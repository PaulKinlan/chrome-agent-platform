// screenshot-persist.test.ts — CAP-FB-20260830-SCREENSHOT-TO-MODEL-01.
//
// The MODEL's capture path used to persist nothing: only the owner-invoked
// action click called saveScreenshot, so `screenshots.list` stayed empty after
// an agent took a screenshot and the owner had no way to open the image. The
// tool now persists on EVERY capture and returns the id plus the PNG's real
// pixel dimensions and byte size, so both the card and the store can find it.
// @ts-nocheck — the chrome + OPFS fakes are intentionally dynamic.

import { assert, assertEquals } from "jsr:@std/assert@1";

// ---- minimal in-memory OPFS fake (same shape as tests/memory.test.ts) ----
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      size: new TextEncoder().encode(node.content ?? "").byteLength,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const opfsRoot = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(opfsRoot); } } },
  configurable: true,
  writable: true,
});

// ---- chrome shim (tabs + permissions + storage) ----
const store = new Map();
const grantedOrigins = new Set();
const tabs = [{ id: 11, url: "https://example.com/", title: "Example Domain", active: true }];
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
// A real 1x1 PNG: the IHDR the tool decodes its width/height from.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_1x1}`;

globalThis.chrome = {
  permissions: {
    contains: async ({ permissions, origins }) => {
      if (origins) return origins.every((o) => grantedOrigins.has(o));
      return (permissions ?? []).every(() => true);
    },
    request: async () => true,
  },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
  tabs: {
    get: async (id) => {
      const t = tabs.find((t) => t.id === id);
      if (!t) throw new Error("no such tab");
      return t;
    },
    query: async () => tabs.filter((t) => t.active),
    update: async (id) => tabs.find((t) => t.id === id),
    captureVisibleTab: async () => PNG_DATA_URL,
  },
  alarms: { create: async () => true, clear: async () => true, get: async () => undefined, getAll: async () => [] },
};

const { browserToolset, setGlobalBrowserControlGrant, pngPixelSize } = await import(
  "../extension/lib/browser-tools.js"
);
const { listScreenshots, loadScreenshot } = await import("../extension/lib/memory.js");

Deno.test("capture_screenshot: a MODEL capture is persisted and returns its id, size and dimensions", async () => {
  grantedOrigins.add("https://example.com/*");
  await setGlobalBrowserControlGrant();

  const before = await listScreenshots();
  const result = await browserToolset().capture_screenshot.execute({ tabId: 11 });

  assert(!result.error, `the capture must succeed: ${result.error ?? ""}`);
  assertEquals(result.ok, true);
  assertEquals(result.url, "https://example.com/");
  assert(
    typeof result.screenshotId === "string" && result.screenshotId.startsWith("shot_"),
    `the model path must persist and return a screenshot id, got ${JSON.stringify(result.screenshotId)}`,
  );
  assertEquals(result.width, 1, "width decoded from the PNG IHDR");
  assertEquals(result.height, 1, "height decoded from the PNG IHDR");
  assertEquals(typeof result.bytes, "number");
  assert(result.bytes > 0 && result.bytes < 200, `the PNG byte size, not the base64 length: ${result.bytes}`);

  // saveScreenshot ran exactly once for this capture: one new index row, and
  // the blob is readable by the id the tool reported.
  const after = await listScreenshots();
  assertEquals(after.length, before.length + 1, "exactly one screenshot was persisted");
  assertEquals(after.at(-1).id, result.screenshotId);
  const blob = await loadScreenshot(result.screenshotId);
  assertEquals(blob.dataURL, PNG_DATA_URL, "the stored blob is the captured PNG");
  assertEquals(blob.url, "https://example.com/");
});

Deno.test("pngPixelSize: reads the IHDR, and refuses anything that is not a PNG", () => {
  assertEquals(pngPixelSize(PNG_DATA_URL), { width: 1, height: 1 });
  assertEquals(pngPixelSize("data:image/jpeg;base64,/9j/4AAQ"), null);
  assertEquals(pngPixelSize("not a data url"), null);
  assertEquals(pngPixelSize(""), null);
});

const { acceptsImageToolResults } = await import("../extension/lib/provider.js");

Deno.test("acceptsImageToolResults: only a lane that transports an image part gets one", () => {
  // The two native lanes carry a real image content part.
  assertEquals(acceptsImageToolResults({ providerName: "gemini", providerLane: "gemini-native" }), true);
  assertEquals(acceptsImageToolResults({ providerName: "anthropic", providerLane: "anthropic-native" }), true);
  // The OpenAI-compatible chat transport JSON-stringifies a `content` output,
  // which would put the whole base64 PNG back into the message text — the exact
  // defect this entry removes. It must NOT be offered an image part.
  assertEquals(acceptsImageToolResults({ providerName: "openai", providerLane: "openai-compatible" }), false);
  assertEquals(acceptsImageToolResults({ providerName: "gemini", providerLane: "openai-compatible" }), false);
  // A provider with no vision at all, and the keyless/demo lanes.
  assertEquals(acceptsImageToolResults({ providerName: "ollama", providerLane: "openai-compatible" }), false);
  assertEquals(acceptsImageToolResults({ providerName: "demo" }), false);
  assertEquals(acceptsImageToolResults(null), false);
  assertEquals(acceptsImageToolResults(undefined), false);
});

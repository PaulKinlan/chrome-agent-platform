// @ts-nocheck — isolated DOM and chrome doubles for the real conversation component.
// b7ny0.22: an ID-keyed Map store DOUBLE pins only the screenshot RESOLVER SEAM
// (images row → screenshots.get → connected strip). It does NOT exercise real
// OPFS durability, the service-worker route, or browser image rendering.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { toolRowsFromRunLog } from "../extension/shared/conversation.js";

class FakeElement {
  constructor(tag = "agent-conversation") {
    this.tagName = tag;
    this.children = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.parent = null;
  }
  get isConnected() { return this._connected === true || this.parent?.isConnected === true; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  attachShadow() { return this; }
}

// These globals MUST be installed before the direct component import. The
// existing components.test.ts imports components-core.js without chrome and
// captures a null module-constant RUNTIME_SEND, which cannot test this seam.
globalThis.HTMLElement = FakeElement;
globalThis.customElements = {
  classes: new Map(),
  define(name, klass) { this.classes.set(name, klass); },
  get(name) { return this.classes.get(name); },
};
globalThis.window = globalThis;
globalThis.document = { createElement: (tag) => new FakeElement(tag) };

const screenshotId = "shot_store_101";
const dataURL = "data:image/png;base64,YQ==";
const store = new Map([
  [screenshotId, { dataURL, url: "https://example.com/captured" }],
  ["shot_decoy_999", { dataURL: "data:image/png;base64,Yg==", url: "https://other.example/" }],
]);
const lookups = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(message, callback) {
      assertEquals(message.type, "screenshots.get", "the resolver uses the screenshot store route");
      lookups.push(message.id);
      const saved = store.get(message.id);
      callback(saved ? { ok: true, ...saved } : { ok: false, error: "screenshot not found" });
    },
  },
};

Deno.test("b7ny0.22: Map store DOUBLE resolves the real images-row ID through screenshots.get into the connected strip (resolver seam only)", async () => {
  // Import AFTER chrome is installed so the real RUNTIME_SEND binds the fake
  // transport. The Map is an explicit store double, not OPFS or the SW route.
  const { AgentConversation } = await import("../extension/shared/components-conversation.js");
  const rows = toolRowsFromRunLog("exec-strip-1", [
    { type: "tool-call", tool: "capture_screenshot", callId: "capture-1", args: {}, at: 1 },
    { type: "tool-result", tool: "capture_screenshot", callId: "capture-1", ok: true,
      result: { ok: true, screenshotId, url: "https://example.com/captured" }, at: 2 },
  ]);
  const images = rows.filter((row) => row.role === "images");
  assertEquals(images.length, 1, "the real projection creates one image row");
  assertEquals(images[0].items.map(({ id, kind }) => ({ id, kind })),
    [{ id: screenshotId, kind: "screenshot" }], "the row carries a screenshot ID, not image bytes");
  assert(!JSON.stringify(images[0]).includes(dataURL), "the projection never inlines store bytes");

  const conversation = new AgentConversation();
  conversation._connected = true;
  conversation._scrollToBottom = () => {}; // scrolling is outside the resolver seam
  const wrap = conversation.appendImages(images[0]);
  assert(wrap, "the real component accepts the projected image row");
  const [strip] = wrap.children;
  assertEquals(strip?.tagName, "screenshot-strip");
  assert(strip.isConnected, "the async resolver must reach a connected strip");
  for (let attempts = 0; attempts < 50 && !strip.getAttribute("shots"); attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(lookups, [screenshotId], "the actual RPC looked up exactly the projected ID, not the decoy");
  assertEquals(JSON.parse(strip.getAttribute("shots")), [
    { url: dataURL, label: "https://example.com/captured", kind: "screenshot" },
  ], "the connected strip receives the bytes fetched from the ID-keyed store double");
});

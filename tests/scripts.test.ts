// Unit test for the agent-generated-script system — lib/scripts.js.
// A script is an origin-keyed asset under `script:<id>` with a reserved `scripts`
// index. Verifies create/list/get/update/delete, the name/source bounds, and that
// the sandbox bootstrap (buildScriptSrcdoc) wraps the source as an async function
// body + embeds the controlled api (fetch/log) + the navigation guard + the CSP.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  SCRIPT_BOUNDS,
  SCRIPT_FRAME_CSP,
  createScript,
  deleteScript,
  getScript,
  listScripts,
  updateScript,
} from "../extension/lib/scripts.js";
import { buildScriptSrcdoc } from "./test-hooks.js";

// ---- minimal in-memory OPFS fake (same shape as tests/artifacts.test.ts) ----
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
      size: (node.content ?? "").length,
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
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: {
    storage: { async getDirectory() { return new FakeDirHandle(root); } },
  },
  configurable: true,
  writable: true,
});

Deno.test("createScript → list → get round-trips a script", async () => {
  const created = await createScript("master", {
    name: "summarize paul",
    source: "const r = await fetch('https://paul.kinlan.me/'); return r.text.slice(0, 200);",
  });
  assert(created.ok, `create must succeed: ${created.error}`);
  const id = created.script.id;
  assert(typeof id === "string" && id.startsWith("s_"), "id must be generated");

  const list = await listScripts("master");
  assert(list.ok, "list must succeed");
  assert(list.scripts.some((s) => s.id === id), "index must contain the new script");

  const got = await getScript("master", id);
  assert(got.ok, "get must succeed");
  assertEquals(got.script.name, "summarize paul");
  assert(got.script.source.includes("paul.kinlan.me"), "source must round-trip");
});

Deno.test("createScript bounds the name + source", async () => {
  const noName = await createScript("master", { name: "  ", source: "return 1;" });
  assert(!noName.ok, "blank name must fail");

  const huge = "x".repeat(SCRIPT_BOUNDS.maxSourceBytes + 1);
  const big = await createScript("master", { name: "big", source: huge });
  assert(!big.ok, "oversized source must fail");
});

Deno.test("updateScript patches name/source + deleteScript removes it", async () => {
  const created = await createScript("master", { name: "v1", source: "return 1;" });
  const id = created.script.id;
  const updated = await updateScript("master", id, { name: "v2", source: "return 2;" });
  assert(updated.ok, `update must succeed: ${updated.error}`);
  assertEquals(updated.script.name, "v2");

  const del = await deleteScript("master", id);
  assert(del.ok, "delete must succeed");
  const got = await getScript("master", id);
  assert(!got.ok, "deleted script must not resolve");
});

Deno.test("buildScriptSrcdoc sandboxes the source + embeds the controlled api", () => {
  const source = "const r = await fetch('https://example.com'); return r.status;";
  const srcdoc = buildScriptSrcdoc(source, { runId: "run_test123", nonce: "nonce-1" });

  // The frame is an opaque sandbox with no network + the navigation guard.
  assert(srcdoc.includes('content="' + SCRIPT_FRAME_CSP + '"'), "CSP meta must be present");
  assert(srcdoc.includes("data-cap-navguard"), "navigation guard must be present");
  assert(srcdoc.includes("cap:script-call"), "the fetch/log bridge must be present");
  assert(srcdoc.includes("cap:script-result"), "the result channel must be present");
  assert(srcdoc.includes("run_test123"), "the runId must be embedded");
  // The source is embedded DIRECTLY (no eval — the extension CSP forbids it).
  assert(srcdoc.includes("window.fetch=function"), "the controlled fetch global must be defined");
  assert(srcdoc.includes("example.com"), "the user source must be embedded as code");
  assert(!srcdoc.includes("new Function") && !srcdoc.includes("__F=Function"), "no eval/Function constructor");
});

Deno.test("buildScriptSrcdoc escapes a closing script tag in the source", () => {
  const srcdoc = buildScriptSrcdoc("const x = 1; // </script><img src=x onerror=alert(1)>", { runId: "r", nonce: "n" });
  assert(!srcdoc.includes("</script><img"), "a closing script tag must be neutralized");
  assert(srcdoc.includes("<\\/script"), "the closing tag must be backslash-escaped");
});

Deno.test("runFetch routes through the SW (no direct CORS-blocked fetch)", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  // Fake chrome.runtime.sendMessage → the SW route (the extension-page fetch
  // must NOT go direct, which would be CORS-blocked for a cross-origin page).
  const calls = [];
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: async (msg: any) => { calls.push(msg); return { ok: true, status: 200, url: msg.url, text: "<html>hi</html>" }; },
    },
  };
  const res = await runFetch({ url: "https://www.bbc.co.uk/news", opts: {} });
  assert(res.ok === true, "the routed fetch must succeed");
  assert(res.status === 200, "the SW response status must pass through");
  assert(calls.length === 1, "exactly one SW message must be sent");
  assert(calls[0].type === "cap:fetch", "the message must be the cap:fetch route");
  assert(calls[0].url === "https://www.bbc.co.uk/news", "the URL must be passed to the SW");
  // A non-http scheme is rejected before the SW is contacted.
  const bad = await runFetch({ url: "file:///etc/passwd", opts: {} });
  assert(bad.ok === false, "a non-http scheme must be rejected");
  assert((globalThis as any).chrome?.runtime?.sendMessage, "chrome must still be present");
  // Cleanup so later tests (if any) don't inherit the fake chrome.
  delete (globalThis as any).chrome;
});

Deno.test("runFetch rejects credentials + non-GET methods", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  (globalThis as any).chrome = { runtime: { sendMessage: async () => ({ ok: true, status: 200, text: "" }) } };
  const cred = await runFetch({ url: "https://user:pass@example.com/", opts: {} });
  assert(cred.ok === false, "credential URLs must be rejected");
  const post = await runFetch({ url: "https://example.com/", opts: { method: "POST" } });
  assert(post.ok === false, "non-GET/HEAD methods must be rejected");
  delete (globalThis as any).chrome;
});

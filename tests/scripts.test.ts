// Unit test for the agent-generated-script system — lib/scripts.js.
// A script is an origin-keyed asset under `script:<id>` with a reserved `scripts`
// index. Verifies create/list/get/update/delete, the name/source bounds, and that
// the sandbox bootstrap (buildScriptSrcdoc) wraps the source as an async function
// body + embeds the controlled api (fetch/log) + the navigation guard + the CSP.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
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

Deno.test("createScript validates a name; source has NO size cap (dptw)", async () => {
  const noName = await createScript("master", { name: "  ", source: "return 1;" });
  assert(!noName.ok, "blank name must fail");

  // Past the removed 64 KiB script-source cap: stored complete. (The backing
  // memory store's own per-value bound is the dptw STORAGE area — the >256 KiB
  // proof lands with that removal.)
  const huge = "x".repeat(200 * 1024 + 1);
  const big = await createScript("master", { name: "big", source: huge });
  assert(big.ok, `oversized source is accepted: ${big.error ?? "ok"}`);
  const got = await getScript("master", big.script.id);
  assertEquals(got.script.source.length, huge.length, "the source round-trips whole");
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

Deno.test("runFetch reads a one-shot Response body once and caches the text", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  const originalChrome = (globalThis as any).chrome;
  const originalFetch = globalThis.fetch;
  const response = new Response("one-shot body", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
  try {
    delete (globalThis as any).chrome;
    globalThis.fetch = async () => response;
    const result = await runFetch({ url: "https://example.com/data", opts: {} });
    assertEquals(result.text, "one-shot body");
    assertEquals(result.untrusted, true, "fetched bodies must be tagged untrusted (INV-7)");
    assertEquals(response.bodyUsed, true, "the native Response stream was consumed once");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete (globalThis as any).chrome;
    else (globalThis as any).chrome = originalChrome;
  }
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

// ── chrome-agent-platform-nv5lt: the unscoped direct fallback's boundary, mechanised ──
// INV-5 covers BROKER-MEDIATED fetches; script-host's direct fallback (te1pu/oe4nz) is
// the ONE sanctioned direct site, reachable only when chrome.runtime is ABSENT and the
// call carries NO run id. That confinement was comment-enforced only, so nothing could
// falsify a widened fallback — a future edit dropping the runId guard or the runtime
// precondition would regress egress policy with every gate green. These pins mechanise
// the boundary; THREAT_MODEL.md's INV-5 now carves the fallback out explicitly and
// cites this block.

Deno.test("runFetch (nv5lt): a registered run is REFUSED, never direct-fetched, when the broker is unavailable", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  const originalChrome = (globalThis as any).chrome;
  const originalFetch = globalThis.fetch;
  const directCalls: string[] = [];
  try {
    delete (globalThis as any).chrome;
    globalThis.fetch = async (input: any) => {
      directCalls.push(String(input));
      return new Response("should never be read", { status: 200 });
    };
    const res = await runFetch({ url: "https://example.com/exfil", opts: {} }, "run-1");
    assertEquals(res.ok, false, "a registered run without the broker must fail closed");
    assertEquals(String((res as any).error).includes("brokered service worker route unavailable"), true,
      "the refusal must name the brokered-route confinement");
    assertEquals(directCalls.length, 0,
      "dropping the runId guard would turn broker failure into unbrokered egress — the direct fetch must never run");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete (globalThis as any).chrome;
    else (globalThis as any).chrome = originalChrome;
  }
});

Deno.test("runFetch (nv5lt): broker FAILURE never widens the fallback — direct fetch needs chrome.runtime ABSENT", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  const originalChrome = (globalThis as any).chrome;
  const originalFetch = globalThis.fetch;
  const directCalls: string[] = [];
  try {
    // The runtime is PRESENT; the broker route itself throws (SW gone, port closed).
    (globalThis as any).chrome = {
      runtime: { sendMessage: async () => { throw new Error("port closed"); } },
    };
    globalThis.fetch = async (input: any) => {
      directCalls.push(String(input));
      return new Response("should never be read", { status: 200 });
    };
    const res = await runFetch({ url: "https://example.com/exfil", opts: {} });
    assertEquals(res.ok, false, "a broker failure in an extension context must fail closed");
    assertEquals(directCalls.length, 0,
      "the fallback's precondition is the runtime being ABSENT, not the broker failing");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete (globalThis as any).chrome;
    else (globalThis as any).chrome = originalChrome;
  }
});

Deno.test("runFetch (nv5lt): the direct fallback fires exactly in the unscoped shape (no runtime, no runId)", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  const originalChrome = (globalThis as any).chrome;
  const originalFetch = globalThis.fetch;
  const directCalls: string[] = [];
  try {
    delete (globalThis as any).chrome;
    globalThis.fetch = async (input: any) => {
      directCalls.push(String(input));
      return new Response("fallback body", { status: 200 });
    };
    const res = await runFetch({ url: "https://example.com/data", opts: {} });
    assertEquals(res.ok, true, "the sanctioned unscoped fallback must still work");
    assertEquals(directCalls.length, 1, "exactly one direct fetch, for the unscoped call only");
    assertEquals(String(directCalls[0]).includes("example.com/data"), true, "and it fetches the requested URL");
    assertEquals((res as any).untrusted, true, "the fallback result is tagged untrusted like the broker's");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete (globalThis as any).chrome;
    else (globalThis as any).chrome = originalChrome;
  }
});

Deno.test("runFetch (nv5lt): chrome.runtime PRESENT without a sendMessage route FAILS CLOSED — an absent broker is not permission to bypass the broker", async () => {
  // The review-FAIL boundary (nv5lt): the documented carve-out says the direct
  // fetch is reachable only when chrome.runtime is ABSENT and there is no run
  // id, but the broker condition tested `chrome.runtime?.sendMessage` — so a
  // runtime that EXISTS without sendMessage used to fall through to the direct
  // fetch for unscoped calls. The guard now refuses every runtime-present shape
  // with no usable route; this pin mechanises that boundary.
  const { runFetch } = await import("../extension/lib/script-host.js");
  const originalChrome = (globalThis as any).chrome;
  const originalFetch = globalThis.fetch;
  const directCalls: string[] = [];
  try {
    // Runtime object PRESENT, no sendMessage — e.g. a context where the
    // extension API surface is partially torn down or mocked.
    (globalThis as any).chrome = { runtime: { id: "present-but-routeless" } };
    globalThis.fetch = async (input: any) => {
      directCalls.push(String(input));
      return new Response("must never be fetched", { status: 200 });
    };
    // The unscoped shape — exactly what the old code let through to fetch().
    const res = await runFetch({ url: "https://example.com/exfil", opts: {} });
    assertEquals(res.ok, false, "a runtime present without sendMessage must fail closed, scoped or not");
    assertEquals(String((res as any).error).includes("refusing rather than bypassing the broker"), true,
      "the refusal must name the bypass refusal, not a generic fetch failure");
    assertEquals(directCalls.length, 0,
      "the direct fetch must NEVER run while chrome.runtime exists — that is the documented INV-5 carve-out boundary");
    // The scoped shape in the same context fails closed too (guard fires
    // before the runId confinement, both refuse).
    const scoped = await runFetch({ url: "https://example.com/exfil", opts: {} }, "run-9");
    assertEquals(scoped.ok, false, "a registered run in a routeless runtime context must also fail closed");
    assertEquals(directCalls.length, 0, "no direct egress in either shape");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete (globalThis as any).chrome;
    else (globalThis as any).chrome = originalChrome;
  }
});

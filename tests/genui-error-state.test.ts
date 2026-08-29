// @ts-nocheck — stubs browser globals (as tests/components.test.ts does) so the
// components module imports under Deno; runtime behavior is what's under test.
//
// tests/genui-error-state.test.ts — the owner-reported bug: a GenUI bubble whose
// tool call FAILED (update_asset → ok:false, "requires owner approval") still
// rendered the sandbox preview frame, which then sat on "Preparing restricted
// preview…" forever. These tests pin:
//   1. toolResultSignalsError detects failure — status attribute, ok:false,
//      error string, the double-wrapped modelContent envelope, and the
//      approval-required (authorizes:false + requiresLiveAuthorization) shape —
//      and NEVER flags a success;
//   2. the message-bubble tool branch CONSULTS it before mounting the frame
//      (source pin — the falsification gate: absent on the pre-fix tree);
//   3. the bubble wires staged payloads from inside its Shadow DOM rather than
//      scanning its empty light DOM (the successful-create regression);
//   4. the sandbox preview host has the bounded wait: timeout, honest failure
//      text, and a retry (source pin — absent on the pre-fix tree).

const registry = new Map();
class HTMLElementStub {
  attachShadow() { return { innerHTML: "" }; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
  setAttribute() {}
  removeAttribute() {}
  dispatchEvent() { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; } };
globalThis.matchMedia = () => ({ matches: false });

import { assert, assertEquals } from "jsr:@std/assert";
const { toolResultSignalsError, toolHeadline, renderHtmlFrame, wireHtmlFrameContent } = await import("../extension/shared/components.js");

// The owner's captured payload, verbatim shape: the outer tool-result envelope
// wraps a modelContent string whose result is the approval-required denial.
const OWNER_RESULT = JSON.stringify({
  modelContent: JSON.stringify({
    ok: true,
    selectedTool: "update_asset",
    result: { error: "This operation requires owner approval in Settings.", ok: false },
    selectionRef: "sel_48a5b187ad9ab795eecbb289c7f0c5aae400",
  }),
  authorizes: false,
  requiresLiveAuthorization: true,
});

Deno.test("genui-error: the owner's approval-required envelope signals error", () => {
  assertEquals(toolResultSignalsError("done", OWNER_RESULT), true);
});

Deno.test("genui-error: tool-status=error signals error even with a null result", () => {
  assertEquals(toolResultSignalsError("error", null), true);
});

Deno.test("genui-error: a bare ok:false result signals error", () => {
  assertEquals(toolResultSignalsError("done", '{"ok":false,"error":"denied"}'), true);
  assertEquals(toolResultSignalsError("done", { ok: false }), true);
});

Deno.test("genui-error: a bare error string field signals error", () => {
  assertEquals(toolResultSignalsError("done", '{"error":"boom"}'), true);
});

Deno.test("genui-error: approval-required (authorizes:false + requiresLiveAuthorization) signals error", () => {
  assertEquals(toolResultSignalsError("done", '{"authorizes":false,"requiresLiveAuthorization":true}'), true);
});

// The REAL lazy-tool success envelope (shape pinned by tests/artifacts-in-thread.test.ts
// from the live protocol, lazy-tool-protocol.js's success projection): ok:true AND
// authorizes:false + requiresLiveAuthorization:true — the pair is NORMAL SUCCESS
// metadata there, so it must never flag the call as failed.
const LAZY_SUCCESS_RESULT = JSON.stringify({
  modelContent: JSON.stringify({
    ok: true,
    selectedTool: "create_asset",
    result: { ok: true, id: "a_real_1", asset: { id: "a_real_1", name: "OpenClaw Report", type: "html", origin: "master", size: 12000 } },
    selectionRef: "sel_ba138fffcac9813515d075901fb166802eb9",
    authorizes: false,
    requiresLiveAuthorization: true,
  }),
});

Deno.test("genui-error: the REAL lazy-tool success envelope (auth metadata + ok:true) never signals error", () => {
  assertEquals(toolResultSignalsError("done", LAZY_SUCCESS_RESULT), false);
  // The pair at the SAME layer as ok:true is success metadata too.
  assertEquals(
    toolResultSignalsError("done", '{"ok":true,"authorizes":false,"requiresLiveAuthorization":true,"asset":{"name":"x","content":"<html></html>"}}'),
    false,
  );
  // And a successful envelope still yields NO headline error text.
  assertEquals(toolHeadline("done", LAZY_SUCCESS_RESULT, null), "");
});

Deno.test("genui-error: the headline unwraps the double-wrapped envelope for the denial text", () => {
  assertEquals(toolHeadline("error", OWNER_RESULT, null), "This operation requires owner approval in Settings.");
  // Bounded: pathological nesting deeper than the unwrap limit yields no headline.
  let deep: any = { error: "too deep" };
  for (let i = 0; i < 8; i++) deep = { modelContent: JSON.stringify(deep) };
  assertEquals(toolHeadline("error", JSON.stringify(deep), null), "");
});

Deno.test("genui-error: SUCCESS results never signal error", () => {
  assertEquals(toolResultSignalsError("done", '{"ok":true,"asset":{"name":"x","content":"<html></html>"}}'), false);
  assertEquals(toolResultSignalsError("done", JSON.stringify({ modelContent: JSON.stringify({ ok: true, result: { ok: true, id: "a_1" } }) })), false);
  assertEquals(toolResultSignalsError("success", null), false);
  assertEquals(toolResultSignalsError("done", "plain text result"), false);
  assertEquals(toolResultSignalsError("done", "<!DOCTYPE html><html><body>hi</body></html>"), false);
  assertEquals(toolResultSignalsError("running", null), false);
  // An empty error STRING is not an error (the field is present on some ok rows).
  assertEquals(toolResultSignalsError("done", '{"ok":true,"error":""}'), false);
});

Deno.test("genui-error: unwrapping is depth-bounded (pathological nesting is not an error)", () => {
  // Each level doubles the string (quote escaping), so keep it small but past
  // the depth bound of 4.
  let deep = { ok: true };
  for (let i = 0; i < 8; i++) deep = { modelContent: JSON.stringify(deep) };
  assertEquals(toolResultSignalsError("done", JSON.stringify(deep)), false);
});

Deno.test("genui-error: MessageBubble wires generated frames inside its Shadow DOM", async () => {
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  const start = source.indexOf("class MessageBubble extends Component");
  const end = source.indexOf('customElements.define("message-bubble"', start);
  const bubble = source.slice(start, end);
  assert(
    bubble.includes('this._root.querySelectorAll?.(".html-frame")'),
    "the generated frame lives in MessageBubble's ShadowRoot; scanning the host light DOM never finds it",
  );
  assert(
    !bubble.includes('this.querySelectorAll?.(".html-frame")'),
    "the empty light-DOM scan must not return",
  );
});

Deno.test("genui-error: the happy-path wire delivers the staged payload to the frame on load", () => {
  // The bubble renders markup from a string renderer, so the payload is staged
  // in frameContents and postMessaged after mount. Pin that contract: staged
  // guarded HTML, nonce-matched, delivered on the frame's load event.
  globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://kat/${p}` } };
  try {
    const markup = renderHtmlFrame("<h1>hi</h1>", { nonce: "n1" });
    assert(markup.includes("sandbox/artifact-preview.html"), "the extension path points at the sandbox host");
    const posted = [];
    const listeners = {};
    const iframe = {
      matches: (s) => s === "iframe",
      addEventListener: (t, f) => { listeners[t] = f; },
      removeEventListener: () => {},
      contentWindow: { postMessage: (d) => posted.push(d) },
    };
    const frame = { matches: (s) => s === ".html-frame", dataset: { frameNonce: "n1" }, querySelector: () => iframe };
    const container = { matches: () => false, querySelector: () => frame };
    const cleanup = wireHtmlFrameContent(container);
    listeners["load"]?.();
    assert(posted.length >= 1, "the load event posts the payload");
    assertEquals(posted[0].type, "cap:artifact-preview-open");
    assertEquals(posted[0].nonce, "n1");
    assert(String(posted[0].html).includes("hi"), "the staged guarded HTML is delivered");
    cleanup();
  } finally {
    delete globalThis.chrome;
  }
});

// ── Round 3 (P1): the LIVE-path headline bug — the owner-reported shape ──────
// The live conversation path (conversation.js tool-result handling) stores
// summarizeToolResult(...) in the card's tool-result attribute — "done" for the
// owner's denied envelope (tool-summary.js's ok:true → "done" fallthrough) — and
// the raw envelope in tool-detail. toolHeadline must headline the DENIAL from
// the detail on an error card, never the bare "done" summary.

Deno.test("genui-error: an ERROR card headlines the denial, never the live path's bare 'done' summary", () => {
  // The reviewer's exact shape: the live path's attribute pairing.
  assertEquals(toolHeadline("error", "done", OWNER_RESULT), "This operation requires owner approval in Settings.");
  // A success status still prefers the result summary (order swap must not regress it).
  assertEquals(toolHeadline("success", "created Paul (Researcher)", "{\"ok\":true}"), "created Paul (Researcher)");
  // No detail → the result summary is all there is, error status or not.
  assertEquals(toolHeadline("error", "done", null), "done");
});

Deno.test("genui-error: the LIVE tool-result path wires summary+detail so the error card headlines the denial", async () => {
  // Drive conversation.js's REAL tool-result event handling (renderRunTranscript)
  // with the owner envelope arriving as the event's result string — the shape the
  // SW actually emits — and assert the attributes the card ends up with, then the
  // headline those attributes produce.
  const { renderRunTranscript } = await import(`../extension/shared/conversation.js?t=${Math.random()}`);
  let portListener = null;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: async () => ({ ok: true }),
      connect: () => ({
        onMessage: { addListener(fn) { portListener = fn; } },
        onDisconnect: { addListener() {} },
        postMessage() {},
      }),
    },
  };
  try {
    const calls = [];
    const c = {
      appendUser() {}, appendAgent() {}, appendSystem() {}, appendError() {}, clear() {}, setAttribute() {},
      appendTool(card) {
        const entry = { kind: "tool", ...card, attrs: {} };
        entry.setAttribute = (name, value) => { entry.attrs[name] = value; };
        calls.push(entry);
        return entry;
      },
    };
    const unsub = renderRunTranscript(c, "exec-genui-live", {});
    portListener({ type: "progress", event: { type: "tool-call", runId: "exec-genui-live", toolName: "execute_tool", toolArgs: { name: "update_asset" } } });
    portListener({ type: "progress", event: { type: "tool-result", runId: "exec-genui-live", toolName: "execute_tool", ok: false, result: OWNER_RESULT } });
    unsub();
    assertEquals(calls.length, 1, "the result resolves the running card");
    const attrs = calls[0].attrs;
    assertEquals(attrs["tool-status"], "error", "a failed call resolves as the error status");
    assertEquals(attrs["tool-result"], "done", "the summary the real code stores is the bare 'done'");
    assertEquals(attrs["tool-detail"], OWNER_RESULT, "the raw envelope lands in the detail attribute");
    // The rendered card headlines the denial, not the summary.
    assertEquals(
      toolHeadline(attrs["tool-status"], attrs["tool-result"], attrs["tool-detail"]),
      "This operation requires owner approval in Settings.",
    );
  } finally {
    delete globalThis.chrome;
  }
});

// ── Source pins: the falsification gate (each FAILS on the pre-fix tree) ─────

const COMPONENTS_SRC = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
const PREVIEW_SRC = await Deno.readTextFile(new URL("../extension/sandbox/artifact-preview.js", import.meta.url));

Deno.test("genui-error: the tool branch consults toolResultSignalsError BEFORE mounting the preview frame", () => {
  const toolBranch = COMPONENTS_SRC.indexOf('role === "tool"');
  const gate = COMPONENTS_SRC.indexOf("const resultFailed = toolResultSignalsError(status, result)");
  const frameRender = COMPONENTS_SRC.indexOf('class="genui"');
  assert(toolBranch > 0 && gate > toolBranch, "the error gate exists inside the tool branch");
  assert(frameRender > gate, "the genui frame render happens AFTER the gate");
  assert(/if \(!resultFailed && genHtml != null/.test(COMPONENTS_SRC), "the genui branch is skipped when the result failed");
});

Deno.test("genui-error: a result-derived failure is promoted to the error status for the card", () => {
  // A "done" status with a failing result envelope must render the ERROR card
  // (open, error chip) — not a collapsed green "done" card.
  assert(
    /status:\s*resultFailed \? "error" : status/.test(COMPONENTS_SRC),
    "buildToolCardDom receives the effective error status when the result failed",
  );});

Deno.test("genui-error: the preview host has the bounded wait — timeout, honest text, retry", () => {
  assert(/PREVIEW_TIMEOUT_MS\s*=\s*15000/.test(PREVIEW_SRC), "a 15s bounded wait exists");
  assert(/Preview unavailable — the content never arrived/.test(PREVIEW_SRC), "the honest failure text replaces the perpetual preparing state");
  assert(/preview-retry/.test(PREVIEW_SRC) && /location\.reload\(\)/.test(PREVIEW_SRC), "a retry affordance reloads the frame (the embedder re-posts on load)");
  assert(/if \(active\) return;/.test(PREVIEW_SRC), "a delivered payload suppresses the failure (happy path untouched)");
});

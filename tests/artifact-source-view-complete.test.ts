// tests/artifact-source-view-complete.test.ts — chrome-agent-platform-p45y.
// The artifact SOURCE view (artifact.html → <artifact-inspector>) must show the
// COMPLETE stored body. Before the fix it rendered only the first 65,536
// characters and printed a "bounded" note, so a large artifact read as
// truncated even though the store + Copy carried it whole.
//
// Falsification: the source guard below fails if anyone reintroduces the
// 64 KiB render slice; the tokenizer-purity test fails if rendering the
// complete body could ever drop or reorder bytes. The end-to-end render is
// pinned by the browser journey (scripts/kat-interactive-artifact-click.ts).
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;

// Stub the browser globals the module touches at load time (same subset as
// tests/html-render-sandbox.test.ts).
const registry = new Map();
class HTMLElementStub {
  attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
  setAttribute() {}
  removeAttribute() {}
  dispatchEvent() { return true; }
  addEventListener() {}
}
globalThis.HTMLElement = globalThis.HTMLElement || HTMLElementStub;
globalThis.customElements = globalThis.customElements || {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.document = globalThis.document || {
  createElement: () => new HTMLElementStub(),
  head: new HTMLElementStub(),
  documentElement: new HTMLElementStub(),
};
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false }));

Deno.test("artifact source view: the inspector renders the COMPLETE body, never a 64 KiB slice (p45y source guard)", () => {
  const raw = Deno.readTextFileSync(`${ROOT}extension/shared/components.js`);
  const inspector = raw.slice(raw.indexOf("/* <artifact-inspector>"), raw.indexOf("customElements.define(\"artifact-inspector\""));
  // The fix: the code element is filled with the whole `content` value.
  assert(
    inspector.includes("highlightSource(content, lang, document)") || inspector.includes("code.textContent = content"),
    "the inspector must mount the complete content variable",
  );
  // The legacy render cap must not return: a slice of content at a fixed limit
  // (or the honest note that used to advertise it) means the source view is
  // truncated again. This guard fails loudly if either is reintroduced.
  assert(!/content\.slice\(0,\s*limit\)/.test(inspector), "the inspector must not slice content at a fixed limit");
  assert(!inspector.includes("Inspection is bounded"), "the bounded-inspection note must not return");
  assert(!/const limit = 65536/.test(inspector), "the 64 KiB render limit must not return");
});

Deno.test("artifact source view: tokenizing the complete body is loss-free at 90 KiB (no bytes can drop when rendered)", async () => {
  const { tokenizeSource } = await import("../extension/shared/components.js");
  // A body larger than the legacy 64 KiB source-view slice, made of tokens +
  // plain runs (mirrors the journey's BIG_HTML shape).
  const body = "<!doctype html><html><head><style>body{color:#123456}</style></head><body>" +
    "<p class=\"x\">" + "plain-text-".repeat(8000) + "</p>" +
    "<script>const a = 'str'; function f(n){ return n + 1; }</script>" +
    "</body></html>";
  assertEquals(body.length > 65536, true, "the sample must exceed the legacy slice");
  for (const language of ["html", "js", "css", "text"]) {
    const tokens = tokenizeSource(body, language);
    const rebuilt = tokens.map((t) => t.text).join("");
    assertEquals(rebuilt, body, `tokenizeSource(${language}) must be loss-free (concatenation === input)`);
    for (const t of tokens) assert(typeof t.text === "string" && t.text.length > 0, "tokens carry their text");
  }
});

// @ts-nocheck
// tests/frame-guards.test.ts — the generated-document frame guards shipped in
// extension/shared/components.js must be valid JavaScript AND behave. This is
// the regression gate for CAP-FB-20260830-GENERATED-UI-BOOTSTRAP-SYNTAX-01:
// preferenceBootstrapScript() used to emit an IIFE whose `function apply(p)`
// was never closed, so every generated srcdoc frame threw
// `SyntaxError: Unexpected token ')'` (14 occurrences in one measured run) and
// the frame never posted cap:preference-ready.
//
// We extract the exact shipped string fragments from the SOURCE FILE (never a
// copy) so the test stays RED if the emitted script regresses, and parse them
// with `new Function` — test-side use only; production bundles are still
// CSP-scrubbed and contain no eval/new Function.
import { assert, assertEquals } from "jsr:@std/assert@1";

const COMPONENTS_PATH = new URL("../extension/shared/components.js", import.meta.url).pathname;

/** Extract the string-fragment array of `function <fnName>` from the shipped
 * source and join it into the exact script string the extension emits.
 * `Function("n", "return […]")(nonce)` reconstructs the array with the real
 * `n` binding, so fragments like `"(function(){var nonce=" + n + ";"` evaluate
 * exactly as they do in the product. */
function extractScript(fnName, nonce = "TESTNONCE") {
  const src = Deno.readTextFileSync(COMPONENTS_PATH, "utf8");
  const start = src.indexOf(`function ${fnName}`);
  assert(start >= 0, `function ${fnName} not found in components.js`);
  const arrStart = src.indexOf("[", start);
  const closePos = src.indexOf(`].join("")`, arrStart);
  assert(arrStart >= 0 && closePos > arrStart, `array literal for ${fnName} not found`);
  const arrayBody = src.slice(arrStart, closePos + 1);
  const frags = Function("n", `return ${arrayBody}`)(JSON.stringify(nonce));
  assert(Array.isArray(frags), `${fnName} fragments did not evaluate to an array`);
  return frags.join("");
}

Deno.test("frame-guards: preferenceBootstrapScript() parses as valid JavaScript", () => {
  const body = extractScript("preferenceBootstrapScript");
  assert(body.includes("cap:preference-ready"), "bootstrap must reference the ready message type");
  new Function(body); // throws SyntaxError on regression
});

Deno.test("frame-guards: navigationGuardScript() parses as valid JavaScript", () => {
  const body = extractScript("navigationGuardScript");
  assert(body.includes("data-cap-navguard") || body.includes("window.open"), "nav guard body looks wrong");
  new Function(body);
});

Deno.test("frame-guards: bootstrap posts cap:preference-ready at IIFE level and applies a validated locale", () => {
  const body = extractScript("preferenceBootstrapScript", "NONCE123");
  const posted = [];
  const listeners = [];
  const windowShim = {
    parent: { postMessage: (msg) => posted.push(msg) },
    addEventListener: (type, fn) => listeners.push(fn),
  };
  const applied = {};
  const documentShim = { documentElement: { setAttribute: (k, v) => { applied[k] = v; } } };
  // Execute the shipped IIFE against minimal shims.
  new Function("window", "document", body)(windowShim, documentShim);
  // (a) readiness is posted immediately at IIFE level (was swallowed inside
  // apply() when the braces were unbalanced, so the frame never announced).
  assertEquals(posted.length, 1, "exactly one cap:preference-ready post");
  assertEquals(posted[0], { type: "cap:preference-ready", nonce: "NONCE123" });
  // (b) a parent message with the matching nonce applies the locale.
  assertEquals(listeners.length, 1, "one message listener registered");
  listeners[0]({
    source: windowShim.parent,
    data: { type: "cap:preference", nonce: "NONCE123", preference: { locale: "fr" } },
  });
  assertEquals(applied.lang, "fr", "validated locale reaches document.documentElement.lang");
});

Deno.test("frame-guards: a message with a wrong nonce is ignored (one-way nonce contract)", () => {
  const body = extractScript("preferenceBootstrapScript", "NONCE123");
  const listeners = [];
  const windowShim = {
    parent: { postMessage: () => {} },
    addEventListener: (type, fn) => listeners.push(fn),
  };
  const applied = {};
  const documentShim = { documentElement: { setAttribute: (k, v) => { applied[k] = v; } } };
  new Function("window", "document", body)(windowShim, documentShim);
  listeners[0]({
    source: windowShim.parent,
    data: { type: "cap:preference", nonce: "WRONG", preference: { locale: "de" } },
  });
  assertEquals(applied.lang, undefined, "wrong nonce must not apply the locale");
});

// ────────────────────────────────────────────────────────────────────────────
// wireHtmlFramePreference delivery ordering (r3 review P1)
// The genuine-ready handler must DELIVER the preference — done guards
// re-delivery, never the first delivery. Regression: done=true was set before
// post(), so the ready attribute fired but the payload never reached the frame
// (the load/timeout fallbacks fire earlier, while the sandbox host is still
// inactive, and their messages are dropped — ready was the only reliable point).
// ────────────────────────────────────────────────────────────────────────────

function stubBrowserGlobals() {
  const registry = new Map();
  class HTMLElementStub {
    attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
    getAttribute() { return null; } hasAttribute() { return false; } setAttribute() {} removeAttribute() {}
    dispatchEvent() { return true; } addEventListener() {} querySelector() { return null; } querySelectorAll() { return []; }
  }
  const prev = {
    HTMLElement: globalThis.HTMLElement, customElements: globalThis.customElements,
    window: globalThis.window, CustomEvent: globalThis.CustomEvent, matchMedia: globalThis.matchMedia,
    addEventListener: globalThis.addEventListener, setTimeout: globalThis.setTimeout,
  };
  globalThis.HTMLElement = HTMLElementStub;
  globalThis.customElements = { define(n, c) { registry.set(n, c); }, get(n) { return registry.get(n); } };
  globalThis.window = globalThis;
  globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; } };
  globalThis.matchMedia = () => ({ matches: false });
  return prev;
}

Deno.test("frame-guards: wireHtmlFramePreference delivers the preference exactly once on genuine ready", async () => {
  const prev = stubBrowserGlobals();
  // Capture the message handler + the mount-time fallback timer without letting
  // the real timer fire during the test (deterministic control of the race).
  const msgHandlers = [];
  const timers = [];
  const origAdd = globalThis.addEventListener;
  const origTimeout = globalThis.setTimeout;
  globalThis.addEventListener = (type, fn) => { if (type === "message") msgHandlers.push(fn); return origAdd(type, fn); };
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  try {
    const mod = await import("../extension/shared/components.js");
    const posts = [];
    const contentWindow = { postMessage: (msg) => posts.push(msg) };
    const loadHandlers = [];
    const iframe = { contentWindow, addEventListener: (type, fn) => { if (type === "load") loadHandlers.push(fn); }, removeEventListener: () => {} };
    const container = {
      matches: () => false,
      querySelector: () => iframe,
      closest: () => null,
      setAttribute: () => {},
    };
    const cleanup = mod.wireHtmlFramePreference(container, { nonce: "NONCE1", locale: "fr" });
    assertEquals(timers.length, 1, "mount fallback registered");
    assertEquals(loadHandlers.length, 1, "load fallback registered");
    assertEquals(msgHandlers.length, 1, "message handler registered");

    // The genuine ready: the generated document's bootstrap parsed and the
    // sandbox host relayed — this MUST trigger exactly one preference delivery.
    msgHandlers[0]({
      data: { type: "cap:preference-ready", nonce: "NONCE1" },
      source: contentWindow,
    });
    assertEquals(posts.length, 1, "genuine ready triggers exactly one preference delivery");
    assertEquals(posts[0], { type: "cap:preference", nonce: "NONCE1", preference: { locale: "fr" } });

    // A repeat ready or the load fallback must NOT re-deliver.
    msgHandlers[0]({ data: { type: "cap:preference-ready", nonce: "NONCE1" }, source: contentWindow });
    for (const h of loadHandlers) h();
    assertEquals(posts.length, 1, "no re-delivery on repeat ready / load fallback");
    cleanup?.();
  } finally {
    globalThis.HTMLElement = prev.HTMLElement;
    globalThis.customElements = prev.customElements;
    globalThis.window = prev.window;
    globalThis.CustomEvent = prev.CustomEvent;
    globalThis.matchMedia = prev.matchMedia;
    globalThis.addEventListener = origAdd;
    globalThis.setTimeout = origTimeout;
  }
});

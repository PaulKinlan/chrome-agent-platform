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

// tests/artifact-sandbox-guidance-eval.test.ts — chrome-agent-platform-np64.
//
// The eval harness for the "generated artifacts must not use unavailable
// sandbox APIs" fix (owner report 2026-09-03: generated UIs keep calling
// localStorage/sessionStorage in the origin-opaque artifact frame, break at
// runtime with raw SecurityErrors, and the agent never learns why). The fix is
// three layers, and this eval drives all three as a generation pipeline:
//
//   1. GUIDANCE REACHES THE MODEL BEFORE IT WRITES CODE — the composed system
//      prompt (the protected runtime-policy rule composes into every scope)
//      and the create_asset/generate_ui/update_asset/patch_asset tool schemas
//      both carry the sandbox constraint block (RED pre-fix: no such text).
//   2. RUNTIME ERRORS TEACH — every generated frame gets the
//      sandboxApiGuardScript, so touching localStorage etc. throws the
//      teaching message instead of the raw SecurityError (RED pre-fix).
//   3. THE EVAL'S CHECKER FLAGS A FIXTURE GENERATION THAT USES THE UNAVAILABLE
//      APIs EVEN WHEN THE GUIDANCE IS REMOVED — the checker scans the
//      generation text mechanically; it does not depend on the model having
//      followed the guidance (that case stays GREEN with the guidance deleted,
//      which is exactly the falsification the issue names: the checker, not
//      the model's adherence, is the backstop the eval asserts on).
//
// @ts-nocheck — stubs browser globals (the html-render-sandbox pattern) so the
// components module imports under Deno; runtime behavior is what's under test.

const registry = new Map();
class HTMLElementStub {
  constructor() {
    this._attrs = new Map();
    this._listeners = new Map();
    this._children = [];
  }
  attachShadow() { return { innerHTML: "", querySelector: () => null }; }
  getAttribute(n) { return this._attrs.get(n) ?? null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  addEventListener() {}
  dispatchEvent() { return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(n) { this._children.push(n); return n; }
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; } };
globalThis.document = {
  createElement() { return new HTMLElementStub(); },
  head: new HTMLElementStub(),
  documentElement: new HTMLElementStub(),
};
globalThis.matchMedia = () => ({ matches: false });

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
const components = await import("../extension/shared/components.js");
const { injectFrameGuards, sandboxApiGuardScript } = components;
import { managementToolset } from "../extension/lib/management-tools.js";
import { baselineSystemPrompt, PROTECTED_CONSTRAINTS } from "../extension/lib/system-prompts.js";

const flat = (s) => String(s ?? "").replace(/\s+/g, " ");

function fakeTools() {
  return managementToolset({ callRoute: async () => ({ ok: true }) });
}

// ── The eval's fixture-generation checker ───────────────────────────────────
// Scans a generated html artifact for the API surfaces the origin-opaque
// sandbox makes unavailable. Text-based on purpose: it judges the GENERATION,
// never the guidance the model was given — so removing the guidance cannot
// silence the eval (the issue's falsification). Mirrors the surfaces the
// runtime guard wraps (components.js sandboxApiGuardScript).
const UNAVAILABLE_SURFACE_RE = [
  ["localStorage", /localStorage/],
  ["sessionStorage", /sessionStorage/],
  ["document.cookie", /document\.cookie/],
  ["indexedDB", /indexedDB/],
  ["caches.open", /caches\.(open|keys|delete|match|has)\s*\(/],
  ["OPFS (navigator.storage)", /navigator\.storage|storage\.getDirectory/],
  ["fetch (network)", /fetch\s*\(/],
];
export function scanGenerationForUnavailableApis(html) {
  return UNAVAILABLE_SURFACE_RE.filter(([, re]) => re.test(String(html ?? ""))).map(([name]) => name);
}

// A fixture generation that KEEPS state in-memory (the guidance's prescription).
const GOOD_FIXTURE = `<div id="app"></div><script>
  let state = { score: 0, best: 0 };
  function addScore(n) { state.score += n; if (state.score > state.best) state.best = state.score; render(); }
  function render() { document.getElementById("app").textContent = "Score: " + state.score; }
</script>`;
// A fixture generation that reaches for localStorage — the owner's repro shape.
const BAD_FIXTURE = `<div id="app"></div><script>
  function load() { return Number(localStorage.getItem("score") || 0); }
  function save(n) { localStorage.setItem("score", String(n)); }
  let state = { score: load() };
</script>`;

// ── Eval scenario 1: the composed guidance reaches the model ────────────────
Deno.test("eval: the composed system prompt teaches the artifact sandbox constraint (hub + worker)", () => {
  // The constraint rides the PROTECTED runtime-policy layer, so the COMPOSED
  // prompt of every scope carries it and no owner prompt override can remove
  // it. RED pre-fix (no sandboxed-artifacts rule existed).
  const composed = baselineSystemPrompt("cap.hub.master");
  assert(composed.endsWith(PROTECTED_CONSTRAINTS), "the protected policy is still the final layer");
  const f = flat(composed);
  assert(f.includes("origin-opaque sandbox"), "composed prompt names the origin-opaque sandbox");
  assert(f.includes("no storage/cookies/network/permission-gated APIs"), "composed prompt enumerates the unavailable API classes");
  assert(f.includes("keep artifact state in-memory or store it with the platform"), "composed prompt prescribes the in-memory/platform alternative");
  // The rule is shared policy — a site worker's composed prompt carries it too.
  const worker = flat(baselineSystemPrompt("cap.worker.base"));
  assert(worker.includes("origin-opaque sandbox"), "worker composed prompt carries the same protected rule");
});

// ── Eval scenario 2: the tool schemas tell the model at the moment of writing ─
Deno.test("eval: create_asset and generate_ui schema descriptions carry the constraint block", () => {
  const { create_asset, generate_ui } = fakeTools();
  // Case-insensitive: the schemas write some emphasis uppercase (IN-MEMORY,
  // ORIGIN-OPAQUE SANDBOX); the eval must not depend on the casing choice.
  const create = flat(create_asset.description).toLowerCase();
  const gen = flat(generate_ui.description).toLowerCase();
  // RED pre-fix: neither description mentioned the sandbox's storage limits.
  for (const surface of ["localstorage", "sessionstorage", "cookies"]) {
    assert(create.includes(surface), `create_asset must name ${surface}`);
    assert(gen.includes(surface), `generate_ui must name ${surface}`);
  }
  for (const doc of [create, gen]) {
    assert(doc.includes("origin-opaque sandbox"), "description names the opaque sandbox");
    assert(doc.includes("permission-gated apis"), "description names permission-gated APIs");
    assert(doc.includes("in-memory"), "description prescribes in-memory state");
    assert(
      doc.includes("store state with the platform") || doc.includes("store it with the platform"),
      "description offers the platform store",
    );
  }
});

Deno.test("eval: update_asset and patch_asset tell the model the constraint survives edits", () => {
  const { update_asset, patch_asset } = fakeTools();
  for (const doc of [flat(update_asset.description), flat(patch_asset.description)]) {
    assert(doc.includes("no localStorage/sessionStorage/cookies"), "an html edit must repeat the storage ban");
    assert(doc.includes("keep state in-memory or store it with the platform"), "an html edit must repeat the alternative");
  }
});

// ── Eval scenario 3: the checker flags the localStorage generation regardless ─
Deno.test("eval: the checker flags a fixture generation that uses localStorage and passes an in-memory one", () => {
  // Falsification the issue names: REMOVE the guidance entirely and this case
  // still holds — the checker judges the generation text, so a model that
  // ignores the guidance is still caught by the eval's mechanical signal.
  const bad = scanGenerationForUnavailableApis(BAD_FIXTURE);
  assert(bad.includes("localStorage"), `the localStorage generation must be flagged (got: ${bad.join(",")})`);
  const good = scanGenerationForUnavailableApis(GOOD_FIXTURE);
  assertEquals(good, [], "the in-memory generation must stay clean");
});

// ── Eval scenario 4: the guarded frame carries the runtime teaching guard ───
Deno.test("eval: the generated frame's runtime guard teaches instead of throwing raw SecurityErrors", () => {
  const guarded = injectFrameGuards(BAD_FIXTURE, "eval-nonce-1");
  // The guard script is injected BEFORE any generated code (the CSP + nav
  // guard + bootstrap come first, the attacker content after).
  assert(guarded.includes("data-cap-sandboxguard"), "guarded frame carries the sandbox-constraints guard");
  const guardAt = guarded.indexOf("data-cap-sandboxguard");
  const codeAt = guarded.indexOf('localStorage.getItem("score")');
  assert(codeAt > guardAt, "the guard runs before the generated localStorage code");
  // The guard's fragments are the issue's teaching text — at runtime the
  // assembled throw names the fix (scenario 5 executes the guard and checks
  // the assembled message; here we pin the raw fragments the frame carries).
  assert(guarded.includes("is unavailable inside sandboxed artifacts"), "the guard teaches on the unavailable APIs");
  assert(guarded.includes("keep state in a variable, or store it with the platform"), "the guard prescribes the in-memory / platform-store alternative");
  assert(guarded.includes("no origin-keyed storage"), "the guard explains WHY storage is absent (opaque origin)");
  // The CSP + nav guard + bootstrap still come first, unchanged.
  assert(guarded.indexOf("data-cap-navguard") < guardAt, "the navigation guard still precedes the sandbox guard");
  assert(guarded.indexOf(components.HTML_FRAME_CSP) < guardAt, "the CSP meta still precedes the sandbox guard");
});

// ── Eval scenario 5: the shipped guard BEHAVES against shims ────────────────
// Extract the exact shipped fragment array from the source (never a copy) and
// execute it, so the test stays RED if the emitted script regresses.
const COMPONENTS_PATH = new URL("../extension/shared/components.js", import.meta.url).pathname;
function extractGuardScript() {
  const src = Deno.readTextFileSync(COMPONENTS_PATH, "utf8");
  const start = src.indexOf("function sandboxApiGuardScript");
  assert(start >= 0, "sandboxApiGuardScript not found in components.js");
  const arrStart = src.indexOf("[", start);
  const closePos = src.indexOf(`].join("")`, arrStart);
  assert(arrStart >= 0 && closePos > arrStart, "guard fragment array not found");
  const arrayBody = src.slice(arrStart, closePos + 1);
  const frags = Function(`return ${arrayBody}`)();
  assert(Array.isArray(frags), "guard fragments did not evaluate to an array");
  return frags.join("");
}

Deno.test("eval: the shipped sandbox guard makes the broken surfaces teach (behavior)", async () => {
  const body = extractGuardScript(); // parses (throws on syntax regression)
  const storage = { getDirectory: () => Promise.resolve({ name: "native" }) };
  const windowShim = { navigator: { storage } };
  const documentShim = {};
  const navigatorShim = { storage };
  // Execute the shipped IIFE against minimal shims (the same pattern the
  // frame-guards suite uses to run the preference bootstrap).
  new Function("window", "document", "navigator", body)(windowShim, documentShim, navigatorShim);

  assert("localStorage" in windowShim, "localStorage stays a present property (feature-detection keeps working)");
  assertThrowsTeaching(
    () => windowShim.localStorage,
    "localStorage",
    "keep state in a variable, or store it with the platform's asset/memory tools",
  );
  assertThrowsTeaching(() => windowShim.sessionStorage, "sessionStorage", "keep state in a variable");
  // document.cookie: reads are empty (the sandbox), writes teach.
  assertEquals(documentShim.cookie, "");
  assertThrowsTeaching(() => { documentShim.cookie = "a=1"; }, "document.cookie", "cookies are blocked");
  // indexedDB / caches methods throw teaching errors.
  assertThrowsTeaching(() => windowShim.indexedDB.open("db", 1), "indexedDB.open", "no origin-keyed storage");
  assertThrowsTeaching(() => windowShim.caches.open("c"), "caches.open", "no origin-keyed storage");
  // OPFS getDirectory rejects with the teaching message.
  await assertRejects(
    () => windowShim.navigator.storage.getDirectory(),
    Error,
    /no origin-keyed storage/,
  );
  // fetch rejects with the network-teaching message.
  await assertRejects(
    () => windowShim.fetch("https://example.com/"),
    Error,
    /fetch is unavailable inside sandboxed artifacts/,
  );
});

function assertThrowsTeaching(fn, api, expectFix) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert(thrown instanceof Error, `expected a teaching throw for ${api}, nothing threw`);
  assert(
    String(thrown.message).includes("unavailable inside sandboxed artifacts"),
    `expected the teaching message for ${api}, got: ${thrown.message}`,
  );
  assert(
    String(thrown.message).includes(expectFix),
    `expected the fix hint for ${api} ("${expectFix}"), got: ${thrown.message}`,
  );
}

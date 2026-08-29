// tests/activity-liveness.test.ts — REVISE-round pins for the Recent-activity
// liveness review (P1-a hidden-hub deferral, P1-b in-flight coalescing,
// P1-c change signature, P1-d secret redaction).
// @ts-nocheck — stubs browser globals (same pattern as components.test.ts).
//
// FALSIFICATION: every test here is RED on the pre-revise candidate
// (ab791752): the old _signature returned count+first-row fields only, the old
// refresh() called _load() directly with no in-flight guard, the SW journal
// wrote JSON.stringify(event.toolArgs) raw, and ntp.js DROPPED covered
// refreshes with no dirty flag.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

// ── minimal browser-global stubs (components.js touches these at load) ────
const registry = new Map();
class HTMLElementStub {
  attachShadow(_init) { return {}; }
  getAttribute(_n) { return null; }
  hasAttribute(_n) { return false; }
  setAttribute(_n, _v) {}
  removeAttribute(_n) {}
  dispatchEvent(_e) { return true; }
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
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });

await import("../extension/shared/components.js");
const ActivityExplorer = registry.get("activity-explorer");

// ── P1-c: the change signature covers every rendered field ────────────────

const baseEntry = () => ({
  ts: 1000, type: "tool-result", id: "t1", callId: "c1",
  source: "named", agentLabel: "Chief", tool: "read_page",
  task: "", args: "", result: "", error: "", message: "",
  stack: "", detail: "", url: "", ok: true,
});

Deno.test("activity signature: an agent RENAME (agentLabel change) re-renders", () => {
  const ctx = { _entries: [baseEntry()], _loadError: null };
  const before = ActivityExplorer.prototype._signature.call(ctx);
  ctx._entries = [{ ...baseEntry(), agentLabel: "Chief of Staff" }];
  const after = ActivityExplorer.prototype._signature.call(ctx);
  assertNotEquals(before, after);
});

Deno.test("activity signature: an ok:true ↔ ok:false flip re-renders", () => {
  const ctx = { _entries: [baseEntry()], _loadError: null };
  const before = ActivityExplorer.prototype._signature.call(ctx);
  ctx._entries = [{ ...baseEntry(), ok: false }];
  assertNotEquals(before, ActivityExplorer.prototype._signature.call(ctx));
});

Deno.test("activity signature: a load-error transition re-renders", () => {
  const ctx = { _entries: [baseEntry()], _loadError: null };
  const before = ActivityExplorer.prototype._signature.call(ctx);
  ctx._loadError = "the activity log didn't answer";
  assertNotEquals(before, ActivityExplorer.prototype._signature.call(ctx));
});

Deno.test("activity signature: identical entries keep the signature (open rows survive)", () => {
  const ctx = { _entries: [baseEntry()], _loadError: null };
  const a = ActivityExplorer.prototype._signature.call(ctx);
  ctx._entries = [baseEntry()];
  assertEquals(a, ActivityExplorer.prototype._signature.call(ctx));
});

// ── P1-b: refresh() coalesces — one in flight, one trailing ───────────────

Deno.test("activity refresh: concurrent refreshes never overlap _load (one in flight + one trailing)", async () => {
  let loads = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const gates = [];
  const fake = {
    _seeded: false,
    _load() {
      loads += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise((resolve) => gates.push(() => { concurrent -= 1; resolve(); }));
    },
    refresh() { return ActivityExplorer.prototype.refresh.call(this); },
  };
  const p1 = ActivityExplorer.prototype.refresh.call(fake);
  const p2 = ActivityExplorer.prototype.refresh.call(fake);
  const p3 = ActivityExplorer.prototype.refresh.call(fake);
  assertEquals(loads, 1, "three rapid refreshes start exactly ONE load");
  assertEquals(p2, p1, "a refresh during flight returns the in-flight promise");
  assertEquals(p3, p1);
  gates.shift()(); // settle load 1 → the trailing refresh fires exactly once
  await Promise.resolve();
  assertEquals(loads, 2, "exactly one trailing load follows");
  gates.shift()(); // settle load 2
  await p1;
  assertEquals(maxConcurrent, 1, "never more than one request in flight");
  // A refresh AFTER everything settled starts fresh (no stale trailing flag).
  const p4 = ActivityExplorer.prototype.refresh.call(fake);
  assertEquals(loads, 3);
  gates.shift()();
  await p4;
  assertEquals(maxConcurrent, 1);
});

Deno.test("activity refresh: seeded (gallery) data is never re-queried", async () => {
  let loads = 0;
  const fake = { _seeded: true, _load() { loads += 1; return Promise.resolve(); } };
  await ActivityExplorer.prototype.refresh.call(fake);
  assertEquals(loads, 0);
});

// ── P1-d: redaction at the persistence + render seams (source pins) ───────

Deno.test("activity journal write path redacts tool args AND results at persistence", () => {
  const sw = Deno.readTextFileSync(new URL("../extension/background/service-worker.js", import.meta.url).pathname);
  assert(sw.includes("JSON.stringify(redactSecrets(event.toolArgs))"), "tool-call journal must redact args before stringify");
  assert(sw.includes("redactToolResult(event.result)"), "tool-result journal must decode + redact STRING and wrapped results before persist (round-3 P1)");
});

// ── round-3 P1: tool-RESULT secrets never reach any render surface ────────
// FALSIFICATION: every pin below is RED on a2e3b1c7 — redactToolResult does
// not exist there, the summary interpolates _unwrap(raw) raw, the detail
// tree safeParses the WRAPPER only, and the SW persists string results
// unchanged.

Deno.test("redactToolResult: a bare JSON-string result redacts secret-shaped keys", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const d = redactToolResult(JSON.stringify({ ok: true, apiKey: "sk-live-KATSECRET-result-1" }));
  assertEquals(d.apiKey, "[REDACTED]");
  assertEquals(d.ok, true);
});

Deno.test("redactToolResult: a wrapped modelContent double-encoded result redacts the INNER payload", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const wrapped = JSON.stringify({ modelContent: JSON.stringify({ ok: true, apiKey: "sk-live-KATSECRET-result-2" }) });
  const d = redactToolResult(wrapped);
  const s = JSON.stringify(d);
  assert(!s.includes("sk-live-KATSECRET-result-2"), `inner secret must not survive: ${s}`);
  assert(s.includes("[REDACTED]"), `inner value must be redacted: ${s}`);
});

Deno.test("redactToolResult: a wrapped userSummary string is decoded + redacted too", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const wrapped = JSON.stringify({ userSummary: JSON.stringify({ token: "sk-live-KATSECRET-result-3" }) });
  const s = JSON.stringify(redactToolResult(wrapped));
  assert(!s.includes("sk-live-KATSECRET-result-3") && s.includes("[REDACTED]"), s);
});

Deno.test("redactToolResult: plain-text results are credential-pattern scrubbed", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const d = redactToolResult("authorization: Bearer sk-live-KATSECRET-result-4-tail");
  assert(typeof d === "string" && !d.includes("sk-live-KATSECRET-result-4-tail"), String(d));
  assert(d.includes("[REDACTED]"), String(d));
});

Deno.test("redactToolResult: non-secret values pass through unchanged", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  assertEquals(redactToolResult(JSON.stringify({ ok: true, title: "Example" })), { ok: true, title: "Example" });
  assertEquals(redactToolResult("just text"), "just text");
  assertEquals(redactToolResult(null), null);
});

Deno.test("activity explorer: summary + detail/copy route tool RESULTS through redactToolResult", () => {
  const src = Deno.readTextFileSync(new URL("../extension/shared/components.js", import.meta.url).pathname);
  assert(src.includes("redactToolResult(raw)"), "the collapsed-row summary must redact the decoded result");
  assert(src.includes('addBlock("result", redactToolResult(e.result))'), "the detail tree + copy must render the redacted decoded view");
  assert(!/const d = _unwrap\(raw\)/.test(src), "the raw _unwrap interpolation seam must be gone");
});

Deno.test("activity explorer redacts historical values before render + copy", () => {
  const src = Deno.readTextFileSync(new URL("../extension/shared/components.js", import.meta.url).pathname);
  assert(src.includes('import { redactSecrets } from "../lib/pure.js";'), "the canonical redactor is imported");
  assert(src.includes("redactSecrets(parsed.value)"), "_detailBody redacts parsed values before tree render + copy");
  assert(src.includes("redactSecrets(p.value)"), "the summary-line args preview is redacted too");
});

// ── round-4 P1s: decoded leaves, nested envelopes, bare shapes, SW persist ──
// FALSIFICATION: every pin below is RED on 82a7cd71 — decoded objects kept
// string leaves raw, unwrap stopped after one envelope, bare sk-/AKIA had no
// pattern, and the scheduled-script journal write bypassed the seam.

Deno.test("redactToolResult: decoded structures scrub NESTED string leaves (Bearer inside a value)", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const d = redactToolResult(JSON.stringify({ message: "Bearer sk-live-NESTEDSECRET123" }));
  const s = JSON.stringify(d);
  assert(!s.includes("NESTEDSECRET123"), `nested string leaf must be scrubbed: ${s}`);
  assert(s.includes("[REDACTED]"), s);
});

Deno.test("redactToolResult: double-encoded envelopes unwrap to the deepest payload", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const deep = JSON.stringify({ modelContent: JSON.stringify({ modelContent: JSON.stringify({ apiKey: "sk-live-DEEPSECRET123" }) }) });
  const s = JSON.stringify(redactToolResult(deep));
  assert(!s.includes("DEEPSECRET123"), `deepest payload must be reached + redacted: ${s}`);
  assert(s.includes("[REDACTED]"), s);
});

Deno.test("redactToolResult: unwrapping is BOUNDED and the cap still text-scrubs", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  let payload = JSON.stringify({ secret: "sk-live-CAPDEPTHSECRET" });
  for (let i = 0; i < 12; i++) payload = JSON.stringify({ modelContent: payload });
  const s = JSON.stringify(redactToolResult(payload));
  assert(!s.includes("CAPDEPTHSECRET"), `beyond-cap residue must be text-scrubbed: ${s}`);
});

Deno.test("redactToolResult: BARE credential shapes scrub without keyword context", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  for (const bare of ["sk-live-BARESECRET123", "AKIA1234567890ABCDEF", "ghp_BARETOKENabcdefghij12"]) {
    const d = redactToolResult(`fetch ok: ${bare}`);
    assert(typeof d === "string" && !d.includes(bare), `bare shape must scrub: ${d}`);
    assert(d.includes("[REDACTED]"), String(d));
  }
});

Deno.test("SW persistence: scheduled-script results route through redactToolResult before journalAppend", () => {
  const sw = Deno.readTextFileSync(new URL("../extension/background/service-worker.js", import.meta.url).pathname);
  assert(sw.includes("redactToolResult(scriptResultRaw)"), "the scheduled-script result/error must be redacted before persist (round-4 P1-d)");
});

// ── round-5 P1: cyclic structures can never crash redaction ──────────────
// FALSIFICATION: the two cyclic pins are RED on bedc76cc — redactSecrets and
// redactResultValue recurse with no cycle tracking, so a self-referential
// result throws RangeError (coordinator probe confirmed). The DAG pin stays
// GREEN pre-fix and guards the guard: path-scoped cycle tracking must not
// drop legitimately-shared subtrees.

Deno.test("redactToolResult: a SELF-REFERENTIAL envelope is redacted, never throws", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const cyc = { modelContent: null, note: "Bearer sk-live-CYCSECRET123" };
  cyc.modelContent = cyc;
  const d = redactToolResult(cyc);
  const s = JSON.stringify(d);
  assert(!s.includes("CYCSECRET123"), `the secret leaf must still scrub: ${s}`);
  assert(s.includes("[Circular]"), `the cycle must degrade to a safe placeholder: ${s}`);
});

Deno.test("redactToolResult: a cycle reachable TWO LEVELS deep is redacted, never throws", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const a = { data: { token: "sk-live-DEEP2SECRET", child: null } };
  a.data.child = a;
  const d = redactToolResult(a);
  const s = JSON.stringify(d);
  assert(!s.includes("DEEP2SECRET"), `a secret on the cycle path must still redact: ${s}`);
  assert(s.includes("[Circular]"), s);
});

Deno.test("redactToolResult: a SHARED (DAG, non-cyclic) reference is redacted at BOTH sites", async () => {
  const { redactToolResult } = await import("../extension/lib/tool-summary.js");
  const shared = { value: "sk-live-DAGSECRET12" };
  const d = redactToolResult({ first: shared, second: shared });
  assertEquals(d.first.value, "[REDACTED]");
  assertEquals(d.second.value, "[REDACTED]");
  const s = JSON.stringify(d);
  assert(!s.includes("[Circular]"), `a non-cyclic shared reference is NOT a cycle: ${s}`);
});

Deno.test("redactSecrets: a throwing getter never pollutes a caller-owned cycle guard", async () => {
  const { redactSecrets } = await import("../extension/lib/pure.js");
  const seen = new WeakSet();
  let reads = 0;
  const source = {};
  Object.defineProperty(source, "nested", {
    enumerable: true,
    get() {
      reads += 1;
      if (reads === 1) throw new Error("getter failed");
      return { apiKey: "sk-live-RETRYSECRET12" };
    },
  });

  let threw = false;
  try {
    redactSecrets(source, seen);
  } catch (error) {
    threw = error instanceof Error && error.message === "getter failed";
  }
  assert(threw, "the first traversal must preserve the getter exception");

  const retry = redactSecrets(source, seen);
  assertNotEquals(retry, "[Circular]", "a failed traversal must release its cycle marker");
  assertEquals(retry, { nested: { apiKey: "[REDACTED]" } });
});

// ── P1-a: covered refreshes are DEFERRED (dirty flag + flush on HUB return)

Deno.test("ntp: a covered refresh marks the log dirty; returning to HUB flushes it", () => {
  const src = Deno.readTextFileSync(new URL("../extension/ntp/ntp.js", import.meta.url).pathname);
  assert(src.includes("runLogDirty = true; return;"), "covered refresh defers via the dirty flag");
  const flushes = src.split("flushRunLogDirty()").length - 1;
  // definition + closeView + hideThreadView call sites
  assert(flushes >= 3, `flushRunLogDirty wired at both HUB-return paths (found ${flushes})`);
  assert(src.includes("threadView.hidden !== true"), "the thread overlay counts as covered too");
});

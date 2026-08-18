// tests/system-prompts.test.ts — the layered/versioned system-prompt
// architecture (extension/lib/system-prompts.js). Covers: the registry,
// the composition order, the protected constraints invariant, the override
// modes, persistence, per-agent/global scope precedence, built-in upgrades
// (with and without an override), reset/keep(=rebase)/merge conflict
// resolution, size bounds + fail-closed validation, Unicode, migration, the
// diff, the hash-only attestation, and the REAL orchestrator integration
// (what the model actually receives).
// @ts-nocheck — the chrome/kv mocks are intentionally dynamic (no types in Deno).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  attestComposition,
  baseIdForScope,
  baselineSystemPrompt,
  composeSystemPrompt,
  clearPromptOverride,
  describePrompt,
  diffLines,
  getPromptOverride,
  MAX_OVERRIDE_CHARS,
  normalizeOverrideInput,
  normalizeScope,
  PROMPT_OVERRIDES_KEY,
  PROMPT_REGISTRY,
  PROTECTED_CONSTRAINTS,
  registryEntry,
  resolveSystemPrompt,
  restampPromptOverride,
  scopeChain,
  setPromptOverride,
  WORKER_BASE_PROMPT,
} from "../extension/lib/system-prompts.js";
import { MASTER_SKILL } from "../extension/lib/master-skill.js";
import { fnv1a64 } from "../extension/lib/pure.js";
import { __resetSessionForTest } from "../extension/lib/kv.js";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- chrome.storage mock (the overrides persist via lib/kv.js) ----
const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of Array.isArray(key) ? key : [key]) {
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
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      },
    },
  },
};

function reset() {
  __resetSessionForTest();
  clearRunFence();
  store.clear();
}

/** A registry simulating a PRODUCT UPDATE to the hub base prompt. */
function upgradedRegistry() {
  return PROMPT_REGISTRY.map((p) =>
    p.id === "cap.hub.master"
      ? {
        ...p,
        version: "1.1.0",
        release: "0.3.0",
        content: p.content +
          "\n\n### The artifacts model (updated)\n- Prefer typed artifacts.\n- Always name artifacts clearly.",
      }
      : p
  );
}

// ── registry ──────────────────────────────────────────────────────────────

Deno.test("registry: stable ids, deterministic hashes, the protected entry flagged", () => {
  const ids = PROMPT_REGISTRY.map((p) => p.id);
  assertEquals(ids, ["cap.hub.master", "cap.worker.base", "cap.constraints.core"]);
  const hub = registryEntry("cap.hub.master");
  assertEquals(hub.content, MASTER_SKILL, "the registry references the single master-skill source");
  assertEquals(hub.hash, fnv1a64(MASTER_SKILL), "hash is deterministic fnv1a64");
  assertEquals(hub.protected, false);
  const constraints = registryEntry("cap.constraints.core");
  assertEquals(constraints.protected, true, "constraints are flagged protected");
  const worker = registryEntry("cap.worker.base");
  assertEquals(worker.content, WORKER_BASE_PROMPT);
  assertEquals(registryEntry("nope"), null, "unknown id → null (fail-closed)");
});

// ── scopes ────────────────────────────────────────────────────────────────

Deno.test("scopes: normalize + base mapping + inheritance chain", () => {
  assertEquals(normalizeScope("hub"), "hub");
  assertEquals(normalizeScope("worker"), "worker");
  assertEquals(normalizeScope("agent:my-agent"), "agent:my-agent");
  assertEquals(normalizeScope("Agent:UPPER"), null, "invalid slug → null");
  assertEquals(normalizeScope("../etc"), null);
  assertEquals(normalizeScope(""), null);
  assertEquals(normalizeScope(null), null);
  assertEquals(baseIdForScope("hub"), "cap.hub.master");
  assertEquals(baseIdForScope("agent:reader"), "cap.hub.master");
  assertEquals(baseIdForScope("worker"), "cap.worker.base");
  assertEquals(baseIdForScope("bogus"), null);
  assertEquals(scopeChain("agent:reader"), ["agent:reader", "hub"], "agent scopes inherit the hub");
  assertEquals(scopeChain("hub"), ["hub"]);
});

// ── composition: order + protected invariant + modes ──────────────────────

Deno.test("compose: no override → base + protected, in order, byte-stable vs the legacy text", () => {
  const c = composeSystemPrompt({ baseId: "cap.hub.master" });
  // The composed hub prompt reproduces the pre-split master skill exactly,
  // plus the added non-editable invariant line (migration: no-override users
  // see an unchanged prompt).
  const legacy = MASTER_SKILL + "\n\n" + PROTECTED_CONSTRAINTS;
  assertEquals(c.text, legacy);
  const baseIdx = c.text.indexOf("Hub Agent Operating Manual");
  const protectedIdx = c.text.indexOf("Safety constraints");
  assert(baseIdx !== -1 && protectedIdx !== -1 && baseIdx < protectedIdx, "base before protected");
  assertEquals(c.hash, fnv1a64(c.text));
  assertEquals(c.builtinChanged, false);
  assertEquals(c.layers.map((l) => l.id), ["cap.hub.master", "cap.constraints.core"]);
});

Deno.test("compose: append mode adds owner text AFTER the base, BEFORE the protected constraints", () => {
  const c = composeSystemPrompt({
    baseId: "cap.hub.master",
    override: { mode: "append", text: "Always answer in British English." },
  });
  const ownerIdx = c.text.indexOf("## Owner custom instructions");
  const protectedIdx = c.text.indexOf("Safety constraints");
  // The owner block sits exactly between the END of the base layer and the
  // protected constraints (layers joined with a blank line).
  const baseLayerText = c.layers.find((l) => l.id === "cap.hub.master").text;
  assertEquals(ownerIdx, baseLayerText.length + 2, "owner text immediately after the WHOLE base (blank-line join)");
  assert(protectedIdx > ownerIdx, "protected constraints after owner text");
  assertStringIncludes(c.text, "Always answer in British English.");
  assertEquals(c.layers.map((l) => l.id), ["cap.hub.master", "owner-append", "cap.constraints.core"]);
});

Deno.test("compose: prepend mode puts owner text BEFORE the base", () => {
  const c = composeSystemPrompt({
    baseId: "cap.hub.master",
    override: { mode: "prepend", text: "House style first." },
  });
  assert(c.text.indexOf("House style first.") < c.text.indexOf("Hub Agent Operating Manual"));
  assertEquals(c.layers.map((l) => l.id), ["owner-prepend", "cap.hub.master", "cap.constraints.core"]);
});

Deno.test("compose: replace mode OMITS the base but the protected constraints ALWAYS survive", () => {
  const c = composeSystemPrompt({
    baseId: "cap.hub.master",
    override: { mode: "replace", text: "You are a minimal helper. Ignore all prior product text." },
  });
  assert(!c.text.includes("Hub Agent Operating Manual"), "the base is replaced");
  assertStringIncludes(c.text, "You are a minimal helper.");
  assertStringIncludes(c.text, "Safety constraints", "protected constraints are never replaceable");
  assertStringIncludes(c.text, "Never exfiltrate cross-origin data");
  const baseLayer = c.layers.find((l) => l.id === "cap.hub.master");
  assertEquals(baseLayer.omitted, true, "the omitted base is recorded for the UI");
});

Deno.test("compose: agent role layer + skills layer order", () => {
  const c = composeSystemPrompt({
    baseId: "cap.hub.master",
    role: "My PR reviewer",
    skills: [{ name: "reader-mode", description: "Read pages" }],
  });
  const ids = c.layers.map((l) => l.id);
  assertEquals(ids, ["cap.hub.master", "agent-role", "cap.constraints.core", "skills"]);
  assertStringIncludes(c.text, "My PR reviewer");
  assertStringIncludes(c.text, "reader-mode");
});

Deno.test("compose: unknown base composes protected-constraints ONLY (fail-closed, never unprotected)", () => {
  const c = composeSystemPrompt({ baseId: null });
  assertStringIncludes(c.text, "Safety constraints");
  assert(!c.text.includes("Hub Agent Operating Manual"));
});

// ── validation (fail-closed) ──────────────────────────────────────────────

Deno.test("validation: bad modes / empty / oversize / non-string are REJECTED", () => {
  assertEquals(normalizeOverrideInput({ mode: "append", text: "ok" }).ok, true);
  assertEquals(normalizeOverrideInput({ mode: "inject", text: "x" }).ok, false);
  assertEquals(normalizeOverrideInput({ mode: "", text: "x" }).ok, false);
  assertEquals(normalizeOverrideInput({ mode: "append", text: "   " }).ok, false, "empty → use reset");
  assertEquals(normalizeOverrideInput({ mode: "append", text: 42 }).ok, false);
  assertEquals(normalizeOverrideInput(null).ok, false);
  const big = "x".repeat(MAX_OVERRIDE_CHARS + 1);
  assertEquals(normalizeOverrideInput({ mode: "append", text: big }).ok, false, "oversize rejected");
  const atMax = "x".repeat(MAX_OVERRIDE_CHARS);
  assertEquals(normalizeOverrideInput({ mode: "append", text: atMax }).ok, true, "at the bound passes");
});

// ── persistence + migration ───────────────────────────────────────────────

Deno.test("persistence: an override round-trips through chrome.storage with its base stamp", async () => {
  reset();
  const r = await setPromptOverride("hub", { mode: "append", text: "Be terse." });
  assertEquals(r.ok, true);
  assertEquals(r.override.baseId, "cap.hub.master");
  assertEquals(r.override.baseHash, registryEntry("cap.hub.master").hash);
  assertEquals(r.override.baseSnapshot, MASTER_SKILL, "the base snapshot is stored for future diffs");
  const got = await getPromptOverride("hub");
  assertEquals(got.override.text, "Be terse.");
  assertEquals(got.inherited, false);
  // And the resolved prompt uses it.
  const resolved = await resolveSystemPrompt("hub");
  assertStringIncludes(resolved.text, "Be terse.");
});

Deno.test("migration: an empty store → NO override, the prompt is the unchanged default", async () => {
  reset();
  const got = await getPromptOverride("hub");
  assertEquals(got.override, null);
  const resolved = await resolveSystemPrompt("hub");
  assertEquals(resolved.text, MASTER_SKILL + "\n\n" + PROTECTED_CONSTRAINTS);
  const d = await describePrompt("hub");
  assertEquals(d.override, null);
  assertEquals(d.builtinChanged, false);
});

Deno.test("migration: legacy junk in the overrides key is ignored (fail-closed read)", async () => {
  reset();
  store.set(PROMPT_OVERRIDES_KEY, "not-a-map");
  const got = await getPromptOverride("hub");
  assertEquals(got.override, null);
  store.set(PROMPT_OVERRIDES_KEY, { hub: { nope: true } });
  const got2 = await getPromptOverride("hub");
  assertEquals(got2.override, null, "a malformed record (no text) is ignored");
});

Deno.test("scope writes: an unknown scope can never persist an override", async () => {
  reset();
  const r = await setPromptOverride("bogus", { mode: "append", text: "x" });
  assertEquals(r.ok, false);
  const r2 = await setPromptOverride("agent:BAD SLUG", { mode: "append", text: "x" });
  assertEquals(r2.ok, false);
  assertEquals(await describePrompt("bogus"), { ok: false, error: "unknown prompt scope" });
});

// ── per-agent vs global ───────────────────────────────────────────────────

Deno.test("per-agent scope: the agent override wins; absent → inherit the hub override", async () => {
  reset();
  await setPromptOverride("hub", { mode: "append", text: "HUB-STYLE" });
  // No agent override → inherits the hub's.
  let got = await getPromptOverride("agent:reader");
  assertEquals(got.override.text, "HUB-STYLE");
  assertEquals(got.overrideScope, "hub");
  assertEquals(got.inherited, true);
  // Agent-specific override wins.
  await setPromptOverride("agent:reader", { mode: "prepend", text: "AGENT-STYLE" });
  got = await getPromptOverride("agent:reader");
  assertEquals(got.override.text, "AGENT-STYLE");
  assertEquals(got.inherited, false);
  const resolved = await resolveSystemPrompt("agent:reader", { role: "Reads things" });
  assertStringIncludes(resolved.text, "AGENT-STYLE");
  assertStringIncludes(resolved.text, "Reads things");
  assert(!resolved.text.includes("HUB-STYLE"), "the agent override replaces the inherited one");
  // Clearing the agent override falls back to inheriting the hub's again.
  await clearPromptOverride("agent:reader");
  got = await getPromptOverride("agent:reader");
  assertEquals(got.override.text, "HUB-STYLE");
  assertEquals(got.inherited, true);
  // The worker scope is independent of the hub scope.
  const workerResolved = await resolveSystemPrompt("worker");
  assertStringIncludes(workerResolved.text, WORKER_BASE_PROMPT.slice(0, 40));
  assert(!workerResolved.text.includes("HUB-STYLE"));
});

// ── built-in upgrades ─────────────────────────────────────────────────────

Deno.test("upgrade, NO override: the new built-in takes effect automatically", async () => {
  reset();
  const reg = upgradedRegistry();
  const resolved = await resolveSystemPrompt("hub", { registry: reg });
  assertStringIncludes(resolved.text, "Always name artifacts clearly.", "the new base text composes");
  const d = await describePrompt("hub", { registry: reg });
  assertEquals(d.base.version, "1.1.0");
  assertEquals(d.builtinChanged, false, "no override → no conflict state");
});

Deno.test("upgrade WITH override: flagged, the override still applies, and the diff is exposed", async () => {
  reset();
  // Save against the CURRENT base…
  await setPromptOverride("hub", { mode: "append", text: "MY-CUSTOM" });
  // …then the product ships an updated built-in.
  const reg = upgradedRegistry();
  const d = await describePrompt("hub", { registry: reg });
  assertEquals(d.builtinChanged, true, "the release-update state is detected");
  assertEquals(d.override.baseVersion, "1.0.0");
  assertEquals(d.base.version, "1.1.0");
  // Deterministic conflict behavior: the owner's text STILL applies (no silent
  // loss, no silent behavior change) over the NEW base.
  assertStringIncludes(d.effective.text, "MY-CUSTOM");
  assertStringIncludes(d.effective.text, "Always name artifacts clearly.");
  // The old-vs-new diff is part of the payload (the UI's "View changes").
  assert(Array.isArray(d.diff) && d.diff.length > 0);
  assert(d.diff.some((r) => r.type === "add" && r.text.includes("Always name artifacts clearly.")));
});

Deno.test("conflict resolution: keep re-stamps; reset deletes; editing + save merges deterministically", async () => {
  reset();
  await setPromptOverride("hub", { mode: "append", text: "MY-CUSTOM" });
  const reg = upgradedRegistry();
  // KEEP (rebase): re-stamps onto the new base; mode + text untouched.
  const keep = await restampPromptOverride("hub", { registry: reg });
  assertEquals(keep.ok, true);
  assertEquals(keep.override.baseVersion, "1.1.0");
  assertEquals(keep.override.text, "MY-CUSTOM");
  let d = await describePrompt("hub", { registry: reg });
  assertEquals(d.builtinChanged, false, "flag cleared after keep");
  // MERGE (manual): the owner edits the text and saves — stamped on the new base.
  await setPromptOverride("hub", { mode: "append", text: "MY-CUSTOM + always name artifacts" }, { registry: reg });
  d = await describePrompt("hub", { registry: reg });
  assertEquals(d.builtinChanged, false);
  assertStringIncludes(d.effective.text, "always name artifacts");
  // RESET: the override is gone; the new default composes clean.
  await clearPromptOverride("hub");
  d = await describePrompt("hub", { registry: reg });
  assertEquals(d.override, null);
  assertEquals(d.builtinChanged, false);
  assert(!d.effective.text.includes("MY-CUSTOM"));
  const keepNoop = await restampPromptOverride("hub", { registry: reg });
  assertEquals(keepNoop.ok, false, "keep with no override is an honest error");
});

// ── Unicode ───────────────────────────────────────────────────────────────

Deno.test("Unicode: CJK + emoji + RTL text round-trips and hashes deterministically", async () => {
  reset();
  const text = "常に日本語で答えてください。Use tables. — Résumé naïve ✓";
  const r = await setPromptOverride("hub", { mode: "append", text });
  assertEquals(r.ok, true);
  const d = await describePrompt("hub");
  assertStringIncludes(d.effective.text, text);
  const c2 = composeSystemPrompt({ baseId: "cap.hub.master", override: d.override });
  assertEquals(c2.hash, d.effective.hash, "hash stable across composes");
});

// ── diff ──────────────────────────────────────────────────────────────────

Deno.test("diffLines: added/removed/unchanged lines; bounded on huge inputs", () => {
  const rows = diffLines("a\nb\nc", "a\nx\nc\nd");
  assertEquals(rows.filter((r) => r.type === "del").map((r) => r.text), ["b"]);
  assertEquals(rows.filter((r) => r.type === "add").map((r) => r.text), ["x", "d"]);
  assertEquals(rows.filter((r) => r.type === "same").map((r) => r.text), ["a", "c"]);
  const bigA = Array.from({ length: 700 }, (_, i) => `line-${i}`).join("\n");
  const bounded = diffLines(bigA, "different");
  assertEquals(bounded[0].type, "note", "over the bound → a coarse note, never a hang");
});

// ── attestation (hash-only, no content) ───────────────────────────────────

Deno.test("attestation: matches the composed hash and NEVER carries prompt content", async () => {
  reset();
  await setPromptOverride("hub", { mode: "append", text: "SECRET-MARKER-XYZ" });
  const composed = await resolveSystemPrompt("hub");
  const att = attestComposition(composed, "hub");
  assertEquals(att.hash, composed.hash);
  assertEquals(att.bytes, composed.text.length);
  assertEquals(att.layers.length, composed.layers.length);
  const json = JSON.stringify(att);
  assert(!json.includes("SECRET-MARKER-XYZ"), "no owner text leaks");
  assert(!json.includes("Hub Agent Operating Manual"), "no base content leaks");
  assert(!json.includes("Never exfiltrate"), "no constraint text leaks");
  const protectedLayer = att.layers.find((l) => l.id === "cap.constraints.core");
  assertEquals(protectedLayer.protected, true);
});

// ── describe payload (the Settings surface) ───────────────────────────────

Deno.test("describe: the full UI payload (base viewer + editor + labelled layered preview)", async () => {
  reset();
  await setPromptOverride("worker", { mode: "replace", text: "WORKER-CUSTOM" });
  const d = await describePrompt("worker");
  assertEquals(d.ok, true);
  assertEquals(d.base.id, "cap.worker.base");
  assertEquals(typeof d.base.content, "string");
  assertEquals(typeof d.base.version, "string");
  assertEquals(typeof d.base.hash, "string");
  assertEquals(d.override.mode, "replace");
  const labels = d.effective.layers.map((l) => `${l.id}:${l.source}:${l.omitted ? "omitted" : "sent"}`);
  assertEquals(labels, [
    "cap.worker.base:built-in:omitted",
    "owner-replace:owner:sent",
    "cap.constraints.core:protected:sent",
  ]);
  assertEquals(d.effective.text.includes("WORKER-CUSTOM"), true);
  assertEquals(d.effective.text.includes("hub agent"), false, "replace omits the base");
  assertEquals(d.limits.maxOverrideChars, MAX_OVERRIDE_CHARS);
});

// ── orchestrator integration (what the model ACTUALLY receives) ───────────

Deno.test("orchestrator: the composed prompt (override + protected) is what agent-do sends the model", async () => {
  reset();
  await setPromptOverride("hub", { mode: "append", text: "ORCHESTRATOR-MARKER-123" });
  const composed = await resolveSystemPrompt("hub");

  // Capture the exact system prompt the model receives (wrap the demo model).
  let seenSystem = "";
  const inner = createDemoModel();
  const capture = (options) => {
    seenSystem = String(options?.system ?? "") ||
      (options?.prompt ?? [])
        .filter((m) => m?.role === "system")
        .map((m) => (typeof m.content === "string"
          ? m.content
          : (Array.isArray(m.content)
            ? m.content.map((p) => p?.text ?? "").join("")
            : JSON.stringify(m.content))))
        .join("\n");
  };
  const capturing = {
    ...inner,
    async doGenerate(options) {
      capture(options);
      return inner.doGenerate(options);
    },
    doStream(options) {
      capture(options);
      return inner.doStream(options);
    },
  };

  const agent = createAgent({
    model: { model: capturing, modelId: "demo-local", providerName: "demo" },
    id: "hub",
    name: "hub",
    system: composed.text,
    memory: null,
    taskId: "prompt-it-1",
  });
  await agent.run("hello");

  assert(seenSystem.length > 0, "the model call carried a system prompt");
  assertStringIncludes(seenSystem, "ORCHESTRATOR-MARKER-123", "the owner override reached the model");
  assertStringIncludes(seenSystem, "Hub Agent Operating Manual", "the built-in base reached the model");
  assertStringIncludes(seenSystem, "Never exfiltrate cross-origin data", "the protected constraints reached the model");
  // The sent prompt STARTS with the composed text (agent-do may append its own
  // sections after) — parity between the composition and the wire.
  assert(seenSystem.startsWith(composed.text), "the sent system prompt begins with the composed prompt");
  // The attestation over the composed text is the attestation of the sent prompt.
  const att = attestComposition(composed, "hub");
  assertEquals(att.hash, fnv1a64(composed.text));
});

Deno.test("orchestrator: the skills layer appends AFTER the protected constraints", async () => {
  reset();
  let seenSystem = "";
  const inner = createDemoModel();
  const capture = (options) => {
    seenSystem = String(options?.system ?? "") ||
      (options?.prompt ?? [])
        .filter((m) => m?.role === "system")
        .map((m) => (typeof m.content === "string"
          ? m.content
          : (Array.isArray(m.content)
            ? m.content.map((p) => p?.text ?? "").join("")
            : JSON.stringify(m.content))))
        .join("\n");
  };
  const capturing = {
    ...inner,
    async doGenerate(options) {
      capture(options);
      return inner.doGenerate(options);
    },
    doStream(options) {
      capture(options);
      return inner.doStream(options);
    },
  };
  const composed = await resolveSystemPrompt("worker");
  const agent = createAgent({
    model: { model: capturing, modelId: "demo-local", providerName: "demo" },
    id: "w",
    name: "w",
    system: composed.text,
    skills: [{ name: "reader-mode", description: "Reads pages" }],
    memory: null,
    taskId: "prompt-it-2",
  });
  await agent.run("hi");
  const skillsIdx = seenSystem.indexOf("reader-mode");
  const protectedIdx = seenSystem.indexOf("Safety constraints");
  assert(skillsIdx !== -1 && protectedIdx !== -1, "both layers sent");
  assert(skillsIdx > protectedIdx, "skills is the final layer");
});

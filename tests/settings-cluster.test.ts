// tests/settings-cluster.test.ts — the Settings-cluster bug fixes
// (CAP-FB-20260823-SETTINGS-PERM-LAYOUT-01, USAGE-TRACKING-FIX-01,
// SECTION-ANCHOR-LINKS-01). Source-level + real-ledger assertions.
// @ts-nocheck — dynamic source reads + the fake-idb mock (house style).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { recordUsage, getUsage } from "../extension/lib/usage.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

const read = (p) => Deno.readTextFile(p);

function usageMock() {
  const store = new Map();
  globalThis.chrome = { permissions: { contains: async () => true }, storage: { local: {
    get: async (key) => { const out = {}; for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = JSON.parse(JSON.stringify(store.get(k))); return out; },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, JSON.parse(JSON.stringify(v))); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
  } } };
}

Deno.test("PERM-LAYOUT: the gates span no longer carries the `.muted` class (grid-area hint collision)", async () => {
  const src = await read("extension/options/options.js");
  assert(!src.includes('gates.className = "perm-gates muted"'), "the gates must not carry `muted` (which assigns grid-area:hint)");
  assert(src.includes('gates.className = "perm-gates"'), "the gates must use the dedicated perm-gates class");
  const css = await read("extension/options/options.css");
  assert(/\.perm-row \.perm-gates \{[^}]*grid-area: gates/.test(css), "the .perm-gates rule must assign grid-area:gates");
  assert(/\.perm-row \.muted \{[^}]*grid-area: hint/.test(css), "the .muted rule assigns grid-area:hint (the description)");
  assert(/\.perm-row \.perm-gates \{[^}]*color: var\(--muted\)/.test(css), "the gates keep the muted color via its own rule");
  // The ≤680px narrow template must also stack gates (not auto-place it after btn).
  assert(/"state"\s*\n\s*"hint"\s*\n\s*"gates"\s*\n\s*"btn"/.test(css), "the narrow .perm-row template stacks gates between hint and btn");
});

Deno.test("USAGE: recordUsage attributes the caller-supplied taskId (per-run, not a stale default)", async () => {
  resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); usageMock();
  await recordUsage({ agentId: "hub", taskId: "task-42", provider: "gemini", model: "gemini-flash", inputTokens: 10, outputTokens: 2 });
  const u = await getUsage();
  const byTask = u.byTask.find((t) => t.taskId === "task-42");
  assert(byTask, "the task-42 row must be attributed to task-42");
  assertEquals(byTask.agentId, "hub");
  assertEquals(byTask.provider, "gemini");
  assertEquals(byTask.model, "gemini-flash");
});

Deno.test("USAGE: the onUsage hook reads the PER-RUN identity taskId, not the closure default", async () => {
  const src = await read("extension/lib/agent.js");
  assert(src.includes("taskId: activeRun?.identity?.taskId ?? taskId"), "onUsage must attribute the per-run identity taskId");
});

Deno.test("USAGE: zero records when nothing ran (the empty-state truth)", async () => {
  resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); usageMock();
  const u = await getUsage();
  assertEquals(u.totals.calls, 0, "no runs → zero calls");
  assertEquals(u.rows.length, 0, "no runs → zero rows");
});

Deno.test("SECTION-ANCHOR: every panel h2 gets a keyboard-reachable copy anchor", async () => {
  const src = await read("extension/options/options.js");
  assert(src.includes("function wireSectionAnchors"), "the anchor wiring exists");
  assert(src.includes('section.querySelector(":scope > h2")'), "anchors bind to the panel h2");
  assert(src.includes("navigator.clipboard.writeText"), "the anchor copies the deep link");
  assert(src.includes("wireSectionAnchors();"), "the wiring runs at startup");
  const css = await read("extension/options/options.css");
  assert(css.includes(".panel h2 .section-anchor"), "the anchor is styled");
  assert(css.includes("opacity: 0"), "the anchor is hover-revealed");
  assert(css.includes(":focus-visible"), "the anchor is keyboard-reachable");
});

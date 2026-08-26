// @ts-nocheck
// CAP-FB-20260826-AGENT-DO-LIFECYCLE-LOG-01 — the agent-do lifecycle is visible
// in the logs at VERBOSE, silent below it, and leaks NO content (prompts, page
// content, tool args/results) — only indices, durations, names, ok/error, counts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { capLogReady, setLogVerbosity, clearLogBuffer, dumpLogBuffer } from "../extension/lib/cap-log.js";
import { perfSummary } from "../extension/lib/cap-perf.js";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";
import { installFakeIdb, resetFakeIdb, clearFaults } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

globalThis.chrome = { permissions: { contains: async () => false }, storage: undefined };
resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); clearFaults();

function captureConsole() {
  const calls = [];
  const orig = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  const rec = (level) => (...a) => calls.push({ level, text: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
  console.debug = rec("debug"); console.info = rec("info"); console.warn = rec("warn"); console.error = rec("error");
  return { calls, restore: () => Object.assign(console, orig) };
}

const SENTINEL_PROMPT = "unique-prompt-sentinel-xyzzy-42";

async function runOne() {
  const model = { model: createDemoModel(), providerName: "demo", modelId: "demo-local" };
  const agent = createAgent({ model, id: "hub", name: "hub", memory: null });
  await agent.run(SENTINEL_PROMPT, "ctx", []);
}

Deno.test("agent-do lifecycle: a verbose run emits the complete ordered redacted trace", async () => {
  await capLogReady();
  await setLogVerbosity("verbose");
  clearLogBuffer();
  const { calls, restore } = captureConsole();
  try {
    await runOne();
  } finally { restore(); }
  const lines = calls.map((c) => c.text).filter((t) => t.includes("agent-do"));
  const joined = lines.join("\n");
  // Ordered lifecycle: step start → (tool start → tool ok/error)* → step complete → run complete → usage.
  const stepStart = lines.findIndex((t) => /step \d+\//.test(t) && t.includes("start"));
  const complete = lines.findIndex((t) => t.includes("run complete"));
  const usage = lines.findIndex((t) => t.includes("usage:"));
  assert(stepStart !== -1, `step start logged:\n${joined}`);
  assert(complete !== -1, `run complete logged:\n${joined}`);
  assert(usage !== -1, `usage logged:\n${joined}`);
  // onUsage fires per provider attempt DURING the run; onComplete is last.
  assert(stepStart !== -1 && stepStart < complete, `ordered lifecycle:\n${joined}`);
  assert(/run complete: \d+ steps in \d+ms/.test(joined), "complete line carries totals + duration");
  assert(/step \d+ complete in [\d.]+ms/.test(joined), "step complete carries a duration");
  // Tool lifecycle present when the demo model uses a tool (demo writes+reads per the fixed protocol).
  if (lines.some((t) => t.includes("tool "))) {
    assert(/tool \S+ (ok|error) in [\d.?]+ms/.test(joined), "tool completion carries name + durationMs + ok/error");
    assert(!/tool .*\{.*\}/.test(joined.replace(/\{ tokensSoFar[^}]*\}|\{ hasToolCalls[^}]*\}/g, "")), "no arg/result objects in tool lines");
  }
  // REDACTION: the sentinel prompt must appear in NO log line anywhere.
  assert(!calls.some((c) => c.text.includes(SENTINEL_PROMPT)), "prompt content NEVER logged");
  // Ring buffer also holds the trace (inspectable via dumpLogBuffer).
  const ring = dumpLogBuffer().entries.filter((e) => e.ns === "agent-do");
  assert(ring.length > 0, "the agent-do lines are in the ring");
  // perf spans recorded for the model round-trip (step span) — visible in perfSummary.
  const perf = perfSummary();
  assert(JSON.stringify(perf).includes("agent-do"), "perf spans for the agent-do lifecycle are recorded");
  await setLogVerbosity("off");
});

Deno.test("agent-do lifecycle: SILENT below verbose (normal = off, off = off)", async () => {
  await capLogReady();
  for (const level of ["normal", "off"]) {
    await setLogVerbosity(level);
    clearLogBuffer();
    const { calls, restore } = captureConsole();
    try {
      await runOne();
    } finally { restore(); }
    const leaked = calls.filter((c) => c.text.includes("agent-do"));
    assertEquals(leaked.length, 0, `no agent-do lines at ${level}`);
    // The ring is cap-log's by-design diagnostic buffer (it retains gated lines
    // for dumpLogBuffer inspection) — the VERBOSITY GATE is the console surface.
    // Silence = nothing printed; ring retention is intentional, not a leak.
  }
  await setLogVerbosity("off");
});

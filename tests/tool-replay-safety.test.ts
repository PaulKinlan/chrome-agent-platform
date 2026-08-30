// CAP-FB-20260820-DURABLE-SIDE-EFFECT-IDEMPOTENCY-01 — the fail-closed per-tool
// replay-safety declarations + the atomic pre-tool authority + the recovery
// gate. The tests drive the REAL production module + the REAL durable-runs
// recovery — no copied controller, no source-regex checks.
// @ts-nocheck — the OPFS/chrome shims implement only the exercised surface.
import { assertEquals, assert } from "jsr:@std/assert@1";

const safety = await import("../extension/lib/tool-replay-safety.js");
const { REPLAY_READ_ONLY, REPLAY_IDEMPOTENT, REPLAY_MUTATING, REPLAY_UNKNOWN } = safety;

// ── the canonical enum + the full built-in classification ───────────────────
Deno.test("replay safety: every shipped built-in is EXPLICITLY classified (the enum is read-only|idempotent|mutating|unknown)", () => {
  // Browser reads.
  for (const name of ["read_page", "capture_screenshot", "list_tabs", "recent_browser_events"]) {
    assertEquals(safety.replaySafetyForTool(name), REPLAY_READ_ONLY, `${name} must be read-only`);
  }
  // Memory reads + the key-bound write.
  for (const name of ["memory_get", "memory_grep", "memory_list"]) {
    assertEquals(safety.replaySafetyForTool(name), REPLAY_READ_ONLY, `${name} must be read-only`);
  }
  assertEquals(safety.replaySafetyForTool("memory_set"), REPLAY_IDEMPOTENT, "memory_set is key-bound idempotent");
  // Management reads.
  for (const name of ["get_agent", "list_agents", "get_asset", "list_assets", "get_usage", "get_named_agent", "list_named_agents", "list_scripts", "get_script"]) {
    assertEquals(safety.replaySafetyForTool(name), REPLAY_READ_ONLY, `${name} must be read-only`);
  }
  // Known MUTATING built-ins.
  for (const name of ["navigate_tab", "close_tab", "open_tab", "delete_agent", "create_asset", "delete_asset", "generate_ui", "schedule_task"]) {
    assertEquals(safety.replaySafetyForTool(name), REPLAY_MUTATING, `${name} must be mutating`);
  }
});

Deno.test("replay safety: undeclared / page-owned / empty / hostile names fail closed to UNKNOWN", () => {
  assertEquals(safety.replaySafetyForTool("page_tool"), REPLAY_UNKNOWN);
  assertEquals(safety.replaySafetyForTool(""), REPLAY_UNKNOWN);
  assertEquals(safety.replaySafetyForTool(undefined), REPLAY_UNKNOWN);
  assertEquals(safety.replaySafetyForTool(null), REPLAY_UNKNOWN);
  // A HOSTILE name (a throwing String, a getter/Proxy) never throws.
  const throwing = { toString() { throw new Error("hostile"); } };
  assertEquals(safety.replaySafetyForTool(throwing), REPLAY_UNKNOWN, "a throwing String must not crash the classifier");
  const proxy = new Proxy({}, { get() { throw new Error("hostile get"); } });
  assertEquals(safety.replaySafetyForTool(proxy), REPLAY_UNKNOWN);
  assertEquals(safety.normalizeSafety("bogus"), REPLAY_UNKNOWN, "a non-enum value normalizes to unknown");
  assertEquals(safety.normalizeSafety(REPLAY_READ_ONLY), REPLAY_READ_ONLY);
  assertEquals(safety.normalizeSafety(42), REPLAY_UNKNOWN);
});

Deno.test("replay safety: the worst-merge can never let an INVALID value retain read-only/idempotent", () => {
  assertEquals(safety.worstSafety(REPLAY_READ_ONLY, REPLAY_MUTATING), REPLAY_MUTATING);
  assertEquals(safety.worstSafety(REPLAY_IDEMPOTENT, REPLAY_UNKNOWN), REPLAY_UNKNOWN);
  // THE CRITICAL CASE: a hostile/invalid second value must NOT leave read-only.
  assertEquals(safety.worstSafety(REPLAY_READ_ONLY, "bogus"), REPLAY_UNKNOWN, "an invalid value must fail the merge closed");
  assertEquals(safety.worstSafety(REPLAY_READ_ONLY, undefined), REPLAY_UNKNOWN);
  const throwing = { toString() { throw new Error("hostile"); } };
  assertEquals(safety.worstSafety(REPLAY_READ_ONLY, throwing), REPLAY_UNKNOWN);
  assertEquals(safety.mayAutoResume(REPLAY_READ_ONLY), true);
  assertEquals(safety.mayAutoResume(REPLAY_IDEMPOTENT), true);
  assertEquals(safety.mayAutoResume(REPLAY_MUTATING), false);
  assertEquals(safety.mayAutoResume(REPLAY_UNKNOWN), false);
  assertEquals(safety.mayAutoResume("bogus"), false, "an invalid value never auto-resumes");
});

Deno.test("replay safety: the stable per-tool-call key is executionId + the attempt-stable index", () => {
  assertEquals(
    safety.perCallIdempotencyKey({ executionId: "exec_1", toolName: "memory_set", callIndex: 3 }),
    "exec_1:memory_set:3",
  );
  // A hostile executionId/toolName never throws + never produces a colliding key.
  const throwing = { toString() { throw new Error("hostile"); } };
  assertEquals(safety.perCallIdempotencyKey({ executionId: throwing, toolName: "t", callIndex: 1 }), ":t:1");
});

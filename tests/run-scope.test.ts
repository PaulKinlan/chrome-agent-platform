import { assertEquals } from "jsr:@std/assert";
import { actionableRunsForSurface, isSettledLiveRunRecord, runSurfaceIdentity } from "../extension/lib/run-scope.js";

const runs = [
  { executionId: "a", phase: "running", threadId: "thread-a", agentId: null },
  { executionId: "b", phase: "paused-permission", threadId: "thread-b", agentId: null },
  { executionId: "old", phase: "terminal", threadId: "thread-a", agentId: null },
  { executionId: "named", phase: "running", threadId: null, agentId: "named:researcher" },
  { executionId: "background", phase: "settling", threadId: null, agentId: "background:auto-tabs" },
  { executionId: "site", phase: "paused-provider-change", threadId: null, agentId: "https://example.com" },
];

Deno.test("run controls are scoped to one task and omit terminal history already in conversation", () => {
  assertEquals(actionableRunsForSurface(runs, { threadId: "thread-a" }).map((run) => run.executionId), ["a"]);
  assertEquals(actionableRunsForSurface(runs, { threadId: "thread-b" }).map((run) => run.executionId), ["b"]);
  assertEquals(actionableRunsForSurface(runs, { threadId: "missing" }), []);
});

Deno.test("run controls are scoped to the exact named, background, or site agent", () => {
  assertEquals(actionableRunsForSurface(runs, { agentKind: "named", agentId: "researcher" }).map((run) => run.executionId), ["named"]);
  assertEquals(actionableRunsForSurface(runs, { agentKind: "background", agentId: "auto-tabs" }).map((run) => run.executionId), ["background"]);
  assertEquals(actionableRunsForSurface(runs, { agentKind: "site", agentId: "https://example.com" }).map((run) => run.executionId), ["site"]);
});

Deno.test("hub and unrelated surfaces expose no conversation run controls", () => {
  assertEquals(runSurfaceIdentity({}), null);
  assertEquals(actionableRunsForSurface(runs, {}), []);
});

Deno.test("terminal reconciliation matches the exact live client run id, never a fresh previous terminal", () => {
  const previous = { executionId: "exec-a", phase: "terminal", clientCorrelationId: "run-a", updatedAt: 10_001 };
  const current = { executionId: "exec-b", phase: "terminal", clientCorrelationId: "run-b", updatedAt: 10_002 };
  assertEquals(isSettledLiveRunRecord(previous, "run-b"), false,
    "run A must not clear follow-up B even when A's terminal timestamp is fresh");
  assertEquals(isSettledLiveRunRecord(current, "run-b"), true);
  assertEquals(isSettledLiveRunRecord(current, null), false, "unknown live identity fails closed");
  assertEquals(isSettledLiveRunRecord({ executionId: "exec-b", phase: "terminal" }, "run-b"), false,
    "legacy records without clientCorrelationId fail closed");
});

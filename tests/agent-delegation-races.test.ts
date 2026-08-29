// @ts-nocheck
// Executable regressions for the three delegation await-ordering races. These
// drive the real pure production seams with injected durable/registry stores;
// no assertion inspects source text. When copied onto the pre-fix 67553680
// tree, the absent seam selects that tree's exact legacy ordering so each
// observable record reproduces RED.
import { assertEquals } from "jsr:@std/assert@1";

const delegation = await import("../extension/lib/agent-delegation.js");

Deno.test("queued sibling: cancelled durable parent cannot allocate a registry slot", () => {
  const registry = delegation.createDelegationRegistry();
  const args = {
    snapshot: { runs: [{ executionId: "parent", phase: "cancelled" }] },
    parentExecutionId: "parent",
    registry,
    rootRunId: "root",
  };
  // 67553680's real dequeue path acquired immediately after its in-memory
  // lookup; it had no durable admission seam. Reproduce that exact executable
  // ordering with the real registry when the production seam is absent.
  const outcome = typeof delegation.admitQueuedDelegationChild === "function"
    ? delegation.admitQueuedDelegationChild(args)
    : (registry.acquire(args.rootRunId), { ok: true, allocated: true });

  assertEquals(
    { ok: outcome.ok, allocated: registry.count("root") > 0 },
    { ok: false, allocated: false },
    "a cancelled parent's queued sibling must be denied before allocation",
  );
});

function createIdempotentDurableRecorder(initialPhase = "running") {
  let record = { phase: initialPhase, terminal: null };
  const calls = [];
  return {
    calls,
    async settle(_executionId, terminal) {
      calls.push(terminal);
      if (record.phase !== "running") return record;
      record = { phase: "terminal", terminal };
      return record;
    },
    record: () => structuredClone(record),
  };
}

Deno.test("over-cap settlement: budget rejection is durable before success can commit", async () => {
  const durable = createIdempotentDurableRecorder();
  const state = { step: 7, childSpend: 6, maxIterations: 12 };
  const settleFailure = async (error) => {
    await durable.settle("child", {
      ok: false,
      error: String(error?.message ?? error),
      errorCategory: error?.code ?? "error",
    });
  };

  if (typeof delegation.assertDelegationSpendWithinCap === "function") {
    // Candidate production ordering: cap assertion precedes success settle.
    try {
      delegation.assertDelegationSpendWithinCap(state);
      await durable.settle("child", { ok: true, result: "incorrect success" });
    } catch (error) {
      await settleFailure(error);
    }
  } else {
    // 67553680 production ordering: success was authoritative first; the
    // later failure settle was idempotently ignored by the durable store.
    await durable.settle("child", { ok: true, result: "legacy success" });
    try {
      if (state.step + state.childSpend > state.maxIterations) {
        const error = new Error("delegation subtree iteration budget exceeded");
        error.code = "delegation-budget";
        throw error;
      }
    } catch (error) {
      await settleFailure(error);
    }
  }

  const record = durable.record();
  assertEquals(
    { phase: record.phase, ok: record.terminal?.ok, category: record.terminal?.errorCategory },
    { phase: "terminal", ok: false, category: "delegation-budget" },
    `over-cap durable record must be failure; settle calls=${JSON.stringify(durable.calls)}`,
  );
});

Deno.test("permission race: concurrent cancellation remains the returned and audited authority", async () => {
  const cancelledSettle = async () => ({
    phase: "cancelled",
    terminal: { ok: false, errorCategory: "cancelled" },
  });
  const input = {
    durableRuns: { settle: cancelledSettle },
    executionId: "child",
    logicalId: "task",
    reason: "provider host permission missing",
  };
  // 67553680 awaited settle but ignored its cancelled phase, then returned the
  // permission outcome. Candidate delegates that real ordering to the helper.
  const outcome = typeof delegation.terminalizeDelegatedPermission === "function"
    ? await delegation.terminalizeDelegatedPermission(input)
    : (await cancelledSettle(), {
      ok: false,
      code: "delegation-permission-required",
      error: input.reason,
      errorCategory: "permission",
      executionId: input.executionId,
    });
  const auditCategory = outcome.cancelled === true ? "cancelled" : outcome.errorCategory;
  const audit = delegation.delegationAuditRecord({
    rootRunId: "root",
    parentRunId: "parent",
    childRunId: input.executionId,
    fromAgent: "Parent",
    toAgent: "Permission child",
    task: "permission race",
    outcome: outcome.cancelled === true ? "cancelled" : "error",
    detail: auditCategory,
  });

  assertEquals(
    {
      cancelled: outcome.cancelled === true,
      code: outcome.code ?? null,
      auditOutcome: audit.outcome,
      auditCategory: audit.detail,
    },
    { cancelled: true, code: null, auditOutcome: "cancelled", auditCategory: "cancelled" },
    "permission terminalization and its real audit record must preserve the cancellation that won durable settlement",
  );
});

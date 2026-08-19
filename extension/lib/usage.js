// lib/usage.js — usage accounting (per-LLM-call token/cost ledger).
//
// Records per-LLM-call usage (agentId, provider, model, input/output tokens,
// estimated cost) into the IndexedDB sole-authority ledger (lib/usage-store.js)
// with a rolling 7-day window, then aggregates by agent/provider/model/task/day.
// Every agent-do onUsage event flows through recordUsage(). Usage survives
// service-worker restarts WITHOUT the optional `storage` permission.
import { usageRead, usageWrite, usageClear, usageRemoveRow } from "./usage-store.js";
import { assertRunOwned } from "./run-fence.js";

// A module mutex serializes the usage ledger read-modify-write. Concurrent
// onUsage events (parallel tool calls in a single model step resolve via
// Promise.all) previously lost rows; one lock makes the append atomic.
let usageMutex = Promise.resolve();
function withUsageLock(fn) {
  const run = usageMutex.then(fn, fn);
  usageMutex = run.then(() => {}, () => {});
  return run;
}

/**
 * @param {{ agentId?: string, taskId?: string, provider?: string, model?: string,
 *   inputTokens?: number, outputTokens?: number, estimatedCost?: number }} p
 */
export async function recordUsage(p, guard = null) {
  // Usage accounting is a durable write (the ledger persists in chrome.storage)
  // — fence it like every other side-effecting boundary: an aborted run must not
  // append a usage row as a silently-degraded owner (the round-19 finding:
  // recordUsage was completely unfenced). DUrable ownership must be verified too
  // (not merely the signal) — the round-20 finding that usage checked the signal
  // only once and never verified durable ownership.
  try {
    await assertRunOwned();
  } catch {
    return; // ownership lost / run aborted — do not record a stale usage row
  }
  const inputTokens = p.inputTokens ?? 0;
  const outputTokens = p.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return; // nothing to record

  // The row id IS the immutable provider-attempt usageEventId (generated at the
  // doGenerate/doStream boundary); occurredAt originates there too. A duplicate
  // delivery reuses both → byte-identical idempotent no-op.
  const id = typeof p.usageEventId === "string" && p.usageEventId.length > 0 ? p.usageEventId : crypto.randomUUID();

  const record = {
    id,
    timestamp: p.occurredAt ?? new Date().toISOString(),
    agentId: p.agentId ?? "hub",
    taskId: p.taskId ?? "adhoc",
    provider: p.provider ?? "unknown",
    model: p.model ?? "unknown",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCost: p.estimatedCost ?? 0,
  };

  // The whole read → append → trim → write is one serialized transaction under
  // the usage mutex, so concurrent onUsage events cannot lose a row (the round-24
  // usage-RMW blocker). `guard` threads the worker's IMMUTABLE run-start
  // enrollment generation so a stale run never records usage under a re-enrolled
  // origin (the round-24 gen-threading blocker).
  return await withUsageLock(async () => {
    // Re-validate the run-start generation BEFORE the read (an abort/ownership
    // loss during the pre-lock awaits above must not proceed to a stale write).
    if (guard?.genGuard) {
      try {
        const g = await guard.genGuard();
        const runGen = guard.getRunGen?.() ?? null;
        if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) return;
      } catch {
        return; // guard failure — fail closed, no stale usage row
      }
    }
    const store = await usageRead();
    // Pass ONLY the new record (usageWrite merges it into the current authority
    // inside its IDB transaction — no pre-transaction snapshot).
    await usageWrite([record]);
    // DUrable ownership re-checked IMMEDIATELY before the ledger commit (no other
    // await between this check and kvSet) — the round-21 finding that usage
    // checked ownership only before the read-modify-write, never adjacent to the
    // commit.
    try {
      await assertRunOwned();
    } catch {
      return; // ownership lost — do not append a stale usage row
    }
    // Re-validate the run-start generation IMMEDIATELY before the commit.
    if (guard?.genGuard) {
      try {
        const g = await guard.genGuard();
        const runGen = guard.getRunGen?.() ?? null;
        if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) return;
      } catch {
        return; // fail closed — no stale usage row
      }
    }
    await usageWrite([record]);
    // Post-commit re-checks: ownership loss DURING the kvSet await must not
    // report a successfully recorded row — AND must COMPENSATE by removing the
    // just-committed row, so a stale owner's usage row does not survive as a
    // forbidden durable effect (the round-22 finding: the post-check only
    // returned, leaving the `deleted-worker` row committed). The run-start
    // generation is re-validated too (a re-enroll during the commit must not
    // leave a stale row under the new enrollment).
    let stale = false;
    try {
      await assertRunOwned();
    } catch {
      stale = true;
    }
    if (!stale && guard?.genGuard) {
      try {
        const g = await guard.genGuard();
        const runGen = guard.getRunGen?.() ?? null;
        if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) stale = true;
      } catch {
        stale = true;
      }
    }
    if (stale) {
      // Compensate: EXPLICIT atomic removal of the just-appended row (by id).
      try {
        await usageRemoveRow(record.id);
      } catch (e) {
        throw new Error(`usage compensation failed: ${e?.message ?? e}`);
      }
      return; // stale owner / re-enrolled — the row is not reported
    }
    return record;
  });
}

export async function getUsage() {
  const { rows, durability } = await usageRead();

  const byModel = {};
  const byProvider = {};
  const byAgent = {};
  const byTask = {};
  const byDay = {};
  const totals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  };
  for (const r of rows) {
    const mk = `${r.provider}/${r.model}`;
    byModel[mk] ??= {
      provider: r.provider,
      model: r.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    byModel[mk].calls++;
    byModel[mk].inputTokens += r.inputTokens;
    byModel[mk].outputTokens += r.outputTokens;
    byModel[mk].estimatedCost += r.estimatedCost;

    // By provider (the provider-level breakdown).
    byProvider[r.provider] ??= {
      provider: r.provider,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    byProvider[r.provider].calls++;
    byProvider[r.provider].inputTokens += r.inputTokens;
    byProvider[r.provider].outputTokens += r.outputTokens;
    byProvider[r.provider].estimatedCost += r.estimatedCost;

    // By agent (each agent's attributable usage + cost).
    byAgent[r.agentId] ??= {
      agentId: r.agentId,
      provider: r.provider,
      model: r.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    byAgent[r.agentId].calls++;
    byAgent[r.agentId].inputTokens += r.inputTokens;
    byAgent[r.agentId].outputTokens += r.outputTokens;
    byAgent[r.agentId].estimatedCost += r.estimatedCost;

    // By task (each task's attributable usage + cost, with its agent).
    const tk = r.taskId ?? "adhoc";
    byTask[tk] ??= {
      taskId: tk,
      agentId: r.agentId ?? "hub",
      provider: r.provider,
      model: r.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    byTask[tk].calls++;
    byTask[tk].inputTokens += r.inputTokens;
    byTask[tk].outputTokens += r.outputTokens;
    byTask[tk].estimatedCost += r.estimatedCost;

    // By day (the times/dates — a per-day breakdown).
    const day = r.timestamp.slice(0, 10); // YYYY-MM-DD
    byDay[day] ??= {
      day,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    byDay[day].calls++;
    byDay[day].inputTokens += r.inputTokens;
    byDay[day].outputTokens += r.outputTokens;
    byDay[day].estimatedCost += r.estimatedCost;

    totals.calls++;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.estimatedCost += r.estimatedCost;
  }
  return {
    totals,
    byModel: Object.values(byModel),
    byProvider: Object.values(byProvider),
    byAgent: Object.values(byAgent),
    byTask: Object.values(byTask),
    byDay: Object.values(byDay),
    rows,
    durability,
  };
}

export async function clearUsage() {
  return await withUsageLock(async () => {
    await usageClear();
  });
}

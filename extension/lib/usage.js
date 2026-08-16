// lib/usage.js — usage accounting (per-LLM-call token/cost ledger).
//
// Records per-LLM-call usage (agentId, provider, model, input/output tokens,
// estimated cost) into chrome.storage.local with a rolling 7-day window, then
// aggregates by agent/provider/model. The memory explorer surfaces a usage view.
// Every agent-do onUsage event flows through recordUsage().
import { kvGet, kvRemove, kvSet } from "./kv.js";
import { assertRunOwned } from "./run-fence.js";

const STORAGE_KEY = "cairn:usage";
const MAX_RECORDS = 5000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// A module mutex serializes the usage ledger read-modify-write. Concurrent
// onUsage events (parallel tool calls in a single model step resolve via
// Promise.all, so two recordUsage calls can interleave) previously read the same
// rows, appended, and overwrote each other — losing one row. One lock makes the
// append atomic (the round-24 usage-RMW blocker).
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

  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
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
    const store = await kvGet(STORAGE_KEY);
    const rows = (store[STORAGE_KEY] ?? []).filter(
      (r) => Date.now() - new Date(r.timestamp).getTime() < RETENTION_MS,
    );
    rows.push(record);
    // cap the ledger (keep the newest)
    const trimmed = rows.slice(-MAX_RECORDS);
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
    await kvSet({ [STORAGE_KEY]: trimmed });
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
      // Compensate: remove the row we just appended (by its unique id). Best-effort
      // — if the compensation write also fails, the row remains but is not REPORTED
      // as recorded.
      try {
        const cur = await kvGet(STORAGE_KEY);
        const compensated = (cur[STORAGE_KEY] ?? []).filter(
          (r) => r.id !== record.id,
        );
        await kvSet({ [STORAGE_KEY]: compensated });
      } catch { /* best-effort compensation */ }
      return; // stale owner / re-enrolled — the row is not reported
    }
    return record;
  });
}

export async function getUsage() {
  const store = await kvGet(STORAGE_KEY);
  const rows = (store[STORAGE_KEY] ?? []).filter(
    (r) => Date.now() - new Date(r.timestamp).getTime() < RETENTION_MS,
  );

  const byModel = {};
  const byAgent = {};
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

    byAgent[r.agentId] ??= {
      agentId: r.agentId,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    byAgent[r.agentId].calls++;
    byAgent[r.agentId].inputTokens += r.inputTokens;
    byAgent[r.agentId].outputTokens += r.outputTokens;

    totals.calls++;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.estimatedCost += r.estimatedCost;
  }
  return {
    totals,
    byModel: Object.values(byModel),
    byAgent: Object.values(byAgent),
    rows,
  };
}

export async function clearUsage() {
  // clearUsage must run INSIDE the SAME usage mutex as append/compensation (the
  // round-25 blocker 7): an unlocked clear could interleave with an in-flight
  // append/compensation, letting a still-writing append resurrect rows the owner
  // just cleared. Route append, compensation, clear, and consistent reads through
  // the same transaction.
  return await withUsageLock(async () => {
    await kvRemove(STORAGE_KEY);
  });
}

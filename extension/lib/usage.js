// lib/usage.js — usage accounting (per-LLM-call token/cost ledger).
//
// Records per-LLM-call usage (agentId, provider, model, input/output tokens,
// estimated cost) into chrome.storage.local with a rolling 7-day window, then
// aggregates by agent/provider/model. The memory explorer surfaces a usage view.
// Every agent-do onUsage event flows through recordUsage().
import { kvGet, kvRemove, kvSet } from "./kv.js";

const STORAGE_KEY = "cairn:usage";
const MAX_RECORDS = 5000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * @param {{ agentId?: string, taskId?: string, provider?: string, model?: string,
 *   inputTokens?: number, outputTokens?: number, estimatedCost?: number }} p
 */
export async function recordUsage(p) {
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

  const store = await kvGet(STORAGE_KEY);
  const rows = (store[STORAGE_KEY] ?? []).filter(
    (r) => Date.now() - new Date(r.timestamp).getTime() < RETENTION_MS,
  );
  rows.push(record);
  // cap the ledger (keep the newest)
  const trimmed = rows.slice(-MAX_RECORDS);
  await kvSet({ [STORAGE_KEY]: trimmed });
  return record;
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
  await kvRemove(STORAGE_KEY);
}

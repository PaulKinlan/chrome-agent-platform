// lib/usage.js — usage accounting (chaos-relay pattern).
//
// Per-task, per-model token + cost records, persisted in master memory so the
// explorer can render a usage view. The agent core calls recordUsage() after
// each model turn; getUsage() aggregates.

import { masterMemory } from "./memory.js";

const KEY = "usage";

export async function recordUsage({ taskId, model, provider, tokensIn = 0, tokensOut = 0, costUsd = 0, latencyMs = 0 }) {
  const store = masterMemory();
  const rows = (await store.get(KEY)) ?? [];
  rows.push({
    ts: Date.now(),
    taskId: taskId ?? "adhoc",
    model: model ?? "unknown",
    provider: provider ?? "unknown",
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs,
  });
  await store.set(KEY, rows.slice(-5000)); // cap the ledger
  return rows;
}

export async function getUsage() {
  const rows = (await masterMemory().get(KEY)) ?? [];
  const byModel = {};
  const byTask = {};
  let totalTokensIn = 0, totalTokensOut = 0, totalCost = 0;
  for (const r of rows) {
    byModel[r.model] ??= { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
    byModel[r.model].tokensIn += r.tokensIn;
    byModel[r.model].tokensOut += r.tokensOut;
    byModel[r.model].costUsd += r.costUsd;
    byModel[r.model].calls += 1;
    byTask[r.taskId] ??= { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
    byTask[r.taskId].tokensIn += r.tokensIn;
    byTask[r.taskId].tokensOut += r.tokensOut;
    byTask[r.taskId].costUsd += r.costUsd;
    byTask[r.taskId].calls += 1;
    totalTokensIn += r.tokensIn;
    totalTokensOut += r.tokensOut;
    totalCost += r.costUsd;
  }
  return { rows, byModel, byTask, totalTokensIn, totalTokensOut, totalCost, calls: rows.length };
}

export async function clearUsage() {
  await masterMemory().delete(KEY);
}

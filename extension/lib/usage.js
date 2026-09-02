// lib/usage.js — usage accounting (per-LLM-call token/cost ledger).
//
// Records per-LLM-call usage (agentId, provider, model, input/output tokens,
// estimated cost) into the IndexedDB sole-authority ledger (lib/usage-store.js)
// with a rolling 7-day window, then aggregates by agent/provider/model/task/day.
// Every agent-do onUsage event flows through recordUsage(). Usage survives
// service-worker restarts WITHOUT the optional `storage` permission.
import { usageRead, usageWrite, usageClear, usageRemoveRow } from "./usage-store.js";
import { assertRunOwned } from "./run-fence.js";
import { kvGet, kvSet } from "./kv.js";

// One optional change listener (the SW registers it) — fired after every
// usage record/clear so the Settings Usage panel can be push-driven instead
// of polling `usage.get` every 1.5 s (CAP-FB-20260830-HUB-POLLING-01).
let usageChangeListener = null;

/** Register the single "usage changed" callback (null to clear). */
export function onUsageChanged(fn) {
  usageChangeListener = typeof fn === "function" ? fn : null;
}

function notifyUsageChanged() {
  if (!usageChangeListener) return;
  try { usageChangeListener(); } catch { /* a listener never breaks a write */ }
}

// ── Per-tool call counters (the Usage panel's tool-usage chart) ─────────────
// Bounded per-day per-tool counts over the same 7-day horizon as the ledger.
// Stored OUTSIDE the IndexedDB ledger (the ledger rows are validated token
// rows; mixing schemas in the sole-authority store is how corruption bugs
// start). Key: cap:usage:tools:v1 → { v: 1, days: { "YYYY-MM-DD": { tool: n } } }.
export const TOOL_USAGE_KEY = "cap:usage:tools:v1";
const TOOL_USAGE_DAYS = 7;
const MAX_TOOL_NAMES_PER_DAY = 64;
const MAX_TOOL_NAME_LEN = 128;
let toolUsageMutex = Promise.resolve();

// ── Provider server-tool usage (per-run query counts + cost ESTIMATES) ──────
// Server-side tools (Gemini google_search, …) bill PER EXECUTED QUERY, not per
// token, and the provider's free-tier meter is invisible to CAP — every figure
// here is a labelled estimate. Key: cap:usage:server-tools:v1 → { v:1, days: {
// "YYYY-MM-DD": [ { provider, tool, queries, estimatedUsd, note, at } ] } }.
export const SERVER_TOOL_USAGE_KEY = "cap:usage:server-tools:v1";
const SERVER_TOOL_USAGE_MAX_PER_DAY = 128;
let serverToolUsageMutex = Promise.resolve();

/** Record ONE run's provider-server usage. Fire-and-forget safe. */
export async function recordServerToolUsage(entry, nowMs = Date.now()) {
  const provider = String(entry?.provider ?? "").slice(0, 64);
  const tool = String(entry?.tool ?? "").slice(0, 64);
  const queries = Math.max(0, Math.min(1000, Math.trunc(Number(entry?.queries) || 0)));
  if (!provider || !tool || queries === 0) return;
  const estimatedUsd = Math.max(0, Number(entry?.estimatedUsd) || 0);
  const note = String(entry?.note ?? "").slice(0, 256);
  const run = serverToolUsageMutex.then(async () => {
    const store = await kvGet([SERVER_TOOL_USAGE_KEY]);
    const cur = store?.[SERVER_TOOL_USAGE_KEY];
    const days = cur && typeof cur === "object" && cur.days && typeof cur.days === "object" ? cur.days : {};
    const day = todayKey(new Date(nowMs));
    const rows = Array.isArray(days[day]) ? days[day] : [];
    if (rows.length < SERVER_TOOL_USAGE_MAX_PER_DAY) {
      rows.push({ provider, tool, queries, estimatedUsd, note, at: new Date(nowMs).toISOString() });
    }
    days[day] = rows;
    await kvSet({ [SERVER_TOOL_USAGE_KEY]: { v: 1, days: trimToolUsageDays(days) } });
    notifyUsageChanged();
  });
  serverToolUsageMutex = run.then(() => {}, () => {});
  return run;
}

/** Read the server-tool usage rows (usage panel). */
export async function getServerToolUsage() {
  return await serverToolUsageMutex.then(() => {}, () => {}).then(async () => {
    const store = await kvGet([SERVER_TOOL_USAGE_KEY]);
    const days = store?.[SERVER_TOOL_USAGE_KEY]?.days;
    if (!days || typeof days !== "object") return [];
    return Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, rows]) => ({ day, rows: Array.isArray(rows) ? rows : [] }));
  });
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function trimToolUsageDays(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > TOOL_USAGE_DAYS) delete days[keys.shift()];
  return days;
}

/** Count ONE tool invocation. Fire-and-forget safe: never throws to the caller
 * of the tool path — a telemetry write must not fail a tool execution. */
export async function recordToolCall(toolName, nowMs = Date.now()) {
  const name = String(toolName ?? "").slice(0, MAX_TOOL_NAME_LEN);
  if (!name) return;
  const run = toolUsageMutex.then(async () => {
    const store = await kvGet([TOOL_USAGE_KEY]);
    const cur = store?.[TOOL_USAGE_KEY];
    const days = cur && typeof cur === "object" && cur.days && typeof cur.days === "object" ? cur.days : {};
    const day = todayKey(new Date(nowMs));
    const today = days[day] && typeof days[day] === "object" ? days[day] : {};
    if (!(name in today) && Object.keys(today).length >= MAX_TOOL_NAMES_PER_DAY) return; // bounded
    today[name] = (Number(today[name]) || 0) + 1;
    days[day] = today;
    await kvSet({ [TOOL_USAGE_KEY]: { v: 1, days: trimToolUsageDays(days) } });
    notifyUsageChanged();
  });
  toolUsageMutex = run.then(() => {}, () => {});
  return run;
}

/** Roll the per-day counters up to per-tool totals over the retention window. */
export async function getToolUsage(nowMs = Date.now()) {
  return await toolUsageMutex.then(() => {}, () => {}).then(async () => {
    const store = await kvGet([TOOL_USAGE_KEY]);
    const cur = store?.[TOOL_USAGE_KEY];
    const days = cur && typeof cur === "object" && cur.days && typeof cur.days === "object" ? cur.days : {};
    const perTool = {};
    const cutoff = nowMs - TOOL_USAGE_DAYS * 24 * 60 * 60 * 1000;
    for (const [day, tools] of Object.entries(days)) {
      const dayMs = Date.parse(`${day}T00:00:00Z`);
      if (!Number.isFinite(dayMs) || dayMs < cutoff) continue; // expired bucket
      if (!tools || typeof tools !== "object") continue;
      for (const [name, n] of Object.entries(tools)) {
        perTool[name] ??= { tool: name, calls: 0 };
        perTool[name].calls += Number(n) || 0;
      }
    }
    return Object.values(perTool).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  });
}

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
    notifyUsageChanged();
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
      totalTokens: 0,
      model: r.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    byModel[mk].calls++;
    byModel[mk].inputTokens += r.inputTokens;
    byModel[mk].outputTokens += r.outputTokens;
    byModel[mk].totalTokens += r.totalTokens;
    byModel[mk].estimatedCost += r.estimatedCost;

    // By provider (the provider-level breakdown).
    byProvider[r.provider] ??= {
      provider: r.provider,
      totalTokens: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    };
    byProvider[r.provider].calls++;
    byProvider[r.provider].inputTokens += r.inputTokens;
    byProvider[r.provider].outputTokens += r.outputTokens;
    byProvider[r.provider].totalTokens += r.totalTokens;
    byProvider[r.provider].estimatedCost += r.estimatedCost;

    // By agent (each agent's attributable usage + cost).
    byAgent[r.agentId] ??= {
      agentId: r.agentId,
      totalTokens: 0,
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
    byAgent[r.agentId].totalTokens += r.totalTokens;
    byAgent[r.agentId].estimatedCost += r.estimatedCost;

    // By task (each task's attributable usage + cost, with its agent).
    const tk = r.taskId ?? "adhoc";
    byTask[tk] ??= {
      taskId: tk,
      agentId: r.agentId ?? "hub",
      totalTokens: 0,
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
    byTask[tk].totalTokens += r.totalTokens;
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
    tools: await getToolUsage(),
  };
}

export async function clearUsage() {
  return await withUsageLock(async () => {
    await usageClear();
    await kvSet({ [TOOL_USAGE_KEY]: { v: 1, days: {} } });
    // Serialize with any in-flight provider-server append: "Clear usage" is one
    // owner action and must empty every usage ledger before it resolves.
    const clearServerTools = serverToolUsageMutex.then(async () => {
      await kvSet({ [SERVER_TOOL_USAGE_KEY]: { v: 1, days: {} } });
    });
    serverToolUsageMutex = clearServerTools.then(() => {}, () => {});
    await clearServerTools;
    notifyUsageChanged();
  });
}

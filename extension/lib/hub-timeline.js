// lib/hub-timeline.js — the hub timeline projection (pure).
//
// CAP-FB-20260828-HUB-AS-TIMELINE-01: the hub below the composer is a single
// reverse-chronological TIMELINE of what happened — the tasks the owner started
// and the runs their agents finished — not three object catalogs (Agents /
// Recent artifacts / Recent activity). This module turns the two durable
// sources (the thread index + the durable-run registry) into one ordered list
// of rows. It is pure and backend-free so it unit-tests directly and the
// gallery can seed the component without the extension.
//
// A row answers the coworker question "what is in flight, what is waiting on
// me, what came back while I was away?": the task/run title (what was asked),
// the agent that ran it, when it last moved, its outcome, and a way to open it.

/** Runs surfaced on their own (without a task thread) — the "came back while I
 * was away" rows. A bare `task` run with no thread is a failed dispatch and
 * belongs to the sidebar's failed-runs section, not here. */
const STANDALONE_RUN_KINDS = new Set(["agent", "scheduled", "delegate"]);

function short(value, n = 90) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Drop the scheme and a leading www. from an origin for a compact @label. */
function shortOrigin(origin) {
  const s = String(origin ?? "");
  return s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

function asNameMap(agentNames) {
  if (agentNames instanceof Map) return agentNames;
  if (agentNames && typeof agentNames === "object") return new Map(Object.entries(agentNames));
  return new Map();
}

/** The human agent attribution for a run record. A plain owner task (no agent,
 * or the master/hub surface) carries no chip — attribution is only meaningful
 * for a named/background agent, an enrolled site, or a scheduled run. */
export function timelineAgentLabel(run, agentNames) {
  const names = asNameMap(agentNames);
  if (!run || typeof run !== "object") return "";
  const aid = typeof run.agentId === "string" ? run.agentId : "";
  if (names.has(aid) && names.get(aid)) return names.get(aid);
  if (aid && aid !== "master" && aid !== "hub") {
    if (aid.startsWith("named:")) return aid.slice("named:".length);
    if (aid.startsWith("background:")) return aid.slice("background:".length);
    if (/^[a-z]+:\/\//i.test(aid)) return `@${shortOrigin(aid)}`;
    return aid;
  }
  if (run.kind === "scheduled" && run.scheduleName) return String(run.scheduleName);
  return "";
}

/** One of "running" | "paused" | "failed" | "done" | "" (unknown). Derived from
 * the durable run's phase/terminal when a run exists, else the thread status. */
export function timelineStatus(thread, run) {
  const phase = run && typeof run === "object" ? String(run.phase ?? "") : "";
  const terminalFailed = run?.terminal && run.terminal.ok === false;
  if (phase) {
    if (["running", "settling", "resume-dispatching", "cancel-requested"].includes(phase)) return "running";
    if (phase.startsWith("paused")) return "paused";
    if (phase === "failed" || phase === "cancelled") return "failed";
    if (phase === "done" || phase === "terminal") return terminalFailed ? "failed" : "done";
  }
  if (terminalFailed) return "failed";
  const ts = thread && typeof thread === "object" ? String(thread.status ?? "") : "";
  if (ts === "running") return "running";
  if (ts === "error") return "failed";
  if (ts) return "done";
  return phase ? "done" : "";
}

function outcomeText(status, run) {
  const reason = run?.pause?.reason ? short(run.pause.reason) : "";
  const summary = run?.terminal?.summary ? short(run.terminal.summary) : "";
  switch (status) {
    case "running": return "Running…";
    case "paused": return reason || "Waiting for you";
    case "failed": return summary || "Didn’t finish";
    case "done": return summary || "";
    default: return summary || "";
  }
}

function threadTime(t) {
  return Number(t?.updatedAt ?? t?.createdAt ?? 0) || 0;
}
function runTime(r) {
  return Number(r?.updatedAt ?? r?.terminal?.at ?? r?.startedAt ?? 0) || 0;
}

/**
 * Build the hub timeline: one reverse-chronological list of rows from the
 * thread index joined with the durable-run registry, plus standalone
 * agent/scheduled runs that never opened a task thread.
 *
 * @param {Array<object>} threads  thread index rows { id, name, preview, status, updatedAt, createdAt }
 * @param {Array<object>} runs     durable run records { executionId, threadId, agentId, kind, phase, terminal, taskPreview, scheduleName, updatedAt, startedAt }
 * @param {{ agentNames?: Map|object, limit?: number }} [opts]
 * @returns {Array<{ id, kind, threadId?, executionId?, agentId?, title, agent, time, status, outcome }>}
 */
export function buildTimeline(threads = [], runs = [], opts = {}) {
  const names = asNameMap(opts.agentNames);
  const limit = Number.isFinite(opts.limit) ? opts.limit : 40;
  const runList = Array.isArray(runs) ? runs : [];

  // The latest run per thread (the outcome the thread row shows).
  const latestByThread = new Map();
  for (const r of runList) {
    const tid = r?.threadId;
    if (!tid) continue;
    const cur = latestByThread.get(tid);
    if (!cur || runTime(r) >= runTime(cur)) latestByThread.set(tid, r);
  }

  const entries = [];
  const threadIds = new Set();
  for (const t of (Array.isArray(threads) ? threads : [])) {
    if (!t?.id) continue;
    threadIds.add(t.id);
    const run = latestByThread.get(t.id) || null;
    const status = timelineStatus(t, run);
    entries.push({
      id: t.id,
      kind: "thread",
      threadId: t.id,
      title: short(t.name || t.preview || "Task", 120),
      agent: timelineAgentLabel(run, names),
      time: Math.max(threadTime(t), run ? runTime(run) : 0),
      status,
      outcome: outcomeText(status, run),
    });
  }

  for (const r of runList) {
    if (r?.threadId && threadIds.has(r.threadId)) continue; // already the thread row's outcome
    if (!STANDALONE_RUN_KINDS.has(r?.kind)) continue;
    if (!r?.executionId) continue;
    const status = timelineStatus(null, r);
    entries.push({
      id: `run:${r.executionId}`,
      kind: r.kind,
      executionId: r.executionId,
      agentId: typeof r.agentId === "string" ? r.agentId : null,
      title: short(r.taskPreview || r.scheduleName || "Run", 120),
      agent: timelineAgentLabel(r, names),
      time: runTime(r),
      status,
      outcome: outcomeText(status, r),
    });
  }

  entries.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return entries.slice(0, limit);
}

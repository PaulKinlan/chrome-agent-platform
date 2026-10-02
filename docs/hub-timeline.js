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
import { projectThreadRunState } from "./thread-projection-authority.js";

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
 * the durable run's phase/terminal when a run exists, else the thread status —
 * through the ONE projection the sidebar dot and the conversation status row
 * also read (chrome-agent-platform-716s.1), so a run still waiting on an
 * approval card reads "paused" here exactly as it does there. */
export function timelineStatus(thread, run, pendingApprovals = []) {
  return projectThreadRunState({ thread, run, pendingApprovals }).timeline;
}

function outcomeText(thread, run, pendingApprovals) {
  return projectThreadRunState({ thread, run, pendingApprovals }).outcome;
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
 * @param {{ agentNames?: Map|object, limit?: number, pendingApprovals?: object[] }} [opts]
 *   `pendingApprovals` — the page's still-unanswered approval-request events; a
 *   run waiting on one of them is a "paused" row ("Waiting for you").
 * @returns {Array<{ id, kind, threadId?, executionId?, agentId?, title, agent, time, status, outcome }>}
 */
export function buildTimeline(threads = [], runs = [], opts = {}) {
  const names = asNameMap(opts.agentNames);
  const limit = Number.isFinite(opts.limit) ? opts.limit : 40;
  const runList = Array.isArray(runs) ? runs : [];
  const pendingApprovals = Array.isArray(opts.pendingApprovals) ? opts.pendingApprovals : [];

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
    const status = timelineStatus(t, run, pendingApprovals);
    entries.push({
      id: t.id,
      kind: "thread",
      threadId: t.id,
      title: short(t.name || t.preview || "Task", 120),
      agent: timelineAgentLabel(run, names),
      time: Math.max(threadTime(t), run ? runTime(run) : 0),
      status,
      outcome: outcomeText(t, run, pendingApprovals),
    });
  }

  for (const r of runList) {
    if (r?.threadId && threadIds.has(r.threadId)) continue; // already the thread row's outcome
    if (!STANDALONE_RUN_KINDS.has(r?.kind)) continue;
    if (!r?.executionId) continue;
    const status = timelineStatus(null, r, pendingApprovals);
    entries.push({
      id: `run:${r.executionId}`,
      kind: r.kind,
      executionId: r.executionId,
      agentId: typeof r.agentId === "string" ? r.agentId : null,
      title: short(r.taskPreview || r.scheduleName || "Run", 120),
      agent: timelineAgentLabel(r, names),
      time: runTime(r),
      status,
      outcome: outcomeText(null, r, pendingApprovals),
    });
  }

  entries.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return entries.slice(0, limit);
}

export const TIMELINE_FILTERS = Object.freeze(["All", "Runs", "Waiting", "Made", "Scheduled"]);

/**
 * Pure predicate over a timeline row: returns true if the entry matches the filter.
 *
 * Primary filters:
 * - All: every row
 * - Runs: thread/task/agent runs (excluding scheduled runs and artifacts)
 * - Waiting: paused/waiting runs, pending permissions, blocked items
 * - Made: artifacts / deliverables created
 * - Scheduled: scheduled agent runs
 *
 * Secondary facets (Hooks, Pages, Spent) supported if present.
 *
 * @param {object} entry
 * @param {string} [filter="All"]
 * @returns {boolean}
 */
export function timelineMatchesFilter(entry, filter = "All") {
  if (!entry || typeof entry !== "object") return false;
  const f = String(filter || "All").trim().toLowerCase();
  switch (f) {
    case "all":
      return true;
    case "runs":
      return (
        entry.kind === "thread" ||
        entry.kind === "task" ||
        entry.kind === "agent" ||
        entry.kind === "delegate" ||
        (entry.kind !== "scheduled" &&
          entry.kind !== "schedule-ran" &&
          entry.kind !== "artifact" &&
          entry.kind !== "made" &&
          entry.kind !== "hook" &&
          entry.kind !== "page" &&
          entry.kind !== "spent")
      );
    case "waiting":
      return (
        entry.status === "paused" ||
        entry.status === "waiting" ||
        entry.status === "approval-pending" ||
        entry.status === "waiting-for-permission" ||
        entry.status === "blocked" ||
        entry.kind === "approval-pending" ||
        entry.kind === "waiting-for-permission" ||
        entry.kind === "blocked" ||
        entry.kind === "approval-requested" ||
        entry.kind === "permission" ||
        entry.blocked === true
      );
    case "made":
      return (
        entry.kind === "artifact" ||
        entry.kind === "made" ||
        Boolean(entry.artifact) ||
        (typeof entry.title === "string" && entry.title.startsWith("Made ")) ||
        (typeof entry.outcome === "string" && entry.outcome.startsWith("Made "))
      );
    case "scheduled":
      return (
        entry.kind === "scheduled" ||
        entry.kind === "schedule-ran" ||
        Boolean(entry.scheduleName) ||
        (typeof entry.id === "string" && entry.id.startsWith("run:sched"))
      );
    case "hooks":
      return entry.kind === "hook" || entry.kind === "event";
    case "pages":
      return entry.kind === "page" || entry.kind === "navigation";
    case "spent":
      return entry.kind === "spent" || entry.kind === "cost";
    default:
      return true;
  }
}

/**
 * Filter an array of timeline rows with a pure predicate.
 *
 * @param {Array<object>} entries
 * @param {string} [filter="All"]
 * @returns {Array<object>}
 */
export function filterTimeline(entries, filter = "All") {
  const list = Array.isArray(entries) ? entries : [];
  const f = String(filter || "All").trim();
  if (!f || f.toLowerCase() === "all") return list;
  return list.filter((e) => timelineMatchesFilter(e, f));
}

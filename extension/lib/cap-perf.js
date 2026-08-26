// lib/cap-perf.js — performance marks/measures for the extension's slow paths.
//
// Owner requirement (CAP-FB-20260826-OBSERVABILITY-01): "I click on a task and
// it can take 10 seconds to load and there is no trace of what it is doing."
// This module turns that mystery into a per-stage breakdown using Chrome's
// native User Timing API (performance.mark / performance.measure) — visible in
// DevTools' Performance panel AND summarised in the console via cap-log.
//
// Usage:
//   import { perfSpan } from "./cap-perf.js";
//   const span = perfSpan("task_load");
//   …work…
//   span.end();            // logs "[cap:perf] task_load in 842ms (ok)"
//   // or span.end("error") on failure — duration still recorded.
//
// perfSummary() aggregates all cap:* measures (name → count/total/avg/max/last)
// for the trace dump; perfReport() console.tables it at verbose. The measure
// buffer is BOUNDED (MAX_MEASURES) — when exceeded the oldest cap measures are
// cleared and the truncation is recorded honestly. No content, args, or
// secrets are ever recorded — only stage names and durations.

import { capLog } from "./cap-log.js";

const log = capLog("perf");
const MARK_PREFIX = "cap:";
const MAX_MEASURES = 500;

let truncated = 0;
let seq = 0;

function hasUserTiming() {
  try {
    return typeof performance !== "undefined" &&
      typeof performance.mark === "function" &&
      typeof performance.measure === "function";
  } catch {
    return false;
  }
}

function now() {
  try {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  } catch {
    return Date.now();
  }
}

function enforceBound() {
  if (!hasUserTiming()) return;
  try {
    const measures = performance.getEntriesByType("measure")
      .filter((e) => e.name.startsWith(MARK_PREFIX));
    if (measures.length <= MAX_MEASURES) return;
    const excess = measures.length - MAX_MEASURES;
    truncated += excess;
    for (const entry of measures.slice(0, excess)) {
      performance.clearMeasures(entry.name);
    }
  } catch { /* perf bookkeeping must never break the product */ }
}

/**
 * Start a named span. `span.end(outcome?)` records a measure and logs the
 * duration through cap-log. outcome is "ok" (default) or "error"/any short
 * string — never pass content.
 */
export function perfSpan(name, { ns = "perf" } = {}) {
  const cleanName = String(name).replace(/[^0-9A-Za-z_:.\-]/g, "_").slice(0, 80);
  const id = ++seq;
  const startMark = `${MARK_PREFIX}${cleanName}:start:${id}`;
  const measureName = `${MARK_PREFIX}${cleanName}`;
  const startedAt = now();
  let ended = false;
  try {
    if (hasUserTiming()) performance.mark(startMark);
  } catch { /* noop */ }
  return {
    end(outcome = "ok") {
      if (ended) return 0;
      ended = true;
      const elapsed = Math.max(0, now() - startedAt);
      try {
        if (hasUserTiming()) {
          performance.measure(measureName, startMark);
          performance.clearMarks(startMark);
          enforceBound();
        }
      } catch { /* noop */ }
      log.debug(`${cleanName} in ${elapsed.toFixed(1)}ms (${String(outcome).slice(0, 24)})`);
      return elapsed;
    },
  };
}

/** Aggregate all recorded cap:* measures into a readable breakdown. */
export function perfSummary() {
  const out = { measures: [], truncated, generatedAt: new Date().toISOString() };
  if (!hasUserTiming()) return out;
  try {
    const byName = new Map();
    for (const entry of performance.getEntriesByType("measure")) {
      if (!entry.name.startsWith(MARK_PREFIX)) continue;
      const name = entry.name.slice(MARK_PREFIX.length);
      const row = byName.get(name) ?? { name, count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
      row.count += 1;
      row.totalMs += entry.duration;
      row.maxMs = Math.max(row.maxMs, entry.duration);
      row.lastMs = entry.duration;
      byName.set(name, row);
    }
    out.measures = [...byName.values()]
      .map((row) => ({
        name: row.name,
        count: row.count,
        totalMs: Math.round(row.totalMs * 10) / 10,
        avgMs: Math.round((row.totalMs / row.count) * 10) / 10,
        maxMs: Math.round(row.maxMs * 10) / 10,
        lastMs: Math.round(row.lastMs * 10) / 10,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
  } catch { /* noop */ }
  return out;
}

/** Console-table the summary (verbose only) — the owner's "where did 10s go". */
export function perfReport() {
  const summary = perfSummary();
  if (summary.measures.length === 0) {
    log.info("no performance measures recorded yet");
    return summary;
  }
  log.info(`${summary.measures.length} measured stages${summary.truncated ? ` (${summary.truncated} truncated)` : ""}`);
  if (log.verbose) {
    try { console.table(summary.measures); } catch { /* noop */ }
  }
  return summary;
}

/** Clear all cap marks/measures (trace reset). */
export function perfClear() {
  if (!hasUserTiming()) return;
  try {
    for (const entry of performance.getEntriesByType("measure")) {
      if (entry.name.startsWith(MARK_PREFIX)) performance.clearMeasures(entry.name);
    }
    for (const entry of performance.getEntriesByType("mark")) {
      if (entry.name.startsWith(MARK_PREFIX)) performance.clearMarks(entry.name);
    }
  } catch { /* noop */ }
}

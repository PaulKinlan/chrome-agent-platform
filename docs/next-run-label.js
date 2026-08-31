// lib/next-run-label.js — the ONE "Next run" projector
// (CAP-FB-20260831-SCHEDULED-NEXT-RUN-WIDGET-01).
//
// A routine (a scheduled/recurring task) fires from a REAL chrome.alarms alarm.
// This module turns that alarm's `scheduledTime` (epoch ms, read via
// chrome.alarms.get / getAll in lib/scheduler.js) into the human label the hub
// shows: a relative countdown ("in 3 minutes") joined to the absolute clock
// time ("Sep 1, 3:45 PM"). Both the <next-run> web component and the NTP
// routine row render THROUGH this function, and the unit test pins ITS output —
// a display path must never re-implement the relative/plural arithmetic, or a
// routine's next fire would read differently in two places.
//
// Pure: no DOM, no chrome, no Date.now() side effects beyond the injectable
// `now`. Every branch is deterministic given (nextFireAt, now, locale,
// timeZone) so the singular/plural boundaries are testable.

// How often a live <next-run> widget re-computes its countdown as the fire
// approaches (a routine an hour out does not need per-second churn; 30s keeps
// the minute-granular label honest without waking the tab constantly).
export const NEXT_RUN_TICK_MS = 30_000;

/** The relative countdown for a FUTURE delta (ms > 0), with correct
 * singular/plural. Seconds under a minute, then minutes, hours, days. */
export function relativeCountdown(deltaMs) {
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return `in ${sec} ${sec === 1 ? "second" : "seconds"}`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min} ${min === 1 ? "minute" : "minutes"}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr} ${hr === 1 ? "hour" : "hours"}`;
  const day = Math.round(hr / 24);
  return `in ${day} ${day === 1 ? "day" : "days"}`;
}

/** The absolute wall-clock time for the fire. Locale + timeZone are injectable
 * so the label is deterministic under test; in the product they default to the
 * viewer's locale/zone. The year is shown only when it differs from the year of
 * `now`, so an imminent routine stays terse. */
export function absoluteClock(ts, { now = Date.now(), locale, timeZone } = {}) {
  try {
    const d = new Date(ts);
    const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    if (timeZone) opts.timeZone = timeZone;
    if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
    return d.toLocaleString(locale, opts);
  } catch {
    return "";
  }
}

/**
 * The full "Next run" projection for a routine, from its live alarm fire time.
 *
 * @param {number} nextFireAt  epoch ms of the alarm's scheduledTime, or null.
 * @returns {null | { due: boolean, deltaMs: number, relative: string,
 *                    absolute: string, label: string }}
 *   null when there is no armed next fire (paused / quarantined / no alarm).
 *   `due` is true once the fire time has passed (a routine mid-fire, or an
 *   overdue one-shot awaiting its worker) — the label reads "due now" rather
 *   than a negative countdown.
 */
export function nextRunLabel(nextFireAt, { now = Date.now(), locale, timeZone } = {}) {
  if (typeof nextFireAt !== "number" || !Number.isFinite(nextFireAt)) return null;
  const deltaMs = nextFireAt - now;
  const absolute = absoluteClock(nextFireAt, { now, locale, timeZone });
  if (deltaMs <= 0) {
    const relative = "due now";
    return { due: true, deltaMs, relative, absolute, label: `Next run ${relative}${absolute ? ` · ${absolute}` : ""}` };
  }
  const relative = relativeCountdown(deltaMs);
  return { due: false, deltaMs, relative, absolute, label: `Next run ${relative}${absolute ? ` · ${absolute}` : ""}` };
}

/** The "Last run <ago>" projection for a routine that has already fired at
 * least once. `at` is the last fire's epoch ms; null when it has never run. */
export function lastRunLabel(at, { now = Date.now() } = {}) {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const d = Math.max(0, now - at);
  const m = Math.floor(d / 60000);
  let ago;
  if (m < 1) ago = "just now";
  else if (m < 60) ago = `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  else {
    const h = Math.floor(m / 60);
    if (h < 24) ago = `${h} ${h === 1 ? "hour" : "hours"} ago`;
    else {
      const days = Math.floor(h / 24);
      ago = `${days} ${days === 1 ? "day" : "days"} ago`;
    }
  }
  return { ago, label: `Last run ${ago}` };
}

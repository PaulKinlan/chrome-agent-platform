// lib/scheduled-run-report.js — the "results persist" primitive for scheduled
// runs (CAP-FB-20260830-SCHEDULED-RUN-OUTPUT-01).
//
// A scheduled agent used to run and leave nothing the owner could see: no
// artifact, no timeline row, no notification. The durable-run registry already
// records the run (so the hub timeline surfaces it as a row on reopen) and the
// completion notification is raised elsewhere in the scheduled settle path.
// This module owns the missing half: on settle, every scheduled run writes ONE
// KEYED report artifact to the agent's OWN origin store, so the outcome is
// retrievable and — because the key is stable per agent — the report ROLLS
// (each fire replaces the previous, same asset id) rather than piling up a new
// artifact every minute.
//
// Pure/near-pure by design: the write goes through the injected
// `createOrUpdateAssetKeyed` seam so it unit-tests directly against the
// in-memory OPFS fake, and the service worker calls it with the real one.

import { createOrUpdateAssetKeyed as realCreateOrUpdateAssetKeyed } from "./artifacts.js";

/** The report body is bounded — a runaway model result must never blow the
 * artifact size bound or the notification. */
export const SCHEDULED_REPORT_MAX_SUMMARY = 4000;

/** The origin-store key prefix. One key per agent slug → the report rolls. */
export const SCHEDULED_REPORT_KEY_PREFIX = "scheduled-report:";

/** Recover the agent slug from a schedule/alarm name (`agent:<slug>`,
 * `recipe:<id>`, `background:<id>`, `named:<slug>`) or fall back to the raw
 * task id. The slug keys the rolling report, so it must be stable per agent. */
export function scheduledReportSlug(scheduleName, fallback = "run") {
  const s = String(scheduleName ?? "").trim();
  for (const prefix of ["agent:", "recipe:", "background:", "named:"]) {
    if (s.startsWith(prefix)) {
      const rest = s.slice(prefix.length).trim();
      if (rest) return rest;
    }
  }
  if (s) return s;
  const fb = String(fallback ?? "").trim();
  return fb || "run";
}

/** The stable per-agent artifact key. */
export function scheduledReportKey(slug) {
  return `${SCHEDULED_REPORT_KEY_PREFIX}${String(slug || "run")}`;
}

/** The report text: who ran, when (ISO), and the one-line-or-more outcome. All
 * of it is untrusted model output, so the consumer renders it with textContent;
 * here it is only bounded and trimmed. */
export function buildScheduledReportBody({ summary, at, agentLabel } = {}) {
  const iso = new Date(Number.isFinite(Number(at)) ? Number(at) : Date.now()).toISOString();
  const body = String(summary ?? "").replace(/\r\n/g, "\n").slice(0, SCHEDULED_REPORT_MAX_SUMMARY).trim();
  const who = String(agentLabel ?? "").trim();
  const header = who ? `${who}\n${iso}` : iso;
  return `${header}\n\n${body || "(the scheduled run produced no text output)"}`;
}

/** The shipped icon the completion notification uses (relative path — the
 * service worker resolves it with chrome.runtime.getURL). Fixed by
 * CAP-FB-20260830-NOTIFY-ICON-PATH-01: the file is `icons/icon128.png`. */
export const SCHEDULED_NOTIFICATION_ICON = "icons/icon128.png";

/** The notification message is bounded (a runaway result must never blow it). */
export const SCHEDULED_NOTIFICATION_MAX_MESSAGE = 160;

/** Where a scheduled-run notification's click should land. A named/background
 * agent's run has NO task thread (its transcript is its agent conversation), so
 * the click must open the AGENT surface — routing it to a `thread:` target
 * would open nothing. A genuine owner task keeps the default thread-open. */
export function scheduledNotificationClickAction(agentSurfaceRef) {
  const ref = String(agentSurfaceRef ?? "");
  if (ref.startsWith("named:")) {
    return { type: "navigate", path: `ntp/ntp.html#agent=named:${encodeURIComponent(ref.slice("named:".length))}` };
  }
  if (ref.startsWith("background:")) {
    return { type: "navigate", path: `ntp/ntp.html#agent=background:${encodeURIComponent(ref.slice("background:".length))}` };
  }
  return { type: "default" };
}

/** The full completion-notification spec: the registry record fields plus the
 * relative icon path and the bounded message. The service worker registers it
 * and calls chrome.notifications.create with `chrome.runtime.getURL(iconPath)`. */
export function buildScheduledNotification({ taskId, executionId, agentSurfaceRef, summary } = {}) {
  const message = String(summary ?? "").slice(0, SCHEDULED_NOTIFICATION_MAX_MESSAGE);
  return {
    notificationId: `cap:task:${taskId}`,
    taskId,
    executionId,
    threadId: taskId,
    title: "Scheduled task complete",
    message,
    action: scheduledNotificationClickAction(agentSurfaceRef),
    iconPath: SCHEDULED_NOTIFICATION_ICON,
  };
}

/**
 * Write (or roll) the scheduled-run report artifact for one agent.
 *
 * @param {{ createOrUpdateAssetKeyed?: Function }} deps  the write seam (defaults to the real one)
 * @param {{ origin?: string, scheduleName?: string, slug?: string, taskId?: string,
 *           summary?: string, at?: number, agentLabel?: string, ok?: boolean }} run
 * @returns {Promise<object>} the createOrUpdateAssetKeyed result ({ ok, id, created|updated })
 */
export async function writeScheduledRunReport(deps, run = {}) {
  const write = (deps && typeof deps.createOrUpdateAssetKeyed === "function")
    ? deps.createOrUpdateAssetKeyed
    : realCreateOrUpdateAssetKeyed;
  const slug = run.slug || scheduledReportSlug(run.scheduleName, run.taskId);
  const key = scheduledReportKey(slug);
  // The report lives in the agent's OWN origin store — never the master's and
  // never another agent's (origin-keyed memory is non-negotiable).
  const origin = typeof run.origin === "string" && run.origin ? run.origin : "master";
  const agentLabel = String(run.agentLabel ?? slug);
  const at = Number.isFinite(Number(run.at)) ? Number(run.at) : Date.now();
  return await write(origin, {
    key,
    type: "text",
    name: `${agentLabel} — scheduled report`.slice(0, 120),
    content: buildScheduledReportBody({ summary: run.summary, at, agentLabel }),
    meta: { kind: "scheduled-report", slug, ok: run.ok !== false, at },
  });
}

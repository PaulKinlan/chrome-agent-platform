// board-view-model.js — the PURE projection for the shared jobs board.
//
// One authority for "what state is this job in and which group does it belong
// to", shared by the <jobs-board> view component (extension/shared/components.js)
// and its unit test (tests/board-view-model.test.ts). No DOM, no I/O: it takes
// the `board.list` job array and returns the owner-facing view model — four
// active/settled groups plus a per-job status descriptor whose LABEL is text
// (never colour alone) so the state is legible without relying on the dot tone.
//
// Job shape (from extension/lib/agent-board.js listJobs): { id, status:
// "pending"|"claimed"|"completed"|"failed", description, posterId, posterName,
// claimantId, claimantName, targetName, blockedBy: string[], blockedByOpen:
// number, blocked: boolean, posterThreadId, createdAt, claimedAt, settledAt,
// result }.

/**
 * The single status descriptor for a job. `key` drives the grouping, `label`
 * is the owner-visible status WORD (text, so colour is never the only signal),
 * and `tone` is the accent role for the dot/badge.
 * A blocked job reads as BLOCKED, never as an open or claimed job — an owner
 * (and the claim guard) must see that it cannot be picked up yet.
 * @param {object} job
 * @returns {{ key: "open"|"claimed"|"blocked"|"completed"|"failed", label: string, tone: string }}
 */
export function statusOf(job) {
  if (!job || typeof job !== "object") return { key: "open", label: "Open", tone: "open" };
  if (job.status === "completed") return { key: "completed", label: "Completed", tone: "done" };
  if (job.status === "failed") return { key: "failed", label: "Failed", tone: "fail" };
  const blockedByOpen = Number(job.blockedByOpen ?? 0);
  if (job.blocked === true || blockedByOpen > 0) return { key: "blocked", label: "Blocked", tone: "blocked" };
  if (job.status === "claimed") return { key: "claimed", label: "Claimed", tone: "claimed" };
  return { key: "open", label: "Open", tone: "open" };
}

/**
 * Project the raw board.list jobs into the owner-facing groups. Settled jobs
 * sort most-recently-settled first; active groups keep the source order (which
 * is newest-first from the store). `counts.active` is every unsettled job
 * (open + claimed + blocked) — the number the owner is waiting on.
 * @param {unknown} jobs
 */
export function projectBoard(jobs) {
  const list = Array.isArray(jobs) ? jobs.filter((j) => j && typeof j === "object") : [];
  const open = [];
  const claimed = [];
  const blocked = [];
  const settled = [];
  for (const job of list) {
    const { key } = statusOf(job);
    if (key === "completed" || key === "failed") settled.push(job);
    else if (key === "blocked") blocked.push(job);
    else if (key === "claimed") claimed.push(job);
    else open.push(job);
  }
  settled.sort((a, b) => (Number(b?.settledAt ?? 0)) - (Number(a?.settledAt ?? 0)));
  const counts = {
    open: open.length,
    claimed: claimed.length,
    blocked: blocked.length,
    settled: settled.length,
    active: open.length + claimed.length + blocked.length,
  };
  return { open, claimed, blocked, settled, counts };
}

/**
 * Who posted / who is on it, as owner-visible text. `poster` and `claimant`
 * are always present strings ("unclaimed" when no one has taken an active job)
 * so a row never renders an identity-less blank.
 * @param {object} job
 */
export function partiesOf(job) {
  const poster = String(job?.posterName ?? job?.posterId ?? "an agent");
  const claimantId = job?.claimantId ?? null;
  const claimant = claimantId ? String(job?.claimantName ?? claimantId) : null;
  return { poster, claimant, unclaimed: !claimant };
}

// Why an Activity-ledger frontier failure happened, as a NAME the harness can print.
//
// Both findings behind this module are the same shape: a red that could not say which of two
// causes it was (chrome-agent-platform-jm54c, chrome-agent-platform-0g5ql). This module is pure
// and dependency-free on purpose - it reads counters the harness ALREADY has, never the DOM,
// never Chrome, and never a provider payload (the frontier's own rule is stage names, timestamps
// and counts only).

/** The Activity-ledger approval poll's wall-clock budget.
 *
 *  The poll used to be bounded only by `i < 120` iterations of a 250ms sleep, i.e. up to 30s of
 *  polling in front of the terminal wait and inside the harness's 90s no-assertion watchdog, so
 *  "the run did not settle" and "the poll exhausted its budget" produced the SAME red (jm54c).
 *  A real poll needs a few hundred milliseconds; this budget is far above the happy path and far
 *  below the watchdog. */
export const APPROVAL_POLL_BUDGET_MS = 15_000;

/**
 * Name why the approval poll stopped.
 *
 * `"settled"` is the only outcome a passing run may report. An exhausted budget OUTRANKS the card
 * conditions on purpose: when the poll gave up early, whether a card would have appeared is
 * exactly what is unknown, and saying "card never appeared" there would be a claim the run cannot
 * support.
 *
 * @param {{requests: number, cardSeen: boolean, cardApproved: boolean, elapsedMs: number, budgetMs?: number}} poll
 * @returns {"settled" | "poll-budget-exhausted" | "approval-card-never-appeared" | "approval-card-not-approved"}
 */
export function approvalPollCause(poll) {
  const budgetMs = poll.budgetMs ?? APPROVAL_POLL_BUDGET_MS;
  if (poll.cardSeen && poll.cardApproved && poll.requests >= 3) return "settled";
  if (poll.elapsedMs >= budgetMs) return "poll-budget-exhausted";
  if (!poll.cardSeen) return "approval-card-never-appeared";
  if (!poll.cardApproved) return "approval-card-not-approved";
  return "settled";
}

/**
 * Name the frontier's `provider.set` outcome.
 *
 * `provider.set` resolves to the redacted config on success and to `{ err }` on rejection, and the
 * frontier used to DISCARD that value, so a later failure could not separate "provider.set was
 * rejected" (nothing was ever configured, so no dispatch was possible) from "the composer never
 * dispatched" (0g5ql). The value is reduced to a name here; the payload is never returned, logged
 * or compared.
 *
 * @param {unknown} response the resolved value of the `provider.set` sendMessage
 * @returns {"provider-set-accepted" | "provider-set-rejected" | "provider-set-unreported"}
 */
export function providerSetCause(response) {
  if (response === undefined || response === null) return "provider-set-unreported";
  if (typeof response === "object" && typeof /** @type {{err?: unknown}} */ (response).err !== "undefined") {
    const err = /** @type {{err?: unknown}} */ (response).err;
    if (err) return "provider-set-rejected";
  }
  return "provider-set-accepted";
}

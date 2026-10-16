// chrome-agent-platform-jm54c + chrome-agent-platform-0g5ql: the Activity-ledger frontier's two
// reds could not name which of two causes they were. These are the NAMES, unit-tested without a
// browser: the harness reads them into its trace and its terminal check's evidence.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  approvalPollCause,
  APPROVAL_POLL_BUDGET_MS,
  providerSetCause,
} from "../scripts/lib/journey-failure-cause.mjs";

Deno.test("jm54c: an exhausted poll budget and a card that never appeared are DIFFERENT names", () => {
  // The whole point of the finding: these two used to be the same red ("the run did not settle").
  const exhausted = approvalPollCause({
    requests: 0, cardSeen: false, cardApproved: false, elapsedMs: APPROVAL_POLL_BUDGET_MS,
  });
  const neverAppeared = approvalPollCause({
    requests: 0, cardSeen: false, cardApproved: false, elapsedMs: 4_000,
  });
  assertEquals(exhausted, "poll-budget-exhausted");
  assertEquals(neverAppeared, "approval-card-never-appeared");
  assert(exhausted !== neverAppeared, "an exhausted budget must not be reported as a missing card");
});

Deno.test("jm54c: an exhausted budget outranks the card conditions it made unobservable", () => {
  // If the poll gave up early, whether a card would have appeared is exactly what is unknown.
  assertEquals(
    approvalPollCause({ requests: 2, cardSeen: true, cardApproved: false, elapsedMs: APPROVAL_POLL_BUDGET_MS + 1 }),
    "poll-budget-exhausted",
  );
  assertEquals(
    approvalPollCause({ requests: 2, cardSeen: true, cardApproved: false, elapsedMs: 1_000 }),
    "approval-card-not-approved",
  );
  assertEquals(
    approvalPollCause({ requests: 3, cardSeen: true, cardApproved: true, elapsedMs: 700 }),
    "settled",
  );
});

Deno.test("jm54c: the budget is a finite wall clock below the harness's watchdog", () => {
  assert(Number.isFinite(APPROVAL_POLL_BUDGET_MS) && APPROVAL_POLL_BUDGET_MS > 0);
  assert(
    APPROVAL_POLL_BUDGET_MS < 90_000,
    `the poll budget (${APPROVAL_POLL_BUDGET_MS}ms) must sit below the 90s no-assertion watchdog`,
  );
  // A caller may state its own budget; the default is only a default.
  assertEquals(
    approvalPollCause({ requests: 0, cardSeen: false, cardApproved: false, elapsedMs: 30, budgetMs: 20 }),
    "poll-budget-exhausted",
  );
});

Deno.test("0g5ql: a rejected provider.set and an accepted one are DIFFERENT names", () => {
  assertEquals(providerSetCause({ err: "provider.set refused: empty model" }), "provider-set-rejected");
  assertEquals(providerSetCause({ provider: "openai-compatible", model: "scripted" }), "provider-set-accepted");
  assert(
    providerSetCause({ err: "refused" }) !== providerSetCause({ provider: "openai-compatible" }),
    "a rejected provider.set must not read the same as an accepted one",
  );
});

Deno.test("0g5ql: an unreported provider.set is named, never mistaken for success", () => {
  // The defect was DISCARding the value; this makes the discarding visible instead of silent.
  assertEquals(providerSetCause(undefined), "provider-set-unreported");
  assertEquals(providerSetCause(null), "provider-set-unreported");
  assertEquals(providerSetCause({ err: "" }), "provider-set-accepted");
});

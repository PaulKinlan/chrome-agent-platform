// A MODEL's named-agent.create is approval-gated. The real Chrome journey must
// observe its pending card and drive a genuine owner Allow before crediting
// the run-created Activity row. Never import chrome-journeys.ts (starts Chrome).
import { assert, assertThrows } from "jsr:@std/assert@1";
import { DESTRUCTIVE_ACTIONS, isOwnerDirectApproval } from "../extension/lib/owner-approval.js";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
const start = source.indexOf("const ledgerProvider = await startScriptedProvider({");
const end = source.indexOf("// The run's durable thread is the owner-visible record", start);
assert(start >= 0 && end > start, "locate the live Activity creation leg without importing the browser script");
const leg = source.slice(start, end);
const action = "named-agent.create";

function assertGatedModelAction(isDirect = isOwnerDirectApproval) {
  assert(leg.includes('query: "create_named_agent"'), "Activity leg must search for the live create tool");
  assert(leg.includes('{ tool: "execute_tool"'), "Activity leg must execute the searched tool in a model run");
  assert(DESTRUCTIVE_ACTIONS.has(action), `${action} must stay in the approval policy`);
  assert(!isDirect({ principal: "model", executionId: "activity-run" }, action),
    `${action} must not be owner-direct for a model principal`);
}

function assertCardDrivenApproval(body: string) {
  const baseline = body.indexOf("__jnyLedgerPriorApprovalCards = new WeakSet");
  const pending = body.indexOf("!globalThis.__jnyLedgerPriorApprovalCards.has(card)");
  const saved = body.indexOf("globalThis.__jnyLedgerCard = card");
  const observed = body.indexOf("ledgerCardSeen = true");
  const scroll = body.indexOf("card.scrollIntoView(");
  const screenshot = body.indexOf('writeEvidence("activity-create-approval-pending.png"');
  const sameCard = body.indexOf("const card = globalThis.__jnyLedgerCard");
  const click = body.indexOf('await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x');
  const passed = body.indexOf("env?.ok === true");
  assert(baseline >= 0 && baseline < pending && pending < saved && saved < observed,
    "bind a NEW pending card, not stale cards from a prior run");
  assert(scroll > saved && scroll < screenshot && screenshot < sameCard && sameCard < click && click < passed,
    "screenshot the visible pending card, then CDP-click the SAME connected card before reading the result");
  const dispatches = body.match(/await cdp\.send\("Input\.dispatchMouseEvent", \{ type: "mouse(?:Pressed|Released)"[^\n]+/g) ?? [];
  assert(dispatches.length === 2 && dispatches.every((line) => line.endsWith("}, ntpSession);")),
    "both CDP mouse events must target the NTP page session, never the browser-root socket");
  assert(body.includes("ledgerCardSeen === true") && body.includes("ledgerCardApproved === true"),
    "missing card or owner click must fail the existing named check, not silently pass after gate removal");
}

Deno.test("activity ledger: a model create still pays the real approval gate", () => {
  assertGatedModelAction();
  assertThrows(() => assertGatedModelAction(() => true), Error, "must not be owner-direct");
});

Deno.test("activity ledger: journey observes and allows the exact model-created card", () => {
  assertCardDrivenApproval(leg);
});

Deno.test("activity ledger: wrong-card, missing click or card assertion is RED", () => {
  const noIdentity = leg.replace("!globalThis.__jnyLedgerPriorApprovalCards.has(card)", "true");
  assert(noIdentity !== leg, "mutant must remove the live prior-card exclusion");
  assertThrows(() => assertCardDrivenApproval(noIdentity), Error, "bind a NEW pending card");
  const noClick = leg.replace('await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x', 'await Promise.resolve({ type: "mousePressed", x: point.x');
  assert(noClick !== leg, "mutant must replace the live CDP click");
  assertThrows(() => assertCardDrivenApproval(noClick), Error, "CDP-click the SAME connected card");
  const browserRootClick = leg.replace("}, ntpSession);", "});");
  assert(browserRootClick !== leg, "mutant must remove a live NTP session argument");
  assertThrows(() => assertCardDrivenApproval(browserRootClick), Error, "both CDP mouse events");
  const noCardAssertion = leg.replace("ledgerCardSeen === true", "true");
  assert(noCardAssertion !== leg, "mutant must replace the live card assertion");
  assertThrows(() => assertCardDrivenApproval(noCardAssertion), Error, "missing card or owner click");
});

// ---------------------------------------------------------------------------------------------
// chrome-agent-platform-jm54c + chrome-agent-platform-0g5ql: the two Activity-frontier reds that
// could not name their own cause. The poll's wall-clock bound is what separates "the run did not
// settle" from "the poll exhausted its budget", and keeping the provider.set result is what
// separates a rejected provider.set from a composer that never dispatched. Both are asserted from
// the SAME sliced leg the rest of this file uses, so the wiring cannot rot into dead code.
function assertCauseIsNamed(body: string) {
  assert(body.includes("APPROVAL_POLL_BUDGET_MS"),
    "the approval poll must be bounded by wall clock, not only by 120 iterations");
  assert(body.includes("Date.now() < ledgerApprovalDeadline"),
    "the wall-clock bound must be the loop's own condition");
  assert(body.includes("approvalPollCause({"),
    "the poll's outcome must be classified into a name (budget vs card-never-appeared)");
  assert(body.includes("pollCause: ledgerPollCause"),
    "the named poll cause must reach the terminal check's evidence, or a failure still cannot be read");
  assert(/const ledgerProviderSet = await evalIn\(/.test(body),
    "the provider.set result must be KEPT - discarding it is the 0g5ql defect");
  assert(body.includes("providerSetCause(ledgerProviderSet)"),
    "the kept provider.set result must be named in the trace and the evidence");
}

Deno.test("jm54c+0g5ql: the frontier names why the ledger leg failed", () => {
  assertCauseIsNamed(leg);
});

Deno.test("jm54c+0g5ql: removing either name is RED", () => {
  const noBudget = leg.replace("Date.now() < ledgerApprovalDeadline", "true");
  assert(noBudget !== leg, "mutant must remove the wall-clock bound");
  assertThrows(() => assertCauseIsNamed(noBudget), Error, "the loop's own condition");

  const noCause = leg.replace("pollCause: ledgerPollCause,", "");
  assert(noCause !== leg, "mutant must drop the named cause from the evidence");
  assertThrows(() => assertCauseIsNamed(noCause), Error, "must reach the terminal check's evidence");

  const noProviderSet = leg.replace("const ledgerProviderSet = await evalIn(", "await evalIn(");
  assert(noProviderSet !== leg, "mutant must discard the provider.set result again");
  assertThrows(() => assertCauseIsNamed(noProviderSet), Error, "must be KEPT");
});

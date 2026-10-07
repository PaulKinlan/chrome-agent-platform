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
  const pending = body.indexOf("#thread-conversation approval-card");
  const observed = body.indexOf("ledgerCardSeen = true");
  const screenshot = body.indexOf('writeEvidence("activity-create-approval-pending.png"');
  const click = body.indexOf('ledgerCardApproved = await clickShadow(cdp, ntpSession, "#thread-conversation approval-card", ".approve")');
  const passed = body.indexOf("env?.ok === true");
  assert(pending >= 0 && pending < observed, "observe a real pending conversation card before approval");
  assert(observed < screenshot && screenshot < click && click < passed,
    "capture the still-pending card, click real Allow once, then read the tool result");
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

Deno.test("activity ledger: missing click or card-seen assertion is RED", () => {
  const noClick = leg.replace('ledgerCardApproved = await clickShadow(cdp, ntpSession, "#thread-conversation approval-card", ".approve")', 'ledgerCardApproved = false');
  assert(noClick !== leg, "mutant must replace the live click, not a comment");
  assertThrows(() => assertCardDrivenApproval(noClick), Error, "capture the still-pending card");
  const noCardAssertion = leg.replace("ledgerCardSeen === true", "true");
  assert(noCardAssertion !== leg, "mutant must replace the live card assertion");
  assertThrows(() => assertCardDrivenApproval(noCardAssertion), Error, "missing card or owner click");
});

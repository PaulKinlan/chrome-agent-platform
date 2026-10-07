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

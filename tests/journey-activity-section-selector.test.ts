// This guard reads the journey source without importing it (import starts Chrome).
// The real sidebar disclosure is <details id="activity-section">; the legacy
// activity-ledger-section id is a hidden compatibility span, not an Undo target.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

const JOURNEY = new URL("../scripts/chrome-journeys.ts", import.meta.url);
const NTP = new URL("../extension/ntp/ntp.html", import.meta.url);

function activityLeg(source: string): string {
  const start = source.indexOf("// Seed the ledger row for the run-created agent");
  const end = source.indexOf("// The tab sentence + Undo UI", start);
  assert(start >= 0 && end > start, "locate the run-created agent's Activity/Undo leg");
  return source.slice(start, end);
}

function assertRealDisclosureTargets(leg: string): void {
  const checks = [
    "Activity ledger: the ledger row for the run-created agent carries its undo",
    "Activity ledger: the hub sidebar renders the sentence and an Undo button",
    "Activity ledger: opening the disclosure makes the Undo button hit-testable (co35)",
    "Activity ledger: a real Undo deletes the agent and marks the row undone",
  ];
  let last = -1;
  for (const name of checks) {
    const at = leg.indexOf(`"${name}"`);
    assert(at > last, `four named Activity/Undo checks must execute in order: ${name}`);
    last = at;
  }
  assert(!leg.includes("activity-ledger-section"), "the hidden compatibility span cannot stand in for the Activity disclosure");
  assertEquals(leg.match(/document\.getElementById\("activity-section"\)/g)?.length, 5,
    "the row, hit-test, open wait, restore guard and close wait all inspect the real disclosure");
  assertEquals(leg.match(/clickSel\(cdp, ntpSession, "#activity-section > summary"\)/g)?.length, 2,
    "both the opening and closing gestures must click the real summary");
  assert(leg.includes('if (ledgerRows.some((row) => row.id === ledgerRowId)) break;'),
    "the row wait must not finish on an unrelated create action");
  assert(leg.includes('const createRow = ledgerRows.find((row) => row.id === ledgerRowId) ?? null;') &&
    leg.includes('createRow?.id === ledgerRowId && createRow.tool === "create_named_agent"'),
    "the row assertion must bind to the exact seeded action, not an unrelated create row");
  assert(leg.includes('const row = (r?.rows ?? []).find((x) => x.id === createRow?.id);'),
    "the Undo assertion must inspect that same action row");
  assert(leg.includes('const undoClicked = await clickShadow(cdp, ntpSession, "#side-action-ledger", ".al-undo");'),
    "the real Undo control must still receive a CDP mouse click");
}

Deno.test("journey Activity assertions target the real details and the exact run-created row", async () => {
  const [source, html] = await Promise.all([Deno.readTextFile(JOURNEY), Deno.readTextFile(NTP)]);
  assert(/<details\b[^>]*\bid="activity-section"/.test(html), "the Activity disclosure is real details");
  assert(/<span\b[^>]*\bid="activity-ledger-section"\s+hidden\b/.test(html),
    "the old id is a hidden compatibility span, not a disclosure");
  assertRealDisclosureTargets(activityLeg(source));
});

Deno.test("each stale Activity selector, row identity and real Undo-click mutant is RED", async () => {
  const leg = activityLeg(await Deno.readTextFile(JOURNEY));
  const selectors = [...leg.matchAll(/document\.getElementById\("activity-section"\)|clickSel\(cdp, ntpSession, "#activity-section > summary"\)/g)];
  assertEquals(selectors.length, 7, "five disclosure reads and two real summary gestures");
  for (const selector of selectors) {
    const at = selector.index!;
    const stale = selector[0].replace("activity-section", "activity-ledger-section");
    assertThrows(() => assertRealDisclosureTargets(leg.slice(0, at) + stale + leg.slice(at + selector[0].length)),
      Error, "hidden compatibility span");
  }
  const wrongRow = leg.replace("row.id === ledgerRowId", 'row.tool === "create_named_agent"');
  assert(wrongRow !== leg, "row-identity mutant must replace a live lookup");
  assertThrows(() => assertRealDisclosureTargets(wrongRow), Error, "row wait");
  const wrongAssertion = leg.replace('const createRow = ledgerRows.find((row) => row.id === ledgerRowId) ?? null;',
    'const createRow = ledgerRows.find((row) => row.tool === "create_named_agent") ?? null;');
  assert(wrongAssertion !== leg, "row-assertion mutant must replace a live lookup");
  assertThrows(() => assertRealDisclosureTargets(wrongAssertion), Error, "exact seeded action");
  const noClick = leg.replace('await clickShadow(cdp, ntpSession, "#side-action-ledger", ".al-undo")',
    'await Promise.resolve(true)');
  assert(noClick !== leg, "mouse-click mutant must replace the real Undo call");
  assertThrows(() => assertRealDisclosureTargets(noClick), Error, "CDP mouse click");
});

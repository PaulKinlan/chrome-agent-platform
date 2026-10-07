import { assert, assertEquals } from "jsr:@std/assert@1";

const KAT = new URL("../scripts/kat-gi0jw-activity-approval.ts", import.meta.url);
const NTP = new URL("../extension/ntp/ntp.html", import.meta.url);

Deno.test("the Activity KAT addresses the real 0.588 details disclosure, not its hidden compatibility span", async () => {
  const [kat, html] = await Promise.all([Deno.readTextFile(KAT), Deno.readTextFile(NTP)]);
  assert(/<details\b[^>]*\bid="activity-section"/.test(html), "real sidebar disclosure must exist");
  assert(/<span\b[^>]*\bid="activity-ledger-section"\s+hidden\b/.test(html),
    "old id is a hidden compatibility span, never the disclosure or visibility source");
  assert(kat.includes('document.getElementById(\'activity-section\')'),
    "row/Undo rendering must read the real Activity section's visibility");
  assert(kat.includes('"#activity-section > summary"'),
    "the genuine CDP click must target the real Activity summary");
  assertEquals(kat.match(/document\.getElementById\('activity-section'\)/g)?.length, 2,
    "both sidebar render and Undo hit-test must inspect the same real disclosure");
  assert(!kat.includes("document.getElementById('activity-ledger-section')"),
    "hidden compatibility span must never be credited or treated as a sidebar visibility failure");
});

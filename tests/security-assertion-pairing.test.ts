// @ts-nocheck — unit tests for assertion pairing criterion in security gates.
// tests/security-assertion-pairing.test.ts — chrome-agent-platform-1z4y:
//
// Invariant guarded: Every negative assertion in a security gate must be paired
// with a positive counterpart proving there was something to be negative about.
//
// A check of the form !X.includes(bad), count === 0, or !/"value"/.test(text)
// passes vacuously on empty, absent, or never-executed probe data. The positive
// sibling proves the probe executed, the fixture was non-empty, and the code under
// test actually ran.

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("security-assertion-pairing: scripts/security-suite.ts contains required positive counterparts for all negative gates", async () => {
  const source = await Deno.readTextFile(`${ROOT}scripts/security-suite.ts`);

  // 1. Network exfil boundary
  assert(
    source.includes("network exfil: untrusted exfil frame executed its exfiltration probes in the sandbox"),
    "network exfil negative check must be paired with positive probe execution check",
  );
  assert(
    source.includes("network exfil: no request escaped the sandbox"),
    "negative check for zero escaped requests must exist",
  );

  // 2. Sandbox execution and DOM availability
  assert(
    source.includes("sandbox execution: the untrusted frame executed in an opaque null-origin context with DOM available"),
    "sandbox escape checks must be paired with positive proof that the sandbox document actually executed",
  );
  assert(
    source.includes("prompt-injection: no chrome.runtime (extension API) in the sandbox"),
    "negative check for absence of chrome.runtime must exist",
  );

  // 3. Sender authority
  assert(
    source.includes("sender authority: a page's MAIN world executed with real DOM ('security fixture')"),
    "MAIN world absence check must be paired with positive proof of MAIN world execution",
  );
  assert(
    source.includes("sender authority: a page's MAIN world has no chrome.runtime"),
    "negative check for absence of chrome.runtime in MAIN world must exist",
  );
  assert(
    source.includes("sender authority: the same world still reaches a page-allowed route (tools.list)"),
    "route refusal check must be paired with positive route reachability check",
  );

  // 4. cap:fetch SSRF
  assert(
    source.includes("cap:fetch: sandboxed script execution is functional — unconstrained computation executes to success"),
    "cap:fetch refusal checks must be paired with positive proof that sandboxed scripts can execute",
  );
  assert(
    source.includes("cap:fetch: the attacker host saw no request from the four probes"),
    "negative check for zero requests seen by attacker must exist",
  );

  // 5. Cookie redaction (nweh model)
  assert(
    source.includes("cookies: the probe fixture was NON-EMPTY — the seeded synthetic cookie reached list_cookies as metadata"),
    "cookie redaction check must be paired with positive proof of seeded non-empty fixture",
  );
  assert(
    source.includes("cookies: list_cookies returns no value field (metadata only) — in the model's own context"),
    "negative check for absence of value field must exist",
  );
});

Deno.test("security-assertion-pairing: vacuous-pass detection drill (falsification)", () => {
  // Scenario A: Probe never ran / empty fixture
  const unexecutedResults: any[] = [];
  const attackerRequestsUnexecuted = 0;

  const exfilReport = unexecutedResults.find((x: any) => x?.result?.frame === "exfil")?.result ?? null;
  const positiveCheck = exfilReport?.executed === true;
  const negativeCheck = attackerRequestsUnexecuted === 0;

  // The bare negative check passes vacuously, but the paired positive check catches the failure
  assertEquals(negativeCheck, true, "bare negative check would pass vacuously");
  assertEquals(positiveCheck, false, "paired positive check catches unexecuted probe");

  // Scenario B: Real probe execution without leak
  const validResults = [{ result: { frame: "exfil", executed: true } }];
  const attackerRequestsClean = 0;

  const exfilReportValid = validResults.find((x: any) => x?.result?.frame === "exfil")?.result ?? null;
  const positiveCheckValid = exfilReportValid?.executed === true;
  const negativeCheckValid = attackerRequestsClean === 0;

  assertEquals(positiveCheckValid, true, "positive check passes when probe ran");
  assertEquals(negativeCheckValid, true, "negative check passes when no leak occurred");

  // Scenario C: Probe execution WITH leak
  const leakedResults = [{ result: { frame: "exfil", executed: true } }];
  const attackerRequestsLeaked = 2;

  const exfilReportLeaked = leakedResults.find((x: any) => x?.result?.frame === "exfil")?.result ?? null;
  const positiveCheckLeaked = exfilReportLeaked?.executed === true;
  const negativeCheckLeaked = attackerRequestsLeaked === 0;

  assertEquals(positiveCheckLeaked, true, "positive check remains green (probe ran)");
  assertEquals(negativeCheckLeaked, false, "negative check turns red specifically on leak");
});

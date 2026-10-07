// The embedded Settings deny journey needs a REAL pending row from the NTP.
// Owner-direct extension actions execute immediately, so a journey using one
// can silently pass the forged-resolve check with an empty/expired id and then
// abort at resolveNextApproval(). Inspect the actual inline request drivers;
// never import chrome-journeys.ts, which starts Chrome on import.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  approvalResolutionRefusal, DESTRUCTIVE_ACTIONS, isOwnerDirectApproval, mayResolveApproval,
} from "../extension/lib/owner-approval.js";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
const start = source.indexOf("const iframeDeniedRequest = await msgValue({");
const end = source.indexOf("const assetUpdate = await approvedMsg({", start);
assert(start >= 0 && end > start, "find the real owner Settings deny/restart journey");
const denyBlock = source.slice(start, end);
const ntpPrincipal = { principal: "extension", documentId: "real-ntp-document" };

function assertPendingDrivers(block: string) {
  const actions = [...block.matchAll(/await msgValue\(\{\s*type:\s*"([a-z.-]+)"/g)]
    .map((m) => m[1]).filter((action) => action.endsWith(".update"));
  assertEquals(actions.length, 4, "iframe deny, row deny, pre-restart and post-restart each need a request");
  for (const action of actions) {
    assert(DESTRUCTIVE_ACTIONS.has(action), `${action} must have an approval class`);
    assert(!isOwnerDirectApproval(ntpPrincipal, action),
      `${action} is owner-direct for extension documents: no pending row can exist for this NTP request`);
  }
  return actions;
}

Deno.test("gi0jw: all four real deny/restart requests are approval-gated from the NTP", () => {
  assertEquals(assertPendingDrivers(denyBlock), ["agent.update", "agent.update", "agent.update", "agent.update"]);
});

Deno.test("gi0jw: a wrong owner-direct driver is rejected rather than credited", () => {
  const wrong = denyBlock.replace(/type:\s*"agent\.update"/, 'type: "asset.update"');
  assert(wrong !== denyBlock, "mutant must replace a live request, not a comment");
  assertThrows(() => assertPendingDrivers(wrong), Error, "owner-direct for extension documents");
  assertThrows(() => assertPendingDrivers(""), Error, "iframe deny, row deny");
});

Deno.test("gi0jw: target reference is credited only after an observed worker restart", () => {
  const before = denyBlock.indexOf('Target.closeTarget", { targetId: approvalWorker.targetId }');
  const after = denyBlock.indexOf('const restartedTargets = await cdp.send("Target.getTargets")');
  assert(before >= 0 && after > before, "observe the worker after closing its original target");
  assert(denyBlock.includes("restartedApprovalWorker.targetId !== approvalWorker.targetId"),
    "stable targetRef must not be credited by deduplicating the same in-memory row");
});

Deno.test("gi0jw: a live ui:-bound row is Settings-only, not an expired-id refusal", () => {
  const row = { runId: "ui:real-ntp-document" };
  assert(mayResolveApproval(row, "owner-options", "settings-document"));
  assert(!mayResolveApproval(row, "extension", "real-ntp-document"));
  assert(/Settings/.test(approvalResolutionRefusal(row, "extension", "real-ntp-document")));
  assert(/expired/.test(approvalResolutionRefusal(undefined, "extension", "real-ntp-document")));
  assert(denyBlock.includes("pendingForForgery.length > 0"), "the journey must rule out empty ids before crediting refusal");
  assert(denyBlock.includes('/Settings/.test(String(forgedResolve?.error ?? ""))'),
    "the journey must identify the live-row custody refusal, not an expired id");
});

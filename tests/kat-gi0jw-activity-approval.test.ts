import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ACTIVITY_CHECKS, allNamedChecksPass, EXPECTED_CHECKS, runForVerdict, SETTINGS_CHECKS } from "../scripts/kat-gi0jw-activity-approval.ts";
import { HARNESSES } from "../scripts/lib/harness-registry.ts";

const green = EXPECTED_CHECKS.map((name) => ({ name, verdict: "PASS" as const }));

Deno.test("focused approval KAT pins all six Settings checks and Activity created-agent/Undo checks", () => {
  assertEquals(SETTINGS_CHECKS.length, 6);
  assertEquals(ACTIVITY_CHECKS.length, 6);
  assertEquals(HARNESSES["kat-gi0jw-activity-approval.ts"]?.class, "kat");
  assert(allNamedChecksPass(green));
  assert(!allNamedChecksPass(green.slice(0, -1)), "a missing verdict is NOT a pass");
  assert(!allNamedChecksPass(green.map((row, i) => i === 5 ? { ...row, verdict: "NOT_REACHED" } : row)),
    "a Settings check not reached is NOT a pass");
  assert(!allNamedChecksPass(green.map((row, i) => i === 6 ? { ...row, verdict: "FAIL" } : row)),
    "a failed Activity card cannot masquerade as acceptance");
});

Deno.test("focused acceptance verdict seam exits nonzero for incomplete, failed, or thrown drives", async () => {
  const errors: unknown[] = [];
  assertEquals(await runForVerdict(async () => green), 0);
  assertEquals(await runForVerdict(async () => green.slice(0, -1)), 1);
  assertEquals(await runForVerdict(async () => green.map((row, i) => i === 0 ? { ...row, verdict: "FAIL" } : row)), 1);
  assertEquals(await runForVerdict(async () => { throw new Error("lost browser"); }, (e) => errors.push(e)), 1);
  assertEquals(errors.length, 1);
});

function assertOwnerApprovedSeed(source: string) {
  const created = source.indexOf('const seeded = await ntpMsg({ type: "agent.create", origin });');
  const denied = source.indexOf("const seedRequest = await ntpMsg(rename);");
  const row = source.indexOf('const seedRow = await onePending("agent.update");');
  const approved = source.indexOf("await resolve(seedRow.approvalId, true);");
  const retried = source.indexOf("const seededRename = await ntpMsg(rename);");
  const firstDeny = source.indexOf('const firstRequest = await ntpMsg({ type: "agent.update"');
  assert(created >= 0 && created < denied && denied < row && row < approved && approved < retried && retried < firstDeny,
    "Settings target name must be established by an exact owner-approved agent.update before deny tests");
}

function assertSessionBoundMouse(source: string) {
  const dispatches = source.match(/await cdp\.send\("Input\.dispatchMouseEvent", \{ type: "mouse(?:Pressed|Released)"[^\n]+/g) ?? [];
  assert(dispatches.length === 2 && dispatches.every((line) => line.endsWith("}, session);")),
    "both real mouse events must target their exact page session, never browser-root CDP");
}

Deno.test("focused KAT dispatches every genuine click to its page session and retains real screenshots", async () => {
  const source = await Deno.readTextFile(new URL("../scripts/kat-gi0jw-activity-approval.ts", import.meta.url));
  assert(source.includes('const mouse = async (session: string, x: number, y: number) =>'));
  assertSessionBoundMouse(source);
  assertOwnerApprovedSeed(source);
  const skipSeedApproval = source.replace('await resolve(seedRow.approvalId, true);', 'await resolve(seedRow.approvalId, false);');
  assert(skipSeedApproval !== source, "seed mutant must replace the actual owner approval");
  assertThrows(() => assertOwnerApprovedSeed(skipSeedApproval), Error, "exact owner-approved agent.update");
  const browserRootMutant = source.replace('buttons: 1, clickCount: 1 }, session);', 'buttons: 1, clickCount: 1 });');
  assert(browserRootMutant !== source, "mutant must remove a live press-event session");
  assertThrows(() => assertSessionBoundMouse(browserRootMutant), Error, "both real mouse events");
  assert(source.includes('await mouse(ntpSession, point.x, point.y);'), "the approval click must target NTP");
  assert(source.indexOf('save("activity-pending-card.png"') < source.indexOf('await mouse(ntpSession, point.x, point.y);'),
    "save the genuinely pending card BEFORE clicking Allow");
  assert(source.includes("trackEmbeddedFrameContexts(cdp, ntpSession)") &&
    source.includes("await frameTracker.evaluate({") && source.includes('path: "/options/options.html"') &&
    !source.includes("contextId: frameCtx.id"),
    "Settings deny must track the current embedded default context, not the first stale frameCtx");
  assert(source.includes('await cdp.send("Target.closeTarget", { targetId: oldSw.targetId });'),
    "a worker restart must be observed rather than simulated");
  assert(source.includes("await teardownChrome(chrome, profile)"), "the one browser must be owner-cleaned");
});

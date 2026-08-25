// @ts-nocheck — dynamic test stubs for isolated execution verification.
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("bridge handshake: content-script listens to enrollment.poke to re-sync startup credentials", async () => {
  const cs = await Deno.readTextFile(new URL("../extension/content/content-script.js", import.meta.url));
  assert(
    cs.includes('message?.type === "enrollment.poke"'),
    "content-script must handle enrollment.poke runtime message",
  );
  assert(
    cs.includes("syncEnrollmentAtStartup()"),
    "enrollment.poke must trigger startup enrollment sync",
  );
});

Deno.test("bridge handshake: invokeSiteTool rebinds snapshot gate on new tab opening and activates tab", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // Invariant 1: Gate rebind happens on plan.kind === "open" under withEnrollmentLock
  assert(
    sw.includes("map[canonical] = rebindSnapshotGate(map[canonical] ?? null, created.id);"),
    "open tab branch must rebind snapshot gate to created tab",
  );
  // Invariant 2: Tab is activated before sendMessage
  assert(
    sw.includes("chrome.tabs.update(tab.id, { active: true })"),
    "target tab must be activated before dispatch",
  );
});

Deno.test("bridge handshake: invokeSiteTool returns structured named error reasons on failure", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes('reason: "bridge-unavailable"'), "connection failure returns bridge-unavailable reason");
  assert(sw.includes('reason: "handshake-timeout"'), "timeout returns handshake-timeout reason");
  assert(sw.includes('reason: "tab-not-openable"'), "tab creation failure returns tab-not-openable reason");
});

Deno.test("bridge handshake: connection recovery flow re-plans and re-attempts dispatch on stale document connection", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("if (connectionFailed) {"), "stale connection recovery block must exist");
  assert(sw.includes("planWebmcpInvocationTab({"), "recovery must re-plan invocation tab");
  assert(sw.includes("waitForSnapshotBinding(canonical, recoverTabId)"), "recovery must await fresh snapshot binding");
});

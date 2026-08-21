// Focused contract tests for the single conversation run-status surface.
import { assert, assertEquals } from "jsr:@std/assert";
import { normalizeConversationRunStatus } from "../extension/shared/run-status.js";

Deno.test("conversation run status: canonical lifecycle states use truthful labels and activity", () => {
  assertEquals(normalizeConversationRunStatus({ state: "queued" }), {
    state: "queued", label: "Queued", active: true, tone: "muted",
  });
  assertEquals(normalizeConversationRunStatus({ state: "running", activity: "Reading tabs" }), {
    state: "running", label: "Reading tabs", active: true, tone: "accent",
  });
  assertEquals(normalizeConversationRunStatus({ state: "retrying" }), {
    state: "retrying", label: "Retrying…", active: true, tone: "accent",
  });
  assertEquals(normalizeConversationRunStatus({ state: "completed" }), {
    state: "completed", label: "Completed", active: false, tone: "success",
  });
  assertEquals(normalizeConversationRunStatus({ state: "failed", errorReason: "runtime disconnected" }), {
    state: "failed", label: "Failed — runtime disconnected", active: false, tone: "danger",
  });
  assertEquals(normalizeConversationRunStatus({ state: "cancelled" }), {
    state: "cancelled", label: "Cancelled", active: false, tone: "muted",
  });
});

Deno.test("conversation run status: waiting for permission is an explicit paused state", () => {
  assertEquals(normalizeConversationRunStatus({ state: "waiting-for-permission", errorReason: "the provider origin is not granted" }), {
    state: "waiting-for-permission",
    label: "Waiting for permission — the provider origin is not granted",
    active: false,
    tone: "muted",
  });
  assertEquals(normalizeConversationRunStatus({ state: "waiting-for-permission" })?.label, "Waiting for permission");
});

Deno.test("conversation run status: legacy lifecycle names normalize to the one canonical surface", () => {
  assertEquals(normalizeConversationRunStatus({ state: "working", activity: "Thinking…" })?.state, "running");
  assertEquals(normalizeConversationRunStatus({ state: "done" })?.state, "completed");
  assertEquals(normalizeConversationRunStatus({ state: "error", message: "boom" })?.state, "failed");
  assertEquals(normalizeConversationRunStatus({ state: "idle" }), null);
  assertEquals(normalizeConversationRunStatus({ state: "unknown" }), null);
});

Deno.test("conversation run status: the legacy top-of-thread banner path is absent and the one surface sits below the transcript", async () => {
  const html = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  assertEquals(html.includes('<div class="run-status"'), false, "the legacy div banner container is gone");
  assertEquals(html.includes("run-status .spin"), false, "the legacy duplicate spinner styles are gone");
  assertEquals(html.includes("loading-state"), false, "the thread view never mounts the generic loader");
  const threadBody = html.indexOf('class="thread-body"');
  assertEquals(threadBody > -1, true, "the thread body exists");
  const thread = html.slice(threadBody);
  const surface = thread.indexOf('<conversation-run-status');
  const transcript = thread.indexOf('<agent-conversation');
  const composer = thread.indexOf('<agent-composer');
  assertEquals(surface > -1, true, "the single conversation-owned surface exists in the thread body");
  assertEquals(transcript > -1 && transcript < surface && surface < composer, true,
    "the status surface renders at the bottom of the transcript, above the composer");
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertEquals(js.includes("createElement(\"loading-state\")"), false, "the generic loader render path is gone");
  assertEquals((js.match(/getElementById\("run-status"\)/g) ?? []).length, 1, "exactly one status owner binds the surface");
});

Deno.test("conversation run status: the action routes in-context to the Settings view, never openOptionsPage", async () => {
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const start = js.indexOf('runStatusEl?.addEventListener("action"');
  assert(start > -1, "the run-status action handler exists");
  const handler = js.slice(start, js.indexOf("});", start) + 3)
    .replace(/\/\/[^\n]*/g, ""); // comments may explain WHY openOptionsPage is wrong
  assert(handler.includes('openView("options/options.html", "Settings")'),
    "the action routes in-context through the standard NTP Settings view");
  assertEquals(handler.includes("openOptionsPage"), false,
    "openOptionsPage creates no target from the NTP and strands the user outside the thread view");
});

Deno.test("conversation run status: the Settings route target reveals in place and moves focus to the frame", async () => {
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const start = js.indexOf("function openView(");
  assert(start > -1, "openView exists");
  const body = js.slice(start, js.indexOf("function closeView(", start));
  assert(body.includes("viewOverlay.hidden = false;"), "the route reveals the view overlay in context");
  assert(body.includes("viewFocus.open("), "the route moves keyboard focus into the revealed view (Directory view-focus contract)");
  assert(body.includes("viewFrame"), "the view frame is the focus target of the reveal");
  // Every other NTP Settings entry uses the same in-context route (no second authority).
  assert(js.includes('openView("options/options.html", "Settings", e.currentTarget)') ||
    js.includes('openView("options/options.html", "Settings", event.currentTarget)'),
    "the standard Settings entries use the identical in-context route (with the trigger for focus restore)");
});

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

Deno.test("conversation run status: the live status is the conversation's own inline pinned bottom row (no separate banner element)", async () => {
  const html = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  assertEquals(html.includes('<div class="run-status"'), false, "the legacy div banner container is gone");
  assertEquals(html.includes("run-status .spin"), false, "the legacy duplicate spinner styles are gone");
  assertEquals(html.includes("loading-state"), false, "the thread view never mounts the generic loader");
  const threadBody = html.indexOf('class="thread-body"');
  assertEquals(threadBody > -1, true, "the thread body exists");
  const thread = html.slice(threadBody);
  assertEquals(thread.includes("conversation-run-status"), false,
    "no standalone status element sits outside the conversation — the status row is the conversation's own inline child");
  assertEquals(html.includes('id="run-status"'), false, "the separate #run-status banner element is gone");
  const transcript = thread.indexOf("<agent-conversation");
  const composer = thread.indexOf("<agent-composer");
  assertEquals(transcript > -1 && transcript < composer, true,
    "the conversation (which owns the inline status row) sits above the composer");
  const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  assert(components.includes("setLiveStatus(status)"), "agent-conversation exposes the inline live-status API");
  assert(components.includes("agent-conversation .live-status { position: sticky; bottom: 0;"),
    "the inline status row is pinned (sticky) at the bottom of the conversation viewport");
  assert(/state === "idle" \|\| state === "completed"/.test(components),
    "idle/completed resolve the row — the final conversation entry is the resolution, no orphan chrome");
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertEquals(js.includes("createElement(\"loading-state\")"), false, "the generic loader render path is gone");
  assertEquals(js.includes('getElementById("run-status")'), false, "no separate status element owner remains");
  assert(js.includes("threadConversation.setLiveStatus?.("), "the NTP routes run status INTO the conversation");
  const spHtml = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.html", import.meta.url));
  assertEquals(spHtml.includes("agent-detail-status"), false, "the sidepanel's separate status line is gone");
  const spJs = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.js", import.meta.url));
  assert(spJs.includes("historyEl.setLiveStatus?.(") || spJs.includes("historyEl.clearLiveStatus?.("),
    "the sidepanel routes run status INTO its conversation");
});

Deno.test("conversation run status: the action routes in-context to the Settings view, never openOptionsPage, and only from the status row", async () => {
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const start = js.indexOf('threadConversation?.addEventListener("action"');
  assert(start > -1, "the status-row action handler exists on the conversation");
  const handler = js.slice(start, js.indexOf("});", start) + 3)
    .replace(/\/\/[^\n]*/g, ""); // comments may explain WHY openOptionsPage is wrong
  assert(handler.includes('openView("options/options.html", "Settings")'),
    "the action routes in-context through the standard NTP Settings view");
  assert(handler.includes('contains?.("live-status")'),
    "the handler fires ONLY for the live-status row (message bubbles also emit 'action')");
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

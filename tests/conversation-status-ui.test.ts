// Focused contract tests for the single conversation run-status surface.
import { assert, assertEquals } from "jsr:@std/assert";
import { cancelRunFromRenderedStop, normalizeConversationRunStatus } from "../extension/shared/run-status.js";

Deno.test("conversation run status: canonical lifecycle states use truthful labels and activity", () => {
  assertEquals(normalizeConversationRunStatus({ state: "queued" }), {
    state: "queued", label: "Queued", active: true, stoppable: true, tone: "muted",
  });
  // The live banner reads as one sentence: "Working — <activity>…"
  // (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01).
  assertEquals(normalizeConversationRunStatus({ state: "running", activity: "Reading tabs" }), {
    state: "running", label: "Working — reading tabs…", active: true, stoppable: true, tone: "accent",
  });
  assertEquals(normalizeConversationRunStatus({ state: "retrying" }), {
    state: "retrying", label: "Retrying…", active: true, stoppable: true, tone: "accent",
  });
  assertEquals(normalizeConversationRunStatus({ state: "completed" }), {
    state: "completed", label: "Completed", active: false, stoppable: false, tone: "success",
  });
  assertEquals(normalizeConversationRunStatus({ state: "failed", errorReason: "runtime disconnected" }), {
    state: "failed", label: "Failed — runtime disconnected", active: false, stoppable: false, tone: "danger",
  });
  assertEquals(normalizeConversationRunStatus({ state: "cancelled" }), {
    state: "cancelled", label: "Stopped", active: false, stoppable: false, tone: "muted",
  });
});

Deno.test("conversation run status: waiting for permission is an explicit paused state", () => {
  assertEquals(normalizeConversationRunStatus({ state: "waiting-for-permission", errorReason: "the provider origin is not granted" }), {
    state: "waiting-for-permission",
    label: "Waiting for permission — the provider origin is not granted",
    active: false,
    stoppable: true,
    tone: "muted",
  });
  assertEquals(normalizeConversationRunStatus({ state: "waiting-for-permission" })?.label, "Waiting for permission");
});

Deno.test("hard stop: live conversation and scheduled-task surfaces expose one-click keyboard buttons", async () => {
  const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  const statusStart = components.indexOf("class ConversationRunStatus");
  const statusEnd = components.indexOf('customElements.define("conversation-run-status"', statusStart);
  const status = components.slice(statusStart, statusEnd);
  assert(status.includes('class="stop" type="button">Stop</button>'), "the live row has an always-labelled native Stop button");
  assert(status.includes('this._emit("stop", { sourceEvent, executionId })'), "the live row carries its native click and rendered execution id");
  const taskStart = components.indexOf("class TaskRow");
  const taskEnd = components.indexOf('customElements.define("task-row"', taskStart);
  const task = components.slice(taskStart, taskEnd);
  assert(task.includes('class="stop" aria-label="Stop ${escapeHtml(name)}">Stop</button>'), "running task rows have a labelled native Stop button");
  assert(task.includes('status === "stopped"'), "a stopped task row replaces its running spinner with an honest stopped indicator");
  assert(task.includes('this._emit("stop", { sourceEvent, executionId })'), "task rows carry their native click and rendered execution id");

  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const stopStart = ntp.indexOf('addEventListener("stop"');
  const ntpStop = ntp.slice(stopStart, ntp.indexOf("/** Which run owner", stopStart));
  assert(ntpStop.includes("cancelRunFromRenderedStop(ev"), "the NTP Stop click crosses the trusted-click boundary");
  assert(ntpStop.includes("cancelDurableRun(executionId"), "the NTP abort uses only the id carried by the rendered control");
  assert(ntpStop.includes('{ state: "cancelled" }'), "successful stop settles the visible row");

  const sidepanel = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.js", import.meta.url));
  assert(sidepanel.includes('historyEl.addEventListener("stop"'), "the sidepanel conversation has the same hard stop");
  assert(sidepanel.includes('row.addEventListener("stop"'), "the scheduled/background task panel has the same hard stop");
  assert(sidepanel.includes('row.setAttribute("execution-id", run.executionId)'), "a task row binds its exact live scheduled execution while rendering");
  assert(sidepanel.includes('return cancelDurableRun(executionId'), "the sidepanel never recomputes a run at click time");
  assert(sidepanel.includes('row.setAttribute("status", "stopped")'), "a successful task-row stop settles visibly instead of leaving a running spinner");
});

Deno.test("hard stop: forged clicks, missing activation, and stale rows cannot abort a newer run", async () => {
  class NativeClick { isTrusted = true; }
  const aborted: string[] = [];
  const cancel = async (executionId: string) => {
    aborted.push(executionId);
    return executionId === "exec:settled-stale"
      ? { ok: false, error: "run_already_terminal" }
      : { ok: true, cancelled: true };
  };

  const forged = await cancelRunFromRenderedStop({
    detail: { sourceEvent: { isTrusted: false }, executionId: "exec:forged" },
  }, cancel, { isActive: true });
  assertEquals(forged.ignored, true);
  assertEquals(aborted, []);

  const withoutActivation = await cancelRunFromRenderedStop({
    detail: { sourceEvent: new NativeClick(), executionId: "exec:programmatic" },
  }, cancel, { isActive: false }, NativeClick as unknown as typeof Event);
  assertEquals(withoutActivation.ignored, true);
  assertEquals(aborted, []);

  const newerRun = "exec:newer";
  const staleClick = await cancelRunFromRenderedStop({
    detail: { sourceEvent: new NativeClick(), executionId: "exec:settled-stale" },
  }, cancel, { isActive: true }, NativeClick as unknown as typeof Event);
  assertEquals(staleClick.executionId, "exec:settled-stale");
  assertEquals(staleClick.error, "run_already_terminal");
  assertEquals(aborted, ["exec:settled-stale"]);
  assertEquals(aborted.includes(newerRun), false, "the newer run remains untouched");
});

Deno.test("hard stop: cancellation helper sends the exact execution id to run.cancel", async () => {
  const { cancelDurableRun } = await import("../extension/shared/conversation.js");
  let sent: Record<string, unknown> | null = null;
  const globals = globalThis as typeof globalThis & { chrome?: unknown };
  const previous = globals.chrome;
  globals.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message: Record<string, unknown>, callback: (result: unknown) => void) { sent = message; callback({ ok: true, cancelled: true }); },
    },
  };
  try {
    const result = await cancelDurableRun("exec:hard-stop", "stopped by owner");
    assertEquals(result.ok, true);
    const message = sent as Record<string, unknown> | null;
    assertEquals(message?.type, "run.cancel");
    assertEquals(message?.executionId, "exec:hard-stop");
    assertEquals(message?.reason, "stopped by owner");
    assert(typeof message?.requestId === "string" && message.requestId.length > 0);
  } finally {
    globals.chrome = previous;
  }
});

Deno.test("hard stop: owner cancellation remains aborted semantically and durable physically", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes('return await cancelExecutionTree(executionId'), "run.cancel retains the durable cancellation authority");
  assertEquals(sw.includes('aborted: true, error: "run cancelled by owner", errorCategory: "cancelled"'), false,
    "owner stop must not escape as a non-aborted error category");
  assert(sw.includes('aborted: true, error: "run cancelled by owner", errorCategory: "aborted"'),
    "the stopped run response carries errorCategory=aborted");
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
  // Still sticky at the bottom — offset by the docked composer's height so the
  // row pins just above it (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01).
  assert(components.includes("agent-conversation .live-status { position: sticky; bottom: var(--conversation-dock, 0px);"),
    "the inline status row is pinned (sticky) at the bottom of the conversation viewport");
  assert(/state === "idle" \|\| state === "completed"/.test(components),
    "idle/completed resolve the row — the final conversation entry is the resolution, no orphan chrome");
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertEquals(js.includes("createElement(\"loading-state\")"), false, "the generic loader render path is gone");
  assertEquals(js.includes('getElementById("run-status")'), false, "no separate status element owner remains");
  assert(js.includes("projectConversationRunStatus(threadConversation, s)"), "the NTP routes run status INTO the conversation");
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

Deno.test("runStatusActionLabel: one shared authority for the Settings recovery action", async () => {
  const { runStatusActionLabel } = await import("../extension/shared/run-status.js");
  assertEquals(runStatusActionLabel({ state: "failed", errorCategory: "provider-auth" }), "Fix in Settings");
  assertEquals(runStatusActionLabel({ state: "error", errorCategory: "model-config" }), "Fix in Settings", "the legacy error alias canonicalizes");
  assertEquals(runStatusActionLabel({ state: "waiting-for-permission", errorCategory: "host-permission" }), "Fix in Settings");
  assertEquals(runStatusActionLabel({ state: "waiting-for-permission", errorCategory: "network" }), "Fix in Settings");
  assertEquals(runStatusActionLabel({ state: "failed", errorCategory: "aborted" }), null, "an abort is not Settings-recoverable");
  assertEquals(runStatusActionLabel({ state: "failed" }), null, "no category, no action");
  assertEquals(runStatusActionLabel({ state: "running", errorCategory: "network" }), null, "a live run never carries the action");
  assertEquals(runStatusActionLabel({ state: "completed", errorCategory: "network" }), null);
  assertEquals(runStatusActionLabel(null), null);
});

Deno.test("sidepanel parity: the live row keeps the recovery action and routes it to Settings (review P1-b)", async () => {
  const sp = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.js", import.meta.url));
  assert(sp.includes("projectConversationRunStatus"), "the sidepanel uses the shared live-status projector");
  const statusCall = sp.slice(sp.indexOf("onStatus: (s)"));
  assert(statusCall.includes("projectConversationRunStatus(historyEl, s)"),
    "the complete terminal status, including errorCategory, reaches the shared projector");
  assertEquals(statusCall.includes("setDetailStatus(res.error"), false,
    "the resolved promise must not overwrite the complete terminal row with a bare error string");
  const listener = sp.indexOf('historyEl.addEventListener("action"');
  assert(listener > -1, "the sidepanel wires the status-row action listener");
  const handler = sp.slice(listener, sp.indexOf("});", listener) + 3);
  assert(handler.includes('contains?.("live-status")'), "the listener fires ONLY for the live-status row");
  assert(handler.includes("chrome.runtime.openOptionsPage()"),
    "the sidepanel routes the action to the real Settings page (openOptionsPage is correct off the NTP)");
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(ntp.includes("projectConversationRunStatus(threadConversation, s)"),
    "the NTP uses the SAME shared projector (no divergent copies)");
});

Deno.test("NTP terminal reconciliation captures the exact per-attempt run id", async () => {
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(ntp.includes("onRunRegistered: (runId)"), "runThreadTurn receives the exact id created by runConversationTurn");
  assert(ntp.includes("liveClientRunId = runId"), "the live surface tracks that exact id");
  assertEquals(ntp.includes("surfaceRunLiveAt"), false, "timestamp identity heuristic is gone");
});

Deno.test("progress-inline KAT fails closed when axe cannot run", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/kat-progress-inline.ts", import.meta.url));
  assertEquals(src.includes("NOTE: axe-during-run"), false, "missing during-run axe is not a passing note");
  assertEquals(src.includes("NOTE: axe injection unavailable"), false, "missing settled axe is not a passing note");
  assert(src.includes('check("axe DURING the run: axe loaded"'), "during-run axe availability is a required check");
  assert(src.includes('check("axe: axe loaded"'), "settled axe availability is a required check");
  assert(src.includes("if (!response.ok) throw"), "an HTTP error cannot inject garbage and pass");
  assertEquals((src.match(/if \(!Array\.isArray\(/g) ?? []).length >= 2, true,
    "both during-run and settled scans require a real axe result array");
});

Deno.test("run-status-lifecycle: no stale #run-status / loading-state selectors remain (review P2)", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/run-status-lifecycle.ts", import.meta.url));
  assertEquals(src.includes("getElementById('run-status')"), false, "the deleted banner element is no longer queried");
  assertEquals(src.includes('getElementById("run-status")'), false);
  assertEquals(src.includes("#run-status"), false, "no #run-status selector survives anywhere in the journey");
  assertEquals(src.includes("loading-state"), false, "the deleted loader element is no longer queried");
  assert(src.includes("conversation-run-status.live-status"), "the journey drives the inline live-status row");
  assert(src.includes("fuContinuous"), "the follow-up assertion forbids working→hidden→working flaps");
  assertEquals(src.includes("fuBlocksResolve"), false, "the old every-block-eventually-resolves loophole is gone");
});

// ── CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01 — the thread view's run state ──
// The run banner is fed from the progress port: a tool-call event sets the
// row to `running` with a "Working — …" label, and the run's completion sets
// `completed` (the row hides itself). Driven through the REAL
// runConversationTurn with a stubbed chrome runtime + progress port.
import { composeWorkingLabel, isScrolledToBottom, artifactCardTitle, turnTime } from "../extension/shared/thread-view.js";

const threadPort: { listener: ((msg: unknown) => void) | null } = { listener: null };
function installThreadChromeStub(sw: { lastRunId: string | null; holdMs: number }) {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string; runId?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") { queueMicrotask(() => cb({ ok: true, local: true })); return; }
        if (msg.type === "agent.run") {
          sw.lastRunId = msg.runId ?? null;
          setTimeout(() => cb({ ok: true, threadId: "t_state", executionId: `exec:${msg.runId}`, result: "[demo] done" }), sw.holdMs);
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn: (msg: unknown) => void) { threadPort.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };
}

Deno.test("thread view: run-status reflects the running state — a tool-call progress event yields running + 'Working — …', completion yields completed", async () => {
  const sw = { lastRunId: null as string | null, holdMs: 150 };
  installThreadChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const statuses: Array<{ state: string; activity?: string }> = [];
  const cards: Array<Record<string, string>> = [];
  const container = {
    appendUser() {}, appendAgent() {}, appendSystem() {}, appendError() {},
    appendTool(m: Record<string, string>) { cards.push(m); return { setAttribute() {} }; },
    setMessages() {}, clear() {},
  };
  const turn = runConversationTurn(container as never, {
    text: "thread view run state",
    onStatus: (s: { state: string; activity?: string }) => statuses.push(s),
  } as never);
  const end = Date.now() + 1000;
  while ((sw.lastRunId === null || threadPort.listener === null) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert(sw.lastRunId && threadPort.listener, "the run dispatched and the progress port connected");
  const before = statuses.length;
  threadPort.listener!({ type: "progress", event: { type: "tool-call", runId: sw.lastRunId, toolName: "list_tabs", toolArgs: {} } });
  const running = statuses.slice(before).find((s) => s.state === "running");
  assert(running, `a tool-call progress event must set the running state (got ${JSON.stringify(statuses)})`);
  const rendered = normalizeConversationRunStatus(running);
  assertEquals(rendered?.state, "running");
  assert(rendered && rendered.label.length > 0, "the running row has a non-empty label");
  assert(/^Working — .+…$/u.test(rendered!.label), `the banner reads "Working — <activity>…" (got ${JSON.stringify(rendered?.label)})`);
  assertEquals(rendered?.label, "Working — reading your tabs…");
  await turn;
  assertEquals(statuses.at(-1)?.state, "completed", "done settles the row to completed (which hides it)");
  assertEquals(normalizeConversationRunStatus(statuses.at(-1))?.active, false);
});

Deno.test("thread view: composeWorkingLabel reads as one sentence with exactly one ellipsis", () => {
  assertEquals(composeWorkingLabel("reading 4 tabs"), "Working — reading 4 tabs…");
  assertEquals(composeWorkingLabel("Writing the answer…"), "Working — writing the answer…");
  assertEquals(composeWorkingLabel("Thinking · step 2 of 4"), "Working — thinking · step 2 of 4…");
  assertEquals(composeWorkingLabel(""), "Working…");
  assertEquals(composeWorkingLabel(undefined), "Working…");
  assertEquals(composeWorkingLabel("…"), "Working…");
});

Deno.test("thread view: the stick-to-bottom latch releases when the owner scrolls up more than the slack", () => {
  assertEquals(isScrolledToBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 }), true, "a non-scrolling container is at the bottom");
  assertEquals(isScrolledToBottom({ scrollTop: 500, clientHeight: 500, scrollHeight: 1000 }), true);
  assertEquals(isScrolledToBottom({ scrollTop: 480, clientHeight: 500, scrollHeight: 1000 }), true, "within 24px slack still sticks");
  assertEquals(isScrolledToBottom({ scrollTop: 470, clientHeight: 500, scrollHeight: 1000 }), false, "scrolled up beyond the slack: the owner is reading");
  assertEquals(isScrolledToBottom({ scrollTop: 267, clientHeight: 320, scrollHeight: 907 }), false, "the measured defect (267 of 587) is 'scrolled up'");
});

Deno.test("thread view: an update card is titled with the artifact's name, never 'Generated UI'", () => {
  const args = JSON.stringify({ id: "as_1", content: "<!doctype html><h1>v2</h1>" });
  assertEquals(artifactCardTitle({ toolName: "update_asset", args, result: JSON.stringify({ ok: true, asset: { id: "as_1", name: "crumb.html", type: "html" } }) }), "crumb.html");
  // The lazy envelope (execute_tool → modelContent → {ok, result}) still resolves the name.
  const envelope = JSON.stringify({ modelContent: JSON.stringify({ ok: true, selectedTool: "update_asset", result: { ok: true, asset: { id: "as_1", name: "crumb.html" } } }) });
  assertEquals(artifactCardTitle({ toolName: "update_asset", args, result: envelope }), "crumb.html");
  // While the call is still running (no result yet) the conversation's own registry names it.
  assertEquals(artifactCardTitle({ toolName: "update_asset", args, lookup: (id: string) => (id === "as_1" ? "crumb.html" : null) }), "crumb.html");
  // The durable re-projection hands the card the persisted lazy CALL shape
  // (execute_tool args: { selectionRef, arguments: {…} }) and a summary-only
  // result — the registry resolves the id one level down.
  const lazyArgs = JSON.stringify({ selectionRef: "sel_" + "0".repeat(36), arguments: { origin: "master", id: "as_1", content: "<!doctype html><h1>v2</h1>" } });
  assertEquals(artifactCardTitle({ toolName: "execute_tool", args: lazyArgs, result: "done", lookup: (id: string) => (id === "as_1" ? "crumb.html" : null) }), "crumb.html");
  assertEquals(artifactCardTitle({ toolName: "execute_tool", args: JSON.stringify({ selectionRef: "sel_x", arguments: { name: "crumb.html", type: "html", content: "<h1/>" } }) }), "crumb.html");
  // create_asset carries the name in its args.
  assertEquals(artifactCardTitle({ toolName: "create_asset", args: JSON.stringify({ name: "crumb.html", type: "html", content: "<h1>v1</h1>" }) }), "crumb.html");
  // Nothing known: a truthful generic head, never the literal "Generated UI".
  const bare = artifactCardTitle({ toolName: "update_asset", args });
  assertEquals(bare, "Updated artifact");
  assert(!/Generated UI/.test(bare));
  assertEquals(artifactCardTitle({ toolName: "generate_ui", args: JSON.stringify({ html: "<h1/>" }) }), "Generated page");
});

Deno.test("thread view: the artifact identity survives the progress port's 300-character truncation", async () => {
  const { artifactIdentityFromPayloads } = await import("../extension/shared/thread-view.js");
  const inner = JSON.stringify({ ok: true, selectedTool: "create_asset", result: { asset: { createdAt: 1788112453696, id: "a_mtg3zjgg_hwepfn3l", name: "crumb.html", origin: "master", size: 73, type: "html", updatedAt: 1788112453696 }, id: "a_mtg3zjgg_hwepfn3l", ok: true }, schemaSummary: "{\"properties\":{\"asset\":{}}}" });
  const full = JSON.stringify({ modelContent: inner });
  assertEquals(artifactIdentityFromPayloads([full]), { id: "a_mtg3zjgg_hwepfn3l", name: "crumb.html" }, "the intact envelope parses");
  const truncated = full.slice(0, 300) + "...";
  assertEquals(artifactIdentityFromPayloads([truncated]), { id: "a_mtg3zjgg_hwepfn3l", name: "crumb.html" }, "the bounded live payload still names the asset");
  // A search_tools result names TOOLS, not assets: never mistaken for one.
  const search = JSON.stringify({ modelContent: JSON.stringify({ ok: true, results: [{ name: "create_asset", summary: "Create an artifact" }] }) }).slice(0, 300) + "...";
  assertEquals(artifactIdentityFromPayloads([search]), null);
});

Deno.test("thread view: turnTime yields an ISO datetime and a short local label", () => {
  const now = Date.UTC(2026, 7, 30, 12, 0, 0);
  assertEquals(turnTime(now - 10_000, now)?.label, "just now");
  assertEquals(turnTime(now - 3 * 60_000, now)?.label, "3m ago");
  assertEquals(turnTime(now - 10_000, now)?.iso, new Date(now - 10_000).toISOString());
  assertEquals(turnTime(NaN, now), null);
  assertEquals(turnTime(0, now), null);
});

Deno.test("thread view: assistant turns carry an <agent-identity> header, the composer docks, the title focus is quiet", async () => {
  const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  assert(components.includes('customElements.define("agent-identity"'), "the identity header is a reusable component");
  const bubbleStart = components.indexOf("class MessageBubble");
  const bubbleEnd = components.indexOf('customElements.define("message-bubble"', bubbleStart);
  const bubble = components.slice(bubbleStart, bubbleEnd);
  assert(bubble.includes("<agent-identity"), "the agent bubble renders the shared identity header (not a hand-rolled row)");
  const identityStart = components.indexOf("class AgentIdentity");
  const identity = components.slice(identityStart, components.indexOf('customElements.define("agent-identity"', identityStart));
  assert(identity.includes("<time datetime="), "the header carries a <time datetime> element");
  assert(identity.includes("<svg") && !/[\u{1F300}-\u{1FAFF}]/u.test(identity), "the fallback avatar is inline SVG, never an emoji");
  assert(!bubble.includes('"Generated UI"'), "the literal 'Generated UI' head is gone");
  assert(bubble.includes("artifactCardTitle("), "the card head resolves the artifact name through the shared rule");
  const convStart = components.indexOf("class AgentConversation");
  const convEnd = components.indexOf('customElements.define("agent-conversation"', convStart);
  const conv = components.slice(convStart, convEnd);
  assert(conv.includes("isScrolledToBottom("), "appends honour the stick-to-bottom latch");
  const statusStart = components.indexOf("class ConversationRunStatus");
  const statusEnd = components.indexOf('customElements.define("conversation-run-status"', statusStart);
  const status = components.slice(statusStart, statusEnd);
  assert(status.includes("<loading-state"), "the run row adopts the shared <loading-state> loader (DEAD-COMPONENTS-01)");
  assert(status.includes('aria-live="polite"'), "the banner is the single polite live region");
  const html = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  assert(/\.thread-body agent-composer\s*\{[^}]*position:\s*sticky/su.test(html), "the thread composer is docked (position: sticky)");
  assert(/\.thread-body agent-conversation\s*\{[^}]*flex:\s*0 0 auto/su.test(html), "the conversation is content-height, not a fixed flex:1 box");
  assert(html.includes("#thread-title.focus-quiet:focus-visible"), "programmatic title focus paints no ring");
});

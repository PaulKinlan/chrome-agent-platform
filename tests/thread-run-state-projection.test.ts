// @ts-nocheck
// chrome-agent-platform-716s.1 — ONE run-state projection behind three surfaces.
// A run paused on an approval card used to read "Working — run in progress…"
// in a reopened hub tab (status row), "Running…" on the hub timeline and an
// amber "running" dot in the sidebar, while the first tab showed the card.
// These tests pin the single projection (shared/thread-projection-authority.js)
// every consumer reads, the bounded pending-approval memory the worker replays
// from, and the card spec a re-mounted request renders with.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  pendingApprovalForRun,
  projectThreadRunState,
  projectThreadTitle,
} from "../extension/shared/thread-projection-authority.js";
import { buildTimeline, timelineStatus } from "../extension/lib/hub-timeline.js";
import {
  approvalEventKey,
  createPendingApprovalTracker,
  MAX_TRACKED_PENDING_APPROVALS,
} from "../extension/lib/pending-approval-replay.js";
import { approvalCardSpecFromRequest } from "../extension/shared/conversation.js";

const PERMISSION_REQUEST = Object.freeze({
  type: "approval-request",
  requestId: "rp_list_tabs",
  runId: "client_run_1",
  threadId: "t_paused",
  executionId: "exec_paused",
  expiresAt: Date.now() + 60_000,
  result: {
    ok: false,
    waitingForPermission: true,
    permissionRequirement: { reason: "list your open tabs", permissions: ["tabs"], grantGlobal: true },
  },
});

const RUNNING = Object.freeze({ executionId: "exec_paused", threadId: "t_paused", phase: "running", revision: 3, updatedAt: 100 });

Deno.test("projection: a running run with an unanswered approval request projects WAITING with the card", () => {
  const p = projectThreadRunState({ run: RUNNING, pendingApprovals: [PERMISSION_REQUEST] });
  assertEquals(p.state, "waiting");
  assertEquals(p.dot, "paused");
  assertEquals(p.timeline, "paused");
  assertEquals(p.outcome, "Waiting for you");
  assertEquals(p.status?.state, "waiting-for-permission", "the status row says waiting, never working");
  assert(String(p.status?.errorReason).includes("list your open tabs"), `reason carried: ${p.status?.errorReason}`);
  assertEquals(p.status?.executionId, "exec_paused");
  assertEquals(p.card?.requestId, "rp_list_tabs", "the SAME request id is what the reopened surface re-mounts");
});

Deno.test("projection: the same running run with no pending request projects WORKING", () => {
  const p = projectThreadRunState({ run: RUNNING, pendingApprovals: [] });
  assertEquals(p.state, "working");
  assertEquals(p.dot, "running");
  assertEquals(p.timeline, "running");
  assertEquals(p.status, { state: "running", activity: "run in progress" });
  assertEquals(p.card, null);
  // an approval for ANOTHER run never pauses this one
  const other = { ...PERMISSION_REQUEST, executionId: "exec_other", runId: "client_other", threadId: "t_other" };
  assertEquals(projectThreadRunState({ run: RUNNING, pendingApprovals: [other] }).state, "working");
});

Deno.test("projection: a durably paused run (provider permission) projects WAITING with no card and a Settings-recoverable category", () => {
  const run = { executionId: "e2", phase: "paused-permission", pause: { kind: "permission", reason: "host access to https://api.example is required" } };
  const p = projectThreadRunState({ run });
  assertEquals(p.state, "waiting");
  assertEquals(p.dot, "paused");
  assertEquals(p.timeline, "paused");
  assertEquals(p.outcome, "host access to https://api.example is required");
  assertEquals(p.status?.state, "waiting-for-permission");
  assertEquals(p.status?.errorCategory, "host-permission");
  assertEquals(p.card, null);
  assertEquals(projectThreadRunState({ run: { ...run, phase: "paused-provider-change", pause: { kind: "provider-change", reason: "x" } } }).status?.errorCategory, "provider-config");
});

Deno.test("projection: pendingApprovalForRun matches by execution id, then by the client run id", () => {
  assertEquals(pendingApprovalForRun({ executionId: "exec_paused" }, [PERMISSION_REQUEST])?.requestId, "rp_list_tabs");
  assertEquals(pendingApprovalForRun({ executionId: "nope", clientCorrelationId: "client_run_1" }, [PERMISSION_REQUEST])?.requestId, "rp_list_tabs");
  assertEquals(pendingApprovalForRun({ executionId: "nope" }, [PERMISSION_REQUEST]), null);
  assertEquals(pendingApprovalForRun({ executionId: "exec_paused" }, [{ ...PERMISSION_REQUEST, type: "approval-settled" }]), null, "a settled event is not a pending card");
  assertEquals(pendingApprovalForRun(null, [PERMISSION_REQUEST]), null);
});

// The table: one projection, three consumers — the sidebar dot class, the
// timeline status word + outcome text, and the conversation status row — must
// agree for every state. `timelineStatus`/`buildTimeline` are the real timeline
// consumers; the status row is the projection's `status`.
Deno.test("projection table: dot, timeline row and status row agree for paused / running / done / failed / cancelled", () => {
  const thread = { id: "t_paused", name: "list my open tabs", status: "running", updatedAt: 50 };
  const rows = [
    { label: "paused (card pending)", run: RUNNING, pending: [PERMISSION_REQUEST], dot: "paused", timeline: "paused", outcome: "Waiting for you", status: "waiting-for-permission" },
    { label: "paused (durable)", run: { ...RUNNING, phase: "paused-permission", pause: { kind: "permission", reason: "needs host access" } }, pending: [], dot: "paused", timeline: "paused", outcome: "needs host access", status: "waiting-for-permission" },
    { label: "running", run: RUNNING, pending: [], dot: "running", timeline: "running", outcome: "Running…", status: "running" },
    { label: "done", run: { ...RUNNING, phase: "terminal", terminal: { ok: true, summary: "Grouped 12 tabs" } }, pending: [], dot: "done", timeline: "done", outcome: "Grouped 12 tabs", status: null },
    { label: "failed", run: { ...RUNNING, phase: "terminal", terminal: { ok: false, summary: "provider refused" } }, pending: [], dot: "error", timeline: "failed", outcome: "provider refused", status: null },
    { label: "failed (phase)", run: { ...RUNNING, phase: "failed" }, pending: [], dot: "error", timeline: "failed", outcome: "Didn’t finish", status: null },
    { label: "cancelled", run: { ...RUNNING, phase: "cancelled" }, pending: [], dot: "error", timeline: "failed", outcome: "Didn’t finish", status: null },
  ];
  for (const row of rows) {
    const p = projectThreadRunState({ thread, run: row.run, pendingApprovals: row.pending });
    assertEquals(p.dot, row.dot, `${row.label}: sidebar dot`);
    assertEquals(p.timeline, row.timeline, `${row.label}: timeline status`);
    assertEquals(p.outcome, row.outcome, `${row.label}: timeline outcome`);
    assertEquals(p.status?.state ?? null, row.status, `${row.label}: status row`);
    // the real timeline consumers read the same projection
    assertEquals(timelineStatus(thread, row.run, row.pending), row.timeline, `${row.label}: timelineStatus()`);
    const [entry] = buildTimeline([thread], [row.run], { pendingApprovals: row.pending });
    assertEquals(entry.status, row.timeline, `${row.label}: buildTimeline status`);
    assertEquals(entry.outcome, row.outcome, `${row.label}: buildTimeline outcome`);
  }
});

Deno.test("projection: without a run the thread index status decides, exactly as the timeline always did", () => {
  assertEquals(projectThreadRunState({ thread: { status: "running" } }).timeline, "running");
  assertEquals(projectThreadRunState({ thread: { status: "error" } }).timeline, "failed");
  assertEquals(projectThreadRunState({ thread: { status: "done" } }).timeline, "done");
  assertEquals(projectThreadRunState({ thread: { status: "" } }).timeline, "");
  assertEquals(projectThreadRunState({}).state, "idle");
  // a buildTimeline call WITHOUT pendingApprovals keeps the prior behaviour
  const [row] = buildTimeline([{ id: "t1", name: "x", status: "running" }], [{ executionId: "e", threadId: "t1", phase: "running", updatedAt: 1 }]);
  assertEquals(row.status, "running");
  assertEquals(row.outcome, "Running…");
});

Deno.test("projection: one title source — the thread name, else the placeholder — for live and reopened views", () => {
  assertEquals(projectThreadTitle({ name: "list my open tabs" }), "list my open tabs");
  assertEquals(projectThreadTitle({ name: "  " }), "Task");
  assertEquals(projectThreadTitle(null), "Task");
  assertEquals(projectThreadTitle({ name: "" }, { placeholder: "New task" }), "New task");
  assertEquals(projectThreadTitle({ name: "x" }, { placeholder: "New task" }), "x");
});

// ── the worker's replay memory ───────────────────────────────────────────────

Deno.test("tracker: a published approval-request is replayable until its settlement; a settled key is forgotten", () => {
  const t = createPendingApprovalTracker();
  t.observe(PERMISSION_REQUEST);
  assertEquals(t.size, 1);
  assertEquals(t.replayable().map((e) => e.requestId), ["rp_list_tabs"]);
  const settled = t.settledEvent("rp_list_tabs", "granted");
  assertEquals(settled, {
    runId: "client_run_1", threadId: "t_paused", executionId: "exec_paused", requestId: "rp_list_tabs",
    type: "approval-settled", state: "granted",
  }, "the settled event carries the request's own stamps so every page's run filter accepts it");
  t.observe(settled);
  assertEquals(t.size, 0);
  assertEquals(t.settledEvent("rp_list_tabs", "denied"), null);
});

Deno.test("tracker: owner approvals key on approvalId; a run's done forgets its cards; unrelated events are ignored", () => {
  const t = createPendingApprovalTracker();
  const owner = { type: "approval-request", approvalId: "ap_1", executionId: "exec_a", expiresAt: Date.now() + 10_000, result: {} };
  t.observe(owner);
  t.observe({ ...PERMISSION_REQUEST, executionId: "exec_b" });
  t.observe({ type: "tool-call", executionId: "exec_a" });
  t.observe({ type: "approval-request", executionId: "exec_a" }); // no key → ignored
  assertEquals(approvalEventKey(owner), "ap_1");
  assertEquals(approvalEventKey({ requestId: "r", approvalId: "a" }), "r", "the inline request id wins");
  assertEquals(approvalEventKey({}), null);
  assertEquals(t.size, 2);
  t.observe({ type: "done", executionId: "exec_a" });
  assertEquals(t.replayable().map((e) => e.executionId), ["exec_b"]);
});

Deno.test("tracker: replay drops expired requests and requests whose waiter is gone; the memory is bounded", () => {
  const t = createPendingApprovalTracker();
  const now = 1_000_000;
  t.observe({ ...PERMISSION_REQUEST, requestId: "live", expiresAt: now + 1 });
  t.observe({ ...PERMISSION_REQUEST, requestId: "expired", expiresAt: now - 1 });
  t.observe({ ...PERMISSION_REQUEST, requestId: "dead-waiter", expiresAt: now + 1 });
  const out = t.replayable({ now, isLive: (ev) => ev.requestId !== "dead-waiter" });
  assertEquals(out.map((e) => e.requestId), ["live"]);
  assertEquals(t.size, 1, "pruned entries do not linger");
  const bounded = createPendingApprovalTracker();
  for (let i = 0; i < MAX_TRACKED_PENDING_APPROVALS + 5; i++) {
    bounded.observe({ ...PERMISSION_REQUEST, requestId: `rp_${i}` });
  }
  assertEquals(bounded.size, MAX_TRACKED_PENDING_APPROVALS);
  assertEquals(bounded.get("rp_0"), null, "the oldest entry is evicted first");
  assert(bounded.get(`rp_${MAX_TRACKED_PENDING_APPROVALS + 4}`), "the newest entry is kept");
});

// ── the card a re-mounted request renders ───────────────────────────────────

Deno.test("card spec: a permission request yields the normalized requirement (dedupe key, exact permissions); a forged shape yields nothing", () => {
  const spec = approvalCardSpecFromRequest(PERMISSION_REQUEST);
  assertEquals(spec.requirement.permissions, ["tabs"]);
  assertEquals(spec.requirement.grantGlobal, true);
  assertEquals(spec.requirement.reason, "list your open tabs");
  assert(typeof spec.requirement.key === "string" && spec.requirement.key.length > 0);
  assertEquals(spec.title, undefined, "a permission card has no action title");
  assertEquals(approvalCardSpecFromRequest({ type: "approval-request", result: { ok: false } }), null);
  assertEquals(approvalCardSpecFromRequest({ type: "approval-request", result: { waitingForPermission: true, permissionRequirement: { permissions: [] } } }), null);
});

Deno.test("card spec: an owner-approval action yields the live card's title/body/labels so a second tab shows the same card", async () => {
  const script = approvalCardSpecFromRequest({
    type: "approval-request", approvalId: "ap_s", executionId: "e",
    result: { ok: false, waitingForPermission: true, permissionRequirement: { reason: "script.run: ref-1", approvals: [{ approvalId: "ap_s", action: "script.run", targetRef: "ref-1", detail: { source: "console.log(1)", hosts: [], dynamic: false } }] } },
  });
  assertEquals(script.title, "Run this script now?");
  assert(script.body.startsWith("Action: script.run"));
  assertEquals(script.cardDetail?.source, "console.log(1)");
  const site = approvalCardSpecFromRequest({
    type: "approval-request", approvalId: "ap_w", executionId: "e",
    result: { ok: false, waitingForPermission: true, permissionRequirement: { reason: "webmcp.use-tool: x", approvals: [{ approvalId: "ap_w", action: "webmcp.use-tool", targetRef: "x", detail: { kind: "webmcp-tool", origin: "https://shop.example", tool: "add_to_cart" } }] } },
  });
  assertEquals(site.title, "Use https://shop.example’s add_to_cart?");
  assertEquals(site.approveLabel, "Allow automatically");
  assertEquals(site.denyLabel, "Deny");
  assertEquals(site.cardDetail, undefined);
  const attached = approvalCardSpecFromRequest({
    type: "approval-request", approvalId: "ap_attached", executionId: "e",
    result: { ok: false, waitingForPermission: true, permissionRequirement: { reason: "webmcp.use-tool: attached", approvals: [{
      approvalId: "ap_attached", action: "webmcp.use-tool", targetRef: "attached", detail: {
        kind: "webmcp-tool", scope: "attached-run", origin: "https://shop.example", tool: "add_to_cart",
      },
    }] } },
  });
  assertEquals(attached.approveLabel, "Allow for this run");
  assertEquals(attached.body.includes("this run and document"), true);
  assertEquals(attached.body.includes("does not enroll"), true);
  assertEquals(attached.body.includes("browser profile"), false);
  const conversation = await Deno.readTextFile(new URL("../extension/shared/conversation.js", import.meta.url));
  assertEquals(conversation.match(/siteToolApprovalCopy\(approval\.detail\)/g)?.length, 2,
    "the live and re-mounted card use one scope-aware copy source");
  // the projection names the site tool in the status row the same way
  const p = projectThreadRunState({ run: { phase: "running", executionId: "e" }, pendingApprovals: [{ type: "approval-request", approvalId: "ap_w", executionId: "e", result: { waitingForPermission: true, permissionRequirement: { reason: "webmcp.use-tool: x", approvals: [{ approvalId: "ap_w", action: "webmcp.use-tool", detail: { kind: "webmcp-tool", origin: "https://shop.example", tool: "add_to_cart" } }] } } }] });
  assertEquals(p.status.errorReason, "the agent needs approval to use add_to_cart on https://shop.example");
});

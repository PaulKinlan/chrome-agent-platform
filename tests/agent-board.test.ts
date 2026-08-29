// @ts-nocheck
// The shared inter-agent jobs board (owner green-lit 2026-08-29; v1 fully open
// among named agents + hub, guard seam kept for the deferred per-edge
// permission layer). Falsification-gated KATs for the REAL modules:
//
//  (1) GUARDS (lib/agent-board.js — the exact decision logic the board.*
//      routes call): hub + named agents pass; unknown identities refuse;
//      self-claim refuses; targeted jobs refuse the wrong claimant; blocked
//      jobs refuse until blockers complete.
//  (2) FOLD: posted→claimed→completed lifecycle, atomic claim transition,
//      derived lease expiry, heartbeat extension, release.
//  (3) STORE: end-to-end post/claim/settle over an in-memory hub store with
//      the lock; claim race (second claimant denied); double-settle
//      idempotence; pruning keeps OPEN jobs and drops oldest settled; every
//      free-text field is secret-redacted + bounded.
//  (4) ROUTES: createAgentBoardRoutes with the real store — caller identity
//      comes from the route CONTEXT resolver (a forged identity can never
//      win); broadcast events fire on post/claim/complete.
//  (5) TOOL WIRING: managementToolset's board_* tools forward model args to
//      the right routes through the SAME callRoute seam; the tools are in the
//      capability inventory.
//  (6) LEASE PARITY: the board's claim lease IS the scheduler's in-flight
//      lease (copied verbatim — the test pins the values equal so drift fails).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BOARD_CLAIM_LEASE_MS,
  BOARD_HUB_ID,
  BOARD_JOBS_KEY,
  BOARD_MAX_DESCRIPTION,
  BOARD_MAX_MESSAGES,
  BOARD_MAX_OPEN_JOBS,
  BOARD_MAX_SETTLED_JOBS,
  BOARD_MESSAGES_KEY,
  boardText,
  canClaimJob,
  canPostJob,
  createAgentBoard,
  createAgentBoardRoutes,
  foldJobEvents,
  foldMessageEvents,
  pruneJobEvents,
} from "../extension/lib/agent-board.js";
import { INFLIGHT_LEASE_MS } from "../extension/lib/scheduler.js";
import { managementToolset, MANAGEMENT_TOOL_NAMES } from "../extension/lib/management-tools.js";
import { MANAGEMENT_CAPABILITY_TOOL_NAMES } from "../extension/lib/chrome-tool-capabilities.js";

const AGENTS = [
  { id: "writer", name: "Blog Writer" },
  { id: "critic", name: "The Critic" },
  { id: "researcher", name: "Researcher" },
];

function mockMemory() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => void map.set(k, v),
    _map: map,
  };
}

// ── (6) lease parity ────────────────────────────────────────────────────────
Deno.test("board: the claim lease IS the scheduler's in-flight lease (drift fails)", () => {
  assertEquals(BOARD_CLAIM_LEASE_MS, INFLIGHT_LEASE_MS);
  assertEquals(BOARD_CLAIM_LEASE_MS, 5 * 60 * 1000);
});

// ── (1) guards ──────────────────────────────────────────────────────────────
Deno.test("board guard: the hub and known named agents may post; unknown identities refuse", () => {
  assertEquals(canPostJob({ callerId: BOARD_HUB_ID, agents: AGENTS }).ok, true);
  assertEquals(canPostJob({ callerId: "writer", agents: AGENTS }).ok, true);
  const denied = canPostJob({ callerId: "ghost", agents: AGENTS });
  assertEquals(denied.ok, false);
  assertEquals(denied.code, "board-unknown-poster");
  const badTarget = canPostJob({ callerId: "writer", agents: AGENTS, targetAgentId: "ghost" });
  assertEquals(badTarget.ok, false);
  assertEquals(badTarget.code, "board-unknown-target");
});

Deno.test("board guard: the full claim matrix (open/targeted/blocked/self/settled)", () => {
  const job = { id: "job_1", posterId: "writer", status: "pending", blockedBy: [] };
  assertEquals(canClaimJob({ callerId: "critic", agents: AGENTS, job }).ok, true);
  assertEquals(canClaimJob({ callerId: BOARD_HUB_ID, agents: AGENTS, job }).ok, true);

  const selfClaim = canClaimJob({ callerId: "writer", agents: AGENTS, job });
  assertEquals(selfClaim.ok, false);
  assertEquals(selfClaim.code, "board-self-claim");

  const ghost = canClaimJob({ callerId: "ghost", agents: AGENTS, job });
  assertEquals(ghost.ok, false);
  assertEquals(ghost.code, "board-unknown-claimant");

  const targeted = { ...job, targetAgentId: "critic", targetName: "The Critic" };
  const wrongAgent = canClaimJob({ callerId: "researcher", agents: AGENTS, job: targeted });
  assertEquals(wrongAgent.ok, false);
  assertEquals(wrongAgent.code, "board-targeted");
  assertEquals(canClaimJob({ callerId: "critic", agents: AGENTS, job: targeted }).ok, true);

  const claimed = { ...job, status: "claimed", claimantId: "critic", claimantName: "The Critic" };
  const race = canClaimJob({ callerId: "researcher", agents: AGENTS, job: claimed });
  assertEquals(race.ok, false);
  assertEquals(race.code, "board-already-claimed");

  const settled = { ...job, status: "completed" };
  assertEquals(canClaimJob({ callerId: "critic", agents: AGENTS, job: settled }).code, "board-settled");

  const blocked = { ...job, blockedBy: ["job_0"] };
  const blockedDeny = canClaimJob({ callerId: "critic", agents: AGENTS, job: blocked, settledJobs: [{ id: "job_0", status: "failed" }] });
  assertEquals(blockedDeny.ok, false);
  assertEquals(blockedDeny.code, "board-blocked");
  const unblocked = canClaimJob({ callerId: "critic", agents: AGENTS, job: blocked, settledJobs: [{ id: "job_0", status: "completed" }] });
  assertEquals(unblocked.ok, true);
});

// ── (2) fold ────────────────────────────────────────────────────────────────
Deno.test("board fold: lifecycle, atomic claim, derived lease expiry, heartbeat, release", () => {
  const t0 = 1_000_000;
  const events = [
    { type: "posted", jobId: "job_1", ts: t0, posterId: "writer", posterName: "Blog Writer", description: "critique the draft" },
    { type: "claimed", jobId: "job_1", ts: t0 + 1000, claimantId: "critic", claimantName: "The Critic", leaseExpiry: t0 + 1000 + BOARD_CLAIM_LEASE_MS },
  ];
  let jobs = foldJobEvents(events, t0 + 2000);
  assertEquals(jobs[0].status, "claimed");
  assertEquals(jobs[0].claimantId, "critic");

  // A second claim event CANNOT overwrite the first (atomic transition).
  const raced = foldJobEvents([...events, { type: "claimed", jobId: "job_1", ts: t0 + 1500, claimantId: "researcher", leaseExpiry: t0 + 99999 }], t0 + 2000);
  assertEquals(raced[0].claimantId, "critic");

  // Lease expiry is derived: past leaseExpiry reads as pending again.
  const expired = foldJobEvents(events, t0 + 1000 + BOARD_CLAIM_LEASE_MS + 1);
  assertEquals(expired[0].status, "pending");
  assertEquals(expired[0].claimantId, null);

  // Heartbeat extends only the claimant's lease.
  const hb = foldJobEvents([...events, { type: "heartbeat", jobId: "job_1", ts: t0 + 5000, claimantId: "critic", leaseExpiry: t0 + 5000 + BOARD_CLAIM_LEASE_MS }], t0 + 6000);
  assertEquals(hb[0].leaseExpiry, t0 + 5000 + BOARD_CLAIM_LEASE_MS);
  const hbOther = foldJobEvents([...events, { type: "heartbeat", jobId: "job_1", ts: t0 + 5000, claimantId: "researcher", leaseExpiry: t0 + 99999 }], t0 + 6000);
  assertEquals(hbOther[0].leaseExpiry, t0 + 1000 + BOARD_CLAIM_LEASE_MS);

  // Completed settles; a non-claimant completion is ignored.
  const done = foldJobEvents([...events, { type: "completed", jobId: "job_1", ts: t0 + 3000, claimantId: "critic", result: "looks good" }], t0 + 4000);
  assertEquals(done[0].status, "completed");
  assertEquals(done[0].result, "looks good");
  const forged = foldJobEvents([...events, { type: "completed", jobId: "job_1", ts: t0 + 3000, claimantId: "researcher", result: "forged" }], t0 + 4000);
  assertEquals(forged[0].status, "claimed");

  // Released returns the job to pending.
  const released = foldJobEvents([...events, { type: "released", jobId: "job_1", ts: t0 + 3000 }], t0 + 4000);
  assertEquals(released[0].status, "pending");
});

Deno.test("board fold: messages fold most-recent-first with addressee intact", () => {
  const messages = foldMessageEvents([
    { type: "message", id: "m1", ts: 100, fromId: "writer", fromName: "Blog Writer", toId: "broadcast", body: "draft is up" },
    { type: "message", id: "m2", ts: 200, fromId: "critic", fromName: "The Critic", toId: "writer", body: "on it" },
  ]);
  assertEquals(messages.map((m) => m.id), ["m2", "m1"]);
  assertEquals(messages[0].toId, "writer");
  assertEquals(messages[1].toName, "everyone");
});

// ── (3) store ───────────────────────────────────────────────────────────────
Deno.test("board store: post → claim → complete end-to-end with identity recorded", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "Critique the latest draft", requiredCapability: "critique" });
  assertEquals(posted.ok, true);
  assertEquals(posted.job.posterId, "writer");
  assertEquals(posted.job.posterName, "Blog Writer");
  assertEquals(posted.job.status, "pending");

  const claimed = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  assertEquals(claimed.ok, true);
  assertEquals(claimed.job.status, "claimed");
  assertEquals(claimed.job.claimantId, "critic");
  assertEquals(claimed.job.leaseExpiry > Date.now(), true);

  const settled = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "Tightened the intro; ship it." });
  assertEquals(settled.ok, true);
  assertEquals(settled.job.status, "completed");
  assertEquals(settled.job.result, "Tightened the intro; ship it.");
});

Deno.test("board store: claim race — the second claimant is denied", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "review this" });
  const first = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  assertEquals(first.ok, true);
  const second = await board.claimJob({ callerId: "researcher", agents: AGENTS, jobId: posted.job.id });
  assertEquals(second.ok, false);
  assertEquals(second.code, "board-already-claimed");
});

Deno.test("board store: double-settle is idempotent for the claimant and refused for others", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "review this" });
  await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  const first = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "done" });
  assertEquals(first.ok, true);
  const again = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "done twice?" });
  assertEquals(again.ok, true);
  assertEquals(again.alreadySettled, true);
  const settledJob = (await board.listJobs())[0];
  assertEquals(settledJob.result, "done"); // the first result stands
  const other = await board.settleJob({ callerId: "researcher", jobId: posted.job.id, result: "forged" });
  assertEquals(other.ok, false);
  assertEquals(other.code, "board-settled");
});

Deno.test("board store: a non-claimant can never settle someone else's claim", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "review this" });
  await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  const stolen = await board.settleJob({ callerId: "researcher", jobId: posted.job.id, result: "I did it" });
  assertEquals(stolen.ok, false);
  assertEquals(stolen.code, "board-not-claimant");
});

Deno.test("board store: free text is secret-redacted and bounded at write", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const longDescription = `x ${"y".repeat(BOARD_MAX_DESCRIPTION + 500)}`;
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: longDescription });
  assertEquals(posted.job.description.length <= BOARD_MAX_DESCRIPTION, true);
  const withSecret = await board.postJob({ callerId: "writer", agents: AGENTS, description: "use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  assertEquals(withSecret.job.description.includes("sk-ant-api03-AAA"), false);

  const claimed = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  assertEquals(claimed.ok, true);
  const settled = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "r".repeat(8000) });
  assertEquals(settled.job.result.length <= 4000, true);

  const msg = await board.sendMessage({ callerId: "writer", agents: AGENTS, body: "b".repeat(5000) });
  assertEquals(msg.message.body.length <= 2000, true);
});

Deno.test("board store: pruning drops oldest SETTLED jobs and never open ones", async () => {
  const memory = mockMemory();
  const board = createAgentBoard({ memory });
  const openIds = [];
  for (let i = 0; i < 3; i += 1) {
    const p = await board.postJob({ callerId: "writer", agents: AGENTS, description: `open ${i}` });
    openIds.push(p.job.id);
  }
  for (let i = 0; i < BOARD_MAX_SETTLED_JOBS + 10; i += 1) {
    const p = await board.postJob({ callerId: "writer", agents: AGENTS, description: `settled ${i}` });
    await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: p.job.id });
    await board.settleJob({ callerId: "critic", jobId: p.job.id, result: "done" });
  }
  const jobs = await board.listJobs();
  const settled = jobs.filter((j) => j.status === "completed");
  assertEquals(settled.length <= BOARD_MAX_SETTLED_JOBS, true);
  for (const id of openIds) {
    assertEquals(jobs.some((j) => j.id === id && j.status === "pending"), true);
  }
});

Deno.test("board store: the open-jobs cap refuses the 101st open job", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  for (let i = 0; i < BOARD_MAX_OPEN_JOBS; i += 1) {
    const p = await board.postJob({ callerId: "writer", agents: AGENTS, description: `job ${i}` });
    assertEquals(p.ok, true);
  }
  const over = await board.postJob({ callerId: "writer", agents: AGENTS, description: "one too many" });
  assertEquals(over.ok, false);
  assertEquals(over.code, "board-full");
});

Deno.test("board store: blockedBy validates known jobs and gates claiming", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const badRef = await board.postJob({ callerId: "writer", agents: AGENTS, description: "child", blockedBy: ["job_nope"] });
  assertEquals(badRef.ok, false);
  assertEquals(badRef.code, "board-bad-blocker");
  const parent = await board.postJob({ callerId: "writer", agents: AGENTS, description: "parent" });
  const child = await board.postJob({ callerId: "writer", agents: AGENTS, description: "child", blockedBy: [parent.job.id] });
  const early = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: child.job.id });
  assertEquals(early.ok, false);
  assertEquals(early.code, "board-blocked");
  await board.claimJob({ callerId: "researcher", agents: AGENTS, jobId: parent.job.id });
  await board.settleJob({ callerId: "researcher", jobId: parent.job.id, result: "done" });
  const after = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: child.job.id });
  assertEquals(after.ok, true);
});

Deno.test("board store: messages bound and filter to the addressee + broadcast", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  await board.sendMessage({ callerId: "writer", agents: AGENTS, body: "draft up" });
  await board.sendMessage({ callerId: "critic", agents: AGENTS, to: "writer", body: "notes attached" });
  await board.sendMessage({ callerId: "researcher", agents: AGENTS, to: "critic", body: "private-ish" });
  const forWriter = await board.listMessages({ forAgentId: "writer" });
  assertEquals(forWriter.map((m) => m.body).sort(), ["draft up", "notes attached"]);
  const all = await board.listMessages();
  assertEquals(all.length, 3);
  // The message log is bounded.
  for (let i = 0; i < BOARD_MAX_MESSAGES + 20; i += 1) await board.sendMessage({ callerId: "writer", agents: AGENTS, body: `m${i}` });
  const bounded = await board.listMessages({ limit: 1000 });
  assertEquals(bounded.length <= BOARD_MAX_MESSAGES, true);
});

Deno.test("board store: unknown addressee and unknown target refuse cleanly", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const msg = await board.sendMessage({ callerId: "writer", agents: AGENTS, to: "ghost", body: "hello?" });
  assertEquals(msg.ok, false);
  assertEquals(msg.code, "board-unknown-target");
  const job = await board.postJob({ callerId: "writer", agents: AGENTS, description: "x", targetAgentRef: "ghost" });
  assertEquals(job.ok, false);
  assertEquals(job.code, "board-unknown-target");
  // Name resolution (the delegate_to_agent convention): exact display name works.
  const byName = await board.postJob({ callerId: "writer", agents: AGENTS, description: "x", targetAgentRef: "The Critic" });
  assertEquals(byName.ok, true);
  assertEquals(byName.job.targetAgentId, "critic");
});

// ── (4) routes ──────────────────────────────────────────────────────────────
Deno.test("board routes: caller identity comes from the route CONTEXT, never model args", async () => {
  const broadcasts = [];
  // The SW resolver: a live run's agent id, else the hub. Model args carry no
  // identity field at all — the routes never read one from the body.
  const routes = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => context?.agentId ?? null,
    broadcast: (e) => broadcasts.push(e),
  });
  // A call with NO run context resolves to the hub.
  const posted = await routes["board.post"]({ description: "critique the draft" }, {});
  assertEquals(posted.ok, true);
  assertEquals(posted.job.posterId, BOARD_HUB_ID);
  // A named-agent run context resolves to that agent.
  const claimed = await routes["board.claim"]({ jobId: posted.job.id }, { agentId: "critic" });
  assertEquals(claimed.ok, true);
  assertEquals(claimed.job.claimantId, "critic");
  // A body that TRIES to carry identity is ignored (the route never reads it).
  const forged = await routes["board.complete"]({ jobId: posted.job.id, result: "forged", callerId: "writer", posterId: "writer" }, { agentId: "critic" });
  assertEquals(forged.ok, true);
  const job = (await routes["board.read"]({ jobId: posted.job.id })).job;
  assertEquals(job.claimantId, "critic");
  assertEquals(job.result, "forged");
  // The completion broadcast carries poster + claimant for the wake path.
  const completion = broadcasts.find((e) => e.type === "board-job-completed");
  assertEquals(completion.posterId, BOARD_HUB_ID);
  assertEquals(completion.claimantId, "critic");
  assertEquals(broadcasts.some((e) => e.type === "board-job-posted"), true);
  assertEquals(broadcasts.some((e) => e.type === "board-job-claimed"), true);
});

// ── (5) tool wiring ─────────────────────────────────────────────────────────
Deno.test("board tools: the model-facing tools forward args to the right routes through callRoute", async () => {
  const calls = [];
  const tools = managementToolset({ callRoute: (type, args) => { calls.push([type, args]); return { ok: true }; } });
  await tools.board_post_job.execute({ description: "critique this", requiredCapability: "critique", targetAgent: "critic", blockedBy: ["job_1"] });
  assertEquals(calls[0], ["board.post", { description: "critique this", requiredCapability: "critique", targetAgent: "critic", blockedBy: ["job_1"] }]);
  await tools.board_claim_job.execute({ jobId: "job_1" });
  assertEquals(calls[1], ["board.claim", { jobId: "job_1" }]);
  await tools.board_complete_job.execute({ jobId: "job_1", result: "done" });
  assertEquals(calls[2], ["board.complete", { jobId: "job_1", result: "done" }]);
  await tools.board_send_message.execute({ to: "broadcast", body: "hi", refJobId: "job_1" });
  assertEquals(calls[3], ["board.message", { to: "broadcast", body: "hi", refJobId: "job_1" }]);
  await tools.board_list.execute({ status: "pending" });
  assertEquals(calls[4], ["board.list", { status: "pending" }]);
  await tools.board_read.execute({ jobId: "job_1" });
  assertEquals(calls[5], ["board.read", { jobId: "job_1" }]);
});

Deno.test("board tools: registered in the tool names + capability inventory", () => {
  for (const name of ["board_post_job", "board_claim_job", "board_complete_job", "board_send_message", "board_list", "board_read"]) {
    assertEquals(MANAGEMENT_TOOL_NAMES.includes(name), true, `${name} missing from MANAGEMENT_TOOL_NAMES`);
    assertEquals(MANAGEMENT_CAPABILITY_TOOL_NAMES.includes(name), true, `${name} missing from the capability inventory`);
  }
});

// ── text hygiene ────────────────────────────────────────────────────────────
Deno.test("board text: bounding, redaction, and whitespace collapse", () => {
  assertEquals(boardText("  hello   world  ", 100), "hello world");
  assertEquals(boardText("x".repeat(3000), BOARD_MAX_DESCRIPTION).length, BOARD_MAX_DESCRIPTION);
  assertEquals(boardText(null, 100), "");
  assertStringIncludes(boardText("normal text", 100), "normal text");
});

Deno.test("board fold: pruneJobEvents is a no-op under the settled cap", () => {
  const events = [
    { type: "posted", jobId: "job_1", ts: 1, posterId: "writer", description: "x" },
    { type: "claimed", jobId: "job_1", ts: 2, claimantId: "critic", leaseExpiry: 2 + BOARD_CLAIM_LEASE_MS },
    { type: "completed", jobId: "job_1", ts: 3, claimantId: "critic", result: "done" },
  ];
  assertEquals(pruneJobEvents(events, 4).length, 3);
  // Storage keys are the documented hub-tier keys.
  assertEquals(BOARD_JOBS_KEY, "cap:board-jobs");
  assertEquals(BOARD_MESSAGES_KEY, "cap:board-messages");
});

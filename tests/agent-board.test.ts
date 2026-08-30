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

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BOARD_CLAIM_HEARTBEAT_MS,
  BOARD_CLAIM_LEASE_MS,
  BOARD_HUB_ID,
  BOARD_JOBS_KEY,
  BOARD_MAX_BLOCKED_BY,
  BOARD_MAX_DESCRIPTION,
  BOARD_MAX_LOG_BYTES,
  BOARD_MAX_MESSAGE_BODY,
  BOARD_MAX_MESSAGES,
  BOARD_MAX_OPEN_JOBS,
  BOARD_MAX_RESULT,
  BOARD_MAX_SETTLED_JOBS,
  BOARD_MAX_TOMBSTONES,
  BOARD_MESSAGES_KEY,
  boardHeartbeatPlan,
  boardText,
  boardWakeTargets,
  canClaimJob,
  canPostJob,
  createAgentBoard,
  createAgentBoardRoutes,
  foldJobEvents,
  foldMessageEvents,
  posterThreadResolver,
  pruneJobEvents,
} from "../extension/lib/agent-board.js";
import { INFLIGHT_HEARTBEAT_MS, INFLIGHT_LEASE_MS } from "../extension/lib/scheduler.js";
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
    // The trusted internal paths the board uses (the model-facing get/set are
    // RESERVED against the board keys — see the reservation tests below).
    getStrict: async (k) => (map.has(k) ? map.get(k) : null),
    setTrusted: async (k, v) => void map.set(k, v),
    _map: map,
  };
}

// ── (6) lease parity ────────────────────────────────────────────────────────
Deno.test("board: the claim lease IS the scheduler's in-flight lease (drift fails)", () => {
  assertEquals(BOARD_CLAIM_LEASE_MS, INFLIGHT_LEASE_MS);
  assertEquals(BOARD_CLAIM_LEASE_MS, 5 * 60 * 1000);
  assertEquals(BOARD_CLAIM_HEARTBEAT_MS, INFLIGHT_HEARTBEAT_MS);
  assertEquals(BOARD_CLAIM_HEARTBEAT_MS, 30 * 1000);
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
  // r2: eviction leaves compact TOMBSTONES — the FULL record count is capped,
  // evicted jobs stay readable as settled tombstones (retry-idempotence), and
  // the tombstone count is itself capped.
  assertEquals(settled.filter((j) => !j.tombstone).length <= BOARD_MAX_SETTLED_JOBS, true);
  assertEquals(settled.filter((j) => j.tombstone).length <= BOARD_MAX_TOMBSTONES, true);
  assertEquals(settled.some((j) => j.tombstone), true, "eviction produced tombstones");
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
  const { routes } = createAgentBoardRoutes({
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

Deno.test("board routes: board.messages exposes the read-side feed (bounded, most-recent-first)", async () => {
  // Distinct injected timestamps: two posts in the same millisecond must
  // still order most-recent-first by the fold's ts sort.
  let tick = 1000;
  const { routes } = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: () => null,
    broadcast: () => {},
    now: () => ++tick,
  });
  // An empty board reads as an empty feed (never an error, never undefined).
  const empty = await routes["board.messages"]({}, {});
  assertEquals(empty.ok, true);
  assertEquals(empty.messages, []);
  // Two real posts land most-recent-first.
  await routes["board.message"]({ to: "broadcast", body: "first message" }, { agentId: "writer" });
  await routes["board.message"]({ to: "critic", body: "second message" }, { agentId: "writer" });
  const listed = await routes["board.messages"]({}, {});
  assertEquals(listed.ok, true);
  assertEquals(listed.messages.length, 2);
  assertEquals(listed.messages[0].body, "second message");
  assertEquals(listed.messages[1].body, "first message");
  assertEquals(listed.messages[0].toName, "The Critic");
  // The limit clamps (the owner surface asks for a handful, never the log).
  const one = await routes["board.messages"]({ limit: 1 }, {});
  assertEquals(one.messages.length, 1);
  const clamped = await routes["board.messages"]({ limit: 1000 }, {});
  assertEquals(clamped.messages.length <= 50, true);
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
  for (const name of ["board_post_job", "board_claim_job", "board_complete_job", "board_send_message", "board_list", "board_read", "board_read_messages"]) {
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

// ── review-revision battery (round-1 REVISE: P1-1…P1-6 + P2-2) ─────────────

// (P1-1) The board logs are AUTHORITY: the model's memory_set must never
// replace them with forged identities, and memory_get/keys must not expose
// them. The reservation lives in memory.js; the KAT proves it behaviorally
// against the loaded extension — this pins the source contract.
Deno.test("board authority: memory.js reserves + hides both board log keys", async () => {
  const src = await Deno.readTextFile(new URL("../extension/lib/memory.js", import.meta.url));
  const reserved = src.match(/const MASTER_RESERVED_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assertStringIncludes(reserved, '"cap:board-jobs"');
  assertStringIncludes(reserved, '"cap:board-messages"');
  const hidden = src.match(/const INTERNAL_KEY_RE = \/(.+)\//)?.[1] ?? "";
  assertStringIncludes(hidden, "cap:board-");
  // The model-facing read path (memory.get → memory_get tool) throws on them.
  const getBody = src.match(/async get\(key\) \{([\s\S]*?)reserved on this store/)?.[1] ?? "";
  assertStringIncludes(getBody, "cap:board-");
});

// (P1-1) The board store itself must use the TRUSTED paths — if it used the
// model-facing set/get, reserving the keys would break the board.
Deno.test("board authority: the store writes via setTrusted and reads via getStrict (never the model paths)", async () => {
  const map = new Map();
  const writes = [];
  const memory = {
    get: async () => { throw new Error("the board must not read its logs via the model-facing get"); },
    set: async () => { throw new Error("the board must not write its logs via the model-facing set"); },
    getStrict: async (k) => (map.has(k) ? map.get(k) : null),
    setTrusted: async (k, v) => { writes.push(k); void map.set(k, v); },
  };
  const board = createAgentBoard({ memory });
  const posted = await board.postJob({ callerId: BOARD_HUB_ID, agents: AGENTS, description: "reserved write path" });
  assertEquals(posted.ok, true);
  assert(writes.includes(BOARD_JOBS_KEY), "the job log write used setTrusted");
  const listed = await board.listJobs();
  assertEquals(listed.length, 1);
  const msg = await board.sendMessage({ callerId: BOARD_HUB_ID, agents: AGENTS, body: "reserved message path" });
  assertEquals(msg.ok, true);
  assert(writes.includes(BOARD_MESSAGES_KEY), "the message log write used setTrusted");
});

// (P1-2) An expired claim is RECLAIMABLE: the fold expires a prior claim AS
// OF each later event's time, so a claim the store legitimately admitted
// after expiry is not dropped by the end-of-fold expiry pass.
Deno.test("board fold: a claim appended after the previous lease expired wins (event-time expiry)", () => {
  const t0 = 1_000_000;
  const events = [
    { type: "posted", jobId: "j1", ts: t0, posterId: "writer", description: "d" },
    { type: "claimed", jobId: "j1", ts: t0 + 1_000, claimantId: "critic", leaseExpiry: t0 + 1_000 + BOARD_CLAIM_LEASE_MS },
    // admitted by the store under the lock AFTER the critic's lease expired:
    { type: "claimed", jobId: "j1", ts: t0 + 1_000 + BOARD_CLAIM_LEASE_MS + 5_000, claimantId: "researcher", leaseExpiry: t0 + 1_000 + 2 * BOARD_CLAIM_LEASE_MS + 5_000 },
  ];
  const [job] = foldJobEvents(events, t0 + 1_000 + BOARD_CLAIM_LEASE_MS + 6_000);
  assertEquals(job.status, "claimed");
  assertEquals(job.claimantId, "researcher");
});

Deno.test("board store: an expired-lease job is reclaimed end to end", async () => {
  let now = 1_000_000;
  const memory = mockMemory();
  const board = createAgentBoard({ memory, now: () => now });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "reclaim me" });
  const claimed = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  assertEquals(claimed.ok, true);
  // The claimant vanishes past the lease…
  now += BOARD_CLAIM_LEASE_MS + 1_000;
  const reclaimed = await board.claimJob({ callerId: "researcher", agents: AGENTS, jobId: posted.job.id });
  assertEquals(reclaimed.ok, true);
  assertEquals(reclaimed.job.claimantId, "researcher");
  // …and a READ at the same instant shows the new claimant (the round-1 bug
  // read the job as pending with no claimant).
  const read = await board.getJob(posted.job.id);
  assertEquals(read.status, "claimed");
  assertEquals(read.claimantId, "researcher");
  // The EXPIRED claimant can no longer settle.
  const lateSettle = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "too late" });
  assertEquals(lateSettle.ok, false);
});

// (P1-3) Pruning never strands an open dependent: a settled job still
// referenced by an OPEN job's blockedBy keeps its completion record.
Deno.test("board fold: pruning preserves settled jobs an open job still depends on", () => {
  let ts = 1_000_000;
  const events = [
    { type: "posted", jobId: "parent", ts: ts++, posterId: "writer", description: "parent" },
    { type: "claimed", jobId: "parent", ts: ts++, claimantId: "critic", leaseExpiry: ts + BOARD_CLAIM_LEASE_MS },
    { type: "completed", jobId: "parent", ts: ts++, claimantId: "critic", result: "done" },
    { type: "posted", jobId: "child", ts: ts++, posterId: "writer", description: "child", blockedBy: ["parent"] },
  ];
  for (let i = 0; i < BOARD_MAX_SETTLED_JOBS + 5; i += 1) {
    events.push({ type: "posted", jobId: `old${i}`, ts: ts++, posterId: "writer", description: "old" });
    events.push({ type: "claimed", jobId: `old${i}`, ts: ts++, claimantId: "critic", leaseExpiry: ts + BOARD_CLAIM_LEASE_MS });
    events.push({ type: "completed", jobId: `old${i}`, ts: ts++, claimantId: "critic", result: "done" });
  }
  const pruned = pruneJobEvents(events, ts + 1_000);
  const jobs = foldJobEvents(pruned, ts + 1_000);
  const child = jobs.find((j) => j.id === "child");
  assert(child, "the open child survives pruning");
  // The parent's completion record survives → the child is claimable NOW.
  const guard = canClaimJob({ callerId: "critic", agents: AGENTS, job: child, settledJobs: jobs });
  assertEquals(guard.ok, true);
  // Unreferenced old settled jobs WERE evicted (full records capped; the
  // evicted ones remain as tombstones — r2 semantics).
  assert(jobs.filter((j) => j.id.startsWith("old") && !j.tombstone).length <= BOARD_MAX_SETTLED_JOBS);
});

// (P1-4) Superseded heartbeats are compacted: one long-lived claimed job must
// not grow the log unboundedly. The latest heartbeat keeps fold authority.
Deno.test("board store: superseded heartbeats are compacted (fold authority retained)", async () => {
  const memory = mockMemory();
  const board = createAgentBoard({ memory });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "long job" });
  await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  for (let i = 0; i < 200; i += 1) await board.heartbeatJob({ callerId: "critic", jobId: posted.job.id });
  const events = memory._map.get(BOARD_JOBS_KEY);
  const heartbeats = events.filter((e) => e.type === "heartbeat");
  assert(heartbeats.length <= 1, `expected ≤1 retained heartbeat, got ${heartbeats.length}`);
  const [folded] = foldJobEvents(events, Date.now());
  assertEquals(folded.status, "claimed");
  assertEquals(folded.claimantId, "critic");
  assert(folded.leaseExpiry > Date.now(), "the surviving heartbeat still carries the live lease");
});

// (P1-4) BOTH serialized logs stay under the memory per-value cap (256 KiB)
// with margin — the message count cap alone allowed 200×2 KB > 256 KiB.
Deno.test("board store: both logs are byte-bounded below the memory per-value cap", async () => {
  assert(BOARD_MAX_LOG_BYTES < 256 * 1024, "the board budget must stay under memory's 256 KiB per-value cap");
  const memory = mockMemory();
  const board = createAgentBoard({ memory });
  for (let i = 0; i < BOARD_MAX_MESSAGES + 40; i += 1) {
    const r = await board.sendMessage({ callerId: BOARD_HUB_ID, agents: AGENTS, body: "x".repeat(BOARD_MAX_MESSAGE_BODY) });
    assertEquals(r.ok, true);
  }
  const messages = memory._map.get(BOARD_MESSAGES_KEY);
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).length;
  assert(bytes <= BOARD_MAX_LOG_BYTES, `messages log ${bytes}B exceeds the ${BOARD_MAX_LOG_BYTES}B budget`);
  assert(messages.length <= BOARD_MAX_MESSAGES);
  assert(messages.length > 0, "recent messages survive byte-bounded pruning");
});

// (P1-4) Posting fails CLOSED (board-full) when the jobs log is byte-full —
// an open job's events are never dropped to make room.
Deno.test("board store: posting refuses when the jobs log is byte-full (open jobs are never dropped)", async () => {
  const memory = mockMemory();
  const board = createAgentBoard({ memory });
  let refused = null;
  let postedCount = 0;
  for (let i = 0; i < BOARD_MAX_OPEN_JOBS + 20; i += 1) {
    const r = await board.postJob({ callerId: "writer", agents: AGENTS, description: "y".repeat(BOARD_MAX_DESCRIPTION) });
    if (!r.ok) { refused = r; break; }
    postedCount += 1;
  }
  assert(refused, "the byte gate must bite before the memory cap can");
  assertEquals(refused.code, "board-full");
  const bytes = new TextEncoder().encode(JSON.stringify(memory._map.get(BOARD_JOBS_KEY))).length;
  assert(bytes <= BOARD_MAX_LOG_BYTES, `jobs log ${bytes}B exceeds the budget`);
  assert(postedCount > 10, `suspiciously few jobs fit (${postedCount}) — the gate should bite near the budget, not immediately`);
});

// (P1-5) A stale MODEL context fails CLOSED — it never escalates to hub
// authority. Trusted owner/page surfaces (no model principal) default to hub.
Deno.test("board routes: a stale model context is denied, never hub-escalated", async () => {
  const { routes } = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: () => null, // production: the execution id is no longer live anywhere
  });
  const stale = { principal: "model", executionId: "exec-gone" };
  for (const [route, body] of [
    ["board.post", { description: "forge a hub post" }],
    ["board.claim", { jobId: "job_x" }],
    ["board.complete", { jobId: "job_x", result: "forged" }],
    ["board.message", { body: "forged hub message" }],
  ]) {
    const r = await routes[route](body, stale);
    assertEquals(r.ok, false, `${route} must deny a stale model context`);
    assertEquals(r.code, "board-context-stale", `${route} denial code`);
  }
  // A trusted page surface (no model principal) still resolves to the hub.
  const page = await routes["board.post"]({ description: "owner post" }, {});
  assertEquals(page.ok, true);
  assertEquals(page.job.posterId, BOARD_HUB_ID);
});

// (P1-6) A settlement commits the result into the POSTER's thread through the
// durable thread-commit seam — idempotently (a repeated settle never
// re-commits), and only when the post carried a thread authority.
Deno.test("board routes: settlement commits the result to the poster's thread (idempotent)", async () => {
  const commits = [];
  const { routes } = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => ({ "exec-writer": "writer", "exec-critic": "critic" })[context?.executionId] ?? null,
    resolvePosterThreadId: async (context) => (context?.executionId === "exec-writer" ? "thread-1" : null),
    commitThread: async (threadId, key, terminal) => { commits.push({ threadId, key, terminal }); return {}; },
  });
  const posted = await routes["board.post"]({ description: "threaded job" }, { principal: "model", executionId: "exec-writer" });
  assertEquals(posted.ok, true);
  assertEquals(posted.job.posterThreadId, "thread-1");
  const claimed = await routes["board.claim"]({ jobId: posted.job.id }, { principal: "model", executionId: "exec-critic" });
  assertEquals(claimed.ok, true);
  assertEquals(commits.length, 0, "no commit before settlement");
  const done = await routes["board.complete"]({ jobId: posted.job.id, result: "the answer" }, { principal: "model", executionId: "exec-critic" });
  assertEquals(done.ok, true);
  assertEquals(commits.length, 1);
  assertEquals(commits[0].threadId, "thread-1");
  assertEquals(commits[0].key, `board:${posted.job.id}`);
  assertEquals(commits[0].terminal.role, "assistant");
  assertStringIncludes(commits[0].terminal.content, "the answer");
  // Idempotent: the SAME claimant's repeated settle does NOT re-commit.
  const again = await routes["board.complete"]({ jobId: posted.job.id, result: "the answer" }, { principal: "model", executionId: "exec-critic" });
  assertEquals(again.alreadySettled, true);
  assertEquals(commits.length, 1);
});

// (P1-6) A job posted without a thread authority (a bare page post) settles
// without a thread commit — the broadcast wake remains the notification.
Deno.test("board routes: a threadless post settles without a thread commit", async () => {
  const commits = [];
  const { routes } = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => (context?.executionId === "exec-critic" ? "critic" : null),
    resolvePosterThreadId: async () => null,
    commitThread: async (threadId, key, terminal) => { commits.push({ threadId, key, terminal }); return {}; },
  });
  const posted = await routes["board.post"]({ description: "page-posted job" }, {});
  assertEquals(posted.ok, true);
  assertEquals(posted.job.posterThreadId, null);
  await routes["board.claim"]({ jobId: posted.job.id }, { principal: "model", executionId: "exec-critic" });
  const done = await routes["board.complete"]({ jobId: posted.job.id, result: "done" }, { principal: "model", executionId: "exec-critic" });
  assertEquals(done.ok, true);
  assertEquals(commits.length, 0);
});

// ── review round-2 battery (P2-block: P1-1…P1-3) ────────────────────────────

// (P1-1) A FAILED or MALFORMED read must never become an empty log that the
// next write overwrites: read errors propagate, malformed logs refuse, and
// NOTHING is written.
Deno.test("board store: a failed read never becomes a destructive empty-log write", async () => {
  const writes = [];
  const memory = {
    getStrict: async () => { throw new Error("OPFS transient read failure"); },
    setTrusted: async (k, v) => { writes.push([k, v]); },
  };
  const board = createAgentBoard({ memory });
  await assertRejects(() => board.postJob({ callerId: BOARD_HUB_ID, agents: AGENTS, description: "x" }));
  await assertRejects(() => board.listJobs());
  await assertRejects(() => board.sendMessage({ callerId: BOARD_HUB_ID, agents: AGENTS, body: "x" }));
  assertEquals(writes.length, 0, "no write may follow a failed read");
});

Deno.test("board store: a malformed (non-array) log refuses without writing", async () => {
  const map = new Map([[BOARD_JOBS_KEY, { corrupted: true }]]);
  const writes = [];
  const memory = {
    getStrict: async (k) => (map.has(k) ? map.get(k) : null),
    setTrusted: async (k, v) => { writes.push([k, v]); void map.set(k, v); },
  };
  const board = createAgentBoard({ memory });
  await assertRejects(() => board.postJob({ callerId: BOARD_HUB_ID, agents: AGENTS, description: "x" }));
  assertEquals(writes.length, 0, "a corrupt authority log is never overwritten by a guess");
  assertEquals(map.get(BOARD_JOBS_KEY), { corrupted: true }, "the corrupt log is preserved for forensics");
});

// (P1-1) Only a SUCCESSFUL null read means absent — the first post works.
Deno.test("board store: an absent log (null read) still accepts the first post", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const r = await board.postJob({ callerId: BOARD_HUB_ID, agents: AGENTS, description: "first" });
  assertEquals(r.ok, true);
});

// (P1-2) Byte/count eviction leaves a compact TOMBSTONE: retry-idempotence
// (alreadySettled), the settled status, and the result survive eviction.
Deno.test("board store: evicted settled jobs leave tombstones (retry-idempotent, result readable)", async () => {
  const memory = mockMemory();
  const board = createAgentBoard({ memory });
  // Settle enough full-result jobs to force byte eviction of the oldest.
  const ids = [];
  for (let i = 0; i < 40; i += 1) {
    const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: `job ${i} ${"d".repeat(BOARD_MAX_DESCRIPTION)}` });
    if (!posted.ok) break;
    ids.push(posted.job.id);
    await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
    const settled = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: `result ${i} ${"r".repeat(BOARD_MAX_RESULT)}` });
    assertEquals(settled.ok, true, `settle ${i} must succeed`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(memory._map.get(BOARD_JOBS_KEY))).length;
  assert(bytes <= BOARD_MAX_LOG_BYTES, `jobs log ${bytes}B exceeds the budget`);
  // The OLDEST settled jobs were evicted — but their tombstones remain:
  const oldest = await board.getJob(ids[0]);
  assert(oldest, "the evicted job still reads");
  assertEquals(oldest.status, "completed");
  assertEquals(oldest.claimantId, "critic");
  assertStringIncludes(oldest.result, "result 0"); // result survives (tombstone-truncated)
  // Retry-idempotence: the claimant's repeated settle is alreadySettled,
  // NEVER board-no-job (the round-2 finding).
  const retry = await board.settleJob({ callerId: "critic", jobId: ids[0], result: "duplicate" });
  assertEquals(retry.ok, true);
  assertEquals(retry.alreadySettled, true);
  // And the guard still refuses a fresh claim on it.
  const claim = await board.claimJob({ callerId: "researcher", agents: AGENTS, jobId: ids[0] });
  assertEquals(claim.ok, false);
  assertEquals(claim.code, "board-settled");
});

// (P1-3) Settlement persists the PENDING delivery BEFORE acknowledgement; a
// transient commit failure returns a delivery error (settlement stands), and
// the caller's retry DRIVES the delivery (idempotent commit key).
Deno.test("board store: settlement persists pending delivery; a failed commit is retried by the repeated settle", async () => {
  const commits = [];
  let failCommits = true;
  const memory = mockMemory();
  const board = createAgentBoard({
    memory,
    commitThread: async (threadId, key, terminal) => {
      if (failCommits) throw new Error("transient thread-store failure");
      commits.push({ threadId, key, terminal });
      return {};
    },
  });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "threaded", posterThreadId: "thread-9" });
  assertEquals(posted.ok, true);
  await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  const first = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "the answer" });
  assertEquals(first.ok, false, "the settle is NOT acknowledged while delivery is pending");
  assertEquals(first.code, "board-delivery");
  assertEquals(commits.length, 0);
  // …but the settlement itself is durable:
  const read = await board.getJob(posted.job.id);
  assertEquals(read.status, "completed");
  assertEquals(read.delivery?.delivered, false, "the pending delivery is persisted with the settlement");
  // The retry (alreadySettled path) drives delivery:
  failCommits = false;
  const retry = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "the answer" });
  assertEquals(retry.ok, true);
  assertEquals(retry.alreadySettled, true);
  assertEquals(commits.length, 1);
  assertEquals(commits[0].key, `board:${posted.job.id}`);
  const delivered = await board.getJob(posted.job.id);
  assertEquals(delivered.delivery?.delivered, true);
  // A further retry does NOT re-commit.
  const again = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "the answer" });
  assertEquals(again.ok, true);
  assertEquals(commits.length, 1);
});

// (P1-3) The startup/periodic drain delivers pending settlements that were
// never acknowledged (SW restart between settle and commit).
Deno.test("board store: drainDeliveries delivers persisted pending deliveries", async () => {
  const commits = [];
  let failCommits = true;
  const memory = mockMemory();
  const commitThread = async (threadId, key, terminal) => {
    if (failCommits) throw new Error("down");
    commits.push({ threadId, key, terminal });
    return {};
  };
  const board = createAgentBoard({ memory, commitThread });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "crash window", posterThreadId: "thread-7" });
  await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  const first = await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "r" });
  assertEquals(first.ok, false);
  // Simulate the restart: a FRESH store over the same memory (its drain runs
  // at SW startup in production).
  failCommits = false;
  const revived = createAgentBoard({ memory, commitThread });
  const drained = await revived.drainDeliveries();
  assertEquals(drained.delivered, 1);
  assertEquals(drained.remaining, 0);
  assertEquals(commits.length, 1);
  assertEquals(commits[0].threadId, "thread-7");
});

// ── review round-3 battery (P1-1 admission reserve, P1-2 resolver fail-closed,
//    P2 drain retry shape) ───────────────────────────────────────────────────

// (P1-1) Admission accounts for the WORST-CASE pending-delivery capacity of
// EVERY open threaded job: threaded posts are refused before the log can
// wedge, and a full settle wave with ALWAYS-FAILING delivery never crosses
// the byte budget (the r2 pin keeps undelivered chains unevictable, so the
// reserve is the only thing standing between settlement and the 256 KiB wall).
Deno.test("board store: admission reserves per-threaded-job settle capacity (no wedge under failed delivery)", async () => {
  const memory = mockMemory();
  const board = createAgentBoard({
    memory,
    commitThread: async () => { throw new Error("thread store down"); },
  });
  // Threaded posts are refused EARLIER than threadless ones (the reserve):
  let threadedAccepted = 0;
  for (let i = 0; i < BOARD_MAX_OPEN_JOBS + 20; i += 1) {
    const r = await board.postJob({ callerId: "writer", agents: AGENTS, description: "z".repeat(BOARD_MAX_DESCRIPTION), posterThreadId: `thread-${i}` });
    if (!r.ok) { assertEquals(r.code, "board-full"); break; }
    threadedAccepted += 1;
  }
  const threadlessBoard = createAgentBoard({ memory: mockMemory() });
  let threadlessAccepted = 0;
  for (let i = 0; i < BOARD_MAX_OPEN_JOBS + 20; i += 1) {
    const r = await threadlessBoard.postJob({ callerId: "writer", agents: AGENTS, description: "z".repeat(BOARD_MAX_DESCRIPTION) });
    if (!r.ok) break;
    threadlessAccepted += 1;
  }
  assert(threadedAccepted > 5, `suspiciously few threaded jobs (${threadedAccepted})`);
  assert(threadedAccepted < threadlessAccepted, `the reserve must bite: threaded ${threadedAccepted} vs threadless ${threadlessAccepted}`);
  // Settle EVERY accepted threaded job with delivery failing: the log must
  // stay within budget (undelivered chains are pinned — the reserve made the
  // room) and settles must return structured board-delivery, never throw.
  const jobs = await board.listJobs();
  let deliveryDenials = 0;
  for (const job of jobs) {
    await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: job.id });
    const settled = await board.settleJob({ callerId: "critic", jobId: job.id, result: "r".repeat(BOARD_MAX_RESULT) });
    assertEquals(settled.ok, false);
    assertEquals(settled.code, "board-delivery");
    deliveryDenials += 1;
    const bytes = new TextEncoder().encode(JSON.stringify(memory._map.get(BOARD_JOBS_KEY))).length;
    assert(bytes <= BOARD_MAX_LOG_BYTES, `log wedged at ${bytes}B after ${deliveryDenials} failed-delivery settles`);
  }
  assert(deliveryDenials > 5, "the settle wave actually ran");
});

// (P1-2) Poster-thread resolution fails CLOSED: a resolver failure on a MODEL
// context is a structured store error (never a silently threadless post), and
// nothing is persisted. A non-model context may still post threadless.
Deno.test("board routes: a thread-resolver failure on a model context fails closed (no threadless post)", async () => {
  const memory = mockMemory();
  const { routes } = createAgentBoardRoutes({
    memory,
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => (context?.executionId === "exec-writer" ? "writer" : null),
    resolvePosterThreadId: async () => { throw new Error("run registry read failed"); },
  });
  const r = await routes["board.post"]({ description: "must not persist" }, { principal: "model", executionId: "exec-writer" });
  assertEquals(r.ok, false);
  assertEquals(r.code, "board-store-error");
  assertEquals((await board_listHelper(memory)).length, 0, "nothing was persisted");
  // Page contexts carry no executionId — the resolver returns null before
  // touching the registry; emulate that contract here (null, never a throw).
  const routes3 = createAgentBoardRoutes({
    memory,
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: () => null,
    resolvePosterThreadId: async (context) => (context?.executionId ? (() => { throw new Error("registry down"); })() : null),
  });
  const page = await routes3.routes["board.post"]({ description: "page post stays threadless" }, {});
  assertEquals(page.ok, true);
  assertEquals(page.job.posterThreadId, null);
});
async function board_listHelper(memory) {
  return (await createAgentBoard({ memory }).listJobs());
}

// (P1-2) The SW resolver itself must not swallow registry failures — pinned
// at source (the behavioral half is the route test above + the KAT).
Deno.test("board wiring: neither resolver catch site swallows failures", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const wiring = swSrc.match(/const boardRoutes = createAgentBoardRoutes\(\{([\s\S]*?)\}\);/)?.[1] ?? "";
  assert(!wiring.includes(".catch("), "the SW board wiring must not swallow resolver failures");
  const libSrc = await Deno.readTextFile(new URL("../extension/lib/agent-board.js", import.meta.url));
  const postRoute = libSrc.match(/"board\.post": guarded\(([\s\S]*?)\}\),/)?.[1] ?? "";
  assert(!postRoute.includes(".catch(() => null)"), "the post route must not catch resolver failures to null");
});

// (P2) The drain reports what REMAINS so the SW can schedule a bounded retry.
Deno.test("board store: drainDeliveries reports delivered + remaining for the retry scheduler", async () => {
  const memory = mockMemory();
  let failCommits = true;
  const board = createAgentBoard({
    memory,
    commitThread: async () => { if (failCommits) throw new Error("down"); return {}; },
  });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "pending", posterThreadId: "thread-r" });
  await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  await board.settleJob({ callerId: "critic", jobId: posted.job.id, result: "r" });
  const first = await board.drainDeliveries();
  assertEquals(first.delivered, 0);
  assertEquals(first.remaining, 1, "the pending delivery is reported for retry scheduling");
  failCommits = false;
  const second = await board.drainDeliveries();
  assertEquals(second.delivered, 1);
  assertEquals(second.remaining, 0);
});

// ── review round-4 battery (P1-1 blockedBy-pinned tombstone compaction,
//    P1-2 claim-churn compaction, P2 live-settle drain kick) ─────────────────

// (P1-1) A settled job an OPEN child still references in blockedBy keeps its
// full record today (prune pins it) — sustained blocked-by pressure therefore
// wedges the log past the byte budget with nothing prune can drop. The fix:
// pinned settled dependencies COMPACT INTO TOMBSTONES (the child only needs
// the completed outcome fact), and those tombstones are themselves never
// dropped while a dependent is open.
Deno.test("board prune: blockedBy-pinned settled dependencies compact to tombstones that are never dropped", async () => {
  const memory = mockMemory();
  const board = createAgentBoard({ memory });
  // 40 threadless parents settled with max-size results: pinned-full alone
  // (~40 × 6.6KB) exceeds the log budget once every parent is settled.
  const parents = [];
  for (let i = 0; i < 40; i += 1) {
    // Posts stay SMALL (the post gate refuses near the budget); the pressure
    // comes from the SETTLE events' max-size results, which pile onto the
    // pinned full records that prune refuses to compact (on the unfixed base).
    const posted = await board.postJob({ callerId: BOARD_HUB_ID, agents: AGENTS, description: "p".repeat(200) });
    assertEquals(posted.ok, true);
    await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
    await board.settleJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id, result: "r".repeat(BOARD_MAX_RESULT) });
    parents.push(posted.job.id);
  }
  // 40 open children, each blockedBy exactly one parent: ALL 40 parents are
  // pinned from this point on — BEFORE the settling pressure piles on.
  for (const parent of parents) {
    const posted = await board.postJob({ callerId: BOARD_HUB_ID, agents: AGENTS, description: "c".repeat(BOARD_MAX_DESCRIPTION), blockedBy: [parent] });
    assertEquals(posted.ok, true);
  }
  // NOW the settle wave: every settle appends a max-size result onto a
  // PINNED full record that prune must not drop on the unfixed base.
  for (const id of parents) {
    const job = await board.getJob(id);
    await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: id });
    await board.settleJob({ callerId: "critic", agents: AGENTS, jobId: id, result: "r".repeat(BOARD_MAX_RESULT) });
  }
  // Churn saves (each post/settle re-pruned) then read back through the store.
  const bytes = new TextEncoder().encode(JSON.stringify(memory._map.get(BOARD_JOBS_KEY))).length;
  assert(bytes <= BOARD_MAX_LOG_BYTES, `prune left ${bytes}B over the ${BOARD_MAX_LOG_BYTES}B budget — pinned settled dependencies must compact to tombstones`);
  // The completed outcome fact survives for every pinned dependency, and the
  // compacted tombstones are never dropped under repeated pruning.
  for (const parent of parents) {
    const job = await board.getJob(parent);
    assert(job, `pinned parent ${parent} was dropped entirely`);
    assertEquals(job.status, "completed");
  }
  // The compaction is driven by the byte gate: it compacts exactly as many
  // pinned fulls as the budget requires (the rest stay full but the log is
  // within budget). Assert compaction ENGAGED and nothing was dropped.
  const evs = memory._map.get(BOARD_JOBS_KEY) ?? [];
  const tombs = evs.filter((ev: any) => ev?.type === "settled-tombstone").length;
  assert(tombs >= 1, `compaction engaged (tombs=${tombs})`);
  assertEquals(evs.filter((ev: any) => ev?.type === "completed").length + tombs, parents.length, "no pinned dependency was dropped");
});

// (P1-2) Claim churn is bounded: superseded/expired claim generations are
// compacted — only the latest authoritative claimed generation survives (the
// fold replaces claimant + lease wholesale, exactly the heartbeat argument).
Deno.test("board prune: claim churn on one open job compacts superseded claim generations", async () => {
  const memory = mockMemory();
  let fakeNow = 1_700_000_000_000;
  const board = createAgentBoard({ memory, now: () => fakeNow });
  const posted = await board.postJob({ callerId: BOARD_HUB_ID, agents: AGENTS, description: "churn me" });
  const jobId = posted.job.id;
  // 3,000 claim -> lease-expiry cycles on ONE open job (the coordinator probe:
  // 3,000 claimed events, 389,513B — 2x the budget).
  for (let i = 0; i < 3000; i += 1) {
    fakeNow += BOARD_CLAIM_LEASE_MS + 1000; // expire the current lease
    const claimed = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId });
    assertEquals(claimed.ok, true, `cycle ${i}`);
  }
  const events = memory._map.get(BOARD_JOBS_KEY) ?? [];
  const bytes = new TextEncoder().encode(JSON.stringify(events)).length;
  assert(bytes <= BOARD_MAX_LOG_BYTES, `claim churn left ${bytes}B over the ${BOARD_MAX_LOG_BYTES}B budget`);
  const claimedCount = events.filter((ev: any) => ev?.type === "claimed").length;
  assertEquals(claimedCount, 1, "only the latest authoritative claim generation survives");
  // The job still folds to CLAIMED with the CURRENT claimant + lease.
  const job = await board.getJob(jobId);
  assertEquals(job?.status, "claimed");
  assertEquals(job?.claimantId, "critic");
  assert(Number.isFinite(job?.leaseExpiry));
});

// (P2) A live settlement that creates a pending delivery must kick the drain
// scheduler (previously only SW startup / the drain's own alarm ran it).
Deno.test("board routes: a settlement creating a pending delivery notifies the drain scheduler", async () => {
  let kicks = 0;
  const memory = mockMemory();
  const { routes } = createAgentBoardRoutes({
    memory,
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    // Model identities: writer posts (thread captured), critic claims+settles
    // — the hub cannot claim its own post (self-claim refuses).
    resolveCaller: (context) => (context?.executionId === "exec-b" ? "critic" : context?.executionId === "exec-a" ? "writer" : null),
    resolvePosterThreadId: async (context) => (context?.executionId === "exec-a" ? "thread-live" : null),
    commitThread: async () => { throw new Error("thread store down"); },
    onPendingDelivery: () => { kicks += 1; },
  });
  const modelA = { principal: "model", executionId: "exec-a" };
  const modelB = { principal: "model", executionId: "exec-b" };
  const posted = await routes["board.post"]({ description: "live settle" }, modelA);
  assertEquals(posted.ok, true);
  const job = (await routes["board.list"]({})).jobs[0];
  await routes["board.claim"]({ jobId: job.id }, modelB);
  const settled = await routes["board.complete"]({ jobId: job.id, result: "r" }, modelB);
  assertEquals(settled.code, "board-delivery");
  assert(kicks >= 1, `the drain scheduler was not kicked by the live pending delivery (kicks=${kicks})`);
});

// ── review round-5 (P2 production wiring): the delivery-drain callback must
//    be supplied by the REAL service-worker wiring — the settle routes'
//    onPendingDelivery hook is dead code if production never passes it — and
//    every drain rejection path (startup / live kick / alarm retry) must
//    schedule the next bounded alarm through ONE shared scheduler.
Deno.test("board wiring: production passes onPendingDelivery and kicks the drain loop", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const wiring = swSrc.match(/const boardRoutes = createAgentBoardRoutes\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
  assert(wiring.includes("onPendingDelivery"), "production createAgentBoardRoutes must pass onPendingDelivery — live failed deliveries otherwise never kick the drain");
  assert(/onPendingDelivery:\s*\(\)\s*=>\s*\{?\s*[^}]*kickBoardDrain\(\)/.test(wiring), "onPendingDelivery must kick the drain loop (reset + run)");
});

Deno.test("board wiring: drain rejections reschedule through one shared bounded scheduler", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // The shared scheduler exists and the rejection handler routes through it.
  assert(swSrc.includes("function scheduleBoardDrain("), "a shared scheduleBoardDrain must exist");
  const handlerRegion = swSrc.slice(swSrc.indexOf("function handleBoardDrainRejection("));
  assert(handlerRegion.includes("scheduleBoardDrain("), "the shared rejection handler must schedule the next bounded alarm");
  // Startup, alarm, and live-kick rejection paths all route through it.
  assert((swSrc.match(/\.catch\(\(e\) => handleBoardDrainRejection\(/g) ?? []).length >= 3, "startup, alarm, and live-kick rejection paths must share the scheduler");
});

// ── r5 P0 REDs: the OPTIONAL + JIT model must be REAL at runtime ────────────

// (P0-2) requestCapability must REQUEST (chrome.permissions.request) — the
// superseded contains-only model can never enable a capability.
Deno.test("capabilities: requestCapability performs a JIT permissions.request", async () => {
  const requested = [];
  const granted = new Set();
  globalThis.chrome = {
    runtime: { id: "t", getURL: (p) => "chrome-extension://t/" + p, getManifest: () => ({ permissions: [] }) },
    permissions: {
      contains: async (q) => (q?.permissions ?? []).every((p) => granted.has(p)),
      request: async (q) => { requested.push(...(q?.permissions ?? [])); (q?.permissions ?? []).forEach((p) => granted.add(p)); return true; },
    },
  };
  const { requestCapability } = await import("../extension/lib/capabilities.js");
  const res = await requestCapability("bookmarks");
  assertEquals(res.granted, true);
  assertEquals(requested.includes("bookmarks"), true, "requestCapability must call chrome.permissions.request");
});

// (P0-3) Tool denials carry the CONVERSATION contract (waitingForPermission +
// permissionRequirement) so the chat renders the inline Enable card.
Deno.test("browser tools: a missing-grant denial carries the conversation permission contract", async () => {
  globalThis.chrome = {
    runtime: { id: "t", getURL: (p) => "chrome-extension://t/" + p, getManifest: () => ({ permissions: [] }) },
    permissions: { contains: async () => false },
  };
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const tools = browserToolset(false);
  const r = await tools.list_bookmarks.execute({});
  assertEquals(r?.waitingForPermission, true, "the denial must carry waitingForPermission");
  assertEquals(r?.permissionRequirement?.permissions, ["bookmarks"], "the requirement names the exact permission");
});

// ── review round-5: capability ID uniqueness ────────────────────────────────
Deno.test("capabilities: no duplicate capability IDs", async () => {
  const { CAPABILITIES } = await import("../extension/lib/capabilities.js");
  const ids = CAPABILITIES.map((c) => c.id);
  assertEquals(new Set(ids).size, ids.length, `duplicate capability IDs: ${ids.join(", ")}`);
});

// ── CAP-FB-20260830-AGENT-BOARD-WORKING-01 — the board works end to end ─────

// (step 1) The SW resolver reads the durable registry SNAPSHOT — `list()`
// returns `{ runs }`, not an array. Every model-side post used to die here
// with "records.find is not a function" (board lane finding 1).
Deno.test("board routes: the production resolver reads durableRuns.list().runs", async () => {
  const durableRuns = { list: async () => ({ runs: [{ executionId: "exec-writer", threadId: "thread-9" }, { executionId: "exec-other", threadId: "thread-x" }] }) };
  const resolve = posterThreadResolver(durableRuns);
  assertEquals(await resolve({ executionId: "exec-writer" }), "thread-9");
  assertEquals(await resolve({ executionId: "exec-unknown" }), null);
  assertEquals(await resolve({}), null);
  const { routes } = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => (context?.executionId === "exec-writer" ? "writer" : null),
    resolvePosterThreadId: resolve,
  });
  const posted = await routes["board.post"]({ description: "a model-context post" }, { principal: "model", executionId: "exec-writer" });
  assertEquals(posted.ok, true, JSON.stringify(posted));
  assertEquals(posted.job.posterThreadId, "thread-9");
});

Deno.test("board wiring: the SW uses posterThreadResolver, wakeBoardAgent and the heartbeat plan", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const wiring = swSrc.match(/const boardRoutes = createAgentBoardRoutes\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
  assert(wiring.includes("resolvePosterThreadId: posterThreadResolver(durableRuns)"), "the SW must resolve the poster thread through the shared helper");
  assert(wiring.includes("wakeAgent: wakeBoardAgent"), "the SW must pass the wake hook");
  assert(swSrc.includes("boardHeartbeatPlan("), "the SW must heartbeat live claimants automatically");
  assert(!wiring.includes("records.find("), "the array-shaped read must not come back");
});

// (step 7) A blocked job is VISIBLY blocked: listJobs derives `blocked` from
// its unsettled blockers so every surface (sidebar, board_list, demo model)
// can tell it from an open one.
Deno.test("board store: listJobs marks unsettled blockedBy as blocked", async () => {
  const board = createAgentBoard({ memory: mockMemory() });
  const parent = await board.postJob({ callerId: "writer", agents: AGENTS, description: "parent" });
  const child = await board.postJob({ callerId: "writer", agents: AGENTS, description: "child", blockedBy: [parent.job.id] });
  let jobs = await board.listJobs();
  assertEquals(jobs.find((j) => j.id === child.job.id).blocked, true);
  assertEquals(jobs.find((j) => j.id === child.job.id).blockedByOpen, 1);
  assertEquals(jobs.find((j) => j.id === parent.job.id).blocked, false);
  await board.claimJob({ callerId: "researcher", agents: AGENTS, jobId: parent.job.id });
  await board.settleJob({ callerId: "researcher", jobId: parent.job.id, result: "done" });
  jobs = await board.listJobs();
  assertEquals(jobs.find((j) => j.id === child.job.id).blocked, false);
  assertEquals(jobs.find((j) => j.id === child.job.id).blockedByOpen, 0);
});

// (step 4) Agents can READ the board: board_read_messages forwards to
// board.messages, and the route filters a model caller to broadcast + its
// own addressed messages (the caller comes from the context, never args).
Deno.test("board tools: board_read_messages forwards to board.messages with the caller filter", async () => {
  const calls = [];
  const tools = managementToolset({ callRoute: (type, args) => { calls.push([type, args]); return { ok: true, messages: [] }; } });
  await tools.board_read_messages.execute({ limit: 5, refJobId: "job_1" });
  assertEquals(calls[0], ["board.messages", { limit: 5, refJobId: "job_1" }]);
  assertStringIncludes(tools.board_send_message.description, "board_read_messages");
  const { routes } = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => ({ "exec-writer": "writer", "exec-critic": "critic", "exec-researcher": "researcher" })[context?.executionId] ?? null,
  });
  await routes["board.message"]({ to: "broadcast", body: "to all" }, { principal: "model", executionId: "exec-writer" });
  await routes["board.message"]({ to: "critic", body: "for the critic", refJobId: "job_1" }, { principal: "model", executionId: "exec-writer" });
  await routes["board.message"]({ to: "researcher", body: "for the researcher" }, { principal: "model", executionId: "exec-writer" });
  const critic = await routes["board.messages"]({}, { principal: "model", executionId: "exec-critic" });
  assertEquals(critic.ok, true);
  assertEquals(critic.messages.map((m) => m.body).sort(), ["for the critic", "to all"]);
  const byJob = await routes["board.messages"]({ refJobId: "job_1" }, { principal: "model", executionId: "exec-critic" });
  assertEquals(byJob.messages.map((m) => m.body), ["for the critic"]);
  // The owner surface (no model principal) reads the whole feed.
  const owner = await routes["board.messages"]({}, {});
  assertEquals(owner.messages.length, 3);
  // A stale model context is denied, never widened to the whole feed.
  const stale = await routes["board.messages"]({}, { principal: "model", executionId: "exec-gone" });
  assertEquals(stale.ok, false);
  assertEquals(stale.code, "board-context-stale");
});

// (step 3) Posting WAKES the target: exactly one run for the target agent,
// none for the poster, idempotent per job, and the wake carries the job.
Deno.test("board wake: a targeted post starts exactly one run for the target and none for the poster", async () => {
  const woken = [];
  const memory = mockMemory();
  const { routes } = createAgentBoardRoutes({
    memory,
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => context?.agentId ?? null,
    wakeAgent: async ({ agentId, jobId, task }) => { woken.push({ agentId, jobId, task }); },
  });
  const posted = await routes["board.post"]({ description: "find three articles about WebMCP", targetAgent: "Researcher" }, { agentId: "writer" });
  assertEquals(posted.ok, true);
  assertEquals(posted.woke, ["researcher"]);
  assertEquals(woken.length, 1);
  assertEquals(woken[0].agentId, "researcher");
  assertEquals(woken[0].jobId, posted.job.id);
  assertStringIncludes(woken[0].task, "find three articles about WebMCP");
  assertStringIncludes(woken[0].task, posted.job.id);
  assertStringIncludes(woken[0].task, "board_claim_job");
  // A job targeted at its own poster is refused by the store; an untargeted
  // job with no capability wakes nobody; a capability wakes matching agents
  // (never the poster).
  const open = await routes["board.post"]({ description: "anyone" }, { agentId: "writer" });
  assertEquals(open.ok, true);
  assertEquals(open.woke, []);
  assertEquals(woken.length, 1);
  const skilled = await routes["board.post"]({ description: "critique this", requiredCapability: "critique" }, { agentId: "critic" });
  assertEquals(skilled.ok, true);
  assertEquals(skilled.woke, []); // no other agent advertises "critique"
  // The pure selector: skills/role/name match the capability; the poster never.
  const agents = [
    { id: "critic", name: "The Critic", skills: ["critique"] },
    { id: "writer", name: "Blog Writer", role: "writes and critiques drafts" },
    { id: "researcher", name: "Researcher" },
  ];
  assertEquals(boardWakeTargets({ posterId: "critic", requiredCapability: "critique", targetAgentId: null }, agents), ["writer"]);
  assertEquals(boardWakeTargets({ posterId: "writer", requiredCapability: "critique", targetAgentId: null }, agents), ["critic"]);
  assertEquals(boardWakeTargets({ posterId: "writer", targetAgentId: "researcher" }, agents), ["researcher"]);
  assertEquals(boardWakeTargets({ posterId: "writer", targetAgentId: "writer" }, agents), []);
  // Idempotent: a second wake for the same job is a no-op even across routes.
  const again = await routes["board.wake"]({ jobId: posted.job.id }, {});
  assertEquals(again.ok, true);
  assertEquals(again.woke, []);
  assertEquals(woken.length, 1);
  // A wake failure never fails the post (the job is on the board regardless).
  const { routes: failing } = createAgentBoardRoutes({
    memory: mockMemory(),
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: (context) => context?.agentId ?? null,
    wakeAgent: async () => { throw new Error("no provider"); },
  });
  const r = await failing["board.post"]({ description: "x", targetAgent: "researcher" }, { agentId: "writer" });
  assertEquals(r.ok, true);
  assertEquals(r.woke, []);
  assertEquals(typeof r.wakeError, "string");
});

// (step 11) The SW heartbeats a claim automatically while the claimant's run
// is live — the model never has to remember. The plan is pure: claimed jobs
// whose claimant has a live execution are heartbeated through that execution.
Deno.test("board heartbeat: claimed jobs with a live claimant run are heartbeated, others are not", () => {
  const jobs = [
    { id: "j1", status: "claimed", claimantId: "critic" },
    { id: "j2", status: "claimed", claimantId: "writer" },
    { id: "j3", status: "pending", claimantId: null },
    { id: "j4", status: "completed", claimantId: "critic" },
  ];
  const live = new Map([["exec-critic", { agentId: "critic" }], ["exec-researcher", { agentId: "researcher" }]]);
  assertEquals(boardHeartbeatPlan(jobs, live), [{ jobId: "j1", executionId: "exec-critic" }]);
  assertEquals(boardHeartbeatPlan([], live), []);
  assertEquals(boardHeartbeatPlan(jobs, new Map()), []);
});

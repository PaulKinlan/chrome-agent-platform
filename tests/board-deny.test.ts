// @ts-nocheck
// tests/board-deny.test.ts — per-edge deny rules for the shared jobs board
// (owner-controlled: "agent A may not claim jobs from agent B" / "agent A may
// not post jobs targeting agent B"). Fail-closed: a malformed rule denies.
// Defaults remain fully open (no behavior change without owner rules).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BOARD_HUB_ID,
  BOARD_MAX_DESCRIPTION,
  BOARD_DENY_RULES_KEY,
  canPostJob,
  canClaimJob,
  createAgentBoard,
  createAgentBoardRoutes,
} from "../extension/lib/agent-board.js";

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
    getStrict: async (k) => (map.has(k) ? map.get(k) : null),
    setTrusted: async (k, v) => void map.set(k, v),
    _map: map,
  };
}

// ── Guard-level deny evaluation ─────────────────────────────────────────────

Deno.test("deny rules: default is fully open (no rules = no behavior change)", () => {
  const guard = canPostJob({ callerId: "writer", agents: AGENTS, targetAgentId: "critic", denyRules: [] });
  assertEquals(guard.ok, true);
  const claim = canClaimJob({ callerId: "critic", agents: AGENTS, job: { id: "j1", posterId: "writer", status: "pending" }, denyRules: [] });
  assertEquals(claim.ok, true);
});

Deno.test("deny rules: agent denied posting jobs targeting a peer", () => {
  const rules = [{ action: "post", agentId: "writer", peerId: "critic" }];
  const denied = canPostJob({ callerId: "writer", agents: AGENTS, targetAgentId: "critic", denyRules: rules });
  assertEquals(denied.ok, false);
  assertEquals(denied.code, "board-deny-post");
  // A different target is fine
  const ok = canPostJob({ callerId: "writer", agents: AGENTS, targetAgentId: "researcher", denyRules: rules });
  assertEquals(ok.ok, true);
});

Deno.test("deny rules: agent denied claiming jobs from a peer", () => {
  const rules = [{ id: "deny_test", action: "claim", agentId: "critic", peerId: "writer" }];
  const job = { id: "j1", posterId: "writer", status: "pending" };
  const denied = canClaimJob({ callerId: "critic", agents: AGENTS, job, denyRules: rules });
  assertEquals(denied.ok, false);
  assertEquals(denied.code, "board-deny-claim");
  // A different poster is fine
  const ok = canClaimJob({ callerId: "critic", agents: AGENTS, job: { id: "j2", posterId: "researcher", status: "pending" }, denyRules: rules });
  assertEquals(ok.ok, true);
});

Deno.test("deny rules: malformed rule is fail-closed (deny)", () => {
  // Missing action
  const r1 = [{ agentId: "writer", peerId: "critic" }];
  const denied1 = canPostJob({ callerId: "writer", agents: AGENTS, targetAgentId: "critic", denyRules: r1 });
  assertEquals(denied1.ok, false, "missing action must deny");
  // Missing agentId
  const r2 = [{ action: "post", peerId: "critic" }];
  const denied2 = canPostJob({ callerId: "writer", agents: AGENTS, targetAgentId: "critic", denyRules: r2 });
  assertEquals(denied2.ok, false, "missing agentId must deny");
  // Non-string peerId
  const r3 = [{ action: "claim", agentId: "critic", peerId: 42 }];
  const denied3 = canClaimJob({ callerId: "critic", agents: AGENTS, job: { id: "j1", posterId: "writer", status: "pending" }, denyRules: r3 });
  assertEquals(denied3.ok, false, "non-string peerId must deny");
});

// ── Store-level integration: the board accepts denyRules ───────────────────

Deno.test("board store: deny rules persist in a reserved key and survive restart", async () => {
  const memory = mockMemory();
  // Seed the deny rules via setTrusted (the SW route does the same via
  // loadDenyRules + saveDenyRules). The board loads them FRESH under the
  // lock — never captured at construction time.
  const rules = [{ id: "deny_test", action: "claim", agentId: "critic", peerId: "writer" }];
  await memory.setTrusted(BOARD_DENY_RULES_KEY, rules);
  const board = createAgentBoard({ memory });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "test" });
  assertEquals(posted.ok, true);
  const denied = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  assertEquals(denied.ok, false, "deny rule blocks the claim");
  // A fresh board instance with the same memory sees the same rules.
  const revived = createAgentBoard({ memory });
  const denied2 = await revived.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  assertEquals(denied2.ok, false, "deny rules survive a restart");
});

// ── Bounded rule count ──────────────────────────────────────────────────────

Deno.test("deny rules: bounded count (200 max)", () => {
  const rules = Array.from({ length: 201 }, (_, i) => ({ action: "claim", agentId: `a${i}`, peerId: `b${i}` }));
  const denied = canClaimJob({ callerId: "critic", agents: AGENTS, job: { id: "j1", posterId: "writer", status: "pending" }, denyRules: rules });
  // 201 rules exceeds the bound — the guard must not crash
  assert(typeof denied === "object");
});

// ── Routes: owner add/remove/list deny rules ───────────────────────────────

Deno.test("board routes: owner can add and remove deny rules", async () => {
  const memory = mockMemory();
  const { routes } = createAgentBoardRoutes({
    memory,
    withLock: (fn) => fn(),
    listAgents: async () => AGENTS,
    resolveCaller: () => BOARD_HUB_ID,
  });
  const added = await routes["board.deny.add"]({ action: "claim", agentId: "critic", peerId: "writer" }, { principal: "owner-options" });
  assertEquals(added.ok, true);
  const listed = await routes["board.deny.list"]({}, { principal: "owner-options" });
  assertEquals(listed.rules.length, 1);
  const removed = await routes["board.deny.remove"]({ ruleId: listed.rules[0].id }, { principal: "owner-options" });
  assertEquals(removed.ok, true);
  const listed2 = await routes["board.deny.list"]({}, { principal: "owner-options" });
  assertEquals(listed2.rules.length, 0);
});

// ── Route-level pins: real production calls, exact denial codes ────────────

Deno.test("board deny: route-level add rule → the denied agent's post is refused via the route", async () => {
  const memory = mockMemory();
  let caller = "writer";
  const make = () => createAgentBoardRoutes({
    memory, withLock: (fn) => fn(), listAgents: async () => AGENTS,
    resolveCaller: () => caller,
  });
  // writer posts a job targeting critic — allowed (default open)
  const posted = await make().routes["board.post"]({ description: "edge case review", targetAgent: "critic" }, { principal: "model", executionId: "run-w1" });
  assertEquals(posted.ok, true);
  // Owner adds: writer may not post jobs targeting critic
  const added = await make().routes["board.deny.add"]({ action: "post", agentId: "writer", peerId: "critic" }, { principal: "owner-options" });
  assertEquals(added.ok, true);
  // writer posts again → denied with the exact code
  const denied = await make().routes["board.post"]({ description: "another", targetAgent: "critic" }, { principal: "model", executionId: "run-w2" });
  assertEquals(denied.ok, false);
  assertEquals(denied.code, "board-deny-post");
  // A non-denied edge still works: researcher may post to critic
  caller = "researcher";
  const allowed = await make().routes["board.post"]({ description: "fine", targetAgent: "critic" }, { principal: "model", executionId: "run-r1" });
  assertEquals(allowed.ok, true);
});

Deno.test("board deny: claim denied via the route, and still denied after recreating the board (fresh load)", async () => {
  const memory = mockMemory();
  let caller = "writer";
  const make = () => createAgentBoardRoutes({
    memory, withLock: (fn) => fn(), listAgents: async () => AGENTS,
    resolveCaller: () => caller,
  });
  // writer posts an open job (no target)
  const posted = await make().routes["board.post"]({ description: "open research task" }, { principal: "model", executionId: "run-w1" });
  assertEquals(posted.ok, true);
  const jobId = posted.job.id;
  // Owner adds: critic may not claim writer's jobs
  const added = await make().routes["board.deny.add"]({ action: "claim", agentId: "critic", peerId: "writer" }, { principal: "owner-options" });
  assertEquals(added.ok, true);
  // critic claims → denied with the exact code (the job EXISTS — board-no-job would prove the test wrong)
  caller = "critic";
  const claim1 = await make().routes["board.claim"]({ jobId }, { principal: "model", executionId: "run-c1" });
  assertEquals(claim1.ok, false);
  assertEquals(claim1.code, "board-deny-claim");
  // Simulate a worker restart: a brand-new routes+board against the same memory
  const claim2 = await make().routes["board.claim"]({ jobId }, { principal: "model", executionId: "run-c2" });
  assertEquals(claim2.ok, false);
  assertEquals(claim2.code, "board-deny-claim", "deny rules survive a board re-creation (fresh load, not closure)");
  // researcher (not denied) can claim the same job
  caller = "researcher";
  const claim3 = await make().routes["board.claim"]({ jobId }, { principal: "model", executionId: "run-r1" });
  assertEquals(claim3.ok, true);
});

Deno.test("board deny: corrupt stored policy fails closed everywhere and is never overwritten", async () => {
  const memory = mockMemory();
  // Bypass the trusted writer to inject corruption directly.
  memory._map.set(BOARD_DENY_RULES_KEY, "garbage-not-an-array");
  const { routes } = createAgentBoardRoutes({
    memory, withLock: (fn) => fn(), listAgents: async () => AGENTS,
    resolveCaller: () => "writer",
  });
  // Guarded board actions fail closed
  const posted = await routes["board.post"]({ description: "x" }, { principal: "model", executionId: "run-1" });
  assertEquals(posted.ok, false);
  assertEquals(posted.code, "board-store-error");
  // Management routes refuse and NEVER overwrite the corrupt value
  const listed = await routes["board.deny.list"]({}, { principal: "owner-options" });
  assertEquals(listed.ok, false);
  assertEquals(listed.code, "board-store-error");
  const added = await routes["board.deny.add"]({ action: "post", agentId: "writer", peerId: "critic" }, { principal: "owner-options" });
  assertEquals(added.ok, false);
  assertEquals(added.code, "board-store-error");
  assertEquals(memory._map.get(BOARD_DENY_RULES_KEY), "garbage-not-an-array", "corrupt policy preserved for repair, not silently replaced");
  // An ABSENT key is the correct default-open state (not corruption)
  const memory2 = mockMemory();
  const ok2 = createAgentBoardRoutes({
    memory: memory2, withLock: (fn) => fn(), listAgents: async () => AGENTS,
    resolveCaller: () => "writer",
  });
  const posted2 = await ok2.routes["board.post"]({ description: "x" }, { principal: "model", executionId: "run-2" });
  assertEquals(posted2.ok, true, "absent deny store = default open");
});

Deno.test("board deny: the 201st rule is refused with board-deny-full via the route", async () => {
  const memory = mockMemory();
  const rules = Array.from({ length: 200 }, (_, i) => ({ id: `deny_seed_${i}`, action: "claim", agentId: "critic", peerId: "writer" }));
  await memory.setTrusted(BOARD_DENY_RULES_KEY, rules);
  const { routes } = createAgentBoardRoutes({
    memory, withLock: (fn) => fn(), listAgents: async () => AGENTS,
    resolveCaller: () => BOARD_HUB_ID,
  });
  const res = await routes["board.deny.add"]({ action: "post", agentId: "writer", peerId: "critic" }, { principal: "owner-options" });
  assertEquals(res.ok, false);
  assertEquals(res.code, "board-deny-full");
  assertEquals((await memory.getStrict(BOARD_DENY_RULES_KEY)).length, 200, "the 201st rule was not written");
});

Deno.test("board deny: the denial text reaches the tool caller verbatim (not silent, not coded-only)", async () => {
  const memory = mockMemory();
  const make = (caller) => createAgentBoardRoutes({
    memory, withLock: (fn) => fn(), listAgents: async () => AGENTS,
    resolveCaller: () => caller,
  });
  await make(BOARD_HUB_ID).routes["board.deny.add"]({ action: "claim", agentId: "critic", peerId: "writer" }, { principal: "owner-options" });
  const posted = await make("writer").routes["board.post"]({ description: "open" }, { principal: "model", executionId: "run-w1" });
  const denied = await make("critic").routes["board.claim"]({ jobId: posted.job.id }, { principal: "model", executionId: "run-c1" });
  assertEquals(denied.ok, false);
  assertEquals(typeof denied.error, "string");
  assert(denied.error.includes("not allowed to claim jobs from writer"), `honest human-readable denial, got: ${denied.error}`);
});

Deno.test("board deny: deny routes require the owner-options principal (model and page callers refused)", async () => {
  const memory = mockMemory();
  const { routes } = createAgentBoardRoutes({
    memory, withLock: (fn) => fn(), listAgents: async () => AGENTS,
    resolveCaller: () => "writer",
  });
  for (const ctx of [{ principal: "model", executionId: "run-1" }, { principal: "page" }, {}]) {
    const res = await routes["board.deny.add"]({ action: "post", agentId: "writer", peerId: "critic" }, ctx);
    assertEquals(res.ok, false);
    assertEquals(res.code, "board-deny-owner-only");
  }
  assertEquals((await memory.getStrict(BOARD_DENY_RULES_KEY)) ?? [], [], "no rule was written by a non-owner");
});

Deno.test("board deny: each route is defined exactly once (no duplicate-key dead code)", async () => {
  const src = await Deno.readTextFile(new URL("../extension/lib/agent-board.js", import.meta.url));
  for (const route of ['"board.deny.add"', '"board.deny.remove"', '"board.deny.list"']) {
    const count = src.split(route).length - 1;
    assertEquals(count, 1, `${route} must be defined exactly once — duplicate object keys silently keep only the last`);
  }
});

Deno.test("board deny: Settings wiring uses the real named-agent.list route and its {agents} envelope", async () => {
  const src = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  const section = src.slice(src.indexOf("renderBoardDenyRules"));
  assert(section.includes('"named-agent.list"'), "the dropdowns use the real route name");
  assert(!section.includes('"named-agents.list"'), "the nonexistent plural route is gone");
  assert(section.includes("agents"), "the {agents} envelope is unwrapped");
});

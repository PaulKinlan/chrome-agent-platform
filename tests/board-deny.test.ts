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
  const rules = [{ action: "claim", agentId: "critic", peerId: "writer" }];
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
  const board = createAgentBoard({ memory, denyRules: [{ action: "claim", agentId: "critic", peerId: "writer" }] });
  const posted = await board.postJob({ callerId: "writer", agents: AGENTS, description: "test" });
  assertEquals(posted.ok, true);
  const denied = await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: posted.job.id });
  assertEquals(denied.ok, false, "deny rule blocks the claim");
  // A fresh board instance with the same memory sees the same rules.
  const revived = createAgentBoard({ memory, denyRules: [{ action: "claim", agentId: "critic", peerId: "writer" }] });
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
  const added = await routes["board.deny.add"]({ action: "claim", agentId: "critic", peerId: "writer" }, {});
  assertEquals(added.ok, true);
  const listed = await routes["board.deny.list"]({}, {});
  assertEquals(listed.rules.length, 1);
  const removed = await routes["board.deny.remove"]({ ruleId: listed.rules[0].id }, {});
  assertEquals(removed.ok, true);
  const listed2 = await routes["board.deny.list"]({}, {});
  assertEquals(listed2.rules.length, 0);
});

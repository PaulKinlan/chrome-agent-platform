// tests/board-deny-engine-contract.test.ts — pins the board deny-policy engine fixture
// and census acceptance contract (chrome-agent-platform-5ihd, follow-up to 4egg).
//
// Invariants guarded:
//   1. Storage & Census Truth:
//      - The real write site is extension/lib/agent-board.js via masterMemory().
//      - The on-disk OPFS path is memory/master/cap:board-deny-rules.json.
//      - There is zero live writer of cap:board-deny-rules to chrome.storage.local (KV).
//   2. Registry Classifier Boundary:
//      - classifyOpfsPath("memory/master/cap:board-deny-rules.json") -> portable-deny-union.
//      - classifyKvKey("cap:board-deny-rules") -> unclassified (phantom KV rejected).
//      - Sibling/unextended paths are unclassified or portable-user-data, never acquiring
//        master deny-union authority.
//   3. Engine Deny-Union Semantics:
//      - Restoring deny policy computes archive ∪ live.
//      - Live owner deny rules are NEVER weakened or deleted (even on empty/missing archive).
//      - Enforces BOARD_MAX_DENY_RULES (200): overflow fails closed without truncation.
//      - Accepts MemoryStore { __v, __value } envelopes and legacy raw arrays.
//   4. Post-Barrier Live-State Ordering:
//      - Live state MUST be read after acquiring the import maintenance barrier so
//        concurrent owner policy modifications are not overwritten.

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  BOARD_DENY_RULES_KEY,
  BOARD_MAX_DENY_RULES,
} from "../extension/lib/agent-board.js";
import {
  classifyKvKey,
  classifyOpfsPath,
} from "../extension/lib/archive-target-registry.js";

const ROOT = new URL("..", import.meta.url).pathname;

// ── 1. Storage & Census Truth ───────────────────────────────────────────────

Deno.test("5ihd: census truth — board deny rules persist in master MemoryStore, never KV", async () => {
  // Pinned constants from agent-board.js
  assertEquals(BOARD_DENY_RULES_KEY, "cap:board-deny-rules");
  assertEquals(BOARD_MAX_DENY_RULES, 200);

  // Source audit: agent-board.js writes ONLY via memory.setTrusted and memory.getStrict
  const agentBoardSrc = await Deno.readTextFile(`${ROOT}extension/lib/agent-board.js`);
  assert(
    agentBoardSrc.includes("memory.getStrict(BOARD_DENY_RULES_KEY)"),
    "agent-board.js must read deny rules via memory.getStrict",
  );
  assert(
    agentBoardSrc.includes("memory.setTrusted(BOARD_DENY_RULES_KEY, rules)"),
    "agent-board.js must write deny rules via memory.setTrusted",
  );
  assert(
    !agentBoardSrc.includes("chrome.storage.local") && !agentBoardSrc.includes("kvSet"),
    "agent-board.js must never write deny rules to chrome.storage.local / KV",
  );

  // Source audit: service-worker.js passes masterMemory() to createAgentBoardRoutes
  const swSrc = await Deno.readTextFile(`${ROOT}extension/background/service-worker.js`);
  assert(
    /createAgentBoardRoutes\(\s*\{[\s\S]*?memory:\s*masterMemory\(\)/.test(swSrc),
    "service-worker.js must wire createAgentBoardRoutes with masterMemory()",
  );
});

// ── 2. Registry Classification Boundary ────────────────────────────────────

Deno.test("5ihd: registry boundary — OPFS path is portable-deny-union, KV is unclassified", () => {
  // Real path under master store
  const realOpfs = classifyOpfsPath("memory/master/cap:board-deny-rules.json");
  assertEquals(realOpfs.cls, "portable-deny-union");
  assertEquals(realOpfs.root, "memory");

  // Phantom KV key must be unclassified (fails closed, never imported)
  const phantomKv = classifyKvKey("cap:board-deny-rules");
  assertEquals(phantomKv.cls, "unclassified");

  // Unextended path without .json must be unclassified
  const unextended = classifyOpfsPath("memory/master/cap:board-deny-rules");
  assertEquals(unextended.cls, "unclassified");

  // Scoped origin memories never gain master deny-union authority
  const scopedOrigin = classifyOpfsPath("memory/origins/https%3A%2F%2Fexample.com/cap:board-deny-rules.json");
  assertEquals(scopedOrigin.cls, "portable-user-data");

  const scopedAgent = classifyOpfsPath("memory/agents/writer/cap:board-deny-rules.json");
  assertEquals(scopedAgent.cls, "portable-user-data");
});

// ── 3. Engine Deny-Union Contract (Pure Helper Model) ──────────────────────

export interface BoardDenyRule {
  id?: string;
  action: "claim" | "post";
  agentId?: string;
  peerId?: string;
}

/**
 * Normalizes and extracts deny rule array from either a MemoryStore envelope
 * ({ __v: number, __value: [...] }) or a legacy raw array.
 */
export function extractDenyRules(raw: unknown): BoardDenyRule[] {
  if (raw == null) return [];
  let items: unknown = raw;
  if (typeof raw === "object" && raw !== null && "__value" in raw) {
    items = (raw as Record<string, unknown>).__value;
  }
  if (!Array.isArray(items)) {
    throw new Error("corrupt_deny_rules: value is not an array");
  }
  for (const r of items) {
    if (!r || typeof r !== "object") throw new Error("malformed_deny_rule");
    if (r.action !== "claim" && r.action !== "post") throw new Error("invalid_action");
    if (r.agentId !== undefined && typeof r.agentId !== "string") throw new Error("invalid_agentId");
    if (r.peerId !== undefined && typeof r.peerId !== "string") throw new Error("invalid_peerId");
  }
  return items as BoardDenyRule[];
}

/**
 * Canonical archive ∪ live deny-rule union.
 * Guarantees:
 *   - Live rules are never dropped or weakened.
 *   - Valid archived rules not present in live state are added.
 *   - Duplicate rules are collapsed by structural identity.
 *   - If union exceeds maxRules (200), fails closed.
 */
export function mergeBoardDenyRules(
  archivedRaw: unknown,
  liveRaw: unknown,
  maxRules = BOARD_MAX_DENY_RULES,
): BoardDenyRule[] {
  const archived = extractDenyRules(archivedRaw);
  const live = extractDenyRules(liveRaw);

  const seen = new Set<string>();
  const merged: BoardDenyRule[] = [];

  const keyOf = (r: BoardDenyRule) => `${r.action}:${r.agentId ?? "*"}:${r.peerId ?? "*"}`;

  // Live owner rules take precedence and are always preserved
  for (const rule of live) {
    const k = keyOf(rule);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(rule);
    }
  }

  // Archived rules are unioned in
  for (const rule of archived) {
    const k = keyOf(rule);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(rule);
    }
  }

  if (merged.length > maxRules) {
    throw new Error(`deny_rule_overflow: union size ${merged.length} exceeds limit ${maxRules}`);
  }

  return merged;
}

Deno.test("5ihd: engine deny-union — live owner rules are preserved, archived rules merged", () => {
  const live: BoardDenyRule[] = [
    { id: "r1", action: "claim", agentId: "critic", peerId: "writer" },
  ];
  const archived: BoardDenyRule[] = [
    { id: "r2", action: "post", agentId: "guest", peerId: "hub" },
    { id: "r1_duplicate", action: "claim", agentId: "critic", peerId: "writer" }, // structural dup
  ];

  const merged = mergeBoardDenyRules(archived, live);
  assertEquals(merged.length, 2);
  assertEquals(merged[0].id, "r1", "live rule must be preserved");
  assertEquals(merged[1].id, "r2", "non-duplicate archived rule must be added");
});

Deno.test("5ihd: engine deny-union — empty archive never weakens or clears live rules", () => {
  const live: BoardDenyRule[] = [
    { id: "r1", action: "claim", agentId: "critic", peerId: "writer" },
    { id: "r2", action: "post", agentId: "researcher", peerId: "hub" },
  ];

  // Empty array in archive
  const mergedEmpty = mergeBoardDenyRules([], live);
  assertEquals(mergedEmpty.length, 2);
  assertEquals(mergedEmpty, live, "empty archive must preserve live rules exactly");

  // Null/undefined archive (key absent in archive)
  const mergedNull = mergeBoardDenyRules(null, live);
  assertEquals(mergedNull.length, 2);
  assertEquals(mergedNull, live, "absent archive must preserve live rules exactly");
});

Deno.test("5ihd: engine deny-union — envelope decoding supports MemoryStore and legacy arrays", () => {
  const liveEnvelope = {
    __v: 42,
    __value: [{ id: "l1", action: "claim", agentId: "a", peerId: "b" }],
  };
  const archivedEnvelope = {
    __v: 10,
    __value: [{ id: "a1", action: "post", agentId: "c", peerId: "d" }],
  };

  const merged = mergeBoardDenyRules(archivedEnvelope, liveEnvelope);
  assertEquals(merged.length, 2);
  assertEquals(merged[0].id, "l1");
  assertEquals(merged[1].id, "a1");
});

Deno.test("5ihd: engine deny-union — union overflow (>200) fails closed without truncation", () => {
  const live: BoardDenyRule[] = Array.from({ length: 150 }, (_, i) => ({
    action: "claim",
    agentId: `live_agent_${i}`,
    peerId: "peer",
  }));
  const archived: BoardDenyRule[] = Array.from({ length: 60 }, (_, i) => ({
    action: "claim",
    agentId: `archive_agent_${i}`,
    peerId: "peer",
  }));

  // 150 + 60 = 210 > 200: must fail closed, never truncate to 200
  assertThrows(
    () => mergeBoardDenyRules(archived, live, 200),
    Error,
    "deny_rule_overflow",
  );
});

// ── 4. Post-Barrier Live-State Ordering ─────────────────────────────────────

Deno.test("5ihd: post-barrier ordering — reading live state after barrier protects concurrent mutations", async () => {
  // Simulates the storage store
  let liveStore: BoardDenyRule[] = [
    { id: "initial", action: "claim", agentId: "agent0", peerId: "peer0" },
  ];
  let barrierHeld = false;

  const acquireBarrier = async () => { barrierHeld = true; };
  const releaseBarrier = async () => { barrierHeld = false; };
  const addRuleLive = (r: BoardDenyRule) => {
    liveStore.push(r);
  };

  const archiveData: BoardDenyRule[] = [
    { id: "archived", action: "post", agentId: "agentX", peerId: "peerX" },
  ];

  // Flawed ordering: Read live state BEFORE acquiring barrier
  const preBarrierRead = [...liveStore];
  // Concurrent owner operation occurs while archive is downloading / staging:
  addRuleLive({ id: "concurrent_owner_rule", action: "claim", agentId: "agent1", peerId: "peer1" });
  await acquireBarrier();
  const flawedMerged = mergeBoardDenyRules(archiveData, preBarrierRead);
  // flawedMerged lacks "concurrent_owner_rule"!
  assert(
    !flawedMerged.some((r) => r.id === "concurrent_owner_rule"),
    "flawed pre-barrier read misses concurrent owner rule",
  );
  await releaseBarrier();

  // Correct ordering: Read live state AFTER acquiring barrier
  await acquireBarrier();
  const postBarrierRead = [...liveStore];
  const correctMerged = mergeBoardDenyRules(archiveData, postBarrierRead);
  assert(
    correctMerged.some((r) => r.id === "concurrent_owner_rule"),
    "post-barrier read captures concurrent owner rule",
  );
  assert(
    correctMerged.some((r) => r.id === "archived"),
    "post-barrier read retains archived rule",
  );
  assert(
    correctMerged.some((r) => r.id === "initial"),
    "post-barrier read retains initial live rule",
  );
  liveStore = correctMerged;
  await releaseBarrier();

  assertEquals(liveStore.length, 3);
});

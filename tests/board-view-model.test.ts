// board-view-model.test.ts — the pure projection behind the owner-facing jobs
// board (CAP-FB-20260831-BOARD-VISIBILITY-01). Falsification: revert the
// blocked-grouping branch in extension/lib/board-view-model.js and the
// "a blocked job groups under blocked, never open/claimed" assertion goes RED.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { partiesOf, projectBoard, statusOf } from "../extension/lib/board-view-model.js";

const job = (over: Record<string, unknown> = {}) => ({
  id: "j",
  status: "pending",
  description: "Do the thing",
  posterId: "hub",
  posterName: "Hub",
  claimantId: null,
  claimantName: null,
  blockedBy: [],
  blockedByOpen: 0,
  blocked: false,
  createdAt: 1,
  settledAt: null,
  result: null,
  ...over,
});

Deno.test("projectBoard: partitions open / claimed / blocked / settled with no overlap", () => {
  const open = job({ id: "o", status: "pending" });
  const claimed = job({ id: "c", status: "claimed", claimantId: "a1", claimantName: "Worker" });
  const blocked = job({ id: "b", status: "pending", blocked: true, blockedByOpen: 1, blockedBy: ["o"] });
  const completed = job({ id: "d", status: "completed", claimantId: "a1", result: "done", settledAt: 10 });
  const failed = job({ id: "f", status: "failed", claimantId: "a1", result: "nope", settledAt: 20 });
  const vm = projectBoard([open, claimed, blocked, completed, failed]);

  assertEquals(vm.open.map((j) => j.id), ["o"]);
  assertEquals(vm.claimed.map((j) => j.id), ["c"]);
  assertEquals(vm.blocked.map((j) => j.id), ["b"]);
  // Settled sorts most-recently-settled first (failed at 20 before completed at 10).
  assertEquals(vm.settled.map((j) => j.id), ["f", "d"]);
  assertEquals(vm.counts, { open: 1, claimed: 1, blocked: 1, settled: 2, active: 3 });
});

Deno.test("projectBoard: a CLAIMED job that is still blocked reads as blocked, not claimed", () => {
  const claimedButBlocked = job({ id: "cb", status: "claimed", claimantId: "a1", blocked: true, blockedByOpen: 2 });
  const vm = projectBoard([claimedButBlocked]);
  assertEquals(vm.blocked.map((j) => j.id), ["cb"]);
  assertEquals(vm.claimed.length, 0);
  assertEquals(vm.open.length, 0);
});

Deno.test("statusOf: every state has a text label so colour is never the only signal", () => {
  assertEquals(statusOf(job({ status: "pending" })).label, "Open");
  assertEquals(statusOf(job({ status: "claimed", claimantId: "a1" })).label, "Claimed");
  assertEquals(statusOf(job({ status: "pending", blocked: true, blockedByOpen: 1 })).label, "Blocked");
  assertEquals(statusOf(job({ status: "completed" })).label, "Completed");
  assertEquals(statusOf(job({ status: "failed" })).label, "Failed");
});

Deno.test("projectBoard: tolerates junk and an empty list (fresh profile is a clean empty board)", () => {
  const vm = projectBoard([null, undefined, 3, "x", job({ id: "ok" })] as unknown[]);
  assertEquals(vm.open.map((j) => j.id), ["ok"]);
  const empty = projectBoard(undefined);
  assertEquals(empty.counts, { open: 0, claimed: 0, blocked: 0, settled: 0, active: 0 });
});

Deno.test("partiesOf: an unclaimed active job still names its poster and reads 'unclaimed'", () => {
  const p = partiesOf(job({ posterName: "Hub", claimantId: null }));
  assertEquals(p.poster, "Hub");
  assertEquals(p.claimant, null);
  assertEquals(p.unclaimed, true);
  const q = partiesOf(job({ claimantId: "a1", claimantName: "Worker" }));
  assertEquals(q.claimant, "Worker");
  assertEquals(q.unclaimed, false);
});

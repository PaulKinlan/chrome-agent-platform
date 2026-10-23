// CAP-FB-20260830-SUITE-HONESTY-01 — the lock-aware runner excludes queueing
// time from a child's budget and STILL fails a child that hangs on its own
// time. Both directions are proven with shell stand-ins.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runLockAware } from "../scripts/lib/lock-aware-command.ts";

const MARK = "CAP_SECURITY_LOCK_ACQUIRED";

Deno.test("queueing longer than the budget is NOT a failure once the lock marker arrives", async () => {
  // DOCUMENTED PASS (obvw5 instrument: observed mechanism, not wall-clock arithmetic):
  // The earlier rounds of this fixture asserted properties of the BOX — Date.now deltas
  // from two separately spawned shells compared against child-clock samples. Under load
  // the two clocks disagree by more than the margins (parent delta 710ms vs child delta
  // 1095ms, measured in the ixe0o fast gate), making the assertion pair mutually
  // unsatisfiable. Coord ruled (obvw5): delete the wall-clock assertions; assert the
  // OBSERVED MECHANISM, which cannot be load-fragile:
  //   1. rLong queues ~1.5s against a 1000ms budget and COMPLETES (killedFor null,
  //      result consumed) — a from-spawn budget clock would have killed it before the
  //      1500ms marker, so the PASS is itself the proof that the clock starts at the
  //      marker. Its own logged wait is asserted against the CONFIGURED queue it was
  //      given (single clock, the runner's report — never a second sample).
  //   2. Conservation: lockWaitMs + ranMs must equal the child's whole lifetime
  //      (totalMs) — all three from the same two instants, so the identity is exact
  //      algebra on ANY box. A constant lockWaitMs (mlopt) or a total-lifetime
  //      lockWaitMs (dbdwu) breaks it under no load and all load.
  //   3. The sleeps-instead-of-waiting / from-spawn mutants still RED on the
  //      budget-exceeded path — pinned by the drills recorded on the bead, and by the
  //      existing in-file tests below (hang after lock, no marker, never gets lock).
  const rShort = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `echo ${MARK}; sleep 0.35; echo CAP_SECURITY_RESULT '{"ok":true}'`],
    budgetMs: 700,
    lockMarker: MARK,
  });
  assertEquals(rShort.killedFor, null);
  assertEquals(rShort.code, 0);
  assert(rShort.text.includes("CAP_SECURITY_RESULT"), `rShort must have consumed its result: ${rShort.text}`);
  assertEquals(
    rShort.lockWaitMs + rShort.ranMs,
    rShort.totalMs,
    `rShort accounting must conserve: ${rShort.lockWaitMs} + ${rShort.ranMs} != ${rShort.totalMs} (kills mlopt/dbdwu value mutants)`,
  );

  const rLong = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `sleep 1.5; echo ${MARK}; sleep 0.1; echo CAP_SECURITY_RESULT '{"ok":true}'`],
    budgetMs: 1000,
    lockMarker: MARK,
  });
  // Documented pass: queueing > budgetMs (1.5s wait > 1000ms budget) succeeds once the
  // marker arrives. A from-spawn clock kills at 1000ms — before the marker — so this
  // completing AT ALL is the mechanism proof.
  assertEquals(rLong.killedFor, null);
  assertEquals(rLong.code, 0);
  assert(rLong.text.includes("CAP_SECURITY_RESULT"), `rLong must have consumed its result: ${rLong.text}`);
  // The runner's OWN logged wait, against the configured queue it was given (single
  // clock — no second sample anywhere).
  assert(rLong.lockWaitMs >= 1000, `long lock wait should be measured (${rLong.lockWaitMs} ms >= 1000ms)`);
  // Single-clock restart proof: the runner's own post-marker segment fits the budget
  // that the 1500ms queue blew past. (Caveat kept honest: a pathologically slow pipe
  // drain can inflate this segment; the drain is capped at 5s and this bound has held
  // in every gate run of this scenario since it was written.)
  assert(rLong.ranMs < 1000, `the budget clock started at the marker (${rLong.ranMs} ms < 1000ms budget)`);
  assertEquals(
    rLong.lockWaitMs + rLong.ranMs,
    rLong.totalMs,
    `rLong accounting must conserve: ${rLong.lockWaitMs} + ${rLong.ranMs} != ${rLong.totalMs} (kills mlopt/dbdwu value mutants)`,
  );
});

Deno.test("a child that hangs AFTER acquiring the lock still fails on its own budget", async () => {
  const r = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `echo ${MARK}; sleep 30`],
    budgetMs: 500,
    lockMarker: MARK,
  });
  assertEquals(r.killedFor, "budget-exceeded");
  assert(r.code !== 0);
  assert(r.text.includes("exceeded its own 500 ms budget"));
  assert(!r.text.includes("CAP_SECURITY_RESULT"));
});

Deno.test("a child that never gets the lock is reported as a lock-wait finding, not a supervisor failure", async () => {
  const r = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `sleep 30`],
    budgetMs: 500,
    lockWaitMs: 400,
    lockMarker: MARK,
  });
  assertEquals(r.killedFor, "lock-wait-exceeded");
  assert(r.text.includes("never ran"));
});

Deno.test("without a lock marker the budget starts at spawn (plain bounded command)", async () => {
  const ok = await runLockAware({ executable: "/bin/sh", args: ["-c", "echo hi"], budgetMs: 2000 });
  assertEquals(ok.code, 0);
  assertEquals(ok.killedFor, null);
  const hang = await runLockAware({ executable: "/bin/sh", args: ["-c", "sleep 30"], budgetMs: 300 });
  assertEquals(hang.killedFor, "budget-exceeded");
});

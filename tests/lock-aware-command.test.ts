// CAP-FB-20260830-SUITE-HONESTY-01 — the lock-aware runner excludes queueing
// time from a child's budget and STILL fails a child that hangs on its own
// time. Both directions are proven with shell stand-ins.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runLockAware } from "../scripts/lib/lock-aware-command.ts";

const MARK = "CAP_SECURITY_LOCK_ACQUIRED";

Deno.test("queueing longer than the budget is NOT a failure once the lock marker arrives", async () => {
  // DOCUMENTED PASS:
  // Queueing time before the lock marker arrives is excluded from the child's budgetMs.
  // In rLong below, the child queues ~1.4s (well exceeding its 700ms budget) before emitting
  // the marker. Because the marker arrives, the budget clock starts at the marker rather
  // than at spawn, so queueing longer than the budget is NOT a failure (killedFor is null, code is 0).
  //
  // Run with two distinct queue durations to prove lockWaitMs is dynamically measured,
  // killing any constant mutant (e.g. opts.budgetMs * 2) (mlopt).
  // In rShort, the child queues ~0.4s and then does ~0.5s of real work.
  // The child measures its own elapsed segments (time-to-marker and post-marker work) via timestamps.
  // Bounds are asserted relative to measured segments with sane floors, so slow-box overhead
  // does not false-red a passing queue, while still killing:
  // - constant mutants like opts.budgetMs * 2 (mlopt) via dynamic delta tracking
  // - total-lifetime mutants (endedAt - spawnedAt) (dbdwu) which fail to exclude post-marker work.
  const rShort = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `t0=$(date +%s%3N); sleep 0.4; t1=$(date +%s%3N); echo ${MARK} $t1; sleep 0.5; t2=$(date +%s%3N); echo "CAP_TIMINGS $t0 $t1 $t2"; echo CAP_SECURITY_RESULT '{"ok":true}'`],
    budgetMs: 700,
    lockMarker: MARK,
  });
  assertEquals(rShort.killedFor, null);
  assertEquals(rShort.code, 0);

  const mShort = rShort.text.match(/CAP_TIMINGS (\d+) (\d+) (\d+)/);
  assert(mShort, `rShort must report segment timestamps: ${rShort.text}`);
  const waitShort = Number(mShort[2]) - Number(mShort[1]);
  const workShort = Number(mShort[3]) - Number(mShort[2]);
  const totalShort = rShort.lockWaitMs + rShort.ranMs;

  // Sane floors: lockWaitMs >= 300ms, ranMs >= 400ms
  assert(rShort.lockWaitMs >= 300, `short lock wait (${rShort.lockWaitMs}ms) must meet sane floor (>= 300ms)`);
  assert(rShort.ranMs >= 400, `short ranMs (${rShort.ranMs}ms) must meet sane floor (>= 400ms)`);

  // Bounds relative to measured elapsed segments:
  // lockWaitMs tracks the time-to-marker segment (waitShort) with spawn overhead:
  assert(rShort.lockWaitMs >= waitShort * 0.8, `short lock wait (${rShort.lockWaitMs}ms) tracks time-to-marker (${waitShort}ms)`);
  // ranMs tracks post-marker work segment:
  assert(rShort.ranMs >= workShort * 0.7, `short ranMs (${rShort.ranMs}ms) tracks post-marker work (${workShort}ms)`);
  // Killing dbdwu: lockWaitMs tracks only pre-marker queueing, not total lifetime (endedAt - spawnedAt).
  // Under honest execution, (rShort.lockWaitMs - waitShort) is merely spawn overhead (~100-300ms),
  // which is strictly less than the post-marker ranMs (~500ms+).
  // Under dbdwu, lockWaitMs includes ranMs, so (lockWaitMs - waitShort) >= ranMs, killing the mutant.
  assert(
    rShort.lockWaitMs - waitShort < rShort.ranMs,
    `lockWaitMs (${rShort.lockWaitMs}ms) minus waitShort (${waitShort}ms) must be less than ranMs (${rShort.ranMs}ms), killing dbdwu`,
  );

  const rLong = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `t0=$(date +%s%3N); sleep 1.4; t1=$(date +%s%3N); echo ${MARK} $t1; sleep 0.1; t2=$(date +%s%3N); echo "CAP_TIMINGS $t0 $t1 $t2"; echo CAP_SECURITY_RESULT '{"ok":true}'`],
    budgetMs: 700,
    lockMarker: MARK,
  });
  // Documented pass: queueing > budgetMs (1.4s wait > 700ms budget) succeeds once marker arrives:
  assertEquals(rLong.killedFor, null);
  assertEquals(rLong.code, 0);

  const mLong = rLong.text.match(/CAP_TIMINGS (\d+) (\d+) (\d+)/);
  assert(mLong, `rLong must report segment timestamps: ${rLong.text}`);
  const waitLong = Number(mLong[2]) - Number(mLong[1]);

  assert(rLong.lockWaitMs >= 1000, `long lock wait should be measured (${rLong.lockWaitMs} ms >= 1000ms)`);
  assert(rLong.lockWaitMs >= waitLong * 0.8, `long lock wait (${rLong.lockWaitMs}ms) tracks time-to-marker (${waitLong}ms)`);
  assert(rLong.ranMs < 700, `the budget clock started at the marker (${rLong.ranMs} ms < 700ms budget)`);
  assert(rLong.text.includes("CAP_SECURITY_RESULT"));

  // The measured difference must reflect the delta between the two sleeps (1.4s - 0.4s = 1.0s),
  // proving lockWaitMs tracks actual elapsed queue time rather than returning a constant, killing mlopt.
  const measuredWaitDelta = waitLong - waitShort;
  assert(
    rLong.lockWaitMs - rShort.lockWaitMs >= measuredWaitDelta * 0.7 && rLong.lockWaitMs - rShort.lockWaitMs >= 600,
    `lockWaitMs delta (${rLong.lockWaitMs - rShort.lockWaitMs} ms) must track actual wait delta (${measuredWaitDelta} ms), killing mlopt`,
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

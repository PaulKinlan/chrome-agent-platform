// CAP-FB-20260830-SUITE-HONESTY-01 — the lock-aware runner excludes queueing
// time from a child's budget and STILL fails a child that hangs on its own
// time. Both directions are proven with shell stand-ins.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runLockAware } from "../scripts/lib/lock-aware-command.ts";

const MARK = "CAP_SECURITY_LOCK_ACQUIRED";

Deno.test("queueing longer than the budget is NOT a failure once the lock marker arrives", async () => {
  // Run with two distinct queue durations to prove lockWaitMs is dynamically measured,
  // killing any constant mutant (e.g. opts.budgetMs * 2) (mlopt).
  // In rShort, the child queues 0.4s and then does 0.5s of real work:
  // lockWaitMs must track the ~400ms queue (< 600ms), killing any total-lifetime
  // (endedAt - spawnedAt) mutant which reports ~900ms (dbdwu).
  const rShort = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `sleep 0.4; echo ${MARK} $(date +%s); sleep 0.5; echo CAP_SECURITY_RESULT '{"ok":true}'`],
    budgetMs: 700,
    lockMarker: MARK,
  });
  assertEquals(rShort.killedFor, null);
  assertEquals(rShort.code, 0);
  assert(rShort.lockWaitMs >= 300 && rShort.lockWaitMs < 600, `short lock wait should track ~400ms (${rShort.lockWaitMs} ms)`);
  assert(rShort.ranMs >= 400 && rShort.ranMs < 700, `short ranMs should track ~500ms (${rShort.ranMs} ms)`);

  const rLong = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `sleep 1.4; echo ${MARK} $(date +%s); sleep 0.1; echo CAP_SECURITY_RESULT '{"ok":true}'`],
    budgetMs: 700,
    lockMarker: MARK,
  });
  assertEquals(rLong.killedFor, null);
  assertEquals(rLong.code, 0);
  assert(rLong.lockWaitMs >= 1000, `long lock wait should be measured (${rLong.lockWaitMs} ms)`);
  assert(rLong.ranMs < 700, `the budget clock started at the marker (${rLong.ranMs} ms)`);
  assert(rLong.text.includes("CAP_SECURITY_RESULT"));

  // The measured difference must reflect the delta between the two sleeps (1.4s - 0.4s = 1.0s),
  // proving lockWaitMs tracks actual elapsed queue time rather than returning a constant.
  assert(rLong.lockWaitMs - rShort.lockWaitMs >= 600, `lockWaitMs delta (${rLong.lockWaitMs - rShort.lockWaitMs} ms) must track actual wait`);
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

// CAP-FB-20260830-SUITE-HONESTY-01 — the lock-aware runner excludes queueing
// time from a child's budget and STILL fails a child that hangs on its own
// time. Both directions are proven with shell stand-ins.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runLockAware } from "../scripts/lib/lock-aware-command.ts";

const MARK = "CAP_SECURITY_LOCK_ACQUIRED";

Deno.test("queueing longer than the budget is NOT a failure once the lock marker arrives", async () => {
  // Pretends to queue 1.2 s for the lock, then does 0.1 s of real work.
  const r = await runLockAware({
    executable: "/bin/sh",
    args: ["-c", `sleep 1.2; echo ${MARK} $(date +%s); sleep 0.1; echo CAP_SECURITY_RESULT '{"ok":true}'`],
    budgetMs: 700,
    lockMarker: MARK,
  });
  assertEquals(r.killedFor, null);
  assertEquals(r.code, 0);
  assert(r.lockWaitMs >= 1000, `lock wait should be measured (${r.lockWaitMs} ms)`);
  assert(r.ranMs < 700, `the budget clock started at the marker (${r.ranMs} ms)`);
  assert(r.text.includes("CAP_SECURITY_RESULT"));
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

// tests/bounded-child.test.ts — chrome-agent-platform-i8qn (fnmr follow-up).
//
// The named-HUNG path must be an AUTOMATED case, not a manual drive: a property
// verified by hand is verified once (ril defect 2). This file drives
// scripts/lib/bounded-child.mjs against a tiny futex-wait script and asserts the
// error NAMES the child — pid, state, threads and wchan present — rather than
// merely "it threw".
//
// Two lessons from today are built in:
//   - ovfm.4: assert the SPECIFIC sentence. A general match can pass for the
//     wrong reason (a two-guard suite became untestable once).
//   - 4ctv: report per-sample ok/err and keep a stopwatch on the assertion. A
//     script that fails to START must not masquerade as a fast, successful bound.
//   - A missing command is FAILED TO START, never HUNG: naming a start failure
//     as a hang is the wrong-cause error this helper exists to prevent.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runBoundedChild } from "../scripts/lib/bounded-child.mjs";

const FUTEX_WAIT = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);";
const TIMEOUT_MS = 2_000;

type Sample = { ok: boolean; ms: number; status?: number; message?: string };

/** One probe, recorded as a sample so a fast failure cannot read as a pass. */
async function sample(command: string, args: string[] = [], timeoutMs = TIMEOUT_MS): Promise<Sample> {
  const started = Date.now();
  try {
    const r = await runBoundedChild(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      label: "futex probe",
    });
    return { ok: true, ms: Date.now() - started, status: r.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, message: (e as Error).message };
  }
}

Deno.test("bounded child: a futex-waiting child is killed, and the error NAMES it (i8qn/fnmr)", async () => {
  const s = await sample("node", ["-e", FUTEX_WAIT]);
  const report = JSON.stringify(s);
  assert(!s.ok, `a futex-waiting child must raise the named error; sample=${report}`);
  const m = /^futex probe HUNG: no exit within 2s \(pid=(\d+) state=(\S+) threads=(\d+) wchan=(\S+)\); its process group was killed\. This is a hang, not slow work — chrome-agent-platform-fnmr\.$/
    .exec(s.message ?? "");
  assert(m, `the SPECIFIC named sentence with pid/state/threads/wchan must be present; sample=${report}`);
  const [, pid, state, threads, wchan] = m;
  assert(Number(pid) > 0, `pid must be sampled from the live child; sample=${report}`);
  assert(state === "S", `state must be the live child's (S), got ${state}; sample=${report}`);
  assert(Number(threads) > 0, `threads must be sampled, got ${threads}; sample=${report}`);
  assert(/futex/.test(wchan), `wchan must show the futex wait, got ${wchan}; sample=${report}`);
  // The stopwatch is part of the assertion: a child that failed to start would
  // raise in milliseconds, so the bound must actually have elapsed.
  assert(s.ms >= TIMEOUT_MS - 250, `the bound must elapse (>= ${TIMEOUT_MS - 250}ms), got ${s.ms}ms; sample=${report}`);
  assert(s.ms < TIMEOUT_MS + 10_000, `the bound must fire promptly, got ${s.ms}ms; sample=${report}`);
});

Deno.test("bounded child: a fast, successful child raises nothing", async () => {
  const s = await sample("node", ["-e", "process.exit(0)"]);
  assert(s.ok, `a fast successful child must not throw; sample=${JSON.stringify(s)}`);
  assertEquals(s.status, 0, `a fast successful child must exit 0; sample=${JSON.stringify(s)}`);
  assert(s.ms < TIMEOUT_MS, `and it must finish inside the bound; sample=${JSON.stringify(s)}`);
});

Deno.test("bounded child: a command that cannot start is FAILED TO START, never HUNG (4ctv)", async () => {
  const s = await sample("definitely-not-a-command-i8qn", []);
  const report = JSON.stringify(s);
  assert(!s.ok, `a missing command must throw; sample=${report}`);
  assert(/FAILED TO START/.test(s.message ?? ""), `the error must name the start failure; sample=${report}`);
  assert(!/HUNG/.test(s.message ?? ""), `a start failure must never be reported as a hang; sample=${report}`);
  // PROMPTNESS IS PART OF THE CLAIM (astra's survivor mutation delayed spawnError
  // by timeoutMs + 100 and passed): a child that never started must be reported
  // BEFORE the hang bound would have fired, not at or after it. The stopwatch is
  // the assertion, exactly as for the futex case above.
  assert(s.ms < TIMEOUT_MS, `a start failure must report before the bound fires (got ${s.ms}ms, bound ${TIMEOUT_MS}ms); sample=${report}`);
});

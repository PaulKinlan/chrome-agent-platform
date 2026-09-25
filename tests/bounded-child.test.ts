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
//
// fnmr review (2026-09-25): a sentence that CLAIMS an effect is not the effect. The
// durable record is asserted by reading the file the message names: for a child the
// diagnostic signal kills, for one that outlives it, and for a record that cannot be
// written. A probe's record directory is kept on failure, as evidence.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBoundedChild } from "../scripts/lib/bounded-child.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const FUTEX_WAIT = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);";
// The same wait with a SIGUSR2 listener installed: the signal no longer terminates the child, and the
// listener cannot run while the main thread is blocked, so the child lives until the kill that follows
// the grace window.
const STUBBORN_FUTEX_WAIT = `process.on("SIGUSR2", () => {}); ${FUTEX_WAIT}`;
const TIMEOUT_MS = 2_000;

type Sample = { ok: boolean; ms: number; status?: number; message?: string };

/** One probe, recorded as a sample so a fast failure cannot read as a pass. */
async function sample(
  command: string,
  args: string[] = [],
  { timeoutMs = TIMEOUT_MS, recordDir }: { timeoutMs?: number; recordDir?: string } = {},
): Promise<Sample> {
  const started = Date.now();
  try {
    const r = await runBoundedChild(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs,
      label: "futex probe",
      recordDir,
    });
    return { ok: true, ms: Date.now() - started, status: r.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, message: (e as Error).message };
  }
}

/** A fresh record directory for ONE probe, on the durable root (never RAM-backed scratch), so a
 *  record read back from it can only be that probe's. */
function freshRecordDir(): string {
  return durableDir("bounded-child-test", crypto.randomUUID());
}

/** The JSON lines appended to <dir>/hangs.jsonl, or [] when the file does not exist. */
function records(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "hangs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

Deno.test("bounded child: a futex-waiting child is killed, and the error NAMES it (i8qn/fnmr)", async () => {
  const recordDir = freshRecordDir();
  const s = await sample("node", ["-e", FUTEX_WAIT], { recordDir });
  const report = JSON.stringify(s);
  assert(!s.ok, `a futex-waiting child must raise the named error; sample=${report}`);
  const m = /^futex probe HUNG: no exit within 2s \(pid=(\d+) state=(\S+) threads=(\d+) wchan=(\S+) thread-wchan\[(.+)\]\); its process group was killed\. This is a hang, not slow work — chrome-agent-platform-fnmr\. (.*) A durable record was appended to (\S+)\.$/
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
  // A FNM R HANG CANNOT WRITE A SIGNAL REPORT, so the thread table is the evidence (measured: a child
  // blocked in Atomics.wait is TERMINATED by SIGUSR2 with no report, while an epoll-idle child writes
  // a full one). Per-thread wchan shows which threads are in the futex, which the process-wide field
  // cannot. The trailing clause must say a report is missing rather than promise one.
  const threadTable = m[5];
  assert(/:futex_do_wait/.test(threadTable), `the thread table must show the futex wait, got ${threadTable}; sample=${report}`);
  assert(m[6].includes("No diagnostic report was produced"), `the message must say no report came, got: ${m[6]}`);
  assert(/futex|thread-wchan/.test(m[6]), `and it must point at the thread table instead, got: ${m[6]}`);
  // THE RECORD IS A FILE, NOT A SENTENCE (fnmr review). This child has no SIGUSR2 listener, so the
  // diagnostic signal ends it inside the grace window: exactly the case where the old code cancelled
  // the write and printed the sentence anyway. Read the file the message names.
  assert(m[6].includes("the child ended on SIGUSR2"), `the message must say how the child ended, got: ${m[6]}`);
  assertEquals(m[7], join(recordDir, "hangs.jsonl"), `the message must name this probe's record file; sample=${report}`);
  const rows = records(recordDir);
  assertEquals(rows.length, 1, `exactly one record must be on disk, got ${rows.length}; sample=${report}`);
  assertEquals(rows[0].label, "futex probe");
  assertEquals(rows[0].endedBy, "SIGUSR2", `the diagnostic signal ended this child; record=${JSON.stringify(rows[0])}`);
  assertEquals(rows[0].report, "none");
  assert(
    String(rows[0].snapshot).startsWith(`pid=${pid} state=${state} `),
    `the record must carry the live snapshot the message names; record=${JSON.stringify(rows[0])}`,
  );
  // The default record file is shared by every lane on the box, so the record says which checkout hung.
  assertEquals(rows[0].cwd, Deno.cwd(), `the record must say which checkout hung; record=${JSON.stringify(rows[0])}`);
  rmSync(recordDir, { recursive: true, force: true });
});

Deno.test("bounded child: a child that survives the diagnostic signal is killed after the grace window, and its record is written (fnmr)", async () => {
  const recordDir = freshRecordDir();
  const s = await sample("node", ["-e", STUBBORN_FUTEX_WAIT], { recordDir });
  const report = JSON.stringify(s);
  assert(!s.ok, `a child that ignores SIGUSR2 must still raise the named error; sample=${report}`);
  assert(/^futex probe HUNG: no exit within 2s /.test(s.message ?? ""), `the error must name the hang; sample=${report}`);
  const file = /A durable record was appended to (\S+)\.$/.exec(s.message ?? "")?.[1];
  assertEquals(file, join(recordDir, "hangs.jsonl"), `the message must name this probe's record file; sample=${report}`);
  const rows = records(recordDir);
  assertEquals(rows.length, 1, `exactly one record must be on disk, got ${rows.length}; sample=${report}`);
  // The other branch: this child outlives the signal, so the kill after the grace window ends it.
  assertEquals(rows[0].endedBy, "SIGKILL", `the kill after the grace window ended this child; record=${JSON.stringify(rows[0])}`);
  assert((s.message ?? "").includes("the child ended on SIGKILL"), `the message must say how the child ended; sample=${report}`);
  assert(s.ms >= TIMEOUT_MS - 250, `the bound must elapse (>= ${TIMEOUT_MS - 250}ms), got ${s.ms}ms; sample=${report}`);
  rmSync(recordDir, { recursive: true, force: true });
});

Deno.test("bounded child: when the record cannot be written, the message says so instead of claiming it (fnmr)", async () => {
  const scratch = freshRecordDir();
  // A regular file where the record directory's parent should be: the mkdir fails, so no record
  // can exist, and the message must say that rather than name a file.
  writeFileSync(join(scratch, "blocker"), "");
  const recordDir = join(scratch, "blocker", "records");
  const s = await sample("node", ["-e", FUTEX_WAIT], { timeoutMs: 1_000, recordDir });
  const report = JSON.stringify(s);
  assert(!s.ok, `the hang must still raise the named error; sample=${report}`);
  assert(/^futex probe HUNG: /.test(s.message ?? ""), `the error must still name the hang; sample=${report}`);
  assert(/No durable record was written \(.+\)\.$/.test(s.message ?? ""), `the message must say no record was written, and why; sample=${report}`);
  assert(!(s.message ?? "").includes("A durable record was appended"), `the message must not claim a record it did not write; sample=${report}`);
  assert(!existsSync(join(recordDir, "hangs.jsonl")), `and no record may exist; sample=${report}`);
  rmSync(scratch, { recursive: true, force: true });
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

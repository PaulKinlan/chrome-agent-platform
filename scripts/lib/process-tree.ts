// scripts/lib/process-tree.ts — kill a spawned process AND its whole tree.
// The journeys suite learned this the hard way: killing only the Chromium
// parent leaves orphaned children running (they keep the profile dir alive
// and recreate files after it is removed). chrome-journeys.ts carries its own
// copy with suite-specific hard-fail wiring; this is the shared helper for
// live scripts (CAP-FB-20260902-LIVE-SCRIPT-CLEANUP-01, chrome-agent-platform-2ypf).

const PKILL = "/usr/bin/pkill";
const PGREP = "/usr/bin/pgrep";
const PS = "/bin/ps";
const PERL = "/usr/bin/perl";
/** Upper bound for one `ps` probe, in seconds: a wedged ps must not hang a teardown. */
const PS_TIMEOUT_SECONDS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HAS_PROC = (() => {
  try { return Deno.statSync("/proc").isDirectory; } catch { return false; }
})();

const HAS_SETSID = (() => {
  try { return Deno.statSync("/usr/bin/setsid").isFile; } catch { return false; }
})();

/**
 * Build a command + args pair that launches `binary` as a new session and
 * process-group leader (`pgid === sid === pid`) in-place via `exec`. Uses
 * `/usr/bin/setsid` when present (Linux) and `/usr/bin/perl -MPOSIX` when
 * `/usr/bin/setsid` is absent (macOS).
 */
export function setsidSpawnSpec(binary: string, args: string[]): { command: string; args: string[] } {
  if (HAS_SETSID) {
    return { command: "/usr/bin/setsid", args: [binary, ...args] };
  }
  return {
    command: "/usr/bin/perl",
    args: [
      "-MPOSIX",
      "-e",
      "POSIX::setsid() >= 0 or die $!; exec {$ARGV[0]} @ARGV; POSIX::_exit(127)",
      "--",
      binary,
      ...args,
    ],
  };
}

/**
 * Build a command + args pair that runs `command` with a hard wall-clock bound:
 * the KERNEL ends it with SIGALRM after `seconds` (perl arms `alarm` and then
 * `exec`s the command in place; a pending alarm survives `exec`). A wedged
 * process-table probe therefore ends as `signal: "SIGALRM"` instead of hanging
 * a teardown forever. A missing binary exits 127.
 */
export function boundedCommandSpec(
  seconds: number,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return {
    command: PERL,
    args: [
      "-e",
      "alarm shift; exec { $ARGV[0] } @ARGV; exit 127",
      "--",
      String(Math.max(1, Math.ceil(seconds))),
      command,
      ...args,
    ],
  };
}

/** One decoded `ps` run. `signal` is non-null when ps was killed by a signal; a
 *  probe that outlived its bound ends as "SIGALRM" (see boundedCommandSpec). */
export interface PsOutput {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Test/diagnostic seam for the macOS `/bin/ps` fallbacks (bead
 * chrome-agent-platform-jjsz). Both fields default to today's behaviour, so the
 * Linux `/proc` paths are untouched; tests inject them to drive the macOS
 * branch (and its failure modes) on any host.
 */
export interface ProcessTableDeps {
  /** Treat `/proc` as present (true) or absent (false). Default: whether this host has it. */
  hasProc?: boolean;
  /** Run `/bin/ps` with `args`. May throw (spawn failure). Default: bounded, `clearEnv` run. */
  ps?: (args: string[]) => PsOutput;
  /** Read `/proc/${pid}/stat`. Default: Deno.readTextFileSync(`/proc/${pid}/stat`). Injected for Linux proc-reading tests. */
  readProcStat?: (pid: number) => string;
}

export interface ProcessGroupInfo {
  group: number;
  state: string;
  startTicks: string;
}

/**
 * Run `command args` to completion under a KERNEL-enforced wall-clock bound and a cleared
 * environment, and report how it ended. This is the default `ps` runner (`runPs`): `ps` always
 * runs under `clearEnv: true` (a C locale parses the same on every host, and no PATH/LD_*
 * tricks reach a cleanup path) and a wedged probe ends as `signal: "SIGALRM"` instead of
 * hanging a teardown. Exported so the real runner, not only its command-line builder
 * (`boundedCommandSpec`), can be driven by a test. May throw on a spawn failure.
 */
export function runBoundedProbe(command: string, args: string[], seconds: number = PS_TIMEOUT_SECONDS): PsOutput {
  const spec = boundedCommandSpec(seconds, command, args);
  const out = new Deno.Command(spec.command, {
    args: spec.args,
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
  }).outputSync();
  const decode = new TextDecoder();
  return { code: out.code, signal: out.signal, stdout: decode.decode(out.stdout), stderr: decode.decode(out.stderr) };
}

const runPs = (args: string[]): PsOutput => runBoundedProbe(PS, args);

const probeFailure = (detail: string) => new Error(`process table probe failed: ${detail} — cannot confirm process state`);

function clip(text: string, max = 160): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Run one ps probe and return its output ONLY when it ran to completion with an
 * accepted exit status and a silent stderr. A spawn error, a signal kill (incl.
 * the timeout), any other exit status or any stderr text THROWS: the process
 * table could not be read, and "could not read" must never be mistaken for
 * "nothing there".
 */
function runProbe(deps: ProcessTableDeps, args: string[], accepted: readonly number[]): PsOutput {
  const label = `ps ${args.join(" ")}`;
  let out: PsOutput;
  try {
    out = (deps.ps ?? runPs)(args);
  } catch (e) {
    throw probeFailure(`${label} could not run (${clip(String((e as Error)?.message ?? e))})`);
  }
  if (out.signal) {
    throw probeFailure(
      `${label} ${out.signal === "SIGALRM" ? `timed out after ${PS_TIMEOUT_SECONDS}s` : `was killed by ${out.signal}`}`,
    );
  }
  if (!accepted.includes(out.code)) {
    throw probeFailure(`${label} exited ${out.code}${out.stderr.trim() ? ` (${clip(out.stderr)})` : ""}`);
  }
  if (out.stderr.trim() !== "") {
    throw probeFailure(`${label} wrote to stderr (${clip(out.stderr)})`);
  }
  return out;
}

/** Linux /proc stat has a parenthesized comm (which may contain spaces or ')').
 *  Falls back to `/bin/ps` when `/proc` is absent (macOS).
 *
 *  Returns null ONLY when the process is proven absent (`/proc/<pid>` is gone, or
 *  `ps -p <pid>` exited 1 with empty stdout AND stderr). Every other failure — a
 *  spawn error, another exit status, a signal kill, stderr text, an unparsable row —
 *  THROWS, so callers fail closed instead of reading "ps failed" as "it exited"
 *  (bead chrome-agent-platform-jjsz, finding F2). */
export function processGroup(pid: number, deps: ProcessTableDeps = {}): ProcessGroupInfo | null {
  if (!(deps.hasProc ?? HAS_PROC)) {
    const out = runProbe(deps, ["-o", "pid=,pgid=,state=,lstart=", "-p", String(pid)], [0, 1]);
    const text = out.stdout.trim();
    if (out.code === 1) {
      // `ps -p <absent pid>` exits 1 with nothing on either stream. A bad argument also
      // exits 1 but explains itself on stderr (rejected above), so empty output is the proof.
      if (text === "") return null;
      throw probeFailure(`ps -p ${pid} exited 1 but printed ${JSON.stringify(clip(text, 80))}`);
    }
    const rows = text.split("\n").filter((row) => row.trim() !== "");
    if (rows.length !== 1) {
      throw probeFailure(`ps -p ${pid} printed ${rows.length} rows, expected exactly one`);
    }
    const parts = rows[0].trim().split(/\s+/);
    const group = Number(parts[1]);
    if (parts.length < 4 || Number(parts[0]) !== pid || !Number.isSafeInteger(group)) {
      throw probeFailure(`ps -p ${pid} printed an unparsable row ${JSON.stringify(clip(rows[0], 80))}`);
    }
    return {
      state: parts[2][0] ?? "?",
      group,
      startTicks: parts.slice(3).join(" "),
    };
  }
  try {
    const stat = deps.readProcStat ? deps.readProcStat(pid) : Deno.readTextFileSync(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), startTicks: fields[19] };
  } catch (e) {
    if (
      e instanceof Deno.errors.NotFound ||
      (e as any)?.code === "ESRCH" ||
      (e as any)?.osError === 3 ||
      String((e as any)?.message).includes("No such process")
    ) {
      return null;
    }
    throw e;
  }
}

// Bind a group to the exact leader observed after setsid exec, not just its PID:
// Linux may reuse a reaped leader's PID for an unrelated process group.
const leaderStartTicks = new WeakMap<Deno.ChildProcess, string>();

export function recordLeaderStartTicks(proc: Deno.ChildProcess, ticks: string): void {
  leaderStartTicks.set(proc, ticks);
}

/** Why `group` may not be signalled as `proc`'s isolated group, or null when it may.
 *  Shared by `killProcessTree` and `attachProcessLifeline`: `kill -TERM -1 1` (group 1,
 *  0 or a negative) addresses everything the caller may signal. */
function unsafeGroupReason(proc: Deno.ChildProcess, group: number): string | null {
  if (!Number.isSafeInteger(group)) return "it is not a safe integer";
  if (group <= 1) return "it must be greater than 1 (0, 1 and negatives address every process the caller may signal)";
  if (group === Deno.pid) return "it is this process's own pid";
  if (group !== proc.pid) {
    return `it is not the leader's own pid ${proc.pid} (only a group the launcher created with setsid is isolated)`;
  }
  return null;
}

// ── Crash-safe lifeline watchdog ────────────────────────────────────────────

/** Lifeline states: `armed` -> `fired` | `disarmed`, once. `unprotected`: the watcher never started. */
export type LifelineStateName = "armed" | "fired" | "disarmed" | "unprotected";

interface Lifeline {
  state: LifelineStateName;
  watcherPid: number | null;
  /** TRUE once the watcher's OWN process group has been confirmed; FALSE only when a RUNNING watcher
   *  could not be confirmed within the bound (which also warns once). It is `true` for an
   *  `unprotected` lifeline - no watcher was started at all, which the F5 warning already reports.
   *  See `attachProcessLifeline` for why this is a promise and not a fact at spawn time
   *  (bead chrome-agent-platform-6tau8). */
  ready: Promise<boolean>;
  /** The in-flight (or finished) transition out of `armed`; null while armed / unprotected. */
  settled: Promise<void> | null;
  /** FALSE once the wait on the watcher's OWN exit timed out. The transition still SETTLES - that is
   *  the point of the second bound - but it settles without proof that the watcher, and any `pkill` it
   *  had already forked, is gone. TRUE means the watcher's exit was observed inside its bound; an
   *  unsettled stdin close is reported separately and does NOT clear this (it is not a death signal)
   *  (t5o2i.2). */
  cleanupConfirmed: boolean;
  /** `killProcessTree` calls running for this proc: they own the cleanup AND its verdict. */
  teardowns: number;
  disarm: () => Promise<void>;
}

const lifelines = new WeakMap<Deno.ChildProcess, Lifeline>();

// 80yqb: a second launch in THIS process must not start while the first
// generation's profile sweep can still pkill its command line. Armed lifelines
// do not block launches; only an already-fired sweep does. The shell watcher
// still owns cleanup if this process dies, so cross-process/parent-death
// relaunches remain a separate problem (chrome-agent-platform-6n41t).
interface ProfileSweep {
  fired: boolean;
  settled: Promise<void> | null;
  /** FALSE once this lifeline's watcher EXIT went UNCONFIRMED; the entry is then kept in the registry
   *  for the rest of the process and a same-profile launch is refused (t5o2i.2). */
  confirmed: boolean;
}
const profileSweeps = new Map<string, Set<ProfileSweep>>();

/**
 * Wait for a FIRED sweep on `treeMatch` before a same-profile launch, and REFUSE the launch while any
 * lifeline for that profile ended its window without proof that its watcher is gone (t5o2i.2).
 *
 * The wait is bounded now: a sweep cannot run past `sweepTimeoutMs` plus its second bound, so this
 * cannot hang a launch. When a watcher outlived BOTH bounds (uninterruptible I/O keeps a pending
 * SIGKILL), the sweep is honestly UNCONFIRMED rather than a clean settle: it may still signal the
 * profile when it is finally scheduled, so a browser launched here could be killed by it. That is the
 * one case that refuses, and the error names the profile and the one next action.
 *
 * It waits for ANY transition out of `armed` - a fired sweep AND a disarm in flight (v8zbu/rm08r). The
 * filter keys on `settled`, not on `fired`: a disarm leaves `fired` false, and while it is in flight its
 * watcher's exit is unproven, so skipping it let a same-profile launch run straight past the very
 * quarantine this guard exists for. A merely ARMED lifeline has `settled === null` and is still never
 * awaited (the leader is alive; there is nothing to wait for).
 */
/**
 * How many sweeps on `treeMatch` ended WITHOUT proof that their watcher is gone (t5o2i.2, read by 4o93n (d)).
 *
 * An UNCONFIRMED sweep may still signal the profile when it is finally scheduled, so anything that reports
 * this profile as clean has to consult this number first.
 */
function unconfirmedSweeps(treeMatch: string): number {
  return [...(profileSweeps.get(treeMatch) ?? [])].filter((entry) => !entry.confirmed).length;
}

/**
 * Wait for every sweep on `treeMatch` that has LEFT `armed` to settle (4o93n (d)).
 *
 * This is the teardown's version of the launch guard: it makes a handle-less teardown queue behind a sweep
 * that is already running for the same profile, so the sweep's `pkill -9 -f` cannot kill the teardown's own
 * pkill/pgrep. It only WAITS - `settled` never rejects by design - and the caller decides what an unconfirmed
 * sweep means for its own claim. For a teardown the answer is "run the reap anyway, then refuse to call it
 * proven", which is why this helper does not throw.
 */
async function awaitProfileSweepSettled(treeMatch: string): Promise<void> {
  await Promise.resolve();
  const pending = [...(profileSweeps.get(treeMatch) ?? [])]
    .filter((entry) => entry.settled !== null)
    .map((entry) => entry.settled!);
  await Promise.all(pending);
}

export async function awaitFiredLifelineSweep(treeMatch: string): Promise<void> {
  // Give an already-resolved leader.status reaction a checkpoint to mark its
  // sweep before the new launch checks the registry. Never await a live leader.
  await Promise.resolve();
  const pending = [...(profileSweeps.get(treeMatch) ?? [])]
    // `settled !== null` means that lifeline has LEFT `armed` (fired, or disarming) - awaiting a disarm is
    // the point: it may end UNCONFIRMED, which the re-read below turns into a refusal.
    .filter((entry) => entry.settled !== null)
    .map((entry) => entry.settled!);
  await Promise.all(pending);
  // Re-read AFTER the wait: a sweep that was in flight above can be the one that turns unconfirmed.
  const unconfirmed = [...(profileSweeps.get(treeMatch) ?? [])].filter((entry) => !entry.confirmed).length;
  if (unconfirmed > 0) {
    throw new Error(
      `refusing to launch on profile ${JSON.stringify(clip(treeMatch, 80))}: ${unconfirmed} previous lifeline ` +
        `watcher(s) for it did not exit within their bound even after SIGKILL, so descendant cleanup is ` +
        `UNCONFIRMED and a sweep may still signal this profile; use a fresh profile for this launch`,
    );
  }
}

/** The watcher's exit status when pkill rejected the pattern (exit >= 2); the group kill already ran. */
const LIFELINE_PKILL_REJECTED = 3;

// The watcher: block on the pipe (`cat` returns only on EOF), then kill the group and
// the profile's stragglers. `$?` right after pkill is pkill's own status: 1 = nothing
// matched (fine), >= 2 = the pattern was rejected (reported, never swallowed).
export const LIFELINE_SCRIPT = 'cat >/dev/null 2>&1; ' +
  // lsk1p: the group is signalled by NUMBER, so re-check that the pid still leads the
  // group this lifeline was attached to before signalling it. `$CAP_LIFELINE_START` is the
  // leader's start time recorded at attach; the VALUE SHAPE picks the same derivation the
  // host used (all digits = Linux /proc starttime, anything else = ps lstart), so the two
  // sides always compare like with like. `same_leader` returns FALSE only when a process
  // with the leader's pid exists with a DIFFERENT start - a pid that is simply absent, an
  // unreadable /proc entry, or no recorded start at all still means "the old group, or
  // nothing", and the signal must go out (never orphan a browser to avoid a rare mis-signal).
  'same_leader() { ' +
  '[ -z "$CAP_LIFELINE_START" ] && return 0; ' +
  'case "$CAP_LIFELINE_START" in ' +
  '*[!0-9]*) cur=$(LC_ALL=C TZ=UTC /bin/ps -o lstart= -p "$CAP_LIFELINE_TARGET" 2>/dev/null | tr -s " " | sed "s/^ //; s/ $//");; ' +
  '*) cur=""; '
  + 'if [ -r "/proc/$CAP_LIFELINE_TARGET/stat" ]; then cur=$(sed "s/^[^)]*) //" "/proc/$CAP_LIFELINE_TARGET/stat" 2>/dev/null | awk "{print \\$20}"); fi;; ' +
  'esac; ' +
  '[ -n "$cur" ] || return 0; ' +
  '[ "$cur" = "$CAP_LIFELINE_START" ]; ' +
  '}; ' +
  // ymnpg (jjsz N3): the group is signalled AS A GROUP, never as a bare pid. `CAP_LIFELINE_TARGET`
  // is set only for a group the launcher VERIFIED with setsid (see the arming rule in
  // `attachProcessLifeline`), and that group always contains the leader, so the second operand added
  // nothing - while in the ~100 ms between the TERM and the KILL, and once the group's leader is gone,
  // it could signal whatever process had been handed that pid. Every member of the verified group is
  // still covered by `-<group>`; a leader that never led one is covered by the profile pkill below.
  'if [ -n "$CAP_LIFELINE_TARGET" ] && same_leader; then ' +
  'kill -TERM -"$CAP_LIFELINE_TARGET" 2>/dev/null || true; ' +
  'sleep 0.1; ' +
  'kill -KILL -"$CAP_LIFELINE_TARGET" 2>/dev/null || true; ' +
  'fi; ' +
  'if [ -n "$CAP_LIFELINE_MATCH" ]; then ' +
  '/usr/bin/pkill -9 -f "$CAP_LIFELINE_MATCH" 2>/dev/null; ' +
  `if [ "$?" -ge 2 ]; then exit ${LIFELINE_PKILL_REJECTED}; fi; ` +
  'fi; ' +
  'exit 0';

const ERE_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

/**
 * The `pkill -f` pattern the lifeline runs for `treeMatch` (bead
 * chrome-agent-platform-jjsz, finding F4): every ERE metacharacter is escaped, so
 * a caller-supplied profile path is matched LITERALLY, and the end is anchored
 * with `( |$)` so `user-data-dir=/x/p1` no longer matches `/x/p10`. Returns "" when
 * no safe pattern exists (empty, a leading "-" that pkill would parse as an option,
 * or a NUL that cannot travel in the environment): the group kill still runs.
 */
export function lifelineMatchPattern(treeMatch: string | undefined): string {
  if (!treeMatch || treeMatch.startsWith("-") || treeMatch.includes("\0")) return "";
  return treeMatch.replace(ERE_SPECIAL, "\\$&") + "( |$)";
}

export interface LifelineSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The slice of `Deno.ChildProcess` the lifeline uses on its watcher. */
export interface LifelineWatcher {
  readonly pid: number;
  readonly status: Promise<{ code: number; signal: string | null }>;
  readonly stdin: { close(): Promise<void> };
  kill(signo?: Deno.Signal): void;
}

/** Test seam for `attachProcessLifeline`; every field defaults to the production behaviour. */
export interface LifelineDeps {
  /** Start the watcher (default: `Deno.Command`, piped stdin, null stdout/stderr, cleared env). */
  spawn?: (spec: LifelineSpawnSpec) => LifelineWatcher;
  /** Where the one-line diagnostics go (default: `console.error`). */
  warn?: (line: string) => void;
  /** How long a leader-exit sweep may take before the watcher is SIGKILLed (default 5000). */
  sweepTimeoutMs?: number;
  /** The SHORT second bound on the waits that follow (the SIGKILLed watcher's exit, and the stdin
   *  close): default `LIFELINE_SETTLE_WAIT_MS` (1000). Neither overrun fails the sweep - an unsettled
   *  exit ends it UNCONFIRMED and an unsettled close is reported without that verdict (t5o2i.2). */
  settleTimeoutMs?: number;
  /** Build the pkill pattern (default `lifelineMatchPattern`). */
  matchPattern?: (treeMatch: string | undefined) => string;
  /**
   * Confirm the watcher leads its own process group (bead chrome-agent-platform-6tau8). Defaults to a
   * bounded `processGroup` poll when this module spawned the watcher, and to "confirmed" when `spawn`
   * is injected - a test that fabricates the watcher owns the process it fabricated (its pid need not
   * exist), so the default would only burn the bound and warn about a process the test invented.
   */
  confirmIsolation?: (watcherPid: number) => Promise<boolean>;
}

function spawnLifelineWatcher(spec: LifelineSpawnSpec): LifelineWatcher {
  return new Deno.Command(spec.command, {
    args: spec.args,
    stdin: "piped",
    stdout: "null",
    stderr: "null",
    clearEnv: true,
    env: spec.env,
  }).spawn();
}

async function attempt(fn: () => unknown): Promise<void> {
  try { await fn(); } catch { /* best effort: the process may already be gone */ }
}

/** The short SECOND bound on a post-timeout wait on the watcher itself (t5o2i.2). The 5 s sweep
 *  bound bounds how long the watcher may take to do its job; this bounds the wait for PROOF that the
 *  watcher has stopped, which a SIGKILL usually gives in milliseconds. */
export const LIFELINE_SETTLE_WAIT_MS = 1000;

/** TRUE only when the watcher's EXIT was OBSERVED: its `status` promise RESOLVED within `ms`. A REJECTION is
 *  not an exit - it means the exit could not be read - so it counts as FALSE, fail closed (qh5lp). Swallowing
 *  that rejection (the old `attempt(() => watcher.status)`) reported a cleanup nobody had proved and let the
 *  profile be reused while a watcher that may still sweep was alive. */
async function diedWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** TRUE when `p` settled within `ms`, FALSE when the bound expired first. Never rejects (a rejection
 *  means the wait is over, which is what is being measured). Used only for waits whose SUBJECT is the call
 *  completing (the stdin close), never for the watcher's death - see `diedWithin` for that. The loser is not
 *  cancelled: a `watcher.status` cannot be, and the caller reports the timeout instead of pretending it ended. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attach a crash-safe lifeline watchdog to `proc`. The watchdog runs in its own
 * session and reads a pipe whose write end is held exclusively by this parent
 * process.
 *
 * WHEN THE GUARANTEE IS TRUE (bead chrome-agent-platform-6tau8). The lifeline is
 * `armed` synchronously, but "the watcher survives a `SIGKILL` of this process's
 * whole process GROUP" only becomes true once the watcher leads its OWN group,
 * which the `setsid` inside its wrapper achieves a few milliseconds after spawn.
 * `lifelineState(proc).ready` is that confirmation (bounded, and it warns once if
 * the watcher never isolates); `launchChrome` awaits it before reporting a
 * protected browser, so anything that kills the group after a launch returns is
 * covered. A caller that attaches directly must await `ready` before claiming the
 * guarantee: it is not a fact at return time, and it cannot be made one, because
 * Deno exposes no spawn-time `setsid`. If this process dies for ANY reason (including `SIGKILL` or a test
 * runner killing the parent's process group), the kernel closes the pipe and the
 * watchdog immediately terminates `proc`, its isolated process group, and any
 * helper matching `treeMatch`. `killProcessTree` disarms the watchdog only AFTER
 * it has verified the group is empty; if it throws, the lifeline stays armed (a
 * parent that dies mid-teardown must still reap the browser).
 *
 * States (bead chrome-agent-platform-jjsz; `lifelineState` reports them): `armed`
 * -> `fired` | `disarmed`, exactly once, behind one guard, so the leader-exit
 * handler, `killProcessTree` and a second attach on the same proc cannot
 * double-fire or fire after a disarm. `unprotected` means the watcher could not
 * be started.
 *   - Leader exit: when `proc` itself exits (any reason) and no `killProcessTree`
 *     is running for it, the lifeline does a ONE-SHOT SWEEP: it closes the
 *     watcher's stdin WITHOUT killing the shell first, so the watcher's own kill
 *     logic is the only kill path, then waits for it (bounded; SIGKILL on
 *     overrun). Without it, a leader reaped by `proc.kill("SIGKILL"); await
 *     proc.status` (the shape of most acceptance scripts, which never call
 *     `teardownChrome`) would leave its GPU/renderer/network helpers with no
 *     watcher at all. The kernel never reuses a PGID while any member lives, and
 *     the sweep runs right after the leader is reaped. A `killProcessTree` that
 *     starts while the sweep is still running waits for it: the watcher's final
 *     `pkill -f` also matches that teardown's own pkill/pgrep command lines.
 *   - Disarm: the shell is SIGKILLed BEFORE its stdin is closed. Closing first
 *     would let it read EOF and run its kill logic on the way out.
 *
 * `group` is validated exactly like `killProcessTree` validates it (a safe
 * integer > 1 that is the leader's own pid and not this process's pid); anything
 * else THROWS, because `kill -TERM -1 1` would signal everything the caller may
 * signal. `treeMatch` runs as the end-anchored, fully escaped pattern from
 * `lifelineMatchPattern`; a pkill that still rejects it is reported by the sweep
 * (when the parent is alive to hear it) and never skips the group kill.
 *
 * If the watcher cannot be started (ENOENT for perl, EAGAIN under process
 * pressure, a restrictive --allow-run) ONE line goes to stderr saying this
 * browser is NOT protected against a killed parent, and a no-op disarm is
 * returned. Whether a launch should refuse instead is a policy call for the
 * caller.
 *
 * KNOWN RESIDUAL RISK (review finding F6; documented, not implemented). The
 * watcher signals the group by NUMBER, with no re-check that the process leading
 * it is still the leader this lifeline was attached to. A live group is always
 * the right one (no PGID is reused while a member lives); the hole is an EMPTY
 * group. It needs all of: (1) this process's event loop is wedged so the leader
 * is reaped and the sweep has not yet run, (2) every member is gone, so the pid
 * is free, (3) that exact pid is handed to a NEW process that leads a group of
 * its own (another lane's setsid child), and (4) this process is then SIGKILLed
 * inside that window; the watcher then signals the unrelated group. The
 * leader-exit sweep shrinks (1)-(3) to the event-loop latency plus the watcher's
 * shell start-up (milliseconds) — but it also means this signal path now runs
 * after EVERY leader exit, not only at parent death, and reuse inside that window
 * still needs the pid space to wrap. What would remove it: record the leader's
 * start time at attach (the `startTicks` `isolatedProcessGroup` already reads),
 * hand it to the watcher, and have the watcher skip the group signal when a
 * process with the leader's pid exists with a DIFFERENT start time (a leader that
 * is simply absent still means "the old group, or nothing").
 *
 * The watcher's isolation is CONFIRMED before a launch reports a protected browser (bead
 * chrome-agent-platform-6tau8). `lifelineState(proc).ready` resolves TRUE once the watcher
 * leads its own group, and FALSE only for a RUNNING watcher whose isolation could not be
 * confirmed within its bound (the watcher says so once, by name); `launchChrome` REFUSES on
 * FALSE inside its existing try, so the abort path tears the browser down and rethrows rather
 * than reporting a launch whose crash watchdog a SIGKILL of this process's process GROUP
 * could take with it. The remaining window is the one inside this function: the watcher is
 * isolated by the `setsid` in its own wrapper, which runs a few milliseconds AFTER
 * `Deno.Command.spawn()` returns, so a group kill inside that window still takes the watcher
 * with its parent. `ready` is what closes that window for a caller that awaits it, and it is
 * the strongest form available here because Deno exposes no spawn-time `setsid`; the
 * alternative - making this function asynchronous - would change the synchronous-arming
 * contract every caller relies on. The `unprotected` path (no watcher could be started at
 * all) still resolves TRUE on purpose: the lifeline has already reported it once, and the
 * caller's policy decision about running unprotected is deliberately unchanged.
 */
export function attachProcessLifeline(
  proc: Deno.ChildProcess,
  { group, treeMatch }: { group?: number; treeMatch?: string } = {},
  deps: LifelineDeps = {},
): () => Promise<void> {
  const target = group ?? proc.pid;
  const unsafe = unsafeGroupReason(proc, target);
  if (unsafe !== null) {
    throw new Error(`attachProcessLifeline: refusing unsafe process group ${target}: ${unsafe}`);
  }
  // ymnpg (jjsz N3): the group-signal path is armed ONLY for a group the CALLER verified - the same
  // `group` that `isolatedProcessGroup` recorded. `target = group ?? proc.pid` invented a group out of
  // the leader's own pid and signalled `-<pid>` with no evidence that pid led any group at all, which
  // is the pid-reuse class this module has been closing (lsk1p); it also made the bare-pid operand
  // look load-bearing, and that operand is gone from LIFELINE_SCRIPT. With no verified group the sweep
  // arms the profile pattern alone and says so below (never silently uncovered, and never a group
  // signal aimed at a pid nobody verified).
  const groupArmed = group !== undefined;
  const existing = lifelines.get(proc);
  if (existing) return existing.disarm;
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const sweepTimeoutMs = deps.sweepTimeoutMs ?? 5000;
  const settleTimeoutMs = deps.settleTimeoutMs ?? LIFELINE_SETTLE_WAIT_MS;
  let unconfirmedReported = false;
  let closeReported = false;
  const match = (deps.matchPattern ?? lifelineMatchPattern)(treeMatch);
  // umuyk: this object has to exist BEFORE the coverage checks, because the no-group/no-pattern case
  // below reports it as `unprotected` and returns it. Nothing else in this function depends on the
  // declaration order.
  const lifeline: Lifeline = {
    state: "unprotected",
    watcherPid: null,
    // Nothing to confirm: no watcher exists (either it could not be started, or umuyk's no-group/
    // no-pattern case below), and the warning already says this browser is NOT protected. `false` is
    // reserved for a RUNNING watcher whose isolation could not be confirmed.
    ready: Promise.resolve(true),
    settled: null,
    // TRUE: there is no watcher to wait on, so nothing about its exit can be unconfirmed (t5o2i.2).
    cleanupConfirmed: true,
    teardowns: 0,
    disarm: async () => {},
  };
  if (!groupArmed && match !== "") {
    warn(
      `process-tree: lifeline for pid ${proc.pid} has no verified process group; the sweep arms the ` +
        `profile pattern only, so the leader's tree is covered by that pattern rather than by a group signal`,
    );
  }
  // umuyk (round-2 review of ymnpg): a lifeline with NEITHER a verified group NOR a usable pattern
  // cannot reap anything. Arming a watcher here would spawn a process whose real script skips both
  // signal paths (target "" and match "") while the warnings claimed the profile pattern covered the
  // tree - a coverage claim the module cannot keep. Reported as the UNPROTECTED case instead, the same
  // way a watcher that could not be started is reported (F5): no watcher, state "unprotected", one
  // warning that names the consequence. `launchChrome` reaches this path when no profile was resolved
  // (treeMatch undefined) and `isolatedProcessGroup` returned nothing, and any rejected treeMatch
  // reaches it too. Coverage is never invented - only narrowed and named.
  if (!groupArmed && match === "") {
    // Built as its own string so the narrowing of `treeMatch` does not have to survive a nested
    // template expression (the type checker refuses to narrow it inside the interpolation).
    const detail = treeMatch
      ? ` (treeMatch ${JSON.stringify(clip(treeMatch, 80))} was rejected)`
      : " (no profile was resolved)";
    warn(
      `process-tree: lifeline for pid ${proc.pid} has neither a verified process group nor a usable ` +
        `profile pattern${detail}; ` +
        `this browser is NOT protected against a killed parent and may be orphaned`,
    );
    lifelines.set(proc, lifeline);
    return lifeline.disarm;
  }
  if (treeMatch && match === "") {
    warn(
      `process-tree: lifeline for pid ${proc.pid} cannot use treeMatch ${JSON.stringify(clip(treeMatch, 80))} ` +
        `as a kill pattern (empty, leading "-" or NUL); only its process group is covered if the parent dies`,
    );
  }
  const spec = setsidSpawnSpec("/bin/sh", ["-c", LIFELINE_SCRIPT]);
  let watcher: LifelineWatcher;
  try {
    watcher = (deps.spawn ?? spawnLifelineWatcher)({
      command: spec.command,
      args: spec.args,
      env: {
        CAP_LIFELINE_TARGET: groupArmed ? String(target) : "",
        CAP_LIFELINE_MATCH: match,
        // lsk1p: the leader's identity, so the watcher can refuse to signal a group whose
        // pid has been reused. Absent when the group was never observed ("" = no re-check).
        CAP_LIFELINE_START: leaderStartTicks.get(proc) ?? "",
      },
    });
  } catch (e) {
    warn(
      `process-tree: lifeline watcher could not be started for pid ${proc.pid} ` +
        `(${clip(String((e as Error)?.message ?? e), 160)}); ` +
        `this browser is NOT protected against a killed parent and may be orphaned`,
    );
    lifelines.set(proc, lifeline);
    return lifeline.disarm;
  }
  lifeline.state = "armed";
  lifeline.watcherPid = watcher.pid;
  const sweepEntry: ProfileSweep | null = treeMatch && match !== "" ? { fired: false, settled: null, confirmed: true } : null;
  if (sweepEntry) {
    const siblings = profileSweeps.get(treeMatch!) ?? new Set<ProfileSweep>();
    siblings.add(sweepEntry);
    profileSweeps.set(treeMatch!, siblings);
  }

  // 6tau8: the guarantee must not be a claim we cannot keep yet. The watcher is put into its own
  // session by `setsid`, which runs INSIDE its wrapper a few milliseconds after `spawn()` returns; a
  // SIGKILL of the parent's whole process GROUP inside that window takes the watcher down with the
  // parent and nothing reaps the browser (measured: 7 of 20 immediate group kills orphaned the
  // target; 20 of 20 once the watcher's own group was visible). So the watcher's group is CONFIRMED
  // here, bounded, and the confirmation is exposed as `lifelineState(proc).ready` - `launchChrome`
  // awaits it before it reports a launched, protected browser, and a caller that attaches directly
  // must await it before claiming the guarantee. It cannot be a synchronous fact: Deno exposes no
  // spawn-time setsid, so the isolation can only be observed, never asserted at spawn (the residual
  // window is inside this function until `ready` resolves).
  const confirm = deps.confirmIsolation ?? (deps.spawn ? async () => true : (pid: number) => leadsOwnGroup(pid));
  lifeline.ready = confirm(watcher.pid)
    .catch(() => false)
    .then((isolated) => {
      if (!isolated) {
        warn(
          `process-tree: lifeline watcher ${watcher.pid} for pid ${proc.pid} does not lead its own process group ` +
            `within ${LIFELINE_ISOLATION_WAIT_MS} ms; a SIGKILL of this process's process GROUP can take the ` +
            `watcher with it and orphan the browser (a kill of this process alone is still covered)`,
        );
      }
      return isolated;
    });

  // The single guard: every transition out of `armed` goes through here, and the
  // state flips synchronously, so a second trigger always sees it already spent.
  const leave = (next: "fired" | "disarmed", body: () => Promise<void>): Promise<void> => {
    lifeline.state = next;
    if (sweepEntry) sweepEntry.fired = next === "fired";
    lifeline.settled = body().catch(() => {}).finally(() => {
      // An UNCONFIRMED lifeline stays in the registry: it is the marker that refuses a same-profile
      // launch (`awaitFiredLifelineSweep`), so dropping it would be the false clean t5o2i.2 forbids.
      // One entry per unconfirmable watcher, so this does not grow with ordinary sweeps.
      if (sweepEntry && sweepEntry.confirmed) {
        const siblings = profileSweeps.get(treeMatch!);
        siblings?.delete(sweepEntry);
        if (siblings?.size === 0) profileSweeps.delete(treeMatch!);
      }
    });
    if (sweepEntry) sweepEntry.settled = lifeline.settled;
    return lifeline.settled;
  };
  // t5o2i.2: the watcher can be in uninterruptible I/O, where a pending SIGKILL is not delivered until
  // the operation finishes - so "we asked it to die" is not "it is gone". Every post-timeout wait is
  // bounded, and an overrun is REPORTED rather than left to imply that `settled` means a clean sweep.
  //
  // The deciding signal is the watcher's own EXIT (its `status`): a watcher proven gone cannot run the
  // pkill it has not reached yet. An unsettled `stdin.close` is a weaker fact - it says the close call
  // did not return, not that anything is still alive - so it is reported and judged separately, and it
  // must not quarantine a profile (a spurious refusal would be its own false verdict).
  const unconfirmed = (wait: string): void => {
    lifeline.cleanupConfirmed = false;
    if (sweepEntry) sweepEntry.confirmed = false;
    // Reported ONCE per lifeline: a second overrun in the same transition adds nothing an operator can act on.
    if (unconfirmedReported) return;
    unconfirmedReported = true;
    warn(
      `process-tree: lifeline ${lifeline.state} for pid ${proc.pid}: its ${wait} did not settle within ` +
        `${settleTimeoutMs} ms; descendant cleanup is UNCONFIRMED - the watcher (and any pkill it already ` +
        `forked) may still signal this profile` +
        (lifeline.state === "fired" ? ", so a same-profile launch is refused" : "") +
        `; use a fresh profile`,
    );
  };
  const closeUnsettled = (): void => {
    if (closeReported) return;
    closeReported = true;
    warn(
      `process-tree: lifeline ${lifeline.state} for pid ${proc.pid}: its stdin close did not settle within ` +
        `${settleTimeoutMs} ms, so whether the sweep trigger reached the watcher is unknown; the watcher's ` +
        `own exit, which is what decides cleanup, is judged separately`,
    );
  };
  // THE ONE WAY to read the watcher's status (qh5lp, zt6zw). The getter itself can THROW, and reading it directly
  // inside a body meant one throw escaped into `leave()`'s catch, which reported a settled transition with nothing
  // unconfirmed - a confirmed cleanup nobody had observed. Every path reads it through here: a throw or a rejected
  // promise both mean "the exit could not be OBSERVED", which is not the same as an exit.
  const watcherStatus = (): Promise<{ code: number; signal: string | null }> | null => {
    try {
      return watcher.status;
    } catch {
      return null;
    }
  };
  const disarmBody = async (): Promise<void> => {
    await attempt(() => watcher.kill("SIGKILL"));
    if (!(await settlesWithin(attempt(() => watcher.stdin.close()), settleTimeoutMs))) closeUnsettled();
    const status = watcherStatus();
    if (status === null || !(await diedWithin(status, settleTimeoutMs))) unconfirmed("exit after SIGKILL");
  };
  const sweepBody = async (): Promise<void> => {
    // The watcher's own trigger is EOF on its stdin: close it and do NOT kill the shell.
    const closing = attempt(() => watcher.stdin.close());
    const timedOut = Symbol("lifeline sweep timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let statusFailed = false;
    const status = watcherStatus();
    if (status === null) {
      // The getter threw: there is no exit to observe at all. Kill the watcher anyway and end UNCONFIRMED.
      await attempt(() => watcher.kill("SIGKILL"));
      unconfirmed("exit status could not be read (the watcher's status getter threw)");
      if (!(await settlesWithin(closing, settleTimeoutMs))) closeUnsettled();
      return;
    }
    try {
      const outcome = await Promise.race([
        // A REJECTION is not an exit: it is an exit we could not read, which stays UNCONFIRMED (qh5lp).
        status.then((value) => value, () => {
          statusFailed = true;
          return null;
        }),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), sweepTimeoutMs);
        }),
      ]);
      if (outcome === timedOut) {
        warn(
          `process-tree: lifeline sweep for pid ${proc.pid} did not finish within ${sweepTimeoutMs} ms; ` +
            `killing its watcher (the group may not have been fully signalled)`,
        );
        await attempt(() => watcher.kill("SIGKILL"));
        // Read it AGAIN through the accessor: a getter that starts throwing must not be a confirmed exit either.
        const afterKill = watcherStatus();
        if (afterKill === null || !(await diedWithin(afterKill, settleTimeoutMs))) unconfirmed("exit after SIGKILL");
      } else if (statusFailed) {
        unconfirmed("exit status could not be read (the watcher's status promise rejected)");
      } else if (outcome !== null && outcome.code === LIFELINE_PKILL_REJECTED) {
        warn(
          `process-tree: lifeline sweep for pid ${proc.pid}: pkill rejected the profile pattern; ` +
            `the group kill still ran, but processes outside the group that match the profile were not swept`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    if (!(await settlesWithin(closing, settleTimeoutMs))) closeUnsettled();
  };
  lifeline.disarm = () => {
    if (lifeline.state === "armed") return leave("disarmed", disarmBody);
    return lifeline.settled ?? Promise.resolve();
  };
  lifelines.set(proc, lifeline);

  const onLeaderExit = () => {
    // A running killProcessTree owns this exit: it kills, verifies, and only then disarms.
    if (lifeline.teardowns > 0) return;
    if (lifeline.state === "armed") void leave("fired", sweepBody);
  };
  proc.status.then(onLeaderExit, onLeaderExit);
  return lifeline.disarm;
}

/**
 * Diagnostics / test seam: where `proc`'s lifeline is (`armed`, `fired`,
 * `disarmed`, `unprotected`), its watcher's pid, and the promise of the
 * transition out of `armed` once one began. `undefined` when none was attached.
 */
export function lifelineState(
  proc: Deno.ChildProcess,
): {
  state: LifelineStateName;
  watcherPid: number | null;
  settled: Promise<void> | null;
  /** TRUE when the watcher was confirmed to lead its own process group; FALSE only for a running
   *  watcher that could not be confirmed. Callers must treat FALSE as isolation UNCONFIRMED. */
  ready: Promise<boolean>;
  /** FALSE when the wait on the watcher's EXIT overran its second bound: the transition settled, but
   *  without proof that the watcher is gone (t5o2i.2). An unsettled stdin close does not clear it. */
  cleanupConfirmed: boolean;
} | undefined {
  const lifeline = lifelines.get(proc);
  return lifeline &&
    {
      state: lifeline.state,
      watcherPid: lifeline.watcherPid,
      settled: lifeline.settled,
      ready: lifeline.ready,
      cleanupConfirmed: lifeline.cleanupConfirmed,
    };
}

/** The launcher waits for setsid to exec before recording the isolated group.
 *  A process table that cannot be read THROWS (it is not "exited before observation"). */
export async function isolatedProcessGroup(
  proc: Deno.ChildProcess,
  deps: ProcessTableDeps = {},
): Promise<number | undefined> {
  for (let i = 0; i < 20; i++) {
    const seen = groupObservation(proc.pid, deps);
    if (seen === "isolated") {
      leaderStartTicks.set(proc, processGroup(proc.pid, deps)!.startTicks);
      return proc.pid;
    }
    if (seen === "gone") return undefined; // exited before observation
    await sleep(25);
  }
  throw new Error(`Chrome pid ${proc.pid} did not enter its own process group; refusing group kill`);
}

/** Whether `pid` leads its own process group yet, is gone, or is still in its spawner's group. */
function groupObservation(pid: number, deps: ProcessTableDeps = {}): "isolated" | "gone" | "not-yet" {
  const stat = processGroup(pid, deps);
  if (stat?.group === pid) return "isolated";
  if (!stat || stat.state === "Z") return "gone";
  return "not-yet";
}

/** How long `attachProcessLifeline` waits for its watcher to lead its own group: 40 x 25 ms. */
const WATCHER_ISOLATION_ATTEMPTS = 40;
/** The bound in milliseconds, exported so a caller can name it in a refusal (chrome-agent-platform-6tau8). */
export const LIFELINE_ISOLATION_WAIT_MS = WATCHER_ISOLATION_ATTEMPTS * 25;

/**
 * Wait, bounded, for `pid` to LEAD its own process group - i.e. for the `setsid` inside the watcher's
 * wrapper to have run. Returns false when the process is gone or still shares our group at the bound.
 */
async function leadsOwnGroup(
  pid: number,
  deps: ProcessTableDeps = {},
  attempts = WATCHER_ISOLATION_ATTEMPTS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const seen = groupObservation(pid, deps);
    if (seen === "isolated") return true;
    if (seen === "gone") return false; // gone before it could be observed isolated
    await sleep(25);
  }
  return false;
}

/**
 * The live (non-zombie) members of process group `group`. On macOS the listing
 * must parse completely and include this very process; any ps failure THROWS
 * rather than reporting an empty group (bead chrome-agent-platform-jjsz, F2).
 */
export function liveGroupMembers(group: number, deps: ProcessTableDeps = {}): number[] {
  if (!(deps.hasProc ?? HAS_PROC)) {
    const out = runProbe(deps, ["-axo", "pid=,pgid=,state="], [0]);
    const members: number[] = [];
    let sawSelf = false;
    for (const row of out.stdout.split("\n")) {
      const line = row.trim();
      if (line === "") continue;
      const parts = line.split(/\s+/);
      const pid = Number(parts[0]);
      const pgid = Number(parts[1]);
      if (parts.length < 3 || !Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid)) {
        throw probeFailure(`ps -axo printed an unparsable row ${JSON.stringify(clip(line, 80))}`);
      }
      if (pid === Deno.pid) sawSelf = true;
      const state = parts[2][0];
      if (pgid === group && state !== "Z" && state !== "X") members.push(pid);
    }
    // This process is always in the table: its absence means the listing is not whole.
    if (!sawSelf) throw probeFailure("ps -axo listing does not include this process, so it is not complete");
    return members;
  }
  const members: number[] = [];
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const stat = processGroup(pid, deps);
    // Reparented zombies await init, and cannot run or hold a Chrome profile.
    if (stat?.group === group && stat.state !== "Z" && stat.state !== "X") members.push(pid);
  }
  return members;
}

/** What the teardown needs from a pkill/pgrep run: how it ended. */
export type SignalRun = (bin: string, args: string[]) => Promise<{ code: number }>;

async function runOut(bin: string, args: string[]) {
  // Absolute path + a cleared environment: no PATH/LD_* tricks in a cleanup path.
  return await new Deno.Command(bin, { args, stdout: "piped", stderr: "piped", clearEnv: true }).output();
}

/**
 * Kill `proc`, its isolated group when provided, and processes whose argv
 * contains `treeMatch`, then verify both group and profile have no live
 * members. `treeMatch` must NOT start with "-": pkill/pgrep would parse a
 * leading "--user-data-dir=…" as an option and exit 2. The pattern actually
 * used for pkill/pgrep is `lifelineMatchPattern(treeMatch)` - escaped and
 * end-anchored - so a teardown for `<profile>/p1` cannot signal
 * `<profile>/p10` (chrome-agent-platform-i6lgk). Throws when survivors
 * or a pgrep failure make cleanup unconfirmable — never silently fails open.
 *
 * The crash-safe lifeline (`attachProcessLifeline`) is disarmed only once the
 * group is verified empty: when this throws, it stays armed. A leader-exit sweep
 * already in flight is awaited FIRST (bounded by the sweep's own timeout): its
 * `pkill -f` matches this teardown's own pkill/pgrep command lines, so running
 * both at once let each SIGKILL the other (`pkill exited 137`).
 */
export async function killProcessTree(
  proc: Deno.ChildProcess | null,
  treeMatch: string,
  { attempts = 20, intervalMs = 250, group, deps, signal }: {
    attempts?: number;
    intervalMs?: number;
    group?: number;
    /** Process-table seam (default: this host's /proc or /bin/ps). */
    deps?: ProcessTableDeps;
    /**
     * Seam for the teardown's own pkill/pgrep (default: the bounded, `clearEnv` runner).
     * It exists so the fail-closed rule - a REJECTED pkill leaves the lifeline ARMED - stays
     * testable now that the pattern is always escaped and anchored: escaping removed the
     * pattern-injection route (`unbalanced (` ) that used to force exit 2, but a real rejection
     * (a missing pkill, a libc that refuses the ERE, a host fault) must still fail closed
     * (chrome-agent-platform-i6lgk, jjsz F1a).
     */
    signal?: SignalRun;
  } = {},
): Promise<void> {
  if (treeMatch.startsWith("-")) {
    throw new Error("treeMatch must not start with '-' (pkill would parse it as an option)");
  }
  const lifeline = proc ? lifelines.get(proc) : undefined;
  if (lifeline) lifeline.teardowns++;
  try {
    // `settled` is non-null from the moment a sweep (or disarm) began; it never rejects.
    if (lifeline?.settled) await lifeline.settled;
    // 4o93n (d): a HANDLE-LESS teardown has no ChildProcess, so the per-handle serialisation above has no
    // key and it used to run straight into an in-flight sweep for the same profile - whose `pkill -9 -f`
    // can match this teardown's own pkill/pgrep command lines and SIGKILL them (observed as exit 137),
    // failing the teardown. The registry is keyed by the PROFILE, so the profile is all that is needed:
    // wait for any sweep on this profile to settle first, exactly as a same-profile launch does.
    if (!lifeline) await awaitProfileSweepSettled(treeMatch);
    await killTreeAndVerify(proc, treeMatch, { attempts, intervalMs, group }, deps ?? {}, signal);
  } finally {
    if (lifeline) lifeline.teardowns--;
  }
  // Verified: the group is empty and nothing matches the profile. Only now is the
  // watchdog redundant (a throw above leaves it armed on purpose).
  if (lifeline) {
    await lifeline.disarm();
    return;
  }
  // A handle-less teardown cannot DISARM anything, and the sweep it queued behind may have ended UNCONFIRMED:
  // its watcher never exited even after SIGKILL, so the sweep may still signal this profile when it is
  // finally scheduled. The reap above has already run - doing it is still the best effort - so what is
  // refused here is the CLAIM. A caller that gets a resolution is entitled to read it as "the profile is
  // clear", and that would be a false clean (chrome-agent-platform-vy15c). The refusal names the profile and
  // the one next action, exactly like its launch twin.
  const unconfirmed = unconfirmedSweeps(treeMatch);
  if (unconfirmed > 0) {
    throw new Error(
      `teardown of profile ${JSON.stringify(clip(treeMatch, 80))} ran, but descendant cleanup is ` +
        `UNCONFIRMED: ${unconfirmed} lifeline watcher(s) for it did not exit within their bound even after ` +
        `SIGKILL, so a sweep may still signal this profile; verify no browser remains before reusing it`,
    );
  }
}

async function killTreeAndVerify(
  proc: Deno.ChildProcess | null,
  treeMatch: string,
  { attempts, intervalMs, group }: { attempts: number; intervalMs: number; group?: number },
  deps: ProcessTableDeps,
  signal?: SignalRun,
): Promise<void> {
  const run = signal ?? runOut;
  // The pattern the lifeline sweep uses, for the same reason and with the same refusal
  // (chrome-agent-platform-i6lgk): a RAW match over-matches by prefix, so tearing down
  // `<profile>/p1` also signalled `<profile>/p10`, and an unescaped one lets a profile path
  // containing an ERE metacharacter match something else entirely. The refusal is kept in ONE
  // place - an empty or NUL-bearing pattern must never reach pkill, which would match every
  // process on the host.
  const match = lifelineMatchPattern(treeMatch);
  if (match === "") {
    throw new Error(
      `process-tree: teardown cannot use treeMatch ${JSON.stringify(clip(treeMatch, 80))} as a pkill/pgrep pattern ` +
        "(empty, leading '-', or NUL-bearing) - refusing to signal anything",
    );
  }
  if (group !== undefined) {
    if (!proc || unsafeGroupReason(proc, group) !== null || processGroup(Deno.pid, deps)?.group === group) {
      throw new Error(`refusing unsafe process group ${group}`);
    }
    // Signal only the exact leader observed by isolatedProcessGroup. If it
    // exited or its PID was reused, the profile match remains the fallback.
    const current = processGroup(group, deps);
    if (current?.group === group && current.startTicks === leaderStartTicks.get(proc)) {
      try { Deno.kill(-group, "SIGKILL"); } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  }
  try { proc?.kill("SIGKILL"); } catch { /* already gone */ }
  try { await proc?.status; } catch { /* reaped */ }
  const killed = await run(PKILL, ["-9", "-f", match]);
  if (killed.code !== 0 && killed.code !== 1) throw new Error(`pkill exited ${killed.code} — cannot confirm cleanup`);
  for (let i = 0; i < attempts; i++) {
    let out;
    try {
      out = await run(PGREP, ["-f", match]);
    } catch (e) {
      throw new Error(`pgrep failed (${(e as Error)?.message ?? e}) — cannot confirm cleanup`);
    }
    if (out.code === 1 && (group === undefined || liveGroupMembers(group, deps).length === 0)) return;
    if (out.code !== 0 && out.code !== 1) {
      throw new Error(`pgrep exited ${out.code} — cannot confirm cleanup`);
    }
    await sleep(intervalMs);
  }
  let survivors = "";
  if (group !== undefined) {
    // The verdict is "survived"; an unreadable table must not replace it with a probe error.
    try {
      survivors = ` (group ${group}: ${liveGroupMembers(group, deps).join(",")})`;
    } catch (e) {
      survivors = ` (group ${group}: unreadable — ${(e as Error)?.message ?? e})`;
    }
  }
  throw new Error(`process tree survived cleanup${survivors}`);
}

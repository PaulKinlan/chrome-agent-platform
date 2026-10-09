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
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), startTicks: fields[19] };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
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
  /** The in-flight (or finished) transition out of `armed`; null while armed / unprotected. */
  settled: Promise<void> | null;
  /** `killProcessTree` calls running for this proc: they own the cleanup AND its verdict. */
  teardowns: number;
  disarm: () => Promise<void>;
}

const lifelines = new WeakMap<Deno.ChildProcess, Lifeline>();

/** The watcher's exit status when pkill rejected the pattern (exit >= 2); the group kill already ran. */
const LIFELINE_PKILL_REJECTED = 3;

// The watcher: block on the pipe (`cat` returns only on EOF), then kill the group and
// the profile's stragglers. `$?` right after pkill is pkill's own status: 1 = nothing
// matched (fine), >= 2 = the pattern was rejected (reported, never swallowed).
const LIFELINE_SCRIPT = 'cat >/dev/null 2>&1; ' +
  'if [ -n "$CAP_LIFELINE_TARGET" ]; then ' +
  'kill -TERM -"$CAP_LIFELINE_TARGET" "$CAP_LIFELINE_TARGET" 2>/dev/null || true; ' +
  'sleep 0.1; ' +
  'kill -KILL -"$CAP_LIFELINE_TARGET" "$CAP_LIFELINE_TARGET" 2>/dev/null || true; ' +
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
  /** Build the pkill pattern (default `lifelineMatchPattern`). */
  matchPattern?: (treeMatch: string | undefined) => string;
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

/**
 * Attach a crash-safe lifeline watchdog to `proc`. The watchdog runs in its own
 * session and reads a pipe whose write end is held exclusively by this parent
 * process. If this process dies for ANY reason (including `SIGKILL` or a test
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
 * KNOWN RESIDUAL RISK (found while making the crash tests deterministic; documented,
 * not implemented). The watcher is isolated by its own perl wrapper (`setsid()`), which
 * runs a few milliseconds AFTER the spawn returns. Until then it still shares THIS
 * process's group, so a SIGKILL of that whole GROUP inside the window kills the watcher
 * together with its parent and nothing reaps the browser (a probe that killed the
 * parent's group immediately after attaching orphaned the target in 7 of 20 runs; once
 * the watcher's own group was visible, 20 of 20 were reaped). A kill of the parent
 * ALONE, or of its group after the window, is covered. `launchChrome` keeps running for
 * at least the browser's start-up after attaching, so real exposure is tiny. What would
 * remove it: wait for `processGroup(watcher.pid).group === watcher.pid` before returning
 * (that makes the attach asynchronous, which every caller would have to accommodate).
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
  const existing = lifelines.get(proc);
  if (existing) return existing.disarm;
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const sweepTimeoutMs = deps.sweepTimeoutMs ?? 5000;
  const match = (deps.matchPattern ?? lifelineMatchPattern)(treeMatch);
  if (treeMatch && match === "") {
    warn(
      `process-tree: lifeline for pid ${proc.pid} cannot use treeMatch ${JSON.stringify(clip(treeMatch, 80))} ` +
        `as a kill pattern (empty, leading "-" or NUL); only its process group is covered if the parent dies`,
    );
  }
  const spec = setsidSpawnSpec("/bin/sh", ["-c", LIFELINE_SCRIPT]);
  const lifeline: Lifeline = {
    state: "unprotected",
    watcherPid: null,
    settled: null,
    teardowns: 0,
    disarm: async () => {},
  };
  let watcher: LifelineWatcher;
  try {
    watcher = (deps.spawn ?? spawnLifelineWatcher)({
      command: spec.command,
      args: spec.args,
      env: { CAP_LIFELINE_TARGET: String(target), CAP_LIFELINE_MATCH: match },
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

  // The single guard: every transition out of `armed` goes through here, and the
  // state flips synchronously, so a second trigger always sees it already spent.
  const leave = (next: "fired" | "disarmed", body: () => Promise<void>): Promise<void> => {
    lifeline.state = next;
    lifeline.settled = body().catch(() => {});
    return lifeline.settled;
  };
  const disarmBody = async (): Promise<void> => {
    await attempt(() => watcher.kill("SIGKILL"));
    await attempt(() => watcher.stdin.close());
    await attempt(() => watcher.status);
  };
  const sweepBody = async (): Promise<void> => {
    // The watcher's own trigger is EOF on its stdin: close it and do NOT kill the shell.
    const closing = attempt(() => watcher.stdin.close());
    const timedOut = Symbol("lifeline sweep timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        watcher.status.then((status) => status, () => null),
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
        await attempt(() => watcher.status);
      } else if (outcome !== null && outcome.code === LIFELINE_PKILL_REJECTED) {
        warn(
          `process-tree: lifeline sweep for pid ${proc.pid}: pkill rejected the profile pattern; ` +
            `the group kill still ran, but processes outside the group that match the profile were not swept`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    await closing;
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
): { state: LifelineStateName; watcherPid: number | null; settled: Promise<void> | null } | undefined {
  const lifeline = lifelines.get(proc);
  return lifeline && { state: lifeline.state, watcherPid: lifeline.watcherPid, settled: lifeline.settled };
}

/** The launcher waits for setsid to exec before recording the isolated group.
 *  A process table that cannot be read THROWS (it is not "exited before observation"). */
export async function isolatedProcessGroup(
  proc: Deno.ChildProcess,
  deps: ProcessTableDeps = {},
): Promise<number | undefined> {
  for (let i = 0; i < 20; i++) {
    const stat = processGroup(proc.pid, deps);
    if (stat?.group === proc.pid) {
      leaderStartTicks.set(proc, stat.startTicks);
      return proc.pid;
    }
    if (!stat || stat.state === "Z") return undefined; // exited before observation
    await sleep(25);
  }
  throw new Error(`Chrome pid ${proc.pid} did not enter its own process group; refusing group kill`);
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

async function runOut(bin: string, args: string[]) {
  // Absolute path + a cleared environment: no PATH/LD_* tricks in a cleanup path.
  return await new Deno.Command(bin, { args, stdout: "piped", stderr: "piped", clearEnv: true }).output();
}

/**
 * Kill `proc`, its isolated group when provided, and processes whose argv
 * contains `treeMatch`, then verify both group and profile have no live
 * members. `treeMatch` must NOT start with "-": pkill/pgrep would parse a
 * leading "--user-data-dir=…" as an option and exit 2. Throws when survivors
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
  { attempts = 20, intervalMs = 250, group, deps }: {
    attempts?: number;
    intervalMs?: number;
    group?: number;
    /** Process-table seam (default: this host's /proc or /bin/ps). */
    deps?: ProcessTableDeps;
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
    await killTreeAndVerify(proc, treeMatch, { attempts, intervalMs, group }, deps ?? {});
  } finally {
    if (lifeline) lifeline.teardowns--;
  }
  // Verified: the group is empty and nothing matches the profile. Only now is the
  // watchdog redundant (a throw above leaves it armed on purpose).
  if (lifeline) await lifeline.disarm();
}

async function killTreeAndVerify(
  proc: Deno.ChildProcess | null,
  treeMatch: string,
  { attempts, intervalMs, group }: { attempts: number; intervalMs: number; group?: number },
  deps: ProcessTableDeps,
): Promise<void> {
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
  const killed = await runOut(PKILL, ["-9", "-f", treeMatch]);
  if (killed.code !== 0 && killed.code !== 1) throw new Error(`pkill exited ${killed.code} — cannot confirm cleanup`);
  for (let i = 0; i < attempts; i++) {
    let out;
    try {
      out = await runOut(PGREP, ["-f", treeMatch]);
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

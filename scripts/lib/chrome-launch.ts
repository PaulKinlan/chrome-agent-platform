// chrome-launch.ts — the ONE way a harness in scripts/ starts a browser.
// CAP-FB-20260829-FIXED-DEBUG-PORTS-01
//
// Why this exists: a harness that hard-codes its debugging port (9351, say)
// does NOT get a guarantee that it is talking to the browser it just started.
// Chrome refuses to bind a port that is already taken and carries on running
// WITHOUT a debugging endpoint, so the harness's `fetch(127.0.0.1:9351)` then
// answers from whatever else is on that port — a zombie from a killed run, or
// a second lane's Chrome with a DIFFERENT extension loaded. The harness drives
// somebody else's browser and prints a confident PASS/FAIL about a tree it
// never loaded. Green against the wrong tree is worse than red: it reads as
// evidence.
//
// The fix is to never name a port. `--remote-debugging-port=0` makes the
// kernel hand Chrome a free port, and Chrome prints the resulting endpoint on
// stderr as `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/...`.
// That URL comes from THIS process, so there is no probe, no race, and no way
// to attach to a stranger. Two lanes can run concurrently by construction.
//
//   import { launchChrome } from "./lib/chrome-launch.ts";
//   const { proc, wsUrl } = await launchChrome({ binary: CHROMIUM, args: [...] });
//
// `freePort()` is the fallback for the rare harness that cannot read its own
// stderr; it is strictly weaker (probe-then-bind still races) and should not
// be reached for by default.

import { crypto } from "jsr:@std/crypto@1";
import { acquireChromeSlot } from "./chrome-slots.ts";
import { requireQuietWindow, type QuietSpec } from "./quiet-window.ts";
import { acquireHeavyGateSlot, HeavyGateSlotRefusedError, type HeavyGateLease } from "./heavy-gate-slot.ts";
import { resolveChromeForTesting } from "./chrome-for-testing.ts";
import { isUsableBinary } from "./browser-refusal.ts";
import { killProcessTree } from "./process-tree.ts";

export interface LaunchedChrome {
  /** The spawned Chrome. The caller owns killing it. */
  proc: Deno.ChildProcess;
  /** The browser-level DevTools WebSocket URL, read from this process's stderr. */
  wsUrl: string;
  /** The port the kernel actually assigned. */
  port: number;
  /** The last few KB of Chrome's stderr — for honest failure messages. */
  stderrTail(): string;
  /** How long this launch queued for its browser slot (0 when one was free). */
  lockWaitMs: number;
  /** Which concurrency slot this launch took (chrome-agent-platform-uzik), or
   *  -1 when the launch was serialized some other way: the exclusive canonical
   *  lock (`canonicalLock`), a fixture's own `lockPath`, or a bypass
   *  (`CAP_SECURITY_NONCE` / `CAP_CHROME_LOCK_HELD`). */
  chromeSlot: number;
  /** How long this launch waited for a QUIET BOX before starting (0 when the
   *  harness did not ask for one, or the box was already quiet).
   *  chrome-agent-platform-mkax. */
  quietWaitMs: number;
  /** How long this launch waited for the FLEET-WIDE heavy-gate slot (0 when it
   *  did not ask for one, or the slot was free). chrome-agent-platform-0lj3. */
  fleetSlotWaitMs?: number;
  /** The profile directory used for this launch, if any. */
  profile?: string;
  /** Cleanly tear down this Chrome instance and all its child processes. */
  close?: () => Promise<void>;
}

const TAIL_LIMIT = 8192;

/** The browser every harness drives. */
export async function computeUnpackedExtensionId(path: string): Promise<string> {
  const absPath = Deno.realPathSync(path);
  const data = new TextEncoder().encode(absPath);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let id = "";
  for (let i = 0; i < 16; i++) {
    const byte = hash[i];
    const high = (byte >> 4) & 0x0f;
    const low = byte & 0x0f;
    id += String.fromCharCode(97 + high) + String.fromCharCode(97 + low);
  }
  return id;
}

export async function seedGrantedPermissions(
  profileDir: string,
  extIdOrPath: string,
  apis: string[] = ["tabs", "notifications"],
): Promise<string> {
  const isId = /^[a-p]{32}$/.test(extIdOrPath);
  const extId = isId ? extIdOrPath : await computeUnpackedExtensionId(extIdOrPath);
  const extPath = isId ? "" : (() => { try { return Deno.realPathSync(extIdOrPath); } catch { return ""; } })();

  const defaultDir = `${profileDir}/Default`;
  await Deno.mkdir(defaultDir, { recursive: true });
  const prefsPath = `${defaultDir}/Preferences`;
  let prefs: any = {};
  try {
    prefs = JSON.parse(await Deno.readTextFile(prefsPath));
  } catch {
    prefs = {};
  }
  prefs.extensions ??= {};
  prefs.extensions.settings ??= {};
  prefs.extensions.settings[extId] = {
    active_permissions: {
      api: apis,
      explicit_host: ["<all_urls>"],
      manifest_permissions: [],
      scriptable_host: [],
    },
    granted_permissions: {
      api: apis,
      explicit_host: ["<all_urls>"],
      manifest_permissions: [],
      scriptable_host: [],
    },
    location: 8,
    ...(extPath ? { path: extPath } : {}),
    withholding_permissions: false,
  };
  await Deno.writeTextFile(prefsPath, JSON.stringify(prefs, null, 2));
  return extId;
}

export const CHROMIUM = "/usr/bin/chromium";

// ── the shared browser resolution (chrome-agent-platform-fyvc) ──────────────
// /usr/bin/chromium as a bare literal names exactly one machine's layout: on a
// box whose only Chrome is a Chrome-for-Testing build in ~/.cache (the normal
// case outside this VM), every harness importing this library failed at the
// spawn — indistinguishable from "this machine has no browser capability" —
// and a reviewer once had to create a system-level symlink just to run the
// repo's own gates. Resolution order, ONE place, every consumer:
//   1. the CAP_CHROMIUM env override (explicit; wins when usable). Both entry points use the same report:
//      missing, not executable, or a bare name absent from $PATH refuses with a named reason, rather than
//      returning an unusable path for a later ENOENT (chrome-agent-platform-s7wr/oy4m);
//   2. the newest Chrome-for-Testing in the puppeteer cache
//      (scripts/lib/chrome-for-testing.ts — includes bare-version cache dirs
//      per chrome-agent-platform-fyvc/wvg);
//   3. /usr/bin/chromium, the documented last resort.
// launchChrome resolves at spawn time; callers that invoke a resolver at module load
// bind the then-current environment. The cache glob is one readdir on a usually absent path.
/** Thrown when nothing USABLE resolves and a caller asked for a single path (chrome-agent-platform-oy4m).
 *  Named as an ENVIRONMENT difference (not an hlgr exit-75 verdict): the tried list says what to fix,
 *  rather than returning a bare path that dies ENOENT downstream,
 *  which is the product-shaped red for an environment difference that hlgr exists to remove. */
export class BrowserUnresolvedError extends Error {
  readonly tried: string[];
  constructor(tried: string[]) {
    super(
      `ENVIRONMENT: no usable browser resolved. Tried: ${tried.join(", ") || "<nothing>"}. ` +
        `Set CAP_CHROMIUM to an existing executable (a bare name is resolved through $PATH), or install a browser. ` +
        `This is an environment difference, not a product failure.`,
    );
    this.name = "BrowserUnresolvedError";
    this.tried = tried;
  }
}

export function resolveChromiumBinary(
  opts: {
    envGet?: (name: string) => string | undefined;
    cacheRoot?: string;
    exists?: (path: string) => boolean;
    usable?: (path: string) => boolean;
  } = {},
): string {
  // ONE resolution, shared with the report: oy4m ADOPTED the s7wr shape here rather than keeping the old
  // "never existence-checked" contract, whose own justification ("a wrong override surfaces as a loud spawn
  // error") is exactly what failed in the original defect. A caller that must REFUSE with an environmental
  // verdict (a guard) uses resolveChromiumBinaryReport + browserRefusal instead; a caller that will SPAWN
  // gets a path or a named throw.
  const report = resolveChromiumBinaryReport(opts);
  if (report.binary) return report.binary;
  throw new BrowserUnresolvedError(report.tried);
}

/** The resolution as a REPORT for callers that must distinguish "resolved"
 *  from "fell through to a default that may not exist" (the RPC census: a
 *  census that cannot launch a browser is a FAILED census, never a silent
 *  green — chrome-agent-platform-fyvc/wvg). `tried` names every step in order
 *  so the failure message tells the operator exactly what to fix.
 *  `exists` is injectable for deterministic tests. */
export function resolveChromiumBinaryReport(
  opts: {
    envGet?: (name: string) => string | undefined;
    cacheRoot?: string;
    exists?: (path: string) => boolean;
    usable?: (path: string) => boolean;
  } = {},
): { binary: string | null; tried: string[] } {
  const envGet = opts.envGet ?? ((name: string) => Deno.env.get(name));
  const exists = opts.exists ?? ((path: string) => {
    try { return Deno.statSync(path).isFile; } catch { return false; }
  });
  // chrome-agent-platform-s7wr: an override is the OPERATOR's explicit instruction, so it is VERIFIED
  // (existence AND executability) before it is reported as resolved. Reporting a missing override as
  // resolved made the hlgr environmental refusal unreachable and the launch died ENOENT - an environment
  // difference surfacing as a product-shaped red, which is the failure class hlgr exists to remove. The
  // predicate is the refusal module's, shared, so the two cannot drift on what "usable" means.
  const usable = opts.usable ?? isUsableBinary;
  // The REFUSAL REASON is as precise as the evidence allows: with injected predicates it comes from them
  // (tests drive it), and against the real filesystem it distinguishes a directory from a missing file, so
  // an operator who pointed CAP_CHROMIUM at a directory is told that rather than "missing" (review finding 3).
  const unusableReason = opts.exists
    ? (path: string) => (exists(path) ? " (not executable)" : " (missing)")
    : (path: string) => {
      try {
        const st = Deno.statSync(path);
        if (st.isDirectory) return " (a directory)";
        if (!st.isFile) return " (not a regular file)";
        return " (not executable)";
      } catch {
        return " (missing)";
      }
    };
  const tried: string[] = [];
  const rawOverride = envGet("CAP_CHROMIUM");
  if (typeof rawOverride === "string" && rawOverride.trim()) {
    // TRIM ONCE and use the trimmed value for the checks AND the report (review finding 4): a stray trailing
    // space must not make a real browser look missing.
    const override = rawOverride.trim();
    // A BARE NAME is not a filesystem path: a spawn resolves it through $PATH, so stat'ing it against the CWD
    // would REFUSE a configuration that used to work - a false refusal introduced by verification itself
    // (review finding 2). Follow the spawn's own rule and search $PATH with the same usability predicate,
    // reporting the absolute path found.
    const bareName = !override.includes("/") && !override.includes("\\");
    if (bareName) {
      const found = (envGet("PATH") ?? "").split(":").filter(Boolean)
        .map((dir) => `${dir}/${override}`)
        .find((candidate) => usable(candidate));
      if (found) {
        tried.push(`CAP_CHROMIUM=${override} (resolved on $PATH: ${found})`);
        return { binary: found, tried };
      }
      tried.push(`CAP_CHROMIUM=${override} (not found on $PATH)`);
      return { binary: null, tried };
    }
    if (usable(override)) {
      tried.push(`CAP_CHROMIUM=${override}`);
      return { binary: override, tried };
    }
    // REFUSE, and do not fall through: quietly using a DIFFERENT browser behind an explicit override
    // would hide the operator's misconfiguration. The reason and the path are both named so the refusal
    // line says exactly what to fix.
    tried.push(`CAP_CHROMIUM=${override}${unusableReason(override)}`);
    return { binary: null, tried };
  }
  const cached = resolveChromeForTesting(opts.cacheRoot != null ? { cacheRoot: opts.cacheRoot } : {});
  if (cached) {
    tried.push(`chrome-for-testing cache: ${cached}`);
    return { binary: cached, tried };
  }
  tried.push(`default ${CHROMIUM}${exists(CHROMIUM) ? "" : " (missing on this box)"}`);
  if (exists(CHROMIUM)) return { binary: CHROMIUM, tried };
  return { binary: null, tried };
}

// ── the exclusive canonical lock (OPT-IN since chrome-agent-platform-uzik) ──
// CAP-FB-20260830-SUITE-HONESTY-01 took this lock for EVERY launch, on the
// theory that two lanes driving headless Chromes at the same time produce CDP
// timeouts that say nothing about the tree. That theory was wrong about the
// mechanism: the timeouts came from machine LOAD (another lane's esbuild or
// rustc), which the lock never excluded — it only excluded other CAP browsers.
// What it cost was a 20-minute queue for 98 harnesses whose instances were
// already fully isolated (kernel-assigned `--remote-debugging-port=0` + a
// per-launch `--user-data-dir`).
//
// So the DEFAULT is now the bounded-concurrency semaphore in chrome-slots.ts,
// and this exclusive lock survives for the suites that genuinely need machine
// determinism — the security custody chain, whose evidence is about process
// groups and descendant residue. Those opt in with `canonicalLock: true`.
// Its properties are unchanged:
//   - bounded: the wait is capped (CAP_CHROME_LOCK_WAIT_MS, default 20 min) and
//     a lane that never gets the lock FAILS loudly — it is never turned green;
//   - honest: the wait is printed when it happens, with its length;
//   - reentrant within one process (a harness that launches two browsers);
//   - skipped inside the security supervisor, which already holds the lock
//     (CAP_SECURITY_NONCE), or when a runner says it holds it (CAP_CHROME_LOCK_HELD);
//   - released when the last browser this process launched exits, and by the
//     holder itself within a second of this process dying (no orphaned lock).
export const CHROME_LOCK_PATH_DEFAULT = "/tmp/cap-serialized-chrome-acceptance.lock";
export const CHROME_LOCK_PATH = Deno.env.get("CAP_CHROME_LOCK_PATH") ?? CHROME_LOCK_PATH_DEFAULT;

/** The canonical lock file, resolved PER CALL (chrome-agent-platform-uzik) so a
 *  runner or a test can point a launch at its own canonical scope without the
 *  module-load order trap that CHROME_LOCK_PATH has. The exported constant above
 *  is the load-time default and stays the value every static guard pins. */
function canonicalLockPath(): string {
  return Deno.env.get("CAP_CHROME_LOCK_PATH") ?? CHROME_LOCK_PATH_DEFAULT;
}

// Lock state is PER PATH (chrome-agent-platform-51x4): the canonical lock
// serializes real browsers; fake-browser unit fixtures take their own
// isolated scope (launchChrome's lockPath option) so they never queue behind
// a real lane's 20-minute gate — and never dilute the real serialization.
const lockStates = new Map<string, { holder: Deno.ChildProcess | null; refs: number }>();

/** Acquire the exclusive file lock at `lockPath` (flock under the hood).
 *  Exported for tests — the launch path itself goes through acquireLaunchScope.
 *  chrome-agent-platform-fyvc/wvg: the lock's PARENT DIRECTORY is created
 *  first (a caller-owned lockPath under a scratch dir that does not exist yet
 *  used to die in ~400ms blaming "another lane's browser" — flock cannot
 *  create the file when the directory is absent, and the misleading timeout
 *  message hid the real reason). */
export async function acquireChromeLock(lockPath: string = canonicalLockPath()): Promise<{ waitedMs: number; release: () => void }> {
  const noop = () => {};
  if (Deno.env.get("CAP_SECURITY_NONCE") || Deno.env.get("CAP_CHROME_LOCK_HELD") === "1") {
    return { waitedMs: 0, release: noop };
  }
  const lockDir = lockPath.slice(0, Math.max(lockPath.lastIndexOf("/"), 0));
  if (lockDir && lockDir !== lockPath) {
    try {
      Deno.mkdirSync(lockDir, { recursive: true });
    } catch (e) {
      throw new Error(
        `launchChrome: cannot create the chrome-lock directory ${lockDir} for ${lockPath}: ${e instanceof Error ? e.message : String(e)}. ` +
          "The lock itself was never attempted — this is a filesystem problem, not another lane's browser.",
      );
    }
  }
  const state = lockStates.get(lockPath) ?? { holder: null, refs: 0 };
  lockStates.set(lockPath, state);
  const release = () => {
    state.refs = Math.max(0, state.refs - 1);
    if (state.refs === 0 && state.holder) {
      // Closing the holder's stdin is the release: `cat` sees EOF, the shell
      // exits, flock exits, the kernel drops the lock. The same EOF happens
      // by itself when this process dies, so a crashed harness never leaves
      // the lock held.
      const h = state.holder;
      state.holder = null;
      try { h.stdin.close().catch(() => {}); } catch { /* already closed */ }
    }
  };
  if (state.holder) {
    state.refs++;
    return { waitedMs: 0, release };
  }
  const waitMs = Number(Deno.env.get("CAP_CHROME_LOCK_WAIT_MS") ?? 20 * 60_000);
  const t0 = Date.now();
  // flock -w gives a bounded wait natively; the holder prints once it has the
  // lock and then holds it exactly until its stdin closes.
  const holder = new Deno.Command("flock", {
    args: [
      "-w", String(Math.max(1, Math.ceil(waitMs / 1000))),
      lockPath,
      "sh", "-c",
      "echo CAP_CHROME_LOCK_ACQUIRED; exec cat >/dev/null",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let notice: ReturnType<typeof setTimeout> | undefined;
  const deadline = t0 + waitMs + 2000;
  while (!seen.includes("CAP_CHROME_LOCK_ACQUIRED") && Date.now() < deadline) {
    if (notice === undefined) {
      notice = setTimeout(() => console.error(`launchChrome: waiting for the serialized-Chrome lock (${lockPath}) — another lane is driving a browser`), 1500);
    }
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await withTimeout(reader.read(), deadline - Date.now()); } catch { break; }
    if (chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
  }
  clearTimeout(notice);
  try { reader.releaseLock(); } catch { /* released */ }
  const waitedMs = Date.now() - t0;
  if (!seen.includes("CAP_CHROME_LOCK_ACQUIRED")) {
    try { await holder.stdin.close(); } catch { /* already closed */ }
    try { holder.kill("SIGKILL"); } catch { /* gone */ }
    try { await holder.status; } catch { /* reaped */ }
    throw new Error(
      `launchChrome: could not take the serialized-Chrome lock within ${waitMs} ms (${lockPath} is held by another lane's browser). ` +
        "Not started — a run that cannot get the browser is a failed run, not a skipped one.",
    );
  }
  if (waitedMs > 1500) console.error(`launchChrome: took the serialized-Chrome lock after ${waitedMs} ms`);
  // Drain the holder's stdout in the background (it prints nothing more).
  (async () => { try { for await (const _ of holder.stdout) { /* drain */ } } catch { /* gone */ } })();
  state.holder = holder;
  state.refs = 1;
  holder.status.then(() => { if (state.holder === holder) { state.holder = null; state.refs = 0; } }).catch(() => {});
  return { waitedMs, release };
}

/**
 * A per-INSTANCE Chrome profile under an operator- or caller-supplied base
 * directory (chrome-agent-platform-uzik).
 *
 * Concurrency made this necessary. A harness whose profile is
 * `${EVIDENCE_DIR}/profile` is unique only as long as nobody else runs the same
 * harness against the same evidence dir — and `HEADED_EVIDENCE_DIR` /
 * `Deno.args[1]` are exactly the knobs an operator sets to a fixed path. Two
 * runs sharing a profile do not merely race: Chrome's SingletonLock makes the
 * second launch fail or attach to the first, and one run's cleanup sweep then
 * deletes the other's LIVE profile. Under the old one-browser-at-a-time lock
 * that could not happen; under a semaphore it can.
 *
 * The suffix is pid + wall clock + 8 random characters, so two runs started in
 * the same millisecond by the same pid (impossible) or by two lanes (different
 * pids) still differ.
 */
export function instanceProfile(base: string, name = "profile"): string {
  const clean = base.replace(/\/+$/u, "");
  return `${clean}/${name}-${Deno.pid}-${Date.now()}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Resolve exactly ONE launch scope (chrome-agent-platform-uzik):
 *   - `lockPath`     → an exclusive lock on a caller-owned file (unit fixtures);
 *   - `canonicalLock`→ the exclusive canonical machine lock (opt-in determinism);
 *   - default        → one slot of the bounded-concurrency semaphore.
 * Asking for two exclusive scopes at once is a caller bug, not a preference.
 */
async function acquireLaunchScope(opts: {
  lockPath?: string;
  canonicalLock?: boolean;
}): Promise<{ waitedMs: number; release: () => void; slot: number }> {
  if (opts.lockPath && opts.canonicalLock) {
    throw new Error(
      "launchChrome: lockPath and canonicalLock together are an ambiguous scope — pass exactly one",
    );
  }
  if (opts.lockPath || opts.canonicalLock) {
    const lock = await acquireChromeLock(opts.lockPath);
    return { waitedMs: lock.waitedMs, release: lock.release, slot: -1 };
  }
  return acquireChromeSlot();
}

/**
 * The flags every headless harness passes. Exported so a harness that builds
 * its own argv (a custom window size, an extra page) still shares one source
 * for the boring part instead of a private copy that drifts.
 */
export function chromeBaseArgs(opts: {
  profile?: string;
  extension?: string;
  windowSize?: string;
} = {}): string[] {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-allow-origins=*",
    `--window-size=${opts.windowSize ?? "1440,900"}`,
  ];
  if (opts.extension) {
    args.push("--silent-debugger-extension-api");
    args.push(`--disable-extensions-except=${opts.extension}`);
    args.push(`--load-extension=${opts.extension}`);
  }
  if (opts.profile) args.push(`--user-data-dir=${opts.profile}`);
  return args;
}

/**
 * Spawn Chrome with a kernel-assigned debugging port and return its real
 * DevTools endpoint. `args` must NOT contain `--remote-debugging-port`; a
 * fixed port is the defect this module exists to remove, so passing one is a
 * hard error rather than a silent override.
 *
 * Two ways to call it:
 *   - `args` only: the caller owns the full argv (the launcher appends the port).
 *   - `extension` / `profile` (+ optional `args` extras): the launcher builds the
 *     standard headless argv with `chromeBaseArgs()` and loads the extension.
 */
export async function launchChrome(opts: {
  binary?: string;
  args?: string[];
  extension?: string;
  profile?: string;
  windowSize?: string;
  timeoutMs?: number;
  stdout?: "null" | "inherit" | "piped";
  clearEnv?: boolean;
  /** Environment for the browser (with clearEnv: the whole environment — an allowlist). */
  env?: Record<string, string>;
  /** Pre-seed Chrome's Preferences with granted permissions before launch. */
  grantPermissions?: string[];
  /** EXCLUSIVE lock scope for this launch, replacing the concurrency slot.
   *  Fake-browser unit fixtures pass their own path so they never queue behind
   *  (or block) the real browser queue (chrome-agent-platform-51x4), and never
   *  spend the machine's browser budget on a shell script. Never set this in a
   *  real acceptance run. */
  lockPath?: string;
  /** Opt into the exclusive canonical serialized-Chrome lock instead of a
   *  concurrency slot (chrome-agent-platform-uzik). For suites whose evidence
   *  requires machine determinism — the security custody chain. Mutually
   *  exclusive with `lockPath`. */
  canonicalLock?: boolean;
  /** Wait for a quiet box before starting (chrome-agent-platform-mkax), for a
   *  gate whose failures under machine load are environmental rather than
   *  product defects — the journey suite's `cdp timeout: Runtime.evaluate`
   *  class (eo4d.1: 59/370 and 250/370 then a transport timeout at load >7;
   *  370/370 only in a quiet window). `true` uses the documented thresholds; a
   *  QuietSpec tunes them. On refusal this THROWS QuietWindowRefusedError and
   *  the browser is NEVER started: the harness must turn that into its
   *  environmental verdict (exit 75 + an `ENVIRONMENT:` line), which is a third
   *  outcome — not green, and not a defect in the tree. The serialized-Chrome
   *  lock is not a substitute for this: exclusivity excludes other CAP
   *  browsers, never another lane's rustc or esbuild. */
  requireQuiet?: boolean | QuietSpec;
  /** Take the fleet-wide heavy-gate slot for this launch (chrome-agent-platform-0lj3).
   *  A load-sensitive gate and the KAT batch must not share the machine: measured
   *  2026-09-22, a box the quiet predicate called quiet (load/core 0.13) took a
   *  journey to 132/370 before a `cdp evaluate` blew its budget under fleet load.
   *  PAIRED WITH `requireQuiet` on purpose — the same declaration that says "this
   *  gate's reds are environmental" is the one that says "this gate takes turns",
   *  and passing one without the other is a caller bug (below). The slot is
   *  released when the browser exits, and by the kernel if this process dies.
   *  Refusal THROWS HeavyGateSlotRefusedError: the harness turns it into its
   *  environmental verdict (exit 75 + the holder named), never a product red. */
  fleetSlot?: boolean | { gate?: string; kind?: string; boundMs?: number };
}): Promise<LaunchedChrome> {
  // chrome-agent-platform-ryrr: NEVER take the fleet turn while this process
  // already holds the canonical serialized-Chrome lock. The custody supervisor
  // (scripts/security-suite-supervisor.sh) holds that lock on fd 9 for its whole
  // run and launches its harnesses as children, so a child that also asked for
  // the fleet turn would invert the fleet-wide order (turn -> canonical) and
  // wait for a gate that is itself waiting for the canonical lock — a deadlock
  // neither lock can see. The custodial exclusivity already serialises that
  // suite, so the correct answer is to refuse, loudly, rather than queue.
  // `acquireChromeLock` bypasses on exactly these two markers, which is what
  // makes the holder detectable here.
  if (opts.fleetSlot && (Deno.env.get("CAP_SECURITY_NONCE") || Deno.env.get("CAP_CHROME_LOCK_HELD") === "1")) {
    throw new Error(
      "launchChrome: refusing fleetSlot while this process already holds the canonical serialized-Chrome lock " +
        "(CAP_SECURITY_NONCE / CAP_CHROME_LOCK_HELD is set — the custody supervisor holds it on fd 9 for its whole " +
        "run). Taking the fleet turn here would invert the fleet-wide acquisition order and can deadlock against " +
        "another gate that holds the turn and wants the canonical lock; the custody chain's own exclusivity already " +
        "serialises this suite, so it must not also take the turn (chrome-agent-platform-ryrr).",
    );
  }
  if (opts.fleetSlot && !opts.requireQuiet) {
    throw new Error(
      "launchChrome: fleetSlot is the load-sensitive gate's declared turn — pass requireQuiet too " +
        "(a non-load-sensitive launch must not hold the fleet-wide slot; chrome-agent-platform-0lj3)",
    );
  }
  // ORDER MATTERS: take the turn BEFORE measuring. Holding the slot means no other
  // heavy gate can start while we wait for quiet, so the predicate then measures
  // the rest of the box rather than racing another gate that is starting up.
  let fleetLease: HeavyGateLease | null = null;
  let fleetSlotWaitMs = 0;
  if (opts.fleetSlot) {
    const spec = opts.fleetSlot === true ? {} : opts.fleetSlot;
    fleetLease = await acquireHeavyGateSlot({
      gate: spec.gate ?? "gate",
      kind: spec.kind ?? "gate",
      boundMs: spec.boundMs,
    });
    fleetSlotWaitMs = fleetLease.waitedMs;
  }
  let quietWaitMs = 0;
  // ANY failure between taking the fleet turn and handing back a live browser
  // gives the turn back. The stdin-close pattern covers this process DYING; it
  // cannot cover this process LIVING while holding a slot for a browser that
  // never started — which is a lock leak nobody sees until the next gate waits
  // its whole bound for a holder that owns nothing (review 2026-09-23, defect 1).
  // Written out at each site rather than via a helper: the release has to be
  // visible next to the failure it guards, and TypeScript cannot narrow a thrown
  // value through a call.
  if (opts.requireQuiet) {
    try {
      quietWaitMs = (await requireQuietWindow(
        opts.requireQuiet === true ? {} : opts.requireQuiet,
      )).waitedMs;
    } catch (e) {
      // A refusal here means we never start a browser: give the turn straight back.
      fleetLease?.release();
      throw e;
    }
  }
  if (Array.isArray(opts.grantPermissions) && opts.grantPermissions.length && opts.profile && opts.extension) {
    try {
      await seedGrantedPermissions(opts.profile, opts.extension, opts.grantPermissions);
    } catch (e) {
      fleetLease?.release();
      throw e;
    }
  }
  const extras = opts.args ?? [];
  const fixed = extras.find((a) => a.startsWith("--remote-debugging-port"));
  if (fixed) {
    fleetLease?.release();
    throw new Error(
      `launchChrome: refusing a caller-chosen debugging port (${fixed}). ` +
        "The port is assigned by the kernel and read back from Chrome's own stderr.",
    );
  }
  const args = (opts.extension || opts.profile)
    ? [
      ...chromeBaseArgs({ profile: opts.profile, extension: opts.extension, windowSize: opts.windowSize }),
      ...extras,
      ...(extras.some((a) => !a.startsWith("--")) ? [] : ["about:blank"]),
    ]
    : extras;

  let lock: { waitedMs: number; release: () => void; slot: number };
  try {
    lock = await acquireLaunchScope(opts);
  } catch (e) {
    fleetLease?.release();
    throw e;
  }
  let proc: Deno.ChildProcess;
  try {
    proc = new Deno.Command(opts.binary ?? resolveChromiumBinary(), {
      args: [...args, "--remote-debugging-port=0"],
      stdout: opts.stdout ?? "null",
      stderr: "piped",
      ...(opts.clearEnv ? { clearEnv: true } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    }).spawn();
  } catch (e) {
    lock.release();
    fleetLease?.release();
    throw e;
  }
  // The slot (or exclusive lock) lives exactly as long as this browser does.
  // When Chrome exits, cancel the stderr drain reader so orphaned grandchild
  // processes never keep the pipe open and hang the event loop in do_epoll_wait.
  proc.status.then(() => {
    lock.release();
    try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
  }).catch(() => {
    lock.release();
    try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
  });

  let tail = "";
  const append = (chunk: string) => {
    tail = (tail + chunk).slice(-TAIL_LIMIT);
  };

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + (opts.timeoutMs ?? 20000);
  let seen = "";
  let wsUrl = "";
  while (!wsUrl && Date.now() < deadline) {
    let value: Uint8Array | undefined, done = false;
    try {
      ({ value, done } = await withTimeout(reader.read(), deadline - Date.now()));
    } catch {
      break; // read deadline — fall through to the honest error below
    }
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    append(text);
    seen += text;
    const m = seen.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) wsUrl = m[1];
  }

  if (!wsUrl) {
    try { reader.releaseLock(); } catch { /* already released */ }
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    try { await proc.status; } catch { /* already reaped */ }
    lock.release();
    fleetLease?.release();
    // The browser never came up: give the FLEET turn back too. Without this, a
    // startup failure kept the fleet-wide slot held by a live process that owns
    // no browser — the one leak the crash-safe stdin pattern cannot cover, since
    // the holder is still alive (review 2026-09-23, defect 1).
    throw new Error(
      `launchChrome: Chrome never printed a DevTools endpoint (${opts.binary}). stderr tail: ${tail.slice(-600)}`,
    );
  }

  // Keep draining stderr in the background. An undrained pipe eventually fills
  // and blocks Chrome mid-run, which reads as a mysterious harness hang.
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
    } catch { /* the process went away; nothing to drain */ }
  })();

  // The turn ends when the browser does. If a harness never kills its browser,
  // this process dying drops the flock anyway (the holder's stdin closes).
  if (fleetLease) {
    const lease = fleetLease;
    proc.status.then(() => lease.release(), () => lease.release());
  }

  const USER_DATA_PREFIX = "--" + "user-data-dir=";
  let resolvedProfile = opts.profile;
  if (!resolvedProfile && opts.args) {
    for (const arg of opts.args) {
      if (arg.startsWith(USER_DATA_PREFIX)) {
        resolvedProfile = arg.slice(USER_DATA_PREFIX.length);
        break;
      }
    }
  }

  const launched: LaunchedChrome = {
    proc,
    wsUrl,
    port: Number(new URL(wsUrl).port),
    stderrTail: () => tail,
    lockWaitMs: lock.waitedMs,
    chromeSlot: lock.slot,
    quietWaitMs,
    fleetSlotWaitMs,
    profile: resolvedProfile,
    close: async () => {
      await teardownChrome(proc, resolvedProfile);
    },
  };
  return launched;
}

/**
 * Cleanly tear down a launched Chrome process AND its entire process tree
 * (zygote, GPU, renderer, crashpad children) using killProcessTree().
 *
 * Chromium child processes inherit `--user-data-dir=...` in their command line,
 * so matching `user-data-dir=${profile}` eliminates orphaned children that
 * would otherwise be reparented to init (PPID=1) and trigger the fleet reaper's
 * orphan kill rule (chrome-agent-platform-jixr).
 *
 * `target` can be a `LaunchedChrome`, a `Deno.ChildProcess`, or an object with `{ proc }`.
 * If `profile` is not explicitly provided, it will be extracted from `target.profile`
 * or inferred from the launch options.
 * If no profile is available (e.g. fake test binaries), it falls back to killing `proc`
 * and awaiting `proc.status`.
 */
export async function teardownChrome(
  target: LaunchedChrome | Deno.ChildProcess | { proc?: Deno.ChildProcess | null; profile?: string } | null | undefined,
  profile?: string,
): Promise<void> {
  if (!target && !profile) return;
  const proc = target ? ("proc" in target ? (target.proc ?? null) : (target instanceof Deno.ChildProcess ? target : null)) : null;
  const matchedProfile = profile ?? (target && "profile" in target ? target.profile : undefined);
  if (matchedProfile) {
    const raw = matchedProfile.replace(/^--/, "");
    const match = raw.startsWith("user-data-dir=") ? raw : `user-data-dir=${raw}`;
    await killProcessTree(proc, match);
    return;
  }
  if (proc) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    try { await proc.status; } catch { /* reaped */ }
  }
}

export const closeChrome = teardownChrome;

export type CdpSend = (method: string, params?: any, sessionId?: string) => Promise<any>;

export interface CdpClient {
  /** Raw CDP send. Resolves with the full `{ result }` envelope; rejects on a protocol error. */
  send: CdpSend;
  /** Attach to a target (flatten) and enable Runtime + Page; returns the session id. */
  attach(targetId: string): Promise<string>;
  /** Open a URL in a new target and attach to it; returns the session id. */
  open(url: string): Promise<{ targetId: string; sessionId: string }>;
  /** `Runtime.evaluate` with awaitPromise + returnByValue; throws on a page exception. */
  eval(sessionId: string, expression: string): Promise<any>;
  /** Safely capture a screenshot of a target without wedging on quiesced headless frames (f5lb). */
  screenshot(sessionId: string, opts?: ScreenshotOptions): Promise<Uint8Array | null>;
  /** Wait (bounded) for the extension's service-worker target; returns its info or null. */
  serviceWorker(opts?: { timeoutMs?: number }): Promise<any | null>;
  /** Subscribe to a CDP event (e.g. Runtime.executionContextCreated). Returns an unsubscribe. */
  on(method: string, handler: (params: any, sessionId?: string) => void): () => void;
  close(): void;
}

/**
 * The minimal CDP client the harnesses used to each carry a private copy of.
 * One WebSocket over the browser endpoint `launchChrome()` returned; every
 * method is bounded and a protocol error REJECTS (never resolves as success).
 */
export async function openCdp(wsUrl: string, opts: { timeoutMs?: number } = {}): Promise<CdpClient> {
  const ws = new WebSocket(wsUrl);
  await withTimeout(
    new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("cdp websocket error"));
    }),
    opts.timeoutMs ?? 10000,
  );
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message ?? "cdp error"}`));
      else p.resolve({ result: m.result });
      return;
    }
    if (typeof m.method === "string") {
      for (const fn of listeners.get(m.method) ?? []) {
        try { fn(m.params, m.sessionId); } catch { /* a listener must not break the socket */ }
      }
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("cdp websocket closed"));
    pending.clear();
  };
  const send: CdpSend = (method, params = {}, sessionId) => {
    const mid = ++id;
    return withTimeout(
      new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      }),
      opts.timeoutMs ?? 30000,
    ).catch((e) => {
      pending.delete(mid);
      throw new Error(`${method}: ${e?.message ?? e}`);
    });
  };
  const attach = async (targetId: string) => {
    const a = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = a?.result?.sessionId as string;
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId).catch(() => {});
    return sessionId;
  };
  return {
    send,
    attach,
    async open(url: string) {
      const t = await send("Target.createTarget", { url });
      const targetId = t?.result?.targetId as string;
      return { targetId, sessionId: await attach(targetId) };
    },
    async eval(sessionId: string, expression: string) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      const res = r?.result;
      if (res?.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate threw");
      }
      return res?.result?.value;
    },
    screenshot: (sessionId, opts = {}) => safeCaptureScreenshot(send, sessionId, opts),
    serviceWorker: (o = {}) => waitForServiceWorker(send, o),
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(handler);
      return () => { listeners.get(method)?.delete(handler); };
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

/**
 * Wait for the loaded extension's service-worker target to appear.
 *
 * Harnesses used to call `Target.getTargets` once, immediately after the CDP
 * handshake, and it worked only because polling a fixed port for
 * `/json/version` burned enough wall-clock for MV3 to register the worker.
 * Reading the endpoint off stderr removes that accidental delay, so the wait
 * has to be explicit — otherwise the harness reports "no service worker
 * target" for a browser that was merely still starting.
 *
 * Returns the target info, or null if it never registered within the deadline.
 */
export async function waitForServiceWorker(
  send: CdpSend,
  opts: { timeoutMs?: number; match?: (t: any) => boolean } = {},
): Promise<any | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15000);
  const match = opts.match ?? ((t: any) => t.type === "service_worker");
  for (;;) {
    const res = await send("Target.getTargets");
    const found = (res?.result?.targetInfos ?? []).find(match);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  fromSurface?: boolean;
  captureBeyondViewport?: boolean;
  timeoutMs?: number;
}

/**
 * Capture a screenshot safely without hanging on quiesced headless frames (chrome-agent-platform-f5lb).
 *
 * In headless Chromium with --disable-gpu, Page.captureScreenshot(fromSurface: true)
 * issued when the page has no pending visual work waits forever for a compositor
 * frame that is never scheduled (the renderer is idle, so Viz never gets an OnBeginFrame).
 *
 * This helper:
 *   1. Races the capture against a bounded timeout (default 8000ms).
 *   2. If fromSurface: true was requested or defaulted and times out or rejects,
 *      wakes the frame pipeline with a micro requestAnimationFrame / style tick
 *      and falls back to fromSurface: false (which reads from the backing store /
 *      Blink paint tree directly rather than waiting for an unscheduled Viz frame).
 *   3. Returns Uint8Array of bytes, or null on terminal failure (never wedges the process).
 */
export async function safeCaptureScreenshot(
  send: CdpSend,
  sessionId: string,
  opts: ScreenshotOptions = {},
): Promise<Uint8Array | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const captureCall = (fromSurface?: boolean) => {
    const params: Record<string, unknown> = {
      format: opts.format ?? "png",
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.clip ? { clip: opts.clip } : {}),
      ...(opts.captureBeyondViewport !== undefined ? { captureBeyondViewport: opts.captureBeyondViewport } : {}),
      ...(fromSurface !== undefined ? { fromSurface } : {}),
    };
    return send("Page.captureScreenshot", params, sessionId);
  };

  // Attempt 1: Caller's preferred fromSurface setting with bounded timeout
  try {
    const res = await withTimeout(captureCall(opts.fromSurface), timeoutMs);
    const b64 = res?.result?.data ?? res?.data;
    if (b64 && typeof b64 === "string") {
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
  } catch (_err) {
    // If fromSurface was true (or defaulted), the frame scheduler may be quiesced.
    // Fall through to wake the compositor and retry with fromSurface: false.
  }

  // Attempt 2: Wake up compositor and capture with fromSurface: false
  try {
    await withTimeout(
      send("Runtime.evaluate", {
        expression: "new Promise(r => requestAnimationFrame(() => r(true)))",
        awaitPromise: true,
      }, sessionId),
      1500,
    ).catch(() => {});
    const fallback = await withTimeout(captureCall(false), Math.min(timeoutMs, 4000));
    const b64 = fallback?.result?.data ?? fallback?.data;
    if (b64 && typeof b64 === "string") {
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
  } catch {
    return null;
  }

  return null;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("deadline"));
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("deadline")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Fallback for a harness that genuinely cannot read Chrome's stderr: find a
 * port nothing answers on AND nothing is bound to. Weaker than `launchChrome`
 * — the window between the check and Chrome's bind is a real race — so prefer
 * `launchChrome` wherever the harness owns the spawn.
 */
export async function freePort(from = 9400, span = 500, attempts = 40): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = from + Math.floor(Math.random() * span);
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
      await probe.body?.cancel();
      continue; // somebody is already answering there
    } catch { /* nothing listening — try to claim it */ }
    try {
      const l = Deno.listen({ port, hostname: "127.0.0.1" });
      l.close();
      return port;
    } catch { /* raced or reserved; try another */ }
  }
  throw new Error("no free debugging port");
}

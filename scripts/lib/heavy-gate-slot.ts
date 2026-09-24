// heavy-gate-slot.ts — ONE declared fleet-wide slot for load-sensitive gates.
// chrome-agent-platform-0lj3
//
// WHY THIS EXISTS. The quiet-window predicate (quiet-window.ts, mkax) measures
// whether the box is quiet enough to START a load-sensitive gate. It cannot stop
// two gates from being on the box at once, and the two scopes that already exist
// do not close that: `launchChrome` takes the canonical flock OR one slot of the
// semaphore, never both (acquireLaunchScope, `slot: -1` for the canonical path),
// so a journey holding the canonical lock and a KAT batch's browsers run
// concurrently by construction. Measured 2026-09-22: with the quiet-window gate
// fixed, chrome-journeys started on a box the predicate called quiet
// (load/core 0.13) and reached 132/370 before a `cdp evaluate` exceeded its
// budget under fleet load — the eo4d.1/qk7p cliff. No threshold could have
// prevented it; the gates have to take turns.
//
// Contract:
//   - ONE SLOT, FLEET-WIDE: a flock held for the gate's lifetime. Load-sensitive
//     gates (chrome-journeys, the KAT batch) take it; ordinary harnesses and unit
//     fixtures are unaffected and keep using the bounded browser semaphore.
//   - ANNOUNCED: the holder publishes a sidecar JSON (gate, pid, started-at, cwd)
//     so a refusing lane can NAME who has the machine instead of asking a human.
//   - BOUNDED: the wait is capped (CAP_HEAVY_GATE_BOUND_MS, default 20 min — the
//     canonical lock's contract).
//   - INCONCLUSIVE, NEVER GREEN: a lane that cannot get the slot refuses
//     environmentally — exit 75 plus the existing CAP_ENVIRONMENTAL_REFUSAL
//     marker carrying {reason:"heavy-gate-slot-busy", holder} — and does not
//     start its browser. It is never a product red and never a silent skip.
//   - CRASH-SAFE: the slot is held by a `flock` child whose stdin is the only
//     thing keeping it alive; when this process dies (any way, including
//     Deno.exit), the kernel closes the pipe and the lock is dropped. No orphaned
//     slot needs reaping.
//   - NEVER DESTRUCTIVE: measure and wait, or refuse. This module does not kill,
//     renice, cgroup or otherwise touch another lane's processes.

import { ENVIRONMENTAL_REFUSAL_EXIT, ENVIRONMENTAL_REFUSAL_MARKER } from "./quiet-window.ts";

/** The one fleet-wide slot. Small cross-process coordination files live on
 *  tmpfs on purpose (see durable-root.mjs): a reboot clearing a stale lock is a
 *  feature, and tests/durable-root.test.ts allowlists this prefix. */
export const HEAVY_GATE_SLOT_PATH = "/tmp/cap-heavy-gate.lock";
export const HEAVY_GATE_HOLDER_PATH = "/tmp/cap-heavy-gate.holder.json";

/** What the holder publishes, so a refusal can name it. Deliberately boring:
 *  no argv dumps, no environment, nothing about another lane's work beyond what
 *  a human needs to go and ask. */
export interface HeavyGateHolder {
  gate: string;
  kind: string;
  pid: number;
  startedAt: string;
  cwd: string;
}

export interface HeavyGateSlot {
  slotPath: string;
  holderPath: string;
}

export interface HeavyGateLease {
  /** How long we waited to get the slot. */
  waitedMs: number;
  /** The holder we waited behind, when the sidecar named one. */
  waitedFor: HeavyGateHolder | null;
  /** True when no slot was taken (CAP_HEAVY_GATE_DISABLE=1) — the caller still
   *  gets a lease so its shape is uniform, and release is a no-op. */
  disabled: boolean;
  release: () => void;
}

export interface AcquireHeavyGateOptions {
  /** Who is asking — appears in the announcement and in refusals. */
  gate: string;
  kind?: string;
  boundMs?: number;
  slot?: Partial<HeavyGateSlot>;
  onWait?: (line: string) => void;
  onAcquired?: (line: string) => void;
}

/** Two env-shaped escapes, both explicit: a lane may not take the fleet slot for
 *  a fixture that is not a load-sensitive gate, and an operator may disable it to
 *  diagnose the slot itself. Neither may be used to make a gate green. */
export function heavyGateDisabled(): boolean {
  return Deno.env.get("CAP_HEAVY_GATE_DISABLE") === "1";
}

function boundMs(opts: AcquireHeavyGateOptions): number {
  const env = Number(Deno.env.get("CAP_HEAVY_GATE_BOUND_MS"));
  if (Number.isFinite(env) && env > 0) return env;
  return opts.boundMs ?? 20 * 60_000;
}

function slotPaths(opts: AcquireHeavyGateOptions): HeavyGateSlot {
  const slotPath = opts.slot?.slotPath ?? Deno.env.get("CAP_HEAVY_GATE_SLOT") ?? HEAVY_GATE_SLOT_PATH;
  return { slotPath, holderPath: opts.slot?.holderPath ?? heavyGateHolderPathFor(slotPath) };
}

/** Where the announcement for `slotPath` lives. ONE derivation, used by the
 *  writer and by every reader — the first version derived the writer's path as
 *  `${slotPath}.holder.json` while the exported reader default was a DIFFERENT
 *  literal, so a lane holding the fleet slot was announced somewhere the handy
 *  reader never looked (review 2026-09-23: 'a sidecar written where the reader
 *  does not look'). The documented default keeps its stable name; a private slot
 *  gets its announcement beside it. */
export function heavyGateHolderPathFor(slotPath: string): string {
  return slotPath === HEAVY_GATE_SLOT_PATH ? HEAVY_GATE_HOLDER_PATH : `${slotPath}.holder.json`;
}

/** A lock that could not be SET UP (a path that cannot be opened, a missing
 *  `flock`, an unwritable directory) is NOT a lock that is busy. The first
 *  version reported both as contention, which sends a lane to wait for a holder
 *  that does not exist — the same class as blaming a dead holder instead of
 *  showing it as stale. Same third verdict (environmental, exit 75), distinct
 *  reason so a reader can tell the two apart. */
export class HeavyGateSlotSetupError extends Error {
  readonly gate: string;
  readonly slotPath: string;
  readonly detail: string;
  constructor(gate: string, slotPath: string, detail: string) {
    super(
      `ENVIRONMENT: the fleet-wide heavy-gate slot could not be SET UP at ${slotPath} — ${detail}. ` +
        `This is NOT contention: no holder is implied and waiting will not help. ` +
        `The gate did not start (exit ${ENVIRONMENTAL_REFUSAL_EXIT}); report it as an environment fault, ` +
        `never as a product red and never as another lane holding the machine (chrome-agent-platform-0lj3).`,
    );
    this.name = "HeavyGateSlotSetupError";
    this.gate = gate;
    this.slotPath = slotPath;
    this.detail = detail;
  }
}

/** The JSON a harness prints after the environmental marker for a SETUP fault. */
export function heavyGateSetupFailurePayload(err: HeavyGateSlotSetupError): Record<string, unknown> {
  return { reason: "heavy-gate-slot-unavailable", gate: err.gate, slotPath: err.slotPath, detail: err.detail };
}

/** Read the announced holder. `alive` distinguishes a live holder from a sidecar
 *  left behind by a process that died (the flock itself is already gone then;
 *  this is about not naming a dead lane as the blocker). */
export function readHeavyGateHolder(holderPath = HEAVY_GATE_HOLDER_PATH): { holder: HeavyGateHolder | null; alive: boolean } {
  try {
    const raw = Deno.readTextFileSync(holderPath);
    const parsed = JSON.parse(raw) as HeavyGateHolder;
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.gate !== "string") {
      return { holder: null, alive: false };
    }
    let alive = true;
    try {
      Deno.kill(parsed.pid, 0); // signal 0: exists-and-visible check, never a kill
    } catch {
      alive = false;
    }
    return { holder: parsed, alive };
  } catch {
    return { holder: null, alive: false };
  }
}

function describeHolder(holder: HeavyGateHolder | null, alive: boolean): string {
  if (!holder) return "an unnamed holder (no announcement sidecar)";
  return `${holder.gate} (pid ${holder.pid}, started ${holder.startedAt}${alive ? "" : ", NOT RUNNING — stale sidecar"})`;
}

/** The refusal a harness must turn into exit 75 + the marker, never a red. */
export class HeavyGateSlotRefusedError extends Error {
  readonly holder: HeavyGateHolder | null;
  readonly holderAlive: boolean;
  readonly waitedMs: number;
  readonly gate: string;
  constructor(gate: string, holder: HeavyGateHolder | null, holderAlive: boolean, waitedMs: number, slotPath: string) {
    super(
      `ENVIRONMENT: the fleet-wide heavy-gate slot is busy (waited ${waitedMs} ms) — held by ` +
        `${describeHolder(holder, holderAlive)} [${slotPath}]. This gate did NOT start: it is an ` +
        `environmental verdict (exit ${ENVIRONMENTAL_REFUSAL_EXIT}), not a failure of the tree. ` +
        `Two load-sensitive gates must not share the machine (chrome-agent-platform-0lj3); ` +
        `wait for the holder to finish, or raise CAP_HEAVY_GATE_BOUND_MS deliberately.`,
    );
    this.name = "HeavyGateSlotRefusedError";
    this.gate = gate;
    this.holder = holder;
    this.holderAlive = holderAlive;
    this.waitedMs = waitedMs;
  }
}

/** The JSON a harness prints after the environmental marker. */
export function heavyGateRefusalPayload(err: HeavyGateSlotRefusedError): Record<string, unknown> {
  return {
    reason: "heavy-gate-slot-busy",
    gate: err.gate,
    waitedMs: err.waitedMs,
    holder: err.holder,
    holderAlive: err.holderAlive,
  };
}

/** Announce this process as the holder. Atomic (temp + rename) so a reader never
 *  sees a half-written file. Best effort: failing to announce must not fail the
 *  gate, but it must be visible, because an unannounced holder is one a refusing
 *  lane cannot name. */
function announceHolder(holderPath: string, holder: HeavyGateHolder): void {
  const tmp = `${holderPath}.${Deno.pid}.tmp`;
  try {
    Deno.writeTextFileSync(tmp, `${JSON.stringify(holder, null, 2)}\n`);
    Deno.renameSync(tmp, holderPath);
  } catch (e) {
    console.error(`heavy-gate: could not announce the holder (${String((e as Error)?.message ?? e)}) — refusals will say "unnamed holder"`);
    try { Deno.removeSync(tmp); } catch { /* best effort */ }
  }
}

function clearHolder(holderPath: string, pid: number): void {
  try {
    const raw = Deno.readTextFileSync(holderPath);
    const parsed = JSON.parse(raw) as HeavyGateHolder;
    // Only the holder clears its own announcement: a stale release from a lane
    // that already lost the slot must never erase the current holder's name.
    if (parsed?.pid === pid) Deno.removeSync(holderPath);
  } catch { /* nothing to clear */ }
}

/**
 * Take the fleet-wide heavy-gate slot, or refuse environmentally inside the
 * bound. The returned lease MUST be released (or the process may simply end —
 * the kernel drops the flock), so a gate never leaks the slot.
 */
export async function acquireHeavyGateSlot(opts: AcquireHeavyGateOptions): Promise<HeavyGateLease> {
  const noop: HeavyGateLease = { waitedMs: 0, waitedFor: null, disabled: true, release: () => {} };
  if (heavyGateDisabled()) {
    console.error(`heavy-gate: CAP_HEAVY_GATE_DISABLE=1 — ${opts.gate} runs WITHOUT the fleet slot (explicitly requested; never a green claim)`);
    return noop;
  }
  const { slotPath, holderPath } = slotPaths(opts);
  const holder: HeavyGateHolder = {
    gate: opts.gate,
    kind: opts.kind ?? "gate",
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    cwd: (() => { try { return Deno.cwd(); } catch { return "unknown"; } })(),
  };
  const waitMs = boundMs(opts);
  const t0 = Date.now();
  const holderAtStart = readHeavyGateHolder(holderPath);
  const say = opts.onWait ?? ((line: string) => console.error(line));
  const sayAcquired = opts.onAcquired ?? ((line: string) => console.error(line));

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("flock", {
      args: [
        "-w", String(Math.max(1, Math.ceil(waitMs / 1000))),
        slotPath,
        "sh", "-c",
        "echo CAP_HEAVY_GATE_ACQUIRED; exec cat >/dev/null",
      ],
      stdin: "piped",
      stdout: "piped",
      // stderr is CAPTURED, not discarded: it is how a setup failure (exit 66,
      // 'cannot open lock file') is told apart from contention (exit 1, silent,
      // after the whole bound). Reporting both as 'busy' sends a lane to wait for
      // a holder that does not exist.
      stderr: "piped",
    }).spawn();
  } catch (e) {
    throw new HeavyGateSlotSetupError(opts.gate, slotPath, `the flock helper could not start (${String((e as Error)?.message ?? e)})`);
  }
  // NOT unref'd. `child.unref()` was tried as insurance against the helper pinning
  // our event loop, and the exit drill was run against its removal: it stayed
  // GREEN, i.e. the unref is not what makes exit prompt — the cleared timer is.
  // An unpinned guard is worse than none (it reads as protection that no test
  // exercises), so it is not carried. If a future change makes the helper outlive
  // a release, pin it with a test FIRST and then add the unref.

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let announcedWait = false;
  const deadline = t0 + waitMs + 2000;
  let acquired = false;
  try {
    while (!seen.includes("CAP_HEAVY_GATE_ACQUIRED") && Date.now() < deadline) {
      if (!announcedWait) {
        announcedWait = true;
        say(
          `heavy-gate: ${opts.gate} waiting for the fleet-wide gate slot [${slotPath}] (bound ${waitMs} ms) — held by ` +
            `${describeHolder(holderAtStart.holder, holderAtStart.alive)}`,
        );
      }
      // ONE timer per read, CLEARED in the same breath. The first version left a
      // `setTimeout` of up to the whole bound pending on every iteration, so a
      // process that acquired and released promptly still could not exit until the
      // timer fired (review 2026-09-23: 'the acquisition timer survives release').
      let timer: ReturnType<typeof setTimeout> | undefined;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) => {
            timer = setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now()));
          }),
        ]);
      } catch {
        break;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (chunk.value) seen += decoder.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
    acquired = seen.includes("CAP_HEAVY_GATE_ACQUIRED");
  } finally {
    if (!acquired) {
      try { child.stdin.close(); } catch { /* already gone */ }
      try { reader.releaseLock(); } catch { /* released */ }
    }
  }

  if (!acquired) {
    const waitedMs = Date.now() - t0;
    // Why did we not get it? Wait for the helper's own verdict and read what it
    // said: 66 + 'cannot open lock file' is a SETUP fault; 1 (or still running
    // when our backstop deadline passed) is genuine contention.
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    // CLEARED IN A finally (k9i3): the clear used to sit on the success line after `await
    // child.status`, so a rejection on that await (the helper already reaped, ECHILD) left a
    // 1.5 s timer pending — the same shape as the acquisition timer this bead is about, and the
    // acceptance asks for the clear on success AND error. The acquisition timer above has been
    // cleared in a finally since the original 0lj3 landing (9811e07c); this is the one that was
    // still on the success path.
    let backstop: ReturnType<typeof setTimeout> | undefined;
    try {
      backstop = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1500);
      const status = await child.status;
      exitCode = status.code;
      exitSignal = status.signal;
    } catch { /* reaped */ } finally {
      if (backstop !== undefined) clearTimeout(backstop);
    }
    let errText = "";
    try {
      errText = (await new Response(child.stderr).text()).trim();
    } catch { /* no stderr to read */ }
    // WHAT CONTENTION LOOKS LIKE, MEASURED rather than pattern-matched (util-linux flock,
    // 2026-09-24). Every shape staged on this box:
    //   contention (held, -w elapsed): exit 1, stderr EMPTY
    //   missing parent dir / permission / read-only fs: exit 66 + "cannot open lock file …"
    //   invalid timeout:                               exit 64 + "invalid timeout: 'abc'"
    //   cannot execute the command:                    exit 69 + "failed to execute …"
    //   helper killed by a signal (OOM or our backstop): status.code = null, signal = SIGKILL
    // So contention is the STATUS PAIR — a quiet exit 1 (its own -w elapsed), or null-code killed
    // because our bound elapsed while it was still waiting. Everything else is a setup/system
    // fault, and this file already states the rule it was breaking: reporting a setup fault as
    // "busy" sends a lane to wait for a holder that does not exist, and blames a peer for it.
    // The previous version scanned stderr for /cannot open lock file|Permission denied|No such
    // file or directory/ or exit 66, which named the reviewer's bad-path case (missing parent)
    // correctly but still blamed a peer for exit 69 (exec failure), exit 64, or a killed helper.
    const quietTimeout = exitCode === 1 && errText === "";
    const killedWhileWaiting = exitCode === null && exitSignal === "SIGKILL";
    const contention = quietTimeout || killedWhileWaiting;
    if (!contention) {
      // Bounded diagnostics: the helper's own words are the real cause, kept short.
      const detail = errText || `the locking helper exited ${exitCode === null ? `on signal ${exitSignal ?? "unknown"}` : `with status ${exitCode}`}`;
      throw new HeavyGateSlotSetupError(opts.gate, slotPath, detail.slice(0, 300));
    }
    const now = readHeavyGateHolder(holderPath);
    throw new HeavyGateSlotRefusedError(opts.gate, now.holder ?? holderAtStart.holder, now.alive, waitedMs, slotPath);
  }

  const waitedMs = Date.now() - t0;
  // DRAIN the helper's stderr for the rest of its life. It is piped so a setup
  // fault can be diagnosed, but an unread pipe is a LIVE RESOURCE: leaving it
  // open kept the holder's own event loop alive after release, so a process that
  // acquired and released could not exit (found by the defect-1 drill, which hung
  // for exactly that reason). The buffer is bounded and only kept for diagnostics.
  (async () => {
    if (Deno.env.get("CAP_DIAG_NO_DRAIN") === "1") return;
    try {
      const errReader = child.stderr.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await errReader.read();
        if (done) break;
        if (value) dec.decode(value, { stream: true });
      }
    } catch { /* the helper went away; nothing to drain */ }
  })();
  announceHolder(holderPath, holder);
  sayAcquired(`heavy-gate: ${opts.gate} holds the fleet-wide gate slot [${slotPath}] (waited ${waitedMs} ms)`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearHolder(holderPath, Deno.pid);
    // Closing the holder's stdin is the release: `cat` sees EOF, flock exits and
    // the kernel drops the lock. The same EOF happens by itself if we die.
    try { child.stdin.close().catch(() => {}); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* released */ }
  };
  return { waitedMs, waitedFor: holderAtStart.holder, disabled: false, release };
}

/** Acquire, run, release — the shape a gate wants. The release runs even when
 *  `fn` throws, so a failed gate does not hold the fleet slot behind it. */
export async function withHeavyGateSlot<T>(
  opts: AcquireHeavyGateOptions,
  fn: (lease: HeavyGateLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireHeavyGateSlot(opts);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}

export { ENVIRONMENTAL_REFUSAL_EXIT, ENVIRONMENTAL_REFUSAL_MARKER };

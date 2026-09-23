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
  return { slotPath, holderPath: opts.slot?.holderPath ?? `${slotPath}.holder.json` };
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

  const child = new Deno.Command("flock", {
    args: [
      "-w", String(Math.max(1, Math.ceil(waitMs / 1000))),
      slotPath,
      "sh", "-c",
      "echo CAP_HEAVY_GATE_ACQUIRED; exec cat >/dev/null",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();

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
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => setTimeout(() => reject(new Error("slot wait bound")), Math.max(1, deadline - Date.now()))),
        ]);
      } catch {
        break;
      }
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
    acquired = seen.includes("CAP_HEAVY_GATE_ACQUIRED");
  } finally {
    if (!acquired) {
      try { child.stdin.close(); } catch { /* already gone */ }
      try { await child.status; } catch { /* reaped */ }
      try { reader.releaseLock(); } catch { /* released */ }
    }
  }

  if (!acquired) {
    const waitedMs = Date.now() - t0;
    const now = readHeavyGateHolder(holderPath);
    throw new HeavyGateSlotRefusedError(opts.gate, now.holder ?? holderAtStart.holder, now.alive, waitedMs, slotPath);
  }

  const waitedMs = Date.now() - t0;
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

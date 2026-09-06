// chrome-slots.ts — bounded concurrency for the Chrome gates.
// chrome-agent-platform-uzik
//
// Why this exists: `launchChrome()` used to take ONE canonical flock
// (/tmp/cap-serialized-chrome-acceptance.lock) for the whole machine, for the
// whole lifetime of every browser. That bought nothing: each launch already
// gets a kernel-assigned debugging port (the launcher asks for port 0 and reads
// the real endpoint back from that child's own stderr) and its own
// `--user-data-dir`, so two lanes driving two browsers cannot attach to each
// other. This module never spawns a browser — only `flock`; the single Chrome
// spawn path stays in chrome-launch.ts (tests/harness-debug-port.test.ts). What the exclusivity DID buy was a
// 20-minute queue: 57 KATs, 6 gates and 27 manual harnesses ran strictly one
// at a time, and a lane that never got the lock failed honestly for a reason
// that had nothing to do with the tree.
//
// The replacement is a semaphore, not a mutex: N slot files, one flock each,
// first free slot wins. N is a MEMORY bound, not a correctness bound — 32 test
// workers each launching a headless Chromium is how a box gets OOMed, so the
// default is 4 and it is env-tunable (`CAP_CHROME_MAX_CONCURRENT`).
//
// Properties that carry over from the lock, deliberately:
//   - BOUNDED: the wait is capped (`CAP_CHROME_LOCK_WAIT_MS`, 20 min default)
//     and a run that never gets a slot FAILS loudly. It is never turned green
//     and never silently skipped.
//   - HONEST: the wait is printed when it happens, with its length.
//   - CRASH-SAFE: a slot is held by a `flock` child whose stdin is the only
//     thing keeping it alive. Closing stdin releases it; if this process dies,
//     the kernel closes the pipe and drops the lock — no orphaned slot.
//   - NOT SELF-DEADLOCKING: a process that already holds the whole bound and
//     asks for another slot fails IMMEDIATELY instead of waiting for itself.
//
// Suites that genuinely need machine determinism (the security custody chain,
// whose evidence is about process groups and residue) opt into the exclusive
// canonical lock via `launchChrome({ canonicalLock: true })` — that path lives
// in chrome-launch.ts and is unchanged.
//
// Small cross-process coordination files stay on tmpfs on purpose (see
// scripts/lib/durable-root.mjs): a reboot clearing a stale slot is a feature.

/** Prefix of the per-slot lock files. `tests/durable-root.test.ts` allowlists
 *  the resulting literal; keep the two in step. */
export const CHROME_SLOT_FILE_PREFIX = "cap-chrome-slot-";

/** Default bound. The bead's own number ("max 3-4 concurrent chromes"): 4 keeps
 *  a full `npm test` parallel phase from OOMing the box while letting four lanes
 *  drive browsers at once. */
export const DEFAULT_MAX_CONCURRENT_CHROMES = 4;

/** Slots this process currently holds. Counting is the point: two browsers in
 *  one harness cost two slots, exactly like two browsers in two lanes. */
const heldSlots = new Set<number>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Where the slot files live. Read per call (NOT at module load) so a test can
 *  point the launcher at its own directory without the load-order trap that
 *  `CHROME_LOCK_PATH` has. */
export function slotDir(): string {
  return Deno.env.get("CAP_CHROME_SLOT_DIR") ?? "/tmp";
}

/** The lock file for slot `i`. A non-integer or negative index is a caller bug
 *  and is refused rather than turned into a path. */
export function slotFile(i: number): string {
  if (!Number.isInteger(i) || i < 0) throw new Error(`slotFile: not a slot index (${i})`);
  return `${slotDir()}/${CHROME_SLOT_FILE_PREFIX}${i}.lock`;
}

/** The concurrency bound, read per call. Unparsable → the default; anything
 *  below 1 → 1 (0 would deadlock every launch on the machine). */
export function maxConcurrentChromes(): number {
  const raw = Deno.env.get("CAP_CHROME_MAX_CONCURRENT");
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENT_CHROMES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT_CHROMES;
  return Math.max(1, Math.floor(parsed));
}

/** How long to wait for a slot. Shares the lock's env var on purpose: one knob
 *  for "how long will a browser gate queue before it fails". */
function waitMs(): number {
  const raw = Number(Deno.env.get("CAP_CHROME_LOCK_WAIT_MS") ?? 20 * 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60_000;
}

/** How many slots THIS process holds (for evidence and the deadlock guard). */
export function heldSlotCount(): number {
  return heldSlots.size;
}

const SLOT_MARKER = "CAP_CHROME_SLOT_ACQUIRED";

/**
 * Try to take one slot without blocking. Returns the live `flock` holder, or
 * null when the slot is busy. `flock -n` exits immediately if the file is
 * locked, so "no marker within the probe window" and "the child exited" both
 * mean busy.
 */
async function trySlot(file: string): Promise<Deno.ChildProcess | null> {
  let holder: Deno.ChildProcess;
  try {
    holder = new Deno.Command("flock", {
      args: ["-n", file, "sh", "-c", `echo ${SLOT_MARKER}; exec cat >/dev/null`],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    return null; // no flock on this box — the caller's honest failure follows
  }
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 2000;
  let seen = "";
  let got = false;
  while (!got && Date.now() < deadline) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await withTimeout(reader.read(), Math.max(1, deadline - Date.now()));
    } catch {
      break;
    }
    if (chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
    if (seen.includes(SLOT_MARKER)) got = true;
  }
  try { reader.releaseLock(); } catch { /* already released */ }
  if (!got) {
    try { await holder.stdin.close(); } catch { /* already closed */ }
    try { holder.kill("SIGKILL"); } catch { /* gone */ }
    try { await holder.status; } catch { /* reaped */ }
    return null;
  }
  // The holder prints nothing more; drain so its stdout never blocks.
  (async () => { try { for await (const _ of holder.stdout) { /* drain */ } } catch { /* gone */ } })();
  return holder;
}

export interface ChromeSlot {
  /** Which slot this launch took, or -1 when the semaphore was bypassed. */
  slot: number;
  /** How long the acquisition queued (0 when a slot was free). */
  waitedMs: number;
  /** Release the slot. Idempotent. */
  release: () => void;
}

/**
 * Take one Chrome slot for the lifetime of a browser.
 *
 * Bypassed (slot -1, no wait) when the caller is already serialized by
 * something stronger: the security supervisor holds the canonical lock and
 * passes `CAP_SECURITY_NONCE`, and a runner that holds the lock itself sets
 * `CAP_CHROME_LOCK_HELD=1`. Those lanes must not consume the machine's browser
 * budget on top of their own exclusivity.
 */
export async function acquireChromeSlot(): Promise<ChromeSlot> {
  const noop = () => {};
  if (Deno.env.get("CAP_SECURITY_NONCE") || Deno.env.get("CAP_CHROME_LOCK_HELD") === "1") {
    return { slot: -1, waitedMs: 0, release: noop };
  }
  const max = maxConcurrentChromes();
  if (heldSlots.size >= max) {
    throw new Error(
      `launchChrome: this process already holds all ${max} Chrome slot(s) — refusing to wait for itself. ` +
        `Raise CAP_CHROME_MAX_CONCURRENT above ${max} to run more browsers in one process.`,
    );
  }
  const bound = waitMs();
  const t0 = Date.now();
  const deadline = t0 + bound;
  // Rotate the probe order so N lanes arriving together do not all hammer slot
  // 0 first (flock is not FIFO; this is the cheap fairness we can get).
  let attempt = (Deno.pid + heldSlots.size) % Math.max(1, max);
  let noticed = false;
  for (;;) {
    for (let n = 0; n < max; n++) {
      const index = (attempt + n) % max;
      if (heldSlots.has(index)) continue;
      const file = slotFile(index);
      const holder = await trySlot(file);
      if (!holder) continue;
      heldSlots.add(index);
      const release = () => {
        if (!heldSlots.has(index)) return; // idempotent
        heldSlots.delete(index);
        // Closing stdin is the release: `cat` sees EOF, the shell exits, flock
        // exits, the kernel drops the lock. The same EOF happens by itself when
        // this process dies, so a crashed harness never leaves a slot held.
        try { holder.stdin.close().catch(() => {}); } catch { /* already closed */ }
      };
      // A holder that dies on its own (killed flock) frees the slot too.
      holder.status.then(() => { heldSlots.delete(index); }).catch(() => {});
      const waitedMs = Date.now() - t0;
      if (waitedMs > 1500) {
        console.error(`launchChrome: took Chrome slot ${index} after ${waitedMs} ms (bound ${max})`);
      }
      // A runner that budgets a harness (scripts/lib/lock-aware-command.ts) must
      // not charge the harness for time spent QUEUEING for a slot — that is how
      // load-dependent reds get mistaken for product reds. Opt in with
      // CAP_CHROME_SLOT_MARKER=1 and the acquisition prints one line on stderr
      // (never stdout: harnesses print their own structured results there).
      if (Deno.env.get("CAP_CHROME_SLOT_MARKER") === "1") {
        console.error(`CAP_CHROME_GATE_ACQUIRED slot=${index} waitedMs=${waitedMs}`);
      }
      return { slot: index, waitedMs, release };
    }
    const elapsed = Date.now() - t0;
    if (elapsed >= bound) break;
    if (!noticed && elapsed > 1500) {
      noticed = true;
      console.error(
        `launchChrome: waiting for a Chrome slot — all ${max} are busy ` +
          `(CAP_CHROME_MAX_CONCURRENT=${max}, waited ${elapsed} ms)`,
      );
    }
    attempt = (attempt + 1) % Math.max(1, max);
    // Back off: probing every slot costs a flock spawn each, and a busy box
    // does not need 32 workers spinning on it.
    await new Promise((r) => setTimeout(r, Math.min(500, 100 + elapsed / 20)));
  }
  throw new Error(
    `launchChrome: could not take a Chrome slot within ${bound} ms ` +
      `(all ${max} CAP_CHROME_MAX_CONCURRENT slots in ${slotDir()} are held by other browsers). ` +
      "Not started — a run that cannot get the browser is a failed run, not a skipped one.",
  );
}

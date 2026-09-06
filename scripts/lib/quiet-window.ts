// quiet-window.ts — let load-sensitive Chrome gates wait for a quiet box, or
// refuse loudly, instead of failing mid-run and reading as a product red.
// chrome-agent-platform-mkax
//
// The evidence this exists for is chrome-agent-platform-eo4d.1's own run
// history: the journey gate reached 59/370 and later 250/370 and then died on
// `cdp timeout: Runtime.evaluate`, with machine load >7 from other lanes'
// imageops/esbuild and Rust/Wasm compilation; it passed 370/370 only in an
// uninterrupted quiet window. That red says nothing about the tree, and it
// costs a whole gate run each time.
//
// The machine-wide Chrome lock that used to serialize every harness did NOT
// prevent this — it excluded other CAP browsers, never other lanes' compilers
// (chrome-agent-platform-uzik retired it for exactly that reason). So the fix
// is not a lock: it is a measurement.
//
// Contract:
//   - MEASURE: 1-minute loadavg per core, plus a count of heavy compiler/build
//     processes. Both from /proc, no dependencies.
//   - WAIT: bounded (CAP_QUIET_WAIT_MS), sampled (CAP_QUIET_SAMPLE_MS), and the
//     quiet has to be SUSTAINED (CAP_QUIET_SUSTAINED consecutive samples) — a
//     one-sample dip must not start a ten-minute run that then starves.
//   - HONEST: every wait is printed with its length and the numbers behind it.
//   - FAIL CLOSED: if the box cannot be measured, the verdict is a refusal. An
//     unmeasurable machine is never assumed quiet.
//   - NEVER a product red: a refusal is a distinct verdict (`ok: false`, an
//     `ENVIRONMENT:`-prefixed message, and exit 75 / EX_TEMPFAIL at the
//     harness), so nobody reads it as a defect in the tree.
//   - NEVER destructive: this measures and waits. It does not kill, renice, or
//     otherwise interfere with another lane's processes to make a window quiet.
//
// Tunables (all env-overridable, all read per call so a runner can change them
// without a module-reload order trap):
//   CAP_QUIET_MAX_LOAD_PER_CORE  default 0.35  (load1 / cores)
//   CAP_QUIET_MAX_COMPILERS      default 1     (heavy build processes)
//   CAP_QUIET_WAIT_MS            default 600000
//   CAP_QUIET_SAMPLE_MS          default 2000
//   CAP_QUIET_SUSTAINED          default 3

/** Process names that mean "somebody is compiling or imaging right now".
 *  Deliberately conservative: a browser, a deno/node test worker or an editor
 *  is NOT heavy in the sense that starves CDP — compilers and image pipelines
 *  are what eo4d.1 measured. */
export const HEAVY_PROCESS_NAMES = new Set([
  "rustc", "cargo", "cc1", "cc1plus", "gcc", "g++", "clang", "clang++",
  "ld", "ld.lld", "lld", "gold", "wasm-ld", "wasm-opt", "wasm-mutate",
  "esbuild", "ninja", "make", "magick", "convert", "ffmpeg", "tsc",
]);

/** How many /proc entries one sample will inspect, and for how long. A sample
 *  must stay cheap: it runs every CAP_QUIET_SAMPLE_MS while a gate waits. */
const MAX_PROC_SCAN = 4096;
const MAX_PROC_SCAN_MS = 400;

export interface LoadSample {
  /** Epoch ms. */
  at: number;
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  loadPerCore: number;
  /** Count of HEAVY_PROCESS_NAMES processes (excluding this process's pid). */
  compilers: number;
  /** The names seen, de-duplicated and bounded — evidence, not a process list. */
  compilerNames: string[];
  /** True when the sample could not be read; a refusal follows, never a pass. */
  measurable: boolean;
  /** Why it was not measurable. */
  error?: string;
}

export interface QuietSpec {
  maxLoadPerCore?: number;
  maxCompilers?: number;
  maxWaitMs?: number;
  sampleMs?: number;
  sustainedSamples?: number;
}

export type QuietVerdict =
  | { ok: true; waitedMs: number; samples: LoadSample[]; spec: ResolvedSpec }
  | {
    ok: false;
    /** `timeout` = the box never got quiet inside the bound. `unmeasurable` =
     *  we could not read the load, so we will not claim it is quiet. */
    reason: "timeout" | "unmeasurable";
    waitedMs: number;
    samples: LoadSample[];
    spec: ResolvedSpec;
    /** The numbers at refusal, for the evidence line. */
    last: LoadSample | null;
  };

export interface ResolvedSpec {
  maxLoadPerCore: number;
  maxCompilers: number;
  maxWaitMs: number;
  sampleMs: number;
  sustainedSamples: number;
}

/** The refusal error a harness must turn into an environmental verdict, never a
 *  product red. */
export class QuietWindowRefusedError extends Error {
  readonly reason: "timeout" | "unmeasurable";
  readonly sample: LoadSample | null;
  readonly spec: ResolvedSpec;
  readonly waitedMs: number;
  constructor(verdict: QuietVerdict & { ok: false }) {
    super(
      `ENVIRONMENT: machine is not quiet enough for this gate ` +
        `(${verdict.reason === "unmeasurable"
          ? `load could not be measured: ${verdict.last?.error ?? "unknown"}`
          : `waited ${verdict.waitedMs} ms, still ${describe(verdict.last, verdict.spec)}`}). ` +
        `Not started — this is an environmental refusal (exit 75), not a failure of the tree. ` +
        `Thresholds: ${formatSpec(verdict.spec)}. Raise them or quiet the box; ` +
        `do not relabel this as a product red.`,
    );
    this.name = "QuietWindowRefusedError";
    this.reason = verdict.reason;
    this.sample = verdict.last;
    this.spec = verdict.spec;
    this.waitedMs = verdict.waitedMs;
  }
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function resolveSpec(spec: QuietSpec = {}): ResolvedSpec {
  return {
    maxLoadPerCore: num(
      spec.maxLoadPerCore?.toString() ?? Deno.env.get("CAP_QUIET_MAX_LOAD_PER_CORE") ?? undefined,
      0.35,
    ),
    maxCompilers: num(
      spec.maxCompilers?.toString() ?? Deno.env.get("CAP_QUIET_MAX_COMPILERS") ?? undefined,
      1,
    ),
    maxWaitMs: num(
      spec.maxWaitMs?.toString() ?? Deno.env.get("CAP_QUIET_WAIT_MS") ?? undefined,
      600_000,
    ),
    sampleMs: Math.max(
      50,
      num(spec.sampleMs?.toString() ?? Deno.env.get("CAP_QUIET_SAMPLE_MS") ?? undefined, 2000),
    ),
    sustainedSamples: Math.max(
      1,
      Math.floor(num(spec.sustainedSamples?.toString() ?? Deno.env.get("CAP_QUIET_SUSTAINED") ?? undefined, 3)),
    ),
  };
}

export function formatSpec(spec: ResolvedSpec): string {
  return `load1/core<=${spec.maxLoadPerCore}, heavy-builders<=${spec.maxCompilers}, ` +
    `sustained=${spec.sustainedSamples}x${spec.sampleMs}ms, bound=${spec.maxWaitMs}ms`;
}

/** The compact evidence line attached to a refusal or to a wait notice. */
export function environmentLine(sample: LoadSample | null, spec?: ResolvedSpec): string {
  if (!sample) return "environment: no sample";
  if (!sample.measurable) return `environment: unmeasurable (${sample.error ?? "unknown"})`;
  const base = `load1=${sample.load1.toFixed(2)} load5=${sample.load5.toFixed(2)} ` +
    `cores=${sample.cores} load/core=${sample.loadPerCore.toFixed(2)} ` +
    `heavy-builders=${sample.compilers}` +
    (sample.compilerNames.length ? `[${sample.compilerNames.join(",")}]` : "");
  return spec ? `${base} (threshold ${formatSpec(spec)})` : base;
}

function describe(sample: LoadSample | null, spec: ResolvedSpec): string {
  return environmentLine(sample, spec);
}

/** Read one sample. Never throws: an unreadable /proc becomes
 *  `measurable: false`, which fails closed downstream. */
export async function readLoadSample(): Promise<LoadSample> {
  const at = Date.now();
  const cores = Math.max(1, navigator.hardwareConcurrency || 1);
  let load1 = NaN, load5 = NaN, load15 = NaN;
  try {
    const raw = (await Deno.readTextFile("/proc/loadavg")).trim();
    const parts = raw.split(/\s+/u);
    load1 = Number(parts[0]);
    load5 = Number(parts[1]);
    load15 = Number(parts[2]);
    if (![load1, load5, load15].every((n) => Number.isFinite(n))) {
      throw new Error(`malformed /proc/loadavg: ${raw.slice(0, 60)}`);
    }
  } catch (e) {
    return {
      at, load1: 0, load5: 0, load15: 0, cores, loadPerCore: Infinity,
      compilers: 0, compilerNames: [], measurable: false,
      error: String((e as Error)?.message ?? e),
    };
  }
  // Heavy builders: a bounded /proc walk. Names only (never arguments), so this
  // is not a process inventory of other lanes' work — just a count.
  let compilers = 0;
  const names = new Set<string>();
  const selfPid = String(Deno.pid);
  try {
    let seen = 0;
    const startedAt = Date.now();
    for await (const entry of Deno.readDir("/proc")) {
      if (seen >= MAX_PROC_SCAN || Date.now() - startedAt > MAX_PROC_SCAN_MS) break;
      if (!entry.isDirectory || !/^\d+$/u.test(entry.name) || entry.name === selfPid) continue;
      seen++;
      try {
        const comm = (await Deno.readTextFile(`/proc/${entry.name}/comm`)).trim();
        if (HEAVY_PROCESS_NAMES.has(comm)) {
          compilers++;
          if (names.size < 8) names.add(comm);
        }
      } catch { /* a process that exited mid-scan is not an error */ }
    }
  } catch (e) {
    return {
      at, load1, load5, load15, cores, loadPerCore: load1 / cores,
      compilers: 0, compilerNames: [], measurable: false,
      error: `proc scan: ${String((e as Error)?.message ?? e)}`,
    };
  }
  return {
    at, load1, load5, load15, cores, loadPerCore: load1 / cores,
    compilers, compilerNames: [...names], measurable: true,
  };
}

/** Is this sample quiet? Returns the reasons it is not, so a wait notice can
 *  say WHAT is holding the gate, not just that it is waiting. */
export function quietReasons(sample: LoadSample, spec: ResolvedSpec): string[] {
  if (!sample.measurable) return [`unmeasurable: ${sample.error ?? "unknown"}`];
  const reasons: string[] = [];
  if (sample.loadPerCore > spec.maxLoadPerCore) {
    reasons.push(`load/core ${sample.loadPerCore.toFixed(2)} > ${spec.maxLoadPerCore}`);
  }
  if (sample.compilers > spec.maxCompilers) {
    reasons.push(`heavy-builders ${sample.compilers} > ${spec.maxCompilers}` +
      (sample.compilerNames.length ? ` (${sample.compilerNames.join(",")})` : ""));
  }
  return reasons;
}

export function isQuiet(sample: LoadSample, spec: ResolvedSpec): boolean {
  return quietReasons(sample, spec).length === 0;
}

/**
 * Wait for a sustained quiet window. Injecting `sample` makes this testable
 * without manufacturing machine load; production uses `readLoadSample`.
 */
export async function awaitQuietWindow(
  spec: QuietSpec = {},
  hooks: {
    sample?: () => Promise<LoadSample>;
    notice?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<QuietVerdict> {
  const resolved = resolveSpec(spec);
  const take = hooks.sample ?? readLoadSample;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = hooks.now ?? (() => Date.now());
  const say = hooks.notice ?? ((line: string) => console.error(line));

  const t0 = now();
  const deadline = t0 + resolved.maxWaitMs;
  const samples: LoadSample[] = [];
  let streak = 0;
  let noticed = false;
  let lastNotice = t0;
  let unmeasurableStreak = 0;

  for (;;) {
    let sample: LoadSample;
    try {
      sample = await take();
    } catch (e) {
      sample = {
        at: now(), load1: 0, load5: 0, load15: 0, cores: 1, loadPerCore: Infinity,
        compilers: 0, compilerNames: [], measurable: false,
        error: String((e as Error)?.message ?? e),
      };
    }
    samples.push(sample);
    if (samples.length > 64) samples.shift(); // bounded: a long wait is not a leak

    if (!sample.measurable) {
      // Fail closed, but not on a single blip: a sample that cannot be read
      // three times in a row is an environment we will not run in.
      unmeasurableStreak++;
      if (unmeasurableStreak >= Math.min(3, resolved.sustainedSamples)) {
        return {
          ok: false, reason: "unmeasurable", waitedMs: now() - t0,
          samples, spec: resolved, last: sample,
        };
      }
    } else {
      unmeasurableStreak = 0;
    }

    const reasons = quietReasons(sample, resolved);
    if (reasons.length === 0) {
      streak++;
      if (streak >= resolved.sustainedSamples) {
        const waitedMs = now() - t0;
        if (waitedMs > 1000) {
          say(`quiet-window: box quiet after ${waitedMs} ms — ${environmentLine(sample, resolved)}`);
        }
        return { ok: true, waitedMs, samples, spec: resolved };
      }
    } else {
      streak = 0;
      if (!noticed) {
        noticed = true;
        say(`quiet-window: waiting for a quiet box (bound ${resolved.maxWaitMs} ms) — ${reasons.join("; ")}`);
      } else if (now() - lastNotice >= 30_000) {
        lastNotice = now();
        say(`quiet-window: still waiting (${now() - t0} ms) — ${reasons.join("; ")}`);
      }
    }

    if (now() >= deadline) {
      return {
        ok: false, reason: "timeout", waitedMs: now() - t0,
        samples, spec: resolved, last: sample,
      };
    }
    await sleep(resolved.sampleMs);
  }
}

/**
 * The one call a load-sensitive harness needs: wait for a quiet window, or
 * throw the refusal error it must turn into exit 75 + an `ENVIRONMENT:` line.
 */
export async function requireQuietWindow(
  spec: QuietSpec = {},
  hooks: Parameters<typeof awaitQuietWindow>[1] = {},
): Promise<{ waitedMs: number; sample: LoadSample | null }> {
  const verdict = await awaitQuietWindow(spec, hooks);
  if (verdict.ok) {
    return { waitedMs: verdict.waitedMs, sample: verdict.samples[verdict.samples.length - 1] ?? null };
  }
  throw new QuietWindowRefusedError(verdict);
}

/** The exit code a harness uses for an environmental refusal. Distinct from 0
 *  (green) and 1 (a product red) so no aggregator can confuse them. */
export const ENVIRONMENTAL_REFUSAL_EXIT = 75;

/** The marker line an aggregator can grep to classify a refusal. */
export const ENVIRONMENTAL_REFUSAL_MARKER = "CAP_ENVIRONMENTAL_REFUSAL";

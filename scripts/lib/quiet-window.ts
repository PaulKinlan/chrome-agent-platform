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
//
//     chrome-agent-platform-dnop: the compiler count is a count of COMPILING
//     processes, not of process names. A name-only match counted the long-lived
//     esbuild SERVICE that Vite keeps open for its dev server as a build, so
//     three parked daemons (measured aged 1d14h, 2d00h, 3d02h, owned by other
//     lanes' `vite`/`isocan serve`, CPU time flat across a 10 s sample while
//     load/core sat at 0.056) held the journey gate closed on a completely idle
//     machine — for as long as those dev servers live, which can be days. That
//     is not what this file is for: line 42's own rule is that a heavy process
//     is one that STARVES CDP, and a daemon that is not compiling starves
//     nothing. Browsers and test workers are already excluded for exactly that
//     reason; a parked compiler now joins them.
//     The threshold therefore applies to `activeCompilers` — heavy-named
//     processes whose accumulated CPU ADVANCED since the previous sample, or
//     which we have never seen before (fail closed: a build already running
//     when the gate starts must still block it). `compilers`/`compilerNames`
//     stay as the name-match evidence, so a refusal line still names what is on
//     the box.
//     Honest limit, stated: a build that is I/O-blocked for a whole sample
//     shows no CPU in that sample and would not count as active for it — but
//     the quiet still has to SUSTAIN across consecutive samples, so a run can
//     only start after several seconds in which the build consumed no CPU at
//     all, which is not a build starving a CDP run.
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
 *  must stay cheap: it runs every CAP_QUIET_SAMPLE_MS while a gate waits.
 *  Env-overridable so a TRUNCATED walk can be driven in a test
 *  (chrome-agent-platform-1io9) and so an operator can raise the bound
 *  deliberately on a box that really has thousands of processes. */
const MAX_PROC_SCAN = 4096;
const MAX_PROC_SCAN_MS = 400;

/** The per-sample /proc budget, read per call (same rule as the other tunables:
 *  no module-reload order trap). */
function procScanBudget(): { entries: number; ms: number } {
  const entries = Number(Deno.env.get("CAP_QUIET_MAX_PROC_SCAN"));
  const ms = Number(Deno.env.get("CAP_QUIET_MAX_PROC_SCAN_MS"));
  return {
    entries: Number.isFinite(entries) && entries > 0 ? entries : MAX_PROC_SCAN,
    ms: Number.isFinite(ms) && ms >= 0 ? ms : MAX_PROC_SCAN_MS,
  };
}

export interface LoadSample {
  /** Epoch ms. */
  at: number;
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  loadPerCore: number;
  /** Count of HEAVY_PROCESS_NAMES processes (excluding this process's pid) —
   *  the NAME MATCH. Evidence, and the conservative superset of the builders
   *  below: it includes parked services that are not compiling anything. */
  compilers: number;
  /** The names seen, de-duplicated and bounded — evidence, not a process list. */
  compilerNames: string[];
  /** Of the name matches, the ones actually COMPILING: their accumulated CPU
   *  advanced since the previous sample, or this is the first time we have seen
   *  them (fail closed). THIS is what the threshold counts. `undefined` means
   *  the sample carries no activity information — callers that build a sample
   *  by hand get the fail-closed reading (see `quietReasons`). */
  activeCompilers?: number;
  /** Names of the active builders (bounded, de-duplicated). */
  activeCompilerNames?: string[];
  /** Per-pid CPU snapshot, for the next sample's activity comparison. */
  cpu?: ProcCpuMap;
  /** True when the sample could not be read; a refusal follows, never a pass. */
  measurable: boolean;
  /** Why it was not measurable. */
  error?: string;
}

/** One heavy-named process's identity and accumulated CPU, from /proc/<pid>/stat.
 *  `startTicks` (field 22) is what makes the reading safe across pid reuse: a
 *  pid whose start time changed is a DIFFERENT process, never a huge delta. */
export interface ProcCpu {
  name: string;
  startTicks: string;
  cpuTicks: number;
}

/** utime+stime and starttime from /proc/<pid>/stat (fields 14, 15 and 22).
 *  The comm is bracketed and may itself contain spaces and parentheses, so the
 *  parse starts after the LAST ')': field 3 is then index 0, making utime 11,
 *  stime 12 and starttime 19. Exported for the unit tests — a misparse here
 *  would silently classify every build as idle, which is the dnop bug again
 *  with the arithmetic instead of the name. */
export function parseProcStatCpu(stat: string, name = ""): ProcCpu | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/u);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { name, startTicks: String(rest[19] ?? ""), cpuTicks: utime + stime };
}

export type ProcCpuMap = Map<string, ProcCpu>;

/** Pure: which heavy-named pids are COMPILING?
 *
 *  A process is active when its accumulated CPU (utime+stime) advanced since the
 *  previous sample. With no previous reading for a pid — the gate's first
 *  sample, or a process that just appeared — it is active: fail closed, because
 *  a build already running when the gate starts must still hold it shut. A pid
 *  whose start time changed is a different process and is active for the same
 *  reason. Pids that vanished are simply absent from `curr`.
 *
 *  Exported so the rule is unit-testable without manufacturing machine load. */
export function classifyActiveBuilders(prev: ProcCpuMap | null | undefined, curr: ProcCpuMap | null | undefined): string[] {
  if (!curr) return []; // no reading at all: nothing to call active (unmeasurable samples refuse separately)
  const active: string[] = [];
  for (const [pid, now] of curr) {
    const before = prev?.get(pid);
    if (!before || before.startTicks !== now.startTicks || now.cpuTicks > before.cpuTicks) {
      active.push(pid);
    }
  }
  return active;
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
    (sample.activeCompilers !== undefined ? ` active=${sample.activeCompilers}` : "") +
    (sample.compilerNames.length ? `[${sample.compilerNames.join(",")}]` : "");
  return spec ? `${base} (threshold ${formatSpec(spec)})` : base;
}

function describe(sample: LoadSample | null, spec: ResolvedSpec): string {
  return environmentLine(sample, spec);
}

/** Read one sample. Never throws: an unreadable /proc becomes
 *  `measurable: false`, which fails closed downstream. */
export async function readLoadSample(prev?: ProcCpuMap | null): Promise<LoadSample> {
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
  // is not a process inventory of other lanes' work — just a count. For a name
  // match we also read the accumulated CPU, so the threshold can count what is
  // COMPILING rather than what is merely named (dnop).
  let compilers = 0;
  const names = new Set<string>();
  const cpu: ProcCpuMap = new Map();
  const selfPid = String(Deno.pid);
  try {
    let seen = 0;
    // 1io9: a TRUNCATED walk must not read as a quiet box. The first version
    // returned the partial count, so a real compiler the walk never reached was
    // reported as zero builders and the gate opened under a build — the exact
    // defect class this file exists to prevent, one level down. Truncation is
    // therefore carried out of the loop and turned into an UNMEASURABLE sample
    // (the module's contract: an unmeasurable box is a refusal, never an
    // assumed quiet one).
    let truncated = false;
    const startedAt = Date.now();
    const budget = procScanBudget();
    for await (const entry of Deno.readDir("/proc")) {
      if (seen >= budget.entries || Date.now() - startedAt > budget.ms) {
        truncated = true;
        break;
      }
      if (!entry.isDirectory || !/^\d+$/u.test(entry.name) || entry.name === selfPid) continue;
      seen++;
      try {
        const comm = (await Deno.readTextFile(`/proc/${entry.name}/comm`)).trim();
        if (HEAVY_PROCESS_NAMES.has(comm)) {
          compilers++;
          if (names.size < 8) names.add(comm);
          const parsed = parseProcStatCpu(await Deno.readTextFile(`/proc/${entry.name}/stat`), comm);
          if (parsed) cpu.set(entry.name, parsed);
        }
      } catch { /* a process that exited mid-scan is not an error */ }
    }
    if (truncated) {
      return {
        at, load1, load5, load15, cores, loadPerCore: load1 / cores,
        // The partial counts stay as evidence: a reader can see what the walk did
        // reach before it was cut off.
        compilers, compilerNames: [...names], measurable: false,
        error: `proc scan truncated after ${seen} entries in ${Date.now() - startedAt} ms ` +
          `(budget ${budget.entries} entries / ${budget.ms} ms) — the builder count is INCOMPLETE, ` +
          `so this sample is NOT a quiet verdict; raise CAP_QUIET_MAX_PROC_SCAN(_MS) deliberately ` +
          `if this box really has that many processes (chrome-agent-platform-1io9)`,
      };
    }
  } catch (e) {
    return {
      at, load1, load5, load15, cores, loadPerCore: load1 / cores,
      compilers: 0, compilerNames: [], measurable: false,
      error: `proc scan: ${String((e as Error)?.message ?? e)}`,
    };
  }
  const activePids = classifyActiveBuilders(prev ?? null, cpu);
  const activeNames = [...new Set(activePids.map((pid) => cpu.get(pid)?.name ?? "").filter(Boolean))];
  return {
    at, load1, load5, load15, cores, loadPerCore: load1 / cores,
    compilers, compilerNames: [...names], measurable: true,
    activeCompilers: activePids.length,
    activeCompilerNames: activeNames.slice(0, 8),
    cpu,
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
  // dnop: the threshold counts COMPILING processes. A sample that carries no
  // activity information (hand-built, or an older caller) is read fail-closed
  // against its name match — an unknown must never be treated as quiet.
  const active = sample.activeCompilers ?? sample.compilers;
  const activityKnown = sample.activeCompilers !== undefined;
  if (active > spec.maxCompilers) {
    reasons.push(`active heavy-builders ${active} > ${spec.maxCompilers}` +
      (sample.compilerNames.length
        ? ` (named: ${sample.compilerNames.join(",")}` +
          (activityKnown
            ? (sample.activeCompilerNames?.length ? `; compiling: ${sample.activeCompilerNames.join(",")}` : "; none compiling")
            : "; activity unknown — counted fail-closed") + ")"
        : ""));
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
    // The sampler receives the previous sample's CPU snapshot so it can tell a
    // compiling process from a parked service (dnop). Injectable for tests.
    sample?: (prev?: ProcCpuMap | null) => Promise<LoadSample>;
    notice?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<QuietVerdict> {
  const resolved = resolveSpec(spec);
  let prevCpu: ProcCpuMap | null = null;
  const take = async (): Promise<LoadSample> => {
    const s = hooks.sample ? await hooks.sample(prevCpu) : await readLoadSample(prevCpu);
    // Carry the CPU snapshot forward: the NEXT sample's activity comparison
    // needs it, and the injected sampler (tests) may not supply one.
    if (s.cpu) prevCpu = s.cpu;
    return s;
  };
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

/**
 * chrome-agent-platform-qk7p: a journeys `Runtime.evaluate` that exceeds the
 * CDP budget is an ENVIRONMENTAL verdict, not a product red. Measured
 * (cap-beads-qk7p): in a full 370/370 instrumented run at fleet density every
 * CDP call completed in under 1 s, while the abort runs each showed a single
 * >30 s evaluate at a varying position (278/229/229/195/159 of 370) — the tail
 * is a cliff under concurrent-lane load, not a distribution a larger budget
 * can be sized from. The harness maps this error class to the environmental
 * refusal verdict (exit 75 + marker) AFTER owner-clean shutdown.
 */
export function isCdpEvaluateTimeout(message: string): boolean {
  return /cdp timeout: Runtime\.evaluate/.test(String(message ?? ""));
}

/** The marker line an aggregator can grep to classify a refusal. */
export const ENVIRONMENTAL_REFUSAL_MARKER = "CAP_ENVIRONMENTAL_REFUSAL";

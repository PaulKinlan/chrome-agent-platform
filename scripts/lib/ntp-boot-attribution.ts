// scripts/lib/ntp-boot-attribution.ts — chrome-agent-platform-mujlt
// Attribution and load classification for NTP boot staging long tasks (9epn.2).

import {
  environmentLine,
  readLoadSample,
  type LoadSample,
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  ZERO_TICK_ACTIVE_BUILDERS,
  isZeroTickActiveBuilder,
} from "./quiet-window.ts";

export {
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  ZERO_TICK_ACTIVE_BUILDERS,
  isZeroTickActiveBuilder,
};

/**
 * Known background services and watchers that run as idle daemons and accumulate 0 CPU ticks
 * when not actively serving requests or compiling changes (chrome-agent-platform-0om0o).
 *
 * Parked-daemon suppression across boot intervals is strictly restricted to this set.
 * One-off or discrete build invocations (gcc, clang, rustc, cargo, make, ninja) can never
 * be suppressed as parked services.
 */
export const KNOWN_PARKABLE_BUILDERS = new Set([
  "esbuild",
  "tsc",
  "cargo-watch",
]);

export class BootStagingEnvironmentalRefusalError extends Error {
  readonly exitCode = ENVIRONMENTAL_REFUSAL_EXIT;
  readonly marker = ENVIRONMENTAL_REFUSAL_MARKER;
  readonly runs: BootStagingRunResult[];

  constructor(runs: BootStagingRunResult[], detail: string) {
    super(
      `ENVIRONMENT: ntp-boot-staging refusal — ${detail} (exit ${ENVIRONMENTAL_REFUSAL_EXIT}). ` +
        `All measurements were taken under host contention; refusing measurement rather than reporting false green or false red.`,
    );
    this.name = "BootStagingEnvironmentalRefusalError";
    this.runs = runs;
  }
}

export interface RawLongTaskAttribution {
  name?: string;
  containerType?: string;
  containerSrc?: string;
  containerId?: string;
  containerName?: string;
}

export interface RawLongTaskEntry {
  entryType?: string;
  name?: string;
  duration: number;
  startTime: number;
  attribution?: RawLongTaskAttribution[];
}

export interface RawLoafScriptEntry {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  duration: number;
  executionStart: number;
  forcedStyleAndLayoutDuration?: number;
}

export interface RawLoafEntry {
  entryType?: string;
  duration: number;
  startTime: number;
  renderDuration?: number;
  styleAndLayoutDuration?: number;
  scripts?: RawLoafScriptEntry[];
}

export interface RawBootPageMetrics {
  composerReadyStartMs?: number | null;
  composerReadyDurationMs?: number | null;
  composerReadyEndMs?: number | null;
  threadListHydratedStartMs?: number | null;
  threadListHydratedDurationMs?: number | null;
  threadListHydratedEndMs?: number | null;
  longTasks: RawLongTaskEntry[];
  loafEntries?: RawLoafEntry[];
  measureNames?: string[];
}

export interface AttributedLongTask {
  durationMs: number;
  startTimeMs: number;
  phase: "stage1-composer" | "stage2-hydration" | "post-boot-quiescence";
  name: string;
  containerType?: string;
  containerSrc?: string;
  scriptUrl?: string;
  functionName?: string;
  invoker?: string;
  invokerType?: string;
  charPosition?: number;
  forcedStyleAndLayoutMs?: number;
}

export interface BootStagingRunResult {
  run: number;
  composerReadyMs: number | null;
  composerReadyEndMs: number | null;
  threadListHydratedMs: number | null;
  threadListHydratedEndMs: number | null;
  longTasks: AttributedLongTask[];
  marginalBreaches: AttributedLongTask[];
  severeBreaches: AttributedLongTask[];
  hostEnvironment: string;
  hostLoaded: boolean;
  validMeasurement: boolean;
  invalidReason?: string;
}

/**
 * Script injected via Page.addScriptToEvaluateOnNewDocument before document execution.
 * Observes both standard PerformanceLongTaskTiming ('longtask') and
 * Modern Long Animation Frames ('long-animation-frame') when supported.
 * Keeps unrounded floating-point durations to avoid weakening the 50ms ceiling.
 */
export function getLongTaskObserverSource(): string {
  return `
    window.__capLongTasks = [];
    window.__capLoafEntries = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'longtask') {
            const att = (entry.attribution || []).map(a => ({
              name: a.name,
              containerType: a.containerType,
              containerSrc: a.containerSrc,
              containerId: a.containerId,
              containerName: a.containerName,
            }));
            window.__capLongTasks.push({
              entryType: 'longtask',
              name: entry.name,
              duration: entry.duration,
              startTime: entry.startTime,
              attribution: att,
            });
          } else if (entry.entryType === 'long-animation-frame') {
            const scripts = (entry.scripts || []).map(s => ({
              invoker: s.invoker,
              invokerType: s.invokerType,
              sourceURL: s.sourceURL,
              sourceFunctionName: s.sourceFunctionName,
              sourceCharPosition: s.sourceCharPosition,
              duration: s.duration,
              executionStart: s.executionStart,
              forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration || 0,
            }));
            window.__capLoafEntries.push({
              entryType: 'long-animation-frame',
              duration: entry.duration,
              startTime: entry.startTime,
              renderDuration: entry.renderDuration || 0,
              styleAndLayoutDuration: entry.styleAndLayoutDuration || 0,
              scripts,
            });
          }
        }
      }).observe({ entryTypes: ['longtask', 'long-animation-frame'] });
    } catch {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__capLongTasks.push({
              entryType: 'longtask',
              name: entry.name,
              duration: entry.duration,
              startTime: entry.startTime,
              attribution: (entry.attribution || []).map(a => ({
                name: a.name,
                containerType: a.containerType,
                containerSrc: a.containerSrc,
              })),
            });
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch {}
    }
  `;
}

/**
 * Script evaluated in the page after boot settles to extract raw timings and task lists.
 * Preserves exact measure start times and durations for accurate phase boundary calculation.
 */
export function getBootMetricsExtractionSource(): string {
  return `(() => {
    const measures = performance.getEntriesByType("measure") || [];
    const boot = measures.find(m => m.name.includes("composer-ready"));
    const thread = measures.find(m => m.name.includes("thread-list-hydrated"));
    const obsTasks = Array.isArray(window.__capLongTasks) ? window.__capLongTasks : [];
    const perfTasks = (performance.getEntriesByType("longtask") || []).map(entry => ({
      entryType: 'longtask',
      name: entry.name,
      duration: entry.duration,
      startTime: entry.startTime,
      attribution: (entry.attribution || []).map(a => ({
        name: a.name,
        containerType: a.containerType,
        containerSrc: a.containerSrc,
        containerId: a.containerId,
        containerName: a.containerName,
      })),
    }));

    // Deduplicate observed vs getEntriesByType using floating point precision key
    const seen = new Set();
    const allLongTasks = [];
    for (const t of [...obsTasks, ...perfTasks]) {
      const key = Math.round(t.startTime * 10) + ":" + Math.round(t.duration * 10);
      if (!seen.has(key)) {
        seen.add(key);
        allLongTasks.push(t);
      }
    }

    const loafEntries = Array.isArray(window.__capLoafEntries) ? window.__capLoafEntries : [];

    return {
      composerReadyStartMs: boot ? boot.startTime : null,
      composerReadyDurationMs: boot ? boot.duration : null,
      composerReadyEndMs: boot ? (boot.startTime + boot.duration) : null,
      threadListHydratedStartMs: thread ? thread.startTime : null,
      threadListHydratedDurationMs: thread ? thread.duration : null,
      threadListHydratedEndMs: thread ? (thread.startTime + thread.duration) : null,
      longTasks: allLongTasks,
      loafEntries: loafEntries,
      measureNames: measures.map(m => m.name),
    };
  })()`;
}

/**
 * Correlates a raw long task with page measures and LoAF script timings
 * to determine execution phase and specific offending script/function.
 * Uses measure start + duration for real phase end boundaries.
 * Verifies script execution interval overlap before attributing script URL.
 */
export function correlateLongTask(
  task: RawLongTaskEntry,
  metrics: { composerReadyEndMs?: number | null; threadListHydratedEndMs?: number | null },
  loafEntries: RawLoafEntry[] = [],
): AttributedLongTask {
  const durationMs = task.duration;
  const startTimeMs = task.startTime;
  const taskEndMs = startTimeMs + durationMs;

  // 1. Determine boot phase using measure end timestamps (startTime + duration)
  let phase: "stage1-composer" | "stage2-hydration" | "post-boot-quiescence";
  const composerBoundary = metrics.composerReadyEndMs ?? 150;
  const hydrationBoundary = metrics.threadListHydratedEndMs ?? 250;

  if (startTimeMs <= composerBoundary) {
    phase = "stage1-composer";
  } else if (startTimeMs <= hydrationBoundary) {
    phase = "stage2-hydration";
  } else {
    phase = "post-boot-quiescence";
  }

  // 2. Container attribution from longtask attribution
  const firstAtt = task.attribution?.[0];
  const containerType = firstAtt?.containerType;
  const containerSrc = firstAtt?.containerSrc;

  // 3. Script attribution from Long Animation Frames (LoAF)
  // Find LoAF frame spanning this longtask window AND containing an overlapping script
  let scriptUrl: string | undefined;
  let functionName: string | undefined;
  let invoker: string | undefined;
  let invokerType: string | undefined;
  let charPosition: number | undefined;
  let forcedStyleAndLayoutMs: number | undefined;

  for (const frame of loafEntries) {
    const frameStart = frame.startTime;
    const frameEnd = frameStart + frame.duration;
    // Check if frame overlaps with task window
    if (frameEnd > startTimeMs && frameStart < taskEndMs) {
      const scripts = frame.scripts ?? [];
      // Finding P2: Filter scripts whose executionStart overlaps the task window
      const overlappingScripts = scripts.filter((s) => {
        const sStart = s.executionStart;
        const sEnd = sStart + s.duration;
        return sEnd > startTimeMs && sStart < taskEndMs;
      });

      if (overlappingScripts.length > 0) {
        const heaviest = [...overlappingScripts].sort((a, b) => b.duration - a.duration)[0];
        scriptUrl = heaviest.sourceURL;
        functionName = heaviest.sourceFunctionName || (heaviest.sourceURL ? "<anonymous>" : undefined);
        invoker = heaviest.invoker;
        invokerType = heaviest.invokerType;
        charPosition = heaviest.sourceCharPosition;
        forcedStyleAndLayoutMs = heaviest.forcedStyleAndLayoutDuration;
        break;
      }
    }
  }

  return {
    durationMs,
    startTimeMs,
    phase,
    name: task.name || "self",
    containerType: containerType || undefined,
    containerSrc: containerSrc || undefined,
    scriptUrl,
    functionName,
    invoker,
    invokerType,
    charPosition,
    forcedStyleAndLayoutMs,
  };
}

export function failedSample(err: any): LoadSample {
  return {
    at: Date.now(),
    measurable: false,
    unbaselined: true,
    error: err instanceof Error ? err.message : String(err ?? "sample read failed"),
    load1: 0,
    load5: 0,
    load15: 0,
    cores: 1,
    loadPerCore: 0,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
    activeCompilerNames: [],
  };
}

export type BootStagingSampleInput =
  | LoadSample
  | LoadSample[]
  | { pre: LoadSample | null; post: LoadSample | null }
  | null;

/**
 * Checks whether a load sample contains positive evidence of an active external builder.
 * - Any sample with activeCompilers > 0 (CPU ticks advanced or newly appeared builder).
 * - Discrete compilers/orchestrators (e.g. rustc, cargo) present in compilerNames,
 *   even if zero CPU ticks advanced in the sample window.
 * - Parked background services and watchers (esbuild, tsc, cargo-watch) with 0 CPU ticks are admitted.
 * - Test suite self-load (compilers = 0, activeCompilers = 0, elevated load/core) remains admitted.
 * - Legacy hand-built mocks with compilers > 0 and activeCompilers undefined fail closed.
 * - Multi-sample interval awareness: if an initial sample flagged a background daemon (like esbuild)
 *   merely because it was newly seen without a baseline (prev = null), but later samples or interval
 *   CPU tracking confirm the daemon's CPU ticks never advanced (0 tick advance / final active=0),
 *   the parked daemon is recognized as idle and does not invalidate the run (chrome-agent-platform-0om0o).
 */
export function hasActiveBuilder(sample: LoadSample, allSamples?: LoadSample[]): boolean {
  if (!sample || !sample.measurable) return false;

  // 1. Unbounded boolean evidence from sampler indicating a discrete builder was seen
  if (sample.hasDiscreteBuilder) return true;

  // 2. Discrete compilers/orchestrators whose presence alone indicates build contention (rustc, cargo)
  if ((sample.compilers ?? 0) > 0 && Array.isArray(sample.compilerNames)) {
    if (sample.compilerNames.some((name) => isZeroTickActiveBuilder(name))) {
      return true;
    }
  }

  // 3. Fallback for legacy mocks where activeCompilers is undefined and compilers > 0
  if (sample.activeCompilers === undefined && (sample.compilers ?? 0) > 0) {
    return true;
  }

  // 4. If activeCompilers is 0 or undefined, no active builder
  if ((sample.activeCompilers ?? 0) <= 0) return false;

  // 5. Active compilers > 0: check if these are background services/watchers (e.g. esbuild, tsc, cargo-watch)
  // that were flagged merely due to lack of predecessor baseline in an initial sample (prev === null)
  // or newly-seen PID, but were actually parked throughout the boot interval (chrome-agent-platform-0om0o).
  //
  // Strict invariants (reviewer P1/P2, coord bcliu/onix1):
  // - Applies across the boot interval for pre-existing daemons that remained parked from boot start to settling.
  // - All active builders in the sample must be in KNOWN_PARKABLE_BUILDERS (esbuild, tsc, cargo-watch).
  //   Discrete and non-parkable compilers (gcc, clang, rustc, cargo, make, ninja) are NEVER suppressed.
  // - The daemon must exist in allSamples[0].cpu (running before boot started) AND finalSample.cpu (persisted through settling).
  // - The daemon must NOT have compiled mid-interval: startTicks must match, and cpuTicks at settling must equal
  //   cpuTicks before boot (compiled-then-parked fails closed as contention).
  // - At settling (finalSample), activeCompilers must be 0 (daemon is not actively compiling).
  // - Complete per-PID CPU evidence is strictly required (unrecorded PIDs or disappearing builders fail closed).
  if (allSamples && allSamples.length > 1) {
    // If the initial sample was explicitly baselined (unbaselined === false) and recorded activeCompilers > 0,
    // its activity came from an actual predecessor baseline comparison and represents real compilation.
    if (sample === allSamples[0] && sample.unbaselined === false) {
      return true;
    }

    const activeNames = sample.activeCompilerNames && sample.activeCompilerNames.length > 0
      ? sample.activeCompilerNames
      : sample.compilerNames ?? [];

    const allKnownParkable = activeNames.length > 0 &&
      activeNames.every((name) => KNOWN_PARKABLE_BUILDERS.has(name));

    if (allKnownParkable) {
      const initialSample = allSamples[0];
      const finalSample = allSamples[allSamples.length - 1];

      // Final sample must be measurable and have 0 active compilers (parked at settling)
      if (initialSample?.measurable && finalSample?.measurable && (finalSample.activeCompilers ?? 0) === 0) {
        const firstCpu = initialSample.cpu;
        const lastCpu = finalSample.cpu;

        if (firstCpu && lastCpu) {
          // Complete CPU evidence required:
          // 1. Initial sample recorded CPU for all observed compilers
          // 2. Final sample recorded CPU for all observed compilers
          // 3. No compilers disappeared between initial and final sample
          if (
            (initialSample.compilers ?? 0) > firstCpu.size ||
            (finalSample.compilers ?? 0) > lastCpu.size ||
            (initialSample.compilers ?? 0) !== (finalSample.compilers ?? 0)
          ) {
            return true;
          }

          let allPersistedAndIdle = true;
          let checkedPids = 0;

          // Check every active process in this sample:
          // It must have been running before boot started (in firstCpu),
          // still running at boot settling (in lastCpu),
          // with unchanged process identity (startTicks),
          // and with ZERO CPU tick advancement across the entire boot interval!
          for (const [pid, currProc] of (sample.cpu ?? firstCpu)) {
            if (activeNames.includes(currProc.name)) {
              checkedPids++;
              const firstProc = firstCpu.get(pid);
              const lastProc = lastCpu.get(pid);

              if (!firstProc || !lastProc) {
                // Newly spawned mid-interval or exited mid-interval!
                allPersistedAndIdle = false;
                break;
              }

              if (lastProc.startTicks !== firstProc.startTicks) {
                // Process restarted or PID reused!
                allPersistedAndIdle = false;
                break;
              }

              if (lastProc.cpuTicks !== firstProc.cpuTicks) {
                // Process consumed CPU ticks during the boot interval (compiled-then-parked)!
                allPersistedAndIdle = false;
                break;
              }
            }
          }

          if (allPersistedAndIdle && checkedPids > 0) {
            // Verified: all active daemons existed at boot start and boot finish with ZERO tick accumulation.
            // They were parked throughout the entire boot run!
            return false;
          }
        }
        // If firstCpu or lastCpu is missing, per-PID tick evidence is incomplete;
        // fail closed as contention (reviewer P2).
      }
    }
  }

  return true;
}

/** Formats the active/contending builder names for diagnostic invalidReason strings. */
export function formatActiveBuilders(sample: LoadSample): string {
  const names = new Set<string>();

  // 1. If explicit activeCompilerNames is provided, use those actively compiling processes
  if (sample.activeCompilerNames && sample.activeCompilerNames.length > 0) {
    for (const n of sample.activeCompilerNames) names.add(n);
  } else if ((sample.activeCompilers ?? 0) > 0 && sample.compilerNames && sample.compilerNames.length > 0) {
    // When activeCompilers > 0 without a distinct activeCompilerNames list, all compilerNames are considered active
    for (const n of sample.compilerNames) names.add(n);
  }

  // 2. Add zero-tick inferred builders (e.g. rustc, cargo) from compilerNames
  if (sample.compilerNames && sample.compilerNames.length > 0) {
    for (const n of sample.compilerNames) {
      if (isZeroTickActiveBuilder(n)) {
        names.add(n);
      }
    }
  }

  if (names.size > 0) {
    return [...names].join(",");
  }
  if (sample.hasDiscreteBuilder) {
    return "discrete builder (name omitted by diagnostic limit)";
  }
  return `${sample.activeCompilers ?? sample.compilers ?? 1} compilers`;
}

/**
 * Attributes all long tasks in a boot staging run, classifying marginal vs severe breaches.
 * Unrounded durations are checked against 50.0 ms strictly.
 * Measurement validity is established across the boot interval (pre, post, and intermediate samples).
 */
export function attributeBootRun(
  run: number,
  rawMetrics: RawBootPageMetrics,
  sample: BootStagingSampleInput = null,
): BootStagingRunResult {
  const samples: LoadSample[] = [];
  if (Array.isArray(sample)) {
    for (const s of sample) if (s) samples.push(s);
  } else if (sample && "pre" in sample && "post" in sample) {
    if (sample.pre) samples.push(sample.pre);
    if (sample.post) samples.push(sample.post);
  } else if (sample && "loadPerCore" in sample) {
    samples.push(sample as LoadSample);
  }

  const effectiveSample = samples[samples.length - 1] ?? null;
  const hostEnvironment = environmentLine(effectiveSample);

  // Classification of measurement validity under contention across the interval:
  // A run is an INVALID (contended) measurement if:
  // 1. Host load was unmeasurable at any point in the interval (cannot establish quiet window).
  // 2. Positive evidence of an EXTERNAL heavy builder detected in any sample during the interval
  //    (e.g. active esbuild, cargo, rustc, tsc, gcc, clang process).
  //    Note: The suite's own parallel-phase self-load (elevated load/core on a 2-vCPU box,
  //    activeCompilers=0) is NORMAL and VALID — aggregate load/core alone does NOT invalidate
  //    a run. Contention requires positive evidence of an external compiling process.
  let validMeasurement = true;
  let invalidReason: string | undefined;

  if (samples.length === 0 || samples.some((s) => !s || !s.measurable)) {
    validMeasurement = false;
    const unmeasurable = samples.find((s) => !s || !s.measurable);
    const err = unmeasurable?.error ?? "load sample missing";
    invalidReason = `unmeasurable host load (${err}) [${hostEnvironment}]`;
  } else {
    // A run is contended/excluded ONLY with positive evidence of an EXTERNAL heavy builder
    // (activeCompilers > 0, non-parked builders like rustc/cargo present, or legacy mock with compilers > 0).
    // Parked esbuild services (0 CPU tick accumulation) do NOT cause contention refusals.
    // The suite's own parallel-phase self-load (compilers=0, activeCompilers=0, elevated load/core)
    // is admitted as valid.
    const activeSample = samples.find((s) => hasActiveBuilder(s, samples));

    if (activeSample) {
      validMeasurement = false;
      const comps = formatActiveBuilders(activeSample);
      invalidReason = `concurrent heavy builder detected during boot: [${comps}] (${hostEnvironment})`;
    }
  }

  const hostLoaded = !validMeasurement;

  const loafEntries = rawMetrics.loafEntries || [];
  // Unrounded 50.0 ms threshold — no weak rounding bypass
  const severeTasks = (rawMetrics.longTasks || []).filter((t) => t.duration > 50.0);

  const attributedTasks = severeTasks.map((t) =>
    correlateLongTask(t, rawMetrics, loafEntries)
  );

  // Classification:
  // Catastrophic stall is strictly > 500.0ms on any host.
  const severeCeilingMs = 500.0;

  const severeBreaches = attributedTasks.filter((t) => t.durationMs > severeCeilingMs);
  const marginalBreaches = attributedTasks.filter((t) => t.durationMs <= severeCeilingMs);

  const composerReadyDuration = rawMetrics.composerReadyDurationMs ??
    (rawMetrics.composerReadyEndMs != null && rawMetrics.composerReadyStartMs != null
      ? rawMetrics.composerReadyEndMs - rawMetrics.composerReadyStartMs
      : null);
  const threadHydratedDuration = rawMetrics.threadListHydratedDurationMs ??
    (rawMetrics.threadListHydratedEndMs != null && rawMetrics.threadListHydratedStartMs != null
      ? rawMetrics.threadListHydratedEndMs - rawMetrics.threadListHydratedStartMs
      : null);

  return {
    run,
    composerReadyMs: composerReadyDuration,
    composerReadyEndMs: rawMetrics.composerReadyEndMs ?? null,
    threadListHydratedMs: threadHydratedDuration,
    threadListHydratedEndMs: rawMetrics.threadListHydratedEndMs ?? null,
    longTasks: attributedTasks,
    marginalBreaches,
    severeBreaches,
    hostEnvironment,
    hostLoaded,
    validMeasurement,
    invalidReason,
  };
}

/**
 * Format structured attribution diagnostics for a long task.
 */
export function formatTaskAttribution(task: AttributedLongTask): string {
  const parts = [
    `duration=${Math.round(task.durationMs * 10) / 10}ms`,
    `start=${Math.round(task.startTimeMs * 10) / 10}ms`,
    `phase=${task.phase}`,
  ];
  if (task.scriptUrl) parts.push(`script=${task.scriptUrl}`);
  if (task.functionName) parts.push(`fn=${task.functionName}`);
  if (task.invoker) parts.push(`invoker=${task.invoker}`);
  if (task.invokerType) parts.push(`invokerType=${task.invokerType}`);
  if (task.forcedStyleAndLayoutMs) parts.push(`forcedStyleLayout=${task.forcedStyleAndLayoutMs}ms`);
  if (task.containerSrc) parts.push(`container=${task.containerSrc}`);
  return `[${parts.join(" ")}]`;
}

export interface BootStagingPolicyEvaluation {
  ok: boolean;
  environmentalRefusal: boolean;
  refusalError?: BootStagingEnvironmentalRefusalError;
  error?: string;
  warnings: string[];
  validRuns: BootStagingRunResult[];
  contendedRuns: BootStagingRunResult[];
  medianTaskCount?: number;
}

/**
 * Evaluates the multi-run policy for NTP boot staging:
 * - Product contract ceiling: 50.0 ms.
 * - Measurement honesty under contention:
 *   A run in which concurrent heavy builder or elevated host load is detected is classified
 *   as an INVALID (contended) measurement and excluded from the median calculation.
 * - If ALL N runs are contended, REFUSES with a named environmental refusal (never a silent pass).
 * - Over VALID runs: median-0 contract is strictly enforced; persistent regressions (median > 0)
 *   fail as contract breaches with full attribution, while isolated cold-start tasks absorbed
 *   by median-0 pass with recorded warnings.
 * - Catastrophic stalls (> 500.0ms) fail immediately on any run.
 * - On valid runs, strictly enforces composer-ready < 150ms and thread-list-hydrated <= 250ms.
 */
export function evaluateBootStagingPolicy(
  runs: BootStagingRunResult[],
): BootStagingPolicyEvaluation {
  const warnings: string[] = [];

  const validRuns = runs.filter((r) => r.validMeasurement);
  const contendedRuns = runs.filter((r) => !r.validMeasurement);

  // 1. Record diagnostics for all excluded contended runs
  for (const r of contendedRuns) {
    const tasksDesc = r.longTasks.length > 0
      ? ` (observed long tasks: ${r.longTasks.map(formatTaskAttribution).join("; ")})`
      : " (0 long tasks)";
    warnings.push(
      `[ntp-boot-staging] Run ${r.run}: excluded from median as INVALID (contended measurement): ${r.invalidReason}${tasksDesc}`,
    );
  }

  // 2. Check 1: Catastrophic stalls (> 500ms) fail immediately even if the host was loaded
  for (const r of runs) {
    if (r.severeBreaches.length > 0) {
      const details = r.severeBreaches.map(formatTaskAttribution).join("; ");
      return {
        ok: false,
        environmentalRefusal: false,
        error: `Run ${r.run}: severe long task breach detected: ${details} [${r.hostEnvironment}]`,
        warnings,
        validRuns,
        contendedRuns,
      };
    }
  }

  // 3. Check 2: If ALL N runs are contended, REFUSE with a named environmental refusal — never a silent pass!
  if (validRuns.length === 0) {
    const reasons = contendedRuns.map((r) => `Run ${r.run}: ${r.invalidReason}`).join("; ");
    const detail = `all ${runs.length} runs were contended and excluded from measurement: ${reasons}`;
    const refusal = new BootStagingEnvironmentalRefusalError(runs, detail);
    return {
      ok: false,
      environmentalRefusal: true,
      refusalError: refusal,
      error: refusal.message,
      warnings,
      validRuns,
      contendedRuns,
    };
  }

  // 4. Check 3: Calculate median long tasks > 50ms across VALID runs (median-of-valid-runs policy)
  const taskCounts = validRuns.map((r) => r.longTasks.length).sort((a, b) => a - b);
  const mid = Math.floor(taskCounts.length / 2);
  const medianTaskCount = taskCounts.length % 2 === 0
    ? (taskCounts[mid - 1] + taskCounts[mid]) / 2
    : taskCounts[mid];

  if (medianTaskCount > 0) {
    const summary = validRuns
      .filter((r) => r.longTasks.length > 0)
      .map((r) => `Run ${r.run}: ${r.longTasks.map(formatTaskAttribution).join(", ")}`)
      .join(" | ");
    return {
      ok: false,
      environmentalRefusal: false,
      error: `ntp-boot-staging contract breach: median long tasks > 50ms across ${validRuns.length} valid run(s) is ${medianTaskCount} (expected 0). ${summary}`,
      warnings,
      validRuns,
      contendedRuns,
      medianTaskCount,
    };
  }

  // Record diagnostics for any isolated long task on valid runs that was absorbed by the median
  for (const r of validRuns) {
    if (r.longTasks.length > 0) {
      warnings.push(
        `[ntp-boot-staging] Run ${r.run}: isolated long task > 50ms observed (absorbed by median-of-${validRuns.length} = 0): ${r.longTasks.map(formatTaskAttribution).join("; ")}`,
      );
    }
  }

  // 5. Check 4: On valid (uncontended) runs, strictly enforce composerReady < 150ms and threadListHydrated <= 250ms
  for (const r of validRuns) {
    if (r.composerReadyMs != null && r.composerReadyMs >= 150) {
      return {
        ok: false,
        environmentalRefusal: false,
        error: `Run ${r.run}: composer-ready took ${r.composerReadyMs}ms on uncontended host (must be < 150ms) [${r.hostEnvironment}]`,
        warnings,
        validRuns,
        contendedRuns,
        medianTaskCount,
      };
    }
    if (r.threadListHydratedMs != null && r.threadListHydratedMs > 250) {
      return {
        ok: false,
        environmentalRefusal: false,
        error: `Run ${r.run}: thread-list-hydrated took ${r.threadListHydratedMs}ms on uncontended host (must be <= 250ms) [${r.hostEnvironment}]`,
        warnings,
        validRuns,
        contendedRuns,
        medianTaskCount,
      };
    }
  }

  return {
    ok: true,
    environmentalRefusal: false,
    warnings,
    validRuns,
    contendedRuns,
    medianTaskCount,
  };
}

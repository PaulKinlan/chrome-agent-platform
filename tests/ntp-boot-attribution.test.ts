// tests/ntp-boot-attribution.test.ts — chrome-agent-platform-mujlt
// Tests for NTP boot staging long-task attribution, load classification, and multi-run policy.
//
// Invariants tested (incorporating independent review findings):
// 1. Long-task attribution calculates phase boundaries using measure end timestamps (startTime + duration),
//    correctly attributing nonzero measure starts.
// 2. LoAF script matching strictly requires script execution interval overlap, rejecting unrelated scripts.
// 3. Unrounded floating-point duration precision (50.1ms) is not rounded down to 50ms.
// 4. Deterministic falsifier: forced long task produces full structured attribution fields.
// 5. Multi-run policy passes clean runs (0 long tasks).
// 6. Isolated marginal breach (50.0ms < duration <= 500.0ms) passes when absorbed by median-0 across valid runs with warning recorded.
// 7. Unmeasurable host sample during interval invalidates run rather than silent pass.
// 8. Isolated severe breach (> 500.0ms) in ANY run fails immediately, even under host load.
// 9. Persistent breach across runs (median > 0 across valid runs) fails as contract breach.

import { assert, assertEquals, assertStrictEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { classifyActiveBuilders, isHeavyProcessName, type ProcCpuMap } from "../scripts/lib/quiet-window.ts";
import {
  correlateLongTask,
  attributeBootRun,
  evaluateBootStagingPolicy,
  formatTaskAttribution,
  failedSample,
  hasActiveBuilder,
  formatActiveBuilders,
  ZERO_TICK_ACTIVE_BUILDERS,
  isZeroTickActiveBuilder,
  type RawBootPageMetrics,
  type RawLongTaskEntry,
  type RawLoafEntry,
} from "../scripts/lib/ntp-boot-attribution.ts";

Deno.test("mujlt: correlateLongTask maps task timing using measure end boundaries (startTime + duration)", () => {
  // Nonzero measure starts:
  // composer-ready: starts at 20ms, duration 100ms -> ends at 120ms
  // thread-list-hydrated: starts at 130ms, duration 90ms -> ends at 220ms
  const metrics = {
    composerReadyEndMs: 120, // 20 + 100
    threadListHydratedEndMs: 220, // 130 + 90
  };

  // Task before composer-ready boundary (startTime=80 <= 120) -> stage1-composer
  const task1: RawLongTaskEntry = {
    name: "self",
    duration: 58.4,
    startTime: 80.2,
    attribution: [{ containerType: "window", containerSrc: "chrome-extension://xyz/ntp/ntp.html" }],
  };
  const attr1 = correlateLongTask(task1, metrics);
  assertEquals(attr1.phase, "stage1-composer");
  assertEquals(attr1.durationMs, 58.4);
  assertEquals(attr1.startTimeMs, 80.2);
  assertEquals(attr1.containerType, "window");
  assertEquals(attr1.containerSrc, "chrome-extension://xyz/ntp/ntp.html");

  // Task during hydration (120 < startTime=150 <= 220) -> stage2-hydration
  const task2: RawLongTaskEntry = {
    name: "self",
    duration: 52.1,
    startTime: 150.0,
  };
  const attr2 = correlateLongTask(task2, metrics);
  assertEquals(attr2.phase, "stage2-hydration");

  // Task after hydration (startTime=260 > 220) -> post-boot-quiescence
  const task3: RawLongTaskEntry = {
    name: "self",
    duration: 61.0,
    startTime: 260.0,
  };
  const attr3 = correlateLongTask(task3, metrics);
  assertEquals(attr3.phase, "post-boot-quiescence");
});

Deno.test("mujlt: correlateLongTask extracts LoAF script only when execution overlaps task window", () => {
  const metrics = { composerReadyEndMs: 100, threadListHydratedEndMs: 200 };
  const task: RawLongTaskEntry = {
    name: "self",
    duration: 64.0,
    startTime: 75.0, // task window: [75, 139]
  };

  const loafEntries: RawLoafEntry[] = [
    {
      entryType: "long-animation-frame",
      duration: 150,
      startTime: 50, // frame window: [50, 200]
      scripts: [
        {
          // Script A runs before task window: [50, 60] -> does NOT overlap [75, 139]
          invoker: "Script",
          sourceURL: "chrome-extension://xyz/ntp/unrelated.js",
          sourceFunctionName: "unrelatedSetup",
          duration: 10,
          executionStart: 50,
        },
        {
          // Script B overlaps task window: [80, 135] -> DOES overlap [75, 139]
          invoker: "Script",
          invokerType: "module-script",
          sourceURL: "chrome-extension://xyz/ntp/ntp.js",
          sourceFunctionName: "renderSiteAgents",
          sourceCharPosition: 1234,
          duration: 55,
          executionStart: 80,
          forcedStyleAndLayoutDuration: 3,
        },
      ],
    },
  ];

  const attributed = correlateLongTask(task, metrics, loafEntries);
  // Must select the overlapping Script B, not Script A
  assertEquals(attributed.scriptUrl, "chrome-extension://xyz/ntp/ntp.js");
  assertEquals(attributed.functionName, "renderSiteAgents");
  assertEquals(attributed.invoker, "Script");
  assertEquals(attributed.invokerType, "module-script");
  assertEquals(attributed.forcedStyleAndLayoutMs, 3);
});

Deno.test("mujlt: correlateLongTask leaves script unknown if frame overlaps but scripts are disjoint", () => {
  const metrics = { composerReadyEndMs: 100, threadListHydratedEndMs: 200 };
  const task: RawLongTaskEntry = {
    name: "self",
    duration: 55.0,
    startTime: 100.0, // task window: [100, 155]
  };

  const loafEntries: RawLoafEntry[] = [
    {
      entryType: "long-animation-frame",
      duration: 100,
      startTime: 80, // frame window: [80, 180] overlaps task [100, 155]
      scripts: [
        {
          // Script runs before task window: [80, 95] -> disjoint from [100, 155]
          invoker: "Script",
          sourceURL: "chrome-extension://xyz/ntp/early.js",
          duration: 15,
          executionStart: 80,
        },
      ],
    },
  ];

  const attributed = correlateLongTask(task, metrics, loafEntries);
  assertEquals(attributed.scriptUrl, undefined, "disjoint scripts within overlapping frame must not be attributed");
});

Deno.test("mujlt: unrounded duration precision prevents weakening the 50ms ceiling", () => {
  const sample: any = {
    measurable: true,
    load1: 0.1,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    activeCompilers: 0,
    compilerNames: [],
  };

  // A 50.1ms task would be rounded to 50ms by Math.round, hiding the breach!
  const run = attributeBootRun(
    1,
    {
      composerReadyEndMs: 40,
      longTasks: [{ name: "self", duration: 50.1, startTime: 30 }],
    },
    sample,
  );

  // Must detect 50.1ms as long task
  assertEquals(run.longTasks.length, 1, "50.1ms task must not be rounded down to 50ms");
  assertEquals(run.longTasks[0].durationMs, 50.1);
});

Deno.test("mujlt: FALSIFICATION — forced long task produces comprehensive attribution fields vs legacy bare count", () => {
  const forcedMetrics: RawBootPageMetrics = {
    composerReadyStartMs: 20,
    composerReadyDurationMs: 75,
    composerReadyEndMs: 95,
    threadListHydratedStartMs: 100,
    threadListHydratedDurationMs: 80,
    threadListHydratedEndMs: 180,
    longTasks: [
      {
        name: "self",
        duration: 56.2,
        startTime: 140.0,
        attribution: [{ containerType: "window", containerSrc: "chrome-extension://test/ntp/ntp.html" }],
      },
    ],
    loafEntries: [
      {
        duration: 60,
        startTime: 138,
        scripts: [
          {
            invoker: "Window.setTimeout",
            invokerType: "user-callback",
            sourceURL: "chrome-extension://test/ntp/ntp-boot-scheduler.js",
            sourceFunctionName: "executeBatch",
            duration: 54,
            executionStart: 140,
          },
        ],
      },
    ],
  };

  const sample: any = {
    measurable: true,
    load1: 18.5,
    load5: 12.0,
    cores: 14,
    loadPerCore: 1.32,
    activeCompilers: 2,
    compilerNames: ["esbuild", "cargo"],
  };

  const runResult = attributeBootRun(1, forcedMetrics, sample);
  assertEquals(runResult.longTasks.length, 1);
  assertEquals(runResult.marginalBreaches.length, 1);
  assertEquals(runResult.severeBreaches.length, 0);

  const task = runResult.longTasks[0];
  const formatted = formatTaskAttribution(task);

  // Assert all attribution fields required by bead specification are present:
  assertStringIncludes(formatted, "duration=56.2ms");
  assertStringIncludes(formatted, "start=140ms");
  assertStringIncludes(formatted, "phase=stage2-hydration");
  assertStringIncludes(formatted, "script=chrome-extension://test/ntp/ntp-boot-scheduler.js");
  assertStringIncludes(formatted, "fn=executeBatch");
  assertStringIncludes(formatted, "invoker=Window.setTimeout");
  assertStringIncludes(runResult.hostEnvironment, "load1=18.50");
  assertStringIncludes(runResult.hostEnvironment, "load/core=1.32");

  // Contrast with legacy failure message format:
  const legacyMessage = `Run 1: 0 long tasks > 50ms (got 1: duration 56, startTime 193)`;
  assertEquals(legacyMessage.includes("script="), false, "legacy message lacked script attribution");
  assertEquals(legacyMessage.includes("fn="), false, "legacy message lacked function attribution");
  assertEquals(legacyMessage.includes("phase="), false, "legacy message lacked phase attribution");
  assertEquals(legacyMessage.includes("load/core"), false, "legacy message lacked host load attribution");
});

Deno.test("mujlt: multi-run policy passes clean runs with 0 long tasks", () => {
  const idleSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    activeCompilers: 0,
    compilerNames: [],
  };

  const runs = [1, 2, 3].map((run) =>
    attributeBootRun(
      run,
      {
        composerReadyStartMs: 0,
        composerReadyDurationMs: 40,
        composerReadyEndMs: 40,
        threadListHydratedStartMs: 40,
        threadListHydratedDurationMs: 40,
        threadListHydratedEndMs: 80,
        longTasks: [],
      },
      idleSample,
    )
  );

  const policy = evaluateBootStagingPolicy(runs);
  assertEquals(policy.ok, true);
  assertEquals(policy.environmentalRefusal, false);
  assertEquals(policy.warnings.length, 0);
});

Deno.test("mujlt falsifier: contended runs are excluded from median and diagnostics persisted", () => {
  const loadedSample: any = {
    measurable: true,
    load1: 22.0,
    load5: 18.0,
    cores: 14,
    loadPerCore: 1.57,
    activeCompilers: 2,
    compilerNames: ["esbuild", "cargo"],
  };
  const idleSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    activeCompilers: 0,
    compilerNames: [],
  };

  // Run 1 is contaminated by concurrent heavy builder and records a 60ms task
  const run1 = attributeBootRun(
    1,
    {
      composerReadyEndMs: 45,
      threadListHydratedEndMs: 90,
      longTasks: [{ name: "self", duration: 60, startTime: 140 }],
    },
    loadedSample,
  );
  assertEquals(run1.validMeasurement, false);
  assertStringIncludes(run1.invalidReason!, "concurrent heavy builder detected during boot: [esbuild,cargo]");

  // Runs 2 and 3 are valid uncontended measurements with 0 long tasks
  const run2 = attributeBootRun(2, { composerReadyEndMs: 38, threadListHydratedEndMs: 75, longTasks: [] }, idleSample);
  const run3 = attributeBootRun(3, { composerReadyEndMs: 36, threadListHydratedEndMs: 72, longTasks: [] }, idleSample);
  assertEquals(run2.validMeasurement, true);
  assertEquals(run3.validMeasurement, true);

  const policy = evaluateBootStagingPolicy([run1, run2, run3]);
  assertEquals(policy.ok, true, "contended run 1 must be excluded; valid runs 2 and 3 establish median=0");
  assertEquals(policy.environmentalRefusal, false);
  assertEquals(policy.validRuns.length, 2);
  assertEquals(policy.contendedRuns.length, 1);
  assertEquals(policy.medianTaskCount, 0);

  // Check persisted diagnostics in warnings
  assertEquals(policy.warnings.length, 1);
  assertStringIncludes(policy.warnings[0], "excluded from median as INVALID (contended measurement)");
  assertStringIncludes(policy.warnings[0], "concurrent heavy builder detected during boot: [esbuild,cargo]");
  assertStringIncludes(policy.warnings[0], "duration=60ms");
});

Deno.test("mujlt falsifier: short-lived builder active strictly in intermediate interval sample is caught", () => {
  const sample0: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
  };
  // Short-lived esbuild spikes mid-boot and exits before settling
  const sample1: any = {
    measurable: true,
    load1: 1.5,
    load5: 0.4,
    cores: 14,
    loadPerCore: 0.10,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
  };
  const sample2: any = {
    measurable: true,
    load1: 0.3,
    load5: 0.2,
    cores: 14,
    loadPerCore: 0.02,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
  };

  const run1 = attributeBootRun(
    1,
    { composerReadyEndMs: 45, threadListHydratedEndMs: 90, longTasks: [{ name: "self", duration: 65, startTime: 120 }] },
    [sample0, sample1, sample2],
  );

  assertEquals(run1.validMeasurement, false, "intermediate interval sample with active compiler must classify run as invalid");
  assertStringIncludes(run1.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("mujlt falsifier: parked esbuild service (0 active compilers) does NOT cause false contention refusal", () => {
  // Parked esbuild daemon running with 0 CPU advance
  const parkedSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    compilers: 2,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    parkedSample,
  );

  assertEquals(run.validMeasurement, true, "parked builder with 0 activeCompilers must be admitted as valid measurement");
  assertEquals(run.hostLoaded, false);
});

Deno.test("mujlt falsifier: parallel test suite self-load (load/core 2.50, activeCompilers 0) is a VALID run", () => {
  // Simulates the suite's own parallel-phase self-load (bead 2bli) on a 2-vCPU box:
  // load1 = 5.0, cores = 2 -> loadPerCore = 2.50.
  // Active external builders = 0.
  const parallelSelfLoadSample: any = {
    measurable: true,
    load1: 5.0,
    load5: 4.5,
    cores: 2,
    loadPerCore: 2.5,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    parallelSelfLoadSample,
  );

  assertEquals(run.validMeasurement, true, "parallel self-load without external heavy builders must be admitted as valid measurement");
  assertEquals(run.hostLoaded, false);
  assertEquals(run.invalidReason, undefined);

  // Across multiple runs at load/core 2.50, the policy passes without environmental refusal
  const runs = [1, 2, 3].map((r) =>
    attributeBootRun(
      r,
      { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
      parallelSelfLoadSample,
    )
  );

  const policy = evaluateBootStagingPolicy(runs);
  assertEquals(policy.ok, true, "suite self-load must evaluate as passing policy without refusal");
  assertEquals(policy.environmentalRefusal, false);
});

Deno.test("mujlt falsifier: failed load read in interval invalidates run even if followed by quiet sample", () => {
  const quietSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
    activeCompilerNames: [],
  };
  const unmeasurableSample: any = {
    measurable: false,
    error: "readLoadSample timed out reading /proc/stat",
    load1: 0,
    load5: 0,
    cores: 1,
    loadPerCore: 0,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [quietSample, unmeasurableSample, quietSample],
  );

  assertEquals(run.validMeasurement, false, "failed read during interval must invalidate run");
  assertStringIncludes(run.invalidReason!, "unmeasurable host load (readLoadSample timed out reading /proc/stat)");
});

Deno.test("mujlt falsifier: failedSample normalizes thrown exceptions and string errors into unmeasurable LoadSample", () => {
  const errSample1 = failedSample(new Error("socket timeout"));
  assertEquals(errSample1.measurable, false);
  assertEquals(errSample1.error, "socket timeout");

  const errSample2 = failedSample("ENOSPC reading /proc");
  assertEquals(errSample2.measurable, false);
  assertEquals(errSample2.error, "ENOSPC reading /proc");
});

Deno.test("mujlt integration falsifier: baseline CPU comparison distinguishes parked esbuild daemon from compiling process", () => {
  // Baseline process table: PID 1001 is a pre-existing parked esbuild daemon with 50 CPU ticks
  const baselineCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);

  // Snapshot 1 (60ms baseline delta): PID 1001 still has 50 CPU ticks (no CPU advance -> parked!)
  const parkedCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);
  const parkedActivePids = classifyActiveBuilders(baselineCpu, parkedCpu);
  assertEquals(parkedActivePids, [], "parked esbuild with zero tick advance must NOT be classified as active");

  const parkedSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: parkedActivePids.length,
    activeCompilerNames: [],
    cpu: parkedCpu,
  };

  const runParked = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    parkedSample,
  );
  assertEquals(runParked.validMeasurement, true, "run with verified parked builder must be valid");

  // Snapshot 2 (active compilation): PID 1001 advanced from 50 to 75 ticks during boot
  const activeCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 75 }],
  ]);
  const activePids = classifyActiveBuilders(baselineCpu, activeCpu);
  assertEquals(activePids, ["1001"], "esbuild with advancing ticks must be classified as active");

  const compilingSample: any = {
    measurable: true,
    load1: 1.8,
    load5: 0.5,
    cores: 14,
    loadPerCore: 0.12,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: activePids.length,
    activeCompilerNames: ["esbuild"],
    cpu: activeCpu,
  };

  const runCompiling = attributeBootRun(
    2,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    compilingSample,
  );
  assertEquals(runCompiling.validMeasurement, false, "run with verified compiling builder must be invalid");
  assertStringIncludes(runCompiling.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("mujlt falsifier: all-contended runs result in named environmental refusal (never silent pass)", () => {
  const loadedSample: any = {
    measurable: true,
    load1: 25.0,
    load5: 20.0,
    cores: 14,
    loadPerCore: 1.78,
    activeCompilers: 2,
    compilerNames: ["esbuild"],
  };

  // All 3 runs were executed under severe host contention
  const runs = [1, 2, 3].map((run) =>
    attributeBootRun(
      run,
      {
        composerReadyEndMs: 80,
        threadListHydratedEndMs: 160,
        longTasks: [{ name: "self", duration: 58, startTime: 90 }],
      },
      loadedSample,
    )
  );

  const policy = evaluateBootStagingPolicy(runs);
  assertEquals(policy.ok, false, "all-contended runs must NEVER be a silent pass");
  assertEquals(policy.environmentalRefusal, true, "must classify as environmental refusal");
  assert(policy.refusalError != null, "must attach refusal error");
  assertEquals(policy.refusalError.exitCode, 75);
  assertEquals(policy.refusalError.marker, "CAP_ENVIRONMENTAL_REFUSAL");
  assertStringIncludes(policy.error!, "ENVIRONMENT: ntp-boot-staging refusal");
  assertStringIncludes(policy.error!, "all 3 runs were contended and excluded from measurement");
  assertStringIncludes(policy.error!, "(exit 75)");
  assertEquals(policy.validRuns.length, 0);
  assertEquals(policy.contendedRuns.length, 3);
});

Deno.test("mujlt falsifier: uncontended 103ms regression across runs is strictly PRODUCT-RED (never environmental)", () => {
  const idleSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    activeCompilers: 0,
    compilerNames: [],
  };

  // Real regression: 103ms long task on multiple runs on an uncontended machine (median > 0)
  const run1 = attributeBootRun(
    1,
    {
      composerReadyEndMs: 40,
      threadListHydratedEndMs: 80,
      longTasks: [{ name: "self", duration: 103.4, startTime: 30 }],
    },
    idleSample,
  );
  const run2 = attributeBootRun(
    2,
    {
      composerReadyEndMs: 35,
      threadListHydratedEndMs: 70,
      longTasks: [{ name: "self", duration: 95.0, startTime: 30 }],
    },
    idleSample,
  );
  const run3 = attributeBootRun(3, { composerReadyEndMs: 35, threadListHydratedEndMs: 70, longTasks: [] }, idleSample);

  const policy = evaluateBootStagingPolicy([run1, run2, run3]);
  assertEquals(policy.ok, false, "uncontended 103ms regression must fail the product gate");
  assertEquals(policy.environmentalRefusal, false, "must NOT be classified as environmental refusal");
  assertEquals(policy.medianTaskCount, 1);
  assert(
    policy.error!.includes("long task breach") || policy.error!.includes("contract breach"),
    `error must indicate a contract/task breach: ${policy.error}`,
  );
  assertStringIncludes(policy.error!, "duration=103.4ms");
});

Deno.test("mujlt: isolated cold-start task on uncontended host passes when median of 3 is 0 with warning recorded", () => {
  const idleSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    activeCompilers: 0,
    compilerNames: [],
  };

  const run1 = attributeBootRun(
    1,
    {
      composerReadyEndMs: 40,
      threadListHydratedEndMs: 80,
      longTasks: [{ name: "self", duration: 65.0, startTime: 30 }],
    },
    idleSample,
  );
  const run2 = attributeBootRun(2, { composerReadyEndMs: 35, threadListHydratedEndMs: 70, longTasks: [] }, idleSample);
  const run3 = attributeBootRun(3, { composerReadyEndMs: 35, threadListHydratedEndMs: 70, longTasks: [] }, idleSample);

  const policy = evaluateBootStagingPolicy([run1, run2, run3]);
  assertEquals(policy.ok, true, "isolated task with median=0 must pass");
  assertEquals(policy.medianTaskCount, 0);
  assertEquals(policy.warnings.length, 1);
  assertStringIncludes(policy.warnings[0], "isolated long task > 50ms observed (absorbed by median-of-3 = 0)");
  assertStringIncludes(policy.warnings[0], "duration=65ms");
});

Deno.test("mujlt: unmeasurable host sample is classified as invalid measurement and not silent pass", () => {
  const unmeasurableSample: any = {
    measurable: false,
    error: "proc scan truncated after 796 entries",
  };

  const runs = [1, 2, 3].map((run) =>
    attributeBootRun(
      run,
      {
        composerReadyEndMs: 40,
        threadListHydratedEndMs: 80,
        longTasks: [],
      },
      unmeasurableSample,
    )
  );

  const policy = evaluateBootStagingPolicy(runs);
  assertEquals(policy.ok, false, "unmeasurable host cannot establish quiet window");
  assertEquals(policy.environmentalRefusal, true);
  assertStringIncludes(policy.error!, "unmeasurable host load");
});

Deno.test("mujlt: isolated severe breach (> 500ms) fails immediately even under contention", () => {
  const loadedSample: any = {
    measurable: true,
    load1: 22.0,
    load5: 18.0,
    cores: 14,
    loadPerCore: 1.57,
    activeCompilers: 1,
    compilerNames: ["cargo"],
  };

  // A 520ms task exceeds the 500ms maximum loaded ceiling and must fail immediately
  const run1 = attributeBootRun(
    1,
    {
      composerReadyEndMs: 40,
      threadListHydratedEndMs: 80,
      longTasks: [{ name: "self", duration: 520, startTime: 30 }],
    },
    loadedSample,
  );
  const run2 = attributeBootRun(2, { composerReadyEndMs: 35, threadListHydratedEndMs: 70, longTasks: [] }, loadedSample);
  const run3 = attributeBootRun(3, { composerReadyEndMs: 35, threadListHydratedEndMs: 70, longTasks: [] }, loadedSample);

  const policy = evaluateBootStagingPolicy([run1, run2, run3]);
  assertEquals(policy.ok, false, "severe breach exceeding loaded ceiling must fail even under host load");
  assertEquals(policy.environmentalRefusal, false);
  assertStringIncludes(policy.error!, "severe long task breach detected");
  assertStringIncludes(policy.error!, "duration=520ms");
});

Deno.test("mujlt: persistent breach across runs (real regression or mutant) fails with full attribution", () => {
  const idleSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 14,
    loadPerCore: 0.01,
    activeCompilers: 0,
    compilerNames: [],
  };

  // Simulates a mutant introducing a real 60ms task across all runs on uncontended host
  const runs = [1, 2, 3].map((run) =>
    attributeBootRun(
      run,
      {
        composerReadyEndMs: 70,
        threadListHydratedEndMs: 140,
        longTasks: [{ name: "self", duration: 60, startTime: 50 }],
      },
      idleSample,
    )
  );

  const policy = evaluateBootStagingPolicy(runs);
  assertEquals(policy.ok, false, "mutant adding a real >50ms task MUST fail the test");
  assertEquals(policy.environmentalRefusal, false);
  assertStringIncludes(policy.error!, "duration=60ms");
  assertStringIncludes(policy.error!, "phase=stage1-composer");
});

Deno.test("mujlt runner boundary: exclusively environmental refusal propagates exit 75", async () => {
  const scratch = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "mujlt-runner-env-" });
  const fixture = `${scratch}/env-refusal.test.ts`;
  Deno.writeTextFileSync(
    fixture,
    `import { ENVIRONMENTAL_REFUSAL_MARKER, BootStagingEnvironmentalRefusalError } from "${new URL("../scripts/lib/ntp-boot-attribution.ts", import.meta.url).href}";\n` +
      `Deno.test("fixture: environmental refusal", () => {\n` +
      `  console.error(ENVIRONMENTAL_REFUSAL_MARKER + ' {"reason":"test-refusal"}');\n` +
      `  throw new BootStagingEnvironmentalRefusalError([], "all runs contended");\n` +
      `});\n`,
  );

  try {
    const cmd = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", fixture],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    assertEquals(code, 75, `runner must exit 75 on exclusive environmental refusal, got ${code}:\n${out}`);
    assertStringIncludes(out, "REFUSED (environmental verdict, exit 75)");
  } finally {
    try { Deno.removeSync(scratch, { recursive: true }); } catch {}
  }
});

Deno.test("mujlt runner boundary: mixed failure (refusal + product red) preserves PRODUCT RED (exit 1)", async () => {
  const scratch = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "mujlt-runner-mixed-" });
  const fixture = `${scratch}/mixed-failure.test.ts`;
  Deno.writeTextFileSync(
    fixture,
    `import { ENVIRONMENTAL_REFUSAL_MARKER, BootStagingEnvironmentalRefusalError } from "${new URL("../scripts/lib/ntp-boot-attribution.ts", import.meta.url).href}";\n` +
      `Deno.test("fixture: environmental refusal", () => {\n` +
      `  console.error(ENVIRONMENTAL_REFUSAL_MARKER + ' {"reason":"test-refusal"}');\n` +
      `  throw new BootStagingEnvironmentalRefusalError([], "all runs contended");\n` +
      `});\n` +
      `Deno.test("fixture: real product defect", () => {\n` +
      `  throw new Error("assertion failed: real product regression");\n` +
      `});\n`,
  );

  try {
    const cmd = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", fixture],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    assertEquals(code, 1, `runner must preserve exit 1 on mixed failure, got ${code}:\n${out}`);
    assertStringIncludes(out, "preserving PRODUCT RED (exit 1)");
  } finally {
    try { Deno.removeSync(scratch, { recursive: true }); } catch {}
  }
});

Deno.test("mujlt runner boundary: abnormal exit before test summary preserves exit code", async () => {
  const scratch = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "mujlt-runner-abnormal-" });
  const fixture = `${scratch}/abnormal-exit.test.ts`;
  // Script emits refusal marker but terminates abruptly before Deno test summary can be printed
  Deno.writeTextFileSync(
    fixture,
    `import { ENVIRONMENTAL_REFUSAL_MARKER } from "${new URL("../scripts/lib/ntp-boot-attribution.ts", import.meta.url).href}";\n` +
      `console.error(ENVIRONMENTAL_REFUSAL_MARKER + ' {"reason":"test-refusal"}');\n` +
      `Deno.kill(Deno.pid, "SIGKILL");\n`,
  );

  try {
    const cmd = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", fixture],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    assert(code !== 75, `runner must NOT relabel abrupt termination as 75, got ${code}:\n${out}`);
    assertStringIncludes(out, "missing test summary — preserving exit");
  } finally {
    try { Deno.removeSync(scratch, { recursive: true }); } catch {}
  }
});

Deno.test("mujlt runner boundary: passing test emitting marker does NOT convert product failure to exit 75", async () => {
  const scratch = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "mujlt-runner-passing-marker-" });
  const fixture = `${scratch}/passing-marker-mixed.test.ts`;
  // Test 1 passes cleanly after emitting marker; Test 2 fails with real product failure
  Deno.writeTextFileSync(
    fixture,
    `import { ENVIRONMENTAL_REFUSAL_MARKER } from "${new URL("../scripts/lib/ntp-boot-attribution.ts", import.meta.url).href}";\n` +
      `Deno.test("fixture: passing test with marker", () => {\n` +
      `  console.error(ENVIRONMENTAL_REFUSAL_MARKER + ' {"reason":"spurious-marker"}');\n` +
      `});\n` +
      `Deno.test("fixture: real product defect", () => {\n` +
      `  throw new Error("assertion failed: product regression");\n` +
      `});\n`,
  );

  try {
    const cmd = new Deno.Command("node", {
      args: ["scripts/run-tests.mjs", fixture],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    assertEquals(code, 1, `runner must preserve exit 1 when product test fails despite passing test emitting marker, got ${code}:\n${out}`);
    assertStringIncludes(out, "contains non-environmental failure(s) — preserving PRODUCT RED (exit 1)");
  } finally {
    try { Deno.removeSync(scratch, { recursive: true }); } catch {}
  }
});

// ── slzv6: detection of rustc and cargo builders as active contention ────────

Deno.test("slzv6: external rustc builder is detected as contention even with 0 activeCompilers ticks", () => {
  const rustcSample: any = {
    measurable: true,
    load1: 1.2,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.6,
    compilers: 1,
    compilerNames: ["rustc"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  assertEquals(hasActiveBuilder(rustcSample), true, "hasActiveBuilder must detect rustc even with 0 active ticks");
  assertEquals(formatActiveBuilders(rustcSample), "rustc");

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    rustcSample,
  );

  assertEquals(run.validMeasurement, false, "external rustc must be classified as contended measurement");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [rustc]");
});

Deno.test("slzv6: external cargo builder (waiting on child / 0 tick advance) is detected as contention", () => {
  const cargoSample: any = {
    measurable: true,
    load1: 2.1,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.05,
    compilers: 1,
    compilerNames: ["cargo"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  assertEquals(hasActiveBuilder(cargoSample), true, "hasActiveBuilder must detect cargo");
  assertEquals(formatActiveBuilders(cargoSample), "cargo");

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    cargoSample,
  );

  assertEquals(run.validMeasurement, false, "external cargo must be classified as contended measurement");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [cargo]");
});

Deno.test("slzv6: mixed parked esbuild and external rustc detects rustc as active contention", () => {
  const mixedSample: any = {
    measurable: true,
    load1: 1.8,
    load5: 1.1,
    cores: 2,
    loadPerCore: 0.9,
    compilers: 2,
    compilerNames: ["esbuild", "rustc"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  assertEquals(hasActiveBuilder(mixedSample), true);
  assertEquals(formatActiveBuilders(mixedSample), "rustc", "formatActiveBuilders must omit parked esbuild");

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    mixedSample,
  );

  assertEquals(run.validMeasurement, false, "presence of non-parked builder must invalidate run despite parked esbuild");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [rustc]");
});

Deno.test("slzv6: parked esbuild is omitted from diagnostics when another process has advanced ticks", () => {
  const sampleWithActiveRustc: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 2,
    compilerNames: ["esbuild", "rustc"],
    activeCompilers: 1,
    activeCompilerNames: ["rustc"],
  };

  assertEquals(hasActiveBuilder(sampleWithActiveRustc), true);
  assertEquals(formatActiveBuilders(sampleWithActiveRustc), "rustc", "formatActiveBuilders must not include parked esbuild when activeCompilers > 0");
});

Deno.test("slzv6: parked watchers (tsc, cargo-watch) with 0 activeCompilers remain admitted as valid", () => {
  for (const name of ["tsc", "cargo-watch"]) {
    const watcherSample: any = {
      measurable: true,
      load1: 0.3,
      load5: 0.2,
      cores: 2,
      loadPerCore: 0.15,
      compilers: 1,
      compilerNames: [name],
      activeCompilers: 0,
      activeCompilerNames: [],
    };

    assertEquals(hasActiveBuilder(watcherSample), false, `idle ${name} watcher must not trigger active builder detection`);

    const run = attributeBootRun(
      1,
      { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
      watcherSample,
    );

    assertEquals(run.validMeasurement, true, `idle ${name} watcher must be admitted as valid measurement`);
    assertEquals(run.hostLoaded, false);
    assertEquals(run.invalidReason, undefined);
  }
});

Deno.test("slzv6: active tsc and cargo-watch processes are detected as contention via activeCompilers", () => {
  for (const name of ["tsc", "cargo-watch"]) {
    const activeWatcherSample: any = {
      measurable: true,
      load1: 1.8,
      load5: 1.2,
      cores: 2,
      loadPerCore: 0.9,
      compilers: 1,
      compilerNames: [name],
      activeCompilers: 1,
      activeCompilerNames: [name],
    };

    assertEquals(hasActiveBuilder(activeWatcherSample), true);
    assertEquals(formatActiveBuilders(activeWatcherSample), name);

    const run = attributeBootRun(
      1,
      { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
      activeWatcherSample,
    );

    assertEquals(run.validMeasurement, false, `active ${name} compilation must invalidate run`);
    assertEquals(run.hostLoaded, true);
    assertStringIncludes(run.invalidReason!, `concurrent heavy builder detected during boot: [${name}]`);
  }
});

Deno.test("slzv6: hasDiscreteBuilder boolean preserves contention detection even if compilerNames is capped at 8 parked daemons", () => {
  // Simulates 8 parked esbuild/watcher daemons filling the 8-name diagnostic cap,
  // while a 9th process was rustc with flat ticks.
  const cappedSample: any = {
    measurable: true,
    load1: 2.5,
    load5: 1.8,
    cores: 2,
    loadPerCore: 1.25,
    compilers: 9,
    // 8 distinct parked names filling the array:
    compilerNames: ["esbuild", "tsc", "cargo-watch", "daemon4", "daemon5", "daemon6", "daemon7", "daemon8"],
    activeCompilers: 0,
    activeCompilerNames: [],
    hasDiscreteBuilder: true,
  };

  assertEquals(hasActiveBuilder(cappedSample), true, "hasDiscreteBuilder must trigger contention detection even if rustc was not in capped compilerNames array");

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    cappedSample,
  );

  assertEquals(run.validMeasurement, false, "run must be invalidated by hasDiscreteBuilder evidence");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [discrete builder (name omitted by diagnostic limit)]");
});

Deno.test("slzv6: rust toolchain variants (rust-lld, cargo-build) are detected as active builders", () => {
  for (const name of ["rust-lld", "cargo-build", "cargo-clippy", "cargo-check", "cargo-test", "rustup"]) {
    const sample: any = {
      measurable: true,
      load1: 1.0,
      load5: 0.5,
      cores: 2,
      loadPerCore: 0.5,
      compilers: 1,
      compilerNames: [name],
      activeCompilers: 0,
      activeCompilerNames: [],
    };
    assertEquals(hasActiveBuilder(sample), true, `${name} must be recognized by hasActiveBuilder`);
    assertEquals(formatActiveBuilders(sample), name);
    const run = attributeBootRun(
      1,
      { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
      sample,
    );
    assertEquals(run.validMeasurement, false, `${name} must be detected as contention`);
    assertStringIncludes(run.invalidReason!, `concurrent heavy builder detected during boot: [${name}]`);
  }
});

Deno.test("slzv6: isHeavyProcessName recognizes rustc, cargo, rust-lld, and cargo-* variants (including cargo-watch)", () => {
  for (const name of ["rustc", "cargo", "rust-lld", "cargo-build", "cargo-clippy", "cargo-check", "cargo-test", "cargo-watch", "rustup"]) {
    assert(isHeavyProcessName(name), `${name} must be recognized as heavy process`);
  }
  for (const name of ["deno", "node", "chrome", "chromium", "bash", "flock"]) {
    assertEquals(isHeavyProcessName(name), false, `${name} must NOT be recognized as heavy process`);
  }
});

Deno.test("slzv6: multi-run staging policy excludes rustc-contended runs from median calculation", () => {
  const cleanSample: any = {
    measurable: true,
    load1: 0.2,
    load5: 0.1,
    cores: 2,
    loadPerCore: 0.1,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
    activeCompilerNames: [],
  };
  const rustcSample: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 1,
    compilerNames: ["rustc"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  // Run 1: clean, 0 long tasks
  const run1 = attributeBootRun(1, { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] }, cleanSample);
  // Run 2: clean, 0 long tasks
  const run2 = attributeBootRun(2, { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] }, cleanSample);
  // Run 3: rustc contended with a 75ms long task
  const run3 = attributeBootRun(3, { composerReadyEndMs: 70, threadListHydratedEndMs: 90, longTasks: [{ duration: 75, startTime: 150 }] }, rustcSample);

  assertEquals(run1.validMeasurement, true);
  assertEquals(run2.validMeasurement, true);
  assertEquals(run3.validMeasurement, false, "run 3 under rustc must be classified as contended measurement");

  const policy = evaluateBootStagingPolicy([run1, run2, run3]);
  assertEquals(policy.ok, true, "contended run 3 with long task must be excluded from median");
  assertEquals(policy.validRuns.length, 2);
  assertEquals(policy.contendedRuns.length, 1);
  assertEquals(policy.medianTaskCount, 0);
});

Deno.test("0om0o: interval samples with unbaselined initial sample seeing parked esbuild daemons (flat CPU ticks) is admitted as valid", () => {
  // Simulates live boot sampling where initial sample (run without prior baseline, prev = null)
  // treats pre-existing parked esbuild daemons as newly seen / active (dnop artifact).
  // Later sample taken against previous CPU map proves 0 CPU tick accumulation (parked daemon).
  const baselineCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 120 }],
    ["3569751", { name: "esbuild", startTicks: "6000", cpuTicks: 450 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 3.60,
    load5: 2.84,
    cores: 2,
    loadPerCore: 1.80,
    compilers: 2,
    compilerNames: ["esbuild"],
    activeCompilers: 2, // newly seen via prev=null
    activeCompilerNames: ["esbuild"],
    cpu: baselineCpu,
  };

  const settledCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 120 }], // identical ticks -> parked!
    ["3569751", { name: "esbuild", startTicks: "6000", cpuTicks: 450 }], // identical ticks -> parked!
  ]);

  const settledSample: any = {
    measurable: true,
    load1: 3.40,
    load5: 2.80,
    cores: 2,
    loadPerCore: 1.70,
    compilers: 2,
    compilerNames: ["esbuild"],
    activeCompilers: 0, // proven 0 ticks advance
    activeCompilerNames: [],
    cpu: settledCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 42, threadListHydratedEndMs: 85, longTasks: [] },
    [initialSample, settledSample],
  );

  assertEquals(run.validMeasurement, true, "parked daemons with flat CPU across interval must be admitted as valid");
  assertEquals(run.invalidReason, undefined);
  assertEquals(run.hostLoaded, false);
});

Deno.test("0om0o: interval samples where an esbuild daemon genuinely advances CPU ticks is excluded as invalid contention", () => {
  const initialCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 120 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    cpu: initialCpu,
  };

  const compilingCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 175 }], // 55 ticks advanced!
  ]);

  const compilingSample: any = {
    measurable: true,
    load1: 2.5,
    load5: 1.8,
    cores: 2,
    loadPerCore: 1.25,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    cpu: compilingCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 42, threadListHydratedEndMs: 85, longTasks: [] },
    [initialSample, compilingSample],
  );

  assertEquals(run.validMeasurement, false, "actively compiling esbuild must be detected as contention");
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o: two-sample { pre, post } with parked esbuild daemon is admitted as valid measurement", () => {
  const sharedCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 120 }],
  ]);

  const pre: any = {
    measurable: true,
    load1: 1.0,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.5,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1, // unbaselined pre-sample
    activeCompilerNames: ["esbuild"],
    cpu: sharedCpu,
  };

  const post: any = {
    measurable: true,
    load1: 1.0,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.5,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0, // baselined post-sample proves 0 tick advance
    activeCompilerNames: [],
    cpu: sharedCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    { pre, post },
  );

  assertEquals(run.validMeasurement, true, "two-sample { pre, post } with parked esbuild must be valid");
  assertEquals(run.invalidReason, undefined);
});

Deno.test("0om0o: intermediate sample with activeCompilers > 0 seeing parked esbuild daemon (0 tick advance across interval) is admitted as valid", () => {
  // Production caller scenario (tests/ntp-boot-staging.test.ts):
  // s0: pre-navigation sample, esbuild daemon parked at cpuTicks 100
  // s1: intermediate sample in samplingLoop where esbuild was flagged activeCompilers 1 (newly seen PID / transient sampling artifact)
  // s2: post-navigation settling sample, esbuild daemon parked at cpuTicks 100 (activeCompilers 0)
  // Across the entire boot run [s0, s1, s2], PID 1285365 accumulated ZERO CPU ticks (100 === 100).
  // Must be admitted as a valid measurement.
  const sharedCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 100 }],
  ]);

  const s0: any = {
    measurable: true,
    load1: 1.0,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.5,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: sharedCpu,
    unbaselined: false,
  };

  const s1: any = {
    measurable: true,
    load1: 1.2,
    load5: 0.9,
    cores: 2,
    loadPerCore: 0.6,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1, // transiently flagged active
    activeCompilerNames: ["esbuild"],
    cpu: sharedCpu,
    unbaselined: false,
  };

  const s2: any = {
    measurable: true,
    load1: 1.1,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.55,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: sharedCpu,
    unbaselined: false,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [s0, s1, s2],
  );

  assertEquals(run.validMeasurement, true, "intermediate sample with parked esbuild daemon (0 tick advance) must be valid");
  assertEquals(run.hostLoaded, false);
  assertEquals(run.invalidReason, undefined);
});

Deno.test("0om0o falsifier: compiled-then-parked daemon (ticks advance mid-interval, parked at settling) is detected as contention", () => {
  // Coord P1 falsifier:
  // s0: pre-navigation sample, esbuild daemon at cpuTicks 50
  // s1: mid-interval compile, esbuild daemon at cpuTicks 120, activeCompilers 1
  // s2: post-navigation settling, esbuild finished compiling and parked at cpuTicks 120, activeCompilers 0
  // Even though it is parked at settling (activeCompilers 0), it ADVANCED CPU TICKS (120 > 50) during the boot interval!
  // It MUST be classified as contention.
  const s0Cpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);
  const s1Cpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 120 }],
  ]);
  const s2Cpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 120 }],
  ]);

  const s0: any = {
    measurable: true,
    load1: 1.0,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.5,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: s0Cpu,
  };

  const s1: any = {
    measurable: true,
    load1: 2.5,
    load5: 1.8,
    cores: 2,
    loadPerCore: 1.25,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    cpu: s1Cpu,
  };

  const s2: any = {
    measurable: true,
    load1: 1.8,
    load5: 1.4,
    cores: 2,
    loadPerCore: 0.9,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: s2Cpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [s0, s1, s2],
  );

  assertEquals(run.validMeasurement, false, "compiled-then-parked daemon must be detected as contention");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: restarted daemon / PID reuse (startTicks changes between boot start and settling) is detected as contention", () => {
  // Coord P2 falsifier:
  // s0: pre-navigation sample, PID 1001 has startTicks "1000", cpuTicks 50
  // s1: mid-interval, PID 1001 was restarted / reused with startTicks "2000", cpuTicks 50, activeCompilers 1
  // s2: post-navigation settling, PID 1001 has startTicks "2000", cpuTicks 50, activeCompilers 0
  // startTicks changed ("2000" !== "1000"), so this is a different process instance!
  // Must NOT be suppressed as the same parked daemon; must fail closed as contention.
  const s0Cpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);
  const s1Cpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "2000", cpuTicks: 50 }],
  ]);
  const s2Cpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "2000", cpuTicks: 50 }],
  ]);

  const s0: any = {
    measurable: true,
    load1: 1.0,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.5,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: s0Cpu,
  };

  const s1: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.1,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    cpu: s1Cpu,
  };

  const s2: any = {
    measurable: true,
    load1: 1.2,
    load5: 1.0,
    cores: 2,
    loadPerCore: 0.6,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: s2Cpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [s0, s1, s2],
  );

  assertEquals(run.validMeasurement, false, "restarted daemon (startTicks change) must be detected as contention");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: mid-interval active build [100, 150, 150] with activity [0, 1, 0] is detected as contention", () => {
  // Reviewer P1 falsifier:
  // s0: ticks 100, activeCompilers 0
  // s1: ticks 150, activeCompilers 1 (active mid-interval compilation during boot!)
  // s2: ticks 150, activeCompilers 0 (settled, but ticks advanced during boot)
  // Must NOT be dismissed as a parked daemon.
  const s0Cpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 100 }],
  ]);
  const s1Cpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 150 }],
  ]);
  const s2Cpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 150 }],
  ]);

  const s0: any = {
    measurable: true,
    load1: 1.0,
    load5: 0.8,
    cores: 2,
    loadPerCore: 0.5,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: s0Cpu,
  };

  const s1: any = {
    measurable: true,
    load1: 1.8,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.9,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    cpu: s1Cpu,
  };

  const s2: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.0,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: s2Cpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [s0, s1, s2],
  );

  assertEquals(run.validMeasurement, false, "mid-interval active build must be classified as contended measurement");
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: baselined initial sample (unbaselined: false) with active esbuild is detected as contention", () => {
  // Reviewer P1 falsifier:
  // Initial sample had a real predecessor comparison (unbaselined: false) and recorded activeCompilers > 0.
  // Its activity is real compilation, not a missing-baseline artifact; it must NOT be suppressed.
  const baselineCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 100 }],
  ]);
  const activeCpu: ProcCpuMap = new Map([
    ["1285365", { name: "esbuild", startTicks: "5000", cpuTicks: 150 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    cpu: activeCpu,
    unbaselined: false, // explicitly baselined!
  };

  const settledSample: any = {
    measurable: true,
    load1: 1.8,
    load5: 1.3,
    cores: 2,
    loadPerCore: 0.9,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: activeCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [initialSample, settledSample],
  );

  assertEquals(run.validMeasurement, false, "baselined initial sample with real active compilation must be contention");
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: unbaselined initial sample with active non-parkable builder (gcc) and parked esbuild is detected as contention", () => {
  // Reviewer P1 falsifier:
  // Initial sample has parked esbuild AND active gcc.
  // gcc exits before final sample.
  // Must NOT be suppressed as a parked daemon.
  const initialCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
    ["1002", { name: "gcc", startTicks: "1005", cpuTicks: 30 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 2.5,
    load5: 1.8,
    cores: 2,
    loadPerCore: 1.25,
    compilers: 2,
    compilerNames: ["esbuild", "gcc"],
    activeCompilers: 2,
    activeCompilerNames: ["esbuild", "gcc"],
    cpu: initialCpu,
    unbaselined: true,
  };

  // Final sample: gcc exited, only esbuild remains
  const finalCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);

  const finalSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: finalCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [initialSample, finalSample],
  );

  assertEquals(run.validMeasurement, false, "non-parkable builder (gcc) must never be suppressed");
  assertStringIncludes(run.invalidReason!, "gcc");
});

Deno.test("0om0o falsifier: unbaselined initial sample with disappearing esbuild daemon PID mid-interval is detected as contention", () => {
  // Reviewer P1 falsifier:
  // Initial sample had 2 esbuild daemons (PID 1001 and PID 1002).
  // PID 1002 was actually a short-lived compilation that exited before the final sample.
  // Must fail closed because PID 1002 disappeared.
  const initialCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
    ["1002", { name: "esbuild", startTicks: "1005", cpuTicks: 30 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 2,
    compilerNames: ["esbuild"],
    activeCompilers: 2,
    activeCompilerNames: ["esbuild"],
    cpu: initialCpu,
    unbaselined: true,
  };

  // Final sample: PID 1002 exited!
  const finalCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);

  const finalSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: finalCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [initialSample, finalSample],
  );

  assertEquals(run.validMeasurement, false, "disappearing esbuild daemon mid-interval must fail closed as contention");
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: valid empty baseline (prev.size === 0, unbaselined: false) with newly spawned esbuild PID is detected as contention", () => {
  // Reviewer P1 falsifier:
  // Baseline was taken on a quiet box with 0 heavy builders (empty predecessor map).
  // unbaselined is false (prev != null).
  // A newly spawned esbuild PID appears in the initial boot sample.
  // Even if its ticks remain flat in the next sample, it was spawned after the baseline!
  // It is real active contention and must NOT be suppressed as a pre-existing parked daemon.
  const newProcessCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "2000", cpuTicks: 40 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    cpu: newProcessCpu,
    unbaselined: false, // baselined against empty baseline!
  };

  const finalSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: newProcessCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [initialSample, finalSample],
  );

  assertEquals(run.validMeasurement, false, "newly spawned esbuild after empty baseline must be contention");
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: incomplete per-PID CPU evidence (compilers: 2 but 1 cpu entry) with disappearing builder fails closed as contention", () => {
  // Reviewer P1 falsifier:
  // Initial sample counted 2 esbuild processes (compilers: 2), but /proc stat read failed/skipped for one,
  // leaving only 1 entry in the cpu Map.
  // Final sample has 1 process (the untracked one disappeared mid-run).
  // Without complete per-PID CPU evidence for all observed builders, the suppression must NOT run.
  const partialCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 2, // 2 compilers observed, but only 1 in cpu map!
    compilerNames: ["esbuild"],
    activeCompilers: 2,
    activeCompilerNames: ["esbuild"],
    cpu: partialCpu,
    unbaselined: true,
  };

  const finalCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);

  const finalSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1, // 1 compiler at end (the other disappeared)
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: finalCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [initialSample, finalSample],
  );

  assertEquals(run.validMeasurement, false, "incomplete CPU evidence with disappearing builder must fail closed");
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: incomplete CPU map (compilers: 2, cpu.size: 1) with matching compiler counts fails closed as contention", () => {
  // Reviewer P2 falsifier:
  // Both samples report compilers: 2, but initialSample only has 1 CPU entry in cpu Map (e.g. unreadable stat).
  // Even though compiler counts match between samples (compilers: 2 === compilers: 2),
  // incomplete per-PID CPU evidence must fail closed.
  const partialCpu: ProcCpuMap = new Map([
    ["1001", { name: "esbuild", startTicks: "1000", cpuTicks: 50 }],
  ]);

  const initialSample: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 2, // 2 compilers observed, but only 1 in cpu map!
    compilerNames: ["esbuild"],
    activeCompilers: 2,
    activeCompilerNames: ["esbuild"],
    cpu: partialCpu,
    unbaselined: true,
  };

  const finalSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 2, // matching count!
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
    cpu: partialCpu,
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [initialSample, finalSample],
  );

  assertEquals(run.validMeasurement, false, "incomplete CPU evidence even with matching counts must fail closed");
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o falsifier: missing CPU maps fail closed as contention even if names and counts match", () => {
  // Reviewer P2 falsifier:
  // Initial and final samples have parked esbuild names and matching counts,
  // but lack CPU tick maps (cpu is undefined).
  // Without per-PID CPU maps, unchanged PID identity and 0 tick advance cannot be proved.
  // Must fail closed as contention.
  const initialSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 1,
    activeCompilerNames: ["esbuild"],
    unbaselined: true,
  };

  const finalSample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 1,
    compilerNames: ["esbuild"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    [initialSample, finalSample],
  );

  assertEquals(run.validMeasurement, false, "missing CPU map must fail closed as contention");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [esbuild]");
});

Deno.test("0om0o unit: readLoadSample with empty Map predecessor returns unbaselined: false, while null returns unbaselined: true", async () => {
  // Unit test verifying quiet-window's unbaselined flag behavior
  const { readLoadSample } = await import("../scripts/lib/quiet-window.ts");
  const nullSample = await readLoadSample(null, { budget: { entries: 10, ms: 50 } });
  assertEquals(nullSample.unbaselined, true);

  const emptyMapSample = await readLoadSample(new Map(), { budget: { entries: 10, ms: 50 } });
  assertEquals(emptyMapSample.unbaselined, false);
});

Deno.test("kjfza: ZERO_TICK_ACTIVE_BUILDERS is deduplicated and matches quiet-window canonical set", async () => {
  const quietWindow = await import("../scripts/lib/quiet-window.ts");
  const ntpAttribution = await import("../scripts/lib/ntp-boot-attribution.ts");

  // Canonical identity: re-exported set references the exact same Set instance
  assertStrictEquals(
    quietWindow.ZERO_TICK_ACTIVE_BUILDERS,
    ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS,
    "ZERO_TICK_ACTIVE_BUILDERS must be the exact same Set instance between quiet-window and ntp-boot-attribution",
  );

  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("rustc"));
  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("cargo"));
  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("rust-lld"));
  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("cargo-build"));
  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("cargo-check"));
  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("cargo-clippy"));
  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("cargo-test"));
  assert(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("rustup"));
  assertEquals(ntpAttribution.ZERO_TICK_ACTIVE_BUILDERS.has("esbuild"), false);
});

Deno.test("nffa7: parked watcher (cargo-watch/esbuild/tsc, 0 ticks) is never treated as an active builder", () => {
  // Requirement (a):
  // Verify that parked watchers with 0 CPU tick advance are admitted as valid measurements
  // and never classified as active builders.
  for (const watcher of ["cargo-watch", "esbuild", "tsc"]) {
    const sample: any = {
      measurable: true,
      load1: 1.0,
      load5: 0.8,
      cores: 2,
      loadPerCore: 0.5,
      compilers: 1,
      compilerNames: [watcher],
      activeCompilers: 0,
      activeCompilerNames: [],
    };

    assertEquals(isZeroTickActiveBuilder(watcher), false, `${watcher} must NOT be in zero-tick active builders`);
    assertEquals(hasActiveBuilder(sample), false, `parked ${watcher} with 0 ticks must NOT be an active builder`);

    const run = attributeBootRun(
      1,
      { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
      sample,
    );

    assertEquals(run.validMeasurement, true, `run under parked ${watcher} must be admitted as valid measurement`);
    assertEquals(run.hostLoaded, false);
    assertEquals(run.invalidReason, undefined);
  }
});

Deno.test("nffa7: multiple parked watchers concurrently with 0 ticks are never active builders", () => {
  // All three watchers running concurrently parked on the host
  const sample: any = {
    measurable: true,
    load1: 1.5,
    load5: 1.2,
    cores: 2,
    loadPerCore: 0.75,
    compilers: 3,
    compilerNames: ["cargo-watch", "esbuild", "tsc"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  assertEquals(hasActiveBuilder(sample), false);

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    sample,
  );

  assertEquals(run.validMeasurement, true);
  assertEquals(run.hostLoaded, false);
  assertEquals(run.invalidReason, undefined);
});

Deno.test("nffa7: parked watcher under elevated self-load (loadPerCore: 2.5, activeCompilers: 0) is admitted as valid", () => {
  // Parked watcher on a loaded host where elevated load is from test suite workers, not the watcher
  const sample: any = {
    measurable: true,
    load1: 5.0,
    load5: 4.0,
    cores: 2,
    loadPerCore: 2.5,
    compilers: 1,
    compilerNames: ["cargo-watch"],
    activeCompilers: 0,
    activeCompilerNames: [],
  };

  assertEquals(hasActiveBuilder(sample), false);

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    sample,
  );

  assertEquals(run.validMeasurement, true);
  assertEquals(run.hostLoaded, false);
});

Deno.test("nffa7 falsifier: cargo-watch with actively advancing CPU ticks IS detected as contention", () => {
  // When cargo-watch triggers a rebuild and its CPU ticks advance, activeCompilers > 0 must catch it
  const sample: any = {
    measurable: true,
    load1: 2.5,
    load5: 1.8,
    cores: 2,
    loadPerCore: 1.25,
    compilers: 1,
    compilerNames: ["cargo-watch"],
    activeCompilers: 1,
    activeCompilerNames: ["cargo-watch"],
  };

  assertEquals(hasActiveBuilder(sample), true);

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    sample,
  );

  assertEquals(run.validMeasurement, false);
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [cargo-watch]");
});

Deno.test("nffa7: build with >8 distinct compiler names still invalidates measurement (discrete builder cap bypass)", () => {
  // Requirement (b):
  // 8 parked daemons saturate the diagnostic compilerNames cap (size 8).
  // A 9th distinct compiler (rustc, discrete) is present on the host.
  // The 8-name cap must NOT bypass contention detection.
  const cappedSample: any = {
    measurable: true,
    load1: 2.5,
    load5: 1.8,
    cores: 2,
    loadPerCore: 1.25,
    compilers: 12, // 12 distinct compilers
    compilerNames: ["esbuild", "tsc", "cargo-watch", "daemon4", "daemon5", "daemon6", "daemon7", "daemon8"],
    activeCompilers: 0,
    activeCompilerNames: [],
    hasDiscreteBuilder: true, // unbounded evidence from sampler
  };

  assertEquals(hasActiveBuilder(cappedSample), true, "hasDiscreteBuilder must invalidate measurement regardless of 8-name cap");

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    cappedSample,
  );

  assertEquals(run.validMeasurement, false, "run must be invalidated when discrete builder exists beyond 8-name cap");
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "concurrent heavy builder detected during boot: [discrete builder (name omitted by diagnostic limit)]");
});

Deno.test("nffa7: build with >8 distinct compiler names still invalidates measurement (actively compiling cap bypass)", () => {
  // Requirement (b):
  // 12 distinct heavy compilers on the box, with multiple actively compiling processes.
  // compilerNames is capped at 8 names, but activeCompilers > 0 triggers contention.
  const sample: any = {
    measurable: true,
    load1: 3.5,
    load5: 2.5,
    cores: 2,
    loadPerCore: 1.75,
    compilers: 12,
    compilerNames: ["esbuild", "tsc", "cargo-watch", "daemon4", "daemon5", "daemon6", "daemon7", "daemon8"],
    activeCompilers: 3,
    activeCompilerNames: ["clang", "gcc", "ninja"],
  };

  assertEquals(hasActiveBuilder(sample), true, "actively compiling builders must invalidate measurement regardless of 8-name cap");

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    sample,
  );

  assertEquals(run.validMeasurement, false);
  assertEquals(run.hostLoaded, true);
  assertStringIncludes(run.invalidReason!, "clang,gcc,ninja");
});

Deno.test("nffa7: build with >8 distinct compiler names in legacy mock (activity unknown) still invalidates measurement", () => {
  // Legacy mock where activeCompilers is undefined and compilers > 8
  const sample: any = {
    measurable: true,
    load1: 2.0,
    load5: 1.5,
    cores: 2,
    loadPerCore: 1.0,
    compilers: 10,
    compilerNames: ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"],
    activeCompilers: undefined,
  };

  assertEquals(hasActiveBuilder(sample), true, "activity-unknown mock with >8 compilers must fail closed");

  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    sample,
  );

  assertEquals(run.validMeasurement, false);
  assertEquals(run.hostLoaded, true);
});

Deno.test("nffa7 end-to-end: readLoadSample with 12 distinct processes preserves discrete builder and invalidates boot measurement", async () => {
  // End-to-end verification through quiet-window's readLoadSample sampler seam.
  // Simulate ps output containing 12 distinct heavy processes:
  // 8 parked daemons + 4 discrete builders (rustc, cargo, rust-lld, cargo-build).
  const { readLoadSample } = await import("../scripts/lib/quiet-window.ts");

  const mockPsOutput = [
    "  101 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/esbuild",
    "  102 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/tsc",
    "  103 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/cargo-watch",
    "  104 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/cc1",
    "  105 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/cc1plus",
    "  106 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/ld",
    "  107 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/lld",
    "  108 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/gold",
    "  109 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/rustc",
    "  110 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/cargo",
    "  111 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/rust-lld",
    "  112 00:00:00 Wed Oct  7 12:00:00 2026 /usr/bin/cargo-build",
  ].join("\n");

  const sample = await readLoadSample(null, {
    hasProc: false,
    runPs: async () => ({ code: 0, stdout: mockPsOutput }),
    loadavg: () => [1.5, 1.2, 1.0],
  });

  assertEquals(sample.measurable, true);
  assertEquals(sample.compilers, 12, "compilers count must reflect all 12 processes (not capped at 8)");
  assertEquals(sample.compilerNames.length, 8, "compilerNames array must be capped at 8 entries for diagnostics");
  assertEquals(sample.hasDiscreteBuilder, true, "hasDiscreteBuilder must be true because rustc/cargo were present");

  // Discrete builders must have evicted non-discrete daemons from compilerNames
  assert(sample.compilerNames.includes("rustc"), "rustc must be in compilerNames");
  assert(sample.compilerNames.includes("cargo"), "cargo must be in compilerNames");

  // Attribution must invalidate the boot run
  assertEquals(hasActiveBuilder(sample), true);
  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    sample,
  );
  assertEquals(run.validMeasurement, false, "measurement must be invalidated by discrete builder presence");
  assertEquals(run.hostLoaded, true);
});

Deno.test("nffa7 end-to-end: readLoadSample with 10 distinct actively compiling processes preserves active count and invalidates boot measurement", async () => {
  // End-to-end verification through quiet-window's readLoadSample sampler seam.
  // 10 distinct compilers with CPU advance between sample 1 and sample 2.
  const { readLoadSample } = await import("../scripts/lib/quiet-window.ts");

  const psSample1 = [
    "  201 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/esbuild",
    "  202 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/tsc",
    "  203 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/clang",
    "  204 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/clang++",
    "  205 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/gcc",
    "  206 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/g++",
    "  207 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/ninja",
    "  208 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/make",
    "  209 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/wasm-ld",
    "  210 00:00:01 Wed Oct  7 12:00:00 2026 /usr/bin/wasm-opt",
  ].join("\n");

  const psSample2 = [
    "  201 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/esbuild",
    "  202 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/tsc",
    "  203 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/clang",
    "  204 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/clang++",
    "  205 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/gcc",
    "  206 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/g++",
    "  207 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/ninja",
    "  208 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/make",
    "  209 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/wasm-ld",
    "  210 00:00:05 Wed Oct  7 12:00:00 2026 /usr/bin/wasm-opt",
  ].join("\n");

  const sample1 = await readLoadSample(null, {
    hasProc: false,
    runPs: async () => ({ code: 0, stdout: psSample1 }),
    loadavg: () => [2.0, 1.8, 1.5],
  });

  const sample2 = await readLoadSample(sample1.cpu, {
    hasProc: false,
    runPs: async () => ({ code: 0, stdout: psSample2 }),
    loadavg: () => [2.5, 2.0, 1.7],
  });

  assertEquals(sample2.measurable, true);
  assertEquals(sample2.compilers, 10, "compilers count must reflect all 10 processes");
  assertEquals(sample2.activeCompilers, 10, "activeCompilers must count all 10 processes that advanced CPU ticks");
  assertEquals(sample2.compilerNames.length, 8, "compilerNames array must be capped at 8");
  assertEquals(sample2.activeCompilerNames?.length, 8, "activeCompilerNames array must be capped at 8");

  assertEquals(hasActiveBuilder(sample2), true);
  const run = attributeBootRun(
    1,
    { composerReadyEndMs: 40, threadListHydratedEndMs: 80, longTasks: [] },
    sample2,
  );
  assertEquals(run.validMeasurement, false, "measurement must be invalidated by actively compiling builders");
  assertEquals(run.hostLoaded, true);
});

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

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { classifyActiveBuilders, type ProcCpuMap } from "../scripts/lib/quiet-window.ts";
import {
  correlateLongTask,
  attributeBootRun,
  evaluateBootStagingPolicy,
  formatTaskAttribution,
  failedSample,
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

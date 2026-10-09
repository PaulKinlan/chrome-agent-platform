// @ts-nocheck
// tests/ntp-boot-staging.test.ts — verifies staged render pipeline and deferred custom elements (9epn.2).
//
// Invariants tested:
//   1. runStagedBoot runs Stage 1 (critical path) before Stage 2.
//   2. runStagedBoot yields between Stage 1 and Stage 2A, and between Stage 2A and Stage 2B.
//   3. Errors in individual stage widgets do not fail or abort the remaining stages.
//   4. Deferred custom elements on NTP: non-hub elements are deferred until first use/flush,
//      while hub elements are defined synchronously.
//   5. In headless Chrome for Testing, ntp.html boots with longTasksCount === 0 across 3 cold runs,
//      with composer-ready < 150ms and thread-list-hydrated <= 250ms.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

// Stub minimal browser globals for importing components.js in Deno test runner
const registry = new Map();
class HTMLElementStub {
  constructor() { this._attrs = new Map(); }
  attachShadow() { return { querySelector: () => null, querySelectorAll: () => [] }; }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
}
if (!globalThis.HTMLElement) {
  globalThis.HTMLElement = HTMLElementStub;
}
if (!globalThis.customElements) {
  globalThis.customElements = {
    define(name, cls) { registry.set(name, cls); },
    get(name) { return registry.get(name); },
  };
}

import { runStagedBoot } from "../extension/ntp/ntp-boot-scheduler.js";
const { NON_HUB_ELEMENTS, flushDeferredComponents } = await import("../extension/shared/components.js");
import { launchChrome, openCdp, waitForServiceWorker, teardownChrome, resolveChromiumBinaryReport } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  getLongTaskObserverSource,
  getBootMetricsExtractionSource,
  attributeBootRun,
  evaluateBootStagingPolicy,
  formatTaskAttribution,
  failedSample,
  ENVIRONMENTAL_REFUSAL_MARKER,
  ENVIRONMENTAL_REFUSAL_EXIT,
} from "../scripts/lib/ntp-boot-attribution.ts";
import { readLoadSample, type LoadSample } from "../scripts/lib/quiet-window.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_DIR = `${ROOT}/extension`;
const { binary: RESOLVED_BIN, tried: TRIED_BINS } = resolveChromiumBinaryReport();

Deno.test("ntp-boot-staging: runStagedBoot executes Stage 1 before Stage 2 and yields between batches", async () => {
  const log: string[] = [];
  const yields: number[] = [];

  const fakeYield = async () => {
    yields.push(log.length);
  };

  const stages = {
    stage1: {
      tasks: () => { log.push("stage1:tasks"); },
      firstRunGuide: () => { log.push("stage1:firstRunGuide"); },
      timeline: () => { log.push("stage1:timeline"); },
    },
    stage2A: {
      providerStatus: () => { log.push("stage2A:providerStatus"); },
      commandStarters: () => { log.push("stage2A:commandStarters"); },
      webmcpStatus: () => { log.push("stage2A:webmcpStatus"); },
    },
    stage2B: {
      actionLedger: () => { log.push("stage2B:actionLedger"); },
      jobsBoard: () => { log.push("stage2B:jobsBoard"); },
      hubUsage: () => { log.push("stage2B:hubUsage"); },
    },
  };

  const result = await runStagedBoot(stages, { yieldFn: fakeYield, initialYield: true });

  // Initial yield before Stage 1 (at index 0) to allow evaluateModule task to finish
  assertEquals(yields[0], 0);
  // Stage 1 executed first
  assertEquals(log.slice(0, 3), ["stage1:tasks", "stage1:firstRunGuide", "stage1:timeline"]);
  // Yield after stage 1 (at index 3)
  assertEquals(yields[1], 3);
  // Stage 2A executed next
  assertEquals(log.slice(3, 6), ["stage2A:providerStatus", "stage2A:commandStarters", "stage2A:webmcpStatus"]);
  // Yield after stage 2A (at index 6)
  assertEquals(yields[2], 6);
  // Stage 2B executed last
  assertEquals(log.slice(6, 9), ["stage2B:actionLedger", "stage2B:jobsBoard", "stage2B:hubUsage"]);
  assertEquals(result.executionOrder.length, 9);
  assertEquals(result.yields, [3, 6], "result.yields must record batch boundaries");
});

Deno.test("ntp-boot-staging: runStagedBoot tolerates failing stage functions without aborting", async () => {
  const log: string[] = [];

  const stages = {
    stage1: {
      good1: () => { log.push("g1"); },
      bad1: () => { throw new Error("stage 1 crash"); },
      good2: () => { log.push("g2"); },
    },
    stage2A: {
      bad2: () => Promise.reject(new Error("async reject")),
      good3: () => { log.push("g3"); },
    },
  };

  await runStagedBoot(stages, { yieldFn: async () => {} });
  assertEquals(log, ["g1", "g2", "g3"]);
});

Deno.test("ntp-boot-staging: non-hub custom elements set contains heavy components", () => {
  assert(NON_HUB_ELEMENTS.has("tool-library"), "tool-library must be non-hub");
  assert(NON_HUB_ELEMENTS.has("system-prompt-editor"), "system-prompt-editor must be non-hub");
  assert(NON_HUB_ELEMENTS.has("activity-explorer"), "activity-explorer must be non-hub");
  assert(NON_HUB_ELEMENTS.has("model-picker"), "model-picker must be non-hub");
  assert(NON_HUB_ELEMENTS.has("webmcp-consent-manager"), "webmcp-consent-manager must be non-hub");
  assert(!NON_HUB_ELEMENTS.has("agent-composer"), "agent-composer must be hub element");
  assert(!NON_HUB_ELEMENTS.has("first-run-guide"), "first-run-guide must be hub element");
  assert(!NON_HUB_ELEMENTS.has("task-row"), "task-row must be hub element");
});

Deno.test("ntp-boot-staging: headless Chrome for Testing boots ntp.html with 0 long tasks across 5 runs", async () => {
  if (RESOLVED_BIN === null) {
    console.warn(`Skipping browser test: no Chrome resolvable on host (tried: ${TRIED_BINS.join("; ")})`);
    return;
  }
  const CHROME_BIN = RESOLVED_BIN;

  const tmp = durableDir(`cap-ntp-boot-${Date.now()}`);
  const lockPath = `${tmp}/chrome.lock`;

  let chrome = null;
  let client = null;
  try {
    chrome = await launchChrome({
      binary: CHROME_BIN,
      extension: EXT_DIR,
      profile: tmp,
      lockPath,
      timeoutMs: 30000,
    });
    client = await openCdp(chrome.wsUrl);

    const sw = await waitForServiceWorker(client.send, {
      timeoutMs: 15000,
      match: (t) => typeof t.url === "string" && t.url.includes("dist/background/service-worker.js"),
    });
    assert(sw, "Service worker must start");
    const extId = sw.url.split("/")[2];

    const runResults = [];
    for (let run = 1; run <= 5; run++) {
      const openTarget = await client.open("about:blank");
      const { targetId, sessionId } = openTarget;

      await client.send("Runtime.enable", {}, sessionId);
      await client.send("Page.enable", {}, sessionId);

      // Register PerformanceObserver before any document script executes (longtask + loaf)
      await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: getLongTaskObserverSource(),
      }, sessionId);

      // 1. Establish baseline CPU map so pre-existing parked builders are known and not misclassified as active
      const baselineSample = await readLoadSample().catch(failedSample);
      await new Promise((r) => setTimeout(r, 60)); // short baseline delta for tick comparison
      let currentSample = await readLoadSample(baselineSample.cpu ?? null).catch(failedSample);
      const intervalSamples = [currentSample];
      if (!baselineSample.measurable) intervalSamples.unshift(baselineSample);

      let samplingActive = true;
      let sampleInFlight = Promise.resolve();

      // Serialized async sampling loop started BEFORE navigation to bracket the full boot interval
      const samplingLoop = (async () => {
        while (samplingActive) {
          await new Promise((r) => setTimeout(r, 200));
          if (!samplingActive) break;
          sampleInFlight = (async () => {
            const s = await readLoadSample(currentSample.cpu ?? null).catch(failedSample);
            currentSample = s;
            intervalSamples.push(s);
          })();
          await sampleInFlight;
        }
      })();

      try {
        await client.send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, sessionId);

        // Wait for document to load completely
        await client.eval(sessionId, `new Promise(r => { if (document.readyState === 'complete') r(); else addEventListener('load', r, { once: true }); })`);
        // Let microtasks and staged batches settle
        await new Promise((r) => setTimeout(r, 600));
      } finally {
        samplingActive = false;
        await samplingLoop;
        await sampleInFlight;
      }

      const rawMetrics = await client.eval(sessionId, getBootMetricsExtractionSource());
      // Final sample after boot settling
      const postSample = await readLoadSample(currentSample.cpu ?? null).catch(failedSample);
      intervalSamples.push(postSample);

      const runResult = attributeBootRun(run, rawMetrics, intervalSamples);
      runResults.push(runResult);

      console.log(`[ntp-boot-staging] Run ${run}: longTasksCount=${runResult.longTasks.length}, composerReadyMs=${runResult.composerReadyMs}, threadListHydratedMs=${runResult.threadListHydratedMs}, validMeasurement=${runResult.validMeasurement}, longTasks=${runResult.longTasks.map(formatTaskAttribution).join("; ") || "none"}`);

      await client.send("Target.closeTarget", { targetId }).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    }

    const policy = evaluateBootStagingPolicy(runResults);
    for (const w of policy.warnings) console.warn(w);
    if (!policy.ok) {
      if (policy.environmentalRefusal) {
        console.error(
          `${ENVIRONMENTAL_REFUSAL_MARKER} ${JSON.stringify({ reason: "boot-staging-contended", runs: runResults.length, error: policy.error })}`,
        );
        console.error(policy.error);
        throw (policy.refusalError ?? new Error(policy.error));
      }
      assert(policy.ok, policy.error);
    }
  } finally {
    if (client) client.close();
    await teardownChrome(chrome, tmp);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

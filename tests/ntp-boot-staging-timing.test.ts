// @ts-nocheck
// tests/ntp-boot-staging-timing.test.ts — the WALL-CLOCK half of the NTP boot contract (9epn.2).
//
// WHY THIS IS IN THE HEAVY TIER (chrome-agent-platform-mr1ak): these assertions are wall-clock
// budgets measured in a real browser (median long tasks 0, composer-ready < 150ms,
// thread-list-hydrated <= 250ms). On a shared 8-vCPU fleet box the load comes from SIBLING lanes'
// Deno/Chrome test workers - high load/core with zero compilers - so the contention classification
// (which requires positive evidence of an external COMPILER) never fires and a 52-109ms scheduler
// stall was reported as a product defect: it reddened the FULL gate at load/core 0.84 against the
// repo's own quiet bound of 0.35, and suppressed 658 parallel files. A wall-clock budget belongs
// where the box can be quiet, which is what `npm run test:heavy` provides.
//
// The FULL gate still certifies that the hub BOOTS without any timing budget:
// tests/ntp-rpc-census.test.ts and the other browser tests load ntp.html and assert outcomes
// (service worker starts, RPC counts, DOM structure), and the structural boot-scheduler
// assertions stay in tests/ntp-boot-staging.test.ts.

import { assert } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
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
// rvht7: acquire a quiet window BEFORE measuring, instead of asserting one from inside the least quiet job on
// the box. Bounded wait; a window that never arrives is an environmental refusal (exit 75), never a product red.
import { acquireQuietWindowForHeavyRun } from "../scripts/lib/heavy-quiet-acquire.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_DIR = `${ROOT}/extension`;
const { binary: RESOLVED_BIN, tried: TRIED_BINS } = resolveChromiumBinaryReport();

Deno.test("ntp-boot-staging: headless Chrome for Testing boots ntp.html with 0 long tasks across 5 runs", async () => {
  if (RESOLVED_BIN === null) {
    console.warn(`Skipping browser test: no Chrome resolvable on host (tried: ${TRIED_BINS.join("; ")})`);
    return;
  }
  const CHROME_BIN = RESOLVED_BIN;

  // rvht7 — the measurement this file makes is "the box was quiet", so the box must BE quiet before the first
  // budget is read. scripts/heavy-gate.ts runs this file alone and after its parallel batch; this call is the
  // part that makes that promise true even when someone runs the file directly. The wait is bounded
  // (CAP_QUIET_ACQUIRE_MS, default 180s) and a refusal is environmental: the marker is printed by the helper and
  // the thrown QuietWindowRefusedError is classified as exit 75 by the runners, so this can never read as a
  // failure of the tree.
  await acquireQuietWindowForHeavyRun({ label: "ntp-boot-staging-timing" });

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

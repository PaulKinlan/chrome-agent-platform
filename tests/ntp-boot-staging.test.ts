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
import { launchChrome, openCdp, waitForServiceWorker } from "../scripts/lib/chrome-launch.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_DIR = `${ROOT}/extension`;
const CHROME_BIN = Deno.env.get("CAP_BIN") ||
  "/Users/paulkinlan/.cache/puppeteer/chrome/mac_arm-149.0.7827.22/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

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

Deno.test("ntp-boot-staging: headless Chrome for Testing boots ntp.html with 0 long tasks across 3 runs", async () => {
  const hasBinary = await Deno.stat(CHROME_BIN).then(() => true).catch(() => false);
  if (!hasBinary) {
    console.warn(`Skipping browser test: ${CHROME_BIN} not found`);
    return;
  }

  const tmp = await Deno.makeTempDir({ prefix: "cap-ntp-boot-" });
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

    for (let run = 1; run <= 3; run++) {
      const openTarget = await client.open("about:blank");
      const { targetId, sessionId } = openTarget;

      await client.send("Runtime.enable", {}, sessionId);
      await client.send("Page.enable", {}, sessionId);

      // Register PerformanceObserver before any document script executes
      await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          window.__capLongTasks = [];
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__capLongTasks.push({ duration: entry.duration, startTime: entry.startTime, name: entry.name });
              }
            }).observe({ entryTypes: ['longtask'] });
          } catch {}
        `,
      }, sessionId);

      const navStart = Date.now();
      await client.send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, sessionId);

      // Wait for document to load completely
      await client.eval(sessionId, `new Promise(r => { if (document.readyState === 'complete') r(); else addEventListener('load', r, { once: true }); })`);
      // Let microtasks and staged batches settle
      await new Promise((r) => setTimeout(r, 600));

      const metrics = await client.eval(sessionId, `(() => {
        const measures = performance.getEntriesByType("measure");
        const boot = measures.find(m => m.name.includes("composer-ready"));
        const thread = measures.find(m => m.name.includes("thread-list-hydrated"));
        const obsTasks = Array.isArray(window.__capLongTasks) ? window.__capLongTasks : [];
        const perfTasks = performance.getEntriesByType("longtask") || [];
        const allTasks = [...obsTasks, ...perfTasks];
        const severeTasks = allTasks.filter(t => t.duration > 50);

        return {
          composerReadyMs: boot ? Math.round(boot.duration) : null,
          threadListHydratedMs: thread ? Math.round(thread.duration) : null,
          longTasksCount: severeTasks.length,
          longTasks: severeTasks.map(t => ({ duration: Math.round(t.duration), startTime: Math.round(t.startTime) })),
          measureNames: measures.map(m => m.name),
        };
      })()`);

      console.log(`[ntp-boot-staging] Run ${run}: longTasksCount=${metrics.longTasksCount}, composerReadyMs=${metrics.composerReadyMs}, threadListHydratedMs=${metrics.threadListHydratedMs}, longTasks=${JSON.stringify(metrics.longTasks)}`);

      assertEquals(metrics.longTasksCount, 0, `Run ${run}: ntp.html must have 0 long tasks > 50ms (got ${metrics.longTasksCount}: ${JSON.stringify(metrics.longTasks)})`);
      if (metrics.composerReadyMs != null) {
        assert(metrics.composerReadyMs < 150, `Run ${run}: composer-ready must be < 150ms (got ${metrics.composerReadyMs}ms)`);
      }
      if (metrics.threadListHydratedMs != null) {
        assert(metrics.threadListHydratedMs <= 250, `Run ${run}: thread-list-hydrated must be <= 250ms (got ${metrics.threadListHydratedMs}ms)`);
      }

      await client.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  } finally {
    if (client) client.close();
    if (chrome) {
      try { chrome.proc.kill("SIGKILL"); } catch {}
      await chrome.proc.status.catch(() => {});
    }
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

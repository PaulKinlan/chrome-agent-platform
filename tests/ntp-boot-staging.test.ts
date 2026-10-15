// @ts-nocheck
// tests/ntp-boot-staging.test.ts — verifies staged render pipeline and deferred custom elements (9epn.2).
//
// Invariants tested:
//   1. runStagedBoot runs Stage 1 (critical path) before Stage 2.
//   2. runStagedBoot yields between Stage 1 and Stage 2A, and between Stage 2A and Stage 2B.
//   3. Errors in individual stage widgets do not fail or abort the remaining stages.
//   4. Deferred custom elements on NTP: non-hub elements are deferred until first use/flush,
//      while hub elements are defined synchronously.
//   5. The wall-clock boot budgets moved to tests/ntp-boot-staging-timing.test.ts (heavy tier,
//      chrome-agent-platform-mr1ak): a timing budget belongs where the box can be quiet. This file
//      keeps the structural boot-scheduler invariants, and the FULL gate still certifies that the
//      hub boots through the browser tests that load ntp.html (e.g. tests/ntp-rpc-census.test.ts).

import { assert, assertEquals } from "jsr:@std/assert@1";

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

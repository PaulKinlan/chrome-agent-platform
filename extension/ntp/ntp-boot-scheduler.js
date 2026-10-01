// ntp-boot-scheduler.js — staged render pipeline for the Agent Hub boot.
// Replaces the monolithic boot fan-out with a staged pipeline that yields to
// the browser between batches, eliminating the input-blocking 50+ ms long task
// (CONSTITUTION §4).

import { sleep } from "../lib/pure.js";

export async function defaultYield() {
  if (typeof window !== "undefined" && window.scheduler && typeof window.scheduler.yield === "function") {
    await window.scheduler.yield();
  } else {
    await sleep(0);
  }
}

/**
 * Executes boot renders in staged batches with yields between them.
 *
 * Stage 1: Critical path before first paint (sidebar thread list, onboarding, timeline)
 * [yield to browser]
 * Stage 2A: Primary secondary widgets (provider status, command starters, webmcp status, site/named agents)
 * [yield to browser]
 * Stage 2B: Background overview widgets (action ledger, jobs board, hub usage)
 *
 * @param {object} stages - Object containing stage1, stage2A, and stage2B function maps
 * @param {object} [options]
 * @param {Function} [options.yieldFn] - Yield function (scheduler.yield or setTimeout 0)
 * @returns {Promise<{ executionOrder: string[], yields: number[] }>}
 */
export async function runStagedBoot(stages, { yieldFn = defaultYield, initialYield = true } = {}) {
  const executionOrder = [];
  const yields = [];

  // Yield before starting renders so module evaluation completes cleanly
  // without piling microtasks into the initial evaluateModule task.
  if (initialYield && typeof yieldFn === "function") {
    await yieldFn();
  }

  // Stage 1: Critical path before first paint
  if (stages?.stage1) {
    for (const [name, fn] of Object.entries(stages.stage1)) {
      if (typeof fn === "function") {
        try {
          executionOrder.push(name);
          const res = fn();
          if (res && typeof res.catch === "function") {
            res.catch(() => {});
          }
        } catch {
          // Best effort; boot proceeds
        }
      }
    }
  }

  // Yield to browser to permit first paint and input handling
  if (typeof yieldFn === "function") {
    yields.push(executionOrder.length);
    await yieldFn();
  }

  // Stage 2A: Primary secondary widgets
  if (stages?.stage2A) {
    for (const [name, fn] of Object.entries(stages.stage2A)) {
      if (typeof fn === "function") {
        try {
          executionOrder.push(name);
          const res = fn();
          if (res && typeof res.catch === "function") {
            res.catch(() => {});
          }
        } catch {
          // Best effort
        }
      }
    }
  }

  // Yield between secondary batches
  if (typeof yieldFn === "function" && stages?.stage2B) {
    yields.push(executionOrder.length);
    await yieldFn();
  }

  // Stage 2B: Overview widgets
  if (stages?.stage2B) {
    for (const [name, fn] of Object.entries(stages.stage2B)) {
      if (typeof fn === "function") {
        try {
          executionOrder.push(name);
          const res = fn();
          if (res && typeof res.catch === "function") {
            res.catch(() => {});
          }
        } catch {
          // Best effort
        }
      }
    }
  }

  return { executionOrder, yields };
}

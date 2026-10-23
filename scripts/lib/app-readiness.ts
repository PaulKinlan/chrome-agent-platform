// scripts/lib/app-readiness.ts — shared readiness primitive for journey/KAT harnesses (chrome-agent-platform-iksuc).
//
// Invariant: harnesses must NOT interact with an unhydrated app page (NTP, sidepanel, options).
// Pre-hydration clicks silently no-op because event listeners are not installed yet, leading to
// false INCONCLUSIVE results and wasted runs.
//
// This module provides:
// 1. APP_READY_ATTR: standard readiness marker if set by an app page.
// 2. APP_NEVER_BECAME_READY: the NAMED failure state reported when readiness wait times out.
// 3. waitForAppReady(): polls for the named app-ready signal or hydration state with bounded wait
//    and throws `app never became ready` on timeout.
// 4. interactWhenReady(): waits for app readiness before executing an interaction.

import { isCdpEvaluateTimeout } from "./quiet-window.ts";
import { CdpEvaluateLoadTimeoutError, CdpEvaluateIdleTimeoutError } from "./kat-evaluate.ts";

export const APP_READY_ATTR = "data-cap-app-ready";
export const APP_NEVER_BECAME_READY = "app never became ready";

export const APP_READY_EXPRESSION = `(() => {
  try {
    const doc = document;
    if (!doc) return { ready: false, reason: "no document" };

    if (doc.documentElement?.dataset?.capAppReady === "true" ||
        doc.documentElement?.getAttribute?.("${APP_READY_ATTR}") === "true") {
      return { ready: true, signal: "${APP_READY_ATTR}" };
    }

    const path = (location.pathname || "").toLowerCase();

    // NTP Hub: interactive once stage2B mounts jobs-board and named-agents container has hydrated
    if (path.includes("/ntp/ntp.html") || path.endsWith("/ntp.html") || path.endsWith("/ntp/")) {
      const jobsBoard = doc.querySelector("#jobs-board-host jobs-board");
      const namedAgents = doc.querySelector("#named-agents");
      const namedHydrated = !!namedAgents && namedAgents.children.length > 0;
      if (jobsBoard && namedHydrated) {
        return { ready: true, signal: "ntp-hydrated" };
      }
      return { ready: false, reason: "ntp hydration pending", jobsBoard: !!jobsBoard, namedHydrated };
    }

    // Sidepanel: interactive once custom elements are defined, tabs are wired, and composer is in DOM
    if (path.includes("/sidepanel/sidepanel.html") || path.endsWith("/sidepanel.html")) {
      const composer = doc.getElementById("page-composer") || doc.getElementById("agent-composer") || doc.querySelector("agent-composer");
      const tabAgents = doc.getElementById("tab-agents");
      const customElementsReady = typeof customElements !== "undefined" &&
        !!customElements.get("agent-composer") &&
        !!customElements.get("agent-picker");
      if (composer && tabAgents && customElementsReady && doc.readyState === "complete") {
        return { ready: true, signal: "sidepanel-hydrated" };
      }
      return { ready: false, reason: "sidepanel hydration pending", composer: !!composer, tabAgents: !!tabAgents, customElementsReady };
    }

    // Options: interactive once document is complete, active section is mounted,
    // and target controls for that section have hydrated (not just static nav header buttons; z4tzw).
    if (path.includes("/options/options.html") || path.endsWith("/options.html")) {
      if (doc.readyState !== "complete") {
        return { ready: false, reason: "options document not complete", readyState: doc.readyState };
      }
      const rawHash = (location.hash || "").replace(/^#/, "").toLowerCase();
      const targetSection = rawHash || "providers";
      const targetPanel = doc.getElementById(targetSection) || (doc.querySelector && doc.querySelector("section#" + targetSection));

      if (targetSection === "board-permissions") {
        const agentSelect = doc.getElementById("board-deny-agent");
        const addBtn = doc.getElementById("board-deny-add-btn");
        const panelActive = !!targetPanel && (targetPanel.classList?.contains?.("active") || targetPanel.dataset?.active === "true");
        // Populated once populateBoardDenyAgents sets agentSelect.providers array with at least Hub and agent entries
        const providersHydrated = !!agentSelect && (Array.isArray(agentSelect.providers) ? agentSelect.providers.length > 0 : ((agentSelect.getAttribute?.("providers") || "").length > 2));
        if (agentSelect && addBtn && panelActive && providersHydrated) {
          return { ready: true, signal: "options-hydrated" };
        }
        return {
          ready: false,
          reason: "options board permissions hydration pending",
          agentSelect: !!agentSelect,
          addBtn: !!addBtn,
          panelActive,
          providersHydrated,
        };
      }

      if (targetSection === "providers") {
        // Must find genuinely rendered provider cards, never just the error/retry button or dead selectors (97qd6)
        const hasCards = (doc.querySelectorAll?.("#provider-panels .provider-card")?.length ?? 0) > 0;
        if (hasCards) {
          return { ready: true, signal: "options-hydrated" };
        }
        return { ready: false, reason: "options providers hydration pending" };
      }

      // Generic options section: target panel must be active and have internal controls
      const panelActive = !!targetPanel && (targetPanel.classList?.contains?.("active") || targetPanel.dataset?.active === "true");
      const hasPanelControls = !!targetPanel && !!targetPanel.querySelector?.("input, select, button, [role=tab], [role=radio], provider-select, switch-toggle");
      const legacyForm = doc.getElementById("settings-form");
      if ((panelActive && hasPanelControls) || legacyForm) {
        return { ready: true, signal: "options-hydrated" };
      }
      return { ready: false, reason: "options section hydration pending", targetSection, panelActive, hasPanelControls };
    }

    if (doc.readyState === "complete") {
      return { ready: true, signal: "document-complete" };
    }
    return { ready: false, readyState: doc.readyState };
  } catch (e) {
    return { ready: false, error: String(e) };
  }
})()`;

/**
 * The clock and timer functions the poll loop runs on, injectable so a unit test can
 * drive the loop deterministically instead of asserting poll counts against real
 * elapsed milliseconds (chrome-agent-platform-2y6fr: on a loaded box one scheduling
 * overshoot could consume the whole timeoutMs budget and a test that asserts
 * "must poll multiple times" observed a single poll — a red that named the fixture
 * rather than the product). Defaults to the real clock; callers that pass nothing
 * keep the previous behaviour exactly.
 */
export interface AppReadinessTimers {
  now(): number;
  setTimeout(fn: (...args: any[]) => void, ms: number): any;
  clearTimeout(handle: any): void;
}

const REAL_READINESS_TIMERS: AppReadinessTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface AppReadinessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  surfaceName?: string;
  predicateExpr?: string;
  probeTimeoutMs?: number;
  /** Clock/timer source for the poll loop; defaults to the real one (2y6fr). */
  timers?: AppReadinessTimers;
}

export interface AppReadinessResult {
  ready: true;
  signal: string;
  elapsedMs: number;
}

/**
 * Classifies an evaluator rejection as a transport or classified evaluate timeout
 * that must propagate directly rather than being swallowed into an app-hydration failure (u7p0b).
 */
export function isTransportOrEvaluateTimeoutError(e: any): boolean {
  if (!e) return false;
  if (e instanceof CdpEvaluateLoadTimeoutError || e?.name === "CdpEvaluateLoadTimeoutError") return true;
  if (e instanceof CdpEvaluateIdleTimeoutError || e?.name === "CdpEvaluateIdleTimeoutError") return true;
  const msg = String(e?.message ?? e);
  if (isCdpEvaluateTimeout(msg)) return true;
  if (/^cdp timeout: Runtime\.evaluate/i.test(msg)) return true;
  if (/Target closed|Session (?:closed|with given id not found)|WebSocket (?:closed|is not open)|Connection closed/i.test(msg)) return true;
  if (/probe evaluation timed out/i.test(msg)) return true;
  return false;
}

/**
 * Polls for the named app-ready signal before interaction.
 *
 * Throws an Error starting with `app never became ready` if the page does not
 * signal readiness within the timeout bound.
 */
export async function waitForAppReady(
  evaluate: (expression: string) => Promise<any>,
  options: AppReadinessOptions = {},
): Promise<AppReadinessResult> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const surface = options.surfaceName ? ` for ${options.surfaceName}` : "";
  const expr = options.predicateExpr ?? APP_READY_EXPRESSION;
  const timers = options.timers ?? REAL_READINESS_TIMERS;
  const deadline = timers.now() + timeoutMs;
  const start = timers.now();
  let lastProbe: any = null;
  let lastTimeoutError: Error | null = null;

  while (timers.now() < deadline) {
    const remainingMs = deadline - timers.now();
    if (remainingMs <= 0) break;
    const probeLimit = Math.min(remainingMs, options.probeTimeoutMs ?? 2000);

    let probeTimer: any;
    let localProbeTimeoutError: Error | null = null;
    try {
      const probe = await Promise.race([
        evaluate(expr),
        new Promise((_, reject) => {
          probeTimer = timers.setTimeout(() => {
            localProbeTimeoutError = new Error(`probe evaluation timed out after ${probeLimit}ms${surface}`);
            reject(localProbeTimeoutError);
          }, probeLimit);
        }),
      ]);
      timers.clearTimeout(probeTimer);
      lastProbe = probe;
      lastTimeoutError = null;
      if (timers.now() <= deadline && probe && typeof probe === "object" && probe.ready === true) {
        return {
          ready: true,
          signal: typeof probe.signal === "string" ? probe.signal : "custom-predicate",
          elapsedMs: timers.now() - start,
        };
      }
    } catch (e: any) {
      timers.clearTimeout(probeTimer);
      if (localProbeTimeoutError && e === localProbeTimeoutError) {
        lastTimeoutError = e;
        lastProbe = { error: String(e) };
      } else if (isTransportOrEvaluateTimeoutError(e)) {
        throw e;
      } else {
        lastTimeoutError = null;
        lastProbe = { error: String(e) };
      }
    }
    await new Promise((r) => timers.setTimeout(r, pollIntervalMs));
  }

  if (lastTimeoutError) {
    throw lastTimeoutError;
  }
  const detail = lastProbe ? ` (last probe: ${JSON.stringify(lastProbe)})` : "";
  throw new Error(`${APP_NEVER_BECAME_READY}${surface} within ${timeoutMs}ms${detail}`);
}

/**
 * Wraps an interaction to guarantee that the app is ready before the interaction executes.
 * If readiness times out, throws `app never became ready` and does NOT execute the action.
 */
export async function interactWhenReady<T>(
  evaluate: (expression: string) => Promise<any>,
  action: () => Promise<T>,
  options: AppReadinessOptions = {},
): Promise<T> {
  await waitForAppReady(evaluate, options);
  return action();
}

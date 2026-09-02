// ntp/ntp.js — the hub page wiring. The hub is a COMMAND CENTER:
//   header → composer (the hero) → Tasks (the distinct task threads) →
//   background agents (scheduled, toggle) → Site Agents (enrolled origins) →
//   recent artifacts. A task is a DISTINCT THREAD: starting one opens a
//   full-screen thread surface (the conversation + a composer to nudge/continue),
//   and the hub lists every prior thread (auto-named).

import { send } from "../lib/messages.js";
import { AGENT_TEMPLATES, STARTER_TEMPLATE_IDS, agentTemplateById, recipeAsTemplate, templatePrefill } from "../lib/agent-templates.js";
import { buildAgentSkillRows } from "../lib/agent-skill-rows.js";
import { projectUnifiedAgents } from "../lib/named-agents.js";
import { buildAgentMcpList, normalizeMcpServer } from "../lib/mcp-config.js";
import { buildMcpServerEditor, mcpServerRow } from "../lib/mcp-server-editor.js";
import { schedulePreviewText } from "../lib/schedule-preview.js";
import { parseEnglishSchedule } from "../shared/schedule-parser.js";
import { selectFailedRuns } from "../lib/run-retry.js";
import { runConversationTurn, subscribeProgress, subscribeRunRegistry, cancelDurableRun, resumePermissionPausedRun, loadDurableRunLogs, appendBubble, pairToolJournal, projectThreadMessages, renderRunTranscript, wireReplayApprovals, isProtocolTool } from "../shared/conversation.js";
import { createRunSurfaceOwner } from "../shared/run-surface-owner.js";
import { summarizeToolResult, toolResultTruncationNote } from "../lib/tool-summary.js";
import { cancelRunFromRenderedStop, projectConversationRunStatus } from "../shared/run-status.js";
import { safeJsonStringify } from "../shared/tool-tree.js";
import {
  renderHtmlFrame,
  isHtmlDocument,
  wireHtmlFrameContent,
  wireHtmlFramePreference,
  currentFramePreference,
  confirmActionDialog,
  escapeHtml,
} from "../shared/components.js";
import { sleep, timeAgo } from "../lib/pure.js";
import { canonicalRef, findAgentByRef } from "../shared/agent-registry.js";
import { agentScheduleMarker, backgroundAgentsForDisplay } from "../shared/agent-display.js";
import { buildTemplateSelect } from "../lib/agent-template-select.js";
import { handleScriptRunMessage } from "../lib/script-host.js";
import { initialAvatar } from "../lib/avatar.js";
import { renderDurabilityState } from "../lib/durability-ui.js";
import { createTaskSidebarLifecycle, loadThreadsWithOneRestartRetry } from "../lib/task-sidebar-lifecycle.js";
import { createTerminalThreadProjectionLifecycle } from "../lib/terminal-thread-projection-lifecycle.js";
import {
  clearAuthoritativeThreadProjection,
  recordAuthoritativeThreadProjection,
} from "../shared/thread-projection-authority.js";
import { createViewFocusController } from "../lib/view-focus.js";
import { loadFirstRunGuideState } from "../lib/first-run-onboarding.js";
import {
  createRouteUpdateRunner,
  focusExplicitRouteTarget,
  VIEW_ROUTE,
} from "./route-focus.js";
import { applySidebarNubPolicy, SIDEBAR_NARROW_QUERY, sidebarWidthPolicy } from "./view-policy.js";
import {
  ensureNtpHistoryRoot,
  navigateHome,
  navigateNtpRoute,
  parseNtpHash,
  resolveEntryMeta,
  shouldDispatchForNavigationType,
} from "../lib/navigation-controller.js";
import { actionableRunsForSurface, isSettledLiveRunRecord, latestRunForSurface, runsForSurface } from "../lib/run-scope.js";
import { buildTimeline } from "../lib/hub-timeline.js";
import {
  SITE_AGENT_COPY,
  enrollOutcomeState,
  formatWebmcpHubStatus,
  selectSiteOfferState,
  siteAgentSetupMessage,
} from "../shared/site-agent-copy.js";
// The visible find-tools action consumes the centralized authority at runtime
// (the ntp module runs at the end of the body — the element exists at eval, so
// no DOMContentLoaded dependency).
const discoverPage = document.getElementById("discover-page");
if (discoverPage) discoverPage.textContent = SITE_AGENT_COPY.findToolsAction;

import {
  installPageDiagnostics,
  startDiagnosticSubscription,
} from "../shared/diagnostics-client.js";
import { capLog } from "../lib/cap-log.js";
import { perfSpan } from "../lib/cap-perf.js";

const ntpLog = capLog("ntp");
ntpLog.info("new tab page evaluated");

const statusEl = document.getElementById("status");
const durableRunRegistry = document.getElementById("durable-run-registry");
const threadConversation = document.getElementById("thread-conversation");
// A reopened thread's grant cards (derived from persisted denials) grant
// through the same path the live card takes (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §2b).
wireReplayApprovals(threadConversation);
// The registry is a DEBUG overlay now (owner directive: the conversation is
// the status surface — no visible registry panel). The toggle appears (and
// hover-reveals the panel) only when the open surface has runs.
const runDebugToggle = document.getElementById("run-debug-toggle");
const runDebugPanel = document.getElementById("run-debug-panel");
let runDebugPinned = false;
let statusTimer;
let currentThreadId = null;
let currentAgentId = null;
let currentAgentKind = null;
let latestDurableRuns = [];
// Declared before subscribeRunRegistry(), which emits its current snapshot synchronously.
let liveClientRunId = null;

function setRunDebugOpen(open, { pin = false, focusToggle = false } = {}) {
  if (!runDebugPanel || !runDebugToggle) return;
  runDebugPinned = open ? (runDebugPinned || pin) : false;
  runDebugPanel.hidden = !open;
  runDebugToggle.setAttribute("aria-expanded", String(open));
  if (!open && focusToggle) runDebugToggle.focus();
}

function syncConversationRunControls() {
  if (!durableRunRegistry) return;
  // Run logs remain reachable after settlement; filtering to actionable phases
  // made the affordance disappear the moment a successful run completed.
  const runs = runsForSurface(latestDurableRuns, {
    threadId: currentThreadId,
    agentId: currentAgentId,
    agentKind: currentAgentKind,
  });
  durableRunRegistry.runs = runs;
  durableRunRegistry.hidden = runs.length === 0;
  if (runDebugToggle) {
    runDebugToggle.hidden = runs.length === 0;
    if (runs.length === 0) setRunDebugOpen(false);
  }
}

// The agent view's LIVE run transcript (CAP-FB-20260823-AGENT-RUN-VISIBILITY-01):
// The open surface's LIVE run transcript — agent surfaces AND task (thread)
// surfaces alike (CAP-FB-20260823-AGENT-RUN-VISIBILITY-01 introduced it for
// agents; CAP-FB-20260823-DURABLE-TASK-RESTORE-01 extends the SAME wiring to
// tasks, whose open path never attached it): subscribe to the current
// surface's most-recent run's progress so the view shows the tool
// calls/results/errors/status in near-real time, composing with the retained
// history (renderAgentHistory / renderThreadProjection) rather than
// duplicating it. The subscription is bound to the current surface
// (threadId when a task is open, else agent + kind) and is torn down when
// the surface changes or the run settles. Returns the resolved run (or null)
// so open paths can truthfully set the status banner.
let runTranscriptUnsub = null;
let runTranscriptExecutionId = null;

function stopRunTranscript() {
  if (runTranscriptUnsub) {
    try { runTranscriptUnsub(); } catch { /* unsubscribe must never throw */ }
    runTranscriptUnsub = null;
  }
  runTranscriptExecutionId = null;
}

function projectSurfaceRunTranscript() {
  const run = latestRunForSurface(latestDurableRuns, {
    threadId: currentAgentId === null ? currentThreadId : null,
    agentId: currentAgentId,
    agentKind: currentAgentKind,
  });
  const nextId = run?.executionId ?? null;
  if (nextId === runTranscriptExecutionId) return run; // already subscribed to THIS run
  stopRunTranscript(); // teardown FIRST — it nulls the guard; assign AFTER so the guard actually holds
  runTranscriptExecutionId = nextId;
  if (!nextId || !threadConversation) return run;
  runTranscriptUnsub = renderRunTranscript(threadConversation, nextId, {
    onStatus: (s) => renderRunStatus(s),
  });
  return run;
}

if (durableRunRegistry) {
  durableRunRegistry.hidden = true;
  subscribeRunRegistry(({ runs }) => {
    latestDurableRuns = Array.isArray(runs) ? runs : [];
    syncConversationRunControls();
    // A run that starts or settles while a run surface (agent OR task) is
    // open re-projects the transcript (guarded by the execution-id change, so
    // heartbeats don't churn the subscription).
    projectSurfaceRunTranscript();
    const surfaceRuns = actionableRunsForSurface(latestDurableRuns, {
      threadId: currentAgentId === null ? currentThreadId : null,
      agentId: currentAgentId,
      agentKind: currentAgentKind,
    });
    const boundRun = liveClientRunId
      ? surfaceRuns.find((run) => run?.clientCorrelationId === liveClientRunId)
      : surfaceRuns.find((run) => run?.executionId === runTranscriptExecutionId);
    threadConversation?.bindLiveStatusExecution?.(boundRun?.executionId ?? null);
    // Terminal reconciliation for the live status row: the registry is the
    // durable authority. When the open surface's latest run has SETTLED and
    // nothing actionable remains, resolve the row — the live terminal event
    // can be lost when the turn was fenced or queued behind other runs, and
    // the row would otherwise stick at "working" forever (found by
    // run-status-lifecycle under 20 concurrent queued runs, 2026-08-28).
    // Paused/permission-waiting runs are actionable here, so an approval-wait
    // row is never cleared by this path.
    const surface = { threadId: currentAgentId === null ? currentThreadId : null, agentId: currentAgentId, agentKind: currentAgentKind };
    const settled = latestRunForSurface(latestDurableRuns, surface);
    if (
      settled &&
      settled.executionId !== lastReconciledTerminalId &&
      // Reconcile ONLY from the settled record that IS the live run (review
      // P1-1): a fresh terminal record for the PREVIOUS run must never clear a
      // new live run's row — identity by the client's per-attempt run id, no
      // timestamp heuristic (a stale snapshot's record fails this check even
      // when its updatedAt lands inside any skew window).
      isSettledLiveRunRecord(settled, liveClientRunId) &&
      !actionableRunsForSurface(latestDurableRuns, surface).length
    ) {
      const phase = String(settled.phase ?? "");
      if (phase === "cancelled" || phase === "terminal") {
        lastReconciledTerminalId = settled.executionId;
        if (phase === "cancelled") renderRunStatus({ state: "cancelled" });
        else {
          const ok = settled.terminal?.ok !== false;
          renderRunStatus(ok
            ? { state: "completed" }
            : { state: "failed", message: settled.terminal?.summary ?? settled.terminal?.reason ?? "the run failed", errorCategory: settled.terminal?.errorCategory });
        }
      }
    }
  });
  durableRunRegistry.addEventListener("run-cancel", async (event) => {
    const result = await cancelDurableRun(event.detail.executionId).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    event.detail.complete(result);
    setStatus(result.ok ? "Run cancelled. Retained logs are still available." : `Cancel failed: ${result.error}`, result.ok === true);
  });
  durableRunRegistry.addEventListener("run-resume", async (event) => {
    const result = await resumePermissionPausedRun(event.detail.executionId, { ownerConfirmed: event.detail.ownerConfirmed }).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    event.detail.complete(result);
    setStatus(result.ok ? "Run resumed." : `Resume failed: ${result.error}`, result.ok === true);
  });
  durableRunRegistry.addEventListener("run-logs", async (event) => {
    const result = await loadDurableRunLogs(event.detail.executionId).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    event.detail.complete(result);
    setStatus(result.ok ? "Retained logs loaded." : `Log load failed: ${result.error}`, result.ok === true);
  });
}

// Debug overlay wiring: click pins it open (click again closes), hover reveals
// it unpinned (fine pointers only), Escape always closes + returns focus, and
// a click outside a pinned panel closes it.
if (runDebugToggle && runDebugPanel) {
  runDebugToggle.addEventListener("click", () => {
    if (!runDebugPanel.hidden && runDebugPinned) { setRunDebugOpen(false); return; }
    setRunDebugOpen(true, { pin: true });
  });
  if (globalThis.matchMedia?.("(pointer: fine)")?.matches) {
    // Hover reveal must be TRAVERSABLE: the panel hangs ~60px below the
    // toggle, so a synchronous pointerleave close destroys it before the
    // pointer can arrive. A short cancellable close delay bridges the gap —
    // re-entering either the toggle or the panel cancels the pending close.
    let hoverCloseTimer = 0;
    const cancelHoverClose = () => {
      if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = 0; }
    };
    const hoverIn = () => { cancelHoverClose(); setRunDebugOpen(true); };
    const hoverOut = () => {
      if (runDebugPinned) return;
      cancelHoverClose();
      hoverCloseTimer = setTimeout(() => { hoverCloseTimer = 0; setRunDebugOpen(false); }, 250);
    };
    runDebugToggle.addEventListener("pointerenter", hoverIn);
    runDebugPanel.addEventListener("pointerenter", hoverIn);
    runDebugToggle.addEventListener("pointerleave", hoverOut);
    runDebugPanel.addEventListener("pointerleave", hoverOut);
  }
  document.addEventListener?.("keydown", (event) => {
    if (event.key === "Escape" && !runDebugPanel.hidden) setRunDebugOpen(false, { focusToggle: true });
  });
  document.addEventListener?.("pointerdown", (event) => {
    if (runDebugPanel.hidden || !runDebugPinned) return;
    if (runDebugPanel.contains(event.target) || runDebugToggle.contains(event.target)) return;
    setRunDebugOpen(false);
  });
}

function setStatus(text, ready = true) {
  statusEl.innerHTML =
    `<span class="dot"></span>${escapeHtml(text || "ready")}`;
  statusEl.querySelector(".dot").style.background = ready
    ? "var(--accent2)"
    : "var(--danger)";
  document.querySelector(".composer")?.classList.toggle("glow", !ready);
  // The idle "ready" state is redundant with the clean header + the
  // diagnostics badges — hide it; show only transient states (running / error /
  // enabled), and auto-revert success feedback to the idle state.
  const idle = !text || text === "ready";
  statusEl.hidden = idle;
  clearTimeout(statusTimer);
  if (!idle && ready) {
    statusTimer = setTimeout(() => setStatus("ready"), 3000);
  }
}

function shortOrigin(o) {
  return String(o).replace(/^https?:\/\//, "").replace(/\/.*/, "");
}

// ── first-run path ────────────────────────────────────────────────────────
// The first-run BANNER (CAP-FB-20260827-HUB-FIRST-RUN-01) asks for ONE thing —
// a model — and only while no provider is connected and no artifact exists (or
// until the owner dismisses it). Browser control is asked for in context by the
// approval card at the moment a task needs it (conversation.js
// approvePermissionRequirement), never up front. The banner is never a
// permission authority: the grant happens on a native Settings click.
const firstRunGuide = document.getElementById("first-run-guide");
const exampleChips = document.getElementById("example-chips");
let returningFromFirstRunSettings = false;
const FIRST_RUN_DISMISSED_KEY = "cap:first-run-guide-dismissed";
const FIRST_RUN_BROWSER_CHOICE_KEY = "cap:first-run-browser-choice";

// ---- factory reset boot handler (CAP-FB-20260823-FACTORY-RESET-01) ----
// When arriving after a factory reset (#factory-reset), clear all page-local
// first-run preferences (localStorage/sessionStorage) and strip the hash so a
// pristine onboarding guide renders immediately.
function handleFactoryResetBoot() {
  if (typeof location !== "undefined" && (location.hash === "#factory-reset" || location.hash === "#reset")) {
    try {
      localStorage.removeItem(FIRST_RUN_DISMISSED_KEY);
      localStorage.removeItem(FIRST_RUN_BROWSER_CHOICE_KEY);
      sessionStorage.removeItem(FIRST_RUN_BROWSER_CHOICE_KEY);
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {}
  }
}
handleFactoryResetBoot();
ensureNtpHistoryRoot(window);

function firstRunDismissed() {
  try { return localStorage.getItem(FIRST_RUN_DISMISSED_KEY) === "1"; }
  catch { return false; }
}

function firstRunBrowserChoice() {
  try { return sessionStorage.getItem(FIRST_RUN_BROWSER_CHOICE_KEY) || localStorage.getItem(FIRST_RUN_BROWSER_CHOICE_KEY) || "unselected"; }
  catch { return "unselected"; }
}

async function renderFirstRunGuide() {
  if (!firstRunGuide) return;
  const state = await loadFirstRunGuideState({
    containsStorage: () => chrome.permissions?.contains?.({ permissions: ["storage"] }) ?? false,
    containsBrowserControl: () => chrome.permissions?.contains?.({ permissions: ["tabs"] }) ?? false,
    readProvider: async () => {
      const [summary, status] = await Promise.all([
        send("provider.summary"),
        send("provider.status"),
      ]);
      return {
        provider: summary?.provider,
        configured: summary?.configured === true && status?.ok === true,
      };
    },
    listArtifacts: async () => {
      const result = await send("asset.list", { origin: "master" });
      return Array.isArray(result?.assets) ? result.assets : [];
    },
    readBrowserChoice: () => firstRunBrowserChoice(),
    dismissed: firstRunDismissed(),
  });
  // With a provider connected there is nothing left to ask for.
  firstRunGuide.hidden = !state.show || state.providerReady;
  firstRunGuide.toggleAttribute("storage-ready", state.storageGranted);
  firstRunGuide.toggleAttribute("provider-ready", state.providerReady);
  firstRunGuide.toggleAttribute("browser-ready", state.browserControlGranted);
  firstRunGuide.setAttribute("browser-choice", state.browserControlChoice);
}

firstRunGuide?.addEventListener("open-settings", (event) => {
  returningFromFirstRunSettings = true;
  openView("options/options.html#providers", "Provider settings", event.detail?.sourceEvent?.currentTarget ?? firstRunGuide);
});
// Example chips (CAP-FB-20260827-HUB-FIRST-RUN-01): a chip puts its text in
// the composer and focuses it for review — it NEVER runs the task.
exampleChips?.addEventListener("pick", (event) => {
  const text = String(event.detail?.text ?? "");
  if (!text) return;
  composer.value = text;
  composer.focus();
});
firstRunGuide?.addEventListener("dismiss-guide", () => {
  try { localStorage.setItem(FIRST_RUN_DISMISSED_KEY, "1"); } catch { /* page-local preference unavailable */ }
  firstRunGuide.hidden = true;
  composer.focus();
});
// ── hub sections: no empty copy for a store that has never had data ───────
// A fresh profile renders the composer, the chips and the banner — nothing
// else. Each section appears once its store has EVER had data (remembered
// page-locally, cleared by a factory reset) and then keeps its honest empty
// copy when the data goes away again.
const HUB_SEEN_PREFIX = "cap:hub-seen:";
const hubFacets = new Map();
function noteHubData(section, facet, hasData) {
  let facets = hubFacets.get(section);
  if (!facets) hubFacets.set(section, (facets = new Map()));
  facets.set(facet, hasData === true);
  const any = [...facets.values()].some(Boolean);
  if (any) {
    try { localStorage.setItem(HUB_SEEN_PREFIX + section, "1"); } catch { /* page-local preference unavailable */ }
  }
  let seen = any;
  if (!seen) {
    try { seen = localStorage.getItem(HUB_SEEN_PREFIX + section) === "1"; } catch { seen = false; }
  }
  const el = document.getElementById(`${section}-section`);
  if (el) el.hidden = !seen;
}

const runRouteUpdate = createRouteUpdateRunner();

// ── Site Agents (enrolled origins + proactive discovery) ───────────────────
async function renderSiteAgents() {
  const el = document.getElementById("site-agents");
  if (!el) return;
  const res = await send("agent.directory").catch(() => ({ agents: [] }));
  // Item 44: a site with ZERO tools is not an agent (paul.kinlan.me with no
  // WebMCP/inferred tools must not appear as a Site Agent). Only origins that
  // actually expose tools are listed here.
  const agents = (Array.isArray(res.agents) ? res.agents : []).filter(
    (a) => (a.toolCount ?? a.tools?.length ?? 0) > 0,
  );
  el.replaceChildren();

  // Proactive discovery (CAP-FB-20260825-SITE-DISCOVERABILITY-01): check for
  // open browser tabs that can be enrolled with one click. Read through the
  // PERMISSION-FREE offers route (CAP-FB-20260825-SITE-AGENT-SHOWCASE-01):
  // `agent.discoverable-tabs` needs the optional `scripting` permission to
  // reattest tabs, so on a fresh profile it answered needScripting and this
  // banner — and with it the whole Agents section and its "Find site tools"
  // link — never appeared. The offers are the passive detector's reports
  // intersected with the open tabs; the click still walks the owner-gesture
  // enrollment that reattests the exact tab before acting on it.
  const enrolledOrigins = new Set((Array.isArray(res.agents) ? res.agents : []).map((a) => a.origin));
  const discoverable = await send("agent.tool-offers").catch(() => ({ ok: false }));
  const unenrolledTabs = (discoverable?.ok && Array.isArray(discoverable.offers))
    ? discoverable.offers.filter((t) => t.enrolled !== true && !enrolledOrigins.has(t.origin))
    : [];

  if (agents.length > 0) {
    for (const a of agents.slice(0, 6)) {
      const row = document.createElement("capability-row");
      row.setAttribute("name", `@${shortOrigin(a.origin)}`);
      row.setAttribute(
        "description",
        `${a.tools?.length ?? 0} tools` +
          (a.name ? ` · ${a.name}` : ""),
      );
      row.setAttribute("icon", "");
      row.setAttribute("action", "run");
      row.addEventListener("run", () => openView("directory/directory.html", "Directory", row));
      el.append(row);
    }
    if (agents.length > 6) {
      const more = document.createElement("div");
      more.className = "empty";
      more.textContent = `+ ${agents.length - 6} more in the directory`;
      el.append(more);
    }
  }

  // Surface discovered open pages so the user can add them as Site Agents with one click
  if (unenrolledTabs.length > 0) {
    const banner = document.createElement("div");
    banner.className = "proactive-discovery-banner";
    banner.style.margin = agents.length ? "10px 0 12px" : "0 0 12px";
    banner.style.padding = "10px 12px";
    banner.style.borderRadius = "8px";
    banner.style.background = "var(--bg-surface-secondary, rgba(0,0,0,0.03))";
    banner.style.border = "1px solid var(--border-subtle, rgba(0,0,0,0.08))";

    const bannerHead = document.createElement("div");
    bannerHead.className = "muted small";
    bannerHead.style.marginBottom = "6px";
    bannerHead.style.fontWeight = "600";
    bannerHead.textContent = "Discovered open pages — click to add as Site Agent:";
    banner.append(bannerHead);

    for (const t of unenrolledTabs.slice(0, 3)) {
      const row = document.createElement("capability-row");
      row.setAttribute("name", t.title || t.origin);
      row.setAttribute("description", `Open page · ${t.origin}`);
      row.setAttribute("icon", "");
      row.setAttribute("action", "run");
      row.setAttribute("action-label", "Add");
      row.addEventListener("run", () => discoverTab(t));
      banner.append(row);
    }
    el.append(banner);
  } else if (!agents.length) {
    el.innerHTML = `<div class="empty">No Site Agents yet. Find tools from an open tab to add one.</div>`;
  }
  noteHubData("agents", "site", agents.length > 0 || unenrolledTabs.length > 0);

  refreshAgentCount();
}

// ── WebMCP discovery hub status ──────────────────────────────────────────
// A structured, honest status CARD under the Site Agents section (never a
// run-on " · " string): the origin, the SW-attested script lifecycle state
// (refreshing is distinct from injected), and the page-reported tool counts
// with timestamps as <time> elements. PRESERVED on the current main (the
// copy-cleanup candidate removed it; the WebMCP semantics stay).
async function renderWebmcpHubStatus() {
  const el = document.getElementById("webmcp-hub-status");
  if (!el) return;
  const status = await send("webmcp.status").catch(() => null);
  const s = status?.status;
  el.replaceChildren();
  if (!s) {
    el.textContent = "Discovery has not run yet.";
    return;
  }
  const vm = formatWebmcpHubStatus(s);
  if (!vm) {
    el.textContent = "Discovery has not run yet.";
    return;
  }
  const addTime = (parent, at) => {
    if (at === null) return;
    const time = document.createElement("time");
    time.dateTime = new Date(at).toISOString();
    time.textContent = new Date(at).toLocaleTimeString();
    time.className = "webmcp-card-time muted";
    parent.append(" ", time);
  };
  // Title row: the origin + the lifecycle state badge.
  const title = document.createElement("div");
  title.className = "webmcp-card-title";
  const titleText = document.createElement("span");
  titleText.textContent = `WebMCP discovery: ${vm.origin}`;
  const badge = document.createElement("span");
  badge.className = `webmcp-card-badge webmcp-card-badge-${vm.state}`;
  badge.textContent = vm.stateLabel;
  title.append(titleText, " ", badge);
  el.append(title);
  const rows = document.createElement("dl");
  rows.className = "webmcp-card-rows";
  // Row 1: the SW-attested script lifecycle + when it last changed.
  const scriptRow = document.createElement("div");
  const scriptDt = document.createElement("dt");
  scriptDt.textContent = "Scripts";
  const scriptDd = document.createElement("dd");
  scriptDd.textContent = vm.stateLabel;
  addTime(scriptDd, vm.scriptAt);
  scriptRow.append(scriptDt, ": ", scriptDd);
  rows.append(scriptRow);
  // Row 2: the page-reported tool counts + when the report arrived. A report
  // that PREDATES the latest script event is marked stale — it never merges
  // with the refreshing/active badge above.
  if (vm.report) {
    const reportRow = document.createElement("div");
    const reportDt = document.createElement("dt");
    reportDt.textContent = "Page report";
    const reportDd = document.createElement("dd");
    reportDd.textContent =
      `${vm.report.toolCount} tools (${vm.report.declaredCount} declared / ${vm.report.inferredCount} inferred)`;
    addTime(reportDd, vm.report.at);
    if (vm.reportStale) {
      const stale = document.createElement("span");
      stale.className = "webmcp-card-badge webmcp-card-badge-stale";
      stale.textContent = "stale";
      reportDd.append(" ", stale);
    }
    reportRow.append(reportDt, ": ", reportDd);
    rows.append(reportRow);
  }
  el.append(rows);
}

// ── Find site tools (explicit tab picker) ────────────────────────────────
// Browsing a page must be discoverable without typing the origin into Settings
// (the dynamic-permission-on-need principle). The EXACT-TAB finding: the old
// flow resolved the ACTIVE tab — which is the hub's own NTP while the user is
// clicking here — so it enrolled the NTP instead of the page the user meant.
// Now the flow lists the open http(s) tabs in an explicit picker; the CHOSEN
// tab's id + origin are threaded through enrollment and the SW verifies the
// picked tab still shows that origin before acting on it.
async function discoverActivePage() {
  let listing = await send("agent.discoverable-tabs").catch(() => ({ ok: false }));
  if (listing?.needScripting) {
    // The discover click IS the trusted user gesture — request the optional
    // scripting permission JIT here. The SW needs it to reattest detected tabs
    // (exact tab+document binding) before the picker can list anything; asking
    // only after a row pick deadlocked fresh profiles behind a picker that
    // could never open. Denial surfaces honestly, never as an empty picker.
    let granted = false;
    try {
      granted = (await chrome.permissions.request({ permissions: ["scripting"] })) === true;
    } catch {
      granted = false;
    }
    if (!granted) {
      setStatus(siteAgentSetupMessage("scripting-denied"), false);
      return;
    }
    listing = await send("agent.discoverable-tabs").catch(() => ({ ok: false }));
    // A just-landed JIT grant re-arms the passive detectors in already-open
    // pages (their first arm predated the grant); give the first snapshots a
    // short bounded window before concluding there is nothing to find.
    if (listing?.ok && Array.isArray(listing.tabs) && listing.tabs.length === 0) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(500);
        listing = await send("agent.discoverable-tabs").catch(() => ({ ok: false }));
        if (!listing?.ok || !Array.isArray(listing.tabs) || listing.tabs.length > 0) break;
      }
    }
  }
  if (listing?.needTabs) {
    // `tabs` is NOT required for discovery (tab URLs/titles come from
    // install-granted `<all_urls>` host access) — a needTabs response is a
    // broken-install signal; verify + report honestly instead of running an
    // obsolete runtime request.
    const granted = await chrome.permissions
      .contains({ permissions: ["tabs"] })
      .catch(() => false);
    if (!granted) {
      setStatus(siteAgentSetupMessage("tabs-denied"), false);
      return;
    }
    listing = await send("agent.discoverable-tabs").catch(() => ({ ok: false }));
  }
  if (!listing?.ok) {
    setStatus(siteAgentSetupMessage("list-failed"), false);
    return;
  }
  const tabs = Array.isArray(listing.tabs) ? listing.tabs : [];
  if (tabs.length === 0) {
    setStatus(siteAgentSetupMessage("no-tabs"), false);
    return;
  }
  openDiscoverPicker(tabs);
}

function openDiscoverPicker(tabs) {
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", SITE_AGENT_COPY.pickerTitle);
  const list = document.createElement("div");
  const hint = document.createElement("div");
  hint.className = "empty";
  hint.textContent = SITE_AGENT_COPY.pickerHint;
  list.append(hint);
  for (const t of tabs) {
    const row = document.createElement("capability-row");
    row.setAttribute("name", t.title || t.origin);
    row.setAttribute("description", t.origin);
    row.setAttribute("icon", "");
    row.setAttribute("action", "run");
    row.setAttribute("action-label", "Choose");
    row.addEventListener("run", () => {
      dialog.close();
      discoverTab(t);
    });
    list.append(row);
  }
  dialog.append(list);
  document.body.append(dialog);
  dialog.show();
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
}

/** Enroll the EXACT picked tab from the owner's click. Returns true when the
 * site became a Site Agent (the chip flips to "Using …"), false otherwise. */
async function discoverTab(tab) {
  // OPTIONAL + JIT model: the discover click IS the user gesture — request
  // the scripting permission + the site's origin here (chrome.permissions
  // .request needs a gesture; the SW can never provide one).
  let granted = false;
  try {
    granted = (await chrome.permissions.request({
      permissions: ["scripting"],
      origins: [`${tab.origin}/*`],
    })) === true;
  } catch (e) {
    setStatus(siteAgentSetupMessage("permission-error", tab.origin), false);
    return false;
  }
  if (!granted) {
    setStatus(siteAgentSetupMessage("permission-denied", tab.origin), false);
    return false;
  }
  const res = await send("agent.enroll-origin", {
    origin: tab.origin,
    ownerGesture: true,
    tabId: tab.id,
  }).catch(() => ({ ok: false }));
  if (res?.ok) {
    // The SHARED error-first mapping (the same enrollOutcomeState as Settings),
    // with the selected-tab-specific recovery: the picker HAS a chosen tab, so
    // a partial injection keeps the exact-tab reload wording.
    const state = enrollOutcomeState(res, { selectedTab: true });
    setStatus(siteAgentSetupMessage(state, tab.origin), state !== "failed" && state !== "reload");
    // Re-poll the Site Agents + the directory so the newly-discovered tools
    // appear without a manual refresh. The discovery scripts re-poll
    // asynchronously (800ms/2s/4s) — refresh again after they report.
    const refresh = () => {
      renderSiteAgents();
      refreshAgentCount();
      renderWebmcpHubStatus();
    };
    refresh();
    for (const delay of [1200, 3200]) setTimeout(refresh, delay);
    return state !== "failed";
  }
  setStatus(siteAgentSetupMessage("failed", tab.origin), false);
  return false;
}

// ── The site-offer chip above the composer ───────────────────────────────────
// (CAP-FB-20260825-SITE-AGENT-SHOWCASE-01.) A page the owner has open reports
// tools through the passive detector; the SW's `agent.tool-offers` (no
// optional permission needed to READ it) intersects those reports with the
// open tabs, and the hub offers ONE unenrolled site as "<host> offers N tools
// — use them?". The click is the single grant: the chip's `select` carries the
// EXACT tab id, and discoverTab requests scripting + that origin on the
// gesture, then enrolls that tab — the same path the Find-site-tools picker
// uses. One honest wrinkle: ARMING a page's detector needs the optional
// `scripting` permission (armDetectionProbe), so on a profile that never
// granted it no page can report a count yet. The chip then reads "Check open
// pages for site tools" and that click grants exactly scripting (warningless,
// no prompt) — the SW's permissions.onAdded nudge re-arms the already-open
// pages and their counts arrive within a second, flipping the chip to the
// offer. Nothing here broadens access quietly: every permission is requested
// from a named click, and the SW still verifies the picked tab shows the
// origin before acting on it.
const siteOffer = document.getElementById("site-offer");
// The origin the owner just enrolled from the chip — kept as "Using <host>"
// until the hub is reloaded, so the grant's result stays visible.
let siteOfferUsing = null;
let siteOfferBusy = false;
function setSiteOfferVariant(variant) {
  for (const v of ["offer", "using", "check"]) {
    if (v === variant) siteOffer.setAttribute(v, "");
    else siteOffer.removeAttribute(v);
  }
}
async function renderSiteOffer() {
  if (!siteOffer || siteOfferBusy) return;
  const [offers, directory] = await Promise.all([
    send("agent.tool-offers").catch(() => ({ ok: false })),
    send("agent.directory").catch(() => ({ agents: [] })),
  ]);
  const rows = offers?.ok && Array.isArray(offers.offers) ? offers.offers : [];
  const enrolled = (Array.isArray(directory?.agents) ? directory.agents : []).map((a) => a.origin);
  if (siteOfferUsing) {
    // The site the owner just added: show "Using <host> · N tools" while its
    // tab is still open; drop the chip once that tab is gone.
    const stillOpen = rows.find((r) => r.origin === siteOfferUsing.origin);
    if (stillOpen) {
      setSiteOfferVariant("using");
      siteOffer.setAttribute("origin", siteOfferUsing.origin);
      siteOffer.setAttribute("tool-count", String(stillOpen.toolCount ?? siteOfferUsing.toolCount ?? 0));
      siteOffer.removeAttribute("tab-id");
      siteOffer.hidden = false;
      return;
    }
    siteOfferUsing = null;
  }
  const state = selectSiteOfferState(offers, enrolled);
  if (!state) {
    siteOffer.hidden = true;
    return;
  }
  if (state.kind === "check") {
    setSiteOfferVariant("check");
    siteOffer.removeAttribute("origin");
    siteOffer.removeAttribute("tool-count");
    siteOffer.removeAttribute("tab-id");
    siteOffer.hidden = false;
    return;
  }
  const offer = state.offer;
  setSiteOfferVariant("offer");
  siteOffer.setAttribute("origin", offer.origin);
  siteOffer.setAttribute("tool-count", String(offer.toolCount));
  siteOffer.setAttribute("tab-id", String(offer.id));
  siteOffer.hidden = false;
}
siteOffer?.addEventListener("select", async (e) => {
  if (siteOfferBusy) return;
  const card = siteOffer.shadowRoot?.querySelector(".card");
  if (e.detail?.check === true) {
    // The one-time scripting grant, from THIS click. Nothing else is
    // requested here — the page's origin is granted only from the offer click.
    siteOfferBusy = true;
    card?.setAttribute("aria-busy", "true");
    let granted = false;
    try {
      granted = (await chrome.permissions.request({ permissions: ["scripting"] })) === true;
    } catch {
      granted = false;
    } finally {
      siteOfferBusy = false;
      card?.removeAttribute("aria-busy");
    }
    if (!granted) {
      setStatus(siteAgentSetupMessage("scripting-denied"), false);
      return;
    }
    // The grant re-arms the already-open pages; their first counts land
    // within a second or two. Re-project a few times (the SW also pushes
    // site-tools-detected as each report arrives).
    renderSiteOffer();
    for (const delay of [600, 1500, 3000]) setTimeout(renderSiteOffer, delay);
    return;
  }
  const origin = e.detail?.origin;
  const tabId = e.detail?.tabId;
  if (!origin || !Number.isInteger(tabId)) return;
  siteOfferBusy = true;
  card?.setAttribute("aria-busy", "true");
  try {
    const toolCount = Number(siteOffer.getAttribute("tool-count")) || 0;
    const ok = await discoverTab({ id: tabId, origin, title: "" });
    if (ok) siteOfferUsing = { origin, toolCount };
  } finally {
    siteOfferBusy = false;
    card?.removeAttribute("aria-busy");
  }
  renderSiteOffer();
});

// ── named agents (the persistent named agents) ──────────────────────────────
async function renderNamedAgents() {
  const el = document.getElementById("named-agents");
  // Unified agents list (CAP-FB-20260826-BACKGROUND-AGENTS-UNIFY-01): the hub's
  // Agents box shows named AND background agents together — a background agent
  // is marked "Runs in the background" and keeps its Delete control.
  const [namedRes, bgRes] = await Promise.all([
    send("named-agent.list").catch(() => ({ agents: [] })),
    send("background-agent.list").catch(() => ({ agents: [] })),
  ]);
  const agents = Array.isArray(namedRes.agents) ? namedRes.agents : [];
  const background = backgroundAgentsForDisplay(bgRes.agents);
  // ONE projection for every agent surface (CAP-FB-20260830-FRESH-PROFILE-
  // TEMPLATE-AGENTS-01): created named agents plus ENABLED background agents.
  // A disabled recipe is a template, not an agent — it stays reachable through
  // the create dialog / Settings' "Configure" picker, never as an agent row.
  // The hub panel, the sidebar, the side panel and Settings all agree on it.
  const active = projectUnifiedAgents(
    agents,
    backgroundAgentsForDisplay(background, { activeOnly: true }),
  );
  noteHubData("agents", "named", active.length > 0);
  // Feed the timeline's agent-name map (keyed by the durable-run agentId) so a
  // run row reads "Reading digest", not "background:digest".
  for (const a of active) {
    if (!a?.id || !a?.name) continue;
    noteAgentName(a.kind === "named" ? `named:${a.id}` : `background:${a.id}`, a.name);
  }
  if (el) {
    el.replaceChildren();
    if (!active.length) {
      // First-run / empty state: templates are the first-class way to create
      // an agent (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01) — the button
      // opens the create flow on the Starter gallery; nothing is created until
      // the owner presses "Create agent" on ONE chosen template.
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No agents yet. Choose a template or start from scratch.";
      const starterBtn = document.createElement("button");
      starterBtn.id = "add-starter-agents";
      starterBtn.type = "button";
      starterBtn.textContent = "Browse starter templates";
      starterBtn.style.cssText = "margin-top:8px;padding:8px 14px;border-radius:8px;border:1px solid var(--border,#e3e0d9);background:var(--panel,#ffffff);color:var(--text,#1f1d1a);font:inherit;cursor:pointer;";
      starterBtn.addEventListener("click", () => addStarterAgents());
      empty.append(document.createElement("br"), starterBtn);
      el.append(empty);
    } else {
      for (const a of active) {
        const row = document.createElement("capability-row");
        row.setAttribute("name", a.name || a.id);
        row.setAttribute("description", a.role || a.description || "an agent");
        row.setAttribute(
          "icon",
          a.kind === "named"
            ? `<img src="${escapeHtml(a.avatar || initialAvatar(a.name || a.id))}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;display:block;" />`
            : "",
        );
        // Item 55: the WHOLE row opens the agent's view (history + run log) +
        // lets you talk to it — a chevron affordance, not a misleading "Run".
        // A recipe-store-only agent additionally carries its Delete (the
        // enable/disable toggle was the wrong primitive).
        row.setAttribute("action", a.kind === "named" ? "open" : "open-delete");
        // ONE agents list (owner directive): a scheduled agent carries a small
        // schedule chip — no other distinction from an on-demand agent.
        if (a.schedule?.periodInMinutes) {
          row.setAttribute("last-run", agentScheduleMarker(a));
        }
        row.addEventListener("open", () => {
          if (a.kind === "named") openAgentChat(a.id || a.name);
          else openBackgroundAgentChat(a.id, a.name);
        });
        if (a.kind !== "named") {
          row.addEventListener("delete", async () => {
          const name = a.name || a.id;
          const confirmed = await confirmActionDialog({
            title: `Delete “${name}”?`,
            body: `Are you sure you want to delete ${name}?\n\nThis will cancel its scheduled task and remove the recurring alarm.`,
            confirmLabel: "Delete agent",
            destructive: true,
          });
          if (!confirmed) return;
          // Background agents schedule deterministically as `recipe:<id>` — the
          // enabled state DERIVES from the scheduled-task store, so the cancel
          // name must be that scheduled name, not the raw recipe id. DELETION
          // goes through recipe.delete: it removes the custom agent record AND
          // tears the schedule down NON-BLOCKING (the instant-delete contract —
          // a RUNNING task's 5s termination dance must never block the UI;
          // reconciliation reaps the inert payload). A built-in copy has no
          // custom record — recipe.delete still cancels its schedule, which is
          // what the row's existence derives from.
          const rows = [...document.querySelectorAll("#named-agents capability-row")];
          const removedIdx = rows.indexOf(row);
          const r = await send("recipe.delete", { id: a.id })
            .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
          if (r?.ok === true) {
            setStatus(`Deleted ${name}.`, true);
          } else {
            setStatus(`Could not delete ${name}: ${r?.error ?? "failed"}.`, false);
          }
          await renderNamedAgents();
          // Focus successor (the re-render destroyed the focused Delete
          // button): the row that TOOK the deleted row's index — else the last
          // row — else the Agents container itself, so keyboard flow survives.
          const after = [...document.querySelectorAll("#named-agents capability-row")];
          const target = after[Math.min(removedIdx, after.length - 1)] ?? null;
          const focusEl = target?.shadowRoot?.querySelector("button") ?? el;
          if (focusEl === el && !el.hasAttribute("tabindex")) {
            el.setAttribute("tabindex", "-1");
          }
          focusEl?.focus?.({ preventScroll: true });
          });
        }
        el.append(row);
      }
    }
  }
  renderSidebarAgents(active);
  refreshAgentCount(active);
}

// ── the named agents in the SIDEBAR (a created agent must appear here, not
//    only in the main area) ───────────────────────────────────────────────
async function renderSidebarAgents(agents) {
  const list = document.getElementById("side-agents");
  if (!list) return;
  const rows = Array.isArray(agents) ? agents : [];
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "thread-empty";
    empty.textContent = "No agents yet";
    list.append(empty);
    return;
  }
  for (const a of rows) {
    const isBackground = a.kind === "background";
    const scheduleMarker = agentScheduleMarker(a);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-item";
    // ONE agent concept: no "background" label — the only distinction is the
    // small schedule marker; the tooltip carries the role/description.
    item.title = (a.name || a.id) + (a.role ? " — " + a.role : a.description ? " — " + a.description : "") + ` — ${scheduleMarker}`;
    const avatar = document.createElement("img");
    avatar.className = "a-avatar";
    avatar.alt = "";
    avatar.src = a.avatar || initialAvatar(a.name || a.id);
    avatar.addEventListener("error", () => { avatar.src = initialAvatar(a.name || a.id); });
    const label = document.createElement("span");
    label.className = "a-name";
    label.append(document.createTextNode(a.name || a.id));
    const snippet = a.role ?? a.description ?? "";
    if (snippet) {
      const role = document.createElement("span");
      role.className = "a-role";
      // The full role is stored intact (no limit) and shown on hover via
      // item.title; the visible list line stays short so the list is scannable
      // (mirrors the side panel's truncated role preview).
      const full = String(snippet);
      role.textContent = full.length > 88 ? full.slice(0, 88).trimEnd() + "…" : full;
      label.append(role);
    }
    const chip = document.createElement("span");
    chip.className = "a-role agent-schedule-marker";
    chip.textContent = scheduleMarker;
    label.append(chip);
    item.append(avatar, label);
    item.addEventListener("click", () => {
      if (isBackground) openBackgroundAgentChat(a.id, a.name);
      else openAgentChat(a.id || a.name);
    });
    list.append(item);
  }
}

// ── background agents (scheduled recipes, enabled/disabled) ──────────────
// Item 25: the hub shows only the ACTIVE (enabled) background agents — the
// full catalog (presets + disabled) lives in Settings behind the "Configure"
// link + the base-select picker.
async function renderBackgroundAgents() {
  // CAP-FB-20260826-BACKGROUND-AGENTS-UNIFY-01: background agents are now rendered
  // INSIDE the unified Agents list (renderNamedAgents). Kept as a no-op so the
  // existing refresh call sites (deletion, broadcasts) don't break; they now
  // trigger the unified render instead.
  await renderNamedAgents();
}

async function refreshAgentCount(unified = null) {
  const el = document.getElementById("agent-count");
  if (!el) return;
  // The unified projection (owner directive): one count, no named/background
  // split. The caller passes the projection it already built; a standalone
  // refresh re-derives it through the same helper.
  const dir = await send("agent.directory").catch(() => ({ agents: [] }));
  const siteN = Array.isArray(dir.agents) ? dir.agents.length : 0;
  let rows = unified;
  if (!rows) {
    const [bg, named] = await Promise.all([
      send("background-agent.list").catch(() => ({ agents: [] })),
      send("named-agent.list").catch(() => ({ agents: [] })),
    ]);
    rows = projectUnifiedAgents(
      Array.isArray(named.agents) ? named.agents : [],
      (Array.isArray(bg.agents) ? bg.agents : []).filter((a) => a.enabled),
    );
  }
  el.textContent = `${rows.length} agent${rows.length === 1 ? "" : "s"} · ${siteN} site`;
}

// ── the hub timeline (CAP-FB-20260828-HUB-AS-TIMELINE-01) ──────────────────
// The hub's spine: ONE reverse-chronological stream of what happened, built
// from the thread index joined with the durable-run registry (the same
// authorities the sidebar tasks and the run controls read). It replaces the
// three object catalogs (Agents / Recent artifacts / Recent activity) the
// review flagged: a returning owner sees what is in flight, what is waiting on
// them, and what came back while they were away as one thing. A `thread` row
// opens its conversation; a `run:` row opens its agent's surface.
let timelineEl = null;
// Human agent names by durable-run agentId (`named:<id>` / `background:<id>` /
// site origin), populated as a side effect of the agent renders that already
// fetch them — so the timeline attributes a run without a fetch of its own.
const agentNameById = new Map();
function noteAgentName(agentId, name) {
  if (typeof agentId === "string" && agentId && typeof name === "string" && name) {
    agentNameById.set(agentId, name);
  }
}
async function refreshTimeline() {
  if (!timelineEl) timelineEl = document.getElementById("hub-timeline");
  if (!timelineEl) return;
  const [threadsRes] = await Promise.all([
    send("thread.list").catch(() => ({ threads: [] })),
  ]);
  const threads = Array.isArray(threadsRes?.threads) ? threadsRes.threads : [];
  timelineEl.entries = buildTimeline(threads, latestDurableRuns, {
    agentNames: agentNameById,
    limit: 40,
  });
}
function renderTimeline() {
  timelineEl = document.getElementById("hub-timeline");
  if (!timelineEl) return;
  // Reveal/hide the section through the same seen-once machinery every hub
  // section uses (a fresh profile shows nothing here).
  timelineEl.addEventListener("entries-change", (ev) =>
    noteHubData("timeline", "runs", (ev.detail?.count ?? 0) > 0));
  timelineEl.addEventListener("open", (ev) => openTimelineEntry(ev.detail?.id));
  refreshTimeline();
}
// A timeline row's Open target: a task thread opens its conversation; a
// standalone agent/scheduled run opens that agent's surface.
function openTimelineEntry(id) {
  if (typeof id !== "string" || !id) return;
  if (!id.startsWith("run:")) { openThread(id); return; }
  const executionId = id.slice("run:".length);
  const run = latestDurableRuns.find((r) => r?.executionId === executionId) || null;
  const agentId = typeof run?.agentId === "string" ? run.agentId : "";
  if (agentId.startsWith("named:")) {
    openAgentChat(agentId.slice("named:".length));
  } else if (agentId.startsWith("background:")) {
    const bgId = agentId.slice("background:".length);
    openBackgroundAgentChat(bgId, agentNameById.get(agentId) || bgId);
  } else if (run?.threadId) {
    openThread(run.threadId);
  }
}

// ── the artifact expand dialog (item 53) ────────────────────────────────
// "View diff" from an edited artifact's thread card: the two version bodies
// from the versions store, rendered in the shared <artifact-diff> inside an
// <agent-dialog>. Reads from the store, never the tool-result text.
async function openArtifactDiffDialog(id, origin, name, fromVersion, toVersion) {
  const [before, after] = await Promise.all([
    send("asset.version-get", { origin: origin ?? "master", id, n: fromVersion }).catch(() => ({ ok: false })),
    send("asset.version-get", { origin: origin ?? "master", id, n: toVersion }).catch(() => ({ ok: false })),
  ]);
  if (!before?.ok || !after?.ok) { setStatus("Those versions are no longer available", false); return false; }
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", `Changes to ${name ?? "artifact"}`);
  const body = document.createElement("div");
  body.style.minWidth = "min(92vw, 980px)";
  body.style.width = "100%";
  const diff = document.createElement("artifact-diff");
  diff.setAttribute("mode", "unified");
  diff.setAttribute("before-label", `v${fromVersion}`);
  diff.setAttribute("after-label", `v${toVersion}`);
  // The language drives nothing but the label today; html is the common case.
  diff.language = "html";
  diff.before = String(before.content ?? "");
  diff.after = String(after.content ?? "");
  body.appendChild(diff);
  dialog.append(body);
  document.body.append(dialog);
  dialog.show();
  dialog.addEventListener("close", () => dialog.remove());
  return true;
}

// A screenshot from the generated-image strip: resolve it from the screenshots
// store and show it in an <agent-dialog> (screenshots have no viewer route).
async function openScreenshotDialog(id) {
  const res = await send("screenshots.get", { id }).catch(() => ({ ok: false }));
  const dataURL = res?.ok && typeof res.dataURL === "string" ? res.dataURL : "";
  if (!dataURL) { setStatus("Screenshot not found", false); return false; }
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", res.url ? `Screenshot — ${res.url}` : "Screenshot");
  const body = document.createElement("div");
  body.style.minWidth = "min(92vw, 900px)";
  const img = document.createElement("img");
  img.src = dataURL; // a data: URL, escaped by assignment (never innerHTML)
  img.alt = res.url ? `Screenshot of ${res.url}` : "Screenshot of the captured page";
  img.style.maxWidth = "100%";
  img.style.height = "auto";
  img.style.borderRadius = "10px";
  img.style.border = "1px solid var(--border)";
  body.append(img);
  dialog.append(body);
  document.body.append(dialog);
  dialog.show();
  dialog.addEventListener("close", () => dialog.remove());
  return true;
}

// Clicking a recent artifact opens it in an <agent-dialog> — the full live
// render (an html artifact in the sandboxed double-iframe, an image inline, or
// the text), without navigating away from the hub.
async function openArtifactDialog(id, origin, fallbackName) {
  const res = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
  const asset = res?.ok ? res.asset : null;
  if (!asset) { setStatus("Artifact not found", false); return false; }
  const frameCleanups = [];

  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", asset.name ?? fallbackName ?? "Artifact");
  const body = document.createElement("div");
  body.style.minWidth = "min(92vw, 1280px)";
  body.style.width = "100%";
  body.style.height = "80vh";
  body.style.minHeight = "min(80vh, 850px)";
  body.style.display = "flex";
  body.style.flexDirection = "column";

  const headActions = document.createElement("div");
  headActions.style.display = "flex";
  headActions.style.justifyContent = "space-between";
  headActions.style.alignItems = "center";
  headActions.style.marginBottom = "8px";
  headActions.style.flex = "0 0 auto";

  const metaSpan = document.createElement("span");
  metaSpan.style.fontSize = "12px";
  metaSpan.style.color = "var(--muted)";
  metaSpan.textContent = `${asset.type ?? "data"} · ${asset.size ?? 0} B · ${origin ?? "master"}`;

  const openTabBtn = document.createElement("button");
  openTabBtn.type = "button";
  openTabBtn.className = "btn";
  openTabBtn.style.padding = "4px 10px";
  openTabBtn.style.fontSize = "12px";
  openTabBtn.style.cursor = "pointer";
  openTabBtn.style.display = "inline-flex";
  openTabBtn.style.alignItems = "center";
  openTabBtn.style.gap = "4px";
  openTabBtn.style.border = "1px solid var(--border)";
  openTabBtn.style.borderRadius = "var(--radius-sm, 6px)";
  openTabBtn.style.background = "transparent";
  openTabBtn.style.color = "var(--text)";
  openTabBtn.innerHTML = `<span>Open in new tab</span> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
  openTabBtn.addEventListener("click", () => {
    const url = chrome.runtime.getURL(`artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`);
    if (typeof chrome !== "undefined" && chrome.tabs?.create) chrome.tabs.create({ url });
    else window.open(url, "_blank");
  });
  headActions.append(metaSpan, openTabBtn);
  body.append(headActions);

  const type = asset.type ?? "data";
  const content = asset.content ?? "";
  if (type === "html" || (type === "text" && isHtmlDocument(content))) {
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.style.border = "1px solid var(--border)";
    frame.style.borderRadius = "10px";
    frame.style.overflow = "hidden";
    frame.style.background = "var(--panel, #fff)";
    frame.style.flex = "1 1 auto";
    frame.style.display = "flex";
    frame.style.flexDirection = "column";
    frame.style.height = "100%";
    frame.style.minHeight = "min(72vh, 760px)";
    frame.innerHTML = renderHtmlFrame(content);
    const htmlFrameEl = frame.querySelector(".html-frame");
    if (htmlFrameEl) {
      htmlFrameEl.style.flex = "1";
      htmlFrameEl.style.display = "flex";
      htmlFrameEl.style.flexDirection = "column";
      htmlFrameEl.style.height = "100%";
      const iframe = htmlFrameEl.querySelector("iframe");
      if (iframe) {
        iframe.style.flex = "1";
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.minHeight = "min(72vh, 760px)";
        iframe.style.maxHeight = "none";
      }
    }
    frameCleanups.push(wireHtmlFrameContent(frame));
    const nonce = frame.querySelector(".html-frame")?.dataset?.frameNonce;
    if (nonce) frameCleanups.push(wireHtmlFramePreference(frame, { nonce, ...currentFramePreference() }));
    body.append(frame);
  } else if (type === "image") {
    const img = document.createElement("img");
    img.src = content;
    img.alt = asset.name ?? "artifact";
    img.style.maxWidth = "100%";
    img.style.maxHeight = "72vh";
    img.style.objectFit = "contain";
    img.style.display = "block";
    body.append(img);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content;
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "13px";
    pre.style.flex = "1 1 auto";
    pre.style.overflow = "auto";
    pre.style.maxHeight = "72vh";
    body.append(pre);
  }
  dialog.append(body);
  document.body.append(dialog);
  dialog.show();
  dialog.addEventListener("close", () => {
    for (const cleanup of frameCleanups.splice(0)) {
      try { cleanup(); } catch { /* best-effort teardown while the dialog closes */ }
    }
    dialog.remove();
  }, { once: true });

  return true;
}

// ── Recent activity (the agent run log — item 16) ────────────────────────
// ── The Activity ledger (CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01) ─────────────
// A distinct sidebar "Activity" section listing the mutating actions the agents
// took, each with Undo where the action is reversible. The section stays hidden
// until it has rows (a fresh profile shows the composer + agents only). An undo
// changed the browser, so it re-reads the other live surfaces too.
let actionLedgerEl = null;
function renderActionLedger() {
  actionLedgerEl = document.getElementById("side-action-ledger");
  const section = document.getElementById("activity-ledger-section");
  if (!actionLedgerEl || !section) return;
  actionLedgerEl.addEventListener("entries-change", (ev) => {
    section.hidden = (ev.detail?.count ?? 0) === 0;
  });
  // An undo mutates tabs/bookmarks — refresh the run log so both surfaces agree.
  actionLedgerEl.addEventListener("action-undo", () => scheduleRunLogRefresh());
  actionLedgerEl.refresh?.().catch(() => {});
}

// The Jobs panel (the shared agent-to-agent board): ONE <jobs-board> mounted
// in the host; refresh() re-queries and updates the head hint. Board progress
// events re-render it live (see subscribeProgress below).
let jobsBoardEl = null;
function renderJobsBoard() {
  const host = document.getElementById("jobs-board-host");
  if (!host) return;
  if (!jobsBoardEl) {
    jobsBoardEl = document.createElement("jobs-board");
    // The Jobs section is ALWAYS visible (CAP-FB-20260831-BOARD-VISIBILITY-01):
    // the owner can always see the shared work queue, empty state included, so
    // it is NOT gated behind noteHubData like Timeline/Agents. The board's own
    // honest empty state carries the "nothing yet" message.
    host.replaceChildren(jobsBoardEl);
  }
  jobsBoardEl?.refresh?.().then(() => {
    const hint = document.getElementById("jobs-count");
    if (hint && jobsBoardEl) hint.textContent = jobsBoardEl.summary;
  }).catch(() => {});
}

// LIVE timeline (CAP-FB-20260828-HUB-AS-TIMELINE-01, replacing the old Recent
// activity explorer): a run that starts, moves or settles while the NTP is open
// must land on the timeline without a reload. The durable-run registry and the
// thread index are the authorities; re-read them on run progress + registry
// changes, TRAILING-DEBOUNCED (one settle per burst, not one per tool call).
// Skipped while the hub is covered — but DEFERRED, never dropped: a covered
// burst marks the timeline dirty and the route return to HUB flushes exactly
// one refresh (runs that settled while Settings/Directory or a task thread was
// open must be there when the owner comes back).
let runLogRefreshTimer = 0;
let runLogDirty = false;
function runLogCovered() {
  const view = document.getElementById("view");
  if (view && view.hidden !== true) return true;
  return typeof threadView !== "undefined" && threadView && threadView.hidden !== true;
}
// ONE refresh helper for the whole Recent-activity surface: the explorer AND
// the runs-today header. Every path that recomputes one must recompute the
// other, or the header goes stale (CAP-FB-20260830-RECENT-ACTIVITY-USER-
// EVENTS-01 r2 B4 / r3 P1).
function refreshHubActivity() {
  refreshTimeline().catch(() => {});
  renderHubUsage().catch(() => {});
}
function scheduleRunLogRefresh() {
  if (!timelineEl) return;
  if (runLogCovered()) { runLogDirty = true; return; }
  clearTimeout(runLogRefreshTimer);
  runLogRefreshTimer = setTimeout(() => {
    refreshTimeline().catch(() => {});
    refreshHubActivity();
    actionLedgerEl?.refresh?.().catch(() => {});
  }, 1500);
}
function flushRunLogDirty() {
  if (!runLogDirty) return;
  runLogDirty = false;
  clearTimeout(runLogRefreshTimer);
  refreshTimeline().catch(() => {});
  refreshHubActivity();
  actionLedgerEl?.refresh?.().catch(() => {});
}
// The progress PORT dies with every MV3 service-worker restart and the shared
// dispatcher settles its listeners fail-closed (clears them) — an AMBIENT
// page-level subscription must re-subscribe itself, or every live hub surface
// (run log, board sidebar, Jobs panel) silently freezes until a reload.
const subscribeAmbientProgress = () => {
  subscribeProgress((ev) => {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "disconnect") {
      subscribeAmbientProgress();
      // Events during the disconnect window are lost — re-read the surfaces
      // once on reconnect so nothing settled while we were deaf stays stale.
      scheduleRunLogRefresh();
      refreshBoard();
      renderJobsBoard();
      return;
    }
    if (["tool-call", "tool-result", "done", "error", "text"].includes(ev.type)) scheduleRunLogRefresh();
    // Board changes re-render the sidebar section + the Jobs panel live
    // (post/claim/settle/message).
    if (typeof ev.type === "string" && ev.type.startsWith("board-")) { refreshBoard(); renderJobsBoard(); }
    // A settled job's result was delivered into its poster's thread — if that
    // thread is the one open right now, re-read it so the result bubble
    // appears without a reopen (the delivery is committed by the claimant's
    // run, not by any run this view is subscribed to).
    if ((ev.type === "board-job-completed" || ev.type === "board-job-failed") && typeof ev.posterThreadId === "string"
      && ev.posterThreadId && ev.posterThreadId === currentThreadId && currentAgentId === null && !threadView.hidden) {
      refreshOpenThreadFromStore(ev.posterThreadId);
    }
  });
};
subscribeAmbientProgress();
subscribeRunRegistry(() => scheduleRunLogRefresh(), { emitCurrent: false });

// A small usage summary on the hub (the recent calls/tokens/cost) — reads the
// SW's single-authority usage aggregate, so you see at a glance how much the
// agents have been doing + what it cost.
async function renderHubUsage() {
  const el = document.getElementById("hub-usage");
  if (!el) return;
  // "N runs today" from the run registry — the count of durable runs started
  // within TODAY'S LOCAL [00:00, next-00:00) WINDOW (upper bound included so
  // a run started at 23:59:59.999 still counts today and tomorrow's runs do
  // not leak in). Cost/token figures live in Settings → Usage; the hub header
  // says what happened, not what it cost (CAP-FB-20260830-RECENT-ACTIVITY-
  // USER-EVENTS-01 r2 B4).
  const res = await send("run.list").catch(() => null);
  const runs = Array.isArray(res?.runs) ? res.runs : [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const todayStart = startOfToday.getTime();
  const tomorrowStart = startOfTomorrow.getTime();
  const today = runs.filter((r) => {
    const at = r?.startedAt ?? 0;
    return at >= todayStart && at < tomorrowStart;
  }).length;
  el.textContent = `${today} run${today === 1 ? "" : "s"} today`;
}

// ── Tasks (the distinct task threads) ────────────────────────────────────
// timeAgo is imported from lib/pure.js (the same one the components use).

const taskSidebarLifecycle = createTaskSidebarLifecycle({
  // A list message can wake a restarting MV3 worker before its routes are
  // ready. Retry that failed authoritative read once, using the existing 400ms
  // boot grace period; every render remains event/navigation-driven.
  loadThreads: () => loadThreadsWithOneRestartRetry(
    () => send("thread.list"),
    () => sleep(400),
  ),
  commitThreads: renderTaskRows,
});

function renderTasks(activeId = currentThreadId) {
  return taskSidebarLifecycle.render(activeId);
}

// UX-008 (CAP-FB-20260828-SILENT-DISPATCH-LOSS-01): the failed-runs section.
// A run that fails before producing anything must stay VISIBLE and RETRYABLE —
// the sidebar renders terminal failures that kept their stored prompt, and the
// Retry action re-dispatches the ORIGINAL prompt through the SW's run.retry
// route (a NEW execution; the failed record remains as history).
// UX (per-agent alarm visibility): the SCHEDULES section in an agent's
// conversation — ONLY this agent's scheduled tasks (matched by the persisted
// owner attribution: named → `named:<id>`, background → `background:<id>`),
// each with Pause/Resume/Update/Delete. The hub has no schedules section.
let agentSchedulesOwner = 0;
let agentSchedulesRef = null;
function hideAgentSchedules() {
  agentSchedulesOwner += 1;
  agentSchedulesRef = null;
  const section = document.getElementById("agent-schedules");
  if (section) {
    section.replaceChildren();
    section.hidden = true;
  }
}
async function refreshAgentSchedules(kind, id) {
  const owner = ++agentSchedulesOwner;
  const surfaceRef = kind === "named" ? `named:${id}` : kind === "background" ? `background:${id}` : null;
  agentSchedulesRef = surfaceRef;
  const section = document.getElementById("agent-schedules");
  if (!section || !surfaceRef) { hideAgentSchedules(); return; }
  let tasks = null;
  try {
    const res = await send("task.list");
    if (res?.ok !== false && Array.isArray(res?.tasks)) tasks = res.tasks;
  } catch {
    tasks = null; // worker restarting — the next authoritative render re-fetches
  }
  if (owner !== agentSchedulesOwner || agentSchedulesRef !== surfaceRef) return;
  const mine = (tasks ?? []).filter((t) => t.owner?.agentSurfaceRef === surfaceRef);
  section.replaceChildren();
  section.hidden = mine.length === 0;
  if (!mine.length) return;
  const label = document.createElement("div");
  label.className = "fr-label";
  // "Routines" — the vocabulary for an agent's scheduled/recurring tasks
  // (CAP-FB-20260831): discoverable with their schedule, never "background
  // agents".
  label.textContent = "Routines";
  section.append(label);
  for (const t of mine) section.append(agentScheduleRow(t));
}
function agentScheduleRow(t) {
  const row = document.createElement("div");
  row.className = "fr-row";
  const text = document.createElement("span");
  text.className = "fr-text";
  // Credential-shaped content is redacted BEFORE the bounded preview — the
  // ONE projector (P1-4/P2-B): the row renders through schedulePreviewText and
  // the test pins that function's output, never a re-implementation.
  const preview = schedulePreviewText(t.task);
  text.textContent = preview;
  text.title = preview;
  row.append(text);
  // The forward-looking "Next run" widget, computed from the routine's REAL
  // alarm (t.nextFireAt is the alarm's scheduledTime from lib/scheduler.js). A
  // paused/quarantined routine has no armed fire, so the widget shows that
  // state as its fallback rather than an invented time; a live routine shows
  // the relative + absolute next fire, its repeat cadence, and its last run.
  const whenEl = document.createElement("next-run");
  whenEl.className = "fr-status";
  if (typeof t.nextFireAt === "number") whenEl.setAttribute("at", String(t.nextFireAt));
  if (t.periodInMinutes) whenEl.setAttribute("period", String(t.periodInMinutes));
  if (typeof t.lastFiredAt === "number") whenEl.setAttribute("last", String(t.lastFiredAt));
  const fallback = t.paused
    ? "Paused"
    : t.quarantined
    ? "Needs attention"
    : t.storageBlocked
    ? "Storage full — retry or cancel"
    : (t.periodInMinutes ? `Repeats every ${t.periodInMinutes} min` : "Not scheduled");
  whenEl.setAttribute("label", fallback);
  row.append(whenEl);
  // Pause/Resume (an owner-approved mutation route — the owner's own click IS
  // the approval for owner-direct actions).
  if (!t.quarantined && !t.storageBlocked) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "fr-retry";
    toggle.textContent = t.paused ? "Resume" : "Pause";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      const r = await send(t.paused ? "task.resume" : "task.pause", { name: t.name }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (!r?.ok) {
        toggle.disabled = false;
        toggle.title = r?.error || "failed";
        return;
      }
      refreshAgentSchedules(currentAgentKind, currentAgentId);
    });
    row.append(toggle);
  }
  // Update: an inline editor (prompt + timing) → task.update.
  const upd = document.createElement("button");
  upd.type = "button";
  upd.className = "fr-retry";
  upd.textContent = "Update";
  upd.addEventListener("click", () => {
    row.replaceChildren(...agentScheduleEditor(t, () => refreshAgentSchedules(currentAgentKind, currentAgentId)));
  });
  row.append(upd);
  // Delete: the authoritative (non-blocking) cancel path.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "fr-retry";
  del.setAttribute("aria-label", `Delete ${t.name}`);
  del.textContent = "×";
  del.addEventListener("click", async () => {
    del.disabled = true;
    await send("task.cancel", { name: t.name }).catch(() => null);
    refreshAgentSchedules(currentAgentKind, currentAgentId);
  });
  row.append(del);
  return row;
}
function agentScheduleEditor(t, done) {
  const text = document.createElement("input");
  text.type = "text";
  text.value = String(t.task || "");
  text.maxLength = 4000;
  text.setAttribute("aria-label", "Scheduled prompt");
  text.className = "fr-text";
  text.style.flex = "1";
  const timing = document.createElement("input");
  timing.type = "text";
  timing.placeholder = t.periodInMinutes ? "period in minutes" : "delay in minutes";
  timing.setAttribute("aria-label", "New timing in minutes (blank = keep)");
  timing.className = "fr-status";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "fr-retry";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "fr-retry";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", done);
  save.addEventListener("click", async () => {
    const body = { name: t.name };
    const nt = text.value.trim();
    if (nt && nt !== t.task) body.task = nt;
    const mins = Number(timing.value.trim());
    if (timing.value.trim() && Number.isFinite(mins) && mins > 0) {
      if (t.periodInMinutes) body.periodInMinutes = mins;
      else body.delayMs = mins * 60 * 1000;
    }
    save.disabled = true;
    const r = await send("task.update", body).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (!r?.ok) {
      save.disabled = false;
      save.title = r?.error || "update failed";
      return;
    }
    done();
  });
  return [text, timing, save, cancel];
}

let failedRunsOwner = 0;
// The shared jobs board grouping (owner green-lit 2026-08-29): open jobs
// (poster, claimant, status) + the three most recent board messages, rendered
// ABOVE the thread rows. Read-only owner surface — all agent-authored content
// renders via textContent only. Bounded: 8 jobs + 3 messages.
let boardOwner = 0;
async function refreshBoard() {
  const owner = ++boardOwner;
  const section = document.getElementById("board-section");
  if (!section) return;
  let jobs = null;
  let messages = null;
  try {
    const [jobsRes, msgsRes] = await Promise.all([
      send("board.list"),
      send("board.messages", { limit: 3 }).catch(() => null),
    ]);
    if (jobsRes?.ok !== false && Array.isArray(jobsRes?.jobs)) jobs = jobsRes.jobs;
    if (msgsRes?.ok && Array.isArray(msgsRes?.messages)) messages = msgsRes.messages;
  } catch {
    jobs = null; // worker restarting — the next authoritative render re-fetches
  }
  if (owner !== boardOwner) return; // a newer render superseded this one
  section.replaceChildren();
  const open = (jobs ?? []).filter((j) => j && (j.status === "pending" || j.status === "claimed"));
  // Settled results stay VISIBLE for a bounded window (CAP-FB-20260830-AGENT-
  // BOARD-WORKING-01 step 6): the owner sees "Research finished: …" here
  // instead of the job vanishing from every surface the moment it settles.
  const settled = (jobs ?? [])
    .filter((j) => j && (j.status === "completed" || j.status === "failed"))
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
    .slice(0, 3);
  const recent = (messages ?? []).slice(0, 3);
  if (!open.length && !recent.length && !settled.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const label = document.createElement("div");
  label.className = "fr-label";
  label.textContent = `Board (${open.length} open)`;
  section.append(label);
  for (const job of open.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "fr-row";
    const dot = document.createElement("span");
    dot.className = "t-dot" + (job.status === "claimed" ? " running" : "");
    const text = document.createElement("span");
    text.className = "fr-text";
    // A blocked job reads as blocked (step 7), never as an open job.
    const state = job.blocked
      ? `blocked by ${job.blockedByOpen ?? job.blockedBy?.length ?? 1}`
      : job.status === "claimed"
      ? `${job.claimantName ?? job.claimantId} is on it`
      : `posted by ${job.posterName ?? job.posterId}${job.targetName ? ` for ${job.targetName}` : ""}`;
    text.textContent = job.description;
    text.title = `${job.description} — ${state}`;
    // Poster/claimant/status are VISIBLE (never title-only — review P2-1).
    const meta = document.createElement("span");
    meta.className = "fr-meta";
    meta.textContent = state;
    row.append(dot, text, meta);
    section.append(row);
  }
  for (const job of settled) {
    // A settled row is a real <button>: it opens the poster's thread (where
    // the result was delivered) or, for a threadless page/UI post, the
    // read-only board view of the job.
    const row = document.createElement("button");
    row.type = "button";
    row.className = "fr-row board-settled";
    const who = job.claimantName ?? job.claimantId ?? "an agent";
    const verb = job.status === "failed" ? "failed" : "finished";
    const text = document.createElement("span");
    text.className = "fr-text";
    const result = String(job.result ?? "").replace(/\s+/g, " ").trim();
    text.textContent = `${who} ${verb}: ${result.slice(0, 80)}${result.length > 80 ? "…" : ""}`;
    text.title = `${job.description} — ${who} ${verb}: ${result.slice(0, 400)}`;
    const meta = document.createElement("span");
    meta.className = "fr-meta";
    meta.textContent = job.posterThreadId ? "open thread" : "view result";
    row.setAttribute("aria-label", `${job.description}: ${who} ${verb}. ${job.posterThreadId ? "Open the thread that asked" : "View the result"}`);
    row.addEventListener("click", () => {
      if (job.posterThreadId) openThread(job.posterThreadId);
      else showBoardResult(job);
    });
    row.append(text, meta);
    section.append(row);
  }
  for (const m of recent) {
    const row = document.createElement("div");
    row.className = "fr-row";
    const text = document.createElement("span");
    text.className = "fr-text";
    text.textContent = `${m.fromName} → ${m.toName}: ${m.body}`;
    text.title = text.textContent;
    row.append(text);
    section.append(row);
  }
}

// Read-only result view for a THREADLESS settled job (posted from a page or
// the Settings UI, so there is no thread to open). Agent-authored text is
// rendered with textContent only. Uses the shared <agent-dialog> primitive.
function showBoardResult(job) {
  const existing = document.getElementById("board-result-dialog");
  if (existing) existing.remove();
  const dialog = document.createElement("agent-dialog");
  dialog.id = "board-result-dialog";
  dialog.setAttribute("title", `Board job ${job.status === "failed" ? "failed" : "completed"}`);
  const body = document.createElement("div");
  body.className = "board-result-body";
  const desc = document.createElement("p");
  desc.className = "muted";
  desc.textContent = job.description ?? "";
  const who = document.createElement("p");
  who.className = "muted";
  who.textContent = `${job.claimantName ?? job.claimantId ?? "an agent"} · ${job.settledAt ? new Date(job.settledAt).toLocaleString() : ""}`;
  const result = document.createElement("pre");
  result.className = "board-result-text";
  result.textContent = String(job.result ?? "");
  body.append(desc, who, result);
  dialog.append(body);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.show();
}

async function refreshFailedRuns() {
  const owner = ++failedRunsOwner;
  const section = document.getElementById("failed-runs");
  if (!section) return;
  let runs = null;
  let dismissedIds = [];
  let agentRefs = null; // null = could not know → the projection does not cascade-filter
  try {
    const [runsRes, dismissedRes, agentsRes] = await Promise.all([
      send("run.list"),
      send("run.dismissedFailed").catch(() => null),
      send("named-agent.list").catch(() => null),
    ]);
    if (runsRes?.ok !== false && Array.isArray(runsRes?.runs)) runs = runsRes.runs;
    if (dismissedRes?.ok && Array.isArray(dismissedRes?.ids)) dismissedIds = dismissedRes.ids;
    // The agent cascade needs the surviving agents' surface refs. A failed
    // fetch stays null — the projection only filters on known agents when the
    // list actually resolved, so a transient failure can never mass-hide
    // failures. Zero agents IS known (an explicit empty list).
    if (agentsRes && Array.isArray(agentsRes.agents)) {
      agentRefs = [];
      for (const a of agentsRes.agents) {
        if (typeof a?.id === "string" && a.id) agentRefs.push(`named:${a.id}`, `background:${a.id}`);
      }
    }
  } catch {
    runs = null; // worker restarting — the next authoritative render re-fetches
  }
  if (owner !== failedRunsOwner) return; // a newer render superseded this one
  const failed = selectFailedRuns(runs ?? [], {
    dismissedIds: new Set(dismissedIds),
    knownAgentIds: agentRefs === null ? undefined : new Set(agentRefs),
  });
  section.replaceChildren();
  section.hidden = failed.length === 0;
  if (!failed.length) return;
  const label = document.createElement("div");
  label.className = "fr-label";
  label.textContent = `Failed runs (${failed.length})`;
  // Clear-all (owner: "sometimes I just don't want to see them"): one click,
  // no confirm — dismissing is durable but carries no data loss beyond the
  // retry affordance, and the rows carry only previews already shown.
  const clearAll = document.createElement("button");
  clearAll.type = "button";
  clearAll.className = "fr-clear";
  clearAll.textContent = "Clear all";
  clearAll.setAttribute("aria-label", `Dismiss all ${failed.length} failed runs`);
  clearAll.addEventListener("click", async () => {
    clearAll.disabled = true;
    await send("run.dismissFailed", { executionIds: failed.map((f) => f.executionId) }).catch(() => null);
    if (owner === failedRunsOwner) await refreshFailedRuns();
  });
  label.append(clearAll);
  section.append(label);
  // ORPHANED-ALARM CLEANUP (owner P0): failed records whose agent is an
  // agent-ref (background:/agent:) may be orphaned — the agent was deleted but
  // its alarm survived. Offer one honest cleanup action that cancels every
  // schedule whose agent no longer exists (the SW verifies against the live
  // registry; it never cancels a live agent's schedule).
  const hasAgentRefFailures = failed.some((fr) => typeof fr.agentId === "string" && /^(background:|agent:)/.test(fr.agentId));
  if (hasAgentRefFailures) {
    const orphanBtn = document.createElement("button");
    orphanBtn.type = "button";
    orphanBtn.className = "fr-retry fr-orphan-cleanup";
    orphanBtn.textContent = "Cancel orphaned alarms";
    orphanBtn.setAttribute("aria-label", "Cancel alarms whose agent was deleted");
    orphanBtn.addEventListener("click", async () => {
      orphanBtn.disabled = true;
      orphanBtn.textContent = "…";
      const r = await send("schedule.cancelOrphans").catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (r?.ok) {
        orphanBtn.textContent = r.count > 0 ? `Cancelled ${r.count} orphaned alarm${r.count === 1 ? "" : "s"}.` : "No orphaned alarms found.";
        await refreshFailedRuns();
      } else {
        orphanBtn.textContent = "Cancel failed";
        orphanBtn.disabled = false;
      }
    });
    section.append(orphanBtn);
  }
  for (const fr of failed) {
    const row = document.createElement("div");
    row.className = "fr-row";
    const text = document.createElement("span");
    text.className = "fr-text";
    const preview = (fr.taskPreview || fr.summary || "(no prompt text)").trim();
    text.textContent = preview;
    text.title = `${preview}${fr.summary ? ` — ${fr.summary}` : ""} · ${timeAgo(fr.at)}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "fr-retry";
    retry.textContent = "Retry";
    retry.setAttribute("aria-label", `Retry failed run: ${preview}`);
    // Dismiss (owner: an X beside Retry — the failure stops being shown even
    // after restarts). Durable id-only tombstone via run.dismissFailed.
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "fr-dismiss";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", `Dismiss failed run: ${preview}`);
    dismiss.addEventListener("click", async () => {
      dismiss.disabled = true;
      await send("run.dismissFailed", { executionIds: [fr.executionId] }).catch(() => null);
      if (owner === failedRunsOwner) await refreshFailedRuns();
    });
    const statusLine = document.createElement("div");
    statusLine.className = "fr-status";
    statusLine.setAttribute("role", "status");
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.textContent = "…";
      statusLine.textContent = "Retrying…";
      const r = await send("run.retry", { executionId: fr.executionId }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (r?.ok) {
        statusLine.textContent = "Run restarted.";
        retry.remove();
        // A retried failure leaves the panel: the owner acted on it. The same
        // durable tombstone as the × button — it never re-appears.
        await send("run.dismissFailed", { executionIds: [fr.executionId] }).catch(() => null);
        await renderTasks(); // the new run may create/update threads
      } else {
        statusLine.textContent = `Retry failed: ${r?.error ?? "unknown error"}`;
        retry.disabled = false;
        retry.textContent = "Retry";
      }
    });
    row.append(text, retry, dismiss);
    section.append(row, statusLine);
  }
}

function renderTaskRows(threads, activeId = null) {
  const el = document.getElementById("thread-sidebar");
  if (!el) return;
  el.replaceChildren();
  // UX-008: failed dispatches render as a bounded, retryable section ABOVE the
  // thread rows — a submitted prompt must never vanish into a silent failure.
  // Fire-and-forget: the section refreshes itself; the thread render stays sync.
  refreshFailedRuns();
  // The shared jobs board (async agent→agent work): open jobs + the latest
  // messages render as a bounded section; fire-and-forget like failed runs.
  refreshBoard();
  if (!threads.length) {
    const empty = document.createElement("div");
    empty.className = "thread-empty";
    empty.textContent = "No tasks yet — start one above.";
    el.append(empty);
    return;
  }
  for (const t of threads.slice(0, 40)) {
    // The row is a NON-interactive wrapper (nested-interactive): a focusable
    // role=button row containing real buttons made child activation ambiguous
    // under the keyboard (Enter on Delete also opened the row). The explicit
    // Open button below is the only open affordance and a sibling of Delete.
    const item = document.createElement("div");
    item.className = "thread-item";
    // A hover tooltip for the collapsed icon-rail (and the full name on hover).
    item.title = (t.name || "Task") + (t.preview ? " — " + t.preview : "");
    if (activeId && t.id === activeId) item.setAttribute("aria-current", "true");
    const dotState =
      t.status === "running" ? "running" : t.status === "error" ? "error" : "";
    // A standalone status dot that stays visible when the sidebar collapses
    // (the .t-name dot is hidden with the label).
    const railDot = document.createElement("span");
    railDot.className = "t-dot" + (dotState ? " " + dotState : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "t-open";
    open.setAttribute("aria-label", `Open task ${t.name || "Task"}`);
    const name = document.createElement("span");
    name.className = "t-name";
    const dot = document.createElement("span");
    dot.className = "dot" + (dotState ? " " + dotState : "");
    const title = document.createElement("span");
    title.className = "t-title";
    title.textContent = t.name || "Task";
    name.append(dot, title);
    const preview = document.createElement("span");
    preview.className = "t-preview";
    preview.textContent = t.preview || "";
    // The railDot lives inside the open button so the collapsed icon-rail
    // keeps a real click target (the dot is its visible content there).
    open.append(railDot, name, preview);
    const meta = document.createElement("span");
    meta.className = "t-meta";
    meta.textContent = timeAgo(t.updatedAt);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "t-delete";
    del.setAttribute("aria-label", `Delete task ${t.name || "Task"}`);
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    item.append(open, meta, del);
    open.addEventListener("click", () => openThread(t.id));
    del.addEventListener("click", async () => {
      const r = await send("thread.delete", { id: t.id })
        .catch(() => ({ ok: false }));
      if (!r?.ok) {
        setStatus(`couldn't delete ${t.name || "task"}`, false);
        return;
      }
      if (currentThreadId === t.id) goHome({ focusAfter: composer });
      await renderTasks();
    });
    el.append(item);
  }
}

// ── the full-screen thread surface ────────────────────────────────────────
const threadView = document.getElementById("thread-view");
const threadTitle = document.getElementById("thread-title");
// The docked composer's height feeds the conversation's sticky live-status
// row (`--conversation-dock`) so the "Working — …" banner pins just above the
// composer rather than under it (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01).
{
  const dockHost = document.getElementById("thread-view");
  const dock = document.getElementById("thread-composer");
  if (dockHost && dock && typeof ResizeObserver !== "undefined") {
    const apply = () => dockHost.style.setProperty("--conversation-dock", `${Math.round(dock.getBoundingClientRect().height)}px`);
    new ResizeObserver(apply).observe(dock);
    apply();
  }
}
// Programmatic focus on the thread title (the view just opened) paints no
// focus ring; the first keydown restores the ring for keyboard users.
if (threadTitle) {
  threadTitle?.addEventListener("focus", () => {
    if (threadTitle.dataset.pointerFocus === "1") return;
    threadTitle.classList.add("focus-quiet");
    const clear = () => { threadTitle.classList.remove("focus-quiet"); document.removeEventListener("keydown", clear, true); };
    document.addEventListener("keydown", clear, true);
    threadTitle?.addEventListener("blur", clear, { once: true });
  });
}
const threadComposer = document.getElementById("thread-composer");

// Artifacts rendered INSIDE a thread (CAP-FB-20260828-ARTIFACTS-IN-THREAD-01).
// artifact-card events bubble, so one delegated listener serves every card the
// conversation ever appends — live or replayed — instead of wiring each card as
// it arrives. Same handlers the hub's Recent artifacts rows already use, so an
// artifact behaves identically wherever the owner meets it.
if (threadConversation) {
  threadConversation.addEventListener("open", (e) => {
    const { id, origin, name } = e.detail ?? {};
    if (!id || !e.target?.matches?.("artifact-card")) return;
    openArtifactDialog(id, origin ?? "master", name);
  });
  threadConversation.addEventListener("open-tab", (e) => {
    const { id, origin } = e.detail ?? {};
    if (!id) return;
    const url = chrome.runtime.getURL(
      `artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`,
    );
    if (chrome.tabs?.create) chrome.tabs.create({ url });
    else window.open(url, "_blank", "noopener");
  });
  // "View diff" under an edited artifact opens the version-to-version change in
  // an <agent-dialog> with the shared <artifact-diff> component — the bodies
  // come from the versions store (never the tool text).
  threadConversation.addEventListener("view-diff", (e) => {
    const { id, origin, name, fromVersion, toVersion } = e.detail ?? {};
    if (!id || !Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(toVersion)) return;
    openArtifactDiffDialog(id, origin ?? "master", name, fromVersion, toVersion);
  });
  // A thumbnail in the generated-image strip: an image asset opens in the
  // artifact viewer tab; a screenshot opens in a dialog (it lives in the
  // screenshots store, not the asset store, so it has no viewer route).
  threadConversation.addEventListener("open-image", (e) => {
    const { id, kind, origin } = e.detail ?? {};
    if (!id) return;
    if (kind === "image") {
      const url = chrome.runtime.getURL(
        `artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`,
      );
      if (chrome.tabs?.create) chrome.tabs.create({ url });
      else window.open(url, "_blank", "noopener");
    } else {
      openScreenshotDialog(id);
    }
  });
}
const editAgentBtn = document.getElementById("edit-agent");
const deleteAgentBtn = document.getElementById("delete-agent");
// Current conversation identity is declared before the run-registry subscription
// so even an immediate snapshot is projected into the correct surface.
let activeViewRoute = VIEW_ROUTE.HUB;
// Every async surface open and run owns one immutable token. A later open/run
// replaces it, so an older continuation can keep journaling in the SW without
// committing title/status DOM into the newly opened surface.
const runSurfaceOwner = createRunSurfaceOwner();

// Sync the thread composer's agent scope so the /agent + @ mention exclude the
// agent the user is currently talking to (they can't call the current agent).
function syncComposerScope() {
  if (!threadComposer) return;
  if (currentAgentId) {
    threadComposer.setAttribute("agent-id", currentAgentId);
    threadComposer.setAttribute("agent-kind", currentAgentKind || "");
  } else {
    threadComposer.removeAttribute("agent-id");
    threadComposer.removeAttribute("agent-kind");
  }
}

// The inner cleanups, so openView/showThreadView can hide the OTHER overlay
// before the next route update (stale overlay state must never survive into
// the new view).
// When any in-context view (thread / settings / directory / skills / etc.) is
// open, the hub is hidden + its scroll is frozen so the BACKGROUND page cannot
// scroll behind the overlay (the scrollbar belongs to the ACTIVE view only).
function syncViewOpen() {
  const fullViewOpen = !viewOverlay.hidden;
  const anyOpen = !threadView.hidden || fullViewOpen;
  document.body.classList.toggle("view-open", anyOpen);
  document.body.classList.toggle("full-view-open", fullViewOpen);

  // The full Directory/Settings/Artifacts view covers the whole hub. Keep
  // the sidebar itself inert and AX-absent while the pure nub policy separately
  // owns every toggle state. This avoids two authorities mutating sideToggle,
  // while preserving the sidebar's exact expanded/collapsed state on restore.
  if (side) {
    side.inert = fullViewOpen;
    if (fullViewOpen) side.setAttribute("aria-hidden", "true");
    else side.removeAttribute("aria-hidden");
  }
  applySidebarNubPolicy(
    sideToggle,
    fullViewOpen ? "full" : !threadView.hidden ? "conversation" : "hub",
  );
}
function hideThreadViewInner() {
  runSurfaceOwner.claim(); // leaving fences any in-flight run (its outcome still journals)
  setRunDebugOpen(false); // the debug overlay never outlives its surface
  if (statusOwner !== 0) {
    statusOwner = 0;
    setStatus("ready"); // reset an orphaned "running…" (a parked run never resets itself)
  }
  threadTitle.classList.remove("editable-task");
  threadTitle.removeAttribute("role");
  threadTitle.removeAttribute("title");
  threadTitle.removeAttribute("aria-label");
  threadView.hidden = true;
  currentThreadId = null;
  currentAgentId = null;
  currentAgentKind = null;
  // Back to the hub: the next task's assistant turns are the hub's own agent.
  threadConversation?.setIdentity?.({ name: "Agent", avatar: initialAvatar("Agent") });
  hideAgentSchedules();
  syncComposerScope();
  syncConversationRunControls();
  stopRunTranscript();
  threadConversation.clear?.();
  renderRunStatus({ state: "idle" });
  syncViewOpen();
}
function hideViewInner() {
  viewOverlay.hidden = true;
  // CAP-FB-20260826-BACK-STACK-02: do NOT navigate the frame with a plain
  // viewFrame.src= assignment here. A cross-document navigation (X →
  // about:blank) via src= APPENDS a JOINT session-history entry, so every close
  // polluted the top frame's history and the next open needed an extra Back
  // press (the "blank screen, press back twice" bug).
  //
  // CAP-FB-20260828-PANEL-DOC-RETENTION-01: the panel documents persist in the
  // per-panel frame pool (bounded by the panel count — see panelFrameFor), so
  // close is a plain hide: no document churn, no GC-cadence memory sawtooth,
  // and the CAP-FB-20260826-BACK-STACK-02 history semantics above still hold.
  syncViewOpen();
}
function showThreadView(options = {}) {
  const focusAfter = Object.hasOwn(options, "focusAfter")
    ? options.focusAfter
    : threadTitle;
  // Already open (a follow-up/nudge in the same surface): restarting the view
  // transition would flash the thread + the run-status banner mid-run (the
  // review's working-state screenshot finding). A no-argument call remains a
  // focus no-op; only explicit route changes (for example, task → agent) own
  // a synchronous focus disposition.
  if (!threadView.hidden) {
    focusExplicitRouteTarget(options);
    return;
  }
  runRouteUpdate(() => {
    // Only ONE overlay at a time (item 48): the thread view replaces the
    // settings/directory/recipes view.
    if (!viewOverlay.hidden) hideViewInner();
    threadView.hidden = false;
    activeViewRoute = VIEW_ROUTE.TASK;
    // Covered-view state is synchronized inside the route update so the
    // destination view never renders over stale overlay state.
    syncViewOpen();
  }, {
    focusAfter,
  });
}
function hideThreadView({
  focusAfter =
    document.querySelector('#thread-sidebar [aria-current="true"]') || composer,
  fromNavigation = false,
} = {}) {
  if (!fromNavigation && typeof window !== "undefined" && window.history?.back && location.hash && location.hash !== "#") {
    window.history.back();
    return;
  }
  runRouteUpdate(() => {
    hideThreadViewInner();
    activeViewRoute = VIEW_ROUTE.HUB;
  }, {
    focusAfter,
  });
  flushRunLogDirty(); // activity written while the thread was open appears now
}

let threadProjectionGeneration = 0;
function renderThreadProjection(thread, owner = runSurfaceOwner.current()) {
  threadTitle.textContent = thread?.name || "Task";
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  // The projection transform is the PURE, unit-tested projectThreadMessages
  // (shared/conversation.js): every persisted user/assistant row renders, and
  // the tool rows replay as ONE TERMINAL card per call via the same pairing
  // the journal surfaces use — a reopened or terminally reconciled thread
  // replaces the projection and therefore restores each durable result
  // exactly once.
  threadConversation.setMessages?.(projectThreadMessages(thread));
  if (typeof thread?.id === "string" && thread.id && owner != null) {
    recordAuthoritativeThreadProjection(threadConversation, {
      threadId: thread.id,
      owner,
      generation: ++threadProjectionGeneration,
      messages,
    });
  } else {
    clearAuthoritativeThreadProjection(threadConversation);
  }
}

const terminalThreadProjectionLifecycle = createTerminalThreadProjectionLifecycle({
  loadThread: (id) => send("thread.get", { id }),
  commitThread: (thread, _run, owner) => renderThreadProjection(thread, owner),
  getOpenOwnerThreadId: () => !threadView.hidden && currentAgentId === null ? currentThreadId : null,
  captureSurfaceOwner: () => runSurfaceOwner.current(),
  ownsSurfaceOwner: (owner) => runSurfaceOwner.owns(owner),
});

// Re-read an OPEN thread from the store and re-project it (board delivery):
// owner-fenced like openThread so a surface switch during the read wins.
async function refreshOpenThreadFromStore(id) {
  const owner = runSurfaceOwner.current();
  const res = await send("thread.get", { id }).catch(() => ({ ok: false }));
  if (!res?.ok || !res.thread) return;
  if (!runSurfaceOwner.owns(owner) || currentThreadId !== id || currentAgentId !== null) return;
  renderThreadProjection(res.thread, owner);
  projectSurfaceRunTranscript();
}

async function openThread(id) {
  // Observability: the owner's "click a task, wait 10s" path — this span is
  // the end-to-end thread-open measurement (perfSummary breaks it out).
  const openSpan = perfSpan("ntp:open_thread");
  ntpLog.debug("open thread", id);
  const owner = runSurfaceOwner.claim();
  currentThreadId = id;
  currentAgentId = null; // a thread is NOT an agent chat
  currentAgentKind = null;
  // Assistant turns in a task thread are the hub's own agent.
  threadConversation?.setIdentity?.({ name: "Agent", avatar: initialAvatar("Agent") });
  setRunDebugOpen(false); // a surface switch always starts with the debug overlay closed
  syncConversationRunControls();
  hideAgentSchedules();

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#thread=${encodeURIComponent(id)}`;
    if (location.hash !== hash) {
      navigateNtpRoute(window, hash, { route: "thread", id });
    }
  }
  // Hide the previous run's banner at the ownership hand-off, not after the
  // asynchronous thread read. The old run continues and journals in the SW.
  renderRunStatus({ state: "idle" });
  // Clear the prior surface's plan strip; THIS thread's live transcript (below)
  // rebuilds it from its own step events (CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01).
  threadConversation?.resetPlan?.();
  // Tasks use direct click-to-edit on the title with an editable hover affordance;
  // the separate Edit button is removed from the task view (CAP-FB-20260823-TASK-INLINE-EDIT-01).
  editAgentBtn.hidden = true;
  if (deleteAgentBtn) deleteAgentBtn.hidden = true;
  threadTitle.classList.add("editable-task");
  threadTitle.setAttribute("tabindex", "-1");
  threadTitle.setAttribute("role", "button");
  threadTitle.setAttribute("title", "Click to rename task");
  syncComposerScope();
  // A thread.get can transiently fail when the MV3 service worker is mid-
  // restart (the message wakes it, but the first attempt can race the boot).
  // Rendering an empty "Task" surface then is a LIE (the run's data exists) —
  // retry the read once before settling (the run-lifecycle resilience fix).
  let res = await send("thread.get", { id }).catch(() => ({ ok: false }));
  if (!(res.ok && res.thread)) {
    await sleep(400); // let a restarting SW boot
    res = await send("thread.get", { id }).catch(() => ({ ok: false }));
  }
  // Another open/run may have claimed the surface during either await. Fence
  // every following title/message/status write as one owner-bound commit.
  if (!runSurfaceOwner.owns(owner) || currentThreadId !== id || currentAgentId !== null) {
    openSpan.end("superseded");
    return;
  }
  const thread = res.ok ? res.thread : null;
  renderThreadProjection(thread, owner);
  // Restore the run view for a task that was executing (or terminally settled)
  // while the owner was away (CAP-FB-20260823-DURABLE-TASK-RESTORE-01):
  // re-attach the live projection for THIS thread's latest run. The thread
  // projection above replays the persisted journal, so the surface composes
  // retained history + live continuation without duplicating or losing either;
  // a run that starts/settles while the view is open re-projects via the run
  // registry subscription below.
  const restoredRun = projectSurfaceRunTranscript();
  showThreadView();
  const live = restoredRun != null
    && actionableRunsForSurface(latestDurableRuns, { threadId: id }).length > 0;
  renderRunStatus(live ? { state: "running", activity: "run in progress" } : { state: "idle" });
  renderTasks(id);
  openSpan.end("ok");
}

// ── the BACKGROUND-agent chat surface (item 61): a background agent is an
//    INDEPENDENT agent — click it to see its OWN run history + talk to it (a
//    task runs in its own OPFS sandbox), exactly like a named agent.
async function openBackgroundAgentChat(id, name) {
  threadConversation?.setIdentity?.({ name: name || id, avatar: initialAvatar(name || id) });
  const owner = runSurfaceOwner.claim();
  currentAgentId = id;
  currentAgentKind = "background";
  currentThreadId = null;
  setRunDebugOpen(false);
  syncConversationRunControls();

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#agent=background:${encodeURIComponent(id)}`;
    if (location.hash !== hash) {
      navigateNtpRoute(window, hash, { route: "agent", kind: "background", id, name });
    }
  }
  renderRunStatus({ state: "idle" });
  // No per-agent config route exists for background agents yet (only
  // named-agent.update), so hide the Edit button rather than show a dead one.
  editAgentBtn.hidden = true;
  if (deleteAgentBtn) {
    deleteAgentBtn.hidden = false;
    deleteAgentBtn.setAttribute("aria-label", "Delete background agent");
  }
  threadTitle.classList.remove("editable-task");
  threadTitle.removeAttribute("role");
  threadTitle.removeAttribute("title");
  threadTitle.removeAttribute("aria-label");
  syncComposerScope();
  threadConversation?.resetPlan?.(); // clear the prior surface's plan strip
  const hRes = await send("background-agent.history", { id }).catch(() => ({ entries: [] }));
  const hydrated = await hydrateToolResultsFromRunLogs(Array.isArray(hRes.entries) ? hRes.entries : []);
  if (!runSurfaceOwner.owns(owner) || currentAgentId !== id || currentAgentKind !== "background") return;
  threadTitle.textContent = name || id || "Background agent";
  renderAgentHistory(threadConversation, hydrated);
  projectSurfaceRunTranscript();
  showThreadView({ focusAfter: threadComposer });
  renderRunStatus({ state: "idle" });
}

// ── the AGENT chat surface (item 43): click a named agent → chat with it ──
// Opens the thread surface scoped to ONE named agent: the conversation shows
// the agent's OWN run history (its journal from its OPFS), and the composer
// starts tasks DIRECTLY in that agent (named-agent.run → its own memory/skills).

/** Load an agent's OWN run history (its journal), most-recent-first, for ANY
 * kind: named (named-agent.history), background (background-agent.history),
 * site (the enrolled origin's journal in its own OPFS store). */
async function loadAgentHistoryEntries(kind, id) {
  if (kind === "named") {
    const r = await send("named-agent.history", { id }).catch(() => ({ entries: [] }));
    return Array.isArray(r.entries) ? r.entries : [];
  }
  if (kind === "background") {
    const r = await send("background-agent.history", { id }).catch(() => ({ entries: [] }));
    return Array.isArray(r.entries) ? r.entries : [];
  }
  if (kind === "site") {
    const journal = await send("memory.get", { origin: id, key: "journal" }).catch(() => []);
    return Array.isArray(journal) ? journal.slice(-200).reverse() : [];
  }
  return [];
}

/** Hydrate an agent's journal tool rows with the RETAINED FULL results from
 * the durable run log (CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01). The journal
 * is the bounded list surface (200 KiB for the whole agent) and keeps only the
 * 300-char summary; the run log is the authority the cards read. Rows are
 * matched by (executionId, callId); the most recent HYDRATE_MAX_EXECUTIONS
 * executions are read (one bounded log read each, concurrently). A read
 * failure leaves that row on its summary — never an empty card. */
const HYDRATE_MAX_EXECUTIONS = 12;
async function hydrateToolResultsFromRunLogs(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const execIds = [];
  for (const r of rows) {
    if (r?.type !== "tool-result" || typeof r.executionId !== "string" || !r.executionId || typeof r.callId !== "string") continue;
    if (!execIds.includes(r.executionId)) execIds.push(r.executionId);
    if (execIds.length >= HYDRATE_MAX_EXECUTIONS) break;
  }
  if (!execIds.length) return rows;
  const logs = await Promise.all(execIds.map((id) => loadDurableRunLogs(id).catch(() => null)));
  const byKey = new Map();
  for (const res of logs) {
    for (const row of Array.isArray(res?.logs) ? res.logs : []) {
      if (row?.type !== "tool-result" || typeof row.resultFull !== "string" || !row.resultFull || typeof row.callId !== "string") continue;
      byKey.set(`${row.executionId}::${row.callId}`, row);
    }
  }
  if (!byKey.size) return rows;
  return rows.map((r) => {
    const hit = r?.type === "tool-result" ? byKey.get(`${r.executionId}::${r.callId}`) : null;
    return hit
      ? { ...r, resultFull: hit.resultFull, resultFullTruncated: hit.resultFullTruncated === true, resultFullBytes: Number.isFinite(hit.resultFullBytes) ? hit.resultFullBytes : null }
      : r;
  });
}

/** Open the thread surface scoped to ONE agent of ANY kind (the unified agent
 * access, CAP-FB-20260818-AGENT-ACCESS-01): the agent's own history + a
 * composer whose sends run DIRECTLY in that agent (its own memory/skills). */
async function openAgentSurface({ kind, id, name }) {
  const owner = runSurfaceOwner.claim();
  currentAgentId = id;
  currentAgentKind = kind;
  currentThreadId = null;
  // Assistant turns carry THIS agent's identity (its generated avatar when it
  // has one, the initial otherwise). The list read is cached by the SW.
  threadConversation?.setIdentity?.({ name: name || id, avatar: initialAvatar(name || id) });
  if (kind === "named") {
    send("named-agent.list").then((r) => {
      if (currentAgentId !== id) return;
      const a = (Array.isArray(r?.agents) ? r.agents : []).find((x) => x?.id === id);
      if (a) threadConversation?.setIdentity?.({ name: a.name || name || id, avatar: a.avatar || initialAvatar(a.name || name || id) });
    }).catch(() => {});
  }
  setRunDebugOpen(false);
  syncConversationRunControls();
  refreshAgentSchedules(kind, id);

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#agent=${encodeURIComponent(kind)}:${encodeURIComponent(id)}`;
    if (location.hash !== hash) {
      navigateNtpRoute(window, hash, { route: "agent", kind, id, name });
    }
  }
  renderRunStatus({ state: "idle" });
  // Only named agents have the owner-facing config dialog (named-agent.update).
  editAgentBtn.hidden = kind !== "named";
  if (kind === "named") editAgentBtn.setAttribute("aria-label", "Edit agent");
  if (deleteAgentBtn) {
    deleteAgentBtn.hidden = !kind;
    if (kind) deleteAgentBtn.setAttribute("aria-label", "Delete " + (name || id));
  }
  threadTitle.classList.remove("editable-task");
  threadTitle.removeAttribute("role");
  threadTitle.removeAttribute("title");
  threadTitle.removeAttribute("aria-label");
  syncComposerScope();
  threadConversation?.resetPlan?.(); // clear the prior surface's plan strip
  const entries = await hydrateToolResultsFromRunLogs(await loadAgentHistoryEntries(kind, id));
  if (!runSurfaceOwner.owns(owner) || currentAgentId !== id || currentAgentKind !== kind) return;
  threadTitle.textContent = name || id || "Agent";
  renderAgentHistory(threadConversation, entries);
  projectSurfaceRunTranscript();
  showThreadView({ focusAfter: threadComposer });
  renderRunStatus({ state: "idle" });
}

async function openAgentChat(id) {
  const aRes = await send("named-agent.get", { id }).catch(() => ({ ok: false }));
  const agent = aRes.ok ? aRes.agent : null;
  await openAgentSurface({ kind: "named", id, name: agent?.name || id });
}

// Render an agent's run history (its journal) as a conversation: task → user
// bubble, result → agent bubble, and PAIRED tool cards (one TERMINAL card per
// tool call — a tool-call + its tool-result pair by callId; failed/blocked
// results render as error, never a stale running card). Chronological (the
// history route is most-recent-first).
function renderAgentHistory(container, entries) {
  if (typeof container.clear === "function") container.clear();
  const rows = [...entries].reverse(); // oldest → newest
  const toolRows = pairToolJournal(rows);
  const filtered = rows.filter(
    (r) =>
      (r?.type === "task" && typeof r.task === "string" && r.task.trim()) ||
      (r?.type === "result" && typeof r.result === "string" && r.result.trim()) ||
      (r?.type === "delegated-result" && (typeof r.task === "string" || typeof r.result === "string")),
  );
  if (!filtered.length && !toolRows.length) {
    if (typeof container.appendSystem === "function") {
      container.appendSystem("No runs yet — start a task below to chat with this agent.");
    }
    return;
  }
  // Chronological merge: task/result/delegated-result bubbles + paired tool cards.
  const items = [...filtered.map((r) => ({ kind: "row", r })), ...toolRows.map((t) => ({ kind: "tool", t }))];
  items.sort((a, b) => {
    const ta = a.kind === "row" ? (typeof a.r.ts === "number" ? a.r.ts : 0) : (a.t.ts ?? 0);
    const tb = b.kind === "row" ? (typeof b.r.ts === "number" ? b.r.ts : 0) : (b.t.ts ?? 0);
    return ta - tb;
  });
  for (const item of items) {
    if (item.kind === "row") {
      const r = item.r;
      const ts = typeof r.ts === "number" ? r.ts : null;
      if (r.type === "task") appendBubble(container, "user", r.task, undefined, ts);
      else if (r.type === "result") appendBubble(container, "agent", r.result, undefined, ts);
      else if (r.type === "delegated-result") {
        if (typeof r.task === "string" && r.task.trim()) appendBubble(container, "user", r.task, undefined, ts);
        const out = typeof r.result === "string" ? r.result : (r.result != null ? safeJsonStringify(r.result) : "");
        if (out.trim()) appendBubble(container, "agent", out, undefined, ts);
      }
    } else {
      const t = item.t;
      if (typeof container.appendTool !== "function") continue;
      if (isProtocolTool(t.tool)) continue; // protocol plumbing, never a card (§9)
      // The card's detail is the RETAINED FULL result (hydrated from the
      // durable run log — the journal row itself is the bounded list surface);
      // the journal's summary string is the fallback for rows persisted before
      // the full copy existed (CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01).
      const full = typeof t.resultFull === "string" && t.resultFull ? t.resultFull : null;
      const source = full ?? t.result;
      const raw = full ?? (t.result == null ? "" : typeof t.result === "string" ? t.result : safeJsonStringify(t.result));
      const summary = source == null ? "" : summarizeToolResult(t.tool, source);
      container.appendTool({
        name: t.tool ?? "tool",
        status: t.status ?? "done",
        args: t.args ?? null,
        result: summary || null,
        detail: raw && raw !== summary ? raw : null,
        detailNote: t.resultFullTruncated ? toolResultTruncationNote(t.resultFullBytes) : null,
        ts: t.ts ?? null,
      });
    }
  }
}

// ── the agent-config surface (item 66): edit a NAMED agent's name, role (the
//    system prompt), avatar, and skills — wired to the named-agent routes.
//    The management tools (update_agent / add_skill / remove_skill) are the
//    model-facing paths; this is the OWNER-facing UI for the same routes.
function configField(labelText, tag, value, rows) {
  const wrap = document.createElement("label");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "4px";
  wrap.style.fontSize = "13px";
  wrap.style.boxSizing = "border-box";
  wrap.style.width = "100%";
  const lbl = document.createElement("span");
  lbl.textContent = labelText;
  lbl.style.fontWeight = "600";
  const el = document.createElement(tag);
  el.style.padding = "8px 10px";
  el.style.font = "inherit";
  el.style.border = "1px solid var(--border,#e3e0d9)";
  el.style.borderRadius = "8px";
  el.style.background = "var(--bg,#f7f6f3)";
  el.style.color = "var(--text,#1d1b18)";
  el.style.boxSizing = "border-box";
  el.style.width = "100%";
  el.style.outlineOffset = "0px";
  if (tag === "textarea") { el.rows = rows ?? 3; el.style.resize = "vertical"; }
  else { el.type = "text"; }
  el.value = value ?? "";
  wrap.append(lbl, el);
  return { wrap, el };
}
function configButton(text, variant) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.style.padding = "8px 14px";
  b.style.font = "inherit";
  b.style.borderRadius = "8px";
  b.style.cursor = "pointer";
  b.style.border = "1px solid var(--border,#e3e0d9)";
  if (variant === "primary") {
    b.style.background = "var(--accent,#0e6e63)";
    b.style.color = "var(--btn-fg, #fff)";
    b.style.borderColor = "var(--accent,#0e6e63)";
  } else {
    b.style.background = "transparent";
    b.style.color = "var(--text,#1d1b18)";
  }
  return b;
}
// ── the RICH agent-config dialog (item: avatar + name + role + skills + mic +
//    context files + refine) — shared by the Edit (named) + Create flows. Reuses
//    the design-system components (<mic-button>, <attach-button>, <agent-dialog>)
//    + the field helpers so it matches the rest of the UI.
function agentAssetRow(name, type) {
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.justifyContent = "space-between";
  row.style.gap = "8px";
  row.style.fontSize = "12.5px";
  row.style.padding = "6px 8px";
  row.style.border = "1px solid var(--border,#e3e0d9)";
  row.style.borderRadius = "8px";
  const lbl = document.createElement("span");
  lbl.textContent = `${name}${type ? ` · ${type}` : ""}`;
  lbl.style.overflow = "hidden";
  lbl.style.textOverflow = "ellipsis";
  lbl.style.whiteSpace = "nowrap";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "✕";
  rm.setAttribute("aria-label", `remove ${name}`);
  rm.style.border = "0";
  rm.style.background = "transparent";
  rm.style.cursor = "pointer";
  rm.style.color = "var(--muted,#635e56)";
  rm.style.fontSize = "14px";
  row.append(lbl, rm);
  return { row, rm };
}

async function openAgentConfig() {
  if (currentAgentKind !== "named" || !currentAgentId) return;
  const res = await send("named-agent.get", { id: currentAgentId }).catch(() => ({ ok: false }));
  const agent = res.ok ? res.agent : null;
  if (!agent) { setStatus("Agent not found", false); return; }
  await buildAgentConfigDialog({
    title: `Edit “${agent.name || currentAgentId}”`,
    name: agent.name ?? "",
    role: agent.role ?? "",
    avatar: agent.avatar ?? null,
    initialSkills: agent.skills ?? [],
    initialCoreAssets: agent.coreAssets ?? [],
    selfId: agent.id ?? currentAgentId,
    initialCanDelegateTo: agent.canDelegateTo ?? [],
    canRegenerateAvatar: true,
    canDelete: true,
    savedLabel: "Save",
    schedule: agent.schedule?.periodInMinutes ?? null,
    initialMcpServers: agent.mcpServers ?? [],
    onSave: async (v) => {
      // Schedule FIRST: the owner's schedule change applies through the
      // owner-direct schedule path even when the persona edit pends an
      // approval (named-agent.update is not owner-direct — pre-existing).
      const prev = agent.schedule?.periodInMinutes ?? null;
      const next = v.schedule?.periodInMinutes ?? null;
      let scheduleNote = "";
      if (next !== prev) {
        const s = await send("named-agent.set-schedule", {
          id: currentAgentId,
          periodInMinutes: next,
          task: v.schedule?.task ?? agent.schedule?.task ?? null,
        }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (s?.ok !== true) return { ok: false, error: `the schedule failed: ${s?.error ?? "unknown"}` };
        scheduleNote = next == null ? "schedule removed" : `scheduled every ${next} min`;
      }
      const r = await send("named-agent.update", {
        id: currentAgentId, name: v.name, role: v.role, avatar: v.avatar, skills: v.skills, coreAssets: v.coreAssets, canDelegateTo: v.canDelegateTo,
      }).catch(() => ({ ok: false }));
      if (r?.ok === false) {
        return scheduleNote
          ? { ok: true, note: `${scheduleNote}; the persona edit needs approval in Settings` }
          : { ok: false, error: r?.error ?? "unknown" };
      }
      // Per-agent MCP servers: persist only when they actually changed — a
      // spurious owner-approval card on every unrelated edit would be noise. The
      // structural signature ignores tokens, so an added/changed credential is
      // detected separately (a redacted, unchanged server carries a blank token).
      const mcpSig = (list) => JSON.stringify((Array.isArray(list) ? list : []).map((s) => ({
        id: s.id, name: s.name, transport: s.transport, url: s.url,
        enabled: s.enabled !== false, header: s.auth?.headerName ?? "",
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
      const tokenTouched = (v.mcpServers ?? []).some((s) => s.auth && s.auth.token);
      if (mcpSig(v.mcpServers) !== mcpSig(agent.mcpServers ?? []) || tokenTouched) {
        const m = await send("named-agent.set-mcp-servers", { id: currentAgentId, servers: v.mcpServers })
          .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (m?.ok === false) {
          return { ok: true, note: `agent saved; MCP servers were not updated: ${m?.error ?? "unknown"}` };
        }
      }
      return { ok: true };
    },
    onSaved: async () => { renderNamedAgents(); await openAgentChat(currentAgentId); },
  });
}

// The starter set is a CURATED gallery, not a batch action (owner directive
// 2026-08-30, CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01): "starter
// templates" opens the create flow with the gallery filtered to the seven
// STARTER_TEMPLATE_IDS. Each template becomes ONE real agent — persona,
// skills, memory and (for a background template) a live schedule — only when
// the owner picks it and presses "Create agent"; never seven at once, never
// silently.
function addStarterAgents() {
  return openQuickCreateAgent();
}

function openQuickCreateAgent() {
  buildAgentConfigDialog({
    title: "Create an agent",
    name: "",
    role: "",
    avatar: null,
    initialSkills: [],
    initialCoreAssets: [],
    canRegenerateAvatar: false,
    showTemplates: true,
    savedLabel: "Create agent",
    onSave: async (v) => {
      const r = await send("named-agent.create", {
        name: v.name, role: v.role, avatar: v.avatar, skills: v.skills, coreAssets: v.coreAssets,
        canDelegateTo: v.canDelegateTo, schedule: v.schedule,
      }).catch(() => ({ ok: false }));
      if (!r?.ok) return { ok: false, error: r?.error ?? "unknown" };
      const id = r.agent?.id ?? v.name;
      // Per-agent MCP servers are saved through their own owner-approval'd route
      // (the create route does not carry them). Only when the owner configured
      // some in the dialog.
      let mcpNote = "";
      if (Array.isArray(v.mcpServers) && v.mcpServers.length) {
        const m = await send("named-agent.set-mcp-servers", { id, servers: v.mcpServers })
          .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (m?.ok === false) mcpNote = `; MCP servers were not saved: ${m?.error ?? "unknown"}`;
      }
      return { ok: true, id, firstTask: v.firstTask, scheduleError: r.scheduleError, note: mcpNote || undefined };
    },
    onSaved: async (result) => {
      renderNamedAgents();
      await openAgentChat(result?.id);
      // A template's first task is a SUGGESTION: pre-fill the VISIBLE composer
      // (the opened agent view's thread composer — never the hidden hub
      // composer) so the owner reviews/edits before sending (never auto-sent).
      if (result?.firstTask && threadComposer) {
        threadComposer.value = result.firstTask;
      }
    },
  });
}

// Build the rich agent dialog. Returns via the onSave/onSaved callbacks (the
// dialog owns its own lifecycle).
// Build the rich agent dialog (CAP-FB-20260823-CREATE-AGENT-DIALOG-01).
// Features: non-clipped focus outline, sticky outside-scroll footer with
// Create/Cancel, collapsible skills section, and overscroll-behavior: contain.
async function buildAgentConfigDialog(opts) {
  const [skillsRes, bgRes] = await Promise.all([
    send("skill.list").catch(() => ({ skills: [] })),
    // The 22 background recipes are scheduled TEMPLATES in the create flow
    // (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01) — fetched only when the
    // gallery is shown, projected through recipeAsTemplate (no data copy).
    opts.showTemplates ? send("background-agent.list").catch(() => ({ agents: [] })) : Promise.resolve({ agents: [] }),
  ]);
  const available = Array.isArray(skillsRes.skills) ? skillsRes.skills : [];
  const backgroundTemplates = (Array.isArray(bgRes?.agents) ? bgRes.agents : [])
    .map(recipeAsTemplate).filter(Boolean);
  const agentSkillIds = new Set((opts.initialSkills ?? []).map((s) => (typeof s === "string" ? s : s?.id ?? s?.name)));

  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", opts.title);

  // Outer container: structural flex column with overscroll containment
  const container = document.createElement("div");
  container.className = "agent-config-container";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.width = "min(88vw, 540px)";
  container.style.minWidth = "0";
  container.style.maxWidth = "100%";
  container.style.maxHeight = "min(78vh, 680px)";
  container.style.overflow = "hidden";
  container.style.overscrollBehavior = "contain";
  container.style.boxSizing = "border-box";

  // Scrollable body: padded so focused elements and focus rings are not clipped
  const scrollBody = document.createElement("div");
  scrollBody.className = "agent-config-scroll";
  scrollBody.style.display = "flex";
  scrollBody.style.flexDirection = "column";
  scrollBody.style.gap = "14px";
  scrollBody.style.flex = "1 1 auto";
  scrollBody.style.minHeight = "0";
  scrollBody.style.overflowY = "auto";
  scrollBody.style.overscrollBehavior = "contain";
  scrollBody.style.padding = "4px 6px";
  scrollBody.style.scrollPadding = "12px";
  scrollBody.style.boxSizing = "border-box";

  // Avatar: a preview + regenerate (edit only) + a custom upload.
  let avatarValue = opts.avatar ?? null;
  const avatarRow = document.createElement("div");
  avatarRow.style.display = "flex";
  avatarRow.style.alignItems = "center";
  avatarRow.style.gap = "10px";
  const avatarImg = document.createElement("img");
  const avatarLabel = document.createElement("span");
  avatarLabel.textContent = "Avatar";
  avatarLabel.style.fontWeight = "600";
  avatarLabel.style.fontSize = "13px";
  avatarLabel.style.marginRight = "auto";
  function renderAvatarPreview() {
    if (avatarValue) {
      avatarImg.src = avatarValue;
      avatarImg.alt = "agent avatar";
      avatarImg.style.width = "36px";
      avatarImg.style.height = "36px";
      avatarImg.style.borderRadius = "50%";
      avatarImg.style.objectFit = "cover";
      avatarImg.style.border = "1px solid var(--border,#e3e0d9)";
      avatarImg.style.display = "block";
    } else {
      avatarImg.removeAttribute("src");
      avatarImg.style.display = "none";
    }
  }
  renderAvatarPreview();
  const uploadBtn = configButton("Upload", "secondary");
  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.accept = "image/*";
  uploadInput.style.display = "none";
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", () => {
    const f = uploadInput.files?.[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { avatarValue = String(fr.result); renderAvatarPreview(); };
    fr.readAsDataURL(f);
  });
  avatarRow.append(avatarImg, avatarLabel, uploadBtn, uploadInput);

  const nameField = configField("Name", "input", opts.name ?? "");

  // ── Template gallery (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01;
  // G2, docs/AGENT-PRODUCT-GAPS.md §3): templates are the FIRST step of the
  // create flow, not a collapsed select. Picking a card pre-fills name/role/
  // skills/schedule (+ the first-task suggestion carried to the composer after
  // create), and the owner can then edit ALL of it — rewrite the persona,
  // add/remove skills — before creating. The card stays selected while the
  // owner edits (it reflects the ORIGIN of the form, not equality with it).
  // "Custom agent" (blank) is selected by default; choosing it again clears
  // what the last template put in the form.
  let selectedTemplate = null;
  let templateSection = null;
  let templateGallery = null;
  if (opts.showTemplates) {
    const starterIds = new Set(STARTER_TEMPLATE_IDS);
    const catalogue = [
      ...STARTER_TEMPLATE_IDS.map(agentTemplateById).filter(Boolean).map((t) => ({ ...t, starter: true })),
      ...AGENT_TEMPLATES.filter((t) => !starterIds.has(t.id)),
      // A recipe that already has a curated template (same id, e.g.
      // price-watcher) is offered once — the curated card is the richer one.
      ...backgroundTemplates.filter((t) => !AGENT_TEMPLATES.some((c) => c.id === t.id)),
    ];
    const templateById = new Map(catalogue.map((t) => [t.id, t]));
    const updateSkillCount = () => {
      const countEl = skillCountEl;
      if (!countEl) return;
      const count = skillSection.count();
      countEl.textContent = count > 0 ? `${count} selected` : `${available.length} available`;
    };
    const applyTemplate = (t) => {
      if (!t) {
        // Back to a blank agent: undo the last template's prefill (the owner's
        // own picks on top of it are kept — removal is theirs).
        if (selectedTemplate) {
          const prev = templatePrefill(selectedTemplate);
          if (nameField.el.value === prev.name) nameField.el.value = "";
          if (roleField.el.value === prev.role) roleField.el.value = "";
          // Collision-proof undo (r3/r4): a raw template skill id unchecks
          // exactly one row of a colliding pair (the unique owner, or the
          // built-in on collision).
          skillSection.uncheckTemplate(prev.skills);
          scheduleField.el.value = "";
          scheduleField.el.dispatchEvent(new Event("input", { bubbles: true }));
          updateSkillCount();
        }
        selectedTemplate = null;
        return;
      }
      const pre = templatePrefill(t);
      selectedTemplate = t;
      nameField.el.value = pre.name;
      roleField.el.value = pre.role;
      // A background template is just an agent WITH a schedule (the unified
      // model): prefill the schedule field; an on-demand template clears it.
      scheduleField.el.value = pre.schedule ? `every ${pre.schedule.periodInMinutes} minutes` : "";
      scheduleField.el.dispatchEvent(new Event("input", { bubbles: true }));
      // Suggested skills: CHECK the template's suggestions on top of whatever
      // the owner already picked — removal is theirs (full specialization).
      // Collision-proof (r3/r4): a raw template skill id toggles exactly one
      // row of a colliding pair (the unique owner, or the built-in on
      // collision) — never both rows.
      skillSection.checkTemplate(pre.skills);
      updateSkillCount();
    };
    const templateSelect = buildTemplateSelect({
      host: document.createElement("div"),
      catalogue,
      blankLabel: "Custom agent — start from a blank agent.",
      selected: "",
      filterLabel: "Search templates",
      onChange: (id) => applyTemplate(id ? templateById.get(id) ?? null : null),
    });
    templateGallery = templateSelect.select;
    const section = document.createElement("div");
    section.className = "agent-template-step";
    section.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0;";
    const heading = document.createElement("h3");
    heading.id = "agent-template-step-title";
    heading.textContent = "Start from a template";
    heading.style.cssText = "margin:0;font-size:13px;font-weight:600;line-height:1.4;";
    const lead = document.createElement("p");
    lead.textContent = "Choose a template or start from scratch. Everything it fills in stays editable.";
    lead.style.cssText = "margin:0;font-size:12px;line-height:1.4;color:var(--muted,#635e56);";
    section.setAttribute("role", "group");
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading, lead, templateSelect.select.parentElement);
    templateSection = section;
  }


  // The primary path follows the owner's task order: identity, purpose,
  // starting template, then schedule. Less common persona data stays in Advanced.
  const roleField = configField("What it does", "textarea", opts.role ?? "", 3);
  const roleTools = document.createElement("div");
  roleTools.className = "agent-role-tools";
  roleTools.style.display = "flex";
  roleTools.style.gap = "8px";
  roleTools.style.alignItems = "center";
  const mic = document.createElement("mic-button");
  mic.setAttribute("label", "Dictate the role");
  mic.addEventListener("transcript", (e) => {
    const text = e?.detail?.text ?? "";
    if (!text) return;
    roleField.el.value = text;
  });
  mic.addEventListener("mic-error", (e) => setStatus(e?.detail?.message ?? "mic error", false));
  const refineBtn = configButton("Refine", "secondary");
  roleTools.append(mic, refineBtn);
  roleField.wrap.append(roleTools);
  if (templateSection) scrollBody.append(templateSection);
  scrollBody.append(nameField.wrap, roleField.wrap);

  const advancedDetails = document.createElement("details");
  advancedDetails.className = "agent-config-advanced";
  advancedDetails.style.border = "1px solid var(--border,#e3e0d9)";
  advancedDetails.style.borderRadius = "8px";
  advancedDetails.style.background = "var(--panel,#ffffff)";
  advancedDetails.style.minWidth = "0";
  advancedDetails.style.maxWidth = "100%";
  advancedDetails.style.overflow = "hidden";
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "Advanced";
  advancedSummary.style.cssText = "cursor:pointer;font-size:13px;font-weight:600;padding:10px 12px;";
  const advancedBody = document.createElement("div");
  advancedBody.className = "agent-config-advanced-body";
  advancedBody.style.cssText = "display:flex;flex-direction:column;gap:12px;min-width:0;max-width:100%;padding:4px 12px 12px;border-top:1px solid var(--border,#e3e0d9);box-sizing:border-box;";
  advancedBody.append(avatarRow);
  advancedDetails.append(advancedSummary, advancedBody);
  scrollBody.append(advancedDetails);

  // Collapsible skills section
  const skillsDetails = document.createElement("details");
  skillsDetails.className = "skills-collapse";
  skillsDetails.style.border = "1px solid var(--border,#e3e0d9)";
  skillsDetails.style.borderRadius = "8px";
  skillsDetails.style.padding = "0";
  skillsDetails.style.margin = "0";
  skillsDetails.style.background = "var(--panel,#ffffff)";
  skillsDetails.style.minWidth = "0";
  skillsDetails.style.maxWidth = "100%";
  skillsDetails.style.overflow = "hidden";

  const skillsSummary = document.createElement("summary");
  skillsSummary.style.padding = "10px 12px";
  skillsSummary.style.fontWeight = "600";
  skillsSummary.style.fontSize = "13px";
  skillsSummary.style.cursor = "pointer";
  skillsSummary.style.display = "flex";
  skillsSummary.style.alignItems = "center";
  skillsSummary.style.justifyContent = "space-between";
  skillsSummary.style.minWidth = "0";
  skillsSummary.style.gap = "8px";
  skillsSummary.style.userSelect = "none";
  const skillCountEl = document.createElement("span");
  skillCountEl.className = "skill-count";
  skillCountEl.style.cssText = "font-size:12px;color:var(--muted,#635e56);font-weight:normal;";
  skillsSummary.append("Skills", skillCountEl);
  skillsDetails.append(skillsSummary);

  const skillsList = document.createElement("div");
  skillsList.className = "skills-list";
  skillsList.style.padding = "8px 12px 10px";
  skillsList.style.maxHeight = "180px";
  skillsList.style.overflowY = "auto";
  skillsList.style.overscrollBehavior = "contain";
  skillsList.style.display = "flex";
  skillsList.style.flexDirection = "column";
  skillsList.style.gap = "6px";
  skillsList.style.borderTop = "1px solid var(--border,#e3e0d9)";

  // The REAL skills-section render path (lib/agent-skill-rows.js): rows keyed
  // by refId, collision-proof restore/count, template apply/undo, and
  // refId-keyed save collection.
  const skillSection = buildAgentSkillRows({
    available,
    savedIds: [...agentSkillIds],
    countEl: skillCountEl,
  });
  if (!skillSection.rows.length) {
    const none = document.createElement("p");
    none.textContent = "No skills available.";
    none.style.fontSize = "12.5px";
    none.style.color = "var(--muted,#635e56)";
    none.style.margin = "4px 0 0";
    skillsList.append(none);
  } else {
    for (const r of skillSection.rows) skillsList.append(r.row);
  }
  skillsDetails.append(skillsList);
  advancedBody.append(skillsDetails);

  // Optional interval schedule, entered in the owner's language. The parser is
  // local and deterministic; unsupported calendar timing is rejected rather
  // than approximated into a recurrence that would fire on the wrong days.
  const initialScheduleText = opts.schedule != null ? `every ${opts.schedule} minutes` : "";
  const scheduleField = configField("Run on a schedule", "input", initialScheduleText, 1);
  scheduleField.el.id = "agent-schedule";
  scheduleField.el.placeholder = "every couple of minutes";
  scheduleField.el.setAttribute("aria-describedby", "agent-schedule-feedback");
  const scheduleFeedback = document.createElement("p");
  scheduleFeedback.id = "agent-schedule-feedback";
  scheduleFeedback.setAttribute("role", "status");
  scheduleFeedback.setAttribute("aria-live", "polite");
  scheduleFeedback.style.cssText = "font-size:12px;color:var(--muted,#635e56);margin:4px 0 0;min-height:1.4em;";
  const updateScheduleFeedback = () => {
    const parsed = parseEnglishSchedule(scheduleField.el.value);
    if (parsed.error) {
      scheduleFeedback.textContent = `${parsed.error} Try: every 10 minutes / every hour`;
      scheduleFeedback.style.color = "var(--warning,#9a6700)";
      scheduleField.el.setAttribute("aria-invalid", "true");
    } else {
      scheduleFeedback.textContent = parsed.interpretation;
      scheduleFeedback.style.color = "var(--muted,#635e56)";
      scheduleField.el.removeAttribute("aria-invalid");
    }
    return parsed;
  };
  scheduleField.el.addEventListener("input", updateScheduleFeedback);
  scheduleField.wrap.append(scheduleFeedback);
  scrollBody.insertBefore(scheduleField.wrap, advancedDetails);
  updateScheduleFeedback();

  // Context files: files whose content becomes part of the agent's context.
  // "Assets" is not a user-facing word. These are NOT artifacts (agent
  // output) — they are owner-supplied input, so they get their own honest
  // name rather than borrowing the artifact noun. The persisted field stays
  // `coreAssets` (stored agent registry shape).  // Can delegate to (G5): the owner-configured allow-list of OTHER agents this
  // agent may hand subtasks to mid-run (delegate_to_agent). Empty = cannot
  // delegate. The checkbox list is every OTHER named agent (self excluded).
  const delegRes = await send("named-agent.list").catch(() => ({ agents: [] }));
  const otherAgents = (Array.isArray(delegRes.agents) ? delegRes.agents : [])
    .filter((a) => a?.id && a.id !== opts.selfId);
  const initialDeleg = new Set(Array.isArray(opts.initialCanDelegateTo) ? opts.initialCanDelegateTo : []);
  const delegChecks = new Map();
  if (otherAgents.length) {
    const delegDetails = document.createElement("details");
    delegDetails.style.fontSize = "13px";
    const delegSummary = document.createElement("summary");
    delegSummary.textContent = "Can delegate to (other agents this agent may hand subtasks to)";
    delegDetails.append(delegSummary);
    const delegList = document.createElement("div");
    delegList.style.padding = "6px 0 0 4px";
    for (const a of otherAgents) {
      const row = document.createElement("label");
      row.style.display = "flex";
      row.style.alignItems = "baseline";
      row.style.gap = "8px";
      row.style.fontSize = "13px";
      row.style.padding = "2px 0";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = initialDeleg.has(a.id);
      const text = document.createElement("span");
      text.textContent = a.name ?? a.id;
      row.append(cb, text);
      delegChecks.set(a.id, cb);
      delegList.append(row);
    }
    delegDetails.append(delegList);
    advancedBody.append(delegDetails);
  }

  // Core assets: files whose content becomes part of the agent's context.
  const coreAssets = [];
  const assetsBox = document.createElement("fieldset");
  assetsBox.style.border = "1px solid var(--border,#e3e0d9)";
  assetsBox.style.borderRadius = "8px";
  assetsBox.style.padding = "10px";
  assetsBox.style.margin = "0";
  const assetsLegend = document.createElement("legend");
  assetsLegend.textContent = "Context files";
  assetsLegend.style.fontWeight = "600";
  assetsLegend.style.fontSize = "13px";
  assetsBox.append(assetsLegend);
  const assetsHint = document.createElement("p");
  assetsHint.textContent = "Attach a text file or image as a context file — its content becomes part of the agent's instructions.";
  assetsHint.style.fontSize = "12px";
  assetsHint.style.color = "var(--muted,#635e56)";
  assetsHint.style.margin = "0 0 6px";
  assetsBox.append(assetsHint);
  const assetsList = document.createElement("div");
  assetsList.style.display = "flex";
  assetsList.style.flexDirection = "column";
  assetsList.style.gap = "6px";
  const attach = document.createElement("attach-button");
  attach.setAttribute("label", "Add a context file");
  attach.addEventListener("attach", async (e) => {
    const d = e?.detail ?? {};
    const file = d.file;
    let content = d.content ?? "";
    if (file && (typeof file.type === "string" && file.type.startsWith("text/") || /\.(txt|md|json|csv|html|css|js|ts)$/i.test(file.name ?? ""))) {
      try {
        content = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsText(file); });
      } catch { content = d.dataURL ?? ""; }
    } else {
      content = d.dataURL ?? content;
    }
    coreAssets.push({ name: d.name ?? file?.name ?? "file", type: d.type ?? file?.type ?? "text/plain", content });
    renderAssets();
  });
  function renderAssets() {
    assetsList.replaceChildren();
    for (let i = 0; i < coreAssets.length; i++) {
      const a = coreAssets[i];
      const { row, rm } = agentAssetRow(a.name, a.type);
      rm.addEventListener("click", () => { coreAssets.splice(i, 1); renderAssets(); });
      assetsList.append(row);
    }
  }
  renderAssets();
  assetsBox.append(attach, assetsList);
  advancedBody.append(assetsBox);

  // ── Per-agent MCP servers (CAP-FB-20260831-MCP-AGENT-UI-01) ──────────────
  // The agent INHERITS the global MCP set (toggle any OFF just for this agent)
  // and can ADD its own remote servers. Tokens are handled exactly like the
  // provider key: never pre-filled, redacted reads only (the hub reads the
  // global list via the token-free `mcp.servers.global-redacted` route), and
  // the per-agent list is saved through the owner-approval'd
  // `named-agent.set-mcp-servers` route on dialog save. Test connection lives in
  // Settings (that route is Settings-only), so the per-agent editor omits it.
  const mcpGlobalRes = await send("mcp.servers.global-redacted").catch(() => ({ servers: [] }));
  const mcpGlobal = Array.isArray(mcpGlobalRes?.servers) ? mcpGlobalRes.servers : [];
  const mcpGlobalIds = new Set(mcpGlobal.map((s) => s.id));
  const initialAgentMcp = Array.isArray(opts.initialMcpServers) ? opts.initialMcpServers : [];
  // A per-agent entry on a global id with enabled:false is a "disabled inherited"
  // marker; any per-agent entry NOT matching a global id is one of the agent's
  // own servers (redacted on load — no token).
  const mcpDisabledGlobal = new Set(
    initialAgentMcp.filter((s) => mcpGlobalIds.has(s.id) && s.enabled === false).map((s) => s.id),
  );
  let mcpOwn = initialAgentMcp.filter((s) => s && !mcpGlobalIds.has(s.id));

  const mcpBox = document.createElement("fieldset");
  mcpBox.className = "agent-mcp-box";
  mcpBox.style.border = "1px solid var(--border,#e3e0d9)";
  mcpBox.style.borderRadius = "8px";
  mcpBox.style.padding = "10px";
  mcpBox.style.margin = "0";
  const mcpLegend = document.createElement("legend");
  mcpLegend.textContent = "MCP servers";
  mcpLegend.style.fontWeight = "600";
  mcpLegend.style.fontSize = "13px";
  const mcpHint = document.createElement("p");
  mcpHint.textContent = "Give this agent extra tools from a remote MCP server. It inherits the servers you set in Settings — turn any off just for this agent — and you can add servers only this agent uses.";
  mcpHint.style.fontSize = "12px";
  mcpHint.style.color = "var(--muted,#635e56)";
  mcpHint.style.margin = "0 0 8px";
  mcpBox.append(mcpLegend, mcpHint);

  const mcpInherited = document.createElement("div");
  mcpInherited.className = "mcp-server-list";
  const mcpOwnList = document.createElement("div");
  mcpOwnList.className = "mcp-server-list";
  const mcpEditorSlot = document.createElement("div");

  function renderMcpInherited() {
    mcpInherited.replaceChildren();
    if (mcpGlobal.length === 0) {
      const none = document.createElement("p");
      none.className = "muted";
      none.style.cssText = "font-size:12px;margin:0 0 6px;";
      none.textContent = "No global MCP servers to inherit yet — add them in Settings.";
      mcpInherited.append(none);
      return;
    }
    for (const g of mcpGlobal) {
      const on = !mcpDisabledGlobal.has(g.id);
      mcpInherited.append(mcpServerRow({ ...g, enabled: on }, {
        tag: "Inherited",
        onToggle: (checked) => {
          if (checked) mcpDisabledGlobal.delete(g.id);
          else mcpDisabledGlobal.add(g.id);
        },
      }));
    }
  }
  function renderMcpOwn() {
    mcpOwnList.replaceChildren();
    for (const s of mcpOwn) {
      mcpOwnList.append(mcpServerRow(s, {
        onRemove: () => { mcpOwn = mcpOwn.filter((x) => x.id !== s.id); renderMcpOwn(); },
      }));
    }
  }
  function openMcpEditor() {
    mcpEditorSlot.replaceChildren();
    mcpEditorSlot.append(buildMcpServerEditor({
      existing: null,
      showTest: false,
      hint: "Streamable HTTP or SSE over an https:// URL. A token stays on this device only. Test a connection from Settings → MCP servers.",
      onSave: (server) => {
        const norm = normalizeMcpServer(server);
        if (!norm) {
          return { ok: false, error: "Enter a valid remote server — an http/sse transport and an http(s) URL." };
        }
        if (mcpGlobalIds.has(norm.id)) {
          return { ok: false, error: `“${norm.id}” collides with an inherited server — pick another name.` };
        }
        // Keep the owner-entered token in memory for this session; it is sent on
        // dialog save through the owner-approval'd route, never before.
        mcpOwn = [...mcpOwn.filter((x) => x.id !== norm.id), { ...server, id: norm.id }];
        mcpEditorSlot.replaceChildren();
        renderMcpOwn();
        return { ok: true };
      },
      onCancel: () => mcpEditorSlot.replaceChildren(),
    }));
  }
  const mcpAddBtn = configButton("Add a server", "secondary");
  mcpAddBtn.addEventListener("click", openMcpEditor);

  const mcpInheritedLabel = document.createElement("p");
  mcpInheritedLabel.textContent = "Inherited from Settings";
  mcpInheritedLabel.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#635e56);margin:2px 0 4px;";
  const mcpOwnLabel = document.createElement("p");
  mcpOwnLabel.textContent = "This agent’s own servers";
  mcpOwnLabel.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#635e56);margin:10px 0 4px;";

  renderMcpInherited();
  renderMcpOwn();
  mcpBox.append(mcpInheritedLabel, mcpInherited, mcpOwnLabel, mcpOwnList, mcpEditorSlot, mcpAddBtn);
  advancedBody.append(mcpBox);
  // Assemble the per-agent list the dialog persists (read by the save handler).
  const collectAgentMcpServers = () => buildAgentMcpList({
    globalServers: mcpGlobal,
    disabledGlobalIds: [...mcpDisabledGlobal],
    ownServers: mcpOwn,
  });

  // Sticky footer outside the scrollable body (Create / Cancel always visible)
  const footer = document.createElement("div");
  footer.className = "agent-config-footer";
  footer.style.display = "flex";
  footer.style.justifyContent = "flex-end";
  footer.style.gap = "8px";
  footer.style.paddingTop = "12px";
  footer.style.marginTop = "4px";
  footer.style.borderTop = "1px solid var(--border,#e3e0d9)";
  footer.style.background = "var(--panel,#ffffff)";
  footer.style.flex = "0 0 auto";
  footer.style.position = "sticky";
  footer.style.bottom = "0";
  footer.style.zIndex = "10";

  const regenBtn = opts.canRegenerateAvatar ? configButton("Regenerate avatar", "secondary") : null;
  const deleteBtn = opts.canDelete ? configButton("Delete agent", "secondary") : null;
  if (deleteBtn) {
    deleteBtn.style.color = "var(--danger,#b3261e)";
    deleteBtn.style.borderColor = "var(--danger,#b3261e)";
    deleteBtn.style.marginRight = "auto";
    deleteBtn.addEventListener("click", () => {
      dialog.close();
      deleteAgentBtn?.click();
    });
  }
  const cancelBtn = configButton("Cancel", "secondary");
  const saveBtn = configButton(opts.savedLabel ?? "Save", "primary");
  if (deleteBtn) footer.append(deleteBtn);
  if (regenBtn) footer.append(regenBtn);
  footer.append(cancelBtn, saveBtn);

  container.append(scrollBody, footer);
  dialog.append(container);
  document.body.append(dialog);

  refineBtn.addEventListener("click", async () => {
    const cur = roleField.el.value.trim();
    if (!cur) { setStatus("Describe what the agent does first, then Refine.", false); return; }
    refineBtn.disabled = true;
    refineBtn.textContent = "Refining…";
    const r = await send("named-agent.refine", { role: cur }).catch(() => ({ ok: false }));
    refineBtn.disabled = false;
    refineBtn.textContent = "Refine";
    if (r?.ok && r.refined) roleField.el.value = r.refined;
    else setStatus(`Refine failed: ${r?.error ?? "unknown"}`, false);
  });

  cancelBtn.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  if (regenBtn) {
    regenBtn.addEventListener("click", async () => {
      regenBtn.disabled = true;
      regenBtn.textContent = "Generating…";
      const r = await send("named-agent.avatar", { id: currentAgentId }).catch(() => ({ ok: false }));
      regenBtn.disabled = false;
      regenBtn.textContent = "Regenerate avatar";
      if (r?.ok && r.avatar) { avatarValue = r.avatar; renderAvatarPreview(); setStatus("Avatar regenerated."); }
      else setStatus(`Avatar failed: ${r?.error ?? "unknown"}`, false);
    });
  }

  saveBtn.addEventListener("click", async () => {
    const name = nameField.el.value.trim();
    const role = roleField.el.value.trim();
    if (!name) { setStatus("An agent needs a name.", false); nameField.el.focus(); return; }
    // RefId-keyed save (r4): collectChecked returns the source-qualified id
    // for every checked row, so a colliding imported skill saves as
    // `imported:<id>` and resolves to the imported row at run time.
    const skills = skillSection.collectChecked();
    const parsedSchedule = parseEnglishSchedule(
      scheduleField.el.value,
      // A background template carries its own recurring prompt; a manual
      // schedule falls back to the SW's role-derived default.
      selectedTemplate?.schedule?.prompt ?? null,
    );
    if (parsedSchedule.error) {
      updateScheduleFeedback();
      scheduleField.el.focus();
      return;
    }
    saveBtn.disabled = true;
    const schedule = parsedSchedule.schedule;
    const canDelegateTo = [...delegChecks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    const r = await opts.onSave({
      name, role, avatar: avatarValue, skills, coreAssets,
      firstTask: selectedTemplate?.firstTask ?? "",
      canDelegateTo, schedule,
      mcpServers: collectAgentMcpServers(),
    });
    saveBtn.disabled = false;
    if (r?.ok) {
      dialog.close();
      setStatus(
        r.scheduleError
          ? `Agent “${name}” saved, but its schedule was not created: ${r.scheduleError}`
          : `Agent “${name}” saved.`,
        !r.scheduleError,
      );
      await opts.onSaved?.(r);
    } else {
      setStatus(`Save failed: ${r?.error ?? "unknown"}`, false);
    }
  });

  dialog.show();
  // The gallery is the first step: initial focus lands on its selected card
  // (the Custom card by default) so Tab order reads gallery → Name → ….
  if (templateGallery) templateGallery.focus();
  else nameField.el.focus();
}

// ── the ONE live-status surface: the conversation's inline pinned bottom row ──
// The status row lives INSIDE the agent-conversation (sticky at the bottom of
// the chat viewport) — it replaced the separate banner element that duplicated
// the running conversation entry below it (owner 2026-08-28).
function renderRunStatus(s) {
  projectConversationRunStatus(threadConversation, s);
}
// The recovery action bubbles from the inline status row (light DOM). Filter
// to the status row itself — message bubbles can also emit "action".
threadConversation?.addEventListener("action", (ev) => {
  if (!ev.target?.classList?.contains?.("live-status")) return;
  // The run-status action is an NTP surface: route IN-CONTEXT like every other
  // Settings entry. chrome.runtime.openOptionsPage() creates no new target from
  // the NTP (it IS the new-tab page) and would strand the user outside the
  // thread view; openView shows the options surface in place and focuses it.
  openView("options/options.html", "Settings");
});

threadConversation?.addEventListener("stop", async (ev) => {
  if (!ev.target?.classList?.contains?.("live-status")) return;
  const row = ev.target;
  const result = await cancelRunFromRenderedStop(ev, (executionId) => {
    const button = row._root?.querySelector?.(".stop");
    if (button) { button.disabled = true; button.textContent = "Stopping…"; }
    return cancelDurableRun(executionId, "stopped by owner");
  }, navigator.userActivation).catch((error) => ({
    ok: false,
    error: error?.message ?? String(error),
    executionId: ev.detail?.executionId,
  }));
  if (result?.ignored) return;
  const currentExecutionId = row.getAttribute("execution-id");
  if (currentExecutionId && currentExecutionId !== result?.executionId) {
    if (result?.error === "run_already_terminal") setStatus("That run already finished; the newer run was not stopped.");
    return;
  }
  if (result?.ok === true) {
    renderRunStatus({ state: "cancelled" });
    setStatus("Stopped.");
  } else {
    const message = result?.error === "run_already_terminal"
      ? "Stop had no effect — this run already finished."
      : `Stop failed — ${result?.error ?? "unknown error"}`;
    renderRunStatus({ state: "failed", message, errorCategory: "aborted" });
    setStatus(message, false);
  }
});

/** Which run owner last wrote the global #status (so a superseded run's
 * orphaned "running…" is reset exactly once, never clobbering a newer run). */
let statusOwner = 0;
/** The live run's immutable per-attempt client run id (each attempt of the
 * open surface's turn registers its own — conversation.js onRunRegistered).
 * The registry terminal-reconciliation resolves the live row ONLY from the
 * settled record whose clientCorrelationId IS this id (review P1-1: the
 * updatedAt-skew heuristic let a previous run's fresh terminal record clear a
 * just-started follow-up's row under queue saturation). Declared with the
 * other registry state above because subscription emits synchronously. */
/** The last run executionId the terminal reconciliation resolved the row for
 * (a settled run keeps matching every later snapshot — resolve it ONCE). */
let lastReconciledTerminalId = null;

/** Run a turn in the thread surface (a new task, or a nudge). `mention` is an
 * @-mention delegation directive ({kind,id,name}): the task stays the hub's
 * thread and the run delegates to the referenced agent, whose result lands
 * back in this thread (CAP-FB-20260824-TASK-AGENT-BOUNDARY-01). */
async function runThreadTurn(text, attachments = [], mention = null) {
  const owner = runSurfaceOwner.claim();
  liveClientRunId = null;
  lastReconciledTerminalId = null;
  showThreadView();
  setStatus("running…", false);
  statusOwner = owner;
  const agentAtStart = currentAgentId;
  const kindAtStart = currentAgentKind;
  const threadAtStart = currentThreadId;
  const owns = () => runSurfaceOwner.owns(owner) && currentAgentId === agentAtStart &&
    currentAgentKind === kindAtStart;
  const res = await runConversationTurn(threadConversation, {
    text,
    attachments,
    history: [], // the SW derives the history from the thread when threadId is set
    threadId: threadAtStart,
    // Fence at the actual shared-DOM commit boundary as well as through
    // isStale below. No old callback can reveal a banner on a newer surface.
    onStatus: (state) => runSurfaceOwner.commit(owner, () => renderRunStatus(state)),
    // Capture the exact per-attempt id BEFORE dispatch. Registry snapshots may
    // still contain run A while follow-up B is waiting for durable admission;
    // only B's own clientCorrelationId may resolve B's row or bind its Stop.
    onRunRegistered: (runId) => runSurfaceOwner.commit(owner, () => {
      liveClientRunId = runId;
      threadConversation?.bindLiveStatusExecution?.(null);
    }),
    agentId: agentAtStart, // null for a thread; set when chatting with a named/background agent
    agentKind: kindAtStart,
    mention: mention ?? null,
    isStale: () => !owns(),
    projectionOwner: owner,
  });
  // The fence: a superseded run mutates NO global surface state. If THIS run
  // was the last status writer, reset its orphaned "running…" (a run parked
  // in a hanging permission request never reaches its own reset).
  if (!owns()) {
    if (statusOwner === owner) {
      statusOwner = 0;
      setStatus("ready");
    }
    return res;
  }
  if (res.ok) {
    // A first task lands a row on the timeline and may satisfy onboarding.
    // Refresh both from their real authorities.
    await Promise.all([refreshTimeline(), renderFirstRunGuide()]);
    if (!owns()) return res;
    if (!agentAtStart) {
      // The SW created (or reused) the thread; capture its id for continuation.
      if (res.threadId && currentThreadId === threadAtStart) {
        currentThreadId = res.threadId;
        syncConversationRunControls();
        const t = await send("thread.get", { id: res.threadId }).catch(() => ({}));
        // Re-check after the nested await: the surface may have moved on
        // while the thread title loaded.
        if (!owns()) return res;
        if (t.thread?.name) {
          runSurfaceOwner.commit(owner, () => { threadTitle.textContent = t.thread.name; });
        }
      }
      await renderTasks(currentThreadId);
      if (!owns()) return res;
    }
    if (statusOwner === owner) setStatus("ready");
  } else {
    if (statusOwner === owner) setStatus("error: " + (res.error ?? "unknown"), false);
  }
  return res;
}

const composer = document.getElementById("composer");
composer.addEventListener("send", async (ev) => {
  const { text: task, attachments, agent } = ev.detail;
  // TASK-LIFECYCLE-CONTRACT §2: a send must land in the conversation the user
  // is looking at. If a task view is open, this send CONTINUES that thread —
  // it may never silently fork a visible conversation into a new task (the
  // owner's P0: "he should have all been in that one task"). A NEW task is
  // started only when the hub surface is showing (no open task view).
  if (!threadView.hidden && currentThreadId) {
    // A send with an @mention while a task view is open CONTINUES the thread
    // too — the mention rides along as a delegation to the referenced agent
    // (same shape as the new-task mention path below); it must never fork the
    // visible conversation into a new task (contract §2).
    await runThreadTurn(task, attachments, agent?.ref ? { kind: agent.kind, id: agent.id, name: agent.name } : null);
    return;
  }
  runSurfaceOwner.claim(); // a NEW task replaces the surface — fence any in-flight run
  currentThreadId = null; // a new task → a new thread
  syncConversationRunControls();
  threadConversation.clear?.();
  if (agent?.ref) {
    // An @mention on a NEW task (CAP-FB-20260824-TASK-AGENT-BOUNDARY-01): the
    // task stays the HUB's task — created as its own thread (it appears in
    // the task list) — and the mention is dispatched as a delegation to the
    // referenced agent, whose result returns INTO the task. Referencing an
    // agent must NOT turn the task into that agent's own conversation.
    currentAgentId = null;
    currentAgentKind = null;
    syncConversationRunControls();
    threadTitle.textContent = "New task";
    await runThreadTurn(task, attachments, { kind: agent.kind, id: agent.id, name: agent.name });
    return;
  }
  currentAgentId = null; // the hub composer is the MASTER agent, not a named-agent chat
  currentAgentKind = null;
  syncConversationRunControls();
  threadTitle.textContent = "New task";
  await runThreadTurn(task, attachments);
});
composer.addEventListener("status", (ev) => {
  if (ev.detail?.text) setStatus(ev.detail.text, false);
});

threadComposer.addEventListener("send", async (ev) => {
  const { text, attachments, agent } = ev.detail;
  if (agent?.ref && !currentAgentKind) {
    // An @mention in a task's follow-up: delegate to the referenced agent and
    // bring the result BACK into THIS thread (the task stays the hub's task —
    // it must never switch into the agent's own conversation).
    await runThreadTurn(text, attachments, { kind: agent.kind, id: agent.id, name: agent.name });
    return;
  }
  if (agent?.ref) {
    // In an agent's OWN conversation the chip still navigates: direct THIS
    // message to the chosen agent's surface (its journal), routed by ID.
    await openAgentSurface({ kind: agent.kind, id: agent.id, name: agent.name });
  }
  await runThreadTurn(text, attachments);
});
document.getElementById("thread-back")?.addEventListener("click", hideThreadView);
// The Edit button is context-aware: a TASK → rename its title in place (the
// same visual as the agent's Edit, but it edits the title); a NAMED agent →
// open the agent config; a background agent → also the agent config (its own
// edit surface). A task's button must not open the agent config (it did
// nothing before because openAgentConfig only handles named agents).
editAgentBtn?.addEventListener("click", () => {
  if (currentAgentKind === "named") openAgentConfig();
  else if (currentThreadId) startTitleEdit();
});

deleteAgentBtn?.addEventListener("click", async () => {
  if (!currentAgentKind || !currentAgentId) return;
  const kind = currentAgentKind;
  const id = currentAgentId;
  let agentName = id;
  let previewDetails = "";

  if (kind === "named") {
    const res = await send("named-agent.get", { id }).catch(() => null);
    const agent = res?.agent;
    agentName = agent?.name || id;
    const skillsCount = agent?.skills?.length ?? 0;
    const assetsCount = agent?.coreAssets?.length ?? 0;
    previewDetails = `This will permanently remove the agent registry entry, its memory store, system prompt override, and custom provider configuration.\n\n` +
      `• Skills configured: ${skillsCount}\n` +
      `• Context files: ${assetsCount}\n\n` +
      `Note: Any artifacts created by this agent will be retained.`;
  } else if (kind === "site" || kind === "origin") {
    const res = await send("list-tools", { origin: id }).catch(() => ({ tools: [] }));
    const toolsCount = res?.tools?.length ?? 0;
    previewDetails = `This will disenroll the site, unregister its ${toolsCount} tools, revoke dynamic scripts, and remove host permissions.\n\n` +
      `Note: Any artifacts created by this agent will be retained.`;
  } else if (kind === "background") {
    previewDetails = `This will cancel the scheduled task and remove its recurring alarm.`;
  }

  const confirmed = await confirmActionDialog({
    title: `Delete “${agentName}”?`,
    body: `Are you sure you want to delete ${agentName}?\n\n${previewDetails}`,
    confirmLabel: "Delete agent",
    destructive: true,
  });

  if (!confirmed) return;

  let out;
  if (kind === "named") {
    out = await send("named-agent.delete", { id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  } else if (kind === "site" || kind === "origin") {
    out = await send("agent.delete", { origin: id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  } else if (kind === "background") {
    // Background agents schedule deterministically as `recipe:<id>` (the
    // enabled state derives from the task store). The old code passed the RAW
    // recipe id, so task.cancel hit "no such task" and silently deleted
    // NOTHING while the UI claimed success — the dead NTP delete button.
    // DELETION now routes through recipe.delete (removes the custom record +
    // tears the schedule down NON-BLOCKING — the instant-delete contract; a
    // RUNNING task's 5s termination dance must never block this dialog), and
    // success is asserted EXPLICITLY (ok === true), not "anything but false".
    out = await send("recipe.delete", { id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  }

  if (out?.ok === true) {
    setStatus(`Deleted ${agentName}.`, true);
    goHome({ focusAfter: composer });
    await Promise.all([renderNamedAgents(), renderSiteAgents(), renderBackgroundAgents()]);
  } else {
    setStatus(`Could not delete ${agentName}: ${out?.error ?? "failed"}.`, false);
  }
});

// ── edit the thread title (item 47): click the title → rename in place.
//    (CAP-FB-20260823-TASK-INLINE-EDIT-01). The Edit button remains solely for
//    NAMED agents to open the agent config dialog.
function startTitleEdit() {
  if (!currentThreadId) return;
  if (threadTitle.querySelector("input")) return; // already editing
  const original = threadTitle.textContent || "Task";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "title-edit";
  input.value = original;
  input.setAttribute("aria-label", "Rename task");
  const restore = (text) => {
    threadTitle.replaceChildren(document.createTextNode(text));
    if (currentThreadId) {
      threadTitle.classList.add("editable-task");
      threadTitle.setAttribute("tabindex", "-1");
      threadTitle.setAttribute("role", "button");
      threadTitle.setAttribute("title", "Click to rename task");
    }
  };
  const commit = async () => {
    const name = input.value.trim();
    if (name && name !== original) {
      const r = await send("thread.rename", { id: currentThreadId, name }).catch(() => ({ ok: false }));
      if (r?.ok) restore(name);
      else restore(original);
      await renderTasks(currentThreadId);
    } else {
      restore(original);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { restore(original); }
  });
  input.addEventListener("blur", commit);
  threadTitle.replaceChildren(input);
  input.focus();
  input.select();
}
threadTitle.addEventListener("click", () => { if (currentThreadId) startTitleEdit(); });
threadTitle.addEventListener("keydown", (e) => {
  if (currentThreadId && !threadTitle.querySelector("input") && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    startTitleEdit();
  }
});

renderSiteAgents();
renderSiteOffer();
renderWebmcpHubStatus();
renderNamedAgents();
renderBackgroundAgents();
renderFirstRunGuide();
renderTasks();
renderTimeline();
renderActionLedger();
renderJobsBoard();
renderHubUsage();
renderProviderStatus();

// The provider-status strip: the user must know BEFORE running a task whether a
// model is connected. A green keyed provider reads "Ready — <Provider> ·
// <model>"; an unreachable/misconfigured one is a warning; no model yet is a
// quiet invitation. All three link to Settings.
const PROVIDER_LABELS = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI-compatible",
  ollama: "Ollama",
  "lm-studio": "LM Studio",
  "prompt-api": "Chrome Prompt API",
  demo: "Demo",
};
async function renderProviderStatus() {
  const slot = document.getElementById("provider-status");
  if (!slot) return;
  const st = await send("provider.status").catch(() => null);
  slot.hidden = false;
  slot.classList.remove("ready", "warn");
  if (st?.ok === false) {
    slot.classList.add("warn");
    slot.textContent = "Provider issue — " + (st.reason || "check Settings");
    slot.title = "Open Settings to fix the provider";
  } else if (st?.ok === true && st.modelId) {
    slot.classList.add("ready");
    slot.textContent = `Ready — ${PROVIDER_LABELS[st.provider] || st.provider} · ${st.modelId}`;
    slot.title = "Model connected — open Settings to change it";
  } else {
    // No keyed model connected yet (the demo/local provider, or nothing).
    slot.textContent = "No model connected yet — pick one to start";
    slot.title = "Open Settings → Providers to connect a model";
  }
}
document.getElementById("provider-status")?.addEventListener("click", () => {
  if (typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
});

// A durable thread-bound run update means the authoritative thread index may
// have changed. Refresh from thread.list while the run is still active; run
// events are only a signal and never become a second task authority.
subscribeRunRegistry((snapshot) => {
  taskSidebarLifecycle.onRunSnapshot(snapshot, currentThreadId);
  terminalThreadProjectionLifecycle.onRunSnapshot(snapshot);
});

// Re-render the named agents (main area + the sidebar) when the registry
// changes — a task that creates an agent must show it in the sidebar without a
// page reload. The SW broadcasts a named-agent-changed progress event on
// create/update/delete (the registry lives in the all-optional storage, so
// chrome.storage.onChanged may never fire).
subscribeProgress((ev) => {
  if (ev?.type === "named-agent-changed") renderNamedAgents();
  // A page's passive detector just reported tools, or the open tabs changed
  // (a page opened/closed/navigated) — re-project the composer chip AND the
  // Site Agents panel (its discovered-pages banner and the section's
  // visibility) so the offer appears while the owner is looking at the hub,
  // without polling.
  if (ev?.type === "site-tools-detected" || ev?.type === "open-tabs-changed") {
    renderSiteOffer();
    renderSiteAgents();
  }
  if (ev?.type === "agent-registry-changed") {
    renderSiteOffer();
    // The unified registry changed (named/background/site) — refresh every
    // agent surface + revalidate any composer's selected-agent chip live
    // (a deleted/disabled agent clears its chip; a rename updates it).
    renderNamedAgents();
    renderBackgroundAgents();
    renderSiteAgents();
    composer.revalidateSelectedAgent?.();
    threadComposer.revalidateSelectedAgent?.();
    revalidateOpenAgent();
  }
});

/** If the agent the thread surface is scoped to was deleted (or a background
 * agent disabled), leave its conversation — chatting with a ghost must not be
 * possible. A rename just updates the title. */
async function revalidateOpenAgent() {
  if (!currentAgentId) return;
  const kind = currentAgentKind; // capture — the surface may change mid-await
  const id = currentAgentId;
  const res = await send("agent.registry").catch(() => null);
  if (!res || res.ok === false || !Array.isArray(res.groups)) return;
  if (currentAgentId !== id || currentAgentKind !== kind) return;
  const ref = canonicalRef(kind, id);
  const found = ref ? findAgentByRef(res.groups, ref) : null;
  if (!found || (found.kind === "background" && found.enabled !== true)) {
    goHome({ focusAfter: composer });
    setStatus("That agent is no longer available — its conversation was closed.", false);
    return;
  }
  if (found.name && threadTitle.textContent !== found.name) {
    threadTitle.textContent = found.name;
  }
}

// ── the task sidebar: collapse/expand + new-task (item 6/7) ──────────────
const side = document.getElementById("side");
const sideToggle = document.getElementById("side-toggle");
const durabilityHint = document.getElementById("sidebar-durability-hint");
let sidebarCollapsed = false;
const SIDEBAR_KEY = "hub.sidebarCollapsed";
// Serialize sidebar writes so a rapid toggle's LAST write always lands. The
// durability is surfaced through PUBLIC DOM (data-durability + a visible/ARIA
// hint), never a window.* test oracle.
let sidebarWriteQueue = Promise.resolve();
let sidebarDurability = "unknown"; // "durable" | "session" | "error"
function renderDurability() {
  renderDurabilityState({ side, hint: durabilityHint }, sidebarDurability);
}
function persistSidebar(collapsed) {
  sidebarWriteQueue = sidebarWriteQueue.then(async () => {
    try {
      const r = await send("kv.set", { values: { [SIDEBAR_KEY]: collapsed } });
      if (r?.ok === false) {
        sidebarDurability = "error";
        console.warn("sidebar collapse not persisted:", r.error ?? "unknown");
      } else {
        // kv.set now reports durable vs permissionless-session fallback.
        sidebarDurability = r?.mode === "durable" ? "durable" : "session";
      }
    } catch {
      sidebarDurability = "error"; // worker unreachable
    }
    // Update the PUBLIC durability surface AFTER the write resolves.
    renderDurability();
  }).catch(() => {});
  return sidebarWriteQueue;
}
// `auto` marks a form-factor-driven change (the narrow-width policy): it moves
// the rail without overwriting the user's persisted preference.
let persistedSidebarCollapsed = false;
// UX-004 REVISE: the narrow manual expansion is an OFF-CANVAS overlay, never
// the inline 240px rail (which overflows a 360px viewport). The overlay is
// transient (never persisted) and closes on scrim tap, Escape, or leaving the
// narrow width.
let sidebarOverlayOpen = false;
// Transient capture of the rail's collapsed state while the overlay drawer is
// open — restored on close, never persisted (the saved preference is untouched).
let sidebarOverlayWasCollapsed = false;
let sideScrim = null;
function setSideToggleExpanded(expanded) {
  sideToggle.setAttribute("aria-expanded", String(expanded));
}
// The toggle's label must track the EFFECTIVE expanded state (at narrow width
// that is the overlay, not the rail class).
function updateSideToggleLabels(expanded) {
  const label = expanded ? "Collapse sidebar" : "Expand sidebar";
  sideToggle.setAttribute("aria-label", label);
  sideToggle.setAttribute("title", label);
}
function ensureSideScrim() {
  if (sideScrim) return sideScrim;
  sideScrim = document.createElement("button");
  sideScrim.className = "side-scrim";
  sideScrim.type = "button";
  sideScrim.setAttribute("aria-label", "Close sidebar");
  sideScrim.hidden = true;
  sideScrim.addEventListener("click", () => runRouteUpdate(() => setSidebarOverlay(false)));
  side.after(sideScrim);
  return sideScrim;
}
function setSidebarOverlay(open) {
  const next = open === true && (narrowSidebarMq?.matches === true);
  if (next && !sidebarOverlayOpen) {
    sidebarOverlayWasCollapsed = sidebarCollapsed;
  }
  sidebarOverlayOpen = next;
  side.classList.toggle("overlay", next);
  // UX-004 REVISE 2: while the overlay drawer is open the FULL nav must be
  // visible (brand, section labels, item text) — the collapsed class comes
  // OFF for the drawer's lifetime. On close the captured rail state goes back
  // on (at narrow that is the icon rail again; at wide the width policy owns
  // the class, so fall back to the live state until it applies).
  side.classList.toggle(
    "collapsed",
    next ? false : ((narrowSidebarMq?.matches === true) ? sidebarOverlayWasCollapsed : sidebarCollapsed),
  );
  const scrim = ensureSideScrim();
  scrim.hidden = !next;
  // expanded-ness is the overlay at narrow width, so aria-expanded + the
  // toggle label track IT.
  setSideToggleExpanded(next);
  updateSideToggleLabels(next);
}
function setSidebarCollapsed(collapsed, { auto = false } = {}) {
  sidebarCollapsed = collapsed;
  // While the overlay drawer is open it owns the collapsed class (the drawer
  // shows the full nav); the variable still updates so close() restores it.
  if (!sidebarOverlayOpen) side.classList.toggle("collapsed", collapsed);
  const expandedNow = (narrowSidebarMq?.matches === true) ? sidebarOverlayOpen : !collapsed;
  updateSideToggleLabels(expandedNow);
  setSideToggleExpanded(expandedNow);
  renderDurability();
  if (auto) return; // form-factor state — the user's saved choice stands
  persistedSidebarCollapsed = collapsed;
  persistSidebar(collapsed); // serialized + ordered
}
sideToggle?.addEventListener("click", () => {
  // UX-004 REVISE: the toggle goes THROUGH the narrow policy — below the
  // breakpoint expansion is the off-canvas overlay, never the inline rail.
  if (narrowSidebarMq?.matches === true) {
    runRouteUpdate(() => setSidebarOverlay(!sidebarOverlayOpen));
    return;
  }
  runRouteUpdate(() => setSidebarCollapsed(!sidebarCollapsed));
});
// Escape closes the overlay. Optional-chained: the unit-thread harnesses
// evaluate this module against a partial DOM shim without addEventListener.
document.addEventListener?.("keydown", (event) => {
  if (event.key === "Escape" && sidebarOverlayOpen) {
    runRouteUpdate(() => setSidebarOverlay(false));
  }
});
// Narrow-width auto-collapse (UX-004): the expanded 240px rail overflows a
// 360px viewport, so below the breakpoint the rail collapses to the icon rail
// without persisting; crossing back restores the user's own last choice.
const narrowSidebarMq = window.matchMedia?.(SIDEBAR_NARROW_QUERY) ?? null;
function applySidebarForWidth() {
  const narrow = narrowSidebarMq?.matches === true;
  // The overlay exists only at narrow width — leaving the breakpoint closes it.
  if (!narrow && sidebarOverlayOpen) setSidebarOverlay(false);
  const policy = sidebarWidthPolicy({
    narrow,
    persistedCollapsed: persistedSidebarCollapsed,
  });
  if (policy.collapsed !== sidebarCollapsed) {
    setSidebarCollapsed(policy.collapsed, { auto: !policy.persist });
  }
  setSideToggleExpanded(narrow ? sidebarOverlayOpen : !policy.collapsed);
}
narrowSidebarMq?.addEventListener?.("change", applySidebarForWidth);
// Restore the persisted rail state on load (session or durable), then let the
// width policy decide the effective state (a narrow viewport collapses even
// when the saved choice was expanded).
async function restoreSidebar() {
  try {
    const s = await send("kv.get", { keys: SIDEBAR_KEY });
    persistedSidebarCollapsed = s?.[SIDEBAR_KEY] === true;
  } catch {
    persistedSidebarCollapsed = false; // worker unreachable — default expanded.
  }
  applySidebarForWidth();
}
restoreSidebar();

// The "+" new-task button is a destination, not Back: replace the current
// deep route with Home, close the task/agent surface, then focus a fresh hub
// composer. No prior task can reappear behind the new conversation.
document.getElementById("new-task")?.addEventListener("click", () => {
  goHome({ focusAfter: composer });
});

// Creating an agent likewise starts from Home before opening the dialog, so
// the dialog is never stacked behind a task/agent surface.
document.getElementById("new-agent")?.addEventListener("click", () => {
  goHome({ focusAfter: null });
  openQuickCreateAgent();
});

// ── in-context navigation (no new tabs) ─────────────────────────────────
const viewOverlay = document.getElementById("view");
// CAP-FB-20260828-PANEL-DOC-RETENTION-01: one PERSISTENT frame per panel
// (lazy, created on first open, reused for every later open). A single shared
// frame forces a cross-document replace on every panel SWITCH, and the
// renderer retains each destroyed document until a MAJOR GC — measured 12
// open/close cycles across settings/directory/assets growing Documents 4→39,
// Frames 3→20, listeners 113→776 and JS heap 1.8→8.4MB before any GC
// (scripts/panel-leak-probe.ts). With a per-panel pool the document count is
// bounded by the panel count, nothing is destroyed on close, and re-opening a
// panel is instant (no reload). Freshness semantics are unchanged: a panel
// document already booted once per hub session for same-panel reopens; this
// makes panel switches behave the same way.
const panelFrames = new Map();
let activePanelFrame = null;
const PANEL_FRAME_CONTAINER = document.getElementById("view");
function panelFrameFor(path) {
  let frame = panelFrames.get(path);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.dataset.panelPath = path;
    frame.title = "view";
    frame.hidden = true;
    PANEL_FRAME_CONTAINER.appendChild(frame);
    panelFrames.set(path, frame);
  }
  return frame;
}
function isPanelFrameSource(win) {
  if (!win) return false;
  for (const frame of panelFrames.values()) {
    if (frame.contentWindow === win) return true;
  }
  return false;
}
const viewTitle = document.getElementById("view-title");
const viewFocus = createViewFocusController();

function embeddedViewRoute(path) {
  const routePath = String(path ?? "").split(/[?#]/, 1)[0];
  if (routePath === "options/options.html") return VIEW_ROUTE.SETTINGS;
  if (routePath === "directory/directory.html") return VIEW_ROUTE.DIRECTORY;
  return VIEW_ROUTE.ARTIFACTS;
}

function openView(path, title, trigger) {
  // Skills moved INTO Settings (owner directive): any residual skills deep
  // link (an old #view=recipes/index.html history entry or a stale caller)
  // lands on Settings' Skills section — a redirect, never a dead end.
  if (String(path ?? "").split(/[?#]/, 1)[0] === "recipes/index.html") {
    path = "options/options.html#skills";
    title = "Settings";
  }
  const targetRoute = embeddedViewRoute(path);
  // Boot the embedded document before the route update so the destination
  // CAP-FB-20260826-BACK-STACK-02: a plain `viewFrame.src = url` is a
  // cross-document navigation that APPENDS a joint session-history entry —
  // combined with the pushState below that produced TWO entries per open (the
  // "press Back twice" bug). Navigate an ALREADY-loaded iframe with a REPLACE
  // (location.replace) so the pushState below is the SINGLE history entry; the
  // very first load (empty iframe) still uses src= (which replaces the initial
  // about:blank and adds nothing).
  const frame = panelFrameFor(path);
  const frameUrl = chrome.runtime.getURL(path);
  // Boot the panel document exactly once; later opens reuse the live document.
  if (!frame.src || frame.src === "about:blank" || frame.src === location.href) {
    frame.src = frameUrl;
  }
  for (const other of panelFrames.values()) other.hidden = other !== frame;
  activePanelFrame = frame;
  frame.title = title;
  viewTitle.textContent = title;

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#view=${encodeURIComponent(path)}`;
    if (location.hash !== hash) {
      try {
        navigateNtpRoute(window, hash, { route: "view", path, title }, title);
      } catch {
        // Ignored in non-browser testing contexts
      }
    }
  }

  runRouteUpdate(() =>
    viewFocus.open(trigger, () => {
      // Only ONE overlay at a time (item 48): the settings/directory/recipes
      // view replaces the task thread. Synchronize covered-view state inside
      // the route update.
      if (!threadView.hidden) hideThreadViewInner();
      viewOverlay.hidden = false;
      activeViewRoute = targetRoute;
      syncViewOpen();
    }, null), {
    focusAfter: activePanelFrame,
  });
}
function closeView({ fromNavigation = false } = {}) {
  if (!fromNavigation && typeof window !== "undefined" && window.history?.back && location.hash && location.hash !== "#") {
    window.history.back();
    return;
  }

  runRouteUpdate(() => {
    hideViewInner();
    activeViewRoute = VIEW_ROUTE.HUB;
  }, {
    // Keep Directory's initiating-trigger restoration via the viewFocus.close
    // disposition rather than focusing underneath the closing overlay.
    focusAfter: { focus: () => viewFocus.close(() => {}) },
  });
  flushRunLogDirty(); // activity written while Settings/Directory was open appears now
  // Returning from Settings/Directory is an owner navigation boundary. A
  // fresh authoritative read both restores the row promptly and fences any
  // older delayed sidebar read that began before the view switch.
  renderTasks(currentThreadId);
  const shouldRestoreGuideFocus = returningFromFirstRunSettings;
  returningFromFirstRunSettings = false;
  renderFirstRunGuide().then(() => {
    if (shouldRestoreGuideFocus && !firstRunGuide?.hidden) firstRunGuide.focusNextAction?.();
  });
}

function goHome({ focusAfter = document.getElementById("home") } = {}) {
  const changed = navigateHome(window);
  if (!viewOverlay?.hidden) closeView({ fromNavigation: true });
  if (!threadView?.hidden) hideThreadView({ fromNavigation: true, focusAfter });
  if (focusAfter) {
    if (typeof focusAfter.focusInput === "function") focusAfter.focusInput();
    else focusAfter.focus?.();
  }
  return changed;
}

// ── Multi-Page App Navigation API Router ────────────────────────────────────
let isApplyingHashRoute = false;
async function applyCurrentHashRoute(isTraverse = false) {
  if (isApplyingHashRoute) return;
  isApplyingHashRoute = true;
  try {
    const parsed = parseNtpHash(location.hash);
    // history.state is the SINGLE source of truth for the exact title/name of
    // the entry being restored — a traverse must not re-derive a degraded
    // hardcoded "View".
    const state = (typeof history !== "undefined" && history.state && typeof history.state === "object")
      ? history.state : null;
    const meta = resolveEntryMeta(parsed, state);
    if (parsed.route === "hub" || parsed.route === "compose") {
      if (!viewOverlay?.hidden) {
        closeView({ fromNavigation: true });
      }
      if (!threadView?.hidden) {
        hideThreadView({ fromNavigation: true });
      }
      if (parsed.route === "compose") {
        // The keyboard "new task" command: land on the hub with the caret in
        // the composer. Focus after the overlay/thread teardown above so it is
        // not immediately stolen by the surface being closed.
        document.getElementById("composer")?.focusInput?.();
      }
    } else if (parsed.route === "thread") {
      if (!viewOverlay?.hidden) hideViewInner();
      if (currentThreadId !== parsed.id || threadView?.hidden) {
        await openThread(parsed.id, { pushHistory: false });
      }
    } else if (parsed.route === "agent") {
      if (!viewOverlay?.hidden) hideViewInner();
      if (parsed.kind === "background") {
        if (currentAgentId !== parsed.id || currentAgentKind !== "background" || threadView?.hidden) {
          await openBackgroundAgentChat(parsed.id, meta.name ?? null, { pushHistory: false });
        }
      } else {
        if (currentAgentId !== parsed.id || currentAgentKind !== parsed.kind || threadView?.hidden) {
          await openAgentSurface({ kind: parsed.kind, id: parsed.id, name: meta.name ?? null }, { pushHistory: false });
        }
        // A standalone Settings tab cannot postMessage to the NTP parent frame.
        // Its explicit edit route still opens the one maintained persona dialog.
        if (parsed.kind === "named" && parsed.edit === true) await openAgentConfig();
      }
    } else if (parsed.route === "view") {
      const title = meta.title ?? "View";
      // CAP-FB-20260828-PANEL-DOC-RETENTION-01: the route is open when its
      // pooled panel frame is the active one (an unbooted path has no frame
      // yet, so a traverse to a not-yet-opened view falls through to openView).
      if (viewOverlay?.hidden || activePanelFrame !== panelFrames.get(parsed.path)) {
        openView(parsed.path, title, null, { pushHistory: false });
      } else if (viewTitle && meta.title && meta.title !== "View") {
        // Already open with the correct src — restore the stored title (a
        // traverse to the SAME view must not blank or rename it).
        viewTitle.textContent = meta.title;
      }
    }
  } finally {
    isApplyingHashRoute = false;
  }
}

// Support browser back/forward navigation when in-context view overlay or thread is open
if (typeof window !== "undefined") {
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigate", (event) => {
      const destUrl = event.destination?.url ? new URL(event.destination.url) : null;
      if (event.canIntercept && destUrl && destUrl.pathname === location.pathname) {
        const type = event.navigationType;
        if (!shouldDispatchForNavigationType(type)) {
          // A self-initiated pushState/replaceState already rendered the view
          // (openView/openThread/openAgentSurface set the DOM BEFORE pushing) —
          // do NOT re-dispatch, or the re-entrancy re-opens with a hardcoded
          // "View" title and loses the real one.
          return;
        }
        event.intercept({
          async handler() {
            await applyCurrentHashRoute(type === "traverse");
            // Settle the intercepted traversal: commit the URL, then restore
            // the browser's native scroll + focus contract.
            try { event.commit(); } catch { /* some traversals commit implicitly */ }
            try { event.scroll(); } catch { /* not every navigation exposes scroll */ }
            try { event.focusReset(); } catch { /* not every navigation exposes focusReset */ }
          },
        });
      }
    });
  } else {
    window.addEventListener("popstate", () => {
      applyCurrentHashRoute(true).catch(() => {});
    });
  }

  // The keyboard "new task" command when a hub tab is ALREADY open: the service
  // worker navigates that tab to "#compose", which is a same-document hash
  // change. The navigate listener above deliberately ignores push/replace (a
  // self-initiated pushState already rendered its view), so the route
  // dispatcher never sees it. `hashchange` always fires for a hash change, so
  // handle the one route that is purely a focus request here. It touches focus
  // only — no view state — so it cannot conflict with the dispatcher.
  window.addEventListener("hashchange", () => {
    if (parseNtpHash(location.hash).route !== "compose") return;
    document.getElementById("composer")?.focusInput?.();
  });
}

document.getElementById("home")?.addEventListener("click", () => goHome());
document.getElementById("view-back")?.addEventListener("click", closeView);

document.getElementById("open-settings")?.addEventListener(
  "click",
  (event) => openView("options/options.html", "Settings", event.currentTarget),
);

document.getElementById("open-directory")?.addEventListener(
  "click",
  (event) => openView("directory/directory.html", "Directory", event.currentTarget),
);
// CAP-FB-20260828-NOUN-DISCIPLINE-01: the view has ONE user-facing name —
// Artifacts. Every call site that opens artifacts/index.html passes the same
// title; there is no second name for the same destination.
const artifactQuickDrawer = document.getElementById("artifact-quick-drawer");
document.getElementById("open-artifacts")?.addEventListener(
  "click",
  () => {
    artifactQuickDrawer?.close?.({ returnFocus: false });
    openView("artifacts/index.html", "Artifacts");
  },
);
artifactQuickDrawer?.addEventListener("browse-artifacts", () => {
  openView("artifacts/index.html", "Artifacts");
});
artifactQuickDrawer?.addEventListener("artifact-open", async (event) => {
  const artifact = event.detail?.artifact;
  if (!artifact?.id) return;
  const opened = await openArtifactDialog(artifact.id, artifact.origin ?? "master", artifact.name);
  if (!opened) artifactQuickDrawer.focusTrigger?.();
});
artifactQuickDrawer?.addEventListener("artifact-reuse", async (event) => {
  const artifact = event.detail?.artifact;
  if (!artifact?.id) return;
  const reused = await attachArtifactToComposer(artifact, { closeOverlay: false });
  if (!reused) artifactQuickDrawer.focusTrigger?.();
});

document.getElementById("bg-configure")?.addEventListener(
  "click",
  (e) => { e.preventDefault(); openView("options/options.html#background-agents", "Background agents", e.currentTarget); },
);

document.getElementById("browse-artifacts")?.addEventListener(
  "click",
  (e) => { e.preventDefault(); openView("artifacts/index.html", "Artifacts", e.currentTarget); },
);

document.getElementById("discover-page")?.addEventListener(
  "click",
  (e) => { e.preventDefault(); discoverActivePage(); },
);

// Reuse an artifact from the gallery: the gallery (in the view frame) posts a
// request; we fetch the artifact + attach it to the hub composer as a pending
// attachment (the model can then read a text/html/json artifact's bytes).
function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(String(s ?? ""));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function artifactDataURL(type, content) {
  if (type === "image") return content ?? ""; // stored as a data URL
  const mime = type === "html" ? "text/html"
    : type === "json" ? "application/json"
    : "text/plain";
  return `data:${mime};base64,${utf8ToBase64(content ?? "")}`;
}

// One authoritative Reuse path serves both the full browser iframe and the
// quick drawer. It fetches the body only after the owner's action; the drawer
// itself remains metadata-only and bounded.
async function attachArtifactToComposer({ id, name, type, origin }, { closeOverlay = false } = {}) {
  const full = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
  const artifact = full?.ok ? full.asset : null;
  if (!artifact) { setStatus("Artifact not found", false); return false; }
  const artifactType = artifact.type ?? type ?? "data";
  const mime = artifactType === "html" ? "text/html"
    : artifactType === "json" ? "application/json"
    : artifactType === "image" ? "image/png"
    : "text/plain";
  composer.addAttachment({
    name: artifact.name ?? name ?? "artifact",
    type: mime,
    size: artifact.size ?? 0,
    kind: "artifact",
    dataURL: artifactDataURL(artifactType, artifact.content),
    content: artifact.content,
    artifactId: artifact.id ?? id,
    artifactOrigin: artifact.origin ?? origin ?? "master",
    artifactType: artifact.type ?? type,
  });
  if (closeOverlay) goHome({ focusAfter: composer });
  else composer.focus();
  setStatus(`Attached "${artifact.name ?? name}" to a new task`);
  return true;
}

window.addEventListener("message", async (e) => {
  const d = e.data;
  if (d?.type === "cap:go-home") {
    // CAP-FB-20260826-HEADER-HOME-01: the settings panel's brand asked to go
    // Home — replace the deep route (never masquerade as Back).
    if (!isPanelFrameSource(e.source)) return;
    goHome({ focusAfter: composer });
    return;
  }
  if (d?.type === "cap:edit-named-agent") {
    // Settings keeps persona + schedule editing reachable from its unified row
    // without duplicating the maintained agent dialog. Only the embedded,
    // extension-owned panel frame may request this navigation.
    if (!isPanelFrameSource(e.source) || typeof d.id !== "string" || !d.id) return;
    if (!viewOverlay?.hidden) closeView({ fromNavigation: true });
    await openAgentChat(d.id);
    editAgentBtn?.click();
    return;
  }
  if (d?.type === "use-skill") {
    // A skill was chosen on the Skills page → close the overlay + pre-fill the
    // composer with the /skill:<id> reference (the skill is INCLUDED in the
    // task, not run in isolation).
    if (!isPanelFrameSource(e.source)) return;
    const id = String(d.id ?? "").trim();
    goHome({ focusAfter: composer });
    composer.value = composer.value ? `${composer.value} /skill:${id}` : `/skill:${id}`;
    composer.focus();
    return;
  }
  if (!d || d.type !== "cap:attach-artifact") return;
  if (!isPanelFrameSource(e.source)) return; // only our own gallery
  const { id, name, type, origin } = d.artifact ?? {};
  if (!id) return;
  // The single Reuse path: attachArtifactToComposer performs exactly one
  // asset.get + the canonical kind:"artifact" attachment + the closeView. No
  // duplicate inline get/add/close/status locals.
  await attachArtifactToComposer({ id, name, type, origin }, { closeOverlay: true });
});

// The Settings iframe (Providers → Use) asks the hub to return with the composer
// focused — the fourth click of the four-click provider flow
// (CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01). Same-origin only. Declared
// AFTER the cap:attach-artifact listener so that handler stays the first
// window "message" listener (its canonical-attachment guard keys off that).
window.addEventListener("message", (ev) => {
  if (ev.origin !== location.origin) return;
  if (ev.data?.type !== "cap:return-to-hub-composer") return;
  goHome({ focusAfter: document.getElementById("composer") });
  renderProviderStatus();
});

setStatus("ready");

// Transparency surface: capture the page's own errors/CSP violations into the
// shared console + keep the shield/console badges live. Push-driven: the SW
// bumps `cap:diagnosticsRevision` in session storage on every change and the
// subscription refreshes on it (once now, then per change while visible) — no
// timer, so an idle hub never wakes the worker (CAP-FB-20260830-HUB-POLLING-01).
installPageDiagnostics();
startDiagnosticSubscription();

// ---- omnibox entry (keyword → a task) --------------------------------
// The SW opens the hub with `#omnibox=<mode>:<query>`; on load we run the task
// (or open the thread) and clear the hash so a reload doesn't re-run it.
async function handleOmniboxEntry() {
  const m = /^#omnibox=([^:]+):(.*)$/s.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search); // clear the hash
  const [, mode, raw] = m;
  const query = decodeURIComponent(raw);
  if (mode === "thread") {
    await openThread(query);
  } else if (query) {
    // A task (or a recipe expanded by the SW into a prompt).
    currentThreadId = null;
    threadConversation.clear?.();
    threadTitle.textContent = "New task";
    await runThreadTurn(query, []);
  }
}

async function bootNtpRoutes() {
  await handleOmniboxEntry().catch((e) => console.error("omnibox entry failed", e?.message ?? e));
  // At boot/startup: restore current hash route (#view=, #thread=, #agent=) on reload
  await applyCurrentHashRoute(false).catch((e) => console.error("boot route failed", e?.message ?? e));
}
bootNtpRoutes();

// ---- agent-script host (the on-demand fallback) ---------------------
// The SW announces `cap:script-run-announce` then addresses the source to the
// winning host; the offscreen document is the production host for scheduled
// runs, and THIS page is the on-demand fallback (so a script run from the hub
// works even where chrome.offscreen is unavailable). The claim protocol ensures
// only ONE host executes (no double side-effects).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
  handleScriptRunMessage(message, sendResponse, document, "ntp")
);

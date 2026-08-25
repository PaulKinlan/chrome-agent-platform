// ntp/ntp.js — the hub page wiring. The hub is a COMMAND CENTER:
//   header → composer (the hero) → Tasks (the distinct task threads) →
//   background agents (scheduled, toggle) → Site Agents (enrolled origins) →
//   recent artifacts. A task is a DISTINCT THREAD: starting one opens a
//   full-screen thread surface (the conversation + a composer to nudge/continue),
//   and the hub lists every prior thread (auto-named).

import { send } from "../lib/messages.js";
import { runConversationTurn, subscribeProgress, subscribeRunRegistry, cancelDurableRun, resumePermissionPausedRun, loadDurableRunLogs, appendBubble, pairToolJournal, projectThreadMessages, renderRunTranscript } from "../shared/conversation.js";
import { createRunSurfaceOwner } from "../shared/run-surface-owner.js";
import { summarizeToolResult } from "../lib/tool-summary.js";
import { safeJsonStringify } from "../shared/tool-tree.js";
import {
  renderHtmlFrame,
  isHtmlDocument,
  wireHtmlFrameContent,
  wireHtmlFramePreference,
  currentFramePreference,
  confirmActionDialog,
} from "../shared/components.js";
import { canonicalRef, findAgentByRef } from "../shared/agent-registry.js";
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
import {
  FIRST_RUN_TASK_PROMPT,
  firstRunExampleAgent,
  loadFirstRunGuideState,
  requestBrowserControlFromOwnerClick,
} from "../lib/first-run-onboarding.js";
import {
  createViewTransitionRunner,
  focusExplicitRouteTarget,
  VIEW_ROUTE,
} from "./view-transition.js";
import { applySidebarNubPolicy } from "./view-policy.js";
import { parseNtpHash, resolveEntryMeta, shouldDispatchForNavigationType } from "../lib/navigation-controller.js";
import { actionableRunsForSurface, latestRunForSurface } from "../lib/run-scope.js";
import {
  SITE_AGENT_COPY,
  enrollOutcomeState,
  formatWebmcpHubStatus,
  siteAgentSetupMessage,
} from "../shared/site-agent-copy.js";
// The visible find-tools action consumes the centralized authority at runtime
// (the ntp module runs at the end of the body — the element exists at eval, so
// no DOMContentLoaded dependency).
const discoverPage = document.getElementById("discover-page");
if (discoverPage) discoverPage.textContent = SITE_AGENT_COPY.findToolsAction;

import {
  installPageDiagnostics,
  refreshDiagnostics,
  startDiagnosticPolling,
} from "../shared/diagnostics-client.js";

const statusEl = document.getElementById("status");
const durableRunRegistry = document.getElementById("durable-run-registry");
let statusTimer;
let currentThreadId = null;
let currentAgentId = null;
let currentAgentKind = null;
let latestDurableRuns = [];

function syncConversationRunControls() {
  if (!durableRunRegistry) return;
  const runs = actionableRunsForSurface(latestDurableRuns, {
    threadId: currentThreadId,
    agentId: currentAgentId,
    agentKind: currentAgentKind,
  });
  durableRunRegistry.runs = runs;
  durableRunRegistry.hidden = runs.length === 0;
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

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

function shortOrigin(o) {
  return String(o).replace(/^https?:\/\//, "").replace(/\/.*/, "");
}

// ── first-run path ────────────────────────────────────────────────────────
// The guide is progress, not a permission authority. It remains visible until
// the owner creates the first artifact (or dismisses it), and every optional
// grant still happens on a native Settings click.
const firstRunGuide = document.getElementById("first-run-guide");
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

function firstRunDismissed() {
  try { return localStorage.getItem(FIRST_RUN_DISMISSED_KEY) === "1"; }
  catch { return false; }
}

function firstRunBrowserChoice() {
  try { return sessionStorage.getItem(FIRST_RUN_BROWSER_CHOICE_KEY) || localStorage.getItem(FIRST_RUN_BROWSER_CHOICE_KEY) || "unselected"; }
  catch { return "unselected"; }
}

function setFirstRunBrowserChoice(choice) {
  try {
    sessionStorage.setItem(FIRST_RUN_BROWSER_CHOICE_KEY, choice);
    localStorage.setItem(FIRST_RUN_BROWSER_CHOICE_KEY, choice);
  } catch {}
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
  firstRunGuide.hidden = !state.show;
  firstRunGuide.toggleAttribute("storage-ready", state.storageGranted);
  firstRunGuide.toggleAttribute("provider-ready", state.providerReady);
  firstRunGuide.toggleAttribute("browser-ready", state.browserControlGranted);
  firstRunGuide.setAttribute("browser-choice", state.browserControlChoice);
}

firstRunGuide?.addEventListener("open-settings", (event) => {
  returningFromFirstRunSettings = true;
  openView("options/options.html#providers", "Provider settings", event.detail?.sourceEvent?.currentTarget ?? firstRunGuide);
});
firstRunGuide?.addEventListener("seed-task", () => {
  composer.value = FIRST_RUN_TASK_PROMPT;
  composer.focus();
  setStatus("Starter task ready — review it, then choose Run task.");
});
firstRunGuide?.addEventListener("create-example-agent", async (event) => {
  const example = firstRunExampleAgent(event.detail?.id);
  if (!example) return;
  const res = await send("named-agent.create", {
    id: example.id, name: example.name, role: example.role,
  }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (res?.ok) {
    setStatus(`Created the "${example.name}" agent.`);
  } else {
    setStatus(`Couldn't create the example agent${res?.error ? `: ${res.error}` : ""}.`, false);
  }
});
firstRunGuide?.addEventListener("dismiss-guide", () => {
  try { localStorage.setItem(FIRST_RUN_DISMISSED_KEY, "1"); } catch { /* page-local preference unavailable */ }
  firstRunGuide.hidden = true;
  composer.focus();
});
firstRunGuide?.addEventListener("request-browser-control", async (event) => {
  const sourceEvent = event.detail?.sourceEvent;
  try {
    const outcome = await requestBrowserControlFromOwnerClick({
      event: sourceEvent,
      userActivation: navigator.userActivation,
      permissionsApi: chrome.permissions,
    });
    if (outcome.granted) {
      setFirstRunBrowserChoice("granted");
      await send("browser-control.set", { granted: true }).catch(() => {});
    } else {
      setFirstRunBrowserChoice("declined");
    }
  } catch {
    setFirstRunBrowserChoice("declined");
  }
  await renderFirstRunGuide();
});
firstRunGuide?.addEventListener("decline-browser-control", async () => {
  setFirstRunBrowserChoice("declined");
  await send("browser-control.set", { granted: false }).catch(() => {});
  await renderFirstRunGuide();
});

function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

const withViewTransition = createViewTransitionRunner({
  document,
  prefersReducedMotion,
});

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
  // open browser tabs that can be enrolled with one click.
  const enrolledOrigins = new Set((Array.isArray(res.agents) ? res.agents : []).map((a) => a.origin));
  const discoverable = await send("agent.discoverable-tabs").catch(() => ({ ok: false }));
  const unenrolledTabs = (discoverable?.ok && Array.isArray(discoverable.tabs))
    ? discoverable.tabs.filter((t) => !enrolledOrigins.has(t.origin))
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
    banner.style.marginTop = agents.length ? "8px" : "0";
    banner.style.padding = "8px 10px";
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
  if (listing?.needTabs) {
    // Tab URLs/titles are hidden without the `tabs` permission — request it
    // (the click IS the user gesture), then re-list.
    const granted = await chrome.permissions
      .request({ permissions: ["tabs"] })
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

async function discoverTab(tab) {
  // Request the exact origin's host permission + `scripting` together (one
  // prompt) — the same owner-gesture the Settings Enroll button uses. The
  // picked tab's id rides along so the SW can verify tab↔origin identity and
  // report whether THAT tab was fully injected.
  let granted = false;
  try {
    granted = await chrome.permissions.request({
      permissions: ["scripting"],
      origins: [`${tab.origin}/*`],
    });
  } catch (e) {
    setStatus(siteAgentSetupMessage("permission-error", tab.origin), false);
    return;
  }
  if (!granted) {
    setStatus(siteAgentSetupMessage("permission-denied", tab.origin), false);
    return;
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
  } else {
    setStatus(siteAgentSetupMessage("failed", tab.origin), false);
  }
}

// ── named agents (the persistent named agents) ──────────────────────────────
async function renderNamedAgents() {
  const el = document.getElementById("named-agents");
  const res = await send("named-agent.list").catch(() => ({ agents: [] }));
  const agents = Array.isArray(res.agents) ? res.agents : [];
  if (el) {
    el.replaceChildren();
    if (!agents.length) {
      el.innerHTML = `<div class="empty">No named agents yet. Create one in a task ("create an agent…") or with /agent:create.</div>`;
    } else {
      for (const a of agents.slice(0, 6)) {
        const row = document.createElement("capability-row");
        row.setAttribute("name", a.name || a.id);
        row.setAttribute("description", a.role || "a named agent");
        row.setAttribute(
          "icon",
          `<img src="${escapeHtml(a.avatar || initialAvatar(a.name || a.id))}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;display:block;" />`,
        );
        // Item 55: the WHOLE row opens the agent's view (history + run log) +
        // lets you talk to it — a chevron affordance, not a misleading "Run".
        row.setAttribute("action", "open");
        row.addEventListener("open", () => openAgentChat(a.id || a.name));
        el.append(row);
      }
      if (agents.length > 6) {
        const more = document.createElement("div");
        more.className = "empty";
        more.textContent = `+ ${agents.length - 6} more`;
        el.append(more);
      }
    }
  }
  renderSidebarAgents(agents);
  refreshAgentCount();
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
    const item = document.createElement("button");
    item.type = "button";
    item.className = "agent-item";
    item.title = (a.name || a.id) + (a.role ? " — " + a.role : "");
    const avatar = document.createElement("img");
    avatar.className = "a-avatar";
    avatar.alt = "";
    avatar.src = a.avatar || initialAvatar(a.name || a.id);
    avatar.addEventListener("error", () => { avatar.src = initialAvatar(a.name || a.id); });
    const label = document.createElement("span");
    label.className = "a-name";
    label.append(document.createTextNode(a.name || a.id));
    if (a.role) {
      const role = document.createElement("span");
      role.className = "a-role";
      // The full role is stored intact (no limit) and shown on hover via
      // item.title; the visible list line stays short so the list is scannable
      // (mirrors the side panel's truncated role preview).
      const full = String(a.role);
      role.textContent = full.length > 88 ? full.slice(0, 88).trimEnd() + "…" : full;
      label.append(role);
    }
    item.append(avatar, label);
    item.addEventListener("click", () => openAgentChat(a.id || a.name));
    list.append(item);
  }
}

// ── background agents (scheduled recipes, enabled/disabled) ──────────────
// Item 25: the hub shows only the ACTIVE (enabled) background agents — the
// full catalog (presets + disabled) lives in Settings behind the "Configure"
// link + the base-select picker.
async function renderBackgroundAgents() {
  const el = document.getElementById("background-agents");
  if (!el) return;
  const res = await send("background-agent.list").catch(() => ({ agents: [] }));
  const agents = Array.isArray(res.agents) ? res.agents : [];
  const active = agents.filter((a) => a.enabled);
  el.replaceChildren();
  if (!active.length) {
    el.innerHTML = `<div class="empty">No background agents running — <a href="#" class="hint-link" data-open-bg>enable one in Settings</a>.</div>`;
    el.querySelector("[data-open-bg]")?.addEventListener("click", (e) => {
      e.preventDefault();
      openView("options/options.html#background-agents", "Background agents", e.currentTarget);
    });
  } else {
    for (const a of active) {
      const row = document.createElement("capability-row");
      row.setAttribute("name", a.name || a.id);
      row.setAttribute("description", a.description || "");
      row.setAttribute("icon", "");
      // item 61: a background agent is an INDEPENDENT agent — a chevron opens
      // its view (history + chat) AND a switch enables/disables it.
      row.setAttribute("action", "open-toggle");
      if (a.enabled) row.setAttribute("enabled", "");
      if (a.schedule?.periodInMinutes) {
        row.setAttribute("last-run", `every ${a.schedule.periodInMinutes} min`);
      }
      row.addEventListener("open", () => openBackgroundAgentChat(a.id, a.name));
      row.addEventListener("toggle", async (ev) => {
        const enabled = ev.detail?.enabled;
        // ENABLE time (a real user gesture): request the OPTIONAL notifications
        // permission so the scheduled completions can surface as notifications.
        // Never request from the SW (no gesture — Chrome rejects it). Best-effort:
        // a denial just means the notification is skipped at run time.
        if (enabled) {
          try {
            await chrome.permissions?.request?.({ permissions: ["notifications"] });
          } catch { /* not grantable here — the run-time path skips the notification */ }
        }
        const r = await send("background-agent.set", { id: a.id, enabled })
          .catch(() => ({ ok: false, error: "request failed" }));
        if (r?.ok) {
          setStatus(`${a.name} ${enabled ? "enabled" : "disabled"}`);
        } else {
          setStatus(`couldn't ${enabled ? "enable" : "disable"} ${a.name}: ${r?.error ?? "unknown"}`, false);
        }
        await renderBackgroundAgents();
      });
      el.append(row);
    }
  }
  refreshAgentCount();
}

async function refreshAgentCount() {
  const el = document.getElementById("agent-count");
  if (!el) return;
  const [dir, bg, named] = await Promise.all([
    send("agent.directory").catch(() => ({ agents: [] })),
    send("background-agent.list").catch(() => ({ agents: [] })),
    send("named-agent.list").catch(() => ({ agents: [] })),
  ]);
  const siteN = Array.isArray(dir.agents) ? dir.agents.length : 0;
  const bgN = (Array.isArray(bg.agents) ? bg.agents : []).filter((a) => a.enabled).length;
  const namedN = Array.isArray(named.agents) ? named.agents.length : 0;
  el.textContent = `${namedN} named · ${bgN} background · ${siteN} site`;
}

// ── recent artifacts ──────────────────────────────────────────────────────
async function renderArtifacts() {
  const el = document.getElementById("artifacts");
  if (!el) return;
  const res = await send("asset.list", { origin: "master" }).catch(() => ({ assets: [] }));
  const assets = Array.isArray(res.assets) ? res.assets : [];
  el.replaceChildren();
  if (!assets.length) {
    el.innerHTML = `<div class="empty">No artifacts yet. Ask an agent to make something.</div>`;
    return;
  }
  for (const a of assets.slice(-6).reverse()) {
    const row = document.createElement("capability-row");
    row.setAttribute("name", a.name ?? "Untitled");
    row.setAttribute("description", (a.type ?? "unknown") + " · " + (a.size ?? 0) + " B");
    row.setAttribute("icon", "");
    // An artifact is OPENED (viewed), not "run" — the open action (the title is
    // a link + the Open button) opens the expanded view.
    row.setAttribute("action", "open");
    row.addEventListener("open", () => openArtifactDialog(a.id ?? a.name, "master", a.name));
    el.append(row);
  }
}

// ── the artifact expand dialog (item 53) ────────────────────────────────
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
  body.style.minWidth = "min(88vw, 1100px)";
  body.style.minHeight = "min(75vh, 720px)";
  body.style.display = "flex";
  body.style.flexDirection = "column";
  const type = asset.type ?? "data";
  const content = asset.content ?? "";
  if (type === "html" || (type === "text" && isHtmlDocument(content))) {
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.style.border = "1px solid var(--border)";
    frame.style.borderRadius = "10px";
    frame.style.overflow = "hidden";
    frame.style.background = "#fff";
    frame.style.flex = "1";
    frame.style.display = "flex";
    frame.style.flexDirection = "column";
    frame.style.minHeight = "min(70vh, 680px)";
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
        iframe.style.minHeight = "min(70vh, 680px)";
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
    img.style.display = "block";
    body.append(img);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content;
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "13px";
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
// Shows what the agents DID across the WHOLE system (master + named + background
// + Site Agents), most-recent-first, so a background agent's work is visible
// even without a live UI. Rendered by the reusable <activity-explorer> Web
// Component (searchable + filterable by agent).
async function renderRunLog() {
  const el = document.getElementById("run-log");
  if (!el) return;
  const explorer = document.createElement("activity-explorer");
  explorer.setAttribute("limit", "100");
  el.replaceChildren(explorer);
}

// A small usage summary on the hub (the recent calls/tokens/cost) — reads the
// SW's single-authority usage aggregate, so you see at a glance how much the
// agents have been doing + what it cost.
async function renderHubUsage() {
  const el = document.getElementById("hub-usage");
  if (!el) return;
  const u = await send("usage.get").catch(() => null);
  if (!u?.totals) {
    el.textContent = "what the agents did";
    return;
  }
  const t = u.totals;
  const tokens = (t.inputTokens + t.outputTokens).toLocaleString();
  el.textContent = `${t.calls} calls · ${tokens} tokens · $${t.estimatedCost.toFixed(4)}`;
}

// ── Tasks (the distinct task threads) ────────────────────────────────────
function timeAgo(ts) {
  const d = Date.now() - (ts ?? 0);
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const taskSidebarLifecycle = createTaskSidebarLifecycle({
  // A list message can wake a restarting MV3 worker before its routes are
  // ready. Retry that failed authoritative read once, using the existing 400ms
  // boot grace period; every render remains event/navigation-driven.
  loadThreads: () => loadThreadsWithOneRestartRetry(
    () => send("thread.list"),
    () => new Promise((resolve) => setTimeout(resolve, 400)),
  ),
  commitThreads: renderTaskRows,
});

function renderTasks(activeId = currentThreadId) {
  return taskSidebarLifecycle.render(activeId);
}

function renderTaskRows(threads, activeId = null) {
  const el = document.getElementById("thread-sidebar");
  if (!el) return;
  el.replaceChildren();
  if (!threads.length) {
    const empty = document.createElement("div");
    empty.className = "thread-empty";
    empty.textContent = "No tasks yet — start one above.";
    el.append(empty);
    return;
  }
  for (const t of threads.slice(0, 40)) {
    const item = document.createElement("div");
    item.className = "thread-item";
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    // A hover tooltip for the collapsed icon-rail (and the full name on hover).
    item.title = (t.name || "Task") + (t.preview ? " — " + t.preview : "");
    if (activeId && t.id === activeId) item.setAttribute("aria-current", "true");
    const dotState =
      t.status === "running" ? "running" : t.status === "error" ? "error" : "";
    // A standalone status dot that stays visible when the sidebar collapses
    // (the .t-name dot is hidden with the label).
    const railDot = document.createElement("span");
    railDot.className = "t-dot" + (dotState ? " " + dotState : "");
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
    const meta = document.createElement("span");
    meta.className = "t-meta";
    meta.textContent = timeAgo(t.updatedAt);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "t-delete";
    del.setAttribute("aria-label", `Delete task ${t.name || "Task"}`);
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    item.append(railDot, name, preview, meta, del);
    item.addEventListener("click", () => openThread(t.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openThread(t.id); }
    });
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const r = await send("thread.delete", { id: t.id })
        .catch(() => ({ ok: false }));
      if (!r?.ok) {
        setStatus(`couldn't delete ${t.name || "task"}`, false);
        return;
      }
      if (currentThreadId === t.id) hideThreadView();
      await renderTasks();
    });
    el.append(item);
  }
}

// ── the full-screen thread surface ────────────────────────────────────────
const threadView = document.getElementById("thread-view");
const threadTitle = document.getElementById("thread-title");
const threadConversation = document.getElementById("thread-conversation");
const threadComposer = document.getElementById("thread-composer");
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

// The inner (no-transition) cleanups, so openView/showThreadView can hide the
// OTHER overlay without nesting a second document.startViewTransition (a nested
// transition throws "transition was aborted because of invalid state snapshot").
// When any in-context view (thread / settings / directory / skills / etc.) is
// open, the hub is hidden + its scroll is frozen so the BACKGROUND page cannot
// scroll behind the overlay (the scrollbar belongs to the ACTIVE view only).
function syncViewOpen() {
  const fullViewOpen = !viewOverlay.hidden;
  const anyOpen = !threadView.hidden || fullViewOpen;
  document.body.classList.toggle("view-open", anyOpen);
  document.body.classList.toggle("full-view-open", fullViewOpen);

  // The full Directory/Settings/Skills/Assets view covers the whole hub. Keep
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
  syncComposerScope();
  syncConversationRunControls();
  stopRunTranscript();
  threadConversation.clear?.();
  renderRunStatus({ state: "idle" });
  syncViewOpen();
}
function hideViewInner() {
  viewOverlay.hidden = true;
  viewFrame.src = "about:blank";
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
  const sourceRoute = activeViewRoute;
  withViewTransition(() => {
    // Only ONE overlay at a time (item 48): the thread view replaces the
    // settings/directory/recipes view.
    if (!viewOverlay.hidden) hideViewInner();
    threadView.hidden = false;
    activeViewRoute = VIEW_ROUTE.TASK;
    // The new-root snapshot must already exclude the hub. Keeping this state
    // change inside the update callback makes snapshot capture deterministic.
    syncViewOpen();
  }, {
    sourceRoute,
    targetRoute: VIEW_ROUTE.TASK,
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
  const sourceRoute = activeViewRoute;
  withViewTransition(() => {
    hideThreadViewInner();
    activeViewRoute = VIEW_ROUTE.HUB;
  }, {
    sourceRoute,
    targetRoute: VIEW_ROUTE.HUB,
    focusAfter,
  });
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

async function openThread(id) {
  const owner = runSurfaceOwner.claim();
  currentThreadId = id;
  currentAgentId = null; // a thread is NOT an agent chat
  currentAgentKind = null;
  syncConversationRunControls();

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#thread=${encodeURIComponent(id)}`;
    if (location.hash !== hash) {
      window.history.pushState({ route: "thread", id }, "", hash);
    }
  }
  // Hide the previous run's banner at the ownership hand-off, not after the
  // asynchronous thread read. The old run continues and journals in the SW.
  renderRunStatus({ state: "idle" });
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
    await new Promise((r) => setTimeout(r, 400)); // let a restarting SW boot
    res = await send("thread.get", { id }).catch(() => ({ ok: false }));
  }
  // Another open/run may have claimed the surface during either await. Fence
  // every following title/message/status write as one owner-bound commit.
  if (!runSurfaceOwner.owns(owner) || currentThreadId !== id || currentAgentId !== null) return;
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
}

// ── the BACKGROUND-agent chat surface (item 61): a background agent is an
//    INDEPENDENT agent — click it to see its OWN run history + talk to it (a
//    task runs in its own OPFS sandbox), exactly like a named agent.
async function openBackgroundAgentChat(id, name) {
  const owner = runSurfaceOwner.claim();
  currentAgentId = id;
  currentAgentKind = "background";
  currentThreadId = null;
  syncConversationRunControls();

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#agent=background:${encodeURIComponent(id)}`;
    if (location.hash !== hash) {
      window.history.pushState({ route: "agent", kind: "background", id, name }, "", hash);
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
  const hRes = await send("background-agent.history", { id }).catch(() => ({ entries: [] }));
  if (!runSurfaceOwner.owns(owner) || currentAgentId !== id || currentAgentKind !== "background") return;
  threadTitle.textContent = name || id || "Background agent";
  renderAgentHistory(threadConversation, Array.isArray(hRes.entries) ? hRes.entries : []);
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

/** Open the thread surface scoped to ONE agent of ANY kind (the unified agent
 * access, CAP-FB-20260818-AGENT-ACCESS-01): the agent's own history + a
 * composer whose sends run DIRECTLY in that agent (its own memory/skills). */
async function openAgentSurface({ kind, id, name }) {
  const owner = runSurfaceOwner.claim();
  currentAgentId = id;
  currentAgentKind = kind;
  currentThreadId = null;
  syncConversationRunControls();

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#agent=${encodeURIComponent(kind)}:${encodeURIComponent(id)}`;
    if (location.hash !== hash) {
      window.history.pushState({ route: "agent", kind, id, name }, "", hash);
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
  const entries = await loadAgentHistoryEntries(kind, id);
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
      const raw = t.result == null ? "" : typeof t.result === "string" ? t.result : safeJsonStringify(t.result);
      const summary = t.result == null ? "" : summarizeToolResult(t.tool, t.result);
      container.appendTool({
        name: t.tool ?? "tool",
        status: t.status ?? "done",
        args: t.args ?? null,
        result: summary || null,
        detail: raw && raw !== summary ? raw : null,
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
    b.style.color = "#fff";
    b.style.borderColor = "var(--accent,#0e6e63)";
  } else {
    b.style.background = "transparent";
    b.style.color = "var(--text,#1d1b18)";
  }
  return b;
}
// ── the RICH agent-config dialog (item: avatar + name + role + skills + mic +
//    core assets + refine) — shared by the Edit (named) + Create flows. Reuses
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
    canRegenerateAvatar: true,
    canDelete: true,
    savedLabel: "Save",
    onSave: async (v) => {
      const r = await send("named-agent.update", {
        id: currentAgentId, name: v.name, role: v.role, avatar: v.avatar, skills: v.skills, coreAssets: v.coreAssets,
      }).catch(() => ({ ok: false }));
      return r?.ok !== false ? { ok: true } : { ok: false, error: r?.error ?? "unknown" };
    },
    onSaved: async () => { renderNamedAgents(); await openAgentChat(currentAgentId); },
  });
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
    savedLabel: "Create agent",
    onSave: async (v) => {
      const r = await send("named-agent.create", {
        name: v.name, role: v.role, avatar: v.avatar, skills: v.skills, coreAssets: v.coreAssets,
      }).catch(() => ({ ok: false }));
      return r?.ok ? { ok: true, id: r.agent?.id ?? v.name } : { ok: false, error: r?.error ?? "unknown" };
    },
    onSaved: async (result) => { renderNamedAgents(); await openAgentChat(result?.id); },
  });
}

// Build the rich agent dialog. Returns via the onSave/onSaved callbacks (the
// dialog owns its own lifecycle).
// Build the rich agent dialog (CAP-FB-20260823-CREATE-AGENT-DIALOG-01).
// Features: non-clipped focus outline, sticky outside-scroll footer with
// Create/Cancel, collapsible skills section, and overscroll-behavior: contain.
async function buildAgentConfigDialog(opts) {
  const skillsRes = await send("skill.list").catch(() => ({ skills: [] }));
  const available = Array.isArray(skillsRes.skills) ? skillsRes.skills : [];
  const agentSkillIds = new Set((opts.initialSkills ?? []).map((s) => (typeof s === "string" ? s : s?.id ?? s?.name)));

  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", opts.title);

  // Outer container: structural flex column with overscroll containment
  const container = document.createElement("div");
  container.className = "agent-config-container";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.minWidth = "min(88vw, 540px)";
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
  scrollBody.append(avatarRow);

  const nameField = configField("Name", "input", opts.name ?? "");

  // Role (the system prompt / what the agent does) + mic (dictate) + refine.
  const roleField = configField("Role / what it does", "textarea", opts.role ?? "", 4);
  const roleTools = document.createElement("div");
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
  scrollBody.append(nameField.wrap, roleField.wrap, roleTools);

  // Collapsible skills section
  const skillsDetails = document.createElement("details");
  skillsDetails.className = "skills-collapse";
  skillsDetails.style.border = "1px solid var(--border,#e3e0d9)";
  skillsDetails.style.borderRadius = "8px";
  skillsDetails.style.padding = "0";
  skillsDetails.style.margin = "0";
  skillsDetails.style.background = "var(--panel,#ffffff)";
  skillsDetails.style.overflow = "hidden";

  const selectedInitialCount = [...agentSkillIds].filter((id) => available.some((s) => (s?.id ?? s?.name ?? String(s)) === id)).length;
  const skillsSummary = document.createElement("summary");
  skillsSummary.style.padding = "10px 12px";
  skillsSummary.style.fontWeight = "600";
  skillsSummary.style.fontSize = "13px";
  skillsSummary.style.cursor = "pointer";
  skillsSummary.style.display = "flex";
  skillsSummary.style.alignItems = "center";
  skillsSummary.style.justifyContent = "space-between";
  skillsSummary.style.userSelect = "none";
  skillsSummary.innerHTML = `<span>Skills</span><span class="skill-count" style="font-size:12px;color:var(--muted,#635e56);font-weight:normal;">${selectedInitialCount > 0 ? `${selectedInitialCount} selected` : `${available.length} available`}</span>`;
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

  const skillChecks = new Map();
  if (!available.length) {
    const none = document.createElement("p");
    none.textContent = "No skills available.";
    none.style.fontSize = "12.5px";
    none.style.color = "var(--muted,#635e56)";
    none.style.margin = "4px 0 0";
    skillsList.append(none);
  } else {
    for (const s of available) {
      const id = s?.id ?? s?.name ?? String(s);
      const row = document.createElement("label");
      row.style.display = "flex";
      row.style.alignItems = "baseline";
      row.style.gap = "8px";
      row.style.fontSize = "13px";
      row.style.padding = "2px 0";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = agentSkillIds.has(id);
      cb.addEventListener("change", () => {
        const count = [...skillChecks.values()].filter((c) => c.checked).length;
        const countEl = skillsSummary.querySelector(".skill-count");
        if (countEl) countEl.textContent = count > 0 ? `${count} selected` : `${available.length} available`;
      });
      const text = document.createElement("span");
      text.textContent = `${s.name ?? id} — ${s.description ?? ""}`.replace(/\s+—\s*$/, "");
      row.append(cb, text);
      skillChecks.set(id, cb);
      skillsList.append(row);
    }
  }
  skillsDetails.append(skillsList);
  scrollBody.append(skillsDetails);

  // Core assets: files whose content becomes part of the agent's context.
  const coreAssets = [];
  const assetsBox = document.createElement("fieldset");
  assetsBox.style.border = "1px solid var(--border,#e3e0d9)";
  assetsBox.style.borderRadius = "8px";
  assetsBox.style.padding = "10px";
  assetsBox.style.margin = "0";
  const assetsLegend = document.createElement("legend");
  assetsLegend.textContent = "Core assets";
  assetsLegend.style.fontWeight = "600";
  assetsLegend.style.fontSize = "13px";
  assetsBox.append(assetsLegend);
  const assetsHint = document.createElement("p");
  assetsHint.textContent = "Attach a text file or image as a core asset — its content becomes part of the agent's instructions.";
  assetsHint.style.fontSize = "12px";
  assetsHint.style.color = "var(--muted,#635e56)";
  assetsHint.style.margin = "0 0 6px";
  assetsBox.append(assetsHint);
  const assetsList = document.createElement("div");
  assetsList.style.display = "flex";
  assetsList.style.flexDirection = "column";
  assetsList.style.gap = "6px";
  const attach = document.createElement("attach-button");
  attach.setAttribute("label", "Add a core asset");
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
    coreAssets.push({ name: d.name ?? file?.name ?? "asset", type: d.type ?? file?.type ?? "text/plain", content });
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
  scrollBody.append(assetsBox);

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
    const skills = [];
    for (const [id, cb] of skillChecks) {
      if (cb.checked) {
        const s = available.find((x) => (x?.id ?? x?.name ?? String(x)) === id);
        skills.push(s ? { id: s.id ?? s.name, name: s.name ?? s.id, description: s.description ?? "" } : { id, name: id });
      }
    }
    saveBtn.disabled = true;
    const r = await opts.onSave({ name, role, avatar: avatarValue, skills, coreAssets });
    saveBtn.disabled = false;
    if (r?.ok) {
      dialog.close();
      setStatus(`Agent “${name}” saved.`);
      await opts.onSaved?.(r);
    } else {
      setStatus(`Save failed: ${r?.error ?? "unknown"}`, false);
    }
  });

  dialog.show();
  nameField.el.focus();
}

// ── the ONE shared conversation run-status surface ───────────────────────
const runStatusEl = document.getElementById("run-status");
function renderRunStatus(s) {
  if (!runStatusEl) return;
  const state = typeof s?.state === "string" ? s.state : "";
  if (!state || state === "idle") {
    runStatusEl.hidden = true;
    for (const name of ["state", "activity", "message", "error-reason", "action-label"]) {
      runStatusEl.removeAttribute(name);
    }
    return;
  }
  runStatusEl.hidden = false;
  runStatusEl.setAttribute("state", state);
  const attrs = {
    activity: s?.activity,
    message: s?.message,
    "error-reason": s?.errorReason,
  };
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "string" && value.trim()) runStatusEl.setAttribute(name, value);
    else runStatusEl.removeAttribute(name);
  }
  // A provider/config failure OR a permission wait gets the inline actionable
  // recovery path ("Fix in Settings"), not just the message.
  const recoverable = /host-permission|provider-auth|model-config|network/i.test(s?.errorCategory ?? "");
  if ((state === "failed" || state === "error" || state === "waiting-for-permission") && recoverable) {
    runStatusEl.setAttribute("action-label", "Fix in Settings");
  } else {
    runStatusEl.removeAttribute("action-label");
  }
}
runStatusEl?.addEventListener("action", () => {
  // The run-status action is an NTP surface: route IN-CONTEXT like every other
  // Settings entry. chrome.runtime.openOptionsPage() creates no new target from
  // the NTP (it IS the new-tab page) and would strand the user outside the
  // thread view; openView shows the options surface in place and focuses it.
  openView("options/options.html", "Settings");
});

/** Which run owner last wrote the global #status (so a superseded run's
 * orphaned "running…" is reset exactly once, never clobbering a newer run). */
let statusOwner = 0;

/** Run a turn in the thread surface (a new task, or a nudge). `mention` is an
 * @-mention delegation directive ({kind,id,name}): the task stays the hub's
 * thread and the run delegates to the referenced agent, whose result lands
 * back in this thread (CAP-FB-20260824-TASK-AGENT-BOUNDARY-01). */
async function runThreadTurn(text, attachments = [], mention = null) {
  const owner = runSurfaceOwner.claim();
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
    // A first task may create an artifact. Refresh the shipped Recent artifacts
    // surface and onboarding completion state from their real authorities.
    await Promise.all([renderArtifacts(), renderFirstRunGuide()]);
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
      `• Core assets: ${assetsCount}\n\n` +
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
    out = await send("task.cancel", { name: id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  }

  if (out?.ok !== false) {
    setStatus(`Deleted ${agentName}.`, true);
    if (typeof window !== "undefined" && window.history?.pushState) {
      window.history.pushState(null, "", "#");
    }
    hideThreadView({ fromNavigation: true, focusAfter: composer });
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
renderWebmcpHubStatus();
renderNamedAgents();
renderBackgroundAgents();
renderArtifacts();
renderFirstRunGuide();
renderTasks();
renderRunLog();
renderHubUsage();
renderProviderStatus();

// The provider-status warning: the user must know BEFORE running a task that
// the provider is unreachable / misconfigured (not be surprised by a failure
// after the run). A small warning chip in the header links to Settings.
async function renderProviderStatus() {
  const slot = document.getElementById("provider-status");
  if (!slot) return;
  const st = await send("provider.status").catch(() => ({ ok: true }));
  if (st?.ok === false) {
    slot.hidden = false;
    slot.textContent = "Provider issue — " + (st.reason || "check Settings");
  } else {
    slot.hidden = true;
    slot.textContent = "";
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
  if (ev?.type === "agent-registry-changed") {
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
    hideThreadView();
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
function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  side.classList.toggle("collapsed", collapsed);
  sideToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sideToggle.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sideToggle.setAttribute("aria-expanded", String(!collapsed));
  renderDurability();
  persistSidebar(collapsed); // serialized + ordered
}
sideToggle?.addEventListener("click", () => {
  withViewTransition(() => setSidebarCollapsed(!sidebarCollapsed));
});
// Restore the persisted rail state on load (session or durable).
async function restoreSidebar() {
  try {
    const s = await send("kv.get", { keys: SIDEBAR_KEY });
    if (s?.[SIDEBAR_KEY] === true) setSidebarCollapsed(true);
  } catch {
    // worker unreachable — default expanded.
  }
}
restoreSidebar();

// The "+" new-task button returns to the hub + focuses the composer. When the
// user is inside a task thread, it also closes the thread view so the composer
// (on the hub) can receive focus (item 26).
document.getElementById("new-task")?.addEventListener("click", () => {
  if (!threadView.hidden) hideThreadView({ focusAfter: composer });
  else composer.focus();
});

// The "+" create-agent button in the sidebar Agents section (item: a quick
// create path — opens the create dialog; it returns to the hub first so the
// dialog is not stacked behind the thread overlay).
document.getElementById("new-agent")?.addEventListener("click", () => {
  if (!threadView.hidden) hideThreadView({ focusAfter: null });
  openQuickCreateAgent();
});

// ── View Transitions (item 8): smooth in-page state changes, reduced-motion aware.
// Named elements let the thread body + composer morph between the hub and the
// full-screen thread. No-op when the API is absent or reduced-motion is on.
//
// The runner guards against overlapping snapshots, cleans route-scoped policy
// after both success and abort, and moves focus only after the active transition
// finishes. Rapid switches still apply their state immediately rather than
// aborting the transition already in flight.

// ── in-context navigation (no new tabs) ─────────────────────────────────
const viewOverlay = document.getElementById("view");
const viewFrame = document.getElementById("view-frame");
const viewTitle = document.getElementById("view-title");
const viewFocus = createViewFocusController();

function embeddedViewRoute(path) {
  const routePath = String(path ?? "").split(/[?#]/, 1)[0];
  if (routePath === "options/options.html") return VIEW_ROUTE.SETTINGS;
  if (routePath === "directory/directory.html") return VIEW_ROUTE.DIRECTORY;
  if (routePath === "recipes/index.html") return VIEW_ROUTE.SKILLS;
  return VIEW_ROUTE.ARTIFACTS;
}

function openView(path, title, trigger) {
  const sourceRoute = activeViewRoute;
  const targetRoute = embeddedViewRoute(path);
  // Start the embedded document load before snapshot capture so the named
  // destination overlay is populated at the transition midpoint.
  viewFrame.src = chrome.runtime.getURL(path);
  viewFrame.title = title;
  viewTitle.textContent = title;

  if (typeof window !== "undefined" && window.history?.pushState) {
    const hash = `#view=${encodeURIComponent(path)}`;
    if (location.hash !== hash) {
      try {
        window.history.pushState({ route: "view", path, title }, title, hash);
      } catch {
        // Ignored in non-browser testing contexts
      }
    }
  }

  withViewTransition(() =>
    viewFocus.open(trigger, () => {
      // Only ONE overlay at a time (item 48): the settings/directory/recipes
      // view replaces the task thread. Synchronise covered-view state inside the
      // transition callback: startViewTransition applies this callback later.
      if (!threadView.hidden) hideThreadViewInner();
      viewOverlay.hidden = false;
      activeViewRoute = targetRoute;
      syncViewOpen();
    }, null), {
    sourceRoute,
    targetRoute,
    focusAfter: viewFrame,
  });
}
function closeView({ fromNavigation = false } = {}) {
  if (!fromNavigation && typeof window !== "undefined" && window.history?.back && location.hash && location.hash !== "#") {
    window.history.back();
    return;
  }

  const sourceRoute = activeViewRoute;
  withViewTransition(() => {
    hideViewInner();
    activeViewRoute = VIEW_ROUTE.HUB;
  }, {
    sourceRoute,
    targetRoute: VIEW_ROUTE.HUB,
    // Keep Directory's initiating-trigger restoration, but defer it until the
    // View Transition top layer has settled instead of focusing underneath it.
    focusAfter: { focus: () => viewFocus.close(() => {}) },
  });
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
      }
    } else if (parsed.route === "view") {
      const expectedSrc = chrome.runtime?.getURL ? chrome.runtime.getURL(parsed.path) : parsed.path;
      const title = meta.title ?? "View";
      if (viewOverlay?.hidden || viewFrame.src !== expectedSrc) {
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

document.getElementById("view-back")?.addEventListener("click", closeView);

document.getElementById("open-settings")?.addEventListener(
  "click",
  (event) => openView("options/options.html", "Settings", event.currentTarget),
);
document.getElementById("open-directory")?.addEventListener(
  "click",
  (event) => openView("directory/directory.html", "Directory", event.currentTarget),
);
document.getElementById("open-recipes")?.addEventListener(
  "click",
  (event) => openView("recipes/index.html", "Skills", event.currentTarget),
);
const assetQuickDrawer = document.getElementById("asset-quick-drawer");
document.getElementById("open-assets")?.addEventListener(
  "click",
  () => {
    assetQuickDrawer?.close?.({ returnFocus: false });
    openView("artifacts/index.html", "Assets");
  },
);
assetQuickDrawer?.addEventListener("browse-assets", () => {
  openView("artifacts/index.html", "Assets");
});
assetQuickDrawer?.addEventListener("asset-open", async (event) => {
  const asset = event.detail?.asset;
  if (!asset?.id) return;
  const opened = await openArtifactDialog(asset.id, asset.origin ?? "master", asset.name);
  if (!opened) assetQuickDrawer.focusTrigger?.();
});
assetQuickDrawer?.addEventListener("asset-reuse", async (event) => {
  const asset = event.detail?.asset;
  if (!asset?.id) return;
  const reused = await attachAssetToComposer(asset, { closeOverlay: false });
  if (!reused) assetQuickDrawer.focusTrigger?.();
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
function assetDataURL(type, content) {
  if (type === "image") return content ?? ""; // stored as a data URL
  const mime = type === "html" ? "text/html"
    : type === "json" ? "application/json"
    : "text/plain";
  return `data:${mime};base64,${utf8ToBase64(content ?? "")}`;
}

// One authoritative Reuse path serves both the full browser iframe and the
// quick drawer. It fetches the body only after the owner's action; the drawer
// itself remains metadata-only and bounded.
async function attachAssetToComposer({ id, name, type, origin }, { closeOverlay = false } = {}) {
  const full = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
  const asset = full?.ok ? full.asset : null;
  if (!asset) { setStatus("Artifact not found", false); return false; }
  const assetType = asset.type ?? type ?? "data";
  const mime = assetType === "html" ? "text/html"
    : assetType === "json" ? "application/json"
    : assetType === "image" ? "image/png"
    : "text/plain";
  composer.addAttachment({
    name: asset.name ?? name ?? "artifact",
    type: mime,
    size: asset.size ?? 0,
    kind: "artifact",
    dataURL: assetDataURL(assetType, asset.content),
    content: asset.content,
    artifactId: asset.id ?? id,
    artifactOrigin: asset.origin ?? origin ?? "master",
    artifactType: asset.type ?? type,
  });
  if (closeOverlay) closeView();
  composer.focus();
  setStatus(`Attached "${asset.name ?? name}" to a new task`);
  return true;
}

window.addEventListener("message", async (e) => {
  const d = e.data;
  if (d?.type === "use-skill") {
    // A skill was chosen on the Skills page → close the overlay + pre-fill the
    // composer with the /skill:<id> reference (the skill is INCLUDED in the
    // task, not run in isolation).
    if (e.source !== viewFrame.contentWindow) return;
    const id = String(d.id ?? "").trim();
    closeView();
    composer.value = composer.value ? `${composer.value} /skill:${id}` : `/skill:${id}`;
    composer.focus();
    return;
  }
  if (!d || d.type !== "cap:attach-artifact") return;
  if (e.source !== viewFrame.contentWindow) return; // only our own gallery
  const { id, name, type, origin } = d.artifact ?? {};
  if (!id) return;
  // The single Reuse path: attachAssetToComposer performs exactly one
  // asset.get + the canonical kind:"artifact" attachment + the closeView. No
  // duplicate inline get/add/close/status locals.
  await attachAssetToComposer({ id, name, type, origin }, { closeOverlay: true });
});

setStatus("ready");

// Transparency surface: capture the page's own errors/CSP violations into the
// shared console + keep the shield/console badges live.
installPageDiagnostics();
refreshDiagnostics().catch(() => {});
startDiagnosticPolling();

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

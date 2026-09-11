// sidepanel/sidepanel.js — the PAGE COMPANION.
//
// The Page view is a companion pinned to the CURRENT tab
// (CAP-FB-20260830-SIDE-PANEL-COMPANION-01): it shows the active tab's favicon
// and host, whether that origin offers Site Agent tools, and a compact composer
// that runs the hub agent against THIS page. `read_page` and the page-action
// tools default to the active tab, so a run started here reads and acts on the
// page in front of the owner. Actions the agents take on the tab show in the
// Activity ledger below, with Undo where the ledger offers it. Each tab keeps
// its own conversation thread; "Continue in hub" reopens that exact thread on
// the new-tab hub.
//
// The active tab is tracked with chrome.tabs.query and kept live on
// onActivated / onUpdated / window focus. A secondary "Open another site…"
// disclosure still opens a chosen URL in a real tab (the panel then follows it),
// but it is no longer the primary control the way the old URL bar was.
//
// The agent-facing `open_side_panel` tool was REMOVED 2026-08-30
// (CAP-FB-20260830-SIDE-PANEL-TOOL-CUT-01) — chrome.sidePanel.open() needs a
// user gesture the service worker does not have, so the panel is opened by the
// owner (the toolbar action or the keyboard command), never by the model.

import { send } from "../lib/messages.js";
import {
  runConversationTurn,
  subscribeProgress,
  subscribeRunRegistry,
  cancelDurableRun,
  appendBubble,
  projectThreadMessages,
} from "../shared/conversation.js";
import { cancelRunFromRenderedStop, projectConversationRunStatus } from "../shared/run-status.js";
import { BUDGET_CONTINUE_TASK } from "../lib/run-budget.js";
import { findAgentByRef } from "../shared/agent-registry.js";
import { deleteAgentDialog, renderAgentPermissionsPanel } from "../shared/components.js"; // registers <agent-picker>, <agent-composer>, <agent-conversation>, <task-row>
import { capLog } from "../lib/cap-log.js";
import { actionableRunsForSurface } from "../lib/run-scope.js";

capLog("sidepanel").info("side panel evaluated");

const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");
const goBtn = document.getElementById("go");
const toolsEl = document.getElementById("tools");
const openAnother = document.getElementById("open-another");
const hostEl = document.getElementById("tab-host");
const toolStateEl = document.getElementById("tab-toolstate");
const faviconEl = document.getElementById("tab-favicon");
const globeEl = document.getElementById("tab-globe");
const continueHubBtn = document.getElementById("continue-hub");
const pageHistory = document.getElementById("page-history");
const pageComposer = document.getElementById("page-composer");

// The Activity ledger (CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01): the mutating
// actions the agents took, each with Undo where reversible. The section stays
// hidden until it has rows. After an undo, re-read so the list reflects the new
// state (the undone row flips to "Undone").
const actionLedgerEl = document.getElementById("action-ledger");
const actionLedgerSection = document.getElementById("activity-ledger-section");
if (actionLedgerEl && actionLedgerSection) {
  actionLedgerEl.addEventListener("entries-change", (ev) => {
    actionLedgerSection.hidden = (ev.detail?.count ?? 0) === 0;
  });
  actionLedgerEl.refresh?.().catch(() => {});
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

/** The one-line tool-state summary in the companion header. */
function setToolState(kind, count = 0) {
  if (!toolStateEl) return;
  toolStateEl.textContent =
    kind === "tools" ? `Offers ${count} ${count === 1 ? "tool" : "tools"}`
    : kind === "empty" ? "No site tools yet — reload to refresh"
    : kind === "not-added" ? "No site tools added"
    : kind === "error" ? "Site tools unavailable right now"
    : kind === "none" ? "No tools on this page"
    : "";
}

/** Render the origin's discovered WebMCP tools as chips and set the header
 *  tool-state line. Tool names come from the SW and are rendered with
 *  textContent (never innerHTML). */
async function renderTools(origin) {
  if (!toolsEl) return;
  const res = await send("sidepanel.getTools", { origin });
  toolsEl.innerHTML = "";
  if (!res?.ok) {
    setToolState("error");
    return;
  }
  const names = res.tools ?? [];
  if (!res.enrolled) {
    setToolState("not-added");
    return;
  }
  if (names.length === 0) {
    setToolState("empty");
    return;
  }
  setToolState("tools", names.length);
  for (const name of names) {
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.textContent = name;
    toolsEl.append(chip);
  }
}

async function go() {
  // Capture activation BEFORE any await. Only the button/Enter owner gesture
  // may open a tab; an agent-opened panel can display a stored target but cannot
  // turn it into a browser mutation through this route.
  const ownerGesture = navigator.userActivation?.isActive === true;
  let url = urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  let parsed;
  try { parsed = new URL(url); } catch { setStatus("Invalid URL", true); return; }

  // Open the page in a real tab so the content-script bridge can drive it.
  // NAVIGATION AUTHORITY LIVES IN THE SERVICE WORKER: the panel never calls
  // chrome.tabs.create itself — the request crosses the SW's sender-
  // authenticated + owner-gesture-gated message dispatcher
  // (sidepanel.openPage), so a content script or an agent-opened panel can
  // never drive a tab open through this surface.
  const res = await send("sidepanel.openPage", { url: parsed.href, ownerGesture }).catch((e) => ({
    ok: false,
    error: String(e?.message ?? e),
  }));
  if (!res?.ok) {
    setStatus("Could not open tab: " + (res?.error ?? "unknown error"), true);
    return;
  }
  setStatus(`Opened ${parsed.origin} in a new tab.`);
  urlInput.value = "";
  openAnother?.removeAttribute("open");
  // Record the origin so the hub can enroll it. The newly-active tab drives the
  // companion header + tools via chrome.tabs.onActivated → refreshActiveTab.
  send("tools.allOrigins").catch(() => {});
}

goBtn.addEventListener("click", go);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

/* ──────────────────────────────────────────────────────────────────────────
 * The COMPANION: the Page view follows the active tab. It shows that tab's
 * favicon + host, the origin's tools, and a conversation keyed to the tab.
 * ────────────────────────────────────────────────────────────────────────── */

// The tab the companion is currently pinned to.
let currentTabId = null;
let currentTabOrigin = null;
// The conversation thread for the current tab (created lazily on the first run
// from the page composer). Each tab keeps its own thread so switching tabs
// swaps the conversation, and "Continue in hub" reopens the exact thread.
let pageThreadId = null;

const PAGE_THREADS_KEY = "cap:sidepanel:page-threads";
function loadPageThreads() {
  try { return JSON.parse(sessionStorage.getItem(PAGE_THREADS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function savePageThread(tabId, threadId) {
  if (tabId == null) return;
  try {
    const m = loadPageThreads();
    if (threadId) m[String(tabId)] = threadId; else delete m[String(tabId)];
    sessionStorage.setItem(PAGE_THREADS_KEY, JSON.stringify(m));
  } catch { /* sessionStorage may be unavailable — persistence is best-effort */ }
}

function hostFromUrl(url) {
  try { const u = new URL(url); return u.host || u.protocol.replace(/:$/, ""); }
  catch { return ""; }
}
function originFromUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.origin : null;
  } catch { return null; }
}

// The favicon is web-controlled: set it as an <img src> (attribute only, never
// innerHTML) with an empty alt; fall back to the inline globe on absence/error.
function setFavicon(url) {
  if (!faviconEl || !globeEl) return;
  if (url && /^https?:\/\//.test(url)) {
    faviconEl.src = url;
    faviconEl.hidden = false;
    globeEl.hidden = true;
  } else {
    faviconEl.hidden = true;
    faviconEl.removeAttribute("src");
    globeEl.hidden = false;
  }
}
faviconEl?.addEventListener("error", () => {
  faviconEl.hidden = true;
  faviconEl.removeAttribute("src");
  if (globeEl) globeEl.hidden = false;
});

/** Render an existing tab thread into the page conversation (full transcript
 *  via the shared projection). Clears when the tab has no thread yet. */
async function loadTabThread(tabId) {
  const threads = loadPageThreads();
  pageThreadId = tabId != null ? (threads[String(tabId)] || null) : null;
  pageHistory?.clear?.();
  if (pageThreadId) {
    const res = await send("thread.get", { id: pageThreadId }).catch(() => null);
    if (res?.thread) pageHistory?.setMessages?.(projectThreadMessages(res.thread));
    else { pageThreadId = null; savePageThread(tabId, null); }
  }
  if (continueHubBtn) continueHubBtn.hidden = !pageThreadId;
}

// Re-entrancy fence: a burst of tab events must not race two refreshes into an
// inconsistent header/thread pair (last query wins).
let refreshSeq = 0;
async function refreshActiveTab() {
  const seq = ++refreshSeq;
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); }
  catch { tab = null; }
  if (seq !== refreshSeq) return; // superseded by a newer event
  if (!tab) return;
  const tabId = tab.id ?? null;
  const origin = originFromUrl(tab.url || "");
  const tabChanged = tabId !== currentTabId;
  currentTabId = tabId;
  currentTabOrigin = origin;
  if (hostEl) hostEl.textContent = hostFromUrl(tab.url || "") || (tab.title || "This page");
  setFavicon(tab.favIconUrl || "");
  if (toolsEl) toolsEl.innerHTML = "";
  if (origin) await renderTools(origin);
  else setToolState("none");
  if (seq !== refreshSeq) return;
  if (tabChanged) await loadTabThread(tabId);
}

// The inline live-status row's recovery action + Stop, for the page
// conversation (same pattern as the agent detail conversation below).
pageHistory?.addEventListener("action", (ev) => {
  if (!ev.target?.classList?.contains?.("live-status")) return;
  // "Budget reached — Continue": a new turn on the same page thread
  // (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01).
  if (ev.detail?.kind === "continue") {
    runPageTurn(BUDGET_CONTINUE_TASK, [], null).catch(ignoreTurnFailure);
    return;
  }
  chrome.runtime.openOptionsPage();
});
// A continuation turn reports its own outcome on the status row; the click
// handler has nothing further to do with a rejection.
function ignoreTurnFailure() {}
pageHistory?.addEventListener("stop", async (ev) => {
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
  projectConversationRunStatus(pageHistory, result?.ok === true
    ? { state: "cancelled" }
    : { state: "failed", message: `Stop failed — ${result?.error ?? "unknown error"}`, errorCategory: "aborted" });
});

// The page composer: run the hub agent against THIS tab. read_page and the
// page-action tools default to the active tab, so the run reads/acts on the
// page in front of the owner. An @mention chip routes the turn to that agent.
pageComposer?.addEventListener("send", async (ev) => {
  const { text, attachments, agent } = ev.detail ?? {};
  const mention = agent?.ref ? { kind: agent.kind, id: agent.id, name: agent.name || agent.id } : null;
  await runPageTurn(text, attachments, mention);
});

/** One turn of the page conversation (the composer's send, or the budget
 * Continue action) — the page thread continues across turns. */
async function runPageTurn(text, attachments, mention) {
  pageHistory?.bindLiveStatusExecution?.(null);
  const res = await runConversationTurn(pageHistory, {
    text,
    attachments,
    threadId: pageThreadId,
    mention,
    onStatus: (s) => projectConversationRunStatus(pageHistory, s),
    onRunRegistered: () => pageHistory?.bindLiveStatusExecution?.(null),
  });
  const newThreadId = res?.threadId ?? pageThreadId;
  if (newThreadId) {
    pageThreadId = newThreadId;
    savePageThread(currentTabId, pageThreadId);
    if (continueHubBtn) continueHubBtn.hidden = false;
  }
  // A run may have mutated this tab — refresh the ledger + the tool list.
  actionLedgerEl?.refresh?.().catch(() => {});
  if (currentTabOrigin) renderTools(currentTabOrigin);
  return res;
}

// "Continue in hub": reopen the exact tab thread on the new-tab hub.
continueHubBtn?.addEventListener("click", () => {
  if (!pageThreadId) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`ntp/ntp.html#thread=${encodeURIComponent(pageThreadId)}`) });
});

// Track the active tab: on load and whenever the owner switches tabs, the tab
// navigates, or the window focus changes.
chrome.tabs?.onActivated?.addListener(() => { refreshActiveTab(); });
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (tabId !== currentTabId) return;
  if (changeInfo.url || changeInfo.favIconUrl || changeInfo.title || changeInfo.status === "complete") {
    refreshActiveTab();
  }
});
chrome.windows?.onFocusChanged?.addListener(() => { refreshActiveTab(); });
refreshActiveTab();

// NOTE: there is deliberately NO runtime.onMessage listener that opens tabs
// (no "navigate"/"sidepanel.navigate" local path). The wider-goal review found
// that an earlier local listener let any message sender open tabs OUTSIDE the
// authoritative browser-tool path. ALL navigation from this surface goes
// through go() → the service worker's `sidepanel.openPage` route (sender-
// authenticated by the SW dispatcher; a content-script sender is denied by the
// page-route allowlist). The agent's own navigation goes through the SW's
// open_tab tool route (grant/origin/run-fenced).

// Set the side panel for the active tab so it can be opened from the hub.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

/* ──────────────────────────────────────────────────────────────────────────
 * The AGENTS view (CAP-FB-20260818-AGENT-ACCESS-01) — a first-class agent
 * surface next to the page-orchestration view: browse/search every agent via
 * the shared <agent-picker> (the live redacted registry), select one to open
 * its conversation/history, and direct a task to it. The selection persists
 * per sidepanel session (sessionStorage) and updates LIVE on create/rename/
 * delete/status (the SW's agent-registry-changed broadcast). No iframes.
 * ────────────────────────────────────────────────────────────────────────── */
const tabPage = document.getElementById("tab-page");
const tabAgents = document.getElementById("tab-agents");
const pageView = document.getElementById("page-view");
const agentsView = document.getElementById("agents-view");
const listPane = document.getElementById("agents-list-pane");
const detailPane = document.getElementById("agent-detail-pane");
const picker = document.getElementById("agents-picker");
const detailName = document.getElementById("agent-detail-name");
const detailKind = document.getElementById("agent-detail-kind");
const historyEl = document.getElementById("agent-history");
const agentComposer = document.getElementById("agent-composer");
let latestDurableRuns = [];
let liveClientRunId = null;

// The inline live-status row's recovery action ("Fix in Settings") — fire ONLY
// for the status row (message bubbles can also emit "action"), and route to the
// real Settings page: the sidepanel is not the NTP, so openOptionsPage IS the
// right route here (review P1-b: the sidepanel had no action listener at all).
historyEl.addEventListener("action", (ev) => {
  if (!ev.target?.classList?.contains?.("live-status")) return;
  // "Budget reached — Continue": a new turn in the open agent's conversation
  // (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01).
  if (ev.detail?.kind === "continue") {
    if (openAgent) runAgentTurn(openAgent, BUDGET_CONTINUE_TASK, []).catch(ignoreTurnFailure);
    return;
  }
  chrome.runtime.openOptionsPage();
});

historyEl.addEventListener("stop", async (ev) => {
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
  projectConversationRunStatus(historyEl, result?.ok === true
    ? { state: "cancelled" }
    : {
      state: "failed",
      message: result?.error === "run_already_terminal"
        ? "Stop had no effect — this run already finished."
        : `Stop failed — ${result?.error ?? "unknown error"}`,
      errorCategory: "aborted",
    });
});

const KIND_LABELS = { named: "Named agent", background: "Background agent", site: "Site Agent" };
const SESSION_KEY = "cap:sidepanel:selected-agent";

// The currently-open agent (null = the list view). { ref, kind, id, name }.
let openAgent = null;

function switchView(which) {
  const agents = which === "agents";
  tabPage.setAttribute("aria-selected", String(!agents));
  tabAgents.setAttribute("aria-selected", String(agents));
  pageView.hidden = agents;
  agentsView.hidden = !agents;
  if (agents) picker?.focusSearch?.();
}
tabPage.addEventListener("click", () => switchView("page"));
tabAgents.addEventListener("click", () => switchView("agents"));
for (const tab of [tabPage, tabAgents]) {
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = tab === tabPage ? tabAgents : tabPage;
    next.focus();
    next.click();
  });
}

// The ONE live-status surface for the agent detail conversation: the
// conversation's own inline pinned bottom row (owner 2026-08-28 — no separate
// status line duplicating the running conversation entry).
function setDetailStatus(text, isError = false) {
  if (!text) {
    historyEl.clearLiveStatus?.();
    return;
  }
  historyEl.setLiveStatus?.(isError
    ? { state: "failed", errorReason: text }
    : { state: "running", activity: text });
}

function persistSelection() {
  try {
    if (openAgent) sessionStorage.setItem(SESSION_KEY, JSON.stringify(openAgent));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* sessionStorage may be unavailable — persistence is best-effort */ }
}

/** Render an agent's journal (most-recent-first entries) as a conversation. */
function renderHistory(entries) {
  historyEl.clear?.();
  const rows = (Array.isArray(entries) ? entries : []).slice().reverse();
  const usable = rows.filter((r) =>
    (r?.type === "task" && typeof r.task === "string" && r.task.trim()) ||
    (r?.type === "result" && typeof r.result === "string" && r.result.trim()) ||
    (r?.type === "delegated-result" && (typeof r.task === "string" || typeof r.result === "string")),
  );
  if (!usable.length) {
    historyEl.appendSystem?.("No runs yet — direct a task below to talk to this agent.");
    return;
  }
  for (const r of usable) {
    const ts = typeof r.ts === "number" ? r.ts : null;
    if (r.type === "task") appendBubble(historyEl, "user", r.task, undefined, ts);
    else if (r.type === "result") appendBubble(historyEl, "agent", r.result, undefined, ts);
    else if (r.type === "delegated-result") {
      if (typeof r.task === "string" && r.task.trim()) appendBubble(historyEl, "user", r.task, undefined, ts);
      const out = typeof r.result === "string" ? r.result : (r.result != null ? JSON.stringify(r.result) : "");
      if (out.trim()) appendBubble(historyEl, "agent", out, undefined, ts);
    }
  }
}

async function loadHistory(kind, id) {
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

async function openAgentDetail(agent) {
  openAgent = { ref: agent.ref, kind: agent.kind, id: agent.id, name: agent.name || agent.id };
  liveClientRunId = null;
  persistSelection();
  detailName.textContent = openAgent.name;
  detailKind.textContent = KIND_LABELS[openAgent.kind] ?? "Agent";
  setDetailStatus("");
  // Scope the composer to this agent so the /agent + @ lists exclude it.
  agentComposer.setAttribute("agent-id", openAgent.id);
  agentComposer.setAttribute("agent-kind", openAgent.kind);
  listPane.hidden = true;
  detailPane.hidden = false;
  // FENCED history load: a rapid A→B selection must never render A's late-
  // arriving history under B's title — capture the selection and render ONLY
  // if it is still the open one when the read resolves.
  const opened = openAgent;
  const entries = await loadHistory(opened.kind, opened.id);
  if (openAgent !== opened) return; // the selection changed (or closed) mid-load
  renderHistory(entries);
  // Per-agent permission management in the agent view
  // (CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01, increment 2): the owner
  // sees and manages the permission posture RIGHT HERE, not only in Settings.
  // For a Site Agent that is its own host access (grant/revoke the origin);
  // for a named/background agent it is the extension-wide posture, honestly
  // labelled. Fenced by isCurrent so a stale read never paints the wrong agent.
  const permSlot = document.getElementById("agent-permissions-slot");
  if (permSlot) {
    renderAgentPermissionsPanel(permSlot, {
      kind: opened.kind,
      id: opened.id,
      isCurrent: () => openAgent === opened,
    });
  }
  const liveRun = actionableRunsForSurface(latestDurableRuns, { agentId: opened.id, agentKind: opened.kind })
    .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0];
  if (liveRun) projectConversationRunStatus(historyEl, { state: "running", activity: "Run in progress", executionId: liveRun.executionId });
  agentComposer.focus();
}

function closeAgentDetail() {
  openAgent = null;
  persistSelection();
  detailPane.hidden = true;
  listPane.hidden = false;
  picker?.focusSearch?.();
}

document.getElementById("agent-back").addEventListener("click", closeAgentDetail);

const agentDeleteBtn = document.getElementById("agent-delete");
agentDeleteBtn?.addEventListener("click", async () => {
  if (!openAgent) return;
  const { kind, id, name } = openAgent;
  const agentName = name || id;
  // ONE shared delete confirmation across the hub, Settings and the side panel
  // (CAP-FB-20260830-USER-VOICE-COPY-01).
  const confirmed = await deleteAgentDialog({ name: agentName, kind, returnFocusTo: agentDeleteBtn });
  if (!confirmed) return;
  let out;
  if (kind === "named") {
    out = await send("named-agent.delete", { id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  } else if (kind === "site") {
    out = await send("agent.delete", { origin: id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  } else if (kind === "background") {
    // Background agents schedule deterministically as `recipe:<id>` — the
    // picker supplies the BARE recipe id, so the old task.cancel({name:id})
    // hit "no such task" and silently deleted nothing. DELETION routes
    // through recipe.delete (removes the custom record + tears the schedule
    // down NON-BLOCKING — the instant-delete contract), and success is
    // asserted EXPLICITLY (ok === true); a real failure surfaces in status
    // instead of silently closing the detail view.
    out = await send("recipe.delete", { id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  }
  if (out?.ok === true) {
    closeAgentDetail();
    picker?.refresh?.();
    await renderTasks();
  } else if (kind) {
    setStatus(`Could not delete ${agentName}: ${out?.error ?? "failed"}.`, true);
  }
});
picker.addEventListener("agent-select", (e) => {
  const a = e.detail?.agent;
  if (a) openAgentDetail({ ...a, ref: e.detail.ref });
});

// ── the TASK LIST (the Agents view's third surface: list / history / tasks) ──
// The owner-visible scheduled-task list (task.list — active AND quarantined),
// rendered with the shared <task-row> component. A recipe:<id> row opens the
// matching background agent's conversation; the row's delete affordance is the
// authoritative task.cancel (which also disables that background agent — the
// SW broadcasts agent-registry-changed, so the picker + this list refresh).
const tasksEl = document.getElementById("agents-tasks");

async function renderTasks() {
  if (!tasksEl) return;
  const res = await send("task.list").catch(() => null);
  const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
  tasksEl.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.textContent = "No scheduled tasks.";
    tasksEl.append(empty);
    return;
  }
  for (const t of tasks) {
    const row = document.createElement("task-row");
    row.dataset.scheduleName = String(t.name ?? "");
    row.setAttribute("name", t.name || "task");
    row.setAttribute("status", (t.quarantined || t.storageBlocked) ? "failed" : (t.paused ? "paused" : "running"));
    const when = t.paused
      ? "paused"
      : t.storageBlocked
      ? "Storage full — retry or cancel"
      : (typeof t.nextFireAt === "number"
        ? new Date(t.nextFireAt).toLocaleString()
        : (t.periodInMinutes
          ? `every ${t.periodInMinutes} min`
          : (typeof t.at === "number" ? new Date(t.at).toLocaleString() : "")));
    if (when) row.setAttribute("time", when);
    if (!t.quarantined && !t.storageBlocked) row.setAttribute("pausable", "");
    if (t.paused) row.setAttribute("paused", "");
    if (t.storageBlocked) {
      row.setAttribute("retryable", "");
      row.title = t.remediation || "Execution storage was full. Retry or cancel this task.";
    }
    row.addEventListener("stop", async (ev) => {
      const result = await cancelRunFromRenderedStop(ev, (executionId) => {
        row.removeAttribute("stoppable");
        row.setAttribute("time", "Stopping…");
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
      row.removeAttribute("execution-id");
      row.setAttribute("time", result?.ok === true
        ? "Stopped"
        : result?.error === "run_already_terminal"
          ? "Already finished — nothing stopped"
          : `Stop failed: ${result?.error ?? "unknown error"}`);
      if (result?.ok === true) row.setAttribute("status", "stopped");
      else if (result?.error !== "run_already_terminal") row.setAttribute("stoppable", "");
    });
    row.addEventListener("toggle-pause", async () => {
      row.setAttribute("time", t.paused ? "Resuming…" : "Pausing…");
      const r = await send(t.paused ? "task.resume" : "task.pause", { name: t.name }).catch(() => null);
      if (!r?.ok) {
        row.setAttribute("time", r?.error || "failed");
        return;
      }
      await renderTasks();
    });
    row.addEventListener("open", () => {
      // A recipe task belongs to its background agent — open its conversation.
      const m = /^recipe:(.+)$/.exec(String(t.name ?? ""));
      if (!m) return;
      openAgentByRef(`background:${m[1]}`);
    });
    row.addEventListener("retry", async () => {
      row.removeAttribute("retryable");
      row.setAttribute("status", "running");
      row.setAttribute("time", "Retrying…");
      const result = await send("task.retry", { name: t.name }).catch(() => null);
      if (!result?.ok) {
        row.setAttribute("status", "failed");
        row.setAttribute("time", result?.error || "Retry failed");
        row.setAttribute("retryable", "");
      } else {
        await renderTasks();
      }
    });
    row.addEventListener("delete", async () => {
      row.setAttribute("status", "completed");
      // cancelBackground: non-blocking teardown (durable mark + abort, the
      // terminating wait happens in the SW) — never the 5s-terminating path.
      const out = await send("task.cancelBackground", { name: t.name }).catch(
        () => null,
      );
      if (out?.ok !== true) {
        row.setAttribute(
          "status",
          "failed",
        );
        row.setAttribute(
          "time",
          `Delete failed: ${out?.error ?? "no response"}`,
        );
        return;
      }
      // The registry broadcast refreshes both the picker + this list; refresh
      // eagerly too so a cancelled row disappears even without the broadcast.
      renderTasks();
      picker.refresh?.();
    });
    tasksEl.append(row);
  }
  syncTaskStopButtons();
}

function syncTaskStopButtons() {
  for (const row of tasksEl?.querySelectorAll?.("task-row") ?? []) {
    const run = latestDurableRuns
      .filter((candidate) => candidate?.scheduleName === row.dataset.scheduleName &&
        ["running", "settling", "resume-dispatching"].includes(candidate?.phase))
      .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0];
    if (run?.executionId) row.setAttribute("execution-id", run.executionId);
    else row.removeAttribute("execution-id");
    row.toggleAttribute("stoppable", Boolean(run?.executionId));
  }
}

/** Open an agent's conversation by canonical ref (the task rows' open path). */
async function openAgentByRef(ref) {
  const res = await send("agent.registry").catch(() => null);
  if (!res || res.ok === false || !Array.isArray(res.groups)) return;
  const found = findAgentByRef(res.groups, ref);
  if (found) await openAgentDetail(found);
}

renderTasks();

subscribeRunRegistry(({ runs }) => {
  latestDurableRuns = Array.isArray(runs) ? runs : [];
  syncTaskStopButtons();
  if (!openAgent) return;
  const surfaceRuns = actionableRunsForSurface(latestDurableRuns, { agentId: openAgent.id, agentKind: openAgent.kind })
    .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
  const active = liveClientRunId
    ? surfaceRuns.find((run) => run?.clientCorrelationId === liveClientRunId)
    : surfaceRuns[0];
  historyEl.bindLiveStatusExecution?.(active?.executionId ?? null);
  if (active) projectConversationRunStatus(historyEl, { state: "running", activity: "Run in progress", executionId: active.executionId });
});

agentComposer.addEventListener("send", async (ev) => {
  const { text, attachments, agent } = ev.detail;
  // A chip overrides the detail context (direct this message to ANOTHER agent);
  // otherwise the task goes to the agent whose conversation is open.
  const target = agent?.ref ? agent : openAgent;
  if (!target) return;
  if (agent?.ref && openAgent && agent.ref !== openAgent.ref) {
    // Switch the open conversation to the chip's agent so the run shows in context.
    await openAgentDetail(agent);
  }
  await runAgentTurn(target, text, attachments);
});

/** One turn of the open agent's conversation (the composer's send, or the
 * budget Continue action). */
async function runAgentTurn(target, text, attachments) {
  historyEl.bindLiveStatusExecution?.(null);
  setDetailStatus("Working…");
  return await runConversationTurn(historyEl, {
    text,
    attachments,
    agentId: target.id,
    agentKind: target.kind,
    // The conversation emits the authoritative terminal status before its
    // promise resolves. Do not overwrite that complete status afterwards with
    // a bare error string — doing so stripped "Fix in Settings" from the row.
    onStatus: (s) => projectConversationRunStatus(historyEl, s),
    onRunRegistered: (runId) => {
      liveClientRunId = runId;
      historyEl.bindLiveStatusExecution?.(null);
    },
  });
}

// Live registry updates: the picker re-fetches; an open conversation on a
// deleted (or freshly-disabled) agent closes honestly; a rename re-titles it.
subscribeProgress((ev) => {
  if (ev?.type !== "agent-registry-changed") return;
  picker.refresh?.();
  agentComposer.revalidateSelectedAgent?.();
  renderTasks();
  revalidateOpenAgent();
});

async function revalidateOpenAgent() {
  if (!openAgent) return;
  const current = openAgent; // capture — a concurrent event may close it mid-await
  const res = await send("agent.registry").catch(() => null);
  if (!res || res.ok === false || !Array.isArray(res.groups)) return;
  if (!openAgent || openAgent.ref !== current.ref) return; // it changed while we read
  const found = findAgentByRef(res.groups, current.ref);
  if (!found || (found.kind === "background" && found.enabled !== true)) {
    closeAgentDetail();
    setStatus(`Agent "${current.name}" is no longer available — its conversation was closed.`, true);
    switchView("agents");
    return;
  }
  if (found.name && found.name !== current.name) {
    openAgent.name = found.name;
    detailName.textContent = found.name;
    persistSelection();
  }
}

// Restore the per-session selection: when the panel was NOT opened with a page
// target, reopen the agent the user was talking to (still-valid entries only).
// A DELETED or freshly-DISABLED background agent is NOT restored (matching the
// live broadcast revalidation) — the stale saved selection is dropped.
(async function restoreAgentSession() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { saved = null; }
  if (!saved?.ref) return;
  const target = await send("sidepanel.getTarget").catch(() => null);
  if (target?.url) return; // an agent-driven page target wins the session
  const res = await send("agent.registry").catch(() => null);
  if (!res || res.ok === false || !Array.isArray(res.groups)) return;
  const found = findAgentByRef(res.groups, saved.ref);
  if (!found || (found.kind === "background" && found.enabled !== true)) {
    // Deleted (or disabled) while the panel was closed — start at the list and
    // drop the stale selection so the NEXT open doesn't retry it.
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* best-effort */ }
    return;
  }
  switchView("agents");
  await openAgentDetail(found);
})();

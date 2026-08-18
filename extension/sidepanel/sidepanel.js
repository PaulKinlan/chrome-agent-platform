// sidepanel/sidepanel.js — the driven-page surface.
//
// Cross-origin iframes cannot be driven (they're isolated + many sites block
// framing), so the real driven-page mechanism is: open the target page in a
// real tab (where the MAIN-world bridge + content script can discover and
// invoke its WebMCP tools), and drive it from there. The side panel shows a
// control + status surface AND the live WebMCP tool list for the driven origin;
// the iframe is retained only as a non-driving preview when the site permits
// framing.
//
// The AGENT can open this surface with the `open_side_panel` tool: it stores a
// target URL (sidepanel.getTarget) and this panel loads it on startup + shows
// the origin's discovered tools (sidepanel.getTools).

import { send } from "../lib/messages.js";
import {
  runConversationTurn,
  subscribeProgress,
  appendBubble,
} from "../shared/conversation.js";
import { findAgentByRef } from "../shared/agent-registry.js";
import "../shared/components.js"; // registers <agent-picker>, <agent-composer>, <agent-conversation>

const frame = document.getElementById("frame");
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");
const goBtn = document.getElementById("go");
const toolsEl = document.getElementById("tools");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

async function renderTools(origin) {
  if (!toolsEl) return;
  const res = await send("sidepanel.getTools", { origin });
  if (!res?.ok) {
    toolsEl.innerHTML = "";
    toolsEl.textContent = res?.error ?? "not enrolled";
    return;
  }
  const names = res.tools ?? [];
  toolsEl.innerHTML = "";
  if (!res.enrolled) {
    const row = document.createElement("div");
    row.className = "tool-row empty";
    row.textContent = "Not enrolled — the agent can enroll this origin to discover its tools.";
    toolsEl.append(row);
    return;
  }
  if (names.length === 0) {
    const row = document.createElement("div");
    row.className = "tool-row empty";
    row.textContent = "Enrolled · 0 WebMCP tools discovered yet.";
    toolsEl.append(row);
    return;
  }
  for (const name of names) {
    const row = document.createElement("div");
    row.className = "tool-row";
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.textContent = name;
    row.append(chip);
    toolsEl.append(row);
  }
}

async function go() {
  let url = urlInput.value.trim();
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  let parsed;
  try { parsed = new URL(url); } catch { setStatus("Invalid URL", true); return; }

  // Open the page in a real tab so the content-script bridge can drive it.
  let tab;
  try {
    tab = await chrome.tabs.create({ url });
  } catch (e) {
    setStatus("Could not open tab: " + String(e?.message ?? e), true);
    return;
  }

  // Preview in the panel only if the site permits framing; never claim the
  // panel drives it — driving happens in the tab via the MAIN-world bridge.
  frame.src = url;
  setStatus(`Opened ${parsed.origin} in a tab (tab ${tab.id}). The agent drives it there via WebMCP.`);

  // Record the origin so the hub can enroll it.
  send("tools.allOrigins").catch(() => {});
  // Show the origin's discovered WebMCP tools.
  renderTools(parsed.origin);
}

goBtn.addEventListener("click", go);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

document.getElementById("morph").addEventListener("click", () => {
  setStatus("Morph (double-iframe meld) is a documented seam — not wired yet.");
});

// On load: if the AGENT opened this panel (open_side_panel stored a target),
// load that target + show its tools.
(async function boot() {
  try {
    const res = await send("sidepanel.getTarget");
    if (res?.url) {
      urlInput.value = res.url;
      await go();
    }
  } catch { /* the panel also works standalone */ }
})();

// A page-origin navigate message (the agent re-targeting an open panel): load
// the URL + refresh the tool list. This is a READ of a URL the agent chose; it
// does NOT create a tab outside the browser-tool grant path — the real tab open
// still goes through go() → chrome.tabs.create only after the user/agent grants
// browser control via the authoritative open_tab/navigate_tab routes.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "sidepanel.navigate" && typeof message.url === "string") {
    urlInput.value = message.url;
    go();
    return;
  }
});

// NOTE: there is deliberately NO runtime.onMessage "navigate" listener that
// blindly calls chrome.tabs.create on a {type:"navigate",url} message. The wider-
// goal review found that earlier path let a content script open tabs outside the
// authoritative browser-tool path. Agent-driven navigation must go through the
// service worker's `open_tab` route (sender-authenticated + grant/origin/run-
// fenced). The side panel's own `go` button + URL input (a user gesture on THIS
// surface) + the agent's open_side_panel/`sidepanel.navigate` target-load remain
// the only local open paths.

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
const detailStatus = document.getElementById("agent-detail-status");
const historyEl = document.getElementById("agent-history");
const agentComposer = document.getElementById("agent-composer");

const KIND_LABELS = { named: "Named agent", background: "Background agent", site: "Site agent" };
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

function setDetailStatus(text, isError = false) {
  detailStatus.hidden = !text;
  detailStatus.textContent = text || "";
  detailStatus.classList.toggle("error", isError);
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
  persistSelection();
  detailName.textContent = openAgent.name;
  detailKind.textContent = KIND_LABELS[openAgent.kind] ?? "Agent";
  setDetailStatus("");
  // Scope the composer to this agent so the /agent + @ lists exclude it.
  agentComposer.setAttribute("agent-id", openAgent.id);
  agentComposer.setAttribute("agent-kind", openAgent.kind);
  listPane.hidden = true;
  detailPane.hidden = false;
  renderHistory(await loadHistory(openAgent.kind, openAgent.id));
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
picker.addEventListener("agent-select", (e) => {
  const a = e.detail?.agent;
  if (a) openAgentDetail({ ...a, ref: e.detail.ref });
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
  setDetailStatus("Working…");
  const res = await runConversationTurn(historyEl, {
    text,
    attachments,
    agentId: target.id,
    agentKind: target.kind,
    onStatus: (s) => {
      if (s?.state === "working") setDetailStatus(s.activity || "Working…");
      else if (s?.state === "done") setDetailStatus("");
      else if (s?.state === "error") setDetailStatus(s.errorReason || s.message || "error", true);
    },
  });
  if (res?.ok === false) setDetailStatus(res.error ?? "run failed", true);
});

// Live registry updates: the picker re-fetches; an open conversation on a
// deleted (or freshly-disabled) agent closes honestly; a rename re-titles it.
subscribeProgress((ev) => {
  if (ev?.type !== "agent-registry-changed") return;
  picker.refresh?.();
  agentComposer.revalidateSelectedAgent?.();
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
(async function restoreAgentSession() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { saved = null; }
  if (!saved?.ref) return;
  const target = await send("sidepanel.getTarget").catch(() => null);
  if (target?.url) return; // an agent-driven page target wins the session
  const res = await send("agent.registry").catch(() => null);
  if (!res || res.ok === false || !Array.isArray(res.groups)) return;
  const found = findAgentByRef(res.groups, saved.ref);
  if (!found) return; // deleted while the panel was closed — start at the list
  switchView("agents");
  await openAgentDetail(found);
})();

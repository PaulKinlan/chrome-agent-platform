// sidepanel/sidepanel.js — the driven-page surface.
//
// Cross-origin iframes cannot be driven (they're isolated + many sites block
// framing), so the real driven-page mechanism is: open the target page in a
// real tab (where the MAIN-world bridge + content script can discover and
// invoke its WebMCP tools), and drive it from there. The side panel shows a
// control + status surface AND the live WebMCP tool list for the driven origin.
// There is deliberately NO iframe preview and NO morph stub — the panel never
// claims to embed or morph the page; the page lives in its real tab.
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
import { projectConversationRunStatus } from "../shared/run-status.js";
import { findAgentByRef } from "../shared/agent-registry.js";
import { siteAgentToolsMessage } from "../shared/site-agent-copy.js";
import { confirmActionDialog } from "../shared/components.js"; // registers <agent-picker>, <agent-composer>, <agent-conversation>, <task-row>
import { capLog } from "../lib/cap-log.js";

capLog("sidepanel").info("side panel evaluated");

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
    toolsEl.textContent = siteAgentToolsMessage("error");
    return;
  }
  const names = res.tools ?? [];
  toolsEl.innerHTML = "";
  if (!res.enrolled) {
    const row = document.createElement("div");
    row.className = "tool-row empty";
    row.textContent = siteAgentToolsMessage("not-added");
    toolsEl.append(row);
    return;
  }
  if (names.length === 0) {
    const row = document.createElement("div");
    row.className = "tool-row empty";
    row.textContent = siteAgentToolsMessage("empty");
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
  // Capture activation BEFORE any await. Only the button/Enter owner gesture
  // may open a tab; an agent-opened panel can display a stored target but cannot
  // turn it into a browser mutation through this route.
  const ownerGesture = navigator.userActivation?.isActive === true;
  let url = urlInput.value.trim();
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
  setStatus(`Opened ${parsed.origin} in a tab. Available Site Agent tools are shown below.`);
  // The first-run guidance has done its job once a site is opened.
  document.getElementById("first-run")?.setAttribute("hidden", "");

  // Record the origin so the hub can enroll it.
  send("tools.allOrigins").catch(() => {});
  // Show the origin's discovered WebMCP tools.
  renderTools(parsed.origin);
}

goBtn.addEventListener("click", go);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

// On load: if the AGENT opened this panel (open_side_panel stored a target),
// show that target + its tools WITHOUT opening a tab. Agent-driven tab opens
// remain on the browser-control-granted open_tab tool; only the owner's Go /
// Enter gesture invokes sidepanel.openPage.
(async function boot() {
  try {
    const res = await send("sidepanel.getTarget");
    if (res?.url) {
      urlInput.value = res.url;
      let parsed = null;
      try { parsed = new URL(res.url); } catch { /* invalid legacy target */ }
      if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
        setStatus(`Site ready: ${parsed.origin}. Choose Open site to show its available Site Agent tools.`);
        // Agent-opened panel: the user is already on a site — the first-run
        // guidance block has done its job.
        document.getElementById("first-run")?.setAttribute("hidden", "");
        await renderTools(parsed.origin);
      } else {
        setStatus("The stored target is invalid.", true);
      }
    }
  } catch { /* the panel also works standalone */ }
})();

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

// The inline live-status row's recovery action ("Fix in Settings") — fire ONLY
// for the status row (message bubbles can also emit "action"), and route to the
// real Settings page: the sidepanel is not the NTP, so openOptionsPage IS the
// right route here (review P1-b: the sidepanel had no action listener at all).
historyEl.addEventListener("action", (ev) => {
  if (!ev.target?.classList?.contains?.("live-status")) return;
  chrome.runtime.openOptionsPage();
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
  let preview = "This will permanently remove the agent and its custom configuration.\n\nNote: Any created artifacts will be retained.";
  if (kind === "site") {
    preview = "This will disenroll the site, unregister its tools, and revoke its permissions.\n\nNote: Any created artifacts will be retained.";
  } else if (kind === "background") {
    preview = "This will cancel the scheduled task and remove its recurring alarm.";
  }
  const confirmed = await confirmActionDialog({
    title: `Delete “${agentName}”?`,
    body: `Are you sure you want to delete ${agentName}?\n\n${preview}`,
    confirmLabel: "Delete agent",
    destructive: true,
  });
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
}

/** Open an agent's conversation by canonical ref (the task rows' open path). */
async function openAgentByRef(ref) {
  const res = await send("agent.registry").catch(() => null);
  if (!res || res.ok === false || !Array.isArray(res.groups)) return;
  const found = findAgentByRef(res.groups, ref);
  if (found) await openAgentDetail(found);
}

renderTasks();

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
  await runConversationTurn(historyEl, {
    text,
    attachments,
    agentId: target.id,
    agentKind: target.kind,
    // The conversation emits the authoritative terminal status before its
    // promise resolves. Do not overwrite that complete status afterwards with
    // a bare error string — doing so stripped "Fix in Settings" from the row.
    onStatus: (s) => projectConversationRunStatus(historyEl, s),
  });
});

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

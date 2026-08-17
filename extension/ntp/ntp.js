// ntp/ntp.js — the hub page wiring. The hub is a COMMAND CENTER:
//   header → composer (the hero) → Tasks (the distinct task threads) →
//   background agents (scheduled, toggle) → site agents (enrolled origins) →
//   recent artifacts. A task is a DISTINCT THREAD: starting one opens a
//   full-screen thread surface (the conversation + a composer to nudge/continue),
//   and the hub lists every prior thread (auto-named).

import { send } from "../lib/messages.js";
import { runConversationTurn, subscribeProgress, appendBubble } from "../shared/conversation.js";
import { summarizeToolResult } from "../lib/tool-summary.js";
import { renderHtmlFrame, isHtmlDocument } from "../shared/components.js";
import { handleScriptRunMessage } from "../lib/script-host.js";

import {
  installPageDiagnostics,
  refreshDiagnostics,
  startDiagnosticPolling,
} from "../shared/diagnostics-client.js";

const statusEl = document.getElementById("status");
let statusTimer;

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

function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

// ── site agents (enrolled origins) ────────────────────────────────────────
async function renderSiteAgents() {
  const el = document.getElementById("site-agents");
  if (!el) return;
  const res = await send("agent.directory").catch(() => ({ agents: [] }));
  // Item 44: a site with ZERO tools is not an agent (paul.kinlan.me with no
  // WebMCP/inferred tools must not appear as a site agent). Only origins that
  // actually expose tools are listed here.
  const agents = (Array.isArray(res.agents) ? res.agents : []).filter(
    (a) => (a.toolCount ?? a.tools?.length ?? 0) > 0,
  );
  el.replaceChildren();
  if (!agents.length) {
    el.innerHTML = `<div class="empty">No site agents yet. Visit a site that exposes tools (WebMCP or window functions) to give it a sub-agent.</div>`;
  } else {
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
      row.addEventListener("run", () => openView("directory/directory.html", "Directory"));
      el.append(row);
    }
    if (agents.length > 6) {
      const more = document.createElement("div");
      more.className = "empty";
      more.textContent = `+ ${agents.length - 6} more in the directory`;
      el.append(more);
    }
  }
  refreshAgentCount();
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
      role.textContent = a.role;
      label.append(role);
    }
    item.append(avatar, label);
    item.addEventListener("click", () => openAgentChat(a.id || a.name));
    list.append(item);
  }
}

function initialAvatar(name) {
  const initial = (String(name ?? "?").trim()[0] || "?").toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="30" fill="#f7f6f3" stroke="#0e6e63" stroke-width="3"/>` +
    `<text x="32" y="42" font-family="system-ui,sans-serif" font-size="28" font-weight="600" fill="#0e6e63" text-anchor="middle">${initial}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
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
      openView("options/options.html", "Settings");
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
  if (!asset) { setStatus("Artifact not found", false); return; }
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", asset.name ?? fallbackName ?? "Artifact");
  const body = document.createElement("div");
  body.style.minWidth = "min(76vw, 920px)";
  body.style.minHeight = "200px";
  const type = asset.type ?? "data";
  const content = asset.content ?? "";
  if (type === "html" || (type === "text" && isHtmlDocument(content))) {
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.style.border = "1px solid var(--border)";
    frame.style.borderRadius = "10px";
    frame.style.overflow = "hidden";
    frame.style.background = "#fff";
    frame.innerHTML = renderHtmlFrame(content);
    const nonce = frame.querySelector(".html-frame")?.dataset?.frameNonce;
    if (nonce) {
      const { wireHtmlFramePreference, currentFramePreference } = await import("../shared/components.js");
      wireHtmlFramePreference(frame, { nonce, ...currentFramePreference() });
    }
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
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
}

// ── Recent activity (the agent run log — item 16) ────────────────────────
// Shows what the agents DID across the WHOLE system (master + named + background
// + site agents), most-recent-first, so a background agent's work is visible
// even without a live UI. Rendered by the reusable <activity-explorer> Web
// Component (searchable + filterable by agent).
async function renderRunLog() {
  const el = document.getElementById("run-log");
  if (!el) return;
  const explorer = document.createElement("activity-explorer");
  explorer.setAttribute("limit", "100");
  el.replaceChildren(explorer);
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

async function renderTasks(activeId = null) {
  const el = document.getElementById("thread-sidebar");
  if (!el) return;
  const res = await send("thread.list").catch(() => ({ threads: [] }));
  const threads = Array.isArray(res.threads) ? res.threads : [];
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
    del.textContent = "×";
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
let currentThreadId = null;
let currentAgentId = null; // when set, the thread surface is an AGENT chat (item 43)
let currentAgentKind = null; // null | "named" | "background" — which agent kind the chat is scoped to

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
  const anyOpen = !threadView.hidden || !viewOverlay.hidden;
  document.body.classList.toggle("view-open", anyOpen);
}
function hideThreadViewInner() {
  threadView.hidden = true;
  currentThreadId = null;
  currentAgentId = null;
  currentAgentKind = null;
  syncComposerScope();
  threadConversation.clear?.();
  renderRunStatus({ state: "idle" });
  syncViewOpen();
}
function hideViewInner() {
  viewOverlay.hidden = true;
  viewFrame.src = "about:blank";
  syncViewOpen();
}
function showThreadView() {
  withViewTransition(() => {
    // Only ONE overlay at a time (item 48): the thread view replaces the
    // settings/directory/recipes view.
    if (!viewOverlay.hidden) hideViewInner();
    threadView.hidden = false;
  });
  syncViewOpen();
}
function hideThreadView() {
  withViewTransition(hideThreadViewInner);
}

async function openThread(id) {
  currentThreadId = id;
  currentAgentId = null; // a thread is NOT an agent chat
  currentAgentKind = null;
  // A TASK shows an Edit button (the same visual as the agent's) that renames
  // the title in place — before, the button was hidden via the `hidden` attr
  // but leaked because `.back { display:inline-flex }` beat `[hidden]`, so it
  // appeared for tasks and did nothing (openAgentConfig only handles agents).
  editAgentBtn.hidden = false;
  editAgentBtn.setAttribute("aria-label", "Edit task");
  syncComposerScope();
  const res = await send("thread.get", { id }).catch(() => ({ ok: false }));
  const thread = res.ok ? res.thread : null;
  threadTitle.textContent = thread?.name || "Task";
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  threadConversation.setMessages?.(
    messages.map((m) => ({ role: m.role, content: m.content, ts: m.ts ?? null, reason: m.reason ?? null, action: m.action ?? null })),
  );
  showThreadView();
  renderRunStatus({ state: "idle" });
  renderTasks(id);
}

// ── the BACKGROUND-agent chat surface (item 61): a background agent is an
//    INDEPENDENT agent — click it to see its OWN run history + talk to it (a
//    task runs in its own OPFS sandbox), exactly like a named agent.
async function openBackgroundAgentChat(id, name) {
  currentAgentId = id;
  currentAgentKind = "background";
  currentThreadId = null;
  // No per-agent config route exists for background agents yet (only
  // named-agent.update), so hide the Edit button rather than show a dead one.
  editAgentBtn.hidden = true;
  syncComposerScope();
  const hRes = await send("background-agent.history", { id }).catch(() => ({ entries: [] }));
  threadTitle.textContent = name || id || "Background agent";
  renderAgentHistory(threadConversation, Array.isArray(hRes.entries) ? hRes.entries : []);
  showThreadView();
  renderRunStatus({ state: "idle" });
  threadComposer.focus();
}

// ── the AGENT chat surface (item 43): click a named agent → chat with it ──
// Opens the thread surface scoped to ONE named agent: the conversation shows
// the agent's OWN run history (its journal from its OPFS), and the composer
// starts tasks DIRECTLY in that agent (named-agent.run → its own memory/skills).
async function openAgentChat(id) {
  currentAgentId = id;
  currentAgentKind = "named";
  currentThreadId = null;
  editAgentBtn.hidden = false;
  editAgentBtn.setAttribute("aria-label", "Edit agent");
  syncComposerScope();
  const [aRes, hRes] = await Promise.all([
    send("named-agent.get", { id }).catch(() => ({ ok: false })),
    send("named-agent.history", { id }).catch(() => ({ entries: [] })),
  ]);
  const agent = aRes.ok ? aRes.agent : null;
  threadTitle.textContent = agent?.name || id || "Agent";
  renderAgentHistory(threadConversation, Array.isArray(hRes.entries) ? hRes.entries : []);
  showThreadView();
  renderRunStatus({ state: "idle" });
  threadComposer.focus();
}

// Render an agent's run history (its journal) as a conversation: task → user
// bubble, result → agent bubble, tool-call/tool-result → a tool card. Chronological
// (the history route is most-recent-first).
function renderAgentHistory(container, entries) {
  if (typeof container.clear === "function") container.clear();
  const rows = [...entries].reverse(); // oldest → newest
  const filtered = rows.filter(
    (r) =>
      (r?.type === "task" && typeof r.task === "string" && r.task.trim()) ||
      (r?.type === "result" && typeof r.result === "string" && r.result.trim()) ||
      r?.type === "tool-call" ||
      r?.type === "tool-result",
  );
  if (!filtered.length) {
    if (typeof container.appendSystem === "function") {
      container.appendSystem("No runs yet — start a task below to chat with this agent.");
    }
    return;
  }
  for (const r of filtered) {
    const ts = typeof r.ts === "number" ? r.ts : null;
    if (r.type === "task") appendBubble(container, "user", r.task, undefined, ts);
    else if (r.type === "result") appendBubble(container, "agent", r.result, undefined, ts);
    else if (r.type === "tool-call") {
      if (typeof container.appendTool === "function") {
        container.appendTool({ name: r.tool ?? "tool", status: "running", ts });
      }
    } else if (r.type === "tool-result") {
      if (typeof container.appendTool === "function") {
        const raw = r.result == null ? "" : typeof r.result === "string" ? r.result : JSON.stringify(r.result);
        const summary = r.result == null ? "" : summarizeToolResult(r.tool, r.result);
        container.appendTool({ name: r.tool ?? "tool", status: "success", result: summary, detail: raw && raw !== summary ? raw : null, ts });
      }
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
async function openAgentConfig() {
  if (currentAgentKind !== "named" || !currentAgentId) return;
  const res = await send("named-agent.get", { id: currentAgentId }).catch(() => ({ ok: false }));
  const agent = res.ok ? res.agent : null;
  if (!agent) { setStatus("Agent not found", false); return; }
  const skillsRes = await send("skill.list").catch(() => ({ skills: [] }));
  const available = Array.isArray(skillsRes.skills) ? skillsRes.skills : [];
  const agentSkillIds = new Set((agent.skills ?? []).map((s) => (typeof s === "string" ? s : s?.id ?? s?.name)));

  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", `Edit “${agent.name || currentAgentId}”`);
  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "12px";
  body.style.minWidth = "min(60vw, 460px)";

  const nameField = configField("Name", "input", agent.name ?? "");
  const roleField = configField("Role / system prompt", "textarea", agent.role ?? "", 4);
  body.append(nameField.wrap, roleField.wrap);

  // Skills: the reusable capabilities (the recipes→skills registry) the agent
  // can have attached — each checked skill is injected into its system prompt.
  const skillsBox = document.createElement("fieldset");
  skillsBox.style.border = "1px solid var(--border,#e3e0d9)";
  skillsBox.style.borderRadius = "8px";
  skillsBox.style.padding = "10px";
  skillsBox.style.margin = "0";
  const legend = document.createElement("legend");
  legend.textContent = "Skills";
  legend.style.fontWeight = "600";
  legend.style.fontSize = "13px";
  skillsBox.append(legend);
  const skillChecks = new Map();
  if (!available.length) {
    const none = document.createElement("p");
    none.textContent = "No skills available.";
    none.style.fontSize = "12.5px";
    none.style.color = "var(--muted,#635e56)";
    none.style.margin = "4px 0 0";
    skillsBox.append(none);
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
      const text = document.createElement("span");
      text.textContent = `${s.name ?? id} — ${s.description ?? ""}`.replace(/\s+—\s*$/, "");
      row.append(cb, text);
      skillChecks.set(id, cb);
      skillsBox.append(row);
    }
  }
  body.append(skillsBox);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  const avatarBtn = configButton("Regenerate avatar", "secondary");
  const cancelBtn = configButton("Cancel", "secondary");
  const saveBtn = configButton("Save", "primary");
  actions.append(avatarBtn, cancelBtn, saveBtn);
  body.append(actions);
  dialog.append(body);
  document.body.append(dialog);

  cancelBtn.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  saveBtn.addEventListener("click", async () => {
    const name = nameField.el.value.trim();
    const role = roleField.el.value.trim();
    const skills = [];
    for (const [id, cb] of skillChecks) {
      if (cb.checked) {
        const s = available.find((x) => (x?.id ?? x?.name ?? String(x)) === id);
        skills.push(s ? { id: s.id ?? s.name, name: s.name ?? s.id, description: s.description ?? "" } : { id, name: id });
      }
    }
    const r = await send("named-agent.update", { id: currentAgentId, name, role, skills }).catch(() => ({ ok: false }));
    if (r?.ok !== false) {
      dialog.close();
      setStatus("Agent updated.");
      renderNamedAgents();
      await openAgentChat(currentAgentId);
    } else {
      setStatus(`Update failed: ${r?.error ?? "unknown"}`, false);
    }
  });
  avatarBtn.addEventListener("click", async () => {
    avatarBtn.disabled = true;
    avatarBtn.textContent = "Generating…";
    const r = await send("named-agent.avatar", { id: currentAgentId }).catch(() => ({ ok: false }));
    avatarBtn.disabled = false;
    avatarBtn.textContent = "Regenerate avatar";
    if (r?.ok) { setStatus("Avatar regenerated."); renderNamedAgents(); }
    else setStatus(`Avatar failed: ${r?.error ?? "unknown"}`, false);
  });
  dialog.show();
}

// ── quick-create an agent (item: the sidebar "+" in the Agents section) ─────
//    A minimal owner-facing create form: a name + a role → named-agent.create
//    (the id/avatar are derived from the name). Reuses the agent-config field
//    helpers + the <agent-dialog> so it matches the Edit flow.
function openQuickCreateAgent() {
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", "Create an agent");
  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "12px";
  body.style.minWidth = "min(60vw, 460px)";

  const nameField = configField("Name", "input", "");
  const roleField = configField("Role / what it does", "textarea", "", 3);
  body.append(nameField.wrap, roleField.wrap);

  const hint = document.createElement("p");
  hint.textContent =
    "An agent is a named, persistent teammate with its own memory + history. " +
    "Give it a name + what it does; you can add skills + an avatar after.";
  hint.style.fontSize = "12.5px";
  hint.style.color = "var(--muted,#635e56)";
  hint.style.margin = "0";
  body.append(hint);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  const cancelBtn = configButton("Cancel", "secondary");
  const createBtn = configButton("Create agent", "primary");
  actions.append(cancelBtn, createBtn);
  body.append(actions);
  dialog.append(body);
  document.body.append(dialog);

  cancelBtn.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  createBtn.addEventListener("click", async () => {
    const name = nameField.el.value.trim();
    const role = roleField.el.value.trim();
    if (!name) { setStatus("An agent needs a name.", false); return; }
    createBtn.disabled = true;
    createBtn.textContent = "Creating…";
    const r = await send("named-agent.create", { name, role }).catch(() => ({ ok: false }));
    createBtn.disabled = false;
    createBtn.textContent = "Create agent";
    if (r?.ok) {
      dialog.close();
      setStatus(`Agent “${name}” created.`);
      renderNamedAgents();
      await openAgentChat(r.agent?.id ?? name);
    } else {
      setStatus(`Create failed: ${r?.error ?? "unknown"}`, false);
    }
  });
  dialog.show();
  nameField.el.focus();
}

// ── the live run-status banner (the user must SEE it is working) ──────────
const runStatusEl = document.getElementById("run-status");
function renderRunStatus(s) {
  if (!runStatusEl) return;
  const state = s?.state;
  if (!state || state === "idle") { runStatusEl.hidden = true; runStatusEl.replaceChildren(); return; }
  runStatusEl.hidden = false;
  runStatusEl.className = "run-status" + (state === "done" ? " done" : state === "error" ? " error" : "");
  runStatusEl.replaceChildren();
  if (state === "working") {
    // The BeautifulUI-inspired working indicator (a pixel-grid loader + the
    // live activity label), reused from the shared design system.
    const loader = document.createElement("loading-state");
    loader.setAttribute("label", s.activity || "thinking…");
    loader.setAttribute("active", "");
    runStatusEl.append(loader);
  } else {
    const label = document.createElement("span");
    label.className = "rs-label";
    if (state === "done") {
      label.textContent = "Done";
    } else if (state === "error") {
      label.textContent = "Failed — " + (s.message || "error");
    }
    runStatusEl.append(label);
  }
}

/** Run a turn in the thread surface (a new task, or a nudge). */
async function runThreadTurn(text, attachments = []) {
  showThreadView();
  setStatus("running…", false);
  const res = await runConversationTurn(threadConversation, {
    text,
    attachments,
    history: [], // the SW derives the history from the thread when threadId is set
    threadId: currentThreadId,
    onStatus: renderRunStatus,
    agentId: currentAgentId, // null for a thread; set when chatting with a named/background agent
    agentKind: currentAgentKind,
  });
  if (res.ok) {
    if (!currentAgentId) {
      // The SW created (or reused) the thread; capture its id for continuation.
      if (res.threadId) currentThreadId = res.threadId;
      if (res.threadId) {
        const t = await send("thread.get", { id: res.threadId }).catch(() => ({}));
        if (t.thread?.name) threadTitle.textContent = t.thread.name;
      }
      await renderTasks(currentThreadId);
    }
    setStatus("ready");
  } else {
    setStatus("error: " + (res.error ?? "unknown"), false);
  }
}

const composer = document.getElementById("composer");
composer.addEventListener("send", async (ev) => {
  const { text: task, attachments } = ev.detail;
  currentThreadId = null; // a new task → a new thread
  currentAgentId = null; // the hub composer is the MASTER agent, not a named-agent chat
  currentAgentKind = null;
  threadConversation.clear?.();
  threadTitle.textContent = "New task";
  await runThreadTurn(task, attachments);
});
composer.addEventListener("status", (ev) => {
  if (ev.detail?.text) setStatus(ev.detail.text, false);
});

threadComposer.addEventListener("send", async (ev) => {
  const { text, attachments } = ev.detail;
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

// ── edit the thread title (item 47): click the title OR the Edit button →
//    rename in place. The Edit button (the same visual as the agent's) does the
//    SAME rename for a TASK; for a NAMED agent it opens the agent config. ─────
function startTitleEdit() {
  if (!currentThreadId) return;
  if (threadTitle.querySelector("input")) return; // already editing
  const original = threadTitle.textContent || "Task";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "title-edit";
  input.value = original;
  input.setAttribute("aria-label", "Rename task");
  const restore = (text) => threadTitle.replaceChildren(document.createTextNode(text));
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

renderSiteAgents();
renderNamedAgents();
renderBackgroundAgents();
renderArtifacts();
renderTasks();
renderRunLog();

// Re-render the named agents (main area + the sidebar) when the registry
// changes — a task that creates an agent must show it in the sidebar without a
// page reload. The SW broadcasts a named-agent-changed progress event on
// create/update/delete (the registry lives in the all-optional storage, so
// chrome.storage.onChanged may never fire).
subscribeProgress((ev) => {
  if (ev?.type === "named-agent-changed") renderNamedAgents();
});

// ── the task sidebar: collapse/expand + new-task (item 6/7) ──────────────
const side = document.getElementById("side");
const sideToggle = document.getElementById("side-toggle");
let sidebarCollapsed = false;
function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  side.classList.toggle("collapsed", collapsed);
  sideToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sideToggle.setAttribute("aria-expanded", String(!collapsed));
}
sideToggle?.addEventListener("click", () => {
  withViewTransition(() => setSidebarCollapsed(!sidebarCollapsed));
});

// The "+" new-task button returns to the hub + focuses the composer. When the
// user is inside a task thread, it also closes the thread view so the composer
// (on the hub) can receive focus (item 26).
document.getElementById("new-task")?.addEventListener("click", () => {
  if (!threadView.hidden) hideThreadView();
  composer.focus();
});

// The "+" create-agent button in the sidebar Agents section (item: a quick
// create path — opens the create dialog; it returns to the hub first so the
// dialog is not stacked behind the thread overlay).
document.getElementById("new-agent")?.addEventListener("click", () => {
  if (!threadView.hidden) hideThreadView();
  openQuickCreateAgent();
});

// ── View Transitions (item 8): smooth in-page state changes, reduced-motion aware.
// Named elements let the thread body + composer morph between the hub and the
// full-screen thread. No-op when the API is absent or reduced-motion is on.
//
// Guard against a transition already in flight: rapid view switches (task →
// agent → recipes) call startViewTransition while the previous transition is
// still capturing, which the browser aborts with "invalid state snapshot" /
// "Capture failed" and throws. When one is active we skip straight to the
// state change (no transition) rather than abort the running one.
let viewTransitionActive = false;
function withViewTransition(fn) {
  if (
    typeof document.startViewTransition !== "function" ||
    prefersReducedMotion() ||
    viewTransitionActive
  ) {
    fn();
    return;
  }
  viewTransitionActive = true;
  try {
    const t = document.startViewTransition(() => fn());
    // A transition that never settles must not throw; clear the guard either
    // way so a later state change can use a transition again.
    t?.finished?.finally(() => { viewTransitionActive = false; });
  } catch {
    // startViewTransition threw (invalid snapshot/state) — apply the change
    // without a transition and release the guard.
    viewTransitionActive = false;
    fn();
  }
}

// ── in-context navigation (no new tabs) ─────────────────────────────────
const viewOverlay = document.getElementById("view");
const viewFrame = document.getElementById("view-frame");
const viewTitle = document.getElementById("view-title");

function openView(path, title) {
  viewFrame.src = chrome.runtime.getURL(path);
  viewTitle.textContent = title;
  withViewTransition(() => {
    // Only ONE overlay at a time (item 48): the settings/directory/recipes
    // view replaces the task thread.
    if (!threadView.hidden) hideThreadViewInner();
    viewOverlay.hidden = false;
  });
  syncViewOpen();
  viewFrame.focus();
}
function closeView() {
  withViewTransition(hideViewInner);
}

document.getElementById("view-back")?.addEventListener("click", closeView);

document.getElementById("open-settings")?.addEventListener(
  "click",
  () => openView("options/options.html", "Settings"),
);
document.getElementById("open-directory")?.addEventListener(
  "click",
  () => openView("directory/directory.html", "Directory"),
);
document.getElementById("open-recipes")?.addEventListener(
  "click",
  () => openView("recipes/index.html", "Skills"),
);

document.getElementById("bg-configure")?.addEventListener(
  "click",
  (e) => { e.preventDefault(); openView("options/options.html", "Settings"); },
);

document.getElementById("browse-artifacts")?.addEventListener(
  "click",
  (e) => { e.preventDefault(); openView("artifacts/index.html", "Artifacts"); },
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
  const full = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
  const asset = full?.ok ? full.asset : null;
  if (!asset) { setStatus("Artifact not found", false); return; }
  const mime = type === "html" ? "text/html" : type === "json" ? "application/json" : type === "image" ? "image/png" : "text/plain";
  composer.addAttachment({
    name: asset.name ?? name ?? "artifact",
    type: mime,
    size: asset.size ?? 0,
    kind: "file",
    dataURL: assetDataURL(type, asset.content),
    content: asset.content,
  });
  closeView();
  setStatus(`Attached "${asset.name ?? name}" to a new task`);
  setTimeout(() => composer.input?.focus?.(), 0);
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
handleOmniboxEntry().catch((e) => console.error("omnibox entry failed", e?.message ?? e));

// ---- agent-script host (the on-demand fallback) ---------------------
// The SW broadcasts `cap:script-run`; the offscreen document is the production
// host for scheduled runs, and THIS page is the on-demand fallback (so a
// script run from the hub works even where chrome.offscreen is unavailable).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
  handleScriptRunMessage(message, sendResponse)
);

// ntp/ntp.js — the hub page wiring. The hub is a COMMAND CENTER:
//   header → composer (the hero) → Tasks (the distinct task threads) →
//   background agents (scheduled, toggle) → site agents (enrolled origins) →
//   recent artifacts. A task is a DISTINCT THREAD: starting one opens a
//   full-screen thread surface (the conversation + a composer to nudge/continue),
//   and the hub lists every prior thread (auto-named).

import { send } from "../lib/messages.js";
import { runConversationTurn } from "../shared/conversation.js";

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
  const agents = Array.isArray(res.agents) ? res.agents : [];
  el.replaceChildren();
  if (!agents.length) {
    el.innerHTML = `<div class="empty">No sites enrolled yet. Visit a site to give it a sub-agent.</div>`;
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
  if (!el) return;
  const res = await send("named-agent.list").catch(() => ({ agents: [] }));
  const agents = Array.isArray(res.agents) ? res.agents : [];
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
      row.setAttribute("action", "run");
      row.addEventListener("run", () => openView("directory/directory.html", "Agents"));
      el.append(row);
    }
    if (agents.length > 6) {
      const more = document.createElement("div");
      more.className = "empty";
      more.textContent = `+ ${agents.length - 6} more`;
      el.append(more);
    }
  }
  refreshAgentCount();
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
      row.setAttribute("action", "toggle");
      if (a.enabled) row.setAttribute("enabled", "");
      if (a.schedule?.periodInMinutes) {
        row.setAttribute("last-run", `every ${a.schedule.periodInMinutes} min`);
      }
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
    row.setAttribute("action", "run");
    row.addEventListener("run", () =>
      openView(`artifact/artifact.html?id=${encodeURIComponent(a.id ?? a.name)}&origin=master`, a.name ?? "Artifact"));
    el.append(row);
  }
}

// ── Recent activity (the agent run log — item 16) ────────────────────────
// Shows what the agents DID (task / result / tool-call / tool-result /
// screenshot entries, most-recent-first) so a background agent's work is
// visible even without a live UI.
function runLogText(entry) {
  switch (entry?.type) {
    case "task": return entry.task || "";
    case "result": return entry.result || "";
    case "tool-call": return (entry.tool || "tool") + (entry.args ? `(${entry.args})` : "");
    case "tool-result": return (entry.tool || "tool") + (entry.result ? ` → ${entry.result}` : "");
    case "screenshot": return entry.url || "screenshot";
    default: return entry?.type || "";
  }
}
async function renderRunLog() {
  const el = document.getElementById("run-log");
  if (!el) return;
  const res = await send("run-log.list").catch(() => ({ entries: [] }));
  const entries = Array.isArray(res.entries) ? res.entries : [];
  el.replaceChildren();
  if (!entries.length) {
    el.innerHTML = `<div class="empty">No activity yet — agents you run will show up here.</div>`;
    return;
  }
  for (const e of entries.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "rl";
    const kind = document.createElement("span");
    kind.className = "rl-kind " + (e.type || "");
    kind.textContent = e.type || "";
    const text = document.createElement("span");
    text.className = "rl-text";
    text.textContent = runLogText(e);
    text.title = runLogText(e);
    const ts = document.createElement("span");
    ts.className = "rl-ts";
    ts.textContent = timeAgo(e.ts);
    row.append(kind, text, ts);
    el.append(row);
  }
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
    name.append(dot, document.createTextNode(t.name || "Task"));
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
let currentThreadId = null;

function showThreadView() {
  withViewTransition(() => { threadView.hidden = false; });
}
function hideThreadView() {
  withViewTransition(() => {
    threadView.hidden = true;
    currentThreadId = null;
    threadConversation.clear?.();
  });
}

async function openThread(id) {
  currentThreadId = id;
  const res = await send("thread.get", { id }).catch(() => ({ ok: false }));
  const thread = res.ok ? res.thread : null;
  threadTitle.textContent = thread?.name || "Task";
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  threadConversation.setMessages?.(
    messages.map((m) => ({ role: m.role, content: m.content })),
  );
  showThreadView();
  renderTasks(id);
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
  });
  if (res.ok) {
    // The SW created (or reused) the thread; capture its id for continuation.
    if (res.threadId) currentThreadId = res.threadId;
    if (res.threadId) {
      const t = await send("thread.get", { id: res.threadId }).catch(() => ({}));
      if (t.thread?.name) threadTitle.textContent = t.thread.name;
    }
    setStatus("ready");
    await renderTasks(currentThreadId);
  } else {
    setStatus("error: " + (res.error ?? "unknown"), false);
  }
}

const composer = document.getElementById("composer");
composer.addEventListener("send", async (ev) => {
  const { text: task, attachments } = ev.detail;
  currentThreadId = null; // a new task → a new thread
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

renderSiteAgents();
renderNamedAgents();
renderBackgroundAgents();
renderArtifacts();
renderTasks();
renderRunLog();

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

// ── View Transitions (item 8): smooth in-page state changes, reduced-motion aware.
// Named elements let the thread body + composer morph between the hub and the
// full-screen thread. No-op when the API is absent or reduced-motion is on.
function withViewTransition(fn) {
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    fn();
    return;
  }
  const t = document.startViewTransition(() => fn());
  t.finished?.catch(() => { /* a transition that never settles must not throw */ });
}

// ── in-context navigation (no new tabs) ─────────────────────────────────
const viewOverlay = document.getElementById("view");
const viewFrame = document.getElementById("view-frame");
const viewTitle = document.getElementById("view-title");

function openView(path, title) {
  viewFrame.src = chrome.runtime.getURL(path);
  viewTitle.textContent = title;
  withViewTransition(() => { viewOverlay.hidden = false; });
  viewFrame.focus();
}
function closeView() {
  withViewTransition(() => {
    viewOverlay.hidden = true;
    viewFrame.src = "about:blank";
  });
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
  () => openView("recipes/index.html", "Recipes"),
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

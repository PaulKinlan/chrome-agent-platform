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

function setStatus(text, ready = true) {
  statusEl.innerHTML =
    `<span class="dot"></span>${escapeHtml(text || "ready")}`;
  statusEl.querySelector(".dot").style.background = ready
    ? "var(--accent2)"
    : "var(--danger)";
  document.querySelector(".composer")?.classList.toggle("glow", !ready);
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

// ── site agents (enrolled origins) ────────────────────────────────────────
async function renderSiteAgents() {
  const el = document.getElementById("site-agents");
  const count = document.getElementById("site-agent-count");
  if (!el) return;
  const res = await send("agent.directory").catch(() => ({ agents: [] }));
  const agents = Array.isArray(res.agents) ? res.agents : [];
  if (count) count.textContent = agents.length
    ? `${agents.length} enrolled`
    : "";
  el.replaceChildren();
  if (!agents.length) {
    el.innerHTML = `<div class="empty">No sites enrolled yet. Visit a site to give it a sub-agent.</div>`;
    return;
  }
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
    row.setAttribute("name", a.name);
    row.setAttribute("description", a.type + " · " + a.size + " B");
    row.setAttribute("icon", "");
    row.setAttribute("action", "run");
    row.addEventListener("run", () => openView("options/options.html", "Settings"));
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
    const item = document.createElement("button");
    item.type = "button";
    item.className = "thread-item";
    if (activeId && t.id === activeId) item.setAttribute("aria-current", "true");
    const dotState =
      t.status === "running" ? "running" : t.status === "error" ? "error" : "";
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
    item.append(name, preview, meta);
    item.addEventListener("click", () => openThread(t.id));
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
  threadView.hidden = false;
}
function hideThreadView() {
  threadView.hidden = true;
  currentThreadId = null;
  threadConversation.clear?.();
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
renderArtifacts();
renderTasks();

// ── in-context navigation (no new tabs) ─────────────────────────────────
const viewOverlay = document.getElementById("view");
const viewFrame = document.getElementById("view-frame");
const viewTitle = document.getElementById("view-title");

function openView(path, title) {
  viewFrame.src = chrome.runtime.getURL(path);
  viewTitle.textContent = title;
  viewOverlay.hidden = false;
  viewFrame.focus();
}
function closeView() {
  viewOverlay.hidden = true;
  viewFrame.src = "about:blank";
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

setStatus("ready");

// Transparency surface: capture the page's own errors/CSP violations into the
// shared console + keep the shield/console badges live.
installPageDiagnostics();
refreshDiagnostics().catch(() => {});
startDiagnosticPolling();

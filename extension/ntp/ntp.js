// ntp/ntp.js — the hub page wiring. The hub is a COMMAND CENTER:
//   header → composer (the hero) → "Now" (the active conversation) →
//   background agents (scheduled, toggle) → site agents (enrolled origins) →
//   recent artifacts. On-demand recipes live on their own documented page
//   (recipes/) and are reached via the /task:name command, not the hub.

import { send } from "../lib/messages.js";
import {
  runConversationTurn,
  renderJournal,
  loadJournal,
  historyFromJournal,
} from "../shared/conversation.js";

import { RECIPE_ICON } from "../shared/recipe-icons.js";

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

// ── background agents (scheduled recipes, a toggle each) ────────────────
async function renderBackgroundAgents() {
  const el = document.getElementById("background-agents");
  if (!el) return;
  const res = await send("background-agent.list").catch(() => ({ agents: [] }));
  const agents = Array.isArray(res.agents) ? res.agents : [];
  el.replaceChildren();
  if (!agents.length) {
    el.innerHTML = `<div class="empty">No background agents. Browse recipes to enable one.</div>`;
    return;
  }
  for (const a of agents) {
    const row = document.createElement("capability-row");
    row.setAttribute("name", a.name);
    row.setAttribute("description", a.description || "");
    row.setAttribute("icon", RECIPE_ICON[a.icon] ?? "");
    row.setAttribute("action", "toggle");
    if (a.enabled) row.setAttribute("enabled", "");
    if (a.schedule?.periodInMinutes) {
      row.setAttribute(
        "last-run",
        `runs every ${a.schedule.periodInMinutes} min`,
      );
    }
    row.addEventListener("toggle", async (e) => {
      const enabled = e.detail.enabled;
      const out = await send("background-agent.set", { id: a.id, enabled });
      if (!out?.ok) {
        setStatus("error: " + (out?.error ?? "unknown"), false);
        return;
      }
      setStatus(enabled ? `${a.name} enabled` : `${a.name} disabled`);
      renderBackgroundAgents();
    });
    el.append(row);
  }
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
    row.addEventListener("run", () => {
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL("directory/directory.html") });
      } catch {
        window.open(chrome.runtime.getURL("directory/directory.html"), "_blank");
      }
    });
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
    row.addEventListener("run", () => {
      chrome.runtime.openOptionsPage();
    });
    el.append(row);
  }
}

// ── conversation (the "Now" view) ────────────────────────────────────────
const conversationEl = document.getElementById("conversation");

async function refreshTasks() {
  const journal = await loadJournal();
  renderJournal(conversationEl, journal);
  if (!conversationEl.children.length) {
    conversationEl.innerHTML = `<div class="empty">Nothing yet — start with the composer above.</div>`;
  }
}

const composer = document.getElementById("composer");
composer.addEventListener("send", async (ev) => {
  const { text: task, attachments } = ev.detail;
  setStatus("running…", false);
  const history = historyFromJournal(await loadJournal());
  const res = await runConversationTurn(conversationEl, {
    text: task,
    attachments,
    history,
  });
  if (res.ok) {
    if (
      Array.isArray(res.droppedAttachments) && res.droppedAttachments.length
    ) {
      setStatus(
        `ready — ${res.droppedAttachments.length} attachment(s) dropped (over limit)`,
      );
    } else {
      setStatus("ready");
    }
    await refreshTasks();
  } else {
    setStatus("error: " + (res.error ?? "unknown"), false);
  }
});
composer.addEventListener("status", (ev) => {
  if (ev.detail?.text) setStatus(ev.detail.text, false);
});

renderBackgroundAgents();
renderSiteAgents();
renderArtifacts();
refreshTasks();

document.getElementById("open-settings")?.addEventListener(
  "click",
  () => chrome.runtime.openOptionsPage(),
);
document.getElementById("open-directory")?.addEventListener("click", () => {
  try {
    chrome.tabs.create({
      url: chrome.runtime.getURL("directory/directory.html"),
    });
  } catch {
    window.open(chrome.runtime.getURL("directory/directory.html"), "_blank");
  }
});
document.getElementById("open-recipes")?.addEventListener("click", () => {
  try {
    chrome.tabs.create({
      url: chrome.runtime.getURL("recipes/index.html"),
    });
  } catch {
    window.open(chrome.runtime.getURL("recipes/index.html"), "_blank");
  }
});

setStatus("ready");

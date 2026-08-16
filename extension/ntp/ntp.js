// ntp/ntp.js — the hub page wiring. The composer (mic + attach + input + send)
// is the shared component (../shared/composer.js), identical to the chat.

import { send } from "../lib/messages.js";
import {
  runConversationTurn,
  renderJournal,
  loadJournal,
  historyFromJournal,
} from "../shared/conversation.js";

const RECIPE_ICON = {
  broom:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21 3l-9 9-3-3 9-9z"/><path d="M9 12l-6 6a2.5 2.5 0 0 0 3 3l6-6"/><path d="M12 9l3 3"/></svg>',
  doc:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  link:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  books:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  layers:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  pin:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24z"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  target:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  sleep:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  calendar:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  mood:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  translate:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/></svg>',
  quote:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>',
  ask:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  tags:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
};

const statusEl = document.getElementById("status");
const conversationEl = document.getElementById("conversation");
const agentsEl = document.getElementById("site-agents");

function setStatus(text, ready = true) {
  statusEl.textContent = text;
  statusEl.closest(".chip").querySelector(".dot").style.background = ready
    ? "var(--accent2)"
    : "var(--danger)";
  // the "thinking" glow — toggle the halo on the composer while the agent runs
  document.querySelector(".composer")?.classList.toggle("glow", !ready);
}

async function refreshAgents() {
  const origins = await send("tools.allOrigins");
  const list = Array.isArray(origins) ? origins : [];
  agentsEl.replaceChildren();
  if (!list.length) {
    agentsEl.append(
      Object.assign(document.createElement("span"), {
        textContent: "No sites enrolled yet — browse the web to discover them.",
        style: "color:var(--muted)",
      }),
    );
    return;
  }
  for (const origin of list) {
    const tools = await send("tools.list", { origin });
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "agent";
    chip.setAttribute("aria-label", `Use site agent ${origin}`);
    chip.innerHTML = `<span class="name">@${
      origin.replace(/^https?:\/\//, "").replace(/\/.*/, "")
    }</span><span class="tools">${(Array.isArray(tools)
      ? tools.length
      : 0)} tools</span>`;
    chip.addEventListener("click", () => {
      composer.input.value = `@${origin} `;
      composer.input.focus();
    });
    agentsEl.append(chip);
  }
}

async function refreshRecipes() {
  const recipesEl = document.getElementById("recipes");
  if (!recipesEl) return;
  const res = await send("recipe.list");
  const list = Array.isArray(res.recipes) ? res.recipes : [];
  const onDemand = list.filter((r) => r.mode !== "background");
  recipesEl.replaceChildren();
  // Group on-demand recipes by category.
  const categories = {};
  for (const r of onDemand) {
    const cat = r.category ?? "other";
    (categories[cat] ??= []).push(r);
  }
  for (const cat of Object.keys(categories)) {
    const label = document.createElement("div");
    label.className = "tag";
    label.textContent = cat[0].toUpperCase() + cat.slice(1);
    recipesEl.append(label);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:4px";
    for (const r of categories[cat]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.style.cursor = "pointer";
      chip.setAttribute("aria-label", `Run recipe ${r.name}`);
      chip.innerHTML = `<span class="chip-icon">${
        RECIPE_ICON[r.icon] ?? ""
      }</span><span>${escapeHtml(r.name)}</span>`;
      chip.addEventListener("click", async () => {
        setStatus(`running recipe: ${r.name}`, false);
        const out = await send("recipe.run", { id: r.id });
        if (out.ok) {
          setStatus("agent ready");
          await refreshTasks();
        } else setStatus("error: " + (out.error ?? "unknown"), false);
      });
      row.append(chip);
    }
    recipesEl.append(row);
  }
}

async function refreshBackgroundAgents() {
  const el = document.getElementById("background-agents");
  if (!el) return;
  const res = await send("background-agent.list");
  const list = Array.isArray(res.agents) ? res.agents : [];
  el.replaceChildren();
  for (const a of list) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:8px;justify-content:space-between;padding:8px;border:1px solid var(--border);border-radius:8px;";
    const left = document.createElement("div");
    left.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0";
    left.innerHTML = `<span class="chip-icon">${
      RECIPE_ICON[a.icon] ?? ""
    }</span><span><strong>${escapeHtml(
      a.name,
    )}</strong><br><span style="color:var(--muted);font-size:12px">${escapeHtml(
      a.description ?? "",
    )}</span></span>`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = a.enabled ? "btn" : "btn ghost";
    toggle.setAttribute("aria-pressed", String(Boolean(a.enabled)));
    toggle.setAttribute(
      "aria-label",
      `${a.enabled ? "Disable" : "Enable"} ${a.name}`,
    );
    toggle.textContent = a.enabled ? "Enabled" : "Enable";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      const out = await send("background-agent.set", {
        id: a.id,
        enabled: !a.enabled,
      });
      toggle.disabled = false;
      if (!out?.ok) {
        setStatus("agent error: " + (out?.error ?? "unknown"), false);
        return;
      }
      await refreshBackgroundAgents();
      setStatus(out.enabled ? `${a.name} enabled` : `${a.name} disabled`);
    });
    row.append(left, toggle);
    el.append(row);
  }
}

async function refreshTasks() {
  const journal = await loadJournal();
  renderJournal(conversationEl, journal);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

// The shared composer Web Component: identical (mic + attach + input + send)
// to the chat surface. The element is declared in ntp.html as <agent-composer>.
//
// The run flow is the unified conversational surface: a task start appends the
// user turn + streams the agent's live progress into the conversation (the
// surface TRANSFORMS into a live conversation), and the composer stays live for
// a mid-run nudge / follow-up.
const composer = document.getElementById("composer");

composer.addEventListener("send", async (ev) => {
  const { text: task, attachments } = ev.detail;
  setStatus("running task…", false);
  // Carry the prior conversation as history so a follow-up is a new turn in the
  // SAME thread (the agent sees what came before).
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
        `agent ready — ${res.droppedAttachments.length} attachment(s) dropped (over limit)`,
      );
    } else {
      setStatus("agent ready");
    }
    await refreshTasks();
  } else {
    setStatus("error: " + (res.error ?? "unknown"), false);
  }
});
composer.addEventListener("status", (ev) => {
  if (ev.detail?.text) setStatus(ev.detail.text, false);
});

refreshRecipes();
refreshAgents();
refreshBackgroundAgents();
refreshTasks();

// Browser-control grant: a user-facing toggle that scopes destructive browser tools.
async function refreshGrantUI() {
  const r = await chrome.runtime.sendMessage({ type: "browser-control.get" })
    .catch(() => ({ active: false }));
  const el = document.getElementById("browser-control-grant");
  if (el) el.checked = Boolean(r?.active);
}
document.getElementById("browser-control-grant")?.addEventListener(
  "change",
  async (e) => {
    const res = await chrome.runtime.sendMessage({
      type: "browser-control.set",
      granted: e.target.checked,
    }).catch((err) => ({ grant: { revoked: false, error: String(err?.message ?? err) } }));
    if (e.target.checked === false && res?.grant?.revoked !== true) {
      e.target.checked = true; // revoke failed → keep the grant visible
    }
    await refreshGrantUI();
  },
);
refreshGrantUI();

document.getElementById("open-settings")?.addEventListener(
  "click",
  () => chrome.runtime.openOptionsPage(),
);
document.getElementById("open-memory").addEventListener(
  "click",
  () => chrome.runtime.openOptionsPage(),
);
document.getElementById("open-directory").addEventListener(
  "click",
  () => {
    try {
      chrome.tabs.create({
        url: chrome.runtime.getURL("directory/directory.html"),
      });
    } catch {
      window.open(chrome.runtime.getURL("directory/directory.html"), "_blank");
    }
  },
);

(async () => {
  const cfg = await send("provider.summary");
  const nameEl = document.getElementById("provider-name");
  if (nameEl && cfg && cfg.provider) {
    nameEl.textContent = cfg.provider;
  }
  refreshAgents();
  refreshTasks();
  setStatus("agent ready");
})();

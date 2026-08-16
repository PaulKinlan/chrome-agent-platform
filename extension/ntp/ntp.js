// ntp/ntp.js — the hub page wiring. The composer (mic + attach + input + send)
// is the shared component (../shared/composer.js), identical to the chat.

import { send } from "../lib/messages.js";

const RECIPE_ICON = {
  broom:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21 3l-9 9-3-3 9-9z"/><path d="M9 12l-6 6a2.5 2.5 0 0 0 3 3l6-6"/><path d="M12 9l3 3"/></svg>',
  doc:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  link:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  books:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
};

const statusEl = document.getElementById("status");
const tasksEl = document.getElementById("tasks");
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
  recipesEl.replaceChildren();
  for (const r of list) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.style.cursor = "pointer";
    chip.innerHTML = `<span class="chip-icon">${
      RECIPE_ICON[r.icon] ?? ""
    }</span><span>${escapeHtml(r.name)}</span>`;
    chip.onclick = async () => {
      setStatus(`running recipe: ${r.name}`, false);
      const out = await send("recipe.run", { id: r.id });
      if (out.ok) {
        setStatus("agent ready");
        await refreshTasks();
      } else setStatus("error: " + (out.error ?? "unknown"), false);
    };
    recipesEl.append(chip);
  }
}

async function refreshTasks() {
  const journal = await send("memory.get", {
    origin: "master",
    key: "journal",
  });
  const rows = Array.isArray(journal) ? journal : [];
  tasksEl.replaceChildren();
  if (!rows.length) {
    tasksEl.append(
      Object.assign(document.createElement("p"), {
        textContent: "No tasks yet — start one above.",
        style: "color:var(--muted)",
      }),
    );
    return;
  }
  for (const r of rows.slice(-10).reverse()) {
    const div = document.createElement("div");
    div.className = "task";
    const text = (() => {
      if (typeof r !== "object" || r === null) return String(r);
      if (typeof r.task === "string" && r.task) return r.task;
      if (typeof r.result === "string") return r.result;
      return "(entry)";
    })();
    const kind = r?.type === "result"
      ? "result"
      : (r?.scheduled ? "scheduled" : "task");
    div.innerHTML = `<div class="t">${
      escapeHtml(text)
    }</div><div class="meta">${kind}</div>`;
    tasksEl.append(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

// The shared composer Web Component: identical (mic + attach + input + send)
// to the chat surface. The element is declared in ntp.html as <agent-composer>.
const composer = document.getElementById("composer");

composer.addEventListener("send", async (ev) => {
  const { text: task, attachments } = ev.detail;
  setStatus("running task…", false);
  const res = await send("agent.run", {
    task,
    id: String(Date.now()),
    attachments,
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

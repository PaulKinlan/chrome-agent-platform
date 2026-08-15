// options.js — the dedicated settings/configuration page.

import { getProviderConfig, setProviderConfig } from "../lib/provider.js";
import { clearUsage, getUsage } from "../lib/usage.js";
import { listOrigins, siteMemory } from "../lib/memory.js";
import {
  isBrowserControlGranted,
  revokeBrowserControlGrant,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
} from "../lib/browser-tools.js";
import { RECIPES } from "../lib/recipes.js";

// ── Provider presets (the user picks one; OpenAI-compatible endpoints) ──
const PROVIDERS = [
  {
    id: "demo",
    name: "Demo (local)",
    hint: "Deterministic local model — no key, always runs.",
    baseURL: "",
    needsKey: false,
    onDevice: false,
  },
  {
    id: "prompt-api",
    name: "Chrome Prompt API",
    hint: "Gemini nano on-device — no key, works offline.",
    baseURL: "",
    needsKey: false,
    onDevice: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    hint: "Your OpenAI key + model.",
    baseURL: "https://api.openai.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "Your Anthropic key (OpenAI-compatible endpoint).",
    baseURL: "https://api.anthropic.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "Your Gemini API key (OpenAI-compatible endpoint).",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    needsModel: true,
    onDevice: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "Your DeepSeek key + model.",
    baseURL: "https://api.deepseek.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    hint: "A local Ollama server.",
    baseURL: "http://localhost:11434/v1",
    needsKey: false,
    needsModel: true,
    onDevice: false,
  },
];

const THEMES = [
  { id: "midnight", label: "Midnight", swatch: "#0d1117,#58a6ff" },
  { id: "sunlit", label: "Sunlit", swatch: "#ffffff,#0969da" },
  { id: "neon", label: "Neon", swatch: "#0a0a12,#ff3ea5" },
  { id: "terminal", label: "Terminal", swatch: "#0c0c0c,#4ec9b0" },
];

const $ = (sel) => document.querySelector(sel);
const storage = chrome.storage.local;

// ── Providers ──
async function renderProviders() {
  const cfg = await getProviderConfig();
  const list = $("#provider-list");
  list.innerHTML = "";
  for (const p of PROVIDERS) {
    const card = document.createElement("div");
    card.className = "provider-card" + (cfg.provider === p.id ? " active" : "");
    card.dataset.provider = p.id;
    card.innerHTML = `
      <div class="provider-head">
        <span class="provider-name">${p.name}</span>
        <span class="muted">${p.hint}</span>
        <button class="btn small set-default" type="button">${
      cfg.provider === p.id ? "Update" : "Use"
    }</button>
      </div>
      ${
      p.needsKey || p.onDevice || p.id === "openai" || p.id === "ollama"
        ? `
      <div class="fields">
        ${
          p.needsKey || p.needsModel || p.baseURL || p.needsModel
            ? `<input class="base-url" type="text" placeholder="Base URL" value="${
              // The ACTIVE card shows the STORED endpoint (not the preset) so an
              // Update never silently resets a custom base URL.
              escapeAttr(cfg.provider === p.id ? (cfg.baseURL || p.baseURL) : p.baseURL)
            }">`
            : ""
        }
        ${
          p.needsKey || p.needsModel
            ? `<input class="api-key" type="password" placeholder="API key" autocomplete="off">`
            : ""
        }
        ${
          p.needsKey || p.needsModel
            ? `<input class="model" type="text" placeholder="Model id" value="${
              escapeAttr(cfg.provider === p.id ? cfg.model : "")
            }">`
            : ""
        }
      </div>`
        : ""
    }
    `;
    card.querySelector(".set-default")?.addEventListener("click", async () => {
      // Preserve the EXISTING stored key when the field is left blank (an Update
      // must not wipe a configured credential). An explicit clear control is the
      // only way to remove a key.
      const isActive = cfg.provider === p.id;
      const keyInput = card.querySelector(".api-key");
      const enteredKey = keyInput?.value ?? "";
      const apiKey = enteredKey
        ? enteredKey
        : (isActive && cfg.apiKey ? cfg.apiKey : "");
      const fields = {
        baseURL: card.querySelector(".base-url")?.value ?? (isActive ? (cfg.baseURL || p.baseURL) : p.baseURL),
        apiKey,
        model: card.querySelector(".model")?.value ?? (isActive ? (cfg.model || "") : ""),
      };
      // Route through the worker's provider.set so the running agent's cached
      // model/orchestrator is invalidated immediately (no stale provider).
      await chrome.runtime.sendMessage({
        type: "provider.set",
        config: { provider: p.id, ...fields },
      });
      await saveFlash(isActive ? `Updated ${p.name}.` : `Set ${p.name} as default.`);
      renderProviders();
    });
    list.appendChild(card);
  }
  // populate the active card's current key/model + an explicit clear-key control
  const active = list.querySelector(
    `.provider-card[data-provider="${cfg.provider}"]`,
  );
  if (active) {
    if (cfg.apiKey) {
      const k = active.querySelector(".api-key");
      if (k) k.placeholder = "API key (set — leave blank to keep)";
    }
    const clear = document.createElement("button");
    clear.className = "btn ghost small clear-key";
    clear.type = "button";
    clear.textContent = "Clear key";
    clear.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "provider.set",
        config: { provider: cfg.provider, baseURL: cfg.baseURL, apiKey: "", model: cfg.model },
      });
      saveFlash("API key cleared.");
      renderProviders();
    });
    active.querySelector(".provider-head")?.appendChild(clear);
  }
}

// ── Agents ──
async function renderAgents() {
  const s = await storage.get("cap:multiAgent");
  $("#multi-agent").checked = Boolean(s["cap:multiAgent"]);
  $("#multi-agent").addEventListener("change", async (e) => {
    await storage.set({ "cap:multiAgent": e.target.checked });
    $("#per-agent-provider").hidden = !e.target.checked;
    // Rebuild the running orchestrator so the fan-out / solo switch takes effect
    // immediately (the worker reads cap:multiAgent at orchestration time).
    try {
      await chrome.runtime.sendMessage({ type: "invalidate-agent" });
    } catch {
      /* worker may not be running yet — the setting still persists */
    }
    saveFlash("Agent mode saved.");
  });
  $("#per-agent-provider").hidden = !$("#multi-agent").checked;

  // Per-agent provider assignment is TODO: it needs COMPLETE provider-specific
  // configs keyed by provider/agent (never one global {baseURL,apiKey,model}
  // that could mix one provider's credential with another's endpoint). Until
  // then, a single safe global provider is used for every agent.
  const list = $("#agent-provider-list");
  list.innerHTML = "";
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "Per-agent provider assignment is planned but not enabled yet — every agent uses the global provider for now.";
  list.appendChild(note);
}

// ── Appearance ──
async function renderAppearance() {
  const s = await storage.get("cap:theme");
  const current = s["cap:theme"] ?? "midnight";
  const grid = $("#theme-grid");
  grid.innerHTML = "";
  for (const t of THEMES) {
    const card = document.createElement("div");
    card.className = "theme-card" + (current === t.id ? " active" : "");
    card.innerHTML = `
      <div class="theme-swatch" style="background: linear-gradient(135deg, ${t.swatch})"></div>
      <div class="theme-label">${t.label}</div>`;
    card.addEventListener("click", async () => {
      await storage.set({ "cap:theme": t.id });
      document.documentElement.dataset.theme = t.id;
      renderAppearance();
      saveFlash(`Theme: ${t.label}.`);
    });
    grid.appendChild(card);
  }
  document.documentElement.dataset.theme = current;
}

// ── Browser control ──
async function renderBrowser() {
  const s = await storage.get("cap:browserControlGrant");
  const grant = s["cap:browserControlGrant"];
  const granted = Boolean(grant && grant.expiresAt > Date.now());
  $("#browser-grant").checked = granted;
  $("#grant-origins").hidden = !granted;
  if (grant?.origins?.length) {
    $("#grant-origin-list").value = grant.origins.join("\n");
  }
  $("#browser-grant").addEventListener("change", async (e) => {
    if (e.target.checked) {
      await setGlobalBrowserControlGrant();
      $("#grant-origins").hidden = false;
      saveFlash(
        "Browser control granted (global, 15 min — set origins below to scope it).",
      );
    } else {
      await revokeBrowserControlGrant();
      $("#grant-origins").hidden = true;
      saveFlash("Browser control revoked.");
    }
  });
  $("#grant-origin-list").addEventListener("change", async (e) => {
    const origins = e.target.value.split("\n").map((s) => s.trim()).filter(
      Boolean,
    );
    if (origins.length > 0) {
      await setOriginBrowserControlGrant(origins);
      saveFlash(
        "Allowed origins saved (scoped to " + origins.length + " origin(s)).",
      );
    } else {
      await setGlobalBrowserControlGrant();
      saveFlash("No origins listed — reverted to a global grant.");
    }
  });
}

// ── Usage ──
async function renderUsage() {
  const u = await getUsage();
  const sum = $("#usage-summary");
  sum.innerHTML = `
    <div class="usage-stat"><div class="n">${u.totals.calls}</div><div class="l">calls</div></div>
    <div class="usage-stat"><div class="n">${
    u.totals.inputTokens + u.totals.outputTokens
  }</div><div class="l">tokens</div></div>
    <div class="usage-stat"><div class="n">$${
    u.totals.estimatedCost.toFixed(4)
  }</div><div class="l">est. cost</div></div>`;
  const detail = $("#usage-detail");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Provider", "Model", "Calls", "Tokens", "Cost"]) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const m of u.byModel) {
    const tr = document.createElement("tr");
    for (
      const v of [
        m.provider,
        m.model,
        String(m.calls),
        String(m.inputTokens + m.outputTokens),
        "$" + m.estimatedCost.toFixed(4),
      ]
    ) {
      const td = document.createElement("td");
      td.textContent = v; // textContent — never interpolate into innerHTML
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  detail.replaceChildren(table);
  $("#usage-detail-toggle").addEventListener("click", () => {
    const d = $("#usage-detail");
    d.hidden = !d.hidden;
    $("#usage-detail-toggle").textContent = d.hidden
      ? "Show detail"
      : "Hide detail";
  });
}

// ── Data / memory ──
async function renderData() {
  const origins = await listOrigins();
  const list = $("#origin-list");
  list.innerHTML = "";
  if (!origins.length) {
    list.innerHTML = `<p class="muted">No per-site memory yet.</p>`;
    return;
  }
  for (const origin of origins) {
    const row = document.createElement("div");
    row.className = "origin-row";
    row.innerHTML =
      `<span class="origin">${origin}</span><button class="btn small ghost clear-origin" type="button">Clear</button>`;
    row.querySelector(".clear-origin").addEventListener("click", async () => {
      const store = siteMemory(origin);
      await store.clear();
      saveFlash(`Cleared memory for ${origin}.`);
      renderData();
    });
    list.appendChild(row);
  }
}

// ── helpers ──
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
let flashTimer;
function saveFlash(msg) {
  const el = $("#save-status");
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.textContent = "Changes save automatically.";
  }, 2500);
}

$("#open-hub").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ntp/ntp.html") });
});

// nav active state
const sections = [
  "providers",
  "agents",
  "appearance",
  "browser",
  "usage",
  "data",
];
document.querySelectorAll(".nav-item").forEach((a) => {
  a.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((x) =>
      x.removeAttribute("aria-current")
    );
    a.setAttribute("aria-current", "true");
  });
});

await renderProviders();
await renderAgents();
await renderAppearance();
await renderBrowser();
await renderUsage();
await renderData();

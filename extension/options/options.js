// options.js — the dedicated settings/configuration page.

import {
  getProviderConfig,
  setProviderConfig,
} from "../lib/provider.js";
import { getUsage, clearUsage } from "../lib/usage.js";
import { listOrigins, siteMemory } from "../lib/memory.js";
import {
  isBrowserControlGranted,
  setBrowserControlGrant,
} from "../lib/browser-tools.js";
import { RECIPES } from "../lib/recipes.js";

// ── Provider presets (the user picks one; OpenAI-compatible endpoints) ──
const PROVIDERS = [
  { id: "demo", name: "Demo (local)", hint: "Deterministic local model — no key, always runs.", baseURL: "", needsKey: false, onDevice: false },
  { id: "prompt-api", name: "Chrome Prompt API", hint: "Gemini nano on-device — no key, works offline.", baseURL: "", needsKey: false, onDevice: true },
  { id: "openai", name: "OpenAI", hint: "Your OpenAI key + model.", baseURL: "https://api.openai.com/v1", needsKey: true, onDevice: false },
  { id: "anthropic", name: "Anthropic", hint: "Your Anthropic key (OpenAI-compatible endpoint).", baseURL: "https://api.anthropic.com/v1", needsKey: true, onDevice: false },
  { id: "gemini", name: "Google Gemini", hint: "Your Gemini API key (OpenAI-compatible endpoint).", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, onDevice: false },
  { id: "deepseek", name: "DeepSeek", hint: "Your DeepSeek key + model.", baseURL: "https://api.deepseek.com/v1", needsKey: true, onDevice: false },
  { id: "ollama", name: "Ollama (local)", hint: "A local Ollama server.", baseURL: "http://localhost:11434/v1", needsKey: false, onDevice: false },
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
        <button class="btn small set-default" type="button" ${cfg.provider === p.id ? "disabled" : ""}>Use</button>
      </div>
      ${p.needsKey || p.onDevice || p.id === "openai" || p.id === "ollama" ? `
      <div class="fields">
        ${p.needsKey || p.baseURL ? `<input class="base-url" type="text" placeholder="Base URL" value="${escapeAttr(p.baseURL)}">` : ""}
        ${p.needsKey ? `<input class="api-key" type="password" placeholder="API key" autocomplete="off">` : ""}
        ${p.needsKey ? `<input class="model" type="text" placeholder="Model id" value="${escapeAttr(cfg.provider === p.id ? cfg.model : "")}">` : ""}
      </div>` : ""}
    `;
    card.querySelector(".set-default")?.addEventListener("click", async () => {
      const fields = {
        baseURL: card.querySelector(".base-url")?.value ?? p.baseURL,
        apiKey: card.querySelector(".api-key")?.value ?? "",
        model: card.querySelector(".model")?.value ?? "",
      };
      await setProviderConfig({ provider: p.id, ...fields });
      await saveFlash(`Set ${p.name} as default.`);
      renderProviders();
    });
    list.appendChild(card);
  }
  // populate the active card's current key/model when openai-ish
  const active = list.querySelector(`.provider-card[data-provider="${cfg.provider}"]`);
  if (active) {
    if (cfg.apiKey) { const k = active.querySelector(".api-key"); if (k) k.placeholder = "API key (set)"; }
  }
}

// ── Agents ──
async function renderAgents() {
  const s = await storage.get("cap:multiAgent");
  $("#multi-agent").checked = Boolean(s["cap:multiAgent"]);
  $("#multi-agent").addEventListener("change", async (e) => {
    await storage.set({ "cap:multiAgent": e.target.checked });
    $("#per-agent-provider").hidden = !e.target.checked;
    saveFlash("Agent mode saved.");
  });
  $("#per-agent-provider").hidden = !$("#multi-agent").checked;

  // per-agent provider list (the recipes + a generic "hub" agent)
  const ap = await storage.get("cap:agentProviders");
  const map = ap["cap:agentProviders"] ?? {};
  const list = $("#agent-provider-list");
  list.innerHTML = "";
  const agents = [{ id: "hub", name: "Hub agent" }, ...RECIPES.map((r) => ({ id: r.id, name: r.name }))];
  for (const a of agents) {
    const row = document.createElement("div");
    row.className = "provider-card";
    row.innerHTML = `
      <div class="provider-head">
        <span class="provider-name">${a.name}</span>
        <select class="agent-provider">
          <option value="">Default</option>
          ${PROVIDERS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}
        </select>
      </div>`;
    const sel = row.querySelector(".agent-provider");
    sel.value = map[a.id] ?? "";
    sel.addEventListener("change", async () => {
      map[a.id] = sel.value || undefined;
      await storage.set({ "cap:agentProviders": map });
      saveFlash("Agent provider saved.");
    });
    list.appendChild(row);
  }
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
  if (grant?.origins?.length) $("#grant-origin-list").value = grant.origins.join("\n");
  $("#browser-grant").addEventListener("change", async (e) => {
    if (e.target.checked) {
      await setBrowserControlGrant({ origins: [] });
      $("#grant-origins").hidden = false;
      saveFlash("Browser control granted (scoped — set origins below).");
    } else {
      await storage.set({ "cap:browserControlGrant": { expiresAt: 0, origins: [] } });
      $("#grant-origins").hidden = true;
      saveFlash("Browser control revoked.");
    }
  });
  $("#grant-origin-list").addEventListener("change", async (e) => {
    const origins = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
    await setBrowserControlGrant({ origins });
    saveFlash("Allowed origins saved.");
  });
}

// ── Usage ──
async function renderUsage() {
  const u = await getUsage();
  const sum = $("#usage-summary");
  sum.innerHTML = `
    <div class="usage-stat"><div class="n">${u.totals.calls}</div><div class="l">calls</div></div>
    <div class="usage-stat"><div class="n">${u.totals.inputTokens + u.totals.outputTokens}</div><div class="l">tokens</div></div>
    <div class="usage-stat"><div class="n">$${u.totals.estimatedCost.toFixed(4)}</div><div class="l">est. cost</div></div>`;
  const detail = $("#usage-detail");
  detail.innerHTML = `<table>
    <thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
    <tbody>${u.byModel.map((m) => `<tr><td>${m.provider}</td><td>${m.model}</td><td>${m.calls}</td><td>${m.inputTokens + m.outputTokens}</td><td>$${m.estimatedCost.toFixed(4)}</td></tr>`).join("")}</tbody></table>`;
  $("#usage-detail-toggle").addEventListener("click", () => {
    const d = $("#usage-detail");
    d.hidden = !d.hidden;
    $("#usage-detail-toggle").textContent = d.hidden ? "Show detail" : "Hide detail";
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
    row.innerHTML = `<span class="origin">${origin}</span><button class="btn small ghost clear-origin" type="button">Clear</button>`;
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
  flashTimer = setTimeout(() => { el.textContent = "Changes save automatically."; }, 2500);
}

$("#open-hub").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ntp/ntp.html") });
});

// nav active state
const sections = ["providers", "agents", "appearance", "browser", "usage", "data"];
document.querySelectorAll(".nav-item").forEach((a) => {
  a.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((x) => x.removeAttribute("aria-current"));
    a.setAttribute("aria-current", "true");
  });
});

await renderProviders();
await renderAgents();
await renderAppearance();
await renderBrowser();
await renderUsage();
await renderData();

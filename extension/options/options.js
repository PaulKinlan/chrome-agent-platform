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
import { kvGet, kvRemove, kvSet } from "../lib/kv.js";
import {
  CAPABILITIES,
  capabilityStatus,
  requestCapability,
} from "../lib/capabilities.js";

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
// The guarded key-value shim: chrome.storage.local is OPTIONAL, so all storage
// access routes through kv.js (which falls back to session memory when the
// storage permission is not yet granted).
const storage = { get: kvGet, set: kvSet, remove: kvRemove };

// ── Providers ──
async function renderProviders(restoreFocus = false) {
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
        <button class="btn small set-default" type="button" aria-label="${
      cfg.provider === p.id ? `Update ${p.name}` : `Use ${p.name}`
    }">${
      cfg.provider === p.id ? "Update" : "Use"
    }</button>
      </div>
      ${
      p.needsKey || p.onDevice || p.id === "openai" || p.id === "ollama"
        ? `
      <fieldset class="fields">
        <legend class="sr-only">${p.name} credentials</legend>
        ${
          p.needsKey || p.needsModel || p.baseURL || p.needsModel
            ? `<label class="field"><span class="field-label">Base URL</span><input class="base-url" type="text" placeholder="https://…" value="${
              // The ACTIVE card shows the STORED endpoint (not the preset) so an
              // Update never silently resets a custom base URL.
              escapeAttr(cfg.provider === p.id ? (cfg.baseURL || p.baseURL) : p.baseURL)
            }"></label>`
            : ""
        }
        ${
          p.needsKey || p.needsModel
            ? `<label class="field"><span class="field-label">API key</span><input class="api-key" type="password" placeholder="…" autocomplete="off"></label>`
            : ""
        }
        ${
          p.needsKey || p.needsModel
            ? `<label class="field"><span class="field-label">Model id</span><input class="model" type="text" placeholder="e.g. gpt-4o-mini" value="${
              escapeAttr(cfg.provider === p.id ? cfg.model : "")
            }"></label>`
            : ""
        }
      </fieldset>`
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
      renderProviders(true);
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
    // A keyless provider (Demo / Prompt API) has nothing to clear — only offer
    // the Clear key control when a key is actually configured (never the
    // contradictory "Clear key" on a keyless provider).
    if (cfg.apiKey) {
      const clear = document.createElement("button");
      clear.className = "btn ghost small clear-key";
      clear.type = "button";
      clear.textContent = "Clear key";
      clear.setAttribute("aria-label", `Clear API key for ${cfg.provider}`);
      clear.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: "provider.set",
          config: { provider: cfg.provider, baseURL: cfg.baseURL, apiKey: "", model: cfg.model },
        });
        saveFlash("API key cleared.");
        renderProviders(true);
      });
      active.querySelector(".provider-head")?.appendChild(clear);
    }
  }
  if (restoreFocus) {
    // Rerender replaces the focused subtree — re-focus the active provider's
    // Set/Update button so a keyboard/AT user is not stranded.
    active?.querySelector(".set-default")?.focus();
  }
}

// ── Site enrollment (owner-driven optional host permission) ──
async function renderEnroll() {
  const input = $("#enroll-origin");
  const btn = $("#enroll-btn");
  btn.addEventListener("click", async () => {
    const raw = input.value.trim();
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      saveFlash("Enter a valid origin, e.g. https://github.com");
      return;
    }
    if (!/^https?:$/.test(new URL(origin).protocol)) {
      saveFlash("Only http/https origins can be enrolled.");
      return;
    }
    const matches = [`${origin}/*`];
    // The OWNER gesture: request the exact origin's host permission from the
    // Settings page (a real user gesture). Only after it is granted do we ask
    // the SW to register the discovery scripts. Never request from the SW.
    let granted;
    try {
      granted = await chrome.permissions.request({ origins: matches });
    } catch (e) {
      saveFlash("Permission request failed: " + String(e?.message ?? e));
      return;
    }
    if (!granted) {
      saveFlash("Host permission not granted — the origin was not enrolled.");
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: "agent.enroll-origin",
      origin,
    }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    input.value = "";
    if (res?.ok) {
      saveFlash(`Enrolled ${origin}${res.scriptsRegistered ? " (scripts registered)" : ""}.`);
      renderData();
    } else {
      saveFlash("Enroll failed: " + (res?.error ?? "unknown"));
    }
  });
}

// ── Agents ──
async function renderAgents() {
  const s = await storage.get("cap:multiAgent");
  $("#multi-agent").checked = s["cap:multiAgent"] !== false;
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
  // then, a single safe global provider is used for every agent. The explanatory
  // note lives in options.html (do NOT append a duplicate here).
  $("#agent-provider-list").replaceChildren();
}

// ── Appearance ──
async function renderAppearance(restoreFocus = false) {
  const s = await storage.get("cap:theme");
  const current = s["cap:theme"] ?? "sunlit";
  const grid = $("#theme-grid");
  grid.innerHTML = "";
  for (const t of THEMES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card" + (current === t.id ? " active" : "");
    card.setAttribute("aria-pressed", String(current === t.id));
    card.innerHTML = `
      <span class="theme-swatch" style="background: linear-gradient(135deg, ${t.swatch})"></span>
      <span class="theme-label">${t.label}</span>`;
    card.addEventListener("click", async () => {
      await storage.set({ "cap:theme": t.id });
      document.documentElement.dataset.theme = t.id;
      renderAppearance(true); // restore focus to the active card after rerender
      saveFlash(`Theme: ${t.label}.`);
    });
    grid.appendChild(card);
  }
  document.documentElement.dataset.theme = current;
  if (restoreFocus) {
    // A rerender replaces the focused subtree — re-focus the (now) active card
    // so a keyboard/AT user is not stranded (the round-13 focus finding).
    grid.querySelector(".theme-card.active")?.focus();
  }
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
      // Screenshot capture uses chrome.tabs.captureVisibleTab (the standard
      // extension API — NOT the Chrome debugger, which cannot be optional and
      // carries Chrome's all-sites warning). It needs the OPTIONAL `tabs`
      // capability, requested HERE (a real user gesture). Denial degrades
      // gracefully: the grant still covers open/navigate/close; only tab
      // listing + screenshots become unavailable.
      let tabsGranted = false;
      try {
        tabsGranted = await chrome.permissions.request({
          permissions: ["tabs"],
        });
      } catch { /* unsupported — tabs stays absent */ }
      await setGlobalBrowserControlGrant();
      $("#grant-origins").hidden = false;
      saveFlash(
        tabsGranted
          ? "Browser control granted (global, 15 min — set origins below to scope it)."
          : "Browser control granted (tab control unavailable — tabs permission not granted).",
      );
      renderPermissions();
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

// ── Permissions (optional capability onboarding) ──
async function renderPermissions() {
  const status = await capabilityStatus();
  const list = $("#permission-list");
  list.replaceChildren();
  for (const cap of CAPABILITIES) {
    const row = document.createElement("div");
    row.className = "perm-row";
    const granted = Boolean(status[cap.id]);

    const name = document.createElement("span");
    name.className = "perm-name";
    name.textContent = cap.label;

    const state = document.createElement("span");
    state.className = "perm-state" + (granted ? " granted" : " missing");
    state.textContent = granted ? "Granted" : "Not granted";

    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = cap.hint;

    row.append(name, state, hint);
    if (!granted) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small grant-perm";
      btn.dataset.capability = cap.id;
      btn.textContent = "Enable";
      btn.setAttribute("aria-label", `Enable ${cap.label}`);
      btn.addEventListener("click", async () => {
        // The real chrome.permissions.request happens here, inside the click
        // handler (a genuine user gesture — the SW can never request).
        const res = await requestCapability(cap.id);
        if (res?.granted) saveFlash(`Enabled ${cap.label}.`);
        else {
          saveFlash(
            `Enable ${cap.label} declined: ${res?.error ?? "not granted"}.`,
          );
        }
        renderPermissions();
      });
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
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
  list.replaceChildren();
  if (!origins.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No enrolled sites yet.";
    list.appendChild(p);
    return;
  }
  for (const origin of origins) {
    const row = document.createElement("div");
    row.className = "origin-row";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin; // textContent — never interpolate an origin
    row.appendChild(label);

    // Clear = clear that origin's memory only (NOT a revocation).
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn small ghost clear-origin";
    clear.textContent = "Clear";
    clear.addEventListener("click", async () => {
      await siteMemory(origin).clear();
      saveFlash(`Cleared memory for ${origin}.`);
      renderData();
    });
    row.appendChild(clear);

    // Disenroll = AUTHORITATIVE revocation: unregister the content scripts,
    // remove the host permission, tombstone the enrollment, and clear OPFS (the
    // agent.delete route). "Clear" alone must never masquerade as revocation.
    const disenroll = document.createElement("button");
    disenroll.type = "button";
    disenroll.className = "btn small ghost disenroll-origin";
    disenroll.textContent = "Disenroll";
    disenroll.setAttribute("aria-label", `Disenroll ${origin}`);
    disenroll.addEventListener("click", async () => {
      const res = await chrome.runtime
        .sendMessage({ type: "agent.delete", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok) {
        saveFlash(
          `Disenrolled ${origin} (scripts + host permission removed).`,
        );
      } else {
        saveFlash(`Disenroll incomplete: ${res?.error ?? "unknown"}.`);
      }
      renderData();
    });
    row.appendChild(disenroll);

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
  "permissions",
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
await renderEnroll();
await renderAppearance();
await renderBrowser();
await renderPermissions();
await renderUsage();
await renderData();

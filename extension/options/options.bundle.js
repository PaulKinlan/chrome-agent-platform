// extension/lib/provider.js
var DEFAULTS = {
  // "demo" | "openai" | "anthropic" | "gemini" | "deepseek" | "ollama" | "prompt-api"
  provider: "demo",
  baseURL: "",
  apiKey: "",
  model: ""
};
async function getProviderConfig() {
  const stored = await chrome.storage.local.get("providerConfig");
  return { ...DEFAULTS, ...stored.providerConfig ?? {} };
}

// extension/lib/usage.js
var STORAGE_KEY = "cairn:usage";
var RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
async function getUsage() {
  const store = await chrome.storage.local.get(STORAGE_KEY);
  const rows = (store[STORAGE_KEY] ?? []).filter(
    (r) => Date.now() - new Date(r.timestamp).getTime() < RETENTION_MS
  );
  const byModel = {};
  const byAgent = {};
  const totals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0
  };
  for (const r of rows) {
    const mk = `${r.provider}/${r.model}`;
    byModel[mk] ??= {
      provider: r.provider,
      model: r.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0
    };
    byModel[mk].calls++;
    byModel[mk].inputTokens += r.inputTokens;
    byModel[mk].outputTokens += r.outputTokens;
    byModel[mk].estimatedCost += r.estimatedCost;
    byAgent[r.agentId] ??= {
      agentId: r.agentId,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0
    };
    byAgent[r.agentId].calls++;
    byAgent[r.agentId].inputTokens += r.inputTokens;
    byAgent[r.agentId].outputTokens += r.outputTokens;
    totals.calls++;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.estimatedCost += r.estimatedCost;
  }
  return {
    totals,
    byModel: Object.values(byModel),
    byAgent: Object.values(byAgent),
    rows
  };
}

// extension/lib/memory.js
var ROOT = "memory";
var MASTER = "master";
function canonicalOrigin(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
function encodeOrigin(origin) {
  return encodeURIComponent(origin);
}
function decodeOrigin(encoded) {
  return decodeURIComponent(encoded);
}
async function openDir(segments) {
  let dir = await rootDir();
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}
async function rootDir() {
  return await navigator.storage.getDirectory();
}
async function readJson(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}
async function writeJson(dir, name, value) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(value));
  await w.close();
}
function memoryStore(origin) {
  const isMaster = origin === MASTER;
  const path = isMaster ? [ROOT, MASTER] : [ROOT, "origins", encodeOrigin(origin)];
  return {
    isMaster,
    origin,
    async get(key) {
      const dir = await openDir(path);
      return await readJson(dir, `${key}.json`);
    },
    async set(key, value) {
      const dir = await openDir(path);
      await writeJson(dir, `${key}.json`, value);
    },
    async keys() {
      const dir = await openDir(path);
      const out = [];
      for await (const [name] of dir.entries()) {
        if (name.endsWith(".json")) out.push(name.slice(0, -5));
      }
      return out.sort();
    },
    async delete(key) {
      const dir = await openDir(path);
      try {
        await dir.removeEntry(`${key}.json`);
      } catch {
      }
    },
    async clear() {
      if (isMaster) {
        const parent = await openDir([ROOT]);
        try {
          await parent.removeEntry(MASTER, { recursive: true });
        } catch {
        }
        return;
      }
      const origins = await openDir([ROOT, "origins"]);
      try {
        await origins.removeEntry(encodeOrigin(origin), { recursive: true });
      } catch {
      }
    }
  };
}
function siteMemory(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) {
    const invalid = memoryStore(`invalid:${origin}`);
    return {
      ...invalid,
      async get() {
        return null;
      },
      async set() {
        throw new Error(`invalid origin: ${origin}`);
      }
    };
  }
  return memoryStore(canonical);
}
async function listOrigins() {
  try {
    const dir = await openDir([ROOT, "origins"]);
    const out = [];
    for await (const [name] of dir.entries()) {
      out.push(decodeOrigin(name));
    }
    return out.sort();
  } catch {
    return [];
  }
}

// extension/lib/scheduler.js
var mutex = Promise.resolve();

// extension/lib/browser-tools.js
var GRANT_KEY = "cap:browserControlGrant";
var DEFAULT_GRANT_MS = 15 * 60 * 1e3;
function clampExpiryMs(expiryMs) {
  const ms = Number(expiryMs);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_GRANT_MS;
  return Math.min(ms, 60 * 60 * 1e3);
}
async function setGlobalBrowserControlGrant(expiryMs = DEFAULT_GRANT_MS) {
  const grant = {
    scope: "global",
    expiresAt: Date.now() + clampExpiryMs(expiryMs),
    grantedAt: Date.now()
  };
  await chrome.storage.local.set({ [GRANT_KEY]: grant });
  return grant;
}
async function setOriginBrowserControlGrant(origins, expiryMs = DEFAULT_GRANT_MS) {
  const canonical = [
    ...new Set(
      (origins ?? []).map((o) => {
        try {
          return canonicalOrigin(String(o));
        } catch {
          return null;
        }
      }).filter(Boolean)
    )
  ].slice(0, 50);
  if (canonical.length === 0) {
    throw new Error("origin grant needs at least one valid origin");
  }
  const grant = {
    scope: "origins",
    origins: canonical,
    expiresAt: Date.now() + clampExpiryMs(expiryMs),
    grantedAt: Date.now()
  };
  await chrome.storage.local.set({ [GRANT_KEY]: grant });
  return grant;
}
async function revokeBrowserControlGrant() {
  await chrome.storage.local.remove(GRANT_KEY);
  return { revoked: true };
}

// extension/options/options.js
var PROVIDERS = [
  {
    id: "demo",
    name: "Demo (local)",
    hint: "Deterministic local model \u2014 no key, always runs.",
    baseURL: "",
    needsKey: false,
    onDevice: false
  },
  {
    id: "prompt-api",
    name: "Chrome Prompt API",
    hint: "Gemini nano on-device \u2014 no key, works offline.",
    baseURL: "",
    needsKey: false,
    onDevice: true
  },
  {
    id: "openai",
    name: "OpenAI",
    hint: "Your OpenAI key + model.",
    baseURL: "https://api.openai.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false
  },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "Your Anthropic key (OpenAI-compatible endpoint).",
    baseURL: "https://api.anthropic.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "Your Gemini API key (OpenAI-compatible endpoint).",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    needsModel: true,
    onDevice: false
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "Your DeepSeek key + model.",
    baseURL: "https://api.deepseek.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    hint: "A local Ollama server.",
    baseURL: "http://localhost:11434/v1",
    needsKey: false,
    needsModel: true,
    onDevice: false
  }
];
var THEMES = [
  { id: "midnight", label: "Midnight", swatch: "#0d1117,#58a6ff" },
  { id: "sunlit", label: "Sunlit", swatch: "#ffffff,#0969da" },
  { id: "neon", label: "Neon", swatch: "#0a0a12,#ff3ea5" },
  { id: "terminal", label: "Terminal", swatch: "#0c0c0c,#4ec9b0" }
];
var $ = (sel) => document.querySelector(sel);
var storage = chrome.storage.local;
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
        ${p.needsKey || p.needsModel || p.baseURL || p.needsModel ? `<input class="base-url" type="text" placeholder="Base URL" value="${escapeAttr(p.baseURL)}">` : ""}
        ${p.needsKey || p.needsModel ? `<input class="api-key" type="password" placeholder="API key" autocomplete="off">` : ""}
        ${p.needsKey || p.needsModel ? `<input class="model" type="text" placeholder="Model id" value="${escapeAttr(cfg.provider === p.id ? cfg.model : "")}">` : ""}
      </div>` : ""}
    `;
    card.querySelector(".set-default")?.addEventListener("click", async () => {
      const fields = {
        baseURL: card.querySelector(".base-url")?.value ?? p.baseURL,
        apiKey: card.querySelector(".api-key")?.value ?? "",
        model: card.querySelector(".model")?.value ?? ""
      };
      await chrome.runtime.sendMessage({
        type: "provider.set",
        config: { provider: p.id, ...fields }
      });
      await saveFlash(`Set ${p.name} as default.`);
      renderProviders();
    });
    list.appendChild(card);
  }
  const active = list.querySelector(
    `.provider-card[data-provider="${cfg.provider}"]`
  );
  if (active) {
    if (cfg.apiKey) {
      const k = active.querySelector(".api-key");
      if (k) k.placeholder = "API key (set)";
    }
  }
}
async function renderAgents() {
  const s = await storage.get("cap:multiAgent");
  $("#multi-agent").checked = Boolean(s["cap:multiAgent"]);
  $("#multi-agent").addEventListener("change", async (e) => {
    await storage.set({ "cap:multiAgent": e.target.checked });
    $("#per-agent-provider").hidden = !e.target.checked;
    saveFlash("Agent mode saved.");
  });
  $("#per-agent-provider").hidden = !$("#multi-agent").checked;
  const list = $("#agent-provider-list");
  list.innerHTML = "";
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Per-agent provider assignment is planned but not enabled yet \u2014 every agent uses the global provider for now.";
  list.appendChild(note);
}
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
        "Browser control granted (global, 15 min \u2014 set origins below to scope it)."
      );
    } else {
      await revokeBrowserControlGrant();
      $("#grant-origins").hidden = true;
      saveFlash("Browser control revoked.");
    }
  });
  $("#grant-origin-list").addEventListener("change", async (e) => {
    const origins = e.target.value.split("\n").map((s2) => s2.trim()).filter(
      Boolean
    );
    if (origins.length > 0) {
      await setOriginBrowserControlGrant(origins);
      saveFlash(
        "Allowed origins saved (scoped to " + origins.length + " origin(s))."
      );
    } else {
      await setGlobalBrowserControlGrant();
      saveFlash("No origins listed \u2014 reverted to a global grant.");
    }
  });
}
async function renderUsage() {
  const u = await getUsage();
  const sum = $("#usage-summary");
  sum.innerHTML = `
    <div class="usage-stat"><div class="n">${u.totals.calls}</div><div class="l">calls</div></div>
    <div class="usage-stat"><div class="n">${u.totals.inputTokens + u.totals.outputTokens}</div><div class="l">tokens</div></div>
    <div class="usage-stat"><div class="n">$${u.totals.estimatedCost.toFixed(4)}</div><div class="l">est. cost</div></div>`;
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
    for (const v of [
      m.provider,
      m.model,
      String(m.calls),
      String(m.inputTokens + m.outputTokens),
      "$" + m.estimatedCost.toFixed(4)
    ]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  detail.replaceChildren(table);
  $("#usage-detail-toggle").addEventListener("click", () => {
    const d = $("#usage-detail");
    d.hidden = !d.hidden;
    $("#usage-detail-toggle").textContent = d.hidden ? "Show detail" : "Hide detail";
  });
}
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
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
var flashTimer;
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
document.querySelectorAll(".nav-item").forEach((a) => {
  a.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(
      (x) => x.removeAttribute("aria-current")
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

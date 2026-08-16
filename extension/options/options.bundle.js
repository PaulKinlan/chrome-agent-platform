// extension/lib/capabilities.js
var CAPABILITIES = [
  {
    id: "storage",
    permissions: ["storage"],
    label: "Memory & settings",
    hint: "Persist settings, tasks, usage and enrollment across restarts. Without it the hub still runs, but nothing survives a restart."
  },
  {
    id: "alarms",
    permissions: ["alarms"],
    label: "Scheduled tasks",
    hint: "Run the agent on a schedule (or after a delay). Without it, scheduled tasks are unavailable."
  },
  {
    id: "tabs",
    permissions: ["tabs"],
    label: "Browser control",
    hint: "Open/navigate/close/list tabs. This permission reads the browsing history (Chrome warns) and is granted from a headed browser; screenshots use the separate Screenshots capability instead."
  },
  {
    id: "activeTab",
    permissions: ["activeTab"],
    label: "Screenshots",
    hint: "Capture the active tab via chrome.tabs.captureVisibleTab. Silent (no warning) \u2014 the same permission the reference screenshot tool uses."
  },
  {
    id: "scripting",
    permissions: ["scripting"],
    label: "Site agents (read pages)",
    hint: "Inject the discovery/content scripts into enrolled origins so a site's WebMCP tools can be discovered and driven."
  },
  {
    id: "notifications",
    permissions: ["notifications"],
    label: "Notifications",
    hint: "Surface scheduled-task completions as system notifications."
  },
  {
    id: "sidePanel",
    permissions: ["sidePanel"],
    label: "Side panel",
    hint: "Open the hub in Chrome's side panel alongside a page."
  }
];
async function hasPermission(permission) {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: [permission] });
  } catch {
    return false;
  }
}
async function hasCapability(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return false;
  for (const p of cap.permissions) {
    if (!await hasPermission(p)) return false;
  }
  return true;
}
async function capabilityStatus() {
  const out = {};
  for (const c of CAPABILITIES) {
    out[c.id] = await hasCapability(c.id);
  }
  return out;
}
async function requestCapability(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) return { ok: false, error: `unknown capability ${id}` };
  try {
    const granted = await chrome.permissions.request({
      permissions: cap.permissions
    });
    return { ok: true, granted: Boolean(granted), capability: id };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), capability: id };
  }
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
  { id: "sunlit", label: "Paper", swatch: "#f7f6f3,#0e6e63" },
  { id: "midnight", label: "Charcoal", swatch: "#181614,#3ec3b0" },
  { id: "neon", label: "Violet", swatch: "#0e0e14,#7c5cff" },
  { id: "terminal", label: "Terminal", swatch: "#0b0f0d,#4ade80" }
];
var $ = (sel) => document.querySelector(sel);
var storage = {
  async get(keys) {
    return await chrome.runtime.sendMessage({ type: "kv.get", keys });
  },
  async set(values) {
    return await chrome.runtime.sendMessage({ type: "kv.set", values });
  },
  async remove(keys) {
    return await chrome.runtime.sendMessage({ type: "kv.remove", keys });
  }
};
async function renderProviders(restoreFocus = false) {
  const cfg = await chrome.runtime.sendMessage({ type: "provider.get" });
  const list = $("#provider-list");
  list.innerHTML = "";
  for (const p of PROVIDERS) {
    const card = document.createElement("div");
    card.className = "provider-card" + (cfg.provider === p.id ? " active" : "");
    card.dataset.provider = p.id;
    card.innerHTML = `
      <div class="provider-head">
        <div class="provider-id">
          <span class="provider-name">${p.name}</span>
          <span class="muted">${p.hint}</span>
        </div>
        <button class="btn small set-default" type="button" aria-label="${cfg.provider === p.id ? `Update ${p.name}` : `Use ${p.name}`}">${cfg.provider === p.id ? "Update" : "Use"}</button>
      </div>
      ${p.needsKey || p.onDevice || p.id === "openai" || p.id === "ollama" ? `
      <fieldset class="fields">
        <legend class="sr-only">${p.name} credentials</legend>
        ${p.needsKey || p.needsModel || p.baseURL || p.needsModel ? `<label class="field"><span class="field-label">Base URL</span><input class="base-url" type="text" placeholder="https://\u2026" value="${// The ACTIVE card shows the STORED endpoint (not the preset) so an
    // Update never silently resets a custom base URL.
    escapeAttr(cfg.provider === p.id ? cfg.baseURL || p.baseURL : p.baseURL)}"></label>` : ""}
        ${p.needsKey || p.needsModel ? `<label class="field"><span class="field-label">API key</span><input class="api-key" type="password" placeholder="\u2026" autocomplete="off"></label>` : ""}
        ${p.needsKey || p.needsModel ? `<label class="field"><span class="field-label">Model id</span><input class="model" type="text" placeholder="e.g. gpt-4o-mini" value="${escapeAttr(cfg.provider === p.id ? cfg.model : "")}"></label>` : ""}
      </fieldset>` : ""}
    `;
    card.querySelector(".set-default")?.addEventListener("click", async () => {
      const isActive = cfg.provider === p.id;
      const keyInput = card.querySelector(".api-key");
      const enteredKey = keyInput?.value ?? "";
      const apiKey = enteredKey ? enteredKey : isActive && cfg.apiKey ? cfg.apiKey : "";
      const fields = {
        baseURL: card.querySelector(".base-url")?.value ?? (isActive ? cfg.baseURL || p.baseURL : p.baseURL),
        apiKey,
        model: card.querySelector(".model")?.value ?? (isActive ? cfg.model || "" : "")
      };
      await chrome.runtime.sendMessage({
        type: "provider.set",
        config: { provider: p.id, ...fields }
      });
      await saveFlash(isActive ? `Updated ${p.name}.` : `Set ${p.name} as default.`);
      renderProviders(true);
    });
    list.appendChild(card);
  }
  const active = list.querySelector(
    `.provider-card[data-provider="${cfg.provider}"]`
  );
  if (active) {
    if (cfg.apiKey) {
      const k = active.querySelector(".api-key");
      if (k) k.placeholder = "API key (set \u2014 leave blank to keep)";
    }
    if (cfg.apiKey) {
      const clear = document.createElement("button");
      clear.className = "btn ghost small clear-key";
      clear.type = "button";
      clear.textContent = "Clear key";
      clear.setAttribute("aria-label", `Clear API key for ${cfg.provider}`);
      clear.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: "provider.set",
          config: { provider: cfg.provider, baseURL: cfg.baseURL, apiKey: "", model: cfg.model }
        });
        saveFlash("API key cleared.");
        renderProviders(true);
      });
      active.querySelector(".provider-head")?.appendChild(clear);
    }
  }
  if (restoreFocus) {
    active?.querySelector(".set-default")?.focus();
  }
}
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
    let granted;
    try {
      granted = await chrome.permissions.request({
        permissions: ["scripting"],
        origins: matches
      });
    } catch (e) {
      saveFlash("Permission request failed: " + String(e?.message ?? e));
      return;
    }
    if (!granted) {
      saveFlash("Host permission not granted \u2014 the origin was not enrolled.");
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: "agent.enroll-origin",
      origin
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
async function renderAgents() {
  const s = await storage.get("cap:multiAgent");
  $("#multi-agent").checked = s["cap:multiAgent"] !== false;
  $("#multi-agent").addEventListener("change", async (e) => {
    await storage.set({ "cap:multiAgent": e.target.checked });
    $("#per-agent-provider").hidden = !e.target.checked;
    try {
      await chrome.runtime.sendMessage({ type: "invalidate-agent" });
    } catch {
    }
    saveFlash("Agent mode saved.");
  });
  $("#per-agent-provider").hidden = !$("#multi-agent").checked;
  $("#agent-provider-list").replaceChildren();
}
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
      renderAppearance(true);
      saveFlash(`Theme: ${t.label}.`);
    });
    grid.appendChild(card);
  }
  document.documentElement.dataset.theme = current;
  if (restoreFocus) {
    grid.querySelector(".theme-card.active")?.focus();
  }
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
      let captureGranted = false;
      try {
        captureGranted = await chrome.permissions.request({
          permissions: ["activeTab"]
        });
      } catch {
      }
      await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: true
      });
      $("#grant-origins").hidden = false;
      saveFlash(
        captureGranted ? "Browser control granted (global, 15 min \u2014 set origins below to scope it)." : "Browser control granted (screenshots unavailable \u2014 activeTab permission not granted)."
      );
      renderPermissions();
    } else {
      const res = await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: false
      }).catch((e2) => ({ grant: { revoked: false, error: String(e2?.message ?? e2) } }));
      const revoked = res?.grant?.revoked === true;
      if (revoked) {
        $("#grant-origins").hidden = true;
        saveFlash("Browser control revoked.");
      } else {
        saveFlash(
          "Browser control revoke failed: " + (res?.grant?.error ?? "still granted") + "."
        );
      }
      renderPermissions();
    }
  });
  $("#grant-origin-list").addEventListener("change", async (e) => {
    const origins = e.target.value.split("\n").map((s2) => s2.trim()).filter(
      Boolean
    );
    if (origins.length > 0) {
      await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: true,
        origins
      });
      saveFlash(
        "Allowed origins saved (scoped to " + origins.length + " origin(s))."
      );
    } else {
      await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: true
      });
      saveFlash("No origins listed \u2014 reverted to a global grant.");
    }
  });
}
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
        const res = await requestCapability(cap.id);
        if (res?.granted) saveFlash(`Enabled ${cap.label}.`);
        else {
          saveFlash(
            `Enable ${cap.label} declined: ${res?.error ?? "not granted"}.`
          );
        }
        renderPermissions();
      });
      row.appendChild(btn);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small ghost revoke-perm";
      btn.dataset.capability = cap.id;
      btn.textContent = "Disable";
      btn.setAttribute("aria-label", `Disable ${cap.label}`);
      btn.addEventListener("click", async () => {
        const res = await chrome.runtime.sendMessage({ type: "capability.revoke", id: cap.id }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (res?.revoked) saveFlash(`Disabled ${cap.label}.`);
        else {
          saveFlash(
            `Disable ${cap.label} failed: ${res?.error ?? "still granted"}.`
          );
        }
        renderPermissions();
      });
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}
async function renderHooks() {
  const res = await chrome.runtime.sendMessage({ type: "hooks.status" }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  const hooks = res?.hooks ?? [];
  const list = $("#hook-list");
  list.replaceChildren();
  for (const h of hooks) {
    const row = document.createElement("div");
    row.className = "hook-row";
    const name = document.createElement("span");
    name.className = "perm-name";
    name.textContent = h.label;
    const id = document.createElement("code");
    id.className = "hook-id";
    id.textContent = h.id;
    const state = document.createElement("span");
    const denied = Boolean(h.denied);
    state.className = "perm-state" + (denied ? " denied" : " missing");
    state.textContent = denied ? "Denied" : "Allowed";
    const sub = document.createElement("span");
    sub.className = "muted";
    sub.textContent = h.subscribers?.length ? `subscribed: ${h.subscribers.join(", ")}` : h.permission ? `needs "${h.permission}"` : "no extra permission";
    row.append(name, id, state, sub);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small " + (denied ? "ghost" : "danger");
    btn.dataset.hook = h.id;
    btn.textContent = denied ? "Allow" : "Deny";
    btn.setAttribute("aria-label", `${denied ? "Allow" : "Deny"} ${h.label}`);
    btn.addEventListener("click", async () => {
      const r = await chrome.runtime.sendMessage({ type: "hooks.deny", hookId: h.id, denied: !denied }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      saveFlash(r?.ok ? `${h.label} ${r.denied ? "denied" : "allowed"}.` : `Could not update ${h.label}: ${r?.error ?? "failed"}.`);
      renderHooks();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}
async function renderUsage() {
  const u = await chrome.runtime.sendMessage({ type: "usage.get" });
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
  const origins = await chrome.runtime.sendMessage({ type: "agent.list" });
  const list = $("#origin-list");
  list.replaceChildren();
  if (!origins.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No enrolled sites yet.";
    list.appendChild(p);
  }
  for (const origin of origins ?? []) {
    const row = document.createElement("div");
    row.className = "origin-row";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin;
    row.appendChild(label);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn small ghost clear-origin";
    clear.textContent = "Clear";
    clear.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "memory.clear", origin });
      saveFlash(`Cleared memory for ${origin}.`);
      renderData();
    });
    row.appendChild(clear);
    const disenroll = document.createElement("button");
    disenroll.type = "button";
    disenroll.className = "btn small ghost disenroll-origin";
    disenroll.textContent = "Disenroll";
    disenroll.setAttribute("aria-label", `Disenroll ${origin}`);
    disenroll.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "agent.delete", origin }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok) {
        saveFlash(
          `Disenrolled ${origin} (scripts + host permission removed).`
        );
      } else {
        saveFlash(`Disenroll incomplete: ${res?.error ?? "unknown"}.`);
      }
      renderData();
    });
    row.appendChild(disenroll);
    list.appendChild(row);
  }
  const pending = await chrome.runtime.sendMessage({ type: "agent.pending-cleanup" });
  for (const origin of pending?.origins ?? []) {
    const row = document.createElement("div");
    row.className = "origin-row pending";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin;
    row.appendChild(label);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn small retry-cleanup";
    retry.textContent = "Retry cleanup";
    retry.setAttribute("aria-label", `Retry cleanup for ${origin}`);
    retry.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "agent.retry-cleanup", origin }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok) {
        saveFlash(`Cleanup complete for ${origin}.`);
      } else {
        saveFlash(`Cleanup still incomplete: ${res?.error ?? "unknown"}.`);
      }
      renderData();
    });
    row.appendChild(retry);
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
await renderEnroll();
await renderAppearance();
await renderBrowser();
await renderPermissions();
await renderHooks();
await renderUsage();
await renderData();

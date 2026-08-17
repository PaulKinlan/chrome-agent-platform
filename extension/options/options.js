// options.js — the dedicated settings/configuration page.

import { RECIPES } from "../lib/recipes.js";
import { RECIPE_ICON } from "../shared/recipe-icons.js";
import {
  CAPABILITIES,
  capabilityStatus,
  requestCapability,
} from "../lib/capabilities.js";
import { testProvider } from "../lib/provider-test.js";
import { requestProviderHostAccess } from "../lib/provider-gate.js";
// Side-effect import: registers the shared Web Components (switch-toggle,
// permission-row, capability-row, …) so the settings page uses the SAME
// design-system components as the hub + the docs showcase (one component,
// everywhere — no hand-rolled duplicates).
import "../shared/components.js";

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
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini", "o3-mini"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "Your Anthropic key (OpenAI-compatible endpoint).",
    baseURL: "https://api.anthropic.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "Your Gemini API key (OpenAI-compatible endpoint).",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-flash"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "Your DeepSeek key + model.",
    baseURL: "https://api.deepseek.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    hint: "Any OpenAI-compatible endpoint (Bedrock, Kimi, Groq, Together…) — set your own base URL + model.",
    baseURL: "",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: ["gpt-4o", "gpt-4o-mini", "deepseek-chat", "deepseek-reasoner", "kimi-k2", "moonshot-v1-8k", "qwen-plus", "claude-sonnet-4-5", "llama-3.3-70b"],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    hint: "A local Ollama server.",
    baseURL: "http://localhost:11434/v1",
    needsKey: false,
    needsModel: true,
    onDevice: false,
    models: [], // free-text — local model names
  },
];

const THEMES = [
  { id: "sunlit", label: "Paper", swatch: "#f7f6f3,#0e6e63" },
  { id: "midnight", label: "Charcoal", swatch: "#181614,#3ec3b0" },
  { id: "neon", label: "Violet", swatch: "#0e0e14,#7c5cff" },
  { id: "terminal", label: "Terminal", swatch: "#0b0f0d,#4ade80" },
];

const $ = (sel) => document.querySelector(sel);
// Shared key-value access routes through the SERVICE WORKER (the single
// authority for shared state). When the optional storage permission is absent,
// kv.js's session fallback is realm-local, so a page writing to its OWN fallback
// map would contradict the worker's (the round-15 split-authority finding).
// Routing every read/write through the SW makes the SW's session Map the one
// shared store. Pages must NEVER call kv* directly in their own realm.
const storage = {
  async get(keys) {
    return await chrome.runtime.sendMessage({ type: "kv.get", keys });
  },
  async set(values) {
    return await chrome.runtime.sendMessage({ type: "kv.set", values });
  },
  async remove(keys) {
    return await chrome.runtime.sendMessage({ type: "kv.remove", keys });
  },
};

// ── Providers ──
// Render the model field as a per-provider dropdown (known models + a "Custom…"
// option that reveals a free-text input) so the placeholder is never a wrong
// cross-provider example like "gpt-4o-mini" on Anthropic/Gemini/DeepSeek.
function modelFieldHtml(p, cfg) {
  const current = cfg.provider === p.id ? (cfg.model || "") : "";
  const models = Array.isArray(p.models) ? p.models : [];
  if (!models.length) {
    const ph = p.id === "ollama" ? "e.g. llama3.1" : "model id";
    return `<label class="field"><span class="field-label">Model id</span><input class="model" type="text" placeholder="${ph}" value="${escapeAttr(current)}"></label>`;
  }
  const opts = models
    .map((m) => `<option value="${escapeAttr(m)}"${m === current ? " selected" : ""}>${escapeHtml(m)}</option>`)
    .join("");
  const isCustom = current !== "" && !models.includes(current);
  return `
    <label class="field"><span class="field-label">Model</span>
      <select class="model-select" aria-label="Model for ${escapeAttr(p.name)}">
        <option value=""${current === "" ? " selected" : ""}>Select a model…</option>
        ${opts}
        <option value="__custom__"${isCustom ? " selected" : ""}>Custom…</option>
      </select>
      <input class="model model-custom" type="text" placeholder="model id" value="${escapeAttr(isCustom ? current : "")}"${isCustom ? "" : " hidden"}>
    </label>`;
}

// The effective model: the select's value unless "Custom…" is chosen (then the
// custom text input).
function effectiveModel(card) {
  const select = card.querySelector(".model-select");
  if (select) {
    return select.value === "__custom__"
      ? (card.querySelector(".model-custom")?.value || "")
      : select.value;
  }
  return card.querySelector(".model")?.value || "";
}

async function renderProviders(restoreFocus = false) {
  // Route the provider read through the SERVICE WORKER (single authority) — never
  // call lib/provider.js's kv* directly in this page realm (the round-16 split-
  // authority finding: with storage absent the page's session Map contradicts the
  // SW's).
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
        <div class="provider-actions">
          <button class="btn small set-default" type="button" aria-label="${
      cfg.provider === p.id ? `Update ${p.name}` : `Use ${p.name}`
    }">${
      cfg.provider === p.id ? "Update" : "Use"
    }</button>
          <button class="btn small ghost test-connection" type="button" aria-label="Test connection for ${p.name}">Test connection</button>
        </div>
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
            ? modelFieldHtml(p, cfg)
            : ""
        }
      </fieldset>`
        : ""
    }
      <div class="test-status" role="status" hidden></div>
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
        model: effectiveModel(card),
      };
      // The model dropdown's "Custom…" option reveals the free-text input.
      card.querySelector(".model-select")?.addEventListener("change", (e) => {
        const custom = card.querySelector(".model-custom");
        if (e.target.value === "__custom__") { custom.hidden = false; custom.focus(); }
        else custom.hidden = true;
      });
      // Route through the worker's provider.set so the running agent's cached
      // model/orchestrator is invalidated immediately (no stale provider).
      // FIRST request the provider's OPTIONAL host permission (this click is the
      // user gesture) — without it, the service worker's fetch to the provider
      // fails with "Failed to fetch" (the root cause Paul hit).
      const host = await requestProviderHostAccess(fields);
      await chrome.runtime.sendMessage({
        type: "provider.set",
        config: { provider: p.id, ...fields },
      });
      await saveFlash(
        host.granted === false
          ? `Saved ${p.name}, but network access was NOT granted — the agent can't reach it. Re-enable it when Chrome asks.`
          : (isActive ? `Updated ${p.name}.` : `Set ${p.name} as default.`),
      );
      renderProviders(true);
    });
    card.querySelector(".test-connection")?.addEventListener("click", async () => {
      const testBtn = card.querySelector(".test-connection");
      const testStatus = card.querySelector(".test-status");
      const isActive = cfg.provider === p.id;
      // Collect the CURRENT field values (including any unsaved typing), falling
      // back to the stored key/model on the active card when the key field is
      // blank (the stored key is never echoed into the password input).
      const keyInput = card.querySelector(".api-key");
      const enteredKey = keyInput?.value ?? "";
      const fields = {
        baseURL:
          card.querySelector(".base-url")?.value ??
          (isActive ? (cfg.baseURL || p.baseURL) : p.baseURL),
        apiKey: enteredKey || (isActive && cfg.apiKey ? cfg.apiKey : ""),
        model: effectiveModel(card),
      };
      // Loading state (the button is disabled + a live region announces it).
      testStatus.hidden = false;
      testStatus.className = "test-status testing";
      testStatus.textContent = "Testing…";
      testBtn.disabled = true;
      // Request the provider's OPTIONAL host permission (this click is a real
      // user gesture) — the test fetch fails without it.
      await requestProviderHostAccess(fields);
      const res = await testProvider(p, fields);
      testBtn.disabled = false;
      testStatus.className = "test-status " + (res.ok ? "ok" : "err");
      testStatus.textContent = res.ok
        ? `Connected — ${res.detail ?? "ok"} (${res.latencyMs}ms)`
        : `Failed — ${res.error ?? "unknown error"}`;
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
    // The OWNER gesture: request the exact origin's host permission AND the
    // `scripting` permission TOGETHER (one gesture, one prompt) so enrollment
    // can register + drive the discovery scripts. The reviewer's round-16 finding:
    // enrollment requested host only, not scripting plus host, so the discovery
    // scripts could never register even after a successful host grant. Never
    // request from the SW (no gesture).
    let granted;
    try {
      granted = await chrome.permissions.request({
        permissions: ["scripting"],
        origins: matches,
      });
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
      ownerGesture: true,
    }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    input.value = "";
    if (res?.ok) {
      saveFlash(`Enrolled ${origin}${res.scriptsRegistered ? " (scripts registered)" : ""}.`);
      renderData();
      renderEnrolledSites();
    } else {
      saveFlash("Enroll failed: " + (res?.error ?? "unknown"));
    }
  });
}

// ── Enrolled sites (the Disenroll lives HERE — the agent lifecycle, not the
//    Data & memory section — item 58) ──
async function renderEnrolledSites() {
  const el = $("#enrolled-sites");
  if (!el) return;
  const origins = await chrome.runtime.sendMessage({ type: "agent.list" }).catch(() => []);
  el.replaceChildren();
  for (const origin of (origins ?? [])) {
    const row = document.createElement("div");
    row.className = "origin-row";
    const label = document.createElement("span");
    label.className = "origin";
    label.textContent = origin; // textContent — never interpolate an origin
    row.appendChild(label);

    // Disenroll = AUTHORITATIVE revocation: unregister the content scripts,
    // remove the host permission, tombstone the enrollment, and clear OPFS (the
    // agent.delete route).
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
      renderEnrolledSites();
      renderData();
    });
    row.appendChild(disenroll);

    el.appendChild(row);
  }
}

// ── Agents ──
async function renderAgents() {
  const s = await storage.get("cap:multiAgent");
  const toggle = $("#multi-agent");
  const on = s["cap:multiAgent"] !== false;
  toggle.checked = on;
  toggle.addEventListener("toggle", async (e) => {
    const checked = e.detail.checked;
    await storage.set({ "cap:multiAgent": checked });
    $("#per-agent-provider").hidden = !checked;
    // Rebuild the running orchestrator so the fan-out / solo switch takes effect
    // immediately (the worker reads cap:multiAgent at orchestration time).
    try {
      await chrome.runtime.sendMessage({ type: "invalidate-agent" });
    } catch {
      /* worker may not be running yet — the setting still persists */
    }
    saveFlash("Agent mode saved.");
  });
  $("#per-agent-provider").hidden = !on;

  // Per-agent provider overrides: each named agent can use its OWN provider +
  // model (a COMPLETE config). The apiKey is written to storage but NEVER read
  // back here — the field shows a blank placeholder when a key exists.
  await renderAgentProviders();
}

/** A compact provider dropdown for the per-agent override (the global
 * PROVIDERS list, minus the in-page baseURL/key fields — the override reuses the
 * provider's own endpoint + a fresh key/model the user enters here). */
function agentProviderOptionsHtml(current) {
  const cur = current?.provider ?? "";
  return [
    `<option value="" ${cur ? "" : "selected"}>Use the global provider</option>`,
    ...PROVIDERS.filter((p) => p.id !== "demo").map((p) =>
      `<option value="${p.id}" ${cur === p.id ? "selected" : ""}>${p.name}</option>`
    ),
  ].join("");
}

async function renderAgentProviders() {
  const list = $("#agent-provider-list");
  if (!list) return;
  list.innerHTML = "";
  let agents = [];
  try {
    const r = await chrome.runtime.sendMessage({ type: "named-agent.list" });
    agents = Array.isArray(r?.agents) ? r.agents : [];
  } catch {
    agents = [];
  }
  if (!agents.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No named agents yet — create one first, then assign it a provider.";
    list.appendChild(empty);
    return;
  }
  for (const a of agents) {
    const row = document.createElement("div");
    row.className = "agent-provider-row";
    // The stored override is REDACTED (no key) — the provider + model are shown,
    // the key is entered (and only ever written, never read back).
    const cur = a.provider ?? {};
    row.innerHTML = `
      <span class="agent-provider-name" title="${escapeAttr(a.name)}">${escapeHtml(a.name)}</span>
      <select class="agent-provider-select" aria-label="Provider for ${escapeAttr(a.name)}">${agentProviderOptionsHtml(cur)}</select>
      <label class="field" style="flex:1"><span class="field-label">Model id</span><input class="agent-provider-model" type="text" placeholder="e.g. deepseek-chat" value="${escapeAttr(cur.model ?? "")}"></label>
      <label class="field" style="flex:1"><span class="field-label">API key (write-only)</span><input class="agent-provider-key" type="password" placeholder="${cur.provider ? "(kept — leave blank to keep)" : "…"}" autocomplete="off"></label>
      <button class="btn small set-agent-provider" type="button">Save</button>
    `;
    row.querySelector(".set-agent-provider").addEventListener("click", async () => {
      const provider = row.querySelector(".agent-provider-select").value;
      const model = row.querySelector(".agent-provider-model").value.trim();
      const apiKey = row.querySelector(".agent-provider-key").value;
      let config = null;
      if (provider) {
        // Build a COMPLETE config: the provider's own endpoint + the model/key
        // entered here. When the key is left blank AND an override already
        // exists, keep the stored key (a Save must not wipe a credential).
        const preset = PROVIDERS.find((p) => p.id === provider);
        config = {
          provider,
          baseURL: preset?.baseURL ?? "",
          model,
          apiKey: apiKey || (cur.provider === provider ? undefined : ""),
        };
      }
      const r = await chrome.runtime.sendMessage({ type: "named-agent.set-provider", id: a.id, config });
      saveFlash(r?.ok === false ? `Provider not saved: ${r.error ?? "unknown error"}` : `${a.name}: provider updated.`);
      await renderAgentProviders();
    });
    list.appendChild(row);
  }
}

// ── Background agents (scheduled recipes) ──
function backgroundAgentRow(a) {
  const row = document.createElement("div");
  row.className = "background-agent-row";

  const name = document.createElement("span");
  name.className = "perm-name";
  name.textContent = a.name;

  const state = document.createElement("span");
  state.className = "perm-state" + (a.enabled ? " running" : " stopped");
  state.textContent = a.enabled ? "Running" : "Stopped";

  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent =
    (a.description || "") +
    (a.schedule?.periodInMinutes
      ? ` · runs every ${a.schedule.periodInMinutes} min`
      : "");

  const toggle = document.createElement("switch-toggle");
  toggle.setAttribute("label", `${a.enabled ? "Disable" : "Enable"} ${a.name}`);
  toggle.checked = Boolean(a.enabled);

  toggle.addEventListener("toggle", async (e) => {
    const enabled = e.detail.checked;
    // ENABLE time (a real user gesture): request the OPTIONAL notifications
    // permission so the scheduled completions can surface as notifications
    // (never from the SW — no gesture). Best-effort: a denial means the
    // run-time path skips the notification silently.
    if (enabled) {
      try {
        await chrome.permissions?.request?.({ permissions: ["notifications"] });
      } catch { /* not grantable — the run-time path skips */ }
    }
    const out = await chrome.runtime
      .sendMessage({ type: "background-agent.set", id: a.id, enabled })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(
      out?.ok
        ? `${a.name} ${enabled ? "enabled." : "disabled."}`
        : `Could not update ${a.name}: ${out?.error ?? "failed"}.`,
    );
    renderBackgroundAgents();
  });

  // Item 56: duplicate a background agent into an EDITABLE copy (the built-in
  // template stays pristine; the copy's prompt can be edited).
  const duplicate = document.createElement("button");
  duplicate.type = "button";
  duplicate.className = "btn small ghost";
  duplicate.textContent = "Duplicate";
  duplicate.setAttribute("aria-label", `Duplicate ${a.name} into an editable copy`);
  duplicate.addEventListener("click", async () => {
    const out = await chrome.runtime
      .sendMessage({ type: "recipe.duplicate", id: a.id })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(out?.ok ? `Duplicated ${a.name} — edit the copy below.` : `Could not duplicate: ${out?.error ?? "failed"}.`);
    renderBackgroundAgents();
  });

  const actions = document.createElement("span");
  actions.className = "agent-actions";
  actions.append(duplicate);

  // A CUSTOM copy is editable: an Edit button opens a prompt editor (the
  // system prompt / constraints). A custom copy can also be deleted.
  if (a.custom) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn small ghost";
    edit.textContent = "Edit prompt";
    edit.setAttribute("aria-label", `Edit ${a.name}'s prompt`);
    edit.addEventListener("click", () => editRecipePrompt(a));
    actions.append(edit);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small ghost";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete ${a.name}`);
    del.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "recipe.delete", id: a.id }).catch(() => ({ ok: false }));
      saveFlash(`Deleted ${a.name}.`);
      renderBackgroundAgents();
    });
    actions.append(del);
  }

  row.append(name, state, hint, toggle, actions);
  return row;
}

// Edit a custom recipe's prompt (item 56): a dialog with the current prompt in
// a textarea + Save (recipe.update). Built with the native <dialog> + textContent
// (never innerHTML for the user-edited value).
function editRecipePrompt(recipe) {
  const dialog = document.createElement("dialog");
  dialog.className = "recipe-edit";
  const label = document.createElement("label");
  label.textContent = `${recipe.name} — system prompt`;
  label.className = "field-label";
  const textarea = document.createElement("textarea");
  textarea.rows = 8;
  textarea.value = recipe.prompt ?? "";
  textarea.setAttribute("aria-label", `System prompt for ${recipe.name}`);
  const actions = document.createElement("div");
  actions.className = "recipe-edit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn small ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close());
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn small";
  save.textContent = "Save";
  save.addEventListener("click", async () => {
    const out = await chrome.runtime
      .sendMessage({ type: "recipe.update", id: recipe.id, prompt: textarea.value })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(out?.ok ? `Updated ${recipe.name}.` : `Could not update: ${out?.error ?? "failed"}.`);
    dialog.close();
    renderBackgroundAgents();
  });
  actions.append(cancel, save);
  dialog.append(label, textarea, actions);
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
}

// The "Add background agent" control uses the NEW customizable HTML select
// (appearance: base-select) with rich icon+name+description options — the
// modern-web-guidance rich-media-picker pattern. Built with DOM APIs so the
// rich content survives (innerHTML would be stripped by the select parser).
function addBackgroundAgentSelect(disabled, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "agent-select-wrap";

  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = "Add a background agent";

  const select = document.createElement("select");
  select.className = "agent-select";
  select.setAttribute("aria-label", "Add a background agent");

  const button = document.createElement("button");
  button.type = "button";
  const selectedcontent = document.createElement("selectedcontent");
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▾";
  button.append(selectedcontent, chevron);
  select.append(button);

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Add a background agent…";
  empty.selected = true;
  select.append(empty);

  for (const a of disabled) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.setAttribute("aria-label", a.name);
    const svg = RECIPE_ICON[a.icon] ?? "";
    const name = document.createElement("span");
    name.className = "opt-title";
    name.textContent = a.name;
    const desc = document.createElement("span");
    desc.className = "opt-desc";
    desc.textContent = a.description ?? "";
    const text = document.createElement("span");
    text.className = "opt-text";
    text.append(name, desc);
    opt.append(text);
    if (svg) {
      const icon = document.createElement("span");
      icon.className = "opt-icon";
      icon.innerHTML = svg;
      opt.prepend(icon);
    }
    select.append(opt);
  }

  select.addEventListener("change", async () => {
    const id = select.value;
    if (!id) return;
    const agent = disabled.find((a) => a.id === id);
    const out = await chrome.runtime
      .sendMessage({ type: "background-agent.set", id, enabled: true })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(
      out?.ok
        ? `${agent?.name ?? id} enabled.`
        : `Could not enable ${agent?.name ?? id}: ${out?.error ?? "failed"}.`,
    );
    select.value = "";
    onChange();
  });

  wrap.append(label, select);
  return wrap;
}

async function renderBackgroundAgents() {
  const res = await chrome.runtime
    .sendMessage({ type: "background-agent.list" })
    .catch(() => ({ agents: [] }));
  const agents = Array.isArray(res.agents) ? res.agents : [];
  const enabled = agents.filter((a) => a.enabled);
  const disabled = agents.filter((a) => !a.enabled);

  const list = $("#background-agent-list");
  list.replaceChildren();

  if (!enabled.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No background agents running.";
    list.appendChild(p);
  }
  for (const a of enabled) list.appendChild(backgroundAgentRow(a));

  if (disabled.length) {
    list.appendChild(addBackgroundAgentSelect(disabled, renderBackgroundAgents));
  }
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
  // A PERSISTENT grant (expiresAt null) stays granted until revoked; a numeric
  // expiresAt is granted until the clock passes it (tracker item 51: the
  // toggle must STAY toggled).
  const granted = Boolean(
    grant &&
      (grant.expiresAt === null || grant.expiresAt === undefined ||
        grant.expiresAt > Date.now()),
  );
  const toggle = $("#browser-grant");
  toggle.checked = granted;
  $("#grant-origins").hidden = !granted;
  if (grant?.origins?.length) {
    $("#grant-origin-list").value = grant.origins.join("\n");
  }
  toggle.addEventListener("toggle", async (e) => {
    const checked = e.detail.checked;
    if (checked) {
      // PERSISTENCE (tracker item 60): the browser-control grant lives in
      // chrome.storage.local, which requires the OPTIONAL "storage" permission.
      // Without it the grant is SESSION-ONLY (the SW's in-memory fallback) and
      // the toggle silently resets on the next page/extension load — the
      // "never stays toggled" bug. Request "storage" HERE (a real gesture) so
      // the grant survives a reload; a denial is surfaced honestly.
      let storageGranted = true;
      try {
        storageGranted = await chrome.permissions.request({ permissions: ["storage"] });
      } catch { storageGranted = false; }
      // Screenshot capture uses chrome.tabs.captureVisibleTab with the SILENT
      // `activeTab` permission (NOT `tabs`, which warns and can't be granted in
      // headless; NOT the Chrome debugger, which can't be optional). Requested
      // HERE (a real user gesture). Denial degrades gracefully: the grant still
      // covers open/navigate/close; only screenshots become unavailable.
      let captureGranted = false;
      try {
        captureGranted = await chrome.permissions.request({
          permissions: ["activeTab"],
        });
      } catch { /* unsupported — activeTab stays absent */ }
      // Route the grant through the SERVICE WORKER (single authority) — never
      // write it in this page's own realm (split-authority).
      await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: true,
      });
      $("#grant-origins").hidden = false;
      saveFlash(
        captureGranted
          ? "Browser control granted (global, all origins — set origins below to scope it)." +
            (storageGranted ? "" : " (session-only — storage permission not granted)")
          : "Browser control granted (screenshots unavailable — activeTab permission not granted)." +
            (storageGranted ? "" : " (session-only — storage permission not granted)"),
      );
      renderPermissions();
    } else {
      const res = await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: false,
      }).catch((e) => ({ grant: { revoked: false, error: String(e?.message ?? e) } }));
      // Surface a FAILED revoke honestly (the round-16 finding: the UI claimed
      // "revoked" regardless of the worker's response). Only hide the origins
      // panel + claim success when the grant is CONFIRMED removed.
      const revoked = res?.grant?.revoked === true;
      if (revoked) {
        $("#grant-origins").hidden = true;
        saveFlash("Browser control revoked.");
      } else {
        saveFlash(
          "Browser control revoke failed: " +
            (res?.grant?.error ?? "still granted") +
            ".",
        );
      }
      renderPermissions();
    }
  });
  $("#grant-origin-list").addEventListener("change", async (e) => {
    const origins = e.target.value.split("\n").map((s) => s.trim()).filter(
      Boolean,
    );
    if (origins.length > 0) {
      await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: true,
        origins,
      });
      saveFlash(
        "Allowed origins saved (scoped to " + origins.length + " origin(s)).",
      );
    } else {
      await chrome.runtime.sendMessage({
        type: "browser-control.set",
        granted: true,
      });
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
    } else {
      // A GRANTED capability must be revocable (the round-16 finding: the panel
      // only rendered Enable, no Disable/Revoke action). Disable removes the
      // permission from a real user gesture + CONFIRMS absence, surfacing failure.
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn small ghost revoke-perm";
      btn.dataset.capability = cap.id;
      btn.textContent = "Disable";
      btn.setAttribute("aria-label", `Disable ${cap.label}`);
      btn.addEventListener("click", async () => {
        // Route Disable through the SERVICE WORKER (single authority): storage
        // needs a pre-removal persistent→session snapshot + migration reset, and
        // scripting needs its dependent host permissions + dynamic scripts
        // revoked. A direct page-realm permissions.remove would skip both (the
        // round-17 capability-Disable finding).
        const res = await chrome.runtime
          .sendMessage({ type: "capability.revoke", id: cap.id })
          .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (res?.revoked) saveFlash(`Disabled ${cap.label}.`);
        else {
          saveFlash(
            `Disable ${cap.label} failed: ${res?.error ?? "still granted"}.`,
          );
        }
        renderPermissions();
      });
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

// ── System hooks (the chrome.* event surface + the deny-list) ──
async function renderHooks() {
  const res = await chrome.runtime
    .sendMessage({ type: "hooks.status" })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  const hooks = res?.hooks ?? [];
  const list = $("#hook-list");
  list.replaceChildren();
  for (const h of hooks) {
    const row = document.createElement("div");
    row.className = "perm-row"; // SAME row as the Permissions section (one layout)

    const name = document.createElement("span");
    name.className = "perm-name";
    name.textContent = h.label;

    const state = document.createElement("span");
    const denied = Boolean(h.denied);
    state.className = "perm-state" + (denied ? " denied" : "");
    state.textContent = denied ? "Denied" : "Allowed";

    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = [
      h.id,
      h.subscribers?.length
        ? `subscribed: ${h.subscribers.join(", ")}`
        : (h.permission ? `needs "${h.permission}"` : "no extra permission"),
    ].join(" · ");

    row.append(name, state, hint);

    // The deny-toggle is OWNER-ONLY + authoritative: denying stops the agent
    // ever using the hook (fail-closed). Un-denying restores it (still gated by
    // the optional permission).
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small " + (denied ? "ghost" : "danger");
    btn.dataset.hook = h.id;
    btn.textContent = denied ? "Allow" : "Deny";
    btn.setAttribute("aria-label", `${denied ? "Allow" : "Deny"} ${h.label}`);
    btn.addEventListener("click", async () => {
      const r = await chrome.runtime
        .sendMessage({ type: "hooks.deny", hookId: h.id, denied: !denied })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      saveFlash(r?.ok
        ? `${h.label} ${r.denied ? "denied" : "allowed"}.`
        : `Could not update ${h.label}: ${r?.error ?? "failed"}.`);
      renderHooks();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

// ── Usage ──
async function renderUsage() {
  // Usage is shared state — read it through the SW (single authority), not the
  // page-local usage.js kv* (the round-16 split-authority finding).
  const u = await chrome.runtime.sendMessage({ type: "usage.get" });
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
// Item 59: the OPFS memory explorer is now a FILE-SYSTEM tree — an expandable
// directory tree (Master / Named agents / Background agents / Site agents),
// each agent a directory whose keys are files you click to view. Directories
// expand/collapse; a file toggles its value. Like a file manager, not a flat
// list.
async function renderMemoryExplorer() {
  const el = $("#memory-explorer");
  if (!el) return;
  el.replaceChildren();
  const res = await chrome.runtime
    .sendMessage({ type: "memory.stores" })
    .catch(() => ({ stores: [] }));
  const stores = Array.isArray(res?.stores) ? res.stores : [];
  if (!stores.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No memory stores yet.";
    el.append(p);
    return;
  }

  const root = document.createElement("div");
  root.className = "mem-tree";
  el.append(root);

  const master = stores.find((s) => s.kind === "master");
  const named = stores.filter((s) => s.kind === "named");
  const bg = stores.filter((s) => s.kind === "background");
  const site = stores.filter((s) => s.kind === "site");

  // ── helper: a directory node (expandable) ──────────────────────────────
  function dirNode(label, kind, children) {
    const wrap = document.createElement("div");
    wrap.className = "mem-dir";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mem-dir-head";
    head.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.textContent = "▸";
    caret.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "mem-dir-icon";
    icon.innerHTML = kind === "master"
      ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12l9-8 9 8"/><path d="M5 10v9h14v-9"/></svg>`
      : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
    const name = document.createElement("span");
    name.className = "mem-dir-name";
    name.textContent = label;
    head.append(caret, icon, name);
    const body = document.createElement("div");
    body.className = "mem-dir-body" + " hidden";
    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      caret.textContent = open ? "▸" : "▾";
      body.classList.toggle("hidden", open);
    });
    wrap.append(head, body);
    for (const c of children) body.append(c);
    return wrap;
  }

  // ── helper: a store node (an agent's directory of keys/files) ──────────
  function storeNode(store) {
    const wrap = document.createElement("div");
    wrap.className = "mem-dir mem-store";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mem-dir-head";
    head.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.textContent = "▸";
    caret.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "mem-dir-name";
    name.textContent = `${store.label} (${store.keyCount ?? 0})`;
    head.append(caret, name);
    const body = document.createElement("div");
    body.className = "mem-dir-body" + " hidden";
    // Lazy: list the keys on first expand.
    let loaded = false;
    head.addEventListener("click", async () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      caret.textContent = open ? "▸" : "▾";
      body.classList.toggle("hidden", open);
      if (!open && !loaded) {
        loaded = true;
        await fillKeys(store, body);
      }
    });
    wrap.append(head, body);
    return wrap;
  }

  async function fillKeys(store, body) {
    body.replaceChildren();
    const keyList = await chrome.runtime
      .sendMessage({ type: "memory.list", origin: store.key })
      .catch(() => []);
    if (!Array.isArray(keyList) || !keyList.length) {
      const p = document.createElement("p");
      p.className = "muted mem-empty";
      p.textContent = "No keys yet.";
      body.append(p);
      return;
    }
    for (const key of keyList) {
      body.append(fileNode(store, key));
    }
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn small ghost mem-clear";
    clearBtn.textContent = `Clear ${store.label}'s memory`;
    clearBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "memory.clear", origin: store.key }).catch(() => {});
      saveFlash(`Cleared ${store.label}'s memory.`);
      renderMemoryExplorer();
      renderData();
    });
    body.append(clearBtn);
  }

  // ── a file node (a key) — click to view its value ──────────────────────
  function fileNode(store, key) {
    const wrap = document.createElement("div");
    wrap.className = "mem-file";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mem-file-head";
    head.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.textContent = "▸";
    caret.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "mem-file-name";
    name.textContent = key;
    head.append(caret, name);
    const val = document.createElement("div");
    val.className = "mem-val hidden";
    let loaded = false;
    head.addEventListener("click", async () => {
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      caret.textContent = open ? "▸" : "▾";
      val.classList.toggle("hidden", open);
      if (!open && !loaded) {
        loaded = true;
        const v = await chrome.runtime
          .sendMessage({ type: "memory.get", origin: store.key, key })
          .catch(() => null);
        const pre = document.createElement("pre");
        pre.className = "mem-pre";
        pre.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);
        val.append(pre);
      }
    });
    wrap.append(head, val);
    return wrap;
  }

  // ── build the tree ─────────────────────────────────────────────────────
  if (master) root.append(storeNode(master));
  if (named.length) root.append(dirNode("Named agents", "named", named.map(storeNode)));
  if (bg.length) root.append(dirNode("Background agents", "background", bg.map(storeNode)));
  if (site.length) root.append(dirNode("Site agents", "site", site.map(storeNode)));
}

async function renderData() {
  // Enrolled origins are AUTHORITATIVE shared state — read them through the SW
  // (agent.list), not the page-local memory.js listOrigins (the round-16 split-
  // authority finding).
  const origins = await chrome.runtime.sendMessage({ type: "agent.list" });
  const list = $("#origin-list");
  list.replaceChildren();
  if (!origins.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No enrolled sites yet.";
    list.appendChild(p);
    // NOTE: no early return — pending-cleanup origins must STILL render below
    // (the round-18 finding: deleting the FINAL origin hid the Retry UI because
    // renderData returned before the pending-cleanup request).
  }
  for (const origin of (origins ?? [])) {
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
      await chrome.runtime.sendMessage({ type: "memory.clear", origin });
      saveFlash(`Cleared memory for ${origin}.`);
      renderData();
    });
    row.appendChild(clear);

    list.appendChild(row);
  }

  // Pending-cleanup origins: a delete that failed partway (e.g. a script or host
  // permission removal that could not be CONFIRMED) records a retryable cleanup
  // obligation independent of enrollment, so it is surfaced here with a Retry
  // control rather than silently dropped when the tombstone hides the origin
  // (the round-17 non-retryable finding).
  const pending = await chrome.runtime.sendMessage({ type: "agent.pending-cleanup" });
  for (const origin of (pending?.origins ?? [])) {
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
      const res = await chrome.runtime
        .sendMessage({ type: "agent.retry-cleanup", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
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

// ── helpers ──
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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

// nav active state
const sections = [
  "providers",
  "agents",
  "background",
  "appearance",
  "browser",
  "permissions",
  "hooks",
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
await renderBackgroundAgents();
await renderEnroll();
await renderAppearance();
await renderBrowser();
await renderPermissions();
await renderHooks();
await renderUsage();
await renderData();
await renderMemoryExplorer();
await renderEnrolledSites();

// The version in the footer (chaos-style semantic versioning — read from the
// manifest so it always matches the installed build).
try {
  const v = chrome.runtime.getManifest().version;
  const el = $("#app-version");
  if (el && v) el.textContent = "v" + v;
} catch { /* non-extension (browser test) — leave the placeholder */ }

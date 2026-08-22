// options.js — the dedicated settings/configuration page.

import { RECIPES } from "../lib/recipes.js";
import { RECIPE_ICON } from "../shared/recipe-icons.js";
import {
  CAPABILITIES,
  capabilityStatus,
  requestCapability,
} from "../lib/capabilities.js";
import { requestProviderHostAccess } from "../lib/provider-gate.js";
import { bindProviderSetDefault } from "../lib/provider-options-save.js";
import { modelsForVendor } from "../lib/model-prices.js";
import {
  LOCAL_MODEL_CATALOG,
  localModelFeasibility,
  preflightLocalModel,
} from "../lib/local-model-catalog.js";
import {
  providerSelectionPresentation,
  renderInternalProviderStatus,
} from "../lib/provider-visibility.js";
import { runOwnerApprovedMutation } from "../lib/owner-approved-mutation.js";
import {
  credentialNeedsDurableStorage,
  requestStorageFromOwnerClick,
} from "../lib/first-run-onboarding.js";
import {
  SITE_AGENT_COPY,
  enrollOutcomeState,
  siteAgentSetupMessage,
} from "../shared/site-agent-copy.js";
// Side-effect import: registers the shared Web Components (switch-toggle,
// permission-row, capability-row, …) so the settings page uses the SAME
// design-system components as the hub + the docs showcase (one component,
// everywhere — no hand-rolled duplicates).
import "../shared/components.js";

// ── Provider presets (the user picks one; OpenAI-compatible endpoints) ──
// NOTE: the "demo" + "prompt-api" providers are deliberately NOT in this
// picker (Paul 2026-08-17). The Chrome Prompt API (Gemini nano) is only for
// INTERNAL summarization/auto-naming (see lib/threads.js — it calls
// createPromptApiModel() directly, not the user's selected provider), and the
// Demo (local) provider is TESTING-only. Both remain resolvable in lib/provider.js
// for those internal/test paths, but the user picks only a real chat provider.
const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    hint: "Your OpenAI key + model.",
    baseURL: "https://api.openai.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: modelsForVendor("openai"),
  },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "Your Anthropic key (OpenAI-compatible endpoint).",
    baseURL: "https://api.anthropic.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: modelsForVendor("anthropic"),
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "Your Gemini API key (OpenAI-compatible endpoint).",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: modelsForVendor("gemini"),
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "Your DeepSeek key + model.",
    baseURL: "https://api.deepseek.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: modelsForVendor("deepseek"),
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    hint: "Any OpenAI-compatible endpoint (Bedrock, Kimi, Groq, Together…) — set your own base URL + model.",
    baseURL: "",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    // No vendor catalogue — a free-custom model id via the shared <model-picker>
    // (the former hand-maintained 11-id list was a stale hard-coded catalogue).
    models: [],
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

let storageGranted = false;

async function refreshStoragePermission() {
  try {
    storageGranted = await chrome.permissions.contains({ permissions: ["storage"] });
  } catch {
    storageGranted = false;
  }
  return storageGranted;
}

function syncCredentialWarning(warning, { focused = false, existing = false } = {}) {
  const input = warning?._credentialInput;
  if (!warning || !input) return;
  const active = !storageGranted && (focused || input.value.length > 0 || existing);
  warning.toggleAttribute("active", active);
  if (storageGranted) warning.removeAttribute("state");
}

function syncAllCredentialWarnings() {
  document.querySelectorAll("storage-durability-warning").forEach((warning) =>
    syncCredentialWarning(warning, {
      focused: warning._credentialInput === document.activeElement,
      existing: warning._existingCredential === true,
    }));
}

function wireCredentialDurability(input, warning, { existing = false } = {}) {
  if (!input || !warning) return;
  warning._credentialInput = input;
  warning._existingCredential = existing;
  const sync = () => syncCredentialWarning(warning, {
    focused: input === document.activeElement,
    existing,
  });
  input.addEventListener("focus", sync);
  input.addEventListener("input", sync);
  input.addEventListener("blur", sync);
  warning.addEventListener("enable-storage", async (event) => {
    warning.setAttribute("busy", "");
    const result = await requestStorageFromOwnerClick({
      event: event.detail?.sourceEvent,
      userActivation: navigator.userActivation,
      permissionsApi: chrome.permissions,
    });
    warning.removeAttribute("busy");
    warning.setAttribute("state", result.reason);
    if (result.granted) {
      storageGranted = true;
      syncAllCredentialWarnings();
      saveFlash("Storage enabled — API keys saved from now on survive extension restarts.");
    } else if (result.reason === "owner-click-required") {
      saveFlash("Use the Enable storage button directly to grant optional storage.");
      warning.setAttribute("active", "");
      warning.focusAction?.();
    } else {
      saveFlash("Storage was not enabled — the API key has not been saved.");
      warning.setAttribute("active", "");
      warning.focusAction?.();
    }
  });
  sync();
}

function blockSessionOnlyCredentialSave(input, warning) {
  if (!credentialNeedsDurableStorage({ enteredKey: input?.value ?? "", storageGranted })) return false;
  warning?.setAttribute("active", "");
  warning?.focusAction?.();
  saveFlash("Enable storage before saving this API key — it would otherwise be lost on restart.");
  return true;
}

async function providerStatusChanged() {
  // Re-read the (redacted) provider status + re-render the status surface so a
  // grant that landed on ANOTHER page (conversation "Grant network access")
  // is reflected here immediately.
  try {
    const status = await chrome.runtime.sendMessage({ type: "provider.status" }).catch(() => null);
    const chip = document.querySelector("#provider-status-chip, .provider-status");
    if (chip && status) chip.dataset.granted = String(Boolean(status.granted ?? status.ok ?? ""));
  } catch { /* status surface absent — nothing to reconcile */ }
}

// ── Local publisher models (catalogue + bounded preflight only) ──
// ── Tool library (READ-ONLY catalog diagnostics; CAP-FB-20260822-TOOL-LIBRARY-UI-01) ──
// Data comes ONLY from the existing Settings-principal `tool-catalog.shadow`
// route (the SW derives the owner-options principal from this exact sender).
// This wiring requests the bounded summary and sets properties; it installs no
// listener, issues no search, and wires no control — the component emits no
// events and exposes no actions by construction.
async function renderToolLibrary() {
  const library = $("#tool-library-view");
  if (!library) return;
  library.state = "loading";
  try {
    const summary = await chrome.runtime.sendMessage({
      type: "tool-catalog.shadow",
      action: "summary",
    });
    if (!summary || summary.ok !== true) {
      library.error = String(summary?.error ?? "the diagnostics route declined");
      library.state = "error";
      return;
    }
    library.summary = summary;
    library.state = "ready";
  } catch (error) {
    // An older background worker without the shadow route rejects the message;
    // that is the truthful unavailable state, not an error in this page.
    const text = String(error?.message ?? error ?? "");
    if (/does not exist|unknown message|no receiver|Could not establish/i.test(text)) {
      library.state = "unavailable";
    } else {
      library.error = text;
      library.state = "error";
    }
  }

  // The Settings-only Gate-2 wasm preview host (CAP-FB-20260822-TOOL-PREVIEW-
  // EXEC-01): the OPTIONS document is Worker-capable + COI, so the bounded job
  // runs HERE — no offscreen document, no NTP/content fallback, and NO new
  // manifest permission (required permissions stay []). The ONLY accepted
  // sender is the same-extension SERVICE WORKER (sender.id exact, no tab); the
  // authority + job arrive from the trusted SW (never request-borne).
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "wasm.preview.options") return undefined;
    if (sender?.id !== chrome.runtime.id || sender?.tab != null) {
      sendResponse({ ok: false, error: "wasm preview host denied: sender is not the service worker" });
      return undefined;
    }
    (async () => {
      // The executor + offscreen host stay SEPARATE shipped files (runtime-URL
      // dynamic import — esbuild cannot inline a non-static specifier), so the
      // options bundle carries NO inlined `new Worker` and the Store scan keeps
      // governing the canonical source files (whose worker-host exemption is
      // scanner-owned). No blanket scanner/Worker exemption is added.
      const { WasmExecutor } = await import(chrome.runtime.getURL("lib/wasm-executor.js"));
      const { createOffscreenWasmHost } = await import(chrome.runtime.getURL("lib/wasm-offscreen-host.js"));
      const executor = new WasmExecutor({
        workerUrl: chrome.runtime.getURL("lib/wasm-execution-worker.js"),
        callMs: Number.isSafeInteger(message.wallMs) ? message.wallMs : 5000,
      });
      const host = createOffscreenWasmHost({
        executor,
        authority: message.authority,
      });
      const { rehydratePreviewStdin, rehydratePreviewWasmBytes } = await import("../lib/tool-exec-preview.js");
      const wasmBytes = rehydratePreviewWasmBytes(message.wasmBytes);
      // createWasiJob on the SW side emitted a FROZEN PLAIN byte array for
      // stdin; the generic host contract requires a genuine Uint8Array — the
      // local rehydration clones the job with the dense validated bytes.
      const job = { ...message.job, stdin: rehydratePreviewStdin(message.job?.stdin) };
      const result = await host.handleJob({
        type: "wasm.job",
        job,
        wasmBytes,
      });
      sendResponse({ ok: true, result });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: String(error?.message ?? error),
        executorCode: error?.executorCode ?? null,
      });
    });
    return true; // async response
  });

  // The csvtool Settings preview: an EXPLICIT owner click on the component's
  // Run button emits tool-preview-request; this surface sends the bounded
  // request to the SW route (the only executor path) and renders the bounded
  // result. No catalog/provider selection is involved.
  library.addEventListener("tool-preview-request", async (event) => {
    const detail = event?.detail ?? {};
    const toolId = typeof detail.toolId === "string" ? detail.toolId : "";
    const args = Array.isArray(detail.args)
      ? detail.args.filter((a) => typeof a === "string").slice(0, 4)
      : [];
    const stdin = typeof detail.stdin === "string" ? detail.stdin : "";
    if (typeof stdin !== "string" || new TextEncoder().encode(stdin).byteLength > 2048) {
      library.previewResult = { ok: false, error: "stdin exceeds the 2 KiB preview bound" };
      return;
    }
    library.previewBusy = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "tool.preview.run",
        toolId,
        args,
        stdin,
      });
      if (!response || response.ok !== true) {
        library.previewResult = {
          ok: false,
          error: String(response?.error ?? "preview declined"),
        };
      } else if (response.result) {
        library.previewResult = response.result;
      } else {
        library.previewResult = { ok: false, error: "preview returned no result" };
      }
    } catch (error) {
      library.previewResult = {
        ok: false,
        error: String(error?.message ?? error ?? "preview failed"),
      };
    } finally {
      library.previewBusy = false;
    }
  });
}

async function renderLocalModels() {
  const catalog = $("#local-model-catalog");
  if (!catalog) return;
  let availableStorageBytes;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) {
      availableStorageBytes = Math.max(0, estimate.quota - estimate.usage);
    }
  } catch { /* inability to estimate is rendered as unknown, never as feasible */ }
  catalog.models = LOCAL_MODEL_CATALOG;
  catalog.feasibility = localModelFeasibility({
    deviceMemory: navigator.deviceMemory,
    // Memory64 support and runtime limits need a dedicated runtime benchmark;
    // this source slice refuses to infer support from ordinary wasm32 support.
    memory64: false,
    opfs: typeof navigator.storage?.getDirectory === "function",
    availableStorageBytes,
  });
  catalog.addEventListener("model-preflight", async (event) => {
    const model = LOCAL_MODEL_CATALOG.find((entry) => entry.id === event.detail?.modelId);
    if (!model) return;
    catalog.setProbeState(model.id, "probing", "Reading one byte from each pinned publisher file…");
    const result = await preflightLocalModel(model);
    catalog.setProbeState(
      model.id,
      result.ok ? "passed" : "failed",
      result.ok
        ? "Publisher preflight passed. Download is available, but full OPFS install remains unimplemented."
        : `Publisher preflight failed closed: ${result.error ?? "unverified response"}`,
    );
  });
}

// ── Providers ──
// The model field is the SHARED <model-picker> combobox (searchable, driven by
// the same modelsForVendor catalogue everywhere) so the main Providers section
// and the per-agent overrides behave identically. Providers without a vendor
// catalogue (Ollama, OpenAI-compatible) run it in free-custom mode.
function providerCatalogue(p) {
  return Array.isArray(p.models) ? p.models : [];
}

function modelFieldHtml(p, cfg) {
  const current = cfg.provider === p.id ? (cfg.model || "") : "";
  const models = providerCatalogue(p);
  const ph = models.length ? "Search or type a model id…" : (p.id === "ollama" ? "e.g. llama3.1" : "model id");
  // The component is SELF-LABELED (its shadow .field carries the label) — no
  // outer wrapper, or two "Model" captions stack (k3 MEDIUM-2).
  return `<model-picker class="model" data-provider="${escapeAttr(p.id)}" placeholder="${escapeAttr(ph)}" models="${escapeAttr(JSON.stringify(models))}" value="${escapeAttr(current)}" label="Model"></model-picker>`;
}

// The effective model: the shared component's committed value (fall back to a
// legacy .model input during transition).
function effectiveModel(card) {
  const picker = card.querySelector("model-picker");
  if (picker) return picker.value ?? "";
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
  // A stored internal provider remains runtime authority, but is not a public
  // card. Explain that state without mutating, auto-selecting, or erasing it.
  renderInternalProviderStatus(
    $("#provider-selection-status"),
    providerSelectionPresentation(cfg, PROVIDERS),
  );
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
            ? `<label class="field"><span class="field-label">API key</span><input class="api-key" type="password" placeholder="…" autocomplete="off"></label>
              ${p.needsKey ? `<storage-durability-warning id="${escapeAttr(`storage-warning-${p.id}`)}" provider="${escapeAttr(p.name)}"></storage-durability-warning>` : ""}`
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
    const credentialInput = card.querySelector(".api-key");
    const durabilityWarning = card.querySelector("storage-durability-warning");
    wireCredentialDurability(credentialInput, durabilityWarning, {
      existing: cfg.provider === p.id && cfg.hasApiKey === true,
    });
    // The synchronous durability guard MUST run before the replacement save
    // path starts either the host request or provider.set. Once allowed, the
    // existing owner click starts optional host access and provider persistence
    // without awaiting native permission settlement.
    bindProviderSetDefault({
      card,
      provider: p,
      currentConfig: cfg,
      shouldBlock: () =>
        blockSessionOnlyCredentialSave(credentialInput, durabilityWarning),
      requestHostAccess: requestProviderHostAccess,
      sendMessage: (message) => chrome.runtime.sendMessage(message),
      onAccess(access) {
        const isActive = cfg.provider === p.id;
        if (access.status === "pending") {
          saveFlash(`Saved ${p.name}. Chrome's network-access decision is still pending; provider requests remain blocked until access is granted.`);
        } else if (access.status === "denied") {
          saveFlash(`Saved ${p.name}, but network access was not granted — provider requests remain blocked. Re-enable it when Chrome asks.`);
        } else {
          saveFlash(isActive ? `Updated ${p.name}.` : `Set ${p.name} as default.`);
        }
      },
      onSaved() {
        renderProviders(true);
      },
    });
    card.querySelector(".test-connection")?.addEventListener("click", async () => {
      const testBtn = card.querySelector(".test-connection");
      const testStatus = card.querySelector(".test-status");
      // The test runs INSIDE the SW (provider.test): an entered key is passed
      // through; a BLANK key field means "use the stored one", which the page
      // never sees. The response's error text is already secret-safe.
      const enteredKey = card.querySelector(".api-key")?.value ?? "";
      const fields = {
        provider: p.id,
        baseURL: card.querySelector(".base-url")?.value ?? p.baseURL,
        apiKey: enteredKey, // "" → the SW merges the stored key
        model: effectiveModel(card),
      };
      // Loading state (the button is disabled + a live region announces it).
      testStatus.hidden = false;
      testStatus.className = "test-status testing";
      testStatus.textContent = "Testing…";
      testBtn.disabled = true;
      // Request the provider's OPTIONAL host permission (this click is a real
      // user gesture) — the test fetch fails without it.
      await requestProviderHostAccess({ baseURL: fields.baseURL });
      const res = await chrome.runtime.sendMessage({ type: "provider.test", ...fields });
      testBtn.disabled = false;
      testStatus.className = "test-status " + (res?.ok ? "ok" : "err");
      testStatus.textContent = res?.ok
        ? `Connected — ${res.detail ?? "ok"} (${res.latencyMs}ms)`
        : `Failed — ${res?.error ?? "unknown error"}`;
    });
    list.appendChild(card);
  }
  // populate the active card's current key/model + an explicit clear-key control
  const active = list.querySelector(
    `.provider-card[data-provider="${cfg.provider}"]`,
  );
  if (active) {
    if (cfg.hasApiKey) {
      const k = active.querySelector(".api-key");
      if (k) k.placeholder = "API key (set — leave blank to keep)";
    }
    // A keyless provider (Demo / Prompt API) has nothing to clear — only offer
    // the Clear key control when a key is actually configured (never the
    // contradictory "Clear key" on a keyless provider). The clear routes to
    // the dedicated provider.clear-key (an owner gesture; the ONLY removal
    // path — provider.set can no longer erase a key from the page).
    if (cfg.hasApiKey) {
      const clear = document.createElement("button");
      clear.className = "btn ghost small clear-key";
      clear.type = "button";
      clear.textContent = "Clear key";
      clear.setAttribute("aria-label", `Clear API key for ${cfg.provider}`);
      clear.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "provider.clear-key" });
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
    } catch {
      saveFlash(siteAgentSetupMessage("permission-error", origin));
      return;
    }
    if (!granted) {
      saveFlash(siteAgentSetupMessage("permission-denied", origin));
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: "agent.enroll-origin",
      origin,
      ownerGesture: true,
    }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    input.value = "";
    const state = enrollOutcomeState(res);
    // The SW owns the persisted lifecycle record (cap:webmcpStatus — bounded +
    // redacted registration/injection errors, survive reopen); the flash is the
    // transient confirmation + the diagnostics section renders the SW record.
    saveFlash(state === "failed"
      ? siteAgentSetupMessage("failed-now", origin)
      : siteAgentSetupMessage(state, origin));
    renderData();
    renderEnrolledSites();
    renderWebmcpStatus();
  });
}

// ── Enrolled sites (the removal action lives HERE — the agent lifecycle, not the
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
    disenroll.textContent = "Remove Site Agent";
    disenroll.setAttribute("aria-label", `Remove Site Agent for ${origin}`);
    disenroll.addEventListener("click", async () => {
      const res = await chrome.runtime
        .sendMessage({ type: "agent.delete", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok) {
        saveFlash(`Site Agent removed for ${origin}.`);
      } else {
        saveFlash(`Couldn't fully remove the Site Agent for ${origin}. Try again.`);
      }
      renderEnrolledSites();
      renderData();
      renderWebmcpStatus();
    });
    row.appendChild(disenroll);

    el.appendChild(row);
  }
}

// ── WebMCP discovery status + diagnostics toggle (Paul 2026-08-18) ──
// A small, honest status surface: when did discovery last run, for which origin,
// what is the script/injection state, and how many tools were found — plus the
// diagnostics toggle that gates the [WebMCP] content-script console logs.
let webmcpDiagWired = false;
async function renderWebmcpStatus() {
  const body = $("#webmcp-status-body");
  const toggle = $("#webmcp-diagnostics");
  if (!body || !toggle) return;

  if (!webmcpDiagWired) {
    webmcpDiagWired = true;
    toggle.addEventListener("toggle", async (e) => {
      const checked = e.detail.checked === true;
      await chrome.runtime
        .sendMessage({ type: "webmcp.diagnostics.set", enabled: checked })
        .catch(() => {});
      saveFlash(checked ? "WebMCP diagnostics logs enabled." : "WebMCP diagnostics logs disabled.");
    });
  }
  let diag = { enabled: false };
  try { diag = await chrome.runtime.sendMessage({ type: "webmcp.diagnostics.get" }); } catch { /* SW not ready */ }
  toggle.checked = diag?.enabled === true;

  const status = await chrome.runtime
    .sendMessage({ type: "webmcp.status" })
    .catch(() => null);
  body.replaceChildren();
  const s = status?.status;
  if (!s) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = SITE_AGENT_COPY.diagnosticsEmpty;
    body.appendChild(p);
    return;
  }
  const row = document.createElement("div");
  row.className = "webmcp-row";
  // The record separates the SW-ATTESTED script lifecycle (registration /
  // injection) from the PAGE-REPORTED tool counts — render both, labeled.
  const lines = [
    `Origin: ${s.origin}`,
    `Script status (attested): ${s.scriptStatus}${s.scriptStatusAt ? " · " + new Date(s.scriptStatusAt).toLocaleString() : ""}`,
  ];
  // The persisted scriptError is rendered ONCE (the "Error:" line below).
  if (s.injection && (s.injection.targets ?? 0) > 0) {
    lines.push(
      `Injection: ${s.injection.ready?.length ?? 0}/${s.injection.targets} tab(s) ready` +
        ((s.injection.partial?.length ?? 0) > 0 ? ` · ${s.injection.partial.length} partial` : "") +
        ((s.injection.failed?.length ?? 0) > 0 ? ` · ${s.injection.failed.length} failed` : ""),
    );
  }
  if (s.lastReport) {
    const r = s.lastReport;
    lines.push(
      `Page report: ${r.toolCount ?? 0} tools (${r.declaredCount ?? 0} declared, ${r.inferredCount ?? 0} inferred) · ${new Date(r.at).toLocaleString()}`,
    );
  } else {
    lines.push("Page report: none yet");
  }
  for (const line of lines) {
    const p = document.createElement("div");
    p.className = "webmcp-line";
    p.textContent = line; // textContent — the origin/status are untrusted data
    row.appendChild(p);
  }
  if (Array.isArray(s.lastReport?.toolNames) && s.lastReport.toolNames.length) {
    const names = document.createElement("div");
    names.className = "webmcp-tools muted";
    names.textContent = s.lastReport.toolNames.join(", ");
    row.appendChild(names);
  }
  if (s.scriptError) {
    const err = document.createElement("div");
    err.className = "webmcp-line error";
    err.textContent = "Error: " + s.scriptError;
    row.appendChild(err);
  }
  body.appendChild(row);
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

/** The per-agent override row: SHARED components (provider-select +
 * model-picker) — the same maintained catalogue + combobox as the main
 * Providers section, on one labeled grid with equal 36px controls. "Use the
 * global provider" is the provider-select's empty option. The API key stays
 * write-only; the Base URL is stored deliberately (the preset endpoint for
 * fixed-endpoint providers; an explicit field for OpenAI-compatible, prefilled
 * from the global config when it matches). */
function agentProviderRowHtml(a, cur, globalCfg) {
  const selection = providerSelectionPresentation(cur, PROVIDERS);
  // An internal legacy override remains stored/runnable. Keep the public select
  // empty and its dependent controls inert until the owner chooses a listed
  // replacement; rendering alone never rewrites the override.
  const provider = selection.selectValue;
  const preset = PROVIDERS.find((p) => p.id === provider);
  const models = preset ? providerCatalogue(preset) : [];
  const needsBaseURL = provider === "openai-compatible";
  // Prefill the OpenAI-compatible base URL from the GLOBAL config when the
  // global provider is also openai-compatible (no stale preset empty string).
  const baseURLDefault = needsBaseURL
    ? (cur.baseURL ?? (globalCfg?.provider === "openai-compatible" ? globalCfg.baseURL : ""))
    : "";
  const providersAttr = escapeAttr(JSON.stringify(PROVIDERS.map((p) => ({ id: p.id, name: p.name }))));
  const internalDisabled = selection.hiddenInternal ? "disabled" : "";
  return `
    <label class="field ag-name"><span class="field-label">Agent</span><span class="agent-provider-name" title="${escapeAttr(a.name)}">${escapeHtml(a.name)}</span></label>
    <provider-select class="ag-provider" providers="${providersAttr}" value="${escapeAttr(provider)}" label="Provider" placeholder="${selection.hiddenInternal ? "Choose a listed provider" : "Use the global provider"}"></provider-select>
    <model-picker class="ag-model" models="${escapeAttr(JSON.stringify(models))}" value="${escapeAttr(selection.hiddenInternal ? "" : (cur.model ?? ""))}" label="Model id" placeholder="${models.length ? "Search or type a model id…" : "model id"}" ${provider ? "" : "disabled"}></model-picker>
    <label class="field ag-base-url" ${needsBaseURL ? "" : "hidden"}><span class="field-label">Base URL</span><input class="agent-provider-base-url" type="text" placeholder="https://your-endpoint/v1" value="${escapeAttr(baseURLDefault)}"></label>
    <label class="field"><span class="field-label">API key (write-only)</span><input class="agent-provider-key" type="password" placeholder="${selection.hiddenInternal ? "Not used by the active internal provider" : cur.hasApiKey ? "(kept — blank keeps it)" : "…"}" autocomplete="off" title="${selection.hiddenInternal ? "Choose a listed provider before entering a key" : cur.hasApiKey ? "A saved key is kept when this field is left blank" : "API key"}" ${internalDisabled}></label>
    <p class="hint agent-provider-internal-status" hidden></p>
    <storage-durability-warning id="${escapeAttr(`agent-storage-warning-${a.id}`)}" provider="${escapeAttr(a.name)}"></storage-durability-warning>
    <div class="ag-actions">
      <button class="btn small set-agent-provider" type="button" ${internalDisabled}>Save</button>
      ${!selection.hiddenInternal && cur.provider && cur.hasApiKey ? `<button class="btn small ghost clear-agent-key" type="button" aria-label="Clear the stored API key for ${escapeAttr(a.name)}">Clear key</button>` : ""}
    </div>
  `;
}

// A per-agent provider change is a destructive named-agent mutation. The SW
// deliberately returns a pending capability on the first exact call. This
// native modal is the explicit owner decision between that call and its one
// exact retry — dismissal/cancel can only deny, never approve.
function confirmAgentProviderMutation(agentName, description, trigger) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "recipe-edit provider-approval-dialog";
    dialog.setAttribute("aria-label", "Approve provider change?");

    const title = document.createElement("h2");
    title.textContent = "Approve provider change?";
    const body = document.createElement("p");
    body.textContent = `${description} for ${agentName}? This changes which model service the agent may use.`;
    const status = document.createElement("p");
    status.className = "muted";
    status.textContent = "Only Approve once saves this exact change.";
    const actions = document.createElement("div");
    actions.className = "recipe-edit-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn ghost cancel-provider-change";
    cancel.textContent = "Cancel";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn primary approve-provider-change";
    approve.textContent = "Approve once";
    actions.append(cancel, approve);
    dialog.append(title, body, status, actions);
    document.body.append(dialog);

    let decision = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      dialog.remove();
      if (trigger?.isConnected) trigger.focus();
      resolve(decision);
    };
    cancel.addEventListener("click", () => dialog.close());
    approve.addEventListener("click", (event) => {
      // A script-triggered click can dismiss/cancel, but can never mint an
      // approval. Match the existing Approvals surface's genuine-click check.
      if (!event.isTrusted || navigator.userActivation?.isActive !== true) {
        status.textContent = "Use a real click to approve this provider change.";
        return;
      }
      decision = true;
      dialog.close();
    });
    dialog.addEventListener("cancel", () => { decision = false; });
    dialog.addEventListener("close", finish, { once: true });
    try {
      dialog.showModal();
      cancel.focus(); // safe default + deterministic keyboard focus
    } catch {
      finish();
    }
  });
}

async function runAgentProviderMutation({ message, agentName, description, trigger }) {
  return await runOwnerApprovedMutation({
    message,
    action: "named-agent.set-provider",
    sendMessage: (value) => chrome.runtime.sendMessage(value),
    requestConfirmation: () => confirmAgentProviderMutation(agentName, description, trigger),
  });
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
  const globalCfg = await chrome.runtime.sendMessage({ type: "provider.get" }).catch(() => null);
  for (const a of agents) {
    const row = document.createElement("div");
    row.className = "agent-provider-row";
    // The stored override is REDACTED (no key) — the provider + model are shown,
    // the key is entered (and only ever written, never read back).
    const cur = a.provider ?? {};
    const storedSelection = providerSelectionPresentation(cur, PROVIDERS);
    row.innerHTML = agentProviderRowHtml(a, cur, globalCfg);
    const internalStatus = row.querySelector(".agent-provider-internal-status");
    renderInternalProviderStatus(internalStatus, storedSelection);
    const agentCredentialInput = row.querySelector(".agent-provider-key");
    const agentDurabilityWarning = row.querySelector("storage-durability-warning");
    const setAgentProvider = row.querySelector(".set-agent-provider");
    wireCredentialDurability(agentCredentialInput, agentDurabilityWarning, {
      existing: cur.hasApiKey === true,
    });

    // Provider change → swap the model catalogue + base-URL field to the
    // selected provider (the row stays a labeled grid; only the dependent
    // cells change). A hidden legacy override cannot be erased by pressing an
    // otherwise-no-op Save: choose a public provider first.
    row.querySelector(".ag-provider")?.addEventListener("change", (e) => {
      const provider = e.detail?.value ?? e.target.value ?? "";
      const preset = PROVIDERS.find((p) => p.id === provider);
      const models = preset ? providerCatalogue(preset) : [];
      const hiddenLegacyUnchanged = storedSelection.hiddenInternal && !provider;
      renderInternalProviderStatus(
        internalStatus,
        hiddenLegacyUnchanged ? storedSelection : { hiddenInternal: false },
      );
      if (agentCredentialInput) agentCredentialInput.disabled = hiddenLegacyUnchanged;
      if (setAgentProvider) setAgentProvider.disabled = hiddenLegacyUnchanged;
      const picker = row.querySelector(".ag-model");
      if (picker) {
        picker.models = models;
        picker.value = ""; // never carry one provider's model id to another
        picker.setAttribute("placeholder", models.length ? "Search or type a model id…" : "model id");
        if (provider) picker.removeAttribute("disabled"); else picker.setAttribute("disabled", "");
      }
      const baseURLField = row.querySelector(".ag-base-url");
      if (baseURLField) {
        const needs = provider === "openai-compatible";
        baseURLField.hidden = !needs;
        const input = baseURLField.querySelector(".agent-provider-base-url");
        if (needs && input && !input.value) {
          input.value = globalCfg?.provider === "openai-compatible" ? (globalCfg.baseURL ?? "") : "";
        }
      }
    });

    // The owner-gesture EXPLICIT key clear for a per-agent override (the only
    // removal path — a blank Save preserves; the final review's MEDIUM).
    row.querySelector(".clear-agent-key")?.addEventListener("click", async (event) => {
      const trigger = event.currentTarget;
      trigger.disabled = true;
      const provider = row.querySelector(".ag-provider")?.value ?? "";
      const preset = PROVIDERS.find((p) => p.id === provider);
      const r = await runAgentProviderMutation({
        message: {
          type: "named-agent.set-provider",
          id: a.id,
          config: { provider, baseURL: provider === "openai-compatible" ? (row.querySelector(".agent-provider-base-url")?.value.trim() ?? "") : (preset?.baseURL ?? ""), model: row.querySelector(".ag-model")?.value?.trim() ?? "", apiKey: "" },
        },
        agentName: a.name,
        description: "Clear the stored API key",
        trigger,
      });
      if (r.ok) {
        saveFlash(`${a.name}: API key cleared.`);
        await renderAgentProviders();
      } else {
        trigger.disabled = false;
        trigger.focus();
        saveFlash(`Key not cleared: ${r.error ?? "unknown error"}`);
      }
    });
    setAgentProvider.addEventListener("click", async (event) => {
      const trigger = event.currentTarget;
      const provider = row.querySelector(".ag-provider")?.value ?? "";
      const model = row.querySelector(".ag-model")?.value?.trim() ?? "";
      const apiKey = agentCredentialInput.value;
      if (blockSessionOnlyCredentialSave(agentCredentialInput, agentDurabilityWarning)) return;
      trigger.disabled = true;
      const customBaseURL = row.querySelector(".agent-provider-base-url")?.value.trim() ?? "";
      let config = null;
      if (provider) {
        // Build a COMPLETE config: the provider's own endpoint + the model/key
        // entered here. When the key is left blank AND an override already
        // exists for the SAME provider, keep the stored key (a Save must not
        // wipe a credential). The baseURL is deliberate: the preset endpoint
        // for fixed-endpoint providers, the explicit field for
        // openai-compatible.
        const preset = PROVIDERS.find((p) => p.id === provider);
        config = {
          provider,
          baseURL: provider === "openai-compatible" ? customBaseURL : (preset?.baseURL ?? ""),
          model,
          apiKey: apiKey || (cur.provider === provider ? undefined : ""),
        };
      }
      const r = await runAgentProviderMutation({
        message: { type: "named-agent.set-provider", id: a.id, config },
        agentName: a.name,
        description: config == null ? "Use the global provider" : `Save ${provider} as the provider`,
        trigger,
      });
      if (r.ok) {
        saveFlash(`${a.name}: provider updated.`);
        await renderAgentProviders();
      } else {
        trigger.disabled = false;
        trigger.focus();
        saveFlash(`Provider not saved: ${r.error ?? "unknown error"}`);
      }
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
      // The Screenshots capability requests the SILENT `activeTab` permission
      // (NOT `tabs`, which warns and can't be granted in headless; NOT the
      // Chrome debugger, which can't be optional) — this ENABLES Chrome's
      // transient owner-invoked capture (clicking the extension icon while
      // viewing a page). It never authorizes a background or model-selected
      // capture (those require exact site access). Requested HERE (a real user
      // gesture). Denial degrades gracefully: the grant still covers
      // open/navigate/close; only icon-click screenshots become unavailable.
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
          : "Browser control granted (icon-click screenshots unavailable — activeTab permission not granted)." +
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
        if (res?.granted && cap.id === "alarms") {
          // Permission was requested only by this owner click. Notify the worker,
          // which confirms the grant and owns listener activation/reload.
          const activation = await chrome.runtime.sendMessage({
            type: "alarms.permission-granted",
          }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
          if (activation?.reloadScheduled) {
            saveFlash("Enabled Scheduled tasks. Reloading once to activate alarms…");
          } else if (activation?.listenerRegistered) {
            saveFlash("Enabled Scheduled tasks.");
          } else {
            saveFlash(
              `Scheduled tasks was granted, but activation failed: ${activation?.error ?? "alarm listener unavailable"}.`,
            );
          }
        } else if (res?.granted) saveFlash(`Enabled ${cap.label}.`);
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
  const tok = u.totals.inputTokens + u.totals.outputTokens;
  sum.replaceChildren();
  for (const [n, l] of [
    [String(u.totals.calls), "calls"],
    [tok.toLocaleString(), "tokens"],
    ["$" + u.totals.estimatedCost.toFixed(4), "est. cost"],
  ]) {
    const s = document.createElement("div");
    s.className = "usage-stat";
    const nEl = document.createElement("div");
    nEl.className = "n";
    nEl.textContent = n;
    const lEl = document.createElement("div");
    lEl.className = "l";
    lEl.textContent = l;
    s.append(nEl, lEl);
    sum.appendChild(s);
  }

  // The full breakdown: by provider, by model, by agent, by day. Each is a
  // textContent-built table (never interpolate into innerHTML — untrusted).
  const detail = $("#usage-detail");
  detail.replaceChildren();

  const mk = (title, headings, rows) => {
    const h = document.createElement("h3");
    h.textContent = title;
    detail.appendChild(h);
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No usage recorded yet.";
      detail.appendChild(p);
      return;
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of headings) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      for (const v of r) {
        const td = document.createElement("td");
        td.textContent = v; // textContent — never interpolate into innerHTML
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    detail.appendChild(table);
  };

  const fmtTok = (m) => String(m.inputTokens + m.outputTokens);
  const fmtCost = (m) => "$" + m.estimatedCost.toFixed(4);
  const sortCost = (a, b) => b.estimatedCost - a.estimatedCost;

  mk("By provider", ["Provider", "Calls", "Tokens", "Cost"],
    u.byProvider.slice().sort(sortCost).map((p) => [p.provider, String(p.calls), fmtTok(p), fmtCost(p)]));
  mk("By model", ["Provider", "Model", "Calls", "Tokens", "Cost"],
    u.byModel.slice().sort(sortCost).map((m) => [m.provider, m.model, String(m.calls), fmtTok(m), fmtCost(m)]));
  mk("By agent", ["Agent", "Model", "Calls", "Tokens", "Cost"],
    u.byAgent.slice().sort(sortCost).map((a) => [a.agentId, `${a.provider}/${a.model}`, String(a.calls), fmtTok(a), fmtCost(a)]));
  mk("By day", ["Day", "Calls", "Tokens", "Cost"],
    u.byDay.slice().sort((a, b) => a.day.localeCompare(b.day)).map((d) => [d.day, String(d.calls), fmtTok(d), fmtCost(d)]));
}

// ── Data / memory ──
// Item 59: the OPFS memory explorer is now a FILE-SYSTEM tree — an expandable
// directory tree (Master / Named agents / Background agents / Site Agents),
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
  if (site.length) root.append(dirNode("Site Agents", "site", site.map(storeNode)));
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

// ── Advanced — system prompts (the layered prompt architecture) ──────────
// The scope selector picks WHICH agent's system prompt is shown: the hub
// (also the default for background/hook/scheduled runs), the Site Agents
// (the "worker" scope), or a specific named agent (agent:<slug>, which
// inherits the hub's customization until it has its own). The
// <system-prompt-editor> component renders the describe payload; saves/resets
// route through the SW prompt.* handlers (the SAME composition authority the
// run path uses — the preview is the exact platform composition).
const PROMPT_SCOPES = [
  { id: "hub", label: "Hub agent (default)", hint: "Applies to the hub and, unless a named agent has its own customization, to every named/background/hook/scheduled run." },
  { id: "worker", label: "Site Agents", hint: "The base prompt every enrolled site's Site Agent runs with. Per-origin skills are appended at run time." },
];

async function renderPrompts() {
  const scopeSelect = $("#prompt-scope");
  const hint = $("#prompt-scope-hint");
  const editor = $("#prompt-editor");
  if (!scopeSelect || !editor) return;

  // The store revision from the LAST describe (echoed back on save as the CAS
  // guard — a second Settings window's save can never silently overwrite).
  let currentRevision = null;
  let loadedScope = "hub";

  // Populate the scope selector: the two global scopes + one entry per named agent.
  scopeSelect.replaceChildren();
  for (const s of PROMPT_SCOPES) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    scopeSelect.append(opt);
  }
  let agents = [];
  try {
    const r = await chrome.runtime.sendMessage({ type: "named-agent.list" });
    agents = Array.isArray(r?.agents) ? r.agents : [];
  } catch { agents = []; }
  for (const a of agents) {
    const opt = document.createElement("option");
    opt.value = `agent:${a.id}`;
    opt.textContent = `Agent: ${a.name}`;
    scopeSelect.append(opt);
  }

  async function load() {
    const scope = scopeSelect.value || "hub";
    const preset = PROMPT_SCOPES.find((s) => s.id === scope);
    hint.textContent = preset?.hint
      ?? (scope.startsWith("agent:")
        ? "This named agent's system prompt. It inherits the hub customization until you save an agent-specific one; its role rides as a labelled layer."
        : "");
    const label = preset?.label
      ?? (scope.startsWith("agent:")
        ? `Agent: ${agents.find((a) => `agent:${a.id}` === scope)?.name ?? scope.slice(6)}`
        : scope);
    editor.setAttribute("scope-label", label);
    editor.data = null; // loading state
    const d = await chrome.runtime
      .sendMessage({ type: "prompt.describe", scope })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    currentRevision = Number.isSafeInteger(d?.revision) ? d.revision : null;
    loadedScope = scope;
    editor.data = d;
  }

  async function mutate(type, payload = {}) {
    const scope = scopeSelect.value || "hub";
    // On the owner's SAVE gesture, request the optional `storage` permission
    // so the customization is DURABLE (never silently session-only — the
    // review's persistence blocker). Denied → still save, but the UI says
    // "session-only" (the describe payload's durable flag drives the badge).
    if (type === "prompt.set") {
      try {
        const has = await chrome.permissions.contains({ permissions: ["storage"] });
        if (!has) {
          const granted = await chrome.permissions.request({ permissions: ["storage"] });
          if (!granted) {
            saveFlash("Storage not granted — this customization is session-only until storage is enabled.");
          }
        }
      } catch { /* a denied/unavailable request falls through to the save */ }
    }
    // MANDATORY CAS (the review's race-safety blocker): EVERY prompt-store
    // mutation — set, reset, keep — carries the revision this window read,
    // so a stale window conflicts instead of silently deleting/re-stamping a
    // newer write it never saw. A null revision is rejected by the route
    // (the describe failed — the honest error is flashed, never a silent
    // unguarded write).
    if (type === "prompt.set" || type === "prompt.reset" || type === "prompt.keep") {
      payload = { ...payload, expectedRevision: currentRevision };
    }
    editor.setAttribute("busy", "");
    const r = await chrome.runtime
      .sendMessage({ type, scope, ...payload })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    editor.removeAttribute("busy");
    if (r?.ok === false) {
      if (r.conflict) {
        // CAS conflict: another window saved first — reload the fresh state.
        saveFlash("Changed in another window — the latest state was reloaded; retry your edit.");
      } else {
        saveFlash(`Prompt not saved: ${r.error ?? "unknown error"}`);
      }
    } else if (type === "prompt.set") {
      // Never claim "saved" when the backend is session-only (the optional
      // storage permission is still absent after the Save-gesture request).
      const durableNow = await chrome.permissions
        .contains({ permissions: ["storage"] })
        .catch(() => true);
      saveFlash(durableNow
        ? "System prompt customization saved."
        : "Saved for THIS SESSION only — enable storage in Settings to persist across restarts.");
    } else {
      saveFlash(
        type === "prompt.keep" ? "Customization kept — now based on the latest built-in prompt."
        : "Reset to the built-in default.",
      );
    }
    await load();
  }

  scopeSelect.addEventListener("change", () => {
    // Switching scopes reloads the editor (re-seeding the draft) — confirm
    // before discarding unsaved edits (the review's dirty-switch finding).
    if (editor.dirty && !globalThis.confirm("Discard the unsaved prompt edits and switch scope?")) {
      // Restore the selector to the scope the editor still shows.
      scopeSelect.value = loadedScope;
      return;
    }
    load();
  });
  editor.addEventListener("prompt-save", (e) =>
    mutate("prompt.set", { mode: e.detail.mode, text: e.detail.text }));
  editor.addEventListener("prompt-reset", (e) =>
    mutate("prompt.reset", { effective: e.detail?.effective === true }));
  editor.addEventListener("prompt-keep", () => mutate("prompt.keep"));

  await load();
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

// ── owner approvals ────────────────────────────────────────────────────────
// Approval ids live only in click-handler closures. No id, target, digest,
// payload, origin or execution identifier is written into the DOM.
const approvalList = $("#approval-list");
const approvalStatus = $("#approval-status");
let approvalRenderBusy = false;

async function resolveApprovalFromClick(event, approvalId, approve, row) {
  if (!event.isTrusted || navigator.userActivation?.isActive !== true) {
    if (approvalStatus) approvalStatus.textContent = "Use a real click to approve or deny.";
    return;
  }
  for (const button of row.querySelectorAll("button")) button.disabled = true;
  if (approvalStatus) approvalStatus.textContent = approve ? "Approving…" : "Denying…";
  const result = await chrome.runtime.sendMessage({
    type: "management.resolve-approval",
    approvalId,
    approve,
  }).catch(() => ({ ok: false }));
  if (approvalStatus) approvalStatus.textContent = result?.ok
    ? (approve ? "Approved. The exact requesting operation may retry once." : "Denied. The exact request was removed.")
    : "That approval could not be resolved. Refresh and try again.";
  await renderApprovals();
}

async function renderApprovals() {
  if (!approvalList || approvalRenderBusy) return;
  approvalRenderBusy = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "management.pending-approvals" }).catch(() => null);
    const approvals = Array.isArray(response?.approvals) ? response.approvals : [];
    approvalList.replaceChildren();
    if (!approvals.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No pending approvals.";
      approvalList.append(empty);
      return;
    }
    if (approvalStatus) approvalStatus.textContent = "Review the pending action, then approve it once or deny it.";
    for (const approval of approvals) {
      const approvalId = approval.approvalId; // closure only
      const row = document.createElement("div");
      row.className = "approval-row";
      const description = document.createElement("div");
      const action = document.createElement("strong");
      action.textContent = String(approval.action ?? "destructive operation");
      const reference = document.createElement("span");
      reference.className = "approval-ref muted";
      reference.textContent = `Private reference ${String(approval.targetRef ?? "unavailable")}`;
      description.append(action, reference);
      const controls = document.createElement("div");
      controls.className = "approval-controls";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "btn primary";
      approve.textContent = "Approve once";
      const deny = document.createElement("button");
      deny.type = "button";
      deny.className = "btn ghost";
      deny.textContent = "Deny";
      approve.addEventListener("click", (event) => resolveApprovalFromClick(event, approvalId, true, row));
      deny.addEventListener("click", (event) => resolveApprovalFromClick(event, approvalId, false, row));
      controls.append(approve, deny);
      row.append(description, controls);
      approvalList.append(row);
    }
  } finally {
    approvalRenderBusy = false;
  }
}

// nav active state
const sections = [
  "providers",
  "local-models",
  "agents",
  "background",
  "appearance",
  "browser",
  "permissions",
  "approvals",
  "hooks",
  "prompts",
  "usage",
  "data",
];
document.querySelectorAll(".nav-item").forEach((a) => {
  a.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((x) =>
      x.removeAttribute("aria-current")
    );
    a.setAttribute("aria-current", "true");
    if (a.dataset.section === "approvals") renderApprovals();
    if (a.dataset.section === "usage") renderUsage();
  });
});

// (The legacy "Custom…" reveal wiring for the old select-based model field is
// gone — the shared <model-picker> makes custom ids a first-class typed path.)

// Permission-settle consumer (the acceptance review): Settings performs its
// own permission requests via requestProviderHostAccess (whose waiter is
// exact pattern+generation); no passive listener here. The status chip
// re-reads from the SW on focus so a grant landed anywhere is reflected.
window.addEventListener("focus", () => { providerStatusChanged(); }, { once: true });
chrome.permissions?.onAdded?.addListener((change) => {
  if (change?.permissions?.includes("storage")) {
    storageGranted = true;
    syncAllCredentialWarnings();
  }
});
chrome.permissions?.onRemoved?.addListener((change) => {
  if (change?.permissions?.includes("storage")) {
    storageGranted = false;
    syncAllCredentialWarnings();
  }
});

await refreshStoragePermission();
await renderProviders();
await renderLocalModels();
await renderToolLibrary();
await renderAgents();
await renderBackgroundAgents();
await renderEnroll();
await renderAppearance();
await renderBrowser();
await renderPermissions();
await renderApprovals();
setInterval(() => { if (document.visibilityState === "visible") renderApprovals(); }, 1500);
await renderHooks();
await renderPrompts();
await renderUsage();
// The OPEN Usage panel must reflect a record/clear the moment it happens (a run
// completing, or the owner clearing), not show a stale count until a manual
// reload — poll while the page is visible (the same pattern as Approvals), and
// re-render on section activation via the nav handler above.
setInterval(() => { if (document.visibilityState === "visible") renderUsage(); }, 1500);
// The detail-toggle is a STATIC control — wire its click EXACTLY ONCE (outside
// renderUsage, which runs per page-load + nav + poll), so repeated renders never
// stack listeners and never produce parity-dependent dead/inverted toggles.
$("#usage-detail-toggle").addEventListener("click", () => {
  const d = $("#usage-detail");
  d.hidden = !d.hidden;
  $("#usage-detail-toggle").textContent = d.hidden ? "Show detail" : "Hide detail";
});
await renderData();
await renderMemoryExplorer();
await renderEnrolledSites();
await renderWebmcpStatus();

// The version in the footer (chaos-style semantic versioning — read from the
// manifest so it always matches the installed build).
try {
  const v = chrome.runtime.getManifest().version;
  const el = $("#app-version");
  if (el && v) el.textContent = "v" + v;
  const av = $("#about-version");
  if (av && v) av.textContent = "v" + v;
} catch { /* non-extension (browser test) — leave the placeholder */ }

// ── About / changelog ────────────────────────────────────────────────────────
// Render the bundled CHANGELOG.md into the About section. Each `## [version]`
// becomes a version card with its bullet list (built as DOM nodes, never
// innerHTML, so the markdown stays inert).
function renderChangelog(md) {
  const host = $("#changelog");
  if (!host) return;
  host.replaceChildren();
  const lines = String(md).split(/\r?\n/);
  let current = null;
  let list = null;
  const commit = () => {
    if (current && list && list.children.length) current.append(list);
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+\[([^\]]+)\]\s*—?\s*(.*)$/);
    if (h) {
      commit();
      current = document.createElement("div");
      current.className = "changelog-entry";
      const head = document.createElement("div");
      head.className = "changelog-head";
      const v = document.createElement("strong");
      v.textContent = "v" + h[1].trim();
      const date = document.createElement("span");
      date.className = "muted";
      date.textContent = h[2].trim();
      head.append(v, date);
      current.append(head);
      host.append(current);
      list = document.createElement("ul");
      list.className = "changelog-items";
      continue;
    }
    if (current && line.startsWith("- ")) {
      if (!list) { list = document.createElement("ul"); list.className = "changelog-items"; }
      const li = document.createElement("li");
      li.textContent = line.slice(2).trim();
      list.append(li);
      continue;
    }
  }
  commit();
  if (!host.children.length) {
    host.innerHTML = `<p class="muted">No changelog yet.</p>`;
  }
}

async function renderAbout() {
  try {
    const url = chrome.runtime.getURL("CHANGELOG.md");
    const res = await fetch(url);
    if (!res.ok) throw new Error("changelog fetch " + res.status);
    renderChangelog(await res.text());
  } catch {
    // Non-extension (browser test) or the file isn't bundled — a graceful fallback.
    renderChangelog("# Changelog\n\n## [0.0.0] — \n- Changelog unavailable in this context.\n");
  }
}
await renderAbout();

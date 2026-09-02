// options.js — the dedicated settings/configuration page.

import {
  RECIPES,
} from "../lib/recipes.js";
import {
  SETTINGS_SECTIONS,
  DEVELOPER_SECTIONS_SET,
  DEVELOPER_FEATURES_KEY,
  normalizeSettingsSectionId,
} from "../lib/pure.js";
import { projectUnifiedAgents } from "../lib/named-agents.js";
import { recipeAsTemplate } from "../lib/agent-templates.js";
import {
  agentScheduleMarker,
  backgroundAgentsForDisplay,
} from "../shared/agent-display.js";
import {
  CAPABILITIES,
  capabilityState,
  requestCapability,
  capabilityStatus,
} from "../lib/capabilities.js";
import { requestProviderHostAccess } from "../lib/provider-gate.js";
import {
  USAGE_RANGES,
  dayBuckets,
  filterRowsByRange,
  formatCost,
  formatTokens,
  shareBars,
  svgDailyBars,
  svgShareBars,
  topTools,
} from "../lib/usage-viz.js";

let currentUsageRange = "7d"; // hoisted above renderUsage — no TDZ on section open
import { bindProviderSetDefault } from "../lib/provider-options-save.js";
import { defaultModelFor, fetchLiveModels, suggestedModelsFor } from "../lib/model-catalog.js";
import {
  providerSelectionPresentation,
  renderInternalProviderStatus,
} from "../lib/provider-visibility.js";
import {
  keyPageFor,
  leadingProviders,
  moreProviders,
  prefilledModelFor,
  useEnabled,
} from "../lib/providers-view.js";
import { runOwnerApprovedMutation } from "../lib/owner-approved-mutation.js";
import { credentialNeedsDurableStorage } from "../lib/first-run-onboarding.js";
import {
  SITE_AGENT_COPY,
  enrollOutcomeState,
  siteAgentSetupMessage,
} from "../shared/site-agent-copy.js";
import { createNavigationController } from "../lib/navigation-controller.js";
// Side-effect import: registers the shared Web Components (switch-toggle,
// permission-row, capability-row, …) so the settings page uses the SAME
// design-system components as the hub + the docs showcase (one component,
// everywhere — no hand-rolled duplicates).
import { confirmActionDialog, escapeHtml } from "../shared/components.js";
import { saveFsGrant, wireLocalFolderPickers, regrantFsGrantAccess } from "../lib/fs-grants.js";
import { mountGrantBrowser } from "../lib/folder-browser.js";
import {
  mcpToSavePayload,
  buildMcpServerEditor,
  mcpServerRow as buildMcpServerRow,
} from "../lib/mcp-server-editor.js";
import { mountSkillsSection } from "../skills/skills-panel.js";
import {
  capLogReady,
  getLogFullDetail,
  getLogVerbosity,
  setLogFullDetail,
  setLogVerbosity,
} from "../lib/cap-log.js";

async function wireObservabilitySettings() {
  const verbosity = document.getElementById("log-verbosity");
  const fullDetail = document.getElementById("log-full-detail");
  if (!verbosity || !fullDetail) return;
  await capLogReady();
  verbosity.value = getLogVerbosity();
  fullDetail.checked = getLogFullDetail();
  verbosity.addEventListener("change", async () => {
    await setLogVerbosity(verbosity.value);
    saveFlash(`Console logging set to ${verbosity.options[verbosity.selectedIndex]?.text ?? verbosity.value}.`);
  });
  fullDetail.addEventListener("toggle", async (event) => {
    const enabled = event.detail?.checked === true;
    await setLogFullDetail(enabled);
    saveFlash(enabled
      ? "Full detail enabled for local DevTools only; exports stay redacted."
      : "Local console payloads are redacted.");
  });
}

// ── Run-log retention (CAP-FB-20260830-RUN-LOG-COMPACTION-01) ──────────
// The policy lives in chrome.storage.local["cap:runRetention"]; the durable-run
// registry reads it at every terminal commit and `run.list` reports it. The
// toggle is the explicit "keep everything" opt-in; off = the bounded defaults.
const RUN_RETENTION_KEY = "cap:runRetention";
function describeRetentionBound(policy) {
  if (!policy || policy.mode === "retain-all") {
    return "On: every run keeps its full step-by-step detail until you clear it. Storage grows with use.";
  }
  const mib = Math.round((policy.globalBytes ?? 32 * 1024 * 1024) / (1024 * 1024));
  return `Off: full detail for the newest ${policy.perThread ?? 50} runs per task and the newest ${policy.globalExecutions ?? 500} runs overall (up to ${mib} MiB); older runs keep a summary line.`;
}
async function wireRunRetentionSettings() {
  const toggle = document.getElementById("run-retention-keep-all");
  const bound = document.getElementById("run-retention-bound");
  if (!toggle || !bound) return;
  let policy = null;
  try {
    const snapshot = await chrome.runtime.sendMessage({ type: "run.list" });
    policy = snapshot?.retentionPolicy ?? null;
  } catch { policy = null; }
  toggle.checked = policy?.mode === "retain-all";
  bound.textContent = describeRetentionBound(policy);
  toggle.addEventListener("toggle", async (event) => {
    const keepAll = event.detail?.checked === true;
    await chrome.storage.local.set({ [RUN_RETENTION_KEY]: { mode: keepAll ? "retain-all" : "bounded" } });
    let next = null;
    try { next = (await chrome.runtime.sendMessage({ type: "run.list" }))?.retentionPolicy ?? null; } catch { next = null; }
    bound.textContent = describeRetentionBound(next ?? { mode: keepAll ? "retain-all" : "bounded" });
    saveFlash(keepAll ? "Every run log is kept in full." : "Older run logs are folded into a summary line.");
  });
}

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
    hint: "Your OpenAI key. Runs gpt-5.6-luna — fast, one tool call per intent.",
    baseURL: "https://api.openai.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    recommended: true,
    models: suggestedModelsFor("openai"),
  },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "Your Anthropic key (OpenAI-compatible endpoint).",
    baseURL: "https://api.anthropic.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: suggestedModelsFor("anthropic"),
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "Your Gemini API key. Runs gemini-3.7-flash — passes every journey, slower per turn.",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    alternative: true,
    models: suggestedModelsFor("gemini"),
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hint: "Your DeepSeek key + model.",
    baseURL: "https://api.deepseek.com/v1",
    needsKey: true,
    needsModel: true,
    onDevice: false,
    models: suggestedModelsFor("deepseek"),
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
  {
    id: "lm-studio",
    name: "LM Studio (local)",
    hint: "A local LM Studio server.",
    baseURL: "http://localhost:1234/v1",
    needsKey: false,
    needsModel: true,
    onDevice: false,
    models: [], // free-text — local model names
  },
];


const $ = (sel) => document.querySelector(sel);
// Bounded SW message: a service worker killed/suspended mid-route leaves the
// sendMessage promise UNSETTLED (the callback never fires) — the real-profile
// "everything is broken" class. Settle on timeout so every Settings section
// renders an honest error/Retry instead of a blank/loading-forever surface.
function boundedSend(type, payload = {}, timeoutMs = 12000) {
  return Promise.race([
    chrome.runtime.sendMessage({ type, ...payload }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}
// Shared key-value access routes through the SERVICE WORKER (the single
// authority for shared state). If the install-granted storage permission cannot be verified,
// kv.js's session fallback is realm-local, so a page writing to its OWN fallback
// map would contradict the worker's (the round-15 split-authority finding).
// Routing every read/write through the SW makes the SW's session Map the one
// shared store. Pages must NEVER call kv* directly in their own realm.
const storage = {
  async get(keys) {
    try {
      return await boundedSend("kv.get", { keys });
    } catch (e) {
      return { error: `storage read didn't answer — ${String(e?.message ?? e)}` };
    }
  },
  async set(values) {
    try {
      return await boundedSend("kv.set", { values });
    } catch (e) {
      return { error: `storage write didn't answer — ${String(e?.message ?? e)}` };
    }
  },
  async remove(keys) {
    try {
      return await boundedSend("kv.remove", { keys });
    } catch (e) {
      return { error: `storage remove didn't answer — ${String(e?.message ?? e)}` };
    }
  },
};

// ── Developer features flag (CAP-FB-20260830-EXEC-BUILD-FLAG-01) ────────────
// One boolean preference, OFF by default, that hides the platform-building
// lanes (Tool library, Board permissions, Hooks, Advanced/system prompts) and
// the provider server-tools card from the DEFAULT Settings surface, and (via
// developerFeaturesOn() in lib/provider.js, which reads the SAME kv key) keeps
// the demo test model + its @demo-* markers and the developer-only browser
// tools out of a fresh profile. Nothing is deleted — the ids stay valid so a
// deep link still resolves, and turning the flag on renders every section
// exactly as before.
let developerFeaturesEnabled = false;

async function readDeveloperFeaturesFlag() {
  try {
    const got = await storage.get(DEVELOPER_FEATURES_KEY);
    developerFeaturesEnabled = got?.[DEVELOPER_FEATURES_KEY] === true;
  } catch {
    developerFeaturesEnabled = false;
  }
  return developerFeaturesEnabled;
}

// Show/hide every developer-marked nav item + section and the server-tools card.
// The server-tools AGENTS sub-panel is governed by the global server-tools
// toggle (renderProviders) when the flag is on, so we only force it closed when
// the flag is off — never open it here.
function applyDeveloperVisibility(on) {
  for (const el of document.querySelectorAll('[data-developer="true"]')) {
    el.hidden = !on;
  }
  if (!on) {
    const agentsPanel = document.getElementById("server-tools-agents");
    if (agentsPanel) agentsPanel.hidden = true;
  }
}

let storageGranted = false;

async function refreshStoragePermission() {
  try {
    storageGranted = await chrome.permissions.contains({ permissions: ["storage"] });
  } catch {
    storageGranted = false;
  }
  return storageGranted;
}

function blockSessionOnlyCredentialSave(input) {
  if (!credentialNeedsDurableStorage({ enteredKey: input?.value ?? "", storageGranted })) return false;
  saveFlash("Storage is missing from this installation. Reload the extension; if it is still missing, reinstall the extension before saving an API key.");
  return true;
}

async function providerStatusChanged() {
  // Re-read the (redacted) provider status + re-render the status surface so a
  // grant that landed on ANOTHER page (conversation "Grant network access")
  // is reflected here immediately.
  try {
    const status = await boundedSend("provider.status").catch(() => null);
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
    const summary = await boundedSend("tool-catalog.shadow", { action: "summary" });
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

  // The Settings preview: an EXPLICIT owner click on the component's
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

// ── local folders (CAP-FB-20260823-PERSISTENT-FS-ACCESS-01) ────────────────
export async function renderLocalFolders() {
  wireLocalFolderPickers({
    win: window,
    onFlash: saveFlash,
    onRender: () => renderLocalFolders(),
  });
  const host = $("#local-folders-list");
  if (!host) return;
  host.replaceChildren();

  let res;
  try {
    res = await boundedSend("fs-grant.list");
  } catch (e) {
    res = { ok: false, error: String(e?.message ?? e) };
  }

  const grants = Array.isArray(res?.grants) ? res.grants : [];
  if (grants.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty muted";
    empty.style.padding = "12px 14px";
    empty.style.fontSize = "13px";
    empty.textContent = "No local folder or file access has been granted. When you attach local directories to tasks or agents, they will be listed here.";
    host.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "folder-grants-list";
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "8px";

  for (const grant of grants) {
    const card = document.createElement("div");
    card.className = "folder-grant-card";
    card.style.display = "flex";
    card.style.alignItems = "center";
    card.style.justifyContent = "space-between";
    card.style.padding = "10px 14px";
    card.style.border = "1px solid var(--border,#e3e0d9)";
    card.style.borderRadius = "10px";
    card.style.background = "var(--panel,#ffffff)";
    card.style.gap = "12px";

    const info = document.createElement("div");
    info.style.display = "flex";
    info.style.flexDirection = "column";
    info.style.gap = "4px";
    info.style.minWidth = "0";

    const titleRow = document.createElement("div");
    titleRow.style.display = "flex";
    titleRow.style.alignItems = "center";
    titleRow.style.gap = "8px";

    const title = document.createElement("strong");
    title.textContent = grant.name || "Local folder";
    title.style.fontSize = "13.5px";

    const kindChip = document.createElement("span");
    kindChip.className = "chip";
    kindChip.style.fontSize = "11px";
    kindChip.style.padding = "1px 7px";
    kindChip.style.borderRadius = "999px";
    kindChip.style.border = "1px solid var(--border,#e3e0d9)";
    kindChip.textContent = grant.kind === "file" ? "file" : "directory";

    const modeChip = document.createElement("span");
    modeChip.className = "chip";
    modeChip.style.fontSize = "11px";
    modeChip.style.padding = "1px 7px";
    modeChip.style.borderRadius = "999px";
    modeChip.style.border = "1px solid var(--border,#e3e0d9)";
    modeChip.textContent = grant.mode === "readwrite" ? "read/write" : "read-only";

    const statusBadge = document.createElement("span");
    statusBadge.className = `chip avail-${grant.status === "granted" ? "ready" : grant.status === "prompt" ? "owner-action-required" : "disabled"}`;
    statusBadge.style.fontSize = "11px";
    statusBadge.style.padding = "1px 7px";
    statusBadge.style.borderRadius = "999px";
    statusBadge.textContent = grant.status === "granted" ? "active" : grant.status === "prompt" ? "needs re-grant" : grant.status;

    titleRow.append(title, kindChip, modeChip, statusBadge);

    const meta = document.createElement("div");
    meta.className = "meta muted";
    meta.style.fontSize = "12px";
    const scopeDesc = grant.scope?.taskId ? `Task: ${grant.scope.taskId}` : grant.scope?.agentId ? `Agent: ${grant.scope.agentId}` : "Global scope";
    meta.textContent = `${scopeDesc} · ID: ${grant.grantId}`;

    info.append(titleRow, meta);

    const cardControls = document.createElement("div");
    cardControls.style.display = "flex";
    cardControls.style.alignItems = "center";
    cardControls.style.gap = "8px";

    if (grant.status === "prompt") {
      const regrantBtn = document.createElement("button");
      regrantBtn.type = "button";
      regrantBtn.className = "btn small primary";
      regrantBtn.textContent = "Re-grant access";
      regrantBtn.addEventListener("click", async (event) => {
        if (!event.isTrusted) {
          saveFlash("Re-grant requires a genuine user click.");
          return;
        }
        regrantBtn.disabled = true;
        regrantBtn.textContent = "Requesting…";
        const result = await regrantFsGrantAccess(grant.grantId, {
          isTrusted: event.isTrusted,
        });
        if (result?.ok && result?.status === "granted") {
          saveFlash(`Re-granted access to "${grant.name}".`);
        } else if (result?.status === "denied") {
          saveFlash(`Access denied for "${grant.name}". You can revoke it if no longer needed.`);
        } else {
          saveFlash(`Re-grant not completed: ${result?.error || result?.status || "cancelled"}.`);
        }
        renderLocalFolders();
      });
      cardControls.append(regrantBtn);
    }

    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "btn small";
    browseBtn.textContent = "Browse";
    browseBtn.disabled = grant.status !== "granted";
    if (grant.status !== "granted") {
      browseBtn.title = "Re-grant access before browsing contents";
    }

    let drawer = null;
    browseBtn.addEventListener("click", async () => {
      if (drawer) {
        drawer.remove();
        drawer = null;
        browseBtn.textContent = "Browse";
        return;
      }
      browseBtn.textContent = "Close";
      drawer = document.createElement("div");
      drawer.className = "grant-browser-drawer";
      drawer.style.marginTop = "10px";
      drawer.style.padding = "10px 12px";
      drawer.style.borderRadius = "8px";
      drawer.style.background = "var(--bg-subtle,#f8f7f5)";
      drawer.style.border = "1px solid var(--border,#e3e0d9)";
      drawer.style.fontSize = "12px";
      drawer.style.width = "100%";
      drawer.style.boxSizing = "border-box";

      cardWrapper.append(drawer);

      // Full folder-tree navigation (breadcrumbs + Up + directory
      // click-through + file View) lives in lib/folder-browser.js; the
      // backend already resolves the relativePath into subdirectory
      // segments. `send` is injected so the drawer stays unit-testable.
      mountGrantBrowser({
        host: drawer,
        grant,
        send: (type, payload) => boundedSend(type, payload),
      });
    });

    const revokeBtn = document.createElement("button");
    revokeBtn.type = "button";
    revokeBtn.className = "btn small danger";
    revokeBtn.textContent = "Revoke";
    revokeBtn.addEventListener("click", async () => {
      const confirmed = await confirmActionDialog({
        title: "Revoke folder access?",
        body: `Revoke persistent access to "${grant.name}"? The agent will no longer be able to access this local path.`,
        confirmLabel: "Revoke access",
        destructive: true,
      });
      if (!confirmed) return;
      revokeBtn.disabled = true;
      const removeRes = await chrome.runtime.sendMessage({
        type: "fs-grant.remove",
        grantId: grant.grantId,
      }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
      if (removeRes?.ok) {
        saveFlash(`Revoked access to "${grant.name}".`);
      } else {
        saveFlash(`Revocation failed: ${removeRes?.error ?? "unknown error"}.`);
      }
      renderLocalFolders();
    });

    cardControls.append(browseBtn, revokeBtn);
    card.append(info, cardControls);

    const cardWrapper = document.createElement("div");
    cardWrapper.style.display = "flex";
    cardWrapper.style.flexDirection = "column";
    cardWrapper.style.width = "100%";
    cardWrapper.append(card);

    list.append(cardWrapper);
  }

  host.append(list);
}

// ── Providers ──
// The model field is the SHARED <model-picker> combobox (searchable, driven by
// the bundled model catalogue — lib/model-catalog.js, the ONE place a model id
// is written down for the user) so the main Providers section and the
// per-agent overrides behave identically. The catalogue's suggested ids are the
// "Recommended" head; once a key is entered the provider's LIVE /models list is
// merged below them. Providers without a catalogue (Ollama, LM Studio,
// OpenAI-compatible) run it in free-custom mode.
function providerCatalogue(p) {
  return Array.isArray(p.models) ? p.models : [];
}

// The provider's live model list, merged under the catalogue suggestions. The
// picker is UPDATED IN PLACE (never re-created) and an empty/failed fetch
// leaves the suggestions as they are — fetchLiveModels never throws.
const liveModelsInFlight = new WeakMap();
async function refreshLiveModels(card, p) {
  const picker = card.querySelector("model-picker");
  if (!picker) return;
  const apiKey = card.querySelector(".api-key")?.value ?? "";
  const baseURL = card.querySelector(".base-url")?.value || p.baseURL;
  if (!baseURL || (p.needsKey && !apiKey)) return;
  const token = Symbol("live-models");
  liveModelsInFlight.set(card, token);
  picker.setAttribute("loading", "");
  try {
    const live = await fetchLiveModels(p.id, { baseURL, apiKey });
    if (liveModelsInFlight.get(card) !== token) return; // a newer refresh won
    const suggested = providerCatalogue(p);
    const merged = [...suggested, ...live.filter((id) => !suggested.includes(id))];
    if (merged.length !== picker.models.length || merged.some((id, i) => picker.models[i] !== id)) {
      picker.models = merged;
    }
  } finally {
    if (liveModelsInFlight.get(card) === token) picker.removeAttribute("loading");
  }
}

// The card the panel LEADS with is the recommended default; selection state is
// the persisted cfg.provider. The rendered card carries role=radio in a
// radiogroup — a fresh user reads ONE recommended path, not seven equal presets.

function modelFieldHtml(p, cfg) {
  // The model field pre-fills the catalogue default (the recommended,
  // verified-callable id) so the user never saves a blank that would run the
  // demo model (CAP-FB-20260830-MODEL-CATALOG-CURRENT-01 / -PROVIDER-DEFAULT-01).
  const current = prefilledModelFor(p, cfg);
  const models = providerCatalogue(p);
  const ph = models.length ? "Search or type a model id…" : (p.id === "ollama" ? "e.g. llama3.1" : "model id");
  // The component is SELF-LABELED (its shadow .field carries the label) — no
  // outer wrapper, or two "Model" captions stack (k3 MEDIUM-2).
  return `<model-picker class="model" data-provider="${escapeAttr(p.id)}" placeholder="${escapeAttr(ph)}" models="${escapeAttr(JSON.stringify(models))}" recommended="${escapeAttr(JSON.stringify(models))}" value="${escapeAttr(current)}" label="Model"></model-picker>`;
}

// Return to the hub with the composer focused after a successful Use. Settings
// runs inside an in-page iframe on the hub (openView) OR as a standalone options
// tab; both are handled — postMessage to the hub parent, or navigate the
// standalone tab to the hub's #compose focus route.
function returnToHubComposer() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "cap:return-to-hub-composer" }, window.location.origin);
      return;
    }
  } catch { /* cross-origin parent — fall through to a full navigation */ }
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    window.location.href = chrome.runtime.getURL("ntp/ntp.html#compose");
  }
}

// The effective model: the shared component's committed value, or the
// provider's catalogue default when the field is empty (fall back to a legacy
// .model input during transition).
function effectiveModel(card) {
  const picker = card.querySelector("model-picker");
  if (picker) {
    // Commit typed-but-not-picked text BEFORE reading the value: the owner may
    // type a model id and click Use without selecting a suggestion — blur may
    // already have committed it, but a programmatic save path must not depend
    // on blur having fired (CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01).
    picker.commitTyped?.();
    return (picker.value ?? "") || defaultModelFor(card?.dataset?.provider ?? picker.dataset?.provider ?? "");
  }
  const select = card.querySelector(".model-select");
  if (select) {
    return select.value === "__custom__"
      ? (card.querySelector(".model-custom")?.value || "")
      : select.value;
  }
  return card.querySelector(".model")?.value || "";
}

// Build ONE provider card — a role=radio in a radiogroup. The recommended and
// alternative cards LEAD; the rest sit under "More providers". The four-click
// flow lives here: paste the key, Test connection (which gates), Use.
function buildProviderCard(p, cfg) {
  const isActive = cfg.provider === p.id;
  const badge = p.recommended
    ? `<span class="provider-badge recommended">Recommended</span>`
    : p.alternative
    ? `<span class="provider-badge">Alternative</span>`
    : "";
  const keyPage = keyPageFor(p.id);
  const getKeyLink = (p.needsKey && keyPage)
    ? `<a class="get-key" href="${escapeAttr(keyPage)}" target="_blank" rel="noopener" aria-label="Get a ${escapeAttr(p.name)} API key (opens in a new tab)">Get a key<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg></a>`
    : "";
  const card = document.createElement("div");
  card.className = "provider-card" + (isActive ? " active" : "");
  card.dataset.provider = p.id;
  card.setAttribute("role", "radio");
  card.setAttribute("aria-checked", String(isActive));
  card.tabIndex = isActive ? 0 : -1;
  card.setAttribute("aria-label", `${p.name}${isActive ? " (current default)" : ""}`);

  const hasFields = p.needsKey || p.onDevice || p.id === "ollama" || p.id === "lm-studio";
  card.innerHTML = `
    <div class="provider-head">
      <div class="provider-id">
        <span class="provider-name">${p.name}${badge}${
    isActive ? `<span class="provider-badge current" title="Current default">Current</span>` : ""
  }</span>
        <span class="muted provider-hint">${p.hint}</span>
      </div>
      <div class="provider-actions">
        <button class="btn small set-default" type="button" aria-label="${
    isActive ? `Update ${p.name}` : `Use ${p.name}`
  }">${isActive ? "Update" : "Use"}</button>
        <button class="btn small ghost test-connection" type="button" aria-label="Test connection for ${p.name}">Test connection</button>
      </div>
    </div>
    ${
    hasFields
      ? `
    <fieldset class="fields">
      <legend class="sr-only">${p.name} credentials</legend>
      ${
        p.needsKey
          ? `<label class="field key-field"><span class="field-label">API key</span><input class="api-key" type="password" placeholder="Paste your key" autocomplete="off">${getKeyLink}</label>`
          : ""
      }
      <details class="provider-advanced">
        <summary>Advanced</summary>
        <div class="advanced-body">
          <label class="field"><span class="field-label">Base URL</span><input class="base-url" type="text" placeholder="https://…" value="${
        escapeAttr(isActive ? (cfg.baseURL || p.baseURL) : p.baseURL)
      }"></label>
          ${p.needsModel ? modelFieldHtml(p, cfg) : ""}
        </div>
      </details>`
      : ""
  }
    <div class="test-status" role="status" hidden></div>
  `;

  // ── The Use gate: Use is disabled until Test passes for the CURRENT key +
  // model; any edit to either resets it. A keyless provider and the currently-
  // active default are exempt (they can Use/Update without a fresh test).
  const useBtn = card.querySelector(".set-default");
  const refreshUseState = () => {
    if (!useBtn) return;
    const enabled = useEnabled({ testPassed: card._testPassed === true, isActive, needsKey: p.needsKey !== false });
    useBtn.disabled = !enabled;
    useBtn.title = enabled ? "" : "Test the connection first";
  };
  card._testPassed = false;
  refreshUseState();

  const credentialInput = card.querySelector(".api-key");
  // Editing the key resets the test gate (a passed test no longer describes the
  // current key) and refetches the live model list on commit.
  credentialInput?.addEventListener("input", () => { card._testPassed = false; refreshUseState(); });
  credentialInput?.addEventListener("change", () => { refreshLiveModels(card, p); });
  // Editing the model likewise resets the gate.
  card.querySelector("model-picker")?.addEventListener("change", () => { card._testPassed = false; refreshUseState(); });
  card.querySelector(".base-url")?.addEventListener("input", () => { card._testPassed = false; refreshUseState(); });

  bindProviderSetDefault({
    card,
    provider: p,
    currentConfig: cfg,
    shouldBlock: () => blockSessionOnlyCredentialSave(credentialInput),
    requestHostAccess: requestProviderHostAccess,
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    onAccess(access, outcome) {
      // A provider.set refusal (e.g. "model id missing") is a failure, not a
      // success flash (CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01).
      if (outcome?.saved && outcome.saved.ok === false) {
        saveFlash(`${p.name} was not updated — ${outcome.saved.reason || outcome.saved.error || "check the provider settings"}.`);
        card._saveFailed = true;
      } else if (access.status === "pending") {
        saveFlash(`Saved ${p.name}. Chrome's network-access decision is still pending; provider requests remain blocked until access is granted.`);
      } else if (access.status === "denied") {
        saveFlash(`Saved ${p.name}, but network access was not granted — provider requests remain blocked. Re-enable it when Chrome asks.`);
      } else {
        saveFlash(isActive ? `Updated ${p.name}.` : `Set ${p.name} as default.`);
      }
    },
    onSaved(outcome) {
      const failed = outcome?.saved && outcome.saved.ok === false;
      // A successful Use of a real keyed provider returns to the hub with the
      // composer focused (the four-click flow's fourth click). A refusal, or a
      // local/demo provider, just re-renders in place.
      if (!failed && p.needsKey) {
        returnToHubComposer();
        return;
      }
      renderProviders(true);
    },
  });

  card.querySelector(".test-connection")?.addEventListener("click", async () => {
    const testBtn = card.querySelector(".test-connection");
    const testStatus = card.querySelector(".test-status");
    const enteredKey = card.querySelector(".api-key")?.value ?? "";
    const fields = {
      provider: p.id,
      baseURL: card.querySelector(".base-url")?.value ?? p.baseURL,
      apiKey: enteredKey, // "" → the SW merges the stored key
      model: effectiveModel(card),
    };
    testStatus.hidden = false;
    testStatus.className = "test-status testing";
    testStatus.textContent = "Testing…";
    testBtn.disabled = true;
    await requestProviderHostAccess({ baseURL: fields.baseURL });
    const res = await chrome.runtime.sendMessage({ type: "provider.test", ...fields });
    testBtn.disabled = false;
    testStatus.className = "test-status " + (res?.ok ? "ok" : "err");
    if (res?.ok) {
      const toolNote = res.toolCheck
        ? (res.toolCheck.ok ? ` — browser read ok (${res.toolCheck.tabs} tab${res.toolCheck.tabs === 1 ? "" : "s"})` : " — browser read unavailable")
        : "";
      testStatus.textContent = `Connected — ${res.detail ?? "ok"} (${res.latencyMs}ms)${toolNote}`;
      card._testPassed = true;
      refreshLiveModels(card, p);
    } else {
      testStatus.textContent = `Failed — ${res?.error ?? "unknown error"}`;
      card._testPassed = false;
    }
    refreshUseState();
  });

  // The active card offers Clear key + shows the stored-key placeholder.
  if (isActive && cfg.hasApiKey) {
    const k = card.querySelector(".api-key");
    if (k) k.placeholder = "Key set — leave blank to keep";
    const clear = document.createElement("button");
    clear.className = "btn ghost small clear-key";
    clear.type = "button";
    clear.textContent = "Clear key";
    clear.setAttribute("aria-label", `Clear API key for ${p.name}`);
    clear.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "provider.clear-key" });
      saveFlash("API key cleared.");
      renderProviders(true);
    });
    card.querySelector(".provider-actions")?.appendChild(clear);
  }
  return card;
}

async function renderProviders(restoreFocus = false) {
  // Route the provider read through the SERVICE WORKER (single authority) — never
  // call lib/provider.js's kv* directly in this page realm (the round-16 split-
  // authority finding). BOUNDED: a killed/suspended worker must not leave
  // Providers blank — settle with an honest error + Retry.
  const recRoot = $("#provider-recommended");
  const moreRoot = $("#provider-more");
  let cfg;
  try {
    cfg = await boundedSend("provider.get");
  } catch (e) {
    if (recRoot) {
      recRoot.innerHTML = `<div class="muted">Couldn't load providers — the agent worker didn't answer (${escapeHtml(String(e?.message ?? e))}).</div>` +
        `<button class="btn small" type="button" id="retry-providers">Retry</button>`;
      recRoot.querySelector("#retry-providers")?.addEventListener("click", () => renderProviders(restoreFocus));
    }
    return;
  }
  // A stored internal provider remains runtime authority, but is not a public
  // card. Explain that state without mutating, auto-selecting, or erasing it.
  renderInternalProviderStatus(
    $("#provider-selection-status"),
    providerSelectionPresentation(cfg, PROVIDERS),
  );
  if (!recRoot || !moreRoot) return;
  recRoot.innerHTML = "";
  moreRoot.innerHTML = "";

  const lead = leadingProviders(PROVIDERS);
  const rest = moreProviders(PROVIDERS);
  for (const p of lead) recRoot.appendChild(buildProviderCard(p, cfg));
  for (const p of rest) moreRoot.appendChild(buildProviderCard(p, cfg));

  // If the active default is one of the "More providers", open the disclosure
  // so the user can see their current selection without hunting for it.
  const more = $("#more-providers");
  if (more && rest.some((p) => p.id === cfg.provider)) more.open = true;

  // ── radiogroup keyboard: arrow/Home/End move the checked selection + focus
  // within each group (cards only; an arrow inside a text input is left alone).
  for (const group of [recRoot, moreRoot]) {
    group.addEventListener("keydown", (e) => {
      const target = e.target;
      if (!target?.classList?.contains?.("provider-card")) return; // typing in a field
      const cards = [...group.querySelectorAll(".provider-card")];
      const cur = cards.indexOf(target);
      if (cur < 0) return;
      let next = null;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") next = cards[(cur + 1) % cards.length];
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = cards[(cur - 1 + cards.length) % cards.length];
      else if (e.key === "Home") next = cards[0];
      else if (e.key === "End") next = cards[cards.length - 1];
      else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        target.querySelector(".api-key, .set-default")?.focus();
        return;
      } else return;
      e.preventDefault();
      for (const c of cards) c.tabIndex = c === next ? 0 : -1;
      next.focus();
    });
  }

  if (restoreFocus) {
    // Rerender replaces the focused subtree — re-focus a STABLE anchor (the
    // active/checked card, else the first card) so a keyboard/AT user is not
    // stranded.
    const anchor = recRoot.querySelector('.provider-card[aria-checked="true"]') ||
      moreRoot.querySelector('.provider-card[aria-checked="true"]') ||
      recRoot.querySelector(".provider-card");
    anchor?.focus();
  }
}

// ── Site enrollment (owner-driven, install-grant verified) ──
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
    // OPTIONAL + JIT model: the enroll click IS the user gesture — request
    // the scripting permission + the site's origin here.
    let granted;
    try {
      granted = (await chrome.permissions.request({
        permissions: ["scripting"],
        origins: matches,
      })) === true;
    } catch (e) {
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

// ── Discovered open tabs (proactive one-click enrollment without typing) ──
async function renderDiscoveredOpenTabs() {
  const container = $("#discovered-tabs");
  if (!container) return;
  const enrolledOrigins = new Set(await boundedSend("agent.list").catch(() => []));
  const listing = await boundedSend("agent.discoverable-tabs", { toolsOnly: true }).catch(() => ({ ok: false }));
  container.replaceChildren();
  if (!listing?.ok || !Array.isArray(listing.tabs) || !listing.tabs.length) {
    container.style.display = "none";
    return;
  }
  const unenrolled = listing.tabs.filter((t) => !enrolledOrigins.has(t.origin));
  if (!unenrolled.length) {
    container.style.display = "none";
    return;
  }
  container.style.display = "block";
  const header = document.createElement("div");
  header.className = "muted small";
  header.style.marginBottom = "8px";
  header.style.fontWeight = "600";
  header.textContent = "Discovered open pages — click to add as Site Agent:";
  container.appendChild(header);

  for (const t of unenrolled.slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "origin-row";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.marginBottom = "6px";

    const info = document.createElement("div");
    info.style.overflow = "hidden";
    info.style.textOverflow = "ellipsis";
    info.style.whiteSpace = "nowrap";
    info.style.marginRight = "8px";

    const titleSpan = document.createElement("span");
    titleSpan.style.fontWeight = "600";
    titleSpan.textContent = t.title || t.origin;
    const urlSpan = document.createElement("span");
    urlSpan.className = "muted small";
    urlSpan.style.marginLeft = "8px";
    urlSpan.textContent = t.origin;
    info.appendChild(titleSpan);
    info.appendChild(urlSpan);
    row.appendChild(info);

    const enrollBtn = document.createElement("button");
    enrollBtn.type = "button";
    enrollBtn.className = "btn small primary";
    enrollBtn.textContent = "Add Site Agent";
    enrollBtn.setAttribute("aria-label", `Add Site Agent for ${t.origin}`);
    enrollBtn.addEventListener("click", async () => {
      // Verify the install grant (scripting + host are granted at install);
      // there is no runtime request left to make. Fail closed on error.
      let granted = false;
      try {
        granted = (await chrome.permissions.contains({
          permissions: ["scripting"],
          origins: [`${t.origin}/*`],
        })) === true;
      } catch {
        saveFlash(siteAgentSetupMessage("permission-error", t.origin));
        return;
      }
      if (!granted) {
        saveFlash(siteAgentSetupMessage("permission-denied", t.origin));
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: "agent.enroll-origin",
        origin: t.origin,
        ownerGesture: true,
        tabId: t.id,
      }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      const state = enrollOutcomeState(res, { selectedTab: true });
      saveFlash(siteAgentSetupMessage(state, t.origin));
      renderData();
      renderEnrolledSites();
      renderWebmcpStatus();
      renderDiscoveredOpenTabs();
    });
    row.appendChild(enrollBtn);
    container.appendChild(row);
  }
}

// ── Enrolled sites (the removal action lives HERE — the agent lifecycle, not the
//    Data & memory section — item 58) ──
async function renderEnrolledSites() {
  const el = $("#enrolled-sites");
  if (!el) return;
  await renderDiscoveredOpenTabs();
  const origins = await boundedSend("agent.list").catch(() => []);
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
  try { diag = await boundedSend("webmcp.diagnostics.get"); } catch { /* SW not ready */ }
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
    // Rebuild the running orchestrator so the fan-out / solo switch takes effect
    // immediately (the worker reads cap:multiAgent at orchestration time).
    try {
      await chrome.runtime.sendMessage({ type: "invalidate-agent" });
    } catch {
      /* worker may not be running yet — the setting still persists */
    }
    saveFlash("Agent mode saved.");
  });

  // Provider server tools (Gemini google_search, Anthropic web_search): the GLOBAL toggle gates
  // every agent; a per-agent opt-in then admits each agent individually. Both
  // live in ONE kv record ({ enabled, agents: { [id]: bool } }) so the service
  // worker reads them atomically at every tool-source snapshot.
  const stCfg = ((await storage.get("cap:providerServerTools"))["cap:providerServerTools"]) ?? {};
  const stToggle = $("#server-tools-enabled");
  stToggle.checked = stCfg.enabled === true;
  const persistServerTools = async (next) => {
    await storage.set({ "cap:providerServerTools": next });
    // Availability is read live per snapshot, but the provider LANE is
    // build-fixed — invalidate so a just-enabled native-lane agent rebuilds.
    try {
      await chrome.runtime.sendMessage({ type: "invalidate-agent" });
    } catch { /* worker may not be running — the setting still persists */ }
  };
  stToggle.addEventListener("toggle", async (e) => {
    const cur = ((await storage.get("cap:providerServerTools"))["cap:providerServerTools"]) ?? {};
    await persistServerTools({ ...cur, enabled: e.detail.checked === true });
    renderServerToolAgents(e.detail.checked === true);
    saveFlash("Provider server tools saved.");
  });
  async function renderServerToolAgents(globalOn) {
    const box = $("#server-tools-agents");
    const list = $("#server-tools-agent-list");
    if (!box || !list) return;
    box.hidden = !globalOn;
    list.replaceChildren();
    if (!globalOn) return;
    const cur = ((await storage.get("cap:providerServerTools"))["cap:providerServerTools"]) ?? {};
    const agents = cur.agents && typeof cur.agents === "object" ? cur.agents : {};
    let named = [];
    try {
      const r = await boundedSend("named-agent.list");
      named = Array.isArray(r?.agents) ? r.agents : [];
    } catch { named = []; }
    const rows = [{ key: "hub", name: "Hub (the main agent)" },
      // Paid provider-tool authority follows the immutable instance identity.
      // Legacy agents without one are omitted (fail closed), never slug-keyed.
      ...named.map((a) => ({ key: String(a?.instanceId ?? ""), name: String(a?.name ?? a?.id ?? "agent") }))]
      .filter((a) => a.key);
    for (const a of rows) {
      const field = document.createElement("div");
      field.className = "toggle-field";
      const t = document.createElement("switch-toggle");
      t.setAttribute("label", a.name);
      t.checked = agents[a.key] === true;
      t.addEventListener("toggle", async (e) => {
        const latest = ((await storage.get("cap:providerServerTools"))["cap:providerServerTools"]) ?? {};
        const latestAgents = latest.agents && typeof latest.agents === "object" ? { ...latest.agents } : {};
        latestAgents[a.key] = e.detail.checked === true;
        await persistServerTools({ ...latest, agents: latestAgents });
        saveFlash(`Provider server tools ${e.detail.checked ? "enabled" : "disabled"} for ${a.name}.`);
      });
      const text = document.createElement("div");
      text.className = "toggle-text";
      const nm = document.createElement("span");
      nm.className = "toggle-name";
      nm.textContent = a.name;
      const hint = document.createElement("span");
      hint.className = "muted";
      hint.textContent = "Can search the web during its runs.";
      text.append(nm, hint);
      field.append(t, text);
      list.appendChild(field);
    }
  }
  await renderServerToolAgents(stToggle.checked);

  // Interactive and scheduled agents share one management list. The data
  // models remain separate; this function only joins their presentation.
  await renderUnifiedAgentSettings();
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
  const providersAttr = escapeAttr(JSON.stringify(PROVIDERS.map((p) => ({ id: p.id, name: p.name, icon: "terminal" }))));
  const internalDisabled = selection.hiddenInternal ? "disabled" : "";
  return `
    <div class="agent-row-summary">
      <div class="agent-row-copy">
        <div class="agent-row-title"><strong title="${escapeAttr(a.name)}">${escapeHtml(a.name)}</strong><span class="agent-mode-badge">${escapeHtml(agentScheduleMarker({ ...a, kind: "named" }))}</span></div>
        <span class="muted">${escapeHtml(a.role || "Interactive agent")}</span>
      </div>
    </div>
    <provider-select class="ag-provider" providers="${providersAttr}" value="${escapeAttr(provider)}" label="Provider" placeholder="${selection.hiddenInternal ? "Choose a listed provider" : "Use the global provider"}"></provider-select>
    <model-picker class="ag-model" models="${escapeAttr(JSON.stringify(models))}" value="${escapeAttr(selection.hiddenInternal ? "" : (cur.model ?? ""))}" label="Model id" placeholder="${models.length ? "Search or type a model id…" : "model id"}" ${provider ? "" : "disabled"}></model-picker>
    <label class="field ag-base-url" ${needsBaseURL ? "" : "hidden"}><span class="field-label">Base URL</span><input class="agent-provider-base-url" type="text" placeholder="https://your-endpoint/v1" value="${escapeAttr(baseURLDefault)}"></label>
    <label class="field"><span class="field-label">API key (write-only)</span><input class="agent-provider-key" type="password" placeholder="${selection.hiddenInternal ? "Not used by the active internal provider" : cur.hasApiKey ? "(kept — blank keeps it)" : "…"}" autocomplete="off" title="${selection.hiddenInternal ? "Choose a listed provider before entering a key" : cur.hasApiKey ? "A saved key is kept when this field is left blank" : "API key"}" ${internalDisabled}></label>
    <p class="hint agent-provider-internal-status" hidden></p>
    <div class="ag-actions">
      <button class="btn small set-agent-provider" type="button" ${internalDisabled}>Save provider</button>
      ${!selection.hiddenInternal && cur.provider && cur.hasApiKey ? `<button class="btn small ghost clear-agent-key" type="button" aria-label="Clear the stored API key for ${escapeAttr(a.name)}">Clear key</button>` : ""}
      <button class="btn small ghost edit-named-agent" type="button">Edit persona &amp; schedule</button>
      <button class="btn small ghost delete-named-agent" type="button" style="color:var(--danger,#b3261e);border-color:var(--border);" aria-label="Delete ${escapeAttr(a.name)}">Delete</button>
    </div>
  `;
}

// A per-agent provider change is a destructive named-agent mutation. The SW
// deliberately returns a pending capability on the first exact call. This modal
// is the explicit owner decision between that call and its one exact retry —
// dismissal/cancel can only deny, never approve.
//
// This was a hand-rolled <dialog> (CAP-FB-20260827-DIALOG-CONSOLIDATION-01).
// The one property that justified the copy — approve only on a genuine,
// trusted click — now lives in the shared confirm as `requireGenuineGesture`,
// so it is available to every future approval by construction instead of being
// re-implemented from memory. Semantics are unchanged: Cancel, Escape and
// backdrop dismissal all deny, and a script-driven click cannot approve.
function confirmAgentProviderMutation(agentName, description, trigger) {
  return confirmActionDialog({
    title: "Approve provider change?",
    body: `${description} for ${agentName}? This changes which model service the agent may use.`,
    note: "Only Approve once saves this exact change.",
    confirmLabel: "Approve once",
    requireGenuineGesture: true,
    returnFocusTo: trigger ?? null,
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

function openNamedAgentEditor(agent) {
  const message = { type: "cap:edit-named-agent", id: agent.id };
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
    return;
  }
  window.location.href = chrome.runtime.getURL(`ntp/ntp.html#agent=named:${encodeURIComponent(agent.id)}&edit=1`);
}

async function renderAgentProviders(list, projectedAgents, globalCfg) {
  for (const projected of projectedAgents) {
    const a = projected.namedAgent;
    if (!a) continue;
    const row = document.createElement("div");
    row.className = "agent-settings-row agent-provider-row";
    // The stored override is REDACTED (no key) — the provider + model are shown,
    // the key is entered (and only ever written, never read back).
    const cur = a.provider ?? {};
    const storedSelection = providerSelectionPresentation(cur, PROVIDERS);
    row.innerHTML = agentProviderRowHtml(a, cur, globalCfg);
    const internalStatus = row.querySelector(".agent-provider-internal-status");
    renderInternalProviderStatus(internalStatus, storedSelection);
    const agentCredentialInput = row.querySelector(".agent-provider-key");
    const setAgentProvider = row.querySelector(".set-agent-provider");
    row.querySelector(".edit-named-agent")?.addEventListener("click", () => openNamedAgentEditor(a));

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
        await renderUnifiedAgentSettings();
      } else {
        trigger.disabled = false;
        trigger.focus();
        saveFlash(`Key not cleared: ${r.error ?? "unknown error"}`);
      }
    });
    row.querySelector(".delete-named-agent")?.addEventListener("click", async () => {
      const confirmed = await confirmActionDialog({
        title: `Delete “${a.name}”?`,
        body: `Are you sure you want to delete ${a.name}? This will remove the agent and its custom configuration.\n\nNote: Any created artifacts will be retained.`,
        confirmLabel: "Delete agent",
        destructive: true,
      });
      if (!confirmed) return;
      const res = await chrome.runtime
        .sendMessage({ type: "named-agent.delete", id: a.id })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok !== false) {
        saveFlash(`Deleted ${a.name}.`);
      } else {
        saveFlash(`Could not delete ${a.name}: ${res?.error ?? "failed"}.`);
      }
      await renderUnifiedAgentSettings();
    });
    setAgentProvider.addEventListener("click", async (event) => {
      const trigger = event.currentTarget;
      const provider = row.querySelector(".ag-provider")?.value ?? "";
      const model = row.querySelector(".ag-model")?.value?.trim() ?? "";
      const apiKey = agentCredentialInput.value;
      if (blockSessionOnlyCredentialSave(agentCredentialInput)) return;
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
        await renderUnifiedAgentSettings();
      } else {
        trigger.disabled = false;
        trigger.focus();
        saveFlash(`Provider not saved: ${r.error ?? "unknown error"}`);
      }
    });
    if (projected.backgroundAgent) backgroundAgentRow(projected.backgroundAgent, row);
    list.appendChild(row);
  }
}

// ── Background agents (scheduled recipes) ──
function backgroundAgentRow(a, hostRow = null) {
  const row = hostRow ?? document.createElement("div");
  row.classList.add("agent-settings-row", "background-agent-row");

  const name = document.createElement("span");
  name.className = "perm-name";
  name.textContent = hostRow ? "Scheduled automation" : a.name;

  const state = document.createElement("span");
  state.className = "agent-mode-badge";
  state.textContent = agentScheduleMarker({ ...a, kind: "background" });

  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = a.description || "Scheduled agent";

  const toggle = document.createElement("switch-toggle");
  toggle.setAttribute("label", `${a.enabled ? "Disable" : "Enable"} ${a.name}`);
  toggle.checked = Boolean(a.enabled);

  toggle.addEventListener("toggle", async (e) => {
    const enabled = e.detail.checked;
    // ENABLE time: notifications are granted at install — VERIFY only (a
    // runtime request no longer exists). Best-effort: if the install grant is
    // somehow absent the run-time path skips the notification silently.
    if (enabled) {
      try {
        await chrome.permissions?.contains?.({ permissions: ["notifications"] });
      } catch { /* unverifiable — the run-time path skips */ }
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
      const out = await chrome.runtime
        .sendMessage({ type: "recipe.delete", id: a.id })
        .catch(() => ({ ok: false }));
      if (out?.ok === true) {
        saveFlash(`Deleted ${a.name}.`);
        renderBackgroundAgents();
      } else {
        saveFlash(`Could not delete ${a.name}: ${out?.error ?? "failed"}.`);
      }
    });
    actions.append(del);
  }

  if (hostRow) {
    const controls = document.createElement("div");
    controls.className = "background-agent-controls";
    controls.append(name, state, hint, toggle, actions);
    row.append(controls);
  } else {
    row.append(name, state, hint, toggle, actions);
  }
  return row;
}

// Edit a skill's system prompt: a dialog with the current prompt in a textarea
// + Save. The user-edited value is set via .value / textContent, never innerHTML.
//
// This was the third hand-rolled <dialog> (CAP-FB-20260827-DIALOG-CONSOLIDATION-01).
// It is a CONTENT dialog rather than a decision, so it uses <agent-dialog> — the
// shared shell — which brings the close button, backdrop light-dismiss, Escape,
// the focus trap, focus return and scrollable overflow that the hand-rolled copy
// only partly had. In particular the copy had no close button and no light
// dismiss, so a fix to either of the other two dialogs never reached it.
function editRecipePrompt(recipe) {
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", `${recipe.name} — system prompt`);

  const textarea = document.createElement("textarea");
  textarea.rows = 8;
  textarea.className = "recipe-edit-textarea";
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

  dialog.append(textarea, actions);
  document.body.append(dialog);
  // The shell emits "close" for Escape, the X and the backdrop alike, so there
  // is one removal path rather than one per dismissal route.
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.show();
  textarea.focus();
}

// Settings offers the SAME scheduled catalogue as the hub's create flow,
// through the SAME component (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01):
// the disabled background recipes render as <agent-template-card>s inside an
// <agent-template-gallery> filtered to Scheduled. Choosing a card selects it;
// "Add" enables exactly ONE recipe through background-agent.set, and it then
// appears in every agent list.
function renderBackgroundAgentPicker(agents) {
  const host = $("#background-agent-add");
  if (!host) return;
  host.replaceChildren();
  if (!agents.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const copy = document.createElement("div");
  copy.className = "background-agent-add-copy";
  const title = document.createElement("h3");
  title.id = "background-agent-add-title";
  title.textContent = "Add a scheduled agent";
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Choose a built-in scheduled template, then add it to your agents.";
  copy.append(title, hint);
  host.setAttribute("role", "group");
  host.setAttribute("aria-labelledby", title.id);

  const gallery = document.createElement("agent-template-gallery");
  gallery.id = "background-agent-gallery";
  gallery.setAttribute("filters", "scheduled");
  gallery.setAttribute("filter", "scheduled");
  gallery.templates = agents.map(recipeAsTemplate).filter(Boolean);

  const controls = document.createElement("div");
  controls.className = "background-agent-add-controls";
  const chosen = document.createElement("span");
  chosen.className = "muted background-agent-add-chosen";
  chosen.setAttribute("role", "status");
  chosen.setAttribute("aria-live", "polite");
  chosen.textContent = "Nothing chosen yet.";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn primary";
  add.textContent = "Add";
  add.disabled = true;
  let selectedId = "";
  gallery.addEventListener("use", (event) => {
    selectedId = String(event.detail?.id ?? "");
    const agent = agents.find((candidate) => candidate.id === selectedId);
    add.disabled = !agent;
    chosen.textContent = agent ? `${agent.name} — runs every ${agent.schedule?.periodInMinutes ?? "?"} min once added.` : "Nothing chosen yet.";
    add.textContent = agent ? `Add ${agent.name}` : "Add";
  });
  add.addEventListener("click", async () => {
    const agent = agents.find((candidate) => candidate.id === selectedId);
    if (!selectedId || !agent) return;
    add.disabled = true;
    const out = await chrome.runtime.sendMessage({ type: "background-agent.set", id: selectedId, enabled: true })
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    saveFlash(out?.ok ? `${agent.name} added.` : `Could not add ${agent.name}: ${out?.error ?? "failed"}.`);
    await renderUnifiedAgentSettings();
  });
  controls.append(chosen, add);
  host.append(copy, gallery, controls);
}

async function renderUnifiedAgentSettings() {
  const list = $("#unified-agent-list");
  if (!list) return;
  const [namedRes, backgroundRes, globalCfg] = await Promise.all([
    boundedSend("named-agent.list").catch(() => ({ agents: [] })),
    boundedSend("background-agent.list").catch(() => ({ agents: [] })),
    boundedSend("provider.get").catch(() => null),
  ]);
  const named = Array.isArray(namedRes?.agents) ? namedRes.agents : [];
  const background = backgroundAgentsForDisplay(backgroundRes?.agents);
  const existingBackground = background.filter((agent) => agent.enabled === true);
  const unified = projectUnifiedAgents(named, existingBackground);
  renderBackgroundAgentPicker(background.filter((agent) => agent.enabled !== true));

  list.replaceChildren();
  if (!unified.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No agents yet.";
    list.appendChild(empty);
    return;
  }
  await renderAgentProviders(list, unified.filter((agent) => agent.namedAgent), globalCfg);
  for (const projected of unified) {
    if (!projected.namedAgent) list.appendChild(backgroundAgentRow(projected.backgroundAgent));
  }
}

async function renderBackgroundAgents() {
  await renderUnifiedAgentSettings();
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
      // chrome.storage.local, which needs the "storage" permission — now
      // GRANTED AT INSTALL, so VERIFY it (no runtime request exists). If the
      // verify fails the grant would be SESSION-ONLY (the SW's in-memory
      // fallback) — surfaced honestly below.
      let storageGranted = true;
      try {
        storageGranted = (await chrome.permissions.contains({ permissions: ["storage"] })) === true;
      } catch { storageGranted = false; }
      // The Screenshots capability uses the SILENT `activeTab` permission
      // (NOT `tabs`, which warns) — this ENABLES Chrome's
      // transient owner-invoked capture (clicking the extension icon while
      // viewing a page). It never authorizes a background or model-selected
      // capture (those require exact site access). Granted at install —
      // verified here. Denial degrades gracefully: the grant still covers
      // open/navigate/close; only icon-click screenshots become unavailable.
      let captureGranted = false;
      try {
        captureGranted = (await chrome.permissions.contains({
          permissions: ["activeTab"],
        })) === true;
      } catch { /* unreadable — activeTab treated as absent */ }
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
        // The switch must show the TRUE grant state, not the click: re-read
        // it from the service worker (CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01).
        const live = await chrome.runtime.sendMessage({ type: "browser-control.get" })
          .catch(() => null);
        toggle.checked = live?.active === true;
        $("#grant-origins").hidden = !toggle.checked;
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

// ── Action policy (CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01) ──
// The three visible classes (Read / Act / Destructive) are described in the
// panel; the one settable control is the Destructive class — "Always ask"
// (default: every destructive browser action shows an approval card) or "Never
// allow" (blocked outright). There is deliberately no "auto" for Destructive.
const DESTRUCTIVE_POLICY_KEY = "cap:destructiveActionPolicy";
async function renderActionPolicy() {
  const select = $("#destructive-policy");
  if (!select) return;
  const s = await storage.get(DESTRUCTIVE_POLICY_KEY);
  select.value = s?.[DESTRUCTIVE_POLICY_KEY] === "never" ? "never" : "ask";
  select.addEventListener("change", async (e) => {
    const value = e.target.value === "never" ? "never" : "ask";
    const res = await storage.set({ [DESTRUCTIVE_POLICY_KEY]: value });
    if (res?.error) {
      saveFlash("Action policy save failed — " + res.error);
      return;
    }
    saveFlash(
      value === "never"
        ? "Destructive browser actions are now blocked."
        : "Destructive browser actions will always ask.",
    );
  });
}

// ── Permissions (OPTIONAL + JIT: three honest states per capability) ──
// OPTIONAL + JIT model (owner directive 2026-08-29, superseding the
// 2026-08-28 install-granted model for capabilities): capability permissions
// are requested HERE from the owner's click (a genuine user gesture — the
// SW can never call chrome.permissions.request). THREE states, never
// collapsed: granted / requestable (with an Enable affordance) /
// platform-unavailable (ChromeOS-only APIs on desktop — saying "reload the
// extension" there is a lie). Host access (<all_urls>) stays install-granted
// and is not part of this list.
async function renderPermissions() {
  const list = $("#permission-list");
  list.replaceChildren();
  const mandatory = new Set(chrome.runtime.getManifest().permissions ?? []);
  for (const cap of CAPABILITIES) {
    if ((cap.permissions ?? []).every((p) => mandatory.has(p))) continue;
    const st = await capabilityState(cap.id);
    const row = document.createElement("div");
    row.className = "perm-row";

    const name = document.createElement("span");
    name.className = "perm-name";
    name.textContent = cap.label;

    const state = document.createElement("span");
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = cap.hint;

    const gates = document.createElement("span");
    gates.className = "perm-gates";
    gates.textContent = cap.gates ?? `Gates: ${cap.label.toLowerCase()}.`;

    if (st.state === "granted") {
      state.className = "perm-state granted";
      state.textContent = "Granted";
      // Optional capabilities are runtime-revocable: an honest control. The
      // revoke goes through the service worker's `capability.revoke` route —
      // the single authority for the dependent teardown (the owner approval
      // dialog, storage's snapshot, alarms' disarm, and for scripting the
      // tombstoning of every enrolled origin's dynamic content script). The
      // page-realm revoke in lib/capabilities.js only removes the permission and left every
      // enrolled bridge registered (CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01).
      // Permission REQUESTS stay in the page below: only the click gesture can
      // call chrome.permissions.request.
      const off = document.createElement("button");
      off.className = "btn small ghost";
      off.textContent = "Turn off";
      off.setAttribute("aria-label", `Turn off ${cap.label}`);
      off.addEventListener("click", async () => {
        off.disabled = true;
        const res = await runOwnerApprovedMutation({
          message: { type: "capability.revoke", id: cap.id },
          action: "capability.revoke",
          sendMessage: (value) => chrome.runtime.sendMessage(value),
          requestConfirmation: () => confirmActionDialog({
            title: `Turn off ${cap.label}?`,
            body: cap.id === "scripting"
              ? `${cap.label} will stop for every site you added: their agents are removed and Chrome's access to those sites is released.`
              : `${cap.label} will be turned off and the agent can no longer use it until you enable it again.`,
            confirmLabel: "Turn off",
            destructive: true,
            requireGenuineGesture: true,
            returnFocusTo: off,
          }),
        });
        if (!res.ok) {
          saveFlash(res.cancelled
            ? `${cap.label} stays on; nothing was changed.`
            : `Could not turn off ${cap.label}: ${res.error ?? "unknown error"}`);
        }
        renderPermissions();
      });
      row.append(name, state, off, hint, gates);
    } else if (st.state === "platform-unavailable" || st.state === "partial-platform-unavailable") {
      state.className = "perm-state unavailable";
      state.textContent = "Not available on this platform";
      hint.textContent = st.state === "partial-platform-unavailable"
        ? `${cap.hint} The ${st.unavailablePermissions.join(" / ")} API exists only on ChromeOS; the rest works here.`
        : `${cap.hint} This API exists only on ChromeOS.`;
      row.append(name, state, hint, gates);
    } else {
      state.className = "perm-state missing";
      state.textContent = "Not enabled";
      // The JIT request affordance: this click handler IS the user gesture
      // chrome.permissions.request requires — never route this through the SW.
      const enable = document.createElement("button");
      enable.className = "btn small";
      enable.textContent = "Enable";
      enable.addEventListener("click", async () => {
        enable.disabled = true;
        const res = await requestCapability(cap.id).catch(() => ({ granted: false }));
        if (res?.granted) renderPermissions();
        else { enable.disabled = false; enable.textContent = "Enable failed — try again"; }
      });
      row.append(name, state, enable, hint, gates);
    }
    list.appendChild(row);
  }
  // Mandatory boot-critical permissions get an honest fixed row (they are
  // not runtime-revocable and never appear in the optional list).
  const mandatoryLabels = {
    storage: "Memory & settings (core)",
    alarms: "Scheduled tasks (core)",
    sidePanel: "Side panel (core)",
    offscreen: "Background execution host (internal)",
  };
  const manifestPerms = chrome.runtime.getManifest().permissions ?? [];
  for (const p of manifestPerms) {
    if (!mandatoryLabels[p]) continue;
    const row = document.createElement("div");
    row.className = "perm-row";
    const name = document.createElement("span");
    name.className = "perm-name";
    name.textContent = mandatoryLabels[p];
    const state = document.createElement("span");
    state.className = "perm-state granted";
    state.textContent = "Granted at install (required)";
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = "Core runtime permission — the hub cannot boot without it.";
    row.append(name, state, hint);
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
    // ever using the hook (fail-closed). Un-denying restores it (the install grant is still verified at use).
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
async function renderUsage(range = currentUsageRange) {
  currentUsageRange = USAGE_RANGES[range] ? range : "7d";
  // Usage is shared state — read it through the SW (single authority), not the
  // page-local usage.js kv* (the round-16 split-authority finding).
  // BOUNDED read — a killed worker must not leave the Usage section blank.
  let u;
  try {
    u = await boundedSend("usage.get");
  } catch (e) {
    const cards = $("#usage-cards");
    if (cards) cards.innerHTML = `<div class="muted">Couldn't load usage — the agent worker didn't answer (${escapeHtml(String(e?.message ?? e))}).</div><button class="btn small" type="button" id="retry-usage">Retry</button>`;
    cards?.querySelector("#retry-usage")?.addEventListener("click", () => renderUsage());
    return;
  }
  // Defensive: usage.get may return an error envelope or a shape missing
  // totals (e.g. storage permission not yet granted, SW cold-start race) —
  // render the empty state instead of crashing the Settings page.
  const totals = u?.ok === false || !u?.totals ? null : u.totals;
  const safe = {
    calls: Number(totals?.calls ?? 0),
    inputTokens: Number(totals?.inputTokens ?? 0),
    outputTokens: Number(totals?.outputTokens ?? 0),
    estimatedCost: Number(totals?.estimatedCost ?? 0),
  };
  const tok = safe.inputTokens + safe.outputTokens;
  const cards = $("#usage-cards");
  if (cards) {
    cards.replaceChildren();
    for (const [n, l] of [
      [formatTokens(tok), "total tokens"],
      [formatTokens(safe.inputTokens), "input"],
      [formatTokens(safe.outputTokens), "output"],
      [formatCost(safe.estimatedCost), "est. cost"],
      [String(safe.calls), "calls"],
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
      cards.appendChild(s);
    }
  }

  // ── Charts (FolioLM-style, SVG, aggregated at read time) ──
  // The ledger aggregates arrive pre-aggregated from the SW; the range filter
  // slices byDay entries + raw rows without re-scanning anything unbounded.
  const byDay = Array.isArray(u?.byDay) ? u.byDay : [];
  const byModel = Array.isArray(u?.byModel) ? u.byModel : [];
  const byAgent = Array.isArray(u?.byAgent) ? u.byAgent : [];
  const rows = Array.isArray(u?.rows) ? u.rows : [];
  const tools = Array.isArray(u?.tools) ? u.tools : [];
  // byDay entries carry `day`; for the 24h view the day buckets would collapse
  // to one bar, so slice the RAW rows for the daily chart when range is 24h.
  const dailySource = currentUsageRange === "24h"
    ? filterRowsByRange(rows, "24h")
    : byDay;
  const dayMount = $("#usage-chart-days");
  if (dayMount) dayMount.innerHTML = svgDailyBars(dayBuckets(dailySource, currentUsageRange));
  const modelMount = $("#usage-chart-models");
  if (modelMount) modelMount.innerHTML = svgShareBars(shareBars(byModel, "totalTokens", 6), { kind: "models", valueLabel: "tokens by model" });
  const agentMount = $("#usage-chart-agents");
  if (agentMount) agentMount.innerHTML = svgShareBars(shareBars(byAgent, "estimatedCost", 6), { kind: "agents", valueLabel: "estimated cost by agent" });
  const toolMount = $("#usage-chart-tools");
  if (toolMount) toolMount.innerHTML = svgShareBars(topTools(tools, 6), { kind: "tools", valueLabel: "tool calls" });
  // Range tabs reflect the active range.
  document.querySelectorAll(".usage-range").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.range === currentUsageRange));
  });

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

  const fmtTok = (m) => String((m.inputTokens ?? 0) + (m.outputTokens ?? 0));
  const fmtCost = (m) => "$" + Number(m.estimatedCost ?? 0).toFixed(4);
  const sortCost = (a, b) => (b.estimatedCost ?? 0) - (a.estimatedCost ?? 0);

  const detailByProvider = Array.isArray(u?.byProvider) ? u.byProvider : [];
  const detailByModel = Array.isArray(u?.byModel) ? u.byModel : [];
  const detailByAgent = Array.isArray(u?.byAgent) ? u.byAgent : [];
  const detailByDay = Array.isArray(u?.byDay) ? u.byDay : [];

  mk("By provider", ["Provider", "Calls", "Tokens", "Cost"],
    detailByProvider.slice().sort(sortCost).map((p) => [p.provider, String(p.calls), fmtTok(p), fmtCost(p)]));
  mk("By model", ["Provider", "Model", "Calls", "Tokens", "Cost"],
    detailByModel.slice().sort(sortCost).map((m) => [m.provider, m.model, String(m.calls), fmtTok(m), fmtCost(m)]));
  mk("By agent", ["Agent", "Model", "Calls", "Tokens", "Cost"],
    detailByAgent.slice().sort(sortCost).map((a) => [a.agentId, `${a.provider}/${a.model}`, String(a.calls), fmtTok(a), fmtCost(a)]));
  mk("By day", ["Day", "Calls", "Tokens", "Cost"],
    detailByDay.slice().sort((a, b) => String(a.day).localeCompare(String(b.day))).map((d) => [d.day, String(d.calls), fmtTok(d), fmtCost(d)]));

  // Provider server tools (Gemini google_search, Anthropic web_search): per-run executed-query
  // counts + the ESTIMATED spend (the provider's free-tier meter is invisible
  // to CAP — every figure here is labelled an estimate).
  const serverToolDays = Array.isArray(u?.serverTools) ? u.serverTools : [];
  const serverToolRows = serverToolDays.flatMap(({ day, rows }) =>
    (Array.isArray(rows) ? rows : []).map((r) => [
      day,
      `${String(r.provider ?? "")}/${String(r.tool ?? "")}`,
      String(r.queries ?? 0),
      `est. $${(Number(r.estimatedUsd) || 0).toFixed(4)}`,
    ]));
  mk("Provider server tools (estimates)", ["Day", "Tool", "Queries", "Est. cost"], serverToolRows);
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
  // The tree is rebuilt from scratch on every render, so anything the owner had
  // expanded snapped shut — including on the refresh that follows Clear, which
  // is exactly when they are looking at that store. Remember what was open and
  // restore it, keyed by a stable id rather than DOM position.
  const wasExpanded = new Set(
    [...el.querySelectorAll('[data-mem-id][aria-expanded="true"]')]
      .map((n) => n.getAttribute("data-mem-id")),
  );
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
    const memId = `dir:${kind}:${label}`;
    head.setAttribute("data-mem-id", memId);
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
    if (wasExpanded.has(memId)) {
      head.setAttribute("aria-expanded", "true");
      caret.textContent = "▾";
      body.classList.remove("hidden");
    }
    return wrap;
  }

  // ── helper: a store node (an agent's directory of keys/files) ──────────
  function storeNode(store) {
    const wrap = document.createElement("div");
    wrap.className = "mem-dir mem-store";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mem-dir-head";
    const memId = `store:${store.key}`;
    head.setAttribute("data-mem-id", memId);
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
    // Restore an expansion the owner had before this rebuild. Keys are lazy, so
    // re-fetch them here — that is also what makes a cleared store show its new
    // (empty) contents instead of the list it had a moment ago.
    if (wasExpanded.has(memId)) {
      head.setAttribute("aria-expanded", "true");
      caret.textContent = "▾";
      body.classList.remove("hidden");
      loaded = true;
      fillKeys(store, body).catch(() => { loaded = false; });
    }
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
    const clearBtn = !store.readOnly
      ? document.createElement("button")
      : null;
    if (clearBtn) {
    clearBtn.type = "button";
    clearBtn.className = "btn small ghost mem-clear";
    clearBtn.textContent = `Clear ${store.label}'s memory`;
    clearBtn.addEventListener("click", async () => {
      const res = await chrome.runtime
        .sendMessage({ type: "memory.clear", origin: store.key })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok === false) {
        saveFlash(res.error || `Couldn't clear ${store.label}'s memory.`);
        return;
      }
      saveFlash(`Cleared ${store.label}'s memory.`);
      renderMemoryExplorer();
      renderData();
    });
    body.append(clearBtn);
    }
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
  // BOUNDED read — a killed worker must not leave the Agents list blank.
  let origins;
  try {
    origins = await boundedSend("agent.list");
  } catch {
    origins = [];
  }
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
      const res = await chrome.runtime
        .sendMessage({ type: "memory.clear", origin })
        .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (res?.ok === false) {
        saveFlash(res.error || `Couldn't clear memory for ${origin}.`);
        return;
      }
      saveFlash(`Cleared memory for ${origin}.`);
      // The memory explorer is where the keys and counts are actually shown.
      // Refreshing only the origin list left it displaying the cleared store's
      // old key count, so the button looked like it had done nothing.
      renderData();
      renderMemoryExplorer();
    });
    row.appendChild(clear);

    list.appendChild(row);
  }

  // Pending-cleanup origins: a delete that failed partway (e.g. a script or host
  // permission removal that could not be CONFIRMED) records a retryable cleanup
  // obligation independent of enrollment, so it is surfaced here with a Retry
  // control rather than silently dropped when the tombstone hides the origin
  // (the round-17 non-retryable finding).
  // BOUNDED read — a killed worker must not leave the pending-cleanup list blank.
  let pending;
  try {
    pending = await boundedSend("agent.pending-cleanup");
  } catch {
    pending = {};
  }
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

// ── Factory reset / Delete all data (CAP-FB-20260823-FACTORY-RESET-01) ──
const factoryResetBtn = $("#factory-reset-btn");
const factoryResetStatus = $("#factory-reset-status");

// ── Agent data maintenance (owner-reported leftover fix: agents deleted before
// teardown existed left OPFS dirs + journals behind; journals needed a purge
// affordance that keeps memory + artifacts). ──
const purgeJournalsBtn = $("#purge-journals-btn");
const sweepOrphansBtn = $("#sweep-orphans-btn");
const purgeJournalAgent = $("#purge-journal-agent");
const maintenanceStatus = $("#maintenance-status");

async function refreshMaintenanceAgentOptions() {
  if (!purgeJournalAgent) return;
  try {
    const res = await boundedSend("named-agent.list");
    const agents = Array.isArray(res?.agents) ? res.agents : [];
    const selected = purgeJournalAgent.value;
    while (purgeJournalAgent.options.length > 1) purgeJournalAgent.remove(1);
    for (const a of agents) {
      const opt = document.createElement("option");
      opt.value = String(a.id ?? a.slug ?? "");
      opt.textContent = String(a.name ?? a.id ?? "agent");
      purgeJournalAgent.append(opt);
    }
    if (selected) purgeJournalAgent.value = selected;
  } catch { /* the select stays "All agents" — the global purge still works */ }
}

refreshMaintenanceAgentOptions();

purgeJournalsBtn?.addEventListener("click", async () => {
  const slug = purgeJournalAgent?.value || "";
  const scopeText = slug
    ? `the journal of agent "${slug}"`
    : "ALL agent journals (named + background + Site Agents)";
  const confirmed = await confirmActionDialog({
    title: "Purge journals?",
    body: `This permanently deletes ${scopeText}. Memory content, run history, skills, and artifacts are NOT touched.\n\nContinue?`,
    confirmLabel: "Purge journals",
    destructive: true,
  });
  if (!confirmed) return;
  if (maintenanceStatus) maintenanceStatus.textContent = "Purging journals…";
  purgeJournalsBtn.disabled = true;
  try {
    const res = await boundedSend("memory.purgeJournals", { target: slug ? { agent: slug } : null });
    if (res?.ok) {
      const n = Array.isArray(res.removed) ? res.removed.length : 0;
      if (maintenanceStatus) maintenanceStatus.textContent = n > 0 ? `Purged ${n} journal${n === 1 ? "" : "s"}.` : "No journals found to purge.";
    } else if (maintenanceStatus) {
      maintenanceStatus.textContent = `Purge failed: ${res?.error ?? "unknown error"}`;
    }
  } catch (e) {
    if (maintenanceStatus) maintenanceStatus.textContent = `Purge failed: ${e?.message ?? e}`;
  } finally {
    purgeJournalsBtn.disabled = false;
  }
});

sweepOrphansBtn?.addEventListener("click", async () => {
  const confirmed = await confirmActionDialog({
    title: "Clean up leftover agent files?",
    body: "This removes stored data (memory folders, journals, run history) belonging to agents that no longer exist. Live agents and artifacts are never touched.\n\nContinue?",
    confirmLabel: "Clean up",
    destructive: true,
  });
  if (!confirmed) return;
  if (maintenanceStatus) maintenanceStatus.textContent = "Sweeping leftover files…";
  sweepOrphansBtn.disabled = true;
  try {
    const res = await boundedSend("memory.sweepOrphans", {}, 30000);
    if (res?.ok) {
      const s = res.swept ?? {};
      const total = (s.agentDirs ?? 0) + (s.backgroundDirs ?? 0) + (s.executionDirs ?? 0) + (s.threadDirs ?? 0);
      if (maintenanceStatus) {
        maintenanceStatus.textContent = total > 0
          ? `Cleaned up ${total} leftover item${total === 1 ? "" : "s"} (${s.agentDirs ?? 0} agent folders, ${s.backgroundDirs ?? 0} background folders, ${s.executionDirs ?? 0} run histories, ${s.threadDirs ?? 0} thread indexes).`
          : "No leftover files found — everything is already clean.";
      }
    } else if (maintenanceStatus) {
      maintenanceStatus.textContent = `Sweep failed: ${res?.error ?? "unknown error"}`;
    }
  } catch (e) {
    if (maintenanceStatus) maintenanceStatus.textContent = `Sweep failed: ${e?.message ?? e}`;
  } finally {
    sweepOrphansBtn.disabled = false;
  }
});

factoryResetBtn?.addEventListener("click", async () => {
  const confirmed = await confirmActionDialog({
    title: "Reset all extension data?",
    body:
      "This is a permanent, destructive action. All tasks, agents, memory, artifacts, downloaded local models, and settings will be completely deleted and the first-run onboarding will be restored.\n\nAre you sure you want to delete everything?",
    confirmLabel: "Delete everything",
    destructive: true,
  });
  if (!confirmed) return;

  if (factoryResetStatus) {
    factoryResetStatus.hidden = false;
    factoryResetStatus.textContent = "Wiping all data and restoring first-run state…";
  }
  factoryResetBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({ type: "system.factoryReset" });
    if (res?.ok) {
      if (factoryResetStatus) {
        factoryResetStatus.textContent = "All data wiped successfully. Reloading…";
      }
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {}
      setTimeout(() => {
        if (typeof window !== "undefined") {
          window.location.href = chrome.runtime.getURL("ntp/ntp.html#factory-reset");
        }
      }, 500);
    } else {
      throw new Error(res?.error || "Factory reset failed");
    }
  } catch (err) {
    if (factoryResetStatus) {
      factoryResetStatus.hidden = false;
      factoryResetStatus.textContent = `Reset failed: ${err?.message || err}`;
    }
    factoryResetBtn.disabled = false;
  }
});

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
    const r = await boundedSend("named-agent.list");
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
    // On the owner's SAVE gesture, verify the install-granted `storage` permission
    // so the customization is DURABLE (never silently session-only — the
    // review's persistence blocker). Denied → still save, but the UI says
    // "session-only" (the describe payload's durable flag drives the badge).
    if (type === "prompt.set") {
      try {
        // storage is granted at install — VERIFY (fail closed), never request.
        const has = (await chrome.permissions.contains({ permissions: ["storage"] })) === true;
        if (!has) {
          saveFlash("Storage not granted — this customization is session-only. Storage is a core permission; reinstall the extension and try again.");
        }
      } catch { /* an unverifiable grant falls through to the save */ }
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
      // Never claim "saved" when the backend is session-only (the required
      // install grant is still absent after verification).
      const durableNow = await chrome.permissions
        .contains({ permissions: ["storage"] })
        .catch(() => true);
      saveFlash(durableNow
        ? "System prompt customization saved."
        : "Saved for THIS SESSION only — storage is a core permission; reinstall the extension to persist it.");
    } else {
      saveFlash(
        type === "prompt.keep" ? "Customization kept — now based on the latest built-in prompt."
        : "Reset to the built-in default.",
      );
    }
    await load();
  }

  scopeSelect.addEventListener("change", async () => {
    // Switching scopes reloads the editor (re-seeding the draft) — confirm
    // before discarding unsaved edits (the review's dirty-switch finding).
    // Native-modal confirm; cancel/Escape/backdrop resolve false and mutate nothing.
    if (editor.dirty && !await confirmActionDialog({
      title: "Discard unsaved edits?",
      body: "Discard the unsaved prompt edits and switch scope?",
      confirmLabel: "Discard",
      destructive: true,
    })) {
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

// ── MCP servers (CAP-FB-20260831-MCP-GLOBAL-UI-01) ───────────────────────────
// The GLOBAL remote-MCP server list: add/edit/enable/remove a Streamable-HTTP or
// SSE server, and Test connection (connects in the SW via mcp-client and lists
// the server's tools). The auth token is handled EXACTLY like the provider key:
// it is written through mcp.servers.set, the read (mcp.servers.get) is REDACTED
// (a hasToken bit, never the token), and a blank token on save/test reuses the
// stored one. Every remote-supplied string (a tool name from Test connection) is
// rendered with textContent — never innerHTML.
let mcpServers = []; // the REDACTED list (no tokens) mirrored from the SW

async function mcpPersist(payload) {
  const res = await boundedSend("mcp.servers.set", { servers: payload }).catch((e) => ({ error: String(e?.message ?? e) }));
  if (res?.error) {
    saveFlash(`Couldn't save MCP servers — ${res.error}`);
    return false;
  }
  mcpServers = Array.isArray(res?.servers) ? res.servers : [];
  mcpRenderList();
  return true;
}

async function renderMcpServers() {
  const list = document.getElementById("mcp-server-list");
  if (!list) return;
  try {
    const res = await boundedSend("mcp.servers.get");
    mcpServers = Array.isArray(res?.servers) ? res.servers : [];
  } catch (e) {
    list.textContent = "";
    const err = document.createElement("p");
    err.className = "muted";
    err.textContent = `Couldn't load MCP servers — the service worker didn't answer (${String(e?.message ?? e)}).`;
    list.append(err);
    return;
  }
  mcpRenderList();
}

function mcpRenderList() {
  const list = document.getElementById("mcp-server-list");
  if (!list) return;
  list.textContent = "";
  if (mcpServers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted mcp-empty";
    empty.textContent = "No MCP servers yet. Add a remote server to give your agents its tools.";
    list.append(empty);
    return;
  }
  for (const s of mcpServers) {
    list.append(buildMcpServerRow(s, {
      onToggle: async (on) => {
        await mcpPersist(mcpToSavePayload(mcpServers, { [s.id]: { enabled: on } }));
        saveFlash(on ? `Enabled ${s.name || s.id}.` : `Disabled ${s.name || s.id}.`);
      },
      onEdit: () => mcpOpenEditor(s),
      onRemove: async () => {
        const rest = mcpServers.filter((x) => x.id !== s.id);
        if (await mcpPersist(mcpToSavePayload(rest))) saveFlash(`Removed ${s.name || s.id}.`);
      },
    }));
  }
}

// The add/edit form. One reused editor panel above the list — no modal (the task
// needs neither interruption nor protected focus). The editor itself is the
// SHARED mcp-server-editor, so Settings and the per-agent agent dialog match.
function mcpOpenEditor(existing) {
  const editor = document.getElementById("mcp-editor");
  if (!editor) return;
  const isEdit = Boolean(existing);
  const close = () => { editor.hidden = true; editor.textContent = ""; };
  editor.textContent = "";
  editor.hidden = false;
  editor.append(buildMcpServerEditor({
    existing,
    showTest: true,
    onTest: (server) => boundedSend("mcp.servers.test", { server }, 20000),
    onSave: async (server) => {
      // Replace by id when editing, else append; the SW normalizes + dedups.
      const others = mcpServers.filter((x) => x.id !== (existing?.id ?? " "));
      const payload = [...mcpToSavePayload(others), server];
      if (await mcpPersist(payload)) {
        close();
        saveFlash(isEdit ? `Saved ${server.name}.` : `Added ${server.name}.`);
      }
    },
    onCancel: close,
  }));
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

// A deep link to a developer section while the flag is OFF must not be a dead
// link (the panel is hidden, so scrolling to it shows nothing). Instead, a
// one-line notice at the top of the content column points to the About toggle.
function ensureDeveloperLockedNotice() {
  let el = document.getElementById("developer-locked-notice");
  if (el) return el;
  const main = document.querySelector("main.content") || document.body;
  el = document.createElement("div");
  el.id = "developer-locked-notice";
  el.className = "panel developer-locked-notice";
  el.setAttribute("role", "status");
  el.hidden = true;
  el.tabIndex = -1;
  const h = document.createElement("h2");
  h.textContent = "Developer feature";
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = "This section is part of the developer features. Turn on “Show developer features” in About to see it.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn small";
  btn.textContent = "Go to About";
  btn.addEventListener("click", () => navigationController.navigate("#about", { replace: true }));
  el.append(h, p, btn);
  const header = main.querySelector(".head");
  if (header && header.nextSibling) main.insertBefore(el, header.nextSibling);
  else main.appendChild(el);
  return el;
}
function showDeveloperLockedNotice() {
  const el = ensureDeveloperLockedNotice();
  el.hidden = false;
  document.querySelectorAll(".nav-item").forEach((x) => x.removeAttribute("aria-current"));
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.focus({ preventScroll: true });
}
function hideDeveloperLockedNotice() {
  const el = document.getElementById("developer-locked-notice");
  if (el) el.hidden = true;
}

// nav active state
export function handleSettingsHashNavigation(hash, isTraverse = false) {
  const sectionId = normalizeSettingsSectionId(hash);
  if (!sectionId) return false;

  const section = document.getElementById(sectionId);
  if (!section) return false;

  // Developer section requested while the flag is off — show the notice, never
  // a silent scroll to a hidden panel.
  if (!developerFeaturesEnabled && DEVELOPER_SECTIONS_SET.has(sectionId)) {
    showDeveloperLockedNotice();
    return true;
  }
  hideDeveloperLockedNotice();

  document.querySelectorAll(".nav-item").forEach((x) => {
    const match = x.dataset.section === sectionId ||
      x.getAttribute("href") === `#${sectionId}`;
    if (match) {
      x.setAttribute("aria-current", "true");
    } else {
      x.removeAttribute("aria-current");
    }
  });

  if (sectionId === "local-folders") renderLocalFolders();
  if (sectionId === "mcp-servers") renderMcpServers();
  if (sectionId === "usage") renderUsage();
  if (sectionId === "skills") mountSkillsSection(document.getElementById("skills"));
  if (sectionId === "about") renderAbout(); // lazy: fetched + rendered on first open (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01)

  section.scrollIntoView({
    behavior: isTraverse ? "auto" : "smooth",
    block: "start",
  });

  const heading = section.querySelector("h2, h3");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }

  return true;
}

// Navigation controller: adopts modern window.navigation API with popstate/hashchange fallback
// for Settings sections and deep links (CAP-FB-20260823-NAVIGATION-BACK-01).
export const navigationController = createNavigationController({
  win: window,
  normalizeHash: normalizeSettingsSectionId,
  isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
  onNavigate: async ({ hash, sectionId, isTraverse }) => {
    return handleSettingsHashNavigation(hash || `#${sectionId}`, isTraverse);
  },
});

// ── Section anchor links (CAP-FB-20260823-SECTION-ANCHOR-LINKS-01) ─────────
// Every panel h2 gets a hover-revealed anchor; clicking the anchor or the
// heading copies the deep link (#section) to the clipboard with a visible
// confirmation. The link itself navigates + scrolls via handleSettingsHashNavigation.
function sectionLinkUrl(sectionId) {
  return `${location.origin}${location.pathname}#${sectionId}`;
}

function flashCopied(anchorEl, url) {
  const original = anchorEl.getAttribute("aria-label") ?? "Copy section link";
  anchorEl.classList.add("copied");
  anchorEl.textContent = "✓";
  anchorEl.setAttribute("aria-label", `Copied ${url}`);
  clearTimeout(anchorEl._copyTimer);
  anchorEl._copyTimer = setTimeout(() => {
    anchorEl.classList.remove("copied");
    anchorEl.textContent = "#";
    anchorEl.setAttribute("aria-label", original);
  }, 1500);
}

async function copySectionLink(sectionId, anchorEl) {
  const url = sectionLinkUrl(sectionId);
  try {
    await navigator.clipboard.writeText(url);
    flashCopied(anchorEl, url);
  } catch {
    // Clipboard unavailable (non-secure context / denied) — reveal the link so
    // the owner can copy manually (never a silent no-op).
    anchorEl.classList.add("copied");
    anchorEl.textContent = url;
    anchorEl.setAttribute("aria-label", `Section link: ${url}`);
  }
}

function wireSectionAnchors() {
  for (const section of document.querySelectorAll("section.panel[id]")) {
    const h2 = section.querySelector(":scope > h2");
    if (!h2) continue;
    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.className = "section-anchor";
    anchor.textContent = "#";
    anchor.setAttribute("aria-label", `Copy link to ${h2.textContent.trim()}`);
    anchor.title = "Copy section link";
    anchor.addEventListener("click", () => copySectionLink(section.id, anchor));
    h2.append(anchor);
    // The heading click also copies (the anchor has its own handler; skip it to
    // avoid a double copy).
    h2.addEventListener("click", (e) => {
      if (e.target === anchor) return;
      copySectionLink(section.id, anchor);
    });
  }
}
wireSectionAnchors();

// CAP-FB-20260826-HEADER-HOME-01: the "Chrome Agent Platform" brand in the
// settings panel acts as a Home link — clicking it asks the parent NTP (the
// overlay host) to close the settings view and return to the hub.
{
  const brand = document.getElementById("about-brand-home");
  const goHome = () => {
    try { window.parent?.postMessage({ type: "cap:go-home" }, "*"); } catch {}
  };
  brand?.addEventListener("click", goHome);
  brand?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); }
  });
}

document.querySelectorAll(".nav-item").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const targetHash = a.getAttribute("href") || `#${a.dataset.section}`;
    // CAP-FB-20260826-BACK-STACK-01: settings sub-navigation REPLACES history
    // (never pushes) so the WHOLE settings surface is ONE entry in the joint
    // session history. Without this, every section click stacked an iframe
    // hash entry, and the NTP Back button traversed those dead intermediate
    // states — the "blank screen, press back twice" bug. Each section stays
    // linkable: the hash still updates to #section via replaceState.
    navigationController.navigate(targetHash, { replace: true });
  });
});

// (The legacy "Custom…" reveal wiring for the old select-based model field is
// gone — the shared <model-picker> makes custom ids a first-class typed path.)

// Permission-settle consumer (the acceptance review): Settings coordinates provider access via requestProviderHostAccess (whose waiter is
// exact pattern+generation); no passive listener here. The status chip
// re-reads from the SW on focus so a grant landed anywhere is reflected.
window.addEventListener("focus", () => { providerStatusChanged(); }, { once: true });
await refreshStoragePermission();
// Read the developer-features flag BEFORE the section renderers run, then hide
// the developer nav items + panels and the server-tools card. The renderers for
// the hidden sections are SKIPPED (the panel is not shown; no need to build it),
// but the DOM stays intact so a deep link still resolves and the toggle can
// reveal them without a reload.
await readDeveloperFeaturesFlag();
applyDeveloperVisibility(developerFeaturesEnabled);
await renderProviders();
await renderMcpServers();
await renderLocalFolders();
if (developerFeaturesEnabled) await renderToolLibrary();
await renderAgents();
await renderEnroll();
await renderBrowser();
await renderActionPolicy();
await renderPermissions();
if (developerFeaturesEnabled) await renderHooks();
if (developerFeaturesEnabled) await renderPrompts();
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
// Usage range tabs (24h / 7d) — re-render the panel on switch.
document.querySelectorAll(".usage-range").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.range && b.dataset.range !== currentUsageRange) renderUsage(b.dataset.range);
  });
});
// Add-server button (MCP servers section) — a STATIC control wired exactly once.
document.getElementById("mcp-add-btn")?.addEventListener("click", () => mcpOpenEditor(null));
await renderData();
await renderMemoryExplorer();
await renderEnrolledSites();
await renderWebmcpStatus();

// ── Developer-features toggle (About) ───────────────────────────────────────
// The switch reflects the stored flag and, on change, persists it, re-applies
// the nav/section visibility, and renders any section that just became visible
// (the initial load skipped its renderer). Turning it OFF hides the lanes
// without tearing down the DOM — a later turn-on reveals them immediately. The
// service worker re-reads the flag per run, so the demo model + developer-only
// tools follow on the next task without a reload.
{
  const devToggle = document.getElementById("developer-features");
  if (devToggle) {
    // Render each developer section AT MOST ONCE per page load — the moment it
    // first becomes visible. Some renderers (renderPrompts) wire listeners on
    // every call, so a second render would stack them; the panels are hidden,
    // not torn down, so one render is enough for the life of the page.
    const devRendered = new Set(developerFeaturesEnabled ? ["tool-library", "hooks", "prompts", "board-permissions"] : []);
    devToggle.checked = developerFeaturesEnabled;
    devToggle.addEventListener("toggle", async (e) => {
      const on = e.detail.checked === true;
      developerFeaturesEnabled = on;
      await storage.set({ [DEVELOPER_FEATURES_KEY]: on });
      applyDeveloperVisibility(on);
      if (on) {
        // Build the sections that were skipped while the flag was off — once.
        if (!devRendered.has("tool-library")) { devRendered.add("tool-library"); try { await renderToolLibrary(); } catch { /* section visible; empty */ } }
        if (!devRendered.has("hooks")) { devRendered.add("hooks"); try { await renderHooks(); } catch { /* idem */ } }
        if (!devRendered.has("prompts")) { devRendered.add("prompts"); try { await renderPrompts(); } catch { /* idem */ } }
        if (!devRendered.has("board-permissions")) { devRendered.add("board-permissions"); try { populateBoardDenyAgents(); } catch { /* idem */ } }
      }
      // The SW resolves the model + toolset per run from the same kv key; nudge
      // any running orchestrator so the demo model / developer tools switch
      // takes effect on the next task without a reload.
      try { await chrome.runtime.sendMessage({ type: "invalidate-agent" }); } catch { /* worker idle — the setting still persists */ }
      saveFlash(on ? "Developer features on." : "Developer features off.");
    });
  }
}

// The version in the footer (chaos-style semantic versioning — read from the
// manifest so it always matches the installed build).
try {
  const v = chrome.runtime.getManifest().version;
  const el = $("#app-version");
  if (el && v) el.textContent = "v" + v;
  const av = $("#about-version");
  if (av && v) av.textContent = "v" + v;
} catch { /* non-extension (browser test) — leave the placeholder */ }

// ── About / keyboard shortcuts ───────────────────────────────────────────────
// The bindings are Chrome's, not ours: chrome.commands.getAll() reports what is
// ACTUALLY bound right now, including a binding the owner cleared or remapped.
// Rendering our manifest's suggested keys instead would lie whenever they had
// changed one. Built as DOM nodes, never innerHTML.
async function renderShortcuts() {
  const host = $("#shortcut-list");
  if (!host) return;
  let commands = [];
  try {
    commands = (await chrome.commands?.getAll?.()) ?? [];
  } catch { /* non-extension context (the gallery/browser test) */ }
  host.replaceChildren();
  if (!commands.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Keyboard shortcuts are unavailable in this context.";
    host.append(p);
    return;
  }
  for (const cmd of commands) {
    // `_execute_action` and friends have no description; skip anything unnamed.
    if (!cmd?.description) continue;
    const dt = document.createElement("dt");
    if (cmd.shortcut) {
      const kbd = document.createElement("kbd");
      kbd.textContent = cmd.shortcut;
      dt.append(kbd);
    } else {
      const span = document.createElement("span");
      span.className = "muted unbound";
      span.textContent = "Not set";
      dt.append(span);
    }
    const dd = document.createElement("dd");
    dd.textContent = cmd.description;
    host.append(dt, dd);
  }
}

$("#open-shortcut-settings")?.addEventListener("click", () => {
  // Chrome's own page is the only place a binding can be changed; an extension
  // cannot set one. Opening it is a plain navigation, not a permission request.
  chrome.tabs?.create?.({ url: "chrome://extensions/shortcuts" });
});

renderShortcuts();

// ── About / changelog ────────────────────────────────────────────────────────
// Render the bundled CHANGELOG.md into the About section. Each `## [version]`
// becomes a version card with its bullet list (built as DOM nodes, never
// innerHTML, so the markdown stays inert).
//
// CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01: only the most recent five
// versions whose bullets a non-engineer can read are shown up front; every
// older or internal entry is behind a "Show all" disclosure so the About page
// stays small and the copy stays human. Rendered lazily on first open.
// The rules live in changelog-filter.js (shared with the test and the release
// gate) so the renderer, the unit tests and `check-changelog` cannot drift.
import { isUserFacingEntry, partitionChangelog } from "./changelog-filter.js";

function renderChangelog(md) {
  const host = $("#changelog");
  if (!host) return;
  host.replaceChildren();
  const { recent, rest } = partitionChangelog(md);
  const buildCard = (v, bullets) => {
    const card = document.createElement("div");
    card.className = "changelog-entry";
    const head = document.createElement("div");
    head.className = "changelog-head";
    const vEl = document.createElement("strong");
    vEl.textContent = "v" + v.version;
    const date = document.createElement("span");
    date.className = "muted";
    date.textContent = v.date;
    head.append(vEl, date);
    card.append(head);
    const list = document.createElement("ul");
    list.className = "changelog-items";
    for (const b of bullets) {
      const li = document.createElement("li");
      li.textContent = b;
      list.append(li);
    }
    card.append(list);
    return card;
  };
  for (const r of recent) {
    host.append(buildCard(r, r.bullets));
  }
  if (!recent.length) {
    host.innerHTML = `<p class="muted">No changelog yet.</p>`;
    return;
  }
  // The disclosure renders ONLY the complement of the visible five — every
  // version NOT shown up front, in full. A version that made the visible five
  // never appears here (visible ∩ show-all = ∅). Built LAZILY on first open
  // so the About page stays bounded at load.
  const details = document.createElement("details");
  details.className = "changelog-all";
  const summary = document.createElement("summary");
  summary.textContent = "Show all release notes";
  details.append(summary);
  details.addEventListener("toggle", () => {
    if (!details.open || details.querySelector(".changelog-all-body")) return;
    const all = document.createElement("div");
    all.className = "changelog-all-body";
    for (const c of rest) all.append(buildCard(c, c.bullets));
    details.append(all);
  });
  host.append(details);
}

let aboutRendered = false;
async function renderAbout() {
  if (aboutRendered) return;
  aboutRendered = true;
  // The full release notes link targets the bundled changelog (also reachable
  // as a packaged file) so it works offline and with no network dependency.
  try {
    const full = document.getElementById("full-release-notes");
    if (full) full.setAttribute("href", chrome.runtime.getURL("CHANGELOG.md"));
  } catch { /* non-extension context */ }
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
await wireObservabilitySettings();
await wireRunRetentionSettings();
await navigationController.syncCurrent();


// ── Board deny rules (the owner controls which edges are blocked) ──────────
// CAP-FB-20260830-AGENT-BOARD-WORKING-01 step 9: the selects are the shared
// <provider-select> primitive (no hand-rolled native selects), they re-populate
// on agent-registry-changed / named-agent-changed (no reload), rule rows print
// agent NAMES, and the copy reads as one sentence.
let boardAgents = [];
const boardAgentName = (id) => (id === "hub" ? "Hub" : (boardAgents.find((a) => a?.id === id)?.name ?? id));
function boardRuleSentence(rule) {
  const verb = rule.action === "claim" ? "claim jobs from" : "post jobs targeting";
  return `${boardAgentName(rule.agentId)} cannot ${verb} ${boardAgentName(rule.peerId)}`;
}
async function renderBoardDenyRules() {
  const list = document.getElementById("board-deny-list");
  if (!list) return;
  const res = await chrome.runtime.sendMessage({ type: "board.deny.list" }).catch(() => null);
  list.replaceChildren();
  if (!res?.ok || !Array.isArray(res.rules)) {
    if (res?.error) {
      const err = document.createElement("p");
      err.className = "muted";
      err.textContent = `Rules unavailable: ${res.error}`;
      list.append(err);
    }
    return;
  }
  if (!res.rules.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.id = "board-deny-empty";
    empty.textContent = "No rules — every named agent and the hub can post and claim.";
    list.append(empty);
    return;
  }
  for (const rule of res.rules) {
    const row = document.createElement("div");
    row.className = "perm-row";
    row.setAttribute("role", "listitem");
    const name = document.createElement("span");
    name.className = "perm-name";
    name.textContent = boardRuleSentence(rule);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small ghost";
    btn.textContent = "Remove";
    btn.setAttribute("aria-label", `Remove rule: ${name.textContent}`);
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "board.deny.remove", ruleId: rule.id }).catch(() => {});
      renderBoardDenyRules();
    });
    row.append(name, btn);
    list.appendChild(row);
  }
}
async function populateBoardDenyAgents() {
  const agentSelect = document.getElementById("board-deny-agent");
  const peerSelect = document.getElementById("board-deny-peer");
  if (!agentSelect || !peerSelect) return;
  const namedAgentRes = await chrome.runtime.sendMessage({ type: "named-agent.list" }).catch(() => null);
  boardAgents = Array.isArray(namedAgentRes?.agents) ? namedAgentRes.agents.filter((a) => a && typeof a.id === "string") : [];
  const options = boardAgents.map((a) => ({ id: a.id, name: a.name ?? a.id, icon: "user" }));
  const keepAgent = agentSelect.value;
  const keepPeer = peerSelect.value;
  agentSelect.providers = [...options, { id: "hub", name: "Hub", icon: "terminal" }];
  peerSelect.providers = [...options, { id: "hub", name: "Hub", icon: "terminal" }];
  if (keepAgent) agentSelect.value = keepAgent;
  if (keepPeer) peerSelect.value = keepPeer;
  // Names in the rule rows come from the same registry — re-render them too.
  renderBoardDenyRules();
}
function initBoardDenyUI() {
  const form = document.getElementById("board-deny-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = document.getElementById("board-deny-action")?.value || "claim";
    const agentId = document.getElementById("board-deny-agent")?.value ?? "";
    const peerId = document.getElementById("board-deny-peer")?.value ?? "";
    if (!agentId || !peerId) return;
    const res = await chrome.runtime.sendMessage({ type: "board.deny.add", action, agentId, peerId }).catch(() => null);
    if (res?.ok) renderBoardDenyRules();
  });
  // Skip the initial render while the developer flag is off (the panel is
  // hidden); the About toggle renders it on demand when turned on. The form +
  // port listeners still wire so a turn-on needs no re-init.
  if (developerFeaturesEnabled) populateBoardDenyAgents();
  // Live registry updates: an agent created after this page loaded appears in
  // the selects without a reload (the SW broadcasts on the progress port).
  try {
    const port = chrome.runtime.connect({ name: "agent-progress" });
    port.onMessage.addListener((msg) => {
      const type = msg?.type === "progress" ? msg.event?.type : null;
      if (type === "agent-registry-changed" || type === "named-agent-changed") populateBoardDenyAgents();
    });
  } catch { /* no port — the page still populates once at load */ }
}
if (typeof document !== "undefined" && document.getElementById("board-deny-list")) {
  initBoardDenyUI();
}

// panels/providers.js — Model providers & provider-run server tools Settings panel module.

import { requestProviderHostAccess } from "../../lib/provider-gate.js";
import { bindProviderSetDefault } from "../../lib/provider-options-save.js";
import { defaultModelFor, fetchLiveModels, suggestedModelsFor } from "../../lib/model-catalog.js";
import {
  providerSelectionPresentation,
  renderInternalProviderStatus,
} from "../../lib/provider-visibility.js";
import {
  defaultFamilyId,
  familyTabSlug,
  keyPageFor,
  prefilledModelFor,
  providerFamilies,
  useEnabled,
} from "../../lib/providers-view.js";
import { credentialNeedsDurableStorage } from "../../lib/first-run-onboarding.js";
import { escapeHtml } from "../../shared/components-core.js";
import { createPanelContext, escapeAttr, bindPanelCtx } from "../panel-context.js";

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
    models: [],
  },
  {
    id: "lm-studio",
    name: "LM Studio (local)",
    hint: "A local LM Studio server.",
    baseURL: "http://localhost:1234/v1",
    needsKey: false,
    needsModel: true,
    onDevice: false,
    models: [],
  },
];

export { PROVIDERS };

const serverToolsToggleWired = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("providers");

export function blockSessionOnlyCredentialSave(input) {
  const panelCtx = ensureCtx(null, arguments[1]);
  const storageGranted = panelCtx.storageGranted();
  if (!credentialNeedsDurableStorage({ enteredKey: input?.value ?? "", storageGranted })) return false;
  saveFlash("Storage is missing from this installation. Reload the extension; if it is still missing, reinstall the extension before saving an API key.");
  return true;
}

async function providerStatusChanged(ctx) {
  try {
    const status = await boundedSend("provider.status").catch(() => null);
    const chip = $("#provider-status-chip, .provider-status");
    if (chip && status) chip.dataset.granted = String(Boolean(status.granted ?? status.ok ?? ""));
  } catch { /* status surface absent — nothing to reconcile */ }
}

export function providerCatalogue(p) {
  return Array.isArray(p.models) ? p.models : [];
}

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
    if (liveModelsInFlight.get(card) !== token) return;
    const suggested = providerCatalogue(p);
    const merged = [...suggested, ...live.filter((id) => !suggested.includes(id))];
    if (merged.length !== picker.models.length || merged.some((id, i) => picker.models[i] !== id)) {
      picker.models = merged;
    }
  } finally {
    if (liveModelsInFlight.get(card) === token) picker.removeAttribute("loading");
  }
}

function modelFieldHtml(p, cfg) {
  const current = prefilledModelFor(p, cfg);
  const models = providerCatalogue(p);
  const ph = models.length ? "Search or type a model id…" : (p.id === "ollama" ? "e.g. llama3.1" : "model id");
  return `<model-picker class="model" data-provider="${escapeAttr(p.id)}" placeholder="${escapeAttr(ph)}" models="${escapeAttr(JSON.stringify(models))}" recommended="${escapeAttr(JSON.stringify(models))}" value="${escapeAttr(current)}" label="Model"></model-picker>`;
}

function effectiveModel(card) {
  const picker = card.querySelector("model-picker");
  if (picker) {
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

function buildProviderCard(p, cfg, ctx) {
  const panelCtx = ensureCtx(null, ctx);
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
      <details class="provider-advanced"${!p.needsKey || !p.models?.length ? " open" : ""}>
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

  const advDetails = card.querySelector(".provider-advanced");
  if (advDetails && (!p.needsKey || !p.models?.length)) {
    advDetails.open = true;
  }

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
  credentialInput?.addEventListener("input", () => { card._testPassed = false; refreshUseState(); });
  credentialInput?.addEventListener("change", () => { refreshLiveModels(card, p); });
  card.querySelector("model-picker")?.addEventListener("change", () => { card._testPassed = false; refreshUseState(); });
  card.querySelector(".base-url")?.addEventListener("input", () => { card._testPassed = false; refreshUseState(); });

  bindProviderSetDefault({
    card,
    provider: p,
    currentConfig: cfg,
    shouldBlock: () => blockSessionOnlyCredentialSave(credentialInput),
    requestHostAccess: requestProviderHostAccess,
    sendMessage: (message) => send(message),
    onAccess(access, outcome) {
      if (outcome?.saved && outcome.saved.ok === false) {
        saveFlash(`${p.name} was not updated — ${outcome.saved.reason || outcome.saved.error || "check the provider settings"}.`);
        card._saveFailed = true;
      } else if (access.status === "pending") {
        saveFlash(`Saved ${p.name}. Network access verification is pending; provider requests remain blocked until access is verified.`);
      } else if (access.status === "denied") {
        saveFlash(`Saved ${p.name}, but network access was not verified — host access was not granted at install.`);
      } else {
        saveFlash(isActive ? `Updated ${p.name}.` : `Set ${p.name} as default.`);
      }
    },
    onSaved(outcome) {
      const failed = outcome?.saved && outcome.saved.ok === false;
      const model = effectiveModel(card);
      const isFirstRunFlow = panelCtx.isFirstRunFlow();
      const localReady = !p.needsKey && (Boolean(model) || card._testPassed === true);
      if (!failed && (p.needsKey || (localReady && isFirstRunFlow))) {
        panelCtx.callbacks.returnToComposer();
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
      apiKey: enteredKey,
      model: effectiveModel(card),
    };
    testStatus.hidden = false;
    testStatus.className = "test-status testing";
    testStatus.textContent = "Testing…";
    testBtn.disabled = true;
    await requestProviderHostAccess({ baseURL: fields.baseURL });
    const res = await send({ type: "provider.test", ...fields });
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

  if (isActive && cfg.hasApiKey) {
    const k = card.querySelector(".api-key");
    if (k) k.placeholder = "Key set — leave blank to keep";
    const clear = document.createElement("button");
    clear.className = "btn ghost small clear-key";
    clear.type = "button";
    clear.textContent = "Clear key";
    clear.setAttribute("aria-label", `Clear API key for ${p.name}`);
    clear.addEventListener("click", async () => {
      await send({ type: "provider.clear-key" });
      saveFlash("API key cleared.");
      renderProviders(true);
    });
    card.querySelector(".provider-actions")?.appendChild(clear);
  }
  return card;
}

let selectedProviderFamily = null;

async function renderProviders(restoreFocus = false, ctx) {
  const tabsRoot = $("#provider-tabs");
  const panelsRoot = $("#provider-panels");
  let cfg;
  try {
    cfg = await boundedSend("provider.get");
  } catch (e) {
    if (panelsRoot) {
      panelsRoot.innerHTML = `<div class="muted">Couldn't load providers — the agent worker didn't answer (${escapeHtml(String(e?.message ?? e))}).</div>` +
        `<button class="btn small" type="button" id="retry-providers">Retry</button>`;
      panelsRoot.querySelector("#retry-providers")?.addEventListener("click", () => renderProviders(restoreFocus));
    }
    return;
  }
  renderInternalProviderStatus(
    $("#provider-selection-status"),
    providerSelectionPresentation(cfg, PROVIDERS),
  );
  if (!tabsRoot || !panelsRoot) return;
  tabsRoot.replaceChildren();
  panelsRoot.replaceChildren();

  const families = providerFamilies(PROVIDERS);
  if (!families.some((f) => f.id === selectedProviderFamily)) {
    selectedProviderFamily = defaultFamilyId(PROVIDERS, cfg.provider);
  }
  const selected = families.find((f) => f.id === selectedProviderFamily) ?? families[0];

  const tabs = document.createElement("segmented-control");
  tabs.setAttribute("items", families.map((f) => f.label).join(","));
  tabs.setAttribute("label", "Provider families");
  tabs.setAttribute("controls-prefix", "provider-family");
  tabs.addEventListener("change", (e) => {
    const fam = families.find((f) => f.label === e.detail?.value);
    if (!fam) return;
    selectedProviderFamily = fam.id;
    for (const panel of panelsRoot.querySelectorAll(".provider-panel")) {
      panel.hidden = panel.dataset.family !== fam.id;
    }
  });
  tabsRoot.appendChild(tabs);
  if (selected) tabs.value = selected.label;

  for (const fam of families) {
    const slug = familyTabSlug(fam.label);
    const panel = document.createElement("div");
    panel.className = "provider-panel";
    panel.dataset.family = fam.id;
    panel.id = `provider-family-panel-${slug}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `provider-family-tab-${slug}`);
    panel.hidden = fam !== selected;
    const cards = document.createElement("div");
    cards.className = "provider-cards";
    cards.setAttribute("role", "radiogroup");
    cards.setAttribute("aria-label", `${fam.label} providers`);
    for (const p of fam.providers) cards.appendChild(buildProviderCard(p, cfg));
    panel.appendChild(cards);
    panelsRoot.appendChild(panel);
  }

  for (const group of panelsRoot.querySelectorAll(".provider-cards")) {
    group.addEventListener("keydown", (e) => {
      const target = e.target;
      if (!target?.classList?.contains?.("provider-card")) return;
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
    tabs.shadowRoot?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  }
}

async function persistProviderServerTools(next, ctx) {
  await storage.set({ "cap:providerServerTools": next });
  try {
    await send({ type: "invalidate-agent" });
  } catch { /* worker may not be running — the setting still persists */ }
}

export async function renderServerToolAgents(globalOn, ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const box = $("#server-tools-agents");
  const list = $("#server-tools-agent-list");
  if (!box || !list) return;
  box.hidden = !globalOn || !panelCtx.developerFeatures();
  list.replaceChildren();
  if (!globalOn) return;
  const cur = ((await storage.get("cap:providerServerTools"))?.["cap:providerServerTools"]) ?? {};
  const agents = cur.agents && typeof cur.agents === "object" ? cur.agents : {};
  let named = [];
  try {
    const r = await boundedSend("named-agent.list");
    named = Array.isArray(r?.agents) ? r.agents : [];
  } catch { named = []; }
  const rows = [{ key: "hub", name: "Hub (the main agent)" },
    ...named.map((a) => ({ key: String(a?.instanceId ?? ""), name: String(a?.name ?? a?.id ?? "agent") }))]
    .filter((a) => a.key);
  for (const a of rows) {
    const field = document.createElement("div");
    field.className = "toggle-field";
    const t = document.createElement("switch-toggle");
    t.setAttribute("label", a.name);
    t.checked = agents[a.key] === true;
    t.addEventListener("toggle", async (e) => {
      const latest = ((await storage.get("cap:providerServerTools"))?.["cap:providerServerTools"]) ?? {};
      const latestAgents = latest.agents && typeof latest.agents === "object" ? { ...latest.agents } : {};
      latestAgents[a.key] = e.detail.checked === true;
      await persistProviderServerTools({ ...latest, agents: latestAgents });
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

async function initProviderServerTools() {
  const panelCtx = ensureCtx(null, arguments[0]);
  const stCfg = ((await storage.get("cap:providerServerTools"))?.["cap:providerServerTools"]) ?? {};
  const stToggle = $("#server-tools-enabled");
  if (!stToggle) return;
  stToggle.checked = stCfg.enabled === true;
  const key = panelCtx.root ?? panelCtx;
  if (!serverToolsToggleWired.has(key)) {
    serverToolsToggleWired.add(key);
    panelCtx.registerCleanup(() => serverToolsToggleWired.delete(key));
    stToggle.addEventListener("toggle", async (e) => {
      const cur = ((await storage.get("cap:providerServerTools"))?.["cap:providerServerTools"]) ?? {};
      await persistProviderServerTools({ ...cur, enabled: e.detail.checked === true });
      renderServerToolAgents(e.detail.checked === true);
      saveFlash("Provider server tools saved.");
    });
  }
  await renderServerToolAgents(stToggle.checked);
}

/** The per-agent override row (moved to panels/agents.js) */

export function initProvidersStatic(ctx) {
  if (!wireOnce(ctx)) return;
  if (typeof window !== "undefined") {
    on(window, "focus", () => { providerStatusChanged(); }, { once: true });
  }
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  initProvidersStatic();
  await renderProviders(false);
  await initProviderServerTools();
  return {
    refresh: async (restoreFocus = false) => {
      await renderProviders(restoreFocus);
    },
    unmount: makeUnmount(panelCtx),
  };
}

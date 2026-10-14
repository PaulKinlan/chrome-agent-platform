// panels/prompts.js — System prompts & observability Settings panel module.

import { confirmActionDialog } from "../../shared/components-core.js";
import {
  capLogReady,
  getLogFullDetail,
  getLogVerbosity,
  setLogFullDetail,
  setLogVerbosity,
} from "../../lib/cap-log.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const PROMPT_SCOPES = [
  { id: "hub", label: "Hub agent (default)", hint: "Applies to the hub and, unless a named agent has its own customization, to every named/background/hook/scheduled run." },
  { id: "worker", label: "Site Agents", hint: "The base prompt every enrolled site's Site Agent runs with. Per-origin skills are appended at run time." },
];

const observabilityWired = new WeakSet();
const promptsWired = new WeakMap();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("prompts");

export async function wireObservabilitySettings(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const key = panelCtx.root ?? panelCtx;
  if (observabilityWired.has(key)) return;
  const verbosity = byId("log-verbosity");
  const fullDetail = byId("log-full-detail");
  if (!verbosity || !fullDetail) return;
  observabilityWired.add(key);
  panelCtx.registerCleanup(() => observabilityWired.delete(key));
  await capLogReady();
  verbosity.value = getLogVerbosity();
  fullDetail.checked = getLogFullDetail();
  verbosity.addEventListener("change", async () => {
    await setLogVerbosity(verbosity.value);
    saveFlash(`Console logging set to ${verbosity.options?.[verbosity.selectedIndex]?.text ?? verbosity.value}.`);
  });
  fullDetail.addEventListener("toggle", async (event) => {
    const enabled = event.detail?.checked === true;
    await setLogFullDetail(enabled);
    saveFlash(enabled
      ? "Full detail enabled for local DevTools only; exports stay redacted."
      : "Local console payloads are redacted.");
  });
}

export async function renderPrompts(ctx) {
  const panelCtx = ensureCtx(null, ctx);
  const scopeSelect = $("#prompt-scope");
  const hint = $("#prompt-scope-hint");
  const editor = $("#prompt-editor");
  if (!scopeSelect || !editor) return;

  let state = promptsWired.get(editor);
  if (!state) {
    state = {
      currentRevision: null,
      loadedScope: "hub",
      agents: [],
    };
    promptsWired.set(editor, state);
    panelCtx.registerCleanup(() => promptsWired.delete(editor));
  }

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
  state.agents = agents;
  for (const a of agents) {
    const opt = document.createElement("option");
    opt.value = `agent:${a.id}`;
    opt.textContent = `Agent: ${a.name}`;
    scopeSelect.append(opt);
  }

  async function load() {
    const scope = scopeSelect.value || "hub";
    const preset = PROMPT_SCOPES.find((s) => s.id === scope);
    if (hint) {
      hint.textContent = preset?.hint
        ?? (scope.startsWith("agent:")
          ? "This named agent's system prompt. It inherits the hub customization until you save an agent-specific one; its role rides as a labelled layer."
          : "");
    }
    const label = preset?.label
      ?? (scope.startsWith("agent:")
        ? `Agent: ${state.agents.find((a) => `agent:${a.id}` === scope)?.name ?? scope.slice(6)}`
        : scope);
    editor.setAttribute("scope-label", label);
    editor.data = null; // loading state
    const d = await send({ type: "prompt.describe", scope })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    state.currentRevision = Number.isSafeInteger(d?.revision) ? d.revision : null;
    state.loadedScope = scope;
    editor.data = d;
  }

  async function mutate(type, payload = {}) {
    const scope = scopeSelect.value || "hub";
    if (type === "prompt.set") {
      try {
        const has = (await globalThis.chrome?.permissions?.contains?.({ permissions: ["storage"] })) === true;
        if (!has) {
          saveFlash("Storage not granted — this customization is session-only. Storage is a core permission; reinstall the extension and try again.");
        }
      } catch { /* an unverifiable grant falls through to the save */ }
    }
    if (type === "prompt.set" || type === "prompt.reset" || type === "prompt.keep") {
      payload = { ...payload, expectedRevision: state.currentRevision };
    }
    editor.setAttribute("busy", "");
    const r = await send({ type, scope, ...payload })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    editor.removeAttribute("busy");
    if (r?.ok === false) {
      if (r.conflict) {
        saveFlash("Changed in another window — the latest state was reloaded; retry your edit.");
      } else {
        saveFlash(`Prompt not saved: ${r.error ?? "unknown error"}`);
      }
    } else if (type === "prompt.set") {
      const durableNow = await globalThis.chrome?.permissions
        ?.contains?.({ permissions: ["storage"] })
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

  state.load = load;
  state.mutate = mutate;

  if (!state.listenersInstalled) {
    state.listenersInstalled = true;
    scopeSelect.addEventListener("change", async () => {
      if (editor.dirty && !await confirmActionDialog({
        title: "Discard unsaved edits?",
        body: "Discard the unsaved prompt edits and switch scope?",
        confirmLabel: "Discard",
        destructive: true,
      })) {
        scopeSelect.value = state.loadedScope;
        return;
      }
      await state.load();
    });
    editor.addEventListener("prompt-save", (e) =>
      state.mutate("prompt.set", { mode: e.detail.mode, text: e.detail.text }));
    editor.addEventListener("prompt-reset", (e) =>
      state.mutate("prompt.reset", { effective: e.detail?.effective === true }));
    editor.addEventListener("prompt-keep", () => state.mutate("prompt.keep"));
  }

  await load();
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  await wireObservabilitySettings();
  await renderPrompts();
  return {
    refresh: () => renderPrompts(),
    unmount: makeUnmount(panelCtx),
  };
}

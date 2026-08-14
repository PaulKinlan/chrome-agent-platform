// lib/provider.js — pluggable model layer (Vercel AI SDK).
//
// Models are swappable: a provider is an OpenAI-compatible endpoint + apiKey +
// model id, resolved from chrome.storage config (set in the hub settings). The
// default is DeepSeek (deepseek-v4-pro). A deferred-tasks route exists for
// sending some tasks to a glm-5.3 endpoint via intercom (documented seam).

import { createOpenAI } from "@ai-sdk/openai";

const DEFAULTS = {
  provider: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  model: "deepseek-chat", // deepseek-v4-pro served here; swap via config
  apiKey: "",            // set in hub settings / chrome.storage
};

export async function getProviderConfig() {
  const stored = await chrome.storage.local.get("providerConfig");
  return { ...DEFAULTS, ...(stored.providerConfig ?? {}) };
}

export async function setProviderConfig(partial) {
  const cur = await getProviderConfig();
  const next = { ...cur, ...partial };
  await chrome.storage.local.set({ providerConfig: next });
  return next;
}

export async function getModel() {
  const cfg = await getProviderConfig();
  if (!cfg.apiKey) {
    throw new Error("No model API key configured — set it in the hub (⚙ provider) first.");
  }
  const provider = createOpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  return { provider: provider(cfg.model), model: cfg.model, providerName: cfg.provider };
}

/**
 * Deferred-tasks seam: route a task to a glm-5.3 endpoint via intercom.
 * The extension cannot open intercom (pi-session-to-pi-session); this is a
 * documented seam — in the hosted harness the parent session posts the task
 * here. For the extension, `deferToGlm` posts to a configurable webhook/endpoint
 * if one is configured, else returns null (caller falls back to the local model).
 */
export async function deferToGlm(task) {
  const cfg = await getProviderConfig();
  const endpoint = cfg.glmDeferEndpoint;
  if (!endpoint) return null; // not configured — caller handles locally
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task }),
  });
  if (!res.ok) throw new Error(`glm defer failed: ${res.status}`);
  return await res.json();
}

// extension/shared/recipe-icons.js
var RECIPE_ICON = {
  broom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M21 3l-9 9-3-3 9-9z"/><path d="M9 12l-6 6a2.5 2.5 0 0 0 3 3l6-6"/><path d="M12 9l3 3"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  books: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  sleep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  mood: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>',
  ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  tags: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>'
};

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

// extension/lib/models/prompt-api-model.js
function extractText(prompt) {
  let out = "";
  for (const msg of prompt ?? []) {
    const c = msg?.content;
    if (typeof c === "string") out += c;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "text") out += part.text;
      }
    }
  }
  return out;
}
function getPromptApi() {
  const g = globalThis;
  if (typeof g.LanguageModel === "function") return g.LanguageModel;
  if (g.ai && typeof g.ai.languageModel?.create === "function") return g.ai.languageModel;
  return null;
}
async function isPromptApiAvailable() {
  try {
    const api = getPromptApi();
    if (!api) return false;
    if (typeof api.capabilities === "function") {
      const caps = await api.capabilities();
      return caps?.available === "readily" || caps?.available === "after-download";
    }
    if (typeof api.availability === "function") {
      return await api.availability() === "available";
    }
    return true;
  } catch {
    return false;
  }
}
function createPromptApiModel() {
  const api = getPromptApi();
  if (!api) throw new Error("Chrome Prompt API not available");
  let session = null;
  const ensureSession = async () => {
    if (session) return session;
    try {
      session = await api.create({
        systemPrompt: "You are the Chrome Agent Platform hub agent. Be concise and helpful.",
        topK: 40,
        temperature: 0.4
      });
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (/topK|temperature/i.test(msg)) {
        throw new Error(`Chrome Prompt API session failed: ${msg}`);
      }
      if (/download|not available|not supported/i.test(msg)) {
        throw new Error(
          "Chrome Prompt API (Gemini nano) model is not ready \u2014 download it via chrome://flags or wait for it to finish downloading."
        );
      }
      throw new Error(`Chrome Prompt API session failed: ${msg}`);
    }
    return session;
  };
  return {
    // v2 is the known-good LanguageModel spec this adapter implements; the AI
    // SDK logs a benign "v2 compatibility mode" warning and runs it via its
    // v2→current compat layer (the Prompt API exposes none of the v3/v4
    // features that would justify the larger migration).
    specificationVersion: "v2",
    provider: "chrome-prompt-api",
    modelId: "gemini-nano",
    supportedUrls: {},
    async doGenerate(options) {
      const s = await ensureSession();
      const text = extractText(options.prompt);
      const out = await s.prompt(text);
      return {
        content: [{ type: "text", text: out }],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        // Prompt API doesn't report tokens
        warnings: []
      };
    },
    async doStream(options) {
      const s = await ensureSession();
      const text = extractText(options.prompt);
      const stream = s.promptStreaming(text);
      const id = `prompt-${crypto.randomUUID?.() ?? Math.random()}`;
      const readable = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id });
          const reader = stream.getReader();
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue({ type: "text-delta", id, delta: value });
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            finishReason: "stop"
          });
          controller.close();
        }
      });
      return { stream: readable };
    }
  };
}

// extension/lib/provider-test.js
var OPENAI_COMPATIBLE_IDS = /* @__PURE__ */ new Set([
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "ollama"
]);
function errorKindForStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "http";
}
async function testProvider(p, fields = {}) {
  const t0 = performance.now();
  const latency = () => Math.max(0, Math.round(performance.now() - t0));
  if (p.id === "demo") {
    return {
      ok: true,
      latencyMs: latency(),
      detail: "Demo (local) \u2014 deterministic, no network, always works."
    };
  }
  if (p.id === "prompt-api") {
    if (!await isPromptApiAvailable()) {
      return {
        ok: false,
        latencyMs: latency(),
        errorKind: "unavailable",
        error: "Chrome Prompt API (Gemini nano) is not available \u2014 enable it in chrome://flags and download the model."
      };
    }
    try {
      const model2 = createPromptApiModel();
      const out = await model2.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }
        ]
      });
      const text = String(out?.content?.[0]?.text ?? "").trim();
      return {
        ok: true,
        latencyMs: latency(),
        detail: `Prompt API responded (${text ? JSON.stringify(text.slice(0, 30)) : "no text"}).`
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: latency(),
        errorKind: "error",
        error: String(e?.message ?? e)
      };
    }
  }
  if (!OPENAI_COMPATIBLE_IDS.has(p.id)) {
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "config",
      error: `Unknown provider "${p.id}".`
    };
  }
  const baseURL = String(fields.baseURL || p.baseURL || "").replace(/\/+$/, "");
  const apiKey = String(fields.apiKey ?? "").trim();
  const model = String(fields.model ?? "").trim();
  if (!baseURL || !model) {
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "config",
      error: `Missing ${!baseURL ? "base URL" : "model id"} \u2014 fill it in, then test.`
    };
  }
  if (p.needsKey !== false && !apiKey) {
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "config",
      error: "Missing API key \u2014 enter it, then test."
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2e4);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
        stream: false
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      return {
        ok: true,
        latencyMs: latency(),
        status: res.status,
        detail: `Model "${model}" responded (HTTP ${res.status}).`
      };
    }
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      const first = Array.isArray(err) ? err[0] : err;
      msg = first?.error?.message || first?.error?.code || first?.error?.status || first?.error?.type || first?.message || msg;
    } catch {
    }
    return {
      ok: false,
      latencyMs: latency(),
      status: res.status,
      errorKind: errorKindForStatus(res.status),
      error: msg
    };
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") {
      return {
        ok: false,
        latencyMs: latency(),
        errorKind: "timeout",
        error: "Timed out after 20s \u2014 check the base URL / network."
      };
    }
    return {
      ok: false,
      latencyMs: latency(),
      errorKind: "network",
      error: `Unreachable: ${String(e?.message ?? e)}`
    };
  }
}

// extension/shared/components.js
var TRUE = "";
var ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  record: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
};
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}
function supportsAnchorPositioning() {
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("position-area", "top span-left");
  } catch {
    return false;
  }
}
function placeFloating(anchor, floatEl, { fullWidth = false, minWidth = 0 } = {}) {
  if (!anchor || !floatEl) return;
  const a = anchor.getBoundingClientRect();
  if (!a.width && !a.height) return;
  const margin = 8;
  const w = fullWidth ? Math.min(a.width, window.innerWidth - 2 * margin) : Math.max(floatEl.offsetWidth || 0, minWidth);
  const h = floatEl.offsetHeight || 160;
  const below = a.bottom + 4;
  const above = a.top - h - 4;
  const fitsBelow = below + h <= window.innerHeight - margin;
  const fitsAbove = above >= margin;
  let top = fitsBelow || !fitsAbove ? below : above;
  top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
  let left = fullWidth ? a.left : Math.min(a.left, window.innerWidth - w - margin);
  left = Math.max(margin, left);
  floatEl.style.position = "fixed";
  floatEl.style.top = `${top}px`;
  floatEl.style.left = `${left}px`;
  floatEl.style.right = "auto";
  floatEl.style.bottom = "auto";
  if (fullWidth) floatEl.style.width = `${w}px`;
}
function ensureStyle(styleId, css) {
  if (document.getElementById(styleId)) return;
  const st = document.createElement("style");
  st.id = styleId;
  st.textContent = css;
  document.head.appendChild(st);
}
function parseJSONAttr(v, fallback) {
  if (v == null || v === "") return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}
function fire(el, type, detail = {}) {
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}
function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}
function renderBlockText(text) {
  const lines = String(text ?? "").split("\n");
  let html = "";
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      html += `<p>${renderInline(para.join(" "))}</p>`;
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (ul) {
      flushPara();
      if (list !== "ul") {
        flushList();
        html += "<ul>";
        list = "ul";
      }
      html += `<li>${renderInline(ul[1])}</li>`;
    } else if (ol) {
      flushPara();
      if (list !== "ol") {
        flushList();
        html += "<ol>";
        list = "ol";
      }
      html += `<li>${renderInline(ol[1])}</li>`;
    } else if (h) {
      flushPara();
      flushList();
      const level = Math.min(h[1].length, 4);
      html += `<h${level}>${renderInline(h[2])}</h${level}>`;
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html;
}
function renderMarkdown(text) {
  const src = String(text ?? "");
  const out = [];
  const fence = /^```([^\n`]*)\n?([\s\S]*?)(?:^```\s*$)/gm;
  let last = 0;
  let m;
  while (m = fence.exec(src)) {
    if (m.index > last) out.push(renderBlockText(src.slice(last, m.index)));
    const lang = (m[1] || "").trim();
    out.push(`<code-block lang="${escapeHtml(lang)}">${escapeHtml(m[2])}</code-block>`);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(renderBlockText(src.slice(last)));
  return out.join("");
}
function isHtmlDocument(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  if (/^<!doctype\s+html/i.test(s)) return true;
  if (/^<html(\s|>)/i.test(s)) return true;
  if (s[0] === "<" && /<(div|section|article|main|header|footer|table|ul|ol|form|h1|h2|h3|p)\b/i.test(s) && /<\/(div|section|article|main|header|footer|table|ul|ol|form|h1|h2|h3|p)>/i.test(s)) {
    return true;
  }
  return false;
}
function renderHtmlFrame(html) {
  return `<div class="html-frame"><iframe title="Rendered HTML output" sandbox="allow-scripts allow-popups" srcdoc="${escapeHtml(html)}"></iframe></div>`;
}
var RUNTIME_SEND = (() => {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      return (type, payload = {}) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else resolve(res ?? { ok: true });
        });
      });
    }
  } catch {
  }
  return null;
})();
function shortOrigin(o) {
  return String(o).replace(/^https?:\/\//, "").replace(/\/.*/, "");
}
var COMMAND_NAMESPACES = [
  { id: "task", label: "task", description: "run a recipe", kind: "recipe" },
  { id: "schedule", label: "schedule", description: "run a recipe in the background", kind: "background" },
  { id: "agent", label: "agent", description: "direct the message to a site agent", kind: "agent" },
  { id: "skill", label: "skill", description: "invoke a skill", kind: "skill" },
  { id: "model", label: "model", description: "switch the provider/model", kind: "model" },
  { id: "theme", label: "theme", description: "switch the theme", kind: "theme" },
  { id: "remember", label: "remember", description: "write something to memory", kind: "free" },
  { id: "focus", label: "focus", description: "protect attention", kind: "recipe" }
];
async function commandItems(ns, arg = "") {
  const q = (arg || "").toLowerCase();
  const matches = (s) => !q || s.toLowerCase().includes(q);
  switch (ns) {
    case "task": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("recipe.list").catch(() => ({})) : {};
      return (res.recipes || []).filter((r) => r.mode !== "background").filter((r) => matches(r.name) || matches(r.id)).map((r) => ({ id: `task:${r.id}`, label: r.name, description: r.description || "", kind: "recipe" }));
    }
    case "schedule": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("recipe.list").catch(() => ({})) : {};
      return (res.recipes || []).filter((r) => r.mode === "background").filter((r) => matches(r.name) || matches(r.id)).map((r) => ({ id: `schedule:${r.id}`, label: r.name, description: r.description || "", kind: "background" }));
    }
    case "agent": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("agent.directory").catch(() => ({})) : {};
      return (res.agents || []).filter((a) => a.enrolled).filter((a) => matches(a.origin) || matches(a.name || "")).map((a) => ({ id: `agent:${a.origin}`, label: `@${shortOrigin(a.origin)}`, description: `${a.toolCount ?? 0} tools`, kind: "agent" }));
    }
    case "skill": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("skills.all").catch(() => ({})) : {};
      const out = [];
      for (const [origin, skills] of Object.entries(res || {})) {
        for (const s of skills) {
          if (matches(s) || matches(shortOrigin(origin))) {
            out.push({ id: `skill:${origin}:${s}`, label: s, description: shortOrigin(origin), kind: "skill" });
          }
        }
      }
      return out;
    }
    case "model": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("provider.models").catch(() => ({})) : {};
      return (res.choices || []).filter((c) => matches(c.label || "") || matches(c.id || "")).map((c) => ({ id: `model:${c.id}`, label: c.label || c.id, description: "", kind: "model" }));
    }
    case "theme":
      return THEMES.filter((t) => matches(t.label) || matches(t.id)).map((t) => ({ id: `theme:${t.id}`, label: t.label, description: "theme", kind: "theme" }));
    case "focus": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("recipe.list").catch(() => ({})) : {};
      return (res.recipes || []).filter((r) => r.mode === "background" && (r.category === "focus" || (r.id || "").includes("focus"))).filter((r) => matches(r.name) || matches(r.id)).map((r) => ({ id: `task:${r.id}`, label: r.name, description: r.description || "", kind: "recipe" }));
    }
    default:
      return [];
  }
}
async function mentionCandidates(q = "") {
  const ql = (q || "").toLowerCase();
  const items = [];
  if (RUNTIME_SEND) {
    const [agents, recipes, assets] = await Promise.all([
      RUNTIME_SEND("agent.directory").catch(() => ({ agents: [] })),
      RUNTIME_SEND("recipe.list").catch(() => ({ recipes: [] })),
      RUNTIME_SEND("asset.list", { origin: "master" }).catch(() => ({ assets: [] }))
    ]);
    for (const a of (agents.agents || []).filter((x) => x.enrolled)) {
      items.push({ id: `agent:${a.origin}`, label: `@${shortOrigin(a.origin)}`, description: `${a.toolCount ?? 0} tools \xB7 site agent`, kind: "agent" });
    }
    for (const r of recipes.recipes || []) {
      items.push({ id: `recipe:${r.id}`, label: r.name, description: r.description || "", kind: "recipe" });
    }
    for (const a of assets.assets || []) {
      items.push({ id: `asset:${a.id ?? a.name}`, label: a.name, description: a.type || "artifact", kind: "artifact" });
    }
  }
  return items.filter((i) => (i.label || "").toLowerCase().includes(ql) || (i.id || "").toLowerCase().includes(ql));
}
var Component = class extends HTMLElement {
  static shadow() {
    return true;
  }
  constructor() {
    super();
    const useShadow = this.constructor.shadow();
    if (useShadow) {
      this._root = this.attachShadow({ mode: "open" });
    } else {
      this._root = this;
    }
  }
  connectedCallback() {
    if (this._rendered) return;
    this._rendered = true;
    this._render();
    this._wire();
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (this._rendered && oldValue !== newValue) {
      this._render();
      this._wire();
    }
  }
  // Bind a document-level listener exactly once (survives re-render).
  _bindDocument(type, handler) {
    if (!this._docListeners) this._docListeners = [];
    if (this._docListeners.some((l) => l.type === type)) return;
    const wrapped = (e) => handler.call(this, e);
    this._docListeners.push({ type, wrapped });
    document.addEventListener(type, wrapped);
  }
  disconnectedCallback() {
    if (this._docListeners) {
      this._docListeners.forEach(({ type, wrapped }) => document.removeEventListener(type, wrapped));
      this._docListeners = [];
    }
    this._rendered = false;
  }
  // subclasses override _render/_wire
  _render() {
  }
  _wire() {
  }
  _emit(type, detail) {
    fire(this, type, detail);
  }
};
function mountTemplate(host, style, markup) {
  const useShadow = host.constructor.shadow();
  const root = host._root;
  if (useShadow) {
    root.innerHTML = `<style>${style}</style>${markup}`;
  } else {
    const styleId = `sc-${host.localName}-style`;
    if (!document.getElementById(styleId)) {
      const st = document.createElement("style");
      st.id = styleId;
      st.textContent = style;
      document.head.appendChild(st);
    }
    root.innerHTML = markup;
  }
  return root;
}
var RunTaskButton = class extends Component {
  static get observedAttributes() {
    return ["label", "loading", "disabled"];
  }
  _render() {
    const label = this.getAttribute("label") || "Run task";
    const loading = this.hasAttribute("loading");
    const disabled = this.hasAttribute("disabled");
    const html = `<button part="button" class="run" type="button"${disabled ? " disabled" : ""}${loading ? ' aria-busy="true"' : ""}>${loading ? '<span class="spin" aria-hidden="true"></span>' : ""}<span>${escapeHtml(label)}</span></button>`;
    mountTemplate(this, `
      :host { display: inline-flex; }
      .run { display:inline-flex; gap:8px; align-items:center; border:0;
        border-radius:8px; padding:9px 16px; font:inherit; font-weight:600;
        cursor:pointer; background:var(--accent, #0e6e63); color:var(--accent-contrast, #fff); }
      .run:disabled { opacity:.55; cursor:not-allowed; }
      .run:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .spin { width:14px; height:14px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation: sc-spin 1s linear infinite; }
      @keyframes sc-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
    `, html);
  }
  _wire() {
    this._root.querySelector(".run")?.addEventListener("click", () => {
      if (this.hasAttribute("disabled") || this.hasAttribute("loading")) return;
      this._emit("run-task");
    });
  }
};
customElements.define("run-task-button", RunTaskButton);
var MicButton = class extends Component {
  static get observedAttributes() {
    return ["listening", "label"];
  }
  constructor() {
    super();
    this._recognition = null;
    this._listening = false;
  }
  _render() {
    const listening = this.hasAttribute("listening");
    const label = this.getAttribute("label") || "Start listening";
    mountTemplate(this, `
      :host { display:inline-flex; }
      .mic { display:inline-flex; align-items:center; justify-content:center; width:var(--control,36px);
        height:var(--control,36px); background:transparent;
        border:1px solid var(--border, #333); color:var(--text, #eee); border-radius:8px;
        padding:0; cursor:pointer; font:inherit; line-height:1; }
      .mic .icon { display:inline-flex; align-items:center; justify-content:center; }
      .mic svg { display:block; }
      .mic[data-listening] { color:var(--accent, #0e6e63); border-color:var(--accent, #0e6e63); }
      .mic:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .wave { display:none; align-items:center; gap:2px; height:16px; }
      .mic[data-listening] .icon { display:none; }
      .mic[data-listening] .wave { display:inline-flex; }
      .wave span { width:3px; background:currentColor; border-radius:2px; animation:sc-wave 1s ease-in-out infinite; }
      .wave span:nth-child(1){height:6px;animation-delay:0s}.wave span:nth-child(2){height:12px;animation-delay:.15s}
      .wave span:nth-child(3){height:16px;animation-delay:.3s}.wave span:nth-child(4){height:10px;animation-delay:.45s}
      .wave span:nth-child(5){height:7px;animation-delay:.6s}
      @keyframes sc-wave { 0%,100%{transform:scaleY(.5)} 50%{transform:scaleY(1)} }
      @media (prefers-reduced-motion: reduce) { .wave span { animation:none; } }
    `, `<button part="button" class="mic" type="button" aria-label="${escapeHtml(label)}"
      aria-pressed="${listening}"><span class="icon">${ICONS.mic}</span><span class="wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span></button>`);
    this._button = this._root.querySelector(".mic");
  }
  _wire() {
    this._button?.addEventListener("click", () => this.toggle());
  }
  get listening() {
    return this._listening;
  }
  toggle() {
    this._listening ? this.stop() : this.start();
  }
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._emit("mic-error", { message: "speech recognition not available in this browser" });
      return;
    }
    if (!this._recognition) {
      this._recognition = new SR();
      this._recognition.continuous = true;
      this._recognition.interimResults = true;
      this._recognition.lang = "en-US";
      this._recognition.onresult = (e) => {
        let finalText = "";
        let interimText = "";
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i];
          if (!res?.[0]) continue;
          if (res.isFinal) finalText += res[0].transcript;
          else interimText += res[0].transcript;
        }
        const text = (finalText + (finalText && interimText ? " " : "") + interimText).trim();
        this._emit("transcript", { text, final: !interimText });
      };
      this._recognition.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        const msg = e.error === "not-allowed" || e.error === "service-not-allowed" ? "microphone permission denied" : e.error === "network" ? "speech service unavailable (network)" : "speech error: " + e.error;
        this._emit("mic-error", { message: msg });
        this.stop();
      };
      this._recognition.onend = () => {
        if (this._listening) {
          try {
            this._recognition.start();
          } catch {
          }
          return;
        }
      };
    }
    this._listening = true;
    this.setAttribute("listening", TRUE);
    this._emit("mic-toggle", { listening: true });
    try {
      this._recognition.start();
    } catch {
    }
  }
  stop() {
    this._listening = false;
    this.removeAttribute("listening");
    this._emit("mic-toggle", { listening: false });
    if (this._recognition) {
      try {
        this._recognition.stop();
      } catch {
      }
    }
  }
  disconnectedCallback() {
    this._listening = false;
    if (this._recognition) {
      try {
        this._recognition.onresult = null;
        this._recognition.onerror = null;
        this._recognition.onend = null;
        this._recognition.abort?.();
      } catch {
      }
      this._recognition = null;
    }
    super.disconnectedCallback?.();
  }
};
customElements.define("mic-button", MicButton);
var AttachButton = class extends Component {
  static get observedAttributes() {
    return ["label", "open"];
  }
  constructor() {
    super();
    this._fileInput = null;
  }
  _render() {
    const label = this.getAttribute("label") || "Add attachment";
    const open = this.hasAttribute("open");
    mountTemplate(this, `
      :host { position:relative; display:inline-flex; }
      .plus { display:inline-flex; align-items:center; justify-content:center; width:var(--control,36px);
        height:var(--control,36px); background:transparent;
        border:1px solid var(--border,#e3e0d9); color:var(--text,#1d1b18); border-radius:8px;
        padding:0; cursor:pointer; font:inherit; line-height:1; anchor-name:--attach-anchor; }
      .plus svg { display:block; }
      .plus:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .menu { position:absolute; inset:auto; margin:0; background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.25);
        padding:4px; min-width:200px; z-index:20;
        position-anchor:--attach-anchor; position-area:top span-left;
        position-try-fallbacks:flip-block, flip-inline; }
      @supports not (position-area: top) {
        .menu { position:absolute; bottom:calc(100% + 6px); left:0; }
      }
      .menu[hidden] { display:none; }
      .menu button { display:block; width:100%; text-align:left; background:transparent; border:0;
        color:var(--text,#1d1b18); padding:8px 10px; border-radius:7px; cursor:pointer; font:inherit; }
      .menu button:hover, .menu button:focus-visible { background:var(--bg,#12121c); outline:none; }
      .note { font-size:11px; color:var(--muted,#635e56); margin:6px 0 2px; max-width:220px; }
    `, `<button part="button" class="plus" type="button" aria-haspopup="menu"
        aria-expanded="${open}" aria-label="${escapeHtml(label)}">${ICONS.plus}</button>
      <div class="menu" role="menu" aria-label="${escapeHtml(label)}" popover="manual"${open ? "" : " hidden"}>
        <button type="button" role="menuitem" data-kind="file">Add file</button>
        <button type="button" role="menuitem" data-kind="record-audio">Record audio</button>
        <button type="button" role="menuitem" data-kind="capture-camera">Capture camera</button>
        <p class="note">Text files are read by the agent. Audio, camera, and image attachments are sent to the model as data (multimodal where the provider supports it).</p>
      </div>`);
    this._btn = this._root.querySelector(".plus");
    this._menu = this._root.querySelector(".menu");
  }
  _wire() {
    this._btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggle(this._menu.hidden);
    });
    this._menu?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this._toggle(false);
        this._btn?.focus();
        return;
      }
      const items = [...this._menu.querySelectorAll("button[role=menuitem]")];
      const idx = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        items[(idx + d + items.length) % items.length].focus();
      }
    });
    this._menu?.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-kind]");
      if (!b) return;
      this._toggle(false);
      const kind = b.dataset.kind;
      if (kind === "record-audio" || kind === "capture-camera") {
        this._emit("attach-media", { kind });
        return;
      }
      const file = await this._pickFile(kind);
      if (file) this._emit("attach", file);
    });
    this._bindDocument("click", (e) => {
      if (this._menu && !this._menu.hidden && !this._menu.contains(e.target) && e.target !== this._btn) {
        this._toggle(false);
      }
    });
  }
  _toggle(open) {
    if (!this._menu) return;
    if (open) {
      if (!supportsAnchorPositioning()) placeFloating(this._btn, this._menu, { minWidth: 200 });
      this._menu.hidden = false;
      if (typeof this._menu.showPopover === "function") {
        try {
          this._menu.showPopover();
        } catch {
        }
      }
      this._isOpen = true;
      this._menu.querySelector("button[role=menuitem]")?.focus();
    } else {
      if (typeof this._menu.hidePopover === "function") {
        try {
          this._menu.hidePopover();
        } catch {
        }
      }
      this._menu.hidden = true;
      this._isOpen = false;
    }
  }
  _pickFile(kind) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (kind === "audio") input.accept = "audio/*";
      if (kind === "video") input.accept = "video/*";
      input.onchange = async () => {
        const file = input.files?.[0] ?? null;
        if (!file) return resolve(null);
        let dataURL = "";
        try {
          dataURL = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = () => rej(fr.error);
            fr.readAsDataURL(file);
          });
        } catch {
        }
        resolve({ name: file.name, size: file.size, type: file.type, kind, file, dataURL });
      };
      input.oncancel = () => resolve(null);
      input.click();
      this._fileInput = input;
    });
  }
};
customElements.define("attach-button", AttachButton);
var THEMES = [
  { id: "midnight", label: "Midnight" },
  { id: "sunlit", label: "Sunlit" },
  { id: "neon", label: "Neon" },
  { id: "terminal", label: "Terminal" }
];
var ThemePicker = class extends Component {
  static get observedAttributes() {
    return ["theme"];
  }
  _render() {
    const current = this.getAttribute("theme") || "sunlit";
    const swatches = THEMES.map(
      (t) => `<button type="button" class="swatch theme-${t.id}" data-theme="${t.id}"
        aria-label="${escapeHtml(t.label)} theme" aria-pressed="${t.id === current}"
        title="${escapeHtml(t.label)}"><span class="label">${escapeHtml(t.label)}</span></button>`
    ).join("");
    mountTemplate(this, `
      :host { display:inline-flex; gap:10px; }
      .swatch { position:relative; width:44px; height:44px; border-radius:10px; border:2px solid transparent; cursor:pointer; }
      .swatch[aria-pressed="true"] { border-color:var(--text,#1d1b18); }
      .swatch:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .swatch .label { position:absolute; inset:auto 0 2px; font-size:9px; text-align:center; color:inherit; }
      .theme-midnight { background:#12121c; color:#cdd6f4; }
      .theme-sunlit { background:#f4f1e8; color:#2b2b2b; }
      .theme-neon { background:#0a0a14; color:#22d3ee; box-shadow:0 0 10px #22d3ee55; }
      .theme-terminal { background:#0c0c0c; color:#33ff66; }
    `, swatches);
  }
  _wire() {
    this._root.querySelectorAll(".swatch").forEach(
      (s) => s.addEventListener("click", () => this._emit("theme-change", { theme: s.dataset.theme }))
    );
  }
};
customElements.define("theme-picker", ThemePicker);
var SwitchToggle = class extends Component {
  static get observedAttributes() {
    return ["checked", "label"];
  }
  _render() {
    const checked = this.hasAttribute("checked");
    const label = this.getAttribute("label") || "Toggle";
    mountTemplate(this, `
      :host { display:inline-flex; flex:0 0 auto; }
      .sw { position:relative; width:36px; height:20px; border-radius:999px;
        border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); cursor:pointer;
        padding:0; flex:0 0 auto; transition:background 150ms ease, border-color 150ms ease; }
      .sw::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px;
        border-radius:50%; background:var(--muted,#635e56); transition:transform 150ms ease, background 150ms ease; }
      .sw[aria-pressed="true"] { background:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
      .sw[aria-pressed="true"]::after { transform:translateX(16px); background:var(--btn-fg,#ffffff); }
      .sw:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion: reduce) { .sw, .sw::after { transition:none; } }
    `, `<button part="switch" class="sw" type="button" role="switch"
        aria-checked="${checked}" aria-pressed="${checked}" aria-label="${escapeHtml(label)}"></button>`);
    this._btn = this._root.querySelector(".sw");
  }
  _wire() {
    this._btn?.addEventListener("click", () => {
      this.toggleAttribute("checked");
      this._emit("toggle", { checked: this.hasAttribute("checked") });
    });
  }
  get checked() {
    return this.hasAttribute("checked");
  }
  set checked(v) {
    v ? this.setAttribute("checked", "") : this.removeAttribute("checked");
  }
};
customElements.define("switch-toggle", SwitchToggle);
var PermissionRow = class extends Component {
  static get observedAttributes() {
    return ["capability", "label", "description", "granted", "warned", "disabled"];
  }
  _render() {
    const cap = this.getAttribute("capability") || "";
    const label = this.getAttribute("label") || cap;
    const desc = this.getAttribute("description") || "";
    const granted = this.hasAttribute("granted");
    const warned = this.hasAttribute("warned");
    const disabled = this.hasAttribute("disabled");
    mountTemplate(this, `
      :host { display:block; }
      .perm { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); }
      .info { flex:1; min-width:0; }
      .name { font-weight:600; }
      .desc { font-size:12px; color:var(--muted,#635e56); }
      .state { font-size:11px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted,#635e56); }
      .state.granted { color:var(--accent2,#34d399); }
      .state.warned { color:var(--warn,#f59e0b); }
      .btn { border:1px solid var(--border,#e3e0d9); background:transparent; color:var(--text,#1d1b18); border-radius:7px; padding:6px 12px; cursor:pointer; font:inherit; }
      .btn:disabled { opacity:.5; cursor:not-allowed; }
      .btn:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
    `, `<div class="perm">
      <div class="info"><div class="name">${escapeHtml(label)}</div><div class="desc">${escapeHtml(desc)}</div></div>
      <span class="state ${granted ? "granted" : ""}${warned ? " warned" : ""}">${granted ? "Granted" : "Not granted"}${warned ? " \xB7 warns" : ""}</span>
      <button type="button" class="btn"${disabled ? " disabled" : ""}>${granted ? "Disable" : "Enable"}</button>
    </div>`);
  }
  _wire() {
    this._root.querySelector(".btn")?.addEventListener("click", () => {
      const granted = this.hasAttribute("granted");
      this._emit(granted ? "disable" : "enable", { capability: this.getAttribute("capability") });
    });
  }
};
customElements.define("permission-row", PermissionRow);
var SiteAgentCard = class extends Component {
  static get observedAttributes() {
    return ["origin", "tools", "status"];
  }
  _render() {
    const origin = this.getAttribute("origin") || "";
    const tools = parseJSONAttr(this.getAttribute("tools"), []);
    const status = this.getAttribute("status") || "";
    const short = origin.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    mountTemplate(this, `
      :host { display:block; }
      .card { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); cursor:pointer; }
      .card:hover, .card:focus-visible { border-color:var(--accent,#0e6e63); outline:none; }
      .badge { width:32px; height:32px; border-radius:8px; background:var(--accent,#0e6e63); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
      .who { flex:1; min-width:0; }
      .name { font-weight:600; }
      .tools { font-size:12px; color:var(--muted,#635e56); }
      .status { font-size:11px; color:var(--muted,#635e56); }
    `, `<div class="card" role="button" tabindex="0" aria-label="Use site agent ${escapeHtml(short)}">
      <span class="badge" aria-hidden="true">@</span>
      <span class="who"><span class="name">@${escapeHtml(short)}</span><span class="tools"> \xB7 ${tools.length} tools</span></span>
      ${status ? `<span class="status">${escapeHtml(status)}</span>` : ""}
    </div>`);
  }
  _wire() {
    const card = this._root.querySelector(".card");
    card?.addEventListener("click", () => this._emit("select", { origin: this.getAttribute("origin") }));
    card?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._emit("select", { origin: this.getAttribute("origin") });
      }
    });
  }
};
customElements.define("site-agent-card", SiteAgentCard);
var CapabilityRow = class extends Component {
  static get observedAttributes() {
    return ["name", "description", "icon", "action", "enabled", "last-run"];
  }
  _render() {
    const name = this.getAttribute("name") || "";
    const description = this.getAttribute("description") || "";
    const icon = this.getAttribute("icon") || "";
    const action = this.getAttribute("action") || "run";
    const enabled = this.hasAttribute("enabled");
    const lastRun = this.getAttribute("last-run") || "";
    const actionHtml = action === "toggle" ? `<switch-toggle part="toggle"${enabled ? " checked" : ""}
          label="${enabled ? "Disable" : "Enable"} ${escapeHtml(name)} in the background"></switch-toggle>` : `<button part="run" class="run" type="button">Run</button>`;
    mountTemplate(this, `
      :host { display:block; }
      .row { display:grid; grid-template-columns:28px 1fr auto; gap:12px; align-items:center;
        padding:12px 14px; border-bottom:1px solid var(--border,#30363d); background:transparent; }
      .row:last-child { border-bottom:0; }
      .icon { display:inline-flex; align-items:center; justify-content:center;
        width:28px; height:28px; color:var(--muted,#8b949e); }
      .icon svg { width:18px; height:18px; display:block; }
      .label { min-width:0; display:flex; flex-direction:column; gap:2px; }
      .name { font-weight:600; font-size:var(--text-sm,13px); color:var(--text,#e6edf3); }
      .desc { font-size:var(--text-xs,12px); color:var(--muted,#8b949e); line-height:1.35; }
      .lastrun { font-size:var(--text-xs,12px); color:var(--muted,#8b949e); }
      .run { justify-self:end; font-size:var(--text-xs,12px); color:var(--muted,#8b949e);
        border:1px solid var(--border,#30363d); border-radius:var(--radius-sm,6px);
        padding:4px 12px; background:transparent; cursor:pointer; font:inherit;
        white-space:nowrap; }
      .run:hover, .run:focus-visible { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); outline:none; }
      .meta { display:flex; align-items:center; gap:6px; }
    `, `<div part="row" class="row">
      <span class="icon" aria-hidden="true">${icon}</span>
      <span class="label"><span class="name">${escapeHtml(name)}</span>
        <span class="desc">${escapeHtml(description)}</span>${lastRun ? `<span class="lastrun">${escapeHtml(lastRun)}</span>` : ""}</span>
      <span class="meta">${actionHtml}</span>
    </div>`);
  }
  _wire() {
    const run = this._root.querySelector(".run");
    run?.addEventListener("click", () => this._emit("run"));
    this._root.querySelector("switch-toggle")?.addEventListener("toggle", (e) => {
      this._emit("toggle", { enabled: e.detail.checked });
    });
  }
};
customElements.define("capability-row", CapabilityRow);
var CodeBlock = class extends Component {
  static get observedAttributes() {
    return ["lang"];
  }
  _render() {
    const lang = this.getAttribute("lang") || "";
    const code = (this.textContent || "").replace(/\n$/, "");
    mountTemplate(this, `
      :host { display:block; margin:10px 0; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px); background:var(--panel-2,#efede8); overflow:hidden; }
      .head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 10px; background:var(--panel,#ffffff); border-bottom:1px solid var(--border,#e3e0d9); }
      .lang { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; letter-spacing:.02em; color:var(--muted,#635e56); }
      .copy { border:0; background:transparent; color:var(--muted,#635e56); font-size:11px; cursor:pointer; padding:2px 6px; border-radius:4px; }
      .copy:hover { background:var(--panel-2,#efede8); color:var(--text,#1d1b18); }
      .copy:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      pre { margin:0; padding:10px 12px; overflow-x:auto; }
      code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.5; white-space:pre; color:var(--text,#1d1b18); }
    `, `<div class="head"><span class="lang">${escapeHtml(lang) || "code"}</span><button type="button" class="copy">Copy</button></div><pre><code>${escapeHtml(code)}</code></pre>`);
  }
  _wire() {
    const btn = this._root.querySelector(".copy");
    btn?.addEventListener("click", async () => {
      const code = this.textContent || "";
      try {
        await navigator.clipboard?.writeText(code);
        btn.textContent = "Copied";
      } catch {
        const ta = document.createElement("textarea");
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          btn.textContent = "Copied";
        } catch {
          btn.textContent = "Copy";
        }
        ta.remove();
      }
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 1600);
    });
  }
};
customElements.define("code-block", CodeBlock);
var MessageBubble = class extends Component {
  static get observedAttributes() {
    return ["role", "content", "tool-name", "tool-status", "tool-args", "tool-result", "step", "total-steps"];
  }
  _content() {
    return this.hasAttribute("content") ? this.getAttribute("content") ?? "" : this.textContent ?? "";
  }
  _render() {
    const role = this.getAttribute("role") || "agent";
    const content = this._content();
    const style = `
      :host { display:flex; margin:0 0 14px; justify-content:flex-start; }
      :host(:last-child) { margin-bottom:0; }
      :host([role="user"]) { justify-content:flex-end; }
      .msg { max-width:78%; border-radius:12px; padding:10px 14px; overflow-wrap:anywhere; }
      .body { font-size:14px; line-height:1.55; color:var(--ink,#1d1b18); }
      :host([role="user"]) .msg { background:var(--secondary-layer,#efede8); }
      :host([role="agent"]) .msg, :host([role="system"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); }
      :host([role="error"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--danger,#b3261e); }
      :host([role="error"]) .body { color:var(--danger,#b3261e); }
      /* markdown content inside agent/system */
      .body p { margin:0 0 8px; }
      .body p:last-child { margin-bottom:0; }
      .body ul, .body ol { margin:0 0 8px; padding-left:20px; }
      .body li { margin:2px 0; }
      .body h1, .body h2, .body h3, .body h4 { margin:12px 0 6px; font-size:1.05em; font-weight:600; line-height:1.3; }
      .body h1:first-child, .body h2:first-child { margin-top:0; }
      .body a { color:var(--accent,#0e6e63); text-decoration:underline; text-underline-offset:2px; }
      .body code.inline-code, .body :not(pre) > code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.9em; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:4px; padding:1px 5px; }
      .body strong { font-weight:600; }
      .body em { font-style:italic; }
      /* rendered HTML output \u2014 the sandboxed iframe */
      .html-frame { margin-top:4px; }
      .html-frame iframe { width:100%; min-height:220px; max-height:480px; border:1px solid var(--border,#e3e0d9); border-radius:8px; background:#fff; resize:vertical; display:block; }
      /* thinking trace \u2014 collapsible, muted, clearly not a wall of text */
      .think { width:100%; }
      .think summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px; color:var(--muted,#635e56); font-size:13px; padding:2px 0; user-select:none; }
      .think summary::-webkit-details-marker { display:none; }
      .think summary:hover { color:var(--text,#1d1b18); }
      .think .spin { width:12px; height:12px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation:sc-think 1s linear infinite; flex:0 0 auto; }
      .think .caret { transition:transform .15s ease; flex:0 0 auto; }
      .think[open] .caret { transform:rotate(90deg); }
      .think .trace { margin-top:8px; padding:8px 12px; border-left:2px solid var(--border,#e3e0d9); color:var(--muted,#635e56); font-size:12.5px; white-space:pre-wrap; overflow-wrap:anywhere; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; line-height:1.5; }
      @keyframes sc-think { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .think .spin { animation: none; } .think .caret { transition: none; } }
      /* tool card */
      .tool { display:flex; flex-direction:column; width:100%; max-width:640px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); overflow:hidden; }
      .tool .tool-head { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--border,#e3e0d9); background:var(--panel-2,#efede8); }
      .tool .tool-name { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; font-weight:600; color:var(--ink,#1d1b18); }
      .tool .tool-status { margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:1px 8px; border-radius:999px; }
      .tool .tool-status::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
      .tool .tool-status.running { color:var(--muted,#635e56); background:var(--panel,#ffffff); }
      .tool .tool-status.done { color:var(--success,#1a7f37); background:var(--panel,#ffffff); }
      .tool .tool-status.error { color:var(--danger,#b3261e); background:var(--panel,#ffffff); }
      .tool .tool-args { padding:6px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; }
      .tool .tool-result { padding:6px 10px; font-size:12.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; border-top:1px solid var(--border,#e3e0d9); }
    `;
    let markup;
    if (role === "tool") {
      const name = this.getAttribute("tool-name") || "tool";
      const statusRaw = this.getAttribute("tool-status") || "running";
      const status = statusRaw === "success" ? "done" : statusRaw === "error" ? "error" : "running";
      const args = this.getAttribute("tool-args");
      const result = this.getAttribute("tool-result");
      markup = `<div class="tool" role="status">
        <div class="tool-head"><span class="tool-name">${escapeHtml(name)}</span><span class="tool-status ${status}">${status === "done" ? "done" : status === "error" ? "error" : "running"}</span></div>
        ${args != null ? `<div class="tool-args">${escapeHtml(args)}</div>` : ""}
        ${result != null ? `<div class="tool-result">${escapeHtml(result)}</div>` : ""}
      </div>`;
    } else if (role === "thinking") {
      const step = this.getAttribute("step");
      const total = this.getAttribute("total-steps");
      const hasTrace = content && !/^thinking\.\.\.$/i.test(content.trim()) && !/^thinking…$/i.test(content.trim());
      const label = step != null ? `thinking \xB7 step ${step}${total ? ` of ${total}` : ""}` : "thinking";
      if (!hasTrace) {
        markup = `<div class="think" role="status"><summary style="list-style:none;display:flex;align-items:center;gap:8px;color:var(--muted,#635e56);font-size:13px;padding:2px 0;"><span class="spin" aria-hidden="true"></span><span>${escapeHtml(label)}</span></summary></div>`;
      } else {
        markup = `<details class="think"><summary><svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg><span>${escapeHtml(label)}</span></summary><div class="trace">${escapeHtml(content)}</div></details>`;
      }
    } else {
      let body;
      if ((role === "agent" || role === "system") && isHtmlDocument(content)) {
        body = renderHtmlFrame(content);
      } else {
        body = role === "agent" || role === "system" || role === "user" ? renderMarkdown(content) : `<span class="plain">${renderInline(content)}</span>`;
      }
      markup = `<div class="msg ${role}"><div class="body">${body}</div></div>`;
    }
    mountTemplate(this, style, markup);
  }
};
customElements.define("message-bubble", MessageBubble);
var AgentConversation = class extends Component {
  static shadow() {
    return false;
  }
  static get observedAttributes() {
    return ["messages"];
  }
  _render() {
    ensureStyle("sc-agent-conversation-style", `
      agent-conversation { display:flex; flex-direction:column; min-height:0; }
      agent-conversation .empty { color:var(--muted,#635e56); font-size:var(--text-sm,13px); padding:2px 0; }
    `);
    const msgs = this.getAttribute("messages");
    if (msgs != null) this.setMessages(parseJSONAttr(msgs, []));
  }
  attributeChangedCallback(name, ov, nv) {
    if (name === "messages" && ov !== nv && this._rendered) {
      this.setMessages(parseJSONAttr(nv, []));
    }
  }
  _bubble(role, content, extra) {
    const b = document.createElement("message-bubble");
    b.setAttribute("role", role);
    if (content != null) b.setAttribute("content", String(content));
    if (extra) for (const [k, v] of Object.entries(extra)) {
      if (v == null) continue;
      if (v === "") b.setAttribute(k, "");
      else b.setAttribute(k, String(v));
    }
    this.appendChild(b);
    this.scrollTop = this.scrollHeight;
    return b;
  }
  appendUser(text) {
    return this._bubble("user", text);
  }
  appendAgent(text) {
    return this._bubble("agent", text);
  }
  appendSystem(text) {
    return this._bubble("system", text);
  }
  appendError(text) {
    return this._bubble("error", text);
  }
  appendThinking(text, { step, totalSteps } = {}) {
    return this._bubble("thinking", text, { step, "total-steps": totalSteps });
  }
  appendTool(m = {}) {
    const name = m.name ?? m["tool-name"];
    const status = m.status ?? m["tool-status"];
    const args = m.args ?? m["tool-args"];
    const result = m.result ?? m["tool-result"];
    return this._bubble("tool", null, {
      "tool-name": name,
      "tool-status": status || "running",
      "tool-args": args != null ? typeof args === "string" ? args : JSON.stringify(args) : null,
      "tool-result": result != null ? String(result) : null
    });
  }
  clear() {
    this.replaceChildren();
  }
  setMessages(messages) {
    this.replaceChildren();
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No conversation yet \u2014 start one above.";
      this.appendChild(p);
      return;
    }
    for (const m of list) {
      if (!m || typeof m !== "object") continue;
      switch (m.role) {
        case "user":
          this.appendUser(m.content);
          break;
        case "agent":
          this.appendAgent(m.content);
          break;
        case "system":
          this.appendSystem(m.content);
          break;
        case "thinking":
          this.appendThinking(m.content, m);
          break;
        case "tool":
          this.appendTool(m);
          break;
        case "error":
          this.appendError(m.content);
          break;
        default:
          this.appendAgent(m.content);
          break;
      }
    }
    this.scrollTop = this.scrollHeight;
  }
};
customElements.define("agent-conversation", AgentConversation);
var ScreenshotStrip = class extends Component {
  static get observedAttributes() {
    return ["shots"];
  }
  _render() {
    const shots = parseJSONAttr(this.getAttribute("shots"), []);
    const items = shots.map((s, i) => {
      const src = typeof s === "string" ? s : s?.url;
      const label = typeof s === "object" ? s?.label : "";
      return `<button type="button" class="shot" data-index="${i}" aria-label="Open screenshot ${i + 1}">
        <img src="${escapeHtml(src || "")}" alt="" loading="lazy">
        ${label ? `<span class="lbl">${escapeHtml(label)}</span>` : ""}</button>`;
    }).join("");
    mountTemplate(this, `
      :host { display:block; }
      .strip { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
      .shot { position:relative; flex:0 0 auto; width:96px; height:64px; border:1px solid var(--border,#e3e0d9); border-radius:8px; overflow:hidden; padding:0; cursor:pointer; background:var(--bg,#12121c); }
      .shot img { width:100%; height:100%; object-fit:cover; display:block; }
      .shot:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .lbl { position:absolute; inset:auto 0 0 0; font-size:9px; background:rgba(0,0,0,.6); color:#fff; padding:1px 3px; }
      .empty { font-size:12px; color:var(--muted,#635e56); }
    `, shots.length ? `<div class="strip">${items}</div>` : `<span class="empty">No screenshots yet.</span>`);
  }
  _wire() {
    this._root.querySelectorAll(".shot").forEach(
      (s) => s.addEventListener("click", () => this._emit("open", { index: Number(s.dataset.index) }))
    );
  }
};
customElements.define("screenshot-strip", ScreenshotStrip);
var AgentComposer = class extends Component {
  static shadow() {
    return false;
  }
  static get observedAttributes() {
    return ["placeholder", "label", "send-label"];
  }
  constructor() {
    super();
    this.attachments = [];
  }
  _render() {
    const placeholder = this.getAttribute("placeholder") || "Ask anything\u2026";
    const label = this.getAttribute("label") || "Message";
    const sendLabel = this.getAttribute("send-label") || "Run task";
    const html = `
      <div class="composer" part="composer">
        <textarea id="task-input" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(label)}" rows="2"></textarea>
        <div class="popup" id="popup" role="listbox" aria-label="Suggestions" hidden></div>
        <div class="chips" id="chips"></div>
        <div class="row">
          <mic-button id="mic"></mic-button>
          <attach-button id="attach"></attach-button>
          <span class="spacer"></span>
          <button id="run-task" class="btn send" type="button">${escapeHtml(sendLabel)}</button>
        </div>
      </div>
      <div class="composer-status" role="status" aria-live="polite"></div>`;
    mountTemplate(this, `
      :host { display:block; }
      .composer { position:relative; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px; padding:14px; anchor-name:--composer-anchor; }
      .composer:focus-within { border-color:var(--accent,#0e6e63); }
      .popup { position:absolute; inset:auto; margin:0; left:0; right:0; background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.08));
        max-height:260px; overflow-y:auto; padding:4px; z-index:40;
        position-anchor:--composer-anchor; position-area:bottom span-x-start span-x-end;
        position-try-fallbacks:flip-block; }
      @supports not (position-area: top) {
        .popup { position:absolute; top:calc(100% + 4px); left:0; right:0; }
      }
      .popup[hidden] { display:none; }
      .popup .item { display:flex; align-items:baseline; gap:10px; padding:7px 10px; border-radius:7px; cursor:pointer; }
      .popup .item:hover, .popup .item[data-active="true"] { background:var(--panel-2,#efede8); }
      .popup .item .lbl { font-weight:600; font-size:13px; color:var(--text,#1d1b18); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .popup .item .dsc { flex:1; text-align:right; font-size:11px; color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .popup .empty { padding:8px 10px; font-size:12px; color:var(--muted,#635e56); }
      .composer textarea { width:100%; background:transparent; border:0; color:var(--text,#1d1b18); font:inherit; resize:vertical; min-height:44px; outline:none; line-height:1.45; }
      .composer .row { display:flex; gap:8px; align-items:center; margin-top:8px; }
      .composer .spacer { flex:1; }
      .composer .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .composer .chips:empty { display:none; }
      .composer .chips .chip { display:inline-flex; align-items:center; gap:6px; font-size:12px;
        color:var(--text,#1d1b18); background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9);
        border-radius:999px; padding:3px 10px; }
      .composer .chips .chip button { border:0; background:transparent; color:var(--muted,#635e56);
        cursor:pointer; padding:0; font:inherit; line-height:1; }
      .composer .chips .chip button:hover { color:var(--text,#1d1b18); }
      .composer .send { display:inline-flex; align-items:center; height:var(--control,36px); padding:0 16px;
        background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); border:0; border-radius:8px;
        font:inherit; font-weight:600; cursor:pointer; }
      .composer .send:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .composer-status { margin-top:8px; font-size:12px; color:var(--muted,#635e56); }
      .composer-status:empty { display:none; }
    `, html);
    this._input = this._root.querySelector("#task-input");
    this._mic = this._root.querySelector("#mic");
    this._attach = this._root.querySelector("#attach");
    this._run = this._root.querySelector("#run-task");
    this._status = this._root.querySelector(".composer-status");
    this._popup = this._root.querySelector("#popup");
    this._chips = this._root.querySelector("#chips");
    this._popupItems = [];
    this._popupActive = -1;
    this._popupToken = null;
  }
  _wire() {
    this._run?.addEventListener("click", () => this._send());
    this._input?.addEventListener("input", () => this._onComposerInput());
    this._input?.addEventListener("keydown", (e) => {
      if (this._popupOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this._moveSelection(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this._moveSelection(-1);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          this._selectActive();
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          this._selectActive();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this._hidePopup();
          return;
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });
    this._mic?.addEventListener("transcript", (e) => {
      const { text, final: isFinal } = e.detail;
      this._input.value = text;
      if (isFinal) this._emit("transcript", { text });
    });
    this._attach?.addEventListener("attach", (e) => {
      const detail = e.detail ?? {};
      this.attachments.push(detail);
      this._addChip(detail);
      this._emit("attach", detail);
    });
    this._attach?.addEventListener("attach-media", (e) => this._captureMedia(e.detail?.kind));
    this._mic?.addEventListener("mic-error", (e) => this.setStatus(e.detail?.message || "mic error", false));
  }
  // ── media capture (record-audio / capture-camera) ──────────────────────
  // The wider-goal review found these menu items advertised but UNWIRED (the
  // attach-button emitted attach-media, the composer re-emitted it, and the
  // NTP/chat only listened for `send`/`status` — so clicking them silently did
  // nothing). Wire the real capture here: a short audio recording / a camera
  // frame becomes a dataURL attachment (the SW bounds it + sends it to the
  // model like any file).
  async _captureMedia(kind) {
    try {
      if (kind === "record-audio") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        try {
          const mime = MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : "";
          const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : void 0);
          const chunks = [];
          rec.ondataavailable = (ev) => {
            if (ev.data?.size) chunks.push(ev.data);
          };
          const stopped = new Promise((res) => {
            rec.onstop = () => res();
          });
          rec.start();
          this.setStatus("Recording audio\u2026 (auto-stops after 8s)");
          await new Promise((resolve) => setTimeout(resolve, 8e3));
          if (rec.state !== "inactive") rec.stop();
          await stopped;
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          const dataURL = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = () => rej(fr.error);
            fr.readAsDataURL(blob);
          });
          this._attachMedia({ name: "recording.webm", type: blob.type || "audio/webm", size: blob.size, dataURL, kind });
          this.setStatus("Audio attached.");
        } finally {
          stream.getTracks().forEach((t) => t.stop());
        }
        return;
      }
      if (kind === "capture-camera") {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        try {
          const video = document.createElement("video");
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await video.play();
          await new Promise((resolve) => setTimeout(resolve, 400));
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataURL = canvas.toDataURL("image/png");
          this._attachMedia({ name: "camera.png", type: "image/png", size: dataURL.length, dataURL, kind });
          this.setStatus("Photo attached.");
        } finally {
          stream.getTracks().forEach((t) => t.stop());
        }
        return;
      }
    } catch (e) {
      const msg = e?.name === "NotAllowedError" ? "media permission denied" : "media capture failed: " + (e?.message ?? e);
      this.setStatus(msg, false);
    }
  }
  _attachMedia(detail) {
    this.attachments.push(detail);
    this._addChip(detail);
    this._emit("attach", detail);
  }
  get input() {
    return this._input;
  }
  get value() {
    return this._input?.value ?? "";
  }
  set value(v) {
    if (this._input) this._input.value = v;
  }
  setStatus(text, ready = true) {
    if (this._status) this._status.textContent = text || "";
    this._emit("status", { text, ready });
  }
  setLoading(loading) {
    if (loading) this._run?.setAttribute("loading", "");
    else this._run?.removeAttribute("loading");
  }
  focus() {
    this._input?.focus();
  }
  // ── / command + @ mention popup ─────────────────────────────────────────
  get _popupOpen() {
    return !!(this._popup && !this._popup.hidden);
  }
  async _onComposerInput() {
    const input = this._input;
    if (!input) return;
    const text = input.value;
    const caret = input.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const slash = before.match(/(?:^|\s)\/([a-z]*)(?::([a-z0-9._ -]*))?$/i);
    if (slash) {
      const slashPos = text[slash.index] === "/" ? slash.index : slash.index + 1;
      const ns = (slash[1] || "").toLowerCase();
      const arg = (slash[2] || "").trim();
      if (!ns) {
        const items2 = COMMAND_NAMESPACES.map((n) => ({
          id: `cmd:${n.id}`,
          label: `/${n.label}`,
          description: n.description,
          kind: n.kind,
          ns: n.id
        }));
        this._showPopup(items2, { type: "command", start: slashPos, end: caret, ns: "", arg: "" });
        return;
      }
      const items = await commandItems(ns, arg);
      if (!items.length && ns === "remember") {
        this._showPopup(
          [{ id: "free:remember", label: "/remember ", description: "write to memory", kind: "free", ns: "remember", free: true }],
          { type: "command", start: slashPos, end: caret, ns, arg }
        );
        return;
      }
      this._showPopup(items.map((i) => ({ ...i, ns })), { type: "command", start: slashPos, end: caret, ns, arg });
      return;
    }
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const atPos = text[at.index] === "@" ? at.index : at.index + 1;
      const items = await mentionCandidates(at[1] || "");
      this._showPopup(items, { type: "mention", start: atPos, end: caret });
      return;
    }
    this._hidePopup();
  }
  _showPopup(items, token) {
    this._popupItems = items || [];
    this._popupToken = token || null;
    this._popupActive = this._popupItems.length ? 0 : -1;
    if (!this._popupItems.length) {
      this._hidePopup();
      return;
    }
    this._renderPopupItems();
    if (this._popup) {
      this._popup.hidden = false;
      if (!supportsAnchorPositioning()) {
        placeFloating(this._root.querySelector(".composer"), this._popup, { fullWidth: true });
      }
    }
  }
  _renderPopupItems() {
    if (!this._popup) return;
    const html = this._popupItems.map(
      (it, i) => `<div class="item" role="option" data-index="${i}" data-active="${i === this._popupActive}" aria-selected="${i === this._popupActive}">
        <span class="lbl">${escapeHtml(it.label)}</span>${it.description ? `<span class="dsc">${escapeHtml(it.description)}</span>` : ""}</div>`
    ).join("");
    this._popup.innerHTML = html;
    this._popup.querySelectorAll(".item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._select(Number(el.dataset.index));
      });
    });
  }
  _moveSelection(delta) {
    if (!this._popupItems.length) return;
    this._popupActive = (this._popupActive + delta + this._popupItems.length) % this._popupItems.length;
    this._renderPopupItems();
    this._popup.querySelector(`[data-index="${this._popupActive}"]`)?.scrollIntoView({ block: "nearest" });
  }
  _selectActive() {
    this._select(this._popupActive);
  }
  _select(index) {
    const item = this._popupItems[index];
    const token = this._popupToken;
    const input = this._input;
    if (!item || !token || !input) {
      this._hidePopup();
      return;
    }
    if (token.type === "command") {
      if (item.free) {
        input.setRangeText(`/${item.ns} `, token.start, token.end, "end");
        this._hidePopup();
        this._emit("command", { namespace: item.ns, item });
        input.focus();
        return;
      }
      if (!token.ns) {
        input.setRangeText(`/${item.ns}:`, token.start, token.end, "end");
        this._hidePopup();
        this._onComposerInput();
        input.focus();
        return;
      }
      input.setRangeText(item.id, token.start, token.end, "end");
      this._hidePopup();
      this._emit("command", { namespace: item.ns, item });
      input.focus();
      return;
    }
    input.setRangeText(item.id, token.start, token.end, "end");
    this._hidePopup();
    this._emit("mention", { item });
    input.focus();
  }
  _hidePopup() {
    if (this._popup) this._popup.hidden = true;
    this._popupItems = [];
    this._popupActive = -1;
    this._popupToken = null;
  }
  _addChip(detail) {
    if (!this._chips) return;
    const name = detail?.name || "attachment";
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove ${name}`);
    rm.textContent = "\u2715";
    rm.addEventListener("click", () => {
      const idx = this.attachments.indexOf(detail);
      if (idx >= 0) this.attachments.splice(idx, 1);
      chip.remove();
    });
    chip.append(label, rm);
    this._chips.append(chip);
  }
  _clearChips() {
    if (this._chips) this._chips.replaceChildren();
  }
  _send() {
    const text = this._input?.value.trim();
    if (!text) return;
    if (this._input) this._input.value = "";
    const pending = this.attachments.splice(0);
    this._clearChips();
    this._emit("send", { text, attachments: pending });
  }
};
customElements.define("agent-composer", AgentComposer);
var AgentDialog = class extends Component {
  static get observedAttributes() {
    return ["title"];
  }
  constructor() {
    super();
    this._open = false;
  }
  _render() {
    const title = this.getAttribute("title") || "";
    mountTemplate(this, `
      :host { display:contents; }
      .dialog { background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:14px; padding:20px; min-width:320px; max-width:90vw; max-height:85vh; overflow:auto; box-shadow:0 20px 60px rgba(0,0,0,.4); color:var(--text,#1d1b18); }
      .dialog::backdrop { background:rgba(0,0,0,.5); }
      .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .title { font-weight:700; font-size:16px; }
      .x { background:transparent; border:0; color:var(--text,#1d1b18); cursor:pointer; padding:4px; }
      .x:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .body { color:var(--text,#1d1b18); }
    `, `<dialog part="dialog" class="dialog" aria-label="${escapeHtml(title)}">
        <div class="head"><span class="title">${escapeHtml(title)}</span>
          <button type="button" class="x" aria-label="Close">${ICONS.close}</button></div>
        <div class="body"><slot></slot></div>
      </dialog>`);
    this._dialog = this._root.querySelector(".dialog");
  }
  _wire() {
    this._root.querySelector(".x")?.addEventListener("click", () => this.close());
    this._dialog?.addEventListener("click", (e) => {
      if (e.target === this._dialog) this.close();
    });
    this._dialog?.addEventListener("close", () => {
      if (this._open) {
        this._open = false;
        this._emit("close");
      }
    });
  }
  get open() {
    return this._dialog?.open ?? false;
  }
  show() {
    if (!this._dialog || this._dialog.open) return;
    this._open = true;
    this._dialog.showModal();
    this._emit("open");
  }
  // (the open() method was removed — it duplicated the get open() getter; use show())
  close() {
    this._dialog?.close();
  }
};
customElements.define("agent-dialog", AgentDialog);
var AgentPicker = class extends Component {
  static get observedAttributes() {
    return ["agents", "selected"];
  }
  _render() {
    const agents = parseJSONAttr(this.getAttribute("agents"), []);
    const selected = this.getAttribute("selected") || "";
    const items = agents.map((a) => {
      const origin = a.origin || a.id || "";
      const short = origin.replace(/^https?:\/\//, "").replace(/\/.*/, "");
      return `<button type="button" class="agent" data-origin="${escapeHtml(origin)}"
        aria-pressed="${origin === selected}">
        <span class="badge" aria-hidden="true">@</span>
        <span class="who"><span class="name">@${escapeHtml(short)}</span>
        <span class="tools">${a.tools?.length ?? 0} tools</span></span></button>`;
    }).join("");
    mountTemplate(this, `
      :host { display:block; }
      .list { display:flex; flex-direction:column; gap:8px; }
      .agent { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); cursor:pointer; font:inherit; color:var(--text,#1d1b18); text-align:left; }
      .agent[aria-pressed="true"] { border-color:var(--accent,#0e6e63); }
      .agent:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .badge { width:28px; height:28px; border-radius:7px; background:var(--accent,#0e6e63); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
      .name { font-weight:600; }
      .tools { display:block; font-size:12px; color:var(--muted,#635e56); }
      .empty { color:var(--muted,#635e56); font-size:13px; }
    `, agents.length ? `<div class="list">${items}</div>` : `<span class="empty">No agents.</span>`);
  }
  _wire() {
    this._root.querySelectorAll(".agent").forEach(
      (b) => b.addEventListener("click", () => this._emit("select", { origin: b.dataset.origin }))
    );
  }
};
customElements.define("agent-picker", AgentPicker);
var AgentConfigForm = class extends Component {
  static get observedAttributes() {
    return ["agent"];
  }
  _render() {
    const agent = parseJSONAttr(this.getAttribute("agent"), {});
    const name = agent.name || "";
    const instructions = agent.instructions || "";
    const skills = (agent.skills || []).join(", ");
    mountTemplate(this, `
      :host { display:block; }
      .form { display:flex; flex-direction:column; gap:12px; }
      label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted,#635e56); }
      input, textarea { background:var(--bg,#12121c); border:1px solid var(--border,#e3e0d9); color:var(--text,#1d1b18); border-radius:7px; padding:8px 10px; font:inherit; }
      input:focus-visible, textarea:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      .save { align-self:flex-start; border:0; border-radius:8px; padding:8px 16px; background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); cursor:pointer; font:inherit; font-weight:600; }
      .save:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
    `, `<div class="form">
      <label>Name<input id="f-name" value="${escapeHtml(name)}"></label>
      <label>Instructions<textarea id="f-instr" rows="4">${escapeHtml(instructions)}</textarea></label>
      <label>Skills (comma-separated)<input id="f-skills" value="${escapeHtml(skills)}"></label>
      <button type="button" class="save">Save agent</button>
    </div>`);
  }
  _wire() {
    this._root.querySelector(".save")?.addEventListener("click", () => {
      this._emit("save", {
        name: this._root.querySelector("#f-name").value,
        instructions: this._root.querySelector("#f-instr").value,
        skills: this._root.querySelector("#f-skills").value.split(",").map((s) => s.trim()).filter(Boolean)
      });
    });
  }
};
customElements.define("agent-config-form", AgentConfigForm);
var VIEWS = [
  { id: "hub", label: "Hub" },
  { id: "chat", label: "Chat" },
  { id: "directory", label: "Directory" },
  { id: "settings", label: "Settings" }
];
var AgentNav = class extends Component {
  static get observedAttributes() {
    return ["active"];
  }
  _render() {
    const active = this.getAttribute("active") || "hub";
    const tabs = VIEWS.map(
      (v) => `<button type="button" class="tab" data-view="${v.id}" role="tab"
        aria-selected="${v.id === active}">${escapeHtml(v.label)}</button>`
    ).join("");
    mountTemplate(this, `
      :host { display:inline-flex; gap:4px; border:1px solid var(--border,#e3e0d9); border-radius:10px; padding:4px; background:var(--panel,#ffffff); }
      .tab { border:0; background:transparent; color:var(--text,#1d1b18); border-radius:7px; padding:7px 14px; cursor:pointer; font:inherit; }
      .tab[aria-selected="true"] { background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); }
      .tab:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
    `, tabs);
  }
  _wire() {
    this._root.querySelectorAll(".tab").forEach(
      (t) => t.addEventListener("click", () => this._emit("navigate", { view: t.dataset.view }))
    );
  }
};
customElements.define("agent-nav", AgentNav);
function backend(type, payload = {}) {
  return RUNTIME_SEND ? RUNTIME_SEND(type, payload) : Promise.resolve({});
}
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  } catch {
    return "";
  }
}
var PanelButton = class extends Component {
  static get observedAttributes() {
    return ["count", "label", "attention"];
  }
  constructor() {
    super();
    this._open = false;
  }
  attributeChangedCallback(name, oldV, newV) {
    if (this._rendered && oldV !== newV) {
      this._render();
      this._wire();
      if (this._open) this._refreshPanel();
    }
  }
  _render() {
    const count = Number(this.getAttribute("count") || 0);
    const label = this.getAttribute("label") || "";
    const attention = this.hasAttribute("attention");
    const badge = count > 0 ? `<span class="badge" aria-hidden="true">${count > 99 ? "99+" : count}</span>` : "";
    mountTemplate(this, `
      :host { display:inline-flex; position:relative; }
      .trigger { position:relative; display:inline-flex; align-items:center; justify-content:center;
        width:36px; height:36px; border:1px solid var(--border,#e3e0d9); border-radius:8px;
        background:transparent; color:var(--muted,#635e56); cursor:pointer; padding:0; }
      .trigger:hover { color:var(--text,#1d1b18); border-color:var(--accent,#0e6e63); }
      .trigger[data-attention="true"] { color:${attention ? "var(--warning,#9a6700)" : "var(--muted,#635e56)"}; border-color:${attention ? "var(--warning,#9a6700)" : "var(--border,#e3e0d9)"}; }
      .trigger:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .badge { position:absolute; top:-6px; right:-6px; min-width:17px; height:17px; padding:0 4px;
        border-radius:999px; background:var(--danger,#b3261e); color:#fff; font-size:10px; font-weight:700;
        display:inline-flex; align-items:center; justify-content:center; line-height:1; }
      .panel { position:fixed; z-index:200; width:min(560px, calc(100vw - 24px));
        background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px;
        box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.08)); overflow:hidden; }
      .panel[hidden] { display:none; }
      .phead { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      .phead .t { font-weight:600; font-size:13px; margin:0; flex:1; }
      .phead button { display:inline-flex; align-items:center; gap:4px; background:transparent; border:0;
        color:var(--muted,#635e56); cursor:pointer; font-size:12px; padding:4px 6px; border-radius:6px; }
      .phead button:hover { background:var(--panel-2,#efede8); color:var(--text,#1d1b18); }
      .pbody { max-height:340px; overflow:auto; }
      .console { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; padding:4px 0; }
      .console .empty, .shield-body .empty { padding:16px 14px; color:var(--muted,#635e56); font-size:12px; }
      .console .line { display:flex; gap:8px; padding:3px 14px; align-items:baseline; border-left:2px solid transparent; }
      .console .line:hover { background:var(--panel-2,#efede8); }
      .console .ts { flex:0 0 auto; color:var(--muted,#635e56); }
      .console .lv { flex:0 0 auto; width:44px; text-transform:uppercase; font-size:10px; font-weight:700; letter-spacing:.04em; }
      .console .lvl-error { border-left-color:var(--danger,#b3261e); } .console .lvl-error .lv { color:var(--danger,#b3261e); }
      .console .lvl-error .msg { color:var(--danger,#b3261e); }
      .console .lvl-warn { border-left-color:var(--warning,#9a6700); } .console .lvl-warn .lv { color:var(--warning,#9a6700); }
      .console .src { flex:0 0 auto; color:var(--muted,#635e56); font-size:10px; opacity:.8; }
      .console .msg { flex:1; word-break:break-word; white-space:pre-wrap; }
      .console .line-copy { flex:0 0 auto; border:0; background:transparent; color:var(--muted,#635e56); cursor:pointer; font-size:11px; padding:0 4px; border-radius:4px; opacity:0; }
      .console .line:hover .line-copy, .console .line-copy:focus-visible { opacity:1; }
      .console .line-copy:hover { color:var(--text,#1d1b18); background:var(--panel-2,#efede8); }
      .shield-body .sect { padding:12px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      .shield-body .sect:last-child { border-bottom:0; }
      .shield-body .sect-h { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted,#635e56); margin-bottom:8px; }
      .shield-body .chips { display:flex; flex-wrap:wrap; gap:6px; }
      .shield-body .chip { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--border,#e3e0d9); }
      .shield-body .chip.ok { background:var(--on-accent-muted,#d7f0ea); border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .shield-body .chip.muted { color:var(--muted,#635e56); }
      .shield-body .viol { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
      .shield-body .viol li { display:flex; gap:8px; align-items:baseline; font-size:12px; }
      .shield-body .vkind { flex:0 0 auto; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--warning,#9a6700); }
      .shield-body .vmsg { flex:1; word-break:break-word; }
      .shield-body .vts { flex:0 0 auto; color:var(--muted,#635e56); }
      @media (prefers-reduced-motion: reduce) { .panel { transition:none; } }
    `, `
      <button class="trigger" type="button" aria-label="${escapeHtml(label)}" data-attention="${attention}" aria-expanded="${this._open}">${this.triggerIcon}${badge}</button>
      <div class="panel" role="dialog" aria-label="${escapeHtml(label)}" hidden>${this._panelMarkup()}</div>
    `);
  }
  _wire() {
    this._trigger = this._root.querySelector(".trigger");
    this._panel = this._root.querySelector(".panel");
    this._trigger?.addEventListener("click", () => this._toggle());
    this._panel?.querySelector("[data-close]")?.addEventListener("click", () => this._close());
    this._panel?.querySelector("[data-clear]")?.addEventListener("click", () => this._clear());
    this._panel?.querySelector("[data-copy-all]")?.addEventListener("click", () => this._copyAll());
    this._bindDocument("keydown", (e) => {
      if (e.key === "Escape") this._close();
    });
    this._bindDocument("pointerdown", (e) => {
      if (this._open && !this.contains(e.composedPath()[0])) this._close();
    });
  }
  _toggle() {
    this._open ? this._close() : this._openPanel();
  }
  async _openPanel() {
    this._open = true;
    this._panel.hidden = false;
    this._position();
    this._trigger?.setAttribute("aria-expanded", "true");
    await this._refreshPanel();
  }
  _close() {
    this._open = false;
    this._panel.hidden = true;
    this._trigger?.setAttribute("aria-expanded", "false");
  }
  _position() {
    const r = this._trigger?.getBoundingClientRect?.();
    if (!r) return;
    const panel = this._panel;
    panel.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 360)}px`;
    const w = panel.offsetWidth || 560;
    panel.style.left = `${Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))}px`;
  }
  // Subclasses:
  get triggerIcon() {
    return "";
  }
  _panelMarkup() {
    return "";
  }
  async _refreshPanel() {
  }
  async _clear() {
  }
  async _copyAll() {
  }
  /** Copy text to the clipboard with a fallback (headless/file:// safe). */
  async _writeClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      ta.remove();
      return ok === true;
    } catch {
      return false;
    }
  }
};
var ErrorConsole = class extends PanelButton {
  get triggerIcon() {
    return ICONS.terminal;
  }
  _panelMarkup() {
    return `
      <div class="phead">
        <span class="t">Console</span>
        <button type="button" data-copy-all>Copy all</button>
        <button type="button" data-clear>Clear</button>
        <button type="button" data-close aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="pbody console" role="log" aria-live="polite"></div>`;
  }
  async _refreshPanel() {
    const body = this._panel.querySelector(".console");
    if (!body) return;
    const res = await backend("diagnostics.list");
    const entries = res.entries || [];
    this._entries = entries;
    if (!entries.length) {
      body.innerHTML = `<div class="empty">No errors captured. The console shows extension errors, warnings, and unhandled rejections as they happen.</div>`;
      return;
    }
    const rank = { error: 0, warn: 1, info: 2 };
    const ordered = entries.slice().sort((a, b) => {
      const ra = rank[a.level] ?? 3;
      const rb = rank[b.level] ?? 3;
      return ra !== rb ? ra - rb : b.ts - a.ts;
    });
    body.innerHTML = ordered.map(
      (e) => `<div class="line lvl-${escapeHtml(e.level)}"><span class="ts">${escapeHtml(fmtTime(e.ts))}</span><span class="lv">${escapeHtml(e.level)}</span><span class="msg">${escapeHtml(e.message)}</span>` + (e.source ? `<span class="src">${escapeHtml(e.source)}</span>` : "") + `<button type="button" class="line-copy" data-copy aria-label="Copy this line">Copy</button></div>`
    ).join("");
    body.scrollTop = 0;
    body.onclick = async (ev) => {
      const btn = ev.target.closest?.("[data-copy]");
      if (!btn) return;
      const line = btn.closest(".line");
      const msg = line?.querySelector(".msg")?.textContent || "";
      const lv = line?.querySelector(".lv")?.textContent || "";
      if (await this._writeClipboard(msg)) {
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1400);
      }
    };
  }
  async _clear() {
    await backend("diagnostics.clear");
    this.setAttribute("count", "0");
    this._entries = [];
    await this._refreshPanel();
    this._emit("cleared");
  }
  async _copyAll() {
    const entries = this._entries || [];
    const text = entries.map(
      (e) => `[${fmtTime(e.ts)}] ${e.level}${e.source ? ` (${e.source})` : ""}: ${e.message}`
    ).join("\n");
    const btn = this._panel?.querySelector("[data-copy-all]");
    if (await this._writeClipboard(text || "")) {
      if (btn) {
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy all";
        }, 1400);
      }
    }
  }
};
customElements.define("error-console", ErrorConsole);
var SecurityShield = class extends PanelButton {
  get triggerIcon() {
    return ICONS.shield;
  }
  _panelMarkup() {
    return `
      <div class="phead">
        <span class="t">Security</span>
        <button type="button" data-clear>Clear</button>
        <button type="button" data-close aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="pbody shield-body"></div>`;
  }
  async _refreshPanel() {
    const body = this._panel.querySelector(".shield-body");
    if (!body) return;
    const res = await backend("security.state");
    const granted = res.granted || [];
    const violations = res.violations || [];
    const permRows = granted.length ? granted.map((p) => `<span class="chip ok" title="granted">${escapeHtml(p)}</span>`).join("") : `<span class="chip muted">none \u2014 running with zero permissions</span>`;
    const viol = violations.length ? `<ul class="viol">${violations.map(
      (v) => `<li><span class="vkind">${escapeHtml(v.kind)}</span><span class="vmsg">${escapeHtml(v.message)}</span><span class="vts">${escapeHtml(fmtTime(v.ts))}</span></li>`
    ).join("")}</ul>` : `<div class="empty">No security violations. Content-Security-Policy violations, denied hooks, blocked actions, and cross-origin attempts would appear here.</div>`;
    body.innerHTML = `
      <div class="sect"><div class="sect-h">Granted permissions</div><div class="chips">${permRows}</div></div>
      <div class="sect"><div class="sect-h">Security events</div>${viol}</div>`;
  }
  async _clear() {
    await backend("security.clear");
    this.setAttribute("count", "0");
    this.removeAttribute("attention");
    await this._refreshPanel();
    this._emit("cleared");
  }
};
customElements.define("security-shield", SecurityShield);

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
var THEMES2 = [
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
        <div class="provider-actions">
          <button class="btn small set-default" type="button" aria-label="${cfg.provider === p.id ? `Update ${p.name}` : `Use ${p.name}`}">${cfg.provider === p.id ? "Update" : "Use"}</button>
          <button class="btn small ghost test-connection" type="button" aria-label="Test connection for ${p.name}">Test connection</button>
        </div>
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
      <div class="test-status" role="status" hidden></div>
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
    card.querySelector(".test-connection")?.addEventListener("click", async () => {
      const testBtn = card.querySelector(".test-connection");
      const testStatus = card.querySelector(".test-status");
      const isActive = cfg.provider === p.id;
      const keyInput = card.querySelector(".api-key");
      const enteredKey = keyInput?.value ?? "";
      const fields = {
        baseURL: card.querySelector(".base-url")?.value ?? (isActive ? cfg.baseURL || p.baseURL : p.baseURL),
        apiKey: enteredKey || (isActive && cfg.apiKey ? cfg.apiKey : ""),
        model: card.querySelector(".model")?.value ?? (isActive ? cfg.model || "" : "")
      };
      testStatus.hidden = false;
      testStatus.className = "test-status testing";
      testStatus.textContent = "Testing\u2026";
      testBtn.disabled = true;
      const res = await testProvider(p, fields);
      testBtn.disabled = false;
      testStatus.className = "test-status " + (res.ok ? "ok" : "err");
      testStatus.textContent = res.ok ? `Connected \u2014 ${res.detail ?? "ok"} (${res.latencyMs}ms)` : `Failed \u2014 ${res.error ?? "unknown error"}`;
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
  const toggle = $("#multi-agent");
  const on = s["cap:multiAgent"] !== false;
  toggle.checked = on;
  toggle.addEventListener("toggle", async (e) => {
    const checked = e.detail.checked;
    await storage.set({ "cap:multiAgent": checked });
    $("#per-agent-provider").hidden = !checked;
    try {
      await chrome.runtime.sendMessage({ type: "invalidate-agent" });
    } catch {
    }
    saveFlash("Agent mode saved.");
  });
  $("#per-agent-provider").hidden = !on;
  $("#agent-provider-list").replaceChildren();
}
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
  hint.textContent = (a.description || "") + (a.schedule?.periodInMinutes ? ` \xB7 runs every ${a.schedule.periodInMinutes} min` : "");
  const toggle = document.createElement("switch-toggle");
  toggle.setAttribute("label", `${a.enabled ? "Disable" : "Enable"} ${a.name}`);
  toggle.checked = Boolean(a.enabled);
  toggle.addEventListener("toggle", async (e) => {
    const enabled = e.detail.checked;
    const out = await chrome.runtime.sendMessage({ type: "background-agent.set", id: a.id, enabled }).catch((e2) => ({ ok: false, error: String(e2?.message ?? e2) }));
    saveFlash(
      out?.ok ? `${a.name} ${enabled ? "enabled." : "disabled."}` : `Could not update ${a.name}: ${out?.error ?? "failed"}.`
    );
    renderBackgroundAgents();
  });
  row.append(name, state, hint, toggle);
  return row;
}
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
  chevron.textContent = "\u25BE";
  button.append(selectedcontent, chevron);
  select.append(button);
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Add a background agent\u2026";
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
    const out = await chrome.runtime.sendMessage({ type: "background-agent.set", id, enabled: true }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    saveFlash(
      out?.ok ? `${agent?.name ?? id} enabled.` : `Could not enable ${agent?.name ?? id}: ${out?.error ?? "failed"}.`
    );
    select.value = "";
    onChange();
  });
  wrap.append(label, select);
  return wrap;
}
async function renderBackgroundAgents() {
  const res = await chrome.runtime.sendMessage({ type: "background-agent.list" }).catch(() => ({ agents: [] }));
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
async function renderAppearance(restoreFocus = false) {
  const s = await storage.get("cap:theme");
  const current = s["cap:theme"] ?? "sunlit";
  const grid = $("#theme-grid");
  grid.innerHTML = "";
  for (const t of THEMES2) {
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
  const toggle = $("#browser-grant");
  toggle.checked = granted;
  $("#grant-origins").hidden = !granted;
  if (grant?.origins?.length) {
    $("#grant-origin-list").value = grant.origins.join("\n");
  }
  toggle.addEventListener("toggle", async (e) => {
    const checked = e.detail.checked;
    if (checked) {
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
    row.className = "perm-row";
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
      h.subscribers?.length ? `subscribed: ${h.subscribers.join(", ")}` : h.permission ? `needs "${h.permission}"` : "no extra permission"
    ].join(" \xB7 ");
    row.append(name, state, hint);
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
await renderBackgroundAgents();
await renderEnroll();
await renderAppearance();
await renderBrowser();
await renderPermissions();
await renderHooks();
await renderUsage();
await renderData();

// background/service-worker.js — the extension's message router + agent core.
// Bundled with esbuild (the AI SDK + zod need bundling). This is the single
// place the agent loop runs; UI pages talk to it via chrome.runtime messages.

import { getModel, getProviderConfig, setProviderConfig, PROVIDER_CHOICES } from "../lib/provider.js";
import { masterMemory, siteMemory, listOrigins, journalAppend, canonicalOrigin } from "../lib/memory.js";
import { createOrchestrator, createAgent } from "../lib/agent.js";
import { recordUsage, getUsage, clearUsage } from "../lib/usage.js";
import { upsertTools, listTools, enrollOrigin, isApproved, approveTool, pendingApprovals } from "../lib/tools.js";
import { setSkills, getSkills, allSkills } from "../lib/skills.js";
import { browserToolset, recordBrowserEvent, setBrowserControlGrant, isBrowserControlGranted } from "../lib/browser-tools.js";
import { RECIPES, getRecipe } from "../lib/recipes.js";
import { tool } from "ai";
import { z } from "zod";
import { schemaToZod as buildSchema, sanitizeToolName as safeToolName, authorizeToolReport, PAGE_ALLOWED_ROUTES } from "../lib/pure.js";

// ---- alarm scheduler (persists the full task payload) ----
const TASK_KEY = "cap:scheduledTasks";

async function registerAlarm(task) {
  const name = task.name ?? task.id ?? String(Date.now());
  // Persist the full task payload (not just the name) so the alarm can resume it.
  const store = await chrome.storage.local.get(TASK_KEY);
  const tasks = store[TASK_KEY] ?? {};
  tasks[name] = { ...task, name };
  await chrome.storage.local.set({ [TASK_KEY]: tasks });

  // Timing: task.at is an ABSOLUTE epoch-ms; task.delayMs is a RELATIVE delay.
  // (Chrome's alarm `when` is absolute — never add a relative value to Date.now()
  // blindly, and never treat an absolute timestamp as a delay.)
  let when;
  if (typeof task.at === "number" && task.at > Date.now()) {
    when = task.at;
  } else if (typeof task.delayMs === "number" && task.delayMs > 0) {
    when = Date.now() + task.delayMs;
  } else {
    throw new Error("task needs a future `at` (absolute ms) or a positive `delayMs`");
  }
  const info = { when };
  if (task.periodInMinutes) info.periodInMinutes = task.periodInMinutes;
  chrome.alarms.create(name, info);
  return name;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const store = await chrome.storage.local.get(TASK_KEY);
  const task = store[TASK_KEY]?.[alarm.name];
  if (!task) {
    console.error("scheduled task payload missing", alarm.name);
    return;
  }
  // One-shot (non-periodic) tasks are removed once fired; periodic tasks stay.
  if (!task.periodInMinutes) {
    const remaining = { ...(store[TASK_KEY] ?? {}) };
    delete remaining[alarm.name];
    await chrome.storage.local.set({ [TASK_KEY]: remaining });
    chrome.alarms.clear(alarm.name).catch(() => {});
  }
  runTask({ id: alarm.name, task: task.task ?? alarm.name, scheduled: true, attachments: task.attachments ?? [] })
    .catch((e) => console.error("scheduled task failed", alarm.name, e));
});

// ---- lazy agent bootstrap (invalidated on provider change) ----
let orchestrator = null;
const MODEL_CACHE = { model: null };

function invalidateAgent() {
  MODEL_CACHE.model = null;
  orchestrator = null;
}

async function ensureModel() {
  if (!MODEL_CACHE.model) MODEL_CACHE.model = await getModel();
  return MODEL_CACHE.model;
}

async function ensureOrchestrator() {
  if (orchestrator) return orchestrator;
  const model = await ensureModel();
  const mem = masterMemory();
  // Workers = enrolled site origins, each with its own memory + skills.
  const origins = (await listOrigins());
  const workers = await Promise.all(origins.map(async (origin) => ({
    origin,
    memory: siteMemory(origin),
    skills: await getSkills(origin),
    tools: await siteToolset(origin),
  })));
  orchestrator = await createOrchestrator({
    model,
    masterMemory: mem,
    workers,
    extraTools: browserToolset(),
  });
  return orchestrator;
}


// Per-site toolset: the site's declared/inferred tools become valid AI-SDK tools.
async function siteToolset(origin) {
  const tools = await listTools(origin);
  const set = {};
  for (const t of tools) {
    // A valid AI-SDK tool needs an inputSchema. The JSON-schema descriptor is
    // converted by schemaToZod (fail-closed: unsupported → z.never()), and the
    // invocation is approval-gated + origin-bound. The content script does NOT
    // validate arguments — this boundary enforces the schema.
    set[safeToolName(origin, t.name)] = tool({
      description: `${t.name} on ${origin} — ${t.description ?? ""}`,
      inputSchema: buildSchema(z, t.inputSchema),
      execute: async (args) => {
        if (!(await isApproved(origin, t.name))) {
          return { error: `tool ${t.name} on ${origin} not approved` };
        }
        return await invokeSiteTool(origin, t.name, args);
      },
    });
  }
  return set;
}

// Drive a page function on an origin via the content script (WebMCP/injection).
async function invokeSiteTool(origin, name, args) {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => {
    try { return t.url ? new URL(t.url).origin === origin : false; } catch { return false; }
  });
  if (!tab?.id) return { error: `no tab open for ${origin}` };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "invoke-tool", name, args });
    return res ?? { ok: true };
  } catch (e) {
    return { error: `invoke failed: ${e.message}` };
  }
}

/** Build a bounded, honest context string from attachments (never an object). */
function attachmentContext(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const parts = [];
  for (const a of attachments) {
    parts.push(
      `[attachment: ${a.name ?? "unnamed"} (${a.kind ?? "file"}, ${a.type ?? "unknown"}, ${a.size ?? "?"} bytes)]`,
    );
    // Text attachments are inlined so the model can read them. Media (image/
    // audio/video) bytes are NOT supplied to the model in this build — they are
    // honestly labelled as attached-but-unprocessed until a multimodal provider
    // path is wired. Never claim the bytes reach the model.
    if (a.dataURL && a.type?.startsWith("text/")) {
      try {
        const body = atob(a.dataURL.split(",")[1] ?? "");
        parts.push("--- text content ---\n" + body.slice(0, 4000) + "\n---");
      } catch { /* not decodable */ }
    } else if (!a.type?.startsWith("text/")) {
      parts.push("  (media attached — not transcribed/described in this build)");
    }
  }
  return "Attachments:\n" + parts.join("\n");
}

async function runTask({ id, task, scheduled = false, attachments = [] }) {
  const orch = await ensureOrchestrator();
  const taskId = id ?? String(Date.now());
  const mem = masterMemory();
  await journalAppend(mem, { type: "task", id: taskId, task, scheduled, attachmentCount: attachments?.length ?? 0 });
  const context = attachmentContext(attachments);
  // agent-do's run(task, context, history) -> result text; context is a STRING.
  const result = await orch.run(task, context, []);
  await journalAppend(mem, { type: "result", id: taskId, result });
  if (scheduled) {
    // Completion lifecycle: surface the result as a notification. Await + handle
    // failure; the icon is an inline data-URI (no external icon file to go missing).
    try {
      await chrome.notifications.create(`cap:${taskId}`, {
        type: "basic",
        iconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='4' fill='%2378b3ff'/%3E%3C/svg%3E",
        title: "Scheduled task complete",
        message: String(result ?? "").slice(0, 160),
      });
    } catch (e) { console.error("notification failed", e); }
  }
  return { ok: true, result };
}

// ---- message router ----
const handlers = {
  async "provider.get"() { return await getProviderConfig(); },
  async "provider.set"(m) {
    const next = await setProviderConfig(m.config);
    // The running agent must switch immediately — invalidate the cached model + orchestrator.
    invalidateAgent();
    return next;
  },
  async "provider.models"() { return { choices: PROVIDER_CHOICES }; },

  async "agent.run"(m) {
    // Bound the attachment payload: measure the ACTUAL dataURL bytes (never trust
    // a client-claimed size), enforce per-item AND aggregate limits + a count cap,
    // and drop (not silently truncate) anything over budget.
    const MAX_ITEM_BYTES = 8 * 1024 * 1024; // 8 MiB per attachment
    const MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MiB aggregate
    const MAX_COUNT = 8;
    const measured = (a) => {
      if (!a?.dataURL) return 0;
      const comma = a.dataURL.indexOf(",");
      if (comma < 0) return 0;
      return Math.ceil((a.dataURL.length - comma - 1) * 0.75);
    };
    let total = 0;
    const bounded = [];
    for (const a of (m.attachments ?? []).slice(0, MAX_COUNT * 4)) {
      const bytes = measured(a);
      if (bytes > MAX_ITEM_BYTES) continue;
      if (total + bytes > MAX_TOTAL_BYTES) continue;
      bounded.push(a);
      total += bytes;
    }
    return await runTask({ id: m.id, task: m.task, attachments: bounded });
  },
  async "agent.list"() { return await listOrigins(); },

  async "tools.list"({ origin }) { return await listTools(origin); },
  async "tools.upsert"({ origin, tools }) {
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    await enrollOrigin(canonical);
    await upsertTools(canonical, tools);
    // New tools/sites must reach the running orchestrator — rebuild it.
    invalidateAgent();
    return { ok: true };
  },
  async "tools.approve"({ origin, name, decision }) { return await approveTool(origin, name, decision); },
  async "tools.pending"({ origin }) { return await pendingApprovals(origin); },
  async "tools.allOrigins"() { return await listOrigins(); },

  async "skills.set"({ origin, skills }) { return await setSkills(origin, skills); },
  async "skills.get"({ origin }) { return await getSkills(origin); },
  async "skills.all"() { return await allSkills(); },

  async "memory.get"({ origin, key }) { return await (origin === "master" ? masterMemory() : siteMemory(origin)).get(key); },
  async "memory.set"({ origin, key, value }) { return await (origin === "master" ? masterMemory() : siteMemory(origin)).set(key, value); },
  async "memory.list"({ origin }) { return await (origin === "master" ? masterMemory() : siteMemory(origin)).keys(); },
  async "memory.clear"({ origin }) { return await (origin === "master" ? masterMemory() : siteMemory(origin)).clear(); },
  async "memory.origins"() { return await listOrigins(); },

  async "usage.get"() { return await getUsage(); },
  async "usage.clear"() { await clearUsage(); return { ok: true }; },

  async "register-task"(m) { const name = await registerAlarm(m.task); return { ok: true, name }; },
  async "run-task"(m) { return await runTask({ id: m.id, task: m.task }); },

  async "recipe.list"() { return { recipes: RECIPES }; },
  async "recipe.run"(m) {
    const recipe = getRecipe(m.id);
    if (!recipe) return { ok: false, error: `no recipe ${m.id}` };
    return await runTask({ id: `recipe:${recipe.id}:${Date.now()}`, task: recipe.prompt });
  },

  async "browser-control.get"() { return { granted: await isBrowserControlGranted(), expiresInMs: (await chrome.storage.local.get("cap:browserControlGrant"))["cap:browserControlGrant"]?.expiresAt - Date.now() ?? 0 }; },
  async "browser-control.set"(m) { const grant = await setBrowserControlGrant({ origins: m?.origins, expiryMs: m?.expiryMs }); return { grant }; },

  // Management tools — the agent can manage its own site-agents.
  async "agent.create"({ origin, name }) {
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    await enrollOrigin(canonical);
    return { ok: true, origin: canonical, name };
  },
  async "agent.delete"({ origin }) {
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    await siteMemory(canonical).clear();
    invalidateAgent();
    return { ok: true, origin: canonical };
  },
  async "agent.listAll"() {
    const origins = await listOrigins();
    return { agents: origins.map((o) => ({ origin: o })) };
  },

  async "capture.tab"({ tabId }) {
    try {
      const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (!tab?.id) return { error: "no such tab" };
      // Activate the REQUESTED tab, then VERIFY it became active before capture
      // (captureVisibleTab always captures the active tab — never another tab).
      await chrome.tabs.update(tab.id, { active: true });
      const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (active?.[0]?.id !== tab.id) return { error: "could not activate the requested tab" };
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { screenshot: url };
    } catch (e) { return { error: String(e?.message ?? e) }; }
  },
};

// A page's content script may ONLY route tool-report operations. Everything else
// (memory, agents, provider, usage, browser-control, run-task, etc.) is extension-only.
// This is an allowlist — unknown/new routes default to denied for page senders.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `unknown message: ${message?.type}` });
    return true;
  }

  // Sender authorization: a content script may only upsert/read its OWN origin's
  // tools; it may never touch memory/admin routes. The pure classifier in
  // lib/pure.js derives + validates the origin (never trusts a message origin).
  const auth = authorizeToolReport(sender, message.origin, canonicalOrigin, chrome.runtime.id);
  if (auth.kind === "content-script") {
    if (auth.error) {
      sendResponse({ ok: false, error: auth.error });
      return true;
    }
    if (!PAGE_ALLOWED_ROUTES.has(message.type)) {
      sendResponse({ ok: false, error: "not authorized from a page" });
      return true;
    }
    if (message.type === "tools.upsert") {
      message.origin = auth.origin; // derive, never trust the message-supplied origin
    }
  } else if (auth.kind === "unmatched") {
    sendResponse({ ok: false, error: auth.error });
    return true;
  }

  handler(message).then((result) => sendResponse(result)).catch((e) => {
    sendResponse({ ok: false, error: String(e?.message ?? e) });
  });
  return true; // async response
});

// ---- browser event listening (the agent sees what happens in the browser) ----
for (const [event, kind] of [
  ["onCreated", "tab-created"],
  ["onActivated", "tab-activated"],
]) {
  chrome.tabs[event]?.addListener((tabOrInfo) => {
    recordBrowserEvent(kind, {
      tabId: tabOrInfo?.tabId ?? tabOrInfo?.id,
      windowId: tabOrInfo?.windowId,
    }).catch(() => {});
  });
}
chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete" || changeInfo.title) {
    recordBrowserEvent("tab-updated", {
      tabId,
      url: tab?.url,
      title: tab?.title,
      status: changeInfo.status,
    }).catch(() => {});
  }
});
chrome.runtime.onInstalled?.addListener(() => {
  recordBrowserEvent("extension-installed", {}).catch(() => {});
});

// On install, seed the master memory + notify.
chrome.runtime.onInstalled.addListener(async () => {
  const mem = masterMemory();
  if (!(await mem.get("preferences"))) {
    await mem.set("preferences", { theme: "dark", model: "demo", multiAgent: true });
  }
  console.log("Chrome Agent Platform installed");
});

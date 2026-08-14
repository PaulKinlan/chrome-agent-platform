// background/service-worker.js — the extension's message router + agent core.
// Bundled with esbuild (the AI SDK + zod need bundling). This is the single
// place the agent loop runs; UI pages talk to it via chrome.runtime messages.

import { getModel, getProviderConfig, setProviderConfig, deferToGlm } from "../lib/provider.js";
import { masterMemory, siteMemory, listOrigins, journalAppend } from "../lib/memory.js";
import { createOrchestrator, createAgent } from "../lib/agent.js";
import { recordUsage, getUsage, clearUsage } from "../lib/usage.js";
import { upsertTools, listTools, enrollOrigin, isApproved, approveTool, pendingApprovals } from "../lib/tools.js";
import { setSkills, getSkills, allSkills } from "../lib/skills.js";

// ---- alarm scheduler (agent-do pattern) ----
function registerAlarm(task) {
  const info = { when: Date.now() + (task.when ?? 0) };
  if (task.periodInMinutes) info.periodInMinutes = task.periodInMinutes;
  chrome.alarms.create(task.name ?? task.id ?? String(Date.now()), info);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // Resume the agent context for the scheduled task and run it.
  runTask({ id: alarm.name, task: alarm.name, scheduled: true }).catch((e) => {
    console.error("scheduled task failed", alarm.name, e);
  });
});

// ---- lazy agent bootstrap ----
let orchestrator = null;
const MODEL_CACHE = { model: null };

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
  orchestrator = await createOrchestrator({ model, masterMemory: mem, workers });
  return orchestrator;
}

// Per-site toolset: the site's declared/inferred tools become callable tools.
async function siteToolset(origin) {
  const tools = await listTools(origin);
  const set = {};
  for (const t of tools) {
    // Only wire tools the user has approved (first-run approval).
    set[`${origin}:${t.name}`] = {
      description: `${t.name} on ${origin} — ${t.description ?? ""}`,
      // Defer real execution to the side-panel bridge; here return a marker
      // that the content script actually invokes the page function.
      execute: async (args) => {
        if (!(await isApproved(origin, t.name))) {
          return { error: `tool ${t.name} on ${origin} not approved` };
        }
        return await invokeSiteTool(origin, t.name, args);
      },
    };
  }
  return set;
}

// Drive a page function on an origin via the content script (WebMCP/injection).
async function invokeSiteTool(origin, name, args) {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => (t.url ?? "").startsWith(origin));
  if (!tab?.id) return { error: `no tab open for ${origin}` };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "invoke-tool", name, args });
    return res ?? { ok: true };
  } catch (e) {
    return { error: `invoke failed: ${e.message}` };
  }
}

async function runTask({ id, task, scheduled = false }) {
  const orch = await ensureOrchestrator();
  const taskId = id ?? String(Date.now());
  const mem = masterMemory();
  await journalAppend(mem, { type: "task", id: taskId, task, scheduled });
  const onStep = () => {};
  const result = await orch.run(task, { onStep });
  await journalAppend(mem, { type: "result", id: taskId, result });
  return { ok: true, result };
}

// ---- message router ----
const handlers = {
  async "provider.get"(m) { return await getProviderConfig(); },
  async "provider.set"(m) { return await setProviderConfig(m.config); },
  async "provider.models"() { return { note: "pluggable: deepseek + glm defer seam" }; },

  async "agent.run"(m) { return await runTask({ id: m.id, task: m.task }); },
  async "agent.list"() { return await listOrigins(); },
  async "agent.defer"({ task }) { return await deferToGlm(task); },

  async "tools.list"({ origin }) { return await listTools(origin); },
  async "tools.upsert"({ origin, tools }) { await enrollOrigin(origin); return await upsertTools(origin, tools); },
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

  async "register-task"(m) { registerAlarm(m.task); return { ok: true }; },
  async "run-task"(m) { return await runTask({ id: m.id, task: m.task }); },

  async "capture.tab"({ tabId }) {
    try {
      const url = await chrome.tabs.captureVisibleTab(tabId ? { tabId } : undefined, { format: "png" });
      return { screenshot: url };
    } catch (e) { return { error: e.message }; }
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `unknown message: ${message?.type}` });
    return true;
  }
  handler(message).then((result) => sendResponse(result)).catch((e) => {
    sendResponse({ ok: false, error: String(e?.message ?? e) });
  });
  return true; // async response
});

// On install, seed the master memory + notify.
chrome.runtime.onInstalled.addListener(async () => {
  const mem = masterMemory();
  if (!(await mem.get("preferences"))) {
    await mem.set("preferences", { theme: "dark", model: "deepseek-v4-pro", multiAgent: true });
  }
  console.log("Chrome Agent Platform installed");
});

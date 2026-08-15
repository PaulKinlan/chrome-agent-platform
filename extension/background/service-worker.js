// background/service-worker.js — the extension's message router + agent core.
// Bundled with esbuild (the AI SDK + zod need bundling). This is the single
// place the agent loop runs; UI pages talk to it via chrome.runtime messages.

import {
  getModel,
  getProviderConfig,
  PROVIDER_CHOICES,
  setProviderConfig,
} from "../lib/provider.js";
import {
  canonicalOrigin,
  journalAppend,
  listOrigins,
  masterMemory,
  siteMemory,
} from "../lib/memory.js";
import { createAgent, createOrchestrator } from "../lib/agent.js";
import { clearUsage, getUsage, recordUsage } from "../lib/usage.js";
import {
  approveTool,
  enrollOrigin,
  isApproved,
  listTools,
  pendingApprovals,
  upsertTools,
} from "../lib/tools.js";
import { allSkills, getSkills, setSkills } from "../lib/skills.js";
import {
  browserToolset,
  captureTabScreenshot,
  isBrowserControlGranted,
  recordBrowserEvent,
  revokeBrowserControlGrant,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
} from "../lib/browser-tools.js";
import { getRecipe, RECIPES } from "../lib/recipes.js";
import {
  recoverOnBoot,
  markScheduledDone,
  releaseInflight,
  scheduleTask,
  tryAcquireInflight,
} from "../lib/scheduler.js";
import { tool } from "ai";
import { z } from "zod";
import {
  authorizeToolReport,
  PAGE_ALLOWED_ROUTES,
  sanitizeToolName as safeToolName,
  schemaToZod as buildSchema,
} from "../lib/pure.js";

// ---- alarm scheduler (persists the full task payload) ----
const TASK_KEY = "cap:scheduledTasks";

async function registerAlarm(task) {
  // The ONE atomic scheduling path (validation → persist → alarm.create).
  return await scheduleTask({
    task: task.task,
    at: task.at,
    delayMs: task.delayMs,
    periodInMinutes: task.periodInMinutes,
    attachments: task.attachments ?? [],
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // In-flight lock: a slow run must not overlap the next alarm (periodic).
  if (!(await tryAcquireInflight(alarm.name))) {
    console.warn("scheduled task already in flight", alarm.name);
    return;
  }
  const store = await chrome.storage.local.get(TASK_KEY);
  const task = store[TASK_KEY]?.[alarm.name];
  if (!task) {
    await releaseInflight(alarm.name);
    console.error("scheduled task payload missing", alarm.name);
    return;
  }
  try {
    // Run FIRST, delete only on success (durable across worker interruption).
    await runTask({
      id: alarm.name,
      task: task.task ?? alarm.name,
      scheduled: true,
      attachments: task.attachments ?? [],
    });
    if (!task.periodInMinutes) {
      await markScheduledDone(alarm.name);
    }
  } catch (e) {
    console.error("scheduled task failed", alarm.name, e);
    // Keep the one-shot payload so a retry/restart can resume it.
  } finally {
    await releaseInflight(alarm.name);
  }
});

// ---- lazy agent bootstrap (invalidated on provider change) ----
let orchestrator = null;
const MODEL_CACHE = { model: null, key: null };

function invalidateAgent() {
  // Clear BOTH the cached model AND its cache key: re-saving the same provider
  // (or rotating credentials for the same base URL/model) must rebuild the
  // model, not leave MODEL_CACHE.model=null with a still-matching key.
  MODEL_CACHE.model = null;
  MODEL_CACHE.key = null;
  orchestrator = null;
}

async function ensureModel(_agentId) {
  // A single safe GLOBAL provider. Per-agent provider resolution is TODO
  // (it needs COMPLETE provider-specific configs keyed by provider, not one
  // global {baseURL,apiKey,model} that can mix one provider's credential with
  // another's endpoint). The cache key carries a credential-version signal (a
  // NON-secret presence flag) so credential rotation rebuilds the model.
  const cfg = await getProviderConfig();
  const credVersion = cfg.apiKey ? "k1" : "k0";
  const cacheKey = `${cfg.provider}:${cfg.baseURL}:${cfg.model}:${credVersion}`;
  // Rebuild whenever the key changed OR the cached model is null.
  if (MODEL_CACHE.key !== cacheKey || !MODEL_CACHE.model) {
    MODEL_CACHE.key = cacheKey;
    MODEL_CACHE.model = await getModel();
  }
  return MODEL_CACHE.model;
}

async function ensureOrchestrator() {
  if (orchestrator) return orchestrator;
  const model = await ensureModel();
  const mem = masterMemory();
  // Workers = enrolled site origins, each with its own memory + skills.
  const origins = await listOrigins();
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
  const seen = new Map(); // tool id → (origin, name) for explicit duplicate rejection
  for (const t of tools) {
    // A valid AI-SDK tool needs an inputSchema. The JSON-schema descriptor is
    // converted by schemaToZod (fail-closed: unsupported → z.never()), and the
    // invocation is approval-gated + origin-bound.
    let id = safeToolName(origin, t.name);
    let n = 2;
    // Even with a 64-bit hash, reject an actual collision explicitly: append a
    // disambiguator rather than silently overwriting another tool.
    while (
      seen.has(id) &&
      (seen.get(id).origin !== origin || seen.get(id).name !== t.name)
    ) {
      id = `${safeToolName(origin, t.name)}_${n++}`.slice(0, 64);
    }
    seen.set(id, { origin, name: t.name });
    set[id] = tool({
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
    try {
      return t.url ? new URL(t.url).origin === origin : false;
    } catch {
      return false;
    }
  });
  if (!tab?.id) return { error: `no tab open for ${origin}` };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "invoke-tool",
      name,
      args,
    });
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
      `[attachment: ${a.name ?? "unnamed"} (${a.kind ?? "file"}, ${
        a.type ?? "unknown"
      }, ${a.size ?? "?"} bytes)]`,
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
      parts.push(
        "  (media attached — not transcribed/described in this build)",
      );
    }
  }
  return "Attachments:\n" + parts.join("\n");
}

async function runTask({ id, task, scheduled = false, attachments = [] }) {
  const orch = await ensureOrchestrator();
  const taskId = id ?? String(Date.now());
  const mem = masterMemory();
  await journalAppend(mem, {
    type: "task",
    id: taskId,
    task,
    scheduled,
    attachmentCount: attachments?.length ?? 0,
  });
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
        iconUrl:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='4' fill='%2378b3ff'/%3E%3C/svg%3E",
        title: "Scheduled task complete",
        message: String(result ?? "").slice(0, 160),
      });
    } catch (e) {
      console.error("notification failed", e);
    }
  }
  return { ok: true, result };
}

// ---- message router ----
const handlers = {
  async "provider.get"() {
    return await getProviderConfig();
  },
  async "provider.set"(m) {
    const next = await setProviderConfig(m.config);
    // The running agent must switch immediately — invalidate the cached model + orchestrator.
    invalidateAgent();
    return next;
  },
  async "provider.models"() {
    return { choices: PROVIDER_CHOICES };
  },

  async "agent.run"(m) {
    // Bound the attachment payload: measure the ACTUAL dataURL bytes (never trust
    // a client-claimed size), enforce per-item AND aggregate limits + a count cap,
    // and report (not silently drop) anything over budget.
    const MAX_ITEM_BYTES = 8 * 1024 * 1024; // 8 MiB per attachment (encoded)
    const MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MiB aggregate (encoded)
    const MAX_ITEM_DECODED = 6 * 1024 * 1024; // 6 MiB per attachment (decoded)
    const MAX_TOTAL_DECODED = 12 * 1024 * 1024; // 12 MiB aggregate (decoded)
    const MAX_COUNT = 8;
    // Validate the dataURL SHAPE + measure BOTH the encoded transport size (the
    // WHOLE dataURL string, which travels through runtime messaging) AND the
    // decoded payload size (from validated base64 length/padding). Accept only
    // data:<mime>;base64,<payload>. The declared a.type must match the parsed
    // MIME — an image must not be relabelled text/plain.
    const measured = (a) => {
      if (!a?.dataURL) return { bytes: 0, decoded: 0, valid: true };
      const m =
        /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*)(?:;\s*[a-z0-9-]+=(?:"[^"]*"|[^;,\s]*))*;base64,([A-Za-z0-9+/]*={0,2})\s*$/
          .exec(
            String(a.dataURL),
          );
      if (!m) return { bytes: 0, decoded: 0, valid: false }; // malformed → rejected
      const mime = m[1].toLowerCase();
      const payload = m[2];
      if (payload.length % 4 !== 0) return { bytes: 0, decoded: 0, valid: false };
      // Bind the declared type to the parsed MIME (no image labelled text/plain).
      const declaredType = String(a?.type ?? "").toLowerCase();
      if (declaredType && declaredType !== mime) {
        return { bytes: 0, decoded: 0, valid: false };
      }
      // Encoded size = the complete dataURL string (ASCII, so length ≈ bytes).
      const encoded = String(a.dataURL).length;
      // Decoded size = (base64_len / 4) * 3 minus padding characters.
      const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
      const decoded = (payload.length / 4) * 3 - padding;
      return { bytes: encoded, decoded, valid: true };
    };
    let total = 0;
    let totalDecoded = 0;
    const bounded = [];
    const dropped = [];
    // Enforce MAX_COUNT exactly (not MAX_COUNT * 4).
    for (const a of (m.attachments ?? []).slice(0, MAX_COUNT)) {
      const { bytes, decoded, valid } = measured(a);
      const name = String(a?.name ?? "unnamed").slice(0, 200);
      const type = String(a?.type ?? "unknown").slice(0, 100);
      if (!valid) {
        dropped.push({ name, reason: "malformed dataURL or type/mime mismatch" });
        continue;
      }
      if (bytes > MAX_ITEM_BYTES || decoded > MAX_ITEM_DECODED) {
        dropped.push({ name, reason: "over per-item limit" });
        continue;
      }
      if (total + bytes > MAX_TOTAL_BYTES || totalDecoded + decoded > MAX_TOTAL_DECODED) {
        dropped.push({ name, reason: "over aggregate limit" });
        continue;
      }
      bounded.push({ ...a, name, type });
      total += bytes;
      totalDecoded += decoded;
    }
    const overCount = (m.attachments ?? []).length - MAX_COUNT;
    if (overCount > 0) {
      dropped.push({ reason: `over count limit (${overCount} dropped)` });
    }
    const result = await runTask({
      id: m.id,
      task: m.task,
      attachments: bounded,
    });
    if (dropped.length > 0) result.droppedAttachments = dropped;
    return result;
  },
  async "agent.list"() {
    return await listOrigins();
  },

  async "tools.list"({ origin }) {
    return await listTools(origin);
  },
  async "tools.upsert"({ origin, tools }) {
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    await enrollOrigin(canonical);
    await upsertTools(canonical, tools);
    // New tools/sites must reach the running orchestrator — rebuild it.
    invalidateAgent();
    return { ok: true };
  },
  async "tools.approve"({ origin, name, decision }) {
    return await approveTool(origin, name, decision);
  },
  async "tools.pending"({ origin }) {
    return await pendingApprovals(origin);
  },
  async "tools.allOrigins"() {
    return await listOrigins();
  },

  async "skills.set"({ origin, skills }) {
    return await setSkills(origin, skills);
  },
  async "skills.get"({ origin }) {
    return await getSkills(origin);
  },
  async "skills.all"() {
    return await allSkills();
  },

  async "memory.get"({ origin, key }) {
    return await (origin === "master" ? masterMemory() : siteMemory(origin))
      .get(key);
  },
  async "memory.set"({ origin, key, value }) {
    return await (origin === "master" ? masterMemory() : siteMemory(origin))
      .set(key, value);
  },
  async "memory.list"({ origin }) {
    return await (origin === "master" ? masterMemory() : siteMemory(origin))
      .keys();
  },
  async "memory.clear"({ origin }) {
    return await (origin === "master" ? masterMemory() : siteMemory(origin))
      .clear();
  },
  async "memory.origins"() {
    return await listOrigins();
  },

  async "usage.get"() {
    return await getUsage();
  },
  async "usage.clear"() {
    await clearUsage();
    return { ok: true };
  },

  async "register-task"(m) {
    const { name, when } = await registerAlarm(m.task);
    return { ok: true, name, when };
  },
  async "run-task"(m) {
    return await runTask({ id: m.id, task: m.task });
  },

  async "recipe.list"() {
    return { recipes: RECIPES };
  },
  async "recipe.run"(m) {
    const recipe = getRecipe(m.id);
    if (!recipe) return { ok: false, error: `no recipe ${m.id}` };
    return await runTask({
      id: `recipe:${recipe.id}:${Date.now()}`,
      task: recipe.prompt,
    });
  },

  async "browser-control.get"() {
    const s = await chrome.storage.local.get("cap:browserControlGrant");
    const grant = s["cap:browserControlGrant"];
    let expiresInMs = 0;
    if (
      grant && typeof grant.expiresAt === "number" &&
      Number.isFinite(grant.expiresAt)
    ) {
      expiresInMs = Math.max(0, grant.expiresAt - Date.now());
    }
    const active = Boolean(
      grant && typeof grant === "object" && grant.expiresAt > Date.now(),
    );
    return {
      // "active" = a grant EXISTS and is unexpired (regardless of scope).
      // "granted" (global scope) is a separate concept from per-origin authorization.
      active,
      scope: grant?.scope ?? null,
      origins: grant?.scope === "origins" && Array.isArray(grant.origins)
        ? grant.origins
        : null,
      expiresInMs,
    };
  },
  async "browser-control.set"(m) {
    // Explicit grant / revoke: granted=false REVOKES (never creates a fresh grant).
    if (m?.granted === false) {
      return { grant: await revokeBrowserControlGrant() };
    }
    let grant;
    if (Array.isArray(m?.origins) && m.origins.length > 0) {
      grant = await setOriginBrowserControlGrant(m.origins, m?.expiryMs);
    } else {
      grant = await setGlobalBrowserControlGrant(m?.expiryMs);
    }
    return { grant };
  },

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
    // The SAME gated capture as the agent tool: resolves the tab, derives its
    // origin, checks the grant FOR THAT ORIGIN, then activates + verifies +
    // captures. A post-revoke or wrong-origin capture is denied here.
    return await captureTabScreenshot(tabId);
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
  const auth = authorizeToolReport(
    sender,
    message.origin,
    canonicalOrigin,
    chrome.runtime.id,
  );
  if (auth.kind === "content-script") {
    if (auth.error) {
      sendResponse({ ok: false, error: auth.error });
      return true;
    }
    if (!PAGE_ALLOWED_ROUTES.has(message.type)) {
      sendResponse({ ok: false, error: "not authorized from a page" });
      return true;
    }
    // Derive the origin for every permitted page route — never trust a
    // message-supplied origin (a page must not be able to act on another origin).
    message.origin = auth.origin;
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
for (
  const [event, kind] of [
    ["onCreated", "tab-created"],
    ["onActivated", "tab-activated"],
  ]
) {
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
    await mem.set("preferences", {
      theme: "dark",
      model: "demo",
      multiAgent: true,
    });
  }
  console.log("Chrome Agent Platform installed");
});

// Recover stale in-flight locks on every worker boot so a crashed task doesn't
// permanently block its alarm. Reconciliation failures are surfaced (logged),
// not silently discarded.
// One serialized, idempotent boot recovery (clear pre-boot locks + reconcile
// missing alarms). Both the module-eval call and the onStartup listener route
// through recoverOnBoot(); the internal flag makes the second a no-op, so a
// live lock acquired between the two can never be cleared twice.
chrome.runtime.onStartup?.addListener(() => {
  recoverOnBoot().catch((e) =>
    console.error("recoverOnBoot:", e?.message ?? e)
  );
});
recoverOnBoot().catch((e) =>
  console.error("recoverOnBoot:", e?.message ?? e)
);

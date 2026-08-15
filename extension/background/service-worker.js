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
  saveScreenshot,
  siteMemory,
} from "../lib/memory.js";
import {
  kvGet,
  kvSet,
  kvRemove,
  migrateSessionToStorage,
  resetStorageTransition,
  snapshotPersistentToSession,
} from "../lib/kv.js";
import {
  hasCapability,
  capabilityStatus,
  requestCapability,
  revokeCapability,
} from "../lib/capabilities.js";
import { createAgent, createOrchestrator } from "../lib/agent.js";
import { clearUsage, getUsage, recordUsage } from "../lib/usage.js";
import {
  approveTool,
  disenrollOrigin,
  enrollmentSnapshot,
  enrollOrigin,
  isApproved,
  isEnrolled,
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
  setDenyAllBrowserControlGrant,
  setOriginBrowserControlGrant,
} from "../lib/browser-tools.js";
import { getRecipe, RECIPES } from "../lib/recipes.js";
import {
  INFLIGHT_HEARTBEAT_MS,
  heartbeatInflight,
  recoverOnBoot,
  markScheduledDone,
  ownsInflight,
  releaseInflight,
  scheduleTask,
  tryAcquireInflight,
} from "../lib/scheduler.js";

import {
  ensureOriginScriptsRegistered,
  removeOriginHostPermission,
  unregisterOriginScripts,
  withOriginLock,
} from "../lib/enrollment.js";
import { tool } from "ai";
import { z } from "zod";
import { setRunFence, clearRunFence, runAborted } from "../lib/run-fence.js";
import {
  authorizeToolReport,
  PAGE_ALLOWED_ROUTES,
  sanitizeToolName as safeToolName,
  schemaToZod as buildSchema,
} from "../lib/pure.js";

// ---- run serialization ----
// The cached orchestrator (and its single agent-do abort controller) is SHARED
// across runs. Two concurrent runs would overwrite/abort each other's controller
// (the round-15 blocker). Serialize master execution: at most one agent run at
// a time, so an abort always targets the one active run. Delegated worker runs
// inside a serialized master are also serialized by this gate.
let runMutex = Promise.resolve();
function withRunLock(fn) {
  const run = runMutex.then(fn, fn);
  runMutex = run.then(() => {}, () => {});
  return run;
}

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

async function handleAlarm(alarm) {
  // In-flight lock: a slow run must not overlap the next alarm (periodic).
  const lock = await tryAcquireInflight(alarm.name);
  if (!lock.acquired) {
    console.warn("scheduled task already in flight", alarm.name, lock.reason);
    return;
  }
  const { token } = lock;
  // Heartbeat while the task runs so a live-but-slow run never looks stale to a
  // later firing (timeout alone must never create overlapping agents). A FAILED
  // heartbeat renewal is tracked (not swallowed): the run must ABORT once it can
  // no longer prove ownership, rather than commit side effects as a stale owner.
  let heartbeatFailed = false;
  const hb = setInterval(() => {
    heartbeatInflight(alarm.name, token).catch(() => {
      heartbeatFailed = true;
      // Abort the RUNNING agent/tools: call the CONTROLLER (an AbortSignal has
      // no `abort` method — the round-13 TypeError), so the fence signal fires
      // and every side-effecting tool checks it before committing.
      lock.controller?.abort();
    });
  }, INFLIGHT_HEARTBEAT_MS);
  // The EXECUTION fence: checked at every durable/destructive boundary inside
  // runTask + before markScheduledDone. Ownership loss (re-acquisition by a
  // later firing) or a heartbeat-renewal failure aborts the run BEFORE it
  // commits journal/notification/task-deletion side effects. The abort signal
  // is threaded into runTask so the RUNNING agent/tools also stop.
  const fence = {
    signal: lock.signal,
    async assertOwned() {
      if (heartbeatFailed || lock.signal?.aborted) {
        throw new Error("heartbeat renewal failed — aborting run");
      }
      if (!(await ownsInflight(alarm.name, token))) {
        throw new Error("in-flight ownership lost — aborting run");
      }
    },
  };
  // The lock is acquired; EVERYTHING below (including the storage read) must
  // run inside try/finally so a read/validation rejection still releases the
  // in-flight lock (otherwise future firings block forever).
  try {
    const store = await kvGet(TASK_KEY);
    const task = store[TASK_KEY]?.[alarm.name];
    if (!task) {
      console.error("scheduled task payload missing", alarm.name);
      return;
    }
    // Run FIRST, delete only on success (durable across worker interruption).
    await runTask({
      id: alarm.name,
      task: task.task ?? alarm.name,
      scheduled: true,
      attachments: task.attachments ?? [],
      fence,
    });
    if (!task.periodInMinutes) {
      await fence.assertOwned();
      await markScheduledDone(alarm.name, token);
    }
  } catch (e) {
    console.error("scheduled task failed", alarm.name, e);
    // Keep the one-shot payload so a retry/restart can resume it.
  } finally {
    clearInterval(hb);
    await releaseInflight(alarm.name, token);
  }
}

// The `chrome.alarms` namespace is permission-gated: when `alarms` is an
// OPTIONAL permission (Paul's all-optional requirement) and not yet granted,
// `chrome.alarms` is `undefined` at module-eval time, so a top-level
// `chrome.alarms?.onAlarm?.addListener(...)` would silently no-op and the alarm
// listener would NEVER be registered (the round-14b alarm bug: the alarm fires
// and is consumed, but nothing handles it, so no task/result is journaled).
// Register the listener lazily: once when the module evaluates (if `alarms` was
// already granted, e.g. the extension was reloaded after a grant) and again via
// chrome.permissions.onAdded when the user grants the capability.
let alarmListenerRegistered = false;
function registerAlarmListener() {
  if (alarmListenerRegistered) return;
  if (typeof chrome === "undefined" || !chrome.alarms?.onAlarm) return;
  chrome.alarms.onAlarm.addListener(handleAlarm);
  alarmListenerRegistered = true;
}
registerAlarmListener();
chrome.permissions?.onAdded?.addListener((perms) => {
  if (perms?.permissions?.includes("alarms")) registerAlarmListener();
  // When the optional `storage` permission is granted later, migrate the SW's
  // session fallback into the persistent backend so the configured provider /
  // theme / grants are not orphaned (the round-16 migration finding: a genuine
  // probe showed the provider resetting to demo on storage grant). A failed
  // migration is logged, never silently dropped.
  if (perms?.permissions?.includes("storage")) {
    migrateSessionToStorage().catch((e) =>
      console.error("migrateSessionToStorage:", e?.message ?? e)
    );
  }
});
chrome.permissions?.onRemoved?.addListener((perms) => {
  if (perms?.permissions?.includes("storage")) {
    // On a storage Disable→Enable cycle the session fallback holds changes made
    // during the disabled period; reset the migration flag so the next grant
    // re-migrates them (never restore stale persistent values — the round-17
    // storage-Disable blocker).
    resetStorageTransition();
  }
});

// ---- lazy agent bootstrap (invalidated on provider change) ----
// A generation counter guards the async bootstrap against stale publication:
// ensureModel/ensureOrchestrator await storage/provider/OPFS reads; if an
// invalidation happens DURING those awaits, the older operation must NOT
// overwrite the freshly-rebuilt cache with a model/orchestrator built from
// stale configuration. Each build commits its result only if the generation
// captured at its start is still current; otherwise it loops and rebuilds.
let orchestrator = null;
let orchestratorGen = -1;
const MODEL_CACHE = { model: null, key: null, gen: -1 };
let generation = 0;

function invalidateAgent() {
  // Bump the generation FIRST (so any in-flight build sees a changed
  // generation and discards its result), then clear the caches. Re-saving the
  // same provider (or rotating credentials for the same base URL/model) must
  // rebuild the model, not leave MODEL_CACHE.model=null with a matching key.
  generation++;
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
  while (true) {
    const gen = generation;
    const cfg = await getProviderConfig();
    const credVersion = cfg.apiKey ? "k1" : "k0";
    const cacheKey = `${cfg.provider}:${cfg.baseURL}:${cfg.model}:${credVersion}`;
    // Rebuild whenever the key changed OR the cached model is null OR the
    // cached model predates the current generation.
    if (
      MODEL_CACHE.model && MODEL_CACHE.key === cacheKey &&
      MODEL_CACHE.gen === gen
    ) {
      return MODEL_CACHE.model;
    }
    const model = await getModel();
    // Commit only if no invalidation happened while we awaited getModel().
    if (generation === gen) {
      MODEL_CACHE.key = cacheKey;
      MODEL_CACHE.model = model;
      MODEL_CACHE.gen = gen;
      return model;
    }
    // Stale build — loop and rebuild under the new generation.
  }
}

async function ensureOrchestrator() {
  while (true) {
    const gen = generation;
    if (orchestrator && orchestratorGen === gen) return orchestrator;
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
    // multiAgent toggles fan-out (hub + per-site sub-agents) vs a solo hub agent.
    // Read it at orchestration time; the options page changes it via
    // provider.set-style invalidation so a saved change rebuilds the orchestrator.
    const prefs = (await kvGet("cap:multiAgent")) ?? {};
    const multiAgent = prefs["cap:multiAgent"] !== false;
    const orch = await createOrchestrator({
      model,
      masterMemory: mem,
      workers,
      multiAgent,
      extraTools: browserToolset(),
      delegateGuard: async (origin) => {
        // The model-facing delegate_task must revalidate LIVE enrollment before
        // running a cached worker (the internal path previously bypassed the
        // lifecycle gate — the round-15 finding). Use the ATOMIC snapshot (enrolled
        // + generation read under the enrollment lock) so a delete can never
        // interleave with the read (the round-16 generation race).
        const snap = await enrollmentSnapshot(origin);
        if (!snap.enrolled) {
          return { ok: false, error: `origin ${origin} is not enrolled` };
        }
        return { ok: true, gen: snap.gen };
      },
    });
    // Commit only if the generation is still current (an invalidation during
    // the awaits above means this orchestrator used stale config).
    if (generation === gen) {
      orchestrator = orch;
      orchestratorGen = gen;
      return orch;
    }
    // Stale build — loop and rebuild under the new generation.
  }
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
// Preemptive revocation: enrollment + GENERATION are read atomically up front,
// the untrusted page call runs WITHOUT holding the origin lifecycle lock (so a
// hung/malicious page tool can never block agent.delete), and the generation is
// REVALIDATED after the call — a delete during the call tombstones + bumps the
// generation, so the result is discarded rather than journaled.
async function invokeSiteTool(origin, name, args) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { error: `invalid origin ${origin}` };
  // Atomic snapshot (enrolled + generation read under the enrollment lock) — a
  // delete cannot interleave with the read (the round-16 generation race).
  const snap = await enrollmentSnapshot(canonical);
  if (!snap.enrolled) {
    return { error: `origin ${canonical} is not enrolled` };
  }
  const gen = snap.gen;
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => {
    try {
      return t.url ? new URL(t.url).origin === canonical : false;
    } catch {
      return false;
    }
  });
  if (!tab?.id) return { error: `no tab open for ${canonical}` };
  // The site invocation is a SIDE-EFFECTING boundary (it drives a page function
  // on the origin) — it must be fenced like every other tool (the round-16 fence
  // coverage finding: site invocation called tabs.sendMessage without a run check).
  if (runAborted()) {
    return { error: "run aborted — site invocation not sent" };
  }
  // Re-check the SAME enrollment generation IMMEDIATELY before tabs.sendMessage:
  // the snapshot above was read before the tab query await, so a delete in that
  // gap could tombstone the origin and the page function would still run (the
  // round-17 blocker: deletion did not preempt a site invocation already in
  // flight). Re-reading under the enrollment lock closes the await gap as tightly
  // as possible without holding the origin lifecycle lock across the page call.
  {
    const recheck = await enrollmentSnapshot(canonical);
    if (!recheck.enrolled || recheck.gen !== gen) {
      return {
        error: `origin ${canonical} was disenrolled before the call`,
      };
    }
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "invoke-tool",
      name,
      args,
    });
    // Revalidate live enrollment + the SAME generation ATOMICALLY after the page
    // call (a single locked snapshot, not two unlocked reads).
    const after = await enrollmentSnapshot(canonical);
    if (!after.enrolled || after.gen !== gen) {
      return {
        error: `origin ${canonical} was disenrolled during the call — result discarded`,
      };
    }
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

async function runTask({ id, task, scheduled = false, attachments = [], fence = null }) {
  // Serialize master execution: the cached orchestrator is shared, so a second
  // run must queue behind the first rather than clobber its abort controller.
  return await withRunLock(async () => {
    const orch = await ensureOrchestrator();
    const taskId = id ?? String(Date.now());
    const mem = masterMemory();
    // Thread the fence's abort signal into the RUNNING agent AND every
    // side-effecting tool (via the shared run-fence module): if ownership or
    // heartbeat renewal fails mid-run, abort the in-flight model/tool loop AND
    // block open/navigate/close/delegate from committing stale side effects.
    let abortNow = null;
    if (fence?.signal) {
      setRunFence(fence);
      abortNow = () => {
        try {
          orch.abort?.();
        } catch { /* already aborted */ }
      };
      fence.signal.addEventListener("abort", abortNow);
      if (fence.signal.aborted) abortNow();
    }
    try {
      // Every durable/destructive boundary is FENCED when a scheduled run owns an
      // in-flight lock: a stale owner aborts before committing the task journal,
      // the result journal, or the completion notification.
      await fence?.assertOwned?.();
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
      await fence?.assertOwned?.();
      await journalAppend(mem, { type: "result", id: taskId, result });
      if (scheduled) {
        await fence?.assertOwned?.();
        // Completion lifecycle: surface the result as a notification. The
        // `notifications` permission is OPTIONAL — when absent, skip silently (a
        // missing permission is not a failure worth a console error).
        if (chrome.notifications?.create) {
          try {
            await chrome.notifications.create(`cap:${taskId}`, {
              type: "basic",
              iconUrl: chrome.runtime.getURL("icon128.png"),
              title: "Scheduled task complete",
              message: String(result ?? "").slice(0, 160),
            });
          } catch (e) {
            console.error("notification failed", e);
          }
        }
      }
      return { ok: true, result };
    } finally {
      clearRunFence();
      // Remove the abort listener BEFORE the run mutex is released (in the
      // `finally`, which still runs under withRunLock). The scheduled run's
      // `handleAlarm` calls releaseInflight AFTER runTask returns — releasing
      // the mutex — and releaseInflight aborts the per-run controller. Without
      // removing this listener, that post-run abort would fire `orch.abort()`
      // on the SHARED orchestrator and kill a queued next run (the round-16
      // cross-run abort blocker).
      if (abortNow && fence?.signal) {
        try {
          fence.signal.removeEventListener("abort", abortNow);
        } catch { /* already removed */ }
        abortNow = null;
      }
    }
  });
}

// ---- message router ----
const handlers = {
  async "capabilities.status"() {
    // Granted/absent status of every OPTIONAL capability (storage, alarms,
    // tabs, scripting, notifications, sidePanel). The Settings panel renders
    // enable buttons from this; the Chrome suite asserts the empty base list.
    return await capabilityStatus();
  },
  // Revoke an optional capability from the SW (single authority for the
  // dependent cleanup + the permission removal). The Settings Disable button
  // routes here so storage/scripting get their authoritative side effects:
  //   - storage: snapshot persistent→session BEFORE removal (no data loss on
  //     Disable) + reset the migration flag for a clean re-enable.
  //   - scripting: also unregister every enrolled origin's dynamic scripts +
  //     host permission (Disable must not leave origin authority behind).
  async "capability.revoke"({ id }) {
    if (id === "storage") {
      try {
        await snapshotPersistentToSession();
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    }
    if (id === "scripting") {
      const origins = await listOrigins();
      const results = await Promise.all(
        origins.map((o) => unregisterOriginScripts(o)),
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        return {
          ok: false,
          error:
            `could not revoke ${failed.length} origin(s): ${
              failed.map((f) => f.error ?? f.origin).join("; ")
            }`,
        };
      }
    }
    const res = await revokeCapability(id);
    if (id === "storage") {
      resetStorageTransition();
    }
    return res;
  },
  // Shared key-value access, EXTENSION-ONLY. Page surfaces route their key-value
  // reads/writes through these routes so the service worker is the SINGLE
  // authority for shared state (provider, theme, browser-control grant, multi-
  // agent). When storage is absent, the SW's session Map is the one shared store
  // — pages must never call kv* directly in their own realm (the round-15
  // split-authority finding: Settings said granted while the worker said no).
  async "kv.get"(m) {
    const keys = m?.keys;
    if (keys == null) return await kvGet(null);
    return await kvGet(Array.isArray(keys) ? keys : [keys]);
  },
  async "kv.set"(m) {
    if (!m?.values || typeof m.values !== "object") {
      return { ok: false, error: "kv.set needs a values object" };
    }
    await kvSet(m.values);
    return { ok: true };
  },
  async "kv.remove"(m) {
    if (m?.keys == null) return { ok: false, error: "kv.remove needs keys" };
    await kvRemove(Array.isArray(m.keys) ? m.keys : [m.keys]);
    return { ok: true };
  },
  async "provider.get"() {
    return await getProviderConfig();
  },
  async "provider.summary"() {
    // A REDACTED summary (provider id only) for surfaces that only need to show
    // which provider is active — the base URL / key / model never cross into a
    // non-settings DOM. The full config is Settings-only (provider.get).
    const cfg = await getProviderConfig();
    return { provider: cfg.provider };
  },
  async "provider.set"(m) {
    const next = await setProviderConfig(m.config);
    // The running agent must switch immediately — invalidate the cached model + orchestrator.
    invalidateAgent();
    return next;
  },
  async "invalidate-agent"() {
    // The options page calls this after toggling agent mode (multi-agent) so the
    // running orchestrator is rebuilt with the new setting.
    invalidateAgent();
    return { invalidated: true };
  },
  async "agent.orchestrator"() {
    // Observable fan-out state (for the acceptance journeys): whether the running
    // orchestrator is multi-agent, how many workers it fans out to, which
    // delegation tools it exposes, and the build generation (the rebuild boundary).
    await ensureOrchestrator();
    const prefs = (await kvGet("cap:multiAgent")) ?? {};
    const multiAgent = prefs["cap:multiAgent"] !== false;
    return {
      multiAgent,
      workerCount: orchestrator ? orchestrator.workers.size : 0,
      workerOrigins: orchestrator ? [...orchestrator.workers.keys()] : [],
      delegationTools: multiAgent ? ["list_agents", "delegate_task"] : [],
      generation,
    };
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
      // Compare the ESSENCE (base type/subtype) — a declared `audio/webm;codecs=opus`
      // must match the parsed `audio/webm`, not be rejected for its parameters.
      const declaredType = String(a?.type ?? "").toLowerCase();
      const declaredBase = declaredType.split(";")[0].trim();
      if (declaredBase && declaredBase !== mime) {
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
    for (let i = 0; i < overCount; i++) {
      dropped.push({ reason: "over count limit" });
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
    if (!(await isEnrolled(origin))) return { ok: false, error: "origin not enrolled" };
    return await listTools(origin);
  },
  async "tools.upsert"({ origin, tools }) {
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    // Serialize the isEnrolled check + the OPFS write under the SAME origin
    // lifecycle lock as create/delete. A running content-script bridge must NOT
    // re-enroll a deleted origin: the upsert is rejected unless the origin is
    // CURRENTLY enrolled, and the check+write is atomic w.r.t. delete (the
    // round-13 race where a delayed write resurrected a tombstoned worker).
    return await withOriginLock(canonical, async () => {
      if (!(await isEnrolled(canonical))) {
        return { ok: false, error: "origin not enrolled — enroll it in Settings" };
      }
      await upsertTools(canonical, tools);
      // New tools/sites must reach the running orchestrator — rebuild it.
      invalidateAgent();
      return { ok: true };
    });
  },
  async "tools.approve"({ origin, name, decision }) {
    return await approveTool(origin, name, decision);
  },
  async "tools.pending"({ origin }) {
    if (!(await isEnrolled(origin))) return { ok: false, error: "origin not enrolled" };
    return await pendingApprovals(origin);
  },
  async "tools.allOrigins"() {
    return await listOrigins();
  },

  async "skills.set"({ origin, skills }) {
    const result = await setSkills(origin, skills);
    // Skills feed the orchestrator's system prompt at build time — a skills change
    // must rebuild the running orchestrator, not leave a stale cached prompt.
    invalidateAgent();
    return result;
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
    const s = await kvGet("cap:browserControlGrant");
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
      // No origins → a DENY-ALL scoped grant, NOT a global grant. The record
      // exists so the UI shows "granted" + reveals the origin field, but it
      // authorizes NOTHING until the owner scopes it (the round-16 finding: the
      // default created a 15-min whole-browser authority before any scope existed).
      grant = await setDenyAllBrowserControlGrant(m?.expiryMs);
    }
    return { grant };
  },

  // Management tools — the agent can manage its own site-agents.
  async "agent.create"({ origin, name }) {
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    // Serialized per origin: create/delete/registration never interleave.
    return await withOriginLock(canonical, async () => {
      // Enroll creates the site's OPFS store directory (so listOrigins()
      // discovers the worker) AND the master-memory origins list — both, never
      // just one. The CONTENT-SCRIPT host permission is a SEPARATE owner-driven
      // step (agent.enroll-origin from a user gesture) — never requested from
      // the SW (no gesture), so a management create cannot silently gain host
      // access or inject scripts.
      await enrollOrigin(canonical);
      // Rebuild the orchestrator so the new worker is actually fan-out-able now.
      invalidateAgent();
      return { ok: true, origin: canonical, name };
    });
  },
  async "agent.enroll-origin"({ origin }) {
    // The OWNER-gesture path: the Settings page already requested the optional
    // host permission via chrome.permissions.request (a real user gesture); this
    // route registers the discovery scripts for the now-granted origin.
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    return await withOriginLock(canonical, async () => {
      // TRANSACTIONAL: enroll the origin, then register its scripts. If
      // registration FAILS (permission absent or registerContentScripts error),
      // ROLL BACK the enrollment AND remove the host permission the Settings page
      // granted, so the UI never reports "Enrolled" while scriptsRegistered is
      // false and never leaves a dangling host permission behind (the round-14
      // transactional finding).
      await enrollOrigin(canonical);
      const registered = await ensureOriginScriptsRegistered(canonical).catch(
        (e) => ({ ok: false, error: String(e?.message ?? e) }),
      );
      if (registered?.ok !== true) {
        // TRANSACTIONAL rollback: tombstone the enrollment, clear the OPFS dir,
        // and REMOVE the just-granted host permission. The rollback result is
        // captured + surfaced (a failed rollback is never silently claimed as
        // clean — the round-15 finding).
        await disenrollOrigin(canonical);
        await siteMemory(canonical).clear();
        const permissionRemoved = await removeOriginHostPermission(canonical);
        return {
          ok: false,
          origin: canonical,
          error: registered?.error ?? "script registration failed",
          permissionRemoved,
        };
      }
      invalidateAgent();
      return { ok: true, origin: canonical, scriptsRegistered: true };
    });
  },
  async "agent.delete"({ origin }) {
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    return await withOriginLock(canonical, async () => {
      // Authoritative, PREEMPTIVE revocation: tombstone the enrollment FIRST
      // (a running content-script bridge is rejected by isEnrolled from this
      // instant), THEN remove the dynamic scripts + host permission + OPFS dir.
      // Tombstone-first means a slow unregister can never leave a still-authorized
      // origin (the round-15 finding that delete was not preemptive).
      await disenrollOrigin(canonical);
      const unreg = await unregisterOriginScripts(canonical);
      await siteMemory(canonical).clear();
      invalidateAgent();
      // Authoritative revocation is claimed ONLY when BOTH the scripts AND the
      // host permission are confirmed removed. A partial revocation is surfaced
      // as incomplete (ok:false + the specific flags), never reported as success.
      if (!unreg.ok) {
        return {
          ok: false,
          origin: canonical,
          error:
            unreg.error ??
            "content-script unregister or host-permission removal failed",
          scriptsRemoved: unreg.scriptsRemoved,
          permissionRemoved: unreg.permissionRemoved,
        };
      }
      return {
        ok: true,
        origin: canonical,
        scriptsRemoved: true,
        permissionRemoved: true,
      };
    });
  },
  async "agent.delegate"({ origin, task }) {
    // Direct, observable fan-out: run a WORKER agent (not the hub) for an
    // enrolled origin and journal its result to the worker's OWN per-origin
    // memory. Preemptive revocation: the generation is captured up front, the
    // worker run happens WITHOUT holding the origin lifecycle lock (a hung
    // provider/model must never block agent.delete), and the generation is
    // revalidated BEFORE committing the journal write.
    const canonical = canonicalOrigin(origin);
    if (!canonical) return { ok: false, error: "invalid origin" };
    const snap = await enrollmentSnapshot(canonical);
    if (!snap.enrolled) {
      return { ok: false, error: `origin ${canonical} is not enrolled` };
    }
    const gen = snap.gen;
    await ensureOrchestrator();
    const a = orchestrator?.workers?.get(canonical);
    if (!a) return { ok: false, error: `no agent for ${origin}` };
    // The worker run is a SIDE-EFFECTING boundary: it must be fenced (an aborted
    // run must not start a delegated worker) AND serialized with the master via
    // withRunLock (the cached orchestrator's shared abort controller must never be
    // clobbered by an explicit delegation racing a master run — the round-16 fence
    // coverage finding).
    if (runAborted()) {
      return { ok: false, error: "run aborted — delegation not started" };
    }
    const result = await withRunLock(async () => {
      if (runAborted()) {
        throw new Error("run aborted — delegation not started");
      }
      // Re-check the SAME generation IMMEDIATELY before a.run: a delete while
      // this delegation was waiting on the run mutex must not start a stale
      // worker (the round-17 blocker: delegation could abort during the guard
      // then still start).
      const recheck = await enrollmentSnapshot(canonical);
      if (!recheck.enrolled || recheck.gen !== gen) {
        throw new Error(
          `origin ${canonical} was disenrolled before delegation`,
        );
      }
      return await a.run(task, "", []);
    });
    // Atomically revalidate + COMMIT under the origin lifecycle lock, so a delete
    // (which tombstones + clears OPFS under the same lock) can never race the
    // journalAppend and resurrect the tombstoned directory (the round-16
    // generation-commit race).
    return await withOriginLock(canonical, async () => {
      const after = await enrollmentSnapshot(canonical);
      if (!after.enrolled || after.gen !== gen) {
        return {
          ok: false,
          error:
            `origin ${canonical} was disenrolled during delegation — result discarded`,
        };
      }
      await journalAppend(siteMemory(canonical), {
        type: "delegated-result",
        id: `delegate:${canonical}:${Date.now()}`,
        task,
        result,
      });
      return { ok: true, origin: canonical, result };
    });
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
// Guarded with `chrome.tabs?.` — the `tabs` permission is OPTIONAL, so a boot
// with zero permissions must not throw here (the listeners simply don't attach
// until the owner enables Browser control).
for (
  const [event, kind] of [
    ["onCreated", "tab-created"],
    ["onActivated", "tab-activated"],
  ]
) {
  chrome.tabs?.[event]?.addListener((tabOrInfo) => {
    recordBrowserEvent(kind, {
      tabId: tabOrInfo?.tabId ?? tabOrInfo?.id,
      windowId: tabOrInfo?.windowId,
    }).catch(() => {});
  });
}
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
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

// The OWNER-invoked screenshot path (the headed-browser success case). Clicking
// the extension action grants `activeTab` TRANSIENTLY for the tab the owner is
// viewing — this is the ONLY gesture that authorizes captureVisibleTab of a
// specific tab (activeTab is tied to the invoked tab, NOT an arbitrary tab the
// agent activates later; headless cannot reproduce this because there is no
// action invocation, so the Chrome suite asserts the fail-closed denial and
// documents this headed-only path). The captured screenshot is journaled to the
// hub's memory so the owner can retrieve it.
chrome.action?.onClicked?.addListener(async (tab) => {
  if (runAborted()) return;
  try {
    const shot = await captureTabScreenshot(tab?.id);
    if (shot?.screenshot) {
      const mem = masterMemory();
      // Store the screenshot as a DEDICATED OPFS file (bounded + evict-oldest),
      // never as an inline base64 value that overflows the 256 KiB memory bound
      // (the round-17 blocker: one base64 PNG (~300 KiB) exceeded the cap).
      await saveScreenshot(mem, {
        url: shot.url,
        dataURL: shot.screenshot,
      });
      await journalAppend(mem, {
        type: "screenshot",
        id: `shot:${Date.now()}`,
        url: shot.url,
      });
    }
  } catch (e) {
    console.error("action screenshot failed", e?.message ?? e);
  }
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

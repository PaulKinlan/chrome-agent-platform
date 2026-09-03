// lib/agent.js — the agent core, built on the REAL agent-do library.
//
// This imports createAgent from "agent-do" (bundled by esbuild) — not a
// reimplementation. Our `createAgent` wrapper calls agent-do's createAgent.
// memory tools + the onUsage hook (→ usage.js). The hub can fan out to
// per-site sub-agents via delegation tools (the 1-agent vs N-agent flag).

import { createAgent as agentDoCreateAgent } from "agent-do";
import { tool } from "ai";
import { z } from "zod";
import { recordUsage } from "./usage.js";
import { createRunTextTracker } from "./run-text-steps.js";
import { createTextDeltaCoalescer } from "./text-delta-coalescer.js";
import { grepAgentMemory } from "./named-agents.js";
import { assertRunOwned } from "./run-fence.js";
import { MODEL_PRICING } from "./model-prices.js";
import { appendSkillsLayer, baselineSystemPrompt } from "./system-prompts.js";
import { sha256Hex, utf8ByteLength, safeProviderError, sleep } from "./pure.js";
import {
  workflowKey,
  workflowNameFromKey,
  WORKFLOW_KINDS,
  WORKFLOW_NAMESPACE,
  WORKFLOW_BOUNDS,
  validateWorkflow,
  workflowRunPlan,
  runPipelineWorkflow,
  createWorkflowPipelineDispatcher,
} from "./workflows.js";
import { capLog } from "./cap-log.js";
import { perfSpan } from "./cap-perf.js";
import { maskCredentialShapes } from "./error-report.js";
import { isToolResultFailure, toolResultFullJson } from "./tool-summary.js";
import { correctUnsupportedMutationClaims } from "./mutation-claim-check.js";
import { RUN_BUDGET_DEFAULTS, budgetExhaustedVerdict, continuationStopDecision, isSilentIteration } from "./run-budget.js";
import { createRunDigest } from "./run-digest.js";
import {
  anthropicAuthoritativeSearchRequests,
  createAnthropicCallReconciler,
  groundingFromProviderMetadata,
  injectLatchedServerTools,
  normalizeAnthropicWebSearchPart,
} from "./provider-server-tools.js";
import {
  createLazyProviderToolset,
  executableBrowserToolRecords,
  executableBuiltinToolRecords,
  executableManagementToolRecords,
} from "./lazy-tool-protocol.js";
import { acceptsImageToolResults } from "./provider.js";

const modelLog = capLog("model");

// CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01: the LAST provider HTTP failure seen
// by the model wrapper. The AI SDK turns a rejected doStream into an empty
// stream and then throws AI_NoOutputGeneratedError (no status on it), so the
// run's catch site would otherwise report a 401/429/400 as "returned no
// content". The wrapper records the status + a secret-safe message here; a
// successful attempt clears it; the run's catch takes it via
// takeLastProviderError() and passes it to describeError as `providerError`.
// Never the key, the URL, or the request body.
let lastProviderError = null;
function recordProviderError(err, method) {
  const status = Number(err?.statusCode ?? err?.status ?? err?.cause?.statusCode ?? NaN);
  if (!Number.isFinite(status) || status < 400) return;
  let message = "";
  const body = err?.responseBody ?? err?.data?.responseBody ?? "";
  if (typeof body === "string" && body) {
    try {
      const j = JSON.parse(body);
      message = String(j?.error?.message || j?.message || j?.error?.code || j?.code || "");
    } catch { message = body.slice(0, 300); }
  }
  if (!message) message = String(err?.message ?? "");
  lastProviderError = {
    status,
    message: maskCredentialShapes(safeProviderError(message)).slice(0, 300),
    method: String(method ?? ""),
    at: Date.now(),
  };
}
/** Return and clear the last recorded provider HTTP failure (or null). */
export function takeLastProviderError() {
  const e = lastProviderError;
  lastProviderError = null;
  return e;
}
/** agent-do lifecycle logger (CAP-FB-20260826-AGENT-DO-LIFECYCLE-LOG-01): the
 * full run lifecycle is visible in the logs at the VERBOSE level (debug
 * builds default verbose; store builds default off — the cap-log gate owns
 * the default). REDACTION: only step indices, durations, tool NAMES,
 * ok/error, and token counts — NEVER prompts, page content, tool args, or
 * tool results. */
const agentDoLog = capLog("agent-do");

// The default system prompt = the versioned worker base (cap.worker.base) +
// the immutable protected constraints, composed by the SINGLE composition
// authority (lib/system-prompts.js). The service worker passes fully-composed
// prompts (with any owner override applied); this baseline is the fallback when
// no composed prompt is supplied (tests, direct lib use).
const DEFAULT_SYSTEM = baselineSystemPrompt("cap.worker.base");

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

// The lazy execute_tool envelope: { ok, selectedTool, result, … } — found as a
// direct object, inside an agent-do {modelContent} wrapper, or as a raw JSON
// string. Returns the envelope object or null for a non-lazy result.
function lazyEnvelope(result) {
  if (typeof ownData(result, "selectedTool") === "string") return result;
  for (const candidate of [ownData(result, "modelContent"), result]) {
    if (typeof candidate !== "string" || candidate.length > 128 * 1024) continue;
    const s = candidate.trim();
    if (!s.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(s);
      if (typeof ownData(parsed, "selectedTool") === "string") return parsed;
    } catch { /* not a lazy envelope */ }
  }
  return null;
}

function selectedToolFromResult(result) {
  const env = lazyEnvelope(result);
  const selected = env ? ownData(env, "selectedTool") : null;
  return typeof selected === "string" ? selected : null;
}

/** Extract a run-originated structured permission denial from agent-do's
 * normalized result, including the lazy execute_tool envelope. */
export function permissionDenialFromToolResult(result) {
  const env = lazyEnvelope(result);
  const candidates = [ownData(env, "result"), ownData(result, "data"), result];
  for (const candidate of candidates) {
    if (ownData(candidate, "waitingForPermission") === true && ownData(candidate, "permissionRequirement")) {
      return candidate;
    }
  }
  return null;
}

// Whether a lazy envelope's NESTED selected-tool result failed. The outer
// dispatch wraps every non-throwing dispatch as { ok:true, selectedTool,
// result } — a denied/failed real tool arrives as outer ok:true with an inner
// { ok:false, error }, and must NOT count as a successful mutation.
function lazyNestedFailure(result) {
  const env = lazyEnvelope(result);
  if (!env) return false;
  const nested = ownData(env, "result");
  if (nested === undefined || nested === null) return false;
  return isToolResultFailure(nested);
}

/** Extract the EXACT system message a provider/model adapter is about to
 * receive (AI-SDK LanguageModel options carry it either as `system` or as
 * role:"system" prompt messages). This is the attestation boundary: what is
 * captured here is byte-for-byte what crosses to the provider. */
export function extractBoundSystemMessage(options) {
  if (typeof options?.system === "string" && options.system) return options.system;
  const msgs = Array.isArray(options?.prompt) ? options.prompt : [];
  return msgs
    .filter((m) => m?.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => p?.text ?? "").join("")
          : ""
    )
    .join("\n");
}

/**
 * The SINGLE typed abort error for the tool/delegation boundary. Every abort
 * shape — the initial run fence, a pre-start disposable worker, or a mid-run
 * controller abort — throws THIS type, so the AI SDK emits a real tool-error
 * and an abort can never masquerade as a successful {error} tool-result.
 */
export class RunAbortedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunAbortedError";
  }
}

/** A single abort predicate: true for EVERY abort-shaped outcome (a typed
 * RunAbortedError, an {error: 'run aborted…'} return, or {aborted:true}). */
export function isAbortShape(value) {
  if (value instanceof RunAbortedError) return true;
  if (value && typeof value === "object") {
    if (value.aborted === true) return true;
    if (typeof value.error === "string" && /^run aborted|abort/.test(value.error)) return true;
  }
  return false;
}

// The skill_read DEFAULT page size. Pagination (offset/limit +
// `truncated`/`nextOffset`) is a feature, not a ceiling (dptw): a caller may
// request any limit and receives exactly that window, whole.
const SKILL_READ_LIMIT = 16 * 1024;

/**
 * The skill_read tool: on-demand loader for large / multi-file imported
 * skills. Reads the SKILL.md body or any stored file, bounded per read, with
 * honest pagination. Results are tagged untrusted (imported skill content is
 * foreign data — the lazy projection wraps it in the run's untrusted
 * boundary, lib/untrusted-fence.js). Read-only, path-confined to the skill's
 * own files — never the filesystem.
 *
 * @param {object|function} skillStore either:
 *   - an object { list: async () => importedSkillIndexRows, read: async (id, path) => text }
 *     (the production wiring: index rows in memory, bodies in OPFS), or
 *   - a function async () => full skill records with a `files` map
 *     (legacy/test shape — the read falls back to the record's files map).
 */
export function skillReadToolset(skillStore = null) {
  if (!skillStore) return {};
  const listFn = typeof skillStore === "function" ? skillStore : skillStore.list;
  const readFn = typeof skillStore === "function" ? null : (skillStore.read ?? null);
  return {
    skill_read: tool({
      description:
        "Read an imported skill's SKILL.md body or one of its files. A large skill's body is NOT composed into the system prompt; call this to load the body or a supporting file (scripts/, references/) on demand. Args: skill (the /skill: id), path (default SKILL.md), offset+limit for pagination. Returns the text chunk with totalBytes and nextOffset when more remains.",
      inputSchema: z.object({
        skill: z.string().min(1),
        path: z.string().min(1).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).optional(),
      }),
      execute: async ({ skill, path = "SKILL.md", offset = 0, limit = SKILL_READ_LIMIT }) => {
        const rawKey = String(path ?? "SKILL.md");
        // Path safety at the tool boundary (the file store re-validates, but
        // the model is a hostile caller): no leading slash, no `..`, no
        // backslash, no NUL.
        if (!rawKey || rawKey.includes("\\") || rawKey.includes("\u0000") ||
            rawKey.split("/").some((seg) => seg === ".." || seg === "") || rawKey.startsWith("/")) {
          return { untrusted: true, ok: false, error: `skill file path is not safe: "${rawKey}"` };
        }
        const key = rawKey;
        let list = [];
        try { list = (await listFn()) ?? []; } catch { /* store read failed */ }
        const rec = (Array.isArray(list) ? list : []).find((s) => s?.id === String(skill));
        if (!rec) return { untrusted: true, ok: false, error: `no imported skill "${skill}"` };
        let text = null;
        if (readFn) {
          try {
            text = await readFn(String(skill), key);
          } catch {
            text = null;
          }
        } else {
          const files =
            rec.files && typeof rec.files === "object"
              ? rec.files
              : { "SKILL.md": rec.prompt ?? "" };
          text = typeof files[key] === "string" ? files[key] : null;
        }
        if (text === null) {
          return { untrusted: true, ok: false, error: `skill "${skill}" has no file "${key}"` };
        }
        // Pagination operates on UTF-8 BYTES (the documented unit of the
        // bounds and offsets): encode once, slice bytes, decode with
        // replacement — a multi-byte char split at a boundary reads as U+FFFD
        // (honest, never a silent offset drift). UTF-16 string slicing would
        // mis-count non-ASCII content (emoji/CJK) and overlap/gap pages.
        const encoded = new TextEncoder().encode(text);
        const startByte = Math.max(0, Number(offset) || 0);
        const endByte = Math.min(encoded.length, startByte + limit);
        const chunkBytes = encoded.slice(startByte, endByte);
        const chunk = new TextDecoder().decode(chunkBytes);
        const more = endByte < encoded.length;
        return {
          untrusted: true,
          ok: true,
          skill: String(skill),
          path: key,
          offset: startByte,
          bytes: chunkBytes.length,
          totalBytes: encoded.length,
          truncated: more,
          nextOffset: more ? endByte : null,
          text: chunk,
        };
      },
    }),
  };
}

export function memoryToolset(memory, enrollmentGuard = null, getRunGen = null, readOnly = false) {
  if (!memory) return {};
  // Reads must be ENROLLMENT-scoped too (the round-24/25 finding: memory_get/
  // memory_list were completely unfenced, so a stale deleted worker could read a
  // re-enrolled origin's memory through the reused origin path). Return an error
  // instead of the value when the run-start generation no longer matches the
  // current enrollment.
  const enrolledGuard = async () => {
    if (!enrollmentGuard) return null;
    const g = await enrollmentGuard();
    const runGen = getRunGen?.() ?? null;
    if (!g?.ok) return { error: g?.error ?? "origin not enrolled" };
    if (runGen != null && (g.gen ?? 0) !== runGen) {
      return { error: "origin re-enrolled during run — memory read rejected" };
    }
    return null;
  };
  const tools = {
    memory_get: tool({
      description: "Read a value from the agent's memory.",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        if (/^(?:__gen|__tx|__wal|__epoch|__tombs|assets|assetRepair|asset:|profile:|profile$|cap:board-)/.test(String(key ?? ""))) {
          return { key, value: undefined, error: `key "${key}" is reserved` };
        }
        const err = await enrolledGuard();
        if (err) return err;
        const value = await memory.get(key);
        // POST-read generation revalidation (the round-26 blocker): a re-enroll
        // DURING the awaited read must not return the NEW enrollment's data to
        // the stale run. Read into a temp, revalidate the immutable generation,
        // then return — never surface a value read under a fresh enrollment.
        const err2 = await enrolledGuard();
        if (err2) return err2;
        return { key, value };
      },
    }),
    memory_set: tool({
      description:
        "Write a value to the agent's memory. Values are bounded (256 KiB) and reserved registry keys are protected.",
      inputSchema: z.object({ key: z.string().min(1), value: z.any() }),
      execute: async ({ key, value }) => {
        // The workflows: namespace is OWNED by save_workflow (its records carry
        // save-time validation that memory_set cannot reproduce — a forged
        // oversized workflows:* record would otherwise bypass the 64 KiB
        // workflow bound up to the store's 256 KiB limit and reach workflow_run).
        // Refuse honestly instead of silently shadowing save_workflow.
        if (String(key ?? "").startsWith(WORKFLOW_NAMESPACE)) {
          return { ok: false, error: `key "${key}" is reserved — save and manage workflows with save_workflow/workflow_get, never memory_set` };
        }
        // memory_set is a durable side-effecting boundary — fence it BEFORE the
        // write (the round-16 fence coverage finding) AND AFTER the awaited OPFS
        // write (the round-18 finding). On abort AFTER a committed overwrite,
        // RESTORE the previous value (or delete a newly-created key) — never
        // delete an existing key wholesale (the round-19 blocker: an overwrite
        // abort deleted the ENTIRE prior key).
        // DUrable ownership must be asserted BEFORE the write (not merely the
        // signal) — the round-20 blocker where a memory_set ownership-only loss
        // threw while the signal was still live and the catch did NOT compensate.
        try {
          await assertRunOwned();
          // A WORKER's memory write must revalidate the IMMUTABLE run-start
          // generation — NOT merely "currently enrolled" (the round-22 ABA
          // blocker: delete→re-enroll bumps the generation, so a stale run whose
          // guard re-reads "currently enrolled" would pass and write into the
          // NEW enrollment). The guard returns {ok, gen}; the run captured its
          // generation at START (getRunGen), so a re-enrolled origin's fresh gen
          // mismatches and the write is rejected.
          if (enrollmentGuard) {
            const g = await enrollmentGuard();
            const runGen = getRunGen?.() ?? null;
            if (!g?.ok) {
              return { error: g?.error ?? "origin not enrolled — memory not written" };
            }
            if (runGen != null && (g.gen ?? 0) !== runGen) {
              return { error: "origin re-enrolled during run — memory not written" };
            }
          }
        } catch {
          return { error: "run aborted — memory not written" };
        }
        let prev = undefined;
        let existed = false;
        let committed = false;
        let wroteVersion = null; // the durable version token `set` returns (round-27)
        try {
          // Existence must be checked via `has`, NOT via `get` returning
          // non-null: a legitimate stored `null` value is indistinguishable from
          // an absent key through `get` alone, so the old `existed = prev !==
          // undefined && prev !== null` classified a stored null as absent and
          // DELETED it on compensation (the round-22 null-compensation bug).
          existed = typeof memory.has === "function"
            ? await memory.has(key)
            : (await memory.get(key)) !== undefined;
          prev = await memory.get(key);
          await assertRunOwned();
          // Re-validate the IMMUTABLE run-start generation IMMEDIATELY before
          // the write (adjacent to set): the gen check at the top ran several
          // awaits ago (memory.has + memory.get), and a delete→re-enroll in that
          // gap would otherwise let a stale run write under the NEW enrollment
          // (the round-23 gen-adjacency finding — the gen was checked only before
          // has/get, not adjacent to set).
          if (enrollmentGuard) {
            const g = await enrollmentGuard();
            const runGen = getRunGen?.() ?? null;
            if (!g?.ok) {
              return { error: g?.error ?? "origin not enrolled — memory not written" };
            }
            if (runGen != null && (g.gen ?? 0) !== runGen) {
              return { error: "origin re-enrolled during run — memory not written" };
            }
          }
          // `set` returns the durable VERSION token for THIS write (the round-27
          // value-CAS ABA blocker). Capture it directly (not via a separate
          // getVersion read, which could observe a later concurrent write's
          // version). Compensation below targets this exact write.
          wroteVersion = await memory.set(key, value);
          committed = true;
          await assertRunOwned();
          // Re-validate the IMMUTABLE run-start generation AFTER the awaited set:
          // the gen check above ran BEFORE the OPFS write, so a delete→re-enroll
          // DURING the write would otherwise leave stale data committed under the
          // NEW enrollment (the round-24 gen-threading blocker — the gen was
          // checked adjacent to `set`, never AFTER it). A mismatch here throws so
          // the catch below compensates (restores prev / deletes the new key).
          if (enrollmentGuard) {
            const g = await enrollmentGuard();
            const runGen = getRunGen?.() ?? null;
            if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) {
              throw new Error("origin re-enrolled during run — memory write compensated");
            }
          }
          return { ok: true, key };
        } catch (e) {
          // A bounded/reserved-key rejection is surfaced honestly, never thrown
          // into the agent loop. An abort/ownership loss AFTER the write (the
          // `committed` flag) compensates by restoring the prior value (or removing
          // a new key), not deleting an existing key's history. Ownership-only loss
          // (durable owner gone while the signal is still live) is compensated here
          // too — `committed` is set on ANY post-write fence failure, not just a
          // signal abort (the round-20 finding).
          //
          // Compensation must be ENROLLMENT-GENERATION-scoped (the round-25
          // blocker): only restore the previous value when the origin is STILL the
          // SAME enrollment (same run-start generation). A delete→re-enroll during
          // the awaited write means the NEW enrollment owns the store, and a stale
          // run must NOT overwrite/delete the new value.
          if (committed && typeof memory.set === "function") {
            try {
              let sameEnrollment = true;
              if (enrollmentGuard) {
                const g = await enrollmentGuard();
                const runGen = getRunGen?.() ?? null;
                if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) {
                  sameEnrollment = false;
                }
              }
              const casDelete = typeof memory.compareAndDelete === "function";
              const casRestore = typeof memory.compareAndRestore === "function";
              if (sameEnrollment) {
                // VERSION-scoped CAS restore (the round-26/27 blockers): only
                // restore/delete if the key's CURRENT VERSION is still the version
                // THIS run wrote — a concurrent legitimate write by the SAME
                // enrollment (a parallel tool call in the same run) bumps the
                // version, so it is never clobbered, and an identical-value ABA
                // (a new write of the same JSON value) is distinguished by its
                // version. `wroteVersion` is the token `set` returned.
                if (existed) {
                  if (casRestore && wroteVersion != null) await memory.compareAndRestore(key, wroteVersion, prev);
                  else await memory.set(key, prev);
                } else {
                  if (casDelete && wroteVersion != null) await memory.compareAndDelete(key, wroteVersion);
                  else await memory.delete(key);
                }
              } else {
                // Generation mismatch (delete→re-enroll): REMOVE this run's
                // forbidden write from the NEW reused store via VERSION-scoped CAS
                // (only if the version is still this write's). Never restore the
                // OLD enrollment's `prev` into the new store, and never delete a
                // new-enrollment value that already replaced ours (the round-26/27
                // stale-write-survives-re-enrollment + value-CAS blockers).
                if (casDelete && wroteVersion != null) await memory.compareAndDelete(key, wroteVersion);
                else await memory.delete(key);
              }
            } catch { /* best-effort */ }
          }
          return { error: String(e?.message ?? e) };
        }
      },
    }),
    memory_list: tool({
      description: "List memory keys.",
      inputSchema: z.object({}),
      execute: async () => {
        const err = await enrolledGuard();
        if (err) return err;
        const keys = await memory.keys();
        // POST-read generation revalidation (the round-26 blocker): a re-enroll
        // DURING the awaited keys() read must not return the NEW enrollment's
        // keys to the stale run.
        const err2 = await enrolledGuard();
        if (err2) return err2;
        return { keys };
      },
    }),
    memory_grep: tool({
      description:
        "Search this agent's own memory (key-value store) AND run history (journal) for a substring. Returns matching keys + a bounded excerpt of each match, never the full store.",
      inputSchema: z.object({
        query: z.string().min(1).describe("the substring to search for"),
      }),
      execute: async ({ query }) => {
        const err = await enrolledGuard();
        if (err) return err;
        const result = await grepAgentMemory(memory, query);
        // POST-read generation revalidation (the sol addendum): a re-enroll
        // DURING the multi-key grep must not return the NEW enrollment's memory
        // to the stale run. Match memory_get/list — revalidate, then return.
        const err2 = await enrolledGuard();
        if (err2) return err2;
        return result;
      },
    }),
  };
  // SCOPED (hook) runs are side-effect-free: no memory_set. Untrusted event
  // data must never persist state to the hub/worker memory.
  if (readOnly) delete tools.memory_set;
  return tools;
}

/**
 * The agent's reusable-workflow tools (save_workflow / workflow_list /
 * workflow_get / workflow_run). Records live under `workflows:<name>` keys in
 * the SAME origin-keyed memory store the memory tools use (the run's own
 * store, never another origin's) and ride the same enrollment-generation +
 * read-only fencing as memoryToolset: a stale deleted worker must never write
 * into a re-enrolled origin's store, SCOPED (hook) runs must never persist
 * workflows, and reads revalidate the immutable run-start generation BEFORE
 * and AFTER the awaited store call.
 *
 * `runRoute` (optional) is the owner-approved script-js dispatcher → the SW's
 * `workflow.run` route (sandbox host), present only on real management-capable
 * runs. `pipelineDispatch` (optional) is the agent-bound dispatcher that runs
 * pipeline-kind steps through the run's live lazy catalog; both fail closed
 * with a clear message when absent.
 */

// save_workflow's count-and-create must be atomic PER STORE: the model's tool
// calls in a single step run with Promise.all, so two concurrent save_workflow
// calls for the same store could each observe 127 workflows and both commit
// 129. The store's own write mutex only wraps each individual set, never a
// count-then-create pair, so the count and the create run under a shared
// promise-chain lock. The key is the store's ORIGIN (all real stores expose
// one; every memoryStoreAt instance for the same directory shares it), falling
// back to the store object identity for anonymous test fakes.
const workflowSaveChainsByOrigin = new Map(); // origin -> tail promise
const workflowSaveChainsByIdentity = new WeakMap(); // anonymous store object -> tail promise
function withWorkflowSaveLock(store, fn) {
  if (!store || typeof store !== "object") return fn();
  const origin = typeof store.origin === "string" && store.origin ? store.origin : null;
  const chains = origin ? workflowSaveChainsByOrigin : workflowSaveChainsByIdentity;
  const key = origin ?? store;
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(key, run.then(() => {}, () => {}));
  return run;
}

export function workflowsToolset({
  memory,
  runRoute = null,
  pipelineDispatch = null,
  enrollmentGuard = null,
  getRunGen = null,
  readOnly = false,
} = {}) {
  if (!memory) return {};
  const enrolledGuard = async () => {
    if (!enrollmentGuard) return null;
    const g = await enrollmentGuard();
    const runGen = getRunGen?.() ?? null;
    if (!g?.ok) return { error: g?.error ?? "origin not enrolled" };
    if (runGen != null && (g.gen ?? 0) !== runGen) {
      return { error: "origin re-enrolled during run — workflow access rejected" };
    }
    return null;
  };
  const tools = {
    save_workflow: tool({
      description:
        "Save a reusable workflow to YOUR memory so you can run it again later: a JS script body (runs sandboxed, owner-approved), a saved tool pipeline (declarative steps of existing tools), Python source (saving only — the Python runtime is not admitted yet), or step-by-step instructions. Later runs can list (workflow_list), read (workflow_get) and run (workflow_run) it. Bounded: name <=64 chars, content <=64 KiB.",
      inputSchema: z.object({
        name: z.string().min(1).max(64).describe("a short, clear name for the workflow"),
        description: z.string().max(256).optional().describe("one line about what it does"),
        kind: z.enum(WORKFLOW_KINDS).describe("script-js | script-python | pipeline | instructions"),
        content: z.string().max(64 * 1024).describe("the workflow body (JS source, pipeline JSON, Python source, or instructions)"),
      }),
      execute: async ({ name, description, kind, content }) => {
        if (readOnly) return { ok: false, error: "workflow save is not available in this context" };
        const v = validateWorkflow({ name, description, kind, content });
        if (!v.ok) return { ok: false, error: v.error };
        const key = workflowKey(v.record.name);
        const pre = await enrolledGuard();
        if (pre) return pre;
        // The declared per-origin bound (WORKFLOW_BOUNDS.maxWorkflows) is
        // enforced HERE, on save, when the key is NEW: an overwrite of an
        // existing workflow never counts against the limit. The count and the
        // create share ONE per-store lock (withWorkflowSaveLock), so two
        // concurrent new-key saves cannot both observe 127 and commit 129.
        // The count FAILS CLOSED: when the store cannot enumerate its keys
        // the capacity is unprovable, so a NEW save is refused rather than
        // silently passing the bound (the reviewer's r3 fail-open finding).
        return await withWorkflowSaveLock(memory, async () => {
          // Durable ownership + generation fencing BEFORE the write, mirroring
          // memory_set exactly (the round-20/22/23 patterns).
          let prev = undefined;
          let existed = false;
          let committed = false;
          let wroteVersion = null;
          try {
            await assertRunOwned();
            existed = typeof memory.has === "function"
              ? await memory.has(key)
              : (await memory.get(key)) !== undefined;
            prev = await memory.get(key);
            await assertRunOwned();
            if (enrollmentGuard) {
              const g = await enrollmentGuard();
              const runGen = getRunGen?.() ?? null;
              if (!g?.ok) {
                return { error: g?.error ?? "origin not enrolled — workflow not saved" };
              }
              if (runGen != null && (g.gen ?? 0) !== runGen) {
                return { error: "origin re-enrolled during run — workflow not saved" };
              }
            }
            // NEW-key capacity proof, under the same lock as the write: an
            // overwrite never counts, so only a new key enumerates. A store
            // that cannot enumerate (no keys(), a throw, or a non-array
            // result) cannot prove the bound — fail closed, nothing written.
            if (!existed) {
              let keys = null;
              try {
                keys = typeof memory.keys === "function" ? await memory.keys() : null;
              } catch (countError) {
                return { ok: false, error: `workflow limit cannot be verified — the store could not be enumerated (${countError?.message ?? countError}); no new workflow saved` };
              }
              if (!Array.isArray(keys)) {
                return { ok: false, error: "workflow limit cannot be verified — the store cannot enumerate its keys; no new workflow saved" };
              }
              const existing = keys
                .map((k) => workflowNameFromKey(String(k)))
                .filter(Boolean).length;
              if (existing >= WORKFLOW_BOUNDS.maxWorkflows) {
                return { ok: false, error: `workflow limit reached (${WORKFLOW_BOUNDS.maxWorkflows} per origin) — no new workflow can be saved until an existing one is removed or overwritten` };
              }
            }
            wroteVersion = await memory.set(key, v.record);
            committed = true;
            // POST-write durable-ownership fence (the memory_set round-20/24
            // pattern): an abort/ownership loss DURING the awaited write must not
            // report success and must not leave this run's record committed. A
            // throw here lands in the catch below, which compensates.
            await assertRunOwned();
            if (enrollmentGuard) {
              const g = await enrollmentGuard();
              const runGen = getRunGen?.() ?? null;
              if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) {
                throw new Error("origin re-enrolled during run — workflow save compensated");
              }
            }
            return { ok: true, name: v.record.name, kind: v.record.kind };
          } catch (e) {
            // Compensation mirrors memory_set: an abort/ownership-loss AFTER the
            // write restores the PRIOR record (a same-name overwrite) or removes
            // the NEW key — never deletes an existing key wholesale. The restore
            // is version-scoped CAS when the store offers it (a concurrent write
            // of the SAME key by the same enrollment is never clobbered), and
            // enrollment-scoped: a delete→re-enroll means the NEW enrollment owns
            // the store, so only THIS write (CAS by version) is ever removed.
            if (committed && typeof memory.set === "function") {
              try {
                let sameEnrollment = true;
                if (enrollmentGuard) {
                  const g = await enrollmentGuard();
                  const runGen = getRunGen?.() ?? null;
                  if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) {
                    sameEnrollment = false;
                  }
                }
                const casDelete = typeof memory.compareAndDelete === "function";
                const casRestore = typeof memory.compareAndRestore === "function";
                if (sameEnrollment) {
                  if (existed) {
                    if (casRestore && wroteVersion != null) await memory.compareAndRestore(key, wroteVersion, prev);
                    else await memory.set(key, prev);
                  } else {
                    if (casDelete && wroteVersion != null) await memory.compareAndDelete(key, wroteVersion);
                    else await memory.delete(key);
                  }
                } else {
                  if (casDelete && wroteVersion != null) await memory.compareAndDelete(key, wroteVersion);
                  else await memory.delete(key);
                }
              } catch { /* best-effort */ }
            }
            const aborted = /abort|re-?enroll/i.test(String(e?.message ?? e));
            return aborted
              ? { error: String(e?.message ?? e) }
              : { ok: false, error: `workflow save failed: ${e?.message ?? e}` };
          }
        });
      },
    }),
    workflow_list: tool({
      description:
        "List YOUR saved workflows (name, kind, description only — never the full body). Memory recall: the same workflows: keys also appear in your run-time memory digest and in memory_list/memory_grep results.",
      inputSchema: z.object({}),
      execute: async () => {
        const pre = await enrolledGuard();
        if (pre) return pre;
        let keys = [];
        try {
          keys = typeof memory.keys === "function" ? await memory.keys() : [];
        } catch { /* best-effort */ }
        const names = (Array.isArray(keys) ? keys : [])
          .map((k) => workflowNameFromKey(String(k)))
          .filter(Boolean)
          .slice(0, 128);
        const workflows = [];
        for (const wfName of names) {
          try {
            const rec = await memory.get(workflowKey(wfName));
            if (rec && typeof rec === "object" && typeof rec.name === "string") {
              workflows.push({ name: rec.name, kind: String(rec.kind ?? ""), description: String(rec.description ?? "") });
            }
          } catch { /* skip unreadable */ }
        }
        const post = await enrolledGuard();
        if (post) return post;
        return { ok: true, workflows };
      },
    }),
    workflow_get: tool({
      description: "Read ONE of YOUR saved workflows in full (name, kind, description, content).",
      inputSchema: z.object({ name: z.string().min(1).max(64) }),
      execute: async ({ name }) => {
        const pre = await enrolledGuard();
        if (pre) return pre;
        let rec = null;
        try {
          rec = await memory.get(workflowKey(name));
        } catch { /* absent */ }
        const post = await enrolledGuard();
        if (post) return post;
        if (!rec || typeof rec !== "object" || typeof rec.name !== "string") {
          return { ok: false, error: `workflow "${String(name).slice(0, 64)}" not found` };
        }
        return { ok: true, workflow: rec };
      },
    }),
    workflow_run: tool({
      description:
        "Run ONE of YOUR saved workflows NOW. script-js workflows run sandboxed (no DOM/extension/network of its own; fetch is host-listed) and REQUIRE OWNER APPROVAL like run_script. pipeline workflows run their declared steps through your live tools, each step keeping its own gates; a step that would need an owner approval card fails closed naming the tool. script-python/instructions kinds fail closed with a clear message.",
      inputSchema: z.object({ name: z.string().min(1).max(64) }),
      execute: async ({ name }) => {
        const wfName = String(name ?? "").slice(0, 64);
        const pre = await enrolledGuard();
        if (pre) return pre;
        let rec = null;
        try {
          rec = await memory.get(workflowKey(wfName));
        } catch { /* absent */ }
        const post = await enrolledGuard();
        if (post) return post;
        if (!rec || typeof rec !== "object" || typeof rec.name !== "string") {
          return { ok: false, error: `workflow "${wfName}" not found` };
        }
        const plan = workflowRunPlan(rec);
        if (!plan.ok) return plan;
        if (plan.mode === "script-js") {
          if (typeof runRoute !== "function") {
            return { ok: false, error: "workflow run is not available in this context" };
          }
          return await runRoute({
            name: rec.name,
            kind: String(rec.kind ?? ""),
            source: String(rec.content ?? ""),
            description: String(rec.description ?? ""),
          });
        }
        if (plan.mode === "pipeline") {
          if (typeof pipelineDispatch !== "function") {
            return { ok: false, error: "workflow run is not available in this context" };
          }
          return await runPipelineWorkflow({
            name: rec.name,
            kind: String(rec.kind ?? ""),
            content: String(rec.content ?? ""),
            dispatchStep: pipelineDispatch,
          });
        }
        return plan;
      },
    }),
  };
  return tools;
}

/**
 * Wrap agent-do's createAgent with our conventions.
 * `model` is the resolved { model: LanguageModel, modelId, providerName } from provider.js.
 */
// A safe, bounded summary of a tool result for the LIVE progress stream's LIST
// surfaces (the 300-char `result`). The COMPLETE result rides beside it as
// `resultFull` — decoded, redacted and byte-bounded to 64 KiB by
// toolResultFullJson (CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01): this summary
// used to be the ONLY copy, so the card, the run log and the reopened thread
// could never show what a tool returned.
function summarizeToolResult(result) {
  try {
    if (result == null) return "";
    if (typeof result === "string") return result.slice(0, 300);
    const s = JSON.stringify(result);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return "(unserializable result)";
  }
}

// The run's step budget (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01) — the
// defaults and every bound live in lib/run-budget.js; re-exported here for
// the callers that size a run.
export { RUN_BUDGET_DEFAULTS };

/** A tool's raw return as the model-facing text agent-do itself would have
 * produced for it (its normaliser JSON-stringifies non-string returns). */
function summarizeForModel(result) {
  if (typeof result === "string") return result;
  try {
    const s = JSON.stringify(result);
    if (typeof s === "string") return s;
  } catch { /* fall through */ }
  return String(result);
}

export function createAgent({
  model,
  id = "hub",
  name = "hub",
  system = DEFAULT_SYSTEM,
  tools = {},
  memory = null,
  skills = [],
  taskId = "adhoc",
  maxIterations = RUN_BUDGET_DEFAULTS.maxIterations,
  iterationGuard = null,
  enrollmentGuard = null,
  // `onProgress` receives normalized progress events (thinking / tool-call /
  // tool-result / text / done) from the agent-do loop, so the UI can show LIVE
  // progress as the agent works. Optional (the SW threads its broadcast through
  // it); null means no progress stream (the legacy request/response path).
  onProgress = null,
  // Run-originated permission/grant requests block inside agent-do's awaited
  // post-tool hook until the originating surface resolves them.
  onPermissionRequest = null,
  // `disposable` marks a per-origin WORKER agent: abort() (agent.delete →
  // abortWorker) permanently disables it so a stale in-flight delegation can
  // never start a new run (the round-22 check→start blocker). The hub/master is
  // NOT disposable — its abort() cancels the current run only, and it is reused
  // across subsequent runs.
  disposable = false,
  // `readOnlyMemory` (SCOPED hook runs): memory_set is omitted — untrusted
  // event data must never persist state.
  readOnlyMemory = false,
  // The owner-approved script-js run dispatcher for saved workflows → the
  // service worker's `workflow.run` route (sandboxed host + approval card,
  // mirroring script.run). Absent (workers, SCOPED hook runs) → workflow_run
  // fails closed with a clear message for script-js workflows.
  workflowRunRoute = null,
  // The imported-skills store reader: async () => importedSkillRecords. When
  // present, the agent gets the `skill_read` tool — on-demand loading of a
  // large/multi-file imported skill's SKILL.md body or any stored file
  // (CAP-FB-20260830-SKILLS-UNCAPPED-01). Absent → no skill_read tool.
  skillStore = null,
  // Additional LIVE source records (WebMCP, Chrome/management, bundled
  // catalog-only rows). Called for every search and every execute fence.
  readLazySources = async () => [],
  // Dynamic scope/document fence reader. The active run identity is merged
  // after this result, so a source can never replace run/task/agent identity.
  readLazyScope = async () => ({}),
  // Provider-server tooling (extension/lib/provider-server-tools.js): the
  // per-build latch registry + a sink for grounding metadata harvested from
  // the provider stream. Absent → no provider-tool injection, no harvesting.
  serverTooling = null,
  // The per-assembly boundary token for untrusted tool results (the SAME token
  // the composed `system` names in its protected policy layer — runtime-
  // context.js mints it). Rides the lazy run context so the projection fences
  // page/site/board content with a boundary the model can verify.
  untrustedToken = null,
}) {
  // The worker's immutable run identity, captured at run START. Because master
  // runs are serialized (withRunLock), at most one run is active per agent, so a
  // single slot is safe. `gen` is the enrollment generation the CALLER captured
  // at delegation start (or, for a direct run, captured here) — every worker
  // commit revalidates THAT generation, never "currently enrolled" (the round-22
  // ABA blocker).
  let activeRun = null; // { gen, controller, identity:{runId,taskId,...} }
  // The IMMUTABLE usage-attempt identity: a FIFO queue of { id, occurredAt,
  // ordinal } pushed at the provider-attempt invocation boundary (doGenerate/
  // doStream) and consumed by onUsage. Agent-do dispatches ALL onUsage records
  // AFTER the stream iteration, so a shared latest-attempt scalar would misattribute
  // delayed callbacks; the queue binds each onUsage to ITS attempt.
  const attemptQueue = [];
  let attemptOrdinal = 0;
  let aborted = false;
  let lastRunAborted = false; // the DURABLE per-run abort flag (read after activeRun is cleared)
  // A per-worker RUN QUEUE serializes concurrent `a.run` calls. The AI SDK
  // executes a step's tool calls with Promise.all, so two delegate_task calls
  // for the SAME worker can invoke the same a.run CONCURRENTLY. The shared
  // `activeRun` slot + agent-do's single mutable abort controller are unsafe
  // under concurrency (the second run overwrites the first's identity; the first
  // `finally` clears the second's; abort() only reaches whichever controller is
  // currently stored) — the round-23 parallel-tool-call blocker. Queuing each
  // run behind the prior guarantees at most one run is active at a time, so the
  // shared slot + controller are always the CURRENT run's.
  let runQueue = Promise.resolve();
  // The progress callback is MUTABLE: the orchestrator (and its cached agents)
  // are REUSED across runs, but the callback is per-run (each run's caller is
  // the page that started it). The hooks below read this binding at emit time,
  // so a later run's setProgress() rebinds the LIVE stream without rebuilding
  // the cached agent.
  let progressCb = onProgress;

  const getRunGen = () => activeRun?.gen ?? null;
  // The agent-bound pipeline-step dispatcher for pipeline-kind workflows
  // (CAP-FB-20260902-WORKFLOWS-TO-MEMORY): bound once `lazy` exists below — it
  // dispatches every step through the run's LIVE lazy catalog, so the tools
  // map is created before `lazy`, but executes only at run time (after the
  // binding is set).
  let livePipelineStepDispatch = null;

  // The RUN-BOUND prompt attestation sink (mutable per run — the orchestrator
  // is cached across runs, so the SW rebinds this per run like setProgress).
  // The wrapped model below captures the EXACT system message observed at the
  // provider/model boundary and reports a content-free attestation: the
  // SHA-256 digest + UTF-8 byte count of the exact wire message, the digest of
  // the platform composition this agent was built with, whether the wire
  // message begins byte-for-byte with that composition (agent-do appends its
  // own fixed loop-instruction + the run context AFTER it), and the
  // provider/model identity. NO prompt content crosses the sink.
  let attestationCb = null;
  let lastAttestedDigest = null; // dedupe: the system message is stable per run
  // The ACTIVE run's full system prompt (the construction composition plus any
  // per-run skills inserted before the protected block). Runs of an agent are
  // serialized (the per-worker runQueue / the SW runMutex), so this mutable
  // binding always names the CURRENT run's composition — the attestation
  // compares the wire message against EXACTLY what this run was built with.
  let activeSystemPrompt = null;
  const emitAttestation = (options) => {
    if (!attestationCb) return;
    try {
      const sent = extractBoundSystemMessage(options);
      if (!sent) return;
      const digest = sha256Hex(sent);
      if (digest === lastAttestedDigest) return;
      lastAttestedDigest = digest;
      const composed = activeSystemPrompt ?? systemPrompt;
      attestationCb({
        agentId: id,
        provider: model.providerName,
        model: model.modelId,
        // The exact provider-bound system message (digest + bytes only).
        digest,
        bytes: utf8ByteLength(sent),
        // The platform composition this run was built with, and whether the
        // wire message EMBEDS it byte-for-byte as its prefix.
        composedDigest: sha256Hex(composed),
        composedBytes: utf8ByteLength(composed),
        prefixMatch: sent.startsWith(composed),
        at: Date.now(),
      });
    } catch { /* attestation is telemetry — never break a run */ }
  };
  // Wrap the LanguageModel with a Proxy so doGenerate/doStream are observed at
  // the provider boundary (prototype methods + every other property untouched).
  // Each attempt's identity entry is REMOVED when the attempt FAILS (a sync
  // throw OR an async rejection): the AI SDK internally retries a retryable
  // doStream/doGenerate (attempt 1 fails, attempt 2 succeeds), so a blind FIFO
  // would let a failed attempt's id leak into the next attempt's onUsage (the
  // reviewer's within-run retry finding).
  // Harvest provider-side grounding (citations + executed search queries) from
  // a model call result WITHOUT touching the payload the agent loop consumes:
  // doStream's ReadableStream is tee'd (the agent gets one branch; we observe
  // the other), doGenerate's providerMetadata is read directly. Observations
  // flow to serverTooling.onGrounding(runId, normalized) for the thread's
  // citation rendering + the usage ledger. Observation NEVER breaks a run.
  const harvestGrounding = (value, runId) => {
    const onGrounding = serverTooling?.onGrounding;
    if (typeof onGrounding !== "function" || !runId) return value;
    try {
      if (value && typeof value === "object" && value.stream instanceof ReadableStream) {
        const [consumed, observed] = value.stream.tee();
        (async () => {
          // Per-CALL reconciliation (the round-2 review): Anthropic's
          // authoritative usage counter applies to THIS call only — the run
          // total is the sum of per-call (authoritative ?? observed).
          const reconciler = createAnthropicCallReconciler();
          const reader = observed.getReader();
          try {
            for (;;) {
              const { done, value: part } = await reader.read();
              if (done) break;
              const metadata = ownData(part, "providerMetadata");
              const grounding = groundingFromProviderMetadata(metadata);
              if (grounding) {
                try { onGrounding(runId, grounding); } catch { /* telemetry */ }
              }
              reconciler.setAuthoritative(anthropicAuthoritativeSearchRequests(metadata));
              reconciler.addPart(normalizeAnthropicWebSearchPart(part));
            }
          } catch { /* observation failure must not reach the run */ } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
            if (reconciler.seen) {
              try { onGrounding(runId, reconciler.flush()); } catch { /* telemetry */ }
            }
          }
        })();
        return { ...value, stream: consumed };
      }
      const grounding = groundingFromProviderMetadata(ownData(value, "providerMetadata"));
      if (grounding) {
        try { onGrounding(runId, grounding); } catch { /* telemetry */ }
      }
      // doGenerate carries Anthropic server-tool observations in the content
      // array (same part shapes as the stream) plus the authoritative counter
      // in the result's providerMetadata.anthropic.usage — one call, one
      // reconciliation.
      const reconciler = createAnthropicCallReconciler();
      reconciler.setAuthoritative(anthropicAuthoritativeSearchRequests(ownData(value, "providerMetadata")));
      const content = Array.isArray(ownData(value, "content")) ? value.content : [];
      for (const part of content) {
        reconciler.addPart(normalizeAnthropicWebSearchPart(part));
      }
      if (reconciler.seen) {
        try { onGrounding(runId, reconciler.flush()); } catch { /* telemetry */ }
      }
    } catch { /* telemetry must never break a model call */ }
    return value;
  };

  // TEXT STREAMING (CAP-FB-20260830-TRANSCRIPT-STREAMING-01): every doStream
  // is tee'd a second time and its text-delta parts are forwarded to the
  // progress callback as bounded `text-delta` events (coalesced ~50 ms / 8 KiB,
  // the first delta at once) so the transcript grows while the model is still
  // answering. Attributed to the step that onStepStart announced; a step the
  // run-text tracker flags as the likely hidden nudge reply is NOT streamed
  // (its text lands — or is hidden — at step end exactly as before). The
  // durable log never sees a delta: only the step's final `text` event is
  // persisted. Each attempt's first flush carries `start:true` so a
  // within-run retry restarts the bubble instead of appending to a failed
  // attempt's partial text.
  let streamStep = -1;
  let streamHold = false;
  let streamDrain = Promise.resolve();

  // THE VISIBLE BUDGET (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01): one model
  // call = one step. Counted at the provider boundary (the Proxy below), so
  // the count is exact — a failed attempt that the SDK retries is dropped
  // again. `budgetTotal` = maxIterations × innerStepLimit; every model call
  // emits {type:"budget", step, total} so the surface shows "Step N of M".
  const innerStepLimit = RUN_BUDGET_DEFAULTS.innerStepLimit(maxIterations);
  const budgetTotal = Math.max(1, Math.trunc(maxIterations)) * innerStepLimit;
  let budgetStep = 0;
  let budgetLastStepHadTools = false;
  let budgetLastStepIndex = -1;
  // THE RUNNING DIGEST (CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01): agent-do keeps
  // only the last step of an inner turn in its history (lib/run-digest.js
  // explains why), so every tool result is digested as it lands and each
  // turn's digest rides agent-do's own continuation message at the provider
  // boundary — bounded, redacted, fenced with the run's untrusted token. The
  // running counts ride every budget event so the status row can show them.
  const runDigest = createRunDigest({ token: untrustedToken });
  let currentOuterStep = 0;
  let digestTurnsLogged = 0;
  let digestBytesMax = 0;
  const emitBudget = (extra = {}) => {
    try { progressCb?.({ type: "budget", step: budgetStep, total: budgetTotal, results: runDigest.counts(), ...extra }); } catch { /* ignore */ }
  };
  // THE CONTINUATION ECONOMY (CAP-FB-20260830-MODEL-CALL-ECONOMY-01): agent-do
  // sends "Continue working on the task…" after ANY outer iteration that
  // called tools — even one that already ended in the model's final answer,
  // where the extra call (the whole transcript again) can only produce a
  // repeat. The stop is agent-do's own `onStepStart → {decision:"stop"}` hook
  // (lib/run-budget.js `continuationStopDecision` holds the rule):
  //   - the previous iteration called tools AND wrote its answer AND its last
  //     model call finished on its own (not on the inner step limit, which
  //     finishes "tool-calls" with work still queued) → no continuation call;
  //   - CONTINUATION_SILENT_CAP consecutive iterations that called tools and
  //     then ended in silence (no text, finished on their own) → stop, with a
  //     visible {type:"stopped"} event and a stop verdict on `done` — a model
  //     answering every nudge with the same tool call is looping, not working.
  // A continuation that DOES go out still carries the run digest above; the
  // inner-step-limit boundary the digest exists for is untouched.
  // Did the previous iteration end with work still queued? TWO signals, because
  // one of them is not always available in time: the provider-boundary finish
  // reason ("tool-calls" = the inner step limit cut the iteration off, not the
  // model), observed from the tee'd stream and therefore subject to the same
  // bounded drain race as the text deltas; and the EXACT count of model calls
  // the iteration made, which is synchronous. An iteration that consumed the
  // whole innerStepLimit hit the inner cap by definition — that is a boundary
  // whatever the drain managed to report (a real-HTTP journey caught the drain
  // losing the race and the run stopping a step early).
  let lastFinishReason = null; // the most recent model call's finish reason
  let finishDrain = Promise.resolve();
  let iterationCalls = 0; // model calls made inside the CURRENT outer iteration
  let lastIteration = null; // { hasToolCalls, text, finishedWithToolCalls }
  let silentContinuations = 0;
  let stoppedBy = null; // { reason, steps, iterations } once the cap stops the run
  const observeFinish = (value) => {
    lastFinishReason = null;
    if (!value || typeof value !== "object") return value;
    if (!(value.stream instanceof ReadableStream)) {
      if (typeof value.finishReason === "string") lastFinishReason = value.finishReason;
      return value;
    }
    let consumed;
    let observed;
    try { [consumed, observed] = value.stream.tee(); } catch { return value; }
    finishDrain = (async () => {
      const reader = observed.getReader();
      try {
        for (;;) {
          const { done, value: part } = await reader.read();
          if (done) break;
          if (part && part.type === "finish" && typeof part.finishReason === "string") lastFinishReason = part.finishReason;
        }
      } catch { /* the consumed branch reports the failure */ } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    })();
    return { ...value, stream: consumed };
  };
  // PROVIDER CACHING: the composed system prompt is byte-stable for a run
  // (the attestation's prefixMatch proves it), so on Anthropic's native lane
  // it is marked as a prompt-cache breakpoint — every call after the first
  // reads it from the cache. OpenAI-compatible endpoints cache the stable
  // prefix on their own; the marker is a no-op for them.
  const markSystemCacheable = (options) => {
    if (model.providerName !== "anthropic") return options;
    const prompt = ownData(options, "prompt");
    if (!Array.isArray(prompt)) return options;
    const at = prompt.findIndex((m) => ownData(m, "role") === "system");
    if (at < 0) return options;
    const message = prompt[at];
    const providerOptions = ownData(message, "providerOptions");
    const anthropic = providerOptions && typeof providerOptions === "object" ? ownData(providerOptions, "anthropic") : null;
    if (anthropic && typeof anthropic === "object" && ownData(anthropic, "cacheControl")) return options;
    const next = prompt.slice();
    next[at] = {
      ...message,
      providerOptions: {
        ...(providerOptions && typeof providerOptions === "object" ? providerOptions : {}),
        anthropic: { ...(anthropic && typeof anthropic === "object" ? anthropic : {}), cacheControl: { type: "ephemeral" } },
      },
    };
    return { ...options, prompt: next };
  };
  // Exhausted = the LAST allowed outer iteration still ended in tool calls
  // (the loop stopped because the budget ran out, not because the model
  // finished — agent-do breaks the loop only on a no-tool-call step) AND no
  // substantive final text landed. A run that wrote its answer on its last
  // allowed step answered (CAP-FB-20260902-BUDGET-VERDICT-ANSWERED-01); the
  // rule itself lives in lib/run-budget.js.
  const budgetExhausted = (aborted, hasFinalText) =>
    budgetExhaustedVerdict({ aborted, lastStepHadTools: budgetLastStepHadTools, lastStepIndex: budgetLastStepIndex, maxIterations, hasFinalText });
  const teeTextDeltas = (value) => {
    if (streamHold || !value || typeof value !== "object" || !(value.stream instanceof ReadableStream)) return value;
    const step = streamStep;
    let first = true;
    const coalescer = createTextDeltaCoalescer((delta) => {
      const ev = { type: "text-delta", delta, step, ...(first ? { start: true } : {}) };
      first = false;
      try { progressCb?.(ev); } catch { /* a progress failure never breaks the stream */ }
    });
    let consumed;
    let observed;
    try { [consumed, observed] = value.stream.tee(); } catch { return value; }
    streamDrain = (async () => {
      const reader = observed.getReader();
      try {
        for (;;) {
          const { done, value: part } = await reader.read();
          if (done) break;
          if (part && part.type === "text-delta" && typeof part.delta === "string") coalescer.push(part.delta);
        }
      } catch { /* the consumed branch reports the failure */ } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
        coalescer.flush();
      }
    })();
    return { ...value, stream: consumed };
  };

  const boundModel = new Proxy(model.model, {
    get(target, prop, receiver) {
      const pushAttempt = () => ({ id: crypto.randomUUID(), occurredAt: new Date().toISOString(), ordinal: ++attemptOrdinal });
      const guarded = async (fn, options, method = "doStream") => {
        emitAttestation(options);
        const entry = pushAttempt();
        attemptQueue.push(entry);
        // PROVIDER-SERVER TOOL LATCH: an execute_tool on a provider-server ref
        // latched the provider-defined tool for THIS run — declare it on this
        // and subsequent model calls (injection is a no-op when nothing is
        // latched or no registry is bound). Execution-as-declaration: the
        // provider runs the tool inside the API call; the client never
        // dispatches it and never answers a tool_call for it.
        const runIdForLatch = ownData(activeRun?.identity, "runId");
        const latchRegistry = serverTooling?.latchRegistry ?? null;
        const latched = latchRegistry && runIdForLatch
          ? latchRegistry.latchedToolsFor(runIdForLatch)
          : [];
        // A latch is not durable authorization. Re-read both owner switches at
        // the last boundary before the paid provider call; revocation between
        // execute_tool and this model step must stop injection immediately.
        let serverToolsAuthorized = false;
        if (latched.length > 0 && typeof serverTooling?.isAuthorized === "function") {
          try { serverToolsAuthorized = await serverTooling.isAuthorized(runIdForLatch); }
          catch { serverToolsAuthorized = false; }
        }
        options = injectLatchedServerTools(options, latched, serverToolsAuthorized);
        // The running digest of earlier inner turns rides agent-do's
        // continuation message(s) — attached here, on the outgoing copy only
        // (agent-do's own history is never touched). Bytes are counted so the
        // model-call economy of the carry-forward is measurable.
        const carried = runDigest.attach(options, currentOuterStep);
        options = markSystemCacheable(carried.options);
        if (carried.bytes > digestBytesMax) digestBytesMax = carried.bytes;
        if (carried.turns > digestTurnsLogged) {
          digestTurnsLogged = carried.turns;
          agentDoLog.info(`run digest carried across an inner-turn boundary`, { turns: carried.turns, bytes: carried.bytes, results: runDigest.counts() });
        }
        // Model round-trip observability: method + attempt ordinal + call
        // latency (time to the provider's response OBJECT — stream consumption
        // continues after). NEVER log options/content (prompts, messages).
        const span = perfSpan(`model:${method}`);
        modelLog.debug(`call attempt ${entry.ordinal}`, method);
        // One model call = one budget step (dropped again if the call fails
        // and the SDK retries it).
        budgetStep = Math.min(budgetTotal, budgetStep + 1);
        iterationCalls += 1;
        emitBudget({ digestBytes: carried.bytes });
        const drop = () => {
          const i = attemptQueue.indexOf(entry);
          if (i >= 0) attemptQueue.splice(i, 1);
          budgetStep = Math.max(0, budgetStep - 1);
          iterationCalls = Math.max(0, iterationCalls - 1);
        };
        let result;
        try {
          result = fn(options);
        } catch (err) {
          // Synchronous throw (a non-async doStream/doGenerate) — this attempt
          // failed and will never emit usage.
          drop();
          span.end("throw");
          recordProviderError(err, method);
          modelLog.warn(`attempt ${entry.ordinal} threw`, err?.message ?? err);
          throw err;
        }
        // Wrap in Promise.resolve so BOTH a Promise rejection AND a plain
        // {stream} / non-thenable return are handled: the rejection drops the
        // entry; a resolved value (incl. a plain object) passes through untouched.
        return Promise.resolve(result).then(
          (value) => {
            span.end("ok");
            lastProviderError = null;
            modelLog.debug(`attempt ${entry.ordinal} response`, method);
            return observeFinish(teeTextDeltas(harvestGrounding(value, runIdForLatch)));
          },
          (err) => {
            drop();
            span.end("error");
            recordProviderError(err, method);
            modelLog.warn(`attempt ${entry.ordinal} failed`, err?.message ?? err);
            throw err;
          },
        );
      };
      if (prop === "doGenerate" && typeof target.doGenerate === "function") {
        return (options) => guarded(target.doGenerate.bind(target), options, "doGenerate");
      }
      if (prop === "doStream" && typeof target.doStream === "function") {
        return (options) => guarded(target.doStream.bind(target), options, "doStream");
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const sourceTools = {
    ...memoryToolset(memory, enrollmentGuard, getRunGen, readOnlyMemory),
    ...workflowsToolset({
      memory,
      runRoute: workflowRunRoute,
      pipelineDispatch: async (toolName, args, stepIndex) =>
        livePipelineStepDispatch
          ? livePipelineStepDispatch(toolName, args, stepIndex)
          : { ok: false, error: "pipeline workflow run is not available in this context" },
      enrollmentGuard,
      getRunGen,
      readOnly: readOnlyMemory,
    }),
    ...skillReadToolset(skillStore),
    ...tools,
  };
  const instanceGeneration = `agent-instance:${crypto.randomUUID()}`;
  // The run-context reader shared by the lazy provider tools AND the
  // pipeline-step dispatcher: null when no run is active (a pipeline step can
  // never dispatch outside a real run).
  const readRunLazyContext = async () => {
    if (!activeRun) return null;
    const dynamic = await readLazyScope();
    return Object.freeze({
      signal: activeRun.controller.signal,
      runId: ownData(activeRun.identity, "runId"),
      taskId: ownData(activeRun.identity, "taskId"),
      agentId: id,
      origin: ownData(dynamic, "origin") ?? ownData(activeRun.identity, "origin") ?? (id === "hub" ? "" : id),
      documentId: ownData(dynamic, "documentId") ?? ownData(activeRun.identity, "documentId") ?? "",
      runGeneration: ownData(dynamic, "runGeneration") ?? ownData(activeRun.identity, "runGeneration") ?? String(activeRun.gen ?? "0"),
      replayMetadata: ownData(activeRun.identity, "replayMetadata") ?? null,
      untrustedToken: typeof untrustedToken === "string" ? untrustedToken : null,
    });
  };
  const lazy = createLazyProviderToolset({
    // A screenshot reaches a vision model as a real IMAGE part, not as base64
    // text (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01). Only lanes whose
    // transport carries an image content part get one; everything else reads
    // the id + dimensions from the JSON, which is honest and small.
    acceptsImageToolResults: () => acceptsImageToolResults(model),
    readSources: async () => {
      const builtin = executableBuiltinToolRecords(sourceTools, {
        version: "runtime-v1",
        sourceGeneration: instanceGeneration,
        closureGeneration: instanceGeneration,
        packageDigest: sha256Hex(`cap.core-tools\u0000${instanceGeneration}`),
        permissionDigest: "none",
        grantDigest: "none",
        scope: {
          hub: id === "hub",
          agentId: id,
          origin: id === "hub" ? "" : id,
          documentId: "",
        },
        capabilitiesByTool: Object.fromEntries(
          Object.keys(sourceTools).map((toolName) => [toolName, [
            toolName === "memory_set" ? "memory.write" :
            toolName === "save_workflow" ? "memory.write" :
            toolName === "delegate_task" ? "agent.delegate" :
            toolName === "list_agents" ? "agent.list" : "memory.read",
          ]]),
        ),
      });
      const extra = await readLazySources();
      if (!Array.isArray(extra)) throw new Error("lazy source reader shape");
      return [...builtin, ...extra];
    },
    contextReader: readRunLazyContext,
  });
  // The pipeline-step dispatcher for pipeline-kind workflows: steps resolve by
  // EXACT tool name against the run's live lazy catalog and execute through the
  // protocol — validation, run ownership and capability gates all apply as for
  // a model-initiated execute_tool call (workflows-to-memory).
  livePipelineStepDispatch = createWorkflowPipelineDispatcher({
    search: (request, ctx) => lazy.protocol.search(request, ctx),
    execute: (request, ctx) => lazy.protocol.execute(request, ctx),
    settle: (ref) => lazy.protocol.settlePausedCall(ref),
    context: readRunLazyContext,
  });
  // The provider receives the fixed lazy protocol tools. Every
  // source closure above stays private until a fresh search result is resolved
  // and execute_tool revalidates it; empty/ambiguous search never falls back to
  // eager exposure.
  const allTools = lazy.tools;
  // The skills layer composes BEFORE the protected constraints (the
  // protected-last invariant, docs/SYSTEM-PROMPTS.md): `system` arrives
  // already composed by lib/system-prompts.js (base + owner customization +
  // protected constraints LAST); any caller-supplied skills are inserted
  // ahead of the protected block by the composition authority — never
  // concatenated after it, so a mutable/site-origin skill can never override
  // the runtime policy. appendSkillsLayer is THE agent boundary: it also
  // appends the protected block to a FOREIGN prompt that never carried one,
  // so every caller's system message ends with the runtime policy.
  const systemPrompt = appendSkillsLayer(system, skills, undefined, untrustedToken);

  // The agent-do agent builder, parameterized by the system prompt so a run
  // carrying per-run skills (a /skill:<id> reference resolved for THIS run)
  // gets a FRESH agent whose system prompt recomposes those full skill bodies
  // BEFORE the protected block — the composition stays the single authority
  // and the protected layer is still structurally last.
  // Lifecycle bookkeeping for the agent-do logs (bounded: entries are deleted
  // on completion; at most innerStepLimit steps + in-flight tools alive).
  // Re-initialized per makeAgent() call so a fresh per-run agent starts clean.
  let stepSpans = new Map();
  let toolSpans = new Map();
  let toolCallSequence = 0;
  let runStartedAt = null;
  // The REAL tool names (post lazy-envelope unwrap) that returned success in
  // THIS run — the runtime backstop against unsupported mutation claims in
  // the final reply (the prompt clause alone is model-compliance-dependent).
  const okToolNames = new Set();
  // Which per-step text is the ANSWER (CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01):
  // agent-do nudges the model after any tool step ("Continue working on the
  // task…"); the nudge reply is hidden and the substantive answer becomes the
  // run result. Runs are serialized (runQueue), so one tracker per agent is
  // safe; it is re-created at every step-0 start.
  let runText = createRunTextTracker();
  const makeAgent = (sysPrompt) => {
    stepSpans = new Map();
    toolSpans = new Map();
    toolCallSequence = 0;
    runStartedAt = null;
    return agentDoCreateAgent({
    id,
    name,
    model: boundModel,
    systemPrompt: sysPrompt,
    tools: allTools,
    maxIterations,
    // One inner turn holds up to 24 model steps: with a reusable selection ref
    // that is one search + ~22 executes — a 30-tab loop in two inner turns.
    // agent-do keeps only an inner turn's LAST step in its history, so the
    // runtime digest (lib/run-digest.js) carries the rest of the turn forward.
    innerStepLimit,
    usage: { pricing: MODEL_PRICING },
    // Lifecycle bookkeeping for the agent-do logs (bounded: entries are deleted
    // on completion; at most innerStepLimit steps + in-flight tools).
    ...(() => {
      stepSpans = new Map();
      toolSpans = new Map();
      toolCallSequence = 0;
      runStartedAt = null;
      return {};
    })(),
    hooks: {
      // LIVE progress hooks — forward the agent-do step/tool lifecycle to the
      // UI as normalized events. onProgress may be async (the SW broadcast is a
      // fire-and-forget postMessage), but the hooks are awaited by agent-do, so
      // they must never throw (a progress-emit failure must not kill the run).
      // The cap-log lines below are a PURE side-effect (verbose-gated): they
      // never alter hook return values, the progress flow, or timing.
      onStepStart: async (e) => {
        if (iterationGuard && iterationGuard(e.step) !== true) {
          const error = new Error("delegation subtree iteration budget exhausted");
          error.code = "delegation-budget";
          throw error;
        }
        // A step is ONE model round-trip — the step span IS the model span
        // (agent-do exposes no separate onModelCall hook; its DebugConfig
        // channels carry content + emit into the progress stream, so they are
        // deliberately NOT used — redaction + preserve constraints).
        const span = perfSpan(`agent-do:step:${e.step}`, { ns: "agent-do" });
        stepSpans.set(e.step, span);
        if (runStartedAt == null) runStartedAt = Date.now();
        if (!(e.step > 0)) {
          runText = createRunTextTracker();
          budgetStep = 0;
          budgetLastStepHadTools = false;
          budgetLastStepIndex = -1;
          runDigest.reset();
          digestTurnsLogged = 0;
          digestBytesMax = 0;
          lastIteration = null;
          silentContinuations = 0;
          stoppedBy = null;
        } else {
          // The continuation decision — agent-do's own stop hook, never a
          // patched loop (CAP-FB-20260830-MODEL-CALL-ECONOMY-01).
          const decision = continuationStopDecision({ lastIteration, silentContinuations });
          if (decision === "answered") {
            agentDoLog.info(`step ${e.step} not started — the previous step answered after its tool calls; no continuation call`);
            span.end("skipped");
            stepSpans.delete(e.step);
            return { decision: "stop" };
          }
          if (decision === "silent-cap") {
            stoppedBy = { reason: "iteration-cap", steps: budgetStep, iterations: silentContinuations };
            agentDoLog.warn(`stopped after ${budgetStep} steps — ${silentContinuations} continuations answered with tool calls and no text`);
            span.end("stopped");
            stepSpans.delete(e.step);
            try { progressCb?.({ type: "stopped", ...stoppedBy }); } catch { /* ignore */ }
            return { decision: "stop" };
          }
        }
        currentOuterStep = Number.isFinite(e.step) ? e.step : currentOuterStep;
        iterationCalls = 0;
        streamStep = e.step;
        streamHold = runText.nextStepMayBeNudge();
        streamDrain = Promise.resolve();
        agentDoLog.debug(`step ${e.step}/${e.totalSteps ?? "?"} start`, { tokensSoFar: e.tokensSoFar ?? 0, costSoFar: e.costSoFar ?? 0 });
        try { progressCb?.({ type: "thinking", step: e.step, totalSteps: e.totalSteps, tokensSoFar: e.tokensSoFar, costSoFar: e.costSoFar }); } catch { /* ignore */ }
      },
      onStepComplete: async (e) => {
        const span = stepSpans.get(e.step);
        stepSpans.delete(e.step);
        const dur = span ? span.end("ok") : 0;
        agentDoLog.debug(`step ${e.step} complete in ${dur.toFixed(1)}ms`, { hasToolCalls: e.hasToolCalls === true });
        // The nudge reply (a text-only step right after a tool step that already
        // answered) is emitted HIDDEN: the surfaces never render it, the SW never
        // persists it, and it is never the run's result.
        // Every forwarded delta precedes its step's text event: wait (bounded)
        // for the observed stream branch to drain before emitting the text.
        await Promise.race([Promise.all([streamDrain, finishDrain]), sleep(250)]);
        // The iteration ended with work still queued when the provider said so
        // OR when it used every inner step it was allowed (the inner cap, not
        // the model, ended it).
        const hitInnerCap = iterationCalls >= innerStepLimit;
        const workStillQueued = lastFinishReason === "tool-calls" || hitInnerCap;
        const classified = runText.step({ step: e.step, hasToolCalls: e.hasToolCalls === true, text: e.text, finishedWithToolCalls: workStillQueued });
        budgetLastStepHadTools = e.hasToolCalls === true;
        budgetLastStepIndex = Number.isFinite(e.step) ? e.step : budgetLastStepIndex;
        // What the NEXT onStepStart decides on: did this iteration answer, or
        // go silent, after its tool calls — and did its last model call
        // finish on its own or on the inner step limit ("tool-calls").
        lastIteration = {
          hasToolCalls: e.hasToolCalls === true,
          text: String(e.text ?? "").trim(),
          finishedWithToolCalls: workStillQueued,
        };
        silentContinuations = isSilentIteration(lastIteration) ? silentContinuations + 1 : 0;
        if (classified.hidden) agentDoLog.debug(`step ${e.step} is the continuation reply — hidden`);
        try {
          progressCb?.({
            type: "text",
            text: e.text,
            step: e.step,
            hasToolCalls: e.hasToolCalls,
            ...(classified.hidden ? { hidden: true, nudgeReply: true } : {}),
            ...(classified.persist ? { persist: true } : {}),
          });
        } catch { /* ignore */ }
      },
      onPreToolUse: async (e) => {
        // The pre-tool progress callback is AWAITED: the SW persists the atomic
        // pre-tool authority BEFORE any external effect runs. A durable
        // refusal propagates so the tool execution is REFUSED (the run never
        // mutates before its authority is durable); ordinary broadcast errors
        // remain non-fatal.
        // Pair concurrent same-name calls with a FIFO per step/name. The
        // owner-grade console includes arguments; cap-log applies the local
        // full-detail toggle while its export ring remains redacted.
        const toolName = String(e.toolName ?? "unknown").slice(0, 64);
        const toolKey = `${e.step}:${toolName}`;
        const callId = `${toolKey}#${++toolCallSequence}`;
        const queue = toolSpans.get(toolKey) ?? [];
        queue.push({ callId, span: perfSpan(`agent-do:tool:${toolName.slice(0, 48)}`, { ns: "agent-do" }) });
        toolSpans.set(toolKey, queue);
        agentDoLog.debug("tool-call:start", { callId, name: toolName, step: e.step, arguments: e.args });
        try {
          await progressCb?.({ type: "tool-call", toolName: e.toolName, toolArgs: e.args, step: e.step });
        } catch (error) {
          if (error?.durableRefusal === true) throw error;
          /* ignore ordinary broadcast failures */
        }
      },
      onPostToolUse: async (e) => {
        const toolName = String(e.toolName ?? "unknown").slice(0, 64);
        const toolKey = `${e.step}:${toolName}`;
        const queue = toolSpans.get(toolKey) ?? [];
        const observed = queue.shift() ?? { callId: `${toolKey}#orphan`, span: null };
        if (queue.length) toolSpans.set(toolKey, queue);
        else toolSpans.delete(toolKey);
        const tspan = observed.span;
        // The selected tool's name, read BEFORE the denial rewrite below
        // replaces the envelope text (after it, the name is unrecoverable and
        // the card would be headed "tool call").
        const selectedBeforeRewrite = selectedToolFromResult(e.result);
        let permissionDenial = permissionDenialFromToolResult(e.result);
        // The STRUCTURED requirement survives on the progress event (the run
        // log persists it) even though the model-facing modelContent is
        // rewritten below — a reopened thread derives its grant card from it
        // (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §2b).
        let permissionRequirement = permissionDenial?.permissionRequirement ?? null;
        let permissionDecision = null;
        // Approved, then RE-RUN by the runtime with the original arguments —
        // the model receives the tool's real result, never a retry instruction
        // (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01). The card records
        // "approved, then ran" from this flag.
        let reexecuted = false;
        // A re-run can pause on a FURTHER requirement (a second capability the
        // same tool needs): each pause is one card and one decision, bounded.
        for (let round = 0; permissionDenial && typeof onPermissionRequest === "function" && round < 4; round++) {
          const decision = await onPermissionRequest(permissionDenial);
          permissionDecision = decision;
          // agent-do records this same normalized object after the awaited hook.
          const selected = selectedToolFromResult(e.result) ?? e.toolName;
          const pausedRef = ownData(lazyEnvelope(e.result), "selectionRef");
          if (!(e.result && typeof e.result === "object")) break;
          if (decision !== "approved") {
            // Deny/timeout is terminal for this action: the call is forgotten
            // and never executed.
            if (typeof pausedRef === "string") { try { lazy.settlePausedCall(pausedRef); } catch { /* nothing recorded */ } }
            e.result.modelContent = decision === "expired"
              ? `Approval expired. ${selected} was not performed; do not claim it succeeded.`
              : `Owner denied the requested capability. ${selected} was not performed; do not retry it.`;
            e.result.userSummary = decision === "expired"
              ? `[${selected}] DENIED — approval expired`
              : `[${selected}] DENIED by owner`;
            break;
          }
          // Approved: the runtime re-runs the SAME call (same tool, the
          // original validated arguments, the same run fence, every live
          // authority check) through the lazy protocol — a runtime-only path
          // the model cannot reach — and the result REPLACES the denial as if
          // the call had succeeded first time.
          let resumed = null;
          if (typeof pausedRef === "string") {
            try { resumed = await lazy.resumeApprovedCall(pausedRef); } catch (error) {
              if (error?.name === "RunAbortedError" || error?.name === "AbortError") throw error;
              resumed = null;
            }
          }
          const protocolFailure = !resumed || (resumed.ok !== true && typeof resumed.selectedTool !== "string");
          if (protocolFailure) {
            // The re-run itself could not be set up (the tool vanished from
            // the catalog, the run moved on). Plain language, no protocol
            // vocabulary; the model may call the tool again.
            agentDoLog.warn("approved call could not be re-run", { tool: selected, error: resumed?.error ?? "unavailable" });
            e.result.modelContent = `Owner approved the requested capability, but ${selected} could not be run again automatically. Call ${selected} again.`;
            e.result.userSummary = `[${selected}] approved — not run`;
            break;
          }
          // The tool's REAL outcome (success, or its own ordinary failure) is
          // what agent-do would have recorded for a first-time success.
          const text = summarizeForModel(resumed);
          e.result.modelContent = text;
          e.result.userSummary = text;
          reexecuted = true;
          permissionDenial = permissionDenialFromToolResult(e.result);
          if (permissionDenial) permissionRequirement = permissionDenial.permissionRequirement ?? permissionRequirement;
        }
        const toolOk = !isToolResultFailure(e.result) && !lazyNestedFailure(e.result);
        if (toolOk) { try { okToolNames.add(selectedToolFromResult(e.result) ?? e.toolName); } catch { /* ignore */ } }
        // Digest the result the model is about to receive (after any denial /
        // re-run rewrite above — the digest mirrors the model's view).
        try {
          runDigest.record({ step: e.step, call: budgetStep, tool: toolName, selected: selectedToolFromResult(e.result), args: e.args, ok: toolOk, result: e.result });
        } catch { /* the digest is telemetry-grade: never breaks a run */ }
        if (tspan) tspan.end(toolOk ? "ok" : "error");
        agentDoLog.debug("tool-call:end", {
          callId: observed.callId,
          name: selectedToolFromResult(e.result) ?? toolName,
          envelopeName: toolName,
          step: e.step,
          durationMs: e.durationMs ?? null,
          outcome: toolOk ? "ok" : "error",
          result: e.result,
        });
        try {
          // The retained full copy (redacted, valid JSON, ≤ 64 KiB, flagged
          // when the cap bit) — computed once here so every downstream surface
          // (the live card, the durable run log, the reopened thread) reads the
          // same bytes the model received.
          const full = toolResultFullJson(e.result);
          progressCb?.({
            type: "tool-result",
            toolName: e.toolName,
            selectedTool: selectedToolFromResult(e.result) ?? selectedBeforeRewrite,
            step: e.step,
            durationMs: e.durationMs,
            result: summarizeToolResult(e.result),
            resultFull: full.json,
            resultFullTruncated: full.truncated,
            resultFullBytes: full.bytes,
            ok: toolOk,
            ...(permissionRequirement ? { permissionRequirement, permissionDecision, ...(reexecuted ? { reexecuted: true } : {}) } : {}),
          });
        } catch { /* ignore */ }
      },
      onComplete: async (e) => {
        const runDur = runStartedAt == null ? 0 : Date.now() - runStartedAt;
        agentDoLog.debug(`run complete: ${e.totalSteps ?? "?"} steps in ${runDur}ms${e.aborted ? " (aborted)" : ""}`);
        try {
          // Runtime honesty backstop: a final text that CLAIMS a mutation with
          // no successful matching tool call gets a visible correction — the
          // owner is never misled by a non-compliant model.
          // The result under check is the SUBSTANTIVE text (never the hidden
          // nudge reply) — see run-text-steps.js.
          e = { ...e, result: runText.finalText(e.result) };
          const checked = correctUnsupportedMutationClaims(e.result, okToolNames);
          if (checked.corrections.length > 0) agentDoLog.warn(`mutation-claim correction appended (${checked.corrections.length})`);
          // The budget verdict rides BOTH the final budget event and `done`:
          // the SW settles a "budget reached — Continue" terminal from it
          // instead of a silent finish (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01).
          // "Budget reached" only when the budget ran out with NO substantive
          // final text — the SAME text the claim check above just read; a run
          // that answered on its last allowed step settles ok
          // (CAP-FB-20260902-BUDGET-VERDICT-ANSWERED-01).
          const hasFinalText = typeof e.result === "string" && e.result.trim().length > 0;
          const exhausted = budgetExhausted(e.aborted, hasFinalText);
          const budget = { used: budgetStep, total: budgetTotal, exhausted, results: runDigest.counts(), digestTurns: digestTurnsLogged, digestBytesMax, ...(stoppedBy ? { stopped: { ...stoppedBy } } : {}) };
          if (exhausted) agentDoLog.warn(`step budget exhausted (${budgetStep}/${budgetTotal}) with tool calls still pending and no final answer`);
          else if (budgetExhausted(e.aborted, false)) agentDoLog.info(`step budget reached (${budgetStep}/${budgetTotal}) on a step that also wrote the final answer — settled as finished`);
          emitBudget({ exhausted });
          progressCb?.({ type: "done", text: checked.text, totalSteps: e.totalSteps, aborted: e.aborted, budget });
        } catch { /* ignore */ }
      },
      onUsage: async (record) => {
        agentDoLog.debug(`usage: in ${record.inputTokens ?? 0} out ${record.outputTokens ?? 0} estCost ${record.estimatedCost ?? 0}`);
        // Bind this callback to ITS provider attempt (FIFO) — a delayed callback
        // must not read a later attempt's id/timestamp.
        const attempt = attemptQueue.shift() ?? { id: crypto.randomUUID(), occurredAt: new Date().toISOString(), ordinal: attemptOrdinal };
        await recordUsage({
          agentId: id,
          taskId: activeRun?.identity?.taskId ?? taskId,
          provider: model.providerName,
          model: model.modelId,
          inputTokens: record.inputTokens ?? 0,
          outputTokens: record.outputTokens ?? 0,
          estimatedCost: record.estimatedCost ?? 0,
          usageEventId: attempt.id,
          occurredAt: attempt.occurredAt,
          attemptOrdinal: attempt.ordinal,
        }, enrollmentGuard
          ? { genGuard: enrollmentGuard, getRunGen }
          : null);
      },
    },
    });
  };
  // The shared agent (no per-run skills — the common case).
  const agent = makeAgent(systemPrompt);

  return {
    id,
    name,
    // Expose the worker's CURRENT run generation (the immutable run-start gen,
    // or null when no run is active). The SW threads this into the site-tool
    // invocation + the provider/usage boundaries so a stale run can never operate
    // under a re-enrolled origin's generation (the round-24 gen-threading blocker).
    getRunGen: () => activeRun?.gen ?? null,
    // agent-do's run(task, context, history) -> string. Our wrapper accepts a
    // FOURTH `runGen` argument: the immutable enrollment generation the caller
    // captured at delegation start. The run + its worker commits revalidate THAT
    // generation (delete→re-enroll ABA), and abort() before the run prevents the
    // start (the check→start gap where agent-do's own controller is null until
    // run() begins). The optional FIFTH `runSkills` argument carries skills
    // resolved for THIS run only (e.g. /skill:<id> references): their FULL
    // prompt bodies recompose into the system prompt BEFORE the protected
    // block (a fresh agent for this run), so referenced-skill instructions
    // never sit after the runtime policy.
    run: async (task, context, history, runGen, runSkills, runIdentity = null, runPromotion = null) => {
      // Serialize the run behind any prior run of THIS worker (see runQueue above).
      // `execute` carries the full original body; the queue always advances even
      // if a run rejects, so a failed run can never poison later runs.
      const execute = async () => {
      // Clear any stale provider-attempt entries from a prior aborted/retried run
      // (an attempt with no onUsage would otherwise misattribute the NEXT run's
      // first callback — cross-run identity leakage).
      attemptQueue.length = 0;
      let gen = runGen ?? null;
      if (enrollmentGuard && gen == null) {
        // No caller-supplied generation (a direct worker run) — capture it now.
        const g = await enrollmentGuard();
        if (!g?.ok) return { error: g?.error ?? "origin not enrolled" };
        gen = g.gen ?? 0;
      }
      // PRE-START abort check: abort() may have been called while the guard await
      // above was in flight (agent.delete → abortWorker), and agent-do's own
      // abort() before run() is a no-op (its controller is null until run starts).
      // A disposable worker that was aborted must never begin a new run — a
      // TYPED abort error, never a successful {error} object.
      if (aborted) throw new RunAbortedError("run aborted before start");
      const controller = new AbortController();
      const identityInput = runIdentity && typeof runIdentity === "object"
        ? runIdentity
        : {};
      const identity = Object.freeze({
        runId: String(ownData(identityInput, "runId") ?? crypto.randomUUID()),
        taskId: String(ownData(identityInput, "taskId") ?? taskId ?? "adhoc"),
        origin: String(ownData(identityInput, "origin") ?? (id === "hub" ? "" : id)),
        documentId: String(ownData(identityInput, "documentId") ?? ""),
        runGeneration: String(ownData(identityInput, "runGeneration") ?? gen ?? "0"),
        replayMetadata: ownData(identityInput, "replayMetadata") ?? null,
      });
      activeRun = { gen, controller, identity };
      if (aborted || controller.signal.aborted) {
        activeRun = null;
        throw new RunAbortedError("run aborted before start");
      }
      // Wire the run-scoped controller to agent-do so abort() during the run
      // cancels the model loop (agent-do's own abort() only works after its run()
      // started). The listener is removed in finally so a post-run abort can
      // never leak into a queued next run (the round-16 cross-run abort blocker).
      // A run carrying per-run skills runs on a FRESH agent whose system prompt
      // recomposes those skills before the protected block. `runPromotion`
      // (chrome-agent-platform-ve67) is the task-relevant catalog promotion
      // section, composed between the skills block and the policy — it is
      // deterministic text computed by the caller (the service worker) from
      // the run's task + the skill catalog, and rides the same fresh-agent
      // boundary so it can never sit after the protected policy.
      const hasRunSkills = Array.isArray(runSkills) && runSkills.length > 0;
      const promotionText = String(runPromotion ?? "").trim() || null;
      const composeRunPrompt = () => appendSkillsLayer(
        system,
        [...(skills ?? []), ...(hasRunSkills ? runSkills : [])],
        undefined,
        untrustedToken,
        promotionText,
      );
      const runAgent = (hasRunSkills || promotionText)
        ? makeAgent(composeRunPrompt())
        : agent;
      activeSystemPrompt = (hasRunSkills || promotionText)
        ? composeRunPrompt()
        : systemPrompt;
      const onAbort = () => {
        try {
          runAgent.abort();
        } catch { /* no active run */ }
      };
      lastRunAborted = false; // per-run reset
      controller.signal.addEventListener("abort", onAbort);
      try {
        // Provider execution boundary: re-validate the IMMUTABLE run-start
        // generation IMMEDIATELY before the model loop starts (a re-enroll during
        // the queue await or the guard await above must not start a stale run —
        // the round-24 gen-threading blocker: the provider received no gen check
        // before agent.run).
        if (enrollmentGuard && gen != null) {
          const g = await enrollmentGuard();
          if (!g?.ok || (g.gen ?? 0) !== gen) {
            return { error: "origin re-enrolled before run — task not started" };
          }
        }
        // The successful-mutation set is PER RUN: a success in run 1 must never
        // back a fabricated claim in run 2 (the set is allocated once per
        // createAgent, so it is cleared here at every run start).
        okToolNames.clear();
        const loopResult = await runAgent.run(task, context, history);
        // The run's answer is the SUBSTANTIVE text, never the hidden reply to
        // agent-do's continuation nudge (the transcript-full-answer finding).
        const result = typeof loopResult === "string" ? runText.finalText(loopResult) : loopResult;
        // Post-run generation revalidation: a re-enroll DURING the model loop
        // must discard the result rather than return it to the caller under a
        // stale enrollment (the round-24 finding — the provider path had no
        // post-run gen check).
        if (enrollmentGuard && gen != null) {
          const g = await enrollmentGuard();
          if (!g?.ok || (g.gen ?? 0) !== gen) {
            return { error: "origin re-enrolled during run — result discarded" };
          }
        }
        // An ABORTED run NEVER resolves: the mid-run abort THROWS the single
        // typed RunAbortedError (with the partial text as `partialText`) — the
        // SW + the direct-delegation callers catch the typed error. A queued
        // next run can never overwrite this caller's observable abort state.
        if (controller.signal.aborted) {
          const err = new RunAbortedError("run aborted mid-run");
          err.partialText = result;
          throw err;
        }
        // The claim-honesty correction must reach the AUTHORITATIVE returned
        // result, not just the progress `done` event — the conversation paints
        // the SW's res.result (this return value), so a correction visible only
        // on the event would be invisible on the primary path.
        return typeof result === "string"
          ? correctUnsupportedMutationClaims(result, okToolNames).text
          : result;
      } finally {
        // DURABLE per-run outcome: capture the abort state BEFORE activeRun is
        // cleared (the SW's isAborted() check runs after orch.run resolves —
        // activeRun is null by then, so the controller signal alone is lost).
        lastRunAborted = controller.signal.aborted;
        controller.signal.removeEventListener("abort", onAbort);
        activeRun = null;
        activeSystemPrompt = null;
        attemptQueue.length = 0; // no cross-run attempt-identity leakage
      }
      };
      const result = runQueue.then(execute, execute);
      runQueue = result.then(() => {}, () => {});
      return result;
    },
    lazyDiagnostics: () => lazy.diagnostics(),
    // The finite step budget this agent runs under (the run log records it;
    // the surface counts against it).
    budget: () => ({ maxIterations, innerStepLimit, total: budgetTotal }),
    abort: () => {
      if (disposable) aborted = true;
      activeRun?.controller.abort();
      try {
        agent.abort();
      } catch { /* no active run */ }
    },
    // Rebind the live progress callback without rebuilding the cached agent.
    // The SW calls this per-run (the orchestrator is reused across runs).
    setProgress: (cb) => { progressCb = cb; },
    // Rebind the run-bound prompt attestation sink (per run, like setProgress).
    // The SW binds a sink tagged with the runId so the attestation journaled
    // for a run is captured from THAT run's actual provider-bound message.
    setAttestation: (cb) => { attestationCb = cb; lastAttestedDigest = null; },
    // Whether THIS agent's run was aborted (a disposable pre-start abort or a
    // mid-run controller abort) — the DURABLE per-run flag survives the
    // activeRun cleanup, so the SW can read it after orch.run resolves and
    // propagate it in the run response (an aborted run is never a success).
    isAborted: () => aborted || lastRunAborted,
  };
}

// The canonical metadata for the two orchestrator-owned built-ins. The runtime
// and the shadow catalog consume the SAME objects so descriptions/schemas cannot
// drift while dispatch remains inside createOrchestrator.
export function delegationToolMetadata() {
  return {
    list_agents: {
      description: "List the available site sub-agents.",
      inputSchema: z.object({}),
    },
    delegate_task: {
      description: "Delegate a task to a site sub-agent and return its result. The sub-agent runs it in ITS OWN context — its own memory, its own discovered tools, its own skills. Use it for site-specific work; handle cross-site or hub-level work yourself. list_agents shows who you can delegate to.",
      inputSchema: z.object({ agentId: z.string(), task: z.string() }),
    },
  };
}

/**
 * Hub + per-site sub-agents. The hub is a single agent-do agent with delegation
 * tools; each worker is an agent-do agent for one site origin. `multiAgent`
 * toggles between the full fan-out and a solo hub agent.
 */
export function createOrchestrator({
  model,
  system = DEFAULT_SYSTEM,
  masterSystem = null,
  masterMemory,
  workers = [], // [{ origin, memory, skills, tools }]
  multiAgent = true,
  taskId = "adhoc",
  maxIterations = undefined, // delegation child budget (createAgent default when absent)
  iterationGuard = null, // dynamic parent/subtree budget fence at each model step
  extraTools = {}, // retained as private source closures; never provider-eager
  readMasterLazySources = async () => [],
  readMasterLazyScope = async () => ({}),
  delegateGuard = null, // async (origin) => { ok, error } — revalidates live
                        // enrollment/generation before a delegated worker runs
  scoped = false, // SCOPED (hook) runs: the master gets read-only memory (no
                  // memory_set) — the extraTools caller already supplies the
                  // read-only browser set, so the master cannot persist state.
  onProgress = null, // async (event) => void — the live progress stream, threaded
                     // into BOTH the master agent and every delegated worker.
  onPermissionRequest = null,
  serverTooling = null, // provider-server latch registry + grounding sink
                        // (master only — workers are site-origin agents whose
                        // tools are page-bound, not provider-bound)
  untrustedToken = null, // the master's untrusted-content boundary token (workers
                         // carry their own as `w.untrustedToken`)
  skillStore = null, // async () => imported-skill records — enables skill_read
                     // (CAP-FB-20260830-SKILLS-UNCAPPED-01) on the master AND
                     // every worker (skills are a shared master store)
  workflowRunRoute = null, // the owner-approved script-js workflow run dispatcher
                           // (SW `workflow.run`) — bound to the MASTER only; a
                           // worker's script-js workflow_run fails closed
}) {
  const workerAgents = new Map();
  let currentRunIdentity = null;
  for (const w of workers) {
    const a = createAgent({
      model,
      id: w.origin,
      name: w.origin,
      system: w.system ?? system,
      memory: w.memory,
      skills: w.skills ?? [],
      tools: w.tools ?? {},
      skillStore,
      readLazySources: w.readLazySources ?? (async () => []),
      readLazyScope: w.readLazyScope ?? (async () => ({
        origin: w.origin,
        documentId: "",
      })),
      untrustedToken: w.untrustedToken ?? null,
      taskId,
      // Thread the delegateGuard into each worker's memory tools so a worker's
      // memory_set revalidates its IMMUTABLE run-start generation before
      // committing (the round-21 blocker: worker tools got no enrollment token;
      // the round-22 ABA: revalidating "currently enrolled" instead of the
      // run-start generation let a delete→re-enroll stale write pass). The guard
      // already revalidates enrollment + generation; reuse it per-origin.
      enrollmentGuard: delegateGuard
        ? async () => delegateGuard(w.origin)
        : null,
      // Workers are DISPOSABLE: agent.delete → abortWorker permanently disables
      // the agent so a stale in-flight delegation cannot start a new run in the
      // check→start gap.
      disposable: true,
      // SCOPED (hook) runs are TRANSITIVELY side-effect-free (the sol addendum):
      // a delegated worker must ALSO get read-only memory (no memory_set) —
      // otherwise an untrusted hook payload could delegate into a worker that
      // writes site memory / invokes page tools, defeating the scoping.
      readOnlyMemory: scoped,
      onProgress,
      onPermissionRequest,
    });
    workerAgents.set(w.origin, a);
  }

  // SCOPED (hook) runs must not delegate (the sol addendum): a hook-invoked
  // run is side-effect-free, so it gets NO delegate_task — an untrusted event
  // payload must not fan out into site workers that invoke page tools.
  const delegateMetadata = delegationToolMetadata();
  const delegate = (multiAgent && !scoped)
    ? {
      list_agents: tool({
        ...delegateMetadata.list_agents,
        execute: async () => ({ agents: [...workerAgents.keys()] }),
      }),
      delegate_task: tool({
        ...delegateMetadata.delegate_task,
        execute: async ({ agentId, task }) => {
          // The model-facing delegate path must be fenced like every other
          // side-effecting tool (the round-15 finding: a cached deleted worker
          // could still run via delegate_task). An aborted run must not start a
          // delegated worker's side effects. DUrable ownership must be asserted
          // BEFORE starting the worker (not just the signal — the round-20
          // durable-ownership-before-commit finding).
          try {
            await assertRunOwned();
          } catch {
            throw new RunAbortedError("run aborted — delegation not started");
          }
          const a = workerAgents.get(agentId);
          if (!a) return { error: `no agent for ${agentId}` };
          // Revalidate LIVE enrollment/generation before the worker runs: a
          // worker deleted AFTER the orchestrator was built must not run (the
          // internal delegate path previously bypassed the lifecycle gate).
          let gen = 0;
          if (delegateGuard) {
            const g = await delegateGuard(agentId);
            if (!g?.ok) {
              return {
                error: g?.error ?? `agent ${agentId} is not enrolled`,
              };
            }
            gen = g.gen ?? 0;
          }
          // Re-check the fence AFTER the guard await: an abort during the
          // delegateGuard await must still prevent the worker from starting
          // (the round-16 blocker: delegate_task could abort during the guard
          // then still start the worker). An ownership loss HERE is the single
          // typed abort error too (every ownership fence is typed).
          try {
            await assertRunOwned();
          } catch {
            throw new RunAbortedError("run aborted — delegation ownership lost before start");
          }
          // Thread the captured generation into a.run so the worker's memory/
          // usage commits revalidate THAT immutable identity, not the current
          // enrollment (the round-22 ABA blocker).
          // An ABORTED worker REJECTS the run — catch it into the explicit
          // aborted failure (never a thrown tool error that would surface as a
          // generic "No output generated").
          let result;
          try {
            result = await a.run(
              task,
              undefined,
              undefined,
              gen,
              undefined,
              Object.freeze({
                ...(currentRunIdentity ?? {}),
                origin: agentId,
                runGeneration: String(gen),
              }),
            );
          } catch (e) {
            // ONLY an ABORT-shaped worker rejection becomes the typed error (a
            // REAL tool-error); any UNRELATED worker error (a tool failure, a
            // provider error) is PRESERVED unchanged — the delegation surfaces
            // it as its own error, never mislabelled as an abort.
            if (isAbortShape(e)) {
              throw new RunAbortedError(
                `delegation aborted — the worker for ${agentId} was aborted mid-run`,
              );
            }
            throw e; // UNRELATED worker failures are preserved UNCHANGED (identity, type, stack, custom fields)
          }
          // Post-run generation revalidation: a delete DURING the worker run
          // tombstones + bumps the generation, so the result must be discarded
          // rather than returned to the model (the round-17 blocker: delegateGuard
          // returned {gen} but delegate_task ignored it). An ownership loss is
          // an ABORT-shaped failure → the typed error.
          if (delegateGuard && gen) {
            const after = await delegateGuard(agentId);
            if (!after?.ok || (after.gen ?? 0) !== gen) {
              throw new RunAbortedError(`agent ${agentId} was disenrolled during the task`);
            }
          }
          // The SECOND ownership fence (re-check before the run's own start):
          // an abort here is also the typed error.
          try {
            await assertRunOwned();
          } catch {
            throw new RunAbortedError("run aborted — delegation ownership lost");
          }
          // An ABORT-shaped outcome — the pre-start {error:'run aborted…'} OR a
          // mid-run {aborted:true} — must FAIL the delegation with a REAL
          // tool-error: the single predicate covers every shape, so no abort can
          // masquerade as a successful delegate result.
          if (isAbortShape(result)) {
            throw new RunAbortedError(`delegation aborted — the worker for ${agentId} was aborted`);
          }
          const workerResult = (result && typeof result === "object" && typeof result.text === "string") ? result.text : result;
          return { agentId, result: workerResult };
        },
      }),
    }
    : {};

  const master = createAgent({
    model,
    system: masterSystem ?? system,
    memory: masterMemory,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    iterationGuard,
    serverTooling,
    skillStore,
    workflowRunRoute,
    // `extraTools` stay out of this eager map. Their live records come from
    // readMasterLazySources; only delegation's existing closures are added to
    // the private built-in source map.
    tools: delegate,
    readLazySources: async () => {
      const extra = await readMasterLazySources(extraTools);
      return Array.isArray(extra) ? extra : [];
    },
    readLazyScope: readMasterLazyScope,
    untrustedToken,
    taskId,
    onProgress,
    onPermissionRequest,
    // SCOPED (hook) runs: the master's memory is READ-ONLY (no memory_set) —
    // untrusted event data must never persist hub state.
    readOnlyMemory: scoped,
  });

  return {
    master,
    workers: workerAgents,
    async run(task, context, history, runSkills, runIdentity = null, runPromotion = null) {
      // Solo/multi-agent runs expose the same two-tool provider surface. The
      // logical/durable identity is held only for this serialized run and is
      // inherited by delegated workers.
      currentRunIdentity = runIdentity && typeof runIdentity === "object"
        ? Object.freeze({ ...runIdentity })
        : Object.freeze({ runId: crypto.randomUUID(), taskId });
      try {
        return await master.run(
          task,
          context,
          history,
          undefined,
          runSkills,
          currentRunIdentity,
          runPromotion,
        );
      } finally {
        currentRunIdentity = null;
      }
    },
    abort() {
      master.abort();
    },
    // Whether the CURRENT run was aborted (the master's controller) — the SW
    // propagates it in the run response.
    isAborted: () => (typeof master.isAborted === "function" ? master.isAborted() : false),
    // The master's finite step budget (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01).
    budget: () => (typeof master.budget === "function" ? master.budget() : null),
    // Rebind the live progress callback on the master + every worker. The SW
    // calls this per-run; the cached orchestrator's agents are reused.
    setProgress(cb) {
      master.setProgress?.(cb);
      for (const a of workerAgents.values()) a.setProgress?.(cb);
    },
    // Rebind the run-bound prompt attestation sink on the master + every
    // worker (a delegated site run's attestation flows to the SAME run's
    // sink, tagged with the worker's agentId).
    setAttestation(cb) {
      master.setAttestation?.(cb);
      for (const a of workerAgents.values()) a.setAttestation?.(cb);
    },
    addWorker(config) {
      const a = createAgent({
        model,
        id: config.origin,
        name: config.origin,
        system: config.system ?? system,
        memory: config.memory,
        skills: config.skills ?? [],
        tools: config.tools ?? {},
        readLazySources: config.readLazySources ?? (async () => []),
        readLazyScope: config.readLazyScope ?? (async () => ({
          origin: config.origin,
          documentId: "",
        })),
        untrustedToken: config.untrustedToken ?? null,
        taskId,
        enrollmentGuard: delegateGuard
          ? async () => delegateGuard(config.origin)
          : null,
        disposable: true,
        onProgress,
        onPermissionRequest,
      });
      workerAgents.set(config.origin, a);
      return a;
    },
  };
}

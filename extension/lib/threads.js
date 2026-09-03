// lib/threads.js — the task-thread model.
//
// A task is a DISTINCT THREAD (not a single shared journal): each thread is its
// own conversation surface with its own persisted message history. The hub shows
// a LIST of threads (auto-named) and a thread opens as a full-screen surface
// that can be nudged/continued.
//
// Storage (master OPFS memory, origin-keyed):
//   - `threads`       — the index, most-recent-first: [{ id, name, preview,
//                        createdAt, updatedAt, status, count }]
//   - `thread:<id>`   — the full thread: { id, name, messages:
//                        [{ role, content, ts }], createdAt, updatedAt, status }
//
// Threads are INTERNAL authority (the model never writes them directly — the
// `memory_set` reserved-key list doesn't need to cover them because the hub
// writes them via `setTrusted`, and `threads`/`thread:<id>` are not reachable
// through the model toolset). Bounds match the journal: capped count + byte
// budget per thread so a long conversation cannot grow the store unbounded.

import { masterMemory, forgetDurableThread } from "./memory.js";
import { sanitizeAttachments } from "./attachments.js";
import { isPromptApiAvailable, createPromptApiModel } from "./models/prompt-api-model.js";

const INDEX_KEY = "threads";
const MAX_THREADS = 200; // the index cap
const MAX_MESSAGES = 500; // per-thread message cap
const MAX_MESSAGE_BYTES = 240 * 1024; // per-message ROW summary bound in UTF-8 BYTES — the most text a single message row may carry in the thread body (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 raised it from 16 KiB so the task view holds the COMPLETE agent response for every response that fits; the 256 KiB per-value bound memory.js MAX_VALUE_BYTES is physical, so a response beyond the per-row bound is NOT sliced into the row — the durable run journal (retainedPayloadRef) is the complete store and the row keeps a bounded digest + the ref (kmpq redesign).
const MAX_THREAD_BYTES = 248 * 1024; // per-thread serialized budget (below the memory store's 256 KiB per-value bound so a full-size response + envelope still stores; the tail is protected from eviction)
// kmpq redesign: the memory row for a durable terminal keeps only a bounded
// index/summary + retainedPayloadRef, never a giant slice. The digest bound is
// small so a thread holds many turns of large answers, and the complete text
// hydrates from the run log on open.
const MAX_ROW_DIGEST_BYTES = 16 * 1024;
const ROW_DIGEST_MARKER = "\n\n…(this view keeps a summary — the complete response is in the run log and opens in full)";
const MAX_NAME_CHARS = 80;
// Continuation-fidelity bounds: the journaled per-run tool summary and skill
// list are deliberately TINY (names + ok only — never args, results, or page
// content) so a long conversation cannot grow the store unbounded and the
// model on resume sees which tools ran without re-inflating result bodies.
const MAX_TERMINAL_TOOL_CALLS = 16;
const MAX_TERMINAL_TOOL_NAME = 64;
const MAX_TERMINAL_SKILLS = 24;
const MAX_PROMPT_HASH = 16;

/** Bound a run's tool-call summary: {name, ok} entries, newest kept, name
 * truncated. Pure — testable without OPFS. */
export function boundToolCalls(toolCalls) {
  const src = Array.isArray(toolCalls) ? toolCalls : [];
  const out = [];
  for (let i = src.length - 1; i >= 0 && out.length < MAX_TERMINAL_TOOL_CALLS; i--) {
    const tc = src[i];
    const name = String(tc?.name ?? "").slice(0, MAX_TERMINAL_TOOL_NAME);
    if (!name) continue;
    out.unshift({ name, ok: tc?.ok === true });
  }
  return out;
}

/** Bound a run's journaled skill id list (deduped, newest kept). Pure. */
export function boundSkillIds(skills) {
  const src = Array.isArray(skills) ? skills : [];
  const out = [];
  const seen = new Set();
  for (let i = src.length - 1; i >= 0 && out.length < MAX_TERMINAL_SKILLS; i--) {
    const id = String(src[i] ?? "").slice(0, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.unshift(id);
  }
  return out;
}

/** Bound a prompt-composition hash to its short stable form. Pure. */
export function boundPromptHash(hash) {
  const s = String(hash ?? "");
  return s.length > MAX_PROMPT_HASH ? s.slice(0, MAX_PROMPT_HASH) : s;
}

/** The compact tool summary rendered into the assistant turn the model sees
 * on continuation: `[tools: name(ok), name(failed)]` — names + outcome only,
 * never args/results. Empty toolCalls render no prefix. Pure. */
export function toolCallsPrefix(toolCalls) {
  const calls = boundToolCalls(toolCalls);
  if (calls.length === 0) return "";
  const parts = calls.map((c) => `${c.name}(${c.ok ? "ok" : "failed"})`);
  return `[tools: ${parts.join(", ")}]`;
}

function newThreadId() {
  return newId("t");
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str).byteLength;
}

/** A short preview for the index (first line, bounded). */
function previewOf(text) {
  // A leading "[… model]" transport tag (the demo model's marker) is never
  // something a person should read in the sidebar; a person's own bracketed
  // prefix ("[urgent] …") is theirs and stays (CAP-FB-20260830-USER-VOICE-COPY-01).
  const first = String(text ?? "").split(/\n+/)[0].trim().replace(/^\[[^\]\n]*\bmodel\b[^\]\n]*\]\s*/i, "");
  const s = first.length > 160 ? first.slice(0, 160) + "…" : first;
  return s;
}

// SECRET-SAFE + bounded (the final review's HIGH): every string persisted
// into a thread (messages, lastError, index rows) is redacted so a credential
// echoed by a hostile endpoint can never reach thread storage. NOTE: the
// redaction is UNBOUNDED (redactSecretText) — safeProviderError also caps at
// 300 chars for ERROR text, which is wrong for message content
// (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01: a response was cut to 300 chars
// at commit). The message-content cap is applied HERE, not inside the redactor.
import { newId, redactSecretText } from "./pure.js";
/** Byte-aware digest for an over-budget durable response stored in a thread
 * row: keep the head up to `maxBytes` and append the never-silent affordance.
 * The cut never splits a UTF-16 surrogate pair. Pure — testable without OPFS.
 * Exported so the durable outbox builds the SAME digest text by reference. */
export function boundResponseDigest(text, maxBytes = MAX_ROW_DIGEST_BYTES) {
  const s = redactSecretText(String(text ?? ""));
  if (utf8Bytes(s) <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - utf8Bytes(ROW_DIGEST_MARKER));
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Bytes(s.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  while (lo > 0) {
    const c = s.charCodeAt(lo - 1);
    if (c >= 0xD800 && c <= 0xDBFF) { lo -= 1; continue; }
    break;
  }
  return `${s.slice(0, lo)}${ROW_DIGEST_MARKER}`;
}

/** Bounded provider-server grounding (citations + executed queries): the SAME
 * caps commitThreadTerminal applies, shared so the durable outbox builds an
 * envelope that can never approach the memory-store bound. Pure. */
export function boundTerminalEnvelope(terminal, role = "assistant") {
  const out = {};
  const citations = Array.isArray(terminal?.citations)
    ? terminal.citations.slice(0, 32).map((c) => ({
      url: boundText(c?.url ?? "", 1024),
      title: boundText(c?.title ?? "", 256),
      ...(Number.isInteger(c?.startIndex) ? { startIndex: c.startIndex } : {}),
      ...(Number.isInteger(c?.endIndex) ? { endIndex: c.endIndex } : {}),
      ...(typeof c?.citedText === "string" ? { citedText: boundText(c.citedText, 512) } : {}),
      provider: boundText(c?.provider ?? "", 32),
    })).filter((c) => /^https:\/\//u.test(c.url))
    : null;
  if (citations && citations.length > 0) out.citations = citations;
  const serverToolEvents = Array.isArray(terminal?.serverToolEvents)
    ? terminal.serverToolEvents.slice(0, 16).map((e) => ({
      kind: boundText(e?.kind ?? "", 64),
      query: boundText(e?.query ?? "", 512),
    })).filter((e) => e.kind && e.query)
    : null;
  if (serverToolEvents && serverToolEvents.length > 0) out.serverToolEvents = serverToolEvents;
  if (role === "assistant") {
    if (Array.isArray(terminal?.toolCalls) && terminal.toolCalls.length > 0) out.toolCalls = boundToolCalls(terminal.toolCalls);
    if (Array.isArray(terminal?.skills) && terminal.skills.length > 0) out.skills = boundSkillIds(terminal.skills);
    if (typeof terminal?.promptHash === "string" && terminal.promptHash) out.promptHash = boundPromptHash(terminal.promptHash);
  }
  return out;
}
function boundText(text, max = MAX_MESSAGE_BYTES) {
  const s = redactSecretText(String(text ?? ""));
  // The cap is UTF-8 BYTES (the memory store bound is byte-based): multi-byte
  // content (emoji/CJK) would otherwise bust the store at fewer chars. Binary
  // search the largest char prefix that fits the byte budget, reserving room
  // for the truncation marker so slice + marker stay within the cap.
  if (utf8Bytes(s) <= max) return s;
  const isMessage = max === MAX_MESSAGE_BYTES;
  // Honest by construction (kmpq): boundText is reached only for content with
  // NO durable run copy (a durable terminal takes the digest path above and
  // names the retained payload). Claiming the complete text is in a run log
  // would be a lie for a plain appended row — say what is actually lost.
  const marker = isMessage
    ? `\n\n…(response truncated to ${(max / 1024).toFixed(0)} KiB — the remainder was not retained)`
    : "";
  const budget = Math.max(0, max - utf8Bytes(marker));
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Bytes(s.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  const sliced = s.slice(0, lo);
  // r2 B5: a cut landing between a UTF-16 surrogate pair leaves a lone high
  // surrogate — back off to the pair boundary (an emoji straddling the byte
  // budget must be kept whole or dropped whole, never halved).
  while (lo > 0) {
    const c = s.charCodeAt(lo - 1);
    if (c >= 0xD800 && c <= 0xDBFF) { lo -= 1; continue; }
    break;
  }
  const slicedFinal = s.slice(0, lo);
  // Never silently truncate the human-readable content: when the DEFAULT
  // (message-content) cap is hit, say so — the complete text is kept in the
  // durable run journal (retainedPayloadRef) and in the run log.
  return isMessage ? `${slicedFinal}${marker}` : slicedFinal;
}

/** Trim a thread's messages to the count + byte budget (drop the OLDEST),
 * but NEVER evict the final turn's terminal assistant/error row + its
 * triggering user row (a self-embedding tool-row blowout must not drop the
 * question or its answer). */
function trimMessages(messages) {
  const entries = messages.slice(-MAX_MESSAGES);
  const keepFrom = protectedTailStart(entries);
  let prefix = entries.slice(0, keepFrom);
  const tail = entries.slice(keepFrom);
  while (
    prefix.length > 0 &&
    utf8Bytes(JSON.stringify([...prefix, ...tail])) > MAX_THREAD_BYTES
  ) {
    prefix = prefix.slice(1);
  }
  return [...prefix, ...tail];
}

/** The index of the first message that must never be evicted: the user row
 * immediately before the LAST terminal (assistant/error) row. If there is no
 * terminal row, nothing is protected (the count/budget trim applies as before).
 * If there is a terminal but no preceding user, protect just the terminal. */
function protectedTailStart(entries) {
  let terminalIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i];
    if (m && (m.role === "assistant" || m.role === "error")) { terminalIdx = i; break; }
  }
  if (terminalIdx < 0) return entries.length;
  for (let i = terminalIdx - 1; i >= 0; i--) {
    const m = entries[i];
    if (m && m.role === "user") return i;
  }
  return terminalIdx;
}

/** The thread index (most-recent-first). */
export async function listThreads() {
  const mem = masterMemory();
  const index = (await mem.get(INDEX_KEY)) ?? [];
  return Array.isArray(index) ? index.slice(0, MAX_THREADS) : [];
}

/** A full thread, or null. */
export async function getThread(id) {
  if (!id) return null;
  const mem = masterMemory();
  return (await mem.get(`thread:${id}`)) ?? null;
}

// A per-thread mutex serializes EVERY index/body read-modify-write. The old
// unlocked sequences (read index → mutate → write index, and read body → mutate
// → write body) let two concurrent creates/continuations last-write-wins (a
// persisted thread silently dropped from the index, or one continuation's
// messages overwritten). All thread mutations run under this lock (the
// wider-goal review's thread-race finding).
let threadMutex = Promise.resolve();
function withThreadLock(fn) {
  const run = threadMutex.then(fn, fn);
  threadMutex = run.then(() => {}, () => {});
  return run;
}

async function writeIndex(index) {
  const mem = masterMemory();
  const next = index.slice(0, MAX_THREADS);
  // Eviction must atomically delete the evicted thread BODIES, not only drop
  // their index rows — an index-row-only truncation orphaned `thread:<id>`
  // values that then accumulated (the wider-goal review's retention finding).
  const old = (await mem.get(INDEX_KEY)) ?? [];
  const kept = new Set(next.map((r) => r.id));
  for (const row of old) {
    if (row?.id && !kept.has(row.id)) {
      try {
        await mem.delete(`thread:${row.id}`);
      } catch { /* absent */ }
    }
  }
  await mem.setTrusted(INDEX_KEY, next);
}

/**
 * Generate a short title for a task. Uses the Chrome Prompt API (Gemini nano)
 * when available; otherwise falls back to the first line of the prompt
 * (truncated). Never throws — naming is best-effort.
 */
export async function generateThreadName(task) {
  const text = String(task ?? "").trim();
  if (!text) return "New task";
  try {
    if (await isPromptApiAvailable()) {
      const model = createPromptApiModel();
      const res = await model.doGenerate({
        prompt: [{
          role: "user",
          content: [{
            type: "text",
            text:
              `Generate a short title for this task (at most 6 words, no quotes, ` +
              `no trailing punctuation). Return ONLY the title:\n\n${text.slice(0, 500)}`,
          }],
        }],
      });
      const title = String(res?.content?.[0]?.text ?? "").trim();
      if (title && title.length <= MAX_NAME_CHARS) {
        return title;
      }
    }
  } catch { /* fall through to the truncated fallback */ }
  const first = text.split(/\n+/)[0].replace(/^```[a-z0-9]*\s*/i, "").trim();
  const s = first || "New task";
  return s.length > 48 ? s.slice(0, 48) + "…" : s;
}

/**
 * Create a new thread for a task, named with a FAST fallback (the first line)
 * so the task is never blocked on a model call. Returns the thread. The caller
 * should then call `nameThreadAsync` to upgrade the name via the model.
 */
export async function createThread(task, attachments) {
  return withThreadLock(async () => {
  const mem = masterMemory();
  const id = newThreadId();
  const now = Date.now();
  const fallbackName = boundText(previewOf(task) || "New task", MAX_NAME_CHARS);
  const thread = {
    id,
    name: fallbackName,
    messages: [{ role: "user", content: boundText(task), ts: now, ...(sanitizeAttachments(attachments) ? { attachments: sanitizeAttachments(attachments) } : {}) }],
    createdAt: now,
    updatedAt: now,
    status: "running",
  };
  await mem.setTrusted(`thread:${id}`, thread);
  const index = (await mem.get(INDEX_KEY)) ?? [];
  index.unshift({
    id,
    name: fallbackName,
    preview: previewOf(task),
    createdAt: now,
    updatedAt: now,
    status: "running",
    count: 1,
  });
  await writeIndex(index);
  return thread;
  });
}

/** Fire-and-forget: upgrade a thread's name via the model, then update the
 * index. Never throws (best-effort). The Prompt API await runs OUTSIDE the
 * global thread mutex (the wider-goal review's finding: holding the mutex
 * across a model await blocked ALL thread mutations); the lock is taken only
 * for the read-modify-write of the stored name. */
export async function nameThreadAsync(id, task) {
  let name;
  try {
    name = await generateThreadName(task);
  } catch {
    return; // best-effort naming
  }
  return withThreadLock(async () => {
    try {
      const mem = masterMemory();
      const thread = (await mem.get(`thread:${id}`)) ?? null;
      if (!thread) return;
      thread.name = name;
      await mem.setTrusted(`thread:${id}`, thread);
      const index = (await mem.get(INDEX_KEY)) ?? [];
      const row = index.find((r) => r.id === id);
      if (row) row.name = name;
      await writeIndex(index);
    } catch { /* best-effort naming */ }
  });
}

/** Rename a thread (the user edits the title). Updates the thread body + the
 * index row's name under the per-thread lock. Returns false when absent. */
export async function renameThread(id, name) {
  if (!id) return false;
  const trimmed = boundText(String(name ?? "").trim(), MAX_NAME_CHARS);
  if (!trimmed) return false;
  return withThreadLock(async () => {
    const mem = masterMemory();
    const thread = (await mem.get(`thread:${id}`)) ?? null;
    if (!thread) return false;
    thread.name = trimmed;
    await mem.setTrusted(`thread:${id}`, thread);
    const index = (await mem.get(INDEX_KEY)) ?? [];
    const row = index.find((r) => r.id === id);
    if (row) row.name = trimmed;
    await writeIndex(index);
    return true;
  });
}

/** Append a message to a thread + update the index (preview/time/status). */
export async function appendThreadMessage(id, message) {
  if (!id) return null;
  return withThreadLock(async () => {
  const mem = masterMemory();
  const thread = (await mem.get(`thread:${id}`)) ?? null;
  if (!thread) return null;
  const { role = "assistant", content = "" } = message ?? {};
  thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
  const att = sanitizeAttachments(message?.attachments);
  const isTool = Boolean(message?.toolName);
  // An INTERIM assistant row: one step's text of a still-running execution
  // (CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01). It carries the executionId
  // AND a step index; the terminal row of the same execution carries no step,
  // which is how the two are told apart everywhere (commit, projection).
  const isInterim = !isTool && role === "assistant" && Boolean(message?.executionId) && Number.isInteger(message?.step);
  // TOOL rows pass through their structured fields (toolName/toolStatus/args/
  // result/ok/duration + the pairing callId) so a reopened thread can replay
  // them as ONE terminal card per call — the thread is not just text. The tool
  // RESULT is bounded (the DEFECT B self-embedding loop: a memory_get of
  // thread:<id> returning the whole body can no longer store an unbounded copy
  // of the thread back into itself).
  const entry = {
    role,
    content: boundText(content),
    ts: Date.now(),
    ...(att ? { attachments: att } : {}),
    ...(isTool
      ? {
        toolName: message.toolName,
        toolStatus: message.toolStatus ?? "running",
        toolArgs: message.toolArgs ?? null,
        toolResult: message.toolResult != null ? boundText(message.toolResult) : null,
        toolOk: message.toolOk ?? null,
        toolDuration: message.toolDuration ?? null,
        toolCallId: message.toolCallId ?? null,
        // Persist the execution identity on the row so a later projection can
        // attribute legacy body tool rows to their run (dedup with the
        // log-derived view).
        ...(message?.executionId ? { executionId: String(message.executionId) } : {}),
      }
      : {}),
    ...(isInterim ? { executionId: String(message.executionId), step: message.step } : {}),
  };
  // DEFECT A (the ordering): a tool row for an execution whose terminal
  // assistant/error row is ALREADY committed (the durable outbox commits the
  // terminal first; the post-run tool replay runs after) must land BEFORE that
  // terminal row — never after — so the thread ends on the terminal, not a
  // tool row. The insert is keyed by the immutable executionId.
  const execId = message?.executionId;
  if (isTool && execId) {
    const terminalIdx = thread.messages.findIndex(
      (m) => m?.executionId === execId && (m.role === "assistant" || m.role === "error"),
    );
    if (terminalIdx >= 0) thread.messages.splice(terminalIdx, 0, entry);
    else thread.messages.push(entry);
  } else {
    thread.messages.push(entry);
  }
  thread.messages = trimMessages(thread.messages);
  thread.updatedAt = Date.now();
  // Tool-card replay may happen after the durable terminal outbox has already
  // committed the assistant/error row. A non-terminal tool append must never
  // regress that authoritative terminal status back to "running".
  thread.status = isInterim
    ? (["done", "error"].includes(thread.status) ? thread.status : "running")
    : role === "assistant"
    ? "done"
    : role === "error"
      ? "error"
      : role === "tool" && ["done", "error"].includes(thread.status)
        ? thread.status
        : "running";
  await mem.setTrusted(`thread:${id}`, thread);
  const index = (await mem.get(INDEX_KEY)) ?? [];
  const row = index.find((r) => r.id === id);
  if (row) {
    const lastText = [...thread.messages].reverse().find((m) => m.role === "user" || m.role === "assistant" || m.role === "error")?.content ?? "";
    row.preview = previewOf(lastText);
    row.updatedAt = thread.updatedAt;
    row.status = thread.status;
    row.count = thread.messages.length;
    await writeIndex(index);
  }
  return thread;
  });
}

/** Idempotently commit one terminal assistant/error message and thread status
 * for an immutable execution. Outbox recovery can repeat this after any crash;
 * the executionId check and body/index update share the thread mutex. */
/** Explicit cancellation replaces any partially committed terminal message for
 * the same immutable execution and derives a visible cancelled thread state. */
export async function commitThreadCancellation(id, executionId, terminal) {
  if (!id || !executionId) return null;
  return withThreadLock(async () => {
    const mem = masterMemory();
    const thread = (await mem.get(`thread:${id}`)) ?? null;
    if (!thread) return null;
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    const content = boundText(terminal?.content ?? "Run cancelled by owner");
    const replacement = {
      role: "error",
      content,
      executionId,
      ts: Date.now(),
      category: "cancelled",
      reason: terminal?.reason ?? "explicit owner cancellation",
      action: "Start a new run to execute this request again.",
      cancelled: true,
    };
    const index = thread.messages.findIndex((message) => message?.executionId === executionId);
    if (index >= 0) thread.messages[index] = replacement;
    else thread.messages.push(replacement);
    thread.status = "cancelled";
    thread.lastError = {
      message: content,
      tool: null,
      category: "cancelled",
      reason: replacement.reason,
      action: replacement.action,
      at: Date.now(),
      executionId,
    };
    thread.updatedAt = Date.now();
    await mem.setTrusted(`thread:${id}`, thread);
    const rows = (await mem.get(INDEX_KEY)) ?? [];
    const row = rows.find((entry) => entry.id === id);
    if (row) {
      row.preview = previewOf(content);
      row.updatedAt = thread.updatedAt;
      row.status = "cancelled";
      row.count = thread.messages.length;
      row.error = content;
      await writeIndex(rows);
    }
    return thread;
  });
}

export async function commitThreadTerminal(id, executionId, terminal) {
  if (!id || !executionId) return null;
  return withThreadLock(async () => {
    const mem = masterMemory();
    const thread = (await mem.get(`thread:${id}`)) ?? null;
    if (!thread) return null;
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    // Interim (per-step) assistant rows share the executionId but carry a
    // step index; only a step-less assistant/error row is the terminal.
    const isTerminalRow = (message) => message?.executionId === executionId && !Number.isInteger(message?.step);
    const existing = thread.messages.find(isTerminalRow);
    if (!existing) {
      const role = terminal?.role === "assistant" ? "assistant" : "error";
      const rawContent = String(terminal?.content ?? (role === "error" ? "run failed" : ""));
      const ref = typeof terminal?.retainedPayloadRef === "string" && terminal.retainedPayloadRef
        ? terminal.retainedPayloadRef
        : null;
      // kmpq redesign: when the durable run journal holds the complete copy
      // (retainedPayloadRef), a response beyond the per-row bound keeps a
      // bounded digest in the row — never a giant slice. Where no durable copy
      // exists the per-row bound stays the honest ceiling (boundText marker).
      const content = ref && utf8Bytes(rawContent) > MAX_MESSAGE_BYTES
        ? boundResponseDigest(rawContent)
        : boundText(rawContent);
      // The answer appears ONCE: an interim row whose text equals the terminal
      // (the step that already answered) is replaced by the terminal row. The
      // durable terminal may arrive as a digest (over the per-row bound), so a
      // matching byte-capped interim of the SAME answer is replaced too — the
      // interim row is a live-stream slice of the same response and must not
      // duplicate the terminal bubble. boundText(rawContent) over a huge
      // response is costly, so it runs only when such an interim row exists.
      const interimCandidate = thread.messages.find((m) =>
        m?.executionId === executionId && Number.isInteger(m?.step) && m.role === "assistant" && m.content !== content);
      const interimTextForDedupe = interimCandidate ? boundText(rawContent) : content;
      thread.messages = thread.messages.filter((message) =>
        !(message?.executionId === executionId && Number.isInteger(message?.step) && message.role === "assistant" &&
          (message.content === content || message.content === interimTextForDedupe)));
      const envelope = boundTerminalEnvelope(terminal, role);
      thread.messages.push({
        role,
        content,
        executionId,
        ...(ref ? { retainedPayloadRef: ref } : {}),
        ts: Date.now(),
        ...envelope,
        ...(role === "error"
          ? {
            tool: terminal?.tool ?? undefined,
            category: terminal?.category ?? "error",
            reason: terminal?.reason ?? undefined,
            action: terminal?.action ?? undefined,
          }
          : {}),
      });
      thread.messages = trimMessages(thread.messages);
    }
    // A repeated executionId always derives status/detail from the first
    // committed message. Even a conflicting replay payload cannot change the
    // winning terminal outcome; retries only repair a possibly-missed index.
    const committed = existing ?? thread.messages.find(isTerminalRow);
    const committedTerminal = committed?.role === "assistant"
      ? { role: "assistant", content: committed.content, status: "done" }
      : {
        role: "error",
        content: committed?.content ?? "run failed",
        status: "error",
        tool: committed?.tool ?? null,
        category: committed?.category ?? "error",
        reason: committed?.reason ?? null,
        action: committed?.action ?? null,
      };
    thread.status = committedTerminal.status;
    if (thread.status === "done") {
      delete thread.lastError;
    } else {
      // lastError is a DIAGNOSTIC summary surface, not the reader: it must
      // stay a small bounded preview so the full error text (in the message
      // row, the task view's source) is not stored twice and the thread value
      // cannot blow the memory store's per-value bound
      // (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 r2 B3).
      thread.lastError = {
        message: boundText(committedTerminal.content, 4 * 1024),
        tool: committedTerminal.tool ?? null,
        category: committedTerminal.category ?? "error",
        reason: committedTerminal.reason ?? null,
        action: committedTerminal.action ?? null,
        at: Date.now(),
        executionId,
      };
    }
    thread.updatedAt = Date.now();
    await mem.setTrusted(`thread:${id}`, thread);
    const index = (await mem.get(INDEX_KEY)) ?? [];
    const row = index.find((entry) => entry.id === id);
    if (row) {
      row.preview = previewOf(committedTerminal.content);
      row.updatedAt = thread.updatedAt;
      row.status = thread.status;
      row.count = thread.messages.length;
      if (thread.status === "done") delete row.error;
      // The SIDEBAR error preview stays a small bounded preview (a list
      // surface) — the durable/terminal-commit path is covered too, like the
      // recordThreadError path (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 r2 B3).
      else row.error = boundText(committedTerminal.content, 1024);
      await writeIndex(index);
    }
    return thread;
  });
}

/** Continue an EXISTING thread: atomically (under the thread lock) read the
 * thread, snapshot its history (the PRIOR turns, excluding the new user turn),
 * append the new user message, and return { thread, history }. This closes the
 * wider-goal review's concurrency finding — two concurrent nudges previously
 * read the SAME pre-append history, so the second run's model context diverged
 * from the persisted thread. The read + append + history-derivation now happen
 * under one lock. */
export async function continueThread(id, task, attachments) {
  if (!id) return { thread: null, history: [] };
  return withThreadLock(async () => {
    const mem = masterMemory();
    const thread = (await mem.get(`thread:${id}`)) ?? null;
    if (!thread) return { thread: null, history: [] };
    const history = historyFromThread(thread);
    // Continuation fidelity: the union of every journaled skill id across the
    // thread's terminal rows, so a resumed run re-applies skills that earlier
    // turns referenced even when this new message does not re-mention them.
    const skills = threadJournaledSkills(thread);
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    const att = sanitizeAttachments(attachments);
    thread.messages.push({
      role: "user",
      content: boundText(task),
      ts: Date.now(),
      ...(att ? { attachments: att } : {}),
    });
    thread.messages = trimMessages(thread.messages);
    thread.updatedAt = Date.now();
    thread.status = "running";
    await mem.setTrusted(`thread:${id}`, thread);
    const index = (await mem.get(INDEX_KEY)) ?? [];
    const row = index.find((r) => r.id === id);
    if (row) {
      row.preview = previewOf(thread.messages[thread.messages.length - 1]?.content ?? "");
      row.updatedAt = thread.updatedAt;
      row.status = thread.status;
      row.count = thread.messages.length;
      await writeIndex(index);
    }
    return { thread, history, skills };
  });
}

/** Mark a thread's final status (done / error). A successful transition clears
 * any prior error detail (a retry that succeeds wipes the stale failure). */
export async function setThreadStatus(id, status) {
  if (!id) return;
  return withThreadLock(async () => {
  const mem = masterMemory();
  const thread = (await mem.get(`thread:${id}`)) ?? null;
  if (!thread) return;
  thread.status = status;
  if (status === "done") delete thread.lastError;
  thread.updatedAt = Date.now();
  await mem.setTrusted(`thread:${id}`, thread);
  const index = (await mem.get(INDEX_KEY)) ?? [];
  const row = index.find((r) => r.id === id);
  if (row) {
    row.status = status;
    if (status === "done") delete row.error;
    row.updatedAt = thread.updatedAt;
    await writeIndex(index);
  }
  });
}

/** Record a task FAILURE so the user can see WHY it failed (not just a red
 * dot): append an `error` message to the thread + store a `lastError` detail
 * (message + the tool that failed) + mark the thread "error" + surface the
 * error as the index preview. The thread surface renders the `error` message as
 * a danger-styled bubble (MessageBubble role="error"). */
export async function recordThreadError(id, detail) {
  if (!id) return null;
  return withThreadLock(async () => {
    const mem = masterMemory();
    const thread = (await mem.get(`thread:${id}`)) ?? null;
    if (!thread) return null;
    // The comprehensive error detail: the category + the UNDERLYING reason +
    // the actionable "what to do", plus the failed tool. The thread surface
    // renders the reason prominently + the action as guidance (not a raw
    // "No output generated" wrapper).
    const message = boundText(String(detail?.message ?? "run failed"));
    const tool = detail?.tool ? String(detail.tool) : null;
    const category = detail?.category ? String(detail.category) : "error";
    const reason = detail?.reason ? boundText(String(detail.reason)) : null;
    const action = detail?.action ? boundText(String(detail.action)) : null;
    // The raw diagnostic detail is a LIST-surface too (the sidebar preview); it
    // must stay a small bounded preview — only the task view's own bubble may
    // carry the full message (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 r1 B3).
    const raw = detail?.detail ? boundText(String(detail.detail), 4 * 1024) : null;
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    thread.messages.push({
      role: "error",
      content: message,
      tool: tool ?? undefined,
      category: category,
      reason: reason ?? undefined,
      action: action ?? undefined,
      ts: Date.now(),
    });
    thread.messages = trimMessages(thread.messages);
    thread.status = "error";
    thread.lastError = { message, tool, category, reason, action, raw, at: Date.now() };
    thread.updatedAt = Date.now();
    await mem.setTrusted(`thread:${id}`, thread);
    const index = (await mem.get(INDEX_KEY)) ?? [];
    const row = index.find((r) => r.id === id);
    if (row) {
      row.status = "error";
      // The SIDEBAR preview stays a small bounded preview (a list surface) —
      // never the full message text (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 r1 B3).
      const sidebarPreview = boundText(message, 1024);
      row.error = sidebarPreview;
      row.preview = sidebarPreview;
      row.updatedAt = thread.updatedAt;
      row.count = thread.messages.length;
      await writeIndex(index);
    }
    return thread;
  });
}

/** Build the conversation history (agent-do turn shape) from a thread. */
export function historyFromThread(thread) {
  const out = [];
  for (const m of (thread?.messages ?? [])) {
    if (m?.role === "user" && m.content) out.push({ role: "user", content: m.content });
    else if (m?.role === "assistant" && m.content) {
      // Continuation fidelity: the assistant turn the model sees carries the
      // compact tool summary (`[tools: name(ok), name(failed)]`) so a resumed
      // run knows which tools ran — the full tool rows stay render-only.
      const prefix = toolCallsPrefix(m.toolCalls);
      out.push({ role: "assistant", content: prefix ? `${prefix}\n${m.content}` : m.content });
    }
  }
  return out;
}

/** The union of every journaled skill id across a thread's terminal rows —
 * what a continuation must re-apply so a skill referenced in an earlier turn
 * survives into a resumed run even when the new message does not re-mention
 * it. Bounded + deduped. */
export function threadJournaledSkills(thread) {
  return boundSkillIds(
    (thread?.messages ?? [])
      .filter((m) => m?.role === "assistant" && Array.isArray(m?.skills))
      .flatMap((m) => m.skills),
  );
}

/**
 * Delete a thread (the owner-facing task-list delete). Removes the index row AND
 * the thread body atomically under the thread lock (never an index-row-only
 * truncation that orphans the `thread:<id>` body). Returns true if it existed.
 */
export async function deleteThread(id) {
  if (!id) return false;
  return withThreadLock(async () => {
    const mem = masterMemory();
    const thread = (await mem.get(`thread:${id}`)) ?? null;
    const index = (await mem.get(INDEX_KEY)) ?? [];
    const next = index.filter((r) => r.id !== id);
    if (thread === null && next.length === index.length) return false;
    if (thread !== null) {
      try { await mem.delete(`thread:${id}`); } catch { /* absent */ }
    }
    if (next.length !== index.length) {
      await mem.setTrusted(INDEX_KEY, next.slice(0, MAX_THREADS));
    }
    // Drop the thread's durable reverse index too. Best-effort: losing the
    // thread record already succeeded, and a failed cleanup must not report the
    // delete as failed — but skipping it entirely leaks a directory per
    // deleted thread.
    await forgetDurableThread(id).catch(() => false);
    return true;
  });
}

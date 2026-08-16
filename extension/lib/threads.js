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

import { masterMemory } from "./memory.js";
import { isPromptApiAvailable, createPromptApiModel } from "./models/prompt-api-model.js";

const INDEX_KEY = "threads";
const MAX_THREADS = 200; // the index cap
const MAX_MESSAGES = 500; // per-thread message cap
const MAX_MESSAGE_CHARS = 16 * 1024; // per-message text cap
const MAX_THREAD_BYTES = 200 * 1024; // per-thread serialized budget
const MAX_NAME_CHARS = 80;

function newThreadId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str).byteLength;
}

/** A short preview for the index (first line, bounded). */
function previewOf(text) {
  const first = String(text ?? "").split(/\n+/)[0].trim();
  const s = first.length > 160 ? first.slice(0, 160) + "…" : first;
  return s;
}

function boundText(text, max = MAX_MESSAGE_CHARS) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/** Trim a thread's messages to the count + byte budget (drop the OLDEST). */
function trimMessages(messages) {
  let entries = messages.slice(-MAX_MESSAGES);
  while (
    entries.length > 1 && utf8Bytes(JSON.stringify(entries)) > MAX_THREAD_BYTES
  ) {
    entries = entries.slice(1);
  }
  return entries;
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
export async function createThread(task) {
  return withThreadLock(async () => {
  const mem = masterMemory();
  const id = newThreadId();
  const now = Date.now();
  const fallbackName = boundText(previewOf(task) || "New task", MAX_NAME_CHARS);
  const thread = {
    id,
    name: fallbackName,
    messages: [{ role: "user", content: boundText(task), ts: now }],
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

/** Append a message to a thread + update the index (preview/time/status). */
export async function appendThreadMessage(id, message) {
  if (!id) return null;
  return withThreadLock(async () => {
  const mem = masterMemory();
  const thread = (await mem.get(`thread:${id}`)) ?? null;
  if (!thread) return null;
  const { role = "assistant", content = "" } = message ?? {};
  thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
  thread.messages.push({
    role,
    content: boundText(content),
    ts: Date.now(),
  });
  thread.messages = trimMessages(thread.messages);
  thread.updatedAt = Date.now();
  thread.status = role === "assistant" ? "done" : "running";
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
export async function continueThread(id, task) {
  if (!id) return { thread: null, history: [] };
  return withThreadLock(async () => {
    const mem = masterMemory();
    const thread = (await mem.get(`thread:${id}`)) ?? null;
    if (!thread) return { thread: null, history: [] };
    const history = historyFromThread(thread);
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    thread.messages.push({
      role: "user",
      content: boundText(task),
      ts: Date.now(),
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
    return { thread, history };
  });
}

/** Mark a thread's final status (done / error). */
export async function setThreadStatus(id, status) {
  if (!id) return;
  return withThreadLock(async () => {
  const mem = masterMemory();
  const thread = (await mem.get(`thread:${id}`)) ?? null;
  if (!thread) return;
  thread.status = status;
  thread.updatedAt = Date.now();
  await mem.setTrusted(`thread:${id}`, thread);
  const index = (await mem.get(INDEX_KEY)) ?? [];
  const row = index.find((r) => r.id === id);
  if (row) {
    row.status = status;
    row.updatedAt = thread.updatedAt;
    await writeIndex(index);
  }
  });
}

/** Build the conversation history (agent-do turn shape) from a thread. */
export function historyFromThread(thread) {
  const out = [];
  for (const m of (thread?.messages ?? [])) {
    if (m?.role === "user" && m.content) out.push({ role: "user", content: m.content });
    else if (m?.role === "assistant" && m.content) out.push({ role: "assistant", content: m.content });
  }
  return out;
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
    return true;
  });
}

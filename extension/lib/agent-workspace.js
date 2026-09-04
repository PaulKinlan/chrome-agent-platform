// lib/agent-workspace.js — each named/background agent's PRIVATE persistent
// workspace (CAP-FB-20260831-AGENT-PRIVATE-FS-01, owner-directed).
//
// ChatGPT Work gives every session a persistent scratch folder plus a shared
// volume; our equivalent: every named/background agent gets its own persistent
// OPFS directory `agent-workspaces/<agentKey>/` — private to that agent,
// created lazily on first use, and readable/writable by the agent WITHOUT any
// owner fs-grant (same trust level as its origin-keyed memory). The owner's
// fs-grants remain the shared/global surface for everything outside an agent.
//
// Isolation: the workspace key derives from the RUN CONTEXT's agent identity
// (`agentSurfaceRef` = `named:<slug>` / `background:<slug>`). A run that has no
// agent identity (hub / site / hook runs) has NO workspace — `resolveAgentKey`
// returns null and every op fails with `no_agent_workspace`. Two agents can
// never see each other's directories because each op resolves its own key from
// the run stamp, and OPFS directory handles are never shared.
//
// Storage: NO artificial per-agent quota (owner directive 2026-09-04). The
// workspace is bounded only by the browser's native OPFS allocation — if
// Chrome refuses a write under real storage pressure, the platform's own
// error surfaces honestly. Individual reads and writes carry no size cap of
// their own (post-dptw contract): a read returns the complete content at any
// size, paged with offset/length. Path grammar is the same bounded ASCII
// segment walk as fs-grants (cleanRelativePath).

import { cleanRelativePath, computeSha256 } from "./fs-grants.js";
import { currentRunContext } from "./run-context.js";
// The agent-id slug MUST come from the named-agents authority (review round-1
// P2a): run contexts stamp agentSurfaceRef from slugifyAgentId, so any local
// re-implementation (no 64-char slice, dashes kept) would have Settings
// address a DIFFERENT directory than the one the agent's runs use.
import { slugifyAgentId } from "./named-agents.js";

export const WORKSPACE_ROOT = "agent-workspaces";
export const MAX_WORKSPACE_DEPTH = 8; // bounded nesting inside an agent workspace

/** Derive the agent's workspace key from the run context's agentSurfaceRef.
 * `named:<slug>` / `background:<slug>` map to `named-<slug>` / `background-<slug>`;
 * anything else (hub, site, hook, or no stamp) has no private workspace. */
export function workspaceKeyFromSurfaceRef(agentSurfaceRef) {
  if (typeof agentSurfaceRef !== "string" || !agentSurfaceRef) return null;
  const m = agentSurfaceRef.match(/^(named|background):([a-z0-9][a-z0-9-]{0,127})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

/** The workspace key for a named agent id (Settings surface): `named-<slug>`.
 * The slug is slugifyAgentId (the SAME function that stamps the run context's
 * agentSurfaceRef — 64-char slice included) so the Settings row addresses the
 * SAME directory the run-context resolver uses. */
export function workspaceKeyFromAgentId(agentId) {
  return `named-${slugifyAgentId(agentId) || "unnamed"}`;
}

/** The workspace key for a background/scheduled agent id: `background-<slug>`. */
export function backgroundWorkspaceKeyFromAgentId(agentId) {
  return `background-${slugifyAgentId(agentId) || "unnamed"}`;
}

function failClosed(name, detail) {
  const error = new Error(`agent workspace fail-closed: ${name}`);
  error.workspaceCode = name;
  error.detail = detail;
  return error;
}

/** The OPFS root accessor — injectable for tests (the live path uses the
 * extension's navigator.storage). */
export function opfsRoot() {
  return navigator.storage.getDirectory();
}

async function getRoot() {
  const root = await opfsRoot();
  const ws = await root.getDirectoryHandle(WORKSPACE_ROOT, { create: true });
  return ws;
}

/** Resolve (creating lazily) the CURRENT run's agent workspace directory.
 * Returns the directory handle + its key, or null when the run has no agent
 * identity. `currentRunContext` is injectable for tests; production defaults
 * to the shared run-context singleton. */
export async function resolveAgentWorkspace({ currentRunContext: ctxFn = currentRunContext } = {}) {
  const ctx = typeof ctxFn === "function" ? ctxFn() : null;
  const key = workspaceKeyFromSurfaceRef(ctx?.agentSurfaceRef ?? null);
  if (!key) return null;
  const ws = await getRoot();
  const dir = await ws.getDirectoryHandle(key, { create: true });
  return { key, dir };
}

async function walk(dir, segments) {
  let cur = dir;
  for (const seg of segments) {
    cur = await cur.getDirectoryHandle(seg);
  }
  return cur;
}

async function walkCreate(dir, segments) {
  let cur = dir;
  for (const seg of segments) {
    cur = await cur.getDirectoryHandle(seg, { create: true });
  }
  return cur;
}

/** Recompute the workspace's true bytes/files used by walking it. Used as
 * the authoritative source for the Settings usage row (there is no quota
 * ledger to reconcile — usage is whatever the workspace holds). */
export async function measureWorkspace(dir, { walkDepth = 0 } = {}) {
  let bytesUsed = 0;
  let filesUsed = 0;
  const scan = async (handle, depth) => {
    if (depth > MAX_WORKSPACE_DEPTH) return;
    for await (const entry of handle.values()) {
      if (entry.kind === "directory") {
        await scan(entry, depth + 1);
      } else {
        try {
          const f = await entry.getFile();
          bytesUsed += f.size;
          filesUsed += 1;
        } catch { /* unreadable file — count the name, zero bytes */ filesUsed += 1; }
      }
    }
  };
  await scan(dir, walkDepth);
  return { bytesUsed, filesUsed };
}

/** List entries under a relative path inside the current agent's workspace. */
export async function listWorkspaceEntries(relativePath = "", { limit = 500, currentRunContext } = {}) {
  const ws = await resolveAgentWorkspace({ currentRunContext });
  if (!ws) return { ok: false, error: "no_agent_workspace" };
  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (segments.length > MAX_WORKSPACE_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_WORKSPACE_DEPTH };
  }
  let dir = ws.dir;
  try {
    dir = await walk(ws.dir, segments);
  } catch {
    return { ok: false, error: "directory_not_found", path: String(relativePath ?? "") };
  }
  const entries = [];
  let total = 0;
  let truncated = false;
  const effectiveLimit = Math.min(Math.max(1, limit || 500), 500);
  try {
    for await (const entry of dir.values()) {
      total++;
      if (entries.length < effectiveLimit) {
        entries.push({
          name: entry.name,
          kind: entry.kind || (entry.getFile ? "file" : "directory"),
          ...(entry.kind === "file"
            ? (await entry.getFile().then((f) => ({ size: f.size })).catch(() => ({})))
            : {}),
        });
      } else {
        truncated = true;
      }
    }
  } catch (err) {
    return { ok: false, error: `enumeration_failed: ${err?.message || err}` };
  }
  return { ok: true, workspace: ws.key, path: segments.join("/"), entries, truncated, total };
}

/** Read a text file inside the current agent's workspace. Same read
 * contract as fs-grants (post-dptw): never refused for size — whole-file by
 * default, offset/length pick a byte window whose edges are widened to whole
 * UTF-8 characters (`start`/`end` disclose the span returned). */
export async function readWorkspaceFile(relativePath = "", { offset = null, length = null, currentRunContext } = {}) {
  const ws = await resolveAgentWorkspace({ currentRunContext });
  if (!ws) return { ok: false, error: "no_agent_workspace" };
  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (segments.length === 0) return { ok: false, error: "invalid_file_path" };
  if (segments.length > MAX_WORKSPACE_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_WORKSPACE_DEPTH };
  }
  let fh;
  try {
    const parent = await walk(ws.dir, segments.slice(0, -1));
    fh = await parent.getFileHandle(segments[segments.length - 1]);
  } catch {
    return { ok: false, error: "file_not_found" };
  }
  const file = await fh.getFile().catch(() => null);
  if (!file) return { ok: false, error: "file_not_found" };
  const bytes = new Uint8Array(await file.arrayBuffer().catch(() => new Uint8Array(0)));
  const fileSize = bytes.byteLength;
  // Byte window, same contract as readFsGrantFile: whole file by default;
  // offset/length pick a window clamped to EOF. No size bound lives here.
  const hasOffset = Number.isInteger(offset);
  const hasLength = Number.isInteger(length);
  const explicitWindow = hasOffset || hasLength;
  const start = explicitWindow ? Math.min(Math.max(0, hasOffset ? offset : 0), fileSize) : 0;
  const end = explicitWindow ? Math.min(fileSize, start + (hasLength ? Math.max(0, length) : fileSize - start)) : fileSize;
  // Widen the window to whole UTF-8 characters so a fatal decode never
  // rejects valid text whose edge split a multi-byte sequence (mirrors
  // readFsGrantFile's alignment).
  const isContinuation = (byte) => (byte & 0xc0) === 0x80;
  const charLengthAt = (byte) =>
    (byte & 0x80) === 0 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 0;
  let effStart = start;
  let effEnd = end;
  if (fileSize > 0 && end > start) {
    while (effStart > 0 && isContinuation(bytes[effStart])) effStart -= 1;
    let head = end - 1;
    while (head > 0 && isContinuation(bytes[head])) head -= 1;
    const len = charLengthAt(bytes[head]);
    if (len > 0 && head + len > effEnd) effEnd = Math.min(fileSize, head + len);
  }
  const windowBytes = bytes.subarray(effStart, effEnd);
  const sha256 = await computeSha256(windowBytes);
  let text = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(windowBytes);
  } catch {
    return { ok: false, error: "fs_file_not_text" };
  }
  const out = { ok: true, workspace: ws.key, path: segments.join("/"), content: text, size: fileSize, sha256 };
  if (explicitWindow) {
    out.start = effStart;
    out.end = effEnd;
  }
  return out;
}

/** Write (create or overwrite) a file inside the current agent's workspace.
 * The agent's own sandbox — no owner approval required (same trust as memory).
 * No size bound of any kind (owner directive 2026-09-04): the workspace is
 * capped only by the browser's native OPFS allocation, and a platform refusal
 * under real storage pressure surfaces as `workspace_write_failed` with
 * Chrome's own message. */
export async function writeWorkspaceFile(relativePath = "", content = "", { currentRunContext } = {}) {
  const ws = await resolveAgentWorkspace({ currentRunContext });
  if (!ws) return { ok: false, error: "no_agent_workspace" };
  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (segments.length === 0) return { ok: false, error: "invalid_file_path" };
  if (segments.length > MAX_WORKSPACE_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_WORKSPACE_DEPTH };
  }
  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(String(content ?? ""));
  const parent = await walkCreate(ws.dir, segments.slice(0, -1));
  const fileName = segments[segments.length - 1];

  try {
    const fh = await parent.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  } catch (err) {
    return { ok: false, error: `workspace_write_failed: ${err?.message || err}` };
  }
  const sha256 = await computeSha256(bytes);
  return { ok: true, workspace: ws.key, path: segments.join("/"), bytes: bytes.byteLength, sha256 };
}

/** Delete a file (or empty directory) inside the current agent's workspace. */
export async function deleteWorkspaceFile(relativePath = "", { currentRunContext } = {}) {
  const ws = await resolveAgentWorkspace({ currentRunContext });
  if (!ws) return { ok: false, error: "no_agent_workspace" };
  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (segments.length === 0) return { ok: false, error: "invalid_file_path" };
  if (segments.length > MAX_WORKSPACE_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_WORKSPACE_DEPTH };
  }
  try {
    const parent = await walk(ws.dir, segments.slice(0, -1));
    await parent.removeEntry(segments[segments.length - 1]);
  } catch {
    return { ok: false, error: "file_not_found" };
  }
  return { ok: true, workspace: ws.key, path: segments.join("/") };
}

/** Search file NAMES inside the current agent's workspace (bounded, no content
 * reads). Mirrors the fs-grant find_files surface. */
export async function searchWorkspaceFiles(query = "", { limit = 200, currentRunContext } = {}) {
  const ws = await resolveAgentWorkspace({ currentRunContext });
  if (!ws) return { ok: false, error: "no_agent_workspace" };
  const needle = String(query ?? "").trim().toLowerCase();
  const cap = Math.min(Math.max(1, Number(limit) || 200), 500);
  const files = [];
  const walkNames = async (handle, prefix, depth) => {
    if (files.length >= cap || depth > MAX_WORKSPACE_DEPTH) return;
    for await (const entry of handle.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        await walkNames(entry, path, depth + 1);
      } else if (!needle || entry.name.toLowerCase().includes(needle)) {
        try {
          const f = await entry.getFile();
          files.push({ path, name: entry.name, size: f.size });
        } catch {
          files.push({ path, name: entry.name, size: 0 });
        }
        if (files.length >= cap) return;
      }
    }
  };
  try {
    await walkNames(ws.dir, "", 0);
  } catch (err) {
    return { ok: false, error: `search_failed: ${err?.message || err}` };
  }
  return { ok: true, workspace: ws.key, query: String(query ?? ""), files, matchCount: files.length, truncated: files.length >= cap };
}

/** Clear the whole workspace (owner gesture from Settings — the ONLY path that
 * removes the directory). */
export async function clearAgentWorkspace({ key = null, currentRunContext } = {}) {
  const ws = key ? { key, dir: await (async () => {
    const root = await getRoot();
    return await root.getDirectoryHandle(key, { create: true });
  })() } : await resolveAgentWorkspace({ currentRunContext });
  if (!ws) return { ok: false, error: "no_agent_workspace" };
  try {
    // Remove every entry, leaving the (now empty) directory in place so a
    // later run resolves the same key without recreating it.
    for await (const entry of ws.dir.values()) {
      await ws.dir.removeEntry(entry.name, { recursive: entry.kind === "directory" });
    }
  } catch (err) {
    return { ok: false, error: `workspace_clear_failed: ${err?.message || err}` };
  }
  return { ok: true, workspace: ws.key };
}

/** Usage for a workspace by its explicit key (Settings surface). Returns
 * { ok, workspace, bytesUsed, filesUsed } — honest measured usage; there is
 * no quota ceiling to report (owner directive 2026-09-04). */
export async function getWorkspaceUsageByKey(key) {
  if (typeof key !== "string" || !/^(named|background)-[a-z0-9][a-z0-9-]{0,127}$/.test(key)) {
    return { ok: false, error: "invalid_workspace_key" };
  }
  const root = await getRoot();
  let dir = null;
  try {
    dir = await root.getDirectoryHandle(key);
  } catch {
    // No workspace yet — honest empty usage.
    return { ok: true, workspace: key, bytesUsed: 0, filesUsed: 0 };
  }
  const measured = await measureWorkspace(dir);
  return {
    ok: true,
    workspace: key,
    bytesUsed: measured.bytesUsed,
    filesUsed: measured.filesUsed,
  };
}

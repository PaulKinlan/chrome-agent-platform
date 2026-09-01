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
// Bounds: per-agent quota (DEFAULT bytes/files) accounted in a `.quota.json`
// metadata file inside the workspace; writes over quota FAIL with an honest
// `workspace_quota_exceeded` (never a silent truncation). Path grammar is the
// same bounded ASCII segment walk as fs-grants (cleanRelativePath).

import { cleanRelativePath, computeSha256, MAX_FS_WRITE_BYTES } from "./fs-grants.js";
import { currentRunContext } from "./run-context.js";

export const WORKSPACE_ROOT = "agent-workspaces";
export const DEFAULT_WORKSPACE_BYTES = 20 * 1024 * 1024; // 20 MiB per agent
export const DEFAULT_WORKSPACE_FILES = 200;
export const MAX_WORKSPACE_DEPTH = 8; // bounded nesting inside an agent workspace
export const QUOTA_FILE = ".quota.json";

const WORKSPACE_QUOTA_BYTES = 32 * 1024; // the metadata file itself is bounded

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
 * Mirrors the memory store's slugify so the Settings row addresses the SAME
 * directory the run-context resolver uses. */
export function workspaceKeyFromAgentId(agentId) {
  const slug = String(agentId ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
  return `named-${slug}`;
}

/** The workspace key for a background/scheduled agent id: `background-<slug>`. */
export function backgroundWorkspaceKeyFromAgentId(agentId) {
  const slug = String(agentId ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
  return `background-${slug}`;
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

async function readQuota(dir) {
  try {
    const fh = await dir.getFileHandle(QUOTA_FILE);
    const f = await fh.getFile();
    const raw = await f.text();
    if (raw.length > WORKSPACE_QUOTA_BYTES) return null; // corrupt oversized → treat absent
    const q = JSON.parse(raw);
    if (!Number.isSafeInteger(q?.bytesUsed) || !Number.isSafeInteger(q?.filesUsed)) return null;
    return q;
  } catch {
    return null;
  }
}

async function writeQuota(dir, quota) {
  const fh = await dir.getFileHandle(QUOTA_FILE, { create: true });
  const w = await fh.createWritable();
  const payload = JSON.stringify({ ...quota, updatedAt: Date.now() });
  if (payload.length > WORKSPACE_QUOTA_BYTES) throw failClosed("quota_file_oversize");
  await w.write(payload);
  await w.close();
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

/** Recompute the workspace's true bytes/files used by walking it (excludes the
 * quota metadata file). Used to reconcile the accounting after deletes and as
 * the authoritative source for the Settings usage row. */
export async function measureWorkspace(dir, { walkDepth = 0 } = {}) {
  let bytesUsed = 0;
  let filesUsed = 0;
  const scan = async (handle, depth) => {
    if (depth > MAX_WORKSPACE_DEPTH) return;
    for await (const entry of handle.values()) {
      if (entry.name === QUOTA_FILE) continue;
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
      if (entry.name === QUOTA_FILE) continue;
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

/** Read a text file inside the current agent's workspace. */
export async function readWorkspaceFile(relativePath = "", { maxBytes = 1024 * 1024, currentRunContext } = {}) {
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
  const effectiveMax = Math.min(Math.max(1, maxBytes || 1024 * 1024), MAX_FS_WRITE_BYTES);
  if (bytes.byteLength > effectiveMax) {
    return { ok: false, error: "workspace_file_too_large", bytes: bytes.byteLength, maxBytes: effectiveMax };
  }
  const sha256 = await computeSha256(bytes);
  let text = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "fs_file_not_text" };
  }
  return { ok: true, workspace: ws.key, path: segments.join("/"), content: text, size: bytes.byteLength, sha256 };
}

/** Write (create or overwrite) a file inside the current agent's workspace.
 * The agent's own sandbox — no owner approval required (same trust as memory).
 * Bounded by the per-agent quota + the shared per-write byte cap. */
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
  if (bytes.byteLength > MAX_FS_WRITE_BYTES) {
    return { ok: false, error: "fs_file_too_large", bytes: bytes.byteLength, maxBytes: MAX_FS_WRITE_BYTES };
  }
  const parent = await walkCreate(ws.dir, segments.slice(0, -1));
  const fileName = segments[segments.length - 1];

  // Quota accounting: recompute the authoritative used figures, then simulate
  // the write (existing file replaces its old size; new file adds).
  const measured = await measureWorkspace(ws.dir);
  const existing = await parent.getFileHandle(fileName).catch(() => null);
  let existingSize = 0;
  if (existing) {
    const f = await existing.getFile().catch(() => null);
    existingSize = typeof f?.size === "number" ? f.size : 0;
  }
  const afterBytes = measured.bytesUsed - existingSize + bytes.byteLength;
  const afterFiles = measured.filesUsed + (existing ? 0 : 1);
  if (afterBytes > DEFAULT_WORKSPACE_BYTES) {
    return {
      ok: false,
      error: "workspace_quota_exceeded",
      bytesUsed: measured.bytesUsed,
      maxBytes: DEFAULT_WORKSPACE_BYTES,
      message: "This agent's private workspace quota (20 MiB) is full — remove files or ask the owner to clear it in Settings.",
    };
  }
  if (afterFiles > DEFAULT_WORKSPACE_FILES) {
    return {
      ok: false,
      error: "workspace_quota_exceeded",
      filesUsed: measured.filesUsed,
      maxFiles: DEFAULT_WORKSPACE_FILES,
      message: "This agent's private workspace file quota (200 files) is full.",
    };
  }

  try {
    const fh = await parent.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  } catch (err) {
    return { ok: false, error: `workspace_write_failed: ${err?.message || err}` };
  }
  const sha256 = await computeSha256(bytes);
  await writeQuota(ws.dir, { bytesUsed: afterBytes, filesUsed: afterFiles });
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
  const measured = await measureWorkspace(ws.dir);
  await writeQuota(ws.dir, { bytesUsed: measured.bytesUsed, filesUsed: measured.filesUsed });
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
      if (entry.name === QUOTA_FILE) continue;
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
    // Remove every entry EXCEPT the quota file first, then drop the directory.
    for await (const entry of ws.dir.values()) {
      await ws.dir.removeEntry(entry.name, { recursive: entry.kind === "directory" });
    }
    await writeQuota(ws.dir, { bytesUsed: 0, filesUsed: 0 });
  } catch (err) {
    return { ok: false, error: `workspace_clear_failed: ${err?.message || err}` };
  }
  return { ok: true, workspace: ws.key };
}

/** Usage for a workspace by its explicit key (Settings surface). Returns
 * { ok, workspace, bytesUsed, filesUsed, maxBytes, maxFiles } — the maxes are
 * the quota defaults so the Settings row can render a bounded bar. */
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
    return { ok: true, workspace: key, bytesUsed: 0, filesUsed: 0, maxBytes: DEFAULT_WORKSPACE_BYTES, maxFiles: DEFAULT_WORKSPACE_FILES };
  }
  const measured = await measureWorkspace(dir);
  return {
    ok: true,
    workspace: key,
    bytesUsed: measured.bytesUsed,
    filesUsed: measured.filesUsed,
    maxBytes: DEFAULT_WORKSPACE_BYTES,
    maxFiles: DEFAULT_WORKSPACE_FILES,
  };
}

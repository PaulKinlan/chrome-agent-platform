// extension/lib/mcp-config.js — the PURE config model + storage for remote MCP
// servers (CAP-FB-20260831-MCP-CONFIG-STORE-01).
//
// The owner ask (docs/MCP-SUPPORT-DESIGN.md): MCP as a GLOBAL option, with each
// named agent ALSO carrying its own MCP servers. This module owns:
//   - the server shape `{ id, name, transport, url, auth?, enabled }` and its
//     validation/normalization,
//   - the GLOBAL server list in chrome.storage (`cap:mcpServers`),
//   - the resolver `effectiveMcpServers(agentId?)` = global ∪ agent minus
//     disabled, dedup by id,
//   - the redacted read (a stored credential — the auth token — NEVER crosses
//     into a page/model; only a `hasToken` presence bit does).
//
// The per-agent list lives in named-agents.js (added EXACTLY like the per-agent
// provider override) and this module's storage resolver folds it in. Connecting
// to a server, listing/injecting its tools, and fencing its output are OUT OF
// SCOPE here (MCP-TOOL-INJECTION-01) — this is the config layer only.
//
// Remote MCP ONLY. MV3 has no subprocess, so stdio/local-command servers are
// impossible in the extension: only Streamable HTTP ("http") and SSE ("sse")
// transports to an http(s) URL are accepted; everything else is rejected.

import { kvGet, kvSet } from "./kv.js";
import { getNamedAgentMcpServers } from "./named-agents.js";

/** The chrome.storage key for the GLOBAL MCP server list. */
export const MCP_SERVERS_KEY = "cap:mcpServers";

/** The transports the extension can actually run (remote only). */
export const MCP_TRANSPORTS = Object.freeze(new Set(["http", "sse"]));

// A server id doubles as the tool-namespace segment (`mcp__<server>__<tool>`),
// so it must match the spike's segment rule: alphanumerics / `-` / `_`, and
// NEVER contain `__` (the flattened-name separator — allowing it would let two
// distinct (server, tool) pairs collapse to one key; agent-do issue #75).
// Kept in sync with NAMESPACE_RE in mcp-client-core.js (the transport spike).
const MCP_ID_RE = /^(?!.*__)[a-zA-Z0-9_-]+$/;

// An HTTP header name is an RFC 7230 token.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

// Bounds (Constitution §4): generous for a real owner, still FINITE so a
// hostile prompt cannot grow the chrome.storage-backed lists without limit.
const MAX_MCP_SERVERS = 32;
const MAX_ID_LEN = 64;
const MAX_NAME_LEN = 120;
const MAX_URL_LEN = 2048;
const MAX_HEADER_NAME_LEN = 128;
const MAX_TOKEN_LEN = 8192;

/** Slugify a free-text name into a valid MCP id segment (single-dash, no `__`). */
function slugifyMcpId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_LEN);
}

/**
 * Validate + normalize ONE MCP server. Returns a clean, self-contained server
 * object, or `null` when the input is not a usable remote MCP server. Fails
 * closed: any malformed required field (transport / url / id / auth) rejects
 * the whole server rather than silently dropping part of it.
 *
 * @returns {{id,name,transport,url,enabled,auth?:{headerName,token}}|null}
 */
export function normalizeMcpServer(value) {
  if (!value || typeof value !== "object") return null;

  // Transport: remote only. Rejects "stdio", "command", "", anything else.
  const transport = String(value.transport ?? "").trim().toLowerCase();
  if (!MCP_TRANSPORTS.has(transport)) return null;

  // URL: must be a parseable http(s) URL. Rejects ws/file/data and garbage.
  const rawUrl = String(value.url ?? "").trim();
  if (!rawUrl || rawUrl.length > MAX_URL_LEN) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Id: an explicit valid segment, else derived from the name.
  let id = String(value.id ?? "").trim();
  if (id) {
    if (id.length > MAX_ID_LEN || !MCP_ID_RE.test(id)) return null;
  } else {
    id = slugifyMcpId(value.name);
    if (!id || !MCP_ID_RE.test(id)) return null;
  }

  const name = String(value.name ?? "").trim().slice(0, MAX_NAME_LEN) || id;
  const enabled = value.enabled === false ? false : true;

  const server = { id, name, transport, url: rawUrl, enabled };

  // Auth is optional. When present it MUST be a well-formed { headerName, token }
  // — a malformed auth block rejects the server (fail closed) so a credential the
  // owner intended is never silently sent under the wrong header or dropped.
  if (value.auth != null) {
    if (typeof value.auth !== "object") return null;
    const headerName = String(value.auth.headerName ?? "").trim();
    if (!headerName || headerName.length > MAX_HEADER_NAME_LEN || !HEADER_NAME_RE.test(headerName)) {
      return null;
    }
    const token = String(value.auth.token ?? "").slice(0, MAX_TOKEN_LEN);
    server.auth = { headerName, token };
  }

  return server;
}

/**
 * Normalize a LIST of servers: drop invalid entries, dedup by id (LAST write
 * wins), and cap the count. Never throws on hostile input.
 */
export function normalizeMcpServerList(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const raw of list) {
    const s = normalizeMcpServer(raw);
    if (!s) continue;
    byId.set(s.id, s); // last write wins
    if (byId.size > MAX_MCP_SERVERS && !byId.has(s.id)) break;
  }
  return [...byId.values()].slice(0, MAX_MCP_SERVERS);
}

/**
 * Strip the auth token from a server before it crosses into any non-Settings
 * surface. The redacted view keeps `auth.headerName` + a `hasToken` presence
 * bit so the UI can show "credential set — leave blank to keep" without ever
 * seeing the token.
 */
export function redactMcpServer(server) {
  if (!server || typeof server !== "object") return null;
  const out = {
    id: server.id,
    name: server.name,
    transport: server.transport,
    url: server.url,
    enabled: server.enabled !== false,
  };
  if (server.auth && typeof server.auth === "object") {
    out.auth = { headerName: server.auth.headerName, hasToken: Boolean(server.auth.token) };
  }
  return out;
}

/** Redact a whole list (normalizing first so the view is always well-formed). */
export function redactMcpServerList(list) {
  return normalizeMcpServerList(list).map(redactMcpServer);
}

/**
 * Carry an existing token forward when the incoming server on the SAME id (and
 * SAME header name) omits it (a blank-save from the UI, which never sees the
 * token). An incoming server that drops `auth` entirely is a deliberate removal
 * — do NOT preserve then. Mirrors the provider-key blank-save preservation.
 */
export function preserveExistingMcpTokens(incoming, existing) {
  const incList = normalizeMcpServerList(incoming);
  const prevById = new Map(normalizeMcpServerList(existing).map((s) => [s.id, s]));
  return incList.map((s) => {
    if (!s.auth || s.auth.token) return s;
    const prev = prevById.get(s.id);
    if (prev?.auth?.token && prev.auth.headerName === s.auth.headerName) {
      return { ...s, auth: { ...s.auth, token: prev.auth.token } };
    }
    return s;
  });
}

/**
 * The resolver (PURE): the effective server set for a run = the global list
 * UNION the per-agent list, with the per-agent entry OVERRIDING a global one of
 * the same id, minus every disabled server, deduped by id.
 *
 * A per-agent entry with `enabled:false` on a global's id DISABLES the inherited
 * server (the design's "add its own and disable inherited ones"). Returns FULL
 * servers (with tokens) — this feeds the SW-side tool-injection path; the UI
 * path uses the redacted variant.
 */
export function resolveEffectiveMcpServers(globalList, agentList) {
  const byId = new Map();
  for (const s of normalizeMcpServerList(globalList)) byId.set(s.id, s);
  for (const s of normalizeMcpServerList(agentList)) byId.set(s.id, s); // agent overrides global
  return [...byId.values()].filter((s) => s.enabled !== false);
}

/** The redacted effective set (for a UI that shows an agent's resolved servers). */
export function resolveEffectiveMcpServersRedacted(globalList, agentList) {
  return resolveEffectiveMcpServers(globalList, agentList).map(redactMcpServer);
}

// ── Global-list storage ─────────────────────────────────────────────────────

/** The FULL global server list (WITH tokens). SW-only — the tool-injection /
 * connection path. Never surface this to a page/model. */
export async function getGlobalMcpServers() {
  const s = await kvGet(MCP_SERVERS_KEY);
  return normalizeMcpServerList(s?.[MCP_SERVERS_KEY] ?? []);
}

/** The REDACTED global server list (no tokens) — the Settings UI read. */
export async function getGlobalMcpServersRedacted() {
  return (await getGlobalMcpServers()).map(redactMcpServer);
}

/**
 * Replace the global server list. Preserves each server's stored token when the
 * incoming server of the same id omits it (blank-save). Returns the REDACTED
 * saved list — the token never crosses back out.
 */
export async function setGlobalMcpServers(list) {
  const existing = await getGlobalMcpServers();
  const preserved = preserveExistingMcpTokens(list, existing);
  const next = normalizeMcpServerList(preserved);
  await kvSet({ [MCP_SERVERS_KEY]: next });
  return next.map(redactMcpServer);
}

// ── The effective resolver over live storage ────────────────────────────────

/**
 * effectiveMcpServers(agentId?) — the stored global list resolved against a
 * named agent's stored per-agent list (when `agentId` is given). Returns FULL
 * servers (with tokens) for the SW-side run/tool-injection path.
 */
export async function effectiveMcpServers(agentId) {
  const global = await getGlobalMcpServers();
  const agentList = agentId ? await getNamedAgentMcpServers(agentId) : [];
  return resolveEffectiveMcpServers(global, agentList);
}

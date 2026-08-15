// lib/tools.js — the tool directory: declared (WebMCP) + linked (agent.md/skills)
// + inferred (window.* functions) tools, with first-run approval per origin.

import { canonicalOrigin, masterMemory, siteMemory } from "./memory.js";

const DIR_KEY = "toolDirectory";
const ENROLL_KEY = "cap:enrollment";

/** Bounds for the tool directory (fail-closed against hostile descriptors). */
export const TOOL_BOUNDS = {
  maxNameLength: 128,
  maxDescriptionLength: 2000,
  maxSchemaBytes: 8192, // serialized JSON-schema size per tool
  maxToolsPerOrigin: 200,
  maxTotalBytes: 1024 * 1024, // serialized directory size per origin
};

/**
 * The canonical tool-descriptor shape. declared/inferred/linked marks the source.
 */
export function describeTool(t) {
  return {
    origin: t.origin,
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    source: t.source, // "declared" | "inferred" | "linked"
  };
}

/** Bound a single descriptor; returns null when it violates the bounds. */
function boundTool(t) {
  const name = String(t.name ?? "");
  const description = String(t.description ?? "");
  const schema = t.inputSchema ?? { type: "object", properties: {} };
  if (name.length === 0 || name.length > TOOL_BOUNDS.maxNameLength) return null;
  if (description.length > TOOL_BOUNDS.maxDescriptionLength) return null;
  let schemaBytes;
  try {
    schemaBytes = JSON.stringify(schema).length;
  } catch {
    return null;
  }
  if (schemaBytes > TOOL_BOUNDS.maxSchemaBytes) return null;
  return describeTool({
    origin: t.origin,
    name,
    description,
    inputSchema: schema,
    source: t.source,
  });
}

export async function upsertTools(origin, tools) {
  const store = siteMemory(origin);
  const dir = (await store.get(DIR_KEY)) ?? [];
  const byName = new Map(dir.map((t) => [t.name, t]));
  for (const t of tools) {
    const bounded = boundTool(t);
    if (!bounded) continue; // reject (not silently accept) out-of-bounds descriptors
    byName.set(bounded.name, bounded);
  }
  let next = [...byName.values()];
  // Total directory size + count bounds: drop the tail when over budget.
  if (next.length > TOOL_BOUNDS.maxToolsPerOrigin) {
    next = next.slice(0, TOOL_BOUNDS.maxToolsPerOrigin);
  }
  let total = 0;
  next = next.filter((t) => {
    let b;
    try {
      b = JSON.stringify(t).length;
    } catch {
      b = TOOL_BOUNDS.maxTotalBytes + 1;
    }
    total += b;
    return total <= TOOL_BOUNDS.maxTotalBytes;
  });
  await store.set(DIR_KEY, next);
  return next;
}

export async function listTools(origin) {
  return (await siteMemory(origin).get(DIR_KEY)) ?? [];
}

export async function listAllOrigins() {
  const master = await masterMemory().get("origins");
  return master ?? [];
}

/** Whether an origin is CURRENTLY enrolled (owner-controlled). A deleted origin
 * is TOMBSTONED (enrolled:false), so a still-running content-script bridge can
 * never re-enroll it or report tools for it. */
export async function isEnrolled(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return false;
  const s = await chrome.storage.local.get(ENROLL_KEY);
  const rec = s[ENROLL_KEY]?.[canonical];
  return Boolean(rec && rec.enrolled === true);
}

export async function enrollOrigin(origin) {
  const store = masterMemory();
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new Error(`invalid origin: ${origin}`);
  // Create the site's OWN OPFS store directory (so listOrigins() — which
  // enumerates the per-origin directories — discovers it as a worker). This
  // fixes the bug where agent.create wrote only the master-memory list and the
  // worker stayed invisible to listOrigins()/the orchestrator.
  await siteMemory(canonical).set("enrolled", { at: Date.now() });
  const origins = (await store.get("origins")) ?? [];
  if (!origins.includes(canonical)) {
    origins.push(canonical);
    await store.set("origins", origins);
  }
  // Persist the ENROLLMENT STATE (enrolled:true) — the authority a running
  // bridge's reports are gated on (isEnrolled).
  const s = await chrome.storage.local.get(ENROLL_KEY);
  const map = { ...(s[ENROLL_KEY] ?? {}) };
  map[canonical] = {
    enrolled: true,
    at: Date.now(),
    gen: (map[canonical]?.gen ?? 0) + 1,
  };
  await chrome.storage.local.set({ [ENROLL_KEY]: map });
  return origins;
}

/** Remove an origin from the master-memory origins list + TOMBSTONE its
 * enrollment (enrolled:false) so a running bridge's reports are rejected. This
 * is the authoritative revocation — not merely removing the list entry. */
export async function disenrollOrigin(origin) {
  const store = masterMemory();
  const origins = (await store.get("origins")) ?? [];
  const canonical = canonicalOrigin(origin);
  if (!canonical) return origins;
  const next = origins.filter((o) => o !== canonical);
  if (next.length !== origins.length) {
    await store.set("origins", next);
  }
  const s = await chrome.storage.local.get(ENROLL_KEY);
  const map = { ...(s[ENROLL_KEY] ?? {}) };
  map[canonical] = {
    enrolled: false, // tombstone
    at: Date.now(),
    gen: (map[canonical]?.gen ?? 0) + 1,
  };
  await chrome.storage.local.set({ [ENROLL_KEY]: map });
  return next;
}

/**
 * First-run approval: a tool on an origin requires one-time user approval
 * before the agent may call it. Approved state is stored per (origin, tool).
 */
export async function isApproved(origin, toolName) {
  const approved = (await siteMemory(origin).get("approvals")) ?? {};
  return Boolean(approved[toolName]);
}

export async function approveTool(origin, toolName, decision = true) {
  const store = siteMemory(origin);
  const approved = (await store.get("approvals")) ?? {};
  if (decision) approved[toolName] = Date.now();
  else delete approved[toolName];
  await store.set("approvals", approved);
  return approved;
}

export async function pendingApprovals(origin) {
  const tools = await listTools(origin);
  const approved = (await siteMemory(origin).get("approvals")) ?? {};
  return tools.filter((t) => !approved[t.name]);
}

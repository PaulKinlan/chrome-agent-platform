// lib/tools.js — the tool directory: declared (WebMCP) + linked (agent.md/skills)
// + inferred (window.* functions) tools, with first-run approval per origin.

import { masterMemory, siteMemory } from "./memory.js";

const DIR_KEY = "toolDirectory";

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

export async function upsertTools(origin, tools) {
  const store = siteMemory(origin);
  const dir = (await store.get(DIR_KEY)) ?? [];
  const byName = new Map(dir.map((t) => [t.name, t]));
  for (const t of tools) byName.set(t.name, describeTool({ ...t, origin }));
  const next = [...byName.values()];
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

export async function enrollOrigin(origin) {
  const store = masterMemory();
  const origins = (await store.get("origins")) ?? [];
  if (!origins.includes(origin)) {
    origins.push(origin);
    await store.set("origins", origins);
  }
  return origins;
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

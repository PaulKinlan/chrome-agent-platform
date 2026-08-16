// lib/management-tools.js — the master hub agent's management tool suite.
//
// The hub agent can create + manage the ENTIRE system: sub-agents, artifacts,
// enrollment, capabilities, usage. Each tool is a thin, model-facing surface
// over the authoritative service-worker routes (the SAME locks, fences, and
// permission checks as the UI). The tools NEVER bypass a route — they call it
// through `callRoute`, so a management action is indistinguishable from a UI
// action in terms of enforcement.
//
// `callRoute(type, args)` dispatches to the SW handler registry (the routes in
// background/service-worker.js: agent.create, agent.delete, asset.create, ...).

import { tool } from "ai";
import { z } from "zod";
import { ASSET_TYPES } from "./artifacts.js";

/** The fixed management tool names (for the orchestrator introspection route). */
export const MANAGEMENT_TOOL_NAMES = [
  "create_agent",
  "update_agent",
  "delete_agent",
  "get_agent",
  "list_agents",
  "enroll_origin",
  "disenroll_origin",
  "create_asset",
  "update_asset",
  "delete_asset",
  "list_assets",
  "get_asset",
  "grant_capability",
  "revoke_capability",
  "get_usage",
  "get_memory_overview",
];

export function managementToolset({ callRoute }) {
  const call = (type, args) => Promise.resolve(callRoute(type, args ?? {}));

  return {
    // ---- sub-agent management ----
    create_agent: tool({
      description:
        "Enroll a new per-site sub-agent for an origin. Registers the origin so its WebMCP/site tools can be discovered. Host access is a separate owner-approved step (enroll_origin).",
      inputSchema: z.object({
        origin: z.string().describe("the https origin, e.g. https://example.com"),
        name: z.string().optional().describe("a display name for the sub-agent"),
      }),
      execute: ({ origin, name }) => call("agent.create", { origin, name }),
    }),
    update_agent: tool({
      description: "Update a sub-agent's display name/config.",
      inputSchema: z.object({
        origin: z.string(),
        name: z.string().optional(),
      }),
      execute: ({ origin, name }) => call("agent.update", { origin, name }),
    }),
    delete_agent: tool({
      description:
        "Authoritatively delete a sub-agent (tombstones its enrollment + removes its scripts/permission/OPFS). A running bridge can never resurrect it.",
      inputSchema: z.object({ origin: z.string() }),
      execute: ({ origin }) => call("agent.delete", { origin }),
    }),
    get_agent: tool({
      description: "Inspect one sub-agent: name, tools, memory keys, enrollment state.",
      inputSchema: z.object({ origin: z.string() }),
      execute: ({ origin }) => call("agent.get", { origin }),
    }),
    list_agents: tool({
      description: "List every sub-agent with its enrollment state + name.",
      inputSchema: z.object({}),
      execute: () => call("agent.directory", {}),
    }),
    enroll_origin: tool({
      description:
        "Request host access + script injection for an origin so its site tools run. Needs a user gesture; if it fails closed, tell the owner to click Enroll in Settings.",
      inputSchema: z.object({ origin: z.string() }),
      execute: ({ origin }) => call("agent.enroll-origin", { origin }),
    }),
    disenroll_origin: tool({
      description: "Remove an origin's host access + injected scripts.",
      inputSchema: z.object({ origin: z.string() }),
      execute: ({ origin }) => call("agent.delete", { origin }),
    }),

    // ---- artifacts ----
    create_asset: tool({
      description:
        "Create an artifact (a thing you make for the owner). Use origin 'master' for a hub-level artifact, or an origin for a site-specific one. type: html|text|json|image|data.",
      inputSchema: z.object({
        origin: z.string().default("master").describe("'master' or an https origin"),
        type: z.enum([...ASSET_TYPES]).default("text"),
        name: z.string().describe("a short, clear name"),
        content: z.string().describe("the artifact content"),
      }),
      execute: ({ origin, type, name, content }) =>
        call("asset.create", { origin, assetType: type, name, content }),
    }),
    update_asset: tool({
      description: "Update an artifact's name/type/content.",
      inputSchema: z.object({
        origin: z.string().default("master"),
        id: z.string(),
        name: z.string().optional(),
        type: z.enum([...ASSET_TYPES]).optional(),
        content: z.string().optional(),
      }),
      execute: (args) =>
        call("asset.update", {
          origin: args.origin,
          id: args.id,
          assetType: args.type,
          name: args.name,
          content: args.content,
        }),
    }),
    delete_asset: tool({
      description: "Delete an artifact.",
      inputSchema: z.object({
        origin: z.string().default("master"),
        id: z.string(),
      }),
      execute: ({ origin, id }) => call("asset.delete", { origin, id }),
    }),
    list_assets: tool({
      description: "List an origin's artifacts (use 'master' for all hub artifacts).",
      inputSchema: z.object({ origin: z.string().default("master") }),
      execute: ({ origin }) => call("asset.list", { origin }),
    }),
    get_asset: tool({
      description: "Read one artifact's content.",
      inputSchema: z.object({
        origin: z.string().default("master"),
        id: z.string(),
      }),
      execute: ({ origin, id }) => call("asset.get", { origin, id }),
    }),

    // ---- capabilities ----
    grant_capability: tool({
      description:
        "Request an optional permission (storage|alarms|tabs|activeTab|scripting|notifications|sidePanel). Needs a user gesture; if it fails closed, tell the owner to click Enable in Settings.",
      inputSchema: z.object({ id: z.string().describe("the capability id") }),
      execute: ({ id }) => call("capability.request", { id }),
    }),
    revoke_capability: tool({
      description: "Revoke an optional permission.",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => call("capability.revoke", { id }),
    }),

    // ---- introspection ----
    get_usage: tool({
      description: "Usage/cost summary (calls, tokens, estimated cost).",
      inputSchema: z.object({}),
      execute: () => call("usage.get", {}),
    }),
    get_memory_overview: tool({
      description: "Per-origin memory overview (keys + approximate sizes).",
      inputSchema: z.object({}),
      execute: () => call("memory.overview", {}),
    }),
  };
}

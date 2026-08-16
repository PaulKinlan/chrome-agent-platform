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
  "create_named_agent",
  "update_named_agent",
  "delete_named_agent",
  "get_named_agent",
  "list_named_agents",
  "list_hooks",
  "subscribe_hook",
  "unsubscribe_hook",
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
    // NOTE: enroll_origin is INTENTIONALLY absent — enrolling an origin (granting
    // host access + injecting scripts) is OWNER-ONLY (a fresh exact-origin gesture
    // in Settings). The model manages agents for ALREADY-enrolled origins, but can
    // never grant host access to a new origin.
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

    // ---- named agents (the persistent teammates) ----
    create_named_agent: tool({
      description:
        "Create a persistent NAMED agent (a teammate with its own memory + history + skills, like a 'PR reviewer' or 'my reader'). You give it a name + role; it gets its own sandbox. The user can then delegate tasks to it.",
      inputSchema: z.object({
        name: z.string().describe("a name for the agent"),
        role: z.string().optional().describe("what the agent does, e.g. 'reviews my GitHub PRs'"),
      }),
      execute: ({ name, role }) => call("named-agent.create", { name, role }),
    }),
    update_named_agent: tool({
      description: "Rename a named agent or change its role.",
      inputSchema: z.object({
        id: z.string().describe("the agent id (slug)"),
        name: z.string().optional(),
        role: z.string().optional(),
      }),
      execute: ({ id, name, role }) => call("named-agent.update", { id, name, role }),
    }),
    delete_named_agent: tool({
      description: "Delete a named agent + its sandbox (the master + the user may do this).",
      inputSchema: z.object({ id: z.string().describe("the agent id (slug)") }),
      execute: ({ id }) => call("named-agent.delete", { id }),
    }),
    get_named_agent: tool({
      description: "Fetch one named agent's details (name, role, avatar, skills).",
      inputSchema: z.object({ id: z.string().describe("the agent id (slug)") }),
      execute: ({ id }) => call("named-agent.get", { id }),
    }),
    list_named_agents: tool({
      description: "List every named agent.",
      inputSchema: z.object({}),
      execute: () => call("named-agent.list", {}),
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

    // ---- system hooks (subscribe agents/recipes to chrome.* events) ----
    list_hooks: tool({
      description:
        "List every system hook (chrome.* event) an agent can listen to, with its required permission, denied state, and current subscribers. Denied hooks can never be used (the owner's deny-list is authoritative).",
      inputSchema: z.object({}),
      execute: () => call("hooks.status", {}),
    }),
    subscribe_hook: tool({
      description:
        "Subscribe a background recipe (or the master agent) to a system event, so the agent runs when it fires. Refused (fail-closed) if the hook is owner-denied or its optional permission is absent. recipeId may be omitted to subscribe the master agent.",
      inputSchema: z.object({
        hookId: z.string().describe("the hook id, e.g. tabs.onCreated"),
        recipeId: z.string().optional().describe("a background recipe id, or omit for the master agent"),
        promptTemplate: z.string().optional().describe("a prompt template; {{payload}} is replaced with the event payload"),
      }),
      execute: ({ hookId, recipeId, promptTemplate }) =>
        call("hooks.subscribe", { hookId, recipeId, promptTemplate }),
    }),
    unsubscribe_hook: tool({
      description: "Unsubscribe an agent/recipe from a system event.",
      inputSchema: z.object({
        hookId: z.string(),
        recipeId: z.string().optional(),
      }),
      execute: ({ hookId, recipeId }) => call("hooks.unsubscribe", { hookId, recipeId }),
    }),
  };
}

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
  "disenroll_origin",
  "create_asset",
  "update_asset",
  "delete_asset",
  "list_assets",
  "get_asset",
  "get_usage",
  "get_memory_overview",
  "create_named_agent",
  "update_named_agent",
  "delete_named_agent",
  "get_named_agent",
  "list_named_agents",
  "set_agent_provider",
  "list_hooks",
  "subscribe_hook",
  "unsubscribe_hook",
  "generate_ui",
  "create_script",
  "update_script",
  "delete_script",
  "list_scripts",
  "get_script",
  "run_script",
  "schedules_list",
  "schedules_pause",
  "schedules_resume",
  "schedules_update",
];

export function managementToolset({ callRoute }) {
  const call = (type, args) => Promise.resolve(callRoute(type, args ?? {}));

  return {
    // ---- sub-agent management ----
    create_agent: tool({
      description:
        "Enroll a new per-site sub-agent for an origin. Registers the origin so its WebMCP/site tools can be discovered. Host access is a separate owner-approved step in Settings.",
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
        "Create an artifact (a thing you make for the owner). Use origin 'master' for a hub-level artifact, or an origin for a site-specific one. type: html|text|json|image|data. Pass the SAME key on every run that should produce the SAME artifact: a key that already exists finds and updates that exact artifact instead of creating a duplicate.",
      inputSchema: z.object({
        origin: z.string().default("master").describe("'master' or an https origin"),
        type: z.enum([...ASSET_TYPES]).default("text"),
        key: z.string().optional().describe("idempotency key (letters, digits, dot, dash, underscore, space; max 64 chars) — pass the same key to create-or-update the SAME artifact instead of duplicating"),
        name: z.string().describe("a short, clear name"),
        content: z.string().describe("the artifact content"),
      }),
      execute: ({ origin, type, key, name, content }) =>
        call("asset.create", { origin, assetType: type, key, name, content }),
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

    // Permission grants/revocations are intentionally NOT model tools. Until
    // the owner preflight is complete, Settings is the only authority that may
    // call chrome.permissions.request/remove from a genuine owner gesture.

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
    set_agent_provider: tool({
      description:
        "Set (or clear) a named agent's provider/model override. `config` is a COMPLETE provider-specific config (provider id + baseURL + apiKey + model); null clears it (the agent inherits the global provider).",
      inputSchema: z.object({
        id: z.string().describe("the agent id (slug)"),
        config: z.object({
          provider: z.string(),
          baseURL: z.string().optional(),
          apiKey: z.string().optional(),
          model: z.string().optional(),
        }).nullable().describe("a complete provider config, or null to inherit the global"),
      }),
      execute: ({ id, config }) => call("named-agent.set-provider", { id, config }),
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

    // ---- generative UI (the co-do double-iframe) ----
    generate_ui: tool({
      description:
        "Generate an interactive HTML UI (a page, a widget, a data visualization, a small app) for the owner. It is saved as an html artifact AND rendered LIVE in a sandboxed double-iframe in the conversation. The UI may use inline scripts + styles (interactive) but is fully sandboxed (no network, no access to the extension or the page). The owner's theme/locale is percolated in automatically.",
      inputSchema: z.object({
        name: z.string().describe("a short, clear name for the generated UI"),
        html: z.string().describe("the complete HTML (a document or a fragment with inline script/style) to render"),
        origin: z.string().default("master").describe("'master' for a hub-level artifact, or an https origin"),
      }),
      execute: ({ name, html, origin }) =>
        call("asset.create", { origin, assetType: "html", name, content: html }),
    }),

    // ---- agent-generated scripts (repeatable JS, sandboxed — Paul 2026-08-17) ----
    // A script runs the SAME JavaScript every time WITHOUT re-invoking the model
    // (no token burn). Use it for repeatable tasks: read a page, transform data,
    // return a value. The script runs SANDBOXED (an opaque iframe, no network of
    // its own) with a CONTROLLED api: `fetch(url, opts)` (the extension fetches
    // on its behalf, http/https only, size-bounded) and `log(...)`. It is an ASYNC
    // function body — `return` the result. It has NO DOM, NO extension APIs, NO
    // other origins, and NO direct network. A script can be scheduled (run it
    // on a timer via schedule_task with scriptId) or run on demand (run_script).
    create_script: tool({
      description:
        "Create a reusable JavaScript script (an async function body) that runs sandboxed + repeatedly without re-invoking the model. The script gets a controlled api: await fetch(url, opts) (reads an http/https page, returns {status, text}) + log(...). Return a value as the result. No DOM/extension/network access of its own.",
      inputSchema: z.object({
        name: z.string().describe("a short, clear name for the script"),
        source: z.string().describe("the JavaScript function body (async), e.g. `const r = await fetch('https://example.com'); return r.text.slice(0, 200);`"),
        origin: z.string().default("master").describe("'master' (hub-level script)"),
      }),
      execute: ({ name, source, origin }) => call("script.create", { origin, name, source }),
    }),
    update_script: tool({
      description: "Update a script's name/source.",
      inputSchema: z.object({
        id: z.string(),
        name: z.string().optional(),
        source: z.string().optional(),
        origin: z.string().default("master"),
      }),
      execute: ({ id, name, source, origin }) => call("script.update", { origin, id, name, source }),
    }),
    delete_script: tool({
      description: "Delete a script.",
      inputSchema: z.object({ id: z.string(), origin: z.string().default("master") }),
      execute: ({ id, origin }) => call("script.delete", { origin, id }),
    }),
    list_scripts: tool({
      description: "List the scripts (metadata only).",
      inputSchema: z.object({ origin: z.string().default("master") }),
      execute: ({ origin }) => call("script.list", { origin }),
    }),
    get_script: tool({
      description: "Read one script (name + source + last-run status).",
      inputSchema: z.object({ id: z.string(), origin: z.string().default("master") }),
      execute: ({ id, origin }) => call("script.get", { origin, id }),
    }),
    run_script: tool({
      description:
        "Run a script NOW (sandboxed, no model re-invocation) and return its result.",
      inputSchema: z.object({ id: z.string(), origin: z.string().default("master") }),
      execute: ({ id, origin }) => call("script.run", { origin, id }),
    }),

    // ---- schedules (per-agent alarm visibility + control) ----
    // The agent manages ITS OWN scheduled tasks by default. Pause/resume/update
    // are MUTATIONS: the route gates them behind owner approval (an in-context
    // approval card resolves a model-initiated call; the owner's own UI click is
    // its own approval).
    schedules_list: tool({
      description:
        "List YOUR scheduled tasks (alarms you created with schedule_task): prompt preview, next fire time, period, and state (active/paused/quarantined). Always scoped to your own tasks — you can never see another agent's tasks.",
      inputSchema: z.object({}),
      execute: () => call("schedules.list", {}),
    }),
    schedules_pause: tool({
      description:
        "Pause one of your scheduled tasks by name: it keeps its schedule metadata but stops firing (its alarm is released). Resume it with schedules_resume. Requires owner approval.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: ({ name }) => call("task.pause", { name }),
    }),
    schedules_resume: tool({
      description:
        "Resume a paused scheduled task by name: a periodic task restarts its period from now; a one-shot fires at its original time (or soon if that passed). Requires owner approval.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: ({ name }) => call("task.resume", { name }),
    }),
    schedules_update: tool({
      description:
        "Update one of your scheduled tasks by name: new prompt text and/or timing. Pass at OR delayMs to change the schedule; omit both to change only the text. Requires owner approval.",
      inputSchema: z.object({
        name: z.string().min(1),
        task: z.string().min(1).max(4000).optional(),
        at: z.number().optional().describe("absolute epoch ms in the future — pass this OR delayMs"),
        delayMs: z.number().optional().describe("positive delay in ms from now — pass this OR at"),
        periodInMinutes: z.number().optional(),
      }),
      execute: ({ name, task, at, delayMs, periodInMinutes }) =>
        call("task.update", { name, task, at, delayMs, periodInMinutes }),
    }),
  };
}

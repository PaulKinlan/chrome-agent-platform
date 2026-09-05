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
import { ASSET_BOUNDS, ASSET_TYPES } from "./artifacts.js";
import { TABLE_LIMITS, TABLE_LOCALE_PROFILES } from "./table-core.js";
import { TABLE_TOOL_NAMES } from "./table-tool-runtime.js";
import { tagUntrusted } from "./untrusted-fence.js";

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
  "patch_asset",
  "append_asset",
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
  "python_execute",
  "schedules_list",
  "schedules_pause",
  "schedules_resume",
  "schedules_update",
  "delegate_to_agent",
  "board_post_job",
  "board_claim_job",
  "board_complete_job",
  "board_send_message",
  "board_list",
  "board_read",
  "board_read_messages",
  ...TABLE_TOOL_NAMES,
];

const TableArtifactIdSchema = z.string().min(1).max(200);
const TableColumnIdSchema = z.string().regex(/^c(?:[1-9]\d*)$/u);
const TableHeaderSchema = z.string().max(TABLE_LIMITS.maxHeaderBytes);
const TableTypeSchema = z.union([
  z.object({ kind: z.enum(["text", "boolean", "int64", "date", "datetime"]) }).strict(),
  z.object({ kind: z.literal("decimal"), scale: z.number().int().min(0).max(18) }).strict(),
]);
const TableExplicitColumnSchema = z.object({
  type: TableTypeSchema,
  header: TableHeaderSchema.optional(),
}).strict();
const CanonicalTableSourceSchema = z.object({
  artifactId: TableArtifactIdSchema,
  format: z.literal("cap.table/1"),
}).strict();
const DelimitedTableSourceBase = {
  artifactId: TableArtifactIdSchema,
  format: z.enum(["csv", "tsv"]),
  hasHeader: z.boolean(),
  localeProfile: z.enum(Object.keys(TABLE_LOCALE_PROFILES)),
};
const DelimitedTableSourceSchema = z.union([
  z.object({ ...DelimitedTableSourceBase, schemaMode: z.enum(["text", "infer"]) }).strict(),
  z.object({
    ...DelimitedTableSourceBase,
    schemaMode: z.literal("explicit"),
    columns: z.array(TableExplicitColumnSchema).max(TABLE_LIMITS.maxColumns),
  }).strict(),
]);
const TableSourceSchema = z.union([CanonicalTableSourceSchema, DelimitedTableSourceSchema]);
const TableOutputFields = {
  outputName: z.string().min(1).max(ASSET_BOUNDS.maxNameLength).optional(),
  timeoutMs: z.number().int().min(100).max(180_000).optional(),
};
const TableMetricSchema = z.object({
  op: z.enum(["count_rows", "count_values", "sum", "avg", "min", "max"]),
  column: TableColumnIdSchema.optional(),
  header: TableHeaderSchema,
  scale: z.number().int().min(0).max(18).optional(),
}).strict().superRefine((metric, ctx) => {
  if ((metric.op === "count_rows") === (metric.column !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["column"], message: "count_rows omits column; every other metric requires it" });
  }
  if ((metric.op === "avg") !== (metric.scale !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scale"], message: "avg requires scale; every other metric omits it" });
  }
});
const TableRangeSchema = z.object({
  r1: z.number().int().min(1),
  c1: z.number().int().min(1),
  r2: z.number().int().min(1),
  c2: z.number().int().min(1),
}).strict();
const TableTargetRowsSchema = z.object({
  r1: z.number().int().min(1),
  r2: z.number().int().min(1),
}).strict();

export function managementToolset({ callRoute }) {
  const call = (type, args) => Promise.resolve(callRoute(type, args ?? {}));

  // chrome-agent-platform-np64: the sandbox constraint every artifact-writing
  // schema carries. The generated html renders live in an ORIGIN-OPAQUE
  // sandbox (an allow-scripts-only frame: no localStorage/sessionStorage/
  // cookies, no network, no permission-gated APIs), so code that reaches for
  // the persistence APIs a normal page has will throw there. The model is
  // told the constraint AT THE TOOL (the moment it writes the code), and the
  // thrown errors repeat it at runtime; the protected system-prompt rule
  // (lib/runtime-policy.js "sandboxed-artifacts") states the same invariant.
  // The SHORT sandbox rule LEADS every artifact-writing tool description. The
  // model-facing discovery surfaces are PREFIX-truncated (tool-search summaries
  // keep the first 512 bytes, list_tools rows the first 256), so a rule
  // appended after a long preamble was never seen at tool-discovery time
  // (np64 r5 review P1). One spelling, first.
  const HTML_ARTIFACT_SANDBOX_LEAD =
    "For html artifacts: they render in an origin-opaque sandbox — no localStorage/sessionStorage/cookies, no network, no permission-gated APIs — keep state in-memory or store it with the platform. ";

  return {
    // ---- sub-agent management ----
    create_agent: tool({
      description:
        "Enroll a new per-site sub-agent for an origin. Registers the origin so its WebMCP/site tools can be discovered. Host access is a separate owner-approved step in Settings. NOTE: this is a SITE enrollment — it does NOT create a teammate in the owner's Agents list; when the owner asks to 'create an agent' (a researcher, a critic, a chief of staff) call create_named_agent instead.",
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
        HTML_ARTIFACT_SANDBOX_LEAD +
        "Create an artifact (a thing you make for the owner). Use origin 'master' for a hub-level artifact, or an origin for a site-specific one. type: \"html\" | \"text\" | \"json\" | \"image\" | \"data\" (exactly one of these literals — never a MIME type). Pass the SAME key on every run that should produce the SAME artifact: a key that already exists finds and updates that exact artifact instead of creating a duplicate.",
      inputSchema: z.object({
        origin: z.string().default("master").describe("'master' or an https origin"),
        type: z.enum([...ASSET_TYPES]).default("text"),
        key: z.string().max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._\-]{0,63}$/u).optional().describe("idempotency key (letters, digits, dot, dash, underscore, space; max 64 chars) — pass the same key to create-or-update the SAME artifact instead of duplicating"),
        name: z.string().max(ASSET_BOUNDS.maxNameLength).describe(`a short, clear name (max ${ASSET_BOUNDS.maxNameLength} characters)`),
        content: z.string().describe("the complete artifact content (no size limit — pass the complete body in this field, never truncate; for very large bodies you may also build incrementally with append_asset)"),
      }),
      execute: ({ origin, type, key, name, content }) =>
        call("asset.create", { origin, assetType: type, key, name, content }),
    }),
    update_asset: tool({
      description:
        HTML_ARTIFACT_SANDBOX_LEAD +
        "Replace an artifact's whole name/type/content (resends the entire body — for a small change prefer patch_asset, which sends only the changed text). type: \"html\" | \"text\" | \"json\" | \"image\" | \"data\" (exactly one of these literals — never a MIME type). When the artifact is html, it still renders in the origin-opaque sandbox, so the constraint applies to the replacement code: no localStorage/sessionStorage/cookies, no network, no permission-gated APIs — keep state in-memory or store it with the platform.",
      inputSchema: z.object({
        origin: z.string().default("master"),
        id: z.string(),
        name: z.string().max(ASSET_BOUNDS.maxNameLength).optional(),
        type: z.enum([...ASSET_TYPES]).optional(),
        content: z.string().optional().describe("complete replacement content (no size limit; never truncate)"),
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
    patch_asset: tool({
      description:
        HTML_ARTIFACT_SANDBOX_LEAD +
        "Edit part of an artifact by exact text replacement — the cheap way to change a small piece. Each `search` must match exactly once (set all:true to replace every occurrence); a search that is not found or is ambiguous is refused without changing anything. Prefer this over update_asset for small edits — you send only the changed text, not the whole document. Pass expectVersion (the version you last read) to refuse the edit if the artifact changed underneath you. When the artifact is html, it still renders in the origin-opaque sandbox, so the constraint applies to the edited code: no localStorage/sessionStorage/cookies, no network, no permission-gated APIs — keep state in-memory or store it with the platform.",
      inputSchema: z.object({
        origin: z.string().default("master").describe("'master' or an https origin"),
        id: z.string().min(1).describe("the artifact id (from list_assets)"),
        edits: z.array(z.object({
          search: z.string().min(1).describe("exact text to find (must occur once unless all:true)"),
          replace: z.string().describe("text to put in its place (may be empty to delete)"),
          all: z.boolean().optional().describe("replace EVERY occurrence instead of requiring a unique match"),
        })).min(1).max(20).describe("the edits, applied in order"),
        expectVersion: z.number().int().optional().describe("the version you last saw; the edit is refused if the head has moved"),
      }),
      execute: ({ origin, id, edits, expectVersion }) =>
        call("asset.patch", { origin, id, edits, expectVersion }),
    }),
    append_asset: tool({
      description:
        "Append text to the END of an artifact's content (the chunked build path for growing one artifact across several calls). There is no size limit: one call may carry any amount of text, and the body accumulates across calls with every append stored as an immutable version. Prefer this over update_asset when you are building a large body incrementally: you never resend what is already stored. Pass expectVersion (the version you last read) to refuse the append if the artifact changed underneath you. The owner approves a model append like any other artifact edit.",
      inputSchema: z.object({
        origin: z.string().default("master").describe("'master' or an https origin"),
        id: z.string().min(1).describe("the artifact id (from list_assets — the artifact you are growing)"),
        content: z.string().min(1).describe("the text to append to the end of the artifact (no size limit; sent complete, never truncated)"),
        expectVersion: z.number().int().optional().describe("the version you last saw; the append is refused if the head has moved"),
      }),
      execute: ({ origin, id, content, expectVersion }) =>
        call("asset.append", { origin, id, content, expectVersion }),
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
      description: "List an origin's artifacts (use 'master' for all hub artifacts). Artifacts are how you hand work back to the owner — a generated page, a report, a data file — so the owner can view and reuse them.",
      inputSchema: z.object({ origin: z.string().default("master") }),
      execute: ({ origin }) => call("asset.list", { origin }),
    }),
    get_asset: tool({
      description: "Read one artifact's content. Canonical cap.table/1 artifacts are local-only: this returns their id, digest, dimensions, and local-preview availability but never headers, rows, or cells.",
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
        "Create a persistent NAMED agent (a teammate with its own memory + history + skills, like a 'PR reviewer' or 'my reader'). You give it a name + role; it gets its own sandbox and appears in the owner's Agents list IMMEDIATELY. When the owner asks you to 'create an agent' / 'make an agent', THIS is the tool — never create_agent (that is a per-site WebMCP enrollment, a different thing entirely).",
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

    // ---- agent→agent delegation (G5) ----
    // The caller identity is NOT a tool arg: the model-facing dispatcher binds
    // the run's execution id into the route CONTEXT (bindModelApprovalDispatcher),
    // and dispatchRoute strips __-prefixed body keys, so the model can never
    // forge the caller. The named-agent.delegate route resolves the caller from
    // context.executionId against the live run registry (fail closed).
    delegate_to_agent: tool({
      description:
        "Delegate a task to ANOTHER named agent and return its result inline. Only works inside a running named agent (from the hub, use board_post_job instead — it wakes the target), and only for agents in your own 'Can delegate to' list (set by the owner). The target runs with its own persona, memory, and provider; its approvals are its own. Use list_named_agents to see who exists.",
      inputSchema: z.object({
        agent: z.string().describe("the target agent's id (slug) or exact name"),
        task: z.string().describe("the complete, self-contained brief for the target agent"),
        context: z.string().optional().describe("extra context the target needs (findings so far, constraints)"),
      }),
      execute: ({ agent, task, context }) =>
        call("named-agent.delegate", { agent, task, context }),
    }),

    // ---- the shared jobs board (async/broadcast complement to delegation) ----
    // Same caller-identity discipline as delegate_to_agent: the caller is the
    // route context, never a model arg. v1 is fully open among named agents +
    // the hub (owner decision 2026-08-29); per-edge rules slot into the pure
    // guards in lib/agent-board.js later.
    board_post_job: tool({
      description:
        "Hand work to ANOTHER named agent through the shared board. This is THE hand-off tool from the hub (delegate_to_agent only works inside a running named agent). Posting a targeted job automatically starts (wakes) the target agent, which claims the job, does the work, and completes it — the result is delivered to this thread as a message when it settles, so do not wait for it and never report the work as done yourself. Set targetAgent to aim it at one agent (its id or exact name from list_named_agents); an untargeted job is claimable by any agent on its next run. blockedBy holds job ids that must complete first.",
      inputSchema: z.object({
        description: z.string().describe("what needs doing — self-contained, bounded; reference threads/artifacts by id instead of copying content"),
        requiredCapability: z.string().optional().describe("a short capability tag (e.g. 'critique', 'screenshot review')"),
        targetAgent: z.string().optional().describe("a specific agent's id or exact name; omit for an open broadcast job"),
        blockedBy: z.array(z.string()).optional().describe("job ids that must complete before this can be claimed"),
      }),
      execute: ({ description, requiredCapability, targetAgent, blockedBy }) =>
        call("board.post", { description, requiredCapability, targetAgent, blockedBy }),
    }),
    board_claim_job: tool({
      description:
        "Claim an open job from the shared board (you become its owner for a 5-minute lease). Only claim jobs you can actually complete; you never claim your own. Use board_list to see what's open.",
      inputSchema: z.object({
        jobId: z.string().describe("the job id from board_list"),
      }),
      execute: ({ jobId }) => call("board.claim", { jobId }),
    }),
    board_complete_job: tool({
      description:
        "Mark a job you claimed as complete, with the result for the poster. The poster sees the result on the board and in the Tasks surface.",
      inputSchema: z.object({
        jobId: z.string(),
        result: z.string().describe("the outcome — what the poster needs to know"),
      }),
      execute: ({ jobId, result }) => call("board.complete", { jobId, result }),
    }),
    board_send_message: tool({
      description:
        "Post a message to the shared board — to everyone (broadcast) or one agent. Use it for findings, questions, and coordination that isn't a job. The recipient reads it with board_read_messages on its next run — a message does not start an agent (post a job for that).",
      inputSchema: z.object({
        to: z.string().optional().describe("an agent id/name, or omit for broadcast"),
        body: z.string().describe("the message"),
        refJobId: z.string().optional().describe("the job this message is about, if any"),
      }),
      execute: ({ to, body, refJobId }) => call("board.message", { to, body, refJobId }),
    }),
    board_list: tool({
      description: "List jobs on the shared board (open, claimed, or settled), most recent first.",
      inputSchema: z.object({
        status: z.enum(["pending", "claimed", "completed", "failed"]).optional().describe("filter by status; omit for all"),
      }),
      // Board jobs are written by OTHER agents (and, through them, by pages):
      // tagged untrusted so the lazy projection fences them (lib/untrusted-fence.js).
      execute: async ({ status }) => tagUntrusted(await call("board.list", { status })),
    }),
    board_read: tool({
      description: "Read one board job in full (description, claimant, result).",
      inputSchema: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => tagUntrusted(await call("board.read", { jobId })),
    }),
    board_read_messages: tool({
      description:
        "Read board messages addressed to you or broadcast to everyone (most recent first). Check this when you are woken for a job or asked to look at the board — notes from other agents arrive here.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe("how many messages (default 20)"),
        refJobId: z.string().optional().describe("only messages about this job"),
      }),
      execute: ({ limit, refJobId }) => call("board.messages", { limit, refJobId }),
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
        "Subscribe a background recipe (or the master agent) to a system event, so the agent runs when it fires. Refused (fail-closed) if the hook is owner-denied or its install-granted permission cannot be verified. recipeId may be omitted to subscribe the master agent.",
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
        HTML_ARTIFACT_SANDBOX_LEAD +
        "Generate an interactive HTML UI (a page, a widget, a data visualization, a small app) for the owner. It is saved as an html artifact AND rendered LIVE in a sandboxed double-iframe in the conversation. The UI may use inline scripts + styles (interactive) but runs in an ORIGIN-OPAQUE SANDBOX: no localStorage/sessionStorage/cookies, no network, no permission-gated APIs are available inside it (the frame is allow-scripts-only and its CSP blocks all egress). Write the UI to keep its state IN-MEMORY (JS variables — state resets on reload), or store state with the platform (a saved-state artifact/memory key) and load it back at start — never generate code that needs storage, cookies, or network at runtime. The owner's theme/locale is percolated in automatically.",
      inputSchema: z.object({
        name: z.string().max(ASSET_BOUNDS.maxNameLength).describe("a short, clear name for the generated UI"),
        html: z.string().describe("the complete HTML (no size limit; never truncate)"),
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
    // A model-initiated create/run/schedule pays an OWNER APPROVAL card that
    // shows the exact source + the hosts it fetches; the host-side fetch
    // refuses private addresses and any host not on that list
    // (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01).
    create_script: tool({
      description:
        "Create a reusable JavaScript script (an async function body) that runs sandboxed + repeatedly without re-invoking the model. The script gets a controlled api: await fetch(url, opts) (reads a PUBLIC http/https page, returns {status, text}) + log(...). Return a value as the result. No DOM/extension/network access of its own. REQUIRES OWNER APPROVAL: the owner sees the full source and every host it fetches before it is saved; use plain string-literal URLs so the hosts are visible — a computed URL is flagged and only the listed hosts are ever reachable; localhost and private addresses are always refused.",
      inputSchema: z.object({
        name: z.string().min(1).describe("a short, clear name for the script"),
        source: z.string().describe("the complete JavaScript function body (no size limit)"),
        origin: z.string().default("master").describe("'master' (hub-level script)"),
      }),
      execute: ({ name, source, origin }) => call("script.create", { origin, name, source }),
    }),
    update_script: tool({
      description: "Update a script's name/source.",
      inputSchema: z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        source: z.string().optional().describe("complete replacement source (no size limit)"),
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
        "Run a script NOW (sandboxed, no model re-invocation) and return its result. REQUIRES OWNER APPROVAL: the owner sees the script's source and the hosts it fetches on an approval card; the run waits for that decision.",
      inputSchema: z.object({ id: z.string(), origin: z.string().default("master") }),
      execute: ({ id, origin }) => call("script.run", { origin, id }),
    }),

    python_execute: tool({
      description:
        "Execute a Python program in the sandboxed in-browser Pyodide runtime. Input is Python source code (code: string) and optional standard input (stdin: string). Output is captured standard output. The runtime runs sandboxed with no DOM access and no network.",
      inputSchema: z.object({
        code: z.string().min(1).describe("the Python program source, top-level only"),
        stdin: z.string().optional().describe("optional standard input passed to the Python program"),
      }),
      execute: ({ code, stdin }) => call("python.execute", { code, stdin }),
    }),

    // ---- local table engine (full cells stay in artifacts; model sees metadata) ----
    table_filter: tool({
      description: "Filter a local table artifact with a strict typed predicate. The complete result is a new immutable cap.table/1 artifact; this tool returns only its id, digest, dimensions, and work/byte counts — never rows or cells.",
      inputSchema: z.object({
        source: TableSourceSchema,
        predicate: z.unknown().describe("strict all/any/not tree or typed leaf {column,op,value}; is_missing/is_present omit value"),
        ...TableOutputFields,
      }).strict(),
      execute: (args) => call("table.run", { toolId: "table_filter", args }),
    }),
    table_select: tool({
      description: "Project and reorder columns from a local table artifact. Repeated source columns and duplicate display headers are allowed; output ids are regenerated c1..cN. Returns metadata only.",
      inputSchema: z.object({
        source: TableSourceSchema,
        columns: z.array(z.object({ column: TableColumnIdSchema, header: TableHeaderSchema.optional() }).strict()).max(TABLE_LIMITS.maxColumns),
        ...TableOutputFields,
      }).strict(),
      execute: (args) => call("table.run", { toolId: "table_select", args }),
    }),
    table_join: tool({
      description: "Join two local table artifacts with exact typed keys and deterministic input order. Missing keys never match; duplicate keys produce the full Cartesian result or the whole job fails its bounds. Returns metadata only.",
      inputSchema: z.object({
        leftSource: TableSourceSchema,
        rightSource: TableSourceSchema,
        kind: z.enum(["inner", "left", "right", "full"]),
        keys: z.array(z.object({ left: TableColumnIdSchema, right: TableColumnIdSchema }).strict()).min(1).max(8),
        leftColumns: z.array(TableColumnIdSchema).max(TABLE_LIMITS.maxColumns),
        rightColumns: z.array(TableColumnIdSchema).max(TABLE_LIMITS.maxColumns),
        ...TableOutputFields,
      }).strict(),
      execute: (args) => call("table.run", { toolId: "table_join", args }),
    }),
    table_group_aggregate: tool({
      description: "Group a local table by stable first-seen typed keys and compute exact count/sum/average/min/max metrics. Decimal math is BigInt-scaled with explicit half-even average scale. Returns metadata only.",
      inputSchema: z.object({
        source: TableSourceSchema,
        groupBy: z.array(TableColumnIdSchema).max(8),
        metrics: z.array(TableMetricSchema).max(TABLE_LIMITS.maxMetrics),
        ...TableOutputFields,
      }).strict(),
      execute: (args) => call("table.run", { toolId: "table_group_aggregate", args }),
    }),
    table_pivot: tool({
      description: "Pivot a local table into explicit ordered categories and exact aggregate metrics. Unknown or missing undeclared categories fail the complete job; no rows or cells are returned to the provider.",
      inputSchema: z.object({
        source: TableSourceSchema,
        rowGroupBy: z.array(TableColumnIdSchema).max(8),
        pivotColumn: TableColumnIdSchema,
        categories: z.array(z.object({
          value: z.union([z.string().max(TABLE_LIMITS.maxCellBytes), z.boolean()]),
          header: TableHeaderSchema,
        }).strict()).min(1).max(128),
        metrics: z.array(TableMetricSchema).min(1).max(TABLE_LIMITS.maxMetrics),
        ...TableOutputFields,
      }).strict(),
      execute: (args) => call("table.run", { toolId: "table_pivot", args }),
    }),
    table_formula: tool({
      description: "Evaluate one closed, explicit-range formula over a local table. No JavaScript, SQL, network, volatile/indirect/external or whole-row references are available. Produces a materialized cap.table/1 artifact and returns metadata only.",
      inputSchema: z.object({
        source: TableSourceSchema,
        mode: z.enum(["append_column", "scalar"]),
        readRange: TableRangeSchema,
        targetRows: TableTargetRowsSchema.optional(),
        expression: z.string().min(1).max(4096),
        result: z.object({ header: TableHeaderSchema, type: TableTypeSchema }).strict(),
        numericPolicy: z.object({
          divisionScale: z.number().int().min(0).max(18),
          rounding: z.literal("half_even"),
        }).strict(),
        ...TableOutputFields,
      }).strict(),
      execute: (args) => call("table.run", { toolId: "table_formula", args }),
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

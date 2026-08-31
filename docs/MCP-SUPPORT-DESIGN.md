# MCP support — design and plan (2026-08-31)

Owner ask: (1) MCP as a **global** option for the task view, with each **agent** also having its
own MCP servers and their own configurations; (2) check whether the agent-do harness supports the
latest MCP spec.

This is the plan of record. Tracker umbrella: `CAP-FB-20260831-MCP-SUPPORT-01` (+ children below).

## What we already have (verified 2026-08-31)

- **agent-do 0.7.0 already implements MCP**, and it is current, not behind:
  - exports `mountMcpServers(configs)`, `MCP_TOOL_PREFIX = "mcp__"`, `namespacedToolName(server, tool)`.
  - depends on `@modelcontextprotocol/sdk@^1.30.0`; that SDK declares
    `LATEST_PROTOCOL_VERSION = '2025-11-25'` and negotiates down through `2025-06-18`, `2025-03-26`,
    `2024-11-05`. **The "latest MCP spec" worry is unfounded** — the harness is on the newest revision.
  - `agent-do/dist/src/mcp.js` builds a `Client` per server and supports **three** transports:
    `StdioClientTransport`, `SSEClientTransport`, `StreamableHTTPClientTransport`.
- **Per-agent config already has the right shape to copy.** `extension/lib/named-agents.js` stores a
  self-contained **per-agent provider override** (`{provider, baseURL, apiKey, model}`) that a run
  inherits-or-overrides. Per-agent MCP config follows that exact pattern.
- **Tools already reach the model lazily.** Runs assemble `extraTools` (browser + management toolsets)
  in `extension/lib/agent.js` / `service-worker.js`; the lazy protocol (`search_tools`/`execute_tool`)
  keeps the prompt small. MCP tools join the same lazy catalog, namespaced `mcp__<server>__<tool>`.
- **WebMCP already exists and is different.** `extension/content/webmcp-detect-*.js` is *sites exposing
  tools to us on the page*. Classic **MCP servers** (this design) are *remote services the agent
  connects out to*. Keep the two names and surfaces distinct.

## The real constraints (this is where the work is)

1. **MV3 has no subprocess → stdio MCP is impossible in the extension.** `StdioClientTransport` spawns a
   child process (`agent-do/dist/src/mcp.js` uses `createRequire` + node stdio). A browser service
   worker cannot spawn processes. **The extension supports REMOTE MCP servers only: Streamable HTTP and
   SSE.** stdio/local-command servers are explicitly out of scope in the extension (a future desktop/
   companion host could add them; not now). The UI must not offer a "command" server type.
   - Risk: agent-do's `mcp.js` imports the stdio transport at module top level. If that import pulls
     `node:child_process` into the esbuild bundle it breaks the MV3 CSP/build. **Child entry
     `MCP-TRANSPORT-SPIKE` must prove** either (a) the stdio import tree-shakes/stubs cleanly in our
     bundle, or (b) we mount MCP ourselves using the SDK's `StreamableHTTPClientTransport`/
     `SSEClientTransport` directly and never import agent-do's stdio path.
2. **`mountMcpServers` is all-or-nothing** ("if any server fails to connect, all fail" — its own doc).
   For user-configured servers that is wrong: one unreachable server must not kill the run. We need
   **per-server resilience** — connect each independently, surface a per-server error, run with the
   ones that connected. Either wrap agent-do's per-server path or mount via the SDK directly with our
   own error isolation.
3. **MCP tool output is untrusted external content.** Fence it exactly like page/WebMCP results
   (`UNTRUSTED-CONTENT-FENCING-01` landed): a server's tool descriptions and results are attacker-
   controlled and must be delimited so they can't inject instructions. Namespacing prevents a server
   spoofing a built-in tool name.
4. **Server credentials are secrets.** Auth headers / bearer tokens / OAuth tokens for MCP servers are
   stored like provider keys — `chrome.storage`, never in the bundle, logs, run receipts, or exported
   data (the constitution rule). OAuth (the SDK ships `auth.js`) is a later slice; start with a
   static header/bearer token.
5. **Connection context.** Remote MCP `fetch`/SSE runs from the **service worker / agent worker**, which
   has `<all_urls>` host access, so egress works. It must **not** run inside the sandboxed artifact
   iframe (its CSP is `connect-src 'none'`). Long-lived SSE connections must be torn down when a run
   ends and re-opened per run (MV3 workers are ephemeral).

## The model

### Global MCP servers (the task-view option)
- A Settings surface **"MCP servers"** (a developer-or-standard section — coordinate with
  `EXEC-BUILD-FLAG-01`). Each server: `{ id, name, transport: "http"|"sse", url, auth?: {headerName,
  token} , enabled }`. Stored in `chrome.storage` (config) with the token handled like a provider key.
- Global servers are available to **hub runs** and, by default, inherited by every agent.

### Per-agent MCP servers
- Each named agent carries its own MCP server list in its config (same store/validation path as the
  per-agent provider override in `named-agents.js`): it **inherits** the global set and may **add** its
  own and **disable** inherited ones. Self-contained per server (name + transport + url + auth), so one
  agent's server credential never leaks to another.
- Configured in the **create/edit agent dialog** (the template gallery already lands there) under an
  "MCP servers" section, and editable per agent later.

### Tool injection + lazy catalog
- On a run, resolve the effective server set (global ∪ agent, minus disabled), connect each remotely
  (resilient), list its tools, namespace them `mcp__<server>__<tool>`, and fold them into the run's
  `extraTools` so they appear in the lazy `search_tools`/`execute_tool` catalog — never eagerly in the
  prompt.
- **First-use approval per server** (mirror WebMCP's per-tool approval and the one Allow card): the
  owner approves a server's tools before the model may call them; the activity ledger records MCP tool
  calls; results are fenced.

## Work breakdown (children of CAP-FB-20260831-MCP-SUPPORT-01)

1. **`MCP-TRANSPORT-SPIKE-01` (P1, do first).** Prove remote MCP works in the loaded extension: connect
   to a local test Streamable-HTTP MCP server from the SW, list + call a tool, tear down. Resolve the
   agent-do stdio-import question (bundle cleanly, or mount via the SDK directly). Decide: use
   `mountMcpServers` with a resilience wrapper, or a thin own mount over the SDK transports. Output: a
   working spike + the transport/bundle decision written back into this doc.
2. **`MCP-CONFIG-STORE-01` (P1).** The config model + validation + storage: global server list and the
   per-agent server list (extend `named-agents.js` the way the provider override is done), credentials
   handled like provider keys, an inherit/override resolver. Pure, unit-tested.
3. **`MCP-TOOL-INJECTION-01` (P1).** Connect the effective server set per run (resilient), namespace and
   fold tools into the lazy catalog, fence outputs (`untrusted:true`), per-server first-use approval,
   ledger the calls, tear down on run end. Depends on 1, 2, and `UNTRUSTED-CONTENT-FENCING-01` (done).
4. **`MCP-GLOBAL-UI-01` (P1).** The Settings "MCP servers" section: add/edit/enable/test-connection a
   remote server, credential field handled like the provider key, honest connection errors. Depends on 2.
5. **`MCP-AGENT-UI-01` (P1).** The per-agent "MCP servers" section in the create/edit dialog: inherit
   the global set, add/disable per agent. Depends on 2, 4.
6. **`MCP-OAUTH-01` (P2, later).** OAuth for MCP servers that require it (the SDK's `auth.js`), a proper
   consent flow. After static-token servers work.
7. **`AGENT-DO-MCP-ASSESSMENT-01` (P2).** Formal note: agent-do 0.7 SDK is `2025-11-25`-current; record
   whether we call `mountMcpServers` or mount ourselves, and whether a future agent-do bump is warranted
   (e.g. if it adds per-server resilience or removes the stdio top-level import). This closes the owner's
   "does agent-do support the latest spec" question with evidence.

## Gates that apply throughout
- MV3-CSP-safe (no eval/new Function); MCP output fenced as untrusted; credentials never in
  bundle/logs/receipts; remote transports only (no stdio in the extension); per-server resilience;
  the lazy catalog stays small; RED-first tests; real loaded-extension verification against a test MCP
  server; production build + full suite green.

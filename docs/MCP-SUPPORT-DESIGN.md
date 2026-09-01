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

---

## Transport spike result (CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01) — landed 2026-08-31

**Decision: option (b). We mount MCP ourselves over the SDK's browser-safe
transports (`StreamableHTTPClientTransport` / `SSEClientTransport`) directly,
and never import agent-do's stdio path. We do NOT call agent-do's
`mountMcpServers`.**

Both reasons in constraint 1's risk and constraint 2 hold, and either is
sufficient:

1. **All-or-nothing (constraint 2).** agent-do's `mountMcpServers` tears the
   whole set down and rethrows on any single server's `connect()`/`listTools()`
   failure. Per-server resilience is a hard requirement, so we own the mount
   loop. Wrapping agent-do per-server would mean calling it once per server and
   reimplementing the aggregation anyway.
2. **Dead stdio weight.** Importing `mountMcpServers` pulls
   `StdioClientTransport` (node `child_process`) — a transport MV3 can never
   use. Importing only `streamableHttp.js` + `sse.js` keeps it out by
   construction.

**On the bundle question specifically:** the stdio import does **not** break
`npm run build:production`. `build.mjs` already aliases every `node:*`
specifier (`child_process` included) to `browser-shim-node.js` for the SW and
agent-worker bundles, and those bundles *already* contain agent-do's MCP code
(including a shimmed, never-called `StdioClientTransport`) because the agent
loop imports agent-do. So the risk is real in mechanism but already mitigated
by the existing shim + `new Function` scrub. Our new client adds **zero** stdio
surface. (This also answers part of `AGENT-DO-MCP-ASSESSMENT-01`: we mount
ourselves; a future agent-do bump is only warranted if it adds per-server
resilience *and* stops importing stdio at module top.)

### What landed

- **`extension/lib/mcp-client-core.js`** — transport-agnostic mount/resolve
  helper (no SDK import → no `node:` builtins → Deno-unit-testable). Owns the
  **per-server-isolated** mount loop, `mcp__<server>__<tool>` namespacing
  (agent-do's `__`-rejecting rule), result flattening, and idempotent teardown.
  `mountRemoteMcpServers(configs)` returns `{ tools, toolOrigins, servers,
  close }`; each tool is `{ name, description, inputSchema, origin, call(args)
  → Promise<string> }`; `servers[]` is the per-server `{ name, ok, error?,
  toolCount? }` status the UI (config-store / global-UI children) should
  surface. A server-level failure is recorded and its half-open client closed;
  the mount never throws for it.
- **`extension/lib/mcp-client.js`** — binds the helper to real SDK `Client`s
  over `StreamableHTTPClientTransport` (transport `"http"`) and
  `SSEClientTransport` (`"sse"`). The SW / agent worker imports this; it never
  imports `client/stdio.js`.
- **`scripts/mcp-test-server.ts`** — a dependency-free, stateless MCP
  Streamable-HTTP test server (`add`, `echo`; CORS-permissive; `GET` → 405;
  `notifications/initialized` → 202). Library (`startMcpTestServer()`) or CLI.
- **`scripts/mcp-probe-entry.js`** — a developer-build-only probe `inject`-ed
  into the SW bundle (SW globals forbid `import()`, so the probe must be part of
  the bundle) that installs `globalThis.__capMcpProbe`. Absent from every store
  build.

### Evidence

- **Unit (falsification gate):** `tests/mcp-client-core.test.ts` (6 tests) — per-
  server isolation, atomic listTools-failure isolation, idempotent teardown,
  name validation, result formatting. Falsified by reverting the mount to
  all-or-nothing: the two isolation tests go **RED**; restored → **GREEN** 6/6.
- **Browser KAT:** `scripts/kat-mcp-transport.ts` (8/8) — the real loaded
  extension's **service worker** connects over Streamable-HTTP to the test
  server, lists `mcp__calc__add` / `mcp__calc__echo`, `add(3,5)` returns `"8"`,
  and a second **unreachable** server is reported `{ ok:false, error:"Failed to
  fetch" }` **without** aborting the run; teardown clean.
- **Build/suite:** `npm run build:production` clean (no `node:` builtins reach
  the SW, no `eval`/`new Function`, dev probe absent from store); full unit
  suite `deno test tests/` 2834 passed / 0 failed.

### Integration notes for the downstream children

- The untrusted-output fence (constraint 3) is **not** yet applied inside
  `call()` — the spike keeps `formatMcpToolResult` a plain text flatten. Wrap it
  with the project's `wrapForModel` guard when folding MCP tools into the
  model-visible lazy catalog (`MCP-TOOL-INJECTION-01`).
- Credentials go in `transport.headers` at connect time, sourced from secure
  storage; never persist them into a logged/exported config
  (`MCP-CONFIG-STORE-01`).

---

## Tool-injection result (CAP-FB-20260831-MCP-TOOL-INJECTION-01) — landed 2026-09-01

The run-time wiring that makes MCP work **end to end**. On a run (a real owner
run — `approvalExecutionId` present, never a scoped/hook run), the service
worker:

1. resolves the effective set with `effectiveMcpServers(agentId)` (global ∪ the
   named agent's, minus disabled) and `mountRemoteMcpServers(...)` — **per-server
   resilient**: one unreachable server is recorded as a diagnostic and skipped,
   never fatal;
2. wraps each mounted tool with **`extension/lib/mcp-run-tools.js` →
   `buildMcpRunTools`**, which owns the three run-time obligations the spike left
   to the integration layer: the untrusted **fence** (`tagUntrusted` on every
   successful result — the lazy projection then wraps its string leaves in the
   run's boundary token), the **per-server first-use owner approval** (one Allow
   card, `mcp.use-server`, cached per server for the run), and the **activity
   ledger** write (`mcp__…` rows via `action-ledger.js`, no inverse);
3. folds those tools into the lazy catalog as a NEW honest source kind **`mcp`**
   (`tool-catalog.adaptMcpTools` + `lazy-tool-protocol.executableMcpToolRecords`),
   so they are discovered through `search_tools`/`execute_tool` — **never eager**
   in the prompt — and are replay-**unknown** (external side effects, never
   auto-resumed);
4. **tears the connections down** in `runTask`'s `finally` (`orch.closeMcp`) —
   re-opened per run (constraint 5).

The keyless end-to-end proof is `scripts/kat-mcp-tool-injection.ts` driving the
demo marker `@demo-mcp <mcp__server__tool> [json-args]` through the real lazy
protocol against `scripts/mcp-test-server.ts`.

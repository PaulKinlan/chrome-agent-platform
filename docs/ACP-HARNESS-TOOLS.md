# Existing CAP tools in harness runs

Tracking: **chrome-agent-platform-vl6c**. Exposes CAP's existing browser and management tool
catalogue to ACP harnesses via an authenticated reverse-RPC MCP endpoint over the bridge,
preserving the existing lazy catalogue (`search_tools`, `list_tools`, `execute_tool`, `run_pipeline`)
and run-bound approval/origin/fence security.

## How does an ACP harness accept tools?

ACP `session/new` and `session/load` accept `mcpServers`. For supported harnesses (Claude Code,
Codex), the bridge supplies a per-session authenticated HTTP MCP endpoint (`http://127.0.0.1:<port>/cap-tools/<uuid>`).
Calls to `tools/list` and `tools/call` over this endpoint are relayed via reverse RPC over the
existing ACP WebSocket connection to `AcpClient` in the offscreen document, which forwards
them to the active AI SDK run loop.

Harnesses that do not support HTTP tools (such as `pi-acp 0.0.33`, tracked in **chrome-agent-platform-jjzm**)
connect normally without the MCP server block and operate as pure chat harnesses without failing.
When MCP tools are mounted (`toolsEnabled && httpToolsSupported`), the legacy prompt-injected
browser tool declaration is skipped to avoid contradictory instructions.

## Architecture and identity

The existing `agent.run` → `runTask` → `createOrchestrator` → agent-do path owns the
run. ACP gets the real durable `executionId`, not `acp.journal`'s display-only ID.
The NTP and shared conversation selection routes now dispatch there. CAP builds
its existing browser, management, memory, workflow, site and remote-tool catalogue;
no duplicate eager browser tool list is introduced.

`acp-model.js` is an AI SDK model backend: a harness tool request becomes an ordinary
model tool call; agent-do validates and executes it; the following model step sends
the result back to the waiting harness. The existing lazy authority, tool progress,
approval-resume and result fencing paths remain the execution path.

ACP I/O lives in the existing singleton offscreen document. The SW holds the small
model proxy, durable ownership and document-bound permission decisions. Each site
agent gets its own backend instance. The bridge mounts a bearer-authenticated,
connection-owned endpoint only when the client opts in and the adapter advertises
HTTP tool support. Closing the connection revokes it and rejects pending requests.
Endpoints reject web Origin requests and supply no CORS grants.

For the v05y retained model session, pre-prompt `acp.commands` discovery and a
subsequent turn reuse one client only when their thread, harness, endpoint and
working directory match. **The composer's `thread-id` attribute must equal the
`threadId` dispatched by `agent.run`**; the hub supplies it, but the sidepanel
composer currently omits the attribute even when `runTask` has a thread ID.
That can establish two short-lived sessions (discovery keyed `global`, turn keyed
to the run's thread) and lose reuse, not cross an authority boundary. Do not
copy a guessed thread ID into the composer: the sidepanel's catalogue cache
would also need invalidation when its thread changes. ACP permits one in-flight
prompt turn per retained session, while command discovery observes cached
commands without stealing a live turn's execution identity.

Native harness permission requests reuse `requestAcpPermission`. The card title
names the harness; the SW binds answers to the live execution and original document.
No answer, expiry, missing surface or cancellation denies. Explicit `acp.permissions`
`auto` remains explicit auto mode, not a default.

## Harness-visible surface

The installed lazy surface has **four** tools:

- `search_tools`
- `list_tools`
- `execute_tool`
- `run_pipeline`

The endpoint server name is `CAP`. Schemas and descriptions come directly from the
AI SDK's actual tool options, not a copied description table. A second browser tool
needs no new registration: it is resolved from the same live catalogue. Availability
still depends on that run's permissions, origin and policy.

## Measured gates and limits

Store-target bundle sizes from a fresh `npm run build:production` (measured 2026-10-16 on
`origin/main` b6389708, v0.3.712). The reference sizes come from `STORE_SW_BUDGET_BYTES` and
`STORE_BUNDLE_BUDGETS` in `scripts/bundle-budget.mjs`, the source of truth; this table is a dated
snapshot, so re-measure rather than trusting it. Only store `offscreen.bundle.js` has an enforced
per-bundle ceiling (258,000 bytes, ratcheted from 250,000 by bwxf); the other twelve are reported, not enforced:

| Surface | Size | Ceiling | Headroom |
| --- | ---: | ---: | ---: |
| Store background/service-worker.js | 2,809,119 B | 3,000,000 B | 190,881 B |
| Workers/agent-worker.js | 853,051 B | 2,000,000 B | 1,146,949 B |
| options.bundle.js | 444,527 B | 450,000 B | 5,473 B |
| ntp.bundle.js | 350,389 B | 500,000 B | 149,611 B |
| sidepanel.bundle.js | 19,832 B | 250,000 B | 230,168 B |
| shared/diff-core.bundle.js | 16,623 B | 17,000 B | 377 B |
| artifacts.bundle.js | 151,058 B | 200,000 B | 48,942 B |
| artifact.bundle.js | 138,122 B | 200,000 B | 61,878 B |
| directory.bundle.js | 61,788 B | 65,000 B | 3,212 B |
| privacy.bundle.js | 63,912 B | 65,000 B | 1,088 B |
| offscreen.bundle.js | 245,796 B | 258,000 B | 12,204 B |
| settings-view.bundle.js | 85,847 B | 120,000 B | 34,153 B |
| chunks aggregate (7 chunks) | 556,793 B | 750,000 B | 193,207 B |

Every store budget passes and none was relaxed. Five bundles sit under 5% headroom (diff-core
377 B, privacy 1,088 B, options 5,473 B, offscreen 4,204 B, directory 3,212 B): that thin margin is
the pattern chrome-agent-platform-3rryv tracks, not a single over-budget bundle. The per-bundle
ceilings quoted here earlier in this file (options 900,000, ntp 920,000, sidepanel 700,000, with
matching sizes) predated the 20e2u code-splitting ratchet-down and were wrong on both sides of the
comparison; since Paul's 2026-10-05 decision those other per-bundle overruns are measured and
reported rather than failing the build, and a lane still must not retune a reference. The later
x9r8k.2 offscreen staging build measured 249,976 B (24 B under its original 250,000 B ceiling, later ratcheted to 258,000 B by bwxf);
any further growth must be reclaimed or explicitly reviewed, not silently shipped.

## Operational boundaries

1. Sequential ACP turns may reuse the same retained harness session; CAP still carries its conversation history, and overlapping prompt turns on one session are refused.
2. In-flight tool calls run through the standard approval gates: gated tools (`close_tab`, `wipe_browsing_data`, `write_file`) raise the in-conversation live approval/diff card before executing.
3. If an owner denies a requested tool mutation, the denial error is returned verbatim to the harness so it can plan its next step.
4. Legacy `browser/call_tool` is refused with `-32601` when `toolHandler` is active, ensuring all tool calls route through the authenticated run-bound executor.

## MCP isolation for a CAP-spawned `pi`

A CAP-harness session must not inherit the operator's own MCP configuration. On a developer machine that
configuration can hand the session a browser-automation server which launches its own headless Chrome, and
that is the opposite of this project's architecture: the extension runs the browser, and the harness is
meant to ask it for tools.

So when CAP spawns a `pi` adapter it also sets `PI_MCP_CONFIG_MODE=exclusive` in that child's environment,
from **both** spawn sites — the bridge (`scripts/acp-bridge.ts`) and the native messaging host
(`scripts/acp-native-host.ts`). Both go through one composer in `scripts/lib/acp-child-env.ts`, so a third
spawn site cannot forget it, and `tests/acp-child-env-wiring.test.ts` spawns a fixture adapter through each
site and asserts the environment the child actually saw.

**This is all-or-nothing, and that is the intended cost.** For `pi`, the session sees only its own MCP
configuration: the operator's machine-level servers are not available inside a CAP session at all. There is
no per-server filter — the choice is the whole config or none of it. Other harnesses are deliberately left
alone: `claude-agent-acp` and `codex-acp` take their servers from ACP, so isolating them would strip servers
the operator did configure for them; and an unknown harness is not guessed at.

**If a real switch is needed, this is what exists today.** The `pi` CLI on this machine documents three
levers that could reach the same goal (`pi --help`): `--no-tools`/`-nt` drops the built-in and extension tools
together, which is all-or-nothing in the wrong direction for a harness that needs its tools; `--exclude-tools`/
`-xt <names>` drops named tools; and `PI_CODING_AGENT_DIR` pointed at a separate agent directory would avoid the
operator's MCP configuration altogether, at the cost of also moving `auth.json` and so losing the harness's
auth. None of the three was demonstrated against an MCP server here, so they are recorded as the documented
options rather than as a working replacement for the variable above. (chrome-agent-platform mfn9m)

**Honest limit.** The variable name and value are the mode `pi` is expected to use, and they were NOT
verified against a `pi` build: the pinned adapter `pi-acp@0.0.33` never mentions the variable (isolation is
its only control because it discards `params.mcpServers`), and the `pi` CLI on this machine exposes no
`PI_MCP_*` variable at all. What IS verified is that the variable reaches the harness — the adapter spawns
the CLI with the inherited environment — and that both CAP spawn sites set it, which the wiring test fails
on if either one stops. If the real switch turns out to differ, `harnessMcpIsolationEnv` in
`scripts/lib/acp-child-env.ts` is the single place to change.

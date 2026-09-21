# Existing CAP tools in harness runs — candidate, not accepted

Tracking: **chrome-agent-platform-vl6c**. This branch is incomplete and must not be
merged as a working integration. The production build exceeds the unchanged SW
budget; full-suite and real-harness/browser acceptance have not passed.

## How does an ACP harness accept tools?

ACP 1 `session/new` and `session/load` accept `mcpServers`. Its client filesystem
and terminal callbacks are fixed capabilities, not arbitrary tool registration.
Custom extension methods are possible but require adapter-specific implementation;
they do not register tools in an arbitrary harness. For Claude/Codex, the candidate
uses the standard server field as transport plumbing, not a separate CAP catalogue.

The pinned **pi-acp 0.0.33 does not mount supplied servers**. Its installed README's
Limitations section says they are accepted/stored but not wired to Pi; its bundled
`PiSession` stores `this.mcpServers` without consuming it. Passing the field alone
cannot deliver tools to Pi. Follow-up: **chrome-agent-platform-jjzm**. The candidate
refuses Pi explicitly instead of silently offering a tool-less session.

## Architecture and identity

The existing `agent.run` → `runTask` → `createOrchestrator` → agent-do path owns the
run. ACP gets the real durable `executionId`, not `acp.journal`'s display-only ID.
The NTP and shared conversation selection routes now dispatch there. CAP builds
its existing browser, management, memory, workflow, site and remote-tool catalogue;
no duplicate eager browser tool list is introduced.

`acp-model.js` is an AI SDK model backend: a harness tool request becomes an ordinary
model tool call; agent-do validates and executes it; the following model step sends
the result back to the waiting harness. The existing lazy authority, tool progress,
approval-resume and result fencing paths remain the execution path. Their real
browser behavior through this backend is **not yet verified**.

ACP I/O lives in the existing singleton offscreen document. The SW holds the small
model proxy, durable ownership and document-bound permission decisions. Each site
agent gets its own backend instance. The bridge mounts a bearer-authenticated,
connection-owned endpoint only when the client opts in and the adapter advertises
HTTP tool support. Closing the connection revokes it and rejects pending requests.
Endpoints reject web Origin requests and supply no CORS grants.

Native harness permission requests reuse `requestAcpPermission`. The card title
names the harness; the SW binds answers to the live execution and original document.
No answer, expiry, missing surface or cancellation denies. Explicit `acp.permissions`
`auto` remains explicit auto mode, not a default.

## Harness-visible surface

The installed lazy surface has **four**, not two, tools:

- `search_tools`
- `list_tools`
- `execute_tool`
- `run_pipeline`

The endpoint server name is `CAP`. Schemas and descriptions come directly from the
AI SDK's actual tool options, not a copied description table. Adapter-generated
model-facing prefixes and exact descriptions still require capture from the real
harness; no such capture is claimed. Focused tests show schema/description transport
and an AI SDK execution/result round trip with a scripted client, not a real model.
A second browser tool needs no new registration: it is resolved from the same live
catalogue. Availability still depends on that run's permissions, origin and policy.

## Measured gates and limits

Same worktree, same installed dependencies:

| Tree | Store SW bytes | Gate |
| --- | ---: | --- |
| Baseline `38e3418d` | 2,998,629 | production build passed |
| Initial ACP I/O in SW | 3,010,959 | over 3,000,000 ceiling |
| ACP I/O moved offscreen | 3,003,397 | over ceiling by 3,397 |

The offscreen move saved 7,562 bytes. No ceiling was changed. The last number is the
measured pre-publication candidate, not a claim about future commits. Evidence logs
are retained under the coordinator's durable `cap-evidence` root with the
`cap-harness-` prefix. Five new focused tests pass; three applied mutations fail
(model call name, bearer validation, document binding). The wider focused ACP run
passes 33 tests. These are **not** full-suite or browser acceptance.

The production build refusal prevents the required production-tree browser drive.
Outstanding acceptance: real Claude/Codex call to existing `list_tabs`, a denied
existing mutation, the native permission card/denial, supersession cleanup, real
model-visible tool capture, offscreen sender identity and full-suite/regression gates.
Do not infer these properties from passing fixture tests.

Native-messaging-only transport is explicitly refused for now; it still needs tool
plumbing. Native CLIs require a host process. **An in-browser harness would need a
callable catalogue binding, distinct from stdio ACP.** That is a separate zero-server
stage, **chrome-agent-platform-qnd4**, not solved by this bridge implementation.

Each candidate ACP turn creates a fresh harness session and carries CAP's conversation
history. Restoring a harness's own hidden session state is not established by this
path. Provider-native tools/model facilities that are not callable CAP tools are not
automatically converted into tools. These limitations must remain visible in review.

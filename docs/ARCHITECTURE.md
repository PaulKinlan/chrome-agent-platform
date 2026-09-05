# Chrome Agent Platform — Architecture

**Status:** living reference. All file:line citations resolve against
`origin/main@14e2a817` (2026-09-05, release 0.3.229) unless marked otherwise.
Where a claim could not be verified in the tree it says so explicitly.
Authored by the cap-arch-docs analysis lane (bead chrome-agent-platform-5k90,
umbrella 9zw7) from direct code reading; complements — does not replace — the
feature design docs in `docs/`.

## 0. The shape of the system

An MV3 Chrome extension whose new-tab page is an agent hub. Five execution
realms, in descending authority order:

```
┌────────────────────────────────────────────────────────────────────┐
│ SERVICE WORKER (dist/background/service-worker.js)                 │
│ The single authority: message routing + sender classification,     │
│ permissions/grants, the durable run registry, provider credentials,│
│ the tool catalog + lazy protocol, the scheduler, the alive-set.    │
│ Source: extension/background/service-worker.js (~9.6k lines) +     │
│ extension/background/routes/*.js (13 modules).                     │
└───────┬──────────────────┬───────────────────┬─────────────────────┘
        │ runtime messages │ chrome.offscreen  │ chrome.runtime ports
        ▼                  ▼                   ▼
┌───────────────┐  ┌──────────────────────────────┐  ┌─────────────────┐
│ EXTENSION     │  │ OFFSCREEN DOCUMENT (singleton)│  │ CONTENT SCRIPTS │
│ PAGES (hub    │  │ offscreen/offscreen.js —     │  │ on every http(s)│
│ ntp/, side-   │  │ hosts FIVE subsystems:       │  │ page (2 scripts)│
│ panel,        │  │  · script-sandbox host       │  │ MAIN probe +    │
│ options,      │  │  · agent SharedWorker host   │  │ ISOLATED relay  │
│ directory,    │  │  · Python (Pyodide) host     │  │ (webmcp-detect- │
│ artifacts…)   │  │  · Wasm stream host          │  │ main/relay.js)  │
└───────┬───────┘  │  · table worker host         │  └─────────────────┘
        │          └───────┬──────────────────────┘
        │ same origin      │ spawns per job/agent
        ▼                  ▼
┌────────────────────────────────────────────────────────┐
│ THROWAWAY WORKERS (fresh per job): wasm-execution-     │
│ worker.js (WASI tools), wasm-stream-worker.js (file-   │
│ backed tools), python classic worker, table-operation- │
│ worker.js. PER-AGENT SharedWorkers: workers/agent-     │
│ worker.js (named by agent id).                         │
└────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────┐
│ MANIFEST SANDBOX PAGES (opaque origin, zero chrome.*): │
│ sandbox/script-sandbox.html (agent-authored JS),       │
│ sandbox/artifact-preview.html (generated-UI artifacts) │
└────────────────────────────────────────────────────────┘
```

Storage authority: one OPFS origin root (the extension's) multiplexed into
per-agent/per-site subtrees, plus `chrome.storage.local` for config, plus the
provider's remote API as the only planned network egress.

## 1. Sandboxing — every surface

### 1.1 Manifest CSP and the eval ban
`extension/manifest.json` sets `content_security_policy.extension_pages` to
`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src 'self'
about: blob: data:`. No remote code can be loaded by any extension page;
`wasm-unsafe-eval` permits only WebAssembly compilation. The production build
refuses `eval`/`new Function` across all shipped JS (README §"Observability";
the store-target scan in build.mjs rejects computed/aliased Worker and remote
script sinks — see README §"Load + run" packaging paragraph).

**The one declared exemption:** `sandbox/script-sandbox.js:97` runs
agent-authored JavaScript with `new Function(...)` inside the manifest
`sandbox` page — an opaque origin with no `chrome.*`, no extension storage, no
same-origin relationship to anything (manifest.json `sandbox.pages`:
`sandbox/script-sandbox.html`, `sandbox/artifact-preview.html`). The sandbox
origin IS the security boundary; the rest of the bundle stays eval-free.
Storage APIs inside the sandbox are redefined to throw *teaching* errors
("a sandboxed script keeps no state between runs…") so an agent learns the
contract instead of hitting a raw SecurityError
(`extension/sandbox/script-sandbox.js:23-40`, chrome-agent-platform-np64).

### 1.2 The sandboxed script host protocol
The host page (offscreen document, or the hub as fallback) iframes
`script-sandbox.html`, posts `{type:"cap:script-source", source, runId, nonce}`
and receives a result (`extension/sandbox/script-sandbox.js:9-16`). The
script's only capabilities are a host-bridged `fetch` (URL-validated,
size-bounded, `credentials:"omit"`, no redirects, no loopback/private/link-local
— `extension/lib/fetch-policy.js`, host allowlist derived from the approved
source) and `log()`. Model-authored scripts are approved as *code* before first
run: the in-conversation card shows the exact source (digest-bound) and the
hosts it fetches (docs/CONSTITUTION.md §1, `script.create`/`script.run` rows in
`extension/lib/owner-approval.js:24-50`).

### 1.3 The offscreen document — singleton execution host
The SW cannot construct DOM or workers, so one offscreen document
(`chrome.offscreen.createDocument`, reasons `["WORKERS","DOM_SCRAPING"]`,
`extension/background/service-worker.js:355-367`) hosts five subsystems
(`extension/offscreen/offscreen.js:16-40`):
1. the script-sandbox host (doubly-registered listener, see §9 notes),
2. per-agent SharedWorkers (`registerAgentWorkerHost` →
   `extension/lib/agent-worker-host.js:60` `new SharedWorker(workerUrl,
   {type:"module", name: id})`),
3. the Pyodide Python host (`registerPythonHost` — fresh classic worker per
   `python.execute`; busy loops die by `worker.terminate()`),
4. the Wasm stream host (`registerWasmStreamHost`,
   `extension/lib/wasm-stream-host.js`),
5. the table worker host (`registerTableWorkerHost`,
   `extension/lib/table-worker-host.js`).

The doc is create-on-demand and disposable; the SW reconciles it on wake
(`reconcileAgentWorkers`, `extension/background/routes/agent-worker.js:575`).
It is also a **single point of failure**: Chrome reclaiming it kills every
hosted worker at once (mitigation: durable run authority + reconcile-on-wake;
see docs/AGENT-EXECUTION-ARCHITECTURE.md §7).

### 1.4 Fresh-worker Wasm execution
Every WASI tool call gets ONE fresh dedicated module Worker — never pooled, no
main-thread fallback (`extension/lib/wasm-executor.js:226`; header invariants
lines 1-20, though its "SOURCE ONLY AND UNREACHABLE" banner is stale — it is
the live path, imported by offscreen.js and the Settings preview). Wall
deadline ⇒ `worker.terminate()` + workspace discard; there is no Wasm fuel
counter in browsers, so Worker termination is the CPU kill switch
(docs/tool-platform-architecture.md §"Future execution invariants"). File-backed
stream tools run through `wasm-stream-worker.js`, which holds OPFS
`createSyncAccessHandle`s for stdin/stdout/stderr and hashes all three streams
incrementally (`extension/lib/wasm-stream-worker.js:1-30`), with a 180 s wall
cap (`wasm-stream-host.js:12` `WASM_STREAM_WALL_MS`).

### 1.5 OPFS job workspaces
The SHIPPED stream workspace is `extension/lib/wasm-stream-files.js`: job I/O
lives under `wasm-tool-streams-v1/` as chunked, sealed, opaque capability
references (`input`/`stdout`/`stderr` per job, 32-hex ids), opened inside the
dedicated Worker via sync access handles; promotion marks `authority.json` so
the bounded orphan GC never sweeps a promoted stream
(`extension/lib/tool-stream-platform.js:204`, GC at :288).

A STRICTER workspace authority, `extension/lib/opfs-tool-workspace.js`
(`tool-jobs/<execution>/<call>/` roots, digest-verified `inputs/<sha256>.bin`,
journaled quota reservations with `.quota.current/.next/.anchor` continuity,
marker-before-removal GC), exists and is fully tested but is **not wired into
the shipped path** — `scripts/check-reachability.mjs`'s RETAINED map records
"Only tests/opfs-tool-workspace.test.ts imports it". It is the reviewed
successor design awaiting adoption, not the live mechanism. (An earlier draft
of this section described it as live — wrong; corrected 2026-09-05.)
Path-class rights reduction in the WASI runtime (`inputs/` read-only,
`scratch/` read-write, `output/` write-only) is implemented in
`extension/lib/wasi-preview1-runtime.js`.

### 1.6 Approval and authority fences
- **Run fence** (`extension/lib/run-fence.js`): the SW threads the current
  run's abort signal into every side-effecting tool; `runAborted()` is checked
  at the mutation boundary.
- **Owner approvals** (`extension/lib/owner-approval.js`): bounded
  (`MAX_PENDING_APPROVALS=64`, `APPROVAL_TTL_MS=60_000`), digest-bound canonical
  payloads, deduplicated pending requests, and a closed `DESTRUCTIVE_ACTIONS`
  set (agent.delete, asset.update, fs.write, script.*, hooks.subscribe, …).
- **Untrusted-content fence** (`extension/lib/untrusted-fence.js`): every
  untrusted tool result reaches the model inside a per-assembly random boundary
  token named by a protected dynamic system-prompt layer
  (docs/SYSTEM-PROMPTS.md §5.6).
- **Principal classes** at the message boundary (§2.1) and the run/`executionId`
  fences in §2.3.

## 2. Messaging & shared work

### 2.1 The SW message boundary
One `chrome.runtime.onMessage` listener
(`extension/background/service-worker.js:9463`) classifies every sender into a
principal: `page` (content script — restricted to `PAGE_ALLOWED_ROUTES`, the
8-route WebMCP/detection allowlist at `extension/lib/pure.js:1120-1130`),
`owner-options` (the exact Settings document — the only principal that may
touch credential-privileged provider routes), `extension` (other extension
surfaces), and `model` (the run-bound dispatch path used by `execute_tool`).
The browser-attested sender identity (`sender.tab.id`, `sender.documentId`,
`documentLifecycle`) — never message-body claims — is what page-side handlers
may trust (service-worker.js:9505-9525). `dispatchRoute`
(service-worker.js:4524-4535) strips every `__`-prefixed key and
`userActivation` from bodies before invoking a handler, so a caller can never
smuggle reserved authority fields.

Route handlers live in 13 modules under `extension/background/routes/`
(registry: `routes/index.js`; kv, perm-lease, provider, mcp, scheduler,
fs-grants, agent-workspace, agent-schedule, activity, agent-worker, memory,
auth) merged with fail-closed duplicate detection
(`mergeRouteMaps`, routes/index.js:24-38). The remainder — including
`run-task`, `run.cancel` (service-worker.js:7791, owner/extension principals
only), `run.resume` (:7802), `run.logs` (:7995), `agent.delegate` — are still
inline in service-worker.js. routes/ROUTE_MAP.md documents a subset and is
currently stale (see docs audit finding F-29).

### 2.2 The agent-worker protocol
Per-agent SharedWorkers (hosted by the offscreen doc, §1.3) execute agent loops
outside the SW realm. The SW stays the authority; the worker holds none (no
storage, no credentials, no fetch — tools RPC back). The route surface
(`extension/background/routes/agent-worker.js:238-575`):
`agent-worker.ensure` / `.run` / `.dispatch` (validate + ensure host + post the
run descriptor), `agent-worker.tool` (principal-gated pass-through into the
SW's real executor — the worker's only tool path), `agent-worker.progress` /
`.result` / `.journal-append` (durable progress/terminal/journal commits citing
the SW-issued `executionId`), `agent-worker.steer` (:368, mid-run redirect),
`agent-worker.alive` / `.close`, plus `reconcileAgentWorkers` (:575) on wake.
UI surfaces additionally subscribe to BroadcastChannel `cap:agent:<agentId>`
for connectionless redacted state, and may hold a raw MessagePort to the same
worker (docs/AGENT-WORKER-DURABILITY.md §1-2; the dedicated client module was
removed 2026-09-02 as dead code — docs/AGENT-WORKER-PHASE4.md §1).
The full `handleAlarm → worker` reroute is deliberately not flipped yet;
scheduled runs still execute via the SW `runTask` path
(docs/AGENT-WORKER-PHASE4.md §"What STAYS on the SW path").

### 2.3 Run envelopes: the durable run authority
Every run is admitted under a SW-issued `executionId` (the only authority key;
logical ids like task/thread/schedule are metadata) and journaled in OPFS
(docs/DURABLE-RUN-ARCHITECTURE.md — note its citations are pinned to commit
`dd41258f`; the mechanism described is current):
- **Records**: `run:<executionId>` (phase, bootId, monotonic revision,
  heartbeat), `run-outbox:<executionId>` (terminal/cancellation packet until
  all projections ack), `run-log:<executionId>:<sha256>` (content-addressed
  rows), `run-resume:*` (private chunked dispatch request), `run-payload:*`
  (full terminal bodies), plus the `journal` and `threads` projections.
- **Three fences**: boot fence (heartbeats carry the boot's id), revision CAS
  fence (stale writers lose), UI surface-owner token (delayed DOM writes
  refused after a new surface claims the view).
- **Settlement order** (payload → outbox → settling → journal → thread → CAS
  terminal → retained log → outbox delete) makes terminal projection
  exactly-once by `executionId` — explicitly NOT universal exactly-once side
  effects (tool-replay-safety: read-only auto-resume, idempotent with stable
  per-call keys, mutating/unknown pause for the owner —
  `extension/lib/tool-replay-safety.js`).
- **Retention**: newest 50 executions per thread keep full logs; older ones
  compact to a summary row (never silently dropped); opt-in retain-all via
  Settings. NOTE: the same doc's "8 MiB store / 256 KiB value / 64 MiB tree"
  bounds are stale post-dptw — see §5.3.
- **Reconnect**: `agent-progress` port → subscribe-before-read → one
  `run-snapshot` → drain buffered events with revision > snapshot
  (`extension/lib/durable-runs.js`; docs/DURABLE-RUN-ARCHITECTURE.md
  §"Reconnect").
- **Cancellation**: owner/extension-only `run.cancel` persists a
  `cancel-requested` tombstone, invokes the live aborter, then runs the
  cancellation outbox through the same settlement path
  (service-worker.js:7791-7800 + `cancelExecutionTree`).

### 2.4 Shared work between agents
`extension/lib/agent-board.js` implements a hub-level board: named agents post
jobs and claim others' (`delegate_to_agent`, guarded by
`extension/lib/agent-delegation.js`), making agent→agent delegation a first-
class management tool (`delegate_to_agent` is in the capability table,
`extension/lib/chrome-tool-capabilities.js:205`). Board jobs reaching the model
are fenced as untrusted (docs/CONSTITUTION.md §1).

## 3. Tool calling

### 3.1 The catalog and the lazy protocol
Regardless of catalog size, every run's provider map contains exactly three
tools: `search_tools`, `list_tools`, `execute_tool`
(`extension/lib/lazy-tool-protocol.js:1464/1478/1491`). The model searches a
bounded lexical index (`extension/lib/tool-search.js` over the canonical
descriptors from `extension/lib/tool-catalog.js`), receives an expiring
selection reference bound to run/task/agent/origin/document/generation
identity, and calls `execute_tool` with it. Execution re-validates every fence
(catalog, source, capability, permission, grant, enrollment, document, run,
expiry, replay) before validation, before dispatch, and after dispatch.
A reference permits up to `TOOL_SELECTION_BOUNDS.maxUsesPerSelection` = 64
calls of the same tool within `defaultTtlMs` = 10 min; argument-validation
failures hand the use back (retryable), dispatch failures do too; search
authorizes nothing (docs/tool-platform-architecture.md §"Live bounded lazy
protocol" — mechanism current; that doc's status line and "Wasm catalog-only"
claims are stale, audit finding 17).
Catalog sources (lazy-tool-protocol.js:896-907 summary): builtin, browser,
management, bundled-wasm, webmcp, provider-server, mcp. All 138 browser tools +
50 management tools are rows in `CHROME_TOOL_CAPABILITY_TABLE` (188 rows;
tests/chrome-tool-capabilities.test.ts:67-72).

### 3.2 Pipelines
`run_pipeline` (`extension/lib/tool-pipeline.js`) chains ≤ 8 existing tools
declaratively — `{id, tool, args}` steps, `$ref`+path bindings resolved by pure
lookup, NO eval, tool names fixed at definition time (untrusted data can land
in an arg but never choose the tool), each step dispatched through the run's
normal executor (keeping its approvals, fencing, ledger); a failing step halts
the pipeline fail-closed. Args ≤ 32 KiB. Per-step owner approval for saved
workflows is in flight (bead chrome-agent-platform-3cb6).

### 3.3 Approval machinery
Model-initiated sensitive actions pause on an in-conversation owner card: the
payload is canonicalized and digest-bound, the exact diff/source/hosts are
shown, and denial is sticky (docs/inline-approval-audit.md maps every class).
`browser.destructive-action`, `browser.cookie-value`, `fs-grant.write-file-
approved`, `task.schedule-script` are gated sub-routes the dispatcher binds per
run (service-worker.js:4646-4649). Approval ids never cross into model results
(owner-approval.js header).

### 3.4 Stream contracts
`extension/lib/tool-stream-platform.js` is the shared streaming plane:
inputs arrive inline or as sealed OPFS `inputRef`s (create → append → seal →
validate); outputs land in per-call OPFS files; over-threshold results promote
to durable artifacts via `createAssetKeyed`; chaining passes `output.ref` as
the next step's `inputRef`. Limits: 30 s default / 180 s max timeout, 64 KiB
inline preview ceiling, 32 active streams/run (`STREAM_PLATFORM_LIMITS`,
tool-stream-platform.js:24-30).

### 3.5 The nine Unix tools
Exactly nine streamed Unix tools run with owner-bound OPFS stdin/stdout and
file-backed large results (chainable by opaque reference, never silently
sliced): **base64, wc, sort, uniq, tr, grep, sed, awk, jq**
(packages/bundled/README.md:13-16; admission profile docs/UNIX-TOOLS-ADMISSION.md;
a bead pins the allowlist at nine — chrome-agent-platform-0alg). The 100 MiB
operating point is by *file-backed* input (inputRef), not inline args — inline
args keep the 16 KiB/string, 32 KiB/payload lazy-protocol bounds
(docs/tool-platform-architecture.md; the two docs do not cross-reference this —
audit note).

### 3.6 Table tools
The spreadsheet family (`table_*` via `extension/lib/table-tool-runtime.js:20`
`TABLE_TOOL_NAMES`) runs in a fresh module Worker per job
(`extension/lib/table-worker-host.js`; MV3 SWs cannot construct Workers),
bounded by `TABLE_LIMITS` (`extension/lib/table-core.js:7-19`: 8 MiB input /
16 MiB join input / 8 MiB output, 100k rows, 1M cells, …). Inputs/outputs are
artifact-backed (`createAssetKeyed`/`getAsset`).

## 4. WebMCP

### 4.1 Passive detection
Two content scripts on every http(s) page (manifest.json `content_scripts`,
install-granted `<all_urls>` — owner decision Q18): a MAIN-world detection-only
probe (`extension/content/webmcp-detect-main.js`) snapshots the page's
`navigator.modelContext`-style tool surface, MACs the snapshot with a
per-document HMAC key delivered out-of-band through `chrome.runtime`, and posts
it over the `__cap_webmcp_detect` channel; the ISOLATED-world relay
(`webmcp-detect-relay.js`) verifies the MAC and forwards a TOOL COUNT only to
the SW — descriptions never leave the page before enrollment
(docs/CONSTITUTION.md §1 untrusted-fence bullet). The SW keeps a 100-origin /
24 h LRU capability registry (`extension/lib/webmcp-detection-registry.js`);
zero-tool snapshots remove entries.

### 4.2 Enrollment
One click on the hub chip ("<origin> offers N tools — use them?") requests
`scripting` JIT and enrolls that exact origin (`extension/lib/enrollment.js`:
per-origin content-script registration `ensureOriginScriptsRegistered`:97,
generation-tracked records, teardown `unregisterOriginScripts`:155, boot
reconciliation `:274`). Enrollment IS the owner's consent for the site's tools
as a class — `isApproved(origin, toolName)` derives from the live enrollment
record and its generation (`extension/lib/tools.js:490-493`;
docs/../webmcp-authority.js header: "Consent model: ENROLLMENT IS THE OWNER'S
CONSENT").

### 4.3 Invocation and the authority guard
Calls go `tools.invoke` → `invokeSiteTool` → the exact approved tab/document →
isolated bridge → MAIN-world page function. `extension/lib/webmcp-authority.js`
owns the live-authorization decision: descriptor still in the live directory,
enrollment live, run-generation echo matches, permission/grant digests match —
each denial is self-diagnosing with a named failing conjunct. Bridge identity
is browser-attested (sender tab/document id), never message-claimed (§2.1).
Page-thrown errors keep full detail in the page-local console; only the
redacted error name crosses into the extension/model path (README §"Sites as
sub-agents").

### 4.4 Consent gap (known, open)
A site's tool call runs with NO per-call consent card today — enrollment is the
only consent point. The decision and implementation are open: bead
chrome-agent-platform-eo4d (CAP-FB-20260901-WEBMCP-CALL-CONSENT-01) with a
recommended default in docs/OPEN-QUESTIONS.md Q23 (read tools covered by
enrollment; one card per run for mutating tools).

### 4.5 Fallback paths
Pages without WebMCP: the six page-action tools (`find_elements`,
`click_element`, `type_text`, `select_option`, `scroll_page`, `wait_for` —
owner decision Q19) act via `chrome.scripting` under the per-origin
browser-control grant, selector-free (opaque per-snapshot integer refs re-
resolved in-page via `data-cap-ref`), fenced untrusted results, ledgered
mutations (docs/CONSTITUTION.md §1 page-actions bullet). Site-specific
instructions can ride as origin-bound skills (bead
chrome-agent-platform-iy9n); `extension/lib/site-docs-fallback.js` covers the
site-doc fallback path.

## 5. OPFS

### 5.1 The one-root-per-origin platform constraint — VERIFIED
Paul's recollection is CORRECT: `navigator.storage.getDirectory()` yields
exactly one OPFS root per storage bucket, and a bucket is per-origin — the
extension's `chrome-extension://<id>` origin owns ONE root, shared by every
extension realm (SW, pages, offscreen doc, workers). The code confirms a single
entry point: `rootDir()` calls `navigator.storage.getDirectory()` once per call
and everything multiplexes beneath it (`extension/lib/memory.js:393-395`).
Sandboxes with opaque origins (§1.1) cannot share it — they get no usable
persistent storage at all (script-sandbox teach-guards exist precisely because
storage APIs throw there).

**Consequence (the gymnastics):** "origin-keyed memory" is NOT platform
isolation. Per-site and per-agent stores are *subdirectories of the extension's
single root* — `memory/master/*`, `memory/origins/<encodeURIComponent(origin)>
/*`, `memory/agents/<slug>/*`, `memory/background/<slug>/*`
(memory.js:13-14, 1020-1060) — and the boundary between them is enforced
entirely by extension code: canonicalization (`canonicalOrigin`, memory.js:
252-263, http/https only, injective `encodeURIComponent` encoding), reserved
key sets, and the trusted-write path. A path-resolution bug has no platform
backstop (see the risk register, stage 3).

### 5.2 Store mechanics
Every store is a directory of JSON values with a durable generation authority
(`__gen.json`, restart-safe monotonic write generations), bounded tombstones
(`__tombs.json`, 512 max then floor-folded), a global write mutex
(serializes check-then-write), and reserved internal namespaces
(`thread:`/`run:*`/`asset:`/`wasmPkg`…) that only `setTrusted` may write
(memory.js:711-760). Model writes to authority keys are rejected
(docs/DURABLE-RUN-ARCHITECTURE.md §"Security boundaries").

### 5.3 Quotas — changed under dptw (2026-09-03), docs partly stale
The per-store/per-value/tree byte bounds are **no longer enforced**:
`assertQuota` is a no-op ledger touch ("dptw: no quota gate … the browser's
OPFS quota is the only ceiling", memory.js:691-698); per-value size bounds are
gone (memory.js:162); artifact bodies are unbounded (`ASSET_BOUNDS.
maxContentBytes: Infinity`, `extension/lib/artifacts.js:418-424`, "no-limits
(owner directive 2026-09-03)"). The durable-run doc's "8 MiB store / 256 KiB
value / 64 MiB tree" sentence and OPEN-QUESTIONS Q16's "256 KB artifact limit"
predicate are stale. What remains bounded: run-log compaction (50/thread full
logs, summary compaction beyond), the journal (500 rows), and the native
browser quota, whose refusal surfaces honestly. The tension with
docs/CONSTITUTION.md §4 ("no unbounded growth … all bounded") is recorded for
the risk register.

### 5.4 Promotion and GC
Tool outputs become durable only through artifact promotion
(`createAssetKeyed`, digest-bound keys, byte receipts; §3.4). Stream GC: the
live plane's bounded orphan collection
(`extension/lib/tool-stream-platform.js:288`) sweeps abandoned
`wasm-tool-streams-v1/` jobs and never touches promotion-marked streams. (The
stricter marker-before-removal GC in `opfs-tool-workspace.js` is the
unwired successor — §1.5.) Run-log compaction runs from terminal commits,
never timers (docs/DURABLE-RUN-ARCHITECTURE.md §"OPFS records").

## 6. Wasm

### 6.1 Admission
Packages enter only through the bundled, reviewed lane
(`extension/lib/wasm-package-authority.js`): canonical manifests with exact
key sets at every depth (:233, :264), executable identity = sha256 + size +
imports + memory declaration (:264-292), SPDX licence validation against a
closed id set with exact two-operand composites (:44-54, :320-321), SBOM +
notices, a bounded raw binary scanner (magic/version/LEB framing/section
order, the exact `wasi_snapshot_preview1` import allowlist, exactly one memory
with a declared maximum; memory64/shared/multi-memory rejected — see
docs/tool-platform-architecture.md §"Source-only bundled Wasm package
authority"). Mutable package records use an exact-generation WAL
(`__wasmTx`). Memory tiers at tip: tiny ≤ 512 pages, default ≤ 2048, large ≤
4096 — all `admission:"allowed"`; the per-tier BYTE ceilings are
`Number.POSITIVE_INFINITY` post-dptw
(`wasm-package-authority.js:20-24`; the docs' "large remains blocked" and the
16 MiB tier byte gates are stale).

### 6.2 Execution hosts
Three hosts, all under the offscreen document (§1.3): the fresh-Worker WASI
executor for small/inline jobs (§1.4), the stream host for file-backed jobs
(§1.4/§3.4), and the separate classic-worker Pyodide dispatcher for
`python.execute` (NOT WASI — an Emscripten/JS-glue profile; the WASI import
allowlist is never widened for it; runtime bytes pinned by SHA-256 in
`extension/lib/python-runtime.js:46-51` and hash-verified at build).
The WASI runtime itself (`extension/lib/wasi-preview1-runtime.js`) is a fixed
`wasi_snapshot_preview1` implementation: bounded argv, empty environment,
fd 0/1/2 + preopen `.` + `/job` alias, path-class rights reduction, 64 KiB
random, monotonic clock, realtime explicitly `ENOTSUP`, typed `proc_exit`;
every syscall checks cancellation and host-call quota
(docs/tool-platform-architecture.md §"Pure source WASI Preview 1
execution-host contract").

### 6.3 Store policy
Chrome Web Store lane: bundled-reviewed executables ONLY — downloaded or
uploaded Wasm is treated as remotely hosted code unless written policy says
otherwise (owner decision Q13 still open; recommended default: keep bundled-
only). Owner-selected packages are an unpacked/developer lane, blocked on the
policy decision (docs/tool-platform-architecture.md §"Distribution lanes";
docs/OPEN-QUESTIONS.md Q13). The store build target statically rejects
unmanifested `.wasm` and non-literal Worker constructors (README §"Load +
run"). Today's shipped set: 31 admitted single-tool packages
(packages/bundled/README.md).

## 7. MCP discovery & capacity/messaging

### 7.1 What MCP is here
Remote MCP servers (Streamable HTTP + SSE only — MV3 cannot spawn stdio
subprocesses; agent-do's stdio path is deliberately never imported) mounted by
CAP's own per-server-resilient loop, NOT agent-do's all-or-nothing
`mountMcpServers` (docs/MCP-SUPPORT-DESIGN.md §"Transport spike result";
`extension/lib/mcp-client-core.js` — SDK-free, unit-testable core;
`extension/lib/mcp-client.js` — the SDK-bound transports).

### 7.2 Configuration and discovery
Servers are configured globally (Settings → MCP servers) and per named agent
(inherit + add/disable), stored in `chrome.storage.local` under
`cap:mcpServers` with bearer tokens handled like provider keys — the
`mcp.servers.get`/`set` routes return REDACTED views
(`extension/background/routes/mcp.js:34-70`; config model
`extension/lib/mcp-config.js`: id regex rejects `__`, transports `http|sse`).
Discovery is per-run: at run start the SW resolves the effective set
(global ∪ agent − disabled), connects each server independently (one
unreachable server is a diagnostic, never fatal), lists its tools, namespaces
them `mcp__<server>__<tool>`, and folds them into the lazy catalog as source
kind `mcp` — so MCP tools are found through the same `search_tools` →
`execute_tool` path as everything else, never eagerly in the prompt
(`extension/lib/mcp-run-tools.js`; service-worker.js run assembly ~:1455-1470).

### 7.3 Messaging and capacity
- **Per-server first-use owner approval**: one Allow card per server per run
  (`mcp.use-server`), mirroring the WebMCP posture; results are fenced
  untrusted; calls are ledgered as external side effects of unknown replay
  class (never auto-resumed) (mcp-run-tools.js header §1-3).
- **Teardown per run**: connections close in `runTask`'s `finally`
  (`orch.closeMcp`) — no long-lived SSE across runs (MV3 ephemerality,
  docs/MCP-SUPPORT-DESIGN.md constraint 5).
- **Capacity**: MCP tools inherit the lazy protocol's bounds — constant
  provider-side definition size regardless of server/tool count (§3.1),
  16 KiB/string and 32 KiB/payload argument bounds, selection-ref TTL/usage
  caps. The catalog summary to the model counts the `mcp` source alongside the
  others (lazy-tool-protocol.js:896-907). There is no separate cap on servers
  per agent in the config model (mcp-config.js normalizes/dedups; no count
  bound found — noted for the risk register).

## 8. Cross-cutting authorities (one-line index)

| Concern | Authority | Location |
|---|---|---|
| System prompts | layered composition + attestation | `extension/lib/system-prompts.js`, `runtime-policy.js`; docs/SYSTEM-PROMPTS.md |
| Provider credentials | SW-only, redacted routes | `extension/lib/provider.js`, `background/routes/provider.js` |
| Activity ledger | mutating-action rows + undo | `extension/lib/action-ledger.js` |
| Run replay safety | read-only/idempotent/mutating/unknown | `extension/lib/tool-replay-safety.js` |
| Usage/cost | per-call records, llm-prices table | `extension/lib/usage*.js`, `model-prices.js` |
| Skills | data-only, untrusted-fenced imported bodies | `extension/lib/skills.js`, `skill-*.js`; docs/SYSTEM-PROMPTS.md §5 |
| Hooks | owner deny-list first, permission-gated | `extension/lib/hooks.js`; docs/HOOKS.md |
| Local folders | owner grants + approval-bound writes | `extension/lib/fs-grants.js`, `background/routes/fs-grants.js` |

## 9. Notes and caveats found while writing this

1. `extension/offscreen/offscreen.js:16-21` registers the identical
   script-run listener TWICE at tip. If `handleScriptRunMessage` does not
   dedupe, every script message is handled twice. Needs a code owner look
   (risk register candidate; cleanup bead material).
2. `extension/lib/wasm-executor.js:1-2` header still declares "SOURCE ONLY AND
   UNREACHABLE" — it is the live execution path. Comment drift; same class as
   python-tool.js:9-10 ("fails closed until admitted" — it is admitted).
3. dptw (2026-09-03) removed byte ceilings across memory/artifacts/Wasm tiers;
   docs citing the old bounds: DURABLE-RUN-ARCHITECTURE.md (8 MiB/256 KiB/64
   MiB), OPEN-QUESTIONS.md Q16 (256 KB), tool-platform-architecture.md (tier
   byte gates, "large blocked"). See docs audit addendum.
4. docs/DURABLE-RUN-ARCHITECTURE.md citations are pinned to commit `dd41258f`;
   its mechanisms match the current tree but its line numbers should not be
   followed at tip without re-derivation.
5. This document cites `origin/main@14e2a817`. It will drift; the fix is the
   same discipline as check:vocabulary — where possible, prefer claims guarded
   by tests (e.g. tool counts in tests/chrome-tool-capabilities.test.ts).

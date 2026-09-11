# Architecture Risk Register — Chrome Agent Platform

**Bead:** chrome-agent-platform-t4td (umbrella 9zw7; successor to afbb) · **Date:** 2026-09-11 ·  
**Tree:** `origin/main@ba9f45d1` (v0.3.364).

Every risk entry records the strict four-field shape required by architecture governance:
- **Risk:** what the hazard is and what fails when it triggers
- **Lives at:** exact code location `file:line`
- **Mitigation:** current mechanical or procedural controls
- **Open question:** remaining architectural question or platform primitive needed

Ordered by architectural class; severity is marked H/M/L (likelihood $\times$ blast radius).

---

## Class 1 — Isolation Boundaries with No Platform Backstop

### R1 (H). Origin-keyed isolation is directory multiplexing inside ONE OPFS root
- **Risk:** The Chromium platform grants the extension origin exactly one OPFS root (`navigator.storage.getDirectory()`). Per-site sub-agents, named agents, background agents, and user artifacts are separated into subdirectories (`memory/origins/<encoded>`, `memory/agents/<slug>`, `agent-workspaces/<slug>`) strictly through application-level path resolution in JavaScript. A single path-traversal or encoding flaw collapses cross-origin isolation, allowing one site's agent or task to read another origin's memory.
- **Lives at:** `extension/lib/memory.js:252` (`canonicalOrigin`), `extension/lib/memory.js:393` (`rootDir()`), `extension/lib/memory.js:711` (reserved namespaces), `extension/lib/opfs-tool-workspace.js:35` (workspace directory mapping).
- **Mitigation:** Injective reversible encoding of origin strings; rejection of non-http(s) schemes; internal key reservation fences (`cap:*`); automated clear-isolation tests in `tests/memory-isolation.test.ts`.
- **Open question:** Within the extension, would the Chromium Storage Buckets API (`navigator.storageBuckets.open(...)`) provide true kernel-level per-agent isolation buckets rather than software directory multiplexing?

### R2 (H). The script sandbox runs agent-authored JS with `new Function`
- **Risk:** The single explicit `eval` exemption in the extension bundle resides in the manifest sandbox (`extension/sandbox/script-sandbox.js:97`). While isolated within an opaque origin (`null`), the script sandbox accepts agent-generated code and runs it via `new Function`. The primary escape surface is the `postMessage` RPC bridge and the host-brokered `fetch` proxy—any parser confusion or policy bypass in the fetch broker constitutes an SSRF and local network exfiltration vector.
- **Lives at:** `extension/sandbox/script-sandbox.js:97` (`fn = new Function(...)`), `extension/sandbox/script-sandbox.js:23-40` (storage teach-guards), `extension/lib/fetch-policy.js:30-80` (brokered fetch policy).
- **Mitigation:** Opaque sandbox origin with zero access to `chrome.*` APIs and zero access to extension storage/OPFS; brokered fetch policy strips credentials (`credentials: "omit"`), forbids HTTP redirects, and strictly blocks loopback/private/link-local IP addresses (`127.0.0.1`, `10.0.0.0/8`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`); owner must approve exact script source before initial execution (`script.run`).
- **Open question:** When the offscreen document is absent, the trusted hub document acts as an alternate iframe host for `script-sandbox.html`. Does hosting the sandbox iframe inside the trusted hub document create an unacceptable blast radius if an iframe boundary escape occurs?

### R3 (M). WebMCP bridge: the extension is globally fingerprintable on every page (f62c)
- **Risk:** Two content scripts are injected at `document_start` on every HTTP/HTTPS web page under the broad `<all_urls>` match pattern. A probe injected into the MAIN world sets `window.__cap_webmcp_detect`. Consequently, any website visited by the user can inspect the DOM or window object to definitively fingerprint the presence of the Chrome Agent Platform extension (tracked in open bead `chrome-agent-platform-f62c`).
- **Lives at:** `extension/content/webmcp-detect-main.js:1-60` (MAIN-world detection probe), `extension/content/webmcp-detect-relay.js:1-70` (ISOLATED-world relay), `extension/manifest.json:55-75` (`content_scripts`).
- **Mitigation:** The detection channel uses per-document HMAC key exchanges so untrusted web pages cannot forge capability snapshots with foreign keys; snapshots transport tool counts only, and actual tool enrollment requires explicit owner gesture.
- **Open question:** Is passive, zero-click tool detection across all websites worth exposing a universal browser fingerprint, or should WebMCP discovery migrate to on-demand activation via `activeTab`?

### R4 (M). Untrusted-content fencing is a prompt-level boundary
- **Risk:** The `<<<UNTRUSTED run:<token>>>>` fencing mechanism isolates untrusted web page content by instructing the model to treat the enclosed text strictly as data. However, prompt-level fencing relies entirely on LLM adherence; a sufficiently adversarial page injection can cause a susceptible model to disregard the fence and request destructive actions.
- **Lives at:** `extension/lib/untrusted-fence.js:15-40` (`wrapUntrustedContent`), `docs/SYSTEM-PROMPTS.md` (runtime policy injection).
- **Mitigation:** Per-run cryptographically random fence tokens (preventing token prediction from page content); destructive model actions require secondary owner confirmation cards; automated journey tests inject adversarial instructions to verify fence robustness.
- **Open question:** What browser platform primitives could enforce hard data/code separation at the model boundary rather than relying on prompt-level framing?

---

## Class 2 — Authority Boundaries & Dispatch Governance

### R5 (H). Removal of byte ceilings (`dptw`) conflicts with constitutional bounded growth
- **Risk:** Following owner directive `dptw`, artificial byte bounds were removed across storage, memory, and artifacts (`assertQuota` became a no-op at `memory.js:691`, `maxContentBytes` was set to `Infinity` at `artifacts.js:422`). However, `docs/CONSTITUTION.md §4` continues to demand bounded storage growth. Because no application-level byte ceiling remains, an agent in an infinite or runaway loop can allocate storage until Chromium's native OPFS quota throws `QuotaExceededError` mid-execution.
- **Lives at:** `extension/lib/memory.js:691-698` (`assertQuota`), `extension/lib/artifacts.js:422` (`maxContentBytes: Infinity`), `extension/lib/wasm-package-authority.js:20-24`.
- **Mitigation:** Native `QuotaExceededError` is surfaced honestly to run logs; thread log retention compacts after 50 executions; emergency `system.factoryReset` route exists.
- **Open question:** Should the constitution be formally amended to reflect native OPFS quota as the sole ceiling, or should a coarse safety bound (e.g. 5 GiB) be restored to halt runaway agents before browser quota exhaustion?

### R6 (M). Run fence is a module-level singleton, safe only under strict serialization
- **Risk:** `extension/lib/run-fence.js` maintains execution fences via a module-level singleton (`currentFenceToken`). This mechanism relies completely on runs being strictly serialized via `withRunLock`. If any future code path dispatches concurrent tasks within the Service Worker realm, abort signals and mutation fences will cross-wire, causing run A to invalidate or corrupt run B's mutations.
- **Lives at:** `extension/lib/run-fence.js:10-30` (`currentFenceToken`), `extension/background/service-worker.js:8200` (`withRunLock` in `runTask`).
- **Mitigation:** `withRunLock` serializes interactive and delegated task execution; background workers run in separate SharedWorker contexts.
- **Open question:** As agent worker offloading expands, should run fence tokens be explicitly threaded through execution context objects rather than stored in module-global singletons?

### R7 (M). Owner approval machinery: 60 s TTL and queue limits
- **Risk:** Owner approval cards expire after `APPROVAL_TTL_MS = 60_000` (`owner-approval.js:15-16`) and the in-memory pending queue is capped at 64 requests. An agent run that triggers an approval card while the user is away from their keyboard aborts after 60 seconds with an expiration failure.
- **Lives at:** `extension/lib/owner-approval.js:15-16` (`APPROVAL_TTL_MS = 60_000`, `MAX_PENDING = 64`).
- **Mitigation:** Bounded and deduplicated pending requests; rejection is sticky; in-flight permission waiters are queued cleanly (fixed in `chrome-agent-platform-m6id`).
- **Open question:** Should approval TTLs pause when no extension UI document (NTP or Side Panel) is visible to the owner?

### R8 (M). Drift between Service Worker and SharedWorker execution paths
- **Risk:** The background agent migration is partially complete: interactive runs and alarm routines still run inside the Service Worker (`runTask`), while offscreen sub-agents run in `SharedWorker` contexts (`agent-worker.js`). Features added to one execution engine do not automatically exist in the other, creating subtle behavioral divergence.
- **Lives at:** `extension/background/routes/agent-worker.js:243` (`agent-worker.run`) vs `extension/background/service-worker.js:8200` (`runTask`).
- **Mitigation:** Shared tool execution bridge: `agent-worker.tool` proxies tool execution back through the Service Worker dispatcher, ensuring identical grant and redaction gates.
- **Open question:** When will alarm and scheduled routines be migrated to SharedWorkers to retire the legacy SW execution path?

### R9 (M). WebMCP calls execute with enrollment-only consent
- **Risk:** Tool enrollment is currently treated as global consent for an origin. Once a user approves site enrollment, an agent can invoke any enrolled tool on that origin without an in-conversation confirmation card, even if the tool mutates site data.
- **Lives at:** `extension/lib/webmcp-authority.js:13-17` ("ENROLLMENT IS THE OWNER'S CONSENT"), `extension/lib/tools.js:490-493` (`isApproved`).
- **Mitigation:** Enrollment is origin-bound and requires explicit owner gesture; tool execution results are fenced as untrusted data; every call is recorded in the action ledger.
- **Open question:** Should site tools declaring mutating side-effects pay an in-conversation approval card per run?

### R10 (L). MCP: unbounded server connections and tool argument exfiltration
- **Risk:** `extension/lib/mcp-config.js` normalizes MCP server lists but enforces no upper bound on server count. A configuration with numerous slow or unresponsive MCP endpoints degrades run startup latency. Furthermore, once an MCP server is approved for a run, the model can transmit arbitrary task parameters to the external server.
- **Lives at:** `extension/lib/mcp-config.js:20-60`, `extension/lib/mcp-client-core.js:40-100`.
- **Mitigation:** First-use per-server approval cards; MCP tool outputs are fenced as untrusted data; all calls are recorded in the action ledger.
- **Open question:** Should MCP server registrations be capped per agent, and should outbound MCP tool arguments display an owner preview before transmission?

### R11 (H). Unclassified Service Worker dispatch mutations (ygvt)
- **Risk:** As established in the dispatch authority census (`docs/SW-DISPATCH-AUTHORITY-CENSUS.md`), 31 message routes perform persistent state mutations without route-local principal checks (`isOwnerPrincipal`) or owner-approval gates (`requireOwnerApproval`). For instance, `named-agent.set-tools` (`service-worker.js:7101`) mutates agent tool configurations and `recipe.delete` (`service-worker.js:9534`) deletes custom recipes without verifying the caller principal.
- **Lives at:** `extension/background/service-worker.js:7101` (`named-agent.set-tools`), `extension/background/service-worker.js:9534` (`recipe.delete`), and 29 additional mutation routes documented in `docs/SW-DISPATCH-AUTHORITY-CENSUS.md`.
- **Mitigation:** Central message listener blocks content scripts (`PAGE_ALLOWED_ROUTES`), ensuring external pages cannot invoke these routes.
- **Open question:** Should all 31 unclassified mutation routes be retrofitted to require `isOwnerPrincipal(context)` or explicit `requireOwnerApproval` gates to ensure non-owner extension contexts cannot trigger unprompted mutations?

---

## Class 3 — Platform Constraints & Standing Fragilities

### R12 (H). The offscreen document is a single point of failure for five subsystems
- **Risk:** Because MV3 Service Workers lack DOM access and worker constructors, exactly one offscreen document (`extension/offscreen/offscreen.html`) multiplexes five independent subsystems: the script-sandbox host, Pyodide Python worker, Wasm stream worker, table worker, and SharedWorker proxy. If Chromium reclaims this single offscreen document due to memory pressure or lifecycle limits, all five subsystems terminate simultaneously.
- **Lives at:** `extension/offscreen/offscreen.js:16-50`, `extension/background/service-worker.js:355-367` (`ensureOffscreen`).
- **Mitigation:** Disposable-by-design worker model; automatic offscreen re-creation on demand; durable run state persisted in OPFS so interrupted runs can recover.
- **Open question:** Can Chromium grant extension service workers the capability to spawn dedicated background workers directly, eliminating the fragile offscreen multiplexer?

### R13 (M). MV3 Service Worker lifecycle ephemerality vs long-running tasks
- **Risk:** Chromium aggressively terminates extension Service Workers after 30 seconds of idle time or under system memory pressure. When the Service Worker is terminated, all volatile execution state (in-memory locks, stream readers, active promises) is destroyed. When a mutating tool call is interrupted mid-flight by SW termination, the recovery sweep on next boot cannot determine if the external mutation completed; it pauses the execution, forcing the user to manually intervene.
- **Lives at:** `extension/lib/durable-runs.js:1-100` (WAL outbox and recovery), `extension/background/service-worker.js:10740` (`resumeInterruptedRuns`).
- **Mitigation:** Outbox settlement pattern; write-ahead logging (WAL) of run steps; automatic 15-second alarm pings to extend worker lifetime during active runs.
- **Open question:** When will the web platform support durable background worker threads for agent extensions without reliance on artificial keep-alive pings?

### R14 (M). Worker constructors unavailable in ServiceWorkerGlobalScope
- **Risk:** The web platform forbids `new Worker()` and `new SharedWorker()` inside `ServiceWorkerGlobalScope`. This fundamental platform limitation forces all background compute to proxy asynchronously through the offscreen document (R12), introducing IPC latency, serialization overhead, and cross-thread failure modes.
- **Lives at:** `extension/lib/wasm-executor.js:226`, `extension/lib/agent-worker-host.js:60`, `extension/offscreen/offscreen.js:16-40`.
- **Mitigation:** Centralized proxying via `offscreen.js` and `agent-worker.js`.
- **Open question:** Standardization proposal for Service Worker worker instantiation.

### R15 (M). Wasm execution lacks CPU fuel counters; JS heap in worker is uncapped
- **Risk:** WebAssembly instances in Chromium have no native instruction/fuel counter. Furthermore, while Wasm linear memory can be bounded at instantiation, the surrounding JavaScript/Emscripten glue code in the worker shares the general V8 heap. A pathological or infinite-loop module can exhaust worker memory or spin the CPU, which can only be recovered by wall-clock termination (`WASM_STREAM_WALL_MS = 180_000`) and killing the worker process.
- **Lives at:** `extension/lib/wasm-executor.js:226`, `extension/lib/wasm-stream-host.js:12`, `extension/lib/tool-stream-platform.js:24-30`.
- **Mitigation:** 180-second wall-clock execution limits with `SIGKILL` termination; fresh worker instances spawned per job; memory limits validated during module admission.
- **Open question:** WebAssembly fuel metering primitives in V8.

### R16 (L). Broad `<all_urls>` host permissions create Store review exposure
- **Risk:** The extension requests `host_permissions: ["<all_urls>"]` and injects content scripts across all web pages. While necessary for zero-configuration WebMCP discovery across the web, this triggers maximum Chrome Web Store review scrutiny and displays the prominent "Read and change all your data on all websites" install warning.
- **Lives at:** `extension/manifest.json:20-25` (`host_permissions`).
- **Mitigation:** Mutations and network fetches require secondary user grants; sensitive provider keys are isolated from content scripts; privacy statement published in `docs/PRIVACY.md`.
- **Open question:** Could activeTab-based just-in-time permissions replace `<all_urls>` without breaking the core premise of ambient site sub-agent discovery?

### R17 (L). Opaque-origin sandbox storage throws SecurityError by design
- **Risk:** Sandboxed iframe scripts attempting to access `localStorage`, `IndexedDB`, or `navigator.storage` immediately throw `SecurityError` due to their `null` opaque origin. While intentional, naive agent-generated code frequently attempts storage calls and fails.
- **Lives at:** `extension/sandbox/script-sandbox.js:23-40`.
- **Mitigation:** Explicit teach-guards intercept storage property accesses and post instructive error events explaining that sandboxed scripts must pass state through function return values.
- **Open question:** None.

---

## Class 4 — Performance Ceilings & Operational Limits

### R18 (H). Service Worker bundle budget ceiling with near-zero slack
- **Risk:** The Chrome Web Store build strictly enforces `STORE_SW_BUDGET_BYTES = 3_000_000` (3.0 MB minified). As of version `0.3.364`, the built store bundle measures **2,999,909 bytes**, leaving exactly **91 bytes of headroom**. Multiple recent commits (`n0sh`, `repair-main`) came within bytes of breaking the build, necessitating string abbreviations. Any new feature, dependency, or error message added to `service-worker.js` will cause the store build to fail unless equivalent bytes are refactored out.
- **Lives at:** `build.mjs:547-563` (`assertBundleBudget`), `scripts/bundle-budget.mjs:16` (`STORE_SW_BUDGET_BYTES = 3_000_000`), `tests/bundle-budget.test.ts:25-35`.
- **Mitigation:** Mandatory build-time budget assertion; top-contributor metafile reporting; ongoing route modularization (`routes/`) to extract logic into separate modules.
- **Open question:** The Service Worker bundle cannot sustain any further feature additions without major refactoring: which existing subsystems (such as Pyodide setup, legacy catalog generators, or inline handlers) should be moved to the Options or offscreen bundles?

### R19 (M). Monolithic data archive 512 MiB / 100k file caps & IPC buffering (2g90)
- **Risk:** The existing "Export All" and "Import All" features buffer the entire OPFS file tree into in-memory base64 JSON strings transmitted over `chrome.runtime.sendMessage`. Profiles exceeding Chrome's ~64 MiB IPC buffer limit fail immediately, and large profiles risk V8 string allocation errors. Furthermore, `data-archive.js` enforces arbitrary caps of 512 MiB and 100,000 files, preventing backups of large user profiles.
- **Lives at:** `extension/lib/data-archive.js:104-105` (`MAX_ARCHIVE_OPFS_FILES = 100_000`, `MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024`), `extension/background/service-worker.js:7651`, `extension/options/options.js:3184`.
- **Mitigation:** Typed refusal errors (`archive-too-large`); comprehensive architecture designed in `docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md` to transition backup/restore to client-side streaming TAR via the File System Access API.
- **Open question:** Implementation roadmap for the 5-stage streaming backup project (bead `chrome-agent-platform-2g90`).

### R20 (L). Catalog rebuild per tool search
- **Risk:** `search_tools` dynamically rebuilds the live capability catalog on every invocation to ensure freshness across enrolled origins and MCP servers. The catalog assembly caps origin inspection at 200 origins (`listOrigins().slice(0, 200)`). A user with more than 200 enrolled origins experiences silent truncation of search results.
- **Lives at:** `extension/background/service-worker.js:3934` (`listOrigins().slice(0, 200)`).
- **Mitigation:** In-memory caching of provider definitions; 200-origin bound prevents catastrophic search latency.
- **Open question:** Should the UI surface a notification when the enrolled origin count exceeds the 200-origin search threshold?

### R21 (L). SharedWorker discovery relies on name conventions
- **Risk:** Chromium provides no enumeration API for active `SharedWorker` instances. SharedWorker liveness is tracked purely by naming conventions (`agent-worker:<id>`) and Service Worker port bookkeeping. If a Service Worker restart drops port references, an orphaned SharedWorker may linger in memory until tab closure.
- **Lives at:** `extension/background/routes/agent-worker.js:575` (`reconcileAgentWorkers`), `extension/lib/agent-worker-host.js:60`.
- **Mitigation:** Persistent active worker registry in `cap:agent-workers:alive` synchronized on worker boot; explicit `agent-worker.close` route.
- **Open question:** Native SharedWorker lifecycle inspection APIs in Chromium.

# Architecture Risk Register — Chrome Agent Platform

**Bead:** chrome-agent-platform-t4td (umbrella 9zw7; successor to afbb) · **Date:** 2026-09-11 ·  
**Tree:** `origin/main@ba9f45d1` (v0.3.364) for R1–R21; entries added later carry their own pin.  
**Threat model:** [`THREAT_MODEL.md`](../THREAT_MODEL.md) — an audit reads THAT first for
what is trusted and what is hostile, and reads this register for what has already been
decided. Class 5 holds the adjudicated-and-withheld decisions: an automated scan that
re-reports one of them is re-reporting a decision, not finding a defect.

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
- **Lives at:** `extension/lib/run-fence.js:10-30` (`currentFenceToken`); `extension/background/service-worker.js#withRunLock` (the lock declaration) and `extension/background/service-worker.js#runTask` (the run entry point). The anchors establish both declarations, not that every invocation remains locked.
- **Mitigation:** `withRunLock` serializes interactive and delegated task execution; background workers run in separate SharedWorker contexts.
- **Open question:** As agent worker offloading expands, should run fence tokens be explicitly threaded through execution context objects rather than stored in module-global singletons?

### R7 (M). Owner approval machinery: 60 s TTL and queue limits
- **Risk:** Owner approval cards expire after `APPROVAL_TTL_MS = 60_000` (`owner-approval.js:15-16`) and the in-memory pending queue is capped at 64 requests. An agent run that triggers an approval card while the user is away from their keyboard aborts after 60 seconds with an expiration failure.
- **Lives at:** `extension/lib/owner-approval.js:15-16` (`APPROVAL_TTL_MS = 60_000`, `MAX_PENDING = 64`).
- **Mitigation:** Bounded and deduplicated pending requests; rejection is sticky; in-flight permission waiters are queued cleanly (fixed in `chrome-agent-platform-m6id`).
- **Open question:** Should approval TTLs pause when no extension UI document (NTP or Side Panel) is visible to the owner?

### R8 (M). Drift between Service Worker and SharedWorker execution paths
- **Risk:** The background agent migration is partially complete: interactive runs and alarm routines still run inside the Service Worker (`runTask`), while offscreen sub-agents run in `SharedWorker` contexts (`agent-worker.js`). Features added to one execution engine do not automatically exist in the other, creating subtle behavioral divergence.
- **Lives at:** `extension/background/routes/agent-worker.js:243` (`agent-worker.run`) vs `extension/background/service-worker.js#runTask` (the SW run entry point).
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
- **Risk:** The executable dispatch census (`docs/SW-DISPATCH-AUTHORITY-CENSUS.md` §4.9) lists 37 unclassified mutation routes without route-local principal checks (`isOwnerPrincipal`) or owner-approval gates (`requireOwnerApproval`). For example, `named-agent.set-tools` mutates agent tool configurations and `asset.export-to-folder` writes an asset to a granted folder. Unclassified does not alone establish exploitability; the central listener still filters page callers.
- **Lives at:** `extension/background/service-worker.js#named-agent.set-tools` (approximate source-line locator `extension/background/service-worker.js:8426`; the symbol, not this moving number, is authoritative), `extension/background/service-worker.js#asset.export-to-folder`, and the other 35 routes in §4.9. `background-agent.delete` (`extension/background/service-worker.js#background-agent.delete`) is now owner-direct approval-gated (§4.3), not part of these 37.
- **Mitigation:** Central message listener blocks content scripts (`PAGE_ALLOWED_ROUTES`), ensuring external pages cannot invoke these routes.
- **Open question:** Should all 37 unclassified mutation routes be retrofitted to require `isOwnerPrincipal(context)` or explicit `requireOwnerApproval` gates to ensure non-owner extension contexts cannot trigger unprompted mutations?

---

## Class 3 — Platform Constraints & Standing Fragilities

### R12 (H). The offscreen document is a single point of failure for its execution and runtime lanes
- **Risk:** MV3 Service Workers cannot create DOM or dedicated workers. The single offscreen document (`extension/offscreen/offscreen.html`) registers the host lanes plus script-sandbox and clipboard listeners enumerated in the authoritative **“Offscreen host inventory”** table in `THREAT_MODEL.md` §1 (per-lane executable operation and sender/asset trust boundary); do not maintain a second count or list here. Reclaiming this document can interrupt in-flight work and ports across those lanes together; later re-creation does not retroactively settle a job whose result or external side effect was interrupted. SVG rasterise and on-device text are runtime lanes, not Wasm execution. The NTP can host the on-demand script sandbox separately; it is not a replacement for every offscreen host.
- **Lives at:** `extension/offscreen/offscreen.js:21-89` (`registerAcpModelHost` through `registerOnDeviceTextHost`, `handleScriptRunMessage`, and `cap:clipboard-write`); `ensureOffscreen` at `extension/background/service-worker.js#ensureOffscreen`. Inventory re-read at `origin/main@28c7189d` (v0.3.593), not inferred from the incomplete onMessage-only census §6.2.
- **Mitigation:** Disposable-by-design worker model; automatic offscreen re-creation on demand; durable run state in OPFS supports reconciliation of interrupted runs. Each lane's sender/asset controls are specified alongside its operation in the `THREAT_MODEL.md` §1 table (`extension/lib/pure.js:959` for the common SW predicate; `extension/lib/acp-model-host.js:5-13` for the ACP port; `extension/lib/emscripten-host.js:110`, `:168` for exact job keys and asset hashes). These controls reduce authority confusion but do not remove the shared lifecycle blast radius.
- **Open question:** Can Chromium grant extension service workers dedicated background workers directly, eliminating the fragile offscreen multiplexer? A new `register*Host()` must update this inventory and the threat-model INV-15 guard; the present onMessage sender guard does not ensure inventory completeness.

### R13 (M). MV3 Service Worker lifecycle ephemerality vs long-running tasks
- **Risk:** Chromium aggressively terminates extension Service Workers after 30 seconds of idle time or under system memory pressure. When the Service Worker is terminated, all volatile execution state (in-memory locks, stream readers, active promises) is destroyed. When a mutating tool call is interrupted mid-flight by SW termination, the recovery sweep on next boot cannot determine if the external mutation completed; it pauses the execution, forcing the user to manually intervene.
- **Lives at:** `extension/lib/durable-runs.js:1-100` (WAL outbox and recovery), `extension/background/service-worker.js#resumeInterruptedRuns` (the recovery entry point).
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
- **Lives at:** `extension/manifest.json:124-126` (`host_permissions`) and `extension/manifest.json:127-152` (the two content scripts). (Corrected 2026-10-06, chrome-agent-platform-oa3o: the previous `:20-25` was stale against the current manifest.)
- **Mitigation:** Mutations and network fetches require secondary user grants; sensitive provider keys are isolated from content scripts; the privacy statement is published in the extension's OWN privacy page — `extension/privacy/privacy.html`, rendered from `extension/lib/privacy-statement.js` and pinned to the live code by `tests/privacy-statement.test.ts` (a new outbound host or storage class fails that test before it can go missing from the page). (Corrected 2026-10-06, chrome-agent-platform-oa3o: this entry cited a `docs/PRIVACY.md` that has never existed in this repository. The page is bundled, not a markdown document, so the honest fix is the corrected citation rather than a new document — see the entry's `Open question`.)
- **Note on the Store half:** question Q11 was resolved on 2026-09-18 (no Store release; distribution is the unpacked developer demo), so the "Store review scrutiny" driver has no consumer today. The install-warning and fingerprint halves stand.
- **Open question:** Could activeTab-based just-in-time permissions replace `<all_urls>` without breaking the core premise of ambient site sub-agent discovery? (Separately: should a repo-level `PRIVACY.md` exist at all, given the product's privacy statement is rendered from code — writing one would create a second source of truth that `tests/privacy-statement.test.ts` cannot pin.)

### R17 (L). Opaque-origin sandbox storage throws SecurityError by design
- **Risk:** Sandboxed iframe scripts attempting to access `localStorage`, `IndexedDB`, or `navigator.storage` immediately throw `SecurityError` due to their `null` opaque origin. While intentional, naive agent-generated code frequently attempts storage calls and fails.
- **Lives at:** `extension/sandbox/script-sandbox.js:23-40`.
- **Mitigation:** Explicit teach-guards intercept storage property accesses and post instructive error events explaining that sandboxed scripts must pass state through function return values.
- **Open question:** None.

---

## Class 4 — Performance Ceilings & Operational Limits

### R18 (M). Service Worker bundle size watched at near-zero slack (reported, not enforced)
- **Risk:** The Chrome Web Store build MEASURES the service-worker bundle against `STORE_SW_BUDGET_BYTES = 3_000_000` (3.0 MB minified; the 2026-10-01 audit measured 2.54 MB, though periods of near-zero headroom — 91 bytes at `0.3.364` — have recurred). Since the owner decision of 2026-10-05 ("The limits make no sense anymore") an over-reference bundle no longer FAILS the build: the size is printed with its top contributors and recorded in `dist.complete`. The operational risk is now UNSEEN growth — bloat ships unless someone reads the report — and the build still fails closed on the dependency-integrity invariants (duplicated instances, lockfile drift).
- **Lives at:** `build.mjs` (`assertBundleBudget` + `bundleBudgetReport`), `scripts/bundle-budget.mjs:16` (`STORE_SW_BUDGET_BYTES = 3_000_000`), `tests/bundle-budget.test.ts` (report-only against `dist.complete`).
- **Mitigation:** Build-time size REPORT with top-contributor metafile breakdown; `dist.complete` records every bundle's size + sha256; the suite prints each bundle against its reference; ongoing route modularization (`routes/`) to extract logic into separate modules.
- **Open question:** With sizes reported rather than enforced, what review step (if any) should treat a sustained over-reference bundle as a finding rather than noise?

### R19 (M). Monolithic data archive 512 MiB / 100k file caps & IPC buffering (2g90)
- **Risk:** The existing "Export All" and "Import All" features buffer the entire OPFS file tree into in-memory base64 JSON strings transmitted over `chrome.runtime.sendMessage`. Profiles exceeding Chrome's ~64 MiB IPC buffer limit fail immediately, and large profiles risk V8 string allocation errors. Furthermore, `data-archive.js` enforces arbitrary caps of 512 MiB and 100,000 files, preventing backups of large user profiles.
- **Lives at:** `extension/lib/data-archive.js:104-105` (`MAX_ARCHIVE_OPFS_FILES = 100_000`, `MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024`), `extension/background/service-worker.js#owner.import.all` (the buffered import route), `extension/options/options.js:3184`.
- **Mitigation:** Typed refusal errors (`archive-too-large`); comprehensive architecture designed in `docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md` to transition backup/restore to client-side streaming TAR via the File System Access API.
- **Open question:** Implementation roadmap for the 5-stage streaming backup project (bead `chrome-agent-platform-2g90`).

### R20 (L). Catalog rebuild per tool search
- **Risk:** `search_tools` dynamically rebuilds the live capability catalog on every invocation to ensure freshness across enrolled origins and MCP servers. The catalog assembly caps origin inspection at 200 origins (`(await listOrigins()).slice(0, 200)`). A user with more than 200 enrolled origins experiences silent truncation of search results.
- **Lives at:** `extension/background/service-worker.js#readShadowCatalogInputs` (the enclosing catalog-input function); `extension/background/service-worker.js:5044` is a deliberately approximate source-line locator for its `(await listOrigins()).slice(0, 200)` cap, **not** a unique symbol or a guarded line pin. The symbol guards the function's existence, not the cap itself.
- **Mitigation:** In-memory caching of provider definitions; 200-origin bound prevents catastrophic search latency.
- **Open question:** Should the UI surface a notification when the enrolled origin count exceeds the 200-origin search threshold?

### R21 (L). SharedWorker discovery relies on name conventions
- **Risk:** Chromium provides no enumeration API for active `SharedWorker` instances. SharedWorker liveness is tracked purely by naming conventions (`agent-worker:<id>`) and Service Worker port bookkeeping. If a Service Worker restart drops port references, an orphaned SharedWorker may linger in memory until tab closure.
- **Lives at:** `extension/background/routes/agent-worker.js:575` (`reconcileAgentWorkers`), `extension/lib/agent-worker-host.js:60`.
- **Mitigation:** Persistent active worker registry in `cap:agent-workers:alive` synchronized on worker boot; explicit `agent-worker.close` route.
- **Open question:** Native SharedWorker lifecycle inspection APIs in Chromium.

---

## Class 5 — Adjudicated and Withheld (audit-stop entries)

An entry in this class is a DECISION, not an open risk. Automated audits (the nightly
software-factory project-audit in particular) keep re-reporting the items below as a new
CRITICAL, each time forcing a coordinator to re-derive a decision that was already made
and landed. That recurrence is the defect this class fixes: the adjudication now lives
where the auditors read. Cite the entry; do not re-derive it. `THREAT_MODEL.md` §7 is the
threat-model half of the same list.

A decision that was adjudicated and has SINCE been ENFORCED is not an entry here: it is a
delivered control, and it belongs in `THREAT_MODEL.md` beside the assertions that falsify
it. The `hooks.subscribe` first-time create gate (`chrome-agent-platform-51cd`, merge
`2b4da1f3`; `THREAT_MODEL.md` T13) is recorded that way and deliberately NOT as an
R-number — a class that mixed withheld decisions with enforced controls would stop meaning
"cite this and move on", which is the only thing it is for.

### R22 (M). The shared sender classifier's extension default is a WITHHELD hardening (lw6d)
- **Evidence pin: `origin/main@213bafbc`.** The `service-worker.js` citations in this entry were re-read against that tree (the listener moved off the document pin) and resolve identically at `origin/main@f507d58f`, where the census count this entry quotes (37 unclassified mutations) was also re-read. Treat the symbol as the anchor and the line as the locator.
- **Risk:** `authorizeToolReport` (`extension/lib/pure.js#authorizeToolReport`) returns `{ kind: "extension" }` for any sender that is not a browser-attested content script and carries no tab URL (`extension/lib/pure.js:934`). A synthetic sender — a foreign extension id with an `https://attacker.example/` url, `origin: "https://attacker.example"` and no `tab` — therefore classifies as an INTERNAL extension document, which would reach every route including the 37 unclassified mutations of R11 without a page-origin fence. No route-local principal check stands between that classification and those mutations.
- **Lives at:** `extension/lib/pure.js:934` (the `{ kind: "extension" }` default), `extension/lib/pure.js#authorizeToolReport` (`authorizeToolReport`), `extension/background/service-worker.js#chrome.runtime.onMessage.addListener` (the one listener that feeds it the browser-attested sender; re-read at `origin/main@28c7189d`).
- **Mitigation:** ADJUDICATED AND WITHHELD (`chrome-agent-platform-lw6d`; `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md`, status line "hardening explicitly withheld"). There is no known producer for the browser-attested tabless/opaque sender shape: `chrome.runtime.onMessage` receives only messages dispatched by this extension's own execution contexts, the manifest declares no `externally_connectable`, and the service worker registers no `chrome.runtime.onMessageExternal` listener — `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md` §3, pinned executably by `tests/internal-sender-contract-audit.test.ts:106-121`, with the synthetic fixture pinned at `:14-25` (the `Deno.test` at :14 closes at :25; :27 opens a different test). Hardening is withheld precisely because it is not free: a naive exact-id or URL-prefix filter would break LEGITIMATE tabless internal frames (the offscreen document, the side panel, sandboxed iframes) — the census of legitimate senders is `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md` §4. The control that remains in place is the closed `PAGE_ALLOWED_ROUTES` set (`extension/lib/pure.js#PAGE_ALLOWED_ROUTES`), enforced in the central listener at `extension/background/service-worker.js#chrome.runtime.onMessage.addListener` (page-route check: `extension/background/service-worker.js#PAGE_ALLOWED_ROUTES.has`), which keeps a page sender off every privileged route. These cited symbols are resolved against live source by `tests/security-doc-drift.test.ts`; the historical `origin/main@28c7189d` evidence pin does not govern their current locations. Threat-model cross-reference: `THREAT_MODEL.md` T3 (the threat) and §7 item 1 (the exclusion).
- **Open question:** None open on the decision itself. **REOPEN TRIGGER — reopen this entry, and re-rate it, if ANY of the following lands:** (a) any NEW sender shape reaching `chrome.runtime.onMessage` — a new offscreen document, a new worker or SharedWorker class, a new extension document class, or a new page/iframe class — because the tabless/opaque shape is exactly what the classifier defaults on; (b) any manifest change adding `externally_connectable`, or any new `chrome.runtime.onMessageExternal` listener, because that is what would produce a real foreign sender rather than a synthetic one; (c) a real-browser delivery of a tabless/opaque sender whose URL is not `chrome-extension://`. Trigger (b) is executable, not a promise: `tests/internal-sender-contract-audit.test.ts:113-114` fails the moment either lands.

### R23 (M). Brokered fetch SSRF guard matches host strings without DNS resolution (v6ej / TM-104)
- **Evidence pin: `origin/main@7172544d`.** Treat `isPrivateOrLoopbackHost` as the anchor and line 21 as the locator.
- **Risk:** In `extension/lib/fetch-policy.js`, the SSRF protection mechanism (`isPrivateOrLoopbackHost` via `checkFetchTarget`) inspects the host string of requested URLs against loopback, private RFC1918/RFC6598, link-local RFC3927 (including cloud metadata `169.254.169.254`), and IPv6 private/loopback literals and names (`localhost`). However, it does not resolve hostnames to IP addresses prior to dispatch. If an approved domain subsequently resolves or rebinds via DNS to `127.0.0.1` or another private network IP (DNS rebinding), the Service Worker's brokered `fetch()` carries the request with the extension's network position to the private endpoint. Across the four bridges sharing `checkFetchTarget`, this exposes: (1) `cap:fetch` (script sandbox): anonymous GET/HEAD; (2) `python.fetch` (Python bridge): GET/HEAD/POST and caller-set headers outside `FORBIDDEN_REQUEST_HEADERS` (e.g. `Metadata-Flavor: Google` to a rebound metadata IP); (3) Secure Enclave proxy: GET/POST; and (4) skill import (`skill.import` / `skill.discover` / `skill.importBatch`): anonymous GET for external skills/commands.
- **Lives at:** `extension/lib/fetch-policy.js:21` (documented DNS-rebinding residual), `extension/lib/fetch-policy.js:93` (`isPrivateOrLoopbackHost`), `extension/lib/fetch-policy.js:118` (`checkFetchTarget`), `extension/lib/python-network.js:183` (`checkPythonNetworkRequest`), `extension/background/routes/enclave-proxy.js:348` (enclave proxy SSRF check), `extension/lib/skill-import.js:16` (`validateHttpUrl`).
- **Mitigation:** ADJUDICATED AND WITHHELD — accepted on 2026-10-05 by coordinator lane (`chrome-agent-platform-coord`) under bead `chrome-agent-platform-v6ej` (software-factory nightly audit finding `dns-rebinding-brokered-fetch-residual` / TM-104; owner ratification pending). The web platform and Chrome extension MV3 Service Worker environments lack a socket-level DNS resolution or destination IP-pinning API (`chrome.dns` is ChromeOS/enterprise-only; `fetch()` does not expose resolved IP addresses or allow custom IP connection targets without TLS certificate validation failure on virtual-hosted HTTPS). Pre-resolving hostnames via external DoH is prone to TOCTOU races and leaks private/intranet hostnames, while socket-level IP substitution is unsupported in MV3 `fetch()`. The residual is bounded by each bridge's explicit target authority: (1) for `cap:fetch`, the per-run, owner-approved host allowlist (`extractFetchHosts` / `checkFetchPolicy`) shown on the script approval card; (2) for `python.fetch`, explicit per-origin grants in Settings or first-use prompts (`checkPythonNetworkRequest`); (3) for the enclave proxy, a frozen, code-reviewed service-origin allowlist; and (4) for skill import, the owner directly supplies the target source URL, with `redirect: "manual"` fail-closed opaqueredirect enforcement and hop-bounded validation preventing redirect bypasses. Cross-reference: `THREAT_MODEL.md` T6, INV-5, and §7 item 9.
- **Open question:** None open on the extension-side implementation. **REOPEN TRIGGER — reopen this entry if:** (a) Chromium introduces an MV3 Service Worker API for IP-bound fetch or pre-fetch DNS inspection; (b) any NEW consumer of `checkFetchTarget` is created that does not enforce its own approved-target allowlist or origin grant; or (c) fetch policy is relaxed to permit ambient wildcard network egress.

### R24 (L). ACP loopback bridge client auth does not authenticate the server (jsjy / 6hly)
- **Evidence pin: `origin/main@40a1ad18`.** The symbols below are the anchors; line numbers locate this tree's WebSocket fallback and bridge authentication.
- **Risk:** The extension's WebSocket fallback connects over plain `ws://` to fixed `127.0.0.1:3210` and sends the configured shared secret in the `/acp?token=…` upgrade query. By default, the bridge authenticates that client, but the client does not authenticate the server (under --allow-anonymous-loopback, neither authenticates the other). An unprivileged local process that binds the port first (or while the real bridge is down) receives the token and can answer as the shell-capable harness; an unauthenticated `/health` response is not proof of server identity. When the default token file is writable, its token persists across restarts and a harvested token can also be replayed later against the real bridge; if persistence fails, the bridge stays authenticated with a generated token for that run only (`scripts/acp-bridge.ts:165-171`), but the same-run bind race remains. The `jsjy` default-auth fix closed unauthenticated loopback access by default (with an explicit loopback-only opt-out) but made this pre-existing bind race more consequential by persisting the token; it did not create the race. This needs a LOCAL process, unlike voicebox `k74h`'s cross-origin web-page threat in a different project.
- **Lives at:** `extension/lib/acp-runner.js:260` (fixed endpoint), `extension/lib/acp-runner.js:292` (token in upgrade URL), `extension/lib/acp-runner.js:551` (configured token), `extension/lib/acp-client.js:34` (loopback-only check, no server identity), `scripts/acp-bridge.ts:785` (bind), `scripts/acp-bridge.ts:791` (unauthenticated health), `scripts/acp-bridge.ts:137` (persisted token), `scripts/acp-bridge.ts:859-867` (required token on upgrade by default).
- **Mitigation:** **ACCEPTED, NAMED, REVERSIBLE RESIDUAL — ADJUDICATED AND WITHHELD** by the operator on 2026-10-06 (`chrome-agent-platform-6hly`). The assumption is a single-user development machine with only owner-controlled local processes: a malicious process already running locally under the owner's authority has equivalent-or-greater access to the shell-capable harness and its files. Existing controls still refuse web Origins, require a token even on loopback by default, compare it in constant time, restrict the extension client to loopback, and store the default token in a mode-0600 per-user file when writable; **none authenticates the server**. Three alternatives were considered and deliberately declined for this P3 residual: (1) a per-run token would shorten replay lifetime but **not** stop theft/impersonation in the run whose bind race the attacker wins, and would restore the token-paste/setup friction `jsjy` removed; (2) `wss://` with a pinned certificate would require certificate trust/provisioning and rotation work (browser WebSocket has no direct application pinning API); (3) requiring the already-prototyped native-messaging transport with no WebSocket fallback would remove the port, but its browser leg still needs headed verification, `nativeMessaging` permission/host installation, and a bundled manifest snapshot re-pin (`docs/ACP-INTEGRATION-RESEARCH.md`, native transport status). These costs are not justified under the stated single-user assumption; this is not a claim that loopback is safe from another local principal. Threat-model cross-reference: `THREAT_MODEL.md` T15 and §7 item 10.
- **Open question:** None on the accepted decision. **REOPEN TRIGGER — reopen and re-rate R24 if** the machine becomes shared or multi-user, a container/CI job or other untrusted local process can bind the same loopback port, the bridge runs as a shared service reachable by another principal, or the client policy permits a non-loopback endpoint. At that point the single-user equivalence argument no longer holds: choose and implement a server-authenticating transport/control (prefer native-only or authenticated TLS over merely rotating the token) before treating that deployment as trusted.

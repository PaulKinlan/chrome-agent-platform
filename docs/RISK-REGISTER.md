# Architecture risk register — Chrome Agent Platform

**Bead:** chrome-agent-platform-afbb (umbrella 9zw7) · **Date:** 2026-09-05 ·
**Tree:** `origin/main@14e2a817` (0.3.229). Every risk cites where it lives in
code, the current mitigation, and the open question. Ordered by class, not
severity ranking — severity is marked H/M/L per entry (likelihood × blast
radius, author's judgement).

---

## Class 1 — Isolation boundaries with no platform backstop

### R1 (H). Origin-keyed "isolation" is directory multiplexing inside ONE OPFS root
- **Risk:** The platform gives the extension origin exactly one OPFS root
  (verified, §5.1 of ARCHITECTURE.md). Per-site/per-agent stores are
  subdirectories (`memory/origins/<encoded>`, `memory/agents/<slug>`, …)
  separated only by extension code. A single path-resolution or
  canonicalization bug collapses cross-origin isolation — one site's sub-agent
  reads another site's memory. There is no platform-level second fence.
- **Lives at:** `extension/lib/memory.js:393-395` (single `rootDir()`),
  `:252-263` (`canonicalOrigin` + injective `encodeURIComponent` encoding),
  `:711-760` (reserved keys + trusted-write path).
- **Mitigation:** canonicalization rejects non-http(s); injective reversible
  encoding; reserved/internal key namespaces; A/B clear-isolation test
  (docs/CONSTITUTION.md §1); stores never share handles across origins by
  construction.
- **Open question:** should the platform give agents real per-principal storage
  (see the stage-4 concept doc)? Within the extension, would the Storage
  Buckets API (`navigator.storageBuckets.open(...)`) give per-agent buckets a
  real second fence? Not currently used anywhere in the tree (grep-verified).

### R2 (H). The script sandbox runs agent-authored JS with `new Function`
- **Risk:** The one eval exemption in the bundle
  (`extension/sandbox/script-sandbox.js:97`). The boundary is the manifest
  sandbox's opaque origin: no chrome.*, no extension storage. Escape surface =
  the postMessage protocol with the host and the host-bridged `fetch` — a
  bridged-fetch bug is an SSRF/exfiltration channel driven by agent code.
- **Lives at:** `extension/sandbox/script-sandbox.js` (protocol :9-16, eval
  :97, teach-guards :23-40); brokered fetch policy
  `extension/lib/fetch-policy.js` (credentials:"omit", no redirects, no
  loopback/private/link-local, per-run host allowlist).
- **Mitigation:** opaque origin (no storage at all — teach-guards make the
  throws instructive); digest-bound owner approval of the exact source before
  first run (`owner-approval.js` DESTRUCTIVE_ACTIONS `script.*`); fetch fenced
  per above; MV3 CSP keeps the exemption confined to the sandbox page.
- **Open question:** the hub can act as the script host when the offscreen doc
  is absent (offscreen.js header: "whichever host is open answers") — hosting
  the sandbox iframe inside the trusted hub document widens the blast radius of
  any iframe-boundary bug. Is the fallback worth it?

### R3 (M). WebMCP bridge: the extension is fingerprintable and the detection probe is on every page
- **Risk:** Two content scripts on every http(s) page at document_start
  (install-granted `<all_urls>`) + a MAIN-world probe mean every website can
  detect the extension's presence (bead chrome-agent-platform-f62c, open P2).
  Beyond fingerprinting, the detection channel itself (`__cap_webmcp_detect` +
  HMAC per-document key) is a page-visible surface whose only protection is
  key secrecy — a page that extracts the key can forge capability snapshots
  (impact bounded: snapshots carry counts only, and enrollment still requires
  the owner click).
- **Lives at:** `extension/content/webmcp-detect-main.js`,
  `webmcp-detect-relay.js` (MAC verify), `extension/manifest.json`
  (content_scripts, host_permissions).
- **Mitigation:** snapshots transport tool COUNTS only; MAC'd per document;
  sender identity is browser-attested, never message-claimed; enrollment and
  invocation stay owner/extension-gated.
- **Open question:** f62c is the owner decision — is passive everywhere-
  present detection worth the fingerprint, or does discovery move to
  activeTab/on-demand (losing the passive thesis)?

### R4 (M). Untrusted-content fence is a prompt-level defense
- **Risk:** The `<<<UNTRUSTED run:<token>>>>` boundary
  (`extension/lib/untrusted-fence.js` + the protected dynamic prompt layer)
  asks the MODEL to treat fenced text as data. A sufficiently persuasive page
  can still talk a weak model into asking for a destructive call. The
  mechanical backstops (grants, approvals, run fence) are what actually hold.
- **Lives at:** `extension/lib/untrusted-fence.js`; system-prompt layer 5.6
  (docs/SYSTEM-PROMPTS.md).
- **Mitigation:** per-assembly random token (not guessable from page content);
  protected-final runtime policy; destructive actions need owner grants;
  journey-suite `injection:` checks with a model scripted to obey the page.
- **Open question:** none actionable in-extension; the real fix is platform
  level (stage-4 concept: a principal separation the model can't talk its way
  past).

## Class 2 — Authority boundaries

### R5 (H). dptw removed the byte ceilings; the constitution still demands bounded growth
- **Risk:** Owner directive dptw (2026-09-03) removed per-store, per-value and
  tree byte bounds: `assertQuota` is a no-op (`memory.js:691-698`),
  `ASSET_BOUNDS.maxContentBytes: Infinity` (`artifacts.js:422`), Wasm tier byte
  gates are `Infinity` (`wasm-package-authority.js:20-24`). The only ceiling
  left is the browser's native OPFS quota, whose refusal arrives mid-run as a
  `QuotaExceededError`. docs/CONSTITUTION.md §4 ("no unbounded growth … all
  bounded") now describes a property the code does not have. A runaway or
  hostile-loop agent can fill the profile's OPFS until writes fail.
- **Lives at:** the three sites above; residual bounds: run-log compaction
  (50/thread) and the 500-row journal.
- **Mitigation:** honest native-quota surfacing; run-log compaction; factory
  reset exists. Related beads show the removal was not free:
  chrome-agent-platform-bfbd (agent-board interlocked caps — naive removal
  OOMs) and chrome-agent-platform-op01 (code-diff CAS budgets share
  CODE_DIFF_LIMITS — removal OOMs) are open P2s.
- **Open question:** is "browser quota is the only ceiling" the settled
  end-state (constitution should be amended), or does a coarse product-level
  ceiling return? This is the register's clearest constitution-vs-code drift.

### R6 (M). The run fence is a module singleton, safe only under run serialization
- **Risk:** `extension/lib/run-fence.js` is a module-level singleton the SW
  swaps per run ("combined with run serialization, only one run is ever
  active"). Any future code path that starts a second concurrent run in the SW
  realm silently cross-wires abort signals — an aborted run A could fence
  (or fail to fence) run B's mutations.
- **Lives at:** `extension/lib/run-fence.js` (whole file);
  `withRunLock` serialization in service-worker.js (`runTask`).
- **Mitigation:** `withRunLock` serializes master + delegated execution;
  delegated site runs go through the same admission; documented invariant.
- **Open question:** agent-worker runs move execution OUT of the SW realm —
  does the fence singleton still cover them, or does each worker need its own
  fence token? (Relates to R8's partial migration.)

### R7 (M). Approval machinery: 60 s TTL, 64 pending cap, and a known rendering bug
- **Risk:** Owner approvals expire after `APPROVAL_TTL_MS = 60_000`
  (`owner-approval.js:14-15`) and pending requests cap at 64. A run whose card
  renders while the owner is away dies on the TTL; worse, bead
  chrome-agent-platform-m6id (open P2): "A run's second in-flight permission
  card never renders, then expires" — a real denial-of-progress path.
- **Lives at:** `extension/lib/owner-approval.js:15-16`; bead m6id.
- **Mitigation:** bounded/deduplicated pending set; deny is sticky; the card
  retry path exists.
- **Open question:** m6id fix + whether the TTL should pause while no surface
  is visible (background runs can't show cards anyway).

### R8 (M). Two agent execution paths (SW `runTask` vs agent SharedWorker) drift apart
- **Risk:** The worker migration is deliberately half-done: scheduled runs still
  execute in the SW; worker runs are stateless single-shots with no thread
  history (docs/OPEN-QUESTIONS.md Q21 — documented residual "by design");
  `handleAlarm → worker` reroute is unflipped
  (docs/AGENT-WORKER-PHASE4.md §"What STAYS on the SW path"). Every behavior
  implemented on one path must be mirrored on the other or the two agent kinds
  diverge (beads chrome-agent-platform-86oj, -mxu5 track known instances).
- **Lives at:** `extension/background/routes/agent-worker.js:243`
  (`agent-worker.run`) vs service-worker `runTask`.
- **Mitigation:** the worker's tools RPC back through the SW executor
  (`agent-worker.tool`), so tool-level authority is shared; the durable
  registry covers both.
- **Open question:** when does the flip happen (mxu5)? Until then every
  run-path feature is double work or a drift risk.

### R9 (M). WebMCP calls run with no per-call consent
- **Risk:** Enrollment is the only consent; any enrolled site tool — including
  mutating ones — runs on the model's say-so within a run (bead
  chrome-agent-platform-eo4d, open P2). A compromised/hostile enrolled site
  gets mutation without a per-call card.
- **Lives at:** consent model documented in
  `extension/lib/webmcp-authority.js:13-17` ("ENROLLMENT IS THE OWNER'S
  CONSENT"); `extension/lib/tools.js:490-493` (`isApproved` = live enrollment).
- **Mitigation:** enrollment is exact-origin + owner-clicked; results fenced;
  calls ledgered; per-run generation fences stop stale runs.
- **Open question:** OPEN-QUESTIONS.md Q23's recommended default (enrollment
  covers reads; one card per run for site-marked-mutating tools) awaits the
  owner.

### R10 (L). MCP: no server-count bound; approved-server exfil window
- **Risk:** `extension/lib/mcp-config.js` normalizes/dedups the server list but
  no maximum count was found (grep-verified) — every run mounts the effective
  set, so N slow/unreachable servers tax every run's startup (per-server
  failure is isolated, but the mount attempts still cost latency). And once a
  server is approved for the run, the model can send tool arguments to it —
  a malicious-but-approved server is an exfil channel for anything the model
  will type (bounded by fencing + the model's judgement only).
- **Lives at:** `extension/lib/mcp-config.js`, `mcp-client-core.js` (mount
  loop), `mcp-run-tools.js` (approval + fencing + ledger).
- **Mitigation:** per-server first-use approval card; results fenced
  untrusted; calls ledgered; connections torn down per run.
- **Open question:** add a servers-per-agent bound? Should argument payloads
  to MCP servers get the same owner-visible treatment as script fetches?

## Class 3 — Platform constraints worked around (each is a standing fragility)

### R11 (H). The offscreen document is a single point of failure for five subsystems
- **Risk:** One offscreen document hosts the script-sandbox host, agent
  SharedWorkers, the Pyodide host, the Wasm stream host, and the table worker
  host (`extension/offscreen/offscreen.js:16-40`). Chrome may reclaim it; one
  reclamation kills every hosted worker mid-job. MV3 gives exactly one
  offscreen document per profile.
- **Lives at:** creation `service-worker.js:355-367` (reasons WORKERS +
  DOM_SCRAPING); reconcile-on-wake
  `routes/agent-worker.js:575`.
- **Mitigation:** disposable-by-design + SW reconcile; durable run authority
  survives; fresh-worker-per-job means a reclaimed job worker's workspace dies
  with it (by design). Known residual from docs/AGENT-EXECUTION-ARCHITECTURE.md
  §7.
- **Open question:** Chrome's actual reclamation behavior under long-lived
  WORKERS-reason docs is unverified in a real build (the doc flags this);
  plus the double-registered script listener (bead chrome-agent-platform-czwz)
  suggests this file gets less review than its centrality warrants.

### R12 (M). MV3 service-worker ephemerality vs long agent runs
- **Risk:** Chrome can kill the SW at any time; all in-memory execution state
  (run mutex, aborter map, run fence, orchestrator cache) dies with the boot.
  The design accepts this and rebuilds from OPFS — but anything not journaled
  before the kill is lost, and mutating-tool interruptions pause for the owner
  (correct but visible).
- **Lives at:** durable-runs machinery (`extension/lib/durable-runs.js`);
  15 s heartbeats; boot fence.
- **Mitigation:** the whole durable-run architecture (ARCHITECTURE.md §2.3):
  outbox settlement, boot/revision fences, resumability classes.
- **Open question:** none new — this is the platform's tax on MV3 agents; the
  stage-4 concept doc argues for a durable-execution platform primitive.

### R13 (M). Worker constructors unavailable in the SW — the reason for R11's shape
- **Risk:** `new Worker`/`new SharedWorker` don't exist in
  ServiceWorkerGlobalScope, so ALL isolated execution must proxy through the
  one offscreen document. This couples every isolation decision to R11.
- **Lives at:** `wasm-executor.js:226` (Worker), `agent-worker-host.js:60`
  (SharedWorker), `table-worker-host.js`, `python-host.js` — all
  offscreen-hosted.
- **Mitigation:** structural (R11's reconcile).
- **Open question:** platform ask (stage 4): let extension SWs spawn workers
  directly.

### R14 (M). Wasm has no fuel counter; memory maxima don't cap the JS heap
- **Risk:** Worker termination is the only CPU kill switch, and a declared
  Wasm memory maximum bounds only linear memory — the Emscripten/glue JS heap
  in the same worker is uncapped (noted in
  docs/tool-platform-architecture.md §"Future execution invariants"). A
  pathological module can balloon the worker's JS heap until the browser OOMs
  it, taking the offscreen doc's siblings' jobs with it (shared process).
- **Lives at:** the Wasm host chain (§6 of ARCHITECTURE.md); wall clocks:
  `WASM_STREAM_WALL_MS = 180_000` (`wasm-stream-host.js:12`), stream-platform
  30 s/180 s (`tool-stream-platform.js:24-30`).
- **Mitigation:** fresh worker per job + wall-clock termination + declared-
  memory admission scan (memory64/shared rejected).
- **Open question:** none in-extension; platform ask: per-worker memory
  accounting/limits.

### R15 (L). Host access is install-granted `<all_urls>` — maximum read surface, Store-review exposure
- **Risk:** Deliberate (owner decision Q18, option (a)): the manifest's
  `host_permissions: ["<all_urls>"]` + two content scripts everywhere is the
  broadest possible read posture; the install prompt says "Read and change all
  your data on all websites". Settled for a private tool; a Store submission
  will have to argue it (bead chrome-agent-platform-8qi).
- **Lives at:** `extension/manifest.json`.
- **Mitigation:** mutations still wait on grants; the privacy page lists it
  honestly; README carries the settled-posture paragraph.
- **Open question:** Store policy (Q13-adjacent) and the f62c fingerprint
  decision interact here.

### R16 (L). Opaque-origin sandbox storage throws — by design, but it trains on errors
- **Risk:** Sandboxed scripts that reach for localStorage/IndexedDB/OPFS get
  SecurityError; the teach-guards convert this to instruction
  (`script-sandbox.js:23-40`). Design choice, listed here so it is read as a
  boundary, not a bug.
- **Open question:** none.

## Class 4 — Perf ceilings and operational ceilings

### R17 (M). SW bundle size and the 9.6k-line service-worker.js
- **Risk:** The constitution budgets the SW bundle at "~2.5mb — watch it"
  (docs/CONSTITUTION.md §4). The SW source is ~9.6k lines with 100+ inline
  routes still un-modularized (routes/ROUTE_MAP.md's "(114) inline" is stale
  but directionally right). Every provider/SDK/route ships in one realm.
- **Lives at:** `extension/background/service-worker.js`; routes/.
- **Mitigation:** route modularization in progress (13 modules); build gate
  watches eval/CSP; perf marks exist.
- **Open question:** current bundle byte size at tip is unverified in this
  pass (dist is generated); worth one measurement as part of the stage-6
  cleanup evidence.

### R18 (L). Catalog rebuild per search
- **Risk:** `search_tools` rebuilds the live bounded catalog per call
  (by design, for freshness); with 188 capability rows + N enrolled origins +
  M MCP servers this is per-search work in the SW. Measured fine today
  (provider-definition bytes constant); the ceiling is origin count
  (`listOrigins().slice(0, 200)` cap in the SW catalog assembly,
  service-worker.js:3934).
- **Open question:** the 200-origin catalog cap — silent beyond it (bounded,
  but is the owner told?).

### R19 (L). SharedWorker discovery is convention-only
- **Risk:** No enumeration API exists for SharedWorkers; liveness is
  convention (`{name: agentId}`) + the SW alive-set + keep-alive ports
  (docs/AGENT-EXECUTION-ARCHITECTURE.md §2-4). A missed reconcile leaves a
  zombie worker holding memory until the last port closes.
- **Mitigation:** SW authoritative alive-set (`cap:agent-workers:alive`) +
  `reconcileAgentWorkers` on wake.

## Class 5 — Process/tracking observations (handed to coordinator, not product risks)

- **R20.** Duplicate beads exist for the same defect:
  chrome-agent-platform-n0sh and chrome-agent-platform-q2we are both "Run-driven
  tool executions bypass the action ledger and the usage counters" (P2). The
  dependency graph works better with one; suggest the coordinator dupe-links
  them.
- **R21.** The double-registered offscreen listener (czwz) survived because
  offscreen.js has no direct test; the harness registry covers scripts/*.ts,
  not this. Noted as a coverage-shape observation, not a demand.

---

### Method note
Every entry was derived from reading the code at `origin/main@14e2a817` during
the stage-2 pass, cross-checked against the open beads (`bd list`) so known-
tracked items are linked rather than duplicated. Nothing here was copy-pasted
from an existing doc without verification; where a doc and the code disagreed,
the code won and the doc got an audit finding (stage 1 addendum).

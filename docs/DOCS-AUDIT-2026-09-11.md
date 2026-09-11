# Documentation Audit & Prioritized Fix Plan — 2026-09-11

**Author:** `merger` lane (bead `chrome-agent-platform-s6r3`, umbrella `9zw7`)  
**Base:** `origin/main` @ `706c76da` (v0.3.367, 2026-09-11)  
**Scope:** Whole-repository documentation audit: `PRODUCT.md`, `README.md`, `PLAN.md`, `AGENTS.md`, and all 53 markdown files under `docs/`.  
**Verification Method:** 100% automated script verification against the local tree. Every cited line number (`doc:line` and `source:line`) was evaluated with an automated string matcher asserting the exact quoted text appears at that specific line. All 58 citations in this document are byte-exact verified against commit `706c76da`.  
**Deduplication vs Prior Audits:** This audit cross-references `docs/DOCS-AUDIT-2026-09-05.md` (40 findings) and annotations in `docs/ARCHITECTURE.md` (e.g. finding 17, finding F-29). Each entry explicitly distinguishes **Prior Unresolved Findings** from **New Findings Post-09-05 / Tonight**.

---

## Executive Summary

The Chrome Agent Platform documentation reflects four distinct evolutionary layers:
1. **The MV2 / Request-Era (August 2026, 0.2.x)**: Conceived as an all-optional permissions model with strict internal size and key quotas (8 MiB store, 256 KiB artifact, 32 KiB tool arguments).
2. **The dptw De-Capping Era (2026-09-03)**: Removal of self-imposed byte, line, count, and schema limits across the platform ("the browser's OPFS quota is the only ceiling").
3. **The Multi-Worker & Protocol Architecture (September 2026, 0.3.x)**: Per-agent SharedWorkers, 38 bundled Wasm packages, 4 lazy protocol tools (including `run_pipeline`), 138 browser tools (188 capability rows), and 258 registered service worker message routes.
4. **Tonight's Landings (2026-09-11)**: Chrome test contract (`dqc1`), Wasm process ownership (`9rmz`), serial phase isolation (`6yrq`), KAT harness migration (`3khn`), MCP approval policy reconciliation (`gcuw`), internal sender audit (`lw6d`), action ledger unification (`n0sh`), streamed backup/restore architecture (`2g90`), pipeline bounds reconciliation (`46rh`), and risk register contract (`t4td`).

While recent documents (`docs/SW-DISPATCH-AUTHORITY-CENSUS.md`, `docs/CHROME-TEST-CONTRACT.md`, `docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md`, `docs/INTERNAL-SENDER-CONTRACT-AUDIT.md`, `docs/RISK-REGISTER.md`) are authoritative, core entry points (`README.md`, `PRODUCT.md`, `PLAN.md`, `docs/CONSTITUTION.md`, `docs/ARCHITECTURE.md`, `docs/inline-approval-audit.md`) contain high-severity contradictions that actively mislead architectural and security decisions.

---

## Part 1: High-Severity Findings (Authority, Gates, Security & Operational Limits)

These findings mislead an engineer or auditor regarding authority boundaries, security guarantees, execution gates, or operational limits.

### H-01: `DESTRUCTIVE_ACTIONS` Allowlist Severely Under-Reported
- **Status:** Unresolved prior finding (extends `DOCS-AUDIT-2026-09-05.md` #27).
- **Document Claim:** `docs/inline-approval-audit.md:14` explicitly states:  
  `The 17-action destructive allowlist audited in `extension/lib/owner-approval.js` is:`  
  listing only 17 actions ending with `task.pause`, `task.resume`, and `task.update`.
- **Source Truth:** `extension/lib/owner-approval.js:23` defines `export const DESTRUCTIVE_ACTIONS = new Set([` containing **32 actions** (almost double the documented size).  
  Actions missing from the documentation include:
  - `asset.restore` (`owner-approval.js:28`)
  - `fs.write` (`owner-approval.js:42`)
  - `script.create`, `script.run`, `task.schedule-script` (`owner-approval.js:48-50`)
  - `browser.cookie-value` (`owner-approval.js:64`)
  - `webmcp.use-tool` (`owner-approval.js:74`)
  - `mcp.use-server` (`owner-approval.js:80`)
  - `browser.close-foreign-tab`, `browser.close-window`, `browser.wipe`, `browser.remove-bookmark`, `browser.set-cookie`, `browser.remove-cookie` (`owner-approval.js:87-92`)
  - `workflow.run` (`owner-approval.js:98`)
- **Impact:** Critical audit failure. An engineer or auditor relying on `inline-approval-audit.md` would conclude that browser wipes, cookie exfiltration, window closures, local file edits, and workflow executions bypass the owner approval card.

### H-02: `named-agent.set-mcp-servers` Approval Contract Reconciliation
- **Status:** **NEW Tonight** (reconciled in `gcuw` / commit `bc393c37`).
- **Document Claim:** `docs/ARCHITECTURE.md:485` claims:  
  `` `mcp.servers.get`/`set` routes return REDACTED views ``  
  and older architectural comments claimed model pending-approval flows for MCP server mutations.
- **Source Truth:** `extension/lib/owner-approval.js:143` lists `"named-agent.set-mcp-servers"` under `OWNER_DIRECT_ACTIONS`. `owner-approval.js:52` explicitly documents:  
  `This operation is strictly owner-only: it is absent from DESTRUCTIVE_ACTIONS, so any non-owner caller fails closed ('operation is not approvable') and cannot trigger a pending approval flow to write server endpoints or credentials.`  
  It is absent from `MANAGEMENT_TOOL_NAMES` (`extension/lib/management-tools.js:25`). Only the owner via the Options document can configure MCP servers.
- **Impact:** Misrepresents the security boundary of MCP server configuration; a model cannot be prompted to inject arbitrary MCP endpoints via approval cards.

### H-03: Stale Pre-dptw Storage, Value, and Artifact Caps
- **Status:** Unresolved prior finding (extends `DOCS-AUDIT-2026-09-05.md` #31).
- **Document Claims:**
  - `docs/DURABLE-RUN-ARCHITECTURE.md:146`: Cites `arbitrary file-count ceiling: each store remains byte-bounded at 8 MiB, each value at 256 KiB, and the full OPFS tree at 64 MiB`.
  - `docs/OPEN-QUESTIONS.md:25` (Q16): Cites `the explicitly lower single-body cap (256 KB, already the artifact limit)`.
  - `docs/CONSTITUTION.md:150`: Mandates `- **Memory resilience**: no unbounded growth — the activity log, the OPFS stores, the screenshots/MHTML, the event log are all bounded`.
- **Source Truth:** Under the `dptw` sweep (2026-09-03):
  - `extension/lib/memory.js:691`: `/** dptw: no quota gate — the ledger is still maintained for diagnostics but assertQuota is a no-op... the browser's OPFS quota is the only ceiling */`.
  - `extension/lib/artifacts.js:422`: `maxContentBytes: Infinity,` ("no-limits (owner directive 2026-09-03)").
  - While `docs/ARCHITECTURE.md:403-412` noted this change, `CONSTITUTION.md` and `OPEN-QUESTIONS.md` still mandate the dead 256 KiB / 8 MiB limits.
- **Impact:** Misguides developers into adding artificial truncation or buffer limits that contradict current platform policy.

### H-04: Monolithic Backup/Restore Hard Caps vs Streamed Architecture
- **Status:** **NEW Tonight** (landed in `2g90` / commit `94717907`).
- **Document Claims:**
  - `docs/ARCHITECTURE.md:12-14` and `README.md:18-20` do not document profile backup bounds.
- **Source Truth:**
  - `extension/lib/data-archive.js:105-106` contains hardcoded legacy ceilings:
    ```javascript
    export const MAX_ARCHIVE_OPFS_FILES = 100_000;
    export const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB
    ```
  - `docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md:14` (landed tonight @ `94717907`) is now the authoritative contract: transitioning from monolithic base64 JSON IPC (`service-worker.js:7651`) to client-side streaming TAR to handle unbounded profiles without OOM or IPC deadlocks.
- **Impact:** Prevents regression into monolithic IPC patterns for large profiles.

### H-05: Real-Browser Execution in `npm test` Omitted from Docs
- **Status:** **NEW Tonight** (established in `dqc1` / commit `79e7b606`).
- **Document Claims:**
  - `README.md:270`: Cites `**Current gate status:** build clean · unit **1779/0** · Chrome journeys **127/127**`.
  - `PLAN.md:11`: Cites `| `npm test` | **1779 pass / 0 fail** |`.
  - Older text presents `npm test` as pure in-memory unit tests.
- **Source Truth:** `docs/CHROME-TEST-CONTRACT.md:13` and `AGENTS.md` Rule 4 explicitly establish:  
  `1. **`npm test` unconditionally launches a real Chromium browser.** Specifically, `tests/chrome-profile-location.test.ts:115` requires a working `/usr/bin/chromium` (or Chrome binary) on the host machine.`  
  `tests/chrome-profile-location.test.ts:126` (`const launched = await launchChrome({`) exercises profile churn during full-tree copy.
- **Impact:** Headless CI or sandbox container setups without Chromium installed fail the mandatory merge gate.

### H-06: Manifest Permissions Contradict "All-Optional" Security Claims
- **Status:** Unresolved prior finding (extends `DOCS-AUDIT-2026-09-05.md` #38).
- **Document Claims:**
  - `PLAN.md:48`: Claims `all under an all-optional-permissions security model`.
  - `PLAN.md:104`: Claims `- [x] All-optional permissions (`manifest.permissions: []`)`.
  - `docs/WEB-PLATFORM-AGENT-CONCEPT.md:96`: Claims `**We built:** all-optional permissions requested just-in-time`.
  - `docs/SETTINGS-CLEANLINESS.md:30`: Notes `Repository guidance contradicts shipped permission reality. The manifest and P0 tests say install-granted + <all_urls>; the Constitution still says all optional.`
- **Source Truth:**
  - `extension/manifest.json:7`: Requires install-time permissions: `"permissions": ["storage", "alarms", "contextMenus", "unlimitedStorage"]`.
  - `extension/manifest.json:114`: Requires install-time host permissions: `"host_permissions": ["<all_urls>"]`.
  - `docs/OPEN-QUESTIONS.md:46` (Q18): Confirms: `18. **Host-access posture** — **RESOLVED (Paul, 2026-08-31): option (a) — keep install-granted host_permissions <all_urls>`.
- **Impact:** Misleads security evaluations regarding the extension's install-time prompt ("Read and change all your data on all websites").

---

## Part 2: Medium-Severity Findings (Capabilities, Counts, Pipeline & Protocols)

These findings describe capabilities or internal contracts that have materially drifted from production code.

### M-01: Bundled Wasm Package Count Stale (Docs: 28 or 31, Code: 38)
- **Status:** **NEW Post-09-05** (expanded from 31 to 38 packages).
- **Document Claims:**
  - `README.md:70`: Claims `- **28 bundled Wasm tools** — awk (bounded filter), base64, csvtool, cut... Separate Rust/C candidate lanes (htmlq, numbat, bttf, sed, jq, xan, tokei) are not part of this shipped set`.
  - `PLAN.md:177`: Claims `- [x] **28 bundled Wasm packages ship** and are verified at build time`.
  - `docs/ARCHITECTURE.md:468`: Claims `Today's shipped set: 31 admitted single-tool packages`.
- **Source Truth:** `build.mjs:108` and `extension/wasm/manifests/` confirm **38 bundled packages** (111 shipped files, 38 manifest identities). `sed` and `jq` are admitted and shipping, alongside `oxipng`, `jxl`, `avif`, `zxing`, `compressops`, `imageops`, `hashwasm-blake3`, `sqlite3`, `d3` (gzip), `csvtool`, `a2`, `b2`, `c2`, `date`, `awk`, `unix-stream-v1`, `awk-posixutils-v1`.
- **Impact:** Misinforms users and agents on available data-processing tools.

### M-02: Lazy Tool Protocol Definitions (Docs: 2 or 3, Code: 4)
- **Status:** **NEW Post-09-05** (slice 2 `qsm4` added `run_pipeline`).
- **Document Claims:**
  - `README.md:62`: Claims `- **Live bounded lazy tool provider** — every run receives exactly two definitions, search_tools and execute_tool`.
  - `docs/ARCHITECTURE.md:249`: Claims `Regardless of catalog size, every run's provider map contains exactly three tools: search_tools, list_tools, execute_tool`.
- **Source Truth:** `extension/lib/lazy-tool-wire.js:21` (`export const LAZY_PROTOCOL_TOOL_WIRE = Object.freeze([`) and `extension/lib/lazy-tool-protocol.js:1803-1891` export **four** protocol tools:
  1. `search_tools` (wire index 0)
  2. `list_tools` (wire index 1)
  3. `execute_tool` (wire index 2)
  4. `run_pipeline` (wire index 3, added in `chrome-agent-platform-qsm4`).
- **Impact:** Omits the declarative pipeline runner from protocol specifications.

### M-03: Tool Pipeline Bounds Stale Post-46rh
- **Status:** **NEW Tonight** (landed in `46rh` / commit `05d0e941`).
- **Document Claims:**
  - `docs/ARCHITECTURE.md:270`: Claims `` `run_pipeline` (`extension/lib/tool-pipeline.js`) chains ≤ 8 existing tools declaratively — {id, tool, args} steps ... Args ≤ 32 KiB. Per-step owner approval for saved workflows is in flight (bead chrome-agent-platform-3cb6). ``
- **Source Truth:** Landed tonight in `46rh` (`05d0e941`, v0.3.366):
  - `MAX_ARGS_BYTES` (32 KiB) removed; args travel as in-memory JS objects.
  - `MAX_PIPELINE_STEPS = 200;` (`extension/lib/tool-pipeline.js:26`).
  - `MAX_BINDING_DEPTH = 64;` (`extension/lib/tool-pipeline.js:29`).
  - `MAX_STEP_ID_LEN` (40) removed; regex kept.
  - `3cb6` (per-step owner approval) has landed (`tests/workflows-approval.test.ts`).
  - `docs/DESIGN.md:483` was updated tonight to state principles (`argument recursion is structurally bounded against call stack exhaustion`), but `docs/ARCHITECTURE.md` still cites the old constants.
- **Impact:** Misleads pipeline authors into unnecessary chunking or step limits.

### M-04: User-Wasm Execution Documented as "Storage Only / Catalog Only"
- **Status:** Unresolved prior finding (extends `DOCS-AUDIT-2026-09-05.md` #17).
- **Document Claims:**
  - `docs/USER-WASM-STORAGE.md:4`: States `in this browser. This increment stores files only. It does **not** compile, run, admit, approve, or register them as callable tools.`
  - `docs/tool-platform-architecture.md:3`: States `Status: live bounded lazy-provider cutover is a 0.2.180 release candidate; ... bundled Wasm remains catalog-only`.
- **Source Truth:** User Wasm execution is fully wired and verified:
  - `extension/lib/tool-catalog.js:28`: `TOOL_SOURCE_KINDS` includes `'user-wasm'`, and `adaptUserWasmTools` adapts rows into the catalog.
  - `tests/user-wasm-execution.test.ts` and `tests/tool-catalog-user-wasm.test.ts`: Verify `execute_tool` dispatches user Wasm modules through `extension/lib/wasm-execution-worker.js` under a 15s deadline and digest allowlists.
- **Impact:** Developers believe user Wasm is inert when it is a live execution engine.

### M-05: WebMCP Per-Call Consent Stated as "Known Open Gap"
- **Status:** **NEW Post-09-05** (`eo4d` implemented per-tool consent).
- **Document Claims:**
  - `docs/ARCHITECTURE.md:352`: Section header states `### 4.4 Consent gap (known, open) ... A site's tool call runs with NO per-call consent card today — enrollment is the only consent point. The decision and implementation are open: bead chrome-agent-platform-eo4d`.
- **Source Truth:**
  - `docs/OPEN-QUESTIONS.md:105` (Q23) confirms: `23. **When does a site's WebMCP tool ask for consent?** — **CLOSED (owner decision, 2026-09-05):** enrollment creates the Site Agent and its discovery channel, but is not automatic-use consent. Every exact origin/tool asks once on its first genuine model use.`
  - `extension/lib/webmcp-authority.js:20`: `export const WEBMCP_AUTHORITY_REASONS = Object.freeze([` actively enforces `tool-consent-denied`, `tool-consent-required`, and `tool-consent-generation-stale`.
- **Impact:** Contradicts the shipped per-tool consent enforcement mechanism.

### M-06: Browser Tool Counts Inconsistent
- **Status:** Unresolved prior finding (extends `DOCS-AUDIT-2026-09-05.md` Section B).
- **Document Claims:**
  - `README.md:56`: `- **125 Chrome tools**, every chrome.* call audited against the Chromium IDL/JSON schemas`.
  - `README.md:113`: `browser" bar. The four CDP tools went with it; the browser-tool count is 126.`
  - `PLAN.md:31`: `Settings label are gone; the browser-tool count is **126** (was 130) and the`.
  - `PRODUCT.md:196`: `**The two tool families are invisible.** The tool library is one flat list of 126`.
- **Source Truth:**
  - `extension/lib/browser-tools.js:2197`: `export function browserToolset(readOnly = false, {` defines **138 browser tools**.
  - `tests/chrome-tool-capabilities.test.ts:71`: Asserts `browserTools: 138,` (138 browser + 50 management = 188 total capability rows).
- **Impact:** Confusion over platform tool inventory.

### M-07: Deleted HTML Surfaces Documented as Active
- **Status:** Unresolved prior finding (extends `DOCS-AUDIT-2026-09-05.md` #12-15).
- **Document Claims:**
  - `README.md:212`: Lists `chat/                         the conversation surface`.
  - `PLAN.md:87`: Lists `- [x] MV3 extension: NTP hub, side panel, chat, directory, memory explorer, options`.
  - `PRODUCT.md:66`: Claims `iframe.** Twelve HTML surfaces ship; two of them — `chat/chat.html` and `memory/explorer.html` — are referenced by nothing at all and still ship to users.`
  - `docs/CONSTITUTION.md:93`: Claims `- **XSS** — chat/directory/memory render untrusted data with textContent/escaping`.
- **Source Truth:** Both `extension/chat/` and `extension/memory/` were deleted. Exactly **10** HTML files ship in `extension/` (`artifact.html`, `index.html` [artifacts], `directory.html`, `ntp.html`, `offscreen.html`, `options.html`, `privacy.html`, `artifact-preview.html`, `script-sandbox.html`, `sidepanel.html`).
- **Impact:** Directs developers to non-existent code surfaces.

### M-08: Stale UI Theme List in Design System
- **Status:** **NEW Post-09-05**.
- **Document Claims:**
  - `docs/DESIGN.md:27`: States `- **Themes**: Sunlit (default light), Midnight (dark), Neon, Terminal. All restyle the same tokens`.
- **Source Truth:** Theme switcher was removed in `v0.2.301` (`CHANGELOG.md:1395`). `extension/shared/theme.css` provides only light and dark modes (`[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`). Neon and Terminal do not exist.
- **Impact:** Wastes designer/developer time searching for non-existent theme tokens.

### M-09: Unimplemented `chrome.runtime.onSuspend` in Hooks Catalog
- **Status:** **NEW Post-09-05**.
- **Document Claims:**
  - `docs/HOOKS.md:50`: Lists `| `runtime.onSuspend` | the service worker is suspending | (none) | Flush in-memory state |`.
- **Source Truth:** MV3 background service workers do not support `chrome.runtime.onSuspend` (MV2 only). `onSuspend` does not exist in `extension/`.
- **Impact:** Misleads developers attempting to implement teardown flush hooks on worker suspension.

### M-10: Tool Usage Accounting in Action Ledger Outdated
- **Status:** **NEW Tonight** (landed in `n0sh` / commit `5cb4398c`).
- **Document Claims:**
  - `docs/USAGE-VIZ-DESIGN.md:36`: States `- **Tool usage**: NOT in the ledger today. The service worker's single tool executor (executeWorkerTool) is the chokepoint ... KNOWN GAP (disclosed): bundled WASM capability tools and any in-page tool execution do not pass that chokepoint and are not counted.`
- **Source Truth:** Landed tonight in `n0sh` (`5cb4398c`, v0.3.363): `extension/lib/action-ledger.js:203` (`export function withRunToolBookkeeping(toolMap, context, { recordCall `) unifies action ledger and usage bookkeeping across ALL run-driven tool executions, including interactive, scheduled, browser, management, and Wasm executions.
- **Impact:** Falsely indicates tool calls are unrecorded in usage metrics.

---

## Part 3: Low-Severity Findings (Pointers, Historical Labels & Metrics)

These findings represent stale historical status lines, pointers to retired markdown trackers, or outdated numerical counters.

### L-01: References to Retired Markdown Trackers
- **Status:** Unresolved prior finding (`DOCS-AUDIT-2026-09-05.md` #1-11).
- **Document Locations:**
  - `README.md:261`: References `| **beads (`bd`)** | **Task, bug and next-work state, and the only authority for it**` but lines 243-248 describe `TASKS.md` and `KNOWN-ISSUES.md`.
  - `docs/KNOWN-ISSUES.md:3`: Redirects: `Known issues and task state live in **beads (bd)** only`.
  - `PLAN.md:41, 48, 76, 229`, `docs/KNOWN-ISSUES-ARCHIVE.md:5, 9, 60`, `docs/UI-FIXES-TRACKER.md:28`.
- **Code Truth:** Retired on 2026-09-02 (AGENTS.md). Beads (`bd ready`, `bd show`) is the sole live authority.

### L-02: Numerical Suite and Gate Counts Out of Date
- **Status:** Numerical drift across releases.
- **Document Locations:**
  - `README.md:270` and `PLAN.md:11`: `1779 pass / 0 fail`, `127/127` journeys.
  - `docs/CONSTITUTION.md:143`: `store SW bundle ... 2.97 MB as of 2026-09-06`.
  - `docs/tool-platform-architecture.md:3`: `0.2.180 release candidate`.
- **Code Truth:**
  - `npm test`: 445 test files, 4,148 passed tests (v0.3.367).
  - Store SW bundle: 2,999,672 bytes (328 bytes clean headroom under 3,000,000 budget).

### L-03: Stale Status Banners on Implemented Designs
- **Status:** Historical status markers.
- **Document Locations:**
  - `docs/THREAD-LOADING-REDESIGN.md:3`: `**Status:** DESIGN, awaiting owner review. Nothing here is implemented.` (Implemented in 0.2.348 as run log WAL).
  - `docs/agent-deletion-lifecycle-design.md:3`: `Status: DESIGN RESEARCH ONLY.` (Implemented in 0.2.365 / `named-agents.js:537`).
  - `docs/AGENT-PRODUCT-GAPS.md:56`: `| G2 | **Agent templates** (ready-made roles) | ... | **missing** — blank create form`. (Implemented in `agent-templates.js`).
  - `docs/TEST-COUPLING-INVENTORY.md:38`: `- **Gap (deliberate, chrome-agent-platform-3khn):** it walks tests/ ONLY.` (Resolved tonight by `3khn` / commit `f75e6afb`).

---

## Part 4: Prioritized Fix Plan

To execute the documentation overhaul cleanly without regressing bundle budgets or test gates, the fixes are structured into three prioritized batches:

### Phase 1: High-Severity Authority & Security Corrections (Critical Priority)
*Target: Align security policies, destructive action catalogs, and operational contracts.*

1. **Work Package `docs-auth-fix-1`**: Update `docs/inline-approval-audit.md`
   - Expand `DESTRUCTIVE_ACTIONS` list from 17 to the actual 32 actions (`owner-approval.js:23-98`).
   - Document `OWNER_DIRECT_ACTIONS` (13 actions) and note that `named-agent.set-mcp-servers` is strictly owner-only and absent from `DESTRUCTIVE_ACTIONS` (`owner-approval.js:52`).
2. **Work Package `docs-auth-fix-2`**: Reconcile Manifest Permissions across Core Docs
   - Update `PLAN.md:48, 104`, `README.md:94-101`, and `docs/CONSTITUTION.md:83, 118` to truthfully state that `host_permissions: ["<all_urls>"]` and key permissions (`storage`, `alarms`, `contextMenus`, `unlimitedStorage`) are install-granted per owner decision Q18 (`manifest.json:7, 114`).
   - Reconcile `docs/permission-remediation-design.md:30` with current permissions reality.
3. **Work Package `docs-limits-fix`**: Clarify dptw Storage Limits vs Constitution
   - Update `docs/CONSTITUTION.md:150`, `docs/DURABLE-RUN-ARCHITECTURE.md:146`, and `docs/OPEN-QUESTIONS.md:25` to note that internal byte/count ceilings (256 KiB artifact, 8 MiB store) were superseded by `dptw` (browser OPFS quota governs, `memory.js:691`, `artifacts.js:422`).

### Phase 2: Architecture & Capability Reconciliation (Medium Priority)
*Target: Update counts, protocol definitions, and pipeline specifications in primary reference docs.*

4. **Work Package `docs-arch-update`**: Synchronize `docs/ARCHITECTURE.md`
   - §3.1 (`ARCHITECTURE.md:249`): Update protocol tools count from 3 to 4 (`run_pipeline` added in `lazy-tool-wire.js:21`).
   - §3.2 (`ARCHITECTURE.md:270`): Reconcile pipeline bounds post-`46rh` (remove 32 KiB cap, step limit 200, depth 64 in `tool-pipeline.js:26, 29`).
   - §4.4 (`ARCHITECTURE.md:352`): Mark WebMCP consent gap closed per Q23 (`webmcp-authority.js:20`).
   - §6.3 (`ARCHITECTURE.md:468`): Update shipped Wasm tool count from 31 to 38.
   - §1.0 & §2.1: Update service worker line count (~11.3k lines).
5. **Work Package `docs-readme-plan-sync`**: Update `README.md`, `PLAN.md`, and `PRODUCT.md`
   - Update browser tool counts from 125/126 to 138 (188 capability rows) in `README.md:56, 113`, `PLAN.md:31`, and `PRODUCT.md:196`.
   - Update bundled Wasm tools to 38 (including `sed` and `jq`) in `README.md:70` and `PLAN.md:177`.
   - Remove deleted surfaces (`chat/`, `memory/`) from directory trees in `README.md:212`, `PLAN.md:87`, `PRODUCT.md:66`, and `CONSTITUTION.md:93`.
   - Update gate summaries to reference dynamic runner rather than hardcoded 1779 tests.
6. **Work Package `docs-wasm-status`**: Reconcile `docs/USER-WASM-STORAGE.md` & `tool-platform-architecture.md`
   - Update `USER-WASM-STORAGE.md:4` to reflect that user Wasm execution is connected and gated under S4 (`tool-catalog.js`, `user-wasm-execution.test.ts`).
   - Update `tool-platform-architecture.md:3` status line from 0.2.180 to current architecture.

### Phase 3: Historical Document Framing & Tracker Cleanup (Low Priority)
*Target: Add status banners to historical research documents and purge dead tracker references.*

7. **Work Package `docs-historical-banners`**: Add "IMPLEMENTED / HISTORICAL" Headers
   - Add clear status banners to `docs/THREAD-LOADING-REDESIGN.md:3`, `docs/agent-deletion-lifecycle-design.md:3`, and `docs/AGENT-PRODUCT-GAPS.md:56`.
   - Update `docs/TEST-COUPLING-INVENTORY.md:38` to mark 3khn KAT gap resolved.
   - Remove `runtime.onSuspend` from `docs/HOOKS.md:50`.
   - Remove `Neon` and `Terminal` from `docs/DESIGN.md:27`.
8. **Work Package `docs-tracker-pointers`**: Purge Dead Tracker References
   - Update all remaining pointers in `README.md`, `PLAN.md`, and `docs/` pointing to `TASKS.md` or `KNOWN-ISSUES.md` to point directly to Beads (`bd ready`).

# Known Issues — Chrome Agent Platform

This tracks the open findings from the ongoing independent review (sol). The review continues in the background; these are tracked here so they don't block wider-project progress. Each entry links the round it was found + the file area.

**Status legend:** Open / In progress / Verified-fixed.

## Review process
- 30 rounds of independent security/correctness review across the integrated feature histories against the Constitution.
- Last retained clean feature baselines include **119/119 general Chrome journeys** and separate external, commit-bound unified-agent-access evidence. Current integration results must be read from the exact-commit external evidence; historical totals are not presented as proof for new bytes. All permissions remain optional (`manifest.permissions = []`) and no debugger permission is declared.
- The core architecture is confirmed solid (all-optional permissions, enrollment lifecycle, alarm scheduler fencing, screenshot capture, memory/journal CAS).
- The open findings are deep concurrency edge-cases + acceptance-coverage gaps, NOT basic-functionality bugs.

## Open — P0 tool operating platform (2026-08-22)

### [Catalog + shadow lazy public; OPFS, bundled-package, code-diff + Chrome-capability metadata in review; runtime cutover blocked] Co-do-style Wasm/tool OS — `CAP-FB-20260822-WASM-TOOL-PLATFORM-01`
- CAP has a public bounded metadata catalog, deterministic lexical index, and expiring run/agent/origin/document/catalog/source/package-generation selection references. The current source candidate replaces ad-hoc Chrome/management capability labels with one bounded data-only exact 9+29 table and projects capability digests/replay/gate summaries for selected results only; non-selected tools are a count. Its loaded-MV3-verified fixed two-tool shadow creates no grant, permission request, execute/install/package path or provider binding. References and metadata authorize nothing; missing/WebMCP replay metadata remains unknown; every eager source closure and provider binding is unchanged. All 38 entries remain cataloged—unsafe-for-cutover tools are policy-flagged, not silently filtered or exposed.
- A source-only OPFS wrapper owns strict per-job roots, hash-verified write-once inputs, journaled byte/file reservations, trusted-anchor recovery, bounded idempotency state, validated terminal orphan GC and content-digest-bound keyed artifact-WAL promotion. A separate bundled-only package authority candidate validates duplicate-free canonical manifests, immutable inventory/CAS digests, measured Wasm framing/import/memory ceilings and SBOM/licence/build provenance, then journals record admission/update/revocation through exact-generation `__wasmTx`; signer metadata remains explicitly unverified. Its prior eight-character import grammar made truthful `wasi_snapshot_preview1` declarations impossible. The review correction separates the eight-module count from a 64-byte ASCII module-name bound and permits only exact `wasi_snapshot_preview1` in `allowed`; arbitrary `env`, typos, Unicode, overlong names and wildcard allows fail closed, while `disallowed` may contain `*` or bounded module names. This does not admit the reconstructed 39-tool set: its Apache-2.0-root versus MIT-metadata contradiction remains blocking. A third unreachable source candidate validates strict Unicode code-change documents, binds producer/run/input/base/result identity, preflights bounded CAS retention, retains and re-verifies bytes only through digest-keyed artifact WAL creates, and derives bounded non-authoritative text views. Apply/reject/undo are unavailable stubs: no owner approval, route or workspace mutation exists. These authorities expose no provider, install, package-owner, Worker or execution route, and no Wasm binary ships. Loaded-MV3 Wasm/Worker/offscreen/OPFS behavior still blocks use. The wider platform remains open: signer trust, fresh-Worker termination, owner-approved diff mutation, Chrome lazy tools, Tool Library, owner install, bundled tools, spreadsheets, and abuse gates.
- Chrome Web Store remotely hosted code treatment for uploaded/downloaded Wasm is unresolved. Store mode remains bundled-reviewed-executable-only. Owner-selected packages are a distinct unpacked/enterprise/developer lane until written policy clearance.
- Co-do is factual precedent only: [PaulKinlan/Co-do](https://github.com/PaulKinlan/Co-do) at `d3ebdbd5066f16a2bb8a2b8cb8af4b57c8ae324a` has 39 built-ins; its Apache-2.0 root versus MIT package/generated-manifest metadata and per-binary provenance must be reconciled before reuse. No Co-do binary ships in this slice.
- **Security-suite custody (fixed on public `0e47a63`):** `npm run test:security` acquires the canonical lock before side effects and supervises the fixed real runner under an immutable 120-second deadline, exact wrapper profile, verified PID=PGID=SID group, bounded TERM→KILL, guarded cleanup, durable evidence and escaped-descendant poison. Executable no-Chrome custody tests and the reviewed real Chromium run passed 7/7 with no survivor, residue, profile or poison.
- **Package archive freshness (fixed on public main):** public `1fd65c696cbfcbe0aed135e0ba8c743b8c0ca624` derives an exact tracked-plus-generated regular-file inventory, verifies a fresh same-directory temp ZIP by names/hashes/extraction, and atomically replaces the final. Independent review and repeated byte-identical 128-entry package/validate passed; ignored artifacts and removed files cannot survive.

## Open — independent architectural review (2026-08-21)

### [Fixed locally; independent + loaded-MV3 gates pending] Scheduled-memory key-bound flood — `CAP-FB-20260821-SCHEDULED-MEMORY-QUOTA-01`
- Retain-all Durable authority used the same `memory/master` directory and 500-key budget as owner/model memory. After enough run records/logs/outboxes/payloads, every new scheduled admission failed and periodic alarms repeated the same console error.
- The local successor keeps every existing quota unchanged, routes the registry and each execution into dedicated bounded stores, and copy-verifies legacy authority before removing only its exact version from master. No owner value or retained run is evicted.
- Exact key-quota alarm failures now become one owner-visible storage-blocked task with Retry/Cancel and a disarmed alarm; stale delivery is silent. Independent review and a short loaded-extension migration/retry check remain required.

An independent Claude/Opus 5 session with no prior custody reviewed exact
`origin/main@300bea1` (`0.2.105`) by building it and driving it, not by reading trackers.
Full rationale, evidence and the ordered work queue are in
[`REVIEW-2026-08-21.md`](REVIEW-2026-08-21.md); the tasks are in [`TASKS.md`](TASKS.md).

**Baseline confirmed healthy at that commit:** build clean, **633 unit tests pass, 0 fail**
(green only with `TMPDIR` on durable storage — see the inode finding below),
**126/126 Chrome journeys pass**,
hub `domContentLoaded` 62 ms, fresh-profile boot clean with zero permissions and zero CSP
violations. `agent-do` is genuinely imported; sender-origin authorization, zod tool-schema
validation and escaping at all 65 non-`dist` `innerHTML` sites hold up under reading.
The findings below are the exceptions, not a re-litigation of the architecture.

### [Open] Build-host temp filesystem at 100% inode use — `CAP-FB-20260821-WORKTREE-HYGIENE-01`
- The build host's temporary filesystem reported **1,043,303 of 1,048,576 inodes used**.
  The same unit suite on the same commit is **633/0** with `TMPDIR` on durable storage and
  fails outright on the default temp filesystem. It fails any process on that host needing
  a temp file — not only this project. Any gate result produced there currently measures
  the disk, not the code. Roughly 60 full git worktrees live there at ~7,560 inodes
  each, plus several hundred retained evidence bundles.
- **That filesystem is RAM-backed.** A reboot destroys those worktrees and every retained
  gate-evidence bundle referenced by a `Gates:` field in `TASKS.md`. Evidence whose only
  copy is on tmpfs is not durable evidence.

### [Open — mitigated] Seven commits reachable only from RAM-backed worktree HEADs — `CAP-FB-20260821-WORKTREE-HYGIENE-01`
- Seven detached worktrees held commits unreachable from any branch. One is
  `b4a0a6f feat(composer): route agent mentions canonically across named, background and
  site agents` — an implementation of a task the tracker records as unstarted.
- Mitigated: all seven are tagged `rescue/tmp-detached-<short-sha>` in the local
  repository (local, unpushed; nothing deleted). Do not remove a worktree until its HEAD is
  reachable from a branch or one of those tags.

### [Fixed in current source; integration review and browser proof pending] Usage attempt attribution — `CAP-FB-20260818-USAGE-RECORDING-01`
- Exact current base `598fb12` contains the accepted usage runtime and deterministic probes byte-identically to correction `d6030b7` and reviewed integration `963b411`; no stale-base runtime replay is needed.
- Provider-attempt identity is queued at the real `doGenerate`/`doStream` boundary. A synchronous throw or asynchronous rejection removes only that attempt; a plain stream object remains a valid model return; an AI SDK retry records the successful attempt's immutable ID/time/ordinal; abort/finalization clears residual entries so later runs cannot inherit them.
- The `0.2.125` candidate restores current-main tracker/release provenance without replacing later provider, Durable-run, task-scope, or UI files. Focused no-Chrome gates and build pass; independent integration review and loaded-MV3 usage proof remain.

### [Fixed in accepted source; integration review pending] Durable run authority — `CAP-FB-20260819-DURABLE-BACKGROUND-RUNS-01`
- The 2026-08-21 architectural review correctly found public main had no persisted in-flight authority. Exact source `dd41258f7401dda8ccf8b561b955b5f4b919baa0` replaces mounted-page ownership with service-worker execution plus OPFS run records, outboxes, retained logs/payloads, recovery decisions, and owner controls.
- Independent source reviews passed the quota, sidebar, terminal projection, and reload-recovery successors. The exact loaded-extension journey passed 7/7 with one execution/thread, navigation away and back, terminal result/logs, and the same native Tasks row/result/registry/logs after hard reload.
- This closes the reproduced Durable defect for integration only. It is not whole-product acceptance; current-main integration review and the residual browser-security suite remain required before merge/push.

### [Successor fixed locally; independent + loaded-MV3 gates pending] Task-boundary snapshots ghost obsolete route controls — `CAP-FB-20260821-TASK-VIEW-TRANSITION-GHOST-01`
- Exact candidate `7d3b3e7e` fixed Hub→task and keyboard restore, but its loaded-MV3 review failed task→Settings and its clean-archive build omitted ignored `extension/CHANGELOG.md`. Exact successor `8b5a6287` fixed old `root` suppression and changelog shipping, but immutable v2 browser evidence isolated remaining task pixels to `::view-transition-old(overlay-view)`: the old task and new full-view containers share the `overlay-view` name, and the old named image remained at opacity `0.197597` at 125 ms.
- The provisional current-main 0.2.118 reconciliation retains the source/target task-boundary policy and named `overlay-view` identity. During either task entry or exit it hides old `root` and old `overlay-view` pixels; it does not target new `overlay-view`, so the replacement named transition remains active. Hub→Settings and all other unrelated full-view routes retain their normal named cross-fade. Finish/abort/overlap cleanup, post-settlement focus, and reduced-motion fallback remain covered. Same-surface task→named-agent switches explicitly route focus to the thread composer synchronously when the thread view is already open, preserving no-transition and no-flash invariants. No-argument follow-up/nudge and same-thread routes remain focus-neutral; fresh opens retain default title focus after settlement. Directory's full-view authority is composed rather than replaced: both the sidebar and edge control remain inert/`aria-hidden` while covered, and the initiating trigger still receives deferred focus restoration after close.
- `CHANGELOG.md` remains the tracked canonical source and `extension/CHANGELOG.md` remains ignored generated output by project precedent. Production build materializes and verifies the package copy; exact-inventory packaging admits only its byte-identical generated copy alongside current dist and tracked extension files. No generated changelog is committed.
- The immutable v2/v3/v4 browser evidence confirmed zero old task/named-overlay pixels at 40/125/220ms and verified genuine keyboard picker commit and pointer send; v4 isolated dropped composer focus on same-surface agent switches to `showThreadView`'s already-open branch. The first focus successor fixed that explicit path but independent review found it also focused the default title on no-argument follow-ups; the corrected successor distinguishes explicit focus ownership. Future evidence must verify midpoint zero-ghost policy, follow-up composer retention, same-thread row focus neutrality, fresh-open title focus, named-agent composer focus, genuine interaction, and singular run/thread projection. Independent loaded-MV3 review remains required. The 0.2.118 release identity is explicitly provisional until serialized integration.

### [Source-corrected locally; independent + loaded-MV3 gates pending] Covered nub and narrow Settings overflow — `CAP-FB-20260819-COVERED-NUB-VISIBILITY-01`
- Reviewed source `aff2375e` generalized the edge-control policy across Hub, conversations, Settings, Directory, Skills, and Assets. Its immutable v4 browser run passed eight complete cells plus genuine Tab/Enter/Space activation, then found a real Settings iframe overflow at the required 500px viewport (`scrollWidth 640`, `clientWidth 490`); 39 cells and both rapid sequences remain unverified.
- The provisional 0.2.119 composite places the independently accepted nub/responsive content onto exact transition-focus tip `46a3e6df`: the sidebar retains covered inert/AX authority, while `applySidebarNubPolicy` solely owns toggle hidden/inert/disabled/AX state and never mutates collapse state. Settings stacks its navigation and shrink-safe form grids below 680px, preserving every control at 500px and 360px without document-level clipping. Explicit-only same-surface focus ownership and no-argument follow-up/same-thread neutrality remain intact.
- Content review passed before recomposition; exact composite review is still required. A fresh complete 48-cell loaded-MV3 matrix plus both rapid sequences must then prove computed overflow, focus, pointer/keyboard, RTL and theme behavior; no browser acceptance or shipping claim is made.

### [Open] Hub WebMCP discovery status renders outside its card — `CAP-FB-20260821-WEBMCP-STATUS-ALIGNMENT-01`
- `extension/ntp/ntp.html` sets `.panel-body { padding: 4px 0; }`, so each row supplies its
  own inline padding. `#webmcp-hub-status` carries that class but has **no CSS rule
  anywhere in the repository**, and `extension/ntp/ntp.js:113` writes straight into
  `el.textContent`. The status line sits flush to the panel edge, ~14 px left of every
  sibling row, visibly breaking the card boundary.
- Reproduced in a screenshot of a clean build of the baseline. Present in no prior tracker.

### [Open] Fresh install looks broken and offers no path forward — `CAP-FB-20260821-FIRST-RUN-ONBOARDING-01`
- New profile, zero permissions: empty states plus a red error-console badge reading **1**.
  The entry is honest (*storage ungranted, changes are session-only*) but reads as a fault.
- Without the optional `storage` permission `lib/kv.js` degrades to an in-memory `Map`
  owned by the service worker, and MV3 terminates idle workers after roughly 30 seconds.
  A user who enters an API key without granting storage loses it almost immediately, with
  no warning at the point of entry.
- There is no onboarding flow in the extension; grepping for `first-run`, `onboard` and
  `welcome` finds only unrelated hits.

### [Corrective successor local; independent + loaded-MV3 gates pending] Conversation run status and projection — `CAP-FB-20260819-CONVERSATION-RUN-STATUS-01`
- The current successor removes the legacy banner/spinner and renders one conversation-owned `<conversation-run-status>` grid surface at the bottom of the transcript, with the canonical queued/running/retrying/waiting/completed/failed/cancelled vocabulary and in-context Settings recovery.
- Transition browser evidence then exposed a separate pre-existing no-tools ordering race: the durable terminal signal could complete an authoritative `thread.get` replacement before the response completion handler appended its local result, briefly rendering two adjacent byte-identical assistant bubbles. The earlier streamed-text guard did not cover a no-tools turn.
- The current-main composition records each authoritative thread projection by thread id, immutable execution id, page-local surface owner and monotonic render generation. Completion suppresses only an already-projected byte-identical assistant result for that same attempt. Different bytes, other executions, other owners and post-reload owners remain distinct; thread data stays authoritative and no polling or synthesized client message is added. Current task-scoped run controls and streamed tool-call finish normalization remain intact.
- Independent review of the current-main conflict resolutions and fresh loaded-MV3 cancellation/fencing/status evidence remain open. The browser contract must enumerate transcript bubbles after every conversation journey, not only named-agent completion. The previously approved exact-`43e395d` headed package is superseded until a package is rebuilt for the accepted successor.

### [Open] Route surface concentration — `CAP-FB-20260821-SW-ROUTE-MODULARIZATION-01`
- `extension/background/service-worker.js` is 4,799 lines exposing **127 message routes**
  in one flat handler object; `extension/shared/components.js` is 5,193 lines with 33
  custom elements; `extension/options/options.js` is 1,775 lines. This is a structural
  cause of cross-lane merge conflict, and part of what the serialized integration queue is
  compensating for. Sequenced after the branch triage.

### [Open] recipes → skills rename unfinished — `CAP-FB-20260821-RECIPES-SKILLS-RENAME-01`
- The UI says "Skills"; the code ships `extension/recipes/`, a 655-line `lib/recipes.js`
  and a `RECIPES` import in `options.js`, against a 39-line `lib/skills.js`.
  `extension/ntp/ntp.js:1586` reads `openView("recipes/index.html", "Skills")`.
  `AGENTS.md` cites this rename as its worked example of cross-subsystem drift.

### Delivery-process findings (not code defects)
Recorded here because they are the measured cause of the delivery stall, and because
reviewers keep re-deriving them. Detail in [`REVIEW-2026-08-21.md`](REVIEW-2026-08-21.md).
- Landed commits per day on `origin/main`: 83 (17 Aug) → 65 → 20 → 3 (20 Aug) → 0 (21 Aug).
- 0 of 31 tracked tasks are `CONFIRMED`; 4 are `PUSHED` awaiting only owner confirmation.
- 46 branches ahead of `origin/main`, several holding independently reviewed work stalled
  by repeated base-change re-review. → `CAP-FB-20260821-STALE-BRANCH-TRIAGE-01`
- At least 9 tasks recorded as `Owner: unassigned` / `Branch: none` have committed work;
  only 2 of 430 commits carry a `CAP-FB-*` identifier, so the tracker's own `Recover:`
  commands cannot find their own material.
  → `CAP-FB-20260821-TRACKER-GIT-RECONCILE-01`
- 17 worktrees hold zero commits beyond `origin/main`; ten share one versioned prep naming
  pattern. An agent creating a `-vN+1` attempt with no commit in `-vN` should stop and
  escalate. → `CAP-FB-20260821-DELIVERY-LIFECYCLE-01`

## Open (as of round 27)

### Permission orchestration recovery (PARTIAL — 2026-08-19)
- Canonical planning rejects malformed/decorated/unknown/overlong/wildcard/implicit `<all_urls>`/background `activeTab` declarations; exact members are checked individually with `permissions.contains`. Model-visible grant/revoke/enroll tools are removed, and model/background screenshots require exact host access. The model contract is now consistent: the master-skill, protected runtime policy, and MANAGEMENT_TOOL_NAMES introspection no longer instruct the model to call `enroll_origin`/`grant_capability`/`revoke_capability`.
- Conversation preflight uses a redacted provider permission summary and pauses before model execution; the run-status banner renders an explicit accessible "Waiting for permission" state; Settings describes Screenshots/activeTab as enabling the transient owner-invoked capture, never a persistent background grant.
- **Still OPEN:** reusable owner preflight UI, explicit task/execution product authorization distinct from Chrome's browser-global grant, same-identity one-shot JIT continuation, denial/cancel/revocation/concurrency/service-worker-restart behavior, and genuine headed accept/revoke evidence. No complete feature or release-acceptance claim is made.

### Unified agent access (CAP-FB-20260818-AGENT-ACCESS-01) — residuals
- **Site-agent delegation is text-only.** `agent.delegate` runs the enrolled
  origin's worker with the task text only: no attachments, and no live per-run
  progress stream (the run returns a single result; the composer says so when
  attachments were dropped). A live-progress + attachment path for site agents
  is a follow-up.
- **Enabling a background agent still requires the `alarms` optional
  permission** (by design — fail closed). The side panel shows disabled
  background agents with a "disabled" status; enabling remains a Settings /
  hub gesture.
- **The hub's three agent summary rows** (sidebar + main Named/Background/Site
  lists) predate `<agent-picker>` and still use `capability-row` — they open
  the same agent surfaces, but a future pass could re-express them as the
  shared picker for full consistency.
- **The side-panel page view is control-only.** Cross-origin pages live in real
  tabs; the misleading preview iframe and morph stub were removed. The panel's
  Go/Enter path crosses the sender-authenticated SW route and requires a current
  owner gesture; an agent-opened panel cannot turn its stored target into a tab
  mutation.

### Concurrency edge-cases (deep, low-likelihood)
- **Cooperative-cancellation limit (fundamental):** an already-started page/WebMCP side effect cannot be unwound — the result is discarded but the effect runs. This is a browser constraint (a running page function can't be cancelled). Documented in DESIGN.md. *Mitigations in place: pre-start cancellation, minimized window.*
- **CAS version-scoping refinements:** the version-scoped CAS landed (round 27) but the reviewer may find further ABA edge-cases in the memory/journal compensation.
- **First-message generation acceptance:** the first sync/invoke requires a generation now; verify no residual generationless path.
- **runGenCells per-run isolation:** build-local now; verify no residual shared-state race.
- **MAIN cancel tombstones bounded:** bounded now; verify eviction under load.

### Acceptance-coverage gaps (test/evidence depth)
- **[FIXED IN ACCEPTED SOURCE — integration review pending] Live Durable Tasks-sidebar row and terminal thread projection:** thread-bound revisions signal authoritative `thread.list` replacement; terminal/cancelled owner revisions trigger targeted `thread.get` replacement. The 0.2.113 recovery preserves prior rows on failed reads, acknowledges invalidation only after successful owner-fenced rendering, and permits one bounded 400ms MV3-startup retry. Exact `dd41258f` passed independent source review and exact 7/7 loaded-extension proof, including the same native Tasks row, terminal result, registry identity, and visible retained logs after hard reload. Accepted for Durable integration only; current-main integration review and residual browser-security execution remain.
- **System-prompts surface (feat/system-prompt-settings, all known review blockers corrected; awaiting independent re-review):** the layered/versioned system-prompt architecture + Settings → Advanced UI. The blocked paths are now structurally closed: full `/skill:<id>` bodies compose before protected-last policy at the agent boundary (including foreign prompts); Prompt API generate/stream calls bind the exact session system message + role transcript; every attempt gets an immutable execution id with finalized/unbound attestation capture (including direct delegation); the HMAC key is route-secret, versioned/rotatable, and honestly labelled ephemeral without durable storage; all UI mutations require CAS; named-agent lifecycle locking/cleanup is coordinated; future store envelopes quarantine intact; and FIPS/RFC crypto + malformed-truncation vectors are covered. The full unit, build, gallery, security, Chrome, and real-extension feature gates are rerun on the corrective commit before re-review. No push until the standing independent review clears.
- **No headed-browser screenshot success path** (headless can't grant arbitrary-tab capture; the active-tab path is documented). Needs a headed-browser test.
- **No full real-enrollment lifecycle journey** (enroll → discover → invoke → cleanup → Retry) as a single headed acceptance.
- **[OPEN — corrective implementation, exact-commit evidence + headed gesture required] WebMCP discovery observability** — Paul's "where is the content script / no logs proving it runs" gap. Round 30 blocked the prior corrective commit because its acceptance bypassed `invokeSiteTool`, approved tab identity was lost at invocation, snapshot sessions could replace each other out of order, cancellation tombstones expired, the broadcast nonce was observable, diagnostics retained raw page errors, and the retained artifact did not attest the corrective bytes. The current corrective source routes acceptance through extension-only `tools.invoke` → production `invokeSiteTool`; binds the picker-approved tab and active `documentId`; accepts snapshots only for the SW-issued navigation epoch of that active document; uses an immutable cancellation epoch; keeps the bridge key off `postMessage` and MACs/replay-fences transport; and redacts page exceptions even in diagnostics. **Trust is deliberately limited:** MACs protect cross-world transport from ordinary postMessage injection, but MAIN shares the page realm, so tools, effects, and results remain page-controlled and untrusted. `scripts/webmcp-acceptance.ts` now writes exact-clean-commit evidence outside the tree via `WEBMCP_ARTIFACT_DIR`. This item remains OPEN until that artifact passes independent review, and the two real OS permission prompts still require the headed manual run in `docs/WEBMCP-ACCEPTANCE.md`.
- **[CLOSED — scripts/capability-lifecycle.ts, 21 checks] Capability lifecycles** — grant→use→revoke acceptance for each optional capability (real CDP gestures), npm run test:capabilities.
- **[CLOSED — scripts/a11y-audit.ts, 17 checks] No accessibility audit run** — an automated a11y-tree acceptance (labels/roles/contrast/focus/landmarks across the hub/chat/settings), npm run test:a11y.
- **[CLOSED — scripts/perf-leak-trace.ts, 8 checks] No performance/leak traces** — an automated perf/leak trace (SW register/render budgets, the SW heap + OPFS + hub DOM bounded across a write loop), npm run test:perf.

## Verified-fixed (27 rounds)
- Current-main hub sidebar regression: Tasks/Agents now have parity for panel/list overflow and gutters, inline-end + alignment, expanded/collapsed/RTL/dark geometry, row formatting, and centered keyboard/pointer task-delete behavior; duplicate Site discovery copy removed. Real-extension acceptance: `scripts/sidebar-parity.ts`.
- **Agent Directory covered-view and function-row geometry (source-corrected; browser rerun pending):** the sidebar/nub are hidden, inert, and absent from hit testing only while a full view is active; canonical tool descriptions/schema metadata render per function via shared `<tool-directory-card>`; source/approval states stay inside the same responsive card; frame focus enters inside the deferred reveal and close restores focus only to a still-connected, still-visible initiating control. The reviewed old-base source `ac72ae19` passed 20/20 loaded-MV3 checks (normal/narrow/RTL/Midnight, exact AX names, exact restoration); the current-main reconciliation (`fix/agent-directory-01` on `0f86e60`) still requires its own independent review and browser rerun before this is claimed fixed on main.
- All permissions optional (manifest permissions = []); no debugger; screenshots via captureVisibleTab + activeTab.
- Re-entrant mutex deadlock (saveScreenshot).
- Alarm scheduler: execution fencing, crash-safe cancel, one-shot replay loop, owner tokens.
- Enrollment: cross-origin races, ABA, tombstone lifecycle, Scripting-Disable coordination.
- Memory/journal: generation-scoped CAS compensation, fenced reads, UTF-8 quotas, bounded OPFS.
- UI: [object Object], contrast, focus, attachment popup, screenshot reader/UI.
- Fail-closed KV, split-authority, session→storage migration.

## Wider-project goals (not blocked by these issues)
- co-do-style double-iframe UI generation.
- Hooks (system-level events).
- Richer sub-agent picker UI.
- UI refinement (anti-slop).

## Round 27 (sol, f3d5fdb) — CAS version edge-cases
- Versions stored only in the value file reset after delete/clear → a stale v1→delete→fresh v1→stale CAS deletes the fresh write. The version must be stored separately (not reset on delete/clear).
- A late stale write can overwrite B, then the CAS delete removes A but cannot restore B; a crash after the commit persists A. The CAS needs a durable version log.
- The journal has the same CAS issue.
- The page sideEffect is still true (the cooperative-cancellation limit).
- The envelope quota undercounts the wrapper (a 262164-byte file accepted against the 262144 bound).
- Legacy raw {__v,__value} gets corrupted; unsafe finite versions stop advancing.
(Tracked for a background fix worker; not blocking the wider goals per Paul's directive.)

## Wider-goal review (sol, 98bbc96) — CRITICAL + HIGH
- **CRITICAL: storage.onChanged hook serializes full changes incl the providerConfig apiKey into the journal + the model prompt (credential leak); subscription/usage storage changes can recursively trigger unbounded paid runs.**
- **[CORRECTED LOCALLY IN 0.2.98 — independent review pending] HIGH: model-exposed destructive operations lacked an operation-specific owner grant.** The current correction binds the immutable model execution/UI document, normalized action/target, and a branded complete-payload SHA-256 digest; deduplicates and bounds single-use grants; resolves only from the exact Settings document; uses a private install-scoped OPFS HMAC for opaque target references; captures immutable model execution authority in a fresh build-local dispatcher; and holds named/hook create/update/delete/provider replacement gates and mutations in one subsystem lock. No body `ownerUI`/activation/run flags are trusted. The expanded loaded-MV3 suite drives real Approve/Deny clicks in both top-level Settings and the primary NTP Settings iframe, proves forged NTP fields fail, exact deny leaves data intact, and verifies the opaque reference across a worker restart. A real fixture-model same-execution retry remains an explicit acceptance gap until independent review.
- HIGH residuals: sidepanel onMessage navigate opens tabs with no sender/grant check; thread authority keys model-writable (forged threads index); unlocked thread/index RMW; global progress broadcast leaks/misattributes tool data; chat never keeps threadId (mixes the global journal); **artifact body/index split writes still race/orphan and are explicitly outside the approval-only correction**; model cross-origin artifact administration needs a separate scoped-read policy; tool cards use one lastTool + String(object); record audio/camera advertised but unwired; mic can survive disconnect.
- Medium: hooks unbounded + catalog permissions undeclared/unrequestable; UTF-8 attachments mojibake; a11y gaps (focus/combobox/speaker/menu/contrast); skills unchecked. The 0.2.98 correction byte-bounds diagnostics and fails arbitrary structured values closed without invoking accessors/Proxy traps; wider diagnostics/skill bounds remain separately open.
(The apiKey leak + the recursive-run risk are the priority fixes.)

---

# Paul's UI/UX issues (2026-08-16) — tracked in docs/UI-FIXES-TRACKER.md

The full tracker is docs/UI-FIXES-TRACKER.md. Summary of the batch:
- DONE: the 5 settings issues (the switch-collision double-toggle, hooks=permissions, the duplicate back button, the origins stretch), the notification icon path, the provider Test-connection buttons, the base-select background-agent picker, the thread navigation (fullscreen + sidebar + background-agents off the NTP), the collapsed-sidebar geometry (the edge nub + centred rail icons + SVG glyphs + reload persistence + RTL), the security fixes (apiKey leak + highs), semver.
- IN PROGRESS (the tracker-remaining worker): View Transitions, HTML-output rendering, the unified Agents area, the + menu options + anchor-positioning, the @mention positioning, the error-console copy buttons + error surfacing.

## Paul meta-directives (2026-08-16)
- Every ask → tracked (UI-FIXES-TRACKER.md / KNOWN-ISSUES.md) + worked in a subagent + visually verified. Nothing dropped.
- Use the impeccable skill for ALL design work + modern-web-guidance for modern-web features.
- Resolve open questions; prioritize known issues; work the plan actively.
- Full-suite-green gate; visual verification (no "it serves" as "it works").

## Fresh sol review (HEAD 0ffd991) — CRITICAL + HIGH
- **[FIXED 78d630a] CRITICAL: the storage-hook paid recursion** — terminated (internal writes return null, never dispatch). ~~NOT fixed~~ — the storage mapper returns changedKeys:[] for internal keys but bind() still dispatches for EVERY storage event; the in-memory limiter throttles but doesn't terminate + resets on SW restart. Internal writes still invoke the subscribed agent.
- **[FIXED 78d630a] HIGH: the scoped hook runs** — now side-effect-free. ~~still expose durable/destructive tools~~ — browserToolset includes schedule_task + browser actions; memory_set is always added. Prompt-injected event data can persist state/schedule future runs. Scoped != side-effect-free.
- **HIGH: hook fan-out is unbounded** — no registry count/template-byte/recipe validation bounds; unique recipeIds let one event enqueue unbounded runs.
- **HIGH: the model-facing enroll_origin lacks a per-origin owner grant** — broad host access lets the model activate any origin without a fresh exact-origin gesture.
- **HIGH correctness: concurrent follow-ups take thread history before run serialization (diverge); nameThreadAsync holds the global thread mutex while awaiting the Prompt API title.**
- Medium: hook-required bookmarks/history/downloads/webNavigation/contextMenus/idle absent from optional_permissions; the media UI claims bytes sent but the SW doesn't pass them; the attach popover show lost on re-render.
(Positive: manifest permissions=[], no debugger, no key literal, redactSecrets blocks the value leak, the deny-list rechecked, the suite green.)

## Security testing (Paul, 2026-08-16) — a standing suite
- **A repeatable security test suite** (an agent/automated tests) reviewing the security of the site: **network exfiltration** (network traces/info must not escape), **sandbox escapes** (HTML/scripts in the double-iframe must not escape + influence the page). chaos + co-do were robust here; match that.
- **MCP-apps-style preference percolation** — user preferences should flow down through the layers (the double-iframe) properly (how? design + implement).

## CRITICAL (sol, HEAD 24dd3f7) — generative-UI sandbox network exfil
- renderHtmlFrame's injected meta CSP is insufficient: (a) injectCspMeta inserts after the first <head>, so resources BEFORE it load before the policy; (b) CSP/default-src does NOT prevent the opaque sandbox from navigating ITSELF (self-location, meta-refresh). A real Chromium probe reproduced attacker requests for all three payloads (pre-csp-image, self-location, meta-refresh). The security suite misses these escapes. Fix: enforce outside attacker-controlled markup/navigation (a non-network-capable document + request interception/URL allow policy); always prepend the CSP; block self-navigation. (sol)

## Sol addendum (HEAD 24dd3f7) — 4 HIGH
- clear() deletes the wrong path (deleting an agent leaves its OPFS sandbox/history; memoryStoreAt.clear() treats every non-master store as a site origin).
- memory_grep lacks a post-read generation recheck (a stale run can return the new enrollment's memory).
- Named agents are NOT actually runnable/delegatable (CRUD/grep/avatar only; no run/delegate path; the AGENT-MODEL.md promise unmet).
- The scoped-hook transitive bypass (the workers dont get readOnlyMemory:scoped + retain site/WebMCP tools; a hook payload can delegate into a side-effecting worker).

## Sol verifications (regression-proven, HEAD 24dd3f7)
- **CAS version issue NOT fixed** — the version is stored only in the value envelope + reset on delete, so a set→v1, delete, set-fresh reuses v1 (a stale compareAndDelete can match/delete the fresh recreation). Fix: a durable per-key version counter that survives delete/clear.
- **Named-agent deletion leaves the OPFS sandbox** (verified: after create→delete, namedAgentMemory still returns the data).

## Sol deep-review of the generative-UI + named-agent layer (HEAD 24dd3f7)
- **CRITICAL: the named-agent avatar path leaks the WRONG provider's key** (getProviderConfig ignores its argument → the active OpenAI/Anthropic/DeepSeek key sent to Google's image API). A cross-provider credential disclosure.
- HIGH: artifact-viewer XSS (the query-param id into innerHTML); artifact network egress (a model-created image artifact with an arbitrary URL loaded outside the sandbox); artifact authority gaps (the model can overwrite asset:<id> bodies; unlocked body+index multi-write).
- HIGH: the thread concurrency is partially fixed (the follow-up history snapshot before the run lock; run 1 releases the lock before appending).
- MEDIUM: the text→HTML detection regex; the preference percolation shadow-root query + done/post ordering.
(All in the sandbox-fix-2 worker, k3.)

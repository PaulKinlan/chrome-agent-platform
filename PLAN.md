# Chrome Agent Platform — Plan & Status

The working plan for the fleet. Every agent/session reads this to see what's happening + where things are.

## The project
Chrome as the agent platform: a new-tab agent hub that orchestrates the web with
persistent named agents (each with its own OPFS sandbox), per-site sub-agents (WebMCP
tool discovery), the generative-UI artifacts surface, a skills system, agent-generated
repeatable scripts, and a system-hooks layer — all under an all-optional-permissions
security model. The README is the overview; THIS file is the single source of truth for
what's landed vs what's next.

## Principles (from the 2026-08-15 thread — NON-NEGOTIABLE)
- **Never accept "it serves" as "it works."** Every feature/fix is verified by driving the real behavior in a browser (CDP) with screenshots as evidence. A route returning 200 or a build passing is zero evidence.
- **Independent review before push** — a different model/session reviews the diff + evidence; vision review is one gate, not a substitute for code/security review.
- **Commit locally; push only after review clears.** No pushing skeletons.
- **Real libraries, not patterns.** agent-do is imported, not reimplemented. Providers actually work.
- **Honest absence** — if something can't be verified, mark it unverified; never claim it works.
- **No emoji icons** — inline SVG icons (line-art, currentColor).
- **Modern web guidance** throughout.
- **No external-project references** — usage-logging is an in-repo pattern, not a reference to another project.

## Independent architectural review (2026-08-21)

[`REVIEW-2026-08-21.md`](REVIEW-2026-08-21.md) verified the baseline by building and driving
exact `origin/main@300bea1`: build clean, 632 unit tests pass, **126/126 Chrome journeys**,
hub render 62 ms, fresh-profile boot clean. Code quality is not the constraint — delivery is.
Landed commits per day fell 83 → 65 → 20 → 3 → 0 between 17 and 21 August, with 0 of 31 tasks
reaching a terminal state and 46 branches of reviewed work unmerged. The review's §6 work
queue supersedes the ordering of the backlog below until its P0 items are cleared.

**Lifecycle change (Paul, 2026-08-21):** the nine-state delivery lifecycle is replaced by
`OPEN → IN_REVIEW → MERGED → DONE` with `BLOCKED`/`ABANDONED` off-ramps, and `DONE` no
longer requires a per-task owner interaction. Independent review by a different
model/session and real-browser verification are retained unchanged; the gate-evidence and
attestation machinery is removed. See `AGENTS.md` for the normative rules.

## Status (2026-08-17)
- [x] MV3 extension skeleton + NTP hub + side panel + chat + directory + memory explorer
- [x] Real agent-do bundled (esbuild) + process/global shims (SW registers, no errors)
- [x] Provider options — a DEDICATED settings pane (options page): Gemini/OpenAI/Anthropic/DeepSeek/Ollama/Prompt-API/demo, multi-agent (1-vs-N) hub, theme picker (4 themes), scoped browser-control grant, usage log, per-origin memory (Paul 2026-08-15: the inline dropdown was not a config pane)
- [x] Usage logging (per-call token/cost records, 7-day rolling window, aggregation)
- [x] Browser control + event listening (tabs, alarms, capture)
- [x] Recipes (4 pre-baked utility agents) + management tools (create/delete/list agents)
- [x] Glow effect (reduced-motion-aware) + theme picker (midnight/sunlit/neon/terminal, default sunlit) + mood board
- [x] Composer: "+" attach menu (file/audio/video/other), mic with Web Speech Recognition (in-button equalizer, dedup'd), Record audio + Capture camera
- [x] Omnibox integration (keyword → start a task)
- [x] SVG icons (no emoji)
- [x] Side-panel mechanism — the agent opens a real page in chrome.sidePanel + drives it via WebMCP (open_side_panel tool + sidepanel.getTarget/getTools routes) — landed 72e781a
- [x] Activity-log explorer — a browsable/searchable timeline of every agent run (per-agent + master, tool calls/results/errors) — landed ba83236
- [x] End-to-end task completion verification — a task runs a real model + produces a result + usage recorded (the e2e-task test + the real-browser OPFS verification) — landed 690188c + scripts/opfs-real-browser.ts
- [x] Per-agent provider config — an agent can have its own model/provider override — landed 690188c
- [x] The named-agent layer — every agent (named/site/background) its own OPFS sandbox (memory + history + skills + memory_grep); the master manages them — landed f8909c6/e28e600
- [x] The skills system — recipes → skills; a skill is INCLUDED in a task (/skill:<id>), attached to an agent, scheduled, or imported (the chaos skill-loader pattern) — landed f7a49fc
- [x] The co-do generative-UI (generate_ui + sandboxed double-iframe + the artifact system) — landed 7323a4c
- [x] The hooks system (the full chrome.* on* event catalog + the owner-only authoritative deny-list) — landed
- [x] The standing security suite (network exfil / sandbox escapes / prompt-injection blocked) — landed 9da411c
- [x] The component design system (20+ Web Components, the gallery) + the impeccable design (paper/teal, PRODUCT.md + DESIGN.md) — landed
- [x] Chaos-style semver (a post-commit hook auto-bumps the patch version after each commit) — landed
- [x] The BeautifulUI AI-native primitives (loading-state, thinking-trace, tool-chips, task-row, streaming-text, approval-card, prompt-bar) — landed 6adcfe6
- [x] The layered, versioned system-prompt architecture (lib/system-prompts.js — the single composition authority for every run type; lib/runtime-policy.js — the single authoritative protected-constraints source, enforced LAST after full referenced-skill bodies even for foreign caller prompts; Settings → Advanced with the built-in viewer, per-scope append/prepend/replace customization, the built-in-updated keep/reset/diff flow, mandatory mutation CAS + strict store quarantine + coordinated named-agent lifecycle, the context-aware preview, exact generate/stream provider-boundary capture, and unique-execution keyed attestations with versioned rotation/ephemeral labelling) — docs/SYSTEM-PROMPTS.md
- [x] Unified agent access (CAP-FB-20260818-AGENT-ACCESS-01) — canonical named:/background:/site: refs; redacted, revisioned `agent.registry` + lifecycle broadcasts; the ONE shared `<agent-picker>` for the + menu and strict-position `/agent`; stale/request/history race fencing; side-panel browse/history/task list with no iframe/stub; sender-authenticated, owner-gesture-gated real-tab navigation — integrated 2026-08-18 (`scripts/agent-access-journeys.ts`: 88 fixed real-CDP checks + external commit-bound manifest/screenshots)
- [x] Current-main hub sidebar parity — Tasks and Agents share fixed headers, intrinsic scrolling lists, stable expanded gutters, row tokens, and aligned + actions; the collapsed rail removes scrollbar width from content and centers task dots/agent avatars/actions; task X hover/focus/delete geometry and Site discovery copy are corrected (`scripts/sidebar-parity.ts`).

- [ ] **WebMCP discovery observability (Paul 2026-08-18) — OPEN (round-30 correction awaiting evidence/re-review).** Earlier rounds fixed startup sync, explicit tab picking, positive-opt-in `window.webmcpExpose`, source-threaded dispatch, strict schemas, singleton teardown, replacement snapshots, injection readiness, and attested-vs-page-reported status separation. Round 30 still BLOCKED completion: acceptance bypassed `invokeSiteTool`; invocation lost the approved tab; snapshots were not ordered by real document identity; cancellation fencing expired; the bridge nonce crossed an observable channel; diagnostics logged raw page errors; and retained evidence did not identify the tested bytes. The current source addresses those blockers with production `tools.invoke` → `invokeSiteTool`, exact approved tab + active `documentId`, SW-issued navigation epochs, immutable cancellation epochs, MAC/replay-fenced cross-world transport with the key delivered out-of-band, and diagnostics redaction. MAIN remains explicitly untrusted: page-owned tools/results are never described as attested. **No completion claim is made here:** exact-clean-commit browser evidence must be generated externally (`WEBMCP_ARTIFACT_DIR=… deno run -A scripts/webmcp-acceptance.ts`) and independently reviewed. The OS permission prompts additionally remain a headed manual gate (`--headed`; docs/WEBMCP-ACCEPTANCE.md).

## In flight (2026-08-19)
- **Task-view transition ghost correction (provisional current-main 0.2.116 reconciliation, `CAP-FB-20260821-TASK-VIEW-TRANSITION-GHOST-01`)** — exact `8b5a6287` hid old `root` and fixed clean-archive changelog shipping, but immutable v2 browser evidence proved shared `::view-transition-old(overlay-view)` still faded task controls over Settings at 125 ms. Reviewed successor `0d3199a` is reconciled by content onto Directory main `eed40358`: source/target direction policy hides old root plus only the old named overlay on every task enter/exit (Hub, Settings, Directory, Skills, Artifacts), leaves new `overlay-view` named/active, preserves unrelated named cross-fades plus cleanup/focus/race/reduced-motion behavior, routes focus synchronously to the composer on already-open same-surface agent switches, and keeps Directory's covered sidebar/edge inertness plus initiating-trigger focus restoration. Independent current-main review and corrected loaded-MV3 launch/Settings/restore/error/focus/genuine-pointer proof remain pending; the v2 harness syntax defect must be fixed and normal `durable-run-registry` Shadow DOM retargeting accepted. Reconcile this provisional release number during serialized integration.
- **Durable run authority and owner surfaces (0.2.113 integration candidate)** — exact source `dd41258f7401dda8ccf8b561b955b5f4b919baa0` / tree `80ca97f0c55cbd0e8a2c306b82764f3a4aa1a860` passed independent source review and the exact 7/7 loaded-MV3 journey. Service-worker/OPFS authority, outbox projection, bounded recovery, exact native-quota compensation, owner controls, live Tasks-sidebar rows, terminal owner-thread replacement, and reload recovery are accepted for integration. [The architecture reference](docs/DURABLE-RUN-ARCHITECTURE.md) binds the exact evidence and retains the v1-v39 limits. This is Durable-lane acceptance only, not whole-product acceptance; the clean current-main integration commit still requires independent integration review, and the residual no-Chrome browser-security suite remains to be run after that review.
- **Owner-bound destructive-operation approvals (0.2.98 local, no push)** — current-main correction has branded bounded canonical payloads, normalized targets, exact Settings-only resolution, single-use run/document-bound grants, install-scoped opaque references, one-lock named/hook replacement gates, trap-free diagnostic redaction, focused concurrency/security tests, and a 126/126 loaded-MV3 journey with genuine top-level + primary embedded-Settings approval/deny clicks. The prior 125-check evidence was invalidated and will be replaced with exact corrected-source evidence before re-review. Awaiting independent re-review; real fixture-model same-execution retry remains an honest acceptance gap. Artifact-store transactions are a separate lane and remain open.
- **Permission orchestration (recovery PARTIAL, 2026-08-19)** — least-privilege declaration validation, exact-host background screenshot gating, redacted provider preflight, and removal of model-visible grant/revoke tools are implemented. The required genuine owner preflight button, task/execution authorization, one-shot JIT continuation, denial/concurrency/restart handling, and headed Chrome acceptance remain OPEN; no complete orchestration claim is made.
- **WebMCP discovery correction + attestation** — implementation is awaiting exact-clean-commit automated evidence, independent re-review, and the headed permission-prompt gesture (see the OPEN item above + docs/WEBMCP-ACCEPTANCE.md).
- (otherwise none actively blocked — see the known-issues + the UI-fixes tracker for the polish backlog)

## Remaining work (the proactive backlog)
- Remove the Chrome Prompt API + Demo local from the settings provider picker (internal/testing only) — see the task backlog.
- The screenshot / media-capture permission flows (ask-on-need, not fail).
- The UI polish + the review backlog (see [docs/UI-FIXES-TRACKER.md](docs/UI-FIXES-TRACKER.md) + root [KNOWN-ISSUES.md](KNOWN-ISSUES.md)).
- The extension rename/packaging (still "Chrome Agent Platform").

## Open questions for Paul
- The extension rename/packaging (still "Chrome Agent Platform").

## Feature: Artifacts (Paul 2026-08-16)
Agents create things for the user in the context of a task (generated pages, files, UI, data). We need:
1. **Per-task artifact view** — see the artifacts a task produced, in the conversation.
2. **Master artifacts view in the hub** — all artifacts across tasks/agents.
3. **Use artifacts** — open/preview/use them.
4. **Attach to a new task** — the + button should offer existing artifacts as attachments (so a task can build on a prior artifact).
Artifacts are origin-keyed (per-agent) with a master index. Types: generated page (HTML), file, data, screenshot, UI fragment. This connects to the co-do double-iframe generative-UI work (a generated UI IS an artifact).

## Task backlog (Paul 2026-08-17)
- Remove the Chrome Prompt API + Demo local from the settings provider picker (internal/testing only).
- (The UI-FIXES-TRACKER.md has the full UI batch.)

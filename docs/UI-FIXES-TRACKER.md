# UI Fixes Tracker — Chrome Agent Platform

Discipline: every Paul ask → an entry here → a subagent fixes + VERIFIES in the real extension → checked off. Nothing dropped. Stale/duplicate entries are a defect.

**Reconciled 2026-08-17 against the current code (HEAD 431bf59).** Items below are grouped; each is verified against the committed code, not the worker's claim.

## Done (verified in the committed code)

### Settings
- Duplicate back buttons removed (a single back path).
- The "Multiple agents" + "Browser control" + hooks toggles use the shared `<switch-toggle>` Web Component (the root cause was a hand-rolled `<label class="switch">` colliding with theme.css — fixed).
- The hooks section matches the permissions `.perm-row` grid (no layout shift on deny).
- The sticky sidebar nav + the "Back to hub" (single).
- The per-provider model selector (current model lists per provider + an OpenAI-compatible + a working Custom… text input).
- The "Test connection" button per provider (a real round-trip + the specific error).
- Chaos-style semver (scripts/bump-version.mjs + the post-commit auto-bump).

### Hub / sidebar / task list
- The task sidebar (expand/collapse to an icon rail, tooltips, the + new-task button).
- The collapsed-rail task X (visible on hover + deletes) + the 24px hit target.
- The task title single-line ellipsis + click-to-rename.
- The unified Agents area (Background + Site groupings; only ACTIVE background agents shown + a Configure link).
- Click a named agent → its view (history + run log) + talk to it.
- The background agents: independent, duplicable + editable (the built-in stays pristine), their own OPFS.
- The Recent activity shows WHICH agent did it.
- The ready indicator removed (cleaner header).

### The + menu (media + browser context)
- The + menu anchors to the + button (in-bounds, flips, no frame scroll).
- Add-tab → a tab picker (pick a tab, attach its contents/URL).
- Grab-screenshot → requests the origin permission then captures (captureVisibleTab).
- Record-audio / Capture-camera → request audioCapture/videoCapture on the gesture then capture.
- Record-screen → getDisplayMedia + a visible "Recording… ▸ Stop" chip.
- Add-window → removed (it just opened a new window).
- The media bytes reach the model (the multimodal image part) + render inline in the thread.

### Conversation / thread
- The unified thread surface (Run task → a full-screen thread; the sidebar persists; the current thread selected).
- A single visible view (the hub hidden + the body scroll frozen when a thread/overlay opens — no background scrollbar).
- The live run-status banner (Working… / Done / Failed + the live tool activity) at the BOTTOM of the thread.
- The subtle timestamps (a muted divider at ≥5m gaps / the first message).
- The readable tool-result summaries (not raw JSON).
- The comprehensive + actionable error reporting (the underlying reason + category + what-to-do).
- The thinking box at the bottom of the chat (the spinner).
- The task error logging (a failed task shows WHY, per-task + centralized).
- The / autocomplete (filters as you type, /skill: lists the skills, /task removed) + the @ autocomplete (named + background + site agents, delineated).
- View Transitions (element-morph, respecting prefers-reduced-motion).

### Artifacts / generative-UI
- HTML output renders in the sandboxed double-iframe (the CSP prepended + the self-navigation blocked).
- Click an artifact → "Open" (the view dialog), not "Run"; the reuse button works (overlay or clipboard fallback).
- The artifact gallery + viewer single header (no double back/h1).

### OPFS / memory
- The Data & memory OPFS explorer — a FILE-SYSTEM tree (Master / Named / Background / Site agents, keys as clickable files).
- The per-agent OPFS sandboxes (named/site/background isolated) + the memory_grep tool.
- The real-browser OPFS verification (npm run test:opfs).

### The + menu / popovers / console
- The error console: the per-line Copy + Copy-all + Clear buttons work (the shadow-root outside-click fix) + the panels close-others + they anchor to the trigger.
- The security shield: the granted permissions are removable.

## Open (genuinely remaining — action these)

1. **Browser-control toggle/grant persistence** — Paul flagged "STILL not working" after the item-51 fix; re-verify the toggle stays ON + the grant persists across a reload in the real extension, and fix the actual cause. (The grant-storage read/write is present; the persistence needs a real-browser proof.)

2. **Remove the Chrome Prompt API (Gemini nano) + Demo (local) from the settings provider picker** — both are for internal/testing use only. The picker filtering is IN FLIGHT (uncommitted); verify it lands + only the real chat providers show.

3. **WebMCP discovery** — the site agents still don't pick up the inferred/known WebMCP tools (Paul: not working). IN FLIGHT (scripts/webmcp-diag.ts); needs the fix + a real-browser integration test (a WebMCP page → the tools discovered), not a mock.

4. **Structured tool-call renderer** — ~~Paul flagged live tool calls in a running job show as ugly raw JSON (escaping/encoding artifacts) instead of a usable structured view. Reproduce in the ACTUAL loaded MV3 extension → implement a polished renderer~~ → **FIXED (2026-08-18)**. Ancestry is authoritative: `git log --reverse bdbe1f3..fix/tool-tree-renderer` lists the full feature lineage (worktree `/tmp/tool-tree-wt`); the tracker deliberately lists NO commit hashes (replacing amended-away siblings has produced false-ancestry churn). The exact frozen tip SHA is attested externally by the evidence manifest + metadata (`/tmp/gvs-final-evidence-<sha>`), which is HEAD-bound and never self-referential.
   - **Root cause:** the tool card rendered the args as a raw escaped JSON string (`JSON.stringify(args)` → `.tool-args` with `\"`/`\n` artifacts) and results could fall through to truncated `JSON.stringify`; no structured view, no timing, no bounds.
   - **Fix:** `extension/shared/tool-tree.js` (pure, DOM-free): `safeParse` (objects + a bounded decode of JSON strings incl. a defensive SECOND decode for double-encoded results, only when clearly JSON; never throws), `buildTree` (depth cap 6, node cap 200, per-container cap 50, string cap 400, truncated markers), `subtreeJson` (bounded copy-JSON). `message-bubble` now builds the card as DOM (createElement/textContent — never unsafe innerHTML): args/result/detail become an accessible collapsible key/value tree (`<details>` block + `<button>` toggles + `aria-expanded` + copy-value/copy-JSON per row), name/status/timing compactly (the `durationMs` from `onPostToolUse` now flows through `conversation.js` → `tool-duration` → "1.2s"), readable plain-text fallback, running state shows the tree immediately (no encoding-garbage flash), no emoji (SVG caret), DESIGN.md tokens.
   - **Tests:** `tests/tool-tree.test.ts` (36) — nested/arrays/escaped/Unicode/malformed/bounds/null-boolean-number/tool-error/adversarial/double-encode/dotted-empty-numeric keys/`__proto__`-as-data/cyclic-getter-BigInt safety/`safeJsonStringify` never-throws (hostile toJSON+toString)/cycle-vs-alias/atomic hostile ARRAY-PROXY/UTF-8 byte-cap envelope (valid JSON ≤ cap for every maxBytes incl. quote/backslash/non-ASCII)/canonical secret redaction (x-api-key + aliases)/root-string byte bounds/tiny-cap RangeError. `tests/tool-lifecycle.test.ts` (20) — queue/flush/error-wiring/`isToolResultFailure`/`pairToolJournal` (pairing, failed→error, FIFO, unpaired→done, legacy, absent-ok, run-isolation, unmatched-unique, same-name distinct callIds, same-type-only duplicates, terminal-row args restore, immutable-ID round-trip)/no-`[object Object]`. `tests/run-terminal.test.ts` (8) + `tests/agent-abort.test.ts` (19) — REAL mid-run abort durable flag, {ok:false, aborted:true} response, retry + queued-concurrency isolation, delegation unwrap (string contract), the PRODUCTION delegate_task failing an aborted worker (real orchestrator path). Targeted 83 (36 + 20 + 8 + 19). Full `deno test -A tests/` 404 passed, 0 failed; `test:security` 7/7.
   - **k3 review (2026-08-18) MEDIUM fixes folded in:** no phantom `0ms` (duration hidden until a real value); tool ERROR results wire to `tool-status=error` + in-flight cards flush on done/error/abort; dotted/empty/numeric-looking keys are segment-addressed (never split on `.`); a11y roles fixed (no incorrect `role=tree`; the card is not a 200-row live region — the compact status chip carries `role=status`); expansion persists across attribute updates; `__proto__` retained as data (`defineProperty`), cyclic/BigInt/getter paths guarded, copy/serialization failures caught; duplicate CHANGELOG entries cleaned.
   - **final-sol corrective commit `7d992d0`:** ABORT is authoritative for the OVERALL outcome (the SW propagates aborted in the run response — orch.isAborted + the fence signal; the terminal arbiter settles immediately on the response or the port final — NO timing dependency — and GATES the result append + done status); port DISCONNECT settles fail-closed + removes listeners; every retry attempt gets a UNIQUE runId (stale cross-attempt events rejected); the serializer is build-then-emit atomic (a hostile array proxy can't leave invalid JSON) + UTF-8 byte-bounded incl. the envelope + secret-like fields REDACTED; containerCap omissions always carry explicit __gvs_truncated__ metadata; no-Clipboard/execCommand reports failure; the replay key includes the run + duplicates flagged; scheduled-script journal rows match the schema (run/callId/ok — errors restore as error); the DETERMINISTIC demo tool-calling provider (@demo-tools) drives REAL tool calls through the PRODUCTION journal writer — the evidence runs a REAL @demo-tools task, persists the REAL tool rows (callId+run+ok), RELOADS, and a REAL CLICK on the persisted task reopens the thread with the RESTORED terminal cards (40/40 evidence incl. tree-5-reopen-thread.png + a HEAD-bound manifest).
   - **Residual risk (documented):** a fully live model-driven tool run is not reproducible in headless — the provider gate needs the provider's host permission and headless has no prompt UI to grant it (`chrome.permissions.request` hangs "pending"; `Browser.grantPermissions` + Preferences seeding are ignored for extension host grants); a real network provider still needs the provider host permission (not grantable headless) — the demo provider's deterministic @demo-tools mode now drives REAL tool calls through the production loop instead, so real persisted-tool evidence is produced in-headless. The render path exercised is the real appendTool/attribute + journal + thread-replay pipeline.

## Evidence
- `npm test` — 298 passed.
- `npm run test:chrome` — 111/120 (9 journeys failing due to the IN-FLIGHT uncommitted work from the running workers; not a committed-state regression — re-check once those workers land).
- `npm run test:components` / `test:security` / `test:opfs` — green in the committed state.

## Notes
- The "Open" list is short (3 items) — the bulk of the backlog is done + verified.
- Items 66/67/68 are carried by workers still running; their edits are uncommitted at reconciliation time.

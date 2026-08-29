# Chrome Agent Platform — Plan & Status

The working plan for the fleet. Every agent/session reads this to see what's happening + where things are.

**Reconciled 2026-08-27 against the actual tree at `0.2.319` / `origin/main@139b6f92`,
by building and running the gates — not by reading trackers.**

| Gate | Result |
|---|---|
| `npm run build` | **clean** — 80 generated files byte-identical, 26 packages, 65 shipped files, no `eval`/`new Function` across 151 shipped JS files |
| `npm test` | **1779 pass / 0 fail** |
| `npm run test:chrome` | **127/127** |
| `npm run test:security` | **PASS** (production scenario, no survivor/residue/poison) |

**The suite was red at 26/127 and is now green.** Three drifts, all from shipped
changes that never updated the gate, all fixed 2026-08-27 under
`CAP-FB-20260827-MAIN-GATES-RED-02`:

1. **The abort that cost 100 checks.** `scripts/chrome-journeys.ts` still clicked
   `.nav-item[data-section="approvals"]` — a Settings section deliberately deleted at
   `0.2.313` when approvals moved in-context — and threw when no row appeared.
   Repointed to the product's real contract rather than deleted: resolving still
   requires the `owner-options` principal, the Settings control now completes in ONE
   click through its native confirm dialog (driven with a genuine CDP click), and the
   two DOM-scraping approval assertions were moved onto the **payload**, which is
   strictly stronger — whatever surface renders an approval can only show what the
   service worker hands it.
2. **`debugger` removed** (owner decision, Q17 resolved). `0.2.286` had re-declared it
   in `optional_permissions` for the CDP power tools, reversing its deliberate removal
   at `c5ccb2d0`. The permission, the four CDP tools, the capability row and the
   Settings label are gone; the browser-tool count is **126** (was 130) and the
   capability table dropped to **155** at the time (it has since regrown to
   **160** with later tool work, incl. the delegation tool). `tests/chrome-tools-t12.test.ts` carries a
   removal guard so it cannot come back by accident — re-adding it must be a
   deliberate act. The user-scripts half of T12 is untouched.
3. **The capability count is now derived**, not hard-coded. The assertion read
   `length === 7` while the product had grown to 17 capabilities. It now reads
   `CAPABILITIES.length` from the product's own table, so the next tranche cannot
   rot it.

Task state lives in [TASKS.md](TASKS.md) (the authority); this file is the roadmap view.

## The project
Chrome as the agent platform: a new-tab agent hub that orchestrates the web with
persistent named agents (each with its own OPFS sandbox), per-site sub-agents (WebMCP
tool discovery), the generative-UI artifacts surface, a skills system, agent-generated
repeatable scripts, and a system-hooks layer — all under an all-optional-permissions
security model. The README is the overview; TASKS.md is the task authority; THIS file is
the roadmap: what's landed vs what's next.

## Principles (from the 2026-08-15 thread — NON-NEGOTIABLE)
- **Never accept "it serves" as "it works."** Every feature/fix is verified by driving the real behavior in a browser (CDP) with screenshots as evidence. A route returning 200 or a build passing is zero evidence.
- **Review before push, labelled honestly** (revised 2026-08-27) — prefer a fresh session on the diff; an author review is permitted and must then clear the falsification gates (a changed assertion proven to go red against the unfixed product; a fix proven to reproduce before and not after; deleted coverage replaced by a guard). Never write "independent" when it was an author review. See AGENTS.md, "Review without a second model".
- **Commit locally; push only after review clears.** No pushing skeletons.
- **Real libraries, not patterns.** agent-do is imported, not reimplemented. Providers actually work.
- **Honest absence** — if something can't be verified, mark it unverified; never claim it works.
- **No emoji icons** — inline SVG icons (line-art, currentColor).
- **Modern web guidance** throughout.
- **No external-project references** — usage-logging is an in-repo pattern, not a reference to another project.

## Independent architectural review (2026-08-21) — delivery diagnosis, now largely answered

[`REVIEW-2026-08-21.md`](REVIEW-2026-08-21.md) verified the baseline by building and driving
exact `origin/main@300bea1`: build clean, 632 unit tests pass, 126/126 Chrome journeys,
hub render 62 ms. Its finding was that code quality was not the constraint — **delivery**
was: landed commits per day had fallen 83 → 65 → 20 → 3 → 0 between 17 and 21 August, with
0 of 31 tasks terminal and 46 branches of reviewed work unmerged.

**That diagnosis has been acted on.** Between 22 and 27 August the project shipped
`0.2.105 → 0.2.319` — 214 releases, each with a user-facing changelog line. The delivery
stall is resolved; the ordering discipline it introduced (CAP-FB IDs in commit subjects,
no `-vN+1` without a commit in `-vN`, durable worktrees) stands.

**Lifecycle:** `OPEN → IN_REVIEW → DONE` with `BLOCKED`/`ABANDONED` off-ramps.
**Merged is done** (Paul, 2026-08-28) — work on `origin/main` with the suite green is
complete and is archived to `TASKS-DONE.md`, so `TASKS.md` holds only live work.
`DONE` does not require a
per-task owner interaction. Real-browser verification is retained unchanged; the
different-model review requirement was replaced on 2026-08-27 by a labelled review plus
mechanical falsification gates, because no second model is available and a rule satisfied
on paper is worse than no rule. See `AGENTS.md` for the normative rules.

## Where the product actually is (2026-08-27, `0.2.319`)

### Landed and shipping — the foundation
- [x] MV3 extension: NTP hub, side panel, chat, directory, memory explorer, options.
- [x] Real `agent-do` bundled (esbuild) + process/global shims.
- [x] Provider layer (`lib/provider.js`) — OpenAI / Anthropic / Gemini / DeepSeek /
      Ollama / OpenAI-compatible, per-provider model dropdowns, **Test connection**,
      per-agent provider override, bundled llm-prices cost table.
- [x] The named-agent layer — every agent (named/site/background) gets its own OPFS
      sandbox: memory + run history + skills + `memory_grep`.
- [x] One owner-facing Agents model: Settings and the task sidebar list interactive +
      scheduled agents together with cadence markers; execution pickers still filter by callability.
- [x] Sites-as-sub-agents (WebMCP discovery + per-tool first-run approval) with
      Settings → Site agents → Diagnostics, including page-local full failure detail
      while bridged/model errors remain redacted.
- [x] Tasks-as-threads, skills (`/skill:<id>`), generative-UI artifacts, agent-generated
      scripts, the system-hooks layer, the omnibox keyword.
- [x] Visible one-click hard Stop on every live conversation and actively running
      scheduled-task row, bound to the rendered execution ID, gated on a trusted live
      user gesture, routed through durable cancellation, and settled as Stopped.
- [x] All-optional permissions (`manifest.permissions: []`), origin-keyed OPFS,
      no `debugger` declared, the standing security suite (`npm run test:security`).
- [x] The component design system — 20+ Web Components in the single-source
      `extension/shared/components.js`, mirrored in the gallery with a build-time drift guard.
- [x] The layered, versioned system-prompt architecture (`lib/system-prompts.js` +
      `lib/runtime-policy.js`, Settings → Advanced) — docs/SYSTEM-PROMPTS.md.
- [x] Unified agent access — the one shared `<agent-picker>` for the + menu, `/agent`,
      and the side-panel Agents view.
- [x] Durable run authority — service-worker/OPFS run registry, outbox projection,
      bounded recovery, reload persistence. docs/DURABLE-RUN-ARCHITECTURE.md.

### Landed 2026-08-24 → 08-27 — the recent wave
- [x] **Agent workers (Phases 1–4 complete, `0.2.308`–`0.2.310`)** — each agent runs in
      its own shared worker hosted by the offscreen document, bootstrapped through the
      service worker. Fault + memory isolation: one crashed or leaky agent no longer
      takes the router and every other agent with it. The UI holds a live MessagePort
      with redacted progress; background agents run with zero visible pages; a
      SW-owned single-driver lease means only one surface drives *destructive* browser
      commands at a time (reads like screenshots stay ungated).
      docs/AGENT-EXECUTION-ARCHITECTURE.md + AGENT-WORKER-DURABILITY.md + AGENT-WORKER-PHASE4.md.
- [x] **Usage/token accounting actually works (`0.2.297`)** — the OpenAI-compatible
      adapter now sends `stream_options.include_usage`, which was the root cause of
      silently-zero token counts. Providers that don't report usage are recorded as
      unknown, never faked.
- [x] **Permissions simplified (`0.2.303`, `0.2.313`)** — when a tool needs a permission
      the request appears **in the conversation** ("This agent wants to group tabs —
      Allow?"); one click grants exactly that and retries. Deny is sticky. The orphaned
      Settings → Approvals page is gone; revoke confirms in-context.
- [x] **130 Chrome tools audited against the Chromium schemas (`0.2.295`)** — tab groups,
      MHTML save, keep-awake release and per-site content settings were all calling
      APIs that don't exist or that escaped their grant scope. Test doubles now mirror
      the real shapes and reject wrong ones.
- [x] **Observability (`0.2.287`, `0.2.294`)** — `npm run build` produces a debug build
      with source maps and a namespaced, levelled, timed logger + performance marks
      across grants, tool calls, model round-trips and task loading. Redacted: no prompt
      or page content. Security assertions identical in both modes.
- [x] **Thread-open performance (`0.2.314`, `0.2.317`)** — task open was 10–15 s on
      well-used threads because it replayed the whole history. Now a per-execution
      ordered log index with cursor pagination reads only the requested page (O(page),
      never O(total)); the first screen renders instantly and the full history pages back.
- [x] **Back-stack fixed at the top frame (`0.2.296`, `0.2.304`)** — Settings / Assets /
      Directory / Skills return to the hub in ONE press with no blank screen.
- [x] **Background agents unified into the agents list (`0.2.306`)** with a "runs in the
      background" marker, schedule and toggle; full named-agent delete (folder, record,
      memory, OPFS) and instant delete/disable (`0.2.305`). Scheduled named-agent runs
      use the same immutable instance journal as interactive chat, so unattended work
      remains visible when the agent conversation is opened.
- [x] **Every data-loading surface is bounded (`0.2.302`)** — providers, usage, agents,
      activity and the tool library time out with an honest error + Retry instead of
      dead-rendering when the worker is suspended.
- [x] **Artifacts (`0.2.318`)** — the viewer fills the window and opens in a full tab via
      minimal web-accessible resources. docs/ARTIFACT-NEW-TAB.md.
- [x] **Simplification** — the theme switcher is removed (`0.2.301`, it only ever worked
      on Settings); built-in local models are removed (`0.2.307`, the ~10 GB Chrome
      built-in-AI download never succeeded) with the architecture logged in
      docs/LOCAL-MODELS-ARCHITECTURE.md for a future OPFS-file-handle rebuild.
      Ollama/LM Studio remain as local OpenAI-compatible endpoints.

### The Wasm tool platform — what actually ships vs what is proven
- [x] **28 bundled Wasm packages ship** and are verified at build time (exact manifest,
      CAS digests, bounded raw import/memory scan, SBOM + licence records):
      awk-filter-bounded, base64, csvtool, cut, date-formatter-bounded, diff, du, grep,
      gzip, head, markdown, md5sum, patch, sha256sum, sha512sum, sort,
      sqlite3-query-bounded, stat, tail, toml2json, touch, tr, tree, truncate, uniq,
      uuid, wc, xxd.
- [x] **Live bounded lazy tool provider** — every run gets exactly three fixed definitions,
      `search_tools`, `list_tools`, and `execute_tool`, regardless of catalog size. Search
      authorizes nothing; list/search share each tool's real JSON Schema and exact
      transport limits; execute accepts only a single-use run-bound reference and
      revalidates identity, permission, grant, document and run authority before and
      after dispatch. Complete artifact/script fields use only their documented backing-
      store bounds while ordinary arguments retain the strict 16/32 KiB limits.
- [x] **Bounded awk/date are admitted** through the immutable Settings-only preview
      route with retained byte-identical rebuilds and lock-faithful licence records.
- [ ] **The remaining candidate lanes are separate** — htmlq, numbat, bttf, sed, jq,
      xan, and tokei retain their own build/admission status under
      `docs/plans/rust-lane/` and `docs/admissions/`; this tranche makes no completion
      claim for them. Admission is `CAP-FB-20260823-EXTENDED-TOOL-FAMILIES-01`.
- [ ] **Python via Pyodide (`0.2.319`)** — the bounded non-eval tool is built and tested
      (`runPythonAsync` + `setStdout`/`setStdin`, 2 KiB in / 64 KiB out, fail-closed) and
      the wiring is ready. The remaining step is the Pyodide runtime **binary**, a
      blocked Emscripten build. docs/PYODIDE-BOUNDED-BUILD.md.
- [ ] **qsv is a documented STOP** — reqwest→tokio/socket2, memmap2/blake3-mmap and a
      dual-GPL `self_cell` sit in core files. The exact patch recipe is recorded; no
      fabricated binary.

## In flight / next (the ordered queue)

- [ ] **macOS dictation diagnostics** (`CAP-FB-20260829-MIC-DEAD-MACOS-01`) —
      the immediate-start fix is landed; the follow-up candidate distinguishes Web
      Speech's OS-default input from a persisted meter-only device, exposes a live
      multi-mic check without cluttering single-mic machines, re-enumerates after the
      first grant, rejects stale out-of-order meter streams, and strengthens silent/
      audio-capture/fallback diagnostics. Mic KAT, unit, security and build gates pass;
      review and the unrelated red main Chrome-journey baseline remain.
- [ ] **Create-agent dialog consistency** (`CAP-FB-20260829-CREATE-DIALOG-DECLUTTER-01`) —
      progressive disclosure, deterministic English interval parsing, the shared
      native template select, user-bubble dark contrast and JSON tool-response dark
      contrast are in the candidate; full gates and required review remain.

The authority is the **Open work queue** table in [TASKS.md](TASKS.md) (39 open).
**The demo path is the only P0 lane** (owner decision, 2026-08-27) — the Wasm platform
dropped to P2 until after the exec demo, because it is invisible in one and largely blocked
on owner licence/Store decisions.

**P0 — the demo path.** Ordered by how early an exec hits them, and each is independently
shippable:
1. `CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01` — put the summary, and on failure the error
   text, in the COLLAPSED tool card; then rebuild the expanded view around content
   (structured/raw JSON toggle with copy, array rows previewed by their identifying field,
   no synthetic `{keys}` node). Measured: one expanded `list_tabs` is 462 px; a collapsed
   failure shows zero characters of its error; there is no raw JSON view at all.
2. `CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01` — the view builder awaits inside a
   `for` loop, so a full-history thread makes 25 serialized OPFS round-trips (up to 6,250
   rows) before `thread.get` returns anything. The reads are independent.
3. `CAP-FB-20260827-HUB-FIRST-RUN-01` — the first-run card offers six competing actions
   above the composer and a fresh profile stacks seven empty states, one of which shows
   filtered-empty copy to someone who has never had data.
4. `CAP-FB-20260828-NOUN-DISCIPLINE-01` — **UI half done, in review (`0.2.355`).** The
   product spoke three vocabularies for the same nouns (Assets / Recent artifacts /
   `asset.*`; Skills served by `recipes/`). Everything a person reads now says
   **Artifacts**, the Agents card names itself once instead of three times nested, and
   `npm run check:vocabulary` fails the build if a banned name returns. Deliberately NOT
   renamed: the `asset.*` / `recipe.*` wire routes, the `*_asset` model-facing tool names
   and the `asset:` OPFS keys — a persisted approval/data boundary that is its own
   reviewed change.

**The product direction behind these** — why the UI reads as messy, and what to do about
it structurally — is in [PRODUCT.md](PRODUCT.md), "Where the product is going".

Also P0: `CAP-FB-20260827-MAIN-GATES-RED-02` (fixed and shipped; author review with the falsification gates) and
`CAP-FB-20260821-WORKTREE-HYGIENE-01` (it protects the evidence everything else cites).

**P1.** Template picker visual cards (`CAP-FB-20260829-TEMPLATE-CARDS-01`, candidate in
review); dialog consolidation (five implementations, three hand-rolled outside the component
system); Settings sectioning (12,837 px, 8.8 screens, all twelve panels rendered at once);
permission-remediation UX; semantic tool search; Store release path; owner export/import;
the headed acceptance lane; `scripts/ui-integration.ts` red; the UI flash/relayout.

**P2.** The whole Wasm tool platform lane — runtime probe, owner install, bundled tranche,
spreadsheet toolkit, tabular diff, abuse gates, the Gate-2 Worker host. Resumes after the
demo. **P3.** Dead components, recipes→skills rename, hub agent rows onto the shared picker.

### Known open defect classes
- **WebMCP discovery — passive registry candidate in review.** The owner rejected the
  temporary all-web-tabs picker: `CAP-FB-20260829-WEBMCP-PASSIVE-DETECTION-01` adds
  detection-only MAIN + isolated scripts on every http(s) page, persists a 100-origin /
  24-hour LRU registry, and makes every `agent.discoverable-tabs` caller require a recent
  positive capability report. Zero-tool snapshots remove entries. The production-path
  journey is **36/36 pass**: a WebMCP fixture enters the picker before enrollment while a
  concurrently-open plain page remains absent, then the existing exact-tab authenticated
  enrollment and invocation path is exercised through reload and navigation.
- **Worktree hygiene** — 71 registered worktrees, and `/tmp` is RAM-backed at 92% inode
  use. Run `node scripts/worktree-audit.mjs` before any cleanup decision; nothing is
  removed until its HEAD is reachable from `origin/main` or a `rescue/*` tag.

## Open questions for Paul
The full list with resolved answers is [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).
Genuinely open: **Q11** extension name/distribution channel · **Q12** the recommended
default provider/model for the best out-of-box experience · **Q13** owner-selected Wasm
under Store policy · **Q14** Co-do licence/provenance reconciliation · **Q15** the
semantic index engine · **Q16** grouped tabular artifact promotion.

## Feature: Artifacts (Paul 2026-08-16) — shipped
Agents create things for the user in the context of a task (generated pages, files, UI,
data). All four pieces are in: the per-task artifact view in the conversation, the master
artifacts view in the hub, open/preview/use (now full-window and openable in a new tab,
`0.2.318`), and attach-an-existing-artifact from the + menu. Artifacts are origin-keyed
per agent with a master index; a generated UI IS an artifact.

# DESIGN.md — Chrome Agent Platform (visual system)

The visual system for the agent hub. Product truth lives in PRODUCT.md; this file
records the durable visual decisions. Run ownership, OPFS records, recovery, and
the browser-proof gate are documented separately in
[DURABLE-RUN-ARCHITECTURE.md](DURABLE-RUN-ARCHITECTURE.md); that reference
currently describes candidate `ac1c4fe`, not public main. The P0 metadata,
search, selection, package, runtime, workspace, artifact, and distribution
boundaries for the Co-do-style tool operating layer are recorded in
[tool-platform-architecture.md](tool-platform-architecture.md). Its current
shadow slice has no UI or provider cutover; future Tool Library UI must use the
shared component and visual rules below.

## Direction — "Quiet instrument"
A calm technical command center. The surface is a precise instrument: quiet,
measured, exact. Restrained palette, hairline borders, one confident accent,
workhorse sans, deliberate grid. Earned familiarity over novelty.

## Palette
- **Light (default "Sunlit")**: warm-neutral paper `#f7f6f3`, panels `#ffffff`,
  secondary layer `#efede8`, hairline border `#e3e0d9`, ink `#1d1b18`, muted
  `#6e6a62`.
- **Accent (petrol teal)**: `#0e6e63` (light) / `#3ec3b0` (dark). Used for primary
  actions, current selection, and state indicators only — never decoration.
- **Secondary (amber)**: `#b45309`. Positive/attention indicators.
- **Semantic**: danger `#b3261e`, success `#1a7f37`, warning `#9a6700`.
- **Themes**: Sunlit (default light), Midnight (dark), Neon, Terminal. All
  restyle the same tokens (matching `extension/shared/theme.css`).

## Directory function cards
- A function is one semantic unit in source order: name, truthful bounded registry description (or “No description provided”), site/schema metadata, then its own source and approval states.
- `<tool-directory-card>` owns responsive behavior with intrinsic/logical sizing, `min-inline-size: 0`, wrapping state controls, and a card-level container query. Badges never float outside or detach from their function in narrow or RTL layouts.
- Full settings/directory/skills views deactivate covered hub controls as view state; task threads remain the only overlay where the sidebar edge control stays available. The sidebar retains covered inert/AX state while one pure per-view policy owns the nub's hidden/inert/disabled/AX state without touching collapse state. Covered controls are hidden/inert, not raised through a z-index contest. Focus enters the frame only after reveal and returns on close only if the initiating control is still connected and visible.

## Settings responsive composition
- The 240px navigation and multi-column forms are the wide composition. At the content-driven 680px breakpoint the navigation becomes a wrapping full-width header and every form/card grid becomes one shrink-safe column using `minmax(0, 1fr)` and `min-inline-size: 0`.
- Every section and control remains present at 500px and 360px. The document reflows rather than clipping; intentionally scrollable data tables retain local `overflow: auto` without widening the Settings iframe.
- Advanced → Observability keeps the verbosity selector and full-local-detail switch adjacent. The warning names exactly what full detail exposes locally and states that dumps, exports, shared bundles, and reports remain redacted.

## Run-log affordance
- A task or agent surface keeps a plainly labelled **Run logs** action after a run settles. Its existing durable registry pages ten retained runs at a time so every run remains reachable without unbounded DOM growth; each row has **View log** and displays at most the latest 200 retained timeline entries with an honest truncation note.

## Typography
- Workhorse system sans (SF/Segoe/Roboto), antialiased, `cv02/cv03/cv04/cv11`.
- Fixed rem scale: 12 / 13 / 14 / 16 / 20 / 24. Base 14px.
- Headings: 600 weight, -0.01em tracking. No display face, no monospace-as-costume.

## Spacing, radius, elevation
- 8px grid: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- Radius: 6px (controls) / 12px (cards) / 16px (large). Pills for small controls.
- Elevation: hairline border OR a soft offset shadow, never both (no ghost cards).

## Components
- `--control: 36px` hit targets; `--control-icon: 18px` stroke icons.
- Every interactive component: default / hover / focus / active / disabled /
  loading / error.
- `<mic-button>` treats speech recognition as the primary action and the live
  AnalyserNode waveform as progressive enhancement: recognition and the visible
  CSS fallback start in the click turn; `getUserMedia` upgrades the waveform in
  parallel, while rejection leaves dictation running and labels the fallback as
  a non-live animation in the control and composer status. When enumeration finds
  at least two physical audio inputs, a small anchored popover lists them and runs
  a brief genuine level check on the selected device. Because pre-permission Chrome
  may expose only an unlabeled default alias, the first successful capture triggers
  exactly one re-enumeration. That persisted selection drives only `getUserMedia`
  meter streams: Web Speech has no `deviceId` input and always follows the OS default
  microphone, which the UI and errors state plainly. A dedicated meter-request
  generation plus captured device identity rejects out-of-order streams after a
  reselection or devicechange. Stop, hide, detach, devicechange, pagehide,
  reduced-motion, and late-stream generation guards remain authoritative.
- Agent templates render through shared `<agent-template-card>`: name, a two-line
  persona summary, at most three skill chips (the skill's display name) plus an
  overflow count, a cadence chip for scheduled templates, and one labelled Use
  action. The whole card activates that button; `selected` presses it
  (`aria-pressed="true"`, accent ring); `blank` is the "Custom agent" card.
  Curated starters come first and carry the Starter badge.
- `<agent-template-gallery>` is the ONE catalogue surface: a segmented
  Starter / All / Scheduled filter (`aria-pressed` buttons with counts) over an
  auto-fill grid of cards with a roving tabindex (one tab stop; arrows, Home,
  End move; Enter/Space activate). The create dialog opens on it (Starter
  first, Custom selected) and Settings → Agents reuses it filtered to Scheduled.
- Customizable selects use the shared native `appearance: base-select` vocabulary:
  one browser `::picker-icon` (never a second drawn chevron), safe inline SVG option
  icons, and a one-line ellipsized closed state contained by `min-width: 0`.
- The create-agent dialog's primary order is template gallery → Name → what it
  does (with visible dictation/refine tools) → English schedule → Advanced.
  Initial focus lands on the gallery's selected card.
  Its inline size is a fixed viewport clamp; every disclosure uses shrink-safe
  containment so opening Advanced or Skills never changes the dialog width.
- SVG line-art icons, one stroke weight, currentColor. No emoji.
- Capability rows: `28px | 1fr | auto` grid (icon | stacked name+description |
  right-aligned action) — aligned by construction.
- The layered system-prompt viewer (`<system-prompt-editor>`, Settings → Advanced):
  labelled layers (source + version + hash badges), a read-only built-in view, the
  owner editor with dirty/byte-count/error states and a session-only durability
  badge, and the protected constraints visually marked as never editable (the
  protected, dynamic `untrusted-content-policy` layer renders the same way, with
  its `<run-token>` placeholder in previews). Every
  Save/Reset/Keep is revision-CAS guarded; attestations expose keyed, versioned
  receipts (with an honest ephemeral label when storage is unavailable), never
  prompt text or an unkeyed custom-text fingerprint.
- `<agent-picker>` (2026-08-18) — the ONE agent picker renderer used by the side
  panel, every composer's + menu, and the strict-position `/agent` command:
  grouped Named/Background/Site rows (28px avatar | name+role | status), 44px
  option targets, a search combobox → grouped listbox contract, explicit empty/
  loading/error states, popover top-layer presentation anchored with logical
  `position-area` + `position-try-fallbacks` (JS `placeFloating` fallback). The
  selected agent shows as a removable accent chip in the composer's chip row.
- The composer's command palette keeps only actionable commands. `/tabs`,
  `/artifacts`, `/bookmarks`, and `/history` open searchable, keyboard-operable
  lists backed by the corresponding live Chrome/library authority; a selection
  leaves both a readable reference and a removable context chip. `/agent` opens
  its shared picker directly. Commands for removed or unclear product concepts
  do not remain as inert suggestions.
- The composer `/files` palette is progressive enhancement: it is absent when
  `showDirectoryPicker` is unavailable, uses the existing listbox keyboard
  contract, and turns a selected file into the same removable attachment chip
  as the + menu. Permission loss and empty/error states name Settings → Local
  folders as the recovery path; no picker or permission prompt fires implicitly.
- Hub sidebar Tasks/Agents sections share one intrinsic flex primitive: fixed
  headers with inline-end actions, independently scrolling lists with stable
  symmetric gutters while expanded, and gutter-free scrollable lists in the
  collapsed rail so task dots, agent avatars, and + actions share one center.
  Task and agent rows share padding/radius/hover tokens; the task delete action
  is centered on the row and remains keyboard-focusable. A run's transcript keeps
  every substantive per-step answer in order: a step that ran tools and ended in
  text is persisted as an interim assistant row of that execution (executionId +
  step) the moment it streams, the terminal row is appended afterwards (an
  interim row identical to the terminal is replaced, never doubled), and the
  reply to agent-do's "Continue working on the task…" nudge is hidden — never a
  bubble, never persisted, never the run's result — so the answer the owner
  watched arrive is the answer the reopened thread shows, at full length. That
  answer STREAMS: the model wrapper tees every provider stream and forwards its
  text deltas as bounded `text-delta` progress events (the first delta at once,
  the rest coalesced per ~50 ms / 8 KiB), and the conversation grows ONE interim
  agent bubble per step — `message-bubble.appendText()` hosts a
  `<streaming-text streaming>` whose deltas are text nodes only (untrusted model
  output never meets innerHTML mid-stream; a blinking caret marks the growing
  body, reduced-motion aware), the live-status row reads "Writing the answer…"
  from the first visible token, and the step's final `text` (or the run's
  `done`) replaces the streamed body with the sanitised markdown render in one
  paint, byte-identical to a non-streamed render. The hidden nudge reply never
  streams; the durable log never sees a delta; a within-run provider retry
  restarts the bubble rather than appending to a failed attempt. The room the
  turns sit in (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01): the thread body is
  the ONE scroll container, the conversation is content-height (no bordered
  620px box with empty panel under two bubbles), and the composer is docked at
  the viewport bottom with `position: sticky` over a soft `--bg` gradient so
  rows scroll under it; the run row pins just above the composer through
  `--conversation-dock`. Every assistant turn carries `<agent-identity>` —
  a 24px avatar (the agent's generated image or an inline-SVG initial in the
  accent), the name, and a `<time datetime>` ("just now" / "3m ago" / a clock
  time, muted at ≥ 4.5:1 in both schemes) — set once per surface via
  `agent-conversation.setIdentity()`. The run row reads as one sentence,
  "Working — reading your tabs…", composed from the progress port's activity
  (`composeWorkingLabel`), hosts the shared `<loading-state>` grid with the
  elapsed seconds, and removes itself on completion. Appends scroll to the
  newest content unless the owner has scrolled up more than 24px to read
  (`isScrolledToBottom`); the owner's own send and a thread (re)projection
  always re-stick, and a ResizeObserver keeps the view pinned while a
  streaming bubble or a rendered frame grows. A generated-page card is
  titled with the artifact's name — args, the returned asset, or the
  conversation's id → name registry — never a generic "Generated UI". Thread storage remains
  the Tasks list authority: thread-bound durable run revisions only signal a
  fresh `thread.list` replacement, never supply or duplicate row data. A failed
  list read preserves the current rows and leaves its run revision unacknowledged
  so an identical event can retry; each read gets at most one 400ms MV3-startup
  retry. Each page-local render has a monotonic owner, so an older delayed list
  response cannot overwrite a newer run/navigation-triggered sidebar state. When
  a terminal/cancelled revision belongs to the already-open owner thread, it is
  likewise only a signal for one targeted authoritative `thread.get` projection
  replacement per execution/revision. The shared surface-owner token fences a
  delayed projection read after navigation; replacement (not append) preserves
  exactly one durable assistant/error result without resetting focus or
  synthesizing conversation content from run logs. A page-local projection
  record binds the authoritative thread, immutable execution, surface owner and
  monotonic render generation; if that projection wins the race with a live
  completion, only the byte-identical same-execution append is suppressed.
  Different terminal bytes and new attempts remain visible, and no polling or
  client-synthesized message becomes an authority. Exact source `dd41258f`
  and its 7/7 loaded-extension journey independently verified these native
  sidebar/thread behaviors for integration; that scoped evidence is not a
  whole-product acceptance claim. A scheduled row blocked by the exact memory
  key ceiling uses the failed indicator, concise “Storage full — retry or cancel”
  text, and a labelled keyboard-focusable Retry action beside Delete. Retry
  rearms the same logical schedule; Delete remains the authoritative cancel.
  Every live conversation row and actively executing scheduled-task row also
  exposes a visible, labelled native Stop button without hover or confirmation.
  It uses the danger token without overpowering the run label. The rendered
  control captures its immutable execution ID and carries the original native
  click; the abort boundary requires both a trusted click and live user activation,
  then sends only that captured ID through `run.cancel`. A stale control can never
  retarget a newer run. Success settles as **Stopped**; an already-settled run is
  reported as a no-op. Stopping is distinct from deleting the task or disabling
  its schedule.
- **Approval happens in context, not in Settings** (changed at `0.2.303`/`0.2.313`;
  the Settings → Approvals section is deleted). When a tool needs a permission or a
  destructive operation needs consent, the request renders as an approval card in the
  conversation that raised it — "This agent wants to group tabs — Allow?" — and one
  click grants exactly that scope and retries the run. Deny is sticky. Revoking a
  permission confirms in place through a native dialog on the same owner-approved
  mutation path: Settings → Permissions "Turn off <capability>" sends
  `capability.revoke` to the service worker (the single revoke authority — the
  storage snapshot, the alarms disarm, and for Site Agents the tombstoning and
  script unregistration of every enrolled origin) and the shared confirm dialog
  with a genuine-gesture accept is the approval; the page never revokes a
  permission itself. Permission REQUESTS stay in the page because only the click
  gesture can call `chrome.permissions.request`. Cards disclose only the normalized action and a private
  install-scoped reference — never target, origin, id, payload, digest, execution id,
  or credentials. Approval ids stay in event-handler closures and never become DOM
  attributes. Approve and Deny are ordinary labelled buttons with immediate
  disabled/pending state and a polite live result.
  **The one deliberate exception is a script** (`script.create` / `script.run` /
  a scheduled script): the owner cannot approve code they have not read, so the
  card shows the exact source in a scrollable, labelled, keyboard-focusable
  `<pre>` (set as a property and rendered with `textContent`, never an attribute
  or markup), lists the sites it fetches, and calls out a computed URL in the
  danger tone ("unknown hosts — only the listed sites will be reachable"). The
  title is plain words ("Run this script now?"), not the action id.
- **Tool cards show the tool's own answer, never the transport** (`0.2.464`,
  CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §9/§10). Every real call travels through
  the lazy protocol — `search_tools` finds a tool, `execute_tool` runs it, and the
  result arrives as `{modelContent:"{ok, selectedTool, result, schemaSummary,
  selectionRef, …}"}`. None of that vocabulary is the owner's business, so ONE
  unwrap (`unwrapToolPayload` in `components.js`, `lazyInnerResult` in
  `conversation.js`) runs before anything renders: the card is headed by the tool
  that ran (a still-running `execute_tool` reads "tool call", never the protocol
  name), the head's summary and the tree are computed from the selected tool's own
  result, the raw JSON view shows that same unwrapped value, an error block shows
  the tool's own error string, and a truncated envelope that cannot parse is not
  painted at all (the headline already carries the words). `search_tools` /
  `list_tools` calls are protocol, not work: they stay in the durable run log and
  render no card — live (a queue sentinel keeps the FIFO pairing honest) or on
  reopen (`protocol:true` rows are skipped by the projection). The journey suite's
  leakage probe walks every shadow root of a completed thread, with every card and
  raw view opened, and fails on any of `modelContent`, `catalogGeneration`,
  `stableId`, `schemaSummary`, `search_tools`, `execute_tool`.
- **A persisted denial reopens as the grant card, not prose** (§2b, the reopened-
  thread half of CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01). The run log keeps the
  tool's structured denial; `toolRowsFromRunLog` derives ONE `approval` row per
  distinct requirement right after the denied call, `projectThreadMessages` keeps
  it with its turn, and `<agent-conversation>` renders the same
  `<permission-approval-card>` the live run showed. The card grants nothing itself:
  Allow bubbles an `approval-decision` event to the surface that owns the
  service-worker channel (`wireReplayApprovals` in the hub), which takes the exact
  live path — `chrome.permissions.request` on the click, then the scoped
  `browser-control.set` — and resumes the run if it is still paused on that
  requirement. A settled run cannot continue, and the card says so honestly:
  "Approved. Ask again and the agent can use it." Not now marks it declined.
  The owner's RECORDED decision is the replayed card's state (`agent.js` puts the
  requirement and the decision on the `tool-result` event; the run log keeps
  them): approved reopens as granted, declined stays declined — deny is sticky,
  so a re-projection can never resurrect a pending Allow for a question already
  answered — expired says so, and only a denial that never paused the run
  reopens grantable. Run-bound action approvals (script.run et al.) are never
  replayed as cards — their ids died with the run.
- **A reply that claims an action it never performed is corrected in place**
  (`extension/lib/mutation-claim-check.js`, applied in `agent.js` on both the
  `done` progress event and the authoritative returned result). The prompt's
  honesty clause is an instruction a model can ignore — gpt-4.1 answered "I have
  saved that your favourite colour is green" with zero tool calls, and the demo
  model reported "Delegation succeeded" over a `delegate_task` card that read
  `error`. So the turn's final text is checked, at runtime, against the set of
  mutating tools that ACTUALLY succeeded in that turn (real tool names, after
  the lazy-envelope unwrap). Eleven claim kinds are covered: creating, updating,
  deleting and scheduling a named agent; opening, navigating and closing a tab
  or window; saving to memory; taking a screenshot; downloading a file; and
  delegating a task. An unbacked claim gets a visible line appended as TEXT —
  "⚠️ Correction: I claimed I …, but no successful tool call did that in this
  turn — no such change was made." The module is pure (no DOM, no imports) and
  the self-claim guard is deliberately narrow: a negation ("I haven't opened
  it"), a third-party subject ("Chrome downloaded the file") and a subordinate
  clause are not claims. The correction lands IN the reply's own bubble rather
  than beside it, and the turn's final text is painted exactly ONCE — a
  continuation step that re-emits the same text settles the streaming row but
  never appends a duplicate (the reported baseline showed the identical bubble
  twelve times for one delegation).

## Screenshots (`<screenshot-thumb>`, `<screenshot-strip>`)
A screenshot is pixels, and pixels are not JSON. Every capture — the agent's as
well as the owner's — is written to the screenshots store as its own OPFS file
(bounded, evict-oldest) and the tool answers with the id, the source URL, the
PNG's real pixel size and its byte count. The bytes themselves never enter the
model-facing result: the lazy protocol lifts the data URL out of the projection
into an attachment side channel, and a provider lane whose transport carries an
image part receives the PNG as a real image content part beside the (image-free)
envelope. A lane that would only stringify it receives the envelope alone, which
is honest and small — a base64 fragment cut at the 16 KiB string bound is not
something a model can read, and both a hallucinated description and "I cannot
see images" were measured coming back from one.
- `<screenshot-thumb shot-id label size>` is one saved capture, resolved from
  the store by id and painted in the tool card so the owner sees exactly what
  the agent saw. Its `alt` names the page ("Screenshot of example.com"), never
  just "screenshot". The decoded blob URL is revoked on disconnect and before
  every re-resolve, so a long transcript never holds a megabyte per card. `src`
  short-circuits the lookup for the component gallery.
- `<screenshot-strip shots>` remains the multi-shot history row.

## Artifact diff (`<artifact-diff>`)
- One element in `extension/shared/components.js` renders what changed between
  two versions of an artifact: a `+n -m · k changes` header, `unified` (default)
  or `split` rows, and `n`/`]` · `p`/`[` hunk navigation that moves focus to the
  hunk section and announces "Change N of M" through a polite live region
  (`role="region"` on the body, `aria-keyshortcuts` on the buttons). Split
  collapses back to unified under 720px of container width.
- Colour is carried by the row tint (`color-mix` of `--success` / `--danger`
  at 12% into `--panel`) and a `+`/`-` marker drawn from `data-kind`, never by
  the ink: counts, markers and lines stay in `--text` so both schemes hold AA.
  The accent marks only the current hunk (a hairline ring) and focus.
- Every line is untrusted model output: rows are DOM-built and set with
  `textContent` after bidi/control neutralisation (the diff core's
  `truncateDiffLine`); the only markup mount is the static header. Rendering
  stops at `max-lines` (2,000) with an honest "Showing X of Y changed lines"
  note and a `truncated` event. The diff itself comes from the bundled diff
  core (jsdiff); the element only renders it.

## Generated artifact boundary
Interactive HTML previews use three distinct layers: the privileged extension
surface, a stable manifest-declared opaque sandbox host, and one disposable
nested `sandbox="allow-scripts"` document. The privileged surface keeps guarded
HTML out of its DOM and delivers it to the host with a fresh bounded nonce. The
host never uses `document.write` and never executes generated markup; it replaces
only the nested frame when the nonce/content changes. Direct
`location.assign`/`replace`/`href` and `self.location` therefore cannot destroy
the host URL, lifecycle listener, or preference relay, while the missing
same-origin/top-navigation/forms/popups tokens preserve the authority boundary.
The generated document receives the strict prepend-first CSP and may run inline
UI scripts/styles without network access. Preference messages relay only between
the current child and its exact nonce. Teardown removes the outer frame and the
privileged staging entry; repeated async preview renders clean the prior listener
and stage exactly one replacement.

## WebMCP discovery boundary

Every top-level http(s) document receives two small detection-only scripts at
`document_start`: MAIN can inspect `document.modelContext` / `navigator.modelContext`
and the positive `webmcpExpose` list, while ISOLATED can report through
`chrome.runtime`. They carry only a bounded tool count and never arm the invocation
bridge, enroll an origin, transport descriptors, or execute a tool. Delayed probes and
capability-change events cover tools registered after initial parsing.

The service worker derives the reporting origin from Chrome's `MessageSender`, checks
`sender.origin`, re-reads `sender.tab.url` to close navigation races, and rejects any
payload-origin mismatch. Positive reports enter a persisted, most-recent-first registry
bounded to 100 origins and 24 hours; zero reports remove the origin immediately. Full
URLs are not persisted. `agent.discoverable-tabs` intersects currently-open http(s) tabs
with that registry for every caller, including the explicit **Find site tools** picker.
Only after the owner chooses a detected tab does the existing MAC-authenticated,
exact-document enrollment/invocation bridge run.

## Distribution archive boundary
The production ZIP is a projection, not a copy of the developer's local
`extension/` directory. Its only authorities are Git-tracked regular extension
files, the current generated dist tree, and the byte-identical generated
changelog. A unique fresh temp archive is checked for exact names, duplicate or
stale entries, regular-file portability, and content hashes before an atomic
same-filesystem replacement. `dist.complete` is not a mere presence flag: its
bounded canonical schema binds the exact Git commit, current bytes of every
indexed source file, and the exact generated service-worker/options hashes.
The build compares indexed source before and after bundling, and packaging
validates the marker both before and after hashing its inventory. Random lock
owners, PIDs, version-directory names, and wall-clock timestamps remain private
custody rather than archive input. Identical source builds are byte-identical;
stale/legacy markers, ignored/untracked files, symlinks, special files, and
content retained from an older ZIP are never distribution UI or runtime.

## Browser-test process custody
The real-Chromium security suite runs only through its canonical lock-owning
supervisor. Before servers or browser state exist, the runner must prove the
supervisor-issued nonce, live parent identity, inherited canonical flock and
exact current-UID non-symlink profile. Production always selects the repository
runner and a 120-second host deadline; environment overrides cannot weaken either.
The detached runner is accepted only after PID=PGID=SID attestation. Timeout or
residual group members receive bounded TERM then KILL only after exact ownership
verification. Observed descendants that escape that group poison the serialized
slot, and profile removal reuses the same exact-prefix/owner/symlink helper tested
by hostile no-Chrome mutants. Durable receipts survive the temporary profile.

## Tool-provider interaction contract

Every run surface presents the model with the same bounded two-step interaction:
`search_tools` returns non-authorizing in-scope metadata and a short-lived
single-use reference; `execute_tool` accepts only that reference and revalidates
live authority around the existing source closure. Dynamic catalog definitions
never enter provider context. Disabled bundled rows remain discoverable metadata
without a reference or execution affordance. This protected contract follows
owner-authored prompt text, so customization cannot replace it.

## Run error copy (the truth contract)

A failed run says what actually happened and what to do, in that order — the
underlying cause in danger ink, the action in plain ink, and a "Fix in Settings"
button whenever Settings can resolve it. The copy is produced by ONE authority
(`extension/lib/error-report.js`, `describeError`) and rendered with
`textContent` only. A provider HTTP failure is classified by its real status —
the model wrapper records the last provider status before the AI SDK collapses
the stream into `AI_NoOutputGeneratedError` — so "returned no content" is
reserved for a genuinely empty HTTP 200 stream.

| Category | Reason (danger) | Action (plain) | Fix in Settings |
|---|---|---|---|
| `provider-auth` (401/403) | `<Provider> rejected the API key (401) — <provider message>` | Check the API key in Settings → Providers — it is missing, invalid, or revoked. | yes |
| `provider-rate-limit` (429) | `<Provider> is rate-limiting this key (429) — <provider message>` | The provider is rate-limiting you — wait a moment and retry. | no |
| `model-config` (400/404/422) | `<Provider> rejected the request (400) — <provider message>` | Check the model id in Settings — it may not exist for this provider. | yes |
| `provider-server` (5xx) | `<Provider> returned a server error (503)` | The provider's servers are having an issue — retry in a moment. | no |
| `provider-config` (preflight) | the configured provider has no valid https:// endpoint | Set the provider endpoint in Settings → Providers, then run the task again. | yes |
| `host-permission` | network access to `<origin>` is not granted | Grant network access in Settings. | yes |
| `model id missing` | a provider that needs a model id has none (no explicit id, no catalogue default) | Set the model id in Settings → Providers — the run never falls back to the demo model. | yes |
| `model-no-output` (empty 200) | the model (`<id>`) returned no content | Retry, or try a different model. | no |

`<Provider>` is the human name for the configured provider id (OpenAI, Anthropic,
Google Gemini, DeepSeek, "the provider" for a custom endpoint) — never the base
URL. Provider messages pass through the secret-safe choke point and an extra
credential-shape mask (`sk-…`, `AIza…`, …) before they reach any surface. A
preflight refusal (no endpoint) is a terminal `failed` status row with the
Settings action, never a "Waiting for permission" state.

## The first result without a model (keyless first run)

A fresh profile has no provider. The first task a new user types still gets a
real result: the default model is the **local assistant**
(`extension/lib/models/local-assistant.js`), a deterministic model that
recognises a small set of tab intents and drives the REAL tool protocol
(`search_tools` → `execute_tool`) — the same tools, grant gating, permission
cards and journal rows a provider model gets. "group my tabs by topic" makes
real tab groups (by site, two or more tabs each), saves the tab list as the
artifact "Your open tabs", and ends in one plain paragraph that reports what
was done and what was not ("1 tab stayed ungrouped because it was the only tab
on its site"). "list / summarise / find duplicate tabs" answer from the real
tab list; duplicates are reported, never closed.

The copy rules: the paragraph names counts and sites, never a model or a
character count; a missing permission is said plainly ("the tabs permission was
not granted — allow it when asked and run this again"); an unrecognised task
gets exactly one line — "I can group, list or summarise your tabs without a
model. For anything else, connect a model in Settings — it takes two minutes."
The demo provider's plumbing proof ("[demo model] Task received (N chars)…") is
a test seam for the journey suite and is reachable only under the developer
flag (`cap:developerFeatures === true`); no bracketed model tag ever renders on
a default build. Tab titles and URLs in the artifact are page-controlled text
and are escaped before they reach the artifact HTML.

## First run (the first screen is a command center)

A fresh profile opens on the composer, not on onboarding
(CAP-FB-20260827-HUB-FIRST-RUN-01). The hub's `<main>` precedes the sidebar in
the DOM (`.side { order: -1 }` keeps it painted on the left), and inside it the
composer comes first, so Tab #1 lands in the task input and the composer is
fully visible at 1024x700. Above it, `<first-run-guide>` is a slim banner — one
sentence and ONE action ("Connect a model" → Settings → Providers) with the
dismiss control last in the tab order — shown only while no provider is
connected and no artifact exists; with a provider it renders nothing. Browser
control is asked for in context by the approval card at the moment a task needs
it, never up front. Under the composer, `<example-chips>` offers three example
tasks; a chip prefills the composer and focuses it — it never runs anything.
The Agents / Jobs / Recent artifacts / Recent activity sections are `hidden`
until their store has ever had data (`cap:hub-seen:<section>`, page-local,
cleared by a factory reset), so a fresh profile never stacks empty states; once
a store has been used its honest empty copy returns. The activity explorer's
zero state ("Nothing has happened yet.") and its filtered-empty state ("No
activity matches this filter.") are different sentences.

## Motion
150–250ms state transitions only; `prefers-reduced-motion` respected. No
page-load choreography, no decorative glow.

Same-document task routing keeps the named primary overlay transition. The
browser's root and named snapshots live in the top layer, so direction-aware
policy makes both obsolete old images immediately transparent across every task
boundary: Hub or embedded view → task, task → Hub, and task →
Settings/Directory/Skills/Artifacts. Only the old `overlay-view` image is
suppressed; the new named overlay stays active. Unrelated full-view routes never
receive the temporary class and retain their normal named cross-fade. The class
is removed after finish, abort, or overlapping route changes; focus moves to the
active task heading, composer, embedded frame, or return target only after the
top layer settles. Reduced motion updates route and focus synchronously without
creating a snapshot.

## Anti-slop bans (enforced)
No rainbow conic glow, no gradient text, no uppercase tracked kickers, no ghost
cards, no over-rounded cards, no emoji, no default purple/blue-black, no AI-beige
cream+serif.

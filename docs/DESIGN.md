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
- Agent templates render through shared `<agent-template-card>`: name, a two-line
  persona summary, at most three skill badges plus an overflow count, and one
  labelled Use action. Curated starters come first and carry the Starter badge.
- SVG line-art icons, one stroke weight, currentColor. No emoji.
- Capability rows: `28px | 1fr | auto` grid (icon | stacked name+description |
  right-aligned action) — aligned by construction.
- The layered system-prompt viewer (`<system-prompt-editor>`, Settings → Advanced):
  labelled layers (source + version + hash badges), a read-only built-in view, the
  owner editor with dirty/byte-count/error states and a session-only durability
  badge, and the protected constraints visually marked as never editable. Every
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
- Hub sidebar Tasks/Agents sections share one intrinsic flex primitive: fixed
  headers with inline-end actions, independently scrolling lists with stable
  symmetric gutters while expanded, and gutter-free scrollable lists in the
  collapsed rail so task dots, agent avatars, and + actions share one center.
  Task and agent rows share padding/radius/hover tokens; the task delete action
  is centered on the row and remains keyboard-focusable. Thread storage remains
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
- **Approval happens in context, not in Settings** (changed at `0.2.303`/`0.2.313`;
  the Settings → Approvals section is deleted). When a tool needs a permission or a
  destructive operation needs consent, the request renders as an approval card in the
  conversation that raised it — "This agent wants to group tabs — Allow?" — and one
  click grants exactly that scope and retries the run. Deny is sticky. Revoking a
  permission confirms in place through a native dialog on the same owner-approved
  mutation path. Cards disclose only the normalized action and a private
  install-scoped reference — never target, origin, id, payload, digest, execution id,
  or credentials. Approval ids stay in event-handler closures and never become DOM
  attributes. Approve and Deny are ordinary labelled buttons with immediate
  disabled/pending state and a polite live result.

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

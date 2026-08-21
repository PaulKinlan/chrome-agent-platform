# DESIGN.md — Chrome Agent Platform (visual system)

The visual system for the agent hub. Product truth lives in PRODUCT.md; this file
records the durable visual decisions. Run ownership, OPFS records, recovery, and
the browser-proof gate are documented separately in
[DURABLE-RUN-ARCHITECTURE.md](DURABLE-RUN-ARCHITECTURE.md); that reference
currently describes candidate `ac1c4fe`, not public main.

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
  synthesizing conversation content from run logs. Exact source `dd41258f`
  and its 7/7 loaded-extension journey independently verified these native
  sidebar/thread behaviors for integration; that scoped evidence is not a
  whole-product acceptance claim.
- Settings → Approvals is the sole owner decision surface for destructive agent
  operations. Rows disclose only the normalized action and a 128-bit private
  install-scoped reference—never target, origin, id, payload, digest, execution
  id, or credentials. Approve-once and Deny are ordinary labelled buttons with
  immediate disabled/pending state and a polite live result. Approval ids stay
  in event-handler closures and never become DOM attributes. Opening the section
  refreshes FIFO pending rows because background-page timers may be throttled.

## Motion
150–250ms state transitions only; `prefers-reduced-motion` respected. No
page-load choreography, no decorative glow.

## Anti-slop bans (enforced)
No rainbow conic glow, no gradient text, no uppercase tracked kickers, no ghost
cards, no over-rounded cards, no emoji, no default purple/blue-black, no AI-beige
cream+serif.

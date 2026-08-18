# DESIGN.md — Chrome Agent Platform (visual system)

The visual system for the agent hub. Product truth lives in PRODUCT.md; this file
records the durable visual decisions.

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
  owner editor with dirty/char-count/error states, and the protected constraints
  visually marked as never editable.

## Motion
150–250ms state transitions only; `prefers-reduced-motion` respected. No
page-load choreography, no decorative glow.

## Anti-slop bans (enforced)
No rainbow conic glow, no gradient text, no uppercase tracked kickers, no ghost
cards, no over-rounded cards, no emoji, no default purple/blue-black, no AI-beige
cream+serif.

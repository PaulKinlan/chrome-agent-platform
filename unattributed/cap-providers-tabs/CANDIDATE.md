# Providers side-tabs (owner feature) — candidate

- Candidate commit: `1d97ac6d` · tree `ac64dc3fdcc23021ec244f9015f99b63a534c025`
- Worktree: `/home/paulkinlan/worktrees/cap-providers-tabs` (branch: providers-tabs off main f1c2d2f4 / 0.2.336)
- Report SHA-256: computed below over this file.

## What was built

The Settings **Providers** panel is now a side-tabs interface (owner request):

1. **Vertical tab rail** (`#provider-tabs`, `role=tablist aria-orientation=vertical`) — one tab per
   catalogue provider (7: OpenAI, Anthropic, Gemini, DeepSeek, OpenAI-compatible, Ollama, LM
   Studio). Each tab: display name + small hint. The **DEFAULT provider's tab carries a pinned
   star badge** (`.pt-default-badge`, accent2 colour) visible without opening anything; the
   badge is `aria-hidden` and the tab's accessible name carries " (default)" via the repo's
   visually-hidden utility.
2. **Editor pane** (`#provider-panels`, one `role=tabpanel` per provider, `aria-labelledby` its
   tab) — the EXISTING per-provider card markup unchanged inside (base URL, API key + durability
   warning, model-picker, Use/Update, Test connection, Clear key, test-status live region). All
   prior wiring (bindProviderSetDefault, host-access request, secret-safe test, clear-key) works
   untouched.
3. **Selection vs default**: tab selection is view state (`selectedProviderId`, survives
   re-renders); the default is the persisted `cfg.provider`. Initial selection falls back to the
   default when it is a rail provider; non-rail defaults (e.g. `demo` on a fresh profile) fall
   back to the first entry and the existing `#provider-selection-status` line explains that state
   (unchanged behaviour, now with zero badges).
4. **Keyboard**: roving tabindex + ArrowUp/ArrowDown (also Left/Right)/Home/End move selection
   with focus; Tab/Shift+Tab leave the rail normally. `preventDefault` only on handled keys.
5. **Narrow (<680px, the existing Settings media block that also covers the NTP's covered-view
   iframe)**: the rail collapses to a horizontal scroll ROW — `overflow-x:auto` + row direction on
   the RAIL (the document never scrolls horizontally: verified `scrollWidth <= clientWidth` at
   360px), hints hide, the badge stays.

## Scope note (deliberate)

Providers are a **fixed catalogue** — there is no add/delete-provider concept in the product
today, so no tabs are added/removed. The owner's ask (side-tabs + visible default) is fully
covered; custom-provider CRUD would be new scope, not attempted.

## Compatibility fixes (required by the restructure)

- `scripts/agent-provider-picker.ts`, `scripts/chrome-journeys.ts`: the CDP journeys now click
  `#provider-tab-<id>` before interacting with a provider's card (non-selected panels are
  `hidden`, so the old direct card queries would hit invisible elements).

## Gates (all run in this worktree)

- `deno test -A tests/providers-tabs.test.ts` — 9/9 (structural contracts: semantics, keyboard,
  layout, narrow collapse, wiring preservation, journey updates).
- `deno test --allow-all tests/` — **1840 passed / 0 failed**.
- `npm run build:production` — RC=0 (options page runs from the built bundle; rebuilt).
- KAT `deno run -A scripts/kat-providers-tabs.ts` — **19 passed / 0 failed** (real browser):
  rail semantics, 7 tabs, single aria-selected, single visible labelled panel, two-column grid,
  selection↔default fallback, badge position (incl. non-rail default), tab-switch, no history
  growth, keyboard nav + focus, set-default persists + badge moves, reload persistence, 360px
  zero document overflow + self-scrolling rail + hidden hints + visible badge.
- Screenshots: `.cache/kat-providers-tabs/providers-tabs-1440.png`,
  `.cache/kat-providers-tabs/providers-tabs-360.png`.

## Residual risks / notes

- The pre-existing card CSS (`.provider-card.active` accent border) still marks the default
  inside the editor pane; harmless duplication of the badge signal.
- `.provider-list` CSS rule is now unused (left in place to keep the diff minimal); flagged for
  the reviewer to optionally drop.

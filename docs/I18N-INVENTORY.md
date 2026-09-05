# I18N Inventory — chrome-agent-platform-54q (foundation)

Stage-1 deliverable of the internationalisation foundation bead: a grep-based
inventory of hardcoded user-visible strings across every surface, the proposed
catalogue key structure, and (after migration) the migrated/remaining split.

**Method.** `grep -oE '"[^"\\]{3,120}"'` over each JS surface, filtered to
strings that start with a letter and carry sentence-case or space-separated
words; static text fragments for HTML surfaces are extracted from between tags
(scripts/styles stripped). This is a **candidate count, not a curated count**:
it overcounts, because quoted code fragments (`' ? (detail || '`, attribute
names, CSS identifiers) pass the coarse filter. The migration pass is the
curation authority — every string it migrates is curated by hand; everything
left behind lands in the "remaining" table below with a class justification.

## Candidate counts per surface (pre-migration)

| Surface | Quoted-string candidates | Notes |
|---|---|---|
| shared/components.js | 649 | shared Web Components — the acceptance names these explicitly |
| options/options.js | 303 | Settings JS-rendered rows, cards, dialogs |
| ntp/ntp.js | 251 | hub task view, rails, composer |
| options/options.html | 151 static fragments | Settings static markup (nav, headings, labels) |
| shared/conversation.js | 84 | transcript rendering |
| sidepanel/sidepanel.js | 47 | side panel agents/activity |
| lib/permission-language.js | 42 | the user-language permission table (already single-sourced) |
| ntp/ntp.html | 27 static fragments | hub static markup |
| shared/tool-tree.js | 25 | tool tree labels/summaries |
| shared/site-agent-copy.js | 19 | site-agent vocabulary (already single-sourced copy module) |
| shared/thread-view.js | 14 | thread view rules/labels |
| sidepanel/sidepanel.html | 12 static fragments | side panel static markup |
| shared/run-status.js | 11 | run status words |
| lib/next-run-label.js | 6 | "Next run" projector labels |
| shared/plan-strip.js | 2 | plan strip words |
| **Total candidates** | **~1,643** | see method caveat above |

## Proposed catalogue key structure

`<surface>_<element>_<purpose>` with underscores (chrome.i18n message names
allow only `[a-zA-Z0-9_@]`). Examples:

- `settings_nav_providers` — Settings left-nav "Providers"
- `settings_providers_test_connection` — the per-provider test button
- `component_approval_title` — approval card heading
- `component_composer_placeholder` — composer hint text
- `hub_rail_tasks` — hub rail label
- `sidepanel_agents_heading`

Shared components (rendered on many surfaces) use the `component_*` prefix; a
string used by several components gets one key, reused.

## Catalogue design (decided, stage 2)

- `extension/manifest.json` carries `"default_locale": "en"`.
- `extension/_locales/en/messages.json` is the SINGLE source of truth.
- `extension/shared/i18n.js` exposes `t(key, ...subs)` (chrome.i18n first,
  embedded byte-identical fallback elsewhere) and `hydrateI18n()` for static
  HTML via `data-i18n` / `data-i18n-attr`.
- `scripts/sync-i18n.mjs` regenerates the embedded fallback from the catalogue
  (`--check` exits 1 on drift); `tests/i18n-foundation.test.ts` pins the drift
  guard, catalogue shape, lookup semantics and hydration contract.
- The gallery sync (`scripts/sync-gallery.mjs`) ships `docs/i18n.js` beside the
  components copy so the docs showcase resolves the same fallback.
- Adding a second locale = a new `extension/_locales/<lang>/messages.json`
  catalogue only; Chrome selects it from the browser language with zero code
  change (the fallback serves the default English everywhere else).

## Migrated / remaining (updated at stage 5)

Filled in by the migration stages below.

- Migrated: (pending)
- Remaining: (pending — each class justified)

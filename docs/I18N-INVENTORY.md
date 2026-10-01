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

## Catalogue contract and the honesty check (chrome-agent-platform-716s.2)

The first Settings migration generated the catalogue from the markup by keying
on the first words and keeping only the text that preceded the first child
element. Twelve-plus messages shipped as a truncated or HTML-escaped prefix of
their sentence (`"Version "`, `"Connect a remote "`, `"Backup &amp; restore"`),
and hydration wrote them over the markup — About lost its version number and
its logo, the Data & memory heading rendered the entity literally, the MCP and
Skills leads ended mid-sentence, and the hidden backup `<input type="file">`
was discarded. The drift pin compared the catalogue to the broken markup byte
for byte, so nothing in the suite could see it. The contract is now:

- **The catalogue holds text, never markup.** No HTML entities (`&amp;` is
  written in the markup fallback, `&` in the catalogue), no `<`, no padding
  whitespace or embedded newlines, and no message that ends in a dash or an
  article (the shape a cut sentence takes).
- **A leaf** (`data-i18n` on an element with no child elements) hydrates with
  `textContent`; its message renders identically to the markup fallback
  (entities decoded, whitespace collapsed).
- **Mixed content** (`data-i18n` on an element WITH child elements) carries one
  `$n` placeholder per direct child, in sentence order: `"Version $1"`,
  `"Connect a remote $1 server … over an $2 URL. …"`. `hydrateI18n` resolves
  the message with the slots marked, splits it, and places the element's
  EXISTING child nodes back between text nodes — moved, never cloned or
  re-parsed, so ids (`#about-version`), listeners and inline `<code>`/`<abbr>`
  survive, and there is no innerHTML path. A message that does not place every
  child leaves the markup untouched rather than destroying it.
- **`data-i18n` on an end tag** (`</svg data-i18n=…>`) is a parse error the
  browser drops; it is a defect, not a wiring.
- **Every key is used** somewhere (`data-i18n`, `data-i18n-attr`, or a
  `t("key")` literal).

`scripts/check-i18n.mjs` (`npm run check:i18n`) enforces all of it over every
`extension/_locales/*/messages.json` and every `extension/**/*.html`, and
`tests/i18n-catalogue-honesty.test.ts` executes the same check under `npm test`
— alongside the fixtures that prove each rule fires on the exact defective
entries that shipped. Run against the pre-fix tree it reported 72 findings
across 28 keys; the fixed tree reports none.

## Migrated / remaining (updated at stage 5, revised 716s.2)

- Migrated: 125 Settings leaves (`options_*`), the artifact-preview component
  strings (`components_*`), and — since 716s.2 — the six mixed-content Settings
  sentences (`options_version`, `options_mcp_lead`,
  `options_site_agents_host_access`, `options_diagnostics_logs_help`,
  `options_skills_lead`, plus the brand text span) through the `$n` slot
  contract above.
- Remaining in Settings, each with its class:
  - **Nav labels and icon buttons** (`Providers … About` in the left nav; `Add
    server`, `Add folder`, `Add file`): a text run beside an inline SVG. The
    generated `data-i18n` sat on the `</svg>` end tag and never hydrated; those
    dead attributes and their 17 keys are removed. Wire them either as a mixed
    message (`"$1 Providers"`, the icon as the slot) or by moving the label
    into a `<span data-i18n>`; the second is kinder to translators but touches
    every Settings harness that reads `.nav-item` text — tracked as a
    follow-up bead.
  - **The Backup & restore export paragraph, the About tagline and the
    developer-features description**: static leaves the first migration did
    not reach; plain `data-i18n` leaves when picked up.
- Remaining elsewhere (ntp, sidepanel, components.js, options.js rendered
  rows): the quoted-string candidates in the table above; each surface is its
  own migration stage.

# Settings cleanliness audit

Date: 2026-08-29  
Audited surface: `extension/options/options.html`, `extension/options/options.js`, `extension/options/options.css`, Settings routes in `extension/lib/pure.js`, and the Settings entry points in `extension/ntp/`  
Product mode: **Operate** — Settings should expose owner decisions, not implementation inventory.

## Scope and decision boundary

This pass implements only removals that are provably dead under the current permission model. The manifest grants four required API permissions (`alarms`, `offscreen`, `sidePanel`, `storage`) and host access `<all_urls>` at install; every other capability permission (33 in `optional_permissions`) is optional and granted just-in-time from a real owner gesture. A required permission cannot be added or removed at runtime, so a button that only re-checks `storage` cannot change the state it presents.

Information-architecture changes, movement of diagnostics, and changes to working owner controls are proposals only. Browser control, local-file grants, hook deny policy, and in-conversation mutation approvals remain owner-controlled and are not permission-toggle leftovers.

## Findings

| Status | Location | Problem | Proposed fix | Severity | Affected tests |
|---|---|---|---|---|---|
| **Implemented** | `extension/options/options.html` — `data-section="appearance"`; `extension/lib/pure.js` — `SETTINGS_SECTIONS` / `OPTIONS_PRODUCT_HASHES` | **Appearance is a dead navigation control.** The navigation item had no matching `<section id="appearance">`; activation changed the hash but `handleSettingsHashNavigation()` returned `false`, with no selected item or focused destination. The removed Approvals surface also remained accepted as a product hash. | Delete the Appearance item and stop accepting `#appearance` / `#approvals` as live Settings routes. Keep unknown/retired fragments outside exact Settings product authority. | P1 | `tests/settings-cleanliness.test.ts`, `tests/navigation-controller.test.ts`, `tests/owner-approval-security.test.ts`, `tests/approvals-synthesis.test.ts` |
| **Implemented** | Provider API-key editors in `extension/options/options.js`; `<storage-durability-warning>` in `extension/shared/components.js`; specimen in `docs/components.html`; `requestStorageFromOwnerClick()` in `extension/lib/first-run-onboarding.js` | **“Verify storage” was a request-era control that could not repair its failure.** `storage` is required at install. The button called `permissions.contains()` again; a missing grant still required reload/reinstall. The same dead control appeared in global and per-agent provider editors. | Remove the control, component, event, gallery specimen, and click-only verifier. Keep the synchronous credential-persistence guard; when verification fails, block the save and say exactly: reload the extension. | P1 | `tests/settings-cleanliness.test.ts`, `tests/first-run-onboarding.test.ts`, `tests/components.test.ts`, `scripts/kat-settings-cleanliness.ts` |
| **Implemented** | `<first-run-guide>` in `extension/shared/components.js` | **The NTP guide pointed to the removed key warning.** “Verify storage from the key warning” became a dead remediation path under install-granted storage. | Treat storage as status, not a user choice: available, or missing with reload remediation. Remove the redundant “keep its key” intro clause. | P1 | `tests/settings-cleanliness.test.ts`, `tests/first-run-onboarding.test.ts`, `scripts/kat-settings-cleanliness.ts` |
| **Resolved / dropped** (2026-10-14) | `extension/options/options.html#permissions`; `extension/options/panels/permissions.js` (`renderPermissions()`) | **A 36-permission diagnostic matrix occupies a top-level user section.** It is truthful and read-only, but it is implementation inventory rather than a routine owner decision. Most visits will show only “Granted at install.” | Superseded by the optional + JIT capability model (`d33a218c`/`21819017`/`5ea49a5a`, `CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01`), where `#permissions` is a live three-state capability table (`<capability-row>`: granted switch / requestable “Turn on” button / platform-unavailable text + mandatory “Always on” group). Per Owner Decision 3d Option 1 (`chrome-agent-platform-jt83l`, 2026-10-14), `vc52` item (a) (moving `#permission-list` behind Advanced → Diagnostics) was dropped. | P2 | `tests/approvals-synthesis.test.ts`, `tests/alarm-permission-lifecycle.test.ts`, `tests/settings-strings-audit.test.ts`, `tests/settings-cleanliness.test.ts` |
| **Implemented** (2026-10-14) | `extension/options/options.html#tool-library`; `extension/shared/components-settings.js` (`<tool-library>`); `extension/options/panels/tool-library.js` | **The section calls itself read-only diagnostics and says “Nothing here runs,” but the component exposes a preview request that executes a bounded Wasm tool.** This is both developer-facing placement and contradictory copy. | Resolved per Owner Decision A / 3d Option 1 (`chrome-agent-platform-vc52` item d / `chrome-agent-platform-jt83l`): kept the explicit Settings preview in `#tool-library` (developer-gated via `data-developer="true"`), grouped tools by purpose (“Running the browser” / “Doing the work”, `f1b4b8ca`), and replaced the contradictory “Read-only diagnostics … Nothing here runs” copy in `options.html` and `<tool-library>` with honest copy stating that the preview runs a bundled tool on this device only on your explicit click and nothing installs, grants, updates, or removes tools. | P1 | `tests/tool-library.test.ts`, preview-host, package-admission and loaded-browser tests |
| **Dropped** (2026-10-14) | `extension/options/options.html#agents` — Site Agent diagnostics; `extension/options/panels/agents.js` (`renderWebmcpStatus()`) | **WebMCP script lifecycle, injection counts, page-reported counts, and a DevTools logging toggle are developer internals embedded in the main Agents flow.** They compete with enrollment and per-agent provider decisions. | Per Owner Decision 3d Option 1 (`chrome-agent-platform-jt83l`, 2026-10-14), `vc52` item (b) (relocating `#webmcp-status-body` to `#prompts` Advanced → Diagnostics) was dropped; WebMCP diagnostics remain in `#agents` (`data-vocab="advanced"`). | P2 | Site-discovery, WebMCP lifecycle/status, diagnostics-toggle and browser tests |
| **Dropped** (2026-10-14) | `extension/options/options.html#hooks`; `extension/options/panels/hooks.js` (`renderHooks()`) | **Every `chrome.*` event and subscriber is shown as a flat top-level panel.** The deny-list is a real owner security control, but raw hook IDs/subscribers are diagnostic detail. | `#hooks` is developer-gated (`data-developer="true"`, `DEVELOPER_SECTIONS`) and renders a `<switch-toggle>` deny-list table (`CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01`). Per Owner Decision 3d Option 1 (`chrome-agent-platform-jt83l`, 2026-10-14), `vc52` item (c) (relocating `#hook-list` to `#prompts` Advanced → Diagnostics) was dropped. | P2 | Hook-policy, capability, permission and loaded-Settings tests |
| **Partially implemented** | Page bootstrap in `extension/options/options.js` + `extension/options/panel-registry.js`; 16 `<section class="panel">` elements (12 default-visible + 4 developer-only, matching `SETTINGS_SECTIONS` in `extension/lib/pure.js`) | **Every panel renders on load, and all panels remain in one long document.** The page initializes panels before the owner chooses a section. | `chrome-agent-platform-9epn.9` added `content-visibility: auto` and staged progressive hydration (active section first, `await sleep(0)` before deferred lists); `chrome-agent-platform-8v5l.1`/`8v5l.2` extracted the 16 sections into `extension/options/panels/*.js` with `PANEL_REGISTRY`. Full single-mounted-panel switching remains tracked under `CAP-FB-20260827-SETTINGS-MONOLITH-01`. | P1 | `tests/options-lazy-sections-9epn9.test.ts`, `tests/settings-panel-registry.test.ts`, `CAP-FB-20260827-SETTINGS-MONOLITH-01` |
| **Implemented** (2026-10-01) | `options.html`, `options.js`, `options.css` | **The order follows feature arrival, not owner intent.** Providers → local files → tool diagnostics → Skills → Agents → schedules → Browser → raw permissions → hooks → prompts → usage → data → About mixes setup, policy, tools and diagnostics. | Replaced the flat feature list with the six-group IA below (Models & spend, Agents, Skills & tools, Automation, Permissions & folders, Data & backup) preserving deep links and accordion keyboard navigation (`chrome-agent-platform-716s.4`). | P1 | `tests/settings-ia-and-cadence-716s4.test.ts`, `tests/settings-section-navigation.test.ts` |
| Deferred for owner sign-off | Provider configuration inside `#providers` and again inside `#agents` | **Provider/model configuration has two homes.** Global setup and per-agent overrides are necessarily different scopes, but the current navigation does not explain the relationship. | Group both under **Providers & models**: global default first, per-agent overrides second with an Agent column/filter. Agents should link to the override rather than embed a second provider editor. | P2 | Provider picker/save, named-agent provider route, focus, storage and browser tests |
| **Implemented** | `extension/ntp/ntp.js` — `#provider-status` click | **The provider warning bypasses the in-context Settings overlay.** First run opens `options.html#providers` in context; the header warning calls `chrome.runtime.openOptionsPage()` with no section. Footer Settings also opens in context. | Resolved by `71d0eafe` (`chrome-agent-platform-d885.6`): `#provider-status` click routes through `openView("options/options.html#providers", "Provider settings", statusEl)` and preserves focus return. | P2 | NTP provider-status, covered-view, focus-return, back-stack and browser tests |
| **Resolved** | `extension/lib/provider-gate.js`; provider Set/Test wiring in `options.js` | **Provider access still carries request-era orchestration and copy despite `<all_urls>` being required.** The fallback verifies, but the coordinated path can still call the permission-request bundle. This is no longer a Settings control problem; it is shared permission plumbing. | Resolved by `fa5a4699` (2026-09-04, `fix(provider-gate): replace host-request leasing with bounded install-grant verification`): provider Set/Test now verifies the install-granted host permission via `chrome.permissions.contains` (bounded, fail-closed); permission-prompt outcomes are gone from provider copy. Tracked as `chrome-agent-platform-p43i`. | P1 | Provider-gate, perm-lease, provider picker, in-context approval and real-profile provider tests |
| Deferred for owner sign-off | `extension/options/options.js` local folder browser (`extension/lib/folder-browser.js`) | **Folder/file rows use emoji (`📁`, `📄`) despite the product-wide SVG/currentColor rule.** | Replace with the existing file/folder line icons when the Local folders surface is next edited. | P2 | Loaded Settings screenshot and component/style checks |
| **Resolved** (2026-09-04 / 2026-09-11) | `README.md`, `PLAN.md`, `docs/CONSTITUTION.md`, older permission-design/task records | **Repository guidance reconciled with shipped permission reality.** The manifest and P0 tests say install-granted + `<all_urls>`; older docs still said all optional. | Resolved by the Q18(a) host-access copy pass `62501eb3` (2026-08-31) with the optional-capability lanes `d33a218c`/`21819017`/`5ea49a5a` and `fd50d24f` (2026-09-11): `README.md`, `PLAN.md`, and `docs/CONSTITUTION.md` §1 Permissions state the shipped model — four required boot permissions (`alarms`, `offscreen`, `sidePanel`, `storage`), 33 optional capability permissions granted just-in-time from a real owner gesture (Settings → Permissions or the in-context approval card; the SW never requests), and host access install-granted via `host_permissions: ["<all_urls>"]`. `tests/settings-strings-audit.test.ts` pins the retired phrasing so it cannot return. Tracked as `chrome-agent-platform-p43i`. | P1 | Documentation review; manifest/permission policy tests |

## Proposed information architecture

The six groups already named in `PRODUCT.md` are the right spine. They describe why the owner is here, not which module implements the setting.

### 1. Providers & models

- **Default provider** — provider, endpoint, model, API key, connection test.
- **Per-agent overrides** — a filtered list of agents whose provider differs from the default.
- Network/install-grant health appears inline only when unhealthy; raw permission state is diagnostic detail.

### 2. Agents

- **Named agents** — identity and behavior controls.
- **Site Agents** — enrolled sites and concise health state.
- **Background agents** — schedules and enabled state.
- Site discovery logs and script/injection telemetry move to Advanced diagnostics.

### 3. Permissions & security

- **Browser control** — the real owner policy grant and origin scope.
- **Local access** — granted folders/files and revoke/re-grant actions.
- **Hook policy** — owner deny/allow decisions, grouped by capability.
- **Extension access health** — one summary; raw manifest matrix disclosed only for diagnosis.
- Runtime mutation approvals stay in the conversation that raised them, not in Settings.

### 4. Tools

- **Skills** — import, browse, and use.
- **Tool library** — product-facing catalog grouped by “Run the browser” / “Do the work,” if preview execution is intentionally retained.
- Package/source diagnostics stay under Advanced.

### 5. Data

- **Usage** — 24h / 7d overview and detail.
- **Memory** — per-origin browsing and clearing.
- **Maintenance** — journal purge and orphan cleanup.
- **Factory reset** — visually separated last, with the existing confirmation boundary.

### 6. Advanced

- **System prompts**.
- **Diagnostics** — permission matrix, WebMCP lifecycle/logging, raw hook IDs/subscribers, tool-source/package diagnostics.
- **About & shortcuts**.

## Interaction rules for the future IA change

1. Only one group is rendered at a time; deep links select a group and optional subpanel.
2. Changing groups replaces the Settings hash entry, preserving the current one-Back behavior.
3. Expensive panels mount on first entry and stop polling when inactive.
4. Owner decisions are visible; implementation telemetry is progressively disclosed.
5. Missing install grants never offer Enable/Verify controls. They name the missing grant and the only valid remediation: reload, then reinstall if it persists.
6. Browser control, file-system grants, hook policy and conversation approvals remain user-controlled; install-granted Chrome API state is not presented as a toggle.

## Developer-features flag (CAP-FB-20260830-EXEC-BUILD-FLAG-01)

A single boolean preference — kv key `cap:developerFeatures`, **off by default** —
now gates the platform/plumbing lanes out of the DEFAULT Settings surface, so a
first-time owner is not met with implementation inventory before the controls
they need. The set is defined once in `extension/lib/pure.js` as
`DEVELOPER_SECTIONS` and marked in `extension/options/options.html` with
`data-developer="true"` on both the nav item and the `<section>`:

- **Tool library** (`#tool-library`) — the tool catalog + explicit Settings preview host.
- **Board permissions** (`#board-permissions`) — the deny-rule editor.
- **Hooks** (`#hooks`) — the `chrome.*` event deny-list table.
- **Advanced** (`#prompts`) — system prompts + observability.
- Plus the **Provider server tools** card (`#server-tools-card`) inside Providers.

With the flag off these are `hidden` and their renderers are skipped; nothing is
deleted, the section ids stay valid, and a deep link to a hidden section shows a
one-line "Turn on developer features in About" notice rather than a dead link.
Turning the switch on in **About → Developer features** reveals every lane and
renders it exactly as before. The same kv key is read by
`developerFeaturesOn()` in `extension/lib/provider.js`, so the flag also keeps
the demo test model + its `@demo-*` markers (KEYLESS-FIRST-RESULT-01) and the
developer-only browser tools (COOKIE-TOOLS-CUT-01) out of a default profile.

**Decision recorded (2026-08-31, updated for 16-section `SETTINGS_SECTIONS`):** Local
folders (`#local-folders`) and Browser control (`#browser`) are **not** gated by
this flag. They are legitimate user features (managing folder grants and the
browser-control policy), not developer plumbing; hiding them would remove real
functionality. The acceptance's original "seven-item" nav assumed those two also
fold away, which is the separate monolith rework owned by
`CAP-FB-20260827-SETTINGS-MONOLITH-01`, not this flag. Across the 16 sections in
`SETTINGS_SECTIONS` (`extension/lib/pure.js`), 12 are default-visible and 4 are
developer-only (`DEVELOPER_SECTIONS`). With the flag off the default nav shows
the 12 user-facing sections (the 4 developer lanes hidden):
Providers · Tool servers (`#mcp-servers`) · Local folders · Your WebAssembly files (`#user-wasm`) ·
Skills · Agents · Browser control · Permissions · Web services (`#web-services`) ·
Usage · Data & memory · About.

## Safe-subset evidence contract

- Source gate: `tests/settings-cleanliness.test.ts` fails on the pre-change tree for the dead Appearance route, storage verifier, and missing fail-closed replacement; it passes after removal.
- Existing copy gate: `tests/settings-strings-audit.test.ts` remains green.
- Loaded browser: `scripts/kat-settings-cleanliness.ts` uses `launchChrome()` and proves the retired controls/routes disappear while provider editing, Browser control, local-folder controls and permission diagnostics still render.
- Visual evidence: baseline and cleaned Settings screenshots are stored outside the repository with the gate logs.

# Settings cleanliness audit

Date: 2026-08-29  
Audited surface: `extension/options/options.html`, `extension/options/options.js`, `extension/options/options.css`, Settings routes in `extension/lib/pure.js`, and the Settings entry points in `extension/ntp/`  
Product mode: **Operate** — Settings should expose owner decisions, not implementation inventory.

## Scope and decision boundary

This pass implements only removals that are provably dead under the current unpacked-only permission model. The manifest grants 36 API permissions and `<all_urls>` at install. A required permission cannot be added or removed at runtime, so a button that only re-checks `storage` cannot change the state it presents.

Information-architecture changes, movement of diagnostics, and changes to working owner controls are proposals only. Browser control, local-file grants, hook deny policy, and in-conversation mutation approvals remain owner-controlled and are not permission-toggle leftovers.

## Findings

| Status | Location | Problem | Proposed fix | Severity | Affected tests |
|---|---|---|---|---|---|
| **Implemented** | `extension/options/options.html` — `data-section="appearance"`; `extension/lib/pure.js` — `SETTINGS_SECTIONS` / `OPTIONS_PRODUCT_HASHES` | **Appearance is a dead navigation control.** The navigation item had no matching `<section id="appearance">`; activation changed the hash but `handleSettingsHashNavigation()` returned `false`, with no selected item or focused destination. The removed Approvals surface also remained accepted as a product hash. | Delete the Appearance item and stop accepting `#appearance` / `#approvals` as live Settings routes. Keep unknown/retired fragments outside exact Settings product authority. | P1 | `tests/settings-cleanliness.test.ts`, `tests/navigation-controller.test.ts`, `tests/owner-approval-security.test.ts`, `tests/approvals-synthesis.test.ts` |
| **Implemented** | Provider API-key editors in `extension/options/options.js`; `<storage-durability-warning>` in `extension/shared/components.js`; specimen in `docs/components.html`; `requestStorageFromOwnerClick()` in `extension/lib/first-run-onboarding.js` | **“Verify storage” was a request-era control that could not repair its failure.** `storage` is required at install. The button called `permissions.contains()` again; a missing grant still required reload/reinstall. The same dead control appeared in global and per-agent provider editors. | Remove the control, component, event, gallery specimen, and click-only verifier. Keep the synchronous credential-persistence guard; when verification fails, block the save and say exactly: reload the extension. | P1 | `tests/settings-cleanliness.test.ts`, `tests/first-run-onboarding.test.ts`, `tests/components.test.ts`, `scripts/kat-settings-cleanliness.ts` |
| **Implemented** | `<first-run-guide>` in `extension/shared/components.js` | **The NTP guide pointed to the removed key warning.** “Verify storage from the key warning” became a dead remediation path under install-granted storage. | Treat storage as status, not a user choice: available, or missing with reload remediation. Remove the redundant “keep its key” intro clause. | P1 | `tests/settings-cleanliness.test.ts`, `tests/first-run-onboarding.test.ts`, `scripts/kat-settings-cleanliness.ts` |
| Deferred for owner sign-off | `extension/options/options.html#permissions`; `renderPermissions()` | **A 36-permission diagnostic matrix occupies a top-level user section.** It is truthful and read-only, but it is implementation inventory rather than a routine owner decision. Most visits will show only “Granted at install.” | Keep one compact “Extension access healthy / reload required” summary in **Permissions & security**. Put the per-permission matrix behind an **Advanced → Diagnostics** disclosure. Do not delete the verification because missing-install-grant diagnosis is useful. | P2 | `tests/approvals-synthesis.test.ts`, `tests/alarm-permission-lifecycle.test.ts`, `tests/settings-strings-audit.test.ts`, Chrome settings journeys |
| Deferred for owner sign-off | `extension/options/options.html#tool-library`; `renderToolLibrary()` | **The section calls itself read-only diagnostics and says “Nothing here runs,” but the component exposes a preview request that executes a bounded Wasm tool.** This is both developer-facing placement and contradictory copy. | Choose one product truth: (A) a user-facing Tools section with an explicit “Preview” capability and plain-language grouping, or (B) Advanced diagnostics with execution removed. The proposed IA assumes A, but this needs an owner decision. | P1 | Tool-library, preview-host, package-admission and loaded-browser tests |
| Deferred for owner sign-off | `extension/options/options.html#agents` — Site Agent diagnostics; `renderWebmcpStatus()` | **WebMCP script lifecycle, injection counts, page-reported counts, and a DevTools logging toggle are developer internals embedded in the main Agents flow.** They compete with enrollment and per-agent provider decisions. | Move the entire block to **Advanced → Diagnostics**, collapsed by default. Keep only a concise enrollment health/error state in Agents. | P2 | Site-discovery, WebMCP lifecycle/status, diagnostics-toggle and browser tests |
| Deferred for owner sign-off | `extension/options/options.html#hooks`; `renderHooks()` | **Every `chrome.*` event and subscriber is shown as a flat top-level panel.** The deny-list is a real owner security control, but raw hook IDs/subscribers are diagnostic detail. | In **Permissions & security**, show denied/allowed policy grouped by capability. Reveal raw event IDs and subscribers in Advanced diagnostics. | P2 | Hook-policy, capability, permission and loaded-Settings tests |
| Deferred for owner sign-off | Page bootstrap at the end of `extension/options/options.js`; 13 `<section class="panel">` elements | **Every panel renders on load, and all panels remain in one long document.** The page initializes providers, local folders, tool catalog, agents, schedules, permissions, hooks, prompts, usage, memory, diagnostics and About before the owner chooses a section; Usage continues polling every 1.5 seconds. This is the root cleanliness and work-cost problem, not a spacing problem. | Render one selected group at a time, preserve deep links, and lazy-mount expensive panels on first entry. Keep the existing navigation/back-stack and focus contracts. This is the already-tracked Settings-monolith change and is not safe-subset work. | P1 | `CAP-FB-20260827-SETTINGS-MONOLITH-01`; navigation, responsive, focus, usage-liveness, panel-retention and Chrome journey tests |
| Deferred for owner sign-off | Current navigation order in `options.html` | **The order follows feature arrival, not owner intent.** Providers → local files → tool diagnostics → Skills → Agents → schedules → Browser → raw permissions → hooks → prompts → usage → data → About mixes setup, policy, tools and diagnostics. | Replace the flat feature list with the six-group IA below. Within each group, put owner decisions before status and diagnostics. | P1 | Navigation-controller, product-hash, exact-options-sender, deep-link, focus and screenshot tests |
| Deferred for owner sign-off | Provider configuration inside `#providers` and again inside `#agents` | **Provider/model configuration has two homes.** Global setup and per-agent overrides are necessarily different scopes, but the current navigation does not explain the relationship. | Group both under **Providers & models**: global default first, per-agent overrides second with an Agent column/filter. Agents should link to the override rather than embed a second provider editor. | P2 | Provider picker/save, named-agent provider route, focus, storage and browser tests |
| Deferred for owner sign-off | `extension/ntp/ntp.js` — `#provider-status` click | **The provider warning bypasses the in-context Settings overlay.** First run opens `options.html#providers` in context; the header warning calls `chrome.runtime.openOptionsPage()` with no section. Footer Settings also opens in context. | Route the provider warning through `openView("options/options.html#providers", "Provider settings")` and preserve focus return. | P2 | NTP provider-status, covered-view, focus-return, back-stack and browser tests |
| Deferred for owner sign-off | `extension/lib/provider-gate.js`; provider Set/Test wiring in `options.js` | **Provider access still carries request-era orchestration and copy despite `<all_urls>` being required.** The fallback verifies, but the coordinated path can still call the permission-request bundle. This is no longer a Settings control problem; it is shared permission plumbing. | In a separate security-reviewed lane, replace host-request leasing with bounded install-grant verification and remove permission-prompt outcomes from provider copy. | P1 | Provider-gate, perm-lease, provider picker, in-context approval and real-profile provider tests |
| Deferred for owner sign-off | `extension/options/options.js` local folder browser | **Folder/file rows use emoji (`📁`, `📄`) despite the product-wide SVG/currentColor rule.** | Replace with the existing file/folder line icons when the Local folders surface is next edited. | P2 | Loaded Settings screenshot and component/style checks |
| Deferred for owner sign-off | `README.md`, `docs/CONSTITUTION.md`, older permission-design/task records | **Repository guidance contradicts shipped permission reality.** The manifest and P0 tests say install-granted + `<all_urls>`; the Constitution still says all optional. This makes Settings decisions hard to review safely. | Reconcile normative permission documentation in a dedicated docs/security review. This pass updates only the directly false README tree line. | P1 | Documentation review; manifest/permission policy tests |

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

## Safe-subset evidence contract

- Source gate: `tests/settings-cleanliness.test.ts` fails on the pre-change tree for the dead Appearance route, storage verifier, and missing fail-closed replacement; it passes after removal.
- Existing copy gate: `tests/settings-strings-audit.test.ts` remains green.
- Loaded browser: `scripts/kat-settings-cleanliness.ts` uses `launchChrome()` and proves the retired controls/routes disappear while provider editing, Browser control, local-folder controls and permission diagnostics still render.
- Visual evidence: baseline and cleaned Settings screenshots are stored outside the repository with the gate logs.

# Open questions for Paul

Resolved answers are recorded here (Paul confirmed each over the course of the build). Remaining open questions are at the bottom. Security-suite serialization and the verified shadow lazy capture are completed implementation custody, not product-policy questions. The live fixed-pair provider cutover is a 0.2.180 implementation candidate with fresh loaded denial/revoke/race acceptance and independent review still pending; it introduces no new product-policy choice or owner authority. The source-only OPFS workspace and retained code-diff artifact authority likewise make no product-policy choice. Bundled Wasm rows remain catalog-only for providers and retain their separate Settings admission posture; owner-package enablement and Store treatment remain unresolved. The exploratory MV3 probe independently passed, while the pure injected-memory/workspace WASI P1 table and retained diff authorities keep their separate execution/mutation gates. Owner-package enablement, signer trust/verification, large-tier evidence, grouped tabular promotion policy and the future owner-approved code-diff mutation/WAL design remain explicitly open decisions.

## Resolved

1. **Agent model** — RESOLVED: a multi-agent hub that fans out to per-site sub-agents. The "Multiple agents" toggle controls 1-vs-N; the hub is modular. (Paul confirmed.)
2. **Consumer view / next-steps tray** — RESOLVED: an inferred "next steps" tray (2-3 useful actions offered after a task, without taking over browsing). (Paul approved; built into the hub.)
3. **Tool approval** — RESOLVED: inferred (window.*) tools require first-run user approval per origin before the agent may call them. (Paul approved; built.)
4. **Memory persistence** — RESOLVED: origin-keyed OPFS (per-origin, one site can never read another). A sync/export (cloud backup) path is a FUTURE option, not in scope now.
5. **MHTML vs screenshots** — RESOLVED: both. Screenshots for the chat strip; MHTML for full-page archives, kept until the user deletes. (Paul decided.)
6. **Wasm tool integration direction** — RESOLVED and elevated to P0 (Paul, 2026-08-22): build the Co-do-style tool operating layer, beginning with the owner-decision-free metadata catalog and lexical shadow index, then loaded-MV3 runtime proof and bundled provenance-clean tools. Existing WebMCP/browser/management dispatch and owner grants remain authoritative. Owner-uploaded execution is a separate distribution lane and is not enabled by this decision.
7. **co-do double-iframe generative UI** — RESOLVED (built): generated HTML artifacts render inside the sandboxed double iframe with the artifact gallery/viewer plus CSP, network, and navigation guards.
8. **Hub sidebar Tasks/Agents layout** — RESOLVED (Paul, 2026-08-18): both sections use the same panel/list/overflow/scrollbar treatment and aligned inline-end + actions; collapsed content must remain centered and unobstructed by scrollbars.
9. **Full Agent Directory presentation** — RESOLVED (Paul, 2026-08-19): a full Directory view hides/inerts covered sidebar controls; focus enters after reveal and returns safely on close; each function presents canonical description/schema metadata and its own accessible source/approval state in semantic responsive order.
10. **Durable retention versus owner memory quota** — RESOLVED (Paul, 2026-08-21): remove the arbitrary key-count ceiling, keep byte ceilings, retain all Durable history without automatic eviction, and isolate execution authority from owner/model master memory so routine schedules cannot crowd owner data or flood errors. OPFS search/indexing improvements are deferred.

## Open

11. **Extension name/distribution** — "Chrome Agent Platform" is a placeholder; the final public name and channel remain undecided. Archive freshness and reproducibility are no longer part of this decision: production ZIPs use an exact tracked-plus-generated inventory, a deterministic commit/source/output-bound `dist.complete`, and atomic fresh replacement. **Recommended default (reanalysis 2026-08-30; still OPEN):** pick a product name before the deck — "Chrome Agent Platform" reads as an internal codename; unpacked/developer channel for the demo; the Store later behind `CAP-FB-20260825-WEBSTORE-RELEASE-01`.
12. **The model for the hub** — Gemini Nano is weak for tool-calling; which provider should be the recommended default for the best experience? **Recommended default (reanalysis 2026-08-30, re-measured on CURRENT model ids after the owner's correction; still OPEN):** OpenAI `gpt-5.6-luna` — the only model that passed every journey (open tab, list tabs, memory set + recall in a new thread, create then edit an artifact behind the approval card, injection resisted) at 7-12 s and $0.005-0.02 per turn. It is unusable on the shipped build until the OpenAI adapter sends `reasoning_effort:"none"` (every gpt-5.6 call is HTTP 400 today) — `CAP-FB-20260830-MODEL-CATALOG-CURRENT-01`. **Interim default until that lands: `gemini-3.7-flash`** (passes unpatched through the native lane; 3-6x slower per turn, edits by re-creating the asset rather than update_asset). Not recommended: `gpt-5.6-sol` (25x luna's price, re-executes under the loop nudge), `gpt-5.6-terra` (missed the new-thread recall by guessing the memory key), `grok-4.6` (runaway under the nudge: 12 duplicate tabs, $0.77, never settled). `claude-sonnet-5` / `claude-opus-5` / `claude-fable-5` and Z.ai `glm-5.3` were not measured (dead key / no balance) and should be before the default is final. Evidence table: `REVIEW-2026-08-30.md` section 9. Blocks `CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01`.
13. **Owner-selected Wasm distribution policy** — may a Chrome Web Store build execute genuinely local owner-selected Wasm without violating remotely hosted code policy? Until written policy resolves this, Store mode is bundled-reviewed-executables only; owner-selected packages remain an unpacked/enterprise/developer lane. The credential-free `--target=store` marker-v2/CSP/package/static scan proves only the checked archive boundary and does not answer this policy question. **Recommended default (reanalysis 2026-08-30; still OPEN):** Store = bundled-reviewed executables only (the current posture); owner-selected Wasm stays a developer lane. Not demo-relevant; park until after the demo.
14. **Co-do licence/provenance reconciliation** — Co-do's root is Apache-2.0 while package and generated manifest metadata declare MIT. Which source/licence/SBOM/reproducibility authority must each candidate binary satisfy? No Co-do binary may be copied before this is resolved. **Recommended default (reanalysis 2026-08-30; still OPEN):** do not copy any Co-do binary; keep the in-repo builds; park until after the demo.
15. **Semantic index engine** — deterministic exact/alias/lexical retrieval ships first. Embedding model, dimensions, quality thresholds, storage engine (SQLite versus IndexedDB), device tiers, and telemetry policy remain decisions under the existing `CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01`; the task must not be duplicated. **Recommended default (reanalysis 2026-08-30; still OPEN):** defer entirely — the lazy provider with lexical search is sufficient at ~160 capabilities; the demo build hides the lane (`CAP-FB-20260830-EXEC-BUILD-FLAG-01`).
16. **Grouped tabular artifact promotion** — before any route can retain up to one MiB across digest-keyed chunks, choose either an atomic/reservable grouped keyed promotion with safe refcount/orphan collection or an explicitly lower single-body cap. The source candidate does neither silently: it remains unreachable, writes the manifest last, surfaces capacity/orphan receipts and never auto-deletes a possibly referenced chunk. **Recommended default (reanalysis 2026-08-30; still OPEN):** the explicitly lower single-body cap (256 KB, already the artifact limit); defer chunked promotion.

17. **`debugger` permission posture** — **RESOLVED (Paul, 2026-08-27): remove it for
    now; the permission and the tools can come back later.** `0.2.286` had re-declared
    `debugger` as an optional permission for the CDP power tools (network conditions,
    CPU throttling, device emulation, navigation, screenshots, performance metrics;
    `Runtime.evaluate` never exposed), reversing its deliberate removal at `c5ccb2d0`.
    The costs decided it: Chrome's all-sites permission warning and a persistent
    "…started debugging this browser" bar are not acceptable in the current posture.
    Removed 2026-08-27 — the optional permission, the four tools, the capability row
    and the Settings label. Browser tools 130 → 126, capability table 159 → 155. The
    user-scripts half of T12 is untouched. A removal guard in
    `tests/chrome-tools-t12.test.ts` plus the manifest assertion in the journey suite
    make any return a deliberate act. When it does return, it should land behind a
    separate developer-only surface rather than the default product.

18. **Host-access posture** — `extension/manifest.json` declares `host_permissions: ["<all_urls>"]`
    plus two content scripts on every http(s) page at `document_start` (install-granted, since
    `0.2.419`), while the README and several comments still describe an all-optional model. The
    install prompt reads "Read and change all your data on all websites" — the first question a
    Chrome reviewer will ask. Either (a) keep install-granted host access and passive WebMCP
    detection and describe it truthfully everywhere, or (b) move `<all_urls>` to
    `optional_host_permissions`, keep the detector on `activeTab` plus JIT origin grants, and
    lose passive discovery. **Recommended default (reanalysis 2026-08-30; OPEN, needed before
    the demo):** (a) — the WebMCP thesis depends on noticing when a site offers tools, and the
    honest sentence is "this extension can read every page in order to notice when a site
    offers tools; it acts only after you allow it". Blocks `CAP-FB-20260830-HOST-ACCESS-STORY-01`;
    shapes `WEBSTORE-RELEASE-01` and `CAP-FB-20260830-PRIVACY-STATEMENT-01`.

19. **Are page actions in scope?** — There is no click, type, fill, scroll or find-element tool;
    the only way to act inside a page is a site that ships WebMCP tools. Every comparator leads
    with "it fills the form". Either add a minimal grant-gated page-action family on
    `chrome.scripting` (find by accessible name, click, type, select, scroll, wait) behind the
    untrusted-content fence and the activity ledger, or decide the product is WebMCP-only for
    page interaction and say so on the slide. **Recommended default (reanalysis 2026-08-30;
    OPEN, needed before the demo script is final):** add the minimal family — it is the largest
    missing piece of the thesis and the Chrome-native permission model is the differentiator
    against screenshot-and-click agents. Blocks `CAP-FB-20260830-PAGE-ACTION-TOOLS-01` and, through
    it, `CAP-FB-20260830-SIDE-PANEL-COMPANION-01`.

20. **"Browser control" first, or "coworker" first?** — The product carries two thesis
    statements: sites-as-sub-agents via WebMCP (unique, working, hidden) and a coworking
    environment for knowledge workers (`PRODUCT.md`; aspirational, missing page actions and a
    companion). The hub is a third thing — an agent-management dashboard. The answer orders the
    post-demo queue in `REVIEW-2026-08-30.md` section 5. **Recommended default (reanalysis
    2026-08-30; still OPEN):** lead the demo with browser control plus WebMCP (what works today),
    and build toward the coworker shape in this order: the activity ledger with undo, the
    companion side panel, the plan strip, scheduled-run reports on the timeline.

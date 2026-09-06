# Docs audit — 2026-09-05 (lane cap-arch-docs, bead chrome-agent-platform-5zl6, umbrella 9zw7)

**Audited tree:** `origin/main@14e2a817` (2026-09-05). Claims were verified against the code at
the tip via `git show origin/main:<path>` — not against the local checkout (which sits 10 commits
behind at `75364f28`). Read-only analysis; no product or doc files were modified.

**Scope:** `README.md`, `PRODUCT.md`, `PLAN.md`, `CHANGELOG.md`, root trackers, and `docs/*.md`
(incl. `docs/plans/`, `docs/admissions/` presence, `docs/KNOWN-ISSUES.md`,
`extension/background/routes/ROUTE_MAP.md`). `docs/admissions/*` and `docs/plans/rust-lane/*`
per-lane records (42 + 59 tracked files) were spot-checked for presence only — they are declared
per-lane authorities for still-open candidate work, so their internal state is owned by those lanes.

Every finding cites file:line at `origin/main`. Severities: **H** = actively misleads a reader
about the current product/process; **M** = stale but recognizably dated; **L** = cosmetic.

---

## A. Retired trackers still presented as the live authority (H)

The 2026-09-02 owner directive (AGENTS.md, "Task tracking: beads only") retired TASKS.md,
TASKS-DONE.md, KNOWN-ISSUES.md and docs/UI-FIXES-TRACKER.md. Both retired root files now carry a
correct RETIRED banner (TASKS.md:1-9, KNOWN-ISSUES.md:1-5). But the docs that point at them were
never updated:

1. **README.md:243** — the document map declares TASKS.md "**Task state, and the only authority
   for it.** … The entry always wins over any summary of it." Directly contradicts the beads-only
   rule; a new reader is sent to a frozen file.
2. **README.md:246** — KNOWN-ISSUES.md described as "Gate state and the few open findings… A thin
   view over TASKS.md". Retired.
3. **README.md:247-248** — docs/UI-FIXES-TRACKER.md and TASKS-DONE.md listed as live map entries
   with no retirement note.
4. **PLAN.md:41** — "Task state lives in TASKS.md (the authority)".
5. **PLAN.md:48** — "TASKS.md is the task authority".
6. **PLAN.md:76** — "archived to TASKS-DONE.md, so TASKS.md holds only live work".
7. **PLAN.md:229** — "The authority is the **Open work queue** table in TASKS.md (39 open)."
   (39 open is doubly stale: the file is retired, and live state is `bd ready`.)
8. **docs/KNOWN-ISSUES.md:3** — the whole file is a redirect to root KNOWN-ISSUES.md, i.e. a
   signpost to a retired file. Should point at beads.
9. **docs/KNOWN-ISSUES-ARCHIVE.md:5, 9, 60, 117, 135** — repeatedly tells readers live findings
   "live in TASKS.md" / to look up CAP-FB ids in TASKS.md. The archive itself may stay, but its
   pointers are dead ends.
10. **docs/AGENT-MODEL.md:81** (status section) — "Residual: … tracked in KNOWN-ISSUES."
11. **docs/UI-FIXES-TRACKER.md:28** — references TASKS.md as the evidence authority. (The tracker
    itself is a legacy view per AGENTS.md; keeping it as history is fine, pointing from it at
    another retired file is not.)

## B. Stale quantitative claims (H — several are in the README a newcomer reads first)

Ground truth measured at `origin/main@14e2a817`:

| Claim | Docs say | Code says | Evidence |
|---|---|---|---|
| Browser tool count | README.md:56 "**125 Chrome tools**"; README.md:107 "the browser-tool count is 126"; PLAN.md:31 "**126**"; PRODUCT.md:196-198 "flat list of 126" | **138** browser tools (+ 3 developer-only cookie tools), 50 management, 188 capability rows | tests/chrome-tool-capabilities.test.ts:60-72 (`CHROME_TOOL_CAPABILITY_TABLE.length === 188`, 138 chrome-api, 50 management, `CHROME_TOOL_CAPABILITY_BOUNDS {browserTools:138, managementTools:50, totalTools:188}`); extension/lib/browser-tools.js has 138 `tool({` definitions |
| Capability table size | PLAN.md:32-33 "dropped to 155 … regrown to 160"; docs/OPEN-QUESTIONS.md:35,44 "159 → 155", "167 → 166" | **188** | same test as above |
| Bundled Wasm tools | README.md:70 "**28 bundled Wasm tools**"; PLAN.md:170 "**28 bundled Wasm packages ship**" | **31** admitted (sed, awk, jq joined the 28) | packages/bundled/README.md:1-3 ("31-tool execution tranche") listing all 31 admitted descriptors |
| Lazy provider definitions | README.md:62-63 "every run receives **exactly two definitions**, `search_tools` and `execute_tool`" | **Three**: `search_tools`, `list_tools`, `execute_tool` | extension/lib/lazy-tool-protocol.js:1464, 1478, 1491 (the three `tool({…})` definitions) |
| Unit tests | README.md:253 "**1779/0**"; PLAN.md:11 "**1779 pass / 0 fail**" | stale (2457 pass at the 2026-08-30 reanalysis; higher today) | REVIEW-2026-08-30.md; the number moves daily — the honest fix is to stop hardcoding it (see fix plan) |
| Chrome journeys | README.md:253 "**127/127**"; PLAN.md:12 "**127/127**" | stale (138/138 at 2026-08-30; current count differs) | REVIEW-2026-08-30.md |
| Chrome-lazy metadata counts | docs/tool-platform-architecture.md (§"Source-only Chrome lazy capability metadata") "the exact **nine** `browserToolset(false)` and **29** `managementToolset` names", "all 38 descriptors" | 138 + 50 | tests/chrome-tool-capabilities.test.ts:67-69 |

Note README.md is internally inconsistent (125 vs 126 in the same file) in addition to both being
stale.

## C. References to deleted surfaces/directories (M)

`extension/chat/` and `extension/memory/` no longer exist at tip (deleted; verified via
`git ls-tree origin/main extension/`). `extension/recipes/` is also gone (though
`extension/lib/recipes.js` still exists — the recipes→skills rename is an open P3, bead
chrome-agent-platform-l0r). Stale references:

12. **README.md:194** — the architecture tree lists `chat/` ("the conversation surface").
13. **PLAN.md:86** — "Landed and shipping" includes "NTP hub, side panel, **chat**, directory,
    **memory explorer**, options".
14. **PRODUCT.md:66-67** — "Twelve HTML surfaces ship; two of them — `chat/chat.html` and
    `memory/explorer.html` — are referenced by nothing at all and still ship to users." Both files
    were subsequently deleted (the "Subtract surfaces" action happened): **10** HTML files ship now
    (verified: artifact, artifacts, directory, ntp, offscreen, options, privacy, sandbox×2,
    sidepanel). The paragraph should record the deletion, not the dead weight.
15. **docs/CONSTITUTION.md** (§1 XSS bullet) — "chat/directory/memory render untrusted data with
    textContent/escaping" — two of the three named surfaces are gone.
16. **docs/UX-AUDIT-2026-08-28.md:73** — evidence row cites the `chat` surface (360px overflow).
    Point-in-time audit; acceptable as history, but any "still true" reading of it is broken.

## D. Stale status headers on design/plan docs (M)

17. **docs/tool-platform-architecture.md** — the worst offender for the architecture story:
    - Status line: "live bounded lazy-provider cutover is a **0.2.180 release candidate** … fresh
      browser acceptance plus independent release review remain pending." The cutover shipped long
      ago (tip is 0.3.229; PLAN.md describes the lazy provider as landed and shipping).
    - §"Live bounded lazy protocol": "bundled Wasm rows are **always projected as disabled
      catalog-only metadata. They receive no selection reference, validator, authorization
      callback, or provider dispatch closure**" — contradicted by
      extension/background/service-worker.js:1430 (`executableBundledToolRecords(…)` folded into
      every run's records with `closureGeneration: "task-execution-core"`) and by
      docs/UNIX-TOOLS-ADMISSION.md:5-9 ("available through the ordinary `search_tools` →
      `execute_tool` path"). packages/bundled/README.md:10 ("Model calls use the lazy selection
      authority and live run fence") agrees with the code. The doc is the odd one out.
    - Repeated "source-only / unreachable / no product file imports this" claims for the OPFS
      workspace, WASI execution host, and package authority slices — all three now have shipped
      execution paths (extension/lib/wasm-executor.js, wasm-offscreen-host.js, wasm-stream-*.js,
      opfs-tool-workspace.js consumed by the live pipeline).
    - §"Planned authority split" items 1-4 are described as future; all are landed.
18. **docs/AGENT-EXECUTION-ARCHITECTURE.md** —
    - Header says "Phases 1–4 all implemented and shipped" but §6 still reads "Phase 2 — move the
      agent-do run loop into the worker (**NEXT**)" (and Phases 3/4 as forward-looking). Internal
      contradiction.
    - §7: "The `chrome.offscreen` API requires no manifest permission — confirmed by this
      codebase… works with `permissions: []` and no `offscreen` entry." The manifest at tip
      declares `offscreen` as one of the four **required** install permissions
      (extension/manifest.json `permissions: ["alarms","offscreen","sidePanel","storage"]`).
      Either the doc's claim was wrong or the posture changed; as written it misinforms.
19. **docs/AGENT-DELEGATION.md:2** — "Status: implemented (**candidate on branch
    `cap-agent-delegation`**)." Delegation is merged: extension/lib/agent-delegation.js and
    `delegate_to_agent` (extension/lib/chrome-tool-capabilities.js:205) are on main.
20. **docs/THREAD-LOADING-REDESIGN.md:3** — "Status: DESIGN, awaiting owner review. **Nothing
    here is implemented.**" The thread-open work landed (`0.2.314`/`0.2.317`, PLAN.md:152-156:
    per-execution ordered log index + cursor pagination).
21. **PLAN.md:189-192** — "Python via Pyodide … The remaining step is the Pyodide runtime
    **binary**, a blocked Emscripten build." Pyodide shipped: official 0.26.4 core admitted and
    wired (extension/background/service-worker.js:9910 `setPythonRuntimeProvider(...)`;
    extension/lib/python-runtime.js:46-51 pins the SHA-256 of every runtime file; CHANGELOG
    0.3.127-0.3.130, 0.3.137). docs/PYODIDE-BOUNDED-BUILD.md carries the correct status note —
    PLAN.md never got it. (Same staleness in python-tool.js:9-10 header comment "Until the runtime
    is admitted, `pythonTool` fails closed" — code comment, not a doc, noted for completeness.)
22. **docs/CONSTITUTION.md** — the closing "**The current gate state** — 2026-08-15: independent
    review REJECTED the build twice … Re-review in flight." A three-week-old transient state
    presented as current, and it references the retired independent-review loop (see E-25).

## E. Process/terminology drift (M/L)

23. **README.md:115** — "The review loop (**sol / GLM / DeepSeek, independent sessions**) reviews
    every change." That fleet was retired 2026-08-27 (AGENTS.md "Review without a second model").
    The README promises a control that does not exist.
24. **README.md** doc map (lines ~241-251) omits **REVIEW-2026-08-30.md** — the current reanalysis
    that AGENTS.md ("The current review (2026-08-30) — read before picking up work") calls the
    required entry point — while listing the superseded REVIEW-2026-08-21.md.
25. **Chaos references (AGENTS.md hard rule: "No chaos references"):**
    - README.md:43 — "the chaos skill-loader pattern".
    - docs/HOOKS.md (catalog intro) — "The reference implementation (**the chaos extension**) wires
      11 of these…".
    - docs/usage-precedent-review.md — title and body: "precedent review (**CHAOS**)", "CHAOS
      contracts (present, read-only)" (multiple).
26. **Recipes terminology** — "recipes" persists in user-facing-adjacent docs where the rename is
    presented as done: docs/AGENT-PRODUCT-GAPS.md:41,45,72,93,110,118; docs/HOOKS.md (subscription
    model: "the recipe's prompt", "Background recipes subscribe"); docs/agent-deletion-lifecycle-
    design.md:18,22,142; docs/SYSTEM-PROMPTS.md (scopes: "recipe runs"). Caveat:
    `extension/lib/recipes.js` still exists and the rename completion is open (bead
    chrome-agent-platform-l0r), so these are partly *accurate*; the finding is that docs mix
    "skills" and "recipes" without telling the reader the rename is half-landed. docs/PRODUCT.md:95
    says "the files followed the UI where it was safe (`extension/recipes/` is gone)" — true for
    the directory, not the lib.
27. **docs/OPEN-QUESTIONS.md** — Q12 carries "**ANSWERED (2026-09-01)**" but remains in the "Open"
    section; PLAN.md:247 still lists Q12 among "Genuinely open". One of the two is wrong.
28. **docs/UX-AUDIT-2026-08-28.md, docs/MODEL-PRICE-AUDIT-2026-09-02.md,
    docs/inline-approval-audit.md, docs/SETTINGS-CLEANLINESS.md** — dated point-in-time audits with
    no "superseded/landed" status line. Not wrong, but indistinguishable from live docs. A one-line
    status header on each would fix the class.

## F. ROUTE_MAP.md drift (M)

29. **extension/background/routes/ROUTE_MAP.md** — titled "Slice 1"; its inventory lists only the
    kv / perm-lease / provider / activity / memory / fs-grant / agent-workspace modules and states
    "*All other routes (114)* — extension/background/service-worker.js (inline). To be modularized
    in subsequent slices." At tip the routes directory has **13 modules** — auth, mcp, scheduler,
    agent-schedule, agent-worker (and index) are unlisted — so both the inventory and the "(114)"
    count are stale. (Verified: git ls-tree origin/main extension/background/routes/.)

## G. Missing documentation (H for the architecture stage)

No doc exists at all for these shipped subsystems (the stage-2 ARCHITECTURE.md will cover them;
recording as gaps a reader hits today):

30. **A system-level architecture map.** The architecture is scattered across README's 12-line
    tree block + ~10 feature design docs, several of them stale (finding 17). Nothing answers
    "what are the processes, who holds authority, how do they talk" at current main.
31. **OPFS / memory architecture.** Origin-keyed stores, the one-OPFS-root-per-origin platform
    constraint and the isolation gymnastics around it, per-store bounds (8 MiB store / 256 KiB
    value / 64 MiB tree — cited only inside DURABLE-RUN-ARCHITECTURE.md), artifact custody, agent
    private workspaces — no home. AGENTS.md's "Agent private workspaces" section is the only
    workspace doc.
32. **The shipped Wasm execution path.** 13 `wasm-*`/`wasi-*` modules, the offscreen host, the
    stream host — tool-platform-architecture.md documents the pre-execution "source-only" slices
    and explicitly disclaims the execution path; UNIX-TOOLS-ADMISSION.md covers the admission
    profile. Nothing documents the runtime as shipped.
33. **Table/spreadsheet tools.** Seven `table-*.js` modules (core, formula, join-pivot,
    operation-worker, runtime, worker-host, tabular-diff) with no design doc.
34. **Messaging/route surface as a whole.** ROUTE_MAP.md covers a slice (and a stale one — F-29);
    the agent-worker protocol is documented (AGENT-WORKER-DURABILITY.md §5) but the overall
    routing/principal model lives only in code + ROUTE_MAP's three-paragraph preamble.
35. **Python execution as shipped.** PYODIDE-BOUNDED-BUILD.md is a build spec with a corrective
    status note; the shipped dispatcher (python-host.js, fresh classic worker per run, offscreen
    transport) has no architecture doc.

## H. Verified-current docs (no action)

Checked and found accurate/current: docs/CONSTITUTION.md (except findings 15, 22),
docs/SYSTEM-PROMPTS.md, docs/MCP-SUPPORT-DESIGN.md (includes its landed spike + injection
results), docs/PERMISSION-MATRIX.md, docs/AGENT-WORKER-DURABILITY.md, docs/AGENT-WORKER-PHASE4.md
(honestly records the client + lease removals), docs/PYODIDE-BOUNDED-BUILD.md (self-correcting
status note; minor: §5's "runtime lives in OPFS, not the bundle" line wasn't individually marked
superseded), docs/LOCAL-MODELS-ARCHITECTURE.md (honest removal log), docs/OPEN-QUESTIONS.md
(current except finding 27), docs/DURABLE-RUN-ARCHITECTURE.md (but see finding 36),
docs/durable-background-runs-design.md (explicitly marked HISTORICAL), docs/TOOL-PURPOSE-GROUPS.md,
docs/UNIX-TOOLS-ADMISSION.md, docs/wasm-tool-catalogue.md (all three new at tip).

36. **docs/DURABLE-RUN-ARCHITECTURE.md — mixed citation currency (M).** The header binds every
    citation to commit `dd41258f` / release 0.2.113 ("Source citations below resolve against
    `dd41258f`"), but the body has been updated with post-0.2.113 content (RUN_RETENTION_POLICY
    `run-retention-v2`, `perThread` 50 from CAP-FB-20260901-THREAD-RELOAD-FIDELITY-01,
    `compactExecution`). A reader cannot tell which line citations resolve at tip and which only
    at dd41258f. Either re-pin the header or split "snapshot evidence" from "living reference".

## I. Local (non-repo) observation for stage 6

37. `docs/.build/` — 309 MB of untracked Rust build residue (tokei target dir) on local disk. Not
    git-tracked (verified: `git ls-files docs/.build` is empty), so not a repo defect — but a
    cleanup candidate for the stage-6 inventory and possibly a `.gitignore` check.

## J. Addendum — found during the stage-2 architecture pass (2026-09-05, all at tip)

38. **dptw staleness class (H).** The 2026-09-03 owner directive removed byte ceilings; docs not
    updated: docs/DURABLE-RUN-ARCHITECTURE.md §"OPFS records" ("each store remains byte-bounded
    at 8 MiB, each value at 256 KiB, and the full OPFS tree at 64 MiB") — refuted by
    `extension/lib/memory.js:691-698` (`assertQuota` is a no-op: "dptw: no quota gate … the
    browser's OPFS quota is the only ceiling") and `memory.js:162` (no per-value bound).
    docs/OPEN-QUESTIONS.md Q16 ("the explicitly lower single-body cap (256 KB, already the
    artifact limit)") — refuted by `extension/lib/artifacts.js:422` (`maxContentBytes: Infinity`).
    docs/tool-platform-architecture.md (tier byte gates; "large remains blocked") — refuted by
    `extension/lib/wasm-package-authority.js:20-24` (tier maxBytes `Number.POSITIVE_INFINITY`,
    `large` admission `"allowed"`). Belongs in fix bead lq5m.
39. **offscreen.js double registration (needs code-owner look).**
    `extension/offscreen/offscreen.js:16-21` registers the identical `handleScriptRunMessage`
    listener twice. If the handler does not dedupe internally, every script message is handled
    twice. Not a docs fix — candidate risk-register/cleanup bead.
40. **Stale module header comments (L).** `extension/lib/wasm-executor.js:1-2` ("SOURCE ONLY AND
    UNREACHABLE" — it is the live execution path, imported by offscreen.js/options.js/
    wasm-stream-host.js) and `extension/lib/python-tool.js:9-10` ("Until the runtime is admitted,
    `pythonTool` fails closed" — the runtime is admitted and wired at
    service-worker.js:9910). Code comments, not docs, but they mislead a reader of the live tree.
    Belongs in fix bead md7m.

---

## Fix plan (prioritized; each lands through the normal review flow — main is frozen)

**P1 — truth about process (cheap, high-traffic):** — DONE 2026-09-06 (chrome-agent-platform-6j8i);
`tests/docs-process-truth.test.ts` pins findings 1-11 and 23-25 so they cannot come back.
1. README.md doc map + PLAN.md authority lines: point task/bug state at beads (`bd ready`,
   `bd list`), mark the four markdown trackers retired-in-place (findings 1-11).
2. README.md:115: replace the review-fleet claim with the 2026-08-27 labelled-review rule (23).
3. README.md doc map: add REVIEW-2026-08-30.md; demote REVIEW-2026-08-21.md to history (24).
4. Scrub the three chaos references (25) — AGENTS.md hard rule.

**P2 — truth about the product (numbers):**
5. README.md:56,62,70,107: 138 Chrome tools (or "≈140" with the test as the guard), three lazy
   definitions, 31 bundled Wasm tools. Consider replacing hardcoded counts with "see
   tests/chrome-tool-capabilities.test.ts bounds" so they cannot rot (6).
6. README.md:253 + PLAN.md:8-15 gate tables: either update to a measured current value with a
   date, or (better) state "gates are green at tip; the suite grows daily — see REVIEW-2026-08-30
   for the last full measurement" and stop hardcoding (6).
7. PLAN.md:170 (28→31), PLAN.md:32-33 (capability table 155/160→188), PLAN.md:189-192 Pyodide
   entry → shipped (21), PLAN.md:86 + README.md:194 + PRODUCT.md:66-67: drop/revise chat//memory
   explorer references (12-14), PRODUCT.md:196-198 flat-list-of-126 paragraph → purpose groups
   landed (docs/TOOL-PURPOSE-GROUPS.md) (6).
8. CONSTITUTION.md: refresh the closing gate-state section and the XSS bullet's surface list
   (15, 22).

**P3 — status headers and the tool-platform rewrite:**
9. docs/tool-platform-architecture.md: mark the pre-cutover sections HISTORICAL (the style
   durable-background-runs-design.md already uses) and add a "current state" header pointing at
   the shipped execution path — or fold the living parts into the stage-2 ARCHITECTURE.md and
   retire the rest to history (17).
10. Status-line fixes: AGENT-DELEGATION.md:2 (19), THREAD-LOADING-REDESIGN.md:3 (20),
    AGENT-EXECUTION-ARCHITECTURE.md §6/§7 (18), OPEN-QUESTIONS.md Q12 placement (27),
    ROUTE_MAP.md re-inventory (29), DURABLE-RUN-ARCHITECTURE.md citation-currency note (36),
    docs/KNOWN-ISSUES.md redirect target (8).
11. One-line status headers on the four dated audits (28).

**Out of scope for doc fixes:** the recipes→skills rename completion (code work, bead
chrome-agent-platform-l0r); the missing architecture content (stage 2 of this umbrella fills
G-30..35).

**Suggested beads:** one bead per P1/P2 item group (1, 2-4, 5-8) + one for P3 (9-11), each with
the verification gate: `npm run build` clean + `npm run test:changed` green + a grep assertion
that the stale string is gone (the pattern already used by check:vocabulary).

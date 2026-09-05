# Project cleanup analysis — 2026-09-05 (lane cap-arch-docs, bead chrome-agent-platform-d0ag, umbrella 9zw7)

**Tree:** `origin/main@14e2a817`. **Method:** every candidate cross-referenced against
package.json scripts, `scripts/lib/harness-registry.ts` (99 entries — every `scripts/*.ts`
must be registered; tests/harness-registry.test.ts enforces), build.mjs, tests/, docs/,
and whole-repo `git grep`. Classification: **remove-now** (verified unreferenced or
gating dead artifacts) / **verify-first** (needs one named check before removal) /
**keep** (live or owned by an open bead). Nothing here is a sweep — every item carries
its own verification gate and its own bead (ids below). No item was removed by this
analysis.

## Remove-now (4)

| # | Item | Why safe | Verification gate |
|---|---|---|---|
| C1 | `scripts/skill-import-proof.mjs` | Zero references anywhere at tip (whole-repo grep). A one-off live proof for CAP-FB-20260830-SKILLS-UNCAPPED-01, which shipped; behavior is pinned by tests/skill-promotion-eval.test.ts + skill unit tests. | `git grep skill-import-proof` → only git history; `npm run build` clean; `npm test` green. |
| C2 | `scripts/check-tasks.mjs` + `scripts/check-tasks-baseline.json` + the `check:tasks` npm script + its position as the FIRST step of `test:all` | The gate enforces the schema of TASKS.md/TASKS-DONE.md — both RETIRED 2026-09-02 (beads directive). The files are frozen, so the gate can never catch anything new; it only misleads (implies the tracker is alive). The 32-entry baseline exists solely for the retired files. | grep shows the only refs are package.json + itself; `test:all` runs green without it; `npm test` green (it never ran there). |
| C3 | `probes/permissions-panel-shot.ts` | Unreferenced one-off probe for CAP-FB-20260831-OPTIONAL-PERMISSION-OMITTED-01 (shipped 2026-08-31). Its INSTALL_ONLY assumption (proxy/fontSettings/tts/declarativeNetRequest) is stale — all four are in `optional_permissions` at tip. probes/ is outside the harness registry. | grep clean; registry untouched; build green. |
| C4 | `reports/cap-ux/` (4.4 MB PNGs, dated 2026-08-28) | Committed evidence unreferenced by any doc (docs/UX-AUDIT-2026-08-28.md does not cite it — grep-verified). Evidence convention is durable storage outside the repo (`~/cap-evidence`), not committed PNGs. | grep clean; UX-AUDIT doc still self-contained. |

## Verify-first (14)

| # | Item | The one check that decides it |
|---|---|---|
| C5 | `scripts/build-pyodide-bounded.sh` | Owner confirms the custom Emscripten Pyodide build lane is permanently dead — docs/PYODIDE-BOUNDED-BUILD.md's status note says the official-dist admission made it moot. If confirmed: remove (git history keeps it). |
| C6 | `scripts/headed-acceptance.ts` (+ registry entry) | docs/PERMISSION-MATRIX.md already declares it superseded ("remains as an optional manual-evidence extra only"). Owner confirms no headed dependency is wanted; then remove. |
| C7 | `scripts/p0-repro.ts` (+ registry entry) | Red at the 2026-09-02 re-inventory; its own registry reason says "a repro script for a P0 that has since moved on". Identify the P0; if closed, remove. |
| C8 | `scripts/repro-recent-activity.ts` (+ registry entry) | Repro for the Recent-activity surface that the hub-timeline collapse cut (PRODUCT.md). If the surface is gone, the repro is dead. |
| C9 | `scripts/opfs-wal-probe.ts` + `scripts/thread-open-trace.ts` (+ registry entries) | One-shot probes for the thread-open redesign that landed (0.2.314/0.2.317). Evidence is recorded; probes are re-derivable from history. |
| C10 | `scripts/tool-call-evidence.ts` (+ registry entry) | Evidence run for CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 with a noted DOM.focus crash. If the legibility work has landed, remove. |
| C11 | `scripts/live-every-tab.ts` | Known broken (bead chrome-agent-platform-2ypf: kills only the Chromium parent, leaves children + temp profiles). Fix-or-remove decision rides on 2ypf — this bead links it. |
| C12 | `extension/lib/js-minifier-tools.js` + `extension/lib/jwt-decode-tools.js` (+ their worker bundles + tests) | RETAINED-map entries whose own reason says "No tool registers the bounded minifier/JWT decoder today; only tests import it … cut together with the named tests in a follow-up". The follow-up was never filed. NOTE: tests/scan-shipped.test.ts's canonical Worker-constructor exemptions are bound to these files — the removal must update the scanner's exemption anchors. Gate: check:reachability + scan-shipped + full suite. |
| C13 | `extension/lib/preference-bridge.js` | RETAINED: "No page mounts the preference bridge" (docs/PREFERENCE-PERCOLATION.md is a design only). Owner decision: adopt the design or cut the module + its security test. |
| C14 | `extension/shared/agent-candidates.js` | RETAINED: replaced in product by shared/agent-registry.js; scripts/sync-gallery.mjs still copies it into docs/ and 3 tests import it. Migrate tests to agent-registry, drop the gallery copy, remove. |
| C15 | `extension/lib/profile-store.js` | RETAINED: "Only tests/profile-store.test.ts imports it." No owning bead found — decide what it was for; cut with its test. |
| C16 | `extension/lib/run-log-wal-memory.js` | A test double living in lib/, imported by 8 tests; its RETAINED reason says "it belongs under tests/". Move (refactor, not removal). Gate: full suite green. |
| C17 | Retired root trackers: `TASKS.md`, `TASKS-DONE.md`, `KNOWN-ISSUES.md`, `docs/UI-FIXES-TRACKER.md` (+ the docs/KNOWN-ISSUES.md redirect) | Owner decision: delete from the working tree (they persist in git history) or keep the frozen banners. C2 (the check-tasks gate) should land first either way. |
| C18 | `docs/.build/` — 309 MB untracked Rust build residue (local disk, NOT git-tracked) | Regenerable from docs/plans/rust-lane sources. Local cleanup + consider a `.gitignore` entry so it can't be committed by accident. |

## Fix-forward (1) — the opposite of a removal

| # | Item | The gap |
|---|---|---|
| C19 | `scripts/check-models.mjs` — wire it into a gate | extension/lib/model-catalog.js:11 says this script "fails the [build]" on retired model ids, but NO npm script, test, or CI step runs it (grep-verified at tip). A guard nothing runs is a lying guard. Either add it to `test:all`/build or delete it. Recommended: add to test:all after check:vocabulary. Gate: `node scripts/check-models.mjs` passes at tip, then is present in test:all. |

## Keep (checked, live — the load-bearing list)

- **Harness machinery:** harness-registry.ts + kat-runner.ts + all gate/named/kat entries whose
  reasons are current (the registry self-polices: entries with `expectedRed` fail the run the
  moment they go green).
- **Build/package chain:** build.mjs, dist-complete.mjs, package-archive.mjs, package-extension.mjs,
  scan-shipped.mjs, store-target-policy.mjs, sync-gallery.mjs, check-vocabulary.mjs,
  check-reachability.mjs, bundle-budget.mjs (build + tests), check-changelog/sync-changelog/
  changelog-delta.mjs (tests + npm scripts), select-tests.mjs / run-tests.mjs / test-partition.mjs.
- **Live helpers:** mcp-probe-entry.js (build.mjs developer-build probe), refresh-model-prices.mjs
  (documented maintenance path for model-prices.js), build-test-extension.mjs +
  test-seam.snippet.js (harness helpers), evidence-runner.sh (registry-referenced),
  security-suite-supervisor.{sh,mjs} + security-suite-custody.mjs (test:security).
- **fixtures/** (the WebMCP demo + KAT fixtures — README demo + webmcp KATs).
- **packages/** + **wasm-tools/** (the admission evidence trees — the bundled-tool authority).
- **docs/plans/rust-lane/** + **docs/admissions/** (42+59 files; owned by open candidate lanes —
  PLAN.md:186-188. Their staleness is their owning lane's call, not a cleanup sweep's).
- **REVIEW-2026-08-21.md / REVIEW-2026-08-30.md / docs/KNOWN-ISSUES-ARCHIVE.md** — declared
  history; keep (but see audit findings on pointers INTO them).
- **RETAINED owner-pinned modules:** lib/agent-cards.js (open bead pu7n), lib/bundled-tool-packages.js +
  lib/bundled-inventory.js (owner directive must-not-change), lib/tabular-diff-artifacts.js +
  lib/code-diff-artifacts.js (open CAP-FB entries own them).
- **.codex/hooks.json, CLAUDE.md → AGENTS.md symlink, browser-shim-*.js, deno*.jsonc** — live
  tooling/build config.
- **docs/.build caveat:** not tracked; the ONLY local-disk item (C18).

## Notes for the coordinator

1. The harness registry's 2026-09-02 re-inventory makes the scripts/ surface unusually honest —
   the cleanup surface is small BECAUSE that gate exists. The 6 registry-entry removals above
   (C6-C10) each need their registry row deleted in the same commit (the test enforces it).
2. C12's scanner-exemption coupling (scan-shipped.test.ts anchors on the minifier/jwt files) is
   the only removal with a non-obvious blast radius — the RETAINED comment documents it.
3. Stage-1 finding 37 + this C18 are the same item (docs/.build).
4. One correction this stage fed back: ARCHITECTURE.md §1.5/§5.4 initially described
   `opfs-tool-workspace.js` as the live workspace; the reachability RETAINED map proves it is
   tests-only, and the shipped stream plane is wasm-stream-files.js. Fixed in the draft.

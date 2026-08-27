# Known Issues — Chrome Agent Platform

**[`TASKS.md`](TASKS.md) is the authority for every open item.** This file used to be a
second tracker holding the same findings, which is how both of them drifted. It is now a
thin view: current gate state, plus the handful of findings that are genuinely open and
not obvious from the task titles.

Reviewed 2026-08-28 against `origin/main`. Twenty-seven rounds of historical review
findings are archived in [`docs/KNOWN-ISSUES-ARCHIVE.md`](docs/KNOWN-ISSUES-ARCHIVE.md) —
at archiving, 15 of the 18 findings there were already closed. Do not add to the archive.

## Gate state

Established by building the tree and running the gates, not by reading trackers.

| Gate | Result | Command |
|---|---|---|
| Build | clean — 80 generated files byte-identical, 26 packages, no `eval`/`new Function` in 151 shipped JS files | `npm run build` |
| Unit | **1779 pass / 0 fail** | `npm test` |
| Chrome journeys | **127 / 127** | `npm run test:chrome` |
| Security suite | **PASS** — no survivor, residue or poison | `npm run test:security` |
| Tracker schema · changelog · order · gallery drift | green | `npm run check:tasks` etc. |

The journey suite was red at 26/127 from `0.2.313` until `0.2.320`. It aborted on a step
driving a Settings section deleted two weeks earlier, and that single throw took 100 checks
with it. Fixed under `CAP-FB-20260827-MAIN-GATES-RED-02`.

## Open findings

Three, all with live entries in `TASKS.md`. Everything else previously listed here is done.

### Infrastructure — evidence lives on a RAM-backed filesystem
`CAP-FB-20260821-WORKTREE-HYGIENE-01` · P0 · OPEN

`/tmp` is a 46 GB tmpfs at **92% inode use** (955,417 of 1,048,576) holding **71 registered
git worktrees**. A reboot destroys every one of them and every retained evidence bundle a
`Gates:` field in the tracker points at. Evidence whose only copy is on tmpfs is not
evidence. Eighteen of those worktrees are dirty and must be preserved or consciously
reconciled before any cleanup; seven detached heads are bound under `rescue/*` tags.
Run `node scripts/worktree-audit.mjs` (read-only, refuses destructive operations) before
any worktree decision.

### Platform — the Wasm tool operating layer is unfinished, and partly not ours to finish
`CAP-FB-20260822-WASM-TOOL-PLATFORM-01` · P2 · OPEN

26 bundled Wasm packages ship and are verified at build time. The lazy two-definition
provider (`search_tools` / `execute_tool`) is live. What remains open: signer trust,
fresh-Worker integration and termination, owner-approved diff mutation, owner install, and
the abuse/quota gates. Two of its blockers are **product decisions, not engineering** —
whether a Store build may execute owner-selected local Wasm (Q13) and the Co-do
Apache-2.0-root vs MIT-metadata licence reconciliation (Q14), both in
[`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md). Dropped to P2 on 2026-08-27: it is
invisible in a demo.

### Consistency — the recipes→skills rename never finished
`CAP-FB-20260821-RECIPES-SKILLS-RENAME-01` · P3 · OPEN

`recipe.*` identifiers, routes and UI strings survive alongside the `skill` vocabulary the
product presents. A user-facing concept with two names in the code is how the `/` command
and the autocomplete fell out of sync the first time.

## Process findings

These are not code defects and have no fix commit; they are recorded because they recur.

**The gate went red the same way twice in three days.** `MAIN-GATES-RED-01` (25 Aug) and
`-RED-02` (27 Aug) were the identical class: a shipped change left the journey suite
driving something that no longer existed, and nobody noticed. The full-suite-green rule is
written down and was not applied at the moment work landed. A red number nobody trusts is a
gate nobody reads.

**A "derived" assertion can be weaker than the literal it replaced.** While fixing
`-RED-02` the author replaced a rotted `length === 7` with a value derived from the
product's own capability table — which made the check tautological and unable to fail. It
was caught only because the review rule changed the same day to require proving a changed
assertion can go red. See `AGENTS.md`, "Review without a second model".

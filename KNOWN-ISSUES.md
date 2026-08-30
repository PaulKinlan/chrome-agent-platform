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

## Reanalysis 2026-08-30

Full-project reanalysis of `origin/main@fc2255be` — seven lanes, real loaded extension,
four real providers. Rationale and the ordered queue: [`REVIEW-2026-08-30.md`](REVIEW-2026-08-30.md).
Umbrella: `CAP-FB-20260830-EXEC-DEMO-01`. The P0 ids, one line each; every entry is in `TASKS.md`.

- `CAP-FB-20260830-EXEC-DEMO-01` — the five-minute demo recorded end to end on a fresh profile.
- `CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01` — the Settings toggle leaks a 15-minute lease; runs and revoke deadlock on it.
- `CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01` — browser-tool denials use a shape the conversation drops, so no Allow card ever appears.
- `CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01` — the nudge summary overwrites the real answer; the persisted transcript is clipped to 240 chars.
- `CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01` — one schema slip burns the single-use selectionRef and ends the run with no message.
- `CAP-FB-20260830-KEYLESS-FIRST-RESULT-01` — no first result without a key; the demo provider replies with the size of the system prompt.
- `CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01` — 22 disabled templates listed as agents in the sidebar and side panel beside "0 agents" (integrate as templates, not a cut).
- `CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01` — templates become a first-class create flow (template gallery + Starter set); sidebar shows only agents the user made or enabled.
- `CAP-FB-20260830-MODEL-CATALOG-CURRENT-01` (P1, demo-blocking in practice) — every gpt-5.6 call is HTTP 400 on the shipped build (adapter omits `reasoning_effort:"none"`); Test connection rejected by every current OpenAI model; 127 retired model ids in the repo.
- `CAP-FB-20260830-GENERATED-IMAGE-STRIP-01` (P1) — an image strip of the screenshots and image assets a run produced, in the thread and on the hub; adopts `screenshot-strip`. No gallery component is deleted (owner, 2026-08-30).
- `CAP-FB-20260830-PAGE-ACTION-TOOLS-01` — no click/type/fill/scroll tool exists; owner question Q19.
- `CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01` — create_script + run_script is an unapproved fetch channel to any URL including loopback.
- `CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01` — page text reaches the model raw; no fence, no policy text, no regression probe.
- `CAP-FB-20260827-HUB-FIRST-RUN-01` — composer is tab stop 41 and below the fold at 1024x700 (updated).
- `CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01` — real runs leak `modelContent`/`catalogGeneration` and render protocol cards (updated).

## Open findings

Current findings all have live entries in `TASKS.md`. Everything else previously listed here is done.

### Agents — scheduled named-agent work is written outside its conversation
`CAP-FB-20260829-BACKGROUND-RUN-TRANSCRIPT-01` · P0 · IN_REVIEW

The alarm branch addressed named-agent memory by reusable slug, while interactive runs and
history address it by immutable instance ID. The candidate uses the loaded agent row's same
instance ID; the real-browser gate creates and fires a schedule, opens the real agent row,
and requires the scheduled prompt in the conversation.

### Composer — macOS dictation produces no transcript and obscures which microphone is alive
`CAP-FB-20260829-MIC-DEAD-MACOS-01` · P0 · IN_REVIEW

The landed decoupling fix starts SpeechRecognition immediately, but the owner still gets no
text and has multiple possible inputs. Web Speech cannot accept a `deviceId`: it follows the
OS default, while only the decorative `getUserMedia` meter can be retargeted. The follow-up
candidate exposes an anchored picker only for two or more physical inputs, re-enumerates
once after the first successful capture so pre-permission default-only enumeration cannot
hide it, persists a meter-only selection, gives each selection a brief real level check,
and fences out-of-order reselection/devicechange streams with their own request generation.
No-speech/audio-capture/fallback states name the OS-default-versus-meter split with a
System Settings recovery path.

### Infrastructure — worktree heads carried work that no ref was holding
`CAP-FB-20260821-WORKTREE-HYGIENE-01` · P0 · OPEN (loss risk closed; cleanup awaits an owner decision)

Re-measured 2026-08-28. The previous text here — 71 worktrees on a RAM-backed
filesystem at 92% inode use — was stale in both directions. Actual: **28
worktrees, 26 already on durable storage, 2 on tmpfs** (each holding one
untracked file, both heads on `origin/main`). `/tmp` sits at 90% inode use and
43% of 46 GB with both suites green, so the `ENOSPC` condition the task was
opened for no longer reproduces.

The real exposure was different: **11 worktree HEADs held commits not reachable
from `origin/main`, none of them rescue-tagged.** Two were held by no ref at all
— `073c59f3` (cairn→cap rename) and `1e55c7cb` (six commits of P0 permissions
work) — and were one `git worktree remove` from garbage collection. A third,
`0816727f`, is the second-writer `main` described below, two commits ahead of
`origin/main`. Branch-held heads were not safe either: a prior cleanup on this
repository deleted 126 local branches.

All 11 are now bound under `rescue/*` tags (25 total, up from 13). The audit
re-run reports `unreachable+untagged: 0`. Purely additive — nothing removed.

What remains is an owner decision, not engineering: which of those lines are
live workspaces to keep and which are finished or abandoned and can be retired.
Run `node scripts/worktree-audit.mjs` (read-only) before any cleanup.

### Platform — the Wasm tool operating layer is unfinished, and partly not ours to finish
`CAP-FB-20260822-WASM-TOOL-PLATFORM-01` · P2 · OPEN

28 bundled Wasm packages ship and are verified at build time. The lazy two-definition
provider (`search_tools` / `execute_tool`) is live. What remains open: signer trust,
fresh-Worker integration and termination, owner-approved diff mutation, owner install, and
the abuse/quota gates. Two of its blockers are **product decisions, not engineering** —
whether a Store build may execute owner-selected local Wasm (Q13) and the Co-do
Apache-2.0-root vs MIT-metadata licence reconciliation (Q14), both in
[`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md). Dropped to P2 on 2026-08-27: it is
invisible in a demo.

### Consistency — the recipes→skills rename never finished
`CAP-FB-20260821-RECIPES-SKILLS-RENAME-01` · P3 · OPEN (narrowed 2026-08-28)

The USER-FACING half is closed by `CAP-FB-20260828-NOUN-DISCIPLINE-01` (`0.2.355`): no
string a person reads still says "recipe", `extension/recipes/` is gone, and
`npm run check:vocabulary` fails the build if one comes back. What survives is internal —
`extension/lib/recipes.js` with its `RECIPES` export, the `recipe.*` message routes
(`recipe.delete` sits in `OWNER_DIRECT_ACTIONS`, so this is an approval-boundary change,
not copy editing), and the tests named after them. A user-facing concept with two names in
the code is how the `/` command and the autocomplete fell out of sync the first time.

### Consistency — the wire still says `asset`
`CAP-FB-20260828-NOUN-DISCIPLINE-01` · P0 · IN_REVIEW

Every user-facing surface now says **Artifacts**, but the `asset.*` message routes, the
`*_asset` model-facing tool names, the `management.asset.*` capability ids and the `asset:`
OPFS keys still say asset. That was a deliberate stop: those strings are load-bearing in
the approval digest (`DESTRUCTIVE_ACTIONS`, `OWNER_DIRECT_ACTIONS`), in per-agent tool
allowlists, and in stored artifact bodies — renaming them is a security/data migration with
its own review, and doing it halfway is worse than not doing it. `check:vocabulary`
deliberately does not scan them, so the gate cannot be satisfied by weakening it.

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

### [P0 — OPEN] Two sessions write to `main` from separate worktrees, and work has already been lost once

`main` is checked out in a second worktree while this repository also pushes to
it. On 2026-08-28 that session force-pushed and **dropped three commits** of
landed, green work (the run-log performance line). It was recovered only because
the commits were still reachable locally.

At the time of writing the second worktree's `main` was **six commits behind**
`origin/main` with its own committed work on top, so its next push would have
dropped both the performance line and the Providers side-tabs work. That was
resolved by merging its committed tip forward (`dc04e4c7`) so its next push is a
fast-forward, and by binding both lines to tags:
`rescue/origin-main-20260828`, `rescue/agent-templates-20260828`,
`rescue/wal-work-20260828`.

**This will recur.** The mechanism is unchanged: two writers, one branch, no
coordination, and `--force` available. Options, cheapest first:

1. **Never force-push `main`.** A rejected push is a signal to merge, not an
   obstacle to overpower. This alone would have prevented the incident.
2. **One worktree owns `main`;** every other session works on a branch and
   merges. The repository already has 71 worktrees — the convention exists, it
   just is not applied to `main`.
3. Protect the branch server-side so the choice is not available.

Recorded here rather than as a `CAP-FB-*` task because it is a working-practice
decision for the owner, not an engineering change.

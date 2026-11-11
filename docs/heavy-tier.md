# The heavy tier, and what a landing's gate actually covers

`chrome-agent-platform-1lvay`. The rule this page exists to state:

> **A landing's gate NEVER covered the heavy tier. It now covers 18 of its 21 suites. The other
> three are swept on a schedule, and every receipt names them.**

## Why "the heavy tier" was the wrong unit

Measured 2026-11-11 on the fleet VM (`fleet-gate heavy-parallel-baseline`, load 3.7):

| population | files | cost | can a landing afford it? |
| --- | --- | --- | --- |
| per-landing heavy | 18 | **19s** (240 tests, measured) | yes — +7% on a ~260s full gate |
| mega | 2 | **2310s** (1416s + 894s, recorded in `scripts/heavy-gate.ts`) | no — 6.4x the whole gate |
| wall-clock | 1 | needs its own quiet window (refuses with exit 75) | no — not a reliable measurement beside other work |

That is a ~120x cost spread, so one policy for "the heavy tier" was always going to be wrong in one
direction or the other. The spread is declared in `scripts/test-partition.mjs`:
`PER_LANDING_HEAVY_FILES`, `MEGA_HEAVY_FILES`, `WALL_CLOCK_HEAVY_FILES`, `DEFERRED_HEAVY_FILES`.

## What happens on a landing now

`npm test` (the FULL landing gate) runs the 18 per-landing heavy suites in **their own phase** after
the general parallel phase. They are never merged into the general batch: the RAM/CPU reason the tier
was created for is about sharing a batch with ~779 general suites, not about the 19s they cost alone.

```
run-tests: <N> files total ... (18 serial, 5 post-build read-only, <M> other parallel, 18 per-landing heavy)
run-tests: heavy-parallel: ran 18 suite(s) at this tree
run-tests: heavy-mega: NOT RUN at this sha (last green 1a2b3c4d5 6h ago)
```

A red in any of the 18 reds the landing gate, so its staleness bound is **zero landings**.

## What a receipt says, and why the wording is fixed

coord's ruling (2026-11-11): a receipt must not say `heavy: deferred` — that reads like a scheduling
note — it must say `heavy-mega: NOT RUN at this sha (last green <sha> <age>h)`, which reads like the
gap it is. `heavyTierStatus()` in `scripts/lib/gate-manifest.mjs` produces exactly four forms and
`tests/heavy-tier-ledger.test.ts` pins each one:

| fact | line |
| --- | --- |
| both populations ran at this tree | `heavy-mega: ran at this sha (PASS, 2h ago)` |
| stale green from another tree | `heavy-mega: NOT RUN at this sha (last green <sha> <age>h)` |
| last sweep failed | `heavy-mega: NOT RUN at this sha (last run <sha> FAIL <age>h)` |
| never swept | `heavy-mega: NOT RUN at this sha (never run — no scheduled sweep has reported)` |

The structured copy rides the manifest payload as `tiers` (and `heavy_parallel_suites`), so a consumer
reads it without parsing prose.

## The scheduled mega sweep (`scripts/heavy-mega-sweep.ts`)

```bash
deno run -A scripts/heavy-mega-sweep.ts --dry-run   # name what would run, touch nothing
deno run -A scripts/heavy-mega-sweep.ts             # sweep, record, file a P1 on red
```

* Runs `MEGA_HEAVY_FILES` only, with `CAP_HEAVY_MEGA_TIMEOUT_MS` (default 3600000).
* Writes the durable record the landing gate reads:
  `cap-evidence/heavy-receipts/mega-last.json` — `{sha, result, at, suites}`.
* **On RED it files a P1 bead** (label `heavy-mega-sweep`) and re-sweeps comment on that bead instead
  of filing thirty of them. A report nobody reads is how main stayed red since `lrhyl` while every
  landing certified green.
* `result: environmental` (a suite that refused with 75) is recorded and does **not** file a P1: the
  box could not measure, which is a different fact from the code being red.

Schedule it at least every 24h — the bound the bead states:

```cron
30 4 * * * cd /home/exedev/worktrees/chrome-agent-platform-impl-d && CAP_HEAVY_MEGA_TIMEOUT_MS=3600000 /path/to/deno run -A scripts/heavy-mega-sweep.ts --tier=all >> /home/exedev/cap-evidence/heavy-receipts/mega-sweep.log 2>&1
```

(Installed on the fleet VM at 04:30 daily; a nightly job that runs 40 minutes should not share the box
with a landing.)

## The tier ledger: all four populations, stated per population

`scripts/lib/tier-ledger.mjs` builds the ledger; it rides the gate receipt as `tiers` and prints one line
per population. Four states, each derived from a durable record and never assumed:

| state | meaning | line |
| --- | --- | --- |
| `ran` | the record's sha is this tree's and it passed | `heavy-mega: ran at this sha (PASS, 2h ago)` |
| `failed` | it ran at this tree and failed | `heavy-mega: ran at this sha (FAIL, 1h ago) — this is a RED, not a gap` |
| `stale` | a record exists for another tree | `kat-harnesses: NOT RUN at this sha (last green abc123456 30h ago)` |
| `never-run` | no record at all | `kat-harnesses: NOT RUN at this sha (never run — no run has ever recorded a result for these 86 kat/named browser harnesses)` |

Never-run is its own state because **absence is the defect**: 86 harnesses went invisible precisely by
not appearing anywhere. Coverage of the four populations:

| population | count | recorded by | when |
| --- | --- | --- | --- |
| per-landing heavy | 18 | the landing gate itself | every landing |
| mega heavy | 2 | `scripts/heavy-mega-sweep.ts --tier=mega` | daily |
| wall-clock NTP | 1 | `npm run test:heavy` | on demand / with the heavy receipt |
| kat + named harnesses | 86 | `scripts/heavy-mega-sweep.ts --tier=kat` | daily |

The KAT count comes from the registry *module*, not from a number in a doc: the parse in
`parseHarnessRegistry` is cross-checked against `HARNESSES` in `tests/heavy-tier-ledger.test.ts`, so a
drift in either reds the gate. (A naive `[^{}]*` parse loses 4 real entries — reason strings contain
`{missing:true}` — which is the under-count this ledger exists to prevent.)

## What is still NOT covered by a landing

* the 2 mega-suites and the wall-clock suite (above) — visible in every receipt, swept nightly;
* the browser/KAT harnesses: `scripts/lib/harness-registry.ts` declares **72 `kat` + 14 `named`**
  harnesses that `npm test` does not run at all. `kat-python-permissioned-fetch` — the red that
  prompted this bead — lives there, not in the heavy tier. Running the heavy tier could never have
  caught it; the receipt field is what makes that population visible, and it is the next piece of
  work in this family.

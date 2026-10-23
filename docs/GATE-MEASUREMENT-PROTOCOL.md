# Gate-Phase Measurement Protocol

What a wall-clock number from a gate run can and cannot decide, and how to take one that decides anything.
Source: `chrome-agent-platform-og9m7`, after four decisions in one day were made inside the measurement noise
(a 430 s "guard floor" that justified raising a fast-tier bound, a 202.7 s per-suite attribution that nearly
justified a refactor, a 3.8x schedule win that became 1.7x and then vanished, and a timer raise built on the
first).

## 1. The noise floor is measured, not assumed

Four **identical** arms of `select-tests --always-on` (50 always-on suites, one committed tree, page cache warmed
between runs, all `rc=0`):

| arm | wall | load (1-min, after) |
|---|---|---|
| 1 | 193 s | 4.59 |
| 2 | 176 s | 8.72 |
| 3 | 238 s | 4.95 |
| 4 | 187 s | 5.82 |

**Spread between these identical arms: 1.35x** (max/min). No cold-first-arm effect: the first arm was not the
slowest, and the warm-up read removed the filesystem variable it would have proxied. No load correlation either:
the fastest arm ran at the highest reported load. So load average is not a usable predictor here, and a "quiet
box" is a description, not a control.

**What this sample is, and is not.** It establishes a noise floor. It is **not** protocol-compliant A/B evidence
and must not be quoted as if it were:

- it records **load only after** each arm, not before and after (rule 5 below would void it);
- the arms are **four repetitions of one schedule**, not two schedules interleaved (rule 2 below);
- there is **no per-arm scheduler log** naming which path ran (rule 6 below).

A same-schedule repeated-run sample is exactly what a noise floor needs; it just cannot decide a comparison.

### The floor is a formula, not a constant

Do not hard-code the number. The threshold for treating a wall-clock difference as real is:

```
threshold = max(measured identical-arm spread, worst same-schedule pair) over the WINDOW
WINDOW     = the last 10 valid comparisons, or all comparisons from the last 30 days if fewer than 10 exist
```

Both terms are maxima over that **window**, never over all history: an all-time maximum can only grow, so it would
be set by the worst artefact ever recorded and could never relax - a floor like that stops measuring and starts
legislating. A comparison is **valid** (and enters the window) only if it has at least two arms per side, interleaved,
load recorded before and after each arm, no refusal, and the scheduler line attached (rule 6). Invalid comparisons
are recorded but do not move the floor.

Today the window gives **~2x**: ~1.35x identical-arm spread from the four-arm sample above (a sample, not the floor),
and ~2.0x from the widest same-schedule pair on one tree (291 s and 147 s, `scripts/run-tests.mjs`, 2026-10-23). It
**tightens or relaxes as the window rolls**: when an old outlier ages out and the remaining comparisons are tighter,
the floor drops, which is the point of stating the window instead of the number. Re-measure; do not re-quote.
Consequences:

- **Any wall-clock A/B whose effect is under today's ~2x threshold is undecided.** It is not a small win and it is
  not a small loss; it is the same measurement twice.
- **A bound raise requires a VALID MEASURED COMPARISON.** It can never be inferred from the existence of this
  protocol, from an expectation that the protocol makes measurements trustworthy, or from a single arm.
- **Per-suite and per-test numbers are far worse than the phase total.** Across the same four identical arms, the
  per-test duration ratio had a median of **2.39x**, a p90 of **5.0x** and a maximum of **18.5x** (53 of 156
  comparable tests varied by 3x or more), while the phase total varied 1.35x. A "this suite took 202.7 test-seconds"
  figure taken from a concurrent run describes the scheduler's mood, not the suite. The phase total is the only
  number that survives averaging, because 50 suites of wild per-test variance partly cancel.
- **Load must be printed with every number.** Three of the four bad decisions above came from comparing an arm
  measured under load ~7 against an arm measured quiet.

## 2. The protocol

1. **State the question as a threshold before measuring.** "Does X beat Y by more than the floor on wall?" - with
   the floor written down first, using the formula above (~2x today, from this session's samples). If the effect you
   expect is smaller than that floor, the experiment cannot answer it: change the question or the metric, do not
   run it and hope.
2. **Interleave arms: A B A B**, never A A B B. Blocking lets a load drift attach itself to whichever side ran
   second; the four-arm A/B that withdrew a schedule change only became readable once the arms were interleaved.
3. **At least two arms per side**, so each side has its own spread to compare against the other's.
4. **Warm the page cache** (`find tests scripts -name '*.ts' -o -name '*.mjs' | xargs cat > /dev/null`) and say so.
5. **Print load before and after every arm**, and treat a run whose load moved by more than ~2x mid-arm as void
   rather than as data.
6. **Prove which scheduler ran - capture the scheduler line verbatim and attach it to the record.** Do not write a
   grep from memory: the strings differ per path, and a pattern that matches nothing silently certifies whichever
   arm the reader assumed. The announcements these runners print today are
   `run-tests: <phase> candidates (N file(s))` (`scripts/run-tests.mjs:58`),
   `run-tests: parallel scheduler longest-first (N selected file(s)); Deno default workers` (`run-tests.mjs:63`),
   `select-tests: <label> candidates (N file(s))` (`scripts/select-tests.mjs:740`) and
   `select-tests: N file(s) - partition: X serial hazard(s) [...], Y parallel` (`scripts/select-tests.mjs:813`).
   Quote the line and its count per arm; if the line you expect is absent, the arm did not run the way you think it
   did. An off switch that silently does nothing turns an A/B into the same arm three times - measured 2026-10-23 at
   174 s / 167 s / 222 s, which would have read as "no effect" and was actually "no experiment".
7. **Record the negative result.** A withdrawn change with its numbers attached is what stops the next person
   re-running it; a deleted branch is an invitation to repeat it.
8. **FAIL CLOSED when the machine cannot be measured.** If the load probe is truncated, the process scan refuses,
   or the box otherwise cannot be characterised, the run is **not evidence** - stop and re-run when it can be
   measured, and say so in the record. A gate was invalidated on 2026-10-23 by exactly this (`proc scan truncated
   after 241 entries`): the numbers looked usable, the measurement behind them did not exist. "The load looked
   fine" is not a characterisation; a refusal is the honest output.

## 3. What to report

- Wall for the **phase**, not per suite, unless the question is about one suite's own runtime - and then run that
  suite alone, serially, twice.
- The number of arms per side, the order they ran in, and the identical-arm spread you measured that day.
- Load before and after each arm, and the command line verbatim.
- The verdict word: **win**, **loss**, or **undecided**. Anything inside the noise floor is `undecided` and says so.

## 4. Known-good reference numbers

| measurement | value | conditions |
|---|---|---|
| always-on guard floor, parallel invocation | **160-176 s** | 49-50 suites, load 0.77-5.4, rc=0, measured 3x across two days |
| always-on guard floor, serial (concurrency 1) | 291 s / 147 s | same tree, two runs of one schedule - NOT an interleaved A/B, and NOT reproducible as a win - see below |
| identical-arm spread, phase wall | **1.35x** | 4 arms, same tree; load recorded after only, so this is the noise-floor sample, not an A/B |
| identical-arm spread, per-test | **2.39x median, 5.0x p90** | same 4 arms, same limitation |

The serial-guard experiment (`chrome-agent-platform-6741y`) is the cautionary case: its first reading was "3.8x
faster at concurrency 1", then "1.7x", and the interleaved A/B measured the opposite - **parallel was 1.8x-2.7x
faster**. Nothing about the change was wrong to try; the first three readings were all inside or near the noise
floor of the day's conditions, and only the fourth experiment had two arms per side and logs proving the schedule.

## 5. Open question

Why the same work takes 176 s and then 238 s is still unexplained. Ruled out by the four-arm run: page-cache
cold start (warmed, and arm 1 was not slowest) and reported load (fastest arm ran at the highest load). Still
open: scheduler worker-start ordering inside `deno test --parallel`, longest-suite alignment, and the cost of
`/proc` scans performed by the guards themselves under different ambient process counts. The falsifier stands:
four runs of one arm; if the identical-arm spread falls under ~10%, these differences are real and attributable,
and any withdrawn comparison reopens on its merits.

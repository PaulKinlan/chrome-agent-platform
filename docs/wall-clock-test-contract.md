# The wall-clock test contract as stated invariants (chrome-agent-platform-38czq)

**Status:** DESIGN for review — no implementation until this and one consolidated fix pass review together.
**Context:** three review rounds on the 9z8xs/63o3v stack each closed the named blockers and each
surfaced a new instance of the same class: an environmental refusal outranking a genuine product
red. That is a policy engine with ordering bugs, and it will keep reappearing seam-by-seam until
the ordering is stated once, in one place, and every verdict flows through it.

The wall-clock machinery is a **policy engine over evidence**. Under this design, every
observation a suite makes is `(value, envelopeStatus)` where `envelopeStatus ∈ {in, out,
unknown}` — a shape the 63o3v/38czq stack will introduce; today's suite still threads
`BootStagingRunResult` fields through imperative early returns. The engine's whole job is
to turn a set of observations into one of three verdicts: `product-red`, `environmental-refusal`,
`pass`. Every historical defect in this class is the engine reaching a verdict while ignoring or
inverting one of the five invariants below.

## The invariants

**I1 — Observed product evidence ALWAYS outranks environmental refusal.**
Once a suite has observed a product fact (a 404, a CSP violation, a runtime exception, an
in-envelope latency breach), that fact decides the verdict. No measurement of the host taken
afterwards may launder it. A refusal is a statement about MISSING evidence; it can never erase
PRESENT evidence.

**I2 — A measurement outside the declared envelope is not evidence in EITHER direction.**
It can neither red the product nor certify it. An outside-envelope breach is not a product red
(that was the 63o3v fix); an outside-envelope CLEAN run is not a pass (the hole round 3 found:
five starved runs with zero observed tasks reached `ok:true`). Outside-envelope observations may
only contribute to the REASON of a refusal, never to a verdict.

**I3 — Declared bounds come from the registry and cannot be widened by environment override for
certification purposes.**
Under this design, `WALL_CLOCK_BUDGETS[suite#phase].definedAt` — a registry the 63o3v/38czq
stack will introduce — is the contract. `CAP_QUIET_*` env vars must tune only the operator
experience (how long to wait for a quiet window), never what counts as inside the envelope. Any
path that derives the certification bound from `resolveSpec()` alone is a hole,
because `CAP_QUIET_MAX_LOAD_PER_CORE=1` then admits a 0.5/core measurement against a declared
0.35.

**I4 — Contention detection is closed under new processes.**
Any optimisation of the sampling path must count a heavy process that STARTED after the baseline
exactly as the unoptimised path does. A verdict read that only re-reads previously-seen pids
changes what counts as contention, and is therefore wrong no matter how much faster it is.

**I5 — Refusal is available only when NO in-envelope evidence exists.**
Refusal means "this run cannot say anything". If any in-envelope measurement exists, the verdict
comes from it: clean in-envelope evidence passes; failing in-envelope evidence reds. A suite that
measured five runs all outside the envelope has no evidence and MUST refuse; a suite with one
in-envelope clean run and four starved ones PASSES on that one run.

## The decision procedure that follows (the engine's total order)

Given the set of observations for a budgeted behaviour:

1. **Collect everything first.** No early returns. Every check — severe stalls, marginal tasks,
   latencies, content assertions — records into one evidence list tagged in/out/unknown.
2. If ANY product CONTENT failure is observed (a 404, a CSP violation, a runtime exception —
   content evidence is category-different from wall-clock measurements and reds the product
   regardless of host envelope status), OR any in-envelope wall-clock observation is a product
   failure → **product-red** (I1, I5).
3. Else if NO in-envelope observation exists → **environmental-refusal**, reason naming what was
   outside the envelope (I2, I5). "Unknown" envelope status counts as not-in (fail closed).
4. Else → **pass** (in-envelope evidence exists and is clean; out-of-envelope observations are
   inert) (I2, I5).

And the pre-wait corollary: a refusal gate may only guard a WAIT. Assertions over already-recorded
product evidence run BEFORE any gate is consulted (I1 applied to program order).

## The adversarial test list — each would have caught its round-3 failure

- **T1 (I4, failure 1):** baseline at t0 with zero builders; start a heavy-named process at
  t0+100ms; verdict read at t0+250ms MUST count it as contention. Round 3's targetedRebase
  re-read only `baseline.cpu` pids, so the new builder was invisible; this test reds that code.
- **T2 (I1, failure 2):** a chunk-resolution fixture with a RECORDED network 404 and a loaded box
  at the settle gate MUST produce the 404 red, never a refusal. Round 3's order called
  `refuseBeforeWait("settle")` before asserting the recorded `networkFailed`; this test reds that
  order. (Statically pinnable: content assertions precede refusal gates in program order.)
- **T3 (I1/I5, failure 3):** run 1 carries a severe task outside the envelope; run 2 carries a
  latency breach INSIDE the envelope → the verdict MUST be run 2's product red. Round 3's Check-1
  returned the refusal without consulting run 2; this test reds that early return.
- **T4 (I2, failure 4):** five runs, all outside the envelope, zero tasks observed → the verdict
  MUST NOT be `ok:true`; it is a refusal. Round 3's engine counted outside-envelope clean runs as
  evidence; this test reds that.
- **T5 (I3, failure 5):** with `CAP_QUIET_MAX_LOAD_PER_CORE=1` set, a run measured at 0.5/core
  against a declared 0.35 MUST be outside the envelope. Round 3's `attributeBootRun` derived its
  bound from the env-overridable `resolveSpec()`; this test reds that derivation.
- **T6 (property):** the decision procedure as a pure function, exercised over the exhaustive
  small table of evidence shapes (∅; one out; one in-clean; one in-red; mixed out-clean + in-red;
  mixed out-red + in-clean; unknown-only; …) — the table IS the contract, so a future reordering
  reds a row instead of a production gate.

## What must be restructured, not patched

1. **`evaluateBootStagingPolicy` (scripts/lib/ntp-boot-attribution.ts) becomes a
   collect-then-decide engine.** The sequential Check 1→2→3→4 early returns are the defect shape:
   every round-3 ordering failure lives in an early return that decided before all evidence was
   in. One evidence list, one decision function implementing the total order above. The existing
   checks become collectors.
2. **`attributeBootRun` takes the declared envelope as an input** (from `WALL_CLOCK_BUDGETS`, both
   axes), and a run outside the envelope is `validMeasurement: false` — "carries no evidence" —
   which makes I2 structural: the all-runs-contended refusal (existing Check 2) then fires for
   free when every run is outside the envelope.
3. **chunk-resolution-browser.ts: evidence before gates.** Recorded content failures are asserted
   before any refusal gate runs; gates guard waits only. The wait itself is the only thing a gate
   may preempt.
4. **The self-baseline verdict read is contention-complete.** Either the targeted re-read gains
   new-process detection (a comm-level `/proc` walk is cheap; full `stat` only for heavy-named
   newcomers) or the optimisation is reverted — I4 is not negotiable and "fast but blind to new
   builders" is not a sampling path.
5. **`resolveSpec()` env overrides must be documented and enforced as wait-tuning only.** The
   certification bound must be the registry's. Any current caller using the spec's
   `maxLoadPerCore` for a VERDICT (rather than for how long to wait) is a bug of the F3 shape.

## Non-goals

- No new mechanism families. The refusal shape (`CAP_ENVIRONMENTAL_REFUSAL`, plain Error, exit 75
  via the aggregator) and the registry stay as built on the parked stack tips.
- The quarantine of `ntp-boot-staging-timing` (8tgnt/ksnsa) is untouched; this design is what lets
  it rejoin honestly.
- The allowlisted re-tuning inventory (`tests/wall-clock-budget-registry.test.ts`, introduced by
  the 63o3v/38czq stack) stays an inventory; converting those suites is follow-on work (8dqfg),
  not this bead.

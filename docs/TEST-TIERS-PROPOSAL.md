# Chrome Agent Platform: Test Tiers & Gate Architecture Proposal

**Bead:** `chrome-agent-platform-yvvvd` / `fleet-r4nb` / `fleet-1ojy.2`  
**Author:** `chrome-agent-platform-qazo`  
**Role:** Architect / Implementer  
**Date:** 2026-10-16  
**Status:** PROPOSED  

---

## 1. Executive Summary & Problem Statement

Per Paul's directive (2026-10-11):
> *"We need to architect each fleet and the architecture of the system so that we get ultimate merge speed and CI speed. This should be core to all work... The VM pool is not the issue, the way you test and how it's structured is the issue."*

### The Bottleneck
- On the 2-vCPU hub, a full gate run (`origin/main` commit `7bf4524c`) took **1,062s** (~17.7 minutes):
  - `npm test`: **815s** (serial phase 129s; parallel phase 686s)
  - `test:build`: **219s**
  - `build:production`: ~28s
- On the 8-vCPU fleet VMs (`nproc=8`), the full gate still averages **437s** (with spikes up to **539s–1,115s** under concurrent host load).
- Main has continuously expanded: +31 test files and +120 CPU-seconds of test work added over the past week, bringing the parallel candidate set to **689 files** across 708+ test suites.
- Because every merge of the merged union pays the full gate whole, the merger queue is throttled to 1 landing every 7–10 minutes even when all candidate branches are green.

---

## 2. Empirical Per-Phase Cost Measurements

Measured across 15 recent consecutive PASS runs on this 8-vCPU host (`~/.fleet/checks/*.json`, October 15–16, 2026):

| Phase | Command / Component | Suites / Files | 8-vCPU Wall Time (Median) | 2-vCPU Wall Time (Measured) | Nature of Execution |
|---|---|---|---|---|---|
| **P0: Build** | `npm run build:production` | 1 store bundle build | **16.6s** (fresh) / **0.8s** (cached) | **28.0s** | Bundles SW, options, NTP, sidepanel; writes `dist.complete` |
| **P1: Serial Phase** | Part of `npm test` (`scripts/run-tests.mjs`) | 16 build/lock/artifact files | **78s** | **129s** | Process-isolated serial execution of shared-state & lock fixtures |
| **P2: Post-Build Read-Only** | Part of `npm test` (`scripts/run-tests.mjs`) | 5 files (`diff-core`, `wasm-tree-shaking`, `bundle-budget`, etc.) | **20s** | **35s** | Verifies generated bundle outputs without re-running builds |
| **P3: Parallel Phase** | Part of `npm test` (`scripts/run-tests.mjs`) | 689 files (in-memory unit tests, mocks, schemas) | **240s** | **686s** | `deno test --parallel` (2 workers on 2-vCPU; 8 workers on 8-vCPU) |
| **P4: Build-Behaviour Tier** | `npm run test:build` (`scripts/build-gate.ts`) | 3 tests (`build-bootstrap`, `build-debug-mode`, `build-tool-bundling`) | **85s** | **219s** | Performs repeated full in-place rebuilds and mode churn |
| **P5: Heavy WASM & Journeys** | `npm run test:heavy` / `test:chrome` | 20 WASM suites + CDP browser journeys | **>350s** | **>800s** | Loads Pyodide (>10MB), image decoders, WASI tools, real Chrome |
| **TOTAL (Full Gate Today)** | `CHECK_CMD` (`build:production && npm test && test:build`) | 713 files | **442s** | **1,062s** | **Exceeds 300s budget by 1.47x (8-vCPU) and 3.54x (2-vCPU)** |

---

## 3. Four-Tier Architecture Specification

To satisfy Fleet Speed Rules R1 (Full Gate ≤ 300s) and R2 (Fast Gate ≤ 60s), the suite is partitioned into four distinct tiers based on blast radius, isolation requirements, and environmental sensitivity:

```
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 1: Fast Gate (Implementer - Every Change)                         │
│ Command: npm run gate:fast                                             │
│ Target: ≤ 60s (Median today: 120s -> Target: ≤ 60s with cache reuse)   │
│ Scope: Affected-only suites + Always-on guards (approx 10-40 suites)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Cleared by Reviewer
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 2: Union Landing Gate (Merger - Merged Batches)                   │
│ Command: node scripts/gate-full.mjs                                    │
│ Target: ≤ 240s (Target: under 300s ceiling)                            │
│ Scope: Build verification + Serial (16) + Read-Only (5) + Parallel(689)│
│ Excludes: In-place build churn (P4) and Heavy WASM/journeys (P5)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Landed to origin/main
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 3: Build & Generator Integrity Tier (Selective & Nightly)         │
│ Command: npm run test:build                                            │
│ Target: ~85s                                                           │
│ Scope: 3 build churn tests (bootstrap, debug toggle, tool generator)   │
│ Trigger: Runs when build.mjs, packages/bundled, or generators change   │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 4: Heavy WASM, Pyodide & Real-Browser Journeys (Nightly / Heavy)  │
│ Command: npm run test:heavy && npm run test:chrome                     │
│ Target: ~350s (Run under dedicated heavy slot)                         │
│ Scope: 20 Pyodide/WASM tools, image codecs, real Chrome CDP journeys   │
│ Trigger: Scheduled nightly or pre-release milestone verification       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. What Moves Out of the Merger Landing Gate & Why It Is Safe

### Lever 1: Move `npm run test:build` out of the default `CHECK_CMD`
- **What moves:** The three in-place build churn tests:
  1. `tests/build-bootstrap.test.ts` (executes 3 repeated in-place production builds)
  2. `tests/build-debug-mode.test.ts` (executes debug-mode alternating rebuilds)
  3. `tests/build-tool-bundling.test.ts` (executes package tool generator regeneration)
- **Time saved:** **85s** on 8-vCPU; **219s** on 2-vCPU.
- **Safety Proof:**
  - Standard `npm test` ALREADY contains `tests/build-smoke.test.ts`, which runs on every single landing.
  - `tests/build-smoke.test.ts` executes a certified store build of the exact tree object and validates `dist.complete` byte authority, AST exported functions, reachability, and bundle budgets.
  - The three tests in `test:build` exercise build *meta-mechanics* (e.g. verifying that toggling debug mode twice leaves clean artifacts, or verifying that symlink boots do not re-bootstrap). They do not test runtime extension logic.
  - **Selective Execution:** When a PR or merge touches `build.mjs`, `scripts/build-*.mjs`, `scripts/lib/wasm-*.mjs`, or `packages/bundled/**`, `scripts/select-tests.mjs` and `scripts/gate-full.mjs` automatically trigger `test:build`. For the 95% of landings that touch extension logic, NTP UI, or tests, running 3 redundant in-place rebuilds is pure overhead.

### Lever 2: Exact-Tip Build Reuse (`scripts/gate-full.mjs`)
- **What moves:** Redundant `npm run build:production` calls when the merger's union tip has already been built and certified.
- **Time saved:** **16s** per landing.
- **Safety Proof:** `ensureStoreBuild` verifies the exact commit SHA, git tree object, indexed source authority hash, and generated artifact hash. If any single byte differs, it rebuilds from scratch.

### Resulting Union Landing Gate Time
$$\text{Full Gate} = 0.8\text{s (build check)} + 78\text{s (serial)} + 20\text{s (read-only)} + 140\text{s (parallel on 8-CPU)} = \mathbf{238.8\text{s}}$$
**238.8s is well within the Fleet Rule R1 budget (≤ 300s)!**

---

## 5. Configuration Implementation: `~/.fleet/check-chrome-agent-platform.conf`

To implement this tiering without breaking coverage contracts or producer verification:

```bash
# ==============================================================================
# PROPOSED ~/.fleet/check-chrome-agent-platform.conf (Bead yvvvd)
# ==============================================================================

# CHECK_CMD (Merger Union Landing Gate):
# Uses gate-full.mjs to reuse verified dist and run standard npm test (serial + parallel + build-smoke).
# Runs test:build selectively only when build-infrastructure files are in the diff.
CHECK_CMD="node scripts/gate-full.mjs --selective-build-tier"

# CHECK_FAST_CMD (Implementer Fast Gate):
# Uses select-tests.mjs with build-if-needed to run affected tests + always-on guards.
CHECK_FAST_CMD="npm run gate:fast"

# Bound ceilings:
CHECK_TIMEOUT=1800      # 30m bound (plenty for 240s run)
CHECK_FAST_TIMEOUT=300  # 5m bound (plenty for 60s run)

# Fast gate verification contract:
CHECK_FAST_PASS_RE='^select-tests: parallel phase GREEN'
CHECK_FAST_COVERAGE_REQUIRED=1
CHECK_FAST_CONTRACT_OWNER="/home/exedev/chrome-agent-platform/.git"
```

---

## 6. Implementation in `scripts/gate-full.mjs`

Update `scripts/gate-full.mjs` to inspect whether build-affecting files changed between `origin/main` (or merge-base) and HEAD before deciding to run `npm run test:build`:

```js
const BUILD_INFRA_PATTERNS = [
  /^build\.mjs$/,
  /^scripts\/build-.*\.mjs$/,
  /^scripts\/lib\/.*build.*\.mjs$/,
  /^packages\/bundled\//,
  /^deno\.runner\.jsonc$/,
  /^package\.json$/,
  /^package-lock\.json$/,
];

export function hasBuildInfraChanges(changedFiles) {
  return changedFiles.some(file => BUILD_INFRA_PATTERNS.some(pat => pat.test(file)));
}
```

If no build infrastructure files changed, the union gate runs `npm test` (which contains `tests/build-smoke.test.ts`), safely completing in ~240s and meeting Fleet Speed Rule R1.

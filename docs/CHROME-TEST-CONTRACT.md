# Full-Suite Chrome and Test Gate Contract

**Status:** Authoritative Contract (chrome-agent-platform-dqc1 / CAP-FB-20260908-FULL-SUITE-CHROME-CONTRACT-01)  
**Applies to:** `npm test`, `npm run test:changed`, `npm run test:file`, `scripts/run-tests.mjs`, `scripts/select-tests.mjs`, `scripts/test-partition.mjs`, `scripts/chrome-journeys.ts`, and all KAT harnesses.

---

## 1. Executive Summary

This document specifies the exact execution environment, real-browser requirements, and lock contracts for the Chrome Agent Platform test gates.

A reader or scheduler must not infer the absence of Chrome from names like "pure", "unit", or "unitScope":
1. **`npm test` includes a real-browser test when Chrome is available.** In `tests/chrome-profile-location.test.ts` (the `9t1b: a REAL browser holds its profile while the whole tree is copied` test near line 97), `browserRefusal(...)` guards the launch. If no usable browser resolves, the last test in that file emits a named, counted environmental refusal (exit **75** via `scripts/lib/browser-refusal.ts`), never a pass or a product failure.
2. **Launch scopes distinguish lock contention, not browser execution.** A `lockPath` (caller-owned file) ensures a test does not block or queue behind machine-wide acceptance runs; it is **NOT** a flag for "no browser". If `binary: fake` is omitted, `launchChrome()` launches real Chromium.
3. **Subset gates (`npm run test:changed`) cannot see cross-cutting guards.** A guard test that is neither modified nor in the static reverse-dependency path of changed files does not run. `npm test` is the mandatory pre-push gate precisely because cross-cutting guards (partition guard, substring honesty, machine-path honesty, etc.) only run when the full suite executes.

---

## 2. Real-Browser Requirements by Gate and Phase

### 2.1 The Full Test Gate (`npm test` / `scripts/run-tests.mjs`)
The full gate runs in two sequential phases:

- **Phase 1: Serial Phase (19 hazard files)**
  - Runs build-artifact hazard tests serially with per-file process isolation and bounded timeouts (`scripts/lib/serial-phase.mjs`): 180s per file at idle, scaled by load per CPU up to 720s. An explicit `CAP_SERIAL_TEST_TIMEOUT_MS` overrides this without scaling; scaled defaults print their effective bound.
  - **Browser requirement:** NONE of the serial files launch a real browser. Lock-machinery tests (`tests/chrome-launch-lock.test.ts`, `tests/chrome-launch-lock-scope.test.ts`, `tests/chrome-slot-semaphore.test.ts`, `tests/chrome-slot-semaphore-honesty.test.ts`) test concurrency and locking logic using `binary: fake` (a mock process printing DevTools banners).
- **Phase 2: Parallel Phase (422+ files)**
  - Runs all non-hazard test files concurrently via `deno test --parallel`. The full and changed-test runners print the candidate file names to stdout and stderr before this phase; on timeout they print the immediate timeout notice and a named candidate block to both streams. Parallel scheduling cannot identify which candidate hung, so the block labels the culprit unconfirmed rather than blaming every file.
  - **Browser requirement:** The profile-copy test requires a usable real browser to execute, but absence is an **environmental refusal**, not an executed product failure.
    - `tests/chrome-profile-location.test.ts` (test title near line 97) first checks `browserRefusal(resolveChromiumBinaryReport(), BROWSER_DEPENDENT_TESTS)` near line 119. Only if it returns `null` does the test reach the real `launchChrome({ extension: `${ROOT}/extension`, profile, timeoutMs: 25000, lockPath: lockScope })` call near line 130.
    - This test exercises the live race where Chrome holds and continuously churns its profile (`Default/`, `SingletonLock`, WAL) outside the repository while a whole-tree copy runs concurrently.
    - If no executable browser resolves, the browser-dependent tests decline; after the remaining static tests, the last test calls `refuseWithoutBrowser(...)` (near line 481), prints the named/count diagnostics, and exits **75** via `scripts/lib/browser-refusal.ts`. Exit 75 is neither a pass (0) nor a product red (1). If a browser resolves but its actual launch fails for another reason, diagnose that failure rather than calling it this missing-browser refusal.
    - Other parallel test files in `tests/` are in-memory unit tests, mock Web/DOM tests, or static source scanners that require no browser.

### 2.1b The Dedicated Build Gate (`npm run test:build` / `scripts/build-gate.ts`)
Option D (chrome-agent-platform-h65e) partitions heavy in-place build-behaviour tests out of `npm test` into a dedicated explicitly-budgeted gate:
- **Command:** `npm run test:build` (invokes `scripts/build-gate.ts`, enforced ceiling: 2120s; ~8 min typical; explicit `CAP_SERIAL_TEST_TIMEOUT_MS` overrides without scaling).
- **Enumerated Coverage:**
  - `tests/build-bootstrap.test.ts` (per-file bound: 850s): steady-state symlink bootstrap, GC of dangling v-boot symlinks under dist-versions, live version counts, archive packaging idempotence.
  - `tests/build-debug-mode.test.ts` (per-file bound: 550s): developer vs store target marker validation, sourcemap inclusion/exclusion, and mode alternation integrity.
  - `tests/build-tool-bundling.test.ts` (base serial window, measured ~10s; ceiling 720s under 4x load): bundled-tool generator verify-mode drift check, `--regen-tools` idempotence, and provenance validation.
- **Coverage Remaining in `npm test`:**
  - `tests/build-smoke.test.ts`: fast assertion proving `node build.mjs` exits 0 and emits a valid `dist.complete` marker.
  - `tests/store-doc-denial.test.ts`: validates store build output and Zod Doc.compile denial (reuses warm build record in ~6s).
  - `tests/package-extension-freshness.test.ts`, `tests/bundle-budget.test.ts`, `tests/diff-core.test.ts`, `tests/wasm-tree-shaking.test.ts`: dist bundle and marker integrity checks.

### 2.2 Acceptance and Journey Harnesses (`scripts/`)
All harnesses under `scripts/` require a real browser:
- **`scripts/chrome-journeys.ts`**: The 370-check sequential CDP journey suite. Loads the unpacked extension, requires real Chromium or Chrome for Testing, and takes the **exclusive canonical lock**.
- **`scripts/kat-*.ts`** (14 KAT harnesses, e.g. `kat-agent-board.ts`, `kat-task-lifecycle.ts`, `kat-ux-lows.ts`, etc.): Exercise real browser interactions via CDP against the loaded extension. These take one slot of the **bounded-concurrency semaphore**.
- **`scripts/axe-audit.ts`**, **`scripts/live-run-evidence.ts`**: Real browser acceptance runs using the bounded-concurrency semaphore.

### 2.3 Subset Gates (`npm run test:changed` / `npm run test:file`)
- **`npm run test:file -- tests/<file>`**: Runs only the designated file. If `<file>` is NOT `tests/chrome-profile-location.test.ts`, no real browser is launched.
- **`npm run test:changed`**: Resolves static reverse dependencies of changed files (against the **merge-base** with `origin/main`, not the moving tip). If `tests/chrome-profile-location.test.ts` or its dependencies (`scripts/lib/chrome-profile-dir.ts`, `scripts/lib/chrome-launch.ts`) are changed, it selects that test: with a usable browser it launches real Chrome; without one, the selected file reports a named, counted environmental refusal (exit 75). If a change cannot be proven covered, `test:changed` fails closed to the full suite, subject to the same browser guard.
  - **chrome-agent-platform-nco2:** two file classes that have no import edges *by construction* are now mapped to the tests that cover them instead of forcing the full suite — an unimported `scripts/*.ts` harness maps to the tree-walking guards, and a **version-only** bookkeeping-JSON diff maps to the tests that read those files as data. A bookkeeping JSON with any non-version change (dependency, script, permission, CSP) still fails closed, decided by a **structural** comparison of both parsed documents — not a flattened key map, which loses empty containers and collides dotted/bracket key paths, and not a line filter on `"version"`. **Every fail-closed run now names the file and the mechanism**, so a full-suite fallback says why it ran.
  - **The guard mapping is bounded by what the guards actually enumerate.** `harnessFiles()` scans `scripts/*.ts` only, so a `.mjs` helper or a subdirectory file is NOT covered by those guards and fails closed to the full suite.

---

## 3. The Three Launch Scopes (`acquireLaunchScope`)

All browser launches go through `launchChrome()` in `scripts/lib/chrome-launch.ts`. The launcher enforces exactly one launch scope via `acquireLaunchScope()`. It invokes `/usr/bin/setsid` (a Linux-specific hardcoded path) and records the dedicated process group from `/proc/<pid>/stat`; `teardownChrome(launched)` kills and verifies that entire group as well as matching the unique profile. Encoding `--user-data-dir` in a descendant's `argv[0]` does **not** defeat `pkill -f`: it matches the joined cmdline (17/17 baseline descendants and 11/11 live group members matched). Group killing is defense in depth for a descendant that leaves the profile match or is born after it. The cause of the original confirmation miss remains open; the full gate plus the user-data-dir monitor is the deciding evidence. `chromeProfileDir()` supplies a fresh pid/time/random-suffixed profile per launch.

```
                          ┌─────────────────────────────┐
                          │   acquireLaunchScope(opts)  │
                          └──────────────┬──────────────┘
                                         │
                 ┌───────────────────────┼──────────────────────┐
                 ▼                       ▼                      ▼
        opts.lockPath           opts.canonicalLock           default
     (Caller-owned file)      (Machine-wide lock)      (4-slot semaphore)
             │                           │                      │
             ▼                           ▼                      ▼
    Flock caller tempfile       Flock /tmp/cap-*.lock     Flock /tmp/slot-*.lock
    Isolation: per-test        Isolation: machine-wide    Isolation: bounded (4)
    Used by: unit tests        Used by: journeys/sec      Used by: KAT harnesses
```

1. **Unit-Scope Lock (`opts.lockPath`)**:
   - Takes an exclusive lock on a caller-owned file (`Deno.makeTempFile`).
   - Purpose: Prevents unit test fixtures from queueing behind machine-wide acceptance runs and avoids depleting the machine's 4-slot concurrency semaphore.
   - **Critical Contract:** `lockPath` isolates lock files; it does **NOT** disable browser launching. If `opts.binary` is omitted, real Chromium is launched.
2. **Canonical Machine Lock (`opts.canonicalLock: true`)**:
   - Takes the exclusive lock at `/tmp/cap-serialized-chrome-acceptance.lock`.
   - Purpose: Machine-wide determinism across all concurrent CAP lanes on the machine. Reserved for suites whose evidence depends on strict single-instance execution (`scripts/chrome-journeys.ts` and security custody chain with `CAP_SECURITY_NONCE`).
3. **Bounded-Concurrency Semaphore (Default)**:
   - Takes one slot (0 to `CAP_CHROME_MAX_CONCURRENT - 1`, default 4) via `/tmp/cap-chrome-slot-N.lock`.
   - Purpose: Standard acceptance suites and KAT harnesses. Limits concurrent headless browsers across the system to prevent memory exhaustion and thrashing.

---

## 4. Fake-Runner Probes vs Real Chrome

To prevent confusion when reading test files, here is how fake-runner probes differ from real Chrome tests:

| File | What it executes | Real Chrome? | Lock Scope |
|---|---|---|---|
| `tests/chrome-profile-location.test.ts` | Real Chromium when resolvable; otherwise a named exit-75 refusal | **YES, when available** | `lockPath: lockScope` |
| `tests/chrome-launch-lock.test.ts` | Fake runner (`binary: fake`) | **NO** | `canonicalLock: true` (on fixture file) |
| `tests/chrome-launch-lock-scope.test.ts` | Fake runner (`binary: fake`) | **NO** | `lockPath: SCOPE_A/B` |
| `tests/chrome-slot-semaphore.test.ts` | Fake runner (`binary: fake`) | **NO** | slot semaphore (on fixture slot dir) |
| `tests/chrome-slot-semaphore-honesty.test.ts` | Fake runner (`binary: fake`) | **NO** | slot semaphore (on fixture slot dir) |
| `tests/quiet-window.test.ts` | Fake runner (`binary: fake`) | **NO** | `lockPath: scope` |
| `tests/harness-debug-port.test.ts` | Stand-in (`/bin/true` or `binary: fake`) | **NO** | `lockPath: FAKE_LOCK` |
| `tests/cdp-client.test.ts` | Mock process (`/bin/sh` or `Deno.execPath()`) | **NO** | None |
| `tests/chrome-for-testing.test.ts` | Directory cache fixtures | **NO** | None |
| `tests/chrome-lock-fixture-scope.test.ts` | Static source AST scan | **NO** | None |
| `tests/machine-path-honesty.test.ts` | Static source scanner | **NO** | None |

---

## 5. The Motivating Lesson: Subset Gates vs Cross-Cutting Guards

### 5.1 The Fundamental Limitation of Subset Gates
`npm run test:changed` builds an in-memory static reverse dependency graph (`importer -> imported`). It evaluates:
1. Which files were modified vs `origin/main`?
2. Which tests import those modified files directly or transitively?
3. Always include `CORE` (security + vocabulary).

**A cross-cutting guard does not import every file it inspects.** Guard tests (such as `tests/test-partition-guard.test.ts`, `tests/substring-pin-honesty.test.ts`, `tests/machine-path-honesty.test.ts`, `tests/harness-registry.test.ts`, `tests/durable-root.test.ts`, `tests/chrome-lock-fixture-scope.test.ts`) read file trees dynamically at runtime. Unless the guard file itself or one of its statically imported modules is modified, `npm run test:changed` will **never** select the guard.

### 5.2 Tonight's Case Study: How `main` Went Red
1. Commit `27ec8926` (`atve`) widened the durable-root guard and updated `tests/durable-root.test.ts`, adding a reference to `scripts/build-bundled-tool-packages.mjs`.
2. The partition classifier in `scripts/test-partition.mjs` scans all test files for `build.mjs` or `build-bundled-tool-packages`. Finding that reference, it classified `tests/durable-root.test.ts` as a build-artifact hazard.
3. Because `tests/durable-root.test.ts` had neither a `SERIAL_REASONS` entry nor an `EXEMPTIONS` entry, `tests/test-partition-guard.test.ts` failed (4 passed, 1 failed).
4. However, `atve` and subsequent authors iterated and validated using `npm run test:changed`. Because neither `test-partition.mjs` nor `test-partition-guard.test.ts` was in the diff or in `CORE`, `test-partition-guard.test.ts` was never executed.
5. As a result, four successive commits (`ffc4b263`, `ccdf3e23`, `c8a68d11`, `f75e6afb`) landed on `origin/main`, and `main` remained quietly broken for hours until a full `npm test` was run during `6yrq` verification.

### 5.3 Non-Negotiable Gate Rule
- `npm run test:changed` is exclusively for inner-loop rapid iteration.
- **`npm test` is the non-negotiable pre-push gate.** Never push or report done based solely on a passing subset run.

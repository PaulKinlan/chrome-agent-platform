# Full-Suite Chrome and Test Gate Contract

**Status:** Authoritative Contract (chrome-agent-platform-dqc1 / CAP-FB-20260908-FULL-SUITE-CHROME-CONTRACT-01)  
**Applies to:** `npm test`, `npm run test:changed`, `npm run test:file`, `scripts/run-tests.mjs`, `scripts/select-tests.mjs`, `scripts/test-partition.mjs`, `scripts/chrome-journeys.ts`, and all KAT harnesses.

---

## 1. Executive Summary

This document specifies the exact execution environment, real-browser requirements, and lock contracts for the Chrome Agent Platform test gates.

A reader or scheduler must not infer the absence of Chrome from names like "pure", "unit", or "unitScope":
1. **`npm test` unconditionally launches a real Chromium browser.** Specifically, `tests/chrome-profile-location.test.ts:115` (`9t1b: a REAL browser holds its profile while the whole tree is copied`) requires a working `/usr/bin/chromium` (or Chrome binary) on the host machine.
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
  - **Browser requirement:** **REAL CHROMIUM REQUIRED.**
    - `tests/chrome-profile-location.test.ts:115` unconditionally invokes:
      ```ts
      launchChrome({
        extension: `${ROOT}/extension`,
        profile,
        timeoutMs: 25000,
        lockPath: lockScope,
      });
      ```
    - This test exercises the live race condition where Chrome holds and continuously churns its profile (`Default/`, `SingletonLock`, WAL) outside the repository while a copy of the working tree executes concurrently. The copy is `rsync -a` of the repository **minus four bulk directories** (`/node_modules/`, `/.git/`, `/packages/bundled/evidence/`, `dist-versions/`), not literally every byte (jjsz: copying them dominated the suite). That does not weaken the property: the race needs a profile inside the copied tree, the launcher never puts one in any of those four directories (the profile root is outside the repository, asserted by an earlier test in the file), and the profile-signature scan reads the REAL tree, excluded directories included. `rsync` is therefore a host prerequisite (§6). The test name still says "whole tree" because it is a stable identifier cited elsewhere.
    - If `/usr/bin/chromium` is missing or cannot be spawned (e.g. headless container missing shared libraries or sandbox permissions), `npm test` fails.
    - All other parallel test files in `tests/` are in-memory unit tests, mock Web/DOM tests, or static source scanners that require no browser.

### 2.1b The Dedicated Build Gate (`npm run test:build` / `scripts/build-gate.ts`)
Option D (chrome-agent-platform-h65e) partitions heavy in-place build-behaviour tests out of `npm test` into a dedicated explicitly-budgeted gate:
- **Command:** `npm run test:build` (invokes `scripts/build-gate.ts`, enforced ceiling: 2120s; measured 31-36 s on an Apple-silicon workstation after jjsz, 2026-10-07 — a single-host figure, not a bound: a loaded or 2-vCPU Linux host takes longer, up to the ceiling; explicit `CAP_SERIAL_TEST_TIMEOUT_MS` overrides without scaling).
- **Enumerated Coverage:**
  - `tests/build-bootstrap.test.ts` (per-file bound: 850s): steady-state symlink bootstrap, GC of dangling v-boot symlinks under dist-versions, live version counts, archive packaging idempotence.
  - `tests/build-debug-mode.test.ts` (per-file bound: 550s): developer vs store target marker validation, sourcemap inclusion/exclusion, and mode alternation integrity.
  - `tests/build-tool-bundling.test.ts` (base serial window, measured ~10s; ceiling 720s under 4x load): bundled-tool generator verify-mode drift check, `--regen-tools` idempotence, and provenance validation.
- **Coverage Remaining in `npm test`:**
  - `tests/build-smoke.test.ts`: a store build of THIS tree exited 0 and the live `dist.complete` marker validates. It either runs `node build.mjs --target=store` now or reuses the record `build.mjs` writes after its last fatal step (§6.2); it does not always execute the build itself.
  - `tests/store-doc-denial.test.ts`: validates store build output and Zod Doc.compile denial (reuses warm build record in ~6s).
  - `tests/package-extension-freshness.test.ts`, `tests/bundle-budget.test.ts`, `tests/diff-core.test.ts`, `tests/wasm-tree-shaking.test.ts`: dist bundle and marker integrity checks.

### 2.2 Acceptance and Journey Harnesses (`scripts/`)
All harnesses under `scripts/` require a real browser:
- **`scripts/chrome-journeys.ts`**: The 370-check sequential CDP journey suite. Loads the unpacked extension, requires real Chromium or Chrome for Testing, and takes the **exclusive canonical lock**.
- **`scripts/kat-*.ts`** (14 KAT harnesses, e.g. `kat-agent-board.ts`, `kat-task-lifecycle.ts`, `kat-ux-lows.ts`, etc.): Exercise real browser interactions via CDP against the loaded extension. These take one slot of the **bounded-concurrency semaphore**.
- **`scripts/axe-audit.ts`**, **`scripts/live-run-evidence.ts`**: Real browser acceptance runs using the bounded-concurrency semaphore.

### 2.3 Subset Gates (`npm run test:changed` / `npm run test:file`)
- **`npm run test:file -- tests/<file>`**: Runs only the designated file. If `<file>` is NOT `tests/chrome-profile-location.test.ts`, no real browser is launched.
- **`npm run test:changed`**: Resolves static reverse dependencies of changed files. If `tests/chrome-profile-location.test.ts` or its dependencies (`scripts/lib/chrome-profile-dir.ts`, `scripts/lib/chrome-launch.ts`) are changed, it executes and launches real Chrome. If a change cannot be proven covered (e.g. unimported code/config change), `test:changed` fails closed to the full suite and thus launches real Chrome.

---

## 3. The Three Launch Scopes (`acquireLaunchScope`)

All browser launches go through `launchChrome()` in `scripts/lib/chrome-launch.ts`. The launcher enforces exactly one launch scope via `acquireLaunchScope()`. It starts the browser as its own session and process-group leader through `setsidSpawnSpec()` (`scripts/lib/process-tree.ts`): `/usr/bin/setsid` where it exists (Linux), otherwise `/usr/bin/perl -MPOSIX` calling `POSIX::setsid()` before `exec` (macOS ships no `setsid` binary). It records the dedicated process group from `/proc/<pid>/stat`, or from `/bin/ps -o pgid=` where there is no `/proc` (macOS); `teardownChrome(launched)` kills and verifies that entire group as well as matching the unique profile. `attachProcessLifeline()` adds a crash-safe watchdog (jjsz): it runs in its own session and blocks reading a pipe whose write end only the launching process holds, so if that process dies for any reason — including `SIGKILL` or a test runner killing its process group — the kernel closes the pipe and the watchdog kills the browser's group and every process whose argv carries the profile (a literal, end-anchored match: `lifelineMatchPattern` escapes every regex metacharacter, so a profile ending `/p1` never reaches `/p10`). A killed or timed-out test therefore cannot orphan Chrome. The lifeline is a small state machine (`armed` → `fired` | `disarmed`, once; `lifelineState()` reports it). When the browser's leader exits while the launcher is alive and no teardown is running (the shape of most acceptance scripts: `proc.kill("SIGKILL"); await proc.status`), that exit triggers a one-shot sweep through the watchdog's own kill logic, so a wedged helper is reaped without waiting for the launcher to die (measured on real Chrome for Testing with the helpers `SIGSTOP`ped: 7 survivors before, 0 after, about 60 ms). A normal `teardownChrome` disarms the watchdog only AFTER it has verified the group empty; a teardown that throws leaves it armed, and a teardown that starts while a sweep is running waits for the sweep, because the sweep's `pkill -f` also matches the teardown's own `pkill`/`pgrep` command lines (a normal teardown costs about 40 ms more than before, from the bounded `ps` wrapper). A watchdog that cannot be started (no perl, `EAGAIN`) says so once on stderr and the launch continues unprotected; whether to refuse the launch is a policy call for the caller. `attachProcessLifeline` refuses an unsafe `group` (anything but the leader's own pid, greater than 1) before it spawns anything. Where there is no `/proc` (macOS) the `/bin/ps` fallbacks fail closed: only `ps -p <absent pid>` exiting 1 with empty stdout and stderr proves a process gone, and every other outcome throws, so an unreadable process table is never read as an empty group. Encoding `--user-data-dir` in a descendant's `argv[0]` does **not** defeat `pkill -f`: it matches the joined cmdline (17/17 baseline descendants and 11/11 live group members matched). Group killing is defense in depth for a descendant that leaves the profile match or is born after it. The cause of the original confirmation miss remains open; the full gate plus the user-data-dir monitor is the deciding evidence. `chromeProfileDir()` supplies a fresh pid/time/random-suffixed profile per launch.

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
| `tests/chrome-profile-location.test.ts` | Real Chromium (`/usr/bin/chromium`) | **YES** | `lockPath: lockScope` |
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

---

## 6. Build Speed, Concurrency Rules and Host Prerequisites (chrome-agent-platform-jjsz)

### 6.1 The parallel build and the rules that keep it safe

`build.mjs` runs the 12 esbuild bundles, the Zod-Doc scrub, the minify pass, the final whole-AST evaluator gate, Pyodide staging and the chmod passes concurrently, and `dist.complete` hashes the git-indexed source in size-bounded batches (`planSourceReadBatches`: 32 MiB / 64 rows per batch; the digest is still computed in index order, so it is byte-identical to the old sequential walk). Measured on one Apple-silicon workstation (a single-host figure, not a bound): `npm run build:production` 8.5 s to about 4.5 s.

Each rule below is pinned by a test that goes red when the rule is broken:

- **`settleAll`, never `Promise.all`, for any fan-out that writes under the staging directory** (`scripts/lib/build-concurrency.mjs`). `Promise.all` rejects on the first failure while its siblings keep writing, and the failure path then removes staging underneath them: the cleanup fails with ENOTEMPTY and that FATAL replaces the real cause, or a sibling recreates a file in a directory the rollback believes is gone. `settleAll` waits for every task to settle, rethrows the first rejection in declaration order (so the reported cause does not depend on a race) and reports later rejections to stderr. Read-only fan-outs may keep `Promise.all`. Pinned by `tests/build-concurrency.test.ts` (the helper) and `tests/build-parallel-discipline.test.ts` (an AST scan of `build.mjs` and `scripts/package-archive.mjs`).
- **Pyodide is staged in two phases.** Every digest is verified first and only then are the files copied, so a bad file leaves nothing half-staged. The verify-to-copy window is whole-set rather than per-file now; the later `dist.complete` and `scan-shipped` gates still cover the final bytes, and exploiting the window needs write access to the repository.
- **The source authority is two-stage.** Every indexed row is `lstat`-validated before any read, then read in byte-budgeted batches. `tests/dist-complete-source-authority.test.ts` pins the digest against an independent reference over every batching path, the per-file and aggregate bounds, the planner's memory bound, and that a precomputed `source` handed to the marker writer is a shortcut and never a trust input (`validateDistCompleteMarker` recomputes from disk).
- **Version-GC grace.** After the atomic `dist` pointer swap, `build.mjs` waits before deleting the old versions so a reader that resolved the previous link mid-open can finish. That wait was a fixed 2000 ms on every build (about half of a warm build). It is now **50 ms**, tunable with `CAP_BUILD_GC_GRACE_MS=<ms>`. Only a plain run of decimal digits is a number: `2000` restores the old behaviour, `0` removes the wait, anything above 60000 is capped, and every other spelling falls back to 50 (never to "no grace"): empty, negative or signed (`-0`, `+5`), fractional, exponent (`1e3`), hex/octal/binary (`0x10`), words, units, and more than 308 digits. The tradeoff is chosen, not free: a reader that opened a path through the OLD link and is still reading it more than 50 ms after the swap can see a missing file, where the 2 s window made that less likely but never impossible. No test or script in this repository depends on the 2 s window (searched). The 50 ms default has no measured basis (`chrome-agent-platform-b0ld8`). The policy is `resolveGcGraceMs`, pinned by `tests/build-concurrency.test.ts`.
- **`scan-shipped` reads in batches.** `scripts/scan-shipped.mjs` merges its two AST walks (the sink aliases and the script-element bindings) into one pass, reads files in batches of 32 and scans the bundled Wasm concurrently. Two reviewers argued the merged walk is behaviour-preserving by reading it, including the assignment-operator handling and walk order; the evidence is `tests/scan-shipped.test.ts` and the schema-aware Wasm test in `tests/wasm-package-authority.test.ts`, not a before/after oracle.
- **The Zod `Doc` scrub has a fast path.** `scripts/lib/scrub-zod-doc.mjs` returns a bundle unchanged, and unparsed, when it contains no `Doc` / `Doc<digits>` token. The one known limit is an escaped spelling of the class name (`class \u0044oc`), which carries no such token, so the fast path does not scrub it. esbuild never emits that spelling, and the final whole-AST `assertNoDynamicEvaluators` gate that `build.mjs` runs over every published bundle is the backstop. `tests/scrub-zod-doc.test.ts` pins the fast path (byte-identical output for token-free input, a real `Doc.compile` shape still scrubbed) and asserts the current escaped-name behaviour so that a change to it is a conscious one.

### 6.2 The build-once record

On a successful **store** build, `build.mjs` writes `<durable root>/serial-build-once/<commit>-<source-digest>.json` (`{ code: 0, stdout, at }`) so a later serial test file can reuse that build's output instead of paying for another build. The record says "this build exited 0", so:

- It is written **after the last fatal step** (staging cleanup, gallery sync, lock release) by ONE function, `writeBuildOnceRecord` in `scripts/lib/build-once-record.mjs`, which applies the strict gate `shouldRecordBuild({ buildSucceeded, exitCode })` **itself**, so the call site cannot weaken it. A build that dies in a finalizer, or exits non-zero for any reason, records nothing. A refused call touches nothing on disk (not even the directory), the key must be one safe path segment (no `../`, no `/`), and a write failure is non-fatal cache population (`{ written: false, reason: "write-failed" }`, never a throw). The behaviour is pinned by EXECUTION in `tests/build-once-record.test.ts` (a table over record × `buildSucceeded` × `exitCode` against real files, judged by an oracle that does not import the gate), and the call site by `tests/build-parallel-discipline.test.ts` rule B (exactly one awaited top-level call after the last top-level `try`, its exact arguments, nothing fatal after it, and no second writer or record-directory literal anywhere in `build.mjs`). What those pins do not catch, stated in their headers: a fatal raised from an exit handler or an unhandled rejection after the call, and a writer that assembles the directory name at runtime.

### 6.3 Host prerequisites for the gates

| Tool | Needed by | Linux | macOS |
|---|---|---|---|
| `rsync` | the tree copy in `tests/chrome-profile-location.test.ts` | `apt install rsync` | preinstalled |
| `flock` | every launch scope, the heavy-gate slot, the security custody lock | util-linux (preinstalled) | `brew install flock` (installs `/opt/homebrew/bin/flock`) |
| `/usr/bin/perl` with `POSIX` | `setsidSpawnSpec` starts a launched browser in its own session where there is no `/usr/bin/setsid`; `boundedCommandSpec` arms the kernel `alarm` that bounds every `ps` probe | not used | ships with macOS |
| `/usr/bin/setsid` | `setsidSpawnSpec` (a launched browser and its lifeline watcher each lead their own session) | util-linux (preinstalled) | not present (perl is used instead) |
| `/bin/ps`, `pgrep`, `/usr/bin/pkill` (procps) | the process-table reads and the lifeline watcher's profile sweep (`/usr/bin/pkill` is an absolute path in the watcher script), the real-process tests | `apt install procps` (preinstalled on most images, absent from some minimal containers) | preinstalled |
| a host WITHOUT a child subreaper | `tests/jjsz-lifeline-process-table.test.ts` and its older sibling assert that an orphan's `ppid` becomes `1` (the `of6z` tests) | the default; they fail on a host where an ancestor is a subreaper (some container init systems, `systemd --user`) | the default (launchd) |
| a UTF-8 locale | `tests/tar-stream.test.ts` lists a Unicode-named archive with the system `tar` | inherited unchanged | `en_US.UTF-8` (ships with macOS; the test sets it for that `tar` call only, because bsdtar escapes Unicode names without one) |
| a browser | `tests/chrome-profile-location.test.ts`, the journeys and KATs | `/usr/bin/chromium`, or `CAP_CHROMIUM` | `CAP_CHROMIUM`, or a Chrome for Testing build in the puppeteer cache (`scripts/lib/chrome-for-testing.ts` resolves `chrome-mac-arm64` and `chrome-mac-x64`) |

### 6.4 What is not proven, and the residual risks (each is a bead)

This is what the jjsz landing does **not** establish. None of it is a known failing gate; each item is a place where a gate could be weaker than it reads, or where a deliberate trade was made.

**Verified on one host only.** All of jjsz was built and gated on macOS arm64 (Apple silicon, Deno 2.9.0). There is no CI and no Linux host was available, so the new tests that contain a macOS branch or call a real `ps`/`flock` have never run on Linux. The macOS-branch tests are seam-driven (an injected platform and exec) and the real-tool tests skip themselves from a raw probe of the tool, never from the code under test; both are design intent, not Linux evidence. The merge host must run `npm test` and report the **ignored** count as well as passed/failed (`chrome-agent-platform-mwj7v`).

**macOS custody proofs are weaker than their Linux counterparts, by construction** (`chrome-agent-platform-xjjhi`):
- `ps` cannot report a session id, so a macOS identity carries `sid` = `pgid`; the `sid === pid` half of the "launched leader" check is implied by `pgid === pid` and proves nothing there. A portable signal exists (`ps -o stat=` carries `s` for a session leader) and is not wired.
- The inherited canonical-lock proof is "the file behind fd 9 has the lock file's device and inode, **and** `flock -n` cannot take the lock". That proves someone holds the lock, not that fd 9 itself does (macOS has no `/proc/self/fdinfo`). `flock` is resolved through `PATH`, as `scripts/security-suite-supervisor.sh` resolves the `flock` that takes the lock in the first place.
- **That macOS branch is reached only through seam tests today.** `npm run test:security` cannot start on macOS, on `main` or on this branch: the Deno runner's `node:fs` `fstatSync(9)` on an inherited descriptor throws `EBADF` (Deno's descriptor namespace is not the OS table; Node reads the same descriptor fine), so the runner refuses with "canonical inherited lock fd is missing" before the macOS proof can run. `main`'s `/proc`-only check refuses identically. The real supervisor flow was therefore never measured on macOS, and no Linux host was available either (`chrome-agent-platform-mwj7v`). `chrome-agent-platform-8bp69` records the measured fix direction: open `/dev/fd/9` write-only and `fstat` the handle (`stat("/dev/fd/N")` is not equivalent).

**An unreadable process table can still read as clean in three places** (`chrome-agent-platform-yuu9s`): `scripts/security-suite-supervisor.mjs` swallows `observeDescendants(...)` errors, so a persistently failing `ps` leaves the observed set empty; the residue `unverified` reason does not reach the receipt; and on Linux `liveObservedResidue` still treats EMFILE/EACCES from a `/proc` read as "gone" (pre-existing, left alone on purpose).

**Probes that are not fully bounded** (`chrome-agent-platform-d9fyo`): custody's `ps` has a 5 s timeout but runs under the inherited environment; the `flock` probe has no timeout; the quiet-window sampler's `ps` has its environment pinned but no timeout.

**Deliberate fail-closed choices with an operator-visible cost** (`chrome-agent-platform-qo3u8`):
- A transient `ps` failure at custody's final residue check exits 70 on macOS. There is no retry.
- One-time build-lock transition: a live owner recorded before this change holds a `start` string in the inherited locale's text, and the new reader computes the C-locale text, so it reads as a different process and the lock is stealable once, at the upgrade. After that the recorded value is canonical. A persistently broken `ps` now makes lock acquisition refuse (bounded, about 24 s) rather than steal.

**The crash lifeline: policy, cost and limits** (`attachProcessLifeline`, section 3). These are the places where it is weaker than it reads; every one fails closed or needs a second failure on top of the first.
- *Policy: an unprotected launch is a warning, not a refusal.* If the watcher cannot be started (no `/usr/bin/perl`, `EAGAIN`), `launchChrome` writes one line to stderr and goes on with the pre-jjsz exposure. Refusing the launch instead would hard-fail every acceptance script on a host with a missing `perl` or a transient fork failure, for a protection that only matters when the launcher is killed. Whether to flip this is recorded with the other fail-closed trade-offs (`chrome-agent-platform-qo3u8`).
- *Cost:* a normal `teardownChrome` is about 40 ms slower than before (the bounded `ps` wrapper); a teardown after a leader-only kill is 85 to 120 ms slower, because it waits for the sweep (medians 138 to 144 ms before, 224 to 265 ms after). Both measured with real Chrome for Testing on one host.
- *No leader-identity re-check.* The watcher signals the group by number. A live group is always the right one, but an EMPTY group whose pid was recycled, with the launcher killed inside that window, would be signalled (`chrome-agent-platform-lsk1p`).
- *Isolation window.* The watcher's own `setsid` runs a few milliseconds after the spawn returns. A kill of the launcher's whole process GROUP inside that window takes the watcher with it (7 of 20 trials orphaned the target before isolation was visible; 20 of 20 were reaped after) (`chrome-agent-platform-6tau8`).
- *`launchChrome` failure path.* If `teardownChrome` throws inside the catch around `isolatedProcessGroup`/`attachProcessLifeline`, the launch lock and fleet lease are not released and the original error is masked; an unreadable table at launch also leaves the cleanup without a recorded group (`chrome-agent-platform-5fh6a`).
- *Three edges, deliberately unchanged* (`chrome-agent-platform-4o93n`): a `pkill` pattern rejection cannot be reported once the launcher is dead (the group kill still ran); a `teardownChrome(null, profile)` with no process handle cannot serialise with an in-flight sweep, so the sweep can kill that teardown's own `pkill`/`pgrep` and the teardown then throws (fails closed); and a concurrent `pkill`/`pgrep` of the same profile run by another process can be killed the same way.
- *A launcher that kills only the leader must wait for the sweep* (found by the round-2 security review; it arrived together with the lifeline itself, which the repository did not have before the jjsz work). The watcher lingers about 110 ms after a leader exit (`kill -TERM; sleep 0.1; kill -KILL; pkill`). `scripts/security-suite.ts` used to exit straight after `await chrome.proc.status`; the real supervisor (`scripts/security-suite-supervisor.mjs`) takes a final `observeDescendants` sample after the runner exits and then judges `liveObservedResidue` (`scripts/security-suite-custody.mjs`), so a watcher still alive at that sample reads as `descendant-residue` and exits 70 (near-certain on Linux, a coin flip on macOS). The same lingering sweep can also `pkill` a second browser opened on the same profile. `reapLeaderAndSettle` (`scripts/lib/reap-leader.ts`) kills the leader, awaits its exit and then awaits the lifeline's `settled` promise; `scripts/security-suite.ts`, `scripts/page-actions-journey.ts` and `scripts/keyless-first-result.ts` call it. **What this rests on:** a deterministic fixture judged by the REAL `observeDescendants` and `liveObservedResidue` (`tests/jjsz-lifeline-runner-exit.test.ts`: a positive control that reproduces the old shape, behavioural tests of the helper, and per-site AST pins each checked against in-file mutants, plus a binding pin that the three scripts import the helper under its own name from the one module: a drill that deleted the import and kept the call survived every call-site pin until it was added). The two cross-process negative windows ("the runner has not reaped yet", "no second browser has opened yet") are counted on the runner's own heartbeat after an in-stream `LEADER_EXITED` marker (`tests/fixtures/jjsz-lifeline-runner.ts`), not on a sleep in the test, so a starved runner cannot pass them for the wrong reason. It is not the real flow: that cannot run on macOS (the lock-proof note above, `chrome-agent-platform-8bp69`) and Linux is unverified (`chrome-agent-platform-mwj7v`). **The pins are per-site, not a rule:** about 30 other scripts still do a bare `proc.kill`; none is judged by the supervisor and none relaunches on the same profile today, and nothing would go red if one started to (`chrome-agent-platform-6efbv`). The sweep itself still has no leader-generation check (`chrome-agent-platform-80yqb`); the helper removes the three known ways to meet it.

**Not changed, found on the way** (each filed): the macOS boot fence in `build-lock` is inert because `machineBootId` is the constant `"unknown-boot"` there (`chrome-agent-platform-8qkmg`); the serial per-file windows in `scripts/test-partition.mjs` (850 s / 550 s) still carry pre-parallel measurements (`chrome-agent-platform-tn7wh`); the build-once key binds the indexed source and the commit, not the `dist.complete` hash (`chrome-agent-platform-lsqay`; the reader revalidates against the live marker, so a stale record cannot make a missing build look current).

**Review findings deferred on purpose** (each filed; none is a known failing gate). They were left because each is low severity, changes security-critical or kill-path semantics that deserve their own review, or is pre-existing on `main`: the watcher signals the bare leader pid as well as its group and can be armed with no verified group (`chrome-agent-platform-ymnpg`); the teardown's `pkill`/`pgrep` take the profile string as a raw extended regex while the lifeline sweep escapes and anchors it (`chrome-agent-platform-i6lgk`, pre-existing); `boundedCommandSpec` does not reject a non-finite bound, which `perl alarm` reads as 0, i.e. unbounded (`chrome-agent-platform-ia98o`); the build lock steals when `kill(pid, 0)` says alive but `ps` says gone, rather than re-checking and treating a persisting contradiction as alive (`chrome-agent-platform-0ym29`); the version-GC grace default of 50 ms has no measured basis (`chrome-agent-platform-b0ld8`); and four test changes were loosened on purpose and should be revisited: the `cdp-client` scratch repo that symlinks the real tree, `safe.bareRepository=all`, the `rsync` excludes, and the darwin-only tar scoping (`chrome-agent-platform-jos6s`). The supervisor-side idea of re-polling residue as defence in depth was declined because it changes custody's judgement semantics.

**Two real-browser tests are load-sensitive, and neither matches a named environmental signature.** In one full run on a heavily loaded shared host (load average above 100, other agents' builds running), `tests/ntp-boot-staging.test.ts` failed its zero-long-tasks-over-50-ms check once (one task of 56 ms) and could not be reproduced (5 of 5 isolated runs passed; 18 of 18 navigations passed under 14 and 28 CPU hogs), and `tests/site-agent-delegation-attachments.test.ts` failed with "CDP Runtime.evaluate timed out" against a fixed 10 s budget, which does reproduce under extreme CPU starvation (2 of 3 runs at 14 hogs, load average 176 or more). Neither failure is attributable to the change under test: the only change since the last fully green run was a 19-line test, the test selector chooses neither failing file for it, and `extension/` was untouched. `MERGER-PLAYBOOK` section 2 names three environmental signatures only, so a load-induced red of this kind has no honest classification rule: it is either landed past silently or blocks. Filed: `chrome-agent-platform-mujlt` (the ntp flake carries no attribution), `chrome-agent-platform-tf48c` (the delegation KAT does not use `classifyEvaluateTimeout` the way `chrome-journeys.ts` does) and `chrome-agent-platform-m9g43` (the playbook rule).

**Info only.** macOS creates a pipe and then sets close-on-exec in two steps; a reviewer raised that a child spawned concurrently with a launch could inherit the lifeline's write end and delay its EOF (the watcher would then fire late, never early). That was not reproduced here. Pyodide verification is whole-set rather than per-file (6.1). Because the build is now recorded once, `node build.mjs --target=store` is still the way to prove a build executes (6.2).

# ACP Continuity Pin Flake Investigation & Falsification Evidence

**Bead:** `chrome-agent-platform-jp78`
**Issue:** ACP continuity pin is load-sensitive and reds npm test
**Worktree:** `/home/paulkinlan/worktrees/chrome-agent-platform/pi-worktree-8d732512-0700-4ede-8131-28795195872d-s0-0`
**Branch:** `pi-subagents/worker-Fix-a-flaky-test-that-reds-a-fleet-wide-gate.-Read-home-paulkinlan-chrome-agent-b2ab813a-8d73251-46f9-s0-t0`
**Base:** `0c387326` (origin/main)

---

## 1. Problem & Root Cause Analysis

### Observation
In `tests/acp-runner.test.ts`, the test:
`runAcpTaskTurn: turn 2 RESUMES the session (session/new once, session/load after)`
intermittently red in the 32-worker phase of `npm test` ("exactly one session/new across two turns" saw 2), while passing in isolated single-file runs.

### Measured Root Cause
1. `deno test --parallel` executes test files concurrently within a single Deno process. Process environment variables (`Deno.env`) are shared across all test files running in parallel.
2. `tests/acp-runner.test.ts` previously configured the fake adapter's log path via `Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath)`.
3. `scripts/acp-bridge.ts` spawned the adapter child process spreading `...Deno.env.toObject()`.
4. Concurrently executing tests (such as `tests/acp-end-to-end.test.ts`) that created ACP servers spawned adapter processes that inherited `CAP_ACP_FIXTURE_LOG`. The concurrent adapter wrote its own JSON-RPC frames (`session/new`, prompt `"fixture prompt"`, `cwd: "/home/paulkinlan/cap-evidence/acp-fixture"`) into `acp-runner.test.ts`'s log file (captured in `red-attempt0-frames.jsonl`).
5. As a result, `methods.filter((m) => m === "session/new").length` was 2 instead of 1.
6. **Secondary defect:** The test had a blind 2-attempt loop. When attempt 0 failed, attempt 1 ran with the same harness ID (`"pi"`). But `acp-runner.js` cached the session ID in module-level `threadSessions`. Consequently, turn 1 of attempt 1 immediately resumed the cached session from attempt 0, failing on:
   `AssertionError: Values are not equal: the first turn has nothing to resume (Actual: true, Expected: false)`.

---

## 2. Deliverables & Fix

1. **Explicit Per-Server Child Environment (`scripts/acp-bridge.ts`):**
   `createAcpServer(port, adapterPathOverride, childEnv: Record<string, string> = {})`
   Adapter processes inherit `...childEnv` explicitly without polluting or relying on global `Deno.env`.
2. **Fixture Bridge in Tests (`tests/acp-runner.test.ts`):**
   Introduced `fixtureBridge(adapterEnv)` and routed all `CAP_ACP_FIXTURE_*` variables through `childEnv`. Removed all `Deno.env.set` calls for fixture configuration.
3. **Observer-Gated Continuity Retries (`tests/acp-runner.test.ts`):**
   - Each continuity run uses an attempt-indexed harness ID (`harnessId = run === 0 ? "pi" : "pi-attempt-${run}"`) so module cache collisions cannot fail subsequent attempts.
   - `resumeFailureVerdict(frames, message)` inspects whether the failure was an environmental spawn/transport failure vs a product regression:
     - If the frame log shows a `session/load` reached the adapter, or if no transport failure occurred, it is classified as `"product"` and fails immediately without retrying.
     - Only verified transport/spawn deaths (`"environment"`) are permitted to retry.
4. **Fault Injection Knob (`tests/fixtures/acp-fake-adapter.mjs`):**
   Added `CAP_ACP_FIXTURE_DIE_ON_SPAWN=N` and `CAP_ACP_FIXTURE_SPAWN_COUNTER=file` so transient adapter spawn failure can be deterministically tested.
5. **Shipped Fault-Injection Test (`tests/acp-runner.test.ts`):**
   Added `runAcpTaskTurn: an adapter spawn the environment killed is retried, never sold as a resume regression`, ensuring the environmental retry path is tested on every gate run.

---

## 3. Falsification Drills

### M1: Product Regression Drill (Disable Runner Resume)
- **Mutation:** In `extension/lib/acp-runner.js`, changed `if (sessionId)` to `if (false && sessionId)`.
- **Observed Result:** Attempt 1 failed immediately with `verdict: "product"`, raising:
  `AssertionError: Values are not equal: attempt 1: Values are not equal: the second turn must resume the first turn's session`
  `Actual: "product" / Expected: "environment"`
- **Verdict:** Pin immediately fails closed without masking the product defect behind retries. Log captured in `m1a-never-resume.log`.

### M2: Environmental Spawn Death Drill
- **Injection:** Set `CAP_ACP_FIXTURE_DIE_ON_SPAWN=2` with a counter file to kill exactly the 2nd adapter spawn.
- **Observed Result:**
  - First connection (`session/new`): ok
  - Second connection: adapter exited code 1 (`[fake-acp-adapter] injected spawn death (spawn 2)`)
  - Attempt 1 classified as `"environment"`
  - Attempt 2 retried with clean adapter: passed both turns (`session/new` once, `session/load` once)
- **Verdict:** Tested and pinned by the new test in `tests/acp-runner.test.ts`.

---

## 4. Gates Executed

1. `npm run test:file -- tests/acp-runner.test.ts`:
   - 17 passed | 0 failed | 0 ignored (427ms)
2. `npm run test:changed`:
   - Serial phase: 15/15 passed
   - Parallel phase: 448 files GREEN
   - Total: 4273 passed (14 steps) | 0 failed | 1 ignored
3. `npm test`:
   - Serial phase: 15 build/artifact files passed
   - Parallel phase: 448 files GREEN
   - Total: 463 files total, 4273 passed (14 steps) | 0 failed | 1 ignored

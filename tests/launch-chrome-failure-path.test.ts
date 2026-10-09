// tests/launch-chrome-failure-path.test.ts — chrome-agent-platform-5fh6a
//
// THE DEFECT. If teardownChrome threw during launch abort (because a cleanup
// step failed, pgrep timed out, or unconfirmed survivors remained), lock.release()
// and fleetLease.release() were skipped because release was placed on a straight line
// after `await teardownChrome(...)`. Furthermore, the teardown error replaced the
// original launch error (e.g. masking an unreadable process table or startup error).
//
// THE CONTRACT (chrome-agent-platform-5fh6a):
// 1. A failed launch must ALWAYS release its launch scope (lock) and fleet lease in finally,
//    even when teardownChrome throws or rejects.
// 2. The original launch error must always be the error that surfaces (never masked by
//    teardown errors; the teardown error is preserved in err.cause and logged).
// 3. When the process table is unreadable at launch, teardown recovers setsid's group
//    if the table becomes readable, or falls back to leader-plus-profile kill without throwing.
// 4. Scratch directories owned by the launcher are removed even when teardown throws.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  type ProcessTableDeps,
  type PsOutput,
  runBoundedProbe,
} from "../scripts/lib/process-tree.ts";
import { type LaunchedChrome, launchChrome, teardownChrome } from "../scripts/lib/chrome-launch.ts";

const LSTART = "Wed Oct  7 13:30:23 2026";
const PGREP = "/usr/bin/pgrep";

const refuses = (message: string): ProcessTableDeps => ({
  hasProc: false,
  ps: () => {
    throw new Error(message);
  },
});

async function survivors(pattern: string): Promise<string[]> {
  const res = await new Deno.Command(PGREP, { args: ["-f", pattern], stdout: "piped", stderr: "piped", clearEnv: true })
    .output();
  if (res.code === 1) return [];
  if (res.code !== 0) throw new Error(`pgrep exited ${res.code}`);
  return new TextDecoder().decode(res.stdout).trim().split("\n").filter(Boolean);
}

async function waitForZeroSurvivors(pattern: string, maxMs = 4000): Promise<string[]> {
  let list = await survivors(pattern);
  const deadline = Date.now() + maxMs;
  while (list.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    list = await survivors(pattern);
  }
  return list;
}

// ── FALSIFIER 1: Teardown throws during unreadable table launch abort ─────────

Deno.test(
  "launchChrome: a throwing teardown during unreadable-table launch abort releases lock and fleet-lease and preserves original error (5fh6a)",
  async () => {
    const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "5fh6a-teardown-throw-" });
    const fake = `${root}/fake-browser`;
    const profile = `${root}/profile`;
    const lockPath = `${root}/scope`;
    const slotPath = `${root}/fleet-slot`;

    Deno.writeTextFileSync(
      fake,
      [
        "#!/bin/bash",
        "echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2",
        '( exec -a "helper $*" sleep 300 ) &',
        "wait",
        "",
      ].join("\n"),
    );
    Deno.chmodSync(fake, 0o755);

    let teardownRan = false;
    let caughtError: unknown;
    let capturedTarget: any = null;

    try {
      try {
        await launchChrome({
          binary: fake,
          profile,
          lockPath,
          fleetSlot: { slotPath, gate: "test-gate", boundMs: 5000 },
          requireQuiet: { maxLoadPerCore: 999, maxCompilers: 999, sampleMs: 10, sustainedSamples: 1 },
          timeoutMs: 5000,
          processTable: refuses("spawn EAGAIN: simulated process table read failure"),
          teardown: async (target) => {
            teardownRan = true;
            capturedTarget = target;
            // Clean up the actual spawned proc so we don't leak processes in the test
            if (target && typeof target === "object" && "proc" in target && target.proc) {
              try { (target.proc as Deno.ChildProcess).kill("SIGKILL"); } catch {}
              await (target.proc as Deno.ChildProcess).status.catch(() => {});
            }
            throw new Error("injected teardown failure: pkill exited 2");
          },
        });
      } catch (err) {
        caughtError = err;
      }

      assert(teardownRan, "injected teardown must have run");
      assert(caughtError instanceof Error, "launchChrome must have thrown an Error");

      // 1. Error message must name the ORIGINAL launch failure, NOT the teardown failure!
      assert(
        caughtError.message.includes("spawn EAGAIN: simulated process table read failure"),
        `error message must preserve the original failure: ${caughtError.message}`,
      );
      assert(
        !caughtError.message.startsWith("injected teardown failure"),
        `error message must NOT be replaced by the teardown error: ${caughtError.message}`,
      );

      // 2. Teardown error must be preserved on cause
      assert(
        caughtError.cause instanceof Error && caughtError.cause.message.includes("injected teardown failure"),
        `teardown failure must be attached to error.cause: ${caughtError.cause}`,
      );

      // 3. Lock scope MUST be released
      const lockHolders = await waitForZeroSurvivors(lockPath);
      assertEquals(lockHolders, [], "the lock holder must be released even when teardown throws");

      // 4. Fleet lease MUST be released
      const leaseHolders = await waitForZeroSurvivors(slotPath);
      assertEquals(leaseHolders, [], "the fleet lease must be released even when teardown throws");
    } finally {
      if (capturedTarget) {
        await teardownChrome(capturedTarget);
      } else {
        await teardownChrome(null, profile);
      }
      try { Deno.removeSync(root, { recursive: true }); } catch {}
    }
  },
);

// ── FALSIFIER 2: Teardown throws when browser never prints DevTools endpoint ──

Deno.test(
  "launchChrome: a throwing teardown when browser never prints DevTools endpoint releases lock and fleet-lease and preserves endpoint error (5fh6a)",
  async () => {
    const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "5fh6a-endpoint-throw-" });
    const fake = `${root}/fake-browser-silent`;
    const profile = `${root}/profile`;
    const lockPath = `${root}/scope`;
    const slotPath = `${root}/fleet-slot`;

    // Script prints nothing on stderr
    Deno.writeTextFileSync(
      fake,
      [
        "#!/bin/bash",
        "sleep 300",
        "",
      ].join("\n"),
    );
    Deno.chmodSync(fake, 0o755);

    let teardownRan = false;
    let caughtError: unknown;
    let capturedTarget: any = null;

    try {
      try {
        await launchChrome({
          binary: fake,
          profile,
          lockPath,
          fleetSlot: { slotPath, gate: "test-gate", boundMs: 5000 },
          requireQuiet: { maxLoadPerCore: 999, maxCompilers: 999, sampleMs: 10, sustainedSamples: 1 },
          timeoutMs: 150,
          teardown: async (target) => {
            teardownRan = true;
            capturedTarget = target;
            if (target && typeof target === "object" && "proc" in target && target.proc) {
              try { (target.proc as Deno.ChildProcess).kill("SIGKILL"); } catch {}
              await (target.proc as Deno.ChildProcess).status.catch(() => {});
            }
            throw new Error("injected teardown failure: cleanup confirmation failed");
          },
        });
      } catch (err) {
        caughtError = err;
      }

      assert(teardownRan, "injected teardown must have run");
      assert(caughtError instanceof Error, "launchChrome must have thrown an Error");

      // Original error must surface
      assert(
        caughtError.message.includes("Chrome never printed a DevTools endpoint"),
        `error must be endpoint failure: ${caughtError.message}`,
      );

      // Teardown error must be preserved on cause
      assert(
        caughtError.cause instanceof Error && caughtError.cause.message.includes("injected teardown failure"),
        `teardown failure must be attached to error.cause: ${caughtError.cause}`,
      );

      // Both locks must be released
      const lockHolders = await waitForZeroSurvivors(lockPath);
      assertEquals(lockHolders, [], "the lock holder must be released when endpoint check fails and teardown throws");

      const leaseHolders = await waitForZeroSurvivors(slotPath);
      assertEquals(leaseHolders, [], "the fleet lease must be released when endpoint check fails and teardown throws");
    } finally {
      if (capturedTarget) {
        await teardownChrome(capturedTarget);
      } else {
        await teardownChrome(null, profile);
      }
      try { Deno.removeSync(root, { recursive: true }); } catch {}
    }
  },
);

// ── FALSIFIER 3: Unreadable table at launch recovers group when table becomes readable ──

Deno.test(
  "launchChrome: unreadable table at launch recovers setsid group when process table becomes readable before teardown (5fh6a)",
  async () => {
    const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "5fh6a-group-recover-" });
    const fake = `${root}/fake-browser`;
    const profile = `${root}/profile`;
    const lockPath = `${root}/scope`;
    const helperMarker = `helper-5fh6a-${crypto.randomUUID()}`;

    // Fake browser spawns an UNMARKED helper in its setsid group (argv carries NO profile)
    // and polls until pgrep confirms it is running before printing DevTools listening
    Deno.writeTextFileSync(
      fake,
      [
        "#!/bin/bash",
        `( exec -a "${helperMarker}" sleep 300 ) &`,
        `while ! pgrep -f "${helperMarker}" >/dev/null 2>&1; do sleep 0.01; done`,
        "echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2",
        "wait",
        "",
      ].join("\n"),
    );
    Deno.chmodSync(fake, 0o755);

    let probeCalls = 0;
    // Fails on the first call (during isolatedProcessGroup), then delegates to real ps
    const recoverableProcessTable: ProcessTableDeps = {
      hasProc: false,
      ps: (args: string[]): PsOutput => {
        probeCalls++;
        if (probeCalls === 1) {
          throw new Error("simulated temporary ps failure");
        }
        return runBoundedProbe("/bin/ps", args);
      },
    };

    let observedTarget: any = null;

    try {
      await assertRejects(
        async () => {
          await launchChrome({
            binary: fake,
            profile,
            lockPath,
            timeoutMs: 5000,
            processTable: recoverableProcessTable,
            teardown: async (target) => {
              observedTarget = target;
              // Assert the unmarked helper is running before teardown proceeds (handshake)
              const running = await survivors(helperMarker);
              assert(running.length >= 1, "unmarked helper must be running before teardown begins");
              await teardownChrome(target);
            },
          });
        },
        Error,
        "simulated temporary ps failure",
      );

      assert(observedTarget !== null, "teardown must have been called");
      assert(
        typeof observedTarget.processGroup === "number" && observedTarget.processGroup > 0,
        `teardown must have received recovered processGroup: ${observedTarget.processGroup}`,
      );
      assertEquals(
        observedTarget.processGroup,
        observedTarget.proc?.pid,
        "recovered processGroup must equal setsid leader pid",
      );

      // Verify that group kill eliminated the UNMARKED helper that carried no profile string!
      const unmarkedSurvivors = await waitForZeroSurvivors(helperMarker);
      assertEquals(unmarkedSurvivors, [], "recovered group kill must destroy unmarked group members");

      const lockHolders = await waitForZeroSurvivors(lockPath);
      assertEquals(lockHolders, [], "lock must be released");
    } finally {
      if (observedTarget) {
        await teardownChrome(observedTarget);
      } else {
        await teardownChrome(null, profile);
      }
      try { Deno.removeSync(root, { recursive: true }); } catch {}
    }
  },
);

// ── FALSIFIER 4: Persistent unreadable table falls back to leader-plus-profile kill ──

Deno.test(
  "launchChrome: persistent unreadable table falls back to leader-plus-profile kill without throwing (5fh6a)",
  async () => {
    const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "5fh6a-fallback-kill-" });
    const fake = `${root}/fake-browser`;
    const profile = `${root}/profile`;
    const lockPath = `${root}/scope`;

    Deno.writeTextFileSync(
      fake,
      [
        "#!/bin/bash",
        "echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2",
        '( exec -a "helper $*" sleep 300 ) &',
        "wait",
        "",
      ].join("\n"),
    );
    Deno.chmodSync(fake, 0o755);

    let observedTarget: any = null;

    try {
      await assertRejects(
        async () => {
          await launchChrome({
            binary: fake,
            profile,
            lockPath,
            timeoutMs: 5000,
            processTable: refuses("persistent ps failure: EPERM"),
            teardown: async (target) => {
              observedTarget = target;
              // Call the REAL teardownChrome to verify that leader-plus-profile kill cleans up
              await teardownChrome(target);
            },
          });
        },
        Error,
        "persistent ps failure: EPERM",
      );

      assert(observedTarget !== null, "teardown must have been called");
      assertEquals(
        observedTarget.processGroup,
        undefined,
        "persistent unreadable table must pass processGroup: undefined to indicate leader-plus-profile kill fallback",
      );

      // Real teardownChrome must have killed the leader and helper matching the profile
      const helpers = await waitForZeroSurvivors(`user-data-dir=${profile}`);
      assertEquals(helpers, [], "leader-plus-profile kill must have eliminated profile survivors");

      const lockHolders = await waitForZeroSurvivors(lockPath);
      assertEquals(lockHolders, [], "lock must be released");
    } finally {
      if (observedTarget) {
        await teardownChrome(observedTarget);
      } else {
        await teardownChrome(null, profile);
      }
      try { Deno.removeSync(root, { recursive: true }); } catch {}
    }
  },
);

// ── FALSIFIER 5: Pre-spawn failure releases lock and lease ────────────────────

Deno.test(
  "launchChrome: pre-spawn refusal releases fleet-lease and does not leak (5fh6a)",
  async () => {
    const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "5fh6a-prespawn-throw-" });
    const slotPath = `${root}/fleet-slot`;
    const fake = `${root}/fake-browser`;
    Deno.writeTextFileSync(fake, "#!/bin/bash\nexit 0\n");
    Deno.chmodSync(fake, 0o755);

    let launched: LaunchedChrome | undefined;
    try {
      await assertRejects(
        async () => {
          launched = await launchChrome({
            binary: fake,
            args: ["--remote-debugging-port=9999"],
            fleetSlot: { slotPath, gate: "test-gate", boundMs: 5000 },
            requireQuiet: { maxLoadPerCore: 999, maxCompilers: 999, sampleMs: 10, sustainedSamples: 1 },
          });
        },
        Error,
        "refusing a caller-chosen debugging port",
      );

      const leaseHolders = await waitForZeroSurvivors(slotPath);
      assertEquals(leaseHolders, [], "fleet lease must be released on pre-spawn refusal");
    } finally {
      if (launched) await teardownChrome(launched);
      try { Deno.removeSync(root, { recursive: true }); } catch {}
    }
  },
);

// ── FALSIFIER 7: Endpoint failure retries leader-plus-profile cleanup on group throw ──

Deno.test(
  "launchChrome: endpoint failure retries leader-plus-profile cleanup when group teardown throws (5fh6a)",
  async () => {
    const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "5fh6a-endpoint-flaky-" });
    const fake = `${root}/fake-browser-silent`;
    const profile = `${root}/profile`;
    const lockPath = `${root}/scope`;
    const slotPath = `${root}/fleet-slot`;
    const helperMarker = `ep-helper-${crypto.randomUUID()}`;

    // Silent fake browser spawns a profile helper and sleeps
    // Polls until pgrep confirms helper is live before entering sleep
    Deno.writeTextFileSync(
      fake,
      [
        "#!/bin/bash",
        `( exec -a "${helperMarker} $*" sleep 300 ) &`,
        `while ! pgrep -f "${helperMarker}" >/dev/null 2>&1; do sleep 0.01; done`,
        "sleep 300",
        "",
      ].join("\n"),
    );
    Deno.chmodSync(fake, 0o755);

    let capturedTarget: any = null;
    let teardownAttempts = 0;

    try {
      await assertRejects(
        async () => {
          await launchChrome({
            binary: fake,
            profile,
            lockPath,
            fleetSlot: { slotPath, gate: "test-gate", boundMs: 5000 },
            requireQuiet: { maxLoadPerCore: 999, maxCompilers: 999, sampleMs: 10, sustainedSamples: 1 },
            timeoutMs: 150,
            teardown: async (target) => {
              teardownAttempts++;
              capturedTarget = target;
              if (teardownAttempts === 1) {
                // Assert the helper is confirmed live before teardown proceeds (handshake)
                const running = await survivors(helperMarker);
                assert(running.length >= 1, "profile helper must be running before teardown begins");
              }
              if (target && typeof target === "object" && "processGroup" in target && target.processGroup !== undefined) {
                // First call has group: simulate unreadable process table throw
                throw new Error("simulated group teardown throw: process table unreadable");
              }
              // Fallback call has processGroup: undefined: run real teardown to clean up
              await teardownChrome(target);
            },
          });
        },
        Error,
        "Chrome never printed a DevTools endpoint",
      );

      // Verify teardown was called at least twice (initial group call + fallback leader-plus-profile call)
      assert(teardownAttempts >= 2, `expected retry call, got ${teardownAttempts} calls`);
      assertEquals(
        capturedTarget && typeof capturedTarget === "object" && "processGroup" in capturedTarget ? capturedTarget.processGroup : null,
        undefined,
        "final teardown call must be leader-plus-profile fallback",
      );

      // Verify profile helper is gone and locks released
      const helpers = await waitForZeroSurvivors(helperMarker);
      assertEquals(helpers, [], "fallback cleanup must leave no profile helpers alive");

      const lockHolders = await waitForZeroSurvivors(lockPath);
      assertEquals(lockHolders, [], "lock must be released");

      const leaseHolders = await waitForZeroSurvivors(slotPath);
      assertEquals(leaseHolders, [], "fleet lease must be released");
    } finally {
      if (capturedTarget) {
        await teardownChrome(capturedTarget);
      } else {
        await teardownChrome(null, profile);
      }
      try { Deno.removeSync(root, { recursive: true }); } catch {}
    }
  },
);


Deno.test(
  "launchChrome: fail–succeed–fail probe falls back to leader-plus-profile cleanup and never leaves browser alive (5fh6a)",
  async () => {
    const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "5fh6a-fail-succ-fail-" });
    const fake = `${root}/fake-browser`;
    const profile = `${root}/profile`;
    const lockPath = `${root}/scope`;
    const helperMarker = `profile-helper-${crypto.randomUUID()}`;

    Deno.writeTextFileSync(
      fake,
      [
        "#!/bin/bash",
        "echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2",
        `( exec -a "${helperMarker} $*" sleep 300 ) &`,
        "wait",
        "",
      ].join("\n"),
    );
    Deno.chmodSync(fake, 0o755);

    let probeCalls = 0;
    // Call 1: fails in isolatedProcessGroup
    // Call 2: succeeds in launchChrome recovery probe (recovers group = proc.pid)
    // Call 3+: fails again when teardown tries to verify group
    const flakyProcessTable: ProcessTableDeps = {
      hasProc: false,
      ps: (args: string[]): PsOutput => {
        probeCalls++;
        if (probeCalls === 1) {
          throw new Error("call 1 failed: simulated initial ps failure");
        }
        if (probeCalls === 2) {
          const pidIdx = args.indexOf("-p");
          const pid = pidIdx >= 0 ? Number(args[pidIdx + 1]) : Deno.pid;
          return {
            code: 0,
            signal: null,
            stdout: `  ${pid}  ${pid} S  ${LSTART}\n`,
            stderr: "",
          };
        }
        // Call 3+: fails again when teardown tries to verify group
        throw new Error("call 3+ failed: process table unreadable during teardown");
      },
    };

    let capturedTarget: any = null;

    try {
      await assertRejects(
        async () => {
          await launchChrome({
            binary: fake,
            profile,
            lockPath,
            timeoutMs: 5000,
            processTable: flakyProcessTable,
            teardown: async (target) => {
              capturedTarget = target;
              await teardownChrome(target);
            },
          });
        },
        Error,
        "call 1 failed: simulated initial ps failure",
      );

      assert(capturedTarget !== null, "teardown must have been called");

      // Even though group verification threw on call 3, the leader-plus-profile cleanup fallback
      // must have killed the leader and helper matching the profile!
      const profileSurvivors = await waitForZeroSurvivors(`user-data-dir=${profile}`);
      assertEquals(profileSurvivors, [], "fallback cleanup must leave no profile survivors");

      const lockHolders = await waitForZeroSurvivors(lockPath);
      assertEquals(lockHolders, [], "lock must be released");
    } finally {
      if (capturedTarget) {
        await teardownChrome(capturedTarget);
      } else {
        await teardownChrome(null, profile);
      }
      try { Deno.removeSync(root, { recursive: true }); } catch {}
    }
  },
);

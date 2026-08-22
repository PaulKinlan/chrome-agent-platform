#!/usr/bin/env node
// Process/profile/evidence custody for the serialized real-Chromium security
// suite. The shell wrapper owns and passes canonical flock fd 9 before this
// process may create a profile, evidence, server, or browser.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attestOwnedGroup,
  CANONICAL_LOCK,
  cleanupExactProfile,
  groupAlive,
  inspectExactProfile,
  inspectOwnedDirectory,
  liveObservedResidue,
  makeReadOnly,
  observeDescendants,
  pidAlive,
  PROFILE_ROOT,
  readProcIdentity,
  resolveSupervisorConfig,
  SELF_TEST_TOKEN,
  SLOT_POISON,
  terminateAttestedGroup,
  verifyInheritedCanonicalLock,
  waitUntil,
} from "./security-suite-custody.mjs";

const EXPECTED_FIXTURE_HASH =
  "adf74ed363d226daab34b74143ac37c4d9297979bd530d7ef29e0863f6129bf3";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const SUPERVISOR_SIGNALS = new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGTERM", 15],
]);
const RUNNER_SIGNAL_NUMBERS = new Map([
  ...SUPERVISOR_SIGNALS,
  ["SIGKILL", 9],
]);

function fail(message, code = 2) {
  console.error(`SECURITY-SUITE SUPERVISOR REFUSED: ${message}`);
  process.exit(code);
}

const lockError = await verifyInheritedCanonicalLock(9);
if (lockError) fail(lockError);
try {
  await lstat(SLOT_POISON);
  fail(`canonical Chrome slot is poisoned at ${SLOT_POISON}`);
} catch (error) {
  if (error?.code !== "ENOENT") fail("cannot inspect canonical poison state");
}

let config;
try {
  config = await resolveSupervisorConfig({
    env: process.env,
    repoRoot: REPO_ROOT,
    expectedFixtureHash: EXPECTED_FIXTURE_HASH,
  });
} catch (error) {
  fail(error.message);
}

const runId = randomBytes(8).toString("hex");
const evidenceRoot = config.evidenceRoot;
const profileRoot = config.profileRoot;
const out = path.join(evidenceRoot, runId);
const profile = path.join(profileRoot, runId);
const guardPath = path.join(out, "guard.json");
const runnerLog = path.join(out, "runner.log");
const receiptPath = path.join(out, "receipt.json");
const identityPath = path.join(out, "identity.json");
const statePath = path.join(out, "self-test-state.jsonl");

await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await mkdir(profileRoot, { recursive: true, mode: 0o700 });
const [evidenceRootCheck, profileRootCheck] = await Promise.all([
  inspectOwnedDirectory({ directory: evidenceRoot }),
  inspectOwnedDirectory({ directory: profileRoot }),
]);
if (!evidenceRootCheck.ok) {
  fail(`evidence root refused: ${evidenceRootCheck.reason}`);
}
if (!profileRootCheck.ok) {
  fail(`profile root refused: ${profileRootCheck.reason}`);
}
await Promise.all([chmod(evidenceRoot, 0o700), chmod(profileRoot, 0o700)]);
await mkdir(out, { mode: 0o700 });
await mkdir(profile, { mode: 0o700 });
const profileCheck = await inspectExactProfile({ profile, root: PROFILE_ROOT });
if (!profileCheck.ok) fail(`created profile refused: ${profileCheck.reason}`);

const nonce = randomBytes(16).toString("hex");
const parentIdentity = await readProcIdentity(process.pid);
const guard = {
  schemaVersion: 1,
  nonce,
  parentPid: process.pid,
  parentStart: parentIdentity.starttime,
  lockPath: CANONICAL_LOCK,
  issuedAt: Date.now(),
};
await writeFile(guardPath, `${JSON.stringify(guard)}\n`, {
  mode: 0o600,
  flag: "wx",
});

const runnerHandle = await open(runnerLog, "wx", 0o600);
const childEnv = {
  ...process.env,
  CAP_SECURITY_NONCE: nonce,
  CAP_SECURITY_GUARD: guardPath,
  CAP_SECURITY_PARENT: String(process.pid),
  CAP_SECURITY_PROFILE: profile,
};
if (config.selfTest) {
  childEnv.CAP_SECURITY_TEST_SCENARIO = config.scenario;
  childEnv.CAP_SECURITY_TEST_STATE = statePath;
} else {
  delete childEnv.CAP_SECURITY_SELF_TEST;
  delete childEnv.CAP_SECURITY_RUNNER;
  delete childEnv.CAP_SECURITY_SELF_TEST_TIMEOUT_MS;
  delete childEnv.CAP_SECURITY_TEST_FORCE_ATTEST_MISMATCH;
  delete childEnv.CAP_SECURITY_TEST_SCENARIO;
  delete childEnv.CAP_SECURITY_TEST_STATE;
}

const stdio = ["ignore", runnerHandle.fd, runnerHandle.fd];
while (stdio.length < 9) stdio.push("ignore");
stdio.push(9); // inherited canonical flock open-file description
const child = spawn(config.command, config.args, {
  cwd: REPO_ROOT,
  detached: true,
  env: childEnv,
  stdio,
});
await runnerHandle.close();

const exitPromise = new Promise((resolve) => {
  child.once("error", (error) => resolve({ kind: "spawn-error", error }));
  child.once(
    "close",
    (code, signal) => resolve({ kind: "exit", code, signal }),
  );
});

let attestation = null;
const attestDeadline = Date.now() + 2_000;
while (Date.now() < attestDeadline) {
  try {
    const readIdentity = config.forceAttestationMismatch
      ? async (pid) => {
        const identity = await readProcIdentity(pid);
        return { ...identity, sid: identity.sid + 1 };
      }
      : readProcIdentity;
    const result = await attestOwnedGroup(child.pid, { readIdentity });
    if (result.ok) {
      attestation = result;
      break;
    }
    if (config.forceAttestationMismatch) {
      attestation = result;
      break;
    }
  } catch {
    // setsid may still be settling, or a very early child may already have died.
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function terminateUnattestedPid(pid) {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (!await waitUntil(() => pidAlive(pid), 250)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await waitUntil(() => pidAlive(pid), 1_000);
  }
}

async function finalizeEarlyFailure(reason) {
  await terminateUnattestedPid(child.pid);
  await exitPromise;
  const cleanup = await cleanupExactProfile({ profile, root: PROFILE_ROOT });
  const receipt = {
    schemaVersion: 1,
    runId,
    result: "REFUSED",
    reason,
    pid: child.pid,
    cleaned: cleanup.ok && cleanup.removed,
    selfTest: config.selfTest,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(
    identityPath,
    `${JSON.stringify({ pid: child.pid, attested: false })}\n`,
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  await makeReadOnly([guardPath, runnerLog, receiptPath, identityPath]);
  console.log(
    `CAP_SECURITY_RESULT ${JSON.stringify({ ...receipt, evidence: out })}`,
  );
  process.exit(2);
}

if (!attestation?.ok) {
  await finalizeEarlyFailure(
    attestation?.reason ?? "PGID/SID attestation failed: child did not settle",
  );
}

await writeFile(
  identityPath,
  `${
    JSON.stringify({
      pid: child.pid,
      pgid: attestation.identity.pgid,
      sid: attestation.identity.sid,
      starttime: attestation.identity.starttime,
      uid: attestation.identity.uid,
      attested: true,
    })
  }\n`,
  { mode: 0o600, flag: "wx" },
);

const observed = new Map();
let sampling = false;
await observeDescendants(child.pid, observed);
const monitor = setInterval(async () => {
  if (sampling) return;
  sampling = true;
  try {
    await observeDescendants(child.pid, observed);
  } finally {
    sampling = false;
  }
}, 20);

let interruptedSignal = null;
let interruptResolve;
const interruptPromise = new Promise((resolve) => {
  interruptResolve = resolve;
});
for (const signal of SUPERVISOR_SIGNALS.keys()) {
  process.once(signal, () => {
    interruptedSignal = signal;
    interruptResolve({ kind: "supervisor-signal", signal });
  });
}
const timeoutPromise = new Promise((resolve) => {
  setTimeout(() => resolve({ kind: "timeout" }), config.timeoutMs);
});

const trigger = await Promise.race([
  exitPromise,
  timeoutPromise,
  interruptPromise,
]);
const timedOut = trigger.kind === "timeout";
let outcome = trigger;
let termination = { termSent: false, killSent: false, survived: false };
if (trigger.kind === "timeout" || trigger.kind === "supervisor-signal") {
  termination = await terminateAttestedGroup({
    attestation,
    observed,
    termWaitMs: config.termWaitMs,
    killWaitMs: config.killWaitMs,
  });
  outcome = await Promise.race([
    exitPromise,
    new Promise((resolve) =>
      setTimeout(() => resolve({ kind: "reap-timeout" }), config.killWaitMs)
    ),
  ]);
}

await observeDescendants(child.pid, observed).catch(() => {});
clearInterval(monitor);
while (sampling) await new Promise((resolve) => setTimeout(resolve, 5));

if (groupAlive(attestation.identity.pgid)) {
  const extra = await terminateAttestedGroup({
    attestation,
    observed,
    termWaitMs: config.termWaitMs,
    killWaitMs: config.killWaitMs,
  });
  termination = {
    termSent: termination.termSent || extra.termSent,
    killSent: termination.killSent || extra.killSent,
    survived: termination.survived || extra.survived,
  };
}

const residue = await liveObservedResidue(observed);
let poisonReason = "";
if (termination.survived) poisonReason = "owned-group-survived";
if (residue.length > 0) poisonReason = "descendant-residue";
if (poisonReason) {
  await writeFile(SLOT_POISON, `${poisonReason}\n`, { mode: 0o600, flag: "wx" })
    .catch(() => {});
}

const cleanup = await cleanupExactProfile({ profile, root: PROFILE_ROOT });
if (!cleanup.ok) {
  poisonReason ||= `cleanup-refused:${cleanup.reason}`;
  await writeFile(SLOT_POISON, `${poisonReason}\n`, { mode: 0o600, flag: "wx" })
    .catch(() => {});
}

let exitCode;
let runnerSignal = null;
if (interruptedSignal) {
  runnerSignal = interruptedSignal;
  exitCode = 128 + SUPERVISOR_SIGNALS.get(interruptedSignal);
} else if (timedOut) {
  exitCode = 124;
} else if (outcome.kind === "exit" && outcome.signal) {
  runnerSignal = outcome.signal;
  exitCode = 128 + (RUNNER_SIGNAL_NUMBERS.get(outcome.signal) ?? 0);
} else if (outcome.kind === "exit") {
  exitCode = outcome.code ?? 1;
} else if (outcome.kind === "spawn-error") {
  exitCode = 2;
} else {
  exitCode = 124;
}
if (termination.survived) exitCode = 72;
if (residue.length > 0) exitCode = 70;
if (!cleanup.ok) exitCode = 71;

const receipt = {
  schemaVersion: 1,
  runId,
  result: exitCode === 0 ? "PASS" : "FAIL",
  selfTest: config.selfTest,
  scenario: config.scenario,
  pid: child.pid,
  pgid: attestation.identity.pgid,
  sid: attestation.identity.sid,
  exit: exitCode,
  runnerSignal,
  timedOut,
  termSent: termination.termSent,
  killSent: termination.killSent,
  groupSurvived: termination.survived,
  residue: residue.map(({ pid, starttime, pgid, sid }) => ({
    pid,
    starttime,
    pgid,
    sid,
  })),
  poisonReason,
  cleaned: cleanup.ok && cleanup.removed,
};
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
await makeReadOnly([
  guardPath,
  runnerLog,
  receiptPath,
  identityPath,
  statePath,
]);
console.log(
  `CAP_SECURITY_RESULT ${JSON.stringify({ ...receipt, evidence: out })}`,
);
process.exit(exitCode);

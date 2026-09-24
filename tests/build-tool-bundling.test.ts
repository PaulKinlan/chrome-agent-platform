// tests/build-tool-bundling.test.ts — executable KATs for the bundled-tool
// verify-mode build wiring (owner requirement: `npm run build` truthfully
// bundles the tools). The default build runs the generator in --verify mode
// and fails closed on drift; full regeneration is the explicit --regen-tools
// flag only. Drift target: packages/bundled/sqlite3/PROVENANCE.json — a
// generated file no other test reads.
// @ts-nocheck: subprocess and byte-level fixtures.
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runBoundedChild } from "../scripts/lib/bounded-child.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GENERATOR = `${ROOT}scripts/build-bundled-tool-packages.mjs`;
const DRIFT_TARGET = `${ROOT}packages/bundled/sqlite3/PROVENANCE.json`;

const CHILD_TIMEOUT_MS = Number(Deno.env.get("CAP_BOUNDED_CHILD_TIMEOUT_MS") ?? 120_000);
// build.mjs runs the generator under its OWN bound (CAP_BUNDLED_TOOL_TIMEOUT_MS,
// default 120s) and each helper spawn is its own process group, so the outer
// bound must be LONGER than the inner one: the inner error must surface first,
// named. An outer kill would leave the inner child holding the pipes.
const BUILD_TIMEOUT_MS = CHILD_TIMEOUT_MS + 30_000;

/** Bounded child runner — the SAME implementation build.mjs uses
 * (scripts/lib/bounded-child.mjs). The bundled-tool generator can block in a
 * futex wait and never exit: an unbounded child presents that as "the test
 * timed out" minutes later, naming the wrong cause. On timeout the shared
 * helper kills the whole process group (pozs) and throws naming the live
 * child's state (fnmr), so the failure blames the hang. */
async function run(cmd, args, timeoutMs = CHILD_TIMEOUT_MS) {
  const r = await runBoundedChild(cmd, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs,
    label: [cmd, ...args].join(" "),
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
async function verify() {
  // The report flags: a non-futex hang leaves a diagnostic report for the bounded runner (fnmr).
  return await run("node", ["--report-on-signal", "--report-signal=SIGUSR2", GENERATOR, "--verify"]);
}
/** chrome-agent-platform-p15i: a run KILLED mid-fixture (SIGKILL traps no
 * finally) leaves its drift in the SHARED packages/bundled tree, and every
 * later run fails 'generated outputs drifted' — a false red in a different
 * run. Reconcile, but ONLY the exact fixture signatures: the byte-flip the
 * drift test applies (first byte XOR 0x01 of the HEAD content, rest equal)
 * and the exact stray-file body. Anything else — a lane's real edit, real
 * committed drift — is never touched, so this can never mask true drift. */
/** Raw bytes of the committed drift target (text-decoding corrupts binary reads). */
function headProvenanceBytes() {
  const out = new Deno.Command("git", {
    args: ["show", "HEAD:packages/bundled/sqlite3/PROVENANCE.json"],
    cwd: ROOT, stdout: "piped", stderr: "null",
  }).outputSync();
  return out.code === 0 ? out.stdout : null;
}

export function reconcileFixtureResidue() {
  const headBytes = headProvenanceBytes();
  const restored = [];
  if (headBytes) {
    let current = null;
    try { current = Deno.readFileSync(DRIFT_TARGET); } catch { /* absent: a real state, leave it */ }
    if (
      current && current.length === headBytes.length &&
      current.length > 0 && current[0] === (headBytes[0] ^ 0x01) &&
      current.slice(1).every((b, i) => b === headBytes[i + 1])
    ) {
      Deno.writeFileSync(DRIFT_TARGET, headBytes);
      restored.push("packages/bundled/sqlite3/PROVENANCE.json (fixture byte-flip)");
    }
  }
  const stray = `${ROOT}packages/bundled/stray-uncommitted-file.txt`;
  try {
    if (Deno.readTextFileSync(stray) === "not generated\n") {
      Deno.removeSync(stray);
      restored.push("packages/bundled/stray-uncommitted-file.txt (fixture stray)");
    }
  } catch { /* absent, or real content — leave it */ }
  return restored;
}
// At load: heal a previous kill's residue before any test in this file reads
// the shared tree.
reconcileFixtureResidue();

Deno.test("verify mode: the committed generated tree has zero drift", async () => {
  const r = await verify();
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "VERIFY OK");
});

Deno.test("p15i reconciliation: a killed run's exact fixture residue self-heals, real drift is never masked", async () => {
  const headBytes = headProvenanceBytes();
  assert(headBytes, "the drift target resolves from HEAD");
  const original = Deno.readFileSync(DRIFT_TARGET);
  const stray = `${ROOT}packages/bundled/stray-uncommitted-file.txt`;
  try {
    // The exact fixture signatures a SIGKILLed run would leave behind.
    const flipped = Uint8Array.from(headBytes);
    flipped[0] = flipped[0] ^ 0x01;
    Deno.writeFileSync(DRIFT_TARGET, flipped);
    Deno.writeTextFileSync(stray, "not generated\n");
    const healed = reconcileFixtureResidue();
    assertEquals(healed.length, 2, `both fixture residues reconciled, got ${JSON.stringify(healed)}`);
    assertEquals((await verify()).code, 0, "verify passes again after reconciliation");

    // A NON-fixture change is not the fixture's residue: reconcile leaves it
    // and verify still fails — reconciliation can never mask real drift.
    const realDrift = Uint8Array.from(headBytes);
    realDrift[0] = realDrift[0] ^ 0x03; // NOT the fixture's ^0x01 signature
    Deno.writeFileSync(DRIFT_TARGET, realDrift);
    assertEquals(reconcileFixtureResidue().length, 0, "non-fixture change is never touched");
    assertNotEquals((await verify()).code, 0, "real drift still fails closed after reconciliation");
  } finally {
    Deno.writeFileSync(DRIFT_TARGET, original);
    try { Deno.removeSync(stray); } catch { /* absent */ }
  }
  assertEquals((await verify()).code, 0, "clean state restored");
});

Deno.test("drift detection: flipping one generated byte fails verify closed and names the file", async () => {
  const original = Deno.readFileSync(DRIFT_TARGET);
  try {
    const mutated = Uint8Array.from(original);
    mutated[0] = mutated[0] ^ 0x01;
    Deno.writeFileSync(DRIFT_TARGET, mutated);
    const r = await verify();
    assertNotEquals(r.code, 0, "verify must fail closed on drift");
    assertStringIncludes(r.stderr, "byte-drift: packages/bundled/sqlite3/PROVENANCE.json");
    assertStringIncludes(r.stderr, "--regen-tools");
  } finally {
    Deno.writeFileSync(DRIFT_TARGET, original);
  }
  assertEquals((await verify()).code, 0, "verify must pass again after restoring the byte");
});

Deno.test("drift detection: an ungenerated file inside a generated tree fails verify closed", async () => {
  const stray = `${ROOT}packages/bundled/stray-uncommitted-file.txt`;
  try {
    Deno.writeFileSync(stray, new TextEncoder().encode("not generated\n"));
    const r = await verify();
    assertNotEquals(r.code, 0, "verify must fail closed on an ungenerated file");
    assertStringIncludes(r.stderr, "ungenerated file present: packages/bundled/stray-uncommitted-file.txt");
  } finally {
    Deno.removeSync(stray);
  }
  assertEquals((await verify()).code, 0, "verify must pass again after removing the stray file");
});

Deno.test("regen idempotence: full regeneration reproduces the committed bytes exactly", async () => {
  const regen = await run("node", [GENERATOR]);
  assertEquals(regen.code, 0, regen.stderr);
  const r = await verify();
  assertEquals(r.code, 0, "verify after a full regen must be clean (regen == committed bytes)");
  const regen2 = await run("node", [GENERATOR]);
  assertEquals(regen2.code, 0, regen2.stderr);
  assertEquals((await verify()).code, 0, "second regen must remain clean (idempotent)");
});

Deno.test("flag confinement: unknown build args fail; disabled targets still refuse", async () => {
  const bad = await run("node", ["build.mjs", "--target=store", "--bogus-flag"], BUILD_TIMEOUT_MS);
  assertNotEquals(bad.code, 0);
  assertStringIncludes(bad.stderr, "usage: node build.mjs [--target=developer|store] [--regen-tools]");
  // developer (debug) is ENABLED (observability workstream) — the enterprise
  // target remains disabled.
  const ent = await run("node", ["build.mjs", "--target=enterprise", "--regen-tools"], BUILD_TIMEOUT_MS);
  assertNotEquals(ent.code, 0);
  assertStringIncludes(ent.stderr, "target_enterprise_not_enabled");
});

Deno.test("build wiring: the DEFAULT build fails closed on generated drift (prove verify, not regen, is the default)", async () => {
  // If the default were regen, the flipped byte would be silently repaired and
  // the build would succeed; verify-only MUST fail fast and name the drift.
  const original = Deno.readFileSync(DRIFT_TARGET);
  try {
    const mutated = Uint8Array.from(original);
    mutated[0] = mutated[0] ^ 0x01;
    Deno.writeFileSync(DRIFT_TARGET, mutated);
    const r = await run("node", ["build.mjs"], BUILD_TIMEOUT_MS);
    assertNotEquals(r.code, 0, "default build must fail closed on generated drift");
    assertStringIncludes(r.stderr + r.stdout, "byte-drift: packages/bundled/sqlite3/PROVENANCE.json");
  } finally {
    Deno.writeFileSync(DRIFT_TARGET, original);
  }
  assertEquals((await verify()).code, 0);
});

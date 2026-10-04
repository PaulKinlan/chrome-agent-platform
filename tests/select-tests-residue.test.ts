// tests/select-tests-residue.test.ts — chrome-agent-platform-nz2r.
//
// The residue TRIGGER, end to end: plant a stale build stage dir (and a lock
// file) exactly where a killed build leaves them, run the REAL
// scripts/select-tests.mjs, and assert the residue changes nothing about which
// tests the per-change gate picks. A killed build never reaches build.mjs's
// finally cleanup, so this is the state a VM lane actually found.
//
// SERIAL phase: this writes under extension/ — the partition guard's
// build-artifact hazard class — and must not race the parallel phase's readers.
// The probe names carry this process's pid and are swept in a finally, so this
// test cannot poison the next run either (asserted at the end).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const STAGE = join(ROOT, "extension", `.dist-stage-${process.pid}-nz2r-probe`);
const LOCK = join(ROOT, `.build.lock.nz2r-probe-${process.pid}`);

async function selectList(): Promise<string> {
  const { stdout, stderr } = await new Deno.Command("node", {
    args: ["scripts/select-tests.mjs", "--list"],
    cwd: ROOT,
  }).output();
  return new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
}

Deno.test("nz2r: stale build residue cannot change what test:changed selects", async () => {
  const before = await selectList();
  try {
    await Deno.mkdir(STAGE, { recursive: true });
    await Deno.writeTextFile(join(STAGE, "chunk.js"), "// a killed build's staged chunk\n");
    await Deno.writeTextFile(LOCK, JSON.stringify({ pid: 70457, token: "stale" }));

    const withResidue = await selectList();
    // 1. The residue is not a candidate at all: neither the stage dir nor the
    // lock may appear in the selection (on main they appeared as
    // "changed file(s) with no reachable test" and forced FULL_SUITE).
    assert(
      !withResidue.includes(".dist-stage-"),
      `the stage residue leaked into the selection:\n${withResidue}`,
    );
    assert(
      !withResidue.includes(".build.lock.nz2r-probe"),
      `the lock residue leaked into the selection:\n${withResidue}`,
    );
    // 2. Nothing about the selection changed. Compared rather than asserted
    // "not FULL_SUITE" because a worktree with its OWN uncovered changes may
    // fail closed for those; what must never happen is residue ADDING a failure.
    assertEquals(withResidue, before, "build residue must not change what the gate selects");
  } finally {
    await Deno.remove(STAGE, { recursive: true }).catch(() => {});
    await Deno.remove(LOCK).catch(() => {});
  }
  // 3. This test sweeps its own residue: a gate test that poisoned the next run
  // would be the very bug it is pinning.
  assertEquals(existsSync(STAGE), false, "the probe stage dir must be gone");
  assertEquals(existsSync(LOCK), false, "the probe lock file must be gone");
});

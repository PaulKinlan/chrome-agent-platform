// tests/quiet-head.test.ts — gate-speed (2026-10-09): the phase that runs a load-sensitive MEASUREMENT
// file first, in a waited-for quiet window (scripts/lib/quiet-head.ts).
//
// The property under test is not "the spinner spins": it is that the phase (a) never measures a
// saturated box — it waits, and refuses with exit 75 if it cannot get one; (b) runs every file it owns
// exactly once, through the same runner as every other phase; and (c) is a no-op when the caller has
// already run it (npm run gate does, before its overlapped sibling build starts).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { awaitQuietWindow, ENVIRONMENTAL_REFUSAL_MARKER, type LoadSample } from "../scripts/lib/quiet-window.ts";
import { headSpec, main, QUIET_HEAD_DONE_ENV } from "../scripts/lib/quiet-head.ts";
import { QUIET_HEAD } from "../scripts/test-partition.mjs";

Deno.test("gate-speed: the quiet-head wait spec is bounded, and its bound is overridable", () => {
  assertEquals(headSpec({}), { maxWaitMs: 300_000, maxLoadPerCore: 0.5 });
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "1000" }).maxWaitMs, 1000);
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "0" }).maxWaitMs, 0, "0 means 'do not wait'");
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "-5" }).maxWaitMs, 300_000, "a negative bound is refused, not obeyed");
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "nonsense" }).maxWaitMs, 300_000);
});

Deno.test("gate-speed: an empty file list is a no-op (no wait, no browser)", async () => {
  assertEquals(await main([], {}), 0);
});

Deno.test("gate-speed: when the caller already ran the phase, it does not run again", async () => {
  assertEquals(await main(["tests/ntp-boot-staging.test.ts"], { [QUIET_HEAD_DONE_ENV]: "1" }), 0);
});

Deno.test("gate-speed: a box that never quiets REFUSES with exit 75 and the environmental marker (never a pass)", async () => {
  // The sampler is INJECTED (the same seam tests/quiet-window.test.ts uses): a refusal that depends on the
  // box being loaded is a test that passes or fails with the machine, and an earlier version of this test
  // was exactly that — it refused on a loaded box and returned 0 inside a quiet gate. The property is the
  // VERDICT WIRE: no quiet window => exit 75 + the marker + the ENVIRONMENT line, and no file is run.
  const heavy = {
    at: Date.now(), load1: 9, load5: 9, load15: 9, cores: 2, loadPerCore: 4.5,
    compilers: 0, compilerNames: [], activeCompilers: 0, activeCompilerNames: [], measurable: true, cpu: null,
  } as unknown as LoadSample;
  const lines: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    // A 1 ms bound: the injected sampler is permanently loaded, so the FIRST sample decides. Without
    // this the wait runs its full 5-minute default and the test itself takes minutes.
    const rc = await main(["tests/zz-file-that-must-not-run.test.ts"], { CAP_QUIET_HEAD_MAX_WAIT_MS: "1" }, {
      sample: async () => heavy,
      sleep: async () => {},
      now: () => Date.now(),
    });
    assertEquals(rc, 75, `a saturated box must refuse, not measure:\n${lines.join("\n")}`);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  const out = lines.join("\n");
  assert(out.includes(ENVIRONMENTAL_REFUSAL_MARKER), `the refusal must carry the marker:\n${out}`);
  assert(out.includes("ENVIRONMENT:"), `the refusal must carry the ENVIRONMENT line:\n${out}`);
  assert(out.includes("no quiet window"), out);
  assert(!out.includes("measuring now"), "a refused run must not go on to measure anything");
});

Deno.test("gate-speed: with a quiet window the phase runs its files, once (and reports the wait)", async () => {
  const quiet = {
    at: Date.now(), load1: 0.1, load5: 0.1, load15: 0.1, cores: 2, loadPerCore: 0.05,
    compilers: 0, compilerNames: [], activeCompilers: 0, activeCompilerNames: [], measurable: true, cpu: null,
  } as unknown as LoadSample;
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "quiet-head-ok-" });
  const probe = `${dir}/zz-quiet-head-ok.test.ts`;
  await Deno.writeTextFile(probe, `Deno.test("runs", () => {});\n`);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const rc = await main([probe], { CAP_QUIET_HEAD_MAX_WAIT_MS: "1" }, { sample: async () => quiet, sleep: async () => {} });
    assertEquals(rc, 0, `a quiet window runs the file:\n${lines.join("\n")}`);
  } finally {
    console.log = originalLog;
    await Deno.remove(dir, { recursive: true });
  }
  assert(lines.join("\n").includes("measuring now"), lines.join("\n"));
});

Deno.test("gate-speed: the phase's real file list is the partition's QUIET_HEAD set", () => {
  assert(QUIET_HEAD.size > 0);
  assert(QUIET_HEAD.has("tests/ntp-boot-staging.test.ts"));
});

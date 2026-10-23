// tests/gate-outcome-child-run.test.ts — the child-runner falsifier for chrome-agent-platform-w6kc0.
//
// WHY A CHILD RUN AND NOT A UNIT TEST (review P1-1, and the reason it was a FAIL). The first cut asserted
// the new behaviour by unit-testing the PURE planner. That leaves the WIRING in scripts/run-tests.mjs
// untested: changing the forced exit to plain `rc`, or passing `rc` instead of the forced value to the
// manifest, kept every test green while the runner went back to reporting a skipped run as a certification.
// This file executes the runner as a CHILD and asserts, from that ONE execution, both halves at once:
//   (1) the process exit is non-zero, and
//   (2) the emitted gate manifest says certifiable:false and names the gap.
// Reverting either half of the wiring reds this file.
//
// HOW IT STAYS CHEAP. CAP_RUN_TESTS_STOP_AFTER_SERIAL=1 makes the runner do the serial phase for real and
// then decline to run the parallel phase, reporting every parallel file as unrun. With
// CAP_SERIAL_TEST_TIMEOUT_MS=1 every serial file dies immediately, so a forced serial failure costs seconds
// instead of the ~7 minutes a full gate needed.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { certificationGaps, parallelPlan } from "../scripts/lib/parallel-plan.mjs";
import { fullTierManifestFields } from "../scripts/lib/gate-manifest.mjs";

const ROOT = new URL("../", import.meta.url).pathname;

function runChild(env: Record<string, string>) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", "deno.runner.jsonc", "scripts/run-tests.mjs"],
    cwd: ROOT,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      // The runner must be able to find the repo's cached deno modules and the built tree.
      DENO_DIR: Deno.env.get("DENO_DIR") ?? "",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = command.outputSync();
  const decoder = new TextDecoder();
  return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
}

function manifestFrom(stderr: string): Record<string, unknown> | null {
  const marker = "fast-gate: manifest: ";
  const line = stderr.split("\n").find((l) => l.startsWith(marker));
  if (!line) return null;
  return JSON.parse(line.slice(marker.length));
}

Deno.test("w6kc0: a forced serial failure makes the CHILD runner refuse certification, in one execution", () => {
  const { code, stderr } = runChild({
    CAP_SERIAL_TEST_TIMEOUT_MS: "1",
    CAP_RUN_TESTS_STOP_AFTER_SERIAL: "1",
  });

  // (1) the exit cannot be 0 when files did not run, even though every phase that ran returned 0.
  assert(code !== 0, `a skipped run must exit non-zero, got ${code}. stderr tail: ${stderr.slice(-1500)}`);

  // (2) the same execution's manifest cannot certify coverage.
  const manifest = manifestFrom(stderr);
  assert(manifest !== null, `the run must emit a gate manifest. stderr tail: ${stderr.slice(-1500)}`);
  assertEquals(manifest.certifiable, false, "the manifest must be certifiable:false");
  const incomplete = String(manifest.incomplete ?? "");
  assert(incomplete.includes("unrun"), `the manifest must name the unrun files, got ${JSON.stringify(incomplete)}`);
  assert(
    /\d+ file\(s\) unrun/.test(incomplete),
    `the manifest gap must carry the count, got ${JSON.stringify(incomplete)}`,
  );

  // And the human-readable outcome says so too, rather than only the machine record.
  assert(stderr.includes("INCOMPLETE"), "the run must print the INCOMPLETE marker");
  assert(stderr.includes("NOT CERTIFIABLE"), "the run must print NOT CERTIFIABLE");
});

Deno.test("w6kc0: SYNTHETIC phase-0 skip — all phases green, files unrun, still refused (reds if the wiring is reverted)", () => {
  // The state that matters and that a real serial failure cannot produce: every phase that ran exited 0, so
  // `rc` is 0, yet files did not run. Here the forced exit and the forced manifest certification are the ONLY
  // things standing between this tree and a green certificate, so reverting either wiring reds this test.
  const { code, stderr } = runChild({
    CAP_SERIAL_TEST_TIMEOUT_MS: "1",
    CAP_RUN_TESTS_SKIP_SERIAL: "1",
    CAP_RUN_TESTS_STOP_AFTER_SERIAL: "1",
  });
  assert(code !== 0, `rc would be 0 here, so the exit must be forced non-zero; got ${code}. ${stderr.slice(-1200)}`);
  const manifest = manifestFrom(stderr);
  assert(manifest !== null, `the synthetic run must emit a manifest. ${stderr.slice(-1200)}`);
  assertEquals(manifest!.certifiable, false, "rc 0 with unrun files must still be certifiable:false");
  assert(
    String(manifest!.incomplete ?? "").includes("unrun"),
    `the manifest must name the unrun files: ${JSON.stringify(manifest!.incomplete)}`,
  );
  assert(stderr.includes("NOT CERTIFIABLE"), "the run must print NOT CERTIFIABLE even with all phases green");
});

Deno.test("w6kc0: the positive control — a run with nothing skipped certifies, and has no gap", () => {
  // Instant and honest: the manifest layer is pure, so the "no false alarm" direction is asserted directly
  // instead of by running the whole suite inside a test (the merger's complete gate is the end-to-end
  // observation of this direction, and it is already required for every landing).
  const complete = fullTierManifestFields({
    serialFiles: ["tests/serial-a.test.ts"],
    parallelFiles: ["tests/parallel-a.test.ts", "tests/parallel-b.test.ts"],
    skippedFiles: [],
    failingFiles: [],
    rc: 0,
  }) as Record<string, unknown> | null;
  assert(complete !== null, "the default npm test form must produce a manifest");
  assertEquals(complete!.certifiable, true, "a run that skipped nothing must certify");
  assertEquals(complete!.incomplete, null, "a complete run carries no incomplete reason");
  assertEquals(certificationGaps({ skipped: 0 }), [], "no skip means no gap");

  // And the refusal is not unconditional: a clean plan certifies, while a declined parallel phase is named
  // as a skip (never mis-blamed on a serial failure).
  const cleanPlan = parallelPlan({ serialRc: 0, parallel: ["tests/a.test.ts"], alwaysOn: [] });
  assertEquals(certificationGaps(cleanPlan), [], "a green serial phase has no gap");
  const declined = certificationGaps({ skipped: 3 });
  assertEquals(declined.length, 1);
  assert(declined[0].includes("3 file(s) unrun"), declined[0]);
});

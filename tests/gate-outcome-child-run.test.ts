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
import { INCOMPLETE_EXIT, BOUND_KILL_EXIT_CODES } from "../scripts/lib/phase-outcome.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function runChild(env: Record<string, string>, cli: string[] = []) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", "deno.runner.jsonc", "scripts/run-tests.mjs", ...cli],
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
  const { code, stdout, stderr } = runChild({
    CAP_SERIAL_TEST_TIMEOUT_MS: "1",
    CAP_RUN_TESTS_STOP_AFTER_SERIAL: "1",
  });
  const out = `${stdout}\n${stderr}`;

  // (1) the exit cannot be 0 when files did not run, even though every phase that ran returned 0.
  assert(code !== 0, `a skipped run must exit non-zero, got ${code}. stderr tail: ${stderr.slice(-1500)}`);
  // 5xg1w: and it must not be the exit-1 shape of a completed FAIL either — the code itself is part of
  // the outcome vocabulary, so a content-addressed cache can never file this abort as a FAIL verdict.
  // This child's serial files die by the 1ms TIMEOUT seam, so the combined rc is a bound-kill code,
  // which outranks 76 by contract (124 already tells consumers "unknown, do not cache"); the exact
  // 1 → 76 mapping of the real incident is pinned by the unit table in tests/phase-outcome.test.ts and
  // by the all-phases-green synthetic child below.
  assert(
    code === INCOMPLETE_EXIT || BOUND_KILL_EXIT_CODES.has(code),
    `a run that skipped files must exit ${INCOMPLETE_EXIT} or keep a bound-kill code, got ${code}. stderr tail: ${stderr.slice(-1500)}`,
  );
  assert(code !== 1, `an incomplete run must never carry the exit-1 shape of a completed FAIL, got ${code}`);

  // (2) the same execution's manifest cannot certify coverage.
  const manifest = manifestFrom(stderr);
  assert(manifest !== null, `the run must emit a gate manifest. stderr tail: ${stderr.slice(-1500)}`);
  assertEquals(manifest.certifiable, false, "the manifest must be certifiable:false");
  // 5xg1w: the structured verdict and skip count, readable without inferring from empty executed_suites.
  assertEquals(manifest.outcome, "incomplete", "the manifest must state the outcome as a field");
  assert(Number(manifest.skipped) > 0, `the manifest must count the skipped files, got ${JSON.stringify(manifest.skipped)}`);
  const incomplete = String(manifest.incomplete ?? "");
  assert(incomplete.includes("unrun"), `the manifest must name the unrun files, got ${JSON.stringify(incomplete)}`);
  assert(
    /\d+ file\(s\) unrun/.test(incomplete),
    `the manifest gap must carry the count, got ${JSON.stringify(incomplete)}`,
  );

  // And the human-readable outcome says so too, rather than only the machine record.
  assert(stderr.includes("INCOMPLETE"), "the run must print the INCOMPLETE marker");
  assert(stderr.includes("NOT CERTIFIABLE"), "the run must print NOT CERTIFIABLE");

  // Review round 3: the CAUSE and the COUNT must be asserted against manifest.incomplete ITSELF. Searching all
  // of stderr for the cause was a false green - the planner's announcement already contains that phrase, so a
  // runner that attributed the gap to the WRONG CAUSE would still pass. The manifest field is the record a
  // consumer reads, so that is what must carry the attribution.
  assert(
    /parallel phase skipped after serial failure \(\d+ file\(s\) unrun\)/.test(incomplete),
    `manifest.incomplete must carry the cause AND the count in the manifest itself, got ${JSON.stringify(incomplete)}`,
  );
  assert(
    !incomplete.includes("serial phase skipped"),
    `a real serial failure must not be reported as a declined serial phase: ${JSON.stringify(incomplete)}`,
  );

  // Separately, the human-readable announcement still names the cause and the 0o0um contract: the
  // parallel phase is no longer skipped on a serial failure (this child declines it only through the
  // STOP_AFTER_SERIAL seam, which is exactly why the manifest must report the files as unrun).
  assert(
    stderr.includes("serial file(s) failed"),
    `the announcement must name the serial failure as the cause: ${stderr.slice(-1200)}`,
  );
  assert(
    stderr.includes("STILL RUNS in full"),
    `the announcement must state the 0o0um contract (parallel runs despite the serial red): ${stderr.slice(-1200)}`,
  );
  assert(
    /\d+ files total, \d+ skipped/.test(out),
    `the summary must count the unrun files: ${stderr.slice(-1200)}`,
  );
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
  assertEquals(code, INCOMPLETE_EXIT, `all phases green but files unrun is INCOMPLETE, not FAIL: got ${code}. ${stderr.slice(-1200)}`);
  const manifest = manifestFrom(stderr);
  assert(manifest !== null, `the synthetic run must emit a manifest. ${stderr.slice(-1200)}`);
  assertEquals(manifest!.certifiable, false, "rc 0 with unrun files must still be certifiable:false");
  assertEquals(manifest!.outcome, "incomplete", "the manifest must state the outcome as a field");
  assert(
    String(manifest!.incomplete ?? "").includes("unrun"),
    `the manifest must name the unrun files: ${JSON.stringify(manifest!.incomplete)}`,
  );
  assert(stderr.includes("NOT CERTIFIABLE"), "the run must print NOT CERTIFIABLE even with all phases green");
  // 5xg1w: the fleet-check wire contract. The per-tree cache greps the LAST 8000 bytes of the log for
  // "ABORTED: incomplete suite run" / "phase not entered, skipped=" to classify st=INCOMPLETE (re-gateable)
  // instead of filing a permanent FAIL — so the marker must exist AND follow the manifest JSON, which
  // with hundreds of omitted entries can dwarf the tail window.
  assert(stderr.includes("ABORTED: incomplete suite run"), `the cache-visible abort marker is missing: ${stderr.slice(-900)}`);
  assert(/phase not entered, skipped=\d+/.test(stderr), `the marker must carry the skipped count: ${stderr.slice(-900)}`);
  assert(
    stderr.lastIndexOf("ABORTED: incomplete suite run") > stderr.lastIndexOf("fast-gate: manifest:"),
    "the marker must be the LAST line: the manifest JSON can exceed the cache's 8000-byte tail window",
  );
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
  assertEquals(complete!.outcome, "passed", "5xg1w: a complete green states its outcome");
  assertEquals(complete!.skipped, 0, "5xg1w: a complete run skipped nothing, and says so with a count");
  assertEquals(certificationGaps({ skipped: 0 }), [], "no skip means no gap");

  // And the refusal is not unconditional: a clean plan certifies, while a declined parallel phase is named
  // as a skip (never mis-blamed on a serial failure).
  const cleanPlan = parallelPlan({ serialRc: 0, parallel: ["tests/a.test.ts"], alwaysOn: [] });
  assertEquals(certificationGaps(cleanPlan), [], "a green serial phase has no gap");
  const declined = certificationGaps({ skipped: 3 });
  assertEquals(declined.length, 1);
  assert(declined[0].includes("3 file(s) unrun"), declined[0]);
});

Deno.test("w6kc0: a serial-only selection cannot be skipped into a green (review P1-1)", () => {
  // The shape that bit: an explicit serial-only selection has ZERO parallel files, so a gap computed from
  // parallel files alone is empty and the run exits 0 having executed nothing.
  const { code, stdout, stderr } = runChild(
    { CAP_SERIAL_TEST_TIMEOUT_MS: "1", CAP_RUN_TESTS_SKIP_SERIAL: "1" },
    ["tests/build-smoke.test.ts"],
  );
  const out = `${stdout}\n${stderr}`;
  assert(code !== 0, `a serial-only selection that ran nothing must exit non-zero, got ${code}. ${stderr.slice(-900)}`);
  assertEquals(code, INCOMPLETE_EXIT, `skipped files exit ${INCOMPLETE_EXIT} even for an explicit-file selection: got ${code}`);
  assert(out.includes("ABORTED: incomplete suite run"), "the cache-visible abort marker must be present even without a manifest");
  assert(out.includes("INCOMPLETE"), "the run must say INCOMPLETE (summary line, stdout)");
  assert(
    /serial phase skipped \(\d+ file\(s\) unrun\)/.test(out),
    `the gap must count the SKIPPED SERIAL files, not just parallel ones: ${out.slice(-900)}`,
  );
  // And the seam must not print a green for a test it never ran.
  assert(!/GREEN|^ok\b/m.test(stdout), `nothing ran, so nothing may read as green: ${stdout.slice(-400)}`);
});

// chrome-agent-platform-0o0um/5xg1w, coord's falsifier: THE defect route itself — a serial file dies
// (here by the 1ms timeout seam; in the incident it was an 8s readyState budget and, on the next
// attempt, a driver OOM-killed with SIGKILL) and the parallel phase used to be skipped down to the
// 48-file guard set, destroying 94% of the evidence while the record read as a plain completed FAIL.
// This test REDS on the old behaviour (no "STILL RUNS", the file never executes, "are SKIPPED" is
// printed) and passes only when the parallel phase actually runs after the serial death.
Deno.test("0o0um: a serial failure STILL RUNS the parallel phase — a completed red, never an abort", () => {
  const { code, stdout, stderr } = runChild(
    { CAP_SERIAL_TEST_TIMEOUT_MS: "1" },
    ["tests/build-smoke.test.ts", "tests/phase-outcome.test.ts"],
  );
  const out = `${stdout}\n${stderr}`;

  // The parallel phase was ENTERED: its own status line names the phase and its file count.
  assert(
    /parallel phase \(1 files\)/.test(out),
    `the parallel phase must run despite the serial failure: ${out.slice(-1500)}`,
  );
  // And the selected parallel file really EXECUTED — its reporter lines are the evidence the old
  // guard-subset skip destroyed. ANSI-stripped first: Deno colours the verdict (`... \x1b[32mok`).
  const clean = out.replace(/\x1b\[[0-9;]*[mGKH]/g, "");
  assert(
    clean.includes("tests/phase-outcome.test.ts =>") && /\.\.\. (?:ok|FAILED)/.test(clean),
    `the selected parallel file must actually execute: ${clean.slice(-1500)}`,
  );
  // The announce states the new contract, and the old skip wording must never return on this route.
  assert(out.includes("serial file(s) failed"), `the serial failure must still be named: ${out.slice(-1200)}`);
  assert(out.includes("STILL RUNS in full"), `the announce must state the parallel phase runs: ${out.slice(-1200)}`);
  assert(!out.includes("are SKIPPED"), `a serial failure must not skip parallel files any more: ${out.slice(-1200)}`);

  // A genuine serial red STILL fails the gate — the failure semantics are not weakened. The timeout
  // seam kills the serial driver, so the completed rc is a bound-kill code; a real assertion red is 1.
  assert(code !== 0, `the serial red must still fail the run, got ${code}`);
  assert(
    code !== INCOMPLETE_EXIT,
    `nothing was skipped, so this is a COMPLETED verdict and must not carry the incomplete code: got ${code}`,
  );
  // Completed shape: no abort marker, no certification gap — a cache may file this red against the
  // tree, because every selected file ran and the log carries every result.
  assert(!out.includes("ABORTED: incomplete suite run"), `a completed run must not carry the abort marker: ${out.slice(-900)}`);
  assert(!out.includes("NOT CERTIFIABLE"), `nothing was skipped, so the run is complete evidence: ${out.slice(-900)}`);
});

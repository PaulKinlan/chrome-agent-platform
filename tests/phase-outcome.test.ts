// tests/phase-outcome.test.ts — chrome-agent-platform-jtrny.
//
// The defect: a full gate read as "the suite COMPLETED (764 files, wall 2681s) and then hung for 568s in
// a POST-TEST phase". Both halves were false. The parallel phase had been killed by its own 1800s bound
// with 108 of 742 files reporting, and the completion-shaped line was the PLANNER summary, which used to
// print for an incomplete run exactly as it does for a complete one. scripts/lib/phase-outcome.mjs is
// the vocabulary the runner lacked; these tests pin the honest shape and FAIL if it regresses into
// "every candidate is the culprit" or into a summary that reads as completion.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  CANDIDATE_LIST_LIMIT,
  candidateBlockLines,
  completedTestFiles,
  incompleteNote,
  killProgress,
  killProgressLine,
} from "../scripts/lib/phase-outcome.mjs";
import { formatGateManifest } from "../scripts/lib/gate-manifest.mjs";

/** A reporter line as Deno actually writes it, with the ANSI colour codes the log carries. */
const line = (file: string, test: string, verdict = "ok", dur = "12ms") =>
  `\x1b[0m\x1b[38;5;245m./${file} => \x1b[0m${test} ... \x1b[32m${verdict}\x1b[0m \x1b[38;5;245m(${dur})\x1b[0m`;

Deno.test("jtrny: completed results are recovered from real reporter lines, ANSI included", () => {
  const output = [
    line("tests/a.test.ts", "first thing"),
    line("tests/b.test.ts", "a step test ... nested step", "ok", "1ms"),
    line("tests/c.test.ts", "a failing test", "FAILED"),
    line("tests/d.test.ts", "an ignored test", "ignored"),
    "",
  ].join("\n");
  const done = completedTestFiles(output);
  assertEquals([...done].sort(), ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"]);
});

Deno.test("jtrny: an IN-PROGRESS line is not a completed result (that is exactly what a hung test looks like)", () => {
  // Deno prints the name when the test starts and appends the verdict+duration when it ends. Counting
  // the in-progress form would report "0 never started" for the one file the report exists to name.
  const inProgress = "\x1b[0m\x1b[38;5;245m./tests/hung.test.ts => \x1b[0msleeps forever ...";
  assertEquals([...completedTestFiles(inProgress)], []);
  assertEquals(killProgress(["tests/hung.test.ts"], inProgress), { completed: [], noResult: ["tests/hung.test.ts"] });
});

Deno.test("jtrny: the kill report names only the files with NO completed result", () => {
  const files = ["tests/heavy-1.test.ts", "tests/hung.test.ts", "tests/heavy-2.test.ts", "tests/light.test.ts"];
  const output = [line("tests/heavy-1.test.ts", "one"), line("tests/heavy-2.test.ts", "two"), line("tests/light.test.ts", "three")].join("\n");
  const progress = killProgress(files, output);
  assertEquals(progress.completed, ["tests/heavy-1.test.ts", "tests/heavy-2.test.ts", "tests/light.test.ts"]);
  assertEquals(progress.noResult, ["tests/hung.test.ts"], "a file that DID report must never be called a culprit");
});

Deno.test("jtrny: the progress line states the measured counts and never a cause", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"];
  const output = [line("tests/a.test.ts", "one")].join("\n");
  const text = killProgressLine({ phase: "parallel phase", files, output, elapsedSecs: 1800.4 });
  assertStringIncludes(text, "progress at the kill: 1 of 4 file(s) completed a test, 3 produced no completed result");
  assertStringIncludes(text, "(1800s elapsed)");
  for (const claim of ["hung", "starv", "contention", "slow"]) {
    assert(!text.toLowerCase().includes(claim), `the report states what it measured, not why: ${text}`);
  }
});

Deno.test("jtrny: the candidate block discloses a truncated list with the exact remainder", () => {
  const candidates = Array.from({ length: CANDIDATE_LIST_LIMIT + 8 }, (_, i) => `tests/f${i}.test.ts`);
  const lines = candidateBlockLines({ phase: "parallel phase", candidates, total: 742 });
  assertEquals(lines.length, 2 + CANDIDATE_LIST_LIMIT);
  assertStringIncludes(lines[0], `culprit unconfirmed; ${CANDIDATE_LIST_LIMIT + 8} of 742 produced no completed result`);
  assertStringIncludes(lines[1], "tests/f0.test.ts");
  assertStringIncludes(lines.at(-1)!, "… and 8 more file(s) with no completed result");
});

Deno.test("jtrny: an intact run's summary is unchanged, and a killed run's cannot read as completion", () => {
  assertEquals(incompleteNote([]), "", "a run that killed nothing must keep its exact previous summary");
  const summary = "run-tests: 764 files total, 0 skipped (17 serial, 5 post-build read-only, 742 other parallel), wall 2681s";
  const killed = summary + incompleteNote(["parallel phase killed at its 1800s bound (108/742 files had completed a test)"]);
  assertStringIncludes(killed, "INCOMPLETE: parallel phase killed at its 1800s bound (108/742 files had completed a test)");
  // The old line, alone, is what two agents read as "the suite finished": the note is what stops it.
  assert(!summary.includes("INCOMPLETE"), "control: the pre-fix line carried no such signal");
});

Deno.test("jtrny: the gate ledger carries the reason a run is not a completion", () => {
  const reason = "parallel phase killed at its 1800s bound (108/742 files had completed a test)";
  const text = formatGateManifest({
    tier: "full",
    executed: 0,
    selected: ["tests/a.test.ts"],
    certifiable: false,
    incomplete: reason,
  });
  const payload = JSON.parse(text.slice(text.indexOf("{")));
  assertEquals(payload.incomplete, reason);
  assertEquals(payload.certifiable, false, "an incomplete run never certifies coverage");
  // Absent, not empty: a complete run's manifest must not gain a field that reads as a kill.
  const complete = JSON.parse(formatGateManifest({ tier: "full", executed: 1, executedSuites: ["tests/a.test.ts"], selected: ["tests/a.test.ts"] }).slice(
    formatGateManifest({ tier: "full", executed: 1, executedSuites: ["tests/a.test.ts"], selected: ["tests/a.test.ts"] }).indexOf("{"),
  ));
  assert(!("incomplete" in complete), "a complete run must not carry an incomplete field");
});

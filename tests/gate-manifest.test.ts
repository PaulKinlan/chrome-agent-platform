// @ts-nocheck
// tests/gate-manifest.test.ts — the gate coverage-ledger producer must be TRUTHFUL, and the wire
// contract is the fleet consumer's (~/fleet/remote/check-coverage.py), not ours.
//
// chrome-agent-platform-0eq00. The failure this file exists to catch: a green gate record whose
// ledger says `executed: N` while naming no suite, or whose ledger is absent entirely — the
// "unreadable green" that made 146 cached PASS records undecidable and blocks the strict consumer
// (coord, 2026-10-14: producer-first sequencing).
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  LOCKFILE_DELTA_PREFIX,
  BUILD_GATE_DEFERRAL_SUFFIX,
  GATE_MANIFEST_PREFIX,
  GATE_UNKNOWN_PREFIX,
  GATE_UNMAPPED_PREFIX,
  HEAVY_GATE_DEFERRAL_SUFFIX,
  deferredTierEntries,
  emitGateLedger,
  formatGateManifest,
  formatGateUnmapped,
  formatGateUnknown,
  fullTierManifestFields,
  normalizeSuiteList,
  parseGateBuild,
} from "../scripts/lib/gate-manifest.mjs";
import {
  BUILD_GATE_FILES,
  BUILD_GATE_REASONS,
  HEAVY_GATE_FILES,
  HEAVY_GATE_REASONS,
} from "../scripts/test-partition.mjs";

// The extractor's own recognizer: `re.match(r"^fast-gate:\s*manifest:\s*(\{.*\})$", line)`.
const EXTRACTOR_MANIFEST_RE = /^fast-gate:\s*manifest:\s*(\{.*\})$/;

function parse(line) {
  const m = EXTRACTOR_MANIFEST_RE.exec(line);
  assert(m, `the fleet extractor would not recognize: ${line}`);
  return JSON.parse(m[1]);
}

Deno.test("0eq00 ledger: a manifest line is exactly what the fleet extractor matches", () => {
  const line = formatGateManifest({
    tier: "fast",
    executed: 2,
    executedSuites: ["tests/b.test.ts", "tests/a.test.ts"],
    selected: ["tests/a.test.ts", "tests/b.test.ts"],
    certifiable: true,
  });
  assert(line.startsWith(GATE_MANIFEST_PREFIX), "the line must carry the extractor's prefix");
  const payload = parse(line);
  assertEquals(payload.tier, "fast");
  assertEquals(payload.executed, 2);
  // Sorted + de-duplicated: the consumer compares paths verbatim.
  assertEquals(payload.executed_suites, ["tests/a.test.ts", "tests/b.test.ts"]);
  assertEquals(payload.certifiable, true);
  assertEquals(normalizeSuiteList(["b", "a", "b"]), ["a", "b"]);
});

Deno.test("lezl0 ledger: lockfile-delta lines are emitted first, prefixed, and are never required", () => {
  // chrome-agent-platform-lezl0: the Class-1 certification trail. Two properties matter to the fleet
  // consumer: the lines carry ONE prefix (so they are greppable), and they can never displace the
  // manifest line, because the extractor takes the LAST manifest line in a log.
  const manifest = {
    tier: "fast",
    executed: 1,
    executedSuites: ["tests/a.test.ts"],
    selected: ["tests/a.test.ts"],
    certifiable: true,
  };
  const written: string[] = [];
  const lines = emitGateLedger({
    manifest,
    lockfileDelta: [
      `${LOCKFILE_DELTA_PREFIX}zod -> importers: extension/lib/agent.js -> suites: tests/a.test.ts`,
      "plain text without the prefix is still written with it",
      "  ",
      "",
    ],
    log: (line: string) => written.push(line),
  });
  assertEquals(lines[0], `${LOCKFILE_DELTA_PREFIX}zod -> importers: extension/lib/agent.js -> suites: tests/a.test.ts`);
  assertEquals(lines[1], `${LOCKFILE_DELTA_PREFIX}plain text without the prefix is still written with it`);
  assertEquals(lines.filter((line: string) => line.trim() === ""), [], "blank entries are never written");
  const manifestLine = lines.at(-1);
  assert(manifestLine.startsWith(GATE_MANIFEST_PREFIX), "the manifest line stays last");
  assertEquals(parse(manifestLine).executed_suites, ["tests/a.test.ts"]);

  // A run with no lockfile delta writes exactly the old lines: the new field is additive.
  const plain: string[] = [];
  emitGateLedger({ manifest, log: (line: string) => plain.push(line) });
  assertEquals(plain.length, 1);
  assert(!plain.some((line: string) => line.startsWith(LOCKFILE_DELTA_PREFIX)));
});

Deno.test("0eq00 ledger: executed>0 with no suites is REFUSED, never written as unreadable green", () => {
  // The falsifier from the architect design: `suites:[]` next to a positive executed count reads as
  // "N suites ran, none of them named".
  assertThrows(
    () => formatGateManifest({ tier: "fast", executed: 3, executedSuites: [] }),
    Error,
    "unreadable green",
  );
  // More suites than the count is the same lie from the other side.
  assertThrows(
    () => formatGateManifest({ tier: "fast", executed: 1, executedSuites: ["a", "b"] }),
    Error,
    "exceeds executed",
  );
  // A failed run reports executed: 0 explicitly rather than dropping the field.
  const failed = parse(formatGateManifest({ tier: "fast", executed: 0, certifiable: false }));
  assertEquals(failed.executed, 0);
  assertEquals(failed.executed_suites, []);
  assertEquals(failed.certifiable, false);
});

Deno.test("0eq00 ledger: tier and count are validated, so a malformed record cannot pass", () => {
  assertThrows(() => formatGateManifest({ tier: "quick", executed: 1, executedSuites: ["a"] }), Error, "tier");
  assertThrows(() => formatGateManifest({ tier: "full", executed: 1.5, executedSuites: ["a"] }), Error, "non-negative integer");
  assertThrows(() => formatGateManifest({ tier: "full", executed: -1 }), Error, "non-negative integer");
});

Deno.test("0eq00 ledger: the build disposition rides in the manifest (validate-or-build evidence)", () => {
  const payload = parse(
    formatGateManifest({
      tier: "fast",
      executed: 1,
      executedSuites: ["tests/a.test.ts"],
      build: { disposition: "reused", reason: "dist.complete validates", secs: 2.4, markerCommit: "abc123" },
    }),
  );
  assertEquals(payload.build.disposition, "reused");
  assertEquals(payload.build.secs, 2); // rounded
  assertEquals(payload.build.marker_commit, "abc123");
  // No build information is ever invented: an omitted disposition is simply absent.
  const noBuild = parse(formatGateManifest({ tier: "fast", executed: 0 }));
  assertEquals(noBuild.build, undefined);
});

Deno.test("0eq00 ledger: the full tier names what the command does NOT run", () => {
  const payload = parse(
    formatGateManifest({
      tier: "full",
      executed: 1,
      executedSuites: ["tests/a.test.ts"],
      omitted: [
        { file: "tests/zz.test.ts", reason: "heavy" },
        { file: "tests/aa.test.ts", reason: "build-behaviour" },
      ],
    }),
  );
  assertEquals(payload.omitted.map((o) => o.file), ["tests/aa.test.ts", "tests/zz.test.ts"]);
  assertEquals(payload.omitted[0].reason, "build-behaviour");
});

Deno.test("6gk81 ledger: measured suite durations ride in the manifest, sanitized", () => {
  const payload = parse(
    formatGateManifest({
      tier: "full",
      executed: 1,
      executedSuites: ["tests/a.test.ts"],
      suiteDurations: new Map([
        ["tests/z.test.ts", 1.26],
        ["tests/a.test.ts", 95],
        ["tests/nan.test.ts", Number.NaN],
      ]),
    }),
  );
  assertEquals(payload.suite_durations, { "tests/a.test.ts": 95, "tests/z.test.ts": 1.3 });
  // No measurements, no field: an empty map invents nothing.
  const none = parse(formatGateManifest({ tier: "full", executed: 0, suiteDurations: new Map() }));
  assertEquals(none.suite_durations, undefined);
});

Deno.test("0eq00 ledger: unmapped and unknown markers use the extractor's exact prefixes", () => {
  assertEquals(formatGateUnmapped([]), null, "an empty unmapped list emits no line");
  assertEquals(formatGateUnmapped(["b.ts", "a.ts"]), `${GATE_UNMAPPED_PREFIX}a.ts b.ts`);
  assertEquals(formatGateUnknown("nothing ran"), `${GATE_UNKNOWN_PREFIX}nothing ran`);
  assertThrows(() => formatGateUnknown("   "), Error, "needs a reason");

  const written = [];
  const lines = emitGateLedger({
    manifest: { tier: "fast", executed: 0, certifiable: false },
    unmapped: ["scripts/x.mjs"],
    unknown: "no test file was selected",
    log: (line) => written.push(line),
  });
  assertEquals(lines.length, 3);
  assertEquals(written, lines);
  assert(parse(lines[0]));
  assertEquals(lines[1], `${GATE_UNMAPPED_PREFIX}scripts/x.mjs`);
  assertEquals(lines[2], `${GATE_UNKNOWN_PREFIX}no test file was selected`);
});

Deno.test("0eq00 ledger: the full tier is computed from what the runner did (and discloses deferrals)", () => {
  const passing = fullTierManifestFields({
    serialFiles: ["tests/serial-a.test.ts"],
    parallelFiles: ["tests/p1.test.ts", "tests/p2.test.ts"],
    skippedFiles: [],
    deferred: [
      { file: "tests/build-bootstrap.test.ts", reason: "runs the generator in-place — also runs in this FULL command's npm run test:build stage" },
      { file: "tests/python-runtime.test.ts", reason: "loads Pyodide — NOT part of the FULL gate command; runs only under the separate npm run test:heavy tier" },
    ],
    rc: 0,
    build: { disposition: "ran", reason: "rebuilt", secs: 95 },
  });
  assertEquals(passing.tier, "full");
  assertEquals(passing.executed, 3);
  assertEquals(
    passing.executedSuites,
    ["tests/serial-a.test.ts", "tests/p1.test.ts", "tests/p2.test.ts"],
  );
  assertEquals(passing.certifiable, true);
  assertEquals(passing.omitted.length, 2, "deferred tiers plus skipped files are disclosed");
  assertEquals(passing.build.disposition, "ran");
  assert(parse(formatGateManifest(passing)), "the full fields must format into a valid manifest");

  // A failed full run names NOTHING it cannot certify.
  const failing = fullTierManifestFields({ serialFiles: ["tests/serial-a.test.ts"], parallelFiles: [], rc: 1 });
  assertEquals(failing.executed, 0);
  assertEquals(failing.executedSuites, []);
  assertEquals(failing.certifiable, false);

  // A serial failure runs the always-on guards only; the rest are named as skipped, not hidden.
  const degraded = fullTierManifestFields({
    serialFiles: ["tests/serial-a.test.ts"],
    parallelFiles: ["tests/guard.test.ts"],
    skippedFiles: ["tests/other.test.ts"],
    rc: 0,
  });
  assertEquals(degraded.executed, 2);
  assertEquals(degraded.omitted, [
    { file: "tests/other.test.ts", reason: "skipped in this run: the serial phase failed" },
  ]);

  // xj6sb: when failing serial files are known, the omission reason names them by name
  const degradedNamed = fullTierManifestFields({
    serialFiles: ["tests/serial-a.test.ts"],
    parallelFiles: ["tests/guard.test.ts"],
    skippedFiles: ["tests/other.test.ts"],
    failingFiles: ["tests/serial-a.test.ts"],
    rc: 1,
  });
  assertEquals(degradedNamed.omitted, [
    { file: "tests/other.test.ts", reason: "skipped in this run: serial file(s) failed [tests/serial-a.test.ts]" },
  ]);

  // xj6sb: an environmental refusal in serial phase runs the full parallel suite without skipped files
  const refused = fullTierManifestFields({
    serialFiles: ["tests/serial-refusal.test.ts"],
    parallelFiles: ["tests/p1.test.ts", "tests/p2.test.ts"],
    skippedFiles: [],
    rc: 75,
  });
  assertEquals(refused.omitted, []);
  assertEquals(refused.selected, ["tests/serial-refusal.test.ts", "tests/p1.test.ts", "tests/p2.test.ts"]);

  // An explicit-file run is an inner-loop tool, not a gate: no record is invented.

  assertEquals(fullTierManifestFields({ rc: 0, cliFiles: ["tests/x.test.ts"] }), null);
});

Deno.test("0eq00 ledger (P1-B): heavy files are NOT described as part of the FULL command", () => {
  // The FULL gate command is `build:production && npm test && test:build` — it has NO test:heavy stage.
  // One shared reason for build-gate and heavy files was a false statement about the heavy ones.
  const entries = deferredTierEntries({
    buildGateFiles: BUILD_GATE_FILES,
    buildGateReasons: BUILD_GATE_REASONS,
    heavyGateFiles: HEAVY_GATE_FILES,
    heavyGateReasons: HEAVY_GATE_REASONS,
  });
  const byFile = new Map(entries.map((e) => [e.file, e.reason]));
  assertEquals(entries.length, BUILD_GATE_FILES.length + HEAVY_GATE_FILES.length);
  // The two wordings must stay DISTINCT and each must name its own tier (a shared sentence is the
  // exact defect the review found; one text cannot be true for both).
  assert(BUILD_GATE_DEFERRAL_SUFFIX.includes("test:build"), BUILD_GATE_DEFERRAL_SUFFIX);
  assert(HEAVY_GATE_DEFERRAL_SUFFIX.includes("test:heavy"), HEAVY_GATE_DEFERRAL_SUFFIX);
  assert(HEAVY_GATE_DEFERRAL_SUFFIX.includes("NOT part of the FULL gate command"), HEAVY_GATE_DEFERRAL_SUFFIX);
  assert(!HEAVY_GATE_DEFERRAL_SUFFIX.includes("test:build"), "the heavy tier is not the build-behaviour tier");
  assert(BUILD_GATE_DEFERRAL_SUFFIX !== HEAVY_GATE_DEFERRAL_SUFFIX);
  for (const file of BUILD_GATE_FILES) {
    const reason = byFile.get(file);
    assert(reason.includes(BUILD_GATE_DEFERRAL_SUFFIX), `${file} runs in the FULL command's test:build stage: ${reason}`);
  }
  for (const file of HEAVY_GATE_FILES) {
    const reason = byFile.get(file);
    assert(reason.includes(HEAVY_GATE_DEFERRAL_SUFFIX), `${file} must not be described as part of the FULL command: ${reason}`);
    assert(
      !reason.includes(BUILD_GATE_DEFERRAL_SUFFIX),
      `${file} must not claim the build-behaviour stage: ${reason}`,
    );
  }
  // Every entry carries a reason, so the manifest guard cannot reject a real FULL record.
  const full = fullTierManifestFields({ serialFiles: ["tests/a.test.ts"], rc: 0, deferred: entries });
  assert(parse(formatGateManifest(full)), "the manifest with real deferrals must be valid");
});

Deno.test("0eq00 ledger (P1-A): an omission with no reason is refused, and truncation is disclosed", () => {
  // The executed+omitted-with-reasons contract: "omitted, cause unknown" is a silent skip.
  assertThrows(
    () => formatGateManifest({ tier: "fast", executed: 1, executedSuites: ["tests/a.test.ts"], omitted: [{ file: "tests/b.test.ts", reason: "  " }] }),
    Error,
    "has no reason",
  );
  // A bound may clip names but must never erase the disclosure itself.
  assertThrows(
    () => formatGateManifest({ tier: "fast", executed: 1, executedSuites: ["tests/a.test.ts"], omittedTotal: 9, omittedTruncated: 9 }),
    Error,
    "silent skip",
  );
  const clipped = parse(
    formatGateManifest({
      tier: "fast",
      executed: 1,
      executedSuites: ["tests/a.test.ts"],
      omitted: [{ file: "tests/b.test.ts", reason: "unselected: no import path from the changed set" }],
      omittedTotal: 13,
      omittedTruncated: 12,
    }),
  );
  assertEquals(clipped.omitted, [{ file: "tests/b.test.ts", reason: "unselected: no import path from the changed set" }]);
  assertEquals(clipped.omitted_total, 13, "the total survives any clipping");
  assertEquals(clipped.omitted_truncated, 12, "a clipped list must say how many entries it dropped");
  const complete = parse(
    formatGateManifest({ tier: "fast", executed: 1, executedSuites: ["tests/a.test.ts"], omitted: [] }),
  );
  assertEquals(complete.omitted_truncated, undefined);
  assertEquals(complete.omitted_total, undefined);
});

Deno.test("0eq00 ledger: a parent tier's build disposition crosses the process boundary safely", () => {
  assertEquals(parseGateBuild(undefined), null);
  assertEquals(parseGateBuild("not json"), null, "a malformed carry-over is null, never a guess");
  assertEquals(parseGateBuild('{"reason":"x"}'), null, "a disposition is required");
  const parsed = parseGateBuild('{"disposition":"ran","reason":"rebuilt","secs":95,"markerCommit":"deadbeef"}');
  assertEquals(parsed.disposition, "ran");
  assertEquals(parsed.secs, 95);
  assertEquals(parsed.markerCommit, "deadbeef");
});

// chrome-agent-platform-5xg1w: the manifest states the run's OUTCOME as a field, so a consumer never
// infers "phase not entered" from executed_suites being empty, and a completed FAIL can never be
// confused with a serial-phase abort.
Deno.test("5xg1w: the full-tier manifest carries a structured outcome and skipped count", () => {
  // The defect case, as the merger observed it: serial failed, 711 of 759 parallel files never ran.
  const aborted = fullTierManifestFields({
    serialFiles: ["tests/serial-a.test.ts"],
    parallelFiles: ["tests/guard.test.ts"],
    skippedFiles: ["tests/p1.test.ts", "tests/p2.test.ts"],
    failingFiles: ["tests/serial-a.test.ts"],
    rc: 76,
    incomplete: "parallel phase skipped after serial failure (2 file(s) unrun)",
  });
  assertEquals(aborted.outcome, "incomplete");
  assertEquals(aborted.skipped, 2);
  assertEquals(aborted.certifiable, false);
  const abortedPayload = parse(formatGateManifest(aborted));
  assertEquals(abortedPayload.outcome, "incomplete", "the wire record a fleet consumer parses");
  assertEquals(abortedPayload.skipped, 2);

  // A completed FAIL: every selected file ran, one went red. Distinguishable at a glance — and its
  // shape is unchanged apart from the two new fields.
  const failed = fullTierManifestFields({
    serialFiles: ["tests/serial-a.test.ts"],
    parallelFiles: ["tests/p1.test.ts"],
    skippedFiles: [],
    rc: 1,
  });
  assertEquals(failed.outcome, "failed");
  assertEquals(failed.skipped, 0);
  assertEquals(failed.certifiable, false);

  // A completed green, and an environmental refusal: their own labels, never "incomplete".
  assertEquals(fullTierManifestFields({ serialFiles: [], parallelFiles: ["tests/p1.test.ts"], rc: 0 }).outcome, "passed");
  assertEquals(fullTierManifestFields({ serialFiles: [], parallelFiles: ["tests/p1.test.ts"], rc: 75 }).outcome, "refused");

  // A killed phase with no skipped file is still not a completion. `skipped` is NARROW by contract
  // (5xg1w review, blocker 2): it counts files with no certified result from a DECLINED or LOST
  // lane/phase — NOT files lost inside a phase killed mid-flight. Those live in the `incomplete`
  // reason with the kill's own progress, so skipped:0 beside outcome:"incomplete" can never be read
  // as complete coverage: the incomplete reason names what the killed phase did not finish.
  const killed = fullTierManifestFields({
    serialFiles: [],
    parallelFiles: ["tests/p1.test.ts"],
    rc: 124,
    incomplete: "parallel phase killed at its 1800s bound (108/742 files had completed a test)",
  });
  assertEquals(killed.outcome, "incomplete");
  assertEquals(killed.skipped, 0, "nothing was DECLINED; the mid-flight loss is named in incomplete, not counted here");
  const killedPayload = parse(formatGateManifest(killed));
  assert(
    killedPayload.incomplete.includes("108/742 files had completed a test"),
    `the killed phase's own progress must survive into the wire record: ${JSON.stringify(killedPayload.incomplete)}`,
  );

  // Defensive: skipped files with no reason string must still never format as a completion.
  const silentSkip = fullTierManifestFields({
    serialFiles: [],
    parallelFiles: ["tests/guard.test.ts"],
    skippedFiles: ["tests/p1.test.ts"],
    rc: 0,
  });
  assertEquals(silentSkip.outcome, "incomplete", "a skip is incomplete whatever the phases returned");
  assert(String(silentSkip.incomplete).includes("1 skipped"), silentSkip.incomplete);

  // 5xg1w review, blocker 1 + round 2: files LOST with a lane/phase that produced no result — an
  // unreported serial-lane child, or a parallel child that never spawned — are counted in skipped
  // and disclosed with their OWN reason. They did not fail, and they were not deliberately skipped;
  // a never-spawned phase reporting skipped:0 is the same false-coverage shape as the kill case.
  const unreported = fullTierManifestFields({
    serialFiles: ["tests/serial-a.test.ts"],
    parallelFiles: ["tests/p1.test.ts"],
    lostFiles: [
      { file: "tests/chrome-launch-lock.test.ts", reason: "serial lane child never reported a result — file never ran to a certified verdict in this run" },
      { file: "tests/p1.test.ts", reason: "parallel phase child never spawned — file never ran in this run" },
    ],
    rc: 76,
    incomplete: "serial lane child never reported a result (1 file(s) unrun): tests/chrome-launch-lock.test.ts; parallel phase child never spawned (1 file(s) unrun)",
  });
  assertEquals(unreported.skipped, 2, "every lost file counts as a file with no certified result");
  assertEquals(unreported.outcome, "incomplete");
  const unreportedEntry = unreported.omitted.find((o) => o.file === "tests/chrome-launch-lock.test.ts");
  assert(unreportedEntry, "the unreported file must be disclosed in omitted");
  assert(
    unreportedEntry.reason.includes("never reported a result"),
    `it must carry the unreported reason, not the skip-after-failure wording: ${unreportedEntry.reason}`,
  );
  const neverSpawnedEntry = unreported.omitted.filter((o) => o.file === "tests/p1.test.ts").at(-1);
  assert(
    neverSpawnedEntry.reason.includes("never spawned"),
    `a never-spawned phase's file must carry its own reason: ${neverSpawnedEntry.reason}`,
  );
  assert(parse(formatGateManifest(unreported)), "the lost-file fields must format into a valid manifest");
});

Deno.test("5xg1w: formatGateManifest validates the outcome vocabulary", () => {
  const base = { tier: "full", executed: 0, selected: ["tests/a.test.ts"], certifiable: false };
  assertThrows(
    () => formatGateManifest({ ...base, outcome: "mostly-fine" }),
    Error,
    "outcome must be one of",
    "an invented verdict is exactly the ambiguity the field exists to remove",
  );
  assertThrows(
    () => formatGateManifest({ ...base, outcome: "incomplete" }),
    Error,
    "without an incomplete reason",
    "outcome:incomplete must carry the reason so the consumer never infers what did not run",
  );
  assertThrows(
    () => formatGateManifest({ ...base, outcome: "passed", skipped: -1 }),
    Error,
    "non-negative integer",
  );
  // Absent, not defaulted: a producer that does not compute the verdict emits no field at all.
  const legacy = parse(formatGateManifest({ ...base, incomplete: "x unrun" }));
  assert(!("outcome" in legacy), "outcome is opt-in for producers that do not compute it");
  assert(!("skipped" in legacy), "skipped is opt-in for producers that do not compute it");
});

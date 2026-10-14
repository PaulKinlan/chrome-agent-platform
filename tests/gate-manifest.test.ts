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
  GATE_MANIFEST_PREFIX,
  GATE_UNKNOWN_PREFIX,
  GATE_UNMAPPED_PREFIX,
  emitGateLedger,
  formatGateManifest,
  formatGateUnmapped,
  formatGateUnknown,
  fullTierManifestFields,
  normalizeSuiteList,
  parseGateBuild,
} from "../scripts/lib/gate-manifest.mjs";

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
    deferredFiles: ["tests/build-bootstrap.test.ts", "tests/python-runtime.test.ts"],
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

  // An explicit-file run is an inner-loop tool, not a gate: no record is invented.
  assertEquals(fullTierManifestFields({ rc: 0, cliFiles: ["tests/x.test.ts"] }), null);
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

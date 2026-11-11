// tests/heavy-tier-ledger.test.ts — chrome-agent-platform-1lvay.
//
// The bead: heavy suites are deferred from the full gate, so a red in the heavy tier is invisible to
// every landing. The measurement that decided the fix (2026-11-11, this VM): "the heavy tier" is three
// populations with a ~120x cost spread — 18 suites cost 19s together, the two mega-suites cost 2310s
// (recorded), the wall-clock suite needs a quiet window. So the fix is not one policy:
//   (a) the 18 cheap ones run in EVERY landing's gate (staleness 0 landings),
//   (d) the receipt states which tiers ran, in words that read like the gap rather than a note,
//   (c) the mega pair is swept on a schedule that AUTO-FILES a P1 on red (bound <= 24h).
// These tests pin the three halves that are pure, because a live gate cannot exercise them in CI.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DEFERRED_HEAVY_FILES,
  HEAVY_GATE_FILES,
  MEGA_HEAVY_FILES,
  PER_LANDING_HEAVY_FILES,
  WALL_CLOCK_HEAVY_FILES,
} from "../scripts/test-partition.mjs";
import {
  deferredTierEntries,
  fullTierManifestFields,
  heavyTierStatus,
} from "../scripts/lib/gate-manifest.mjs";

Deno.test("1lvay: the heavy tier splits into per-landing and deferred, with nothing lost or double-counted", () => {
  assertEquals(PER_LANDING_HEAVY_FILES.length, 18, "18 suites measured at 19s together — the cheap population");
  assertEquals(DEFERRED_HEAVY_FILES.length, 3, "2 mega + 1 wall-clock are the only ones still out of a landing");
  // The split must be a partition: every heavy file in exactly one half. A file that fell out of both
  // would be invisible again, which is the defect this bead exists to close.
  const union = [...PER_LANDING_HEAVY_FILES, ...DEFERRED_HEAVY_FILES].sort();
  assertEquals(union, [...HEAVY_GATE_FILES].sort(), "every HEAVY_GATE file is in exactly one half");
  assertEquals(
    PER_LANDING_HEAVY_FILES.filter((f) => DEFERRED_HEAVY_FILES.includes(f)),
    [],
    "no file may be both per-landing and deferred",
  );
  for (const f of MEGA_HEAVY_FILES) {
    assertEquals(PER_LANDING_HEAVY_FILES.includes(f), false, `${f} costs 1416s/894s — it cannot be per-landing`);
    assertEquals(DEFERRED_HEAVY_FILES.includes(f), true);
  }
  assertEquals(DEFERRED_HEAVY_FILES.includes(WALL_CLOCK_HEAVY_FILES[0]), true);
});

Deno.test("1lvay (d): a receipt says 'NOT RUN at this sha', never 'deferred'", () => {
  const status = heavyTierStatus({
    heavyParallelFiles: [...PER_LANDING_HEAVY_FILES],
    megaRecord: { sha: "abcdef1234567890", result: "pass", at: Date.now() - 2 * 3_600_000 },
    sha: "0123456789abcdef",
  });
  assertStringIncludes(status.lines[0], "heavy-parallel: ran 18 suite(s) at this tree");
  // coord's ruling: "deferred" reads like a scheduling note; "NOT RUN at this sha" reads like the gap.
  assertStringIncludes(status.lines[1], "heavy-mega: NOT RUN at this sha");
  assert(
    !status.lines.some((line: string) => /deferred/i.test(line)),
    "the receipt must not describe a tier it did not run as merely deferred",
  );
  // Staleness is stated with both facts a reader needs: WHICH tree was green, and HOW stale that is.
  assertStringIncludes(status.lines[1], "last green abcdef123");
  assertStringIncludes(status.lines[1], "2h ago");
  assertEquals(status.heavy_mega.ran, false);
  assertEquals(status.heavy_mega.age_h, 2);
});

Deno.test("1lvay (d): a FAILED mega sweep is reported as a failed run, not as silence or as a pass", () => {
  const failed = heavyTierStatus({
    heavyParallelFiles: [],
    megaRecord: { sha: "deadbeefcafe0000", result: "fail", at: Date.now() - 30 * 3_600_000 },
    sha: "0123456789abcdef",
  });
  assertStringIncludes(failed.lines[1], "last run deadbeefc FAI");
  assertStringIncludes(failed.lines[1], "30h ago");
  assertEquals(failed.heavy_mega.ran, false);
  // Never run at all is its OWN fact: claiming a green would be exactly the "certified green while
  // nothing ran" failure the bead describes.
  const never = heavyTierStatus({ heavyParallelFiles: [], megaRecord: null, sha: "0123456789abcdef" });
  assertStringIncludes(never.lines[1], "never run");
  assertEquals(never.heavy_mega.last_sha, null);
});

Deno.test("1lvay (d): a mega sweep AT this tree is credited, so the receipt cannot lie in the other direction", () => {
  const same = heavyTierStatus({
    heavyParallelFiles: [],
    megaRecord: { sha: "0123456789abcdef", result: "pass", at: Date.now() - 3_600_000 },
    sha: "0123456789abcdef",
  });
  assertStringIncludes(same.lines[1], "heavy-mega: ran at this sha (PASS");
  assertEquals(same.heavy_mega.ran, true);
});

Deno.test("1lvay: the full-tier manifest counts the per-landing heavy suites as EXECUTED and defers only the 3", () => {
  // deno-lint-ignore no-explicit-any — the pure helper is JS with a loose JSDoc return; the test is
  // asserting the payload's shape, which is exactly what a typed return would hide.
  const manifest = fullTierManifestFields({
    serialFiles: ["tests/aaa.test.ts"],
    parallelFiles: ["tests/bbb.test.ts"],
    heavyParallelFiles: [...PER_LANDING_HEAVY_FILES],
    deferred: deferredTierEntries({
      heavyGateFiles: [...DEFERRED_HEAVY_FILES],
      heavyGateReasons: { "tests/python-documents-bundle-3p3e11.test.ts": "mega-suite" },
    }),
    tiers: heavyTierStatus({ heavyParallelFiles: [...PER_LANDING_HEAVY_FILES], megaRecord: null, sha: "abc123456" }),
    rc: 0,
  }) as any;
  assert(manifest, "a default run must produce a manifest");
  const executed = new Set(manifest.executedSuites);
  for (const f of PER_LANDING_HEAVY_FILES) {
    assertEquals(executed.has(f), true, `${f} ran in this command, so the ledger must say so`);
  }
  const omitted = new Set((manifest.omitted ?? []).map((o: { file: string }) => o.file));
  for (const f of PER_LANDING_HEAVY_FILES) {
    assertEquals(omitted.has(f), false, `${f} ran — listing it as omitted would report a gap that does not exist`);
  }
  for (const f of DEFERRED_HEAVY_FILES) {
    assertEquals(omitted.has(f), true, `${f} did not run and must be disclosed with a reason`);
  }
  // The structured tier ledger rides the record a reader/consumer sees.
  assertEquals(manifest.tiers.heavy_parallel.ran, PER_LANDING_HEAVY_FILES.length);
  assertEquals(manifest.tiers.heavy_mega.ran, false);
});

Deno.test("1lvay (c): the mega sweep exists, records its verdict, and files a P1 rather than a report", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/heavy-mega-sweep.ts", import.meta.url));
  assertStringIncludes(src, "writeMegaRecord", "the sweep must publish the record the landing gate reads");
  assertStringIncludes(src, "MEGA_HEAVY_FILES", "the sweep runs the declared mega population, not a hand-kept list");
  // A P1 bead is the notification: a report someone must read is how main stayed red since lrhyl.
  assert(/"-p",\s*"1"/.test(src), "the failure must be filed at priority 1");
  assertStringIncludes(src, "heavy-mega-sweep", "the bead is labelled so re-sweeps comment instead of duplicating");
  // And it must NOT write a per-tree heavy receipt: a partial run that looks like the heavy tier ran is
  // the same class of lie (a receipt naming a coverage it does not have) that this bead closes.
  assertEquals(/writeReceipt\(/.test(src), false, "the sweep must not emit a heavy-tier receipt");
});

// ── 1lvay (d), re-pointed at the KAT population (coord, 2026-11-11) ────────────────────────────────
// The invisible tier is not heavy: it is scripts/lib/harness-registry.ts, where 72 `kat` + 14 `named`
// harnesses sit and `npm test` runs none of them. "Absent from the ledger" is exactly how they went
// invisible, so these two assertions ARE the acceptance: never-run must be STATED, and stale must be
// stated with the sha and the age it is behind by.
import { HARNESSES } from "../scripts/lib/harness-registry.ts";
import {
  buildTierLedger,
  parseHarnessRegistry,
  TIER_IDS,
  unrunHarnesses,
} from "../scripts/lib/tier-ledger.mjs";

Deno.test("1lvay: the registry parser agrees with the real module — a drifting parse reds here", async () => {
  const text = await Deno.readTextFile(new URL("../scripts/lib/harness-registry.ts", import.meta.url));
  const parsed = parseHarnessRegistry(text);
  // Ground truth is the module itself, not a number typed into this test: prose in that file mentions
  // harness names (`{ "kat-x.ts": … }` inside a comment) and reason strings contain `{…}`, which is
  // exactly how a naive parse lost 4 real entries while still looking plausible.
  const truth = Object.entries(HARNESSES as Record<string, { class: string }>);
  const truthByClass: Record<string, string[]> = {};
  for (const [file, entry] of truth) (truthByClass[entry.class] ??= []).push(file);
  for (const list of Object.values(truthByClass)) list.sort();
  assertEquals(
    Object.keys(parsed.classes).sort(),
    Object.keys(truthByClass).sort(),
    "parser must see the same classes the module declares",
  );
  for (const [cls, files] of Object.entries(truthByClass)) {
    assertEquals(parsed.classes[cls], files, `class ${cls}: parsed set must equal the module's`);
  }
  assertEquals(parsed.files.length, truth.length);
  // And the population this bead is about, named explicitly so a silent zero cannot pass.
  const unrun = unrunHarnesses(parsed);
  assertEquals(unrun.length, (truthByClass.kat?.length ?? 0) + (truthByClass.named?.length ?? 0));
  assert(unrun.includes("kat-python-permissioned-fetch.ts"), "the harness that prompted the bead must be IN the population");
});

Deno.test("1lvay (d): a never-run population is STATED as never-run, never silently absent", () => {
  const ledger = buildTierLedger({
    files: {
      "heavy-parallel": ["tests/a.test.ts"],
      "heavy-mega": ["tests/b.test.ts"],
      "heavy-wall-clock": ["tests/c.test.ts"],
      "kat-harnesses": ["kat-one.ts", "kat-two.ts"],
    },
    records: { "kat-harnesses": null },
    sha: "1111111111111111",
    now: 1_700_000_000_000,
  });
  assertEquals(ledger.entries.map((e: {id: string}) => e.id), [...TIER_IDS], "one entry per population, in a fixed order");
  const kat = ledger.entries.find((e: {id: string}) => e.id === "kat-harnesses")!;
  assertEquals(kat.status, "never-run");
  assertStringIncludes(kat.line, "NOT RUN at this sha");
  assertStringIncludes(kat.line, "never run");
  assertStringIncludes(kat.line, "2 kat/named browser harnesses");
  // The defect was SILENCE: every population must have a line even when it has no record at all.
  assertEquals(ledger.lines.length, TIER_IDS.length);
  for (const line of ledger.lines) assert(/^[a-z-]+: /.test(line), `every tier line names its tier: ${line}`);
  assertEquals(ledger.payload.kat_harnesses.status, "never-run");
});

Deno.test("1lvay (d): a record from a tree BEHIND head is stale, with the sha and the age", () => {
  const now = 1_700_000_000_000;
  const ledger = buildTierLedger({
    files: { "kat-harnesses": ["kat-one.ts"] },
    records: { "kat-harnesses": { sha: "abcdef1234567890", result: "pass", at: now - 30 * 3_600_000 } },
    sha: "9999999999999999",
    now,
  });
  const kat = ledger.entries.find((e: {id: string}) => e.id === "kat-harnesses")!;
  assertEquals(kat.status, "stale");
  assertStringIncludes(kat.line, "NOT RUN at this sha");
  assertStringIncludes(kat.line, "last green abcdef123");
  assertStringIncludes(kat.line, "30h ago");
  assertEquals(kat.age_h, 30);
  // A record AT this tree is credited instead — the ledger must be able to say "it ran", or nobody will
  // trust it when it says "it did not".
  const same = buildTierLedger({
    files: { "kat-harnesses": ["kat-one.ts"] },
    records: { "kat-harnesses": { sha: "9999999999999999", result: "pass", at: now - 3_600_000 } },
    sha: "9999999999999999",
    now,
  }).entries.find((e: {id: string}) => e.id === "kat-harnesses")!;
  assertEquals(same.status, "ran");
  assertStringIncludes(same.line, "ran at this sha (PASS");
});

Deno.test("1lvay (d): a FAILED population is reported as a red, not as a gap or a green", () => {
  const now = 1_700_000_000_000;
  const sameTree = buildTierLedger({
    files: { "heavy-mega": ["tests/b.test.ts"] },
    records: { "heavy-mega": { sha: "abc1234567", result: "fail", at: now - 2 * 3_600_000 } },
    sha: "abc1234567",
    now,
  }).entries.find((e: {id: string}) => e.id === "heavy-mega")!;
  assertEquals(sameTree.status, "failed");
  assertStringIncludes(sameTree.line, "RED");
  const otherTree = buildTierLedger({
    files: { "heavy-mega": ["tests/b.test.ts"] },
    records: { "heavy-mega": { sha: "deadbeef00", result: "fail", at: now - 2 * 3_600_000 } },
    sha: "abc1234567",
    now,
  }).entries.find((e: {id: string}) => e.id === "heavy-mega")!;
  assertEquals(otherTree.status, "failed");
  assertStringIncludes(otherTree.line, "NOT RUN at this sha");
  assertStringIncludes(otherTree.line, "last run deadbeef0 FAIL");
});

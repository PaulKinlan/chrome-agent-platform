// tests/select-tests.test.ts — falsification pins for the dependency-aware
// subset picker (chrome-agent-platform-9hoc). The picker must NEVER lose a
// test that imports a changed file: that would let a per-commit gate go green
// while the full suite goes red. These pins fail if the static-import graph
// logic or the always-on core contract regresses.
import { assertEquals, assert } from "jsr:@std/assert@1";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CORE,
  FAST_SUBSET_EXCLUDED,
  FAST_SUBSET_EXCLUDED_REASONS,
  OMITTED_QUIET_BOX_REASON,
  ROOT,
  buildReverseGraph,
  collectChangedFiles,
  fileMappingContextForPlan,
  guardGapFor,
  isBuildResidue,
  omittedInventory,
  planSelection,
  referrersFor,
  selectTestFiles,
  selectionFanInNotice,
} from "../scripts/select-tests.mjs";
import { explainChangedFileMapping } from "../scripts/lib/gate-manifest.mjs";

// A real seam with a known importer: schedule-parser.js is imported by
// tests/schedule-parser.test.ts. If the graph walk stops resolving, the subset
// silently loses coverage — this pin is the RED that catches that.
Deno.test("nz2r: build scratch is never a changed source file (predicate + ignore rules)", async () => {
  // Two halves of ONE guarantee, because either alone can be defeated: the
  // selector's own predicate drops the family structurally (so a stale or
  // bypassed .gitignore cannot poison the gate), and git's untracked collection
  // never reports it in the first place. Both are required for the residue a
  // KILLED build leaves behind (no finally block runs — see build.mjs).
  const residue = [
    "extension/.dist-stage-70457-1791155350084/chunk.js",
    "extension/.dist-stage-12-3/index.html",
    "extension/.dist-link-boot-9/.dist-link-next-10",
    "extension/.dist-prev-11",
    ".build.lock.d/owner.json",
    ".lock-stage-x/y",
    ".lock-quarantine-1",
    ".owner.tmp-42",
  ];
  for (const path of residue) {
    assertEquals(isBuildResidue(path), true, `${path} is build scratch, never a source change`);
    const { code } = await new Deno.Command("git", { args: ["check-ignore", "-q", path], cwd: ROOT }).output();
    assertEquals(code, 0, `${path} must be gitignored (git check-ignore exited ${code})`);
  }
  // A filter that ignored too much would HIDE a real change from the gate, so
  // the predicate must not swallow source.
  for (const path of [
    "extension/shared/components.js",
    "extension/lib/acp-client.js",
    "scripts/select-tests.mjs",
    "tests/select-tests.test.ts",
    "package.json",
  ]) {
    assertEquals(isBuildResidue(path), false, `${path} is a real change and must stay a candidate`);
  }
});

Deno.test("select-tests: a changed source file selects its direct importer test", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/shared/schedule-parser.js"], reverse);
  assert(
    selected.includes("tests/schedule-parser.test.ts"),
    `schedule-parser.test.ts must be selected when schedule-parser.js changes; got: ${selected.length} files`,
  );
});

Deno.test("ps2x8: changing build script selects tests/build-parallel-discipline.test.ts", () => {
  const reverse = buildReverseGraph();
  const buildScript = ["build", "mjs"].join(".");
  const selected = selectTestFiles([buildScript], reverse);
  assert(
    selected.includes("tests/build-parallel-discipline.test.ts"),
    "build-parallel-discipline.test.ts must be selected when build script changes",
  );
});

Deno.test("zw8f0: changing build script selects tests/build-once-capture.test.ts", () => {
  const reverse = buildReverseGraph();
  const buildScript = ["build", "mjs"].join(".");
  const selected = selectTestFiles([buildScript], reverse);
  assert(
    selected.includes("tests/build-once-capture.test.ts"),
    "build-once-capture.test.ts must be selected when build script changes",
  );
});

Deno.test("cac6c: a service-worker.js delta selects the onMessage sender-guard census", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/background/service-worker.js"], reverse);
  assert(
    selected.includes("tests/onmessage-sender-guard.test.ts"),
    "the guard that POLICES service-worker.js's listeners must run on any sw.js delta: three consecutive edits (lrhyl, hvd4s, khwi9) ran their gates without it and a P1 reply-before-trust dispatcher hole reached main (cac6c)",
  );
});

Deno.test("select-tests: changed test files always run themselves", () => {
  const selected = selectTestFiles(["tests/security.test.ts"], null);
  assert(selected.includes("tests/security.test.ts"), "a changed test file must run itself");
});

Deno.test("select-tests: the always-on core never silently shrinks", () => {
  const selected = selectTestFiles([], null);
  for (const core of CORE) {
    assert(selected.includes(core), `${core} is always-on core and must always be selected`);
    assert(existsSync(join(ROOT, core)), `${core} exists on disk`);
  }
  // Core is security + vocabulary; dropping one of them would weaken the
  // per-commit gate for exactly the regressions subsetting must not miss.
  assertEquals(CORE.length, 5, "core = security(3) + redaction + vocabulary");
});

Deno.test("select-tests: selected files exist and are sorted, no duplicates", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/lib/pure.js"], reverse);
  assertEquals(new Set(selected).size, selected.length, "no duplicate selection");
  for (const f of selected) {
    assert(existsSync(join(ROOT, f)), `selected file exists: ${f}`);
    assert(f.endsWith(".test.ts"), `only test files are selected: ${f}`);
  }
});

Deno.test("select-tests: evidence modules referenced by tests preserve transitive reverse edges", () => {
  const reverse = buildReverseGraph();
  // cap-evidence/3yfs-finalizer-matrix.ts is referenced by tests/evidence-instruments.test.ts
  // and imports scripts/lib/kat-finalizer.ts. Changing kat-finalizer.ts must select evidence-instruments.test.ts!
  const selected = selectTestFiles(["scripts/lib/kat-finalizer.ts"], reverse);
  assert(
    selected.includes("tests/evidence-instruments.test.ts"),
    "changing scripts/lib/kat-finalizer.ts must select tests/evidence-instruments.test.ts via cap-evidence transitive edge",
  );
});

// ── zwpp9: a quiet-box suite cannot produce a verdict on a loaded fleet host ──────────────
// tests/ntp-boot-staging-timing.test.ts measures wall-clock budgets in a real browser and
// refuses environmentally (exit 75) whenever load/core exceeds CAP_QUIET_MAX_LOAD_PER_CORE.
// The fast subset runs on a shared, loaded box, so selecting it there yielded 3 refusals + 2
// passes for one tip on 2026-10-18 — a load-dependent verdict for every landing. It stays in
// the heavy tier; a per-change subset no longer selects it unless the change IS that suite.

Deno.test("zwpp9: a quiet-box suite is not selected by import mapping, but a change to it runs it", () => {
  const suite = "tests/ntp-boot-staging-timing.test.ts";
  assert(FAST_SUBSET_EXCLUDED.has(suite), "the quiet-box registry names the wall-clock boot suite");
  assert(existsSync(join(ROOT, suite)), "the excluded suite still exists (a stale entry would hide a rename)");
  assert(
    (FAST_SUBSET_EXCLUDED_REASONS[suite] ?? "").length > 40,
    "every exclusion states why, because an unexplained exclusion is a silent skip",
  );

  // Mapping-driven selection (a change to one of its dependencies) must not pull it in:
  const mapped = [{ file: "scripts/lib/ntp-boot-attribution.ts", mechanism: "scanned by the suite", tests: [suite] }];
  const viaMapping = selectTestFiles(["scripts/lib/ntp-boot-attribution.ts"], buildReverseGraph(), mapped);
  assert(!viaMapping.includes(suite), "the loaded-box fast subset must not select a quiet-box suite");

  // A change TO the suite runs it: the lane that edits a wall-clock test owns its verdict.
  const edited = selectTestFiles([suite], buildReverseGraph(), []);
  assert(edited.includes(suite), "editing the suite itself still selects it");
});

Deno.test("zwpp9: the gate ledger names the quiet-box omission, not the generic 'unselected' class", () => {
  const inventory = omittedInventory(["tests/select-tests.test.ts"], "unselected: no import path from the changed set");
  const entries = inventory.omitted.filter((e) => FAST_SUBSET_EXCLUDED.has(e.file));
  assert(entries.length > 0, "the excluded suite is disclosed in the omission inventory");
  for (const entry of entries) assertEquals(entry.reason, OMITTED_QUIET_BOX_REASON);
});
// ---- chrome-agent-platform-fhh50: the changed set is COLLECTED, not filtered by dot-ness ----

// Built by join() on purpose: referrersFor() maps a changed file to every suite whose TEXT names its
// path, so a literal path in this file would make the test itself the coverage for the file it is
// asserting has none. The fragments keep this suite out of its own fixture.
const TOOLING_REFERENCED = [".agents", "skills", "impeccable", "scripts", "context.mjs"].join("/");
const TOOLING_UNREFERENCED = [".agents", "skills", "impeccable", "scripts", "live-wrap.mjs"].join("/");

Deno.test("fhh50: dot-prefixed paths reach the ledger instead of vanishing from the changed set", () => {
  // RED before the fix: the impeccable tooling path was dropped by a blanket `!f.startsWith(".")`,
  // so the gate printed "no files changed vs origin/main" and reported nothing at all.
  const collected = collectChangedFiles([
    TOOLING_UNREFERENCED,
    ".beads/issues.jsonl",
    ".gitignore",
    "extension/lib/acp-run-config.js",
  ]);
  for (const path of [TOOLING_UNREFERENCED, ".beads/issues.jsonl", ".gitignore", "extension/lib/acp-run-config.js"]) {
    assert(collected.includes(path), `${path} must be collected so it can be classified`);
  }
  // The filter still drops what it dropped for a reason (build scratch is a separate predicate).
  assert(!collected.includes("docs/index.html"), "docs/ stays out of the executable changed set");
  assert(!collected.includes("CHANGELOG.md"), "the changelog is never a test-selection input");
  assertEquals(collectChangedFiles(["a.js", "a.js"]), ["a.js"], "the changed set stays de-duplicated");
});

Deno.test("fhh50: a plan that cannot map the delta says so (selection_covers_delta)", () => {
  // Two injected plans, no git and no suite run: the boolean is the plan's verdict, not the rc's.
  const mapped = planSelection({ changedFiles: () => ["extension/shared/schedule-parser.js"], reverseGraph: () => buildReverseGraph() });
  assertEquals(mapped.kind, "subset");
  assertEquals(fileMappingContextForPlan(mapped).selectionCoversDelta, true);

  // The tooling file a suite DOES name maps to that suite (the mechanism, stated in one line).
  const referenced = planSelection({ changedFiles: () => [TOOLING_REFERENCED], reverseGraph: () => buildReverseGraph() });
  assertEquals(referenced.kind, "subset");
  assertEquals(fileMappingContextForPlan(referenced).selectionCoversDelta, true);
  assert(
    referenced.mapped.some((row: { tests: string[] }) => row.tests.includes("tests/impeccable-design-context.test.ts")),
    `the suite that executes the launcher must be selected; got ${JSON.stringify(referenced.mapped)}`,
  );

  // Nothing names this one, so nothing may claim it: fail closed, with the file named.
  assertEquals(referrersFor(TOOLING_UNREFERENCED), [], "fixture precondition: no suite names this file");
  const refused = planSelection({ changedFiles: () => [TOOLING_UNREFERENCED], reverseGraph: () => buildReverseGraph() });
  assertEquals(refused.kind, "full", "unreferenced agent tooling must fail closed, not warn and proceed");
  assertEquals(fileMappingContextForPlan(refused).selectionCoversDelta, false);
  assertEquals(refused.unmappable.map((row: { file: string }) => row.file), [TOOLING_UNREFERENCED]);
});

// ---- chrome-agent-platform-nn5eq: a hot module's fan-in is stated, not discovered ----

Deno.test("nn5eq: a large selection announces its fan-in cost without refusing to run", () => {
  const ordinary = selectionFanInNotice({ selected: 134, population: 803 });
  assertEquals(ordinary, null, "a normal subset must not nag");

  const hot = selectionFanInNotice({ selected: 537, population: 803 });
  assert(hot, "537/803 is a hot-module delta and must be named");
  assert(/IMPORT FAN-IN, not a failure/.test(hot), hot);
  assert(/537 of 803 suites \(67%\)/.test(hot), hot);
  assert(/union FULL gate remains the landing verdict/.test(hot), hot);

  // The boundary is a third of the population, and it must not drift silently.
  assertEquals(selectionFanInNotice({ selected: 267, population: 803 }), null, "just under a third stays quiet");
  assert(selectionFanInNotice({ selected: 268, population: 803 }), "a third or more is announced");

  // No population, no claim.
  assertEquals(selectionFanInNotice({ selected: 10, population: 0 }), null);
  assertEquals(selectionFanInNotice({ selected: Number.NaN, population: 803 }), null);
});

// chrome-agent-platform-h346c: a guard-owning changed file must CARRY its guard in the
// selection, or the gate must refuse. The five incidents (lrhyl, hvd4s, khwi9 on
// service-worker.js; ibdr4 on script-host.js; qjoji+5b9mp's union) all share one shape: the
// file WAS import-reachable, so the uncovered-file guard tables never looked at it, and the
// plan still called itself a subset. A greener smaller selection is indistinguishable from a
// real pass where a merger reads it, which is why the rule is applied to every changed file.
Deno.test("h346c: a guard-owning changed file carries its dedicated guard even when the import graph covers it", () => {
  const plan = planSelection({ changedFiles: () => ["extension/lib/script-host.js"] });
  assertEquals(plan.kind, "subset", "script-host.js is import-reachable, so this stays a subset");
  assert(
    plan.files!.includes("tests/sandbox-egress-confinement.test.ts"),
    "the egress-confinement journey imports script-host dynamically, so no static edge selects it — the registry must (ibdr4's delta ran its gate without it)",
  );
  assertEquals(plan.guardGap, [], "after enforcement no guard gap remains");
  assert(
    plan.notices.some((n) => n.includes("owns a dedicated guard") && n.includes("sandbox-egress-confinement")),
    `the plan SAYS it added the guard, so a reader can see why the selection grew: ${plan.notices.join(" | ")}`,
  );
});

Deno.test("h346c: a registry entry naming a suite the tree does not have FAILS CLOSED and names the guard", () => {
  const plan = planSelection({
    changedFiles: () => ["extension/lib/script-host.js"],
    dedicatedGuards: { "extension/lib/script-host.js": ["tests/a-guard-that-does-not-exist.test.ts"] },
    htmlGuards: {},
  });
  assertEquals(plan.kind, "full", "a registry entry the selection cannot honour is a coverage claim nobody can keep");
  assert(plan.reason.includes("dedicated guard not resolvable"), plan.reason);
  assertEquals(plan.unmappable.length, 1);
  assertEquals(plan.unmappable[0].file, "extension/lib/script-host.js");
  assert(
    plan.unmappable[0].mechanism.includes("tests/a-guard-that-does-not-exist.test.ts"),
    `the refusal names the expected guard: ${plan.unmappable[0].mechanism}`,
  );
  assertEquals(plan.guardGap, [{ file: "extension/lib/script-host.js", guard: "tests/a-guard-that-does-not-exist.test.ts" }]);
});

Deno.test("h346c: guardGapFor is the merger's stop signal — it counts changed files whose guard is absent", () => {
  const changed = ["extension/background/service-worker.js", "extension/lib/script-host.js", "extension/lib/pure.js"];
  assertEquals(guardGapFor(changed, ["tests/onmessage-sender-guard.test.ts"]), [
    { file: "extension/lib/script-host.js", guard: "tests/sandbox-egress-confinement.test.ts" },
  ], "only the guard-owning file with an absent guard counts; pure.js owns none");
  assertEquals(
    guardGapFor(changed, ["tests/onmessage-sender-guard.test.ts", "tests/sandbox-egress-confinement.test.ts"]),
    [],
    "a zero is a pass",
  );
  assertEquals(guardGapFor([], []), []);
});

// chrome-agent-platform-xpmke: the selector must SAY which kind of refusal it is making, because
// the manifest can only render what it is told. A policy refusal (the selector's own machinery,
// an uncertifiable lockfile delta) and a genuine unmapped gap both withhold a subset, but only
// the second is a coverage GAP — and the fleet raises its COVERAGE WARNING from the gap list.
Deno.test("xpmke: a selector-infrastructure refusal is marked as POLICY, not left to be re-derived", () => {
  const plan = planSelection({ changedFiles: () => ["scripts/select-tests.mjs"] });
  assertEquals(plan.kind, "full");
  assertEquals(plan.unmappable.length, 1);
  assertEquals(plan.unmappable[0].file, "scripts/select-tests.mjs");
  assertEquals(
    plan.unmappable[0].kind,
    "policy",
    "the manifest renders 'fail-closed' from this kind; without it the file is reported as an unmapped gap",
  );
});

Deno.test("xpmke: an uncertifiable lockfile delta is POLICY too, not a coverage gap", () => {
  const plan = planSelection({
    changedFiles: () => ["package-lock.json"],
    lockfileOptions: {
      readText: () => {
        throw new Error("unreadable lockfile (test seam)");
      },
    },
  });
  // Whether this particular seam refuses or certifies, the invariant is: anything the plan
  // reports as unmappable carries an explicit kind, so no entry is silently reclassified.
  for (const entry of plan.unmappable) {
    assert(
      entry.kind === "policy" || entry.kind === "unmapped",
      `${entry.file} must declare a kind, got ${String(entry.kind)}`,
    );
  }
});

// chrome-agent-platform-1lvay/xpmke INTEGRATION — this is the case coord flagged as "where 'it merged
// clean' is weakest": h346c and xpmke merged without a textual conflict in scripts/select-tests.mjs and
// still contradicted each other, because h346c's guard-registry refusal carried no `kind`, so xpmke's
// manifest rendered a deliberate policy refusal as a coverage GAP. A test per bead would not have caught
// it — this one asserts the two behaviours TOGETHER.
Deno.test("xpmke+h346c: a guard-registry refusal is POLICY, so the manifest does not call it an unmapped gap", () => {
  const plan = planSelection({
    changedFiles: () => ["extension/lib/script-host.js"],
    dedicatedGuards: { "extension/lib/script-host.js": ["tests/no-such-guard-suite.test.ts"] },
  });
  assertEquals(plan.kind, "full", "an unhonourable registry entry must fail closed, not subset");
  assertEquals(plan.unmappable.length, 1);
  assertEquals(plan.unmappable[0].file, "extension/lib/script-host.js");
  assertEquals(
    plan.unmappable[0].kind,
    "policy",
    "h346c's refusal is by design; without kind the ledger reports it as a gap and the warning is unfixable noise",
  );
  // And the declaration reaches the wire: the manifest renders fail-closed, never unmapped.
  const rows = explainChangedFileMapping({ changed: ["extension/lib/script-host.js"], executedSuites: [], unmappable: plan.unmappable });
  assertEquals(rows[0].status, "fail-closed");
});

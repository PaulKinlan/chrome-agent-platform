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
import { guardsForChangedFile } from "../scripts/lib/changed-file-mapping.mjs";

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

Deno.test("xycyl: a file whose DEDICATED guard ran is mapped, not reported as an unmapped gap", () => {
  // The lzccc shape, measured on the gate: scripts/lib/serial-runner.mjs has no import
  // edge to any suite (it executes at import time, so importing it would RUN a test file),
  // and the gate printed "unmapped changed file" while BOTH of its dedicated guards ran.
  // Driven here as a PURE plan (reverse: null) so the assertion cannot be satisfied by an
  // incidental graph edge: with no import graph, the dedicated table is the only thing that
  // can name an inspecting suite for this file.
  const file = "scripts/lib/serial-runner.mjs";
  const guards = guardsForChangedFile(file);
  assert(guards.length > 0, "fixture precondition: this file owns dedicated guards");

  const fullPlan = { kind: "full", changed: [file], mapped: [], reverse: null, unmappable: [], lockfileDelta: [] };
  const context = fileMappingContextForPlan(fullPlan);
  for (const guard of guards) {
    assert(
      (context.candidates[file] ?? []).includes(guard),
      `${guard} must be a candidate for ${file}; got ${JSON.stringify(context.candidates[file])}`,
    );
  }

  // And the ledger then says mapped when they ran — the actual warning condition.
  const rows = explainChangedFileMapping({
    changed: [file],
    candidates: context.candidates,
    executedSuites: guards,
    runExitCode: 0,
  });
  assertEquals(rows[0].status, "mapped", `a covered file must not read as a gap: ${JSON.stringify(rows[0])}`);
  assertEquals(rows[0].executed_suites, [...guards].sort());
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

Deno.test("wwgnm: the incidental-instrument surface carries its guard, and removal is a named stop signal", () => {
  // wwgnm: settings-view.js is registered because its only touching suite reaches it by a
  // dynamic import specifier (a coincidence edge). (directory.js was the second entry until
  // r3/1jkwf proved it false — its suite only string-checks the file — and it moved to
  // DECLARED_NO_GUARD; see the leg below.)
  const file = "extension/options/settings-view.js";
  const guard = "tests/settings-client-view.test.ts";
  {
    const plan = planSelection({ changedFiles: () => [file] });
    assertEquals(plan.kind, "subset", `${file}: import-reachable, so still a certifiable subset`);
    assert(
      plan.files!.includes(guard),
      `${file} must carry its dedicated guard (${guard})`,
    );
    assertEquals(plan.guardGap, [], `${file}: after enforcement no guard gap remains`);
    assertEquals(
      guardGapFor([file], (plan.files ?? []).filter((f) => f !== guard)),
      [{ file, guard }],
      `${file}: dropping the guard must be reported, not silent`,
    );
  }
  // wwgnm r3 (1jkwf): directory.js owns NO dedicated guard — no suite imports it (every
  // reference in tests/ is readTextFile text inspection) — and its answer is the DECLARATION:
  // the runtime edge is ntp.js's static import, which the graph already counts, so a
  // directory.js delta stays a certifiable subset with no gap and no invented coverage.
  const directory = planSelection({ changedFiles: () => ["extension/directory/directory.js"] });
  assertEquals(directory.kind, "subset", "directory.js stays import-reachable through ntp.js's static import");
  assertEquals(directory.guardGap, [], "no dedicated guard is claimed for directory.js, so no gap");
  assert(
    (directory.files ?? []).includes("tests/ntp-agent-route-execution.test.ts"),
    `the transitive edge must select ntp.js's policing suite, got: ${(directory.files ?? []).filter((f) => f.includes("ntp")).join(", ")}`,
  );
});

// chrome-agent-platform-wwgnm round 2 (coord acceptance 1), REFINED by chrome-agent-platform-
// 853x8: NO SILENCE means a refusal for a product file NOTHING runs for — no import edge, no
// classification mapping, no dedicated guard, no declaration. The r2 rule fired on registry
// state instead and escalated 469 import-reachable files (and passive assets) to the FULL
// suite; a covered-but-unpoliced delta now stays a certifiable subset and is NAMED in a notice.
Deno.test("wwgnm r2 + 853x8: an uncovered, unmapped, undeclared product file is refused BY NAME; a covered one is a named subset", () => {
  // REFUSAL leg: the class is EMPTY on today's tree (every product file is covered, mapped or
  // declared), so the rule is exercised through the reverseGraph seam the refusal path was built
  // with: an empty graph makes a real, import-covered file uncovered+unmappable — the
  // genuinely-blind state the fail-closed refusal exists for (the unmappable leg, generic
  // "no reachable test" header — the r2 registry-state block is gone; it could never see this
  // class and refused everything else instead).
  const refused = planSelection({
    changedFiles: () => ["extension/lib/attachments.js"],
    reverseGraph: () => new Map(),
  });
  assertEquals(refused.kind, "full", "a product file nothing runs for must refuse, not fall back silently");
  assertEquals(
    refused.unmappable.map((row: { file: string }) => row.file),
    ["extension/lib/attachments.js"],
    "the refusal must name the file",
  );
  assert(
    (refused.reason ?? "").includes("no reachable test") ||
      refused.unmappable[0].mechanism.includes("unmappable") ||
      refused.unmappable[0].mechanism.length > 0,
    `the refusal must say what is missing: ${JSON.stringify(refused.unmappable[0])}`,
  );

  // COVERED-BUT-UNPOLICED leg, real tree (the reviewer's own repro file): attachments.js has
  // import-edge coverage and no registry answer — a certifiable subset, NAMED in a notice.
  const covered = planSelection({ changedFiles: () => ["extension/lib/attachments.js"] });
  assertEquals(covered.kind, "subset", "import-reachable coverage certifies the delta (853x8)");
  assert(
    covered.notices.some((n) => n.includes("extension/lib/attachments.js") && n.includes("no dedicated guard")),
    `the covered-but-unpoliced class must stay visible by name: ${covered.notices.join(" | ")}`,
  );
  assertEquals(
    (covered.unmappable ?? []).filter((row: { file: string }) => row.file === "extension/lib/attachments.js"),
    [],
    "a covered file must not be reported as an unmapped gap",
  );

  // The r2 refusal premise is GONE for covered files: schedule-parser.js with an empty
  // declared-map is still import-covered, so it certifies (with the notice) instead of refusing.
  const undeclaredCovered = planSelection({
    changedFiles: () => ["extension/shared/schedule-parser.js"],
    declaredNoGuard: {},
  });
  assertEquals(undeclaredCovered.kind, "subset", "coverage, not registry state, decides certification");

  // The SAME file WITH its declaration is a certifiable subset — declarations answer.
  const declared = planSelection({ changedFiles: () => ["extension/shared/schedule-parser.js"] });
  assertEquals(declared.kind, "subset", "a declared file must not be refused");
  assertEquals(
    (declared.unmappable ?? []).filter((row: { file: string }) => row.file === "extension/shared/schedule-parser.js"),
    [],
  );

  // PASSIVE ASSETS: a stylesheet is content — no unit-tier suite executes CSS, so it is
  // reported, never refused (the r2 rule red theme.css deltas with no honest answer).
  const asset = planSelection({ changedFiles: () => ["extension/shared/theme.css"] });
  assert(asset.kind !== "full", `a passive asset must not refuse: ${asset.failClosedHeader ?? ""}`);
  assertEquals(
    (asset.unmappable ?? []).filter((row: { file: string }) => row.file === "extension/shared/theme.css"),
    [],
  );

  // THE DEFAULT LOCALE has a REAL policing suite (byte-identical catalogue drift guard) reached
  // only by a URL path read the import graph cannot count — the deliberate dedicated-guard
  // entry binds it, so a messages.json delta carries the suite instead of refusing.
  const locales = planSelection({ changedFiles: () => ["extension/_locales/en/messages.json"] });
  assertEquals(locales.kind, "subset", "the locale catalogue is policed by its drift guard");
  assert(
    locales.files!.includes("tests/i18n-foundation.test.ts"),
    "the catalogue delta must carry tests/i18n-foundation.test.ts",
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

// ── chrome-agent-platform-4iyck: the h346c rule applied to the files that had NO mapping at all.
// Each of these four subjects had a guard suite in the tree that the selection did not carry, and
// the selector had no registry entry to derive one from — so the exposure was permanent, not a
// one-delta accident. The acceptance is the same for all four: the plan carries the guard, the gap
// count is zero, and the plan SAYS which guard it added.
Deno.test("4iyck: each formerly-unmapped subject carries its guard, with no gap and a stated reason", () => {
  const subjects: Array<[string, string]> = [
    // 67xsg: cap-fetch-deny reads the SW as DATA (no import edge).
    ["extension/background/service-worker.js", "tests/cap-fetch-deny.test.ts"],
    // c60vo: the dispatcher denial paths are driven by settings-session's extracted SW harness.
    ["extension/background/service-worker.js", "tests/settings-session.test.ts"],
    // v8n9b: the classic-script port and the canonical predicate it mirrors.
    ["extension/content/content-script.js", "tests/trusted-sender-port-fence.test.ts"],
    ["extension/lib/pure-trust.js", "tests/trusted-sender-port-fence.test.ts"],
    // 28hwd + qnci3: runbooks are passive content, so nothing read them.
    ["docs/MERGER-PLAYBOOK.md", "tests/runbook-sync-commands.test.ts"],
    [".agents/skills/beads-flow/SKILL.md", "tests/runbook-sync-commands.test.ts"],
  ];
  for (const [file, guard] of subjects) {
    const plan = planSelection({ changedFiles: () => [file] });
    assertEquals(plan.kind, "subset", `${file}: the change is still certifiable as a subset`);
    assert(plan.files!.includes(guard), `${file} must carry its guard ${guard}`);
    assertEquals(plan.guardGap, [], `${file}: after enforcement no guard gap remains`);
    // Removing the guard from the selection is the merger's stop signal, and it NAMES the guard.
    assertEquals(guardGapFor([file], (plan.files ?? []).filter((f) => f !== guard)), [{ file, guard }]);
  }
  // A guard the import graph and the text-reference walk BOTH miss is the case the registry exists
  // for, and there the plan must say so — otherwise the selection silently grows. The runbooks are
  // that case: they are passive content, so before 4iyck nothing selected anything for them.
  const runbookPlan = planSelection({ changedFiles: () => ["docs/MERGER-PLAYBOOK.md"] });
  assert(
    runbookPlan.notices.some((n) => n.includes("owns a dedicated guard") && n.includes("runbook-sync-commands")),
    `the plan must SAY it added the runbook guard: ${runbookPlan.notices.join(" | ")}`,
  );
});

Deno.test("h346c: guardGapFor is the merger's stop signal — it counts changed files whose guard is absent", () => {
  const changed = ["extension/background/service-worker.js", "extension/lib/script-host.js", "extension/lib/pure.js"];
  // 4iyck: service-worker.js owns THREE guards now (the sender census plus the two suites that read
  // it as data — cap-fetch-deny and settings-session), and the gap list must name every absent one:
  // a stop signal that reports one of three missing guards is the same silent subset this bead
  // exists to remove.
  assertEquals(guardGapFor(changed, ["tests/onmessage-sender-guard.test.ts"]), [
    { file: "extension/background/service-worker.js", guard: "tests/cap-fetch-deny.test.ts" },
    { file: "extension/background/service-worker.js", guard: "tests/settings-session.test.ts" },
    { file: "extension/lib/script-host.js", guard: "tests/sandbox-egress-confinement.test.ts" },
  ], "every absent guard of a guard-owning file counts; pure.js owns none");
  assertEquals(
    guardGapFor(changed, [
      "tests/onmessage-sender-guard.test.ts",
      "tests/cap-fetch-deny.test.ts",
      "tests/settings-session.test.ts",
      "tests/sandbox-egress-confinement.test.ts",
    ]),
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

// ── erxkj: the subset parallel phase resolves a REFUSAL, not a raw 1 ───────
// Behavioral pin: drive the real runPhase through a fake `deno` on PATH whose
// output is the r2l8n incident's shape (an all-environmental failure), and a
// second fake whose shape is a genuine product red. Before the fix runPhase
// resolved the child's RAW code (stdio: "inherit", no capture), so the refusal
// red-ed the fast gate and the landing queue paid a retry.

async function runPhaseWithFakeDeno(fakeOutput: string, fakeExit: number): Promise<number> {
  const root = await Deno.makeTempDir();
  try {
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    const fake = join(bin, "deno");
    await Deno.writeTextFile(fake, `#!/bin/sh\ncat <<'FAKEOUT'\n${fakeOutput}\nFAKEOUT\nexit ${fakeExit}\n`);
    await Deno.chmod(fake, 0o755);
    const moduleUrl = new URL("../scripts/select-tests.mjs", import.meta.url).href;
    const cmd = new Deno.Command("node", {
      args: [
        "--input-type=module",
        "-e",
        `import { runPhase } from ${JSON.stringify(moduleUrl)};` +
          `const rc = await runPhase(["tests/fake.test.ts"], [], "parallel phase", 60000);` +
          `process.exit(rc);`,
      ],
      env: { ...Deno.env.toObject(), PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` },
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    return out.code;
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const ERXKJ_REFUSAL_SHAPE = `
 ERRORS 

boot timing under steal => ./tests/fake-quiet.test.ts:10:6
error: QuietWindowRefusedError: ENVIRONMENT: machine is not quiet enough for this gate (load1=11.76 load5=9.21 cores=8 load/core=1.47 heavy-builders=3)
    throw new QuietWindowRefusedError(msg);
          ^

 FAILURES 

boot timing under steal => ./tests/fake-quiet.test.ts:10:6

FAILED | 0 passed | 1 failed (15ms)
`;

const ERXKJ_PRODUCT_SHAPE = `
 ERRORS 

assertion fails => ./tests/fake-product.test.ts:20:6
error: AssertionError: Values are not equal
    throw new AssertionError(msg);
          ^

 FAILURES 

assertion fails => ./tests/fake-product.test.ts:20:6

FAILED | 0 passed | 1 failed (9ms)
`;

Deno.test("erxkj: a subset parallel phase whose failures are ALL environmental resolves 75, not the raw deno code", async () => {
  assertEquals(await runPhaseWithFakeDeno(ERXKJ_REFUSAL_SHAPE, 1), 75, "the fast gate must receive the refusal, not a product red");
});

Deno.test("erxkj: a subset parallel phase with a PRODUCT failure keeps the raw 1 (the fix must not soften reds)", async () => {
  assertEquals(await runPhaseWithFakeDeno(ERXKJ_PRODUCT_SHAPE, 1), 1, "a product red stays a product red");
});

Deno.test("kdeqx: a child KILLED BY SIGNAL after printing a refusal summary resolves 137, never 75 (behavioral)", async () => {
  // The fake deno prints the all-environmental shape and then SIGKILLs itself —
  // the killed child did not exit normally, so the run is not a verdict at all.
  const root = await Deno.makeTempDir();
  try {
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    const fake = join(bin, "deno");
    await Deno.writeTextFile(fake, `#!/bin/sh\ncat <<'FAKEOUT'\n${ERXKJ_REFUSAL_SHAPE}\nFAKEOUT\nkill -9 $$\n`);
    await Deno.chmod(fake, 0o755);
    const moduleUrl = new URL("../scripts/select-tests.mjs", import.meta.url).href;
    const cmd = new Deno.Command("node", {
      args: [
        "--input-type=module",
        "-e",
        `import { runPhase } from ${JSON.stringify(moduleUrl)};` +
          `const rc = await runPhase(["tests/fake.test.ts"], [], "parallel phase", 60000);` +
          `process.exit(rc);`,
      ],
      env: { ...Deno.env.toObject(), PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` },
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    assertEquals(out.code, 137, "a SIGKILLed child resolves 137 — fleet-check treats it as KILLED, not a cached verdict");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

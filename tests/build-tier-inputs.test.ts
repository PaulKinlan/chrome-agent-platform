// tests/build-tier-inputs.test.ts — the build-behaviour tier's SELECTION rule (chrome-agent-platform-6gk81).
//
// scripts/lib/build-tier-inputs.mjs decides whether `npm run test:build` can skip its three in-place
// build tests because the tree's build machinery is byte-identical to a tree that already passed them.
// That decision is the only thing standing between a 92-146s-per-landing gate line and a silently UNRUN
// build tier, so it is pinned by execution here, not by a structural grep alone:
//
//   * MEMBERSHIP, derived not listed: the key is the TRANSITIVE STATIC IMPORT CLOSURE of build.mjs,
//     scripts/build-gate.ts and every BUILD_GATE file, plus the data trees. The first version of the
//     module keyed a hand-written pattern list and review (rev-6gk81, finding on
//     chrome-agent-platform-1yzg2) found direct dependencies of the build and of the tier tests that
//     the list missed — scripts/browser-dependencies.mjs, scripts/lib/{bounded-child,pyodide-staging}.mjs,
//     scripts/lib/process-tree.ts, scripts/dist-complete.mjs, scripts/{sync-gallery,sync-changelog,
//     generate-about-page}.mjs. Every one of those is pinned BY NAME below, so a future narrowing of the
//     walk fails here instead of silently certifying a stale PASS.
//   * VERSION-NEUTRALITY: the landing bump rewrites the version on every landing, so a key that saw it
//     could never match. Two trees that differ ONLY in the version stamp must key identically, and a
//     real byte change must not.
//   * THE DECISION TABLE: only a record whose key equals the computed key may skip. No mode other than
//     an exact match skips, a truncated closure never skips, and `CAP_BUILD_TIER` cannot spell "skip".
//   * THE RECORD: written only for exit 0 (a failed tier can never license a skip); missing, malformed
//     or misfiled records are refused, and a key is not a path.
//   * THE CALL SITE: scripts/build-gate.ts must reach the decision through resolveBuildTier and write
//     the record only on its success path, and `npm run test:all` must FORCE the tier.
//
// Every test here is pure or uses its own durable scratch directory: no test depends on another's
// order, on machine state outside that directory, or on a real build.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { BUILD_GATE_FILES } from "../scripts/test-partition.mjs";
import {
  BUILD_TIER_RECORD_DIR_NAME,
  BUILD_TIER_ROOTS,
  MAX_CLOSURE_FILES,
  VERSION_PLACEHOLDER,
  buildTierDecision,
  buildTierKey,
  buildTierMode,
  buildTierRecordDir,
  collectBuildTierClosure,
  collectBuildTierInputPaths,
  collectBuildTierInputs,
  isBuildTierDataInput,
  moduleSpecifiers,
  normalizeRepoPath,
  readBuildTierRecord,
  recordBuildTierPass,
  resolveBuildTier,
  resolveSpecifier,
  versionNeutralBytes,
} from "../scripts/lib/build-tier-inputs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Sentinel versions, not a plausible project version: the key substitutes the tree's CURRENT version,
// so a test that embedded a real release number would itself key differently on the landing that bumps
// to it (and the stamp-surface guard below would rightly fail). 999.x is unreachable.
const V1 = "999.0.0";
const V2 = "999.0.1";

/**
 * A private scratch root under the durable root (never /tmp: tmpfs is RAM-backed and the fleet bans
 * it — tests/durable-root.test.ts enforces the convention). Unique per call, removed in a finally.
 */
function scratchDir(): string {
  return durableDir("scratch", `cap-build-tier-${crypto.randomUUID()}`);
}

/** The fake root the injected-graph tests use; `read` always receives root-joined paths. */
const FAKE_ROOT = "/nonexistent-cap-build-tier";
const fakePathToRel = (abs: string): string => normalizeRepoPath(String(abs).slice(FAKE_ROOT.length + 1));

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------------------------------
// Specifier scanning and resolution: the two primitives the closure is built from.
// ---------------------------------------------------------------------------------------------------

Deno.test("closure: every literal module-specifier shape is found, and non-specifier strings are not", () => {
  const text = [
    'import { a } from "./a.mjs";',
    "import b from '../b.ts';",
    'export { c } from "./c.js";',
    'const d = await import("./d.mjs");',
    'const e = require("./e.cjs");',
    'import "./side-effect.mjs";',
    'import { f } from "npm:zod@3.25.76";',
    'const prose = "this is not an import from x";',
  ].join("\n");
  const found = moduleSpecifiers(text).sort();
  for (const expected of ["./a.mjs", "../b.ts", "./c.js", "./d.mjs", "./e.cjs", "./side-effect.mjs", "npm:zod@3.25.76"]) {
    assert(found.includes(expected), `expected ${expected} in ${JSON.stringify(found)}`);
  }
  assertEquals(moduleSpecifiers("const x = 1; // no imports here").length, 0);
});

Deno.test("closure: relative specifiers resolve with this repo's extension and index conventions", async () => {
  const files = new Set(["tests/build-x.test.ts", "scripts/lib/helper.ts", "scripts/lib/dual.mjs", "scripts/lib/pkg/index.ts", "build.mjs"]);
  const exists = async (rel: string) => files.has(normalizeRepoPath(rel));
  assertEquals(await resolveSpecifier("tests/build-x.test.ts", "../scripts/lib/helper.mjs", exists), "scripts/lib/helper.ts");
  assertEquals(await resolveSpecifier("tests/build-x.test.ts", "../scripts/lib/dual.ts", exists), "scripts/lib/dual.mjs");
  assertEquals(await resolveSpecifier("tests/build-x.test.ts", "../scripts/lib/pkg/index.ts", exists), "scripts/lib/pkg/index.ts");
  assertEquals(await resolveSpecifier("tests/build-x.test.ts", "../scripts/lib/pkg", exists), "scripts/lib/pkg/index.ts");
  assertEquals(await resolveSpecifier("tests/build-x.test.ts", "../scripts/lib/does-not-exist.mjs", exists), null);
  assertEquals(await resolveSpecifier("tests/build-x.test.ts", "npm:zod@4.4.3", exists), null, "bare specifiers are the lockfiles' business");
  assertEquals(await resolveSpecifier("tests/build-x.test.ts", "../../../../etc/passwd", exists), null, "a specifier cannot leave the repo");
});

// ---------------------------------------------------------------------------------------------------
// The closure walk, on an injected graph (no checkout needed).
// ---------------------------------------------------------------------------------------------------

Deno.test("closure: a helper imported by the build OR by a tier test is an input, transitively", async () => {
  const graph: Record<string, string> = {
    "build.mjs": 'import { x } from "./scripts/lib/direct.mjs";',
    "scripts/build-gate.ts": 'import { y } from "./lib/gate-helper.mjs";',
    "tests/build-bootstrap.test.ts": 'import { z } from "../scripts/lib/test-helper.ts";',
    "scripts/lib/direct.mjs": 'import { deep } from "./deep.mjs";',
    "scripts/lib/deep.mjs": "export const deep = 1;",
    "scripts/lib/gate-helper.mjs": "export const y = 1;",
    "scripts/lib/test-helper.ts": 'import "npm:zod@4.4.3"; export const z = 1;',
  };
  const closure = await collectBuildTierClosure({
    root: FAKE_ROOT,
    exists: async (rel: string) => normalizeRepoPath(rel) in graph,
    read: async (abs: string) => encoder.encode(graph[fakePathToRel(abs)] ?? ""),
  });
  assertEquals(closure.truncated, false);
  for (const expected of [
    "build.mjs",
    "scripts/build-gate.ts",
    ...BUILD_GATE_FILES,
    "scripts/lib/direct.mjs",
    "scripts/lib/deep.mjs",
    "scripts/lib/gate-helper.mjs",
    "scripts/lib/test-helper.ts",
  ]) {
    assert(closure.paths.includes(expected), `${expected} must be in the closure (got ${closure.paths.join(", ")})`);
  }
  assertEquals(closure.paths, [...closure.paths].sort(), "the closure is sorted");
});

Deno.test("closure: exceeding the bound sets truncated (a partial key must not certify), and residue is named", async () => {
  const graph: Record<string, string> = {
    "build.mjs": 'import "./scripts/lib/a.mjs"; import "./does-not-exist.mjs";',
    "scripts/build-gate.ts": "",
    "tests/build-bootstrap.test.ts": "",
    "tests/build-debug-mode.test.ts": "",
    "tests/build-tool-bundling.test.ts": "",
    "scripts/lib/a.mjs": 'import "./b.mjs";',
    "scripts/lib/b.mjs": "",
  };
  const deps = {
    root: FAKE_ROOT,
    exists: async (rel: string) => normalizeRepoPath(rel) in graph,
    read: async (abs: string) => encoder.encode(graph[fakePathToRel(abs)] ?? ""),
  };
  const bounded = await collectBuildTierClosure({ ...deps, maxFiles: 2 });
  assertEquals(bounded.truncated, true, "hitting the bound must be visible to the decision");
  const entries = [{ path: "build.mjs", sha256: "1".repeat(64) }];
  const record = { key: buildTierKey(entries) as string, at: "2026-10-17T00:00:00.000Z" };
  assertEquals(buildTierDecision({ entries, record, truncated: true }).run, true,
    "a truncated closure must run the tier even with a matching record");

  const full = await collectBuildTierClosure(deps);
  assertEquals(full.truncated, false);
  assert(full.unresolved.some((entry) => entry.includes("does-not-exist.mjs")), "an unresolvable RELATIVE import is reported, not silently dropped");
});

// ---------------------------------------------------------------------------------------------------
// The real tree: the closure reaches what the reviewer found, and nothing product-side.
// ---------------------------------------------------------------------------------------------------

Deno.test("closure: the real tier's own dependencies are inputs (the 1yzg2 review finding, pinned by name)", async () => {
  const { paths } = await collectBuildTierClosure({ root: ROOT });
  const required = [
    // imported by the tier's TESTS
    "scripts/lib/process-tree.ts",
    "scripts/dist-complete.mjs",
    // imported by build.mjs
    "scripts/browser-dependencies.mjs",
    "scripts/lib/bounded-child.mjs",
    "scripts/lib/pyodide-staging.mjs",
    "scripts/sync-gallery.mjs",
    "scripts/sync-changelog.mjs",
    "scripts/generate-about-page.mjs",
    // the roots themselves
    "build.mjs",
    "scripts/build-gate.ts",
    ...BUILD_GATE_FILES,
  ];
  const missing = required.filter((rel) => !paths.includes(rel));
  assertEquals(missing, [], `the import closure must reach these (they are executed by the tier): ${missing.join(", ")}`);
});

Deno.test("closure: product sources, the changelog and unrelated tests are NOT inputs", async () => {
  const { paths } = await collectBuildTierClosure({ root: ROOT });
  // If one of these ever becomes an input, every landing keys differently (the version/CHANGELOG stamp
  // is rewritten by scripts/bump-version.mjs on each landing) and the tier can never skip. The fix for
  // that is the dependency graph, not a wider key.
  for (const rel of [
    "CHANGELOG.md",
    "extension/background/service-worker.js",
    "tests/journey-focus-fail-closed.test.ts",
    "tests/backup-restore.test.ts",
    "scripts/run-tests.mjs",
    "scripts/select-tests.mjs",
  ]) {
    assert(!paths.includes(rel), `${rel} is product/selector surface the tier does not execute; keying it would disable the skip`);
  }
});

Deno.test("closure: the real roots are the tier's tests, the runner and the build entry point", () => {
  assertEquals([...BUILD_TIER_ROOTS], ["build.mjs", "scripts/build-gate.ts", ...BUILD_GATE_FILES]);
  for (const rel of ["build.mjs", "scripts/build-gate.ts", ...BUILD_GATE_FILES]) assert(BUILD_TIER_ROOTS.includes(rel), rel);
  assert(MAX_CLOSURE_FILES >= 100, "the bound must be far above the real closure (~90 files) so it never fires by accident");
});

Deno.test("data inputs: the manifest and the dependency pinning are inputs; product files are not", () => {
  for (const rel of ["package.json", "package-lock.json", "deno.lock", "deno.runner.jsonc", "extension/manifest.json"]) {
    assert(isBuildTierDataInput(rel), `${rel} pins the build and must be an input`);
  }
  for (const rel of ["CHANGELOG.md", "extension/background/service-worker.js", "README.md", ""]) {
    assert(!isBuildTierDataInput(rel), `${rel} must not be a data input`);
  }
});

Deno.test("inputs: the real walk is deterministic, sorted, de-duplicated and reaches the machinery trees", async () => {
  const first = await collectBuildTierInputPaths({ root: ROOT });
  const second = await collectBuildTierInputPaths({ root: ROOT });
  assertEquals(first.paths, second.paths, "two walks of the same tree must agree");
  assertEquals(first.truncated, false, "the real closure must fit inside the bound");
  assertEquals(first.paths, [...first.paths].sort());
  assertEquals(new Set(first.paths).size, first.paths.length);
  assert(first.paths.includes("build.mjs"));
  assert(first.paths.includes("scripts/build-gate.ts"));
  assert(first.paths.includes("package.json"));
  assert(first.paths.some((rel) => rel.startsWith("packages/bundled/")), "the bundled-tool inputs must be in the walk");
  assert(first.paths.some((rel) => rel.startsWith("wasm-tools/")), "the Wasm inputs must be in the walk");
  assert(!first.paths.includes("CHANGELOG.md"));
});

// ---------------------------------------------------------------------------------------------------
// Version neutrality: the landing stamp is not an input.
// ---------------------------------------------------------------------------------------------------

Deno.test("inputs: the tree's own version stamp does not change the key, a real byte does", () => {
  const at724 = encoder.encode(JSON.stringify({ name: "cap", version: V1, deps: { a: "1.0.0" } }));
  const at725 = encoder.encode(JSON.stringify({ name: "cap", version: V2, deps: { a: "1.0.0" } }));
  const depChanged = encoder.encode(JSON.stringify({ name: "cap", version: V1, deps: { a: "1.0.1" } }));

  assertEquals(
    decoder.decode(versionNeutralBytes(at724, V1)),
    JSON.stringify({ name: "cap", version: VERSION_PLACEHOLDER, deps: { a: "1.0.0" } }),
  );
  assertEquals(
    buildTierKey([{ path: "package.json", sha256: digest(versionNeutralBytes(at724, V1)) }]),
    buildTierKey([{ path: "package.json", sha256: digest(versionNeutralBytes(at725, V2)) }]),
    "a version-only difference between two trees must not invalidate the recorded PASS",
  );
  assertNotEquals(
    buildTierKey([{ path: "package.json", sha256: digest(versionNeutralBytes(at724, V1)) }]),
    buildTierKey([{ path: "package.json", sha256: digest(versionNeutralBytes(depChanged, V1)) }]),
    "a dependency change must invalidate it",
  );
});

Deno.test("inputs: binary content is hashed as-is (a version string in a blob is not a stamp)", () => {
  const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x39, 0x39, 0x39, 0x2e, 0x30, 0x2e, 0x30]); // "\xff\xfe\x00999.0.0"
  assertEquals(versionNeutralBytes(binary, V1), binary);
});

Deno.test("inputs: the key is order-independent, and null when nothing could be digested", () => {
  const a = { path: "build.mjs", sha256: "1".repeat(64) };
  const b = { path: "package.json", sha256: "2".repeat(64) };
  assertEquals(buildTierKey([a, b]), buildTierKey([b, a]));
  assertEquals(buildTierKey([]), null);
  assertNotEquals(buildTierKey([a, b]), buildTierKey([a, { path: b.path, sha256: "3".repeat(64) }]));
});

// ---------------------------------------------------------------------------------------------------
// The decision table, and the missing skip switch.
// ---------------------------------------------------------------------------------------------------

Deno.test("decision: only an exact recorded PASS in selective mode skips", () => {
  const entries = [{ path: "build.mjs", sha256: "1".repeat(64) }];
  const key = buildTierKey(entries) as string;
  const pass = { key, at: "2026-10-17T00:00:00.000Z" };

  assertEquals(buildTierDecision({ entries, record: pass }).run, false, "a matching PASS skips");
  assertEquals(buildTierDecision({ entries, record: pass }).key, key);
  assertEquals(buildTierDecision({ entries, record: null }).run, true, "no record => run");
  assertEquals(buildTierDecision({ entries, record: { key: KEY_B, at: pass.at } }).run, true, "another key => run");
  assertEquals(buildTierDecision({ entries: [], record: pass }).run, true, "nothing digested => run (fail closed)");
  assertEquals(buildTierDecision({ entries, record: pass, mode: "force" }).run, true, "force always runs");
  assertEquals(buildTierDecision({ entries, record: pass, mode: "selective" }).run, false);
});

Deno.test("mode: CAP_BUILD_TIER can force a run and cannot switch the tier off", () => {
  for (const value of ["force", "FORCE", " force ", "1", "true", "always"]) {
    assertEquals(buildTierMode({ CAP_BUILD_TIER: value }), "force", value);
  }
  for (const value of ["", "skip", "off", "0", "false", undefined, "selective"]) {
    assertEquals(buildTierMode({ CAP_BUILD_TIER: value }), "selective", String(value));
  }
});

// ---------------------------------------------------------------------------------------------------
// The record: written only for a PASS, and only trusted when it names this exact key.
// ---------------------------------------------------------------------------------------------------

Deno.test("record: only an exit-0 run of a named tier is recorded and read back", async () => {
  const dir = scratchDir();
  try {
    const refused: Array<[{ key: string, suites: string[], exitCode: number, dir: string | null }, { written: boolean, reason: string }]> = [
      [{ key: KEY_A, suites: ["tests/build-smoke.test.ts"], exitCode: 1, dir }, { written: false, reason: "tier-did-not-exit-0" }],
      [{ key: KEY_A, suites: [], exitCode: 0, dir }, { written: false, reason: "no-suites" }],
      [{ key: "not-a-key", suites: ["tests/build-smoke.test.ts"], exitCode: 0, dir }, { written: false, reason: "invalid-key" }],
      [{ key: KEY_A, suites: ["tests/build-smoke.test.ts"], exitCode: 0, dir: null }, { written: false, reason: "no-record-dir" }],
    ];
    for (const [args, expected] of refused) assertEquals(await recordBuildTierPass(args), expected);
    assertEquals(await readBuildTierRecord({ key: KEY_A, dir }), null, "a refused call leaves nothing to read");

    assertEquals(await recordBuildTierPass({ key: KEY_A, suites: ["tests/build-smoke.test.ts"], exitCode: 0, dir }), { written: true, reason: "written" });
    const record = await readBuildTierRecord({ key: KEY_A, dir });
    assertEquals(record?.key, KEY_A);
    assertEquals(record?.suites, ["tests/build-smoke.test.ts"]);

    assertEquals(await readBuildTierRecord({ key: KEY_B, dir }), null, "another key's record is not this key's");
    assertEquals(await readBuildTierRecord({ key: KEY_A, dir: null }), null);
    assertEquals(await readBuildTierRecord({ key: "../../etc/passwd", dir }), null, "a key is not a path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("record: a malformed or key-mismatched file is refused, never trusted", async () => {
  const dir = scratchDir();
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${KEY_A}.json`);
    await writeFile(file, "{not json");
    assertEquals(await readBuildTierRecord({ key: KEY_A, dir }), null);
    await writeFile(file, JSON.stringify({ key: KEY_B, at: "2026-10-17T00:00:00.000Z" }));
    assertEquals(await readBuildTierRecord({ key: KEY_A, dir }), null, "the body must name the key it is filed under");
    await writeFile(file, JSON.stringify({ key: KEY_A }));
    assertEquals(await readBuildTierRecord({ key: KEY_A, dir }), null, "a record without a timestamp cannot justify a skip");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// resolveBuildTier: the one entry point the runner uses, over an injected tree.
// ---------------------------------------------------------------------------------------------------

Deno.test("resolveBuildTier: unchanged inputs skip, one changed chunk runs, the version stamp is not a difference", async () => {
  const trees: Record<string, Record<string, string>> = {
    first: { "build.mjs": "build A", "package.json": JSON.stringify({ version: V1 }) },
    next: { "build.mjs": "build A", "package.json": JSON.stringify({ version: V2 }) },
    changed: { "build.mjs": "build B", "package.json": JSON.stringify({ version: V2 }) },
  };
  const collectFor = (files: Record<string, string>) => async () => {
    const version = JSON.parse(files["package.json"]).version;
    return Object.entries(files).map(([path, body]) => {
      const bytes = encoder.encode(body);
      return { path, sha256: digest(versionNeutralBytes(bytes, version)), bytes: bytes.length };
    });
  };
  const dir = scratchDir();
  // The runner walks the real tree for its path set and the injected reader supplies the content, so
  // this exercises the real closure + the real decision without a checkout per case.
  const paths = (await collectBuildTierInputPaths({ root: ROOT })).paths;
  const realCollect = async ({ version }: { version?: string | null }) => {
    // Only paths present in the case tree contribute; everything else is absent in that tree.
    const files = trees.__current as Record<string, string>;
    const entries = [];
    for (const rel of paths) {
      const body = files[rel];
      if (body === undefined) continue;
      const bytes = encoder.encode(body);
      entries.push({ path: rel, sha256: digest(versionNeutralBytes(bytes, version ?? null)), bytes: bytes.length });
    }
    return entries;
  };
  try {
    trees.__current = trees.first;
    const first = await resolveBuildTier({ root: ROOT, version: V1, recordDir: dir, collect: realCollect });
    assertEquals(first.run, true, "the first tree has no record and must run");
    await recordBuildTierPass({ key: first.key as string, suites: ["tests/build-smoke.test.ts"], exitCode: 0, dir });

    trees.__current = trees.next;
    const next = await resolveBuildTier({ root: ROOT, version: V2, recordDir: dir, collect: realCollect });
    assertEquals(next.run, false, "the version bump alone must not re-run a 92-146s tier");

    trees.__current = trees.changed;
    const changed = await resolveBuildTier({ root: ROOT, version: V2, recordDir: dir, collect: realCollect });
    assertEquals(changed.run, true, "one changed build-machinery byte must re-run the tier");

    trees.__current = trees.next;
    const forced = await resolveBuildTier({ root: ROOT, version: V2, mode: "force", recordDir: dir, collect: realCollect });
    assertEquals(forced.run, true, "force overrides a matching record");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // keep the injected-collector signature honest: no argument beyond the ones the module passes.
  assert(typeof collectFor === "function");
});

Deno.test("real inputs: an imported helper's bytes are in the key (the dependency the list missed)", async () => {
  const entries = await collectBuildTierInputs({ root: ROOT, version: "0.0.0" });
  const paths = entries.map((entry) => entry.path);
  for (const rel of ["scripts/lib/process-tree.ts", "scripts/browser-dependencies.mjs", "scripts/dist-complete.mjs"]) {
    assert(paths.includes(rel), `${rel} is executed by the tier and must be digested`);
  }
  assertEquals(entries.length, paths.length, "no duplicate paths");
});

// ---------------------------------------------------------------------------------------------------
// The landing bump: the stamp surfaces are rewritten on every landing and must not change the key.
// ---------------------------------------------------------------------------------------------------

Deno.test("inputs: a simulated landing bump over the real stamp surfaces keeps the key", async () => {
  // scripts/bump-version.mjs rewrites exactly these three shapes on every landing. This replays that
  // rewrite over a real directory (so the real walk and the real file reads are exercised) and requires
  // the key to be unchanged: otherwise the tier would re-run on every landing and the skip would never
  // fire — the failure mode that is silent, because everything still passes.
  const dir = scratchDir();
  const stamp = (version: string) => ({
    "package.json": JSON.stringify({ name: "cap", version, scripts: { test: "node x" } }, null, 2) + "\n",
    "package-lock.json": JSON.stringify({ name: "cap", version, lockfileVersion: 3, packages: { "": { name: "cap", version } } }, null, 2) + "\n",
    "extension/manifest.json": JSON.stringify({ manifest_version: 3, version, version_name: version }, null, 2) + "\n",
  });
  const write = async (files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), body);
    }
  };
  try {
    await write({ ...stamp(V1), "build.mjs": "// build\n" });
    const before = await collectBuildTierInputPaths({ root: dir });
    const beforeKey = buildTierKey(await collectBuildTierInputs({ root: dir, version: V1, paths: before.paths }));

    await write(stamp(V2)); // the landing bump, same file set
    const after = await collectBuildTierInputPaths({ root: dir });
    const afterKey = buildTierKey(await collectBuildTierInputs({ root: dir, version: V2, paths: after.paths }));

    assert(beforeKey !== null, "the simulated tree must produce a key");
    assertEquals(after.paths, before.paths, "the bump must not change the input SET");
    assertEquals(afterKey, beforeKey, "a landing version bump must not invalidate the recorded PASS");

    await write({ "build.mjs": "// build, changed\n" });
    assertNotEquals(buildTierKey(await collectBuildTierInputs({ root: dir, version: V2, paths: after.paths })), afterKey, "a machinery change still must");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("inputs: the tree's version stamp appears ONLY in the files the landing bump rewrites", async () => {
  // The substitution above can only remove the tree's CURRENT version. If some other input starts
  // carrying it, that file keys differently on the next landing and the tier silently stops skipping.
  // This guard names the invariant so the next person meets it as a failing test, not as a mystery.
  const version = JSON.parse(decoder.decode(await readFile(join(ROOT, "package.json")))).version as string;
  // Every surface scripts/bump-version.mjs rewrites: the two JSON manifests, the lockfile, and the
  // bundled-tool inventory's top-level `release` (CAP-FB-20260825-INVENTORY-DRIFT-01). The inventory
  // reached this key through the import closure, which is why it is named here rather than assumed.
  const stampedByLandingBump = new Set([
    "package.json",
    "package-lock.json",
    "extension/manifest.json",
    "extension/lib/bundled-inventory-data.js",
  ]);
  const carriers: string[] = [];
  // Known-binary extensions carry no text stamp; skipping them keeps this guard at ~50ms instead of
  // reading the ~58MB of Wasm and image inputs in the key.
  const binary = /\.(?:wasm|bin|png|jpe?g|gif|webp|avif|zip|gz|br|woff2?|ttf|otf|so|dylib|node|pdf|pyc)$/;
  const { paths } = await collectBuildTierInputPaths({ root: ROOT });
  for (const rel of paths) {
    if (binary.test(rel)) continue;
    let text: string;
    try {
      text = decoder.decode(await readFile(join(ROOT, rel)));
    } catch {
      continue; // binary input: no text stamp to carry
    }
    if (text.includes(version)) carriers.push(rel);
  }
  assertEquals(
    carriers.filter((rel) => !stampedByLandingBump.has(rel)),
    [],
    `version ${version} appears in build-tier inputs that scripts/bump-version.mjs does not rewrite. ` +
      "Either stop keying those files (see the header of scripts/lib/build-tier-inputs.mjs) or teach the bump to stamp them.",
  );
});

// ---------------------------------------------------------------------------------------------------
// The call site: the runner reaches the decision through the shared resolver, and records only on PASS.
// ---------------------------------------------------------------------------------------------------

Deno.test("build-gate call site: selection goes through resolveBuildTier and the record is written only on success", async () => {
  const source = await readFile(join(ROOT, "scripts/build-gate.ts"), "utf8");
  assert(source.includes("resolveBuildTier("), "the runner must use the shared resolver, not its own git delta");
  assert(source.includes("recordBuildTierPass("), "a PASS must be recorded, or the tier can never skip");
  assert(!/\bgit\b/.test(source), "selection must not read a ref, a merge base or a remote (the gate-full.mjs finding class)");
  // The record call sits inside the success branch: `if (rc === 0) { ... recordBuildTierPass(...)`.
  const success = source.indexOf("if (rc === 0)");
  const record = source.indexOf("recordBuildTierPass(");
  assert(success !== -1 && record > success, "recordBuildTierPass must be reachable only from the rc === 0 branch");
  assert(source.includes("CAP_BUILD_TIER"), "the force switch is documented at the call site");
});

Deno.test("build-gate call site: the everything-gate (test:all) FORCES the tier, so the nightly cannot inherit the skip", async () => {
  // Selection answers "can these three tests tell this tree apart from one that passed them?".
  // `npm run test:all` is the everything-gate: it must run them regardless, or the nightly — the tier
  // the TEST-TIERS-PROPOSAL calls "Selective & Nightly" — silently stops executing build behaviour.
  const scripts = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).scripts;
  const all: string = scripts["test:all"];
  assert(typeof all === "string", "test:all must exist");
  assert(/CAP_BUILD_TIER=force\s+npm run test:build/.test(all), "test:all must force the build tier (CAP_BUILD_TIER=force npm run test:build)");
  assert(all.includes("npm run test:build"), "the tier must still be named in test:all");
});

Deno.test("record dir: an unresolvable record dir makes the tier run, never skip", () => {
  // buildTierRecordDir answers null when the durable root cannot be resolved (or an override is blank),
  // and readBuildTierRecord then refuses to certify a key: the decision falls back to "run".
  const dir = buildTierRecordDir({ CAP_BUILD_TIER_RECORD_DIR: "" });
  assert(dir === null || dir.endsWith(BUILD_TIER_RECORD_DIR_NAME), `unexpected record dir ${String(dir)}`);
  assertEquals(buildTierDecision({ entries: [{ path: "build.mjs", sha256: "1".repeat(64) }], record: null }).run, true);
});

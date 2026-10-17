// tests/build-tier-inputs.test.ts — the build-behaviour tier's SELECTION rule (chrome-agent-platform-6gk81).
//
// scripts/lib/build-tier-inputs.mjs decides whether `npm run test:build` can skip its three in-place
// build tests because the tree's build machinery is byte-identical to a tree that already passed them.
// That decision is the only thing standing between a 92s-per-landing gate line and a silently UNRUN
// build tier, so it is pinned by execution here, not by a structural grep alone:
//
//   * MEMBERSHIP: a path that changes what a build-behaviour assertion can see is an input; a product
//     path is not. Both directions are asserted, because an over-broad key silently disables the skip
//     (that direction is merely slow) and an over-narrow one silently hides a change (that direction
//     is a coverage hole). Product paths are named explicitly so a future pattern cannot swallow them.
//   * VERSION-NEUTRALITY: the landing bump rewrites the version on every landing, so a key that saw it
//     could never match. Two trees that differ ONLY in the version stamp must key identically, and a
//     real byte change must not.
//   * THE DECISION TABLE: only a record whose key equals the computed key may skip. No mode other than
//     an exact match skips, and `CAP_BUILD_TIER` cannot spell "skip" — buildTierMode refuses it.
//   * THE RECORD: a record is written only for exit 0 (a failed tier can never license a skip), and a
//     record that is missing, malformed, or filed under another key is refused.
//   * THE CALL SITE: scripts/build-gate.ts must reach the decision through resolveBuildTier and write
//     the record only on its success path, so the structural half of the argument cannot drift.
//
// Every test here is pure or uses its own scratch directory: no test depends on another's order, on
// machine state outside that directory, or on a real build.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_TIER_RECORD_DIR_NAME,
  VERSION_PLACEHOLDER,
  buildTierDecision,
  buildTierKey,
  buildTierMode,
  buildTierRecordDir,
  collectBuildTierInputPaths,
  collectBuildTierInputs,
  isBuildTierInput,
  readBuildTierRecord,
  recordBuildTierPass,
  resolveBuildTier,
  versionNeutralBytes,
} from "../scripts/lib/build-tier-inputs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------------------------------
// Membership: what the tier's verdict depends on, in both directions.
// ---------------------------------------------------------------------------------------------------

Deno.test("build-tier inputs: the build machinery, its tests, and its input trees are inputs", () => {
  const inputs = [
    "build.mjs",
    "scripts/build-gate.ts",
    "scripts/build-if-needed.mjs",
    "scripts/build-bundled-tool-packages.mjs",
    "scripts/package-archive.mjs",
    "scripts/bump-version.mjs",
    "scripts/changelog-delta.mjs",
    "scripts/test-partition.mjs",
    "scripts/lib/build-lock.mjs",
    "scripts/lib/build-concurrency.mjs",
    "scripts/lib/dist-complete.mjs",
    "scripts/lib/copy-built-tree.mjs",
    "scripts/lib/wasm-manifest-assets.mjs",
    "tests/build-bootstrap.test.ts",
    "tests/build-debug-mode.test.ts",
    "tests/build-tool-bundling.test.ts",
    "tests/build-smoke.test.ts",
    "tests/fixtures/build-once.mjs",
    "packages/bundled/pyodide/inventory.json",
    "packages/bundled/evidence/image.wasm",
    "wasm-tools/jsonpath/tool.wasm",
    "extension/manifest.json",
    "package.json",
    "package-lock.json",
    "deno.lock",
    "deno.runner.jsonc",
  ];
  for (const path of inputs) assert(isBuildTierInput(path), `${path} changes what the build tier can see and must be an input`);
});

Deno.test("build-tier inputs: product sources, the changelog, and unrelated tests are NOT inputs", () => {
  // If one of these ever becomes an input, every landing keys differently (the version/CHANGELOG stamp
  // is rewritten by scripts/bump-version.mjs on each landing) and the tier can never skip. The fix for
  // that is the pattern list, not a wider key.
  const notInputs = [
    "CHANGELOG.md",
    "extension/background/service-worker.js",
    "extension/shared/components-core.js",
    "docs/components-core.js",
    "tests/journey-focus-fail-closed.test.ts",
    "tests/backup-restore.test.ts",
    "scripts/run-tests.mjs",
    "scripts/select-tests.mjs",
    "scripts/lib/parallel-schedule.mjs",
    "README.md",
    "",
  ];
  for (const path of notInputs) assert(!isBuildTierInput(path), `${path} is product/doc/selector surface and must not gate the build tier`);
});

// ---------------------------------------------------------------------------------------------------
// Version neutrality: the landing stamp is not an input.
// ---------------------------------------------------------------------------------------------------

// Sentinel versions, not a plausible project version: the key substitutes the tree's CURRENT
// version, so a test that embedded a real release number would itself key differently on the landing
// that bumps to it (and the stamp-surface guard below would rightly fail). 999.x is unreachable.
const V1 = "999.0.0";
const V2 = "999.0.1";

Deno.test("build-tier inputs: the tree's own version stamp does not change the key, a real byte does", () => {
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

Deno.test("build-tier inputs: binary content is hashed as-is (a version string in a blob is not a stamp)", () => {
  const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x39, 0x39, 0x39, 0x2e, 0x30, 0x2e, 0x30]); // "\xff\xfe\x00999.0.0"
  assertEquals(versionNeutralBytes(binary, V1), binary);
});

Deno.test("build-tier inputs: the key is order-independent, and null when nothing could be digested", () => {
  const a = { path: "build.mjs", sha256: "1".repeat(64) };
  const b = { path: "package.json", sha256: "2".repeat(64) };
  assertEquals(buildTierKey([a, b]), buildTierKey([b, a]));
  assertEquals(buildTierKey([]), null);
  assertNotEquals(buildTierKey([a, b]), buildTierKey([a, { path: b.path, sha256: "3".repeat(64) }]));
});

// ---------------------------------------------------------------------------------------------------
// The decision table, and the missing skip switch.
// ---------------------------------------------------------------------------------------------------

Deno.test("build-tier decision: only an exact recorded PASS in selective mode skips", () => {
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

Deno.test("build-tier mode: CAP_BUILD_TIER can force a run and cannot switch the tier off", () => {
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

Deno.test("build-tier record: only an exit-0 run of a named tier is recorded and read back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cap-build-tier-"));
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

Deno.test("build-tier record: a malformed or key-mismatched file is refused, never trusted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cap-build-tier-bad-"));
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
// resolveBuildTier: the one entry point the runner uses, exercised with an injected reader.
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
  const dir = await mkdtemp(join(tmpdir(), "cap-build-tier-resolve-"));
  try {
    // The PASS is recorded on the first version; the next landing bumps it with the same machinery.
    const first = await resolveBuildTier({ root: ROOT, version: V1, recordDir: dir, collect: collectFor(trees.first) });
    assertEquals(first.run, true, "the first tree has no record and must run");
    await recordBuildTierPass({ key: first.key as string, suites: ["tests/build-smoke.test.ts"], exitCode: 0, dir });

    const next = await resolveBuildTier({ root: ROOT, version: V2, recordDir: dir, collect: collectFor(trees.next) });
    assertEquals(next.run, false, "the version bump alone must not re-run a 92s tier");

    const changed = await resolveBuildTier({ root: ROOT, version: V2, recordDir: dir, collect: collectFor(trees.changed) });
    assertEquals(changed.run, true, "one changed build-machinery byte must re-run the tier");

    const forced = await resolveBuildTier({ root: ROOT, version: V2, mode: "force", recordDir: dir, collect: collectFor(trees.next) });
    assertEquals(forced.run, true, "force overrides a matching record");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// The real tree: the walk reaches the machinery, and is deterministic.
// ---------------------------------------------------------------------------------------------------

Deno.test("build-tier inputs: the real checkout's walk is deterministic and reaches the build machinery", async () => {
  const paths = await collectBuildTierInputPaths({ root: ROOT });
  for (const required of ["build.mjs", "scripts/build-gate.ts", "tests/build-bootstrap.test.ts", "package.json"]) {
    assert(paths.includes(required), `${required} must be in the walk`);
  }
  assert(paths.some((path) => path.startsWith("packages/bundled/")), "the bundled-tool generator inputs must be in the walk");
  assert(!paths.includes("CHANGELOG.md"), "the changelog is rewritten on every landing and must not gate the tier");
  assertEquals(paths, [...paths].sort(), "the walk is sorted");
  assertEquals(new Set(paths).size, paths.length, "the walk has no duplicates");
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

// ---------------------------------------------------------------------------------------------------
// The landing bump: the stamp surfaces are rewritten on every landing and must not change the key.
// ---------------------------------------------------------------------------------------------------

Deno.test("build-tier inputs: a simulated landing bump over the real stamp surfaces keeps the key", async () => {
  // scripts/bump-version.mjs rewrites exactly these three shapes on every landing. This replays that
  // rewrite over a real directory (so the real walk and the real file reads are exercised) and requires
  // the key to be unchanged: otherwise the tier would re-run on every landing and the skip would never
  // fire — the failure mode that is silent, because everything still passes.
  const dir = await mkdtemp(join(tmpdir(), "cap-build-tier-bump-"));
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
    const before = buildTierKey(await collectBuildTierInputs({ root: dir, version: V1 }));

    await write(stamp(V2)); // the landing bump, same file set
    const after = buildTierKey(await collectBuildTierInputs({ root: dir, version: V2 }));

    assert(before !== null, "the simulated tree must produce a key");
    assertEquals(after, before, "a landing version bump must not invalidate the recorded PASS");

    await write({ "build.mjs": "// build, changed\n" });
    assertNotEquals(buildTierKey(await collectBuildTierInputs({ root: dir, version: V2 })), after, "a machinery change still must");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("build-tier inputs: the tree's version stamp appears ONLY in the files the landing bump rewrites", async () => {
  // The substitution above can only remove the tree's CURRENT version. If some other input starts
  // carrying it, that file keys differently on the next landing and the tier silently stops skipping.
  // This guard names the invariant so the next person meets it as a failing test, not as a mystery.
  const version = JSON.parse(decoder.decode(await readFile(join(ROOT, "package.json")))).version as string;
  const stampedByLandingBump = new Set(["package.json", "package-lock.json", "extension/manifest.json"]);
  const carriers: string[] = [];
  // Known-binary extensions carry no text stamp; skipping them keeps this guard at ~50ms instead of
  // reading the ~58MB of Wasm and image inputs in the key.
  const binary = /\.(?:wasm|bin|png|jpe?g|gif|webp|avif|zip|gz|br|woff2?|ttf|otf|so|dylib|node|pdf|pyc)$/;
  for (const rel of await collectBuildTierInputPaths({ root: ROOT })) {
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

Deno.test("build-tier record dir: an unresolvable record dir makes the tier run, never skip", () => {
  // buildTierRecordDir answers null when the durable root cannot be resolved (or an override is blank),
  // and readBuildTierRecord then refuses to certify a key: the decision falls back to "run".
  const dir = buildTierRecordDir({ CAP_BUILD_TIER_RECORD_DIR: "" });
  assert(dir === null || dir.endsWith(BUILD_TIER_RECORD_DIR_NAME), `unexpected record dir ${String(dir)}`);
  assertEquals(buildTierDecision({ entries: [{ path: "build.mjs", sha256: "1".repeat(64) }], record: null }).run, true);
});

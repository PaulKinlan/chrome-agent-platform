// @ts-nocheck
// bbz3s: check the package AJV REALLY resolves before either build target bundles it.
// Fixture stores are isolated under durable scratch; NEVER mutate shared node_modules.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { assertLiveFastUriResolution } from "../scripts/bundle-budget.mjs";

Deno.test("bbz3s: pre-bundle guard covers developer and store targets", async () => {
  const source = await Deno.readTextFile(new URL("../build.mjs", import.meta.url));
  const check = source.indexOf("assertLiveFastUriResolution({");
  const plugin = source.indexOf("const capAiSdkDedup =");
  // jjsz: build.mjs fans out through settleAll, never Promise.all (a rejected sibling must not keep
  // writing into STAGE after the rollback removes it; tests/build-parallel-discipline.test.ts pins
  // that rule). This anchor is the FIRST such fan-out after the plugin definition, as it always was.
  const builds = source.indexOf("await settleAll([", plugin);
  assert(check > 0 && check < plugin && plugin < builds,
    "the live AJV-to-fast-uri resolution must be checked before bundling in BOTH build targets");
  assertStringIncludes(source, 'execFileSync("deno", ["install", "--frozen-lockfile"]',
    "even an SDK-missing auto-install cannot silently rewrite deno.lock");
});

Deno.test("bbz3s: stale, mixed, flat and dangling AJV links fail closed against BOTH locks", () => {
  const roots: string[] = [];
  const fixture = (versions: string[], target: string, options: { sdk?: string; deno?: string; shadow?: string } = {}) => {
    // Node caches require.resolve results: each case needs a FRESH root, just
    // as each build is a fresh Node process. Repointing one link mid-test can
    // read Node's old resolver cache rather than the disk state under test.
    const root = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "layout-" });
    roots.push(root);
    const sdkDir = join(root, "node_modules", ".deno", "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol", "sdk");
    const ajvDir = join(sdkDir, "node_modules", "ajv");
    const store = (version: string) => join(root, "node_modules", ".deno", `fast-uri@${version}`, "node_modules", "fast-uri");
    Deno.mkdirSync(join(ajvDir, "node_modules"), { recursive: true });
    Deno.mkdirSync(join(ajvDir, "dist", "runtime"), { recursive: true });
    Deno.writeTextFileSync(join(ajvDir, "dist", "runtime", "uri.js"), 'module.exports = require("fast-uri");\n');
    Deno.writeTextFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", version: options.sdk ?? "1.31.0" }));
    Deno.writeTextFileSync(join(ajvDir, "package.json"), JSON.stringify({ name: "ajv", version: "8.20.0" }));
    for (const version of versions) {
      Deno.mkdirSync(store(version), { recursive: true });
      Deno.writeTextFileSync(join(store(version), "package.json"), JSON.stringify({ name: "fast-uri", version }));
    }
    const flat = join(root, "node_modules", "fast-uri");
    if (target === "flat") {
      Deno.mkdirSync(flat, { recursive: true });
      Deno.writeTextFileSync(join(flat, "package.json"), JSON.stringify({ name: "fast-uri", version: "3.1.8" }));
    }
    Deno.symlinkSync(target === "flat" ? flat : store(target), join(ajvDir, "node_modules", "fast-uri"));
    if (options.shadow) {
      const nested = join(ajvDir, "dist", "runtime", "node_modules");
      Deno.mkdirSync(nested, { recursive: true });
      Deno.symlinkSync(store(options.shadow), join(nested, "fast-uri"));
    }
    Deno.writeTextFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "node_modules/fast-uri": { version: "3.1.8", integrity: "sha512-test" },
      "node_modules/@modelcontextprotocol/sdk": { version: "1.31.0" },
    } }));
    Deno.writeTextFileSync(join(root, "deno.lock"), JSON.stringify({ npm: {
      [`fast-uri@${options.deno ?? "3.1.8"}`]: { integrity: options.deno ? "sha512-old" : "sha512-test" },
      "@modelcontextprotocol/sdk@1.31.0_zod@3.25.76": { integrity: "sha512-sdk" },
      "@modelcontextprotocol/sdk@1.31.0_zod@4.4.3": { integrity: "sha512-sdk" },
    } }));
    return { root, sdkDir, expected: join(store("3.1.8"), "package.json") };
  };
  try {
    // Old store ONLY: both locks are patched but AJV resolves vulnerable bytes.
    const stale = assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.5"], "3.1.5")),
      Error, "cap-security-dependency-resolve:");
    assertStringIncludes(stale.message, "fast-uri 3.1.5");
    assertStringIncludes(stale.message, "fast-uri 3.1.8");
    // Both directories present: checking for patched-dir PRESENCE would pass.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.5", "3.1.8"], "3.1.5"))).message,
      "fast-uri 3.1.5");
    // The actual importer is Ajv dist/runtime/uri.js, not Ajv package.json:
    // even a correct package-root link can be shadowed by a nested old copy.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.5", "3.1.8"], "3.1.8", { shadow: "3.1.5" }))).message, "fast-uri 3.1.5");
    const good = fixture(["3.1.8"], "3.1.8");
    const current = assertLiveFastUriResolution(good);
    assertEquals(current.version, "3.1.8");
    assertEquals(current.path, good.expected);
    // Same version in FLAT npm copy is not the Deno-store copy esbuild expects.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.8"], "flat"))).message,
      "npm and Deno locks require");
    const dangling = assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.8"], "3.1.6")),
      Error, "cap-security-dependency-resolve:");
    assertStringIncludes(dangling.message, "SDK -> AJV -> fast-uri cannot resolve");
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.8"], "3.1.8", { deno: "3.1.5" }))).message, "fast-uri locks disagree");
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.8"], "3.1.8", { sdk: "1.30.0" }))).message, "MCP SDK lock vs selected Deno-store instance");
  } finally {
    for (const root of roots) Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("c1e3s: symlinked node_modules or .deno store fails with actionable recovery message", () => {
  const root = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "symlink-root-" });
  const realStore = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "real-store-" });
  try {
    // Case 1: root/node_modules is a symlink to realStore
    Deno.symlinkSync(realStore, join(root, "node_modules"));
    const err = assertThrows(
      () => assertLiveFastUriResolution({ root, sdkDir: join(realStore, "sdk") }),
      Error,
      "cap-security-dependency-resolve:",
    );
    assertStringIncludes(err.message, "is a SYMLINK →");
    assertStringIncludes(err.message, "rm -rf node_modules && npm ci && deno install");
    assertStringIncludes(err.message, "never run deno install alone against a symlinked store");

    // Case 2: root/node_modules is real dir, but root/node_modules/.deno is a symlink
    Deno.removeSync(join(root, "node_modules"));
    Deno.mkdirSync(join(root, "node_modules"), { recursive: true });
    Deno.symlinkSync(realStore, join(root, "node_modules", ".deno"));
    const err2 = assertThrows(
      () => assertLiveFastUriResolution({ root, sdkDir: join(realStore, "sdk") }),
      Error,
      "cap-security-dependency-resolve:",
    );
    assertStringIncludes(err2.message, "is a SYMLINK →");
    assertStringIncludes(err2.message, "rm -rf node_modules && npm ci && deno install");
    assertStringIncludes(err2.message, "never run deno install alone against a symlinked store");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(realStore, { recursive: true });
  }
});

Deno.test("c1e3s: build.mjs refuses symlinked node_modules and .deno store BEFORE automatic deno install repair", async () => {
  const buildScript = await Deno.readTextFile(new URL("../build.mjs", import.meta.url));
  const preRepairBlock = buildScript.match(/const nmDir = path\.join\(ROOT, "node_modules"\);[\s\S]*?(?=let denoEntries = \[\];)/);
  assert(preRepairBlock, "build.mjs must contain pre-repair symlink guard before let denoEntries");
  assertStringIncludes(preRepairBlock[0], 'lstatSync(nmDir).isSymbolicLink()', "pre-repair guard must check nmDir");
  assertStringIncludes(preRepairBlock[0], 'lstatSync(denoStoreDir).isSymbolicLink()', "pre-repair guard must check denoStoreDir");
  const repairCallIndex = buildScript.indexOf('execFileSync("deno", ["install", "--frozen-lockfile"]');
  assert(repairCallIndex > 0, "build.mjs must contain repair call");
  assert(buildScript.indexOf('const nmDir = path.join(ROOT, "node_modules");') < repairCallIndex,
    "pre-repair symlink check must execute before any repair execFileSync call");

  // Dynamic execution test: run the pre-repair logic against mock layouts
  const tmp = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "build-guard-" });
  const realStore = Deno.makeTempDirSync({ dir: durableDir("bbz3s-live-resolution"), prefix: "real-store-" });
  try {
    const testRunner = `
import fs, { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
const ROOT = process.argv[2];
${preRepairBlock[0]}
console.log("GUARD_PASSED");
`;
    const runnerScript = join(tmp, "runner.mjs");
    Deno.writeTextFileSync(runnerScript, testRunner);

    // Test 1: symlinked node_modules
    const worktree1 = join(tmp, "wt1");
    Deno.mkdirSync(worktree1, { recursive: true });
    Deno.symlinkSync(realStore, join(worktree1, "node_modules"));
    const p1 = await new Deno.Command("node", { args: [runnerScript, worktree1] }).output();
    assertEquals(p1.code, 1);
    const err1 = new TextDecoder().decode(p1.stderr);
    assertStringIncludes(err1, "cap-security-dependency-resolve:");
    assertStringIncludes(err1, "is a SYMLINK →");
    assertStringIncludes(err1, "rm -rf node_modules && npm ci && deno install");

    // Test 2: real node_modules, symlinked .deno
    const worktree2 = join(tmp, "wt2");
    Deno.mkdirSync(join(worktree2, "node_modules"), { recursive: true });
    Deno.symlinkSync(realStore, join(worktree2, "node_modules", ".deno"));
    const p2 = await new Deno.Command("node", { args: [runnerScript, worktree2] }).output();
    assertEquals(p2.code, 1);
    const err2 = new TextDecoder().decode(p2.stderr);
    assertStringIncludes(err2, "cap-security-dependency-resolve:");
    assertStringIncludes(err2, "is a SYMLINK →");
    assertStringIncludes(err2, "rm -rf node_modules && npm ci && deno install");

    // Test 3: verify remediation command applicability on both layout shapes
    const pRm1 = await new Deno.Command("sh", { args: ["-c", "rm -rf node_modules"], cwd: worktree1 }).output();
    assertEquals(pRm1.code, 0);
    assertThrows(() => Deno.lstatSync(join(worktree1, "node_modules")), Deno.errors.NotFound);
    assertEquals(Deno.statSync(realStore).isDirectory, true, "realStore must not be deleted by symlink removal");

    const pRm2 = await new Deno.Command("sh", { args: ["-c", "rm -rf node_modules"], cwd: worktree2 }).output();
    assertEquals(pRm2.code, 0);
    assertThrows(() => Deno.lstatSync(join(worktree2, "node_modules")), Deno.errors.NotFound);
    assertEquals(Deno.statSync(realStore).isDirectory, true, "realStore must not be deleted by directory removal");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
    Deno.removeSync(realStore, { recursive: true });
  }
});

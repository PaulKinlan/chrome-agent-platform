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
  const builds = source.indexOf("await Promise.all([", plugin);
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
      Deno.writeTextFileSync(join(flat, "package.json"), JSON.stringify({ name: "fast-uri", version: "3.1.7" }));
    }
    Deno.symlinkSync(target === "flat" ? flat : store(target), join(ajvDir, "node_modules", "fast-uri"));
    if (options.shadow) {
      const nested = join(ajvDir, "dist", "runtime", "node_modules");
      Deno.mkdirSync(nested, { recursive: true });
      Deno.symlinkSync(store(options.shadow), join(nested, "fast-uri"));
    }
    Deno.writeTextFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "node_modules/fast-uri": { version: "3.1.7", integrity: "sha512-test" },
      "node_modules/@modelcontextprotocol/sdk": { version: "1.31.0" },
    } }));
    Deno.writeTextFileSync(join(root, "deno.lock"), JSON.stringify({ npm: {
      [`fast-uri@${options.deno ?? "3.1.7"}`]: { integrity: options.deno ? "sha512-old" : "sha512-test" },
      "@modelcontextprotocol/sdk@1.31.0_zod@3.25.76": { integrity: "sha512-sdk" },
      "@modelcontextprotocol/sdk@1.31.0_zod@4.4.3": { integrity: "sha512-sdk" },
    } }));
    return { root, sdkDir, expected: join(store("3.1.7"), "package.json") };
  };
  try {
    // Old store ONLY: both locks are patched but AJV resolves vulnerable bytes.
    const stale = assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.5"], "3.1.5")),
      Error, "cap-security-dependency-resolve:");
    assertStringIncludes(stale.message, "fast-uri 3.1.5");
    assertStringIncludes(stale.message, "fast-uri 3.1.7");
    // Both directories present: checking for patched-dir PRESENCE would pass.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.5", "3.1.7"], "3.1.5"))).message,
      "fast-uri 3.1.5");
    // The actual importer is Ajv dist/runtime/uri.js, not Ajv package.json:
    // even a correct package-root link can be shadowed by a nested old copy.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.5", "3.1.7"], "3.1.7", { shadow: "3.1.5" }))).message, "fast-uri 3.1.5");
    const good = fixture(["3.1.7"], "3.1.7");
    const current = assertLiveFastUriResolution(good);
    assertEquals(current.version, "3.1.7");
    assertEquals(current.path, good.expected);
    // Same version in FLAT npm copy is not the Deno-store copy esbuild expects.
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.7"], "flat"))).message,
      "npm and Deno locks require");
    const dangling = assertThrows(() => assertLiveFastUriResolution(fixture(["3.1.7"], "3.1.6")),
      Error, "cap-security-dependency-resolve:");
    assertStringIncludes(dangling.message, "SDK -> AJV -> fast-uri cannot resolve");
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.7"], "3.1.7", { deno: "3.1.5" }))).message, "fast-uri locks disagree");
    assertStringIncludes(assertThrows(() => assertLiveFastUriResolution(
      fixture(["3.1.7"], "3.1.7", { sdk: "1.30.0" }))).message, "MCP SDK lock vs selected Deno-store instance");
  } finally {
    for (const root of roots) Deno.removeSync(root, { recursive: true });
  }
});

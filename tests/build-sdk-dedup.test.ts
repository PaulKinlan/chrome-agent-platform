import { assert } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

Deno.test("cap-ai-sdk-dedup layout behaviors", async (t) => {
  const ROOT = Deno.cwd();

  const buildScript = await Deno.readTextFile("build.mjs");
  const extractMatch = buildScript.match(/let denoEntries = \[\];[\s\S]*?(?=const isStoreBuild =)/);
  if (!extractMatch) throw new Error("Could not extract guard logic");
  // These pre-existing fixtures exercise ONLY canonical SDK/zod peer selection,
  // including a legacy flat Mac layout. The separate bbz3s fixture suite tests
  // the live AJV -> fast-uri dependency guard with actual .deno paths/locks.
  // Require the production check to remain in the build before excluding its
  // call from this SDK-only scratch extraction (never bypass it in build.mjs).
  const dependencyCheck = "assertLiveFastUriResolution({ root: ROOT, sdkDir: CANON_MCP_SDK_DIR });";
  assert(extractMatch[0].split(dependencyCheck).length === 2,
    "live dependency check must appear once after canonical SDK selection and before bundling");
  const sdkSelectionLogic = extractMatch[0].replace(dependencyCheck, "/* dependency check separately covered by bbz3s fixtures */");

  const guardLogic = `
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const execFileSync = () => { fs.mkdirSync(denoStoreDir, { recursive: true }); }; // Mock auto-install for tests
const { readdirSync, rmSync } = fs;
function realpathSync(p) { return fs.realpathSync(p); }
const ROOT = process.cwd();
const denoStoreDir = path.join(ROOT, "node_modules", ".deno");
let BUILD_TARGET = "developer";
${sdkSelectionLogic}
console.log("GUARD_PASSED");
`;

  async function mkPkg(nm: string, name: string) {
    const p = path.join(nm, name);
    await Deno.mkdir(p, { recursive: true });
    await Deno.writeTextFile(path.join(p, "package.json"), JSON.stringify({ name, main: "index.js" }));
    await Deno.writeTextFile(path.join(p, "index.js"), "");
  }

  await t.step("Mac-style npm layout (no .deno) passes guard", async () => {
    const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-sdkdedup-" });
    try {
      await Deno.writeTextFile(path.join(tmp, "package.json"), `{"name":"test"}`);
      const nm = path.join(tmp, "node_modules");
      await mkPkg(nm, "zod");
      await Deno.mkdir(path.join(nm, "zod", "v4"));
      await Deno.writeTextFile(path.join(nm, "zod", "v4", "index.js"), "");
      await mkPkg(nm, "@ai-sdk/anthropic");
      await mkPkg(nm, "@ai-sdk/provider-utils");
      await mkPkg(nm, "@modelcontextprotocol/sdk");
      
      await Deno.writeTextFile(path.join(tmp, "guard.mjs"), guardLogic);
      const cmd = new Deno.Command("node", { args: ["guard.mjs"], cwd: tmp });
      const { code, stdout, stderr } = await cmd.output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);
      assert(out.includes("GUARD_PASSED"), "Expected guard to pass\\n" + err);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  await t.step("Deno layout with zod@3 + zod@4 passes by selecting zod@3", async () => {
    const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-sdkdedup-" });
    try {
      await Deno.writeTextFile(path.join(tmp, "package.json"), `{"name":"test"}`);
      const nm = path.join(tmp, "node_modules");
      await mkPkg(nm, "@ai-sdk/anthropic");
      await mkPkg(nm, "@ai-sdk/provider-utils");
      
      const denoStore = path.join(nm, ".deno");
      
      // Hoisted real zods in .deno
      await mkPkg(path.join(denoStore, "zod@3.25.76", "node_modules"), "zod");
      await mkPkg(path.join(denoStore, "zod@4.4.3", "node_modules"), "zod");
      await Deno.mkdir(path.join(denoStore, "zod@3.25.76", "node_modules", "zod", "v4"));
      await Deno.writeTextFile(path.join(denoStore, "zod@3.25.76", "node_modules", "zod", "v4", "index.js"), "");

      // Symlink the canonical zod
      await Deno.symlink(
        path.join(denoStore, "zod@3.25.76", "node_modules", "zod"),
        path.join(nm, "zod"),
        { type: "dir" }
      );
      
      // Candidate 1 (bound to zod@3)
      await mkPkg(path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol"), "sdk");
      await Deno.symlink(
        path.join(denoStore, "zod@3.25.76", "node_modules", "zod"),
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "zod"),
        { type: "dir" }
      );

      // Candidate 2 (bound to zod@4)
      await mkPkg(path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0_1", "node_modules", "@modelcontextprotocol"), "sdk");
      await Deno.symlink(
        path.join(denoStore, "zod@4.4.3", "node_modules", "zod"),
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0_1", "node_modules", "zod"),
        { type: "dir" }
      );

      // Symlink root sdk to Candidate 2 to test that requireFromRoot mismatch triggers the fallback loop!
      await Deno.mkdir(path.join(nm, "@modelcontextprotocol"), { recursive: true });
      await Deno.symlink(
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0_1", "node_modules", "@modelcontextprotocol", "sdk"),
        path.join(nm, "@modelcontextprotocol", "sdk"),
        { type: "dir" }
      );

      await Deno.writeTextFile(path.join(tmp, "guard.mjs"), guardLogic);
      const cmd = new Deno.Command("node", { args: ["guard.mjs"], cwd: tmp });
      const { code, stdout, stderr } = await cmd.output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);
      assert(out.includes("GUARD_PASSED"), "Expected guard to PASS by selecting candidate 1\\n" + err);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  await t.step("Throws when NO zod@3-bound entry exists", async () => {
    const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-sdkdedup-" });
    try {
      await Deno.writeTextFile(path.join(tmp, "package.json"), `{"name":"test"}`);
      const nm = path.join(tmp, "node_modules");
      await mkPkg(nm, "@ai-sdk/anthropic");
      await mkPkg(nm, "@ai-sdk/provider-utils");
      
      const denoStore = path.join(nm, ".deno");
      
      await mkPkg(path.join(denoStore, "zod@3.25.76", "node_modules"), "zod");
      await mkPkg(path.join(denoStore, "zod@4.4.3", "node_modules"), "zod");
      await Deno.mkdir(path.join(denoStore, "zod@3.25.76", "node_modules", "zod", "v4"));
      await Deno.writeTextFile(path.join(denoStore, "zod@3.25.76", "node_modules", "zod", "v4", "index.js"), "");

      await Deno.symlink(
        path.join(denoStore, "zod@3.25.76", "node_modules", "zod"),
        path.join(nm, "zod"),
        { type: "dir" }
      );
      
      // Candidate 1 (bound to zod@4 instead of zod@3)
      await mkPkg(path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol"), "sdk");
      await Deno.symlink(
        path.join(denoStore, "zod@4.4.3", "node_modules", "zod"),
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "zod"),
        { type: "dir" }
      );

      // Symlink root sdk to Candidate 1
      await Deno.mkdir(path.join(nm, "@modelcontextprotocol"), { recursive: true });
      await Deno.symlink(
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol", "sdk"),
        path.join(nm, "@modelcontextprotocol", "sdk"),
        { type: "dir" }
      );

      await Deno.writeTextFile(path.join(tmp, "guard.mjs"), guardLogic);
      const cmd = new Deno.Command("node", { args: ["guard.mjs"], cwd: tmp });
      const { code, stdout, stderr } = await cmd.output();
      const err = new TextDecoder().decode(stderr);
      assert(err.includes("no @modelcontextprotocol/sdk instance is bound to the extension's zod"), "Expected guard to FAIL when no entry matches");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  await t.step("Passes when root SDK is bound to zod@3 and a dual-zod .deno store is present", async () => {
    const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-sdkdedup-" });
    try {
      await Deno.writeTextFile(path.join(tmp, "package.json"), `{"name":"test"}`);
      const nm = path.join(tmp, "node_modules");
      await mkPkg(nm, "@ai-sdk/anthropic");
      await mkPkg(nm, "@ai-sdk/provider-utils");
      
      const denoStore = path.join(nm, ".deno");
      
      // Hoisted real zods in .deno
      await mkPkg(path.join(denoStore, "zod@3.25.76", "node_modules"), "zod");
      await mkPkg(path.join(denoStore, "zod@4.4.3", "node_modules"), "zod");
      await Deno.mkdir(path.join(denoStore, "zod@3.25.76", "node_modules", "zod", "v4"));
      await Deno.writeTextFile(path.join(denoStore, "zod@3.25.76", "node_modules", "zod", "v4", "index.js"), "");

      // Symlink the canonical zod
      await Deno.symlink(
        path.join(denoStore, "zod@3.25.76", "node_modules", "zod"),
        path.join(nm, "zod"),
        { type: "dir" }
      );
      
      // Candidate 1 (bound to zod@3)
      await mkPkg(path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol"), "sdk");
      await Deno.symlink(
        path.join(denoStore, "zod@3.25.76", "node_modules", "zod"),
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "zod"),
        { type: "dir" }
      );

      // Candidate 2 (bound to zod@4)
      await mkPkg(path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0_1", "node_modules", "@modelcontextprotocol"), "sdk");
      await Deno.symlink(
        path.join(denoStore, "zod@4.4.3", "node_modules", "zod"),
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0_1", "node_modules", "zod"),
        { type: "dir" }
      );

      // Symlink root sdk to Candidate 1 (this is the regression case: it's ALREADY bound to zod@3)
      await Deno.mkdir(path.join(nm, "@modelcontextprotocol"), { recursive: true });
      await Deno.symlink(
        path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol", "sdk"),
        path.join(nm, "@modelcontextprotocol", "sdk"),
        { type: "dir" }
      );

      await Deno.writeTextFile(path.join(tmp, "guard.mjs"), guardLogic);
      const cmd = new Deno.Command("node", { args: ["guard.mjs"], cwd: tmp });
      const { code, stdout, stderr } = await cmd.output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);
      assert(out.includes("GUARD_PASSED"), "Expected guard to PASS when root SDK is already correct\\n" + err);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  await t.step("npm-flat mixed layout (flat zod + stale .deno SDK) fails loudly with the exact remediation", async () => {
    const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-sdkdedup-" });
    try {
      await Deno.writeTextFile(path.join(tmp, "package.json"), `{"name":"test"}`);
      const nm = path.join(tmp, "node_modules");
      // Flat (npm) zod at the root — the extension's canonical zod. This is the
      // layout `npm ci`/`npm install` produces when run AFTER `deno install`.
      await mkPkg(nm, "zod");
      await Deno.mkdir(path.join(nm, "zod", "v4"));
      await Deno.writeTextFile(path.join(nm, "zod", "v4", "index.js"), "");
      await mkPkg(nm, "@ai-sdk/anthropic");
      await mkPkg(nm, "@ai-sdk/provider-utils");
      // Flat SDK whose own node_modules pins a DIFFERENT zod, so its zod peer is
      // not the root zod — mirrors the npm-flat/deno mix Paul hit.
      await mkPkg(nm, "@modelcontextprotocol/sdk");
      await mkPkg(path.join(nm, "@modelcontextprotocol", "sdk", "node_modules"), "zod");

      // A stale .deno store that already has SDK entries, so the mixed-layout
      // auto-heal branch runs (rmSync + `deno install`) rather than plain bd06.
      const denoStore = path.join(nm, ".deno");
      await mkPkg(path.join(denoStore, "@modelcontextprotocol+sdk@1.31.0", "node_modules", "@modelcontextprotocol"), "sdk");
      await mkPkg(path.join(denoStore, "zod@3.25.76", "node_modules"), "zod");

      await Deno.writeTextFile(path.join(tmp, "guard.mjs"), guardLogic);
      const cmd = new Deno.Command("node", { args: ["guard.mjs"], cwd: tmp });
      const { code, stdout, stderr } = await cmd.output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);
      assert(!out.includes("GUARD_PASSED"), "Expected guard to FAIL on the npm-flat mixed layout\\n" + err);
      assert(err.includes("no @modelcontextprotocol/sdk instance is bound to the extension's zod"), "Expected the fail-closed anchor\\n" + err);
      assert(err.includes("npm-flat"), "Expected the failure to name the npm-flat zod\\n" + err);
      assert(err.includes("rm -rf node_modules && npm ci && deno install"), "Expected the exact remediation order\\n" + err);
      assert(err.includes("deno install MUST run LAST"), "Expected the LAST-ordering warning\\n" + err);
      assert(err.includes("re-running npm ci/npm install after deno install"), "Expected the re-introduce warning\\n" + err);
      assert(err.includes("stale node_modules/.deno"), "Expected the stale .deno warning\\n" + err);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

});

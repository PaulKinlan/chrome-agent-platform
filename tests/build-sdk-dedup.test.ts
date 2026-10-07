import { assert } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";

Deno.test("cap-ai-sdk-dedup layout behaviors", async (t) => {
  const ROOT = Deno.cwd();

  const buildScript = await Deno.readTextFile("build.mjs");
  const extractMatch = buildScript.match(/let denoEntries = \[\];[\s\S]*?(?=const isStoreBuild =)/);
  if (!extractMatch) throw new Error("Could not extract guard logic");
  
  const guardLogic = `
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { execFileSync } from "child_process";
const { readdirSync } = fs;
function realpathSync(p) { return fs.realpathSync(p); }
const ROOT = process.cwd();
const denoStoreDir = path.join(ROOT, "node_modules", ".deno");
let BUILD_TARGET = "developer";
${extractMatch[0]}
console.log("GUARD_PASSED");
`;

  async function mkPkg(nm: string, name: string) {
    const p = path.join(nm, name);
    await Deno.mkdir(p, { recursive: true });
    await Deno.writeTextFile(path.join(p, "package.json"), JSON.stringify({ name, main: "index.js" }));
    await Deno.writeTextFile(path.join(p, "index.js"), "");
  }

  await t.step("Mac-style npm layout (no .deno) passes guard", async () => {
    const tmp = await Deno.makeTempDir();
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
    const tmp = await Deno.makeTempDir();
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
    const tmp = await Deno.makeTempDir();
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
    const tmp = await Deno.makeTempDir();
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

});

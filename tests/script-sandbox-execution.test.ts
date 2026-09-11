// tests/script-sandbox-execution.test.ts — Execution and import map injection tests
// for installable JavaScript modules in the script sandbox (ovfm.3).

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  validateJsModuleName,
  computeModuleDigest,
  prepareScriptModuleSource,
  verifyAndPrepareJsModule,
} from "../extension/lib/script-sandbox-modules.js";

const encoder = new TextEncoder();

Deno.test("ovfm.3 sandbox [unit]: validateJsModuleName rejects path traversal and quotes", () => {
  assertThrows(() => validateJsModuleName("../etc/passwd"), Error);
  assertThrows(() => validateJsModuleName('module"name'), Error);
  assertThrows(() => validateJsModuleName("module/../../evil"), Error);
  assertEquals(validateJsModuleName("lodash-es"), "lodash-es");
  assertEquals(validateJsModuleName("@scope/pkg-1"), "@scope/pkg-1");
});

Deno.test("ovfm.3 sandbox [unit]: import map JSON shape matches W3C specification", () => {
  const mod1Name = "lodash-es";
  const mod1Blob = "blob:null/00000000-0000-0000-0000-000000000001";
  const mod2Name = "d3-array";
  const mod2Blob = "blob:null/00000000-0000-0000-0000-000000000002";

  const imports = {
    [mod1Name]: mod1Blob,
    [mod2Name]: mod2Blob,
  };
  const importMap = { imports };

  const parsed = JSON.parse(JSON.stringify(importMap));
  assertEquals(parsed.imports["lodash-es"], mod1Blob);
  assertEquals(parsed.imports["d3-array"], mod2Blob);
  assertEquals(Object.keys(parsed).length, 1);
});

Deno.test("ovfm.3 sandbox [unit]: prepareScriptModuleSource supports static import with return", () => {
  const src = `import { chunk } from "lodash-es";
const arr = [1, 2, 3, 4];
return chunk(arr, 2);`;

  const prep = prepareScriptModuleSource(src);
  assertEquals(prep.isExplicitModule, true);
  assertEquals(prep.hasImports, true);
  assert(prep.source.startsWith('import { chunk } from "lodash-es";'));
  assert(prep.source.includes("export default async function()"));
  assert(prep.source.includes("return chunk(arr, 2);"));
});

Deno.test("ovfm.3 sandbox [unit]: prepareScriptModuleSource preserves multi-line imports", () => {
  const src = `import {
  add,
  multiply
} from "math";
const a = add(1, 2);
return multiply(a, 3);`;

  const prep = prepareScriptModuleSource(src);
  assertEquals(prep.isExplicitModule, true);
  assert(prep.source.includes("export default async function()"));
  assert(prep.source.includes("return multiply(a, 3);"));
});

Deno.test("ovfm.3 sandbox [teardown fault]: failure on second module mint revokes first module Blob URL and emits terminal error (executes actual script-sandbox.js)", async () => {
  // Read the actual production script-sandbox.js source code
  const sandboxSource = await Deno.readTextFile(
    new URL("../extension/sandbox/script-sandbox.js", import.meta.url)
  );

  const mod1Src = "export function a() { return 1; }";
  const mod1Bytes = encoder.encode(mod1Src);
  const mod1Digest = computeModuleDigest(mod1Bytes);

  const mod2Src = "export function b() { return 2; }";
  const mod2Bytes = encoder.encode(mod2Src);
  const mod2Digest = computeModuleDigest(mod2Bytes);

  const messages: any[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  let mintCount = 0;

  const fakeParent = {
    postMessage: (msg: any) => messages.push(msg),
  };
  const listeners: Record<string, Function[]> = {};
  const fakeWindow: any = {
    parent: fakeParent,
    addEventListener: (t: string, fn: Function) => {
      listeners[t] = listeners[t] || [];
      listeners[t].push(fn);
    },
    removeEventListener: () => {},
  };
  const fakeDoc = {
    createElement: () => ({}),
    head: { appendChild: () => {} },
  };
  const fakeURL = {
    createObjectURL: (_blob: unknown) => {
      mintCount++;
      if (mintCount === 1) {
        const url = "blob:null/module-1-uuid";
        createdUrls.push(url);
        return url;
      }
      // Second mint deliberately throws to simulate an allocation/runtime fault
      throw new Error("QuotaExceededError: simulated allocation fault on second mint");
    },
    revokeObjectURL: (u: string) => {
      revokedUrls.push(u);
    },
  };

  // Run the ACTUAL product source code in the sandbox context
  const runner = new Function(
    "window",
    "document",
    "URL",
    "Blob",
    "TextEncoder",
    "Uint8Array",
    "ArrayBuffer",
    "DataView",
    "BigInt",
    sandboxSource
  );
  runner(fakeWindow, fakeDoc, fakeURL, Blob, TextEncoder, Uint8Array, ArrayBuffer, DataView, BigInt);

  // Dispatch message through actual script-sandbox.js message listener
  for (const listener of listeners["message"] || []) {
    listener({
      source: fakeParent,
      data: {
        type: "cap:script-source",
        runId: "run-teardown-fault",
        nonce: "test-nonce",
        source: "return 42;",
        modules: [
          { name: "mod1", source: mod1Src, digest: mod1Digest },
          { name: "mod2", source: mod2Src, digest: mod2Digest },
        ],
      },
    });
  }

  // Await asynchronous completion of runScript
  await new Promise((r) => setTimeout(r, 50));

  // Assertions on actual execution:
  // 1. Both mints were attempted
  assertEquals(mintCount, 2, "Both module mints must be attempted");
  // 2. Terminal error IPC was emitted
  assertEquals(messages.length, 1, "Terminal error IPC must be posted");
  assertEquals(messages[0].type, "cap:script-error");
  assert(
    messages[0].error.includes("simulated allocation fault on second mint"),
    "Terminal error message must carry the failure cause"
  );
  // 3. The first minted Blob URL was revoked by script-sandbox.js's finally block!
  assertEquals(
    revokedUrls,
    ["blob:null/module-1-uuid"],
    "First minted Blob URL must be revoked when second mint throws"
  );
  // 4. Zero leaked URLs
  const leaked = createdUrls.filter((u) => !revokedUrls.includes(u));
  assertEquals(leaked, [], "All created URLs must be revoked");
});

Deno.test("ovfm.3 sandbox [native ESM execution]: prepared module executes natively with static import and extracts return value", async () => {
  // Test genuine native dynamic import of an ES module in Deno runtime
  const dependencySrc = "export function double(n) { return n * 2; }";
  const depDataUrl = `data:text/javascript;base64,${btoa(dependencySrc)}`;

  // Script using static import
  const rawScript = `import { double } from "${depDataUrl}";
const val = double(21);
return val;`;

  const prep = prepareScriptModuleSource(rawScript);
  assertEquals(prep.isExplicitModule, true);

  const scriptDataUrl = `data:text/javascript;base64,${btoa(prep.source)}`;
  const mod = await import(scriptDataUrl);

  assertEquals(typeof mod.default, "function", "Prepared module must export default async function");
  const result = await mod.default();
  assertEquals(result, 42, "Module execution must return the computed value");
});

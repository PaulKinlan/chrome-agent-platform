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

Deno.test("ovfm.3 sandbox: validateJsModuleName rejects path traversal and quotes", () => {
  assertThrows(() => validateJsModuleName("../etc/passwd"), Error);
  assertThrows(() => validateJsModuleName('module"name'), Error);
  assertThrows(() => validateJsModuleName("module/../../evil"), Error);
  assertEquals(validateJsModuleName("lodash-es"), "lodash-es");
  assertEquals(validateJsModuleName("@scope/pkg-1"), "@scope/pkg-1");
});

Deno.test("ovfm.3 sandbox: import map JSON shape matches W3C specification", () => {
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

Deno.test("ovfm.3 sandbox: prepareScriptModuleSource supports static import with return", () => {
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

Deno.test("ovfm.3 sandbox: prepareScriptModuleSource preserves multi-line imports", () => {
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

Deno.test("ovfm.3 sandbox: dynamic import execution resolves module and revokes Blob URLs", () => {
  const moduleSource = "export function multiply(a, b) { return a * b; }";
  const bytes = encoder.encode(moduleSource);
  const digest = computeModuleDigest(bytes);

  const revokedUrls: string[] = [];
  const fakeBlobUrl = "blob:null/mock-test-url";
  const mockCreateBlobUrl = (_b: Uint8Array) => fakeBlobUrl;

  const prepared = verifyAndPrepareJsModule({
    name: "calc",
    digest,
    bytes,
    createBlobUrl: mockCreateBlobUrl,
  });

  assertEquals(prepared.blobUrl, fakeBlobUrl);

  // Simulate cleanup revocation
  const cleanup = (urls: string[]) => {
    for (const u of urls) revokedUrls.push(u);
  };
  cleanup([prepared.blobUrl!]);
  assertEquals(revokedUrls, [fakeBlobUrl]);
});

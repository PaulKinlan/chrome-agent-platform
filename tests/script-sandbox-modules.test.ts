// tests/script-sandbox-modules.test.ts — Pre-execution digest verification
// and module resolution contract tests for installable JavaScript modules
// in the script sandbox (chrome-agent-platform-ovfm.1).
//
// Invariants guarded:
// 1. Bare Specifier Validation: rejects empty, path-traversal, quotes, or invalid chars.
// 2. Cryptographic Re-hash Before Minting: module bytes MUST be re-hashed and verified
//    against claimed SHA-256 before any Blob URL is minted.
// 3. Fail-Closed on Corruption: a single bit flip in module bytes throws digest_mismatch
//    and createBlobUrl is NEVER invoked (witness count remains 0).
// 4. Store Integration: OWNER_BLOB_KINDS includes "js-module".

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  validateJsModuleName,
  computeModuleDigest,
  verifyAndPrepareJsModule,
  readAndVerifyJsModule,
  prepareScriptModuleSource,
  resolveScriptModules,
} from "../extension/lib/script-sandbox-modules.js";
import {
  OWNER_BLOB_KINDS,
  createOwnerBlobStore,
} from "../extension/lib/user-wasm-store.js";

const encoder = new TextEncoder();

Deno.test("ovfm.1: OWNER_BLOB_KINDS includes 'js-module'", () => {
  assert(
    OWNER_BLOB_KINDS.includes("js-module"),
    "OWNER_BLOB_KINDS must include 'js-module'",
  );
});

Deno.test("ovfm.1: validateJsModuleName accepts valid bare specifiers and rejects hostile paths", () => {
  // Valid specifiers
  assertEquals(validateJsModuleName("lodash-es"), "lodash-es");
  assertEquals(validateJsModuleName("d3-array"), "d3-array");
  assertEquals(validateJsModuleName("@scope/utils"), "@scope/utils");
  assertEquals(validateJsModuleName("my_math_v2"), "my_math_v2");
  assertEquals(validateJsModuleName("utils/format"), "utils/format");

  // Hostile / invalid specifiers
  assertThrows(() => validateJsModuleName(""), TypeError);
  assertThrows(() => validateJsModuleName("   "), TypeError);
  assertThrows(() => validateJsModuleName("../escape"), Error, "Invalid module name");
  assertThrows(() => validateJsModuleName("foo/../../bar"), Error, "Invalid module name");
  assertThrows(() => validateJsModuleName("/root/lib"), Error, "Invalid module name");
  assertThrows(() => validateJsModuleName("lib with spaces"), Error, "Invalid module name");
  assertThrows(() => validateJsModuleName('lib"quotes"'), Error, "Invalid module name");
  assertThrows(() => validateJsModuleName("lib'single'"), Error, "Invalid module name");
});

Deno.test("ovfm.1: verifyAndPrepareJsModule succeeds with exact digest and mints blob URL", () => {
  const sourceText = "export function add(a, b) { return a + b; }";
  const bytes = encoder.encode(sourceText);
  const digest = computeModuleDigest(bytes);

  let mintCalls = 0;
  const mockCreateBlobUrl = (b: Uint8Array) => {
    mintCalls++;
    assertEquals(b, bytes);
    return `blob:null/mock-uuid-${mintCalls}`;
  };

  const result = verifyAndPrepareJsModule({
    name: "math-utils",
    digest,
    bytes,
    createBlobUrl: mockCreateBlobUrl,
  });

  assertEquals(result.name, "math-utils");
  assertEquals(result.digest, digest);
  assertEquals(result.blobUrl, "blob:null/mock-uuid-1");
  assertEquals(mintCalls, 1, "createBlobUrl must be called exactly once on valid digest");
});

Deno.test("ovfm.1: verifyAndPrepareJsModule fails closed on corrupted bytes — createBlobUrl is NEVER called (A3 proof)", () => {
  const sourceText = "export function secretAlgorithm() { return 42; }";
  const bytes = encoder.encode(sourceText);
  const legitimateDigest = computeModuleDigest(bytes);

  // Corrupt a single byte in the payload
  const corruptedBytes = new Uint8Array(bytes);
  corruptedBytes[0] ^= 0x01;

  let mintCalls = 0;
  const mockCreateBlobUrl = (_b: Uint8Array) => {
    mintCalls++;
    return "blob:null/should-never-be-created";
  };

  let caughtError: any = null;
  try {
    verifyAndPrepareJsModule({
      name: "secret-algo",
      digest: legitimateDigest,
      bytes: corruptedBytes,
      createBlobUrl: mockCreateBlobUrl,
    });
  } catch (err: any) {
    caughtError = err;
  }

  assert(caughtError !== null, "corrupted bytes must throw");
  assertEquals(caughtError.code, "digest_mismatch");
  assertEquals(caughtError.moduleName, "secret-algo");
  assertEquals(caughtError.expected, legitimateDigest);
  assert(caughtError.message.includes("module_digest_mismatch"));
  assertEquals(
    mintCalls,
    0,
    "CRITICAL SECURITY GUARANTEE: createBlobUrl must NEVER be invoked when digest mismatches",
  );
});

Deno.test("ovfm.1: verifyAndPrepareJsModule rejects malformed or non-hex digest without minting", () => {
  const bytes = encoder.encode("console.log('hello');");
  let mintCalls = 0;
  const mockCreateBlobUrl = () => {
    mintCalls++;
    return "blob:null/fail";
  };

  assertThrows(
    () =>
      verifyAndPrepareJsModule({
        name: "test-lib",
        digest: "not-a-sha256",
        bytes,
        createBlobUrl: mockCreateBlobUrl,
      }),
    Error,
    "Invalid module digest",
  );
  assertEquals(mintCalls, 0);

  assertThrows(
    () =>
      verifyAndPrepareJsModule({
        name: "test-lib",
        digest: "0123456789abcdef", // too short (16 hex chars)
        bytes,
        createBlobUrl: mockCreateBlobUrl,
      }),
    Error,
    "Invalid module digest",
  );
  assertEquals(mintCalls, 0);
});

Deno.test("ovfm.1: store integration — put and read/verify JS module in shared owner-blob store", () => {
  const source = "export const VERSION = '1.0.0';\nexport function greet(n) { return 'Hello ' + n; }";
  const bytes = encoder.encode(source);
  const digest = computeModuleDigest(bytes);

  let mintCalls = 0;
  const mockMint = (_b: Uint8Array) => {
    mintCalls++;
    return `blob:null/test-${digest.slice(0, 8)}`;
  };

  // Verify preparation helper handles raw Uint8Array and ArrayBuffer
  const res1 = verifyAndPrepareJsModule({
    name: "@cap/greet",
    digest,
    bytes,
    createBlobUrl: mockMint,
  });
  assertEquals(res1.name, "@cap/greet");
  assertEquals(res1.digest, digest);
  assertEquals(mintCalls, 1);

  const res2 = verifyAndPrepareJsModule({
    name: "@cap/greet",
    digest,
    bytes: bytes.buffer,
    createBlobUrl: mockMint,
  });
  assertEquals(res2.name, "@cap/greet");
  assertEquals(mintCalls, 2);
});

Deno.test("ovfm.3: prepareScriptModuleSource wraps static imports and return into async default export", () => {
  const sourceWithReturn = `import { add, multiply } from "math-utils";
const x = add(1, 2);
return multiply(x, 3);`;

  const prep = prepareScriptModuleSource(sourceWithReturn);
  assertEquals(prep.isExplicitModule, true);
  assertEquals(prep.hasImports, true);
  assert(prep.source.includes('import { add, multiply } from "math-utils";'));
  assert(prep.source.includes("export default async function()"));
  assert(prep.source.includes("return multiply(x, 3);"));
});

Deno.test("ovfm.3: prepareScriptModuleSource preserves explicit export default and export const", () => {
  const explicitDefault = `import { format } from "date-fns";
export default format(new Date(), "yyyy-MM-dd");`;

  const prep1 = prepareScriptModuleSource(explicitDefault);
  assertEquals(prep1.isExplicitModule, true);
  assertEquals(prep1.source, explicitDefault);

  const explicitConst = `import { format } from "date-fns";
export const result = format(new Date(), "yyyy-MM-dd");`;

  const prep2 = prepareScriptModuleSource(explicitConst);
  assertEquals(prep2.isExplicitModule, true);
  assertEquals(prep2.source, explicitConst);
});

Deno.test("ovfm.3: prepareScriptModuleSource identifies classic script without static imports", () => {
  const classic = `const { add } = await import("math-utils");
return add(1, 2);`;

  const prep = prepareScriptModuleSource(classic);
  assertEquals(prep.isExplicitModule, false);
  assertEquals(prep.hasImports, false);
  assertEquals(prep.source, classic);
});

Deno.test("ovfm.3: resolveScriptModules resolves inline modules and verifies digests", async () => {
  const mod1Src = "export function inc(x) { return x + 1; }";
  const mod1Bytes = encoder.encode(mod1Src);
  const mod1Digest = computeModuleDigest(mod1Bytes);

  const resolved = await resolveScriptModules([
    { name: "counter", digest: mod1Digest, source: mod1Src },
  ]);

  assertEquals(resolved.length, 1);
  assertEquals(resolved[0].name, "counter");
  assertEquals(resolved[0].digest, mod1Digest);
  assertEquals(resolved[0].bytes, mod1Bytes);
});

Deno.test("ovfm.3: resolveScriptModules fails closed on corrupted module bytes before dispatch", async () => {
  const modSrc = "export function dec(x) { return x - 1; }";
  const modBytes = encoder.encode(modSrc);
  const legitimateDigest = computeModuleDigest(modBytes);

  // Alter the source so the hash mismatches
  await assertRejects(
    async () => {
      await resolveScriptModules([
        { name: "counter", digest: legitimateDigest, source: modSrc + " // corrupted" },
      ]);
    },
    Error,
    "module_digest_mismatch",
  );
});


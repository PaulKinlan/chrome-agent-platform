// @ts-nocheck — bounded JWT-decode lane: disabled metadata + the pure decode core
// + the browser-native fresh Worker. No Chrome. No signature verification.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { JWT_DECODE_TOOL, decodeInDedicatedWorker } from "../extension/lib/jwt-decode-tools.js";
import { decodeJwtBounded, LIMITS } from "../extension/lib/jwt-decode-core.js";

Deno.test("jwt-decode: disabled bundled-package descriptor with the exact bounds", () => {
  assertEquals(JWT_DECODE_TOOL.toolId, "jwt_decode_bounded");
  assertEquals(JWT_DECODE_TOOL.sourceKind, "bundled-package");
  assertEquals(JWT_DECODE_TOOL.canonicalNameClaim, false);
  assertEquals(JWT_DECODE_TOOL.admitted, false);
  assertEquals(JWT_DECODE_TOOL.canExecute, false);
  assertEquals(JWT_DECODE_TOOL.canGrant, false);
  assertEquals(JWT_DECODE_TOOL.availability, "disabled");
  assertEquals(JWT_DECODE_TOOL.replayClass, "read-only");
  assertEquals(JWT_DECODE_TOOL.spdxLicense, "MIT");
  assertEquals(LIMITS.maxTokenBytes, Number.POSITIVE_INFINITY, "dptw: no token byte limit");
  assertEquals(LIMITS.maxJsonDepth, 32, "parse-recursion grammar bound stays");
  assertEquals(LIMITS.maxOutputBytes, Number.POSITIVE_INFINITY, "dptw: no output byte limit");
  assert(["compute", "data.read"].every((c) => JWT_DECODE_TOOL.capabilities.includes(c)), "capabilities");
});

Deno.test("jwt-decode: the core decodes a valid token with verified:false + the untrusted warning", () => {
  const result = decodeJwtBounded("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln");
  assertEquals(result.verified, false);
  assertEquals(result.header.alg, "HS256");
  assertEquals(result.payload.sub, "123");
  assertEquals(
    result.warnings[0],
    "WARNING: JWT signature was not verified; header and payload claims are untrusted.",
  );
});

Deno.test("jwt-decode: the core rejects a 5-component JWE and an enc header", () => {
  assertThrows(() => decodeJwtBounded("a.b.c.d.e"), Error, "JWE");
  const encHeader = "eyJlbmMiOiJBMTI4R0NNIn0.e30.c2ln";
  assertThrows(() => decodeJwtBounded(encHeader), Error, "JWE");
});

Deno.test("jwt-decode: no token size limit (dptw); duplicate keys still reject", () => {
  // A token past the removed 16 KiB limit decodes (a 20 KiB payload claim).
  const bigClaim = "x".repeat(20000);
  const b64 = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const bigToken = `${b64({ alg: "none" })}.${b64({ big: bigClaim })}.`;
  const decoded = decodeJwtBounded(bigToken);
  assertEquals(decoded.payload.big, bigClaim, "a past-limit token decodes whole");
  const dup = "eyJhbGciOiJIUzI1NiIsImFsZyI6Im5vbmUifQ.e30.c2ln";
  assertThrows(() => decodeJwtBounded(dup), Error, "duplicate");
});

Deno.test("jwt-decode: the browser Worker path is a fresh Worker per call with no main-thread fallback", async () => {
  const originalWorker = globalThis.Worker;
  const calls = [];
  try {
    globalThis.Worker = class {
      constructor(url, opts) {
        calls.push({ url: String(url), opts });
        this.onmessage = null;
        this.onerror = null;
      }
      postMessage(request) {
        const result = decodeJwtBounded(request.params.token);
        queueMicrotask(() => {
          if (this.onmessage) this.onmessage({ data: { schemaVersion: 1, id: request.id, ok: true, result } });
        });
      }
      terminate() {}
    };
    const result = await decodeInDedicatedWorker("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln");
    assertEquals(result.verified, false);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, new URL("../extension/lib/jwt-decode-worker.js", import.meta.url).href);
    assertEquals(calls[0].opts.type, "module");
  } finally {
    globalThis.Worker = originalWorker;
  }
});

Deno.test("jwt-decode: a missing Worker constructor fails closed (no fallback)", async () => {
  const originalWorker = globalThis.Worker;
  try {
    globalThis.Worker = undefined;
    await assertRejects(
      () => decodeInDedicatedWorker("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln"),
    );
  } finally {
    globalThis.Worker = originalWorker;
  }
});

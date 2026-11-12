// @ts-nocheck
// ko4h6: the shared versioned injective model-stream owner codec.
// Pins: length-prefixed v2 format, exact round-trip for colon-bearing tuples,
// no legacy/prefix inference, <=1024 UTF-8 bytes, malformed input decodes null.
import {
  encodeModelStreamOwner,
  decodeModelStreamOwner,
  isModelStreamOwner,
} from "../extension/lib/wasm-stream-owner-codec.js";
import { assertEquals } from "jsr:@std/assert@1";
import { validExecutionId } from "../extension/lib/durable-runs.js";

function assert(condition, message = "assertion failed") { if (!condition) throw new Error(message); }
function equal(actual, expected, message = "values differ") {
  if (actual !== expected) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function throwsCode(fn, code) {
  try { fn(); } catch (error) { if (error?.code === code) return; throw new Error(`wrong code: ${error?.code}`); }
  throw new Error(`expected throw with code ${code}`);
}

Deno.test("ko4h6 codec: v2 owners round-trip exactly, including colon-bearing tuples", () => {
  for (const [runId, agentId] of [
    ["acp:aaaaaaaa", "b:c"],
    ["acp:aaaaaaaa:b", "c"],
    ["exec:123e4567-e89b-12d3-a456-426614174000", "named:alice:sub"],
    ["execution-1", "hub"],
    ["run:with:colons:9", "agent:with:colons:9"],
  ]) {
    const owner = encodeModelStreamOwner(runId, agentId);
    const decoded = decodeModelStreamOwner(owner);
    assert(decoded, `owner must decode: ${owner}`);
    equal(decoded.runId, runId);
    equal(decoded.agentId, agentId);
    equal(isModelStreamOwner(owner), true);
    assert(new TextEncoder().encode(owner).byteLength <= 1024, "owner within the 1024-byte stream bound");
  }
});

Deno.test("ko4h6 codec: tuples that collided under legacy and ':|' encodings are distinct", () => {
  const legacyColliders = encodeModelStreamOwner("acp:aaaaaaaa", "b:c");
  const legacyColliders2 = encodeModelStreamOwner("acp:aaaaaaaa:b", "c");
  assert(legacyColliders !== legacyColliders2, "legacy colon concatenation collision must not recur");
  const pipeColliders = encodeModelStreamOwner("acp:aaaaaaaa", "x:|y");
  const pipeColliders2 = encodeModelStreamOwner("acp:aaaaaaaa:|x", "y");
  assert(pipeColliders !== pipeColliders2, "':|' separator collision must not recur");
  equal(decodeModelStreamOwner(pipeColliders).agentId, "x:|y");
  equal(decodeModelStreamOwner(pipeColliders2).runId, "acp:aaaaaaaa:|x");
});

Deno.test("ko4h6 codec: format is the pinned length-prefixed v2 form", () => {
  equal(encodeModelStreamOwner("acp:aaaaaaaa:b", "hub"), "agent:v2:14:acp:aaaaaaaa:bhub");
  equal(encodeModelStreamOwner("r", "a"), "agent:v2:1:ra");
});

Deno.test("ko4h6 codec: legacy and malformed owners decode to null, never a guessed tuple", () => {
  for (const owner of [
    "agent:acp:aaaaaaaa:b:hub", // legacy ambiguous concatenation
    "agent:acp:aaaaaaaa:|hub", // 7wywc ':|' form — superseded, non-authoritative
    "agent:run-1:hub",
    "owner-options:doc-1", // a different, opaque owner family
    "agent:v2:03:runhub", // non-canonical leading-zero length
    "agent:v2:0:hub", // empty run id
    "agent:v2:3:run", // empty agent id
    "agent:v2:9:runhub", // length overruns the string
    "agent:v2:x:runhub", // non-numeric length
    "agent:v2::runhub", // missing length
    "agent:v3:3:runhub", // unknown version
    "agent:v2:3runhub", // missing separator colon
    "",
    "hub",
  ]) {
    equal(decodeModelStreamOwner(owner), null, `must not decode: ${JSON.stringify(owner)}`);
    equal(isModelStreamOwner(owner), false);
  }
  for (const notString of [null, undefined, 42, {}, ["agent:v2:1:ra"]]) {
    equal(decodeModelStreamOwner(notString), null);
  }
});

Deno.test("n6aj1: the v2/legacy ambiguity is a documented framing fact, closed writer-side", () => {
  // The filed repro: a legacy owner whose run id begins 'v2:<digits>:' parses as the
  // v2 owner of the SHIFTED tuple. The framing cannot refuse it (ko4h6 forbids grammar
  // inference in the codec), so the boundary is the WRITER: the owner lanes gate
  // context.runId through lib/run-id-gate.js's streamOwnerRunIdOrNull (the execution-id
  // grammar), and no valid execution id can begin 'v2:' — the colliding legacy form is
  // unreachable from any writer by construction. This pin documents the decode result
  // as the plain length-prefix arithmetic, NOT as provenance.
  const decoded = decodeModelStreamOwner("agent:v2:3:abc:hub");
  assertEquals(decoded, { runId: "abc", agentId: ":hub" });
  // The grammar refuses the colliding run id shape in every direction.
  assertEquals(validExecutionId("v2:3:abc"), false);
  assertEquals(validExecutionId("agent:v2:3:abc:hub"), false);
});

Deno.test("n6aj1 r2: per-site gate semantics — owner lanes use the owner gate, identity lanes the preview-aware gate", async () => {
  // Round 1's pin matched ONE literal spelling of the gate, which is how an
  // unconditional exec-id gate slipped into the preview lane and refused Settings
  // previews that worked. This pin asserts the SEMANTICS per function slice: the
  // stream-owner function uses the owner gate; each identity lane uses the
  // preview-aware gate; and no raw (ungated) derivation remains anywhere.
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const sliceOf = (name) => {
    const start = sw.indexOf(`async function ${name}`);
    assert(start !== -1, `${name} must exist`);
    const end = sw.indexOf("\nasync function ", start + 1);
    return sw.slice(start, end === -1 ? sw.length : end);
  };
  const ownerFn = sliceOf("dispatchBundledWasmStream");
  assertEquals((ownerFn.match(/streamOwnerRunIdOrNull\(context\.runId\)/g) ?? []).length, 2,
    "both wasm-stream owner derivations must use the OWNER gate (execution ids only)");
  assertEquals((ownerFn.match(/dispatchRunIdOrNull/g) ?? []).length, 0,
    "the owner lane must not use the preview-aware gate — owners are execution ids only");
  for (const lane of ["dispatchEmscriptenRun", "dispatchUserWasmTool"]) {
    const slice = sliceOf(lane);
    assertEquals((slice.match(/dispatchRunIdOrNull\(context\.runId\)/g) ?? []).length, 1,
      `${lane} must use the preview-aware gate — refusing Settings previews was the round-1 regression`);
    assertEquals((slice.match(/streamOwnerRunIdOrNull\(context\.runId\)/g) ?? []).length, 0,
      `${lane} never derives a stream owner`);
    assert(slice.includes("round 2"), `${lane} must carry the written exemption reason`);
  }
  assertEquals((sw.match(/const runId = typeof context\?\.runId === "string" && context\.runId/g) ?? []).length, 0,
    "ungated context.runId derivations must not return");
});

Deno.test("ko4h6 codec: encode refuses empty, non-string, and over-1024-byte identities", () => {
  throwsCode(() => encodeModelStreamOwner("", "hub"), "wasm_stream_owner");
  throwsCode(() => encodeModelStreamOwner("run", ""), "wasm_stream_owner");
  throwsCode(() => encodeModelStreamOwner(null, "hub"), "wasm_stream_owner");
  throwsCode(() => encodeModelStreamOwner("run", undefined), "wasm_stream_owner");
  throwsCode(() => encodeModelStreamOwner("r".repeat(600), "a".repeat(600)), "wasm_stream_owner");
  // UTF-8 bytes, not code units: 400 two-byte chars + 300 ascii exceeds 1024 bytes after framing.
  throwsCode(() => encodeModelStreamOwner("é".repeat(400), "a".repeat(300)), "wasm_stream_owner");
  // A decoded owner exactly at the bound is accepted; one byte over is not.
  // Framing is "agent:v2:" + digits + ":" = 10 + digits(runLen) bytes.
  const atBound = encodeModelStreamOwner("r".repeat(1009), "a");
  equal(new TextEncoder().encode(atBound).byteLength, 1024);
  assert(decodeModelStreamOwner(atBound), "at-bound owner decodes");
  equal(decodeModelStreamOwner(`${atBound}x`), null, "over-bound owner never decodes");
});

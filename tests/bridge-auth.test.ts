// tests/bridge-auth.test.ts — unit tests for the bridge message-authentication
// primitive (content/bridge-auth.js):
//  - known-answer vectors pin the SHA-256 + HMAC-SHA256 implementations
//  - canonicalJson is deterministic (sorted keys) so both worlds MAC the same
//    byte string
//  - seal/open round-trip strips seq/tag
//  - a wrong key, a tampered body, a replay, an out-of-order seq, and
//    malformed tags/seqs are all rejected (the round-30 bridge-forgery gate)
// @ts-nocheck — the content script is a plain script; the test imports it for
// its globalThis.CapBridgeAuth side effect.

import { assert, assertEquals } from "jsr:@std/assert@1";

await import("../extension/content/bridge-auth.js");
const auth = globalThis.CapBridgeAuth;

Deno.test("bridge-auth: the primitive is installed + frozen", () => {
  assert(auth, "CapBridgeAuth installed on globalThis");
  assert(Object.isFrozen(auth), "the API surface is frozen");
  assertEquals(typeof auth.seal, "function");
  assertEquals(typeof auth.open, "function");
});

Deno.test("bridge-auth: known-answer SHA-256 + HMAC-SHA256 vectors", () => {
  // FIPS 180-4 / RFC 4231-style known answers pin the dependency-free
  // implementations so a silent regression in the primitive fails loudly.
  assertEquals(
    auth.sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    auth.hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
});

Deno.test("bridge-auth: canonicalJson is deterministic (sorted keys)", () => {
  assertEquals(
    auth.canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
  );
  assertEquals(auth.canonicalJson([3, "x", null, true]), '[3,"x",null,true]');
  assertEquals(auth.canonicalJson(undefined), "null");
  assertEquals(auth.canonicalJson({ f: () => 1 }), '{"f":null}', "functions never enter the MAC'd payload");
});

Deno.test("bridge-auth: seal/open round-trip (seq + tag stripped on open)", () => {
  const key = "test-bridge-key-0123456789abcdef";
  const sealed = auth.seal(key, "down", 0, { type: "invoke", requestId: "r1", name: "greet" });
  assertEquals(sealed.seq, 0);
  assertEquals(typeof sealed.tag, "string");
  assertEquals(sealed.tag.length, 64);
  assert(!JSON.stringify(sealed).includes(key), "the key itself never appears in the sealed message");
  const opened = auth.open(key, "down", -1, sealed);
  assertEquals(opened.ok, true);
  assertEquals(opened.seq, 0);
  assertEquals(opened.msg, { type: "invoke", requestId: "r1", name: "greet" }, "seq/tag are stripped from the opened message");
});

Deno.test("bridge-auth: a wrong key never verifies (the nonce-eavesdrop forgery fails)", () => {
  const sealed = auth.seal("real-key-0000000000000000", "up", 0, { type: "tools", tools: [] });
  // A page script that eavesdropped the broadcast sees only this tag — it
  // cannot recompute it without the key, and a guessed/wrong key fails.
  assertEquals(auth.open("guessed-key-000000000000", "up", -1, sealed).ok, false, "wrong key rejected");
  assertEquals(auth.open(null, "up", -1, sealed).ok, false, "an unarmed (keyless) bridge rejects everything");
});

Deno.test("bridge-auth: a tampered body fails verification", () => {
  const key = "test-bridge-key-0123456789abcdef";
  const sealed = auth.seal(key, "up", 0, { type: "result", requestId: "r1", ok: true, result: "hello" });
  const tampered = { ...sealed, result: "pwned" };
  assertEquals(auth.open(key, "up", -1, tampered).ok, false, "a tampered payload rejected");
  const retyped = { ...sealed, type: "tools" };
  assertEquals(auth.open(key, "up", -1, retyped).ok, false, "a tampered type rejected");
});

Deno.test("bridge-auth: replay + out-of-order sequences are rejected", () => {
  const key = "test-bridge-key-0123456789abcdef";
  const m0 = auth.seal(key, "down", 0, { type: "collect" });
  const m1 = auth.seal(key, "down", 1, { type: "cancel" });
  assertEquals(auth.open(key, "down", -1, m0).ok, true);
  assertEquals(auth.open(key, "down", 0, m0).ok, false, "a replayed message rejected");
  assertEquals(auth.open(key, "down", 1, m0).ok, false, "an out-of-order (older) message rejected");
  assertEquals(auth.open(key, "down", 0, m1).ok, true, "the advancing sequence accepted");
});

Deno.test("bridge-auth: direction separation — a sealed message never verifies on the other direction", () => {
  const key = "test-bridge-key-0123456789abcdef";
  const down = auth.seal(key, "down", 0, { type: "invoke", requestId: "r1" });
  assertEquals(auth.open(key, "up", -1, down).ok, false, "a down message replayed as up rejected");
  const up = auth.seal(key, "up", 0, { type: "result", requestId: "r1", ok: true });
  assertEquals(auth.open(key, "down", -1, up).ok, false, "an up message replayed as down rejected");
});

Deno.test("bridge-auth: malformed seq/tag are rejected", () => {
  const key = "test-bridge-key-0123456789abcdef";
  const sealed = auth.seal(key, "down", 0, { type: "collect" });
  assertEquals(auth.open(key, "down", -1, { ...sealed, seq: -1 }).ok, false, "negative seq");
  assertEquals(auth.open(key, "down", -1, { ...sealed, seq: 1.5 }).ok, false, "fractional seq");
  assertEquals(auth.open(key, "down", -1, { ...sealed, seq: "0" }).ok, false, "string seq");
  assertEquals(auth.open(key, "down", -1, { ...sealed, seq: 2e9 }).ok, false, "out-of-bounds seq");
  assertEquals(auth.open(key, "down", -1, { ...sealed, tag: "x".repeat(64) }).ok, false, "wrong tag");
  assertEquals(auth.open(key, "down", -1, { ...sealed, tag: "short" }).ok, false, "malformed tag");
  assertEquals(auth.open(key, "down", -1, { type: "collect" }).ok, false, "missing seq/tag");
  assertEquals(auth.open(key, "down", -1, null).ok, false, "non-object message");
});

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createSha256, sha256Bytes } from "../extension/lib/pure.js";

const hex = (bytes: Uint8Array) => [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");

Deno.test("incremental SHA-256 matches native WebCrypto across padding, view offsets, and chunk boundaries", async () => {
  for (const size of [0, 1, 2, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 511, 1024]) {
    const buffer = Uint8Array.from({ length: size + 7 }, (_, i) => (i * 131 + 97) & 255);
    const bytes = buffer.subarray(3, 3 + size);
    const expected = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    assertEquals(hex(sha256Bytes(bytes)), expected);
    for (const stride of [1, 3, 55, 56, 63, 64, 65, 127, 1024]) {
      const hash = createSha256();
      hash.update(new Uint8Array());
      for (let i = 0; i < bytes.length; i += stride) hash.update(bytes.subarray(i, i + stride));
      assertEquals(hash.hex(), expected, `size=${size}, stride=${stride}`);
      assertEquals(hash.hex(), expected, "digest is repeatable");
      hash.digest().fill(0);
      assertEquals(hash.hex(), expected, "caller cannot mutate retained digest");
      assertThrows(() => hash.update(new Uint8Array([1])), Error, "finalized");
    }
  }
});

Deno.test("incremental SHA-256 matches the FIPS million-a vector without retaining the message", () => {
  const hash = createSha256();
  const chunk = new Uint8Array(1000).fill(97);
  for (let i = 0; i < 1000; i++) hash.update(chunk);
  assertEquals(hash.hex(), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

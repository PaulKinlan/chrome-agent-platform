// lib/pure-hash.js — the hashing/ids seam (FNV-1a, SHA-256, HMAC, tool-name sanitising)
// extracted from lib/pure.js by chrome-agent-platform-ux4ud. pure.js re-exports all of it.

/**
 * Build a collision-resistant, bounded AI-SDK tool id from an origin + name.
 * Uses a 64-bit FNV-1a (two independent 32-bit rounds) so distinct
 * (origin, name) pairs are astronomically unlikely to collide after
 * punctuation sanitization. The caller additionally checks for duplicates.
 */
export function sanitizeToolName(origin, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const h = fnv1a64(`${origin}\u0000${name}`);
  return `site_${h}_${safe}`.slice(0, 64);
}

/** FNV-1a 32-bit (pure, deterministic, dependency-free). */
export function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** FNV-1a 64-bit: two independent 32-bit FNV rounds, hex-encoded (16 chars).
 * NON-cryptographic — fine for tool-name disambiguation, NEVER for security
 * fingerprints (use sha256Hex / hmacSha256Hex below). */
export function fnv1a64(input) {
  const seedA = 0x811c9dc5, seedB = 0x01000193;
  let a = seedA, b = seedB;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul((a ^ c) >>> 0, 0x01000193) >>> 0;
    b = Math.imul((b ^ (c + 0x9e)) >>> 0, 0x01000193) >>> 0;
  }
  return (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 0).toString(16).padStart(8, "0");
}

/* ── SHA-256 (FIPS 180-4), synchronous + dependency-free ──────────────────
 * The collision-resistant digest for every security-relevant fingerprint
 * (registry content hashes, prompt attestations). Pure JS over UTF-8 BYTES —
 * no WebCrypto (works identically in the SW, pages, Deno tests), no eval
 * (MV3-CSP-safe). Verified against the FIPS test vectors in tests/pure.test.ts.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

// The same compression round serves both whole-buffer and incremental hashing.
function sha256Compress(H, w, bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4);
  for (let i = 16; i < 64; i++) {
    const s0 = (rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
    const s1 = (rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3],
    e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
    const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
  H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
  H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
  H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
}

/** Incremental SHA-256: retains one block, never the full input.
 * Run large-file hashing in a Worker: update() is synchronous CPU work.
 */
export function createSha256() {
  const H = new Uint32Array(SHA256_H0);
  const w = new Uint32Array(64);
  const pending = new Uint8Array(64);
  let used = 0, length = 0n, result = null;
  return {
    update(data) {
      if (result) throw new Error("SHA-256 is already finalized");
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      length += BigInt(bytes.byteLength);
      let offset = 0;
      if (used) {
        const count = Math.min(64 - used, bytes.length);
        pending.set(bytes.subarray(0, count), used);
        used += count;
        offset = count;
        if (used === 64) { sha256Compress(H, w, pending); used = 0; }
      }
      for (; offset + 64 <= bytes.length; offset += 64) {
        sha256Compress(H, w, bytes.subarray(offset, offset + 64));
      }
      if (offset < bytes.length) {
        pending.set(bytes.subarray(offset), used);
        used += bytes.length - offset;
      }
      return this;
    },
    digest() {
      if (!result) {
        const tail = new Uint8Array(used < 56 ? 64 : 128);
        tail.set(pending.subarray(0, used));
        tail[used] = 0x80;
        new DataView(tail.buffer).setBigUint64(tail.length - 8, length * 8n);
        for (let offset = 0; offset < tail.length; offset += 64) {
          sha256Compress(H, w, tail.subarray(offset, offset + 64));
        }
        result = new Uint8Array(32);
        const view = new DataView(result.buffer);
        for (let i = 0; i < 8; i++) view.setUint32(i * 4, H[i]);
      }
      return result.slice();
    },
    hex() { return bytesToHex(this.digest()); },
  };
}

/** SHA-256 over a Uint8Array → the 32-byte digest. */
export function sha256Bytes(data) {
  return createSha256().update(data).digest();
}

function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** SHA-256 over the UTF-8 encoding of a string → 64-char hex. */
export function sha256Hex(text) {
  return bytesToHex(sha256Bytes(new TextEncoder().encode(String(text ?? ""))));
}

/** HMAC-SHA-256 (RFC 2104) over the UTF-8 encoding of `text`, keyed by raw
 * key bytes → 64-char hex. Used for the OPAQUE run/preview attestation
 * receipts: a keyed digest is not dictionary-testable against guessed owner
 * text the way a public stable fingerprint is (the review's privacy finding),
 * because the per-install key never leaves storage. */
export function hmacSha256Hex(keyBytes, text) {
  let key = keyBytes instanceof Uint8Array
    ? keyBytes
    : new TextEncoder().encode(String(keyBytes ?? ""));
  if (key.length > 64) key = sha256Bytes(key);
  const ipad = new Uint8Array(64 + 0);
  const opad = new Uint8Array(64 + 0);
  for (let i = 0; i < 64; i++) {
    const kb = i < key.length ? key[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  const msg = new TextEncoder().encode(String(text ?? ""));
  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad);
  inner.set(msg, 64);
  const innerHash = sha256Bytes(inner);
  const outer = new Uint8Array(64 + innerHash.length);
  outer.set(opad);
  outer.set(innerHash, 64);
  return bytesToHex(sha256Bytes(outer));
}

/* ── UTF-8 accounting (byte-accurate bounds, malformed-Unicode rejection) ── */

/** REAL SHA-256 over raw bytes (a Uint8Array / ArrayBuffer) or the UTF-8
 * encoding of a string → 64-char hex, via WebCrypto. Async, so file-sized
 * inputs (the OPFS workspace CAS, artifact digests, Wasm package bytes) never
 * block the thread; the synchronous `sha256Hex(text)` above stays for the
 * short security fingerprints that must be computable without an await. */
export async function sha256HexBytes(input) {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array
    ? input
    : new Uint8Array(input ?? []);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

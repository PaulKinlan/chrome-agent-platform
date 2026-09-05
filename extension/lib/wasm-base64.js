// lib/wasm-base64.js — canonical standard-base64 helpers for bounded Wasm
// result envelopes. Pure only: no route, Worker, DOM, filesystem or authority.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ENCODE_CHUNK_BYTES = 12 * 1024; // divisible by 3; bounds temporary strings

/** Encode the complete byte sequence as canonical standard base64.
 * Chunks are 3-byte aligned, so padding appears only in the final chunk. */
export function encodeCanonicalBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("base64_bytes");
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += ENCODE_CHUNK_BYTES) {
    const end = Math.min(bytes.byteLength, offset + ENCODE_CHUNK_BYTES);
    let chunk = "";
    for (let index = offset; index < end; index += 3) {
      const remaining = end - index;
      const a = bytes[index];
      const b = remaining > 1 ? bytes[index + 1] : 0;
      const c = remaining > 2 ? bytes[index + 2] : 0;
      chunk += ALPHABET[a >>> 2];
      chunk += ALPHABET[((a & 0x03) << 4) | (b >>> 4)];
      chunk += remaining > 1 ? ALPHABET[((b & 0x0f) << 2) | (c >>> 6)] : "=";
      chunk += remaining > 2 ? ALPHABET[c & 0x3f] : "=";
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

/** Strictly decode canonical standard base64. Grammar rejects whitespace,
 * non-ASCII, URL-safe alphabet and misplaced padding; re-encoding rejects
 * non-zero trailing bits and any other noncanonical representation. */
export function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new TypeError("base64_canonical");
  }
  if (value.length === 0) return new Uint8Array();
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let target = 0;
  for (let index = 0; index < value.length; index += 4) {
    const last = index + 4 === value.length;
    const a = ALPHABET.indexOf(value[index]);
    const b = ALPHABET.indexOf(value[index + 1]);
    const c = value[index + 2] === "=" ? -1 : ALPHABET.indexOf(value[index + 2]);
    const d = value[index + 3] === "=" ? -1 : ALPHABET.indexOf(value[index + 3]);
    if (a < 0 || b < 0) throw new TypeError("base64_canonical");
    out[target++] = (a << 2) | (b >>> 4);
    if (c < 0) {
      // One-byte tail: padding is final and the unused four bits are zero.
      if (!last || value[index + 2] !== "=" || value[index + 3] !== "=" || (b & 0x0f) !== 0) {
        throw new TypeError("base64_canonical");
      }
      continue;
    }
    out[target++] = ((b & 0x0f) << 4) | (c >>> 2);
    if (d < 0) {
      // Two-byte tail: one final '=' and the unused two bits are zero.
      if (!last || value[index + 3] !== "=" || (c & 0x03) !== 0) {
        throw new TypeError("base64_canonical");
      }
      continue;
    }
    out[target++] = ((c & 0x03) << 6) | d;
  }
  if (target !== out.byteLength) throw new TypeError("base64_canonical");
  return out;
}

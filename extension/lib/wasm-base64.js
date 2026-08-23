// lib/wasm-base64.js — canonical standard-base64 helpers for bounded Wasm
// result envelopes. Pure only: no route, Worker, DOM, filesystem or authority.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CANONICAL_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
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
  if (typeof value !== "string" || value.length % 4 !== 0 || !CANONICAL_RE.test(value)) {
    throw new TypeError("base64_canonical");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = value.length === 0 ? 0 : (value.length / 4) * 3 - padding;
  const out = new Uint8Array(decodedLength);
  let target = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = ALPHABET.indexOf(value[index]);
    const b = ALPHABET.indexOf(value[index + 1]);
    const c = value[index + 2] === "=" ? 0 : ALPHABET.indexOf(value[index + 2]);
    const d = value[index + 3] === "=" ? 0 : ALPHABET.indexOf(value[index + 3]);
    out[target++] = (a << 2) | (b >>> 4);
    if (value[index + 2] !== "=") {
      out[target++] = ((b & 0x0f) << 4) | (c >>> 2);
    }
    if (value[index + 3] !== "=") {
      out[target++] = ((c & 0x03) << 6) | d;
    }
  }
  if (target !== decodedLength || encodeCanonicalBase64(out) !== value) {
    throw new TypeError("base64_canonical");
  }
  return out;
}

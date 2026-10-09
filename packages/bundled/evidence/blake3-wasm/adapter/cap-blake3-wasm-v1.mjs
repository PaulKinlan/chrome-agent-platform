// cap-blake3-wasm-v1.mjs — CAP-authored adapter for blake3-wasm (connor4312 v3.0.0)
// Emscripten glue class admission (chrome-agent-platform-fh9k).
//
// Binds the declared entry operation (hash) to the exported hash_oneshot function
// using linear memory allocated through _malloc / _free.
//
// Constraints:
//   - ES module, zero eval / dynamic Function constructors.
//   - Isolated execution: input bytes are copied to unshared linear memory.
//   - Returns standard 64-char lowercase hex BLAKE3 digest.

export const ADAPTER_ID = "cap-blake3-wasm-v1";

const enc = new TextEncoder();

/**
 * Create the Blake3 operation surface for one admitted, instantiated module.
 * @param {{exports: Record<string, unknown>}} instance WebAssembly instance / module
 * @returns {{hash: (data: string | Uint8Array) => string}}
 */
export function createBlake3Adapter(instance) {
  const exports = instance?.exports ?? {};
  const fn =
    (typeof exports._hash_oneshot === "function" ? exports._hash_oneshot : null) ??
    (typeof exports.hash_oneshot === "function" ? exports.hash_oneshot : null) ??
    (typeof exports.f === "function" ? exports.f : null);
  const malloc =
    (typeof exports._malloc === "function" ? exports._malloc : null) ??
    (typeof exports.malloc === "function" ? exports.malloc : null) ??
    (typeof exports.h === "function" ? exports.h : null);
  const free =
    (typeof exports._free === "function" ? exports._free : null) ??
    (typeof exports.free === "function" ? exports.free : null) ??
    (typeof exports.o === "function" ? exports.o : null);
  const memory = exports.d ?? exports.memory;

  if (typeof fn !== "function") throw new TypeError("hash_oneshot export missing");
  if (typeof malloc !== "function") throw new TypeError("malloc export missing");
  if (typeof free !== "function") throw new TypeError("free export missing");
  if (!memory || !memory.buffer) throw new TypeError("memory export missing");

  return Object.freeze({
    hash(data) {
      let bytes;
      if (typeof data === "string") {
        bytes = enc.encode(data);
      } else if (data instanceof Uint8Array) {
        bytes = data;
      } else {
        throw new TypeError("data must be a string or Uint8Array");
      }
      if (bytes.byteLength > 4194304) {
        throw new RangeError("data exceeds 4 MiB buffer limit");
      }
      const inPtr = malloc(bytes.byteLength || 1);
      const outPtr = malloc(32);
      try {
        if (bytes.byteLength > 0) {
          new Uint8Array(memory.buffer).set(bytes, inPtr);
        }
        fn(inPtr, bytes.byteLength, outPtr, 32);
        const digestBytes = new Uint8Array(memory.buffer, outPtr, 32);
        let hex = "";
        for (let i = 0; i < 32; i++) {
          hex += digestBytes[i].toString(16).padStart(2, "0");
        }
        return hex;
      } finally {
        free(inPtr);
        free(outPtr);
      }
    },
  });
}

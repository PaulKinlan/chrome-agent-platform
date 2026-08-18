// content/bridge-auth.js — the bridge message-authentication primitive, shared
// by the MAIN-world bridge (content/main-world.js) and the isolated relay
// (content/content-script.js). Injected BEFORE both files (it is a plain
// script, no modules, no chrome.* — safe in any world).
//
// WHY A MAC (the round-30 bridge-forgery blocker): the MAIN world shares its
// realm with the page, and window.postMessage is BROADCAST — every page script
// listener observes every message. The old design posted the shared nonce over
// that channel, so any page script could eavesdrop it and forge "tools" /
// "result" messages. The nonce is now issued by the service worker and
// delivered OUT-OF-BAND (to the MAIN world via chrome.scripting.executeScript
// func ARGS, to the isolated world via the enrollment.status response — both
// extension-private), so it never transits the observable channel. Every
// bridge message then carries only an HMAC-SHA256 tag keyed by that nonce plus
// a monotonic per-direction sequence (replay suppression): a page script sees
// tags it cannot recompute and cannot forge a message without the key.
//
// TRUST LIMIT (documented in docs/KNOWN-ISSUES.md): this MAC protects the
// cross-world transport against a page script that merely observes/injects
// postMessage traffic. It does NOT make the MAIN world or its values trusted:
// MAIN shares the page realm, and the page owns the exposed tools, their side
// effects, and their return values. A page that ran first or poisoned realm
// intrinsics can interfere with its own bridge. Consequently every descriptor
// and result remains page-controlled data. The actual authority boundary is
// the service worker (sender-derived origin/tab/document, generation fencing,
// exact binding, owner approval); bridge failure is fail-closed.
(function () {
  "use strict";

  // ── SHA-256 (synchronous, dependency-free, MV3-CSP-safe — no eval) ──────
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

  function sha256Bytes(message) {
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const bitLen = message.length * 8;
    const paddedLen = (((message.length + 1 + 8) + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLen);
    padded.set(message);
    padded[message.length] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(paddedLen - 4, bitLen >>> 0);
    const w = new Uint32Array(64);
    for (let off = 0; off < paddedLen; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (((h + S1) >>> 0) + ((ch + K[i]) >>> 0) + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (const [i, v] of [h0, h1, h2, h3, h4, h5, h6, h7].entries()) odv.setUint32(i * 4, v);
    return out;
  }

  const encoder = new TextEncoder();

  function hmacSha256(keyBytes, msgBytes) {
    let key = keyBytes;
    if (key.length > 64) key = sha256Bytes(key);
    const ipad = new Uint8Array(64 + msgBytes.length);
    const opadPad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      const kb = i < key.length ? key[i] : 0;
      ipad[i] = kb ^ 0x36;
      opadPad[i] = kb ^ 0x5c;
    }
    ipad.set(msgBytes, 64);
    const inner = sha256Bytes(ipad);
    const opad = new Uint8Array(64 + inner.length);
    opad.set(opadPad);
    opad.set(inner, 64);
    return sha256Bytes(opad);
  }

  function hex(bytes) {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
  }

  function hmacSha256Hex(keyStr, msgStr) {
    return hex(hmacSha256(encoder.encode(String(keyStr)), encoder.encode(String(msgStr))));
  }

  // ── Canonical JSON (deterministic key order so both worlds MAC the same
  // byte string) ────────────────────────────────────────────────────────────
  function canonicalJson(v) {
    if (v === null || v === undefined) return "null";
    const t = typeof v;
    if (t === "string" || t === "boolean") return JSON.stringify(v);
    if (t === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
    if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
    if (t === "object") {
      return "{" + Object.keys(v).sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k]))
        .join(",") + "}";
    }
    return "null"; // functions/symbols are never valid bridge payload
  }

  const MAX_SEQ = 1e9;

  /** Seal an outbound bridge message: returns a copy with a monotonic `seq`
   * and an HMAC-SHA256 `tag` keyed by the nonce over
   * "direction|seq|canonicalJson(msg)". The nonce itself is NEVER included. */
  function seal(nonce, direction, seq, msg) {
    const body = canonicalJson(msg ?? {});
    const tag = hmacSha256Hex(nonce, `${direction}|${seq}|${body}`);
    return { ...(msg ?? {}), seq, tag };
  }

  /** Open an inbound bridge message: verifies the tag against the nonce and
   * requires an ADVANCING sequence (> lastSeq) so replays are rejected.
   * Returns { ok, msg, seq } — `msg` has seq/tag stripped. The channel marker
   * (`__cairn_bridge`) rides alongside the MAC'd body as public routing
   * metadata — it is excluded from verification (it authenticates nothing;
   * the tag does). */
  function open(nonce, direction, lastSeq, data) {
    if (!nonce || !data || typeof data !== "object") return { ok: false };
    const { seq, tag, __cairn_bridge, ...rest } = data;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
      return { ok: false };
    }
    if (seq <= lastSeq) return { ok: false }; // replay / out-of-order
    if (typeof tag !== "string" || tag.length !== 64) return { ok: false };
    const expected = hmacSha256Hex(nonce, `${direction}|${seq}|${canonicalJson(rest)}`);
    if (expected !== tag) return { ok: false };
    return { ok: true, msg: rest, seq };
  }

  globalThis.CairnBridgeAuth = Object.freeze({
    seal,
    open,
    hmacSha256Hex,
    canonicalJson,
    // exposed for the unit tests (a known-answer check pins the primitive)
    sha256Hex: (s) => hex(sha256Bytes(encoder.encode(String(s)))),
  });
})();

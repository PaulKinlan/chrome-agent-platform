// Incremental SHA-256 for file-backed execution receipts. WebCrypto only
// accepts a complete ArrayBuffer; this keeps hashing O(chunk) while bytes move
// through OPFS. The implementation follows FIPS 180-4 and holds one 64-byte
// block regardless of total content size.

const K = new Uint32Array([
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

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

export class IncrementalSha256 {
  constructor() {
    this._state = new Uint32Array(INITIAL);
    this._block = new Uint8Array(64);
    this._used = 0;
    this._bytes = 0;
    this._done = false;
    this._schedule = new Uint32Array(64);
  }

  get bytesHashed() { return this._bytes; }

  update(input) {
    if (this._done) throw new TypeError("sha256_finalized");
    if (!(input instanceof Uint8Array)) throw new TypeError("sha256_bytes");
    this._bytes += input.byteLength;
    if (!Number.isSafeInteger(this._bytes)) throw new TypeError("sha256_length");
    let offset = 0;
    while (offset < input.byteLength) {
      const take = Math.min(64 - this._used, input.byteLength - offset);
      this._block.set(input.subarray(offset, offset + take), this._used);
      this._used += take;
      offset += take;
      if (this._used === 64) {
        this._compress(this._block);
        this._used = 0;
      }
    }
    return this;
  }

  _compress(block) {
    const w = this._schedule;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this._state;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) this._state[i] = (this._state[i] + next[i]) >>> 0;
  }

  digest() {
    if (this._done) throw new TypeError("sha256_finalized");
    this._done = true;
    const bitLength = BigInt(this._bytes) * 8n;
    this._block[this._used++] = 0x80;
    if (this._used > 56) {
      this._block.fill(0, this._used);
      this._compress(this._block);
      this._used = 0;
    }
    this._block.fill(0, this._used, 56);
    const view = new DataView(this._block.buffer);
    view.setBigUint64(56, bitLength, false);
    this._compress(this._block);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this._state[i], false);
    return out;
  }

  hex() {
    return [...this.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export function createIncrementalSha256() {
  return new IncrementalSha256();
}

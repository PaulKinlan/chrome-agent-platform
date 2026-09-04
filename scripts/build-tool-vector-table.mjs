// scripts/build-tool-vector-table.mjs — regenerate extension/vendor/tool-vector-table.json.
//
// PROVENANCE (dev-time only, never in any gate): embeds a fixed vocabulary with
// the real model all-MiniLM-L6-v2 (quantized ONNX via @xenova/transformers),
// reduces 384d → 64d with a FIXED-SEED Gaussian random projection
// (Johnson–Lindenstrauss; deterministic, no fitting), then int8-quantizes each
// row with a per-row absmax scale. The runtime (extension/lib/tool-vectors.js)
// is pure lookup + weighted mean + L2 normalize: no network, no wasm, no model.
//
// REGENERATE (dev machine only, needs network once for the model download):
//   cd /some/scratch && npm init -y && npm i @xenova/transformers@2.17.2
//   node /path/to/repo/scripts/build-tool-vector-table.mjs \
//     --corpus /path/to/corpus-tokens.txt --common /path/to/google-20k.txt \
//     --out /path/to/repo/extension/vendor/tool-vector-table.json
// corpus-tokens.txt comes from: deno run -A scripts/dump-tool-corpus-tokens.ts
// google-20k.txt: github.com/first20hours/google-10000-english (20k.txt)

import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith("--") ? [a.slice(2), all[i + 1]] : null
).filter(Boolean));
if (!args.corpus || !args.common || !args.out || !args.texts) {
  console.error("usage: --corpus <file> --common <file> --texts <file> --out <file>");
  process.exit(2);
}

const TABLE_VERSION = 1;
const OUT_DIMS = 64;
const RP_SEED = 0x9e3779b9;
// Words are embedded inside a minimal carrier sentence: all-MiniLM-L6-v2 is a
// SENTENCE model — bare single-word inputs produce poor word geometry
// (take·capture = 0.43 pre-PC) while a carrier more than doubles the synonym
// margin (0.81). The common direction the carrier adds is exactly what the
// PC-removal step subtracts. Measured: scripts evidence in the 4kl gate logs.
const TEMPLATES = Object.freeze({
  bare: (w) => w,
  action: (w) => `the tool action to ${w} something`,
  howto: (w) => `how to ${w}`,
});
const TEMPLATE = TEMPLATES[args.template ?? "action"];
if (!TEMPLATE) {
  console.error(`unknown --template ${args.template} (have: ${Object.keys(TEMPLATES).join(", ")})`);
  process.exit(2);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Standard-normal via Box–Muller over the seeded PRNG (deterministic).
function gaussian(rng) {
  let u = 0; while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const norm = (s) => s.normalize("NFKC").toLocaleLowerCase("en-US").trim();
const vocab = [...new Set([
  ...readFileSync(args.common, "utf8").split("\n"),
  ...readFileSync(args.corpus, "utf8").split("\n"),
].map(norm).filter((s) => /^[\p{L}\p{N}_-]{2,40}$/u.test(s)))].sort();
console.error(`vocab: ${vocab.length} words`);

const { pipeline } = await import("@xenova/transformers");
const embed = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });

const rng = mulberry32(RP_SEED);
const rp = new Float32Array(384 * OUT_DIMS);
const invSqrt = 1 / Math.sqrt(384);
for (let i = 0; i < rp.length; i++) rp[i] = gaussian(rng) * invSqrt;

// Embed the vocab once (fp32, model-normalized), then remove the vocabulary's
// dominant common direction (all-but-the-top, Mu & Viswanath 2018): raw
// sentence-model word vectors are anisotropic — everything cosines ~0.5-0.6
// regardless of relatedness — so the top principal component (computed by
// deterministic power iteration) is subtracted before projection. Without
// this the semantic floor cannot separate related from unrelated pairs.
const raw = new Float32Array(vocab.length * 384);
const BATCH = 256;
for (let off = 0; off < vocab.length; off += BATCH) {
  const batch = vocab.slice(off, off + BATCH).map(TEMPLATE);
  const out = await embed(batch, { pooling: "mean", normalize: true });
  raw.set(out.data, off * 384);
  if (off % (BATCH * 8) === 0) console.error(`embedded ${off}/${vocab.length}`);
}
// Power iteration for the top principal component (deterministic start).
const pc = new Float32Array(384);
{
  const seedRng = mulberry32(RP_SEED ^ 0x5f356495);
  for (let d = 0; d < 384; d++) pc[d] = gaussian(seedRng);
  const tmp = new Float32Array(384);
  for (let iter = 0; iter < 64; iter++) {
    tmp.fill(0);
    for (let i = 0; i < vocab.length; i++) {
      let dot = 0;
      for (let d = 0; d < 384; d++) dot += raw[i * 384 + d] * pc[d];
      for (let d = 0; d < 384; d++) tmp[d] += dot * raw[i * 384 + d];
    }
    let n = 0;
    for (let d = 0; d < 384; d++) n += tmp[d] * tmp[d];
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < 384; d++) pc[d] = tmp[d] / n;
  }
}
console.error("top PC fitted");

const words = [];
const vectors = new Int8Array(vocab.length * OUT_DIMS);
const scales = new Float32Array(vocab.length);
for (let i = 0; i < vocab.length; i++) {
  const src = raw.subarray(i * 384, (i + 1) * 384);
  // subtract the common direction, then random-project to OUT_DIMS
  let dot = 0;
  for (let d = 0; d < 384; d++) dot += src[d] * pc[d];
  const v = new Float32Array(OUT_DIMS);
  for (let o = 0; o < OUT_DIMS; o++) {
    let acc = 0;
    for (let d = 0; d < 384; d++) acc += (src[d] - dot * pc[d]) * rp[d * OUT_DIMS + o];
    v[o] = acc;
  }
  let norm2 = 0;
  for (const x of v) norm2 += x * x;
  if (norm2 < 1e-12) continue; // a word ON the common direction carries no signal
  norm2 = Math.sqrt(norm2);
  let absmax = 0;
  for (let o = 0; o < OUT_DIMS; o++) {
    v[o] /= norm2;
    if (Math.abs(v[o]) > absmax) absmax = Math.abs(v[o]);
  }
  const scale = absmax / 127 || 1;
  const row = words.length;
  words.push(vocab[i]);
  scales[row] = scale;
  for (let o = 0; o < OUT_DIMS; o++) {
    vectors[row * OUT_DIMS + o] = Math.max(-127, Math.min(127, Math.round(v[o] / scale)));
  }
}

// Evidence: nearest-neighbour sanity probes printed to stderr for the log.
// TEXT-LEVEL common direction: mean-pooling word vectors re-concentrates text
// embeddings toward a "generic English" center (raw probe: unrelated tool
// texts cosined 0.5-0.7 against every query). Fit the top PC of POOLED TEXT
// means (real descriptor texts + seeded pseudo-sentences from the common list)
// in the projected space and ship it as `pc`; the runtime subtracts it after
// pooling (all-but-the-top for sentence means, Mu & Viswanath 2018).
const deq = (i) => {
  const v = new Float32Array(OUT_DIMS);
  for (let o = 0; o < OUT_DIMS; o++) v[o] = vectors[i * OUT_DIMS + o] * scales[i];
  return v;
};
const rowByWord = new Map(words.map((w, i) => [w, i]));
const pool = (tokens) => {
  const out = new Float32Array(OUT_DIMS);
  let hits = 0;
  for (const t of tokens) {
    const row = rowByWord.get(t);
    if (row === undefined) continue;
    const v = deq(row);
    for (let o = 0; o < OUT_DIMS; o++) out[o] += v[o];
    hits++;
  }
  if (!hits) return null;
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let o = 0; o < OUT_DIMS; o++) out[o] /= n;
  return out;
};
const fitTexts = [];
if (args.texts) {
  for (const line of readFileSync(args.texts, "utf8").split("\n")) {
    const tokens = line.trim().match(/[\p{L}\p{N}_-]+/gu);
    if (tokens?.length) fitTexts.push(tokens);
  }
}
// Pseudo-sentences from the common list estimate the generic-English center
// (grammar is irrelevant to a mean-pool).
{
  const fitRng = mulberry32(RP_SEED ^ 0x1b873593);
  const common = readFileSync(args.common, "utf8").split("\n").map(norm).filter(Boolean);
  for (let s = 0; s < 2000; s++) {
    const len = 3 + Math.floor(fitRng() * 6);
    const tokens = [];
    for (let i = 0; i < len; i++) tokens.push(common[Math.floor(fitRng() * common.length)]);
    fitTexts.push(tokens);
  }
}
const pc64 = new Float32Array(OUT_DIMS);
{
  const pooled = fitTexts.map(pool).filter(Boolean);
  const seedRng = mulberry32(RP_SEED ^ 0x85ebca6b);
  for (let d = 0; d < OUT_DIMS; d++) pc64[d] = gaussian(seedRng);
  const tmp = new Float32Array(OUT_DIMS);
  for (let iter = 0; iter < 64; iter++) {
    tmp.fill(0);
    for (const v of pooled) {
      let dot = 0;
      for (let d = 0; d < OUT_DIMS; d++) dot += v[d] * pc64[d];
      for (let d = 0; d < OUT_DIMS; d++) tmp[d] += dot * v[d];
    }
    let n = 0;
    for (let d = 0; d < OUT_DIMS; d++) n += tmp[d] * tmp[d];
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < OUT_DIMS; d++) pc64[d] = tmp[d] / n;
  }
  console.error(`text-level PC fitted over ${pooled.length} pooled texts`);
}

async function neighbours(word, k = 5) {
  const q = (await embed([word], { pooling: "mean", normalize: true })).data;
  let qdot = 0;
  for (let d = 0; d < 384; d++) qdot += q[d] * pc[d];
  const qv = new Float32Array(OUT_DIMS);
  for (let o = 0; o < OUT_DIMS; o++) {
    let acc = 0;
    for (let d = 0; d < 384; d++) acc += (q[d] - qdot * pc[d]) * rp[d * OUT_DIMS + o];
    qv[o] = acc;
  }
  let n2 = 0; for (const x of qv) n2 += x * x;
  if (n2 < 1e-12) { console.error(`nn(${word}): on the common direction — no signal`); return; }
  n2 = Math.sqrt(n2);
  const scored = [];
  for (let i = 0; i < words.length; i++) {
    let dot = 0, vn = 0;
    for (let o = 0; o < OUT_DIMS; o++) {
      const x = vectors[i * OUT_DIMS + o] * scales[i];
      dot += (qv[o] / n2) * x;
      vn += x * x;
    }
    scored.push([dot / (Math.sqrt(vn) || 1), words[i]]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  console.error(`nn(${word}):`, scored.slice(0, k).map(([s, w]) => `${w}=${s.toFixed(3)}`).join(" "));
}
for (const probe of ["weather", "close", "screenshot", "bookmark", "navigate"]) await neighbours(probe);

const packed = Buffer.from(vectors.buffer, 0, words.length * OUT_DIMS).toString("base64");
const table = {
  version: TABLE_VERSION,
  model: "all-MiniLM-L6-v2",
  reduction: `common-direction removal (top PC) + fixed-seed gaussian random projection 384->${OUT_DIMS} (seed ${RP_SEED})`,
  quantization: "int8 per-row absmax",
  dims: OUT_DIMS,
  pc: Array.from(pc64, (x) => Number(x.toPrecision(7))),
  // Ultra-frequent words carry no discriminative signal after common-direction
  // removal — their residuals align with NOTHING and pollute pooled texts
  // (measured: "am" cosined 0.53 against an unrelated tool description). The
  // runtime skips them when pooling; the lexical tier still matches them.
  stopwords: readFileSync(args.common, "utf8").split("\n").map(norm).filter(Boolean).slice(0, 150),
  words,
  scales: Array.from(scales.subarray(0, words.length), (s) => Number(s.toPrecision(7))),
  vectorsB64: packed,
};
writeFileSync(args.out, JSON.stringify(table));
console.error(`wrote ${args.out} (${(JSON.stringify(table).length / 1024 / 1024).toFixed(2)} MB, ${words.length} words)`);

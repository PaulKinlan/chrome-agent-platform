// lib/tool-vectors.js — deterministic local embeddings for tool search (4kl).
//
// The committed table (extension/vendor/tool-vector-table.json) is precomputed
// from a real model at TABLE-GENERATION time (all-MiniLM-L6-v2 → fixed-seed
// random projection 384→64 → int8 per-row; see scripts/build-tool-vector-table.mjs).
// Runtime is pure lookup + weighted mean + L2-normalize: no network, no wasm,
// no model runtime, fully offline and MV3-safe. OOV tokens are skipped (counted
// in diagnostics) — the lexical tier already covers exact-token matches.
//
// Text is DATA here: descriptor/query tokens only select table rows. Nothing in
// this module can execute tools, alter ranking policy, or create grants.
//
// The loader is injectable: the SW passes a fetch of the bundled asset; tests
// pass the parsed table (or a fixture). Loading failure (missing asset, bad
// shape, version mismatch) resolves to null and search degrades to the lexical
// path honestly — diagnostics report `semantic: "unavailable"`.

export const TOOL_VECTOR_TABLE_VERSION = 1;
export const TOOL_VECTOR_DIMS = 64;

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function parseTable(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (ownData(raw, "version") !== TOOL_VECTOR_TABLE_VERSION) return null;
  if (ownData(raw, "dims") !== TOOL_VECTOR_DIMS) return null;
  const words = ownData(raw, "words");
  const scales = ownData(raw, "scales");
  const vectorsB64 = ownData(raw, "vectorsB64");
  if (!Array.isArray(words) || !Array.isArray(scales) || typeof vectorsB64 !== "string") return null;
  if (words.length === 0 || words.length !== scales.length) return null;
  let bytes;
  try {
    bytes = Uint8Array.from(atob(vectorsB64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length !== words.length * TOOL_VECTOR_DIMS) return null;
  // Interpret the bytes as signed (the table stores int8 two's-complement).
  const vectors = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  // The text-level common direction (fitted on pooled text means at tablegen;
  // subtracted after pooling so generic-English centering never drowns the
  // discriminative residue). Absent/malformed → no subtraction (older table).
  const pcRaw = ownData(raw, "pc");
  let pc = null;
  if (Array.isArray(pcRaw) && pcRaw.length === TOOL_VECTOR_DIMS &&
      pcRaw.every((x) => Number.isFinite(x))) {
    pc = new Float32Array(pcRaw);
    let n = 0;
    for (const x of pc) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < TOOL_VECTOR_DIMS; d++) pc[d] /= n;
  }
  const byWord = new Map();
  // Ultra-frequent words (stopwords) pollute pooled embeddings with residual
  // noise; skip them at pool time (lexical matching is unaffected).
  const stopRaw = ownData(raw, "stopwords");
  const stopwords = new Set(
    Array.isArray(stopRaw) ? stopRaw.filter((w) => typeof w === "string") : [],
  );
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const scale = Number(scales[i]);
    if (typeof word !== "string" || !Number.isFinite(scale) || scale <= 0) return null;
    byWord.set(word, { offset: i * TOOL_VECTOR_DIMS, scale });
  }
  return Object.freeze({
    version: TOOL_VECTOR_TABLE_VERSION,
    dims: TOOL_VECTOR_DIMS,
    size: words.length,
    vectors,
    pc,
    stopwords,
    byWord,
  });
}

// One cached load per loader identity. A rejected load is cached too (the SW
// would otherwise retry a broken asset on every query); a fresh loader
// function is the reset seam.
const tableCache = new WeakMap();

/** Load + validate the table. `loader` is async () => parsedJson. Returns the
 * parsed table or null (caller reports semantic: "unavailable"). */
export function loadToolVectorTable(loader) {
  if (typeof loader !== "function") return Promise.resolve(null);
  if (tableCache.has(loader)) return tableCache.get(loader);
  const promise = Promise.resolve()
    .then(() => loader())
    .then((raw) => parseTable(raw))
    .catch(() => null);
  tableCache.set(loader, promise);
  return promise;
}

/** Embed tokens (already normalized by the caller's tokenizer) as the weighted
 * mean of in-vocab word vectors, L2-normalized. `weights` is an optional
 * parallel array (default weight 1). Returns { vector, hits, misses } or null
 * when nothing embeds (no table / zero in-vocab tokens). */
export function embedTokens(table, tokens, weights = null) {
  if (!table || !Array.isArray(tokens) || tokens.length === 0) return null;
  const out = new Float32Array(TOOL_VECTOR_DIMS);
  let hits = 0;
  let misses = 0;
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token !== "string" || !token) continue;
    if (table.stopwords?.has(token)) continue;
    if (seen.has(token)) continue; // a repeated token never double-counts
    seen.add(token);
    const row = table.byWord.get(token);
    if (!row) {
      misses++;
      continue;
    }
    const weight = weights && Number.isFinite(weights[i]) ? weights[i] : 1;
    if (weight <= 0) continue;
    hits++;
    for (let d = 0; d < TOOL_VECTOR_DIMS; d++) {
      out[d] += table.vectors[row.offset + d] * row.scale * weight;
    }
  }
  if (hits === 0) return { vector: null, hits, misses };
  // Remove the fitted common direction before normalizing (the table ships
  // `pc`; without one the pooled mean is used as-is).
  if (table.pc) {
    let dot = 0;
    for (let d = 0; d < TOOL_VECTOR_DIMS; d++) dot += out[d] * table.pc[d];
    for (let d = 0; d < TOOL_VECTOR_DIMS; d++) out[d] -= dot * table.pc[d];
  }
  let norm = 0;
  for (let d = 0; d < TOOL_VECTOR_DIMS; d++) norm += out[d] * out[d];
  if (norm < 1e-9) return { vector: null, hits, misses };
  norm = Math.sqrt(norm);
  for (let d = 0; d < TOOL_VECTOR_DIMS; d++) out[d] /= norm;
  return { vector: out, hits, misses };
}

/** Cosine similarity of two L2-normalized vectors (dot product). Returns null
 * when either vector is absent. */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

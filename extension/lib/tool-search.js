// lib/tool-search.js — deterministic derived exact/alias/lexical index.
//
// Ranking consumes bounded descriptor text as data. It cannot execute tools,
// mutate source stores, request permissions, or create grants. The index is
// rebuilt from the canonical catalog whenever its generation changes.

import { redactSecretText, utf8ByteLength } from "./pure.js";
import { cosineSimilarity, embedTokens } from "./tool-vectors.js";

// 4kl: semantic tier tuning. The cosine floor keeps pure-semantic recall honest
// (below it a no-keyword query reports no-match rather than noise); the bonus
// scale is calibrated so a STRONG whole-query semantic match outranks a lone
// incidental description-token hit (e.g. a stopword like "this", 220) but can
// never outrank name/alias/prefix evidence (≥1200) — measured cosines on the
// committed table: related pairs 0.40–0.81, unrelated ≤0.15.
export const TOOL_SEARCH_SEMANTIC = Object.freeze({
  cosineFloor: 0.25,
  bonusScale: 600,
  // Descriptor text weights: the name is the strongest identity signal, then
  // aliases, then the free-text description and capability labels.
  weights: Object.freeze({ name: 3, aliases: 2, description: 1, capabilities: 1 }),
});

export const TOOL_SEARCH_BOUNDS = Object.freeze({
  // dptw (2026-09-03): the byte/token/topK ceilings are gone — a query of any
  // size is honored, every match is returned, summaries arrive complete.
  // defaultTopK remains a DEFAULT (a caller that asks for more gets more).
  defaultTopK: 6,
});

const FORBIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

export function normalizeToolQuery(value) {
  let text;
  try {
    if (typeof value !== "string") return { text: "", tokens: [] };
    text = value.normalize("NFKC").toLocaleLowerCase("en-US");
  } catch {
    return { text: "", tokens: [] };
  }
  text = text.replace(FORBIDDEN, " ").trim().replace(/\s+/gu, " ");
  const tokens = text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return { text, tokens: [...new Set(tokens)] };
}

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function descriptorTokens(descriptor) {
  const data = [
    descriptor.name,
    ...(descriptor.aliases ?? []),
    descriptor.description,
    descriptor.schemaSummary,
    descriptor.outputSchemaSummary,
    ...(descriptor.capabilities ?? []),
  ].join(" ");
  let normalized;
  try {
    normalized = data.normalize("NFKC").toLocaleLowerCase("en-US")
      .replace(FORBIDDEN, " ");
  } catch {
    normalized = "";
  }
  return Object.freeze([
    ...new Set(
      normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [],
    ),
  ].sort());
}

export function buildToolSearchIndex(catalog, options = {}) {
  // 4kl: `vectorTable` (parsed by tool-vectors.js) is OPTIONAL — without it the
  // index is the pure lexical one and search reports semantic: "unavailable".
  const vectorTable = options.vectorTable ?? null;
  const weights = TOOL_SEARCH_SEMANTIC.weights;
  const rows = [];
  for (const descriptor of catalog?.descriptors ?? []) {
    let vector = null;
    if (vectorTable) {
      const parts = [];
      const partWeights = [];
      const push = (text, weight) => {
        let normalized;
        try {
          normalized = String(text ?? "").normalize("NFKC")
            .toLocaleLowerCase("en-US").replace(FORBIDDEN, " ");
        } catch {
          normalized = "";
        }
        for (const token of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
          parts.push(token);
          partWeights.push(weight);
        }
      };
      push(descriptor.name, weights.name);
      for (const alias of descriptor.aliases ?? []) push(alias, weights.aliases);
      push(descriptor.description, weights.description);
      for (const capability of descriptor.capabilities ?? []) {
        push(capability, weights.capabilities);
      }
      vector = embedTokens(vectorTable, parts, partWeights)?.vector ?? null;
    }
    rows.push(Object.freeze({
      descriptor,
      tokens: descriptorTokens(descriptor),
      vector,
    }));
  }
  return Object.freeze({
    catalogGeneration: String(catalog?.generation ?? ""),
    vectorTableVersion: vectorTable ? vectorTable.version : 0,
    rows: Object.freeze(rows),
  });
}

function scoreRow(row, query, queryVector) {
  const descriptor = row.descriptor;
  if (!query.text || query.tokens.length === 0) return null;
  let score = 0;
  let tier = null;
  if (descriptor.normalizedName === query.text) { score += 10000; tier = "exact"; }
  if (descriptor.normalizedAliases?.includes(query.text)) {
    score += 9000;
    if (!tier) tier = "alias";
  }
  if (descriptor.normalizedName.startsWith(query.text)) {
    score += 3000;
    if (!tier) tier = "prefix";
  }
  if (
    descriptor.normalizedAliases?.some((alias) => alias.startsWith(query.text))
  ) {
    score += 2500;
    if (!tier) tier = "prefix";
  }
  let matched = 0;
  for (const token of query.tokens) {
    if (descriptor.normalizedName === token) score += 1200;
    else if (descriptor.normalizedName.includes(token)) score += 700;
    if (descriptor.normalizedAliases?.includes(token)) score += 1000;
    if (row.tokens.includes(token)) {
      matched++;
      score += 200;
    }
  }
  if (matched === query.tokens.length) score += 1000;
  if (matched > 0 && !tier) tier = "lexical";
  // 4kl semantic tier: cosine against the descriptor's embedded searchable
  // text. A pure-semantic hit (no lexical signal at all) is admitted only at
  // or above the floor; with lexical signal the cosine is a bounded bonus that
  // can never outrank exact/alias/prefix (see TOOL_SEARCH_SEMANTIC).
  let cosine = null;
  if (queryVector && row.vector) {
    cosine = cosineSimilarity(queryVector, row.vector);
    if (cosine != null && cosine >= TOOL_SEARCH_SEMANTIC.cosineFloor) {
      score += cosine * TOOL_SEARCH_SEMANTIC.bonusScale;
      if (!tier) tier = "semantic";
    } else {
      cosine = null; // below the floor the cosine is noise — not reported
    }
  }
  if (matched === 0 && score === 0) return null;
  // Availability is a deterministic tie-break signal, never authorization.
  if (descriptor.availability === "ready") score += 20;
  return { score, tier: tier ?? "lexical", cosine };
}

function boundedSearchText(value) {
  // Redacted, never size-clipped (dptw).
  return redactSecretText(String(value ?? ""));
}

export function projectToolSearchResult(descriptor) {
  return Object.freeze({
    stableId: descriptor.stableId,
    name: descriptor.name,
    aliases: descriptor.aliases,
    summary: boundedSearchText(descriptor.description),
    // Schema string leaves were already secret-redacted before canonical JSON
    // serialization; do not run text redaction over JSON syntax here.
    schemaSummary: String(descriptor.schemaSummary ?? ""),
    outputSchemaSummary: String(descriptor.outputSchemaSummary ?? ""),
    sourceKind: descriptor.sourceKind,
    packageId: descriptor.packageId,
    version: descriptor.version,
    digest: descriptor.digest,
    packageDigest: descriptor.packageDigest,
    capabilityDigest: descriptor.capabilityDigest,
    permissionDigest: descriptor.permissionDigest,
    grantDigest: descriptor.grantDigest,
    capabilities: descriptor.capabilities,
    scope: descriptor.scope,
    sourceGeneration: descriptor.sourceGeneration,
    availability: descriptor.availability,
    trustedReplaySafety: descriptor.trustedReplaySafety,
    dispatcherKind: descriptor.dispatcherKind,
  });
}

export function searchToolIndex(index, queryValue, options = {}) {
  const query = normalizeToolQuery(queryValue);
  const vectorTable = ownData(options, "vectorTable") ?? null;
  const requested = Number(ownData(options, "limit"));
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.trunc(requested))
    : TOOL_SEARCH_BOUNDS.defaultTopK;
  if (!query.text || limit === 0) {
    return Object.freeze({
      catalogGeneration: index?.catalogGeneration ?? "",
      results: Object.freeze([]),
      diagnostics: Object.freeze({
        returned: 0,
        resultBytes: 0,
        queryTokens: 0,
        semantic: "none",
        fallback: "empty-query",
      }),
    });
  }
  // 4kl: embed the query in the SAME table the index rows were embedded with.
  // A version skew (index built with an older table) reports "stale" honestly
  // and the query vector is simply not used — lexical ranking still runs.
  let queryVector = null;
  let semantic = "unavailable";
  if (vectorTable && index?.rows?.some((row) => row.vector)) {
    if ((index?.vectorTableVersion ?? 0) === vectorTable.version) {
      queryVector = embedTokens(vectorTable, query.tokens)?.vector ?? null;
      semantic = queryVector ? "applied" : "unavailable";
    } else {
      semantic = "stale";
    }
  }
  const ranked = [];
  for (const row of index?.rows ?? []) {
    const scored = scoreRow(row, query, queryVector);
    if (scored != null) {
      ranked.push({ ...scored, descriptor: row.descriptor });
    }
  }
  ranked.sort((a, b) =>
    b.score - a.score ||
    (a.descriptor.stableId < b.descriptor.stableId
      ? -1
      : a.descriptor.stableId > b.descriptor.stableId
      ? 1
      : 0)
  );
  const results = [];
  let resultBytes = 0;
  const tiers = { exact: 0, alias: 0, prefix: 0, lexical: 0, semantic: 0 };
  for (const row of ranked) {
    if (results.length >= limit) break;
    const projected = {
      ...projectToolSearchResult(row.descriptor),
      score: row.score,
      matchTier: row.tier,
      ...(row.cosine != null ? { cosine: row.cosine } : {}),
    };
    // No result byte budget (dptw): every ranked result up to the requested
    // limit is returned whole.
    resultBytes += utf8ByteLength(JSON.stringify(projected));
    tiers[row.tier] = (tiers[row.tier] ?? 0) + 1;
    results.push(Object.freeze(projected));
  }
  return Object.freeze({
    catalogGeneration: index?.catalogGeneration ?? "",
    results: Object.freeze(results),
    diagnostics: Object.freeze({
      returned: results.length,
      resultBytes,
      queryTokens: query.tokens.length,
      semantic,
      fallback: results.length === 0 ? "no-match" : "none",
      tiers: Object.freeze(tiers),
    }),
  });
}

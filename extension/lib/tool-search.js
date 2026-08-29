// lib/tool-search.js — deterministic derived exact/alias/lexical index.
//
// Ranking consumes bounded descriptor text as data. It cannot execute tools,
// mutate source stores, request permissions, or create grants. The index is
// rebuilt from the canonical catalog whenever its generation changes.

import { redactSecretText, truncateUtf8, utf8ByteLength } from "./pure.js";

export const TOOL_SEARCH_BOUNDS = Object.freeze({
  maxQueryBytes: 512,
  maxQueryTokens: 16,
  maxIndexedTokensPerTool: 256,
  maxTopK: 12,
  defaultTopK: 6,
  maxResultBytes: 32 * 1024,
  maxSummaryBytes: 512,
  maxSchemaSummaryBytes: 4096,
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
  text = truncateUtf8(
    text.replace(FORBIDDEN, " "),
    TOOL_SEARCH_BOUNDS.maxQueryBytes,
  )
    .trim().replace(/\s+/gu, " ");
  const tokens = (text.match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .slice(0, TOOL_SEARCH_BOUNDS.maxQueryTokens);
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
      (normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [])
        .slice(0, TOOL_SEARCH_BOUNDS.maxIndexedTokensPerTool),
    ),
  ].sort());
}

export function buildToolSearchIndex(catalog) {
  const rows = [];
  for (const descriptor of catalog?.descriptors ?? []) {
    rows.push(Object.freeze({
      descriptor,
      tokens: descriptorTokens(descriptor),
    }));
  }
  return Object.freeze({
    catalogGeneration: String(catalog?.generation ?? ""),
    rows: Object.freeze(rows),
  });
}

function scoreRow(row, query) {
  const descriptor = row.descriptor;
  if (!query.text || query.tokens.length === 0) return null;
  let score = 0;
  if (descriptor.normalizedName === query.text) score += 10000;
  if (descriptor.normalizedAliases?.includes(query.text)) score += 9000;
  if (descriptor.normalizedName.startsWith(query.text)) score += 3000;
  if (
    descriptor.normalizedAliases?.some((alias) => alias.startsWith(query.text))
  ) {
    score += 2500;
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
  if (matched === 0 && score === 0) return null;
  // Availability is a deterministic tie-break signal, never authorization.
  if (descriptor.availability === "ready") score += 20;
  return score;
}

function boundedSearchText(value, maxBytes) {
  return truncateUtf8(redactSecretText(String(value ?? "")), maxBytes);
}

export function projectToolSearchResult(descriptor) {
  return Object.freeze({
    stableId: descriptor.stableId,
    name: descriptor.name,
    aliases: descriptor.aliases,
    summary: boundedSearchText(
      descriptor.description,
      TOOL_SEARCH_BOUNDS.maxSummaryBytes,
    ),
    schemaSummary: boundedSearchText(
      descriptor.schemaSummary,
      TOOL_SEARCH_BOUNDS.maxSchemaSummaryBytes,
    ),
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
  const requested = Number(ownData(options, "limit"));
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.min(Math.trunc(requested), TOOL_SEARCH_BOUNDS.maxTopK))
    : TOOL_SEARCH_BOUNDS.defaultTopK;
  if (!query.text || limit === 0) {
    return Object.freeze({
      catalogGeneration: index?.catalogGeneration ?? "",
      results: Object.freeze([]),
      diagnostics: Object.freeze({
        returned: 0,
        resultBytes: 0,
        queryTokens: 0,
      }),
    });
  }
  const ranked = [];
  for (const row of index?.rows ?? []) {
    const score = scoreRow(row, query);
    if (score != null) ranked.push({ score, descriptor: row.descriptor });
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
  for (const row of ranked) {
    if (results.length >= limit) break;
    const projected = {
      ...projectToolSearchResult(row.descriptor),
      score: row.score,
    };
    const bytes = utf8ByteLength(JSON.stringify(projected));
    if (resultBytes + bytes > TOOL_SEARCH_BOUNDS.maxResultBytes) continue;
    resultBytes += bytes;
    results.push(Object.freeze(projected));
  }
  return Object.freeze({
    catalogGeneration: index?.catalogGeneration ?? "",
    results: Object.freeze(results),
    diagnostics: Object.freeze({
      returned: results.length,
      resultBytes,
      queryTokens: query.tokens.length,
    }),
  });
}

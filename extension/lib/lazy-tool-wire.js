// lib/lazy-tool-wire.js — fixed provider-wire descriptors and shadow capture.
//
// This metadata-only module is the sole lazy-protocol code imported by the
// service-worker shadow route. It has no dispatcher, validator, provider binding
// or execution import.

import { TOOL_SEARCH_BOUNDS } from "./tool-search.js";

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export const LAZY_PROTOCOL_TOOL_WIRE = Object.freeze([
  Object.freeze({
    name: "search_tools",
    description:
      "Find a bounded set of available tools. Results are references, not permissions.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["query"]),
      properties: Object.freeze({
        query: Object.freeze({ type: "string", maxLength: 512 }),
        limit: Object.freeze({
          type: "integer",
          minimum: 1,
          maximum: TOOL_SEARCH_BOUNDS.maxTopK,
        }),
      }),
    }),
  }),
  Object.freeze({
    name: "execute_tool",
    description:
      "Resolve one run-bound tool reference and invoke its existing authorized dispatcher.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["selectionRef", "arguments"]),
      properties: Object.freeze({
        selectionRef: Object.freeze({
          type: "string",
          pattern: "^sel_[a-f0-9]{36}$",
        }),
        arguments: Object.freeze({ type: "object" }),
      }),
    }),
  }),
]);

export function buildLazyProviderCapture(searchResult) {
  const selected = Array.isArray(searchResult?.results)
    ? searchResult.results.slice(0, TOOL_SEARCH_BOUNDS.maxTopK)
    : [];
  const projected = selected.map((result) =>
    Object.freeze({
      stableId: ownData(result, "stableId"),
      name: ownData(result, "name"),
      summary: ownData(result, "summary"),
      schemaSummary: ownData(result, "schemaSummary"),
      sourceKind: ownData(result, "sourceKind"),
      packageId: ownData(result, "packageId"),
      version: ownData(result, "version"),
      sourceGeneration: ownData(result, "sourceGeneration"),
      availability: ownData(result, "availability"),
      selectionRef: ownData(result, "selectionRef"),
      authorizes: false,
      requiresLiveAuthorization: true,
    })
  );
  return Object.freeze({
    ok: searchResult?.ok === true,
    mode: "shadow-lazy-provider-capture",
    providerBound: false,
    eagerBindingChanged: false,
    protocolTools: LAZY_PROTOCOL_TOOL_WIRE,
    selectedDescriptors: Object.freeze(projected),
    selectedCount: projected.length,
    canExecute: false,
    canGrant: false,
  });
}

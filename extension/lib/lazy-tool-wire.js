// lib/lazy-tool-wire.js — fixed provider-wire descriptors and shadow capture.
//
// This metadata-only module is the sole lazy-protocol code imported by the
// service-worker shadow route. It has no dispatcher, validator, provider binding
// or execution import.

import { TOOL_SEARCH_BOUNDS } from "./tool-search.js";
import { selectedCapabilitySummary } from "./chrome-tool-capabilities.js";
import { TOOL_CATALOG_BOUNDS } from "./tool-catalog.js";
import { toolArgumentContract, toolOutputSchema } from "./tool-argument-contract.js";

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
      "Find a bounded set of available tools. Results are references, not permissions. A selectionRef works for every execute_tool call of that tool for the rest of the run (up to 64 calls) — search once per tool, then loop.",
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
    outputSchema: toolOutputSchema("search_tools"),
  }),
  Object.freeze({
    name: "list_tools",
    description:
      "Enumerate available tools grouped by source category (builtin, browser, management, bundled-wasm). Returns tool inventories and counts.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        source: Object.freeze({
          type: "string",
          description: "Optional category filter: 'builtin' | 'browser' | 'management' | 'bundled-wasm' | 'webmcp'",
        }),
      }),
    }),
    outputSchema: toolOutputSchema("list_tools"),
  }),
  Object.freeze({
    name: "execute_tool",
    description:
      "Resolve one run-bound tool reference and invoke its existing authorized dispatcher. The same selectionRef may be executed again for the next item; a failed call does not spend it.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["selectionRef", "arguments"]),
      properties: Object.freeze({
        selectionRef: Object.freeze({
          type: "string",
          pattern: "^sel_[a-f0-9]{36}$",
        }),
        arguments: Object.freeze({
          type: "object",
          description: "Arguments must match the selected tool's schemaSummary exactly. Its x-cap-argument-limits names the UTF-8 byte and shape bounds; designated largeContent fields are the only exception to ordinary limits.",
          "x-cap-default-argument-limits": toolArgumentContract(),
        }),
      }),
    }),
    outputSchema: toolOutputSchema("execute_tool"),
  }),
]);

function capabilitySummary(result) {
  try {
    return selectedCapabilitySummary(
      ownData(result, "name"),
      ownData(result, "sourceKind"),
      ownData(result, "capabilities"),
      ownData(result, "trustedReplaySafety"),
    );
  } catch {
    return Object.freeze({
      capabilityTokens: Object.freeze([]),
      optionalPermissions: Object.freeze([]),
      productGrantScopeKind: "none",
      replayClass: "unknown",
      requiresOwnerGesture: false,
      mutationClass: "mutating",
      routeFamily: "catalog.unknown",
    });
  }
}

export function buildLazyProviderCapture(searchResult, options = {}) {
  const selected = Array.isArray(searchResult?.results)
    ? searchResult.results.slice(0, TOOL_SEARCH_BOUNDS.maxTopK)
    : [];
  const projected = selected.map((result) =>
    Object.freeze({
      stableId: ownData(result, "stableId"),
      name: ownData(result, "name"),
      summary: ownData(result, "summary"),
      schemaSummary: ownData(result, "schemaSummary"),
      outputSchemaSummary: ownData(result, "outputSchemaSummary"),
      sourceKind: ownData(result, "sourceKind"),
      packageId: ownData(result, "packageId"),
      version: ownData(result, "version"),
      sourceGeneration: ownData(result, "sourceGeneration"),
      availability: ownData(result, "availability"),
      selectionRef: ownData(result, "selectionRef"),
      capabilityDigest: ownData(result, "capabilityDigest"),
      trustedReplaySafety: ownData(result, "trustedReplaySafety") ?? "unknown",
      capabilitySummary: capabilitySummary(result),
      authorizes: false,
      requiresLiveAuthorization: true,
    })
  );
  const rawNonSelected = ownData(options, "nonSelectedCount") ??
    ownData(searchResult, "nonSelectedCount") ?? 0;
  const requestedNonSelected = typeof rawNonSelected === "number"
    ? rawNonSelected
    : typeof rawNonSelected === "string" && /^\d{1,7}$/u.test(rawNonSelected)
    ? Number(rawNonSelected)
    : 0;
  const nonSelectedCount = Number.isFinite(requestedNonSelected)
    ? Math.max(0, Math.min(
      Math.trunc(requestedNonSelected),
      TOOL_CATALOG_BOUNDS.maxDescriptors,
    ))
    : 0;
  return Object.freeze({
    ok: searchResult?.ok === true,
    mode: "shadow-lazy-provider-capture",
    providerBound: false,
    eagerBindingChanged: false,
    protocolTools: LAZY_PROTOCOL_TOOL_WIRE,
    selectedDescriptors: Object.freeze(projected),
    selectedCount: projected.length,
    nonSelectedCount,
    omittedNonSelected: nonSelectedCount > 0,
    canExecute: false,
    canGrant: false,
  });
}

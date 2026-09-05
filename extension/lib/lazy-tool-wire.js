// lib/lazy-tool-wire.js — fixed provider-wire descriptors and shadow capture.
//
// This metadata-only module is the sole lazy-protocol code imported by the
// service-worker shadow route. It has no dispatcher, validator, provider binding
// or execution import.

import { TOOL_SEARCH_BOUNDS } from "./tool-search.js";
import { selectedCapabilitySummary } from "./chrome-tool-capabilities.js";
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
      "Enumerate available tools grouped by source category (builtin, browser, management, bundled-wasm, webmcp, provider-server) with live counts. A provider-server tool runs INSIDE the model call: execute_tool on it (no arguments) activates it for the rest of the run so later answers can be grounded with citations — activate once, never in a loop.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        source: Object.freeze({
          type: "string",
          description: "Optional category filter: 'builtin' | 'browser' | 'management' | 'bundled-wasm' | 'webmcp' | 'provider-server'",
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
          description: "Arguments must match the selected tool's schemaSummary exactly. There are no size limits — plain JSON data of any size is accepted; a provider-side limit fails with the provider's own error.",
          "x-cap-default-argument-limits": toolArgumentContract(),
        }),
      }),
    }),
    outputSchema: toolOutputSchema("execute_tool"),
  }),
  // chrome-agent-platform-qsm4 (slice 2): the DECLARATIVE pipeline runner —
  // chain a few existing tools into one legible run where a step's output
  // feeds a later step by an explicit { $ref } binding. Each step still runs
  // through the ordinary search/execute seam, so its own owner-approval card
  // and untrusted fence apply exactly as a direct call; a failing step halts
  // the pipeline. No eval, no new authority.
  Object.freeze({
    name: "run_pipeline",
    description:
      "Run a few tools in sequence as one pipeline: each step names an existing tool, and a step's arguments may carry a binding { \"$ref\": \"<an earlier step's id>\", \"path\": \"a.b.0\" } that is replaced with that step's result (or a sub-path of it). Use it when one tool's output feeds the next (search → read → save) instead of making separate calls. Every step is validated and gated exactly like a direct execute_tool call — a step needing owner approval pauses on the owner's card, and a failing step stops the pipeline with the failed step named. The tool NAME in each step is fixed text, never a binding.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["steps"]),
      properties: Object.freeze({
        name: Object.freeze({
          type: "string",
          maxLength: 80,
          description: "A short label for the pipeline (shown in the plan strip).",
        }),
        steps: Object.freeze({
          type: "array",
          minItems: 1,
          items: Object.freeze({
            type: "object",
            additionalProperties: false,
            required: Object.freeze(["id", "tool"]),
            properties: Object.freeze({
              id: Object.freeze({
                type: "string",
                description: "Unique step id (letters, digits, - or _), referenced by later steps' bindings.",
              }),
              tool: Object.freeze({
                type: "string",
                description: "The EXACT name of an existing tool (as list_tools/search_tools report it). Fixed text — never a binding.",
              }),
              args: Object.freeze({
                type: "object",
                description: "The tool's arguments, matching its schemaSummary. Any value shaped { \"$ref\": \"<earlier step id>\", \"path\": \"a.b.0\" } is replaced with that step's result (or the sub-path of it). A binding may only reference an EARLIER step.",
              }),
            }),
          }),
        }),
      }),
    }),
    outputSchema: toolOutputSchema("run_pipeline"),
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
    ? Math.max(0, Math.trunc(requestedNonSelected))
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

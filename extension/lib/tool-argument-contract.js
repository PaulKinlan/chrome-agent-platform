// lib/tool-argument-contract.js — one truthful argument contract shared by
// provider-visible schemas, lazy sanitization, and the underlying content stores.
//
// dptw (2026-09-03): there are NO size limits on tool arguments. The old
// TOOL_ARGUMENT_LIMITS byte/shape ceilings (32 KiB payloads, 16 KiB strings,
// depth 8, 64 keys, ...) refused complete owner data at self-imposed bounds;
// they are gone. Arguments must be plain JSON DATA (objects, arrays, strings,
// finite numbers, booleans, null) — a shape requirement, not a size one. A
// provider's own request limit, when one exists, surfaces as that provider's
// honest error instead of a pre-emptive refusal.

// Large-content field designations are kept for CONTENT FIDELITY only: a
// designated field's text is carried exactly as given (no Unicode
// normalization), at any size.
const LARGE_FIELDS = Object.freeze({
  management: Object.freeze({
    create_asset: Object.freeze({ field: "content" }),
    update_asset: Object.freeze({ field: "content" }),
    // The chunked build path carries the SAME body bytes create_asset would —
    // a chunk is exact content, never NFKC-rewritten (gpw).
    append_asset: Object.freeze({ field: "content" }),
    generate_ui: Object.freeze({ field: "html" }),
    create_script: Object.freeze({ field: "source" }),
    update_script: Object.freeze({ field: "source" }),
    python_execute: Object.freeze({ field: "code" }),
  }),
  // A local-file write carries the COMPLETE file body, so it gets the same
  // exact-content treatment an artifact body does
  // (CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01).
  "chrome-api": Object.freeze({
    write_file: Object.freeze({ field: "content" }),
  }),
});

export function toolArgumentContract(sourceKind, toolId) {
  const large = LARGE_FIELDS[sourceKind]?.[toolId] ?? null;
  return Object.freeze({
    // Truthful declaration: no size limits. Plain JSON data, any size.
    limits: "none",
    ...(large ? { largeContent: large } : {}),
  });
}

/** Add the transport contract without rewriting a source's validation schema. */
export function schemaWithArgumentContract(schema, sourceKind, toolId) {
  return {
    allOf: [schema && typeof schema === "object" ? schema : {}],
    "x-cap-argument-limits": toolArgumentContract(sourceKind, toolId),
  };
}

const JSON_VALUE_OUTPUT = Object.freeze({
  oneOf: [
    { type: "object" }, { type: "array" }, { type: "string" },
    { type: "number" }, { type: "boolean" }, { type: "null" },
  ],
  "x-cap-output-shape": "generic-json-value",
});
const ERROR = { type: "string" };
const ARTIFACT = {
  type: "object",
  properties: {
    id: { type: "string" }, key: { type: "string" }, type: { type: "string" },
    name: { type: "string" }, origin: { type: "string" }, size: { type: "number" },
    at: { type: "number" }, updatedAt: { type: "number" }, content: { type: "string" },
  },
};
const ARTIFACT_RESULT = {
  type: "object",
  properties: {
    ok: { type: "boolean" }, id: { type: ["string", "null"] },
    asset: ARTIFACT, error: ERROR,
  },
};
const TOOL_DESCRIPTOR_RESULT = {
  type: "object",
  properties: {
    name: { type: "string" }, summary: { type: "string" },
    schemaSummary: { type: "string" }, outputSchemaSummary: { type: "string" },
    sourceKind: { type: "string" }, availability: { type: "string" },
    selectionRef: { type: ["string", "null"] },
  },
};
const TABLE_RESULT = {
  type: "object",
  properties: {
    ok: { type: "boolean" }, artifactId: { type: "string" },
    schema: { type: "string" }, sha256: { type: "string" },
    rows: { type: "number" }, columns: { type: "number" },
    inputBytes: { type: "number" }, outputBytes: { type: "number" },
    workUnits: { type: "number" }, warnings: { type: "array", items: { type: "string" } },
    previewAvailableLocally: { type: "boolean" }, deduped: { type: "boolean" },
    code: { type: "string" }, error: ERROR,
  },
  "x-cap-output-shape": "provider-safe-table-metadata",
};
const PROVIDER_SEARCH_RESULT = {
  type: "object",
  properties: {
    provider: { type: "string" }, kind: { type: "string" }, query: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" }, title: { type: "string" },
          citedText: { type: "string" }, provider: { type: "string" },
        },
      },
    },
    activated: { type: "string" }, alreadyActive: { type: "boolean" },
    note: { type: "string" }, cost: { type: "object" },
    ok: { type: "boolean" }, error: ERROR,
  },
};

/** Exact return contracts opt in here; uncatalogued tools remain renderable via
 * the bounded generic JSON-value contract until the follow-up audit adds them. */
export const TOOL_OUTPUT_SCHEMA_REGISTRY = Object.freeze({
  search_tools: {
    type: "object",
    properties: {
      ok: { type: "boolean" }, catalogGeneration: { type: "string" },
      results: { type: "array", items: TOOL_DESCRIPTOR_RESULT },
      diagnostics: { type: "object" }, error: ERROR,
    },
  },
  list_tools: {
    type: "object",
    properties: {
      ok: { type: "boolean" }, counts: { type: "object" },
      truncated: { type: "boolean" },
      tools: { type: "object", additionalProperties: { type: "array", items: TOOL_DESCRIPTOR_RESULT } },
      summary: { type: "string" }, error: ERROR,
    },
  },
  execute_tool: {
    type: "object",
    properties: {
      ok: { type: "boolean" }, selectedTool: { type: "string" },
      result: JSON_VALUE_OUTPUT, schemaSummary: { type: "string" }, error: ERROR,
      // lazy-arguments-invalid hands the un-consumed ref back: retry with it
      // (CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01).
      retryable: { type: "boolean" }, selectionRef: { type: "string" },
    },
  },
  // chrome-agent-platform-qsm4 (slice 2): run_pipeline's envelope is the
  // pipeline runner's own outcome — the per-step rows ({id, tool, result}),
  // the final step's result, or the fail-closed halt (failedStep + error).
  run_pipeline: {
    type: "object",
    properties: {
      ok: { type: "boolean" }, name: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" }, tool: { type: "string" },
            result: JSON_VALUE_OUTPUT,
          },
        },
      },
      final: JSON_VALUE_OUTPUT,
      failedStep: { type: "string" }, stepIndex: { type: "number" },
      completed: { type: "array" }, error: ERROR,
    },
  },
  create_asset: ARTIFACT_RESULT,
  update_asset: ARTIFACT_RESULT,
  generate_ui: ARTIFACT_RESULT,
  delete_asset: { type: "object", properties: { ok: { type: "boolean" }, error: ERROR } },
  list_assets: {
    type: "object",
    properties: {
      ok: { type: "boolean" }, assets: { type: "array", items: ARTIFACT }, error: ERROR,
    },
  },
  get_asset: ARTIFACT_RESULT,
  table_filter: TABLE_RESULT,
  table_select: TABLE_RESULT,
  table_join: TABLE_RESULT,
  table_group_aggregate: TABLE_RESULT,
  table_pivot: TABLE_RESULT,
  table_formula: TABLE_RESULT,
  "provider-server/gemini/google_search": PROVIDER_SEARCH_RESULT,
  "provider-server/anthropic/web_search": PROVIDER_SEARCH_RESULT,
});

export function toolOutputSchema(toolId, declaredSchema) {
  if (declaredSchema && typeof declaredSchema === "object") return declaredSchema;
  return TOOL_OUTPUT_SCHEMA_REGISTRY[toolId] ?? JSON_VALUE_OUTPUT;
}

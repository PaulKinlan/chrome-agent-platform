// lib/tool-argument-contract.js — one truthful argument-size contract shared by
// provider-visible schemas, lazy sanitization, and the underlying content stores.

export const TOOL_ARGUMENT_LIMITS = Object.freeze({
  maxJsonUtf8Bytes: 32 * 1024,
  maxDepth: 8,
  maxNodes: 256,
  maxObjectKeys: 64,
  maxArrayItems: 64,
  maxKeyUtf8Bytes: 128,
  maxStringUtf8Bytes: 16 * 1024,
  maxLargeJsonUtf8Bytes: 288 * 1024,
  maxAssetContentUtf8Bytes: 256 * 1024,
  maxScriptSourceUtf8Bytes: 64 * 1024,
});

const LARGE_FIELDS = Object.freeze({
  management: Object.freeze({
    create_asset: Object.freeze({ field: "content", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes }),
    update_asset: Object.freeze({ field: "content", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes }),
    generate_ui: Object.freeze({ field: "html", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes }),
    create_script: Object.freeze({ field: "source", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxScriptSourceUtf8Bytes }),
    update_script: Object.freeze({ field: "source", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxScriptSourceUtf8Bytes }),
  }),
  // A local-file write carries the COMPLETE file body, so it gets the same
  // large-content allowance an artifact body does
  // (CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01).
  "chrome-api": Object.freeze({
    write_file: Object.freeze({ field: "content", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes }),
  }),
});

export function toolArgumentContract(sourceKind, toolId) {
  const large = LARGE_FIELDS[sourceKind]?.[toolId] ?? null;
  return Object.freeze({
    maxJsonUtf8Bytes: large
      ? TOOL_ARGUMENT_LIMITS.maxLargeJsonUtf8Bytes
      : TOOL_ARGUMENT_LIMITS.maxJsonUtf8Bytes,
    maxDepth: TOOL_ARGUMENT_LIMITS.maxDepth,
    maxNodes: TOOL_ARGUMENT_LIMITS.maxNodes,
    maxObjectKeys: TOOL_ARGUMENT_LIMITS.maxObjectKeys,
    maxArrayItems: TOOL_ARGUMENT_LIMITS.maxArrayItems,
    maxKeyUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxKeyUtf8Bytes,
    defaultMaxStringUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxStringUtf8Bytes,
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
  "provider-server/gemini/google_search": PROVIDER_SEARCH_RESULT,
  "provider-server/anthropic/web_search": PROVIDER_SEARCH_RESULT,
});

export function toolOutputSchema(toolId, declaredSchema) {
  if (declaredSchema && typeof declaredSchema === "object") return declaredSchema;
  return TOOL_OUTPUT_SCHEMA_REGISTRY[toolId] ?? JSON_VALUE_OUTPUT;
}

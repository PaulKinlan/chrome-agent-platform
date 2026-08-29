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
  create_asset: Object.freeze({ field: "content", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes }),
  update_asset: Object.freeze({ field: "content", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes }),
  generate_ui: Object.freeze({ field: "html", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes }),
  create_script: Object.freeze({ field: "source", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxScriptSourceUtf8Bytes }),
  update_script: Object.freeze({ field: "source", maxUtf8Bytes: TOOL_ARGUMENT_LIMITS.maxScriptSourceUtf8Bytes }),
});

export function toolArgumentContract(sourceKind, toolId) {
  const large = sourceKind === "management" ? LARGE_FIELDS[toolId] ?? null : null;
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

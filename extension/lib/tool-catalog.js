// lib/tool-catalog.js — bounded metadata-only shadow catalog authority.
//
// This module describes existing tools; it cannot execute tools, install
// packages, request permissions, or create grants. Current source dispatchers
// remain authoritative. Descriptions and schemas may be page-controlled, so
// they are treated only as bounded searchable data.

import { zodSchema } from "ai";
import {
  schemaWithArgumentContract,
  toolOutputSchema,
} from "./tool-argument-contract.js";
import {
  hasLoneSurrogates,
  redactSecretText,
  sha256Hex,
  truncateUtf8,
  utf8ByteLength,
} from "./pure.js";
import { REPLAY_UNKNOWN, replaySafetyForTool } from "./tool-replay-safety.js";

export const TOOL_CATALOG_SCHEMA_VERSION = 1;

export const TOOL_CATALOG_BOUNDS = Object.freeze({
  // dptw (2026-09-03): every descriptor/catalog SIZE ceiling is gone — no more
  // silent drops past 1200 tools, no more clipped names/descriptions/schemas.
  // What remains is identity GRAMMAR (not size): ids, digests, scope and
  // generation strings are bounded so a hostile descriptor cannot smuggle an
  // oversized identity through the authority comparisons.
  maxIdentityBytes: 256,
  maxScopeBytes: 768,
});

export const TOOL_SOURCE_KINDS = Object.freeze([
  "extension-builtin",
  "chrome-api",
  "management",
  "webmcp-declared",
  "webmcp-inferred",
  "bundled-package",
  // Remote MCP servers the agent connects OUT to (Streamable HTTP / SSE). Their
  // tools are namespaced `mcp__<server>__<tool>` and their output is untrusted
  // external content (extension/lib/mcp-run-tools.js, MCP-TOOL-INJECTION-01).
  "mcp",
  // Provider-EXECUTED (server-side) tools — e.g. Gemini google_search. Their
  // "dispatch" is a per-run latch, not a client execution
  // (extension/lib/provider-server-tools.js).
  "provider-server",
]);

export const TOOL_AVAILABILITIES = Object.freeze([
  "ready",
  "owner-action-required",
  "stale",
  "disabled",
]);

export class ToolCatalogValidationError extends Error {
  constructor(code) {
    super(`tool catalog descriptor rejected: ${code}`);
    this.name = "ToolCatalogValidationError";
    this.code = code;
  }
}

function ownData(value, key) {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return ""; // never invoke untrusted object coercion hooks
}

const FORBIDDEN_UNICODE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

export function normalizeCatalogText(value) {
  const text = safeString(value);
  if (!text || hasLoneSurrogates(text) || FORBIDDEN_UNICODE.test(text)) {
    return "";
  }
  try {
    return text.normalize("NFKC").trim().replace(/\s+/gu, " ");
  } catch {
    return "";
  }
}

function boundedIdentity(value, code) {
  const text = normalizeCatalogText(value);
  if (!text || utf8ByteLength(text) > TOOL_CATALOG_BOUNDS.maxIdentityBytes) {
    throw new ToolCatalogValidationError(code);
  }
  return text;
}

function boundedText(value, code, { allowEmpty = true } = {}) {
  // dptw: text is validated (no lone surrogates) but never size-clipped.
  const text = normalizeCatalogText(value);
  if ((!allowEmpty && !text) || hasLoneSurrogates(text)) {
    throw new ToolCatalogValidationError(code);
  }
  return text;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      ).join(",")
    }}`;
  }
  return "null";
}

function projectSchema(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 256 || depth > 6) return "[bounded]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return truncateUtf8(redactSecretText(value), 256);
  if (typeof value === "bigint") return "[bigint]";
  if (typeof value === "function" || typeof value === "symbol") {
    return "[opaque]";
  }
  if (Array.isArray(value)) {
    const out = [];
    for (let index = 0; index < Math.min(value.length, 32); index++) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        throw new ToolCatalogValidationError("schema-hostile");
      }
      if (!descriptor || !("value" in descriptor)) {
        out.push("[accessor]");
      } else {
        out.push(projectSchema(descriptor.value, depth + 1, budget));
      }
    }
    return out;
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out = {};
    // Runtime parser caches are execution state, not schema identity. Zod 3
    // populates `_cached` on first safeParse(); including it would change a
    // descriptor/catalog generation merely because validation ran.
    for (
      const key of Object.keys(descriptors).filter((key) => key !== "_cached")
        .sort().slice(0, 64)
    ) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) {
        out[key] = "[accessor]";
        continue;
      }
      out[key] = projectSchema(descriptor.value, depth + 1, budget);
    }
    return out;
  } catch {
    throw new ToolCatalogValidationError("schema-hostile");
  }
}

function providerJsonSchema(value) {
  try {
    if (ownData(ownData(value, "~standard"), "vendor") === "zod") {
      const { $schema: _dialect, ...json } = zodSchema(value).jsonSchema;
      return json;
    }
  } catch {
    throw new ToolCatalogValidationError("schema-hostile");
  }
  return value;
}

function summarizeSchema(value) {
  let summary;
  try {
    summary = canonicalJson(projectSchema(providerJsonSchema(value)));
  } catch (error) {
    if (error instanceof ToolCatalogValidationError) throw error;
    throw new ToolCatalogValidationError("schema-hostile");
  }
  return summary;
}

export function summarizeToolSchema(value, sourceKind = "extension-builtin", toolId = "unknown") {
  return summarizeSchema(schemaWithArgumentContract(
    providerJsonSchema(value),
    sourceKind,
    toolId,
  ));
}

export function summarizeToolOutputSchema(value, toolId = "unknown") {
  return summarizeSchema(toolOutputSchema(toolId, value));
}

function normalizeList(value, { code }) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ToolCatalogValidationError(code);
  }
  const seen = new Set();
  const out = [];
  for (let index = 0; index < value.length; index++) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw new ToolCatalogValidationError(code);
    }
    if (!descriptor || !("value" in descriptor)) {
      throw new ToolCatalogValidationError(code);
    }
    const text = boundedText(descriptor.value, code, {
      allowEmpty: false,
    });
    const key = text.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(text);
    }
  }
  return out.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function normalizeScope(scope) {
  let raw;
  try {
    raw = scope && typeof scope === "object" ? scope : {};
  } catch {
    throw new ToolCatalogValidationError("scope-hostile");
  }
  const normalized = {
    hub: ownData(raw, "hub") === true,
    agentId: boundedText(ownData(raw, "agentId"), "scope-agent"),
    origin: boundedText(ownData(raw, "origin"), "scope-origin"),
    documentId: boundedText(ownData(raw, "documentId"), "scope-document"),
  };
  if (
    utf8ByteLength(canonicalJson(normalized)) >
      TOOL_CATALOG_BOUNDS.maxScopeBytes
  ) {
    throw new ToolCatalogValidationError("scope-too-large");
  }
  return Object.freeze(normalized);
}

function normalizedCollisionText(value) {
  return normalizeCatalogText(value).toLocaleLowerCase("en-US");
}

export function canonicalToolDescriptor(input) {
  if (!input || typeof input !== "object") {
    throw new ToolCatalogValidationError("not-object");
  }
  const sourceKind = boundedIdentity(
    ownData(input, "sourceKind"),
    "source-kind",
  );
  if (!TOOL_SOURCE_KINDS.includes(sourceKind)) {
    throw new ToolCatalogValidationError("source-kind");
  }
  const packageId = boundedIdentity(ownData(input, "packageId"), "package-id");
  const toolId = boundedIdentity(ownData(input, "toolId"), "tool-id");
  const version = boundedIdentity(ownData(input, "version"), "version");
  const name = boundedText(
    ownData(input, "name"),
    "name",
    { allowEmpty: false },
  );
  const normalizedName = normalizedCollisionText(name);
  if (!normalizedName) throw new ToolCatalogValidationError("name");
  const aliases = normalizeList(ownData(input, "aliases"), { code: "aliases" }).filter((alias) => normalizedCollisionText(alias) !== normalizedName);
  const description = boundedText(
    ownData(input, "description"),
    "description",
  );
  const schemaSummary = summarizeToolSchema(
    ownData(input, "inputSchema"),
    sourceKind,
    toolId,
  );
  const outputSchemaSummary = summarizeToolOutputSchema(
    ownData(input, "outputSchema"),
    toolId,
  );
  const capabilities = normalizeList(ownData(input, "capabilities"), { code: "capabilities" });
  const scope = normalizeScope(ownData(input, "scope"));
  const sourceGeneration = boundedText(
    ownData(input, "sourceGeneration"),
    "source-generation",
    { allowEmpty: false },
  );
  const closureGeneration = boundedIdentity(
    ownData(input, "closureGeneration") ?? sourceGeneration,
    "closure-generation",
  );
  const packageDigest = boundedIdentity(
    ownData(input, "packageDigest") ?? sha256Hex(`${packageId}\u0000${version}\u0000${sourceGeneration}`),
    "package-digest",
  );
  const permissionDigest = boundedIdentity(
    ownData(input, "permissionDigest") ?? "none",
    "permission-digest",
  );
  const grantDigest = boundedIdentity(
    ownData(input, "grantDigest") ?? "none",
    "grant-digest",
  );
  if (
    sourceKind === "bundled-package" &&
    !/^[a-f0-9]{64}$/u.test(packageDigest)
  ) {
    throw new ToolCatalogValidationError("package-digest");
  }
  const dispatcherKind = boundedIdentity(
    ownData(input, "dispatcherKind"),
    "dispatcher-kind",
  );
  const availability = safeString(ownData(input, "availability")) || "ready";
  if (!TOOL_AVAILABILITIES.includes(availability)) {
    throw new ToolCatalogValidationError("availability");
  }
  // Replay safety is trusted only when supplied by a product-owned adapter.
  // WebMCP/page metadata is always unknown regardless of page claims, and a
  // REMOTE MCP server's tool is an external side effect of unknown class — never
  // auto-resumed after an interruption (fail closed).
  const trustedReplaySafety = (sourceKind.startsWith("webmcp-") || sourceKind === "mcp")
    ? REPLAY_UNKNOWN
    : replaySafetyForTool(toolId);
  const capabilityDigest = sha256Hex(canonicalJson(capabilities));
  const descriptorDigest = sha256Hex(canonicalJson({
    sourceKind,
    packageId,
    toolId,
    version,
    name,
    aliases,
    description,
    schemaSummary,
    outputSchemaSummary,
    capabilities,
    dispatcherKind,
    closureGeneration,
    packageDigest,
    permissionDigest,
    grantDigest,
  }));
  const identity = {
    sourceKind,
    packageId,
    toolId,
    version,
    digest: descriptorDigest,
    packageDigest,
    capabilityDigest,
    permissionDigest,
    grantDigest,
    scope,
    sourceGeneration,
    closureGeneration,
  };
  const stableId = `tool:v1:${sha256Hex(canonicalJson(identity))}`;
  return Object.freeze({
    schemaVersion: TOOL_CATALOG_SCHEMA_VERSION,
    stableId,
    ...identity,
    name,
    normalizedName,
    aliases: Object.freeze(aliases),
    normalizedAliases: Object.freeze(
      aliases.map(normalizedCollisionText).sort(),
    ),
    description,
    schemaSummary,
    outputSchemaSummary,
    capabilities: Object.freeze(capabilities),
    availability,
    dispatcherKind,
    trustedReplaySafety,
  });
}

function namespaceCollisionKey(descriptor, label) {
  return canonicalJson({
    sourceKind: descriptor.sourceKind,
    packageId: descriptor.packageId,
    scope: descriptor.scope,
    label,
  });
}

export function buildToolCatalog(inputs) {
  const sourceInputs = Array.isArray(inputs) ? inputs : [];
  let rawInputLength = 0;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(
      sourceInputs,
      "length",
    );
    rawInputLength = Number(lengthDescriptor?.value) || 0;
  } catch {
    rawInputLength = 0;
  }
  const inputLength = rawInputLength;
  const inspectLimit = Infinity;
  const diagnostics = {
    input: inputLength,
    accepted: 0,
    rejected: 0,
    collisions: 0,
    duplicateStableIds: 0,
    truncated: Math.max(0, inputLength - inspectLimit),
    errors: {},
  };
  const valid = [];
  for (let index = 0; index < Math.min(rawInputLength, inspectLimit); index++) {
    let input;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(
        sourceInputs,
        String(index),
      );
      if (!descriptor || !("value" in descriptor)) {
        throw new ToolCatalogValidationError("input-accessor");
      }
      input = descriptor.value;
    } catch (error) {
      diagnostics.rejected++;
      const code = error instanceof ToolCatalogValidationError
        ? error.code
        : "unexpected";
      diagnostics.errors[code] = (diagnostics.errors[code] ?? 0) + 1;
      continue;
    }
    try {
      valid.push(canonicalToolDescriptor(input));
    } catch (error) {
      diagnostics.rejected++;
      const code = error instanceof ToolCatalogValidationError
        ? error.code
        : "unexpected";
      diagnostics.errors[code] = (diagnostics.errors[code] ?? 0) + 1;
    }
  }

  // Within one source/package/scope namespace, canonical names and aliases are
  // a single lookup namespace. Any ambiguous label excludes every collider;
  // source order can never decide which tool wins.
  const labelOwners = new Map();
  const collidingStableIds = new Set();
  for (const descriptor of valid) {
    for (
      const label of [
        descriptor.normalizedName,
        ...descriptor.normalizedAliases,
      ]
    ) {
      const key = namespaceCollisionKey(descriptor, label);
      const owner = labelOwners.get(key);
      if (owner && owner.stableId !== descriptor.stableId) {
        collidingStableIds.add(owner.stableId);
        collidingStableIds.add(descriptor.stableId);
      } else if (!owner) {
        labelOwners.set(key, descriptor);
      }
    }
  }
  diagnostics.collisions = collidingStableIds.size;

  const byStableId = new Map();
  for (const descriptor of valid) {
    if (collidingStableIds.has(descriptor.stableId)) continue;
    if (byStableId.has(descriptor.stableId)) {
      diagnostics.duplicateStableIds++;
      continue;
    }
    byStableId.set(descriptor.stableId, descriptor);
  }

  const sorted = [...byStableId.values()].sort((a, b) =>
    a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0
  );
  // dptw: every descriptor lands — no count or byte ceiling, no silent drop.
  // `bytes` stays in diagnostics as INFORMATIONAL measurement only.
  const descriptors = [];
  let bytes = 0;
  for (const descriptor of sorted) {
    bytes += utf8ByteLength(canonicalJson(descriptor));
    descriptors.push(descriptor);
  }
  diagnostics.accepted = descriptors.length;
  const generation = sha256Hex(canonicalJson(
    descriptors.map((descriptor) => ({
      stableId: descriptor.stableId,
      sourceGeneration: descriptor.sourceGeneration,
      availability: descriptor.availability,
    })),
  ));
  return Object.freeze({
    schemaVersion: TOOL_CATALOG_SCHEMA_VERSION,
    generation,
    descriptors: Object.freeze(descriptors),
    byStableId: Object.freeze(Object.fromEntries(
      descriptors.map((descriptor) => [descriptor.stableId, descriptor]),
    )),
    diagnostics: Object.freeze({
      ...diagnostics,
      errors: Object.freeze({ ...diagnostics.errors }),
      bytes,
    }),
  });
}

function adaptAiToolMap(toolMap, context) {
  const inputs = [];
  let entries;
  try {
    entries = Object.entries(Object.getOwnPropertyDescriptors(toolMap ?? {}))
      .filter(([, descriptor]) => "value" in descriptor)
      .map(([name, descriptor]) => [name, descriptor.value]);
  } catch {
    return inputs;
  }
  for (
    const [name, aiTool] of entries
  ) {
    inputs.push({
      sourceKind: context.sourceKind,
      packageId: context.packageId,
      toolId: name,
      version: context.version,
      name,
      aliases: context.aliasesByTool?.[name] ?? [],
      description: ownData(aiTool, "description") ?? "",
      inputSchema: ownData(aiTool, "inputSchema") ?? {},
      outputSchema: ownData(aiTool, "outputSchema") ?? context.outputSchemaByTool?.[name],
      capabilities: context.capabilitiesByTool?.[name] ??
        context.capabilities ?? [],
      scope: context.scope,
      sourceGeneration: context.sourceGeneration,
      closureGeneration: context.closureGeneration ?? context.sourceGeneration,
      packageDigest: context.packageDigest,
      permissionDigest: context.permissionDigestByTool?.[name] ?? context.permissionDigest,
      grantDigest: context.grantDigestByTool?.[name] ?? context.grantDigest,
      availability: context.availabilityByTool?.[name] ?? context.availability ?? "ready",
      dispatcherKind: context.dispatcherKind,
    });
  }
  return inputs;
}

export function adaptBuiltinTools(toolMap, context) {
  return adaptAiToolMap(toolMap, {
    ...context,
    sourceKind: "extension-builtin",
    packageId: context?.packageId ?? "cap.core-tools",
    dispatcherKind: "builtin",
  });
}

export function adaptBrowserTools(toolMap, context) {
  return adaptAiToolMap(toolMap, {
    ...context,
    sourceKind: "chrome-api",
    packageId: context?.packageId ?? "cap.browser-tools",
    dispatcherKind: "browser",
  });
}

export function adaptManagementTools(toolMap, context) {
  return adaptAiToolMap(toolMap, {
    ...context,
    sourceKind: "management",
    packageId: context?.packageId ?? "cap.management-tools",
    dispatcherKind: "management",
  });
}

export function adaptMcpTools(toolMap, context) {
  return adaptAiToolMap(toolMap, {
    ...context,
    sourceKind: "mcp",
    packageId: context?.packageId ?? "cap.mcp-tools",
    dispatcherKind: "mcp",
    // A remote server's tool can declare no host capabilities — the only
    // capability it carries is "connect out and invoke".
    capabilities: context?.capabilities ?? ["mcp.invoke"],
  });
}

export function adaptWebMcpTools(tools, context) {
  const inputs = [];
  for (
    const sourceTool of (Array.isArray(tools) ? tools : [])
  ) {
    const source = safeString(ownData(sourceTool, "source"));
    if (source !== "declared" && source !== "inferred") continue;
    const name = ownData(sourceTool, "name");
    inputs.push({
      sourceKind: `webmcp-${source}`,
      packageId: context?.packageId ?? `webmcp:${context?.origin ?? "unknown"}`,
      toolId: name,
      version: context?.version ?? "page-current",
      name,
      aliases: [],
      description: ownData(sourceTool, "description") ?? "",
      inputSchema: ownData(sourceTool, "inputSchema") ?? {},
      outputSchema: ownData(sourceTool, "outputSchema"),
      // Page text cannot declare host capabilities or replay safety.
      capabilities: ["webmcp.invoke"],
      scope: {
        hub: false,
        agentId: context?.agentId ?? "",
        origin: context?.origin ?? "",
        documentId: context?.documentId ?? "",
      },
      sourceGeneration: context?.sourceGeneration ?? "unversioned",
      closureGeneration: context?.closureGeneration ?? context?.sourceGeneration ?? "unversioned",
      packageDigest: context?.packageDigest,
      permissionDigest: context?.permissionDigestByTool?.[name] ?? context?.permissionDigest,
      grantDigest: context?.grantDigestByTool?.[name] ?? context?.grantDigest,
      availability: context?.availabilityByTool?.[name] ?? context?.availability ?? "ready",
      dispatcherKind: "webmcp",
    });
  }
  return inputs;
}

/** Catalog-only bundled Wasm projection. A row may be searchable while still
 * disabled for provider execution; only a separately supplied live dispatch
 * closure can make it executable. Settings-preview admission never implies a
 * provider route. */
export function adaptBundledTools(rows, context = {}) {
  const inputs = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const toolId = ownData(row, "toolId");
    const binary = ownData(row, "binary");
    const packageDigest = ownData(binary, "sha256");
    const isAdmitted = row?.admitted === true && row?.disabled !== true;
    const availability = context?.availabilityByTool?.[toolId] ?? (isAdmitted ? "ready" : "disabled");
    const dispatcherKind = context?.dispatcherKind ?? (isAdmitted ? "bundled-wasm-task" : "bundled-wasm-disabled");
    inputs.push({
      sourceKind: "bundled-package",
      packageId: ownData(row, "packageId"),
      toolId,
      version: ownData(row, "version"),
      name: toolId,
      aliases: [],
      description: ownData(row, "description") ?? ownData(row, "displayName") ?? "",
      inputSchema: context.inputSchemaByTool?.[toolId] ?? {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" }, description: "command-line arguments, excluding argv[0]" },
          stdin: { type: "string", description: "inline UTF-8 input; omitted when inputRef is used" },
          inputRef: {
            type: "object",
            description: "opaque file-backed input or prior tool-output reference",
            properties: {
              version: { type: "integer", const: 1 },
              id: { type: "string", pattern: "^[0-9a-f]{32}$" },
              kind: { type: "string", enum: ["input", "stdout"] },
            },
            required: ["version", "id", "kind"],
            additionalProperties: false,
          },
        },
        not: { required: ["stdin", "inputRef"] },
        additionalProperties: false,
      },
      outputSchema: context.outputSchemaByTool?.[toolId],
      capabilities: ownData(row, "capabilities") ?? [],
      scope: context.scope ?? { hub: true, agentId: "hub", origin: "", documentId: "" },
      sourceGeneration: context.sourceGeneration ?? `bundled:${packageDigest}`,
      closureGeneration: context.closureGeneration ?? "provider-route-absent",
      packageDigest,
      permissionDigest: "none",
      grantDigest: "none",
      availability,
      dispatcherKind,
    });
  }
  return inputs;
}

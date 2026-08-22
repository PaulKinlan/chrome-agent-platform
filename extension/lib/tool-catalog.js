// lib/tool-catalog.js — bounded metadata-only shadow catalog authority.
//
// This module describes existing tools; it cannot execute tools, install
// packages, request permissions, or create grants. Current source dispatchers
// remain authoritative. Descriptions and schemas may be page-controlled, so
// they are treated only as bounded searchable data.

import {
  hasLoneSurrogates,
  sha256Hex,
  truncateUtf8,
  utf8ByteLength,
} from "./pure.js";
import { REPLAY_UNKNOWN, replaySafetyForTool } from "./tool-replay-safety.js";

export const TOOL_CATALOG_SCHEMA_VERSION = 1;

export const TOOL_CATALOG_BOUNDS = Object.freeze({
  maxDescriptors: 1200,
  maxCatalogBytes: 2 * 1024 * 1024,
  maxNameBytes: 192,
  maxDescriptionBytes: 1024,
  maxAliases: 12,
  maxAliasBytes: 128,
  maxSchemaBytes: 4096,
  maxCapabilities: 24,
  maxCapabilityBytes: 96,
  maxIdentityBytes: 256,
  maxSourceGenerationBytes: 192,
  maxScopeBytes: 768,
});

export const TOOL_SOURCE_KINDS = Object.freeze([
  "extension-builtin",
  "chrome-api",
  "management",
  "webmcp-declared",
  "webmcp-inferred",
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

function boundedText(value, maxBytes, code, { allowEmpty = true } = {}) {
  const text = normalizeCatalogText(value);
  if ((!allowEmpty && !text) || hasLoneSurrogates(text)) {
    throw new ToolCatalogValidationError(code);
  }
  return truncateUtf8(text, maxBytes);
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
  if (typeof value === "string") return truncateUtf8(value, 256);
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

export function summarizeToolSchema(value) {
  let summary;
  try {
    summary = canonicalJson(projectSchema(value));
  } catch (error) {
    if (error instanceof ToolCatalogValidationError) throw error;
    throw new ToolCatalogValidationError("schema-hostile");
  }
  if (utf8ByteLength(summary) > TOOL_CATALOG_BOUNDS.maxSchemaBytes) {
    throw new ToolCatalogValidationError("schema-too-large");
  }
  return summary;
}

function normalizeList(value, { maxItems, maxBytes, code }) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
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
    const text = boundedText(descriptor.value, maxBytes, code, {
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
    agentId: boundedText(ownData(raw, "agentId"), 192, "scope-agent"),
    origin: boundedText(ownData(raw, "origin"), 256, "scope-origin"),
    documentId: boundedText(
      ownData(raw, "documentId"),
      192,
      "scope-document",
    ),
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
    TOOL_CATALOG_BOUNDS.maxNameBytes,
    "name",
    { allowEmpty: false },
  );
  const normalizedName = normalizedCollisionText(name);
  if (!normalizedName) throw new ToolCatalogValidationError("name");
  const aliases = normalizeList(ownData(input, "aliases"), {
    maxItems: TOOL_CATALOG_BOUNDS.maxAliases,
    maxBytes: TOOL_CATALOG_BOUNDS.maxAliasBytes,
    code: "aliases",
  }).filter((alias) => normalizedCollisionText(alias) !== normalizedName);
  const description = boundedText(
    ownData(input, "description"),
    TOOL_CATALOG_BOUNDS.maxDescriptionBytes,
    "description",
  );
  const schemaSummary = summarizeToolSchema(ownData(input, "inputSchema"));
  const capabilities = normalizeList(ownData(input, "capabilities"), {
    maxItems: TOOL_CATALOG_BOUNDS.maxCapabilities,
    maxBytes: TOOL_CATALOG_BOUNDS.maxCapabilityBytes,
    code: "capabilities",
  });
  const scope = normalizeScope(ownData(input, "scope"));
  const sourceGeneration = boundedText(
    ownData(input, "sourceGeneration"),
    TOOL_CATALOG_BOUNDS.maxSourceGenerationBytes,
    "source-generation",
    { allowEmpty: false },
  );
  const dispatcherKind = boundedIdentity(
    ownData(input, "dispatcherKind"),
    "dispatcher-kind",
  );
  const availability = safeString(ownData(input, "availability")) || "ready";
  if (!TOOL_AVAILABILITIES.includes(availability)) {
    throw new ToolCatalogValidationError("availability");
  }
  // Replay safety is trusted only when supplied by a product-owned adapter.
  // WebMCP/page metadata is always unknown regardless of page claims.
  const trustedReplaySafety = sourceKind.startsWith("webmcp-")
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
    capabilities,
    dispatcherKind,
  }));
  const identity = {
    sourceKind,
    packageId,
    toolId,
    version,
    digest: descriptorDigest,
    capabilityDigest,
    scope,
    sourceGeneration,
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
  const inputLength = Math.min(rawInputLength, 1000000);
  const inspectLimit = TOOL_CATALOG_BOUNDS.maxDescriptors * 2;
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
  const descriptors = [];
  let bytes = 0;
  for (const descriptor of sorted) {
    if (descriptors.length >= TOOL_CATALOG_BOUNDS.maxDescriptors) {
      diagnostics.truncated++;
      continue;
    }
    const descriptorBytes = utf8ByteLength(canonicalJson(descriptor));
    if (bytes + descriptorBytes > TOOL_CATALOG_BOUNDS.maxCatalogBytes) {
      diagnostics.truncated++;
      continue;
    }
    bytes += descriptorBytes;
    descriptors.push(descriptor);
  }
  diagnostics.accepted = descriptors.length;
  const generation = sha256Hex(canonicalJson(
    descriptors.map((descriptor) => ({
      stableId: descriptor.stableId,
      sourceGeneration: descriptor.sourceGeneration,
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
    const [name, aiTool] of entries.slice(0, TOOL_CATALOG_BOUNDS.maxDescriptors)
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
      capabilities: context.capabilitiesByTool?.[name] ??
        context.capabilities ?? [],
      scope: context.scope,
      sourceGeneration: context.sourceGeneration,
      availability: context.availability ?? "ready",
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

export function adaptWebMcpTools(tools, context) {
  const inputs = [];
  for (
    const sourceTool of (Array.isArray(tools) ? tools : []).slice(
      0,
      TOOL_CATALOG_BOUNDS.maxDescriptors,
    )
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
      // Page text cannot declare host capabilities or replay safety.
      capabilities: ["webmcp.invoke"],
      scope: {
        hub: false,
        agentId: context?.agentId ?? "",
        origin: context?.origin ?? "",
        documentId: context?.documentId ?? "",
      },
      sourceGeneration: context?.sourceGeneration ?? "unversioned",
      availability: context?.availability ?? "ready",
      dispatcherKind: "webmcp",
    });
  }
  return inputs;
}

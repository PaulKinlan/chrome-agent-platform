// Broker core for admitted Emscripten schema-2 packages (chrome-agent-platform-ltkj.3).
//
// The service worker is the ONLY broker: it enumerates committed registry
// records, surfaces each admitted entry operation as a model-facing tool,
// validates the exact scalar arguments against the admitted manifest's
// parameter bounds, re-checks the registry at dispatch time (a stale
// version/graphDigest fails closed), builds the exact cap:emscripten-run
// envelope, and races the offscreen host with a lifecycle-derived deadline.
//
// The envelope carries ONLY identity, the broker-derived operation descriptor,
// scalar-validated args, opaque asset references (role/path/sha256/size from
// the admitted manifest) and lifecycle bounds — never caller-provided Module,
// hooks, JS, asset URLs, export names, locateFile, dynamicLibraries or
// memory/pool settings.

import { EMSCRIPTEN_RUN_TYPE } from "./emscripten-host.js";

export function isSchema2Admitted(pkg) {
  return Boolean(pkg && pkg.schema2 === true && pkg.manifest && pkg.graphDigest);
}

// Enumerate committed schema-2 packages as catalog rows (one per entry op).
export function emscriptenCatalogRows(packages) {
  const rows = [];
  for (const pkg of Array.isArray(packages) ? packages : []) {
    if (!isSchema2Admitted(pkg)) continue;
    const operations = pkg.manifest?.entry?.operations;
    if (!Array.isArray(operations)) continue;
    for (const op of operations) {
      if (op?.kind !== "native-scalar-v1" || typeof op?.toolId !== "string" || !op.toolId) continue;
      rows.push(Object.freeze({
        packageId: pkg.packageId,
        version: pkg.version,
        graphDigest: pkg.graphDigest,
        operationId: op.id,
        toolId: op.toolId,
        adapterId: pkg.manifest.entry.adapterId,
        exportName: op.exportName,
        result: op.result,
        params: op.params,
      }));
    }
  }
  return rows;
}

function inputSchemaFor(op) {
  const properties = {};
  const required = [];
  for (const param of op.params ?? []) {
    properties[param.name] = {
      type: "number",
      minimum: param.minimum,
      maximum: param.maximum,
      description: `${param.type} scalar in [${param.minimum}, ${param.maximum}]`,
    };
    required.push(param.name);
  }
  return Object.freeze({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
}

// Validate raw model args against the admitted parameter bounds. Returns the
// ORDERED scalar array (manifest params order) the envelope carries.
export function validateEmscriptenOperationArgs(row, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { ok: false, error: "invalid_arguments: shape" };
  }
  if (Object.hasOwn(rawArgs, "toolId") && rawArgs.toolId !== row.toolId) {
    return { ok: false, error: "invalid_arguments: toolId" };
  }
  const params = Array.isArray(row.params) ? row.params : [];
  const keys = Object.keys(rawArgs).filter((k) => k !== "toolId");
  const expected = new Set(params.map((param) => param.name));
  if (keys.length !== expected.size || !keys.every((k) => expected.has(k))) {
    return { ok: false, error: "invalid_arguments: unexpected_keys" };
  }
  const args = [];
  for (const param of params) {
    const value = rawArgs[param.name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: `invalid_arguments: ${param.name} must be a finite number` };
    }
    if (param.type === "i32" && !Number.isSafeInteger(value)) {
      return { ok: false, error: `invalid_arguments: ${param.name} must be a safe integer` };
    }
    if (value < param.minimum || value > param.maximum) {
      return { ok: false, error: `invalid_arguments: ${param.name} outside [${param.minimum}, ${param.maximum}]` };
    }
    args.push(value);
  }
  return { ok: true, data: Object.freeze({ args: Object.freeze(args) }) };
}

// Build the exact cap:emscripten-run envelope from a FRESH committed registry
// record. The stale-graph fence lives in the caller (version + graphDigest are
// compared against the record used at catalog composition).
export function buildEmscriptenRunEnvelope({ record, operationId, args, authority }) {
  const manifest = record?.manifest;
  if (!manifest || typeof operationId !== "string") return null;
  const operations = manifest?.entry?.operations;
  const op = Array.isArray(operations) ? operations.find((candidate) => candidate?.id === operationId) : null;
  if (!op || op.kind !== "native-scalar-v1") return null;
  const assets = (manifest.assets ?? [])
    .filter((asset) => asset && (asset.role === "adapter" || asset.role === "glue" || asset.role === "main-wasm"))
    .map((asset) => ({
      role: asset.role,
      path: String(asset.path).replace(/^extension\//, ""),
      sha256: asset.sha256,
      size: asset.size,
    }));
  const lifecycle = manifest.resources?.lifecycle ?? {};
  return Object.freeze({
    type: EMSCRIPTEN_RUN_TYPE,
    packageId: manifest.package.id ?? manifest.package.name,
    version: manifest.package.version,
    graphDigest: record.graphDigest,
    operationId: op.id,
    operation: Object.freeze({
      id: op.id,
      adapterId: manifest.entry.adapterId,
      exportName: op.exportName,
      result: op.result,
      params: Object.freeze((op.params ?? []).map((param) => Object.freeze({
        name: param.name, type: param.type, minimum: param.minimum, maximum: param.maximum,
      }))),
    }),
    args: Object.freeze([...args]),
    assets: Object.freeze(assets.map((asset) => Object.freeze(asset))),
    lifecycle: Object.freeze({ startupMs: lifecycle.startupMs, callMs: lifecycle.callMs }),
    authority,
  });
}

// Model-facing executable records — one per admitted entry operation. The
// validator bounds args against the admitted manifest; the authorizer treats
// owner admission in the registry as the execution grant (policy mirrors the
// bundled build-admission lane); dispatch re-queries the registry fresh.
export function executableEmscriptenToolRecords(packages, context = {}) {
  return emscriptenCatalogRows(packages).map((row) => {
    const descriptorInput = Object.freeze({
      sourceKind: "emscripten-package",
      packageId: row.packageId,
      operationId: row.operationId,
      toolId: row.toolId,
      version: row.version,
      name: row.toolId,
      aliases: [],
      description:
        `${row.toolId} — admitted Emscripten operation ${row.operationId} of ${row.packageId} v${row.version}. ` +
        `In: named scalar arguments (${(row.params ?? []).map((param) => param.name).join(", ")}). ` +
        "Out: a single scalar result. Runs in a fresh worker with a host-owned deadline; validated-not-persistent.",
      inputSchema: inputSchemaFor({ params: row.params }),
      outputSchema: undefined,
      capabilities: [],
      scope: context.scope ?? { hub: true, agentId: "hub", origin: "", documentId: "" },
      sourceGeneration: `emscripten-package:${row.packageId}:${row.version}:${row.graphDigest}`,
      closureGeneration: "emscripten-runtime:v1",
      packageDigest: row.graphDigest,
      permissionDigest: "none",
      grantDigest: "none",
      availability: "ready",
      dispatcherKind: "emscripten-run",
    });

    const validator = async (rawArgs) => validateEmscriptenOperationArgs(row, rawArgs);

    const authorizer = async () => Object.freeze({
      ok: true,
      policy: "owner-registry-admission",
      toolId: row.toolId,
      permissionDigest: "none",
      grantDigest: "none",
    });

    const dispatcher = async (validatedArgs, runContext) => {
      if (typeof context.dispatchEmscriptenRun !== "function") {
        return { ok: false, error: "emscripten_dispatcher_unavailable" };
      }
      return await context.dispatchEmscriptenRun({
        packageId: row.packageId,
        version: row.version,
        graphDigest: row.graphDigest,
        operationId: row.operationId,
        args: validatedArgs?.args ?? [],
        context: runContext,
      });
    };

    return Object.freeze({
      descriptorInput,
      validateArguments: validator,
      authorize: authorizer,
      dispatch: dispatcher,
    });
  });
}

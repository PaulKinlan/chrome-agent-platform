// Read-only registry core for the wasm package authority (chrome-agent-platform-ltkj.3).
//
// wasm-package-authority.js is the WRITE/validation authority and must stay
// out of the service-worker bundle (the standing static/RHC boundary pin).
// The SW's Emscripten broker still needs a fail-closed registry READ at
// dispatch time — this module is that read path: the key constants, the
// registry/WAL shape validators (imported back by the authority — single
// source of truth, no drift), and a small committed-record reader.
//
// Read semantics: a prepared (mid-flight) WAL makes the reader REFUSE with
// busy — recovery stays writer-side (the next Settings admission/query
// recovers it); a dispatch never mutates registry state.

export const REGISTRY_KEY = "wasmPkg";
export const WAL_KEY = "__wasmTx";
export const REPAIR_KEY = "wasmPkgRepair";

const PACKAGE_ID_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/u;

function defaultFail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

// The authority injects its own fail (WasmPackageAuthorityError with path
// detail); the SW read path uses the plain default.
export function validateRegistry(raw, fail = defaultFail) {
  if (raw == null) return { schemaVersion: 1, packages: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1 || !raw.packages || typeof raw.packages !== "object" || Array.isArray(raw.packages) || Object.keys(raw).some((key) => !new Set(["schemaVersion", "packages"]).has(key))) fail("registry_corrupt");
  for (const [packageId, record] of Object.entries(raw.packages)) {
    if (record?.packageId !== packageId || record?.lane !== "bundled" || !record.current || !Array.isArray(record.history)) fail("registry_corrupt", packageId);
    if (!new Set(["committed", "revoked"]).has(record.current.state)) fail("registry_corrupt", packageId);
  }
  return structuredClone(raw);
}

export function validateWalShape(raw, fail = defaultFail) {
  if (raw == null || raw?.state === "none") return null;
  if (!raw || typeof raw !== "object" || !new Set(["prepared", "committed", "compensated"]).has(raw.state) || !new Set(["install", "update", "revoke"]).has(raw.op) || !PACKAGE_ID_RE.test(raw.packageId ?? "") || !Number.isSafeInteger(raw.registryBeforeGen) || (raw.registryAfterGen != null && !Number.isSafeInteger(raw.registryAfterGen)) || !Object.hasOwn(raw, "prevRecord") || !raw.nextRecord) fail("wasm_wal_corrupt");
  return raw;
}

// Read committed records for the dispatch broker. Returns
// { ok:true, packages: Map<packageId, current> } — a prepared WAL refuses
// closed with { ok:false, error:"registry_busy" } rather than racing a
// half-applied admission.
export async function readCommittedPackages(store) {
  const wal = validateWalShape(await store.getStrict(WAL_KEY));
  if (wal && wal.state === "prepared") return { ok: false, error: "registry_busy" };
  const registry = validateRegistry(await store.getStrict(REGISTRY_KEY));
  const packages = new Map();
  for (const [packageId, record] of Object.entries(registry.packages)) {
    if (record.current.state === "committed") packages.set(packageId, structuredClone(record.current));
  }
  return { ok: true, packages };
}

// chrome-agent-platform-ltkj.3 — the SW broker core for admitted Emscripten
// packages: catalog rows from committed schema-2 records only, scalar arg
// validation against admitted bounds, the exact cap:emscripten-run envelope,
// and the authority.list() read path.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildEmscriptenRunEnvelope,
  emscriptenCatalogRows,
  executableEmscriptenToolRecords,
  validateEmscriptenOperationArgs,
} from "../extension/lib/emscripten-run-broker.js";
import { WasmPackageAuthority } from "../extension/lib/wasm-package-authority.js";

const GRAPH = "a".repeat(64);
const MANIFEST = Object.freeze({
  package: { id: "cap.acceptance.a0.numeric", name: "numeric", version: "1.0.0" },
  assets: [
    { role: "glue", path: "extension/wasm/runtime/cap.acceptance.a0.numeric/1.0.0/numeric-glue.mjs", sha256: "g".repeat(64), size: 6155 },
    { role: "adapter", path: "extension/wasm/runtime/cap.acceptance.a0.numeric/1.0.0/cap-a0-numeric-v1.mjs", sha256: "d".repeat(64), size: 1751 },
    { role: "main-wasm", path: `extension/wasm/cas/${"b".repeat(64)}.wasm`, sha256: "b".repeat(64), size: 278 },
  ],
  entry: {
    adapterId: "cap-a0-numeric-v1",
    operations: [{
      id: "weighted_sum",
      toolId: "cap_acceptance_weighted_sum",
      kind: "native-scalar-v1",
      exportName: "cap_weighted_sum",
      result: "f64",
      params: [
        { name: "value", type: "f64", minimum: -1000000, maximum: 1000000 },
        { name: "weight", type: "f64", minimum: -1000000, maximum: 1000000 },
        { name: "bias", type: "f64", minimum: -1000000, maximum: 1000000 },
      ],
    }],
  },
  resources: { lifecycle: { startupMs: 10000, callMs: 30000, concurrentJobs: 1 } },
});

const ROW_PACKAGE = Object.freeze({
  packageId: "cap.acceptance.a0.numeric",
  version: "1.0.0",
  manifestDigest: "m".repeat(64),
  capabilityDigest: "c".repeat(64),
  graphDigest: GRAPH,
  schema2: true,
  manifest: MANIFEST,
});

Deno.test("broker: catalog rows come from committed schema-2 records only", () => {
  const rows = emscriptenCatalogRows([
    ROW_PACKAGE,
    { ...ROW_PACKAGE, packageId: "cap.schema1.only", schema2: false, manifest: null },
    { ...ROW_PACKAGE, packageId: "cap.no.graph", graphDigest: null },
    null,
  ]);
  assertEquals(rows.length, 1, "exactly the committed schema-2 row surfaces");
  assertEquals(rows[0].toolId, "cap_acceptance_weighted_sum");
  assertEquals(rows[0].operationId, "weighted_sum");
  assertEquals(rows[0].adapterId, "cap-a0-numeric-v1");
});

Deno.test("broker: arg validation enforces exact keys, types and admitted bounds", () => {
  const row = emscriptenCatalogRows([ROW_PACKAGE])[0];
  const good = validateEmscriptenOperationArgs(row, { value: 6, weight: 7, bias: 0.5 });
  assertEquals(good.ok, true);
  assertEquals(good.data.args, [6, 7, 0.5], "args ordered by manifest params");
  assertEquals(validateEmscriptenOperationArgs(row, { value: 6, weight: 7 }).ok, false, "missing param");
  assertEquals(validateEmscriptenOperationArgs(row, { value: 6, weight: 7, bias: 0.5, extra: 1 }).ok, false, "extra key");
  assertEquals(validateEmscriptenOperationArgs(row, { value: 6, weight: 7, bias: "0.5" }).ok, false, "non-number");
  assertEquals(validateEmscriptenOperationArgs(row, { value: 6, weight: 2000000, bias: 0.5 }).ok, false, "out of bounds");
  assertEquals(validateEmscriptenOperationArgs(row, { value: 6, weight: 7, bias: 0.5, toolId: "other_tool" }).ok, false, "mismatched toolId");
  assertEquals(validateEmscriptenOperationArgs(row, { value: 6, weight: 7, bias: 0.5, toolId: row.toolId }).ok, true, "matching toolId tolerated");
});

Deno.test("broker: the envelope is exact, frozen and carries broker-derived identity only", () => {
  const authority = Object.freeze({
    sessionId: "s", executionId: "e", callId: "c", agentId: "a", origin: "o", documentId: "d",
  });
  const envelope = buildEmscriptenRunEnvelope({
    record: { graphDigest: GRAPH, manifest: MANIFEST },
    operationId: "weighted_sum",
    args: [6, 7, 0.5],
    authority,
  });
  assert(envelope, "envelope built");
  assertEquals(
    JSON.stringify(Object.keys(envelope).sort()),
    JSON.stringify(["args", "assets", "authority", "graphDigest", "lifecycle", "operation", "operationId", "packageId", "type", "version"]),
    "exact envelope keys",
  );
  assertEquals(envelope.type, "cap:emscripten-run");
  assertEquals(envelope.graphDigest, GRAPH);
  assertEquals(envelope.operation.exportName, "cap_weighted_sum");
  assertEquals(envelope.operation.adapterId, "cap-a0-numeric-v1");
  assertEquals(envelope.lifecycle, { startupMs: 10000, callMs: 30000 });
  assertEquals(envelope.assets.length, 3);
  assert(envelope.assets.every((asset) => !asset.path.startsWith("extension/")), "repo prefix stripped for packaged URLs");
  assert(Object.isFrozen(envelope) && Object.isFrozen(envelope.operation) && Object.isFrozen(envelope.assets));
  assertEquals(buildEmscriptenRunEnvelope({ record: { graphDigest: GRAPH, manifest: MANIFEST }, operationId: "nope", args: [], authority }), null, "unknown operation refused");
});

Deno.test("broker: executable records wire validator/authorizer/dispatch with run identity", async () => {
  const dispatched = [];
  const records = executableEmscriptenToolRecords([ROW_PACKAGE], {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    dispatchEmscriptenRun: async (payload) => { dispatched.push(payload); return { ok: true, phase: "completed", result: 42.5 }; },
  });
  assertEquals(records.length, 1);
  const record = records[0];
  assertEquals(record.descriptorInput.sourceKind, "emscripten-package");
  assertEquals(record.descriptorInput.dispatcherKind, "emscripten-run");
  assertEquals(record.descriptorInput.inputSchema.required, ["value", "weight", "bias"]);
  assertEquals(record.descriptorInput.inputSchema.additionalProperties, false);
  const validated = await record.validateArguments({ value: 6, weight: 7, bias: 0.5 });
  assertEquals(validated.ok, true);
  const auth = await record.authorize(validated.data, {});
  assertEquals(auth.ok, true);
  assertEquals(auth.policy, "owner-registry-admission");
  const result = await record.dispatch(validated.data, { runId: "run-1", agentId: "hub" });
  assertEquals(result.result, 42.5);
  assertEquals(dispatched.length, 1);
  assertEquals(dispatched[0].packageId, "cap.acceptance.a0.numeric");
  assertEquals(dispatched[0].graphDigest, GRAPH, "the composition-time graphDigest travels for the dispatch-time stale fence");
  assertEquals(dispatched[0].args, [6, 7, 0.5]);
  const failed = await record.validateArguments({ value: 6, weight: 7, bias: 0.5, hook: "()=>{}" });
  assertEquals(failed.ok, false, "caller-supplied hooks rejected by exact keys");
});

Deno.test("broker: authority.list surfaces committed schema-2 records with manifests only", async () => {
  const store = {
    rows: new Map(),
    version: 0,
    async getStrict(key) { return this.rows.has(key) ? structuredClone(this.rows.get(key).value) : null; },
    async getVersion(key) { return this.rows.get(key)?.version ?? 0; },
    async setTrusted(key, value) { const t = ++this.version; this.rows.set(key, { value: structuredClone(value), version: t }); return t; },
    async compareAndRestore(key, expected, value) {
      if ((this.rows.get(key)?.version ?? 0) !== expected) return false;
      const t = ++this.version; this.rows.set(key, { value: structuredClone(value), version: t }); return true;
    },
    async compareAndDelete(key, expected) {
      if ((this.rows.get(key)?.version ?? 0) !== expected) return false;
      this.rows.delete(key); this.version++; return true;
    },
  };
  const authority = new WasmPackageAuthority({ getStore: () => store });
  const empty = await authority.list();
  assertEquals(empty.ok, true);
  assertEquals(empty.packages, []);
  // Seed the registry directly (schema-2 committed + a revoked + a schema-1).
  await store.setTrusted("wasmPkg", {
    schemaVersion: 1,
    packages: {
      "cap.acceptance.a0.numeric": { packageId: "cap.acceptance.a0.numeric", lane: "bundled", current: { version: "1.0.0", manifestDigest: "m".repeat(64), capabilityDigest: "c".repeat(64), graphDigest: GRAPH, manifest: MANIFEST, state: "committed" }, history: [] },
      "cap.revoked.pkg": { packageId: "cap.revoked.pkg", lane: "bundled", current: { version: "1.0.0", manifestDigest: "x".repeat(64), capabilityDigest: "y".repeat(64), state: "revoked" }, history: [] },
      "cap.schema1.pkg": { packageId: "cap.schema1.pkg", lane: "bundled", current: { version: "2.0.0", manifestDigest: "z".repeat(64), capabilityDigest: "w".repeat(64), state: "committed" }, history: [] },
    },
  });
  const listed = await authority.list();
  assertEquals(listed.ok, true);
  const ids = listed.packages.map((p) => p.packageId).sort();
  assertEquals(ids, ["cap.acceptance.a0.numeric", "cap.schema1.pkg"], "revoked never listed");
  const schema2 = listed.packages.find((p) => p.packageId === "cap.acceptance.a0.numeric");
  assertEquals(schema2.schema2, true);
  assertEquals(schema2.graphDigest, GRAPH);
  assertEquals(schema2.manifest.package.id, "cap.acceptance.a0.numeric");
  const schema1 = listed.packages.find((p) => p.packageId === "cap.schema1.pkg");
  assertEquals(schema1.schema2, false);
  assertEquals(schema1.manifest, null);
});

Deno.test("broker: readCommittedPackages refuses closed on mid-flight prepared WAL", async () => {
  const { readCommittedPackages } = await import("../extension/lib/wasm-package-registry-core.js");
  const store = {
    rows: new Map([
      ["__wasmTx", { value: { state: "prepared", op: "install", packageId: "cap.busy.pkg", registryBeforeGen: 1, prevRecord: null, nextRecord: {} }, version: 1 }],
      ["wasmPkg", { value: { schemaVersion: 1, packages: {} }, version: 1 }],
    ]),
    async getStrict(key) { return this.rows.has(key) ? structuredClone(this.rows.get(key).value) : null; },
  };
  const result = await readCommittedPackages(store);
  assertEquals(result.ok, false);
  assertEquals(result.error, "registry_busy", "prepared WAL must fail closed with registry_busy");
});


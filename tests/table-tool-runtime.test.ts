// @ts-nocheck
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { TABLE_LIMITS, TABLE_VERSION } from "../extension/lib/table-core.js";
import {
  providerSafeTableAssetRead,
  runTableArtifactTool,
  tableRunOwner,
  TABLE_TOOL_NAMES,
} from "../extension/lib/table-tool-runtime.js";

const context = Object.freeze({
  principal: "model",
  executionId: "exec:11111111-1111-4111-8111-111111111111",
  runId: "exec:11111111-1111-4111-8111-111111111111",
  agentId: "agent-instance-a",
});

function table(value = "secret-cell") {
  return {
    version: TABLE_VERSION,
    localeProfile: "canonical-v1",
    columns: [{ id: "c1", header: "secret-header", type: { kind: "text" } }],
    rows: [[value]],
  };
}

function source(artifactId = "a_source") {
  return { artifactId, format: TABLE_VERSION };
}

function filterArgs(artifactId = "a_source") {
  return { source: source(artifactId), predicate: { column: "c1", op: "is_present" } };
}

function streamDeps(overrides = {}) {
  let sequence = 0;
  return {
    stageAsset: async (asset, { owner }) => ({
      ok: true,
      inputRef: { schema: "cap.wasm-stream/1", id: `s${++sequence}`, kind: "input" },
      bytes: new TextEncoder().encode(asset.content ?? "").byteLength,
      chained: false,
      owner,
    }),
    discardStream: async () => ({ ok: true }),
    isRunLive: () => true,
    ...overrides,
  };
}

Deno.test("table runtime exposes exactly the six approved model tools", () => {
  assertEquals(TABLE_TOOL_NAMES, [
    "table_filter",
    "table_select",
    "table_join",
    "table_group_aggregate",
    "table_pivot",
    "table_formula",
  ]);
});

Deno.test("provider asset reads keep canonical table cells and headers local", () => {
  const response = {
    ok: true,
    asset: {
      id: "a_table",
      type: "data",
      name: "private customer list",
      size: 123,
      content: JSON.stringify(table("private@example.com")),
      meta: {
        schema: TABLE_VERSION,
        sha256: "a".repeat(64),
        rows: 1,
        columns: 1,
        sourceArtifactIds: ["a_private_source"],
        runOwner: "agent:private-run:private-agent",
      },
    },
  };
  const safe = providerSafeTableAssetRead(response);
  assertEquals(safe, {
    ok: true,
    asset: {
      id: "a_table",
      type: "data",
      size: 123,
      meta: {
        schema: TABLE_VERSION,
        sha256: "a".repeat(64),
        rows: 1,
        columns: 1,
        previewAvailableLocally: true,
      },
    },
  });
  const providerBytes = JSON.stringify(safe);
  for (const forbidden of ["private@example.com", "secret-header", "customer list", "a_private_source", "private-run", "private-agent"]) {
    assert(!providerBytes.includes(forbidden));
  }
  const ordinary = { ok: true, asset: { id: "a_text", content: "owner chose an ordinary text artifact" } };
  assert(providerSafeTableAssetRead(ordinary) === ordinary, "non-table artifact behavior is unchanged");
});

Deno.test("table runtime derives custody only from an immutable live model envelope", () => {
  assertEquals(tableRunOwner(context), `agent:${context.runId}:${context.agentId}`);
  for (const forged of [
    { ...context, principal: "extension" },
    { ...context, runId: "exec:other" },
    { ...context, runId: "exec:other", executionId: "exec:other" },
    { ...context, executionId: "exec:other" },
    { ...context, agentId: "" },
  ]) {
    let code = "";
    try { tableRunOwner(forged); } catch (error) { code = error.code; }
    assertEquals(code, "table_run_required");
  }
});

Deno.test("table runtime has no permissive liveness default", async () => {
  let reads = 0;
  const result = await runTableArtifactTool("table_filter", filterArgs(), context, {
    readAsset: async () => { reads++; return { ok: true, asset: { content: JSON.stringify(table()) } }; },
  });
  assertEquals(result.code, "table_cancelled");
  assertEquals(reads, 0);
});

Deno.test("table runtime publishes complete canonical data but returns provider-safe metadata only", async () => {
  const sourceBody = JSON.stringify(table("input-secret-cell"));
  let created;
  let stagedOwner = "";
  let stagedChunkSize = 0;
  let discarded = 0;
  const result = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: sourceBody, meta: { streamOwner: "forged-owner" } } }),
    stageAsset: async (asset, { owner, chunkSize }) => {
      stagedOwner = owner;
      stagedChunkSize = chunkSize;
      return { ok: true, inputRef: { id: "s1", kind: "input" }, bytes: new TextEncoder().encode(asset.content).byteLength, chained: false };
    },
    discardStream: async () => { discarded++; return { ok: true }; },
    runJob: async (_job, options) => {
      assertEquals(options.runId, context.runId);
      return { ok: true, table: table("output-secret-cell"), workUnits: 7 };
    },
    createArtifact: async (origin, input) => {
      created = { origin, input };
      return { ok: true, id: "a_output" };
    },
  }));

  assertEquals(result.ok, true);
  assertEquals(stagedOwner, `agent:${context.runId}:${context.agentId}`);
  assertEquals(stagedChunkSize, TABLE_LIMITS.chunkSize, "table staging writes in exact 64 KiB chunks");
  assertEquals(discarded, 1, "temporary staged input is removed before publication");
  assertEquals(result.artifactId, "a_output");
  assertEquals(result.rows, 1);
  assertEquals(result.columns, 1);
  assertEquals(result.workUnits, 7);
  assertEquals(created.origin, "master");
  assertEquals(JSON.parse(created.input.content), table("output-secret-cell"), "the artifact keeps the complete canonical table");
  assertEquals(created.input.meta.runOwner, `agent:${context.runId}:${context.agentId}`, "caller metadata cannot override custody");
  assertEquals(created.input.meta.operation.version, "cap.table-publication/1");
  assertEquals(created.input.meta.operation.toolId, "table_filter");
  assertEquals(created.input.meta.operation.request, { predicate: { column: "c1", op: "is_present" } });
  assertEquals(created.input.meta.operation.sources[0].role, "source");
  assertEquals(created.input.meta.operation.sources[0].artifactId, "a_source");
  assertEquals(created.input.meta.operation.sources[0].format, TABLE_VERSION);
  assertEquals(created.input.meta.operation.sources[0].bytes, new TextEncoder().encode(sourceBody).byteLength);
  assert(/^[0-9a-f]{64}$/u.test(created.input.meta.operation.sources[0].sha256));
  assert(/^table:[0-9a-f]{64}$/u.test(created.input.key), "the full operation identity is content-digested");
  assertNotEquals(created.input.key, "table:fixed", "no fixed key may alias different table bytes");

  const visible = JSON.stringify(result);
  for (const forbidden of ["input-secret-cell", "output-secret-cell", "secret-header", "forged-owner"]) {
    assert(!visible.includes(forbidden), `provider result must not contain ${forbidden}`);
  }
  assert(new TextEncoder().encode(visible).byteLength <= TABLE_LIMITS.maxProviderResultBytes);
});

Deno.test("table runtime uses distinct keyed identities for distinct table content", async () => {
  const keys = [];
  let value = "first";
  const deps = streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table("source")) } }),
    runJob: async () => ({ ok: true, table: table(value), workUnits: 1 }),
    createArtifact: async (_origin, input) => { keys.push(input.key); return { ok: true, id: `a_${keys.length}` }; },
  });
  const first = await runTableArtifactTool("table_filter", filterArgs(), context, deps);
  value = "second";
  const second = await runTableArtifactTool("table_filter", filterArgs(), context, deps);
  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  assertNotEquals(keys[0], keys[1]);
  assertNotEquals(first.sha256, second.sha256);
});

Deno.test("table runtime keeps provenance-distinct operations separate even when output bytes match", async () => {
  const keys = [];
  const deps = streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table("same input")) } }),
    runJob: async () => ({ ok: true, table: table("same output"), workUnits: 1 }),
    createArtifact: async (_origin, input) => { keys.push(input.key); return { ok: true, id: `a_${keys.length}` }; },
  });
  const first = await runTableArtifactTool("table_filter", filterArgs("a_first"), context, deps);
  const replay = await runTableArtifactTool("table_filter", filterArgs("a_first"), context, deps);
  const otherSource = await runTableArtifactTool("table_filter", filterArgs("a_second"), context, deps);
  assertEquals(first.sha256, otherSource.sha256);
  assertEquals(keys[0], keys[1], "an exact retry reuses its full operation key");
  assertNotEquals(keys[0], keys[2], "different source provenance cannot inherit another operation's artifact row");
  assertEquals(replay.ok, true);
});

Deno.test("table runtime binds source bytes and refuses a mutated keyed artifact on replay", async () => {
  const keys = [];
  let sourceValue = "version one";
  let corruptDedup = false;
  const deps = streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table(sourceValue)) } }),
    runJob: async () => ({ ok: true, table: table("stable output"), workUnits: 1 }),
    createArtifact: async (_origin, input) => {
      keys.push(input.key);
      if (!corruptDedup) return { ok: true, id: `a_${keys.length}` };
      return {
        ok: true,
        deduped: true,
        id: "a_mutated",
        asset: { id: "a_mutated", type: "data", sha256: "0".repeat(64), meta: input.meta },
      };
    },
  });
  assertEquals((await runTableArtifactTool("table_filter", filterArgs(), context, deps)).ok, true);
  sourceValue = "version two";
  assertEquals((await runTableArtifactTool("table_filter", filterArgs(), context, deps)).ok, true);
  assertNotEquals(keys[0], keys[1], "the same artifact id at different content digests is distinct provenance");

  corruptDedup = true;
  const replay = await runTableArtifactTool("table_filter", filterArgs(), context, deps);
  assertEquals(replay.code, "table_artifact_promotion_failed");
  assertEquals(replay.ok, false, "a keyed row whose current body no longer matches the operation cannot be returned");
});

Deno.test("table runtime fails before execution at the exact input byte boundary plus one", async () => {
  let runs = 0;
  const execute = async (size) => runTableArtifactTool("table_filter", {
    source: {
      artifactId: "a_csv",
      format: "csv",
      hasHeader: true,
      schemaMode: "text",
      localeProfile: "canonical-v1",
    },
    predicate: { column: "c1", op: "is_present" },
  }, context, streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: "x".repeat(size) } }),
    runJob: async () => { runs++; return { ok: true, table: table(), workUnits: 1 }; },
    createArtifact: async () => ({ ok: true, id: "a_result" }),
  }));

  assertEquals((await execute(TABLE_LIMITS.maxInputBytes)).ok, true, "exactly 8 MiB reaches the bounded worker");
  assertEquals(runs, 1);
  const over = await execute(TABLE_LIMITS.maxInputBytes + 1);
  assertEquals(over.ok, false);
  assertEquals(over.code, "table_input_bound");
  assertEquals(runs, 1, "+1 never reaches execution");
});

Deno.test("table runtime permits exactly 16 MiB of joined input and rejects plus one before execution", async () => {
  let runs = 0;
  const bodies = new Map([
    ["a_left", "l".repeat(TABLE_LIMITS.maxInputBytes)],
    ["a_right", "r".repeat(TABLE_LIMITS.maxInputBytes)],
  ]);
  const args = {
    leftSource: { artifactId: "a_left", format: "csv", hasHeader: false, schemaMode: "text", localeProfile: "canonical-v1" },
    rightSource: { artifactId: "a_right", format: "csv", hasHeader: false, schemaMode: "text", localeProfile: "canonical-v1" },
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1"],
    rightColumns: ["c1"],
  };
  let discarded = 0;
  const deps = streamDeps({
    readAsset: async (_origin, id) => ({ ok: true, asset: { content: bodies.get(id) } }),
    discardStream: async () => { discarded++; return { ok: true }; },
    runJob: async () => { runs++; return { ok: true, table: table(), workUnits: 1 }; },
    createArtifact: async () => ({ ok: true, id: "a_joined" }),
  });
  const exact = await runTableArtifactTool("table_join", args, context, deps);
  assertEquals(exact.ok, true);
  assertEquals(exact.inputBytes, TABLE_LIMITS.maxJoinInputBytes);
  assertEquals(runs, 1);
  bodies.set("a_right", "r".repeat(TABLE_LIMITS.maxInputBytes + 1));
  const plusOne = await runTableArtifactTool("table_join", args, context, deps);
  assertEquals(plusOne.code, "table_input_bound");
  assertEquals(runs, 1);
  assertEquals(discarded, 3, "two exact inputs and the first +1-attempt input are all cleaned");
});

Deno.test("table runtime rejects hostile route shapes and redacts downstream failures", async () => {
  let reads = 0;
  const unknown = await runTableArtifactTool("table_filter", { ...filterArgs(), owner: "attacker" }, context, streamDeps({
    readAsset: async () => { reads++; return null; },
  }));
  assertEquals(unknown.code, "table_unknown_field");
  assertEquals(reads, 0);

  let getterCalls = 0;
  const hostilePredicate = {};
  Object.defineProperty(hostilePredicate, "column", { enumerable: true, get() { getterCalls++; throw new Error("private getter"); } });
  Object.defineProperty(hostilePredicate, "op", { enumerable: true, value: "is_present" });
  const hostile = await runTableArtifactTool("table_filter", { source: source(), predicate: hostilePredicate }, context, streamDeps({
    readAsset: async () => { reads++; return null; },
  }));
  assertEquals(hostile.code, "table_bad_request");
  assertEquals(getterCalls, 0, "nested route accessors are rejected from descriptors without invocation");
  assertEquals(reads, 0, "hostile nested data is rejected before artifact I/O");

  const sparseColumns = [];
  sparseColumns[1] = { column: "c1" };
  const sparse = await runTableArtifactTool("table_select", { source: source(), columns: sparseColumns }, context, streamDeps({
    readAsset: async () => { reads++; return null; },
  }));
  assertEquals(sparse.code, "table_bad_request");
  assertEquals(reads, 0);

  const missing = await runTableArtifactTool("table_filter", filterArgs("a_missing"), context, streamDeps({
    readAsset: async () => ({ ok: false, error: "cell=private@example.com password=hunter2" }),
  }));
  assertEquals(missing.code, "table_artifact_read_failed");
  assert(!JSON.stringify(missing).includes("private@example.com"));
  assert(!JSON.stringify(missing).includes("hunter2"));

  const worker = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table()) } }),
    runJob: async () => ({ ok: false, code: "table_private_cell_value" }),
  }));
  assertEquals(worker.code, "table_failed", "non-allowlisted worker codes cannot become provider text");

  for (const workUnits of [-1, TABLE_LIMITS.maxWorkUnits + 1, Number.NaN]) {
    const bounded = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
      readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table()) } }),
      runJob: async () => ({ ok: true, table: table(), workUnits }),
    }));
    assertEquals(bounded.code, "table_work_bound");
  }
});

Deno.test("table runtime revalidates sealed stream custody and receipt identity", async () => {
  let discarded = 0;
  let createdMeta;
  const digest = "b".repeat(64);
  const result = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({
      ok: true,
      asset: { content: "bounded preview", meta: { streamRef: { id: "promoted", kind: "stdout" }, streamOwner: "ignored" } },
    }),
    stageAsset: async (_asset, { owner }) => ({
      ok: true,
      inputRef: { id: "promoted", kind: "stdout" },
      bytes: 123,
      chained: true,
      owner,
    }),
    readStreamReceipt: async ({ owner }) => {
      assertEquals(owner, `agent:${context.runId}:${context.agentId}`);
      return { ok: true, receipt: { stdoutBytes: 123, stdoutSha256: digest } };
    },
    discardStream: async () => { discarded++; return { ok: true }; },
    runJob: async () => ({ ok: true, table: table(), workUnits: 1 }),
    createArtifact: async (_origin, input) => { createdMeta = input.meta; return { ok: true, id: "a_stream_result" }; },
  }));
  assertEquals(result.ok, true);
  assertEquals(discarded, 0, "a promoted source remains durable rather than being deleted as temporary staging");
  assertEquals(createdMeta.sourceSha256, [digest]);

  let runs = 0;
  const badReceipt = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: "preview", meta: { streamRef: { id: "promoted", kind: "stdout" } } } }),
    stageAsset: async () => ({ ok: true, inputRef: { id: "promoted", kind: "stdout" }, bytes: 123, chained: true }),
    readStreamReceipt: async () => ({ ok: true, receipt: { stdoutBytes: 122, stdoutSha256: digest } }),
    runJob: async () => { runs++; return { ok: true, table: table(), workUnits: 1 }; },
  }));
  assertEquals(badReceipt.code, "table_artifact_stage_failed");
  assertEquals(runs, 0, "a receipt/authority mismatch never reaches the worker");
});

Deno.test("table runtime revalidates stream-backed custody and cleans every worker terminal", async () => {
  let runs = 0;
  const forged = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({
      ok: true,
      asset: { content: "bounded preview only", meta: { streamRef: { id: "foreign" }, streamOwner: "caller-forged" } },
    }),
    stageAsset: async (_asset, { owner }) => {
      assertEquals(owner, `agent:${context.runId}:${context.agentId}`);
      throw new Error("wasm_stream_authority customer@example.com");
    },
    runJob: async () => { runs++; return { ok: true }; },
  }));
  assertEquals(forged.code, "table_artifact_stage_failed");
  assertEquals(runs, 0);
  assert(!JSON.stringify(forged).includes("customer@example.com"));

  for (const terminal of ["table_cancelled", "table_timeout", "table_worker_failed"]) {
    let discarded = 0;
    const result = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
      readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table()) } }),
      discardStream: async () => { discarded++; return { ok: true }; },
      runJob: async () => ({ ok: false, code: terminal }),
    }));
    assertEquals(result.code, terminal);
    assertEquals(discarded, 1, `${terminal} removes its temporary staged input`);
  }

  let publishedAfterCancel = 0;
  let livenessChecks = 0;
  const settledBeforePublish = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table()) } }),
    runJob: async () => ({ ok: true, table: table(), workUnits: 1 }),
    isRunLive: () => ++livenessChecks <= 3,
    createArtifact: async () => { publishedAfterCancel++; return { ok: true, id: "must-not-exist" }; },
  }));
  assertEquals(settledBeforePublish.code, "table_cancelled");
  assertEquals(livenessChecks, 4, "liveness is checked before staging/execution, after the worker, and at the publication edge");
  assertEquals(publishedAfterCancel, 0, "a run settled after worker success cannot publish an artifact");

  const cleanupFailure = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table()) } }),
    discardStream: async () => { throw new Error("OPFS removal failed"); },
    runJob: async () => ({ ok: true, table: table(), workUnits: 1 }),
    createArtifact: async () => { throw new Error("must not publish after cleanup failure"); },
  }));
  assertEquals(cleanupFailure.code, "table_cleanup_failed");
});

Deno.test("table runtime artifact publication is atomic from the provider's view", async () => {
  const result = await runTableArtifactTool("table_filter", filterArgs(), context, streamDeps({
    readAsset: async () => ({ ok: true, asset: { content: JSON.stringify(table("private-output")) } }),
    runJob: async () => ({ ok: true, table: table("private-output"), workUnits: 1 }),
    createArtifact: async () => ({ ok: false, error: "partial private-output write" }),
  }));
  assertEquals(result, {
    ok: false,
    code: "table_artifact_promotion_failed",
    error: "The local table operation failed.",
  });
  assert(!JSON.stringify(result).includes("private-output"));
});

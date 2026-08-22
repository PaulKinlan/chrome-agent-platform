// @ts-nocheck — hostile proxies and deliberately corrupted records are dynamic.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  applyTabularDiff,
  buildTabularDiffIdentity,
  canonicalTabularJson,
  exportPatchedCsv,
  planTabularDiffRetention,
  previewTabularDiff,
  readTabularDiff,
  rejectTabularDiff,
  retainTabularDiff,
  TABULAR_CHUNK_MEDIA,
  TABULAR_DIFF_LIMITS,
  TABULAR_DIFF_MEDIA,
  TABULAR_MANIFEST_MEDIA,
  tabularSha256Hex,
  undoTabularDiff,
  validateTabularDiffBytes,
} from "../extension/lib/tabular-diff-artifacts.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const H = (digit) => digit.repeat(64);

function codeOf(fn, code) {
  const error = assertThrows(fn);
  assertEquals(error.code, code, error.message);
  return error;
}

async function rejectCode(fn, code) {
  const error = await assertRejects(fn);
  assertEquals(error.code, code, error.message);
  return error;
}

function producer(overrides = {}) {
  return {
    sourceKind: "bundled-package",
    packageId: "reviewed.tabular-tools",
    toolId: "tabular_diff_bounded",
    version: "1.2.3",
    sourceToolDigest: H("1"),
    packageManifestDigest: H("2"),
    packageInventoryDigest: H("3"),
    executableSha256: H("4"),
    capabilityDigest: H("5"),
    replayClass: "idempotent",
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    workspace: "tool-jobs/ex_1/7",
    executionId: "ex_1",
    callIndex: 7,
    runId: "run_1",
    agentId: "agent_1",
    origin: "https://example.test",
    documentId: "doc_1",
    ...overrides,
  };
}

const K_OPTIONS = {
  compareColumns: null,
  dialect: "rfc4180",
  header: true,
  ignoredColumns: [],
  keys: ["id"],
  mode: "keyed",
};
const O_OPTIONS = {
  compareColumns: null,
  dialect: "rfc4180",
  header: true,
  ignoredColumns: [],
  keys: [],
  mode: "ordered",
};

const K_SEMANTIC = {
  columns: {
    added: ["team"],
    common: ["id", "name", "city"],
    compared: ["name", "city"],
    ignored: [],
    keys: ["id"],
    removed: [],
  },
  counts: {
    added: 1,
    changed: 1,
    leftRows: 3,
    removed: 1,
    rightRows: 3,
    unchanged: 1,
  },
  rows: {
    added: [{
      at: { key: ["3"] },
      row: { city: "Berlin", id: "3", name: "Jo", team: "C" },
    }],
    changed: [{
      at: { key: ["1"] },
      cells: [{ after: "Manchester", before: "London", column: "city" }],
    }],
    removed: [{
      at: { key: ["4"] },
      row: { city: "Rome", id: "4", name: "Sam" },
    }],
  },
};

const O_SEMANTIC = {
  columns: {
    added: [],
    common: ["id", "val"],
    compared: ["id", "val"],
    ignored: [],
    keys: [],
    removed: [],
  },
  counts: {
    added: 1,
    changed: 2,
    leftRows: 2,
    removed: 0,
    rightRows: 3,
    unchanged: 0,
  },
  rows: {
    added: [{ at: { index: 2 }, row: { id: "3", val: "c" } }],
    changed: [
      {
        at: { index: 0 },
        cells: [{ after: "2", before: "1", column: "id" }, {
          after: "b",
          before: "a",
          column: "val",
        }],
      },
      {
        at: { index: 1 },
        cells: [{ after: "1", before: "2", column: "id" }, {
          after: "a",
          before: "b",
          column: "val",
        }],
      },
    ],
    removed: [],
  },
};

async function artifactFor(semantic, options, overrides = {}) {
  const identity = {
    engineDigest: H("4"),
    left: { sha256: H("a"), size: 49, sourceGeneration: "left-gen-1" },
    right: { sha256: H("b"), size: 65, sourceGeneration: "right-gen-1" },
    optionsDigest: await tabularSha256Hex(canonicalTabularJson(options)),
    ...(overrides.identity ?? {}),
  };
  const artifact = {
    schema: "cap-tabular-diff-v1",
    identity,
    columns: semantic.columns,
    counts: semantic.counts,
    rows: semantic.rows,
    semanticDigest: await tabularSha256Hex(canonicalTabularJson(semantic)),
    complete: true,
    ...overrides.artifact,
  };
  const canonical = canonicalTabularJson(artifact);
  return { artifact, canonical, options };
}

function inputsFor(artifact, overrides = {}) {
  return [
    {
      role: "left",
      relativePath: "inputs/left.csv",
      ...artifact.identity.left,
    },
    {
      role: "right",
      relativePath: "inputs/right.csv",
      ...artifact.identity.right,
    },
  ].map((row, index) => ({ ...row, ...(overrides[index] ?? {}) }));
}

async function fixture(semantic = K_SEMANTIC, options = K_OPTIONS) {
  const value = await artifactFor(semantic, options);
  const inputs = inputsFor(value.artifact);
  const identity = await buildTabularDiffIdentity({
    producer: producer(),
    context: context(),
    inputs,
    options,
    artifact: value.canonical,
  });
  const plan = await planTabularDiffRetention({
    producer: producer(),
    context: context(),
    inputs,
    options,
    artifact: value.canonical,
    label: "Read-only table comparison",
  });
  return { ...value, inputs, identity, plan };
}

class FakeArtifacts {
  records = new Map();
  ids = new Map();
  creates = [];
  gets = [];
  next = 1;
  capacityAt = null;
  throwAfterAt = null;
  mutateRead = null;

  async createAssetKeyed(origin, input) {
    this.creates.push({ origin, ...structuredClone(input) });
    const prior = this.records.get(input.key);
    if (prior) {
      return {
        ok: true,
        id: prior.id,
        asset: structuredClone(prior),
        deduped: true,
      };
    }
    if (this.capacityAt === this.creates.length) {
      return { ok: false, error: "asset limit reached (200)" };
    }
    const record = { id: `a_${this.next++}`, ...structuredClone(input) };
    this.records.set(input.key, record);
    this.ids.set(record.id, record);
    if (this.throwAfterAt === this.creates.length) {
      throw new Error("simulated close interruption");
    }
    return {
      ok: true,
      id: record.id,
      asset: structuredClone(record),
      deduped: false,
    };
  }

  async getAsset(origin, id) {
    this.gets.push({ origin, id });
    const record = this.ids.get(id);
    if (!record) return { ok: false, error: "missing" };
    const asset = structuredClone(record);
    if (this.mutateRead) this.mutateRead(asset, this.gets.length);
    return { ok: true, asset };
  }

  api() {
    return {
      createAssetKeyed: this.createAssetKeyed.bind(this),
      getAsset: this.getAsset.bind(this),
    };
  }
}

Deno.test("K-BASE and O-BASE canonical semantic bytes/digests are exact and full artifacts validate", async () => {
  assertEquals(canonicalTabularJson(K_SEMANTIC).length, 486);
  assertEquals(
    await tabularSha256Hex(canonicalTabularJson(K_SEMANTIC)),
    "17577bf5f04ae0b475dc3d908588dd82a081b7b04eb400ac14f906578ef6f26d",
  );
  assertEquals(canonicalTabularJson(O_SEMANTIC).length, 506);
  assertEquals(
    await tabularSha256Hex(canonicalTabularJson(O_SEMANTIC)),
    "f38865f824688c8f756e253c48414f4d0b3005f9901d535ecf9b68df3daacb48",
  );
  for (
    const [semantic, options, mode] of [[K_SEMANTIC, K_OPTIONS, "keyed"], [
      O_SEMANTIC,
      O_OPTIONS,
      "ordered",
    ]]
  ) {
    const fixture = await artifactFor(semantic, options);
    const validated = await validateTabularDiffBytes(
      encoder.encode(fixture.canonical),
    );
    assertEquals(validated.mode, mode);
    assertEquals(validated.canonical, fixture.canonical);
    assertEquals(
      validated.contentSize,
      encoder.encode(fixture.canonical).byteLength,
    );
  }
});

Deno.test("canonical parser rejects whitespace, key-order changes, BOM, malformed Unicode and duplicate decoded keys", async () => {
  const f = await fixture();
  await rejectCode(
    () => validateTabularDiffBytes(` ${f.canonical}`),
    "artifact_not_canonical",
  );
  await rejectCode(
    () => validateTabularDiffBytes(`${f.canonical}\n`),
    "artifact_not_canonical",
  );
  const reordered = JSON.stringify(f.artifact);
  assert(reordered !== f.canonical);
  await rejectCode(
    () => validateTabularDiffBytes(reordered),
    "artifact_not_canonical",
  );
  await rejectCode(
    () =>
      validateTabularDiffBytes(
        new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(f.canonical)]),
      ),
    "artifact_bom_unsupported",
  );
  await rejectCode(
    () => validateTabularDiffBytes(new Uint8Array([0xc3, 0x28])),
    "artifact_bad_unicode",
  );
  await rejectCode(
    () =>
      validateTabularDiffBytes(
        '{"schema":"cap-tabular-diff-v1","schema":"cap-tabular-diff-v1"}',
      ),
    "artifact_duplicate_key",
  );
  await rejectCode(
    () =>
      validateTabularDiffBytes(
        '{"schema":"cap-tabular-diff-v1","\\u0073chema":"cap-tabular-diff-v1"}',
      ),
    "artifact_duplicate_key",
  );
  await rejectCode(
    () => validateTabularDiffBytes(`{"x":"\\ud800"}`),
    "artifact_bad_unicode",
  );
});

Deno.test("schema semantics reject extras, digest/count/order/locator/cell mutants and any incomplete or truncation claim", async () => {
  const base = await artifactFor(K_SEMANTIC, K_OPTIONS);
  const mutate = async (fn) => {
    const value = structuredClone(base.artifact);
    fn(value);
    return canonicalTabularJson(value);
  };
  for (
    const [body, code] of [
      [
        await mutate((v) => {
          v.extra = true;
        }),
        "artifact_unknown_field",
      ],
      [
        await mutate((v) => {
          v.complete = false;
        }),
        "artifact_incomplete",
      ],
      [
        await mutate((v) => {
          v.truncated = true;
        }),
        "artifact_unknown_field",
      ],
      [
        await mutate((v) => {
          v.semanticDigest = H("0");
        }),
        "artifact_semantic_digest_mismatch",
      ],
      [
        await mutate((v) => {
          v.counts.changed = 2;
        }),
        "artifact_count_mismatch",
      ],
      [
        await mutate((v) => {
          v.rows.added[0].row.extra = "x";
        }),
        "artifact_unknown_field",
      ],
      [
        await mutate((v) => {
          v.rows.changed[0].cells[0].column = "name";
        }),
        "artifact_semantic_digest_mismatch",
      ],
      [
        await mutate((v) => {
          v.rows.changed[0].cells[0].after = "London";
        }),
        "artifact_cell_noop",
      ],
      [
        await mutate((v) => {
          v.rows.removed[0].at.key = [];
        }),
        "artifact_locator_invalid",
      ],
      [
        await mutate((v) => {
          v.rows.added[0].at.key = ["not-the-row-id"];
        }),
        "artifact_locator_invalid",
      ],
      [
        await mutate((v) => {
          v.identity.left.size = TABULAR_DIFF_LIMITS.maxInputBytes + 1;
        }),
        "artifact_input_size_bound",
      ],
    ]
  ) await rejectCode(() => validateTabularDiffBytes(body), code);

  const unorderedSemantic = structuredClone(K_SEMANTIC);
  unorderedSemantic.rows.added.push({
    at: { key: ["2"] },
    row: { city: "x", id: "2", name: "x", team: "x" },
  });
  unorderedSemantic.counts.added++;
  unorderedSemantic.counts.rightRows++;
  const unordered = await artifactFor(unorderedSemantic, K_OPTIONS);
  await rejectCode(
    () => validateTabularDiffBytes(unordered.canonical),
    "artifact_row_order",
  );
});

Deno.test("identity binds complete producer/context/ordered receipts/content and verifies engine/options/source receipts", async () => {
  const f = await fixture();
  const again = await buildTabularDiffIdentity({
    producer: producer(),
    context: context(),
    inputs: f.inputs,
    options: K_OPTIONS,
    artifact: f.canonical,
  });
  assertEquals(again.operationIdentity, f.identity.operationIdentity);
  assertEquals(again.tuple.media, TABULAR_DIFF_MEDIA);
  const mutations = [
    [producer({ sourceToolDigest: H("6") }), context(), f.inputs],
    [producer({ packageManifestDigest: H("6") }), context(), f.inputs],
    [producer({ packageInventoryDigest: H("6") }), context(), f.inputs],
    [producer({ capabilityDigest: H("6") }), context(), f.inputs],
    [producer(), context({ runId: "run_2" }), f.inputs],
    [producer(), context({ callIndex: 8 }), f.inputs],
    [
      producer(),
      context(),
      f.inputs.map((row, index) =>
        index ? row : { ...row, relativePath: "inputs/other.csv" }
      ),
    ],
  ];
  for (const [p, c, inputs] of mutations) {
    const changed = await buildTabularDiffIdentity({
      producer: p,
      context: c,
      inputs,
      options: K_OPTIONS,
      artifact: f.canonical,
    });
    assert(changed.operationIdentity !== f.identity.operationIdentity);
  }
  await rejectCode(
    () =>
      buildTabularDiffIdentity({
        producer: producer({ executableSha256: H("6") }),
        context: context(),
        inputs: f.inputs,
        options: K_OPTIONS,
        artifact: f.canonical,
      }),
    "engine_receipt_mismatch",
  );
  await rejectCode(
    () =>
      buildTabularDiffIdentity({
        producer: producer(),
        context: context(),
        inputs: f.inputs,
        options: { ...K_OPTIONS, compareColumns: ["name"] },
        artifact: f.canonical,
      }),
    "options_mismatch",
  );
  const stale = f.inputs.map((row, index) =>
    index ? row : { ...row, sourceGeneration: "stale" }
  );
  await rejectCode(
    () =>
      buildTabularDiffIdentity({
        producer: producer(),
        context: context(),
        inputs: stale,
        options: K_OPTIONS,
        artifact: f.canonical,
      }),
    "source_receipt_mismatch",
  );
  await rejectCode(
    () =>
      buildTabularDiffIdentity({
        producer: producer(),
        context: context(),
        inputs: [...f.inputs].reverse(),
        options: K_OPTIONS,
        artifact: f.canonical,
      }),
    "inputs_invalid",
  );
});

Deno.test("hostile producer/context/options/plan/API accessors fail before artifact calls", async () => {
  const f = await fixture();
  const fake = new FakeArtifacts();
  const hostileProducer = producer();
  Object.defineProperty(hostileProducer, "version", {
    enumerable: true,
    get() {
      throw new Error("must not invoke");
    },
  });
  await rejectCode(
    () =>
      planTabularDiffRetention({
        producer: hostileProducer,
        context: context(),
        inputs: f.inputs,
        options: K_OPTIONS,
        artifact: f.canonical,
      }),
    "hostile_input",
  );
  assertEquals(fake.creates.length, 0);
  const proxy = new Proxy({}, {
    ownKeys() {
      throw new Error("must not invoke");
    },
  });
  await rejectCode(() => retainTabularDiff(proxy, fake.api()), "hostile_input");
  assertEquals(fake.creates.length, 0);
  const hostileApi = {};
  Object.defineProperty(hostileApi, "getAsset", {
    enumerable: true,
    get() {
      throw new Error("must not invoke");
    },
  });
  Object.defineProperty(hostileApi, "createAssetKeyed", {
    enumerable: true,
    value() {},
  });
  await rejectCode(
    () => retainTabularDiff(f.plan, hostileApi),
    "hostile_input",
  );
  assertEquals(fake.creates.length, 0);
});

async function sizedOrderedArtifact(targetBytes) {
  for (let count = 1; count <= 100; count++) {
    const rows = Array.from(
      { length: count },
      (_, index) => ({ at: { index }, row: { id: String(index), value: "" } }),
    );
    const semantic = {
      columns: {
        added: [],
        common: ["id", "value"],
        compared: ["id", "value"],
        ignored: [],
        keys: [],
        removed: [],
      },
      counts: {
        added: count,
        changed: 0,
        leftRows: 0,
        removed: 0,
        rightRows: count,
        unchanged: 0,
      },
      rows: { added: rows, changed: [], removed: [] },
    };
    let artifact = await artifactFor(semantic, O_OPTIONS, {
      identity: {
        left: { sha256: H("a"), size: 0, sourceGeneration: "left-gen-1" },
        right: { sha256: H("b"), size: count, sourceGeneration: "right-gen-1" },
      },
    });
    let remaining = targetBytes - encoder.encode(artifact.canonical).byteLength;
    if (remaining < 0 || remaining > count * TABULAR_DIFF_LIMITS.maxCellBytes) {
      continue;
    }
    for (const row of rows) {
      const take = Math.min(remaining, TABULAR_DIFF_LIMITS.maxCellBytes);
      row.row.value = "x".repeat(take);
      remaining -= take;
    }
    artifact = await artifactFor(semantic, O_OPTIONS, {
      identity: {
        left: { sha256: H("a"), size: 0, sourceGeneration: "left-gen-1" },
        right: { sha256: H("b"), size: count, sourceGeneration: "right-gen-1" },
      },
    });
    if (encoder.encode(artifact.canonical).byteLength === targetBytes) {
      return artifact;
    }
  }
  throw new Error(`could not construct ${targetBytes}-byte canonical artifact`);
}

async function largeOrderedArtifact(
  minimumBytes = TABULAR_DIFF_LIMITS.maxChunkRawBytes + 1000,
  emoji = false,
) {
  const rows = [];
  const value = (emoji ? "😀" : "x").repeat(3000);
  while (true) {
    const index = rows.length;
    rows.push({ at: { index }, row: { id: String(index), value } });
    const semantic = {
      columns: {
        added: [],
        common: ["id", "value"],
        compared: ["id", "value"],
        ignored: [],
        keys: [],
        removed: [],
      },
      counts: {
        added: rows.length,
        changed: 0,
        leftRows: 0,
        removed: 0,
        rightRows: rows.length,
        unchanged: 0,
      },
      rows: { added: rows, changed: [], removed: [] },
    };
    const artifact = await artifactFor(semantic, O_OPTIONS, {
      identity: {
        left: { sha256: H("a"), size: 0, sourceGeneration: "left-gen-1" },
        right: {
          sha256: H("b"),
          size: rows.length,
          sourceGeneration: "right-gen-1",
        },
      },
    });
    if (encoder.encode(artifact.canonical).byteLength >= minimumBytes) {
      return artifact;
    }
  }
}

Deno.test("planner splits exact UTF-8 bytes at 180 KiB, preserves Unicode across chunk boundaries and bounds every envelope", async () => {
  let artifact = await largeOrderedArtifact(
    TABULAR_DIFF_LIMITS.maxChunkRawBytes + 20_000,
    true,
  );
  // Shift the byte alignment until the fixed boundary lands inside a scalar.
  for (let attempt = 0; attempt < 4; attempt++) {
    const first = encoder.encode(artifact.canonical).slice(
      0,
      TABULAR_DIFF_LIMITS.maxChunkRawBytes,
    );
    try {
      decoder.decode(first);
      artifact.artifact.rows.added[0].row.id += "x";
      artifact.artifact.semanticDigest = await tabularSha256Hex(
        canonicalTabularJson({
          columns: artifact.artifact.columns,
          counts: artifact.artifact.counts,
          rows: artifact.artifact.rows,
        }),
      );
      artifact.canonical = canonicalTabularJson(artifact.artifact);
    } catch {
      break;
    }
  }
  const inputs = inputsFor(artifact.artifact);
  const plan = await planTabularDiffRetention({
    producer: producer(),
    context: context(),
    inputs,
    options: O_OPTIONS,
    artifact: artifact.canonical,
  });
  assert(plan.chunks.length >= 2);
  assertEquals(plan.chunks[0].size, TABULAR_DIFF_LIMITS.maxChunkRawBytes);
  assert(
    plan.chunks.every((chunk, index) =>
      chunk.index === index &&
      encoder.encode(chunk.content).byteLength <=
        TABULAR_DIFF_LIMITS.maxChunkEnvelopeBytes
    ),
  );
  const combined = plan.chunks.map((chunk) => JSON.parse(chunk.content).bytes)
    .map((body) => Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
  const reassembled = new Uint8Array(
    combined.reduce((sum, row) => sum + row.length, 0),
  );
  let offset = 0;
  for (const row of combined) {
    reassembled.set(row, offset);
    offset += row.length;
  }
  assertEquals(decoder.decode(reassembled), artifact.canonical);
  assertEquals(await tabularSha256Hex(reassembled), plan.tuple.contentSha256);
  assertEquals(plan.quota, {
    atomicGroup: false,
    capacityReservationAvailable: false,
    orphanCollectionAvailable: false,
    maxAssetsPerResult: 9,
  });
});

Deno.test("exact chunk/content boundaries are deterministic and complete; zero/+1 reject without truncation", async () => {
  await rejectCode(
    () => validateTabularDiffBytes(new Uint8Array()),
    "artifact_size_bound",
  );
  await rejectCode(
    () =>
      validateTabularDiffBytes(
        new Uint8Array(TABULAR_DIFF_LIMITS.maxContentBytes + 1),
      ),
    "artifact_size_bound",
  );
  for (
    const target of [
      TABULAR_DIFF_LIMITS.maxChunkRawBytes - 1,
      TABULAR_DIFF_LIMITS.maxChunkRawBytes,
      TABULAR_DIFF_LIMITS.maxChunkRawBytes + 1,
      TABULAR_DIFF_LIMITS.maxContentBytes,
    ]
  ) {
    const artifact = await sizedOrderedArtifact(target);
    const validated = await validateTabularDiffBytes(artifact.canonical);
    assertEquals(validated.contentSize, target);
    const plan = await planTabularDiffRetention({
      producer: producer(),
      context: context(),
      inputs: inputsFor(artifact.artifact),
      options: O_OPTIONS,
      artifact: artifact.canonical,
    });
    assertEquals(
      plan.chunks.length,
      Math.ceil(target / TABULAR_DIFF_LIMITS.maxChunkRawBytes),
    );
    assertEquals(
      plan.chunks.reduce((sum, chunk) => sum + chunk.size, 0),
      target,
    );
    assert(
      plan.chunks.slice(0, -1).every((chunk) =>
        chunk.size === TABULAR_DIFF_LIMITS.maxChunkRawBytes
      ),
    );
    assert(
      plan.chunks.every((chunk) =>
        encoder.encode(chunk.content).byteLength <=
          TABULAR_DIFF_LIMITS.maxChunkEnvelopeBytes
      ),
    );
    assertEquals(plan.summary.complete, true);
    assert(!plan.canonicalArtifact.includes("truncat"));
  }
});

Deno.test("retention writes chunks in index order, re-reads each, writes manifest last, and exact retry is idempotent", async () => {
  const artifact = await largeOrderedArtifact(
    TABULAR_DIFF_LIMITS.maxChunkRawBytes + 1000,
  );
  const inputs = inputsFor(artifact.artifact);
  const plan = await planTabularDiffRetention({
    producer: producer(),
    context: context(),
    inputs,
    options: O_OPTIONS,
    artifact: artifact.canonical,
    label: "Large comparison",
  });
  const fake = new FakeArtifacts();
  const first = await retainTabularDiff(plan, fake.api());
  assert(first.ok);
  assertEquals(first.retainedChunks.length, plan.chunks.length);
  assertEquals(
    fake.creates.slice(0, -1).map((call) => call.key),
    plan.chunks.map((chunk) => chunk.key),
  );
  assert(
    fake.creates.slice(0, -1).every((call) =>
      call.meta.media === TABULAR_CHUNK_MEDIA && call.type === "data"
    ),
  );
  const manifestCall = fake.creates.at(-1);
  assert(manifestCall.key.startsWith("opfs:tabular-diff:"));
  assertEquals(manifestCall.type, "json");
  assertEquals(manifestCall.meta.storageMedia, TABULAR_MANIFEST_MEDIA);
  assertEquals(manifestCall.meta.state, "retained-read-only");
  assertEquals(manifestCall.meta.mutationAvailable, false);
  assert(
    !JSON.stringify(manifestCall.meta).includes("Large comparison") &&
      !JSON.stringify(manifestCall.meta).includes("inputs/"),
  );
  const callCount = fake.records.size;
  const second = await retainTabularDiff(plan, fake.api());
  assertEquals(second.id, first.id);
  assert(second.deduped);
  assert(second.retainedChunks.every((chunk) => chunk.deduped));
  assertEquals(fake.records.size, callCount);
  const parsed = JSON.parse(manifestCall.content);
  assertEquals(parsed.schema, "cap-tabular-diff-retention-v1");
  assertEquals(parsed.operationIdentity, plan.operationIdentity);
  assertEquals(
    parsed.content.chunks.map((chunk) => chunk.assetId),
    first.retainedChunks.map((chunk) => chunk.assetId),
  );
});

Deno.test("capacity and close interruption expose bounded orphan limitations, never create an unkeyed/delete/apply side effect, and retry completes", async () => {
  const artifact = await largeOrderedArtifact(
    TABULAR_DIFF_LIMITS.maxChunkRawBytes + 1000,
  );
  const inputs = inputsFor(artifact.artifact);
  const plan = await planTabularDiffRetention({
    producer: producer(),
    context: context(),
    inputs,
    options: O_OPTIONS,
    artifact: artifact.canonical,
  });
  const capacity = new FakeArtifacts();
  capacity.capacityAt = plan.chunks.length + 1;
  const error = await rejectCode(
    () => retainTabularDiff(plan, capacity.api()),
    "artifact_capacity",
  );
  assertEquals(error.phase, "manifest");
  assertEquals(error.orphanedChunks.length, plan.chunks.length);
  assertEquals(error.orphanPolicy, {
    automaticDeletion: false,
    collectionAvailable: false,
    reservationAvailable: false,
  });
  assert(
    [...capacity.records.keys()].every((key) =>
      key.startsWith("opfs:tabular-diff:cas:")
    ),
  );

  const interrupted = new FakeArtifacts();
  interrupted.throwAfterAt = 1;
  const close = await assertRejects(
    () => retainTabularDiff(plan, interrupted.api()),
    Error,
    "simulated close interruption",
  );
  assertEquals(close.orphanPolicy.closeOutcomeUnknown, true);
  assertEquals([...interrupted.records.keys()].length, 1);
  interrupted.throwAfterAt = null;
  const recovered = await retainTabularDiff(plan, interrupted.api());
  assert(recovered.ok);
  assertEquals(interrupted.records.size, plan.chunks.length + 1);
});

Deno.test("read validates manifest-last identity and all chunks; hostile missing/reordered/corrupt data fails closed", async () => {
  const f = await fixture();
  const fake = new FakeArtifacts();
  const retained = await retainTabularDiff(f.plan, fake.api());
  const read = await readTabularDiff(retained.id, fake.api());
  assertEquals(read.operationIdentity, f.plan.operationIdentity);
  assertEquals(read.validated.canonical, f.canonical);

  const manifestRecord = fake.ids.get(retained.id);
  const originalContent = manifestRecord.content;
  const reordered = JSON.parse(originalContent);
  reordered.content.chunks[0].index = 1;
  manifestRecord.content = canonicalTabularJson(reordered);
  await rejectCode(
    () => readTabularDiff(retained.id, fake.api()),
    "manifest_invalid",
  );
  manifestRecord.content = originalContent;

  const chunkId = retained.retainedChunks[0].assetId;
  const chunk = fake.ids.get(chunkId);
  const originalChunk = chunk.content;
  chunk.content = `${chunk.content} `;
  await rejectCode(
    () => readTabularDiff(retained.id, fake.api()),
    "chunk_verify_failed",
  );
  chunk.content = originalChunk;
  fake.ids.delete(chunkId);
  await rejectCode(
    () => readTabularDiff(retained.id, fake.api()),
    "chunk_read_failed",
  );
});

Deno.test("bounded previews revalidate retained authority, paginate without partial cells, neutralize hostile text and preserve inert formula warnings", async () => {
  const semantic = structuredClone(K_SEMANTIC);
  semantic.rows.changed[0].cells[0].before = "=SUM(A1:A2)\t\u202eevil<em>" +
    "😀".repeat(300);
  semantic.rows.changed[0].cells[0].after = "+safe&literal";
  const artifact = await artifactFor(semantic, K_OPTIONS);
  const inputs = inputsFor(artifact.artifact);
  const plan = await planTabularDiffRetention({
    producer: producer(),
    context: context(),
    inputs,
    options: K_OPTIONS,
    artifact: artifact.canonical,
  });
  const fake = new FakeArtifacts();
  const retained = await retainTabularDiff(plan, fake.api());
  const summary = await previewTabularDiff(
    retained.id,
    { kind: "summary" },
    fake.api(),
  );
  assertEquals(summary.authoritative, false);
  assertEquals(summary.operationIdentity, plan.operationIdentity);
  const schema = await previewTabularDiff(retained.id, {
    kind: "schema",
    page: 0,
    pageSize: 2,
  }, fake.api());
  assertEquals(schema.items.length, 2);
  assert(schema.hasMore);
  const rows = await previewTabularDiff(retained.id, {
    kind: "rows",
    section: "changed",
    page: 0,
    pageSize: 1,
  }, fake.api());
  const before = rows.items[0].cells[0].before;
  assert(before.formulaLike);
  assert(before.truncated);
  assert(!before.text.includes("\u202e") && !before.text.includes("\t"));
  assert(
    encoder.encode(before.text).byteLength <=
      TABULAR_DIFF_LIMITS.maxViewCellBytes,
  );
  assert(rows.bytes <= TABULAR_DIFF_LIMITS.maxViewBytes);
  const cell = await previewTabularDiff(retained.id, {
    kind: "cell",
    row: 0,
    cell: 0,
  }, fake.api());
  assertEquals(cell.items[0].before.text, before.text);
  await rejectCode(
    () =>
      previewTabularDiff(retained.id, {
        kind: "rows",
        section: "changed",
        page: 0,
        pageSize: 201,
      }, fake.api()),
    "view_request_invalid",
  );
});

Deno.test("mutation/export stubs synchronously refuse before hostile argument reads and static import graph has no mutation/runtime/UI/route authority", async () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error("must not read");
    },
    ownKeys() {
      throw new Error("must not read");
    },
  });
  for (
    const fn of [
      applyTabularDiff,
      rejectTabularDiff,
      undoTabularDiff,
      exportPatchedCsv,
    ]
  ) codeOf(() => fn(hostile), "mutation_authority_required");
  const core = await Deno.readTextFile(
    new URL("../extension/lib/tabular-diff-artifacts-core.js", import.meta.url),
  );
  const adapter = await Deno.readTextFile(
    new URL("../extension/lib/tabular-diff-artifacts.js", import.meta.url),
  );
  assert(!/^import /mu.test(core), "pure core must have no imports");
  for (
    const forbidden of [
      "code-diff-artifacts",
      "canonicalPathSet",
      "changeDoc",
      "createAsset(",
      "updateAsset",
      "deleteAsset",
      "navigator.storage",
      "showDirectoryPicker",
      "WebAssembly.",
      "new Worker",
      "fetch(",
      "XMLHttpRequest",
      "innerHTML",
      "DOMParser",
      "eval(",
      "Function(",
      "addListener(",
      "chrome.permissions",
      "ownerApproval",
    ]
  ) {
    assert(!core.includes(forbidden), `core: ${forbidden}`);
    assert(!adapter.includes(forbidden), `adapter: ${forbidden}`);
  }
  assert(adapter.includes("createAssetKeyed"));
  assert(adapter.includes("getAsset"));
  const imports = [
    ...new Set(
      [...adapter.matchAll(/from "([^"]+)";/gmu)].map((match) => match[1]),
    ),
  ];
  assertEquals(imports.sort(), [
    "./artifacts.js",
    "./tabular-diff-artifacts-core.js",
  ]);
  const sw = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  assert(!sw.includes("tabular-diff-artifacts"));
});

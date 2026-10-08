// @ts-nocheck — focused in-memory OPFS doubles.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createSiteToolAuditStore,
  digestSiteToolArguments,
} from "../extension/lib/site-tool-audit.js";

class FileNode { kind = "file"; bytes = new Uint8Array(); failWrite = false; }
class FakeWritable {
  constructor(node, keep) {
    this.node = node;
    this.bytes = keep ? node.bytes.slice() : new Uint8Array();
    this.position = 0;
  }
  async seek(position) { this.position = position; }
  async write(value) {
    if (this.node.failWrite) throw new Error("quota");
    const incoming = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const size = Math.max(this.bytes.length, this.position + incoming.length);
    const next = new Uint8Array(size);
    next.set(this.bytes);
    next.set(incoming, this.position);
    this.bytes = next;
    this.position += incoming.length;
  }
  async close() { this.node.bytes = this.bytes; }
}
class FakeFileHandle {
  kind = "file";
  constructor(node) { this.node = node; }
  async getFile() {
    const bytes = this.node.bytes.slice();
    return {
      size: bytes.length,
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  }
  async createWritable(options = {}) { return new FakeWritable(this.node, options.keepExistingData === true); }
}
class FakeDirectory {
  kind = "directory";
  constructor() { this.nodes = new Map(); this.failRemove = false; }
  async getFileHandle(name, options = {}) {
    if (!this.nodes.has(name)) {
      if (options.create !== true) throw new Error("not found");
      this.nodes.set(name, new FileNode());
    }
    return new FakeFileHandle(this.nodes.get(name));
  }
  async removeEntry(name) {
    if (this.failRemove) throw new Error("remove denied");
    this.nodes.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.nodes) yield [name, new FakeFileHandle(node)];
  }
}

const DIGEST = "a".repeat(64);
function record(index, overrides = {}) {
  return {
    event: "invocation-started",
    direction: "agent-to-site",
    actor: "agent",
    origin: "https://audit.example.com",
    tool: `tool_${index}`,
    source: "declared",
    identityDigest: DIGEST,
    enrollmentGen: 7,
    consentRevision: 3,
    executionId: `exec:${index}`,
    runId: `run:${index}`,
    agentId: "hub",
    argDigest: digestSiteToolArguments({ index, nested: { b: 2, a: 1 } }),
    outcome: "pending",
    reason: "cached-allow",
    ...overrides,
  };
}

Deno.test("site tool audit: awaited concurrent appends serialize and survive restart", async () => {
  const directory = new FakeDirectory();
  let clock = 100;
  const create = () => createSiteToolAuditStore({
    openDirectory: async () => directory,
    now: () => ++clock,
    recordsPerSegment: 2,
    maxSegments: 4,
  });
  const first = create();
  await Promise.all([first.append(record(1)), first.append(record(2)), first.append(record(3))]);
  const restarted = create();
  const page = await restarted.list({ limit: 10 });
  assertEquals(page.records.map((row) => row.seq), [3, 2, 1]);
  assertEquals(page.records.map((row) => row.at), [103, 102, 101]);
});

Deno.test("site tool audit: stable older/newer cursors traverse without gaps", async () => {
  const directory = new FakeDirectory();
  let clock = 0;
  const store = createSiteToolAuditStore({ openDirectory: async () => directory, now: () => ++clock, recordsPerSegment: 2, maxSegments: 5, maxPageSize: 2 });
  for (let index = 1; index <= 6; index++) await store.append(record(index));
  const newest = await store.list({ limit: 2 });
  assertEquals(newest.records.map((row) => row.seq), [6, 5]);
  const older = await store.list({ cursor: newest.olderCursor, limit: 2 });
  assertEquals(older.records.map((row) => row.seq), [4, 3]);
  const oldest = await store.list({ cursor: older.olderCursor, limit: 2 });
  assertEquals(oldest.records.map((row) => row.seq), [2, 1]);
  assertEquals(oldest.olderCursor, null);
  const newer = await store.list({ cursor: oldest.newerCursor, limit: 2 });
  assertEquals(newer.records.map((row) => row.seq), [4, 3]);
  await store.append(record(7));
  const next = await store.list({ cursor: newer.newerCursor, limit: 2 });
  assertEquals(next.records.map((row) => row.seq), [6, 5]);
});

Deno.test("site tool audit: whole-segment retention is explicit", async () => {
  const directory = new FakeDirectory();
  let clock = 0;
  const store = createSiteToolAuditStore({ openDirectory: async () => directory, now: () => ++clock, recordsPerSegment: 2, maxSegments: 3 });
  for (let index = 1; index <= 7; index++) await store.append(record(index));
  const page = await store.list({ limit: 20 });
  assertEquals(page.records.map((row) => row.seq), [7, 6, 5, 4, 3]);
  assertEquals(page.historyTruncated, true);
  assertEquals(page.firstRetainedSequence, 3);
  assertEquals(page.retention.maxRetainedRecords, 6);
});

Deno.test("site tool audit: retention deletion failure cannot create an over-limit segment", async () => {
  const directory = new FakeDirectory();
  const store = createSiteToolAuditStore({
    openDirectory: async () => directory,
    recordsPerSegment: 1,
    maxSegments: 2,
  });
  await store.append(record(1));
  await store.append(record(2));
  assertEquals(directory.nodes.size, 2);
  directory.failRemove = true;
  await assertRejects(() => store.append(record(3)), Error, "remove denied");
  assertEquals(directory.nodes.size, 2, "delete-before-create preserves the hard segment bound");
  directory.failRemove = false;
  assertEquals((await store.list({ limit: 10 })).records.map((row) => row.seq), [2, 1]);
});

Deno.test("site tool audit: canonical argument hashing is incremental and has no old node ceiling", () => {
  const values = Array.from({ length: 10_000 }, (_, index) => ({ index, value: `row-${index}` }));
  const first = digestSiteToolArguments({ values });
  const second = digestSiteToolArguments({ values: structuredClone(values) });
  assertEquals(first, second);
  values[9_999].value = "changed";
  assert(first !== digestSiteToolArguments({ values }));
});

Deno.test("site tool audit: exclusive barriers wait for queued writes and block interleaving", async () => {
  const directory = new FakeDirectory();
  const events = [];
  const store = createSiteToolAuditStore({ openDirectory: async () => directory });
  const append = store.append(record(1));
  const barrier = store.runExclusive(async () => {
    const text = [...directory.nodes.values()]
      .map((node) => new TextDecoder().decode(node.bytes))
      .join("");
    assert(text.includes('"seq":1'), "the earlier append is durable before the barrier runs");
    events.push("barrier");
  });
  const later = store.append(record(2)).then(() => events.push("later"));
  await Promise.all([append, barrier, later]);
  assertEquals(events, ["barrier", "later"]);
});

Deno.test("site tool audit: write failure rejects instead of silently succeeding", async () => {
  const directory = new FakeDirectory();
  const store = createSiteToolAuditStore({ openDirectory: async () => directory });
  await store.append(record(1));
  const node = [...directory.nodes.values()][0];
  node.failWrite = true;
  await assertRejects(() => store.append(record(2)), Error, "quota");
  node.failWrite = false;
  const page = await store.list({ limit: 10 });
  assertEquals(page.records.map((row) => row.seq), [1]);
});

Deno.test("site tool audit: a missing interior segment or row is corruption, never silent history loss", async () => {
  const directory = new FakeDirectory();
  const store = createSiteToolAuditStore({
    openDirectory: async () => directory,
    recordsPerSegment: 2,
    maxSegments: 4,
  });
  for (let index = 1; index <= 6; index++) await store.append(record(index));
  await directory.removeEntry("events-0000000000000003.jsonl");
  await assertRejects(() => store.list(), Error, "site_tool_audit_corrupt");
  await assertRejects(() => store.append(record(7)), Error, "site_tool_audit_corrupt");
});

Deno.test("site tool audit: torn or corrupt complete lines fail closed", async () => {
  const directory = new FakeDirectory();
  const handle = await directory.getFileHandle("events-0000000000000001.jsonl", { create: true });
  const writable = await handle.createWritable();
  await writable.write('{"v":1');
  await writable.close();
  const store = createSiteToolAuditStore({ openDirectory: async () => directory });
  await assertRejects(() => store.list(), Error, "site_tool_audit_corrupt");
  await assertRejects(() => store.append(record(2)), Error, "site_tool_audit_corrupt");
});

Deno.test("site tool audit: strict bounded records never retain raw arguments/results", async () => {
  const directory = new FakeDirectory();
  const store = createSiteToolAuditStore({ openDirectory: async () => directory });
  const hostile = record(1);
  hostile.arguments = { secret: "do-not-store" };
  await assertRejects(() => store.append(hostile), Error, "site_tool_audit_record");
  const getter = record(2);
  Object.defineProperty(getter, "tool", { get() { throw new Error("getter ran"); }, enumerable: true });
  await assertRejects(() => store.append(getter), Error, "site_tool_audit_record");
  assertEquals(digestSiteToolArguments({ b: 2, a: 1 }), digestSiteToolArguments({ a: 1, b: 2 }));
  assert((await store.list()).records.length === 0);
});

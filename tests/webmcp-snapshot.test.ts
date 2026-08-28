// tests/webmcp-snapshot.test.ts — unit tests for the discovery replacement
// snapshot (lib/tools.js replaceTools) and the pure status/injection/ordering
// helpers (lib/pure.js):
//  - a complete snapshot REPLACES the discovered set (stale tools removed)
//  - an EMPTY snapshot clears the discovered set
//  - malformed/out-of-bounds descriptors are rejected, never stored
//  - snapshot ordering by sender-derived tab/document + SW-issued monotonic
//    navigation epoch (seedSnapshotGate / syncSnapshotDocument /
//    acceptToolSnapshot — the round-30 gate)
//  - per-tab per-role injection summarization (summarizeInjection)
//  - status bounding + SW-attested vs page-reported separation
// @ts-nocheck — lib modules run against the mocked browser shims.

import { assert, assertEquals } from "jsr:@std/assert@1";

// The tools lib persists to origin-keyed OPFS via navigator.storage — install
// the same minimal in-memory OPFS fake the memory tests use.
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const node = this.node;
    return {
      size: (node.content ?? "").length,
      async text() { return node.content ?? ""; },
    };
  }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true,
  writable: true,
});

const tools = await import("../extension/lib/tools.js");
const pure = await import("../extension/lib/pure.js");

const ORIGIN = "https://snapshot.example";

Deno.test("snapshot: a complete report REPLACES the discovered set (stale removal)", async () => {
  await tools.replaceTools(ORIGIN, [
    { name: "a.one", source: "declared", description: "", inputSchema: { type: "object" } },
    { name: "b.two", source: "inferred", description: "", inputSchema: { type: "object" } },
  ]);
  let listed = await tools.listTools(ORIGIN);
  assertEquals(new Set(listed.map((t) => t.name)), new Set(["a.one", "b.two"]));
  // The next snapshot omits a.one — it must be REMOVED, not merged-retained.
  await tools.replaceTools(ORIGIN, [
    { name: "b.two", source: "inferred", description: "v2", inputSchema: { type: "object" } },
    { name: "c.three", source: "declared", description: "", inputSchema: { type: "object" } },
  ]);
  listed = await tools.listTools(ORIGIN);
  assertEquals(new Set(listed.map((t) => t.name)), new Set(["b.two", "c.three"]), "a.one was removed by the replacement");
});

Deno.test("snapshot: an EMPTY report clears the discovered set", async () => {
  await tools.replaceTools(ORIGIN, [
    { name: "a.one", source: "declared", description: "", inputSchema: { type: "object" } },
  ]);
  await tools.replaceTools(ORIGIN, []);
  assertEquals(await tools.listTools(ORIGIN), [], "the empty snapshot removed every tool");
});

Deno.test("snapshot: malformed + out-of-bounds + non-page descriptors are rejected", async () => {
  const accepted = await tools.replaceTools(ORIGIN, [
    { name: "ok", source: "declared", description: "", inputSchema: { type: "object" } },
    { name: "", source: "declared", description: "", inputSchema: {} }, // empty name
    { name: "x".repeat(200), source: "declared", description: "", inputSchema: {} }, // over-long name
    { name: "huge", source: "declared", description: "d".repeat(5000), inputSchema: {} }, // over-long description
    { name: "linked-tool", source: "linked", description: "", inputSchema: {} }, // not a page source
    { name: "ok", source: "inferred", description: "dup", inputSchema: {} }, // duplicate name — first wins
    null,
    "garbage",
  ]);
  assertEquals(accepted.length, 1, "only the single valid descriptor is accepted");
  assertEquals(accepted[0].name, "ok");
  assertEquals(accepted[0].source, "declared", "the first descriptor for a name wins");
  const listed = await tools.listTools(ORIGIN);
  assertEquals(listed.length, 1, "the directory holds only the accepted descriptor");
});

Deno.test("snapshot gate: sender-derived tab/document + monotonic navigation epoch ordering", async () => {
  const { seedSnapshotGate, syncSnapshotDocument, acceptToolSnapshot } = pure;
  // Enrollment seed binds the picker-approved tab.
  let gate = seedSnapshotGate(null, 7);
  assertEquals(gate, { tabId: 7, documentId: null, epoch: -1, maxEpoch: -1, seq: -1 });
  // The bridge startup sync binds the current document on the bound tab with a fresh epoch.
  let sync = syncSnapshotDocument(gate, 7, "doc-A");
  assertEquals(sync.bound, true);
  assertEquals(sync.gate.documentId, "doc-A");
  assertEquals(sync.gate.epoch, 0);
  gate = sync.gate;
  // A snapshot from the bound (tab, document) with the echoed epoch + advancing seq accepts.
  let acc = acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-A", epoch: 0, seq: 1 });
  assertEquals(acc.accept, true);
  gate = acc.gate;
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-A", epoch: 0, seq: 2 }).accept, true, "advancing seq accepted");
  // Replay / stale sequences are rejected.
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-A", epoch: 0, seq: 1 }).accept, false, "a replayed seq rejected");
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-A", epoch: 0, seq: 0 }).accept, false, "a stale seq rejected");
  // A SECOND same-origin tab never replaces the bound tab's snapshot…
  assertEquals(acceptToolSnapshot(gate, { tabId: 9, documentId: "doc-X", epoch: 0, seq: 99 }).accept, false, "a second same-origin tab is rejected");
  // …and never advances the gate at startup sync.
  assertEquals(syncSnapshotDocument(gate, 9, "doc-X").bound, false, "a second tab never binds");
  // A navigation on the bound tab advances the epoch; the stale document's late
  // report — or the OLD epoch echoed by a stale bridge — is rejected.
  sync = syncSnapshotDocument(gate, 7, "doc-B");
  assertEquals(sync.bound, true);
  assertEquals(sync.gate.epoch, 1, "a navigation issues a fresh monotonic epoch");
  gate = sync.gate;
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-A", epoch: 0, seq: 99 }).accept, false, "the stale document's late report rejected");
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-B", epoch: 0, seq: 1 }).accept, false, "the old epoch echoed by a stale bridge rejected");
  acc = acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-B", epoch: 1, seq: 1 });
  assertEquals(acc.accept, true, "the current (tab, document, epoch) accepted");
  gate = acc.gate;
  // Malformed identity is rejected.
  assertEquals(acceptToolSnapshot(gate, { tabId: null, documentId: "doc-B", epoch: 1, seq: 2 }).accept, false, "missing tab id rejected");
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "", epoch: 1, seq: 2 }).accept, false, "empty document id rejected");
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-B", epoch: 1, seq: -1 }).accept, false, "negative seq rejected");
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-B", epoch: 1, seq: 1.5 }).accept, false, "fractional seq rejected");
  assertEquals(acceptToolSnapshot(gate, { tabId: 7, documentId: "doc-B", epoch: 1, seq: "2" }).accept, false, "string seq rejected");
  // Re-enrollment RESEEDS the tab binding but NEVER reissues a stale epoch.
  const reseeded = seedSnapshotGate(gate, 7);
  assertEquals(reseeded.maxEpoch, gate.maxEpoch, "maxEpoch survives re-enrollment");
  assertEquals(reseeded.epoch, -1);
  const resynced = syncSnapshotDocument(reseeded, 7, "doc-C");
  assertEquals(resynced.gate.epoch, gate.maxEpoch + 1, "the next epoch is strictly greater than any issued one");
  // A null picker leaves the gate unbound until enrollment.status observes an
  // active browser-attested document. A snapshot report may never bind itself.
  const unbound = seedSnapshotGate(null, null);
  assertEquals(unbound.tabId, null);
  assertEquals(
    acceptToolSnapshot(unbound, { tabId: 3, documentId: "doc-1", epoch: 0, seq: 1 }).accept,
    false,
    "a snapshot cannot choose its own tab/document identity",
  );
  const firstSync = syncSnapshotDocument(unbound, 3, "doc-1");
  assertEquals(firstSync.bound, true, "startup status binds the first active reporting tab");
  assertEquals(
    acceptToolSnapshot(firstSync.gate, { tabId: 3, documentId: "doc-1", epoch: 0, seq: 1 }).accept,
    true,
  );
  assertEquals(syncSnapshotDocument(firstSync.gate, 4, "doc-2").bound, false, "a second tab can never replace the first-bound tab");
});

Deno.test("injection summary: a tab is ready only when BOTH worlds injected", async () => {
  const s = pure.summarizeInjection([
    { tabId: 1, main: true, bridge: true },
    { tabId: 2, main: true, bridge: false }, // partial — MAIN only
    { tabId: 3, main: false, bridge: false, error: "x".repeat(1000) }, // failed
  ]);
  assertEquals(s.targets, 3);
  assertEquals(s.ready, [1], "only the dual-injected tab is ready");
  assertEquals(s.partial, [{ tabId: 2, missing: ["bridge"] }], "the single-world tab is PARTIAL");
  assertEquals(s.failed.length, 1);
  assert(s.failed[0].error.length <= pure.WEBMCP_ERROR_BOUND, "the failure error is UTF-16 code-unit bounded");
  assertEquals(s.scriptStatus, "injection-partial");
  assertEquals(pure.summarizeInjection([{ tabId: 1, main: true, bridge: true }]).scriptStatus, "injected");
  assertEquals(pure.summarizeInjection([{ tabId: 1, main: false, bridge: false }]).scriptStatus, "injection-failed");
  assertEquals(pure.summarizeInjection([]).scriptStatus, "no-open-tabs");
});

Deno.test("status: SW-attested lifecycle is separate from page-reported data + bounded", async () => {
  // A page report lands in lastReport only.
  let status = pure.applyWebmcpPageReport(null, "https://a.example", pure.buildWebmcpPageReport([
    { name: "t", source: "declared" },
  ], 1000));
  assertEquals(status.scriptStatus, "none", "a page report never fabricates a lifecycle state");
  assertEquals(status.lastReport.toolCount, 1);
  // An attested lifecycle preserves the same-origin page report.
  status = pure.applyWebmcpLifecycle(status, { origin: "https://a.example", scriptStatus: "injected" }, 2000);
  assertEquals(status.scriptStatus, "injected");
  assertEquals(status.lastReport.toolCount, 1, "the page report survives a lifecycle update");
  // A bogus status string is coerced; an error is bounded.
  status = pure.applyWebmcpLifecycle(status, {
    origin: "https://a.example",
    scriptStatus: "discovered", // not an attested enum value — a page must never set this
    error: "e".repeat(1000),
  }, 3000);
  assertEquals(status.scriptStatus, "injection-error", "a non-enum status never lands");
  assert(status.scriptError.length <= pure.WEBMCP_ERROR_BOUND, "the lifecycle error is UTF-16 code-unit bounded");
  // A lifecycle record for a DIFFERENT origin drops the prior page report.
  status = pure.applyWebmcpLifecycle(status, { origin: "https://b.example", scriptStatus: "registered" }, 4000);
  assertEquals(status.lastReport, null, "cross-origin page data never carries over");
  // Tool names in a page report are bounded.
  const report = pure.buildWebmcpPageReport(
    Array.from({ length: 80 }, (_, i) => ({ name: "n".repeat(200) + i, source: "declared" })),
  );
  assertEquals(report.toolNames.length, 50, "tool names capped at 50");
  assert(report.toolNames.every((n) => n.length <= 128), "each tool name length-bounded");
});

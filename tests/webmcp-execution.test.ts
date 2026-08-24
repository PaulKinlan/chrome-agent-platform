// tests/webmcp-execution.test.ts — CAP-FB-20260824-WEBMCP-EXECUTION-01
// The stale-page fix: a closed/navigated approved tab is PLANNED (reuse an
// existing same-identity tab or open the canonical URL), not a hard failure.
// Pure planner KATs + gate re-bind transitions + the SW-level flow.
// @ts-nocheck — the chrome stub is intentionally dynamic (house style).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  matchesPageIdentity,
  planWebmcpInvocationTab,
  rebindSnapshotGate,
  seedSnapshotGate,
  syncSnapshotDocument,
  acceptToolSnapshot,
} from "../extension/lib/pure.js";

const CANON = "https://apps.example";
const t = (id, url, active = false) => ({ id, url, active });

Deno.test("planner: bound+alive tab wins (the current path, byte-identical)", () => {
  const binding = { tabId: 7, documentId: "doc-7", epoch: 3, seq: 2 };
  const plan = planWebmcpInvocationTab({
    canonical: CANON,
    binding,
    tabs: [t(7, "https://apps.example/app"), t(9, "https://apps.example/other")],
  });
  assertEquals(plan.kind, "bound");
  assertEquals(plan.tabId, 7);
  assertEquals(plan.documentId, "doc-7");
});

Deno.test("planner: bound tab dead → reuse the ACTIVE same-identity tab (else lowest id), deterministically", () => {
  // active wins over lowest-id
  const a = planWebmcpInvocationTab({
    canonical: CANON,
    binding: { tabId: 7, documentId: "doc-7" }, // tab 7 is gone
    tabs: [t(9, "https://apps.example/x"), t(3, "https://apps.example/y", true), t(1, "https://apps.example/z")],
  });
  assertEquals(a, { kind: "reuse", tabId: 3 });
  // no active → lowest tabId
  const b = planWebmcpInvocationTab({
    canonical: CANON,
    binding: { tabId: 7, documentId: "doc-7" },
    tabs: [t(9, "https://apps.example/x"), t(2, "https://apps.example/z")],
  });
  assertEquals(b, { kind: "reuse", tabId: 2 });
  // bound tab alive but on ANOTHER origin → the reuse path (never trusts the dead-origin tab)
  const c = planWebmcpInvocationTab({
    canonical: CANON,
    binding: { tabId: 7, documentId: "doc-7" },
    tabs: [t(7, "https://other.example/"), t(4, "https://apps.example/z")],
  });
  assertEquals(c, { kind: "reuse", tabId: 4 });
});

Deno.test("planner: no binding / no candidates → open the canonical URL; never invents a candidate", () => {
  const noBinding = planWebmcpInvocationTab({ canonical: CANON, binding: null, tabs: [t(1, "https://apps.example/x")] });
  assertEquals(noBinding, { kind: "reuse", tabId: 1 }); // binding null but a matching tab exists → reuse it
  const none = planWebmcpInvocationTab({ canonical: CANON, binding: null, tabs: [] });
  assertEquals(none, { kind: "open", url: CANON });
  const wrongOrigin = planWebmcpInvocationTab({ canonical: CANON, binding: null, tabs: [t(1, "https://other.example/")] });
  assertEquals(wrongOrigin, { kind: "open", url: CANON });
});

Deno.test("planner: matchesPageIdentity is the page-level seam (origin today; path refinement honored)", () => {
  assertEquals(matchesPageIdentity(t(1, "https://apps.example/a"), { origin: CANON }), true);
  assertEquals(matchesPageIdentity(t(1, "https://other.example/"), { origin: CANON }), false);
  assertEquals(matchesPageIdentity(t(1, "https://apps.example/a"), { origin: CANON, path: "/a" }), true);
  assertEquals(matchesPageIdentity(t(1, "https://apps.example/a"), { origin: CANON, path: "/b" }), false);
  assertEquals(matchesPageIdentity(t(1, "file:///etc"), { origin: CANON }), false);
});

Deno.test("gate re-bind: dead binding replaced, maxEpoch preserved, live binding NEVER displaced (round-30)", () => {
  // seed → bound tab 5, then a document sync → epoch 0 (maxEpoch starts at -1)
  const seeded = seedSnapshotGate(null, 5);
  assertEquals(seeded.tabId, 5);
  const synced = syncSnapshotDocument(seeded, 5, "doc-A");
  assertEquals(synced.bound, true);
  assertEquals(synced.gate.epoch, 0);
  assertEquals(synced.gate.maxEpoch, 0);
  // the binding dies → rebind replaces with the resolved tab, maxEpoch preserved
  const rebound = rebindSnapshotGate(synced.gate, 12);
  assertEquals(rebound.tabId, 12);
  assertEquals(rebound.documentId, null);
  assertEquals(rebound.maxEpoch, 0, "maxEpoch preserved (never reissue a stale epoch)");
  // the resolved tab's bridge syncs its NEW document → a fresh epoch (1)
  const reSynced = syncSnapshotDocument(rebound, 12, "doc-B");
  assertEquals(reSynced.bound, true);
  assertEquals(reSynced.gate.epoch, 1);
  // the gate now accepts a snapshot from doc-B only
  const accept = acceptToolSnapshot(reSynced.gate, { tabId: 12, documentId: "doc-B", epoch: 1, seq: 0 });
  assertEquals(accept.accept, true);
  // the old doc-A can never report again (a late stale report is rejected)
  const stale = acceptToolSnapshot(reSynced.gate, { tabId: 5, documentId: "doc-A", epoch: 0, seq: 5 });
  assertEquals(stale.accept, false);
});

Deno.test("gate: the round-30 fence — a second same-origin tab never displaces the live binding (unchanged)", () => {
  const seeded = seedSnapshotGate(null, 5);
  const synced = syncSnapshotDocument(seeded, 5, "doc-A");
  // a second same-origin tab's sync is rejected
  const second = syncSnapshotDocument(synced.gate, 9, "doc-X");
  assertEquals(second.bound, false);
  assertEquals(second.gate, synced.gate, "the gate is unchanged");
  // a second tab's snapshot is rejected
  const report = acceptToolSnapshot(synced.gate, { tabId: 9, documentId: "doc-X", epoch: 1, seq: 1 });
  assertEquals(report.accept, false);
});

Deno.test("SW wiring: the invocation planner + rebind + readiness are wired into invokeSiteTool (source pins)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("planWebmcpInvocationTab({"), "the planner is consulted");
  assert(sw.includes("rebindSnapshotGate(cur, plan.tabId)"), "the deliberate re-bind transition");
  assert(sw.includes("waitForSnapshotBinding(canonical, plan.tabId)"), "the bounded readiness wait (reuse)");
  assert(sw.includes("waitForSnapshotBinding(canonical, created.id)"), "the bounded readiness wait (open)");
  assert(sw.includes("tool ${name} is not present on the freshly bound page"), "descriptor re-verification on the fresh path");
  // the fences are byte-identical:
  assert(sw.includes("the approved document changed before"), "the stale-document fence retained");
  assert(sw.includes("documentId: resolvedBinding.documentId"), "documentId-addressed sendMessage (the resolved document)");
  assert(sw.includes("enrollment.poke"), "the reuse path pokes the bridge to re-sync");
});

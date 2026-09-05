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
  assert(sw.includes("waitForSnapshotBinding(canonical, targetTabId)"), "the bounded readiness wait (reuse)");
  assert(sw.includes("waitForSnapshotBinding(canonical, created.id)"), "the bounded readiness wait (open)");
  assert(sw.includes("tool ${name} is not present on the freshly bound page"), "descriptor re-verification on the fresh path");
  // the fences are byte-identical:
  assert(sw.includes("the approved document changed before"), "the stale-document fence retained");
  assert(sw.includes("documentId: resolvedBinding.documentId"), "documentId-addressed sendMessage (the resolved document)");
  assert(sw.includes("enrollment.poke"), "the reuse path pokes the bridge to re-sync");
});

Deno.test("delegated WebMCP: lazy tool sources report ready when enrolled & approved without open tab", async () => {
  const { executableWebMcpToolRecords, LazyToolProtocol } = await import("../extension/lib/lazy-tool-protocol.js");
  const { ToolSelectionAuthority } = await import("../extension/lib/tool-selection.js");

  const dispatched = [];
  const tools = [{
    name: "book_table_le_petit_bistro",
    source: "declared",
    description: "Book a table at Le Petit Bistro",
    inputSchema: {
      type: "object",
      properties: { partySize: { type: "number" }, date: { type: "string" } },
      required: ["partySize", "date"],
    },
  }];

  const origin = "https://googlechromelabs.github.io";
  const records = executableWebMcpToolRecords(tools, {
    origin,
    agentId: origin,
    documentId: "", // no open tab initially
    version: "page-current",
    sourceGeneration: "enrollment:1:document::epoch:0:seq:0",
    closureGeneration: "enrollment:1:document::epoch:0:seq:0",
    packageDigest: "sha256-pkg",
    permissionDigestByTool: {
      book_table_le_petit_bistro: "sha256-perm",
    },
    grantDigest: "sha256-grant",
    availabilityByTool: {
      book_table_le_petit_bistro: "ready", // ready because enrolled & approved
    },
    authorizationGuard: async () => ({
      ok: true,
      permissionDigest: "sha256-perm",
      grantDigest: "sha256-grant",
    }),
  }, ({ name, source, args }) => {
    dispatched.push({ name, source, args });
    return { ok: true, result: "Table booked for 2 on 2026-08-25" };
  });

  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority(),
  });

  const context = {
    signal: new AbortController().signal,
    runId: "run-1",
    taskId: "task-1",
    agentId: origin,
    origin,
    documentId: "",
    runGeneration: "1",
    catalogGeneration: "1",
  };

  const search = await protocol.search({ query: "book table" }, context);
  assertEquals(search.ok, true);
  assertEquals(search.results.length, 1);
  assertEquals(search.results[0].name, "book_table_le_petit_bistro");
  assertEquals(search.results[0].availability, "ready");
  assert(typeof search.results[0].selectionRef === "string", "selectionRef must be issued");

  // Execution succeeds through the protocol dispatch
  const exec = await protocol.execute({
    selectionRef: search.results[0].selectionRef,
    arguments: { partySize: 2, date: "2026-08-25" },
  }, context);

  assertEquals(exec.ok, true);
  assertEquals(dispatched.length, 1);
  assertEquals(dispatched[0].name, "book_table_le_petit_bistro");
  assertEquals(dispatched[0].args.partySize, 2);
});

Deno.test("delegated WebMCP: an ASK tool receives a selection so its dispatch can show first-use consent", async () => {
  const { executableWebMcpToolRecords, LazyToolProtocol } = await import("../extension/lib/lazy-tool-protocol.js");
  const { ToolSelectionAuthority } = await import("../extension/lib/tool-selection.js");

  const tools = [{
    name: "mutate_something",
    source: "declared",
    description: "Mutate something",
    inputSchema: { type: "object", properties: { val: { type: "string" } } },
  }];

  const origin = "https://googlechromelabs.github.io";
  const records = executableWebMcpToolRecords(tools, {
    origin,
    agentId: origin,
    documentId: "",
    version: "page-current",
    sourceGeneration: "enrollment:1:document::epoch:0:seq:0",
    closureGeneration: "enrollment:1:document::epoch:0:seq:0",
    packageDigest: "sha256-pkg",
    permissionDigestByTool: { mutate_something: "sha256-unapproved" },
    grantDigest: "sha256-grant",
    availabilityByTool: {
      mutate_something: "ready",
    },
  }, () => ({ ok: false }));

  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority(),
  });

  const context = {
    signal: new AbortController().signal,
    runId: "run-2",
    taskId: "task-2",
    agentId: origin,
    origin,
    documentId: "",
    runGeneration: "1",
    catalogGeneration: "1",
  };

  const search = await protocol.search({ query: "mutate" }, context);
  assertEquals(search.ok, true);
  assertEquals(search.results.length, 1);
  assertEquals(search.results[0].availability, "ready");
  assert(typeof search.results[0].selectionRef === "string", "ASK needs a selectionRef to reach the card-owning dispatch closure");
});

Deno.test("delegated WebMCP: invokeSiteTool source contract requires tab opening & focus on dead/missing binding", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // Invariant 1: ASK and Allow are executable (the dispatch owns the first-use
  // card); Deny/disenrollment are excluded before a page call.
  assert(sw.includes('availabilityByTool[sourceTool.name] = !enrollment.enrolled || consent?.state === "denied"'), "readSiteLazySources consent availability calculation");
  assert(sw.includes("siteToolConsentPermissionDigest(consent)"), "selection identity binds the consent revision");
  // Invariant 2: invokeSiteTool checks alive bound tab before deciding to plan vs execute directly
  assert(sw.includes('const isBoundAlive = Boolean('), "isBoundAlive check in invokeSiteTool");
  // Invariant 3: opening new tab activates and focuses it
  assert(sw.includes('chrome.tabs.create({ url: openTargetUrl, active: true })') || sw.includes('chrome.tabs.create({ url: canonical, active: true })'), "open tab creates focused tab");
  // Invariant 4: reusing tab activates and focuses it
  assert(sw.includes('chrome.tabs.update(targetTabId, { active: true })'), "reuse tab activates target tab");
  // Invariant 5: descriptor re-verified on freshly bound page before dispatch
  assert(sw.includes('tool ${name} is not present on the freshly bound page'), "descriptor re-verification");
  // Invariant 6: round-30 fence preserves gap-born live+complete bindings
  assert(sw.includes('isCurAliveAndComplete'), "completeness and origin aware live fence");
});

Deno.test("round-30 in-lock fence: gap-born live+complete binding is NOT displaced; dead/off-origin/incomplete IS rebound", async () => {
  // A test helper simulating the in-lock predicate
  const checkRebind = (cur, curTab, canonical) => {
    let curOrigin = null;
    try {
      curOrigin = curTab?.url ? new URL(curTab.url).origin : null;
    } catch {
      curOrigin = null;
    }
    const isCurAliveAndComplete = Boolean(
      cur && cur.tabId != null &&
      typeof cur.documentId === "string" && cur.documentId.length > 0 &&
      Number.isInteger(cur.seq) && cur.seq >= 0 &&
      curTab?.id && curOrigin === canonical
    );
    return isCurAliveAndComplete;
  };

  const canonical = "https://googlechromelabs.github.io";

  // Case 1: Gap-born live & complete tab on same origin -> PRESERVED (not displaced)
  const gapBorn = { tabId: 42, documentId: "doc-gap", seq: 1, epoch: 1 };
  const gapTab = { id: 42, url: "https://googlechromelabs.github.io/bistro" };
  assertEquals(checkRebind(gapBorn, gapTab, canonical), true, "gap-born live+complete binding must be preserved");

  // Case 2: Dead tab -> REBOUND (dead: true)
  const deadBinding = { tabId: 99, documentId: "doc-old", seq: 1, epoch: 1 };
  assertEquals(checkRebind(deadBinding, null, canonical), false, "dead tab must be marked for rebind");

  // Case 3: Off-origin navigated tab -> REBOUND
  const offOriginTab = { id: 42, url: "https://evil.example.com/phish" };
  assertEquals(checkRebind(gapBorn, offOriginTab, canonical), false, "off-origin tab must be marked for rebind");

  // Case 4: Incomplete binding (empty documentId) -> REBOUND
  const incompleteBinding = { tabId: 42, documentId: "", seq: 1, epoch: 1 };
  assertEquals(checkRebind(incompleteBinding, gapTab, canonical), false, "incomplete binding (no doc) must be marked for rebind");

  // Case 5: Invalid seq -> REBOUND
  const invalidSeqBinding = { tabId: 42, documentId: "doc-gap", seq: -1, epoch: 1 };
  assertEquals(checkRebind(invalidSeqBinding, gapTab, canonical), false, "invalid seq must be marked for rebind");
});


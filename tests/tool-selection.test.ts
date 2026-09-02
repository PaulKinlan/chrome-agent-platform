// tests/tool-selection.test.ts — bounded expiring non-authorizing refs.
// @ts-nocheck

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildToolCatalog } from "../extension/lib/tool-catalog.js";
import {
  buildToolSearchIndex,
  searchToolIndex,
} from "../extension/lib/tool-search.js";
import {
  TOOL_SELECTION_BOUNDS,
  ToolSelectionAuthority,
} from "../extension/lib/tool-selection.js";

function item(index, overrides = {}) {
  return {
    sourceKind: "webmcp-declared",
    packageId: "webmcp:https://example.test",
    toolId: `tool-${index}`,
    version: "page-current",
    name: `tool-${index}`,
    aliases: [`match-${index}`],
    description: "common page tool",
    inputSchema: { type: "object" },
    capabilities: ["webmcp.invoke"],
    scope: {
      hub: false,
      agentId: "site:https://example.test",
      origin: "https://example.test",
      documentId: "doc-1",
    },
    sourceGeneration: "enrollment:1:epoch:1:seq:1",
    availability: "ready",
    dispatcherKind: "webmcp",
    ...overrides,
  };
}

function fixture(count = 3) {
  const catalog = buildToolCatalog(
    Array.from({ length: count }, (_, index) => item(index)),
  );
  const search = searchToolIndex(buildToolSearchIndex(catalog), "common", {
    limit: 12,
  });
  return { catalog, search };
}

function context(catalog, overrides = {}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    runGeneration: "generation-1",
    agentId: "site:https://example.test",
    origin: "https://example.test",
    documentId: "doc-1",
    catalogGeneration: catalog.generation,
    ...overrides,
  };
}

function refFactory() {
  let sequence = 0;
  return () => `sel_${(++sequence).toString(16).padStart(36, "0")}`;
}

Deno.test("tool selection: refs bind run/agent/origin/document/catalog/source generation and never authorize", () => {
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const issued = authority.issue(search, context(catalog), catalog);
  assertEquals(issued.ok, true);
  assert(issued.results.length > 0);
  assertEquals(issued.results[0].authorizes, false);
  assertEquals(issued.results[0].requiresLiveAuthorization, true);

  const selectionRef = issued.results[0].selectionRef;
  const resolved = authority.resolve(selectionRef, context(catalog), catalog);
  assertEquals(resolved.ok, true);
  assertEquals(resolved.authorizes, false);
  for (
    const changed of [
      { runId: "run-2" },
      { taskId: "task-2" },
      { runGeneration: "generation-2" },
      { agentId: "hub" },
      { origin: "https://other.test" },
      { documentId: "doc-2" },
      { catalogGeneration: "stale" },
    ]
  ) {
    assertEquals(
      authority.resolve(selectionRef, context(catalog, changed), catalog).ok,
      false,
    );
  }
});

Deno.test("tool selection: expiry is fail-closed", () => {
  let now = 1000;
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({
    clock: () => now,
    newRef: refFactory(),
  });
  const issued = authority.issue(search, context(catalog), catalog, {
    ttlMs: 10,
  });
  const selectionRef = issued.results[0].selectionRef;
  assertEquals(
    authority.resolve(selectionRef, context(catalog), catalog).ok,
    true,
  );
  now += 11;
  const expired = authority.resolve(selectionRef, context(catalog), catalog);
  assertEquals(expired.ok, false);
  assertEquals(expired.error, "selection-missing-or-expired");
  assertStringIncludes(String(expired.message), "search_tools", "the error says what to do next");
});

Deno.test("tool selection: source removal and generation changes revoke old refs", () => {
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const issued = authority.issue(search, context(catalog), catalog);
  const selectionRef = issued.results[0].selectionRef;
  const removed = buildToolCatalog([item(99)]);
  assertNotEquals(removed.generation, catalog.generation);
  assertEquals(
    authority.resolve(
      selectionRef,
      context(catalog, { catalogGeneration: removed.generation }),
      removed,
    ).ok,
    false,
  );
  const regenerated = buildToolCatalog([
    item(0, { sourceGeneration: "enrollment:2:epoch:1:seq:1" }),
    item(1),
    item(2),
  ]);
  assertEquals(
    authority.resolve(
      selectionRef,
      context(catalog, { catalogGeneration: regenerated.generation }),
      regenerated,
    ).ok,
    false,
  );
});

Deno.test("tool selection: per-run/result/total caps are enforced", () => {
  const { catalog, search } = fixture(100);
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const all = [];
  for (let index = 0; index < 10; index++) {
    const issued = authority.issue(search, context(catalog), catalog);
    all.push(...issued.results.filter((result) => result.selectionRef));
  }
  assert(all.length <= TOOL_SELECTION_BOUNDS.maxSelectionsPerRun);
  assert(
    authority.diagnostics().activeSelections <=
      TOOL_SELECTION_BOUNDS.maxTotalSelections,
  );
  assertEquals(authority.diagnostics().grantsCreated, 0);
  assertEquals(authority.diagnostics().executableRoutesCreated, 0);
});

Deno.test("tool selection: unavailable tools get no reference", () => {
  const catalog = buildToolCatalog([
    item(1, { availability: "owner-action-required" }),
  ]);
  const search = searchToolIndex(buildToolSearchIndex(catalog), "common");
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const issued = authority.issue(search, context(catalog), catalog);
  assertEquals(issued.results.length, 1);
  assertEquals(issued.results[0].selectionRef, null);
  assertEquals(authority.diagnostics().activeSelections, 0);
});

Deno.test("tool selection: stale/missing catalog and malformed fences fail closed", () => {
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  assertEquals(
    authority.issue(search, context(catalog, { runId: "" }), catalog).error,
    "missing-selection-fence",
  );
  assertEquals(
    authority.issue(
      search,
      context(catalog, { catalogGeneration: "old" }),
      catalog,
    ).error,
    "stale-catalog-generation",
  );
  const poison = {
    toString() {
      throw new Error("hostile");
    },
  };
  assertEquals(
    authority.issue(search, context(catalog, { runId: poison }), catalog).error,
    "missing-selection-fence",
  );
});

// CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01 — release() hands a claimed
// use back when the claim never dispatched (argument validation failed).
// CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01 rewrote the contract from single-use
// to BOUNDED REUSE: a claim counts one use; release gives that use back exactly
// once; the ref stays live for the same tool until expiry or the use bound.
Deno.test("tool selection: release hands a claimed use back exactly once, never after expiry", () => {
  let now = 1000;
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory(), clock: () => now });
  const issued = authority.issue(search, context(catalog), catalog);
  const selectionRef = issued.results[0].selectionRef;

  const claimed = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(claimed.ok, true);
  assertEquals(claimed.claim.selectionRef, selectionRef);
  assertEquals(claimed.claim.use, 1, "the claim records which use it was");
  // Reusable: the ref still resolves after a claim (no search round-trip).
  assertEquals(authority.resolve(selectionRef, context(catalog), catalog).ok, true);

  // Release gives the use back: the next claim is use 1 again.
  assertEquals(authority.release(claimed.claim), true);
  const resolved = authority.resolve(selectionRef, context(catalog), catalog);
  assertEquals(resolved.ok, true);
  assertEquals(resolved.expiresAt, claimed.expiresAt);
  // A second release of the same claim is a no-op (a use is never given back twice).
  assertEquals(authority.release(claimed.claim), false);

  const reclaimed = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(reclaimed.ok, true);
  assertEquals(reclaimed.claim.use, 1, "the released use was handed back");
  // Forged/foreign claims restore nothing.
  assertEquals(authority.release({ ...reclaimed.claim, selectionRef: "sel_" + "f".repeat(36) }), false);
  assertEquals(authority.release(null), false);
  // Past expiry the release is refused and the ref stays dead.
  now += TOOL_SELECTION_BOUNDS.maxTtlMs + 1;
  assertEquals(authority.release(reclaimed.claim), false);
  assertEquals(authority.resolve(selectionRef, context(catalog), catalog).ok, false);
});

// ── CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01 — bounded reuse ─────────────────
Deno.test("tool selection: a ref resolves for a second execute of the same tool", () => {
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const issued = authority.issue(search, context(catalog), catalog);
  const selectionRef = issued.results[0].selectionRef;
  const first = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(first.ok, true);
  const second = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(second.ok, true, `a second claim of the same ref must succeed, got ${JSON.stringify(second)}`);
  assertEquals(second.descriptor.stableId, first.descriptor.stableId, "the same tool");
  assertEquals(second.claim.use, 2);
  assertEquals(second.authorizes, false, "reuse never authorizes anything");
  assertEquals(second.requiresLiveAuthorization, true);
  // Reuse is a diagnostic handle, not an authority: the scope fences still hold.
  assertEquals(authority.claim(selectionRef, context(catalog, { runId: "run-2" }), catalog).ok, false);
});

Deno.test("tool selection: the 65th use is selection-replayed with a plain-English message", () => {
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const issued = authority.issue(search, context(catalog), catalog);
  const selectionRef = issued.results[0].selectionRef;
  assertEquals(TOOL_SELECTION_BOUNDS.maxUsesPerSelection, 64, "the bound is finite and named");
  for (let use = 1; use <= TOOL_SELECTION_BOUNDS.maxUsesPerSelection; use++) {
    const claimed = authority.claim(selectionRef, context(catalog), catalog);
    assertEquals(claimed.ok, true, `use ${use} must succeed`);
    assertEquals(claimed.claim.use, use);
  }
  const overflow = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(overflow.ok, false);
  assertEquals(overflow.error, "selection-replayed");
  assertStringIncludes(String(overflow.message), "64 times");
  assertStringIncludes(String(overflow.message), "search_tools");
  // The bound is sticky: resolve after the overflow is also replayed, never "missing".
  assertEquals(authority.resolve(selectionRef, context(catalog), catalog).error, "selection-replayed");
});

Deno.test("tool selection: a tool-level failure releases the use so the loop never burns the ref", () => {
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const issued = authority.issue(search, context(catalog), catalog);
  const selectionRef = issued.results[0].selectionRef;
  // Claim + release 200 times (a loop where every call fails): the ref never
  // reaches its use bound because each failed call hands its use back.
  for (let attempt = 0; attempt < 200; attempt++) {
    const claimed = authority.claim(selectionRef, context(catalog), catalog);
    assertEquals(claimed.ok, true, `attempt ${attempt}: the ref is still live`);
    assertEquals(claimed.claim.use, 1, `attempt ${attempt}: every failed use was returned`);
    assertEquals(authority.release(claimed.claim), true);
  }
  // A release of a claim that is not the latest use is refused (bounded, never a
  // double credit): claim twice, release the first, and the counter stays at 2.
  const a = authority.claim(selectionRef, context(catalog), catalog);
  const b = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(b.claim.use, 2);
  assertEquals(authority.release(a.claim), false, "only the latest use can be handed back");
  assertEquals(authority.release(b.claim), true);
  assertEquals(authority.claim(selectionRef, context(catalog), catalog).claim.use, 2);
});

Deno.test("tool selection: every failure token carries a message with the next action", () => {
  let now = 1000;
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory(), clock: () => now });
  const issued = authority.issue(search, context(catalog), catalog);
  const selectionRef = issued.results[0].selectionRef;
  const cases = [
    ["selection-scope-mismatch", authority.resolve(selectionRef, context(catalog, { runId: "run-2" }), catalog)],
    ["selection-catalog-stale", authority.resolve(selectionRef, context(catalog), { ...catalog, generation: "regenerated" })],
    ["selection-missing-or-expired", authority.resolve("sel_" + "f".repeat(36), context(catalog), catalog)],
    ["missing-selection-fence", authority.issue(search, context(catalog, { runId: "" }), catalog)],
    ["stale-catalog-generation", authority.issue(search, context(catalog, { catalogGeneration: "old" }), catalog)],
  ];
  // Same catalog generation, but the tool behind the ref is no longer ready.
  const stableId = issued.results[0].stableId;
  const sameGenerationStaleSource = {
    ...catalog,
    byStableId: { ...catalog.byStableId, [stableId]: { ...catalog.byStableId[stableId], availability: "owner-action-required" } },
  };
  cases.push(["selection-source-stale", authority.resolve(selectionRef, context(catalog), sameGenerationStaleSource)]);
  for (const [code, result] of cases) {
    assertEquals(result.ok, false, code);
    assertEquals(result.error, code);
    assert(typeof result.message === "string" && /search_tools/.test(result.message),
      `${code} must carry a sentence naming the next action, got ${JSON.stringify(result)}`);
    assert(!/\bselection-[a-z-]+\b/.test(result.message), `${code}: the message is prose, not the bare token`);
  }
});

Deno.test("tool selection: bounds are finite, named, and long enough for a 30-item loop", () => {
  assertEquals(TOOL_SELECTION_BOUNDS.defaultTtlMs, 10 * 60 * 1000, "a 30-tab loop takes longer than a minute");
  assertEquals(TOOL_SELECTION_BOUNDS.maxTtlMs, 15 * 60 * 1000);
  assertEquals(TOOL_SELECTION_BOUNDS.maxSelectionsPerRun, 128);
  for (const [name, value] of Object.entries(TOOL_SELECTION_BOUNDS)) {
    assert(Number.isFinite(value) && value > 0, `${name} is a finite positive bound`);
  }
});

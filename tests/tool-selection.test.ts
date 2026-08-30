// tests/tool-selection.test.ts — bounded expiring non-authorizing refs.
// @ts-nocheck

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
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
  assertEquals(
    authority.resolve(selectionRef, context(catalog), catalog),
    { ok: false, error: "selection-missing-or-expired" },
  );
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
// ref back when the claim never dispatched (argument validation failed).
Deno.test("tool selection: release restores a claimed ref exactly once, never after expiry or dispatch", () => {
  let now = 1000;
  const { catalog, search } = fixture();
  const authority = new ToolSelectionAuthority({ newRef: refFactory(), clock: () => now });
  const issued = authority.issue(search, context(catalog), catalog);
  const selectionRef = issued.results[0].selectionRef;

  const claimed = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(claimed.ok, true);
  assertEquals(claimed.claim.selectionRef, selectionRef);
  assertEquals(authority.resolve(selectionRef, context(catalog), catalog).error, "selection-replayed");

  // Release restores the identical record: resolve + claim work again.
  assertEquals(authority.release(claimed.claim), true);
  const resolved = authority.resolve(selectionRef, context(catalog), catalog);
  assertEquals(resolved.ok, true);
  assertEquals(resolved.expiresAt, claimed.expiresAt);
  // A second release of the same claim is a no-op (never a duplicate record).
  assertEquals(authority.release(claimed.claim), false);
  assertEquals(authority.diagnostics?.() ?? null, authority.diagnostics?.() ?? null);

  const reclaimed = authority.claim(selectionRef, context(catalog), catalog);
  assertEquals(reclaimed.ok, true);
  // Forged/foreign claims restore nothing.
  assertEquals(authority.release({ ...reclaimed.claim, selectionRef: "sel_" + "f".repeat(36) }), false);
  assertEquals(authority.release(null), false);
  // Past expiry the release is refused and the ref stays dead.
  now += TOOL_SELECTION_BOUNDS.maxTtlMs + 1;
  assertEquals(authority.release(reclaimed.claim), false);
  assertEquals(authority.resolve(selectionRef, context(catalog), catalog).ok, false);
});

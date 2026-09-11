// @ts-nocheck
// tests/run-driven-tool-ledger.test.ts
// Tests for chrome-agent-platform-n0sh:
// Run-driven tool executions participate in the action ledger and tool-usage counters.
//
// Verifies:
// 1. withRunToolBookkeeping records usage (recordToolCall) and ledgers mutating tools.
// 2. Error isolation: bookkeeping failures never delay or fail the tool execution.
// 3. Honest inverse per row: reversible mutations get executable inverse; irreversible
//    mutations get inverse: null; read-only tools produce no row.
// 4. Disjointness: exactly one ledger row and one counter increment per call.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  withRunToolBookkeeping,
  ledgerRowFor,
  isLedgerableTool,
} from "../extension/lib/action-ledger.js";

Deno.test("n0sh: withRunToolBookkeeping counts tool usage and ledgers mutating tools", async () => {
  const recordedCalls: string[] = [];
  const ledgerRows: Array<{ name: string; args: any; result: any; context: any }> = [];

  const rawTools = {
    open_tab: {
      description: "open a tab",
      execute: async (args: any) => ({ ok: true, tabId: 101, url: args.url }),
    },
    list_tabs: {
      description: "list tabs",
      execute: async () => ({ ok: true, tabs: [] }),
    },
  };

  const context = { executionId: "exec-1", runId: "exec-1", agentId: "researcher" };
  const wrapped = withRunToolBookkeeping(rawTools, context, {
    recordCall: async (name) => { recordedCalls.push(name); },
    writeLedgerRow: async (name, args, result, ctx) => {
      ledgerRows.push({ name, args, result, context: ctx });
    },
  });

  // 1. Mutating tool call: open_tab
  const openRes = await wrapped.open_tab.execute({ url: "https://example.com" });
  assertEquals(openRes, { ok: true, tabId: 101, url: "https://example.com" });
  assertEquals(recordedCalls, ["open_tab"], "open_tab must increment usage counter");
  assertEquals(ledgerRows.length, 1, "open_tab must write exactly one ledger row");
  assertEquals(ledgerRows[0].name, "open_tab");
  assertEquals(ledgerRows[0].context.executionId, "exec-1");

  // 2. Read-only tool call: list_tabs
  const listRes = await wrapped.list_tabs.execute({});
  assertEquals(listRes, { ok: true, tabs: [] });
  assertEquals(recordedCalls, ["open_tab", "list_tabs"], "list_tabs must increment usage counter");
  assertEquals(ledgerRows.length, 1, "read-only list_tabs must NOT produce an action ledger row");
});

Deno.test("n0sh error isolation: bookkeeping failures never fail or delay tool execution", async () => {
  const rawTools = {
    group_tabs: {
      description: "group tabs",
      execute: async (args: any) => ({ ok: true, groupId: 5, tabIds: args.tabIds }),
    },
  };

  const context = { executionId: "exec-2" };
  const wrapped = withRunToolBookkeeping(rawTools, context, {
    recordCall: async () => {
      throw new Error("injected usage storage failure");
    },
    writeLedgerRow: async () => {
      throw new Error("injected ledger storage failure");
    },
  });

  // Must not throw or fail; returns tool result cleanly:
  const res = await wrapped.group_tabs.execute({ tabIds: [1, 2] });
  assertEquals(res, { ok: true, groupId: 5, tabIds: [1, 2] });
});

Deno.test("n0sh honest inverse: reversible mutation vs irreversible mutation vs read-only", () => {
  // Reversible mutation: open_tab inverts to close_tab
  const openRow = ledgerRowFor("open_tab", { url: "https://example.com" }, { ok: true, tabId: 42, url: "https://example.com" });
  assert(openRow !== null);
  assertEquals(openRow.sentence, "Opened example.com");
  assertEquals(openRow.inverse, { tool: "close_tab", args: { tabId: 42 } });

  // Irreversible mutation: remove_bookmark has no inverse
  const removeBmRow = ledgerRowFor("remove_bookmark", { id: "bm_1" }, { ok: true });
  assert(removeBmRow !== null);
  assertEquals(removeBmRow.sentence, "Removed a bookmark");
  assertEquals(removeBmRow.inverse, null, "irreversible mutation must have inverse: null (no dead undo button)");

  // Read-only tool produces no row
  const readPageRow = ledgerRowFor("read_page", { tabId: 1 }, { ok: true, text: "content" });
  assertEquals(readPageRow, null, "read-only tool must not produce a ledger row");
});

Deno.test("n0sh re-entrancy & disjointness: __ledgerReentrant prevents duplicate recording", async () => {
  let ledgerCount = 0;
  let usageCount = 0;

  const rawTools = {
    close_tab: {
      description: "close tab",
      execute: async () => ({ ok: true, closed: { title: "Test" } }),
    },
  };

  // Re-entrant context (e.g. actions.undo running inverse):
  const reentrantContext = { executionId: "exec-undo", __ledgerReentrant: true };
  const wrapped = withRunToolBookkeeping(rawTools, reentrantContext, {
    recordCall: async () => { usageCount++; },
    writeLedgerRow: async () => { ledgerCount++; },
  });

  await wrapped.close_tab.execute({ tabId: 99 });
  assertEquals(usageCount, 1, "usage is counted");
  assertEquals(ledgerCount, 0, "re-entrant execution must NOT double-ledger");
});

Deno.test("n0sh source pin: service-worker wires withRunToolBookkeeping into run tools", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(
    sw.includes("withRunToolBookkeeping(liveBrowserTools"),
    "service-worker.js must wrap liveBrowserTools with withRunToolBookkeeping",
  );
  assert(
    sw.includes("withRunToolBookkeeping(liveManagementTools"),
    "service-worker.js must wrap liveManagementTools with withRunToolBookkeeping",
  );
});

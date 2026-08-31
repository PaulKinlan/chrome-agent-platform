// @ts-nocheck
// CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01 — the pure action-ledger core.
// A mutating tool call becomes a plain-language row with the reversing call
// (the inverse) when one exists; a read-only call is not ledger material; a
// mutating call with no inverse is logged but marked un-reversible.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ledgerRowFor,
  isLedgerableTool,
  appendLedgerRow,
  ACTION_LEDGER_MAX_ROWS,
  digestArgs,
} from "../extension/lib/action-ledger.js";

Deno.test("close_tab yields the right sentence and a restore inverse", () => {
  const row = ledgerRowFor(
    "close_tab",
    { tabId: 3 },
    { ok: true, closed: { title: "Example Domain" } },
    { recentlyClosed: [{ sessionId: "s1", title: "Example Domain" }] },
  );
  assert(row, "close_tab must produce a ledger row");
  assertEquals(row.sentence, "Closed Example Domain");
  assertEquals(row.inverse, { tool: "restore_closed", args: { sessionId: "s1" } });
  assertEquals(row.tool, "close_tab");
});

Deno.test("close_tab reads the sessionId from the recently-closed extra", () => {
  // The real close_tab result is { ok:true, tabId } with no title/sessionId —
  // both come from the list_recently_closed call the SW makes right after.
  const row = ledgerRowFor(
    "close_tab",
    { tabId: 7 },
    { ok: true, tabId: 7 },
    { recentlyClosed: [{ sessionId: "abc", title: "Docs" }] },
  );
  assertEquals(row.sentence, "Closed Docs");
  assertEquals(row.inverse, { tool: "restore_closed", args: { sessionId: "abc" } });
});

Deno.test("group_tabs inverts to ungroup_tabs with the same tabIds", () => {
  const row = ledgerRowFor("group_tabs", { tabIds: [1, 2, 3] }, { ok: true, groupId: 9, tabIds: [1, 2, 3] });
  assertEquals(row.sentence, "Grouped 3 tabs");
  assertEquals(row.inverse, { tool: "ungroup_tabs", args: { tabIds: [1, 2, 3] } });
});

Deno.test("open_tab inverts to close_tab with the fresh tab id", () => {
  const row = ledgerRowFor("open_tab", { url: "https://example.com/x" }, { ok: true, tabId: 12, url: "https://example.com/x" });
  assertEquals(row.sentence, "Opened example.com");
  assertEquals(row.inverse, { tool: "close_tab", args: { tabId: 12 } });
});

Deno.test("create_bookmark inverts to remove_bookmark by id", () => {
  const row = ledgerRowFor(
    "create_bookmark",
    { title: "Rust book", url: "https://doc.rust-lang.org" },
    { ok: true, id: "b42", title: "Rust book" },
  );
  assertEquals(row.sentence, "Bookmarked Rust book");
  assertEquals(row.inverse, { tool: "remove_bookmark", args: { id: "b42" } });
});

Deno.test("create_named_agent inverts to delete_named_agent by id", () => {
  const row = ledgerRowFor(
    "create_named_agent",
    { name: "Reader" },
    { ok: true, agent: { id: "reader", name: "Reader" } },
  );
  assertEquals(row.sentence, "Created the agent Reader");
  assertEquals(row.inverse, { tool: "delete_named_agent", args: { id: "reader" } });
});

Deno.test("a read-only tool is not ledger material (null row)", () => {
  assertEquals(ledgerRowFor("list_tabs", {}, { tabs: [] }), null);
  assertEquals(ledgerRowFor("read_page", { tabId: 1 }, { ok: true, text: "hi" }), null);
  assert(!isLedgerableTool("list_tabs"));
});

Deno.test("a mutating tool with no inverse is logged but not reversible", () => {
  const row = ledgerRowFor("remove_bookmark", { id: "b1" }, { ok: true });
  assert(row, "a mutation must still be logged");
  assertEquals(row.inverse, null);
  assert(row.sentence.length > 0);

  // navigate_tab is a mutation with no dedicated inverse builder → generic
  // sentence, no inverse.
  const nav = ledgerRowFor("navigate_tab", { tabId: 2, url: "https://x.test" }, { ok: true });
  assert(nav, "navigate_tab is a mutation and must be logged");
  assertEquals(nav.inverse, null);
  assert(isLedgerableTool("navigate_tab"));
});

Deno.test("a failed mutation is never logged", () => {
  assertEquals(ledgerRowFor("close_tab", { tabId: 3 }, { error: "run aborted" }), null);
  assertEquals(ledgerRowFor("open_tab", { url: "https://x" }, { ok: false }), null);
});

Deno.test("the ledger is bounded to ACTION_LEDGER_MAX_ROWS, most-recent last", () => {
  let rows = [];
  for (let i = 0; i < ACTION_LEDGER_MAX_ROWS + 25; i++) {
    rows = appendLedgerRow(rows, { id: `r${i}`, sentence: `row ${i}` });
  }
  assertEquals(rows.length, ACTION_LEDGER_MAX_ROWS);
  assertEquals(rows[rows.length - 1].id, `r${ACTION_LEDGER_MAX_ROWS + 24}`);
  assertEquals(rows[0].id, `r25`);
});

Deno.test("digestArgs is bounded and deterministic across key order", () => {
  const a = digestArgs({ b: 2, a: 1 });
  const b = digestArgs({ a: 1, b: 2 });
  assertEquals(a, b);
  assert(digestArgs({ big: "x".repeat(500) }).length <= 160);
});

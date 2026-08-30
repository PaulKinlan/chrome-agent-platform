// @ts-nocheck
// Bug 7: History is optional and its honest denial points to the real Settings
// capability control that can request the grant from an owner click.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { browserToolset } from "../extension/lib/browser-tools.js";

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url)),
);

function installChromeStub({ granted, historyRows = [] }) {
  globalThis.chrome = {
    permissions: {
      contains: async ({ permissions }) => (permissions ?? []).every((p) => granted.has(p)),
    },
    history: {
      search: async () => historyRows,
    },
  };
}

Deno.test("bug 7: history is optional and absent until the owner grants it", () => {
  assert(!(manifest.permissions ?? []).includes("history"));
  assert((manifest.optional_permissions ?? []).includes("history"));
});

Deno.test("bug 7: search_history executes after the owner grant", async () => {
  installChromeStub({
    granted: new Set(["history"]),
    historyRows: [{ url: "https://example.com/", title: "Example", visitCount: 3, lastVisitTime: 123 }],
  });
  const tools = browserToolset(false);
  const result = await tools.search_history.execute({ text: "example", maxResults: 5 });
  assertEquals(result.error, undefined, "the optional grant satisfies the gate");
  assert(Array.isArray(result.history), "results are returned");
  assertEquals(result.total, 1);
});

Deno.test("bug 7: an absent grant denies honestly and points at the Settings control", async () => {
  installChromeStub({ granted: new Set(), historyRows: [] });
  const tools = browserToolset(false);
  const result = await tools.search_history.execute({ text: "example", maxResults: 5 });
  assert(typeof result.error === "string" && result.error.length > 0, "fail closed when the grant is truly absent");
  assertStringIncludes(result.error, "Enable History in Settings", "the denial points at the real owner grant control");
});

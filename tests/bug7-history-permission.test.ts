// @ts-nocheck
// Bug 7 (owner, live on 0.2.346): search_history denied with "enable History
// in Settings" — but Settings had NO History control. Under the install-granted
// model every manifest permission is granted at install, so the tool's gate can
// never fire in a real install; if the grant state is ever genuinely broken the
// denial must point at REAL UI (the read-only Settings → Permissions display).
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

Deno.test("bug 7: history is an OPTIONAL permission (JIT-requested; the gate denies honestly until granted)", () => {
  // OPTIONAL + JIT model (owner directive 2026-08-29): history moved OUT of
  // the mandatory set — enterprise policy refused installs over it. The gate
  // now denies with a structured permissionRequired marker the chat turns
  // into an inline Enable affordance.
  assert(
    (manifest.optional_permissions ?? []).includes("history"),
    "history must be optional — the JIT grant path is the fix for bug 7's dead-end denial",
  );
  assert(
    !(manifest.permissions ?? []).includes("history"),
    "history must NOT be mandatory (enterprise policy refused installs over it)",
  );
});

Deno.test("bug 7: search_history EXECUTES with the install grant (no denial)", async () => {
  installChromeStub({
    granted: new Set(["history"]),
    historyRows: [{ url: "https://example.com/", title: "Example", visitCount: 3, lastVisitTime: 123 }],
  });
  const tools = browserToolset(false);
  const result = await tools.search_history.execute({ text: "example", maxResults: 5 });
  assertEquals(result.error, undefined, "no denial — the install grant satisfies the gate");
  assert(Array.isArray(result.history), "results are returned");
  assertEquals(result.total, 1);
});

Deno.test("bug 7: a broken grant state denies HONESTLY — structured, pointing at the chat affordance and Settings", async () => {
  installChromeStub({ granted: new Set(), historyRows: [] });
  const tools = browserToolset(false);
  const result = await tools.search_history.execute({ text: "example", maxResults: 5 });
  assert(typeof result.error === "string" && result.error.length > 0, "fail closed when the grant is truly absent");
  // The structured marker: the chat UI turns this into an inline Enable
  // affordance (the JIT request fires from the page's own user gesture).
  assertEquals(result.permissionRequired?.capability, "history");
  assertStringIncludes(result.error, "enable it from the chat when prompted", "the denial offers the in-chat affordance");
  assertStringIncludes(result.error, "Settings → Permissions", "the denial points at the Settings fallback");
});

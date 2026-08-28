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

Deno.test("bug 7: history is a manifest install grant (the tool gate can never fire post-install)", () => {
  assert(
    (manifest.permissions ?? []).includes("history"),
    "history must be in manifest permissions — the install grant is the ONLY grant path",
  );
  assert(
    !(manifest.optional_permissions ?? []).includes("history"),
    "history must NOT be optional (a runtime-requestable permission is the old broken model)",
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

Deno.test("bug 7: a broken grant state denies HONESTLY — pointing at real UI, never an Enable control", async () => {
  installChromeStub({ granted: new Set(), historyRows: [] });
  const tools = browserToolset(false);
  const result = await tools.search_history.execute({ text: "example", maxResults: 5 });
  assert(typeof result.error === "string" && result.error.length > 0, "fail closed when the grant is truly absent");
  assert(
    !/enable [A-Za-z ]+ in Settings/i.test(result.error),
    "the denial must not reference an Enable control — the install-granted model has none",
  );
  assertStringIncludes(result.error, "granted at install", "the denial explains the install-grant model");
  assertStringIncludes(result.error, "Settings → Permissions", "the denial points at the REAL read-only state display");
});

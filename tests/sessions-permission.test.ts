// @ts-nocheck
// chrome-agent-platform-3p3e.1 — the `sessions` optional permission.
//
// Observed before the fix: `chrome.sessions` REQUIRES the "sessions"
// permission, but the manifest declared it nowhere and the capability table
// said the three sessions tools needed none. In a loaded service worker
// `typeof chrome.sessions === "undefined"`, so list_recently_closed /
// restore_closed / list_synced_devices returned "sessions API not available in
// this browser context" unconditionally — three catalogued tools that could
// never run, and no Allow card to fix it (the close_tab Undo in the activity
// ledger rides restore_closed, so Undo was dead too).
//
// The contract pinned here (option (a) of the bead — make them real):
//   1. "sessions" is an optional_permission (never install-required).
//   2. The three capability rows list exactly ["sessions"], so the ONE-CARD
//      requirement derivation names it in plain words.
//   3. Without the grant each tool returns the standard permission-denied
//      shape that drives the in-context Allow card — never the dead-end
//      "not available" string. With chrome.sessions present + the grant the
//      reads return entries and the restore restores.
//   4. Settings → Permissions carries a row for it (the page renders
//      CAPABILITIES, not the manifest, so a row is what makes the Settings
//      fallback the denial text points at real).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { browserToolset, setOriginBrowserControlGrant } from "../extension/lib/browser-tools.js";
import { chromeToolCapability, requirementFor } from "../extension/lib/chrome-tool-capabilities.js";
import { PERMISSION_USER_LANGUAGE, permissionUserLanguage } from "../extension/lib/permission-language.js";
import { CAPABILITIES } from "../extension/lib/capabilities.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url)),
);

const SESSIONS_TOOLS = ["list_recently_closed", "restore_closed", "list_synced_devices"];

/** A chrome shim mirroring the two real profiles: `granted` is what
 *  chrome.permissions.contains answers; `withApi` is whether the
 *  chrome.sessions namespace is injected at all (Chrome injects it only when
 *  the permission is held — a profile without the grant has NO namespace,
 *  which is exactly the pre-fix dead end). */
function installChrome({ granted, withApi, closed = [], devices = [] }) {
  const store = new Map();
  const calls = { restore: [] };
  globalThis.chrome = {
    permissions: {
      contains: async ({ permissions = [], origins = [] }) =>
        permissions.every((p) => granted.has(p)) && origins.length === 0,
      getAll: async () => ({ permissions: [...granted], origins: [] }),
    },
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
        remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) store.delete(key); },
      },
    },
    runtime: { getManifest: () => manifest },
    tabs: { get: async () => null, query: async () => [] },
    ...(withApi
      ? {
        sessions: {
          // Chrome's real contract (sessions.MAX_SESSION_RESULTS = 25): a larger
          // filter is REJECTED, exactly as the live browser rejected the old
          // `maxResults: 100` call on the day the permission became real.
          getRecentlyClosed: async (filter) => {
            if (filter && Number.isFinite(filter.maxResults) && filter.maxResults > 25) {
              throw new Error("Error in invocation of sessions.getRecentlyClosed(optional sessions.Filter filter, function callback): Error at parameter 'filter': Error at property 'maxResults': Value must be at most 25.");
            }
            return closed;
          },
          getDevices: async () => devices,
          restore: async (sessionId) => {
            calls.restore.push(sessionId);
            return { tab: { id: 4242, sessionId } };
          },
        },
      }
      : {}),
  };
  clearRunFence();
  return calls;
}

Deno.test("3p3e.1 manifest: sessions is an OPTIONAL permission and never install-required", () => {
  assert(
    (manifest.optional_permissions ?? []).includes("sessions"),
    "sessions must be in optional_permissions — chrome.sessions is undefined without the permission",
  );
  assert(
    !(manifest.permissions ?? []).includes("sessions"),
    "sessions must NOT be install-required (the all-optional capability model)",
  );
});

Deno.test("3p3e.1 capability table: the three sessions rows list exactly [\"sessions\"]", () => {
  for (const name of SESSIONS_TOOLS) {
    const row = chromeToolCapability(name, "chrome-api");
    assertEquals([...row.optionalPermissions], ["sessions"], `${name} needs the sessions permission`);
    assertEquals(row.routeFamily, "browser.sessions");
  }
  // restore keeps its browser-control grant model (tab-scoped, covering every
  // restored origin); the reads need no product grant.
  assertEquals(chromeToolCapability("restore_closed", "chrome-api").productGrantScopeKind, "tab-scoped");
  assertEquals(chromeToolCapability("list_recently_closed", "chrome-api").productGrantScopeKind, "none");
  assertEquals(chromeToolCapability("list_synced_devices", "chrome-api").productGrantScopeKind, "none");
});

Deno.test("3p3e.1 Allow-card copy: the requirement names the permission in the owner's words, never the token", () => {
  assertEquals(PERMISSION_USER_LANGUAGE.sessions, "see and restore recently closed tabs");
  assertEquals(permissionUserLanguage("sessions"), "see and restore recently closed tabs");
  const need = requirementFor("list_recently_closed");
  assertEquals([...need.permissions], ["sessions"]);
  assertEquals([...need.reasons], ["see and restore recently closed tabs"]);
  const restore = requirementFor("restore_closed", { origins: ["https://docs.example"] });
  assertEquals([...restore.permissions], ["sessions"]);
  assertEquals(restore.browserControl, true, "restore still rides the browser-control grant");
  assertEquals([...restore.reasons], ["see and restore recently closed tabs", "control the browser on docs.example"]);
});

Deno.test("3p3e.1 without the grant (no namespace, as in a real ungranted profile): every sessions tool returns the permission-denied card shape, never 'not available'", async () => {
  installChrome({ granted: new Set(["storage", "tabs"]), withApi: false });
  const tools = browserToolset(false);
  for (const [name, args] of [["list_recently_closed", {}], ["list_synced_devices", {}], ["restore_closed", { sessionId: "s-1" }]]) {
    const r = await tools[name].execute(args);
    assertEquals(r.permissionRequired?.capability, "sessions", `${name}: names the sessions permission`);
    assertEquals(r.waitingForPermission, true, `${name}: carries the Allow-card marker`);
    assertEquals(r.permissionRequirement?.permissions, ["sessions"], `${name}: the card requests exactly sessions`);
    assert(typeof r.permissionRequirement?.reason === "string" && r.permissionRequirement.reason.length > 0, `${name}: the card has a reason`);
    assertStringIncludes(r.error, "sessions permission not granted", `${name}: the model-facing line is the standard denial`);
    assertStringIncludes(r.error, "allow it in the approval card here", `${name}: offers the in-context affordance`);
    assert(!/not available/i.test(r.error), `${name}: never the dead-end 'not available' string: ${r.error}`);
  }
});

Deno.test("3p3e.1 with the grant: list_recently_closed returns the closed entries and restore_closed restores (under the browser-control grant)", async () => {
  const calls = installChrome({
    granted: new Set(["storage", "tabs", "sessions"]),
    withApi: true,
    closed: [{ tab: { sessionId: "s-docs", url: "https://docs.example/page", title: "Docs" }, lastModified: 1700000001 }],
    devices: [{ deviceName: "Pixel", sessions: [] }],
  });
  const tools = browserToolset(false);
  // The model-facing schema and the Chrome call agree on Chrome's hard cap
  // (sessions.MAX_SESSION_RESULTS = 25): a maxResults of 100 is refused at the
  // schema, never forwarded to an API that would throw on it.
  assertEquals(tools.list_recently_closed.inputSchema.safeParse({ maxResults: 100 }).success, false, "maxResults above Chrome's cap is rejected by the schema");
  assertEquals(tools.list_recently_closed.inputSchema.safeParse({ maxResults: 25 }).success, true);
  const rc = await tools.list_recently_closed.execute({});
  assertEquals(rc.error, undefined, `no denial with the grant (and no Chrome maxResults rejection): ${rc.error}`);
  assertEquals(rc.total, 1);
  assertEquals(rc.closed[0], { kind: "tab", sessionId: "s-docs", url: "https://docs.example/page", title: "Docs", lastModified: 1700000001 });

  const dv = await tools.list_synced_devices.execute({});
  assertEquals(dv.error, undefined);
  assertEquals(dv.devices[0].deviceName, "Pixel");

  // The restore's own grant model is unchanged: the browser-control grant
  // must cover the restored origin; the sessions permission alone is not it.
  const denied = await tools.restore_closed.execute({ sessionId: "s-docs" });
  assert(denied.error && denied.permissionRequirement?.grantOrigins?.includes("https://docs.example"), "the restore still asks for browser control of the restored origin");
  assertEquals(calls.restore, [], "nothing restored before the grant");
  await setOriginBrowserControlGrant(["https://docs.example"]);
  const restored = await tools.restore_closed.execute({ sessionId: "s-docs" });
  assertEquals(restored.ok, true, `restored: ${JSON.stringify(restored)}`);
  assertEquals(restored.restoredTabId, 4242);
  assertEquals(calls.restore, ["s-docs"]);
});

Deno.test("3p3e.1 Settings → Permissions: a sessions row exists in the Browsing group (the Settings fallback the denial points at is real)", () => {
  const row = CAPABILITIES.find((c) => c.id === "sessions");
  assert(row, "a sessions capability row renders in Settings → Permissions");
  assertEquals(row.permissions, ["sessions"]);
  assertEquals(row.group, "browsing");
  assert(/recently closed/i.test(row.label) || /recently closed/i.test(row.hint), "the row speaks the owner's language");
  assert(row.gates.startsWith("Gates:"));
});

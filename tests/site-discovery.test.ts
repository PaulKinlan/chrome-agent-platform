// @ts-nocheck — dynamic test stubs for isolated execution verification.
import { assert, assertEquals } from "jsr:@std/assert@1";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable { constructor(n) { this.node = n; this.parts = []; } async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); } async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle { constructor(n) { this.node = n; } get kind() { return "file"; } async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; } async createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle {
  constructor(n) { this.node = n; } get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no dir ${name}`); this.node.children.set(name, dirNode()); } return new FakeDirHandle(this.node.children.get(name)); }
  async getFileHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no file ${name}`); this.node.children.set(name, fileNode("")); } return new FakeFileHandle(this.node.children.get(name)); }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", { value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } }, configurable: true, writable: true });

// Mock Chrome APIs
let registeredScripts = [];
let grantedOrigins = new Set();
let grantedPermissions = new Set(["scripting"]);
let permanentHostAccess = false;

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ host_permissions: permanentHostAccess ? ["<all_urls>"] : [] }),
  },
  permissions: {
    contains: async ({ origins = [], permissions = [] }) => {
      if (permissions.some((p) => !grantedPermissions.has(p))) return false;
      if (origins.some((o) => !grantedOrigins.has(o))) return false;
      return true;
    },
    request: async ({ origins = [], permissions = [] }) => {
      origins.forEach((o) => grantedOrigins.add(o));
      permissions.forEach((p) => grantedPermissions.add(p));
      return true;
    },
    remove: async ({ origins = [] }) => {
      origins.forEach((o) => grantedOrigins.delete(o));
      return true;
    },
  },
  scripting: {
    getRegisteredContentScripts: async ({ ids = [] } = {}) => {
      if (!ids.length) return registeredScripts.slice();
      return registeredScripts.filter((s) => ids.includes(s.id));
    },
    registerContentScripts: async (scripts) => {
      registeredScripts.push(...scripts);
    },
    unregisterContentScripts: async ({ ids = [] } = {}) => {
      registeredScripts = registeredScripts.filter((s) => !ids.includes(s.id));
    },
  },
};

const { ensureOriginScriptsRegistered, unregisterOriginScripts, reconcileEnrolledOriginScriptsOnBoot } = await import("../extension/lib/enrollment.js");
const { enrollOrigin, isEnrolled } = await import("../extension/lib/tools.js");
const { siteMemory } = await import("../extension/lib/memory.js");

Deno.test("site discovery PROBE (a): content scripts are absent on un-enrolled origins and require permission", async () => {
  registeredScripts = [];
  grantedOrigins.clear();

  const unenrolledOrigin = "https://bistro.example";
  // Without host permission, ensureOriginScriptsRegistered fails honestly
  const res = await ensureOriginScriptsRegistered(unenrolledOrigin);
  assertEquals(res.ok, false);
  assert(res.error.includes("host permission not granted"));
  assertEquals(registeredScripts.length, 0, "no scripts registered for un-enrolled origin");

  // When owner grants host permission, registration succeeds
  grantedOrigins.add(`${unenrolledOrigin}/*`);
  const registered = await ensureOriginScriptsRegistered(unenrolledOrigin);
  assertEquals(registered.ok, true);
  assertEquals(registeredScripts.length, 2, "main and bridge scripts registered");
});

Deno.test("site discovery PROBE (b): reconcileEnrolledOriginScriptsOnBoot restores content script registrations on boot", async () => {
  // Simulate enrolled origin in memory
  const origin = "https://enrolled-app.example";
  grantedOrigins.add(`${origin}/*`);
  await enrollOrigin(origin);
  assertEquals(await isEnrolled(origin), true);

  // Simulate browser/worker restart where in-memory script registrations were cleared
  registeredScripts = [];
  assertEquals(registeredScripts.length, 0);

  // Run boot reconciliation
  const boot = await reconcileEnrolledOriginScriptsOnBoot();
  assertEquals(boot.ok, true);
  assert(boot.results.some((r) => r.origin === origin && r.ok === true));
  assert(registeredScripts.length >= 2, "content scripts re-registered on boot");
});

Deno.test("site discovery: unregisterOriginScripts cleanly removes dynamic scripts and host permission", async () => {
  const origin = "https://to-remove.example";
  grantedOrigins.add(`${origin}/*`);
  await ensureOriginScriptsRegistered(origin);
  assertEquals(registeredScripts.some((s) => s.id.includes("to-remove")), true);

  const unreg = await unregisterOriginScripts(origin);
  assertEquals(unreg.ok, true);
  assertEquals(unreg.scriptsRemoved, true);
  assertEquals(unreg.permissionRemoved, true);
  assertEquals(registeredScripts.some((s) => s.id.includes("to-remove")), false);
});

Deno.test("site discovery: permanent manifest host access is honest cleanup success", async () => {
  const origin = "https://permanent-host.example";
  permanentHostAccess = true;
  grantedOrigins.add(`${origin}/*`);
  await ensureOriginScriptsRegistered(origin);
  try {
    const unreg = await unregisterOriginScripts(origin);
    assertEquals(unreg.ok, true);
    assertEquals(unreg.scriptsRemoved, true);
    assertEquals(unreg.permissionRemoved, false);
    assertEquals(unreg.hostPermissionPermanent, true);
  } finally {
    permanentHostAccess = false;
  }
});

Deno.test("site discovery WIRING (source pins): boot recovery and proactive discovery UI are wired", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

  // Invariant 1: SW runs reconcileEnrolledOriginScriptsOnBoot on startup
  assert(
    sw.includes("reconcileEnrolledOriginScriptsOnBoot().catch"),
    "SW must run reconcileEnrolledOriginScriptsOnBoot on boot",
  );
  // Invariant 2: NTP surfaces discoverable unenrolled tabs
  assert(
    ntp.includes('send("agent.discoverable-tabs")'),
    "NTP must query discoverable tabs in renderSiteAgents",
  );
  assert(
    ntp.includes("proactive-discovery-banner"),
    "NTP must render proactive discovery banner for unenrolled tabs",
  );
  // Invariant 3: Options page renders discovered open tabs for one-click enrollment
  assert(
    options.includes("renderDiscoveredOpenTabs()"),
    "Options must render discovered open tabs",
  );
  // Delete and retry-cleanup must trust unregisterOriginScripts' authoritative
  // result; it already distinguishes removable permission from permanent
  // manifest host access.
  assertEquals(
    sw.match(/if \(unreg\.ok === true && cleared\)/g)?.length,
    2,
    "both cleanup paths accept permanent host authority as non-removable success",
  );
});

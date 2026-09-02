// @ts-nocheck
// CAP-FB-20260901-READ-PAGE-HOST-GRANT-01 — read_page (and every tool that
// reaches into a page: the page-action family, capture_screenshot) on a site
// the extension has no host access for returns the STRUCTURED permission
// denial the conversation turns into ONE Allow card naming the site — never
// the raw Chrome string "Cannot access contents of the page. Extension
// manifest must request permission to access the respective host."
//
// The requirement names the site under `hostOrigins` (Chrome site access,
// requested via chrome.permissions.request({ origins }) from the owner's
// click) — distinct from `grantOrigins` (the product's browser-control policy
// grant, which reading a page does not need).
//
// In-memory chrome shim (the browser-tool-denial-contract pattern) with
// NOTHING granted by default; the shim's executeScript REJECTS with Chrome's
// real message whenever the tab's origin has no host access, so a missing
// pre-check reproduces the owner's run log exactly.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  browserToolset,
  readPage,
  revokeBrowserControlGrant,
  setOriginBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { approvePermissionRequirement, normalizePermissionRequirement } from "../extension/shared/conversation.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

const RAW_CHROME_MESSAGE = "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";
const EXAMPLE = "https://example.com";

// ---- in-memory chrome shim ----
const store = new Map();
const grantedPermissions = new Set();
const grantedOrigins = new Set();
const tabs = [];
let nextTabId = 1;
let executeScriptCalls = 0;
/** Origins whose host access is withdrawn AFTER the pre-check answered true
 * (the withheld-mid-flight race the catch backstop must still map). */
let withholdAfterCheck = null;

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedOrigins.clear();
  tabs.length = 0;
  nextTabId = 1;
  executeScriptCalls = 0;
  withholdAfterCheck = null;
  clearRunFence();
}

function addTab(url, { hideUrl = false } = {}) {
  const tab = { id: nextTabId++, windowId: 1, active: true, title: "Example" };
  if (!hideUrl) tab.url = url;
  tab._realUrl = url;
  tabs.push(tab);
  return tab;
}

function hostAllowed(url) {
  try {
    const origin = new URL(url).origin;
    if (!/^https?:$/.test(new URL(url).protocol)) return false;
    return grantedOrigins.has(`${origin}/*`) || grantedOrigins.has("<all_urls>");
  } catch {
    return false;
  }
}

globalThis.chrome = {
  permissions: {
    contains: async (q) => {
      if (q?.permissions && !q.permissions.every((p) => grantedPermissions.has(p))) return false;
      if (q?.origins) {
        const ok = q.origins.every((o) => grantedOrigins.has(o) || grantedOrigins.has("<all_urls>"));
        if (ok && withholdAfterCheck) {
          // The pre-check saw the grant; the site access is withdrawn before
          // the injection runs (the owner changed site access mid-run).
          for (const o of withholdAfterCheck) grantedOrigins.delete(o);
          withholdAfterCheck = null;
        }
        return ok;
      }
      return true;
    },
  },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
  tabs: {
    query: async () => [...tabs],
    get: async (id) => tabs.find((t) => t.id === id) ?? null,
    captureVisibleTab: async () => "data:image/png;base64,iVBORw0KGgo=",
    update: async (id) => tabs.find((t) => t.id === id) ?? null,
  },
  windows: {
    get: async (id) => ({ id, tabs: [...tabs] }),
    update: async (id) => ({ id }),
  },
  scripting: {
    executeScript: async ({ target }) => {
      executeScriptCalls++;
      const tab = tabs.find((t) => t.id === target?.tabId);
      const url = tab?._realUrl ?? "";
      if (!hostAllowed(url)) throw new Error(RAW_CHROME_MESSAGE);
      return [{ result: { title: "Example", url, text: "hello from the page" } }];
    },
  },
};

const tools = () => browserToolset(false);

/** The denial contract: the conversation's normaliser accepts it AND it names
 * the site under hostOrigins; the raw Chrome string is nowhere in it. */
function assertHostDenial(result, origin) {
  assertEquals(result?.waitingForPermission, true, `carries waitingForPermission: ${JSON.stringify(result)}`);
  const req = normalizePermissionRequirement(result);
  assert(req !== null, `accepted by normalizePermissionRequirement: ${JSON.stringify(result)}`);
  assert(Array.isArray(req.hostOrigins) && req.hostOrigins.includes(origin), `names ${origin} as a host origin: ${JSON.stringify(req)}`);
  assert(!JSON.stringify(result).includes("Cannot access contents"), `the raw Chrome string never reaches the model: ${JSON.stringify(result)}`);
  assert(typeof result.error === "string" && result.error.includes(origin), `the error text names the site: ${result.error}`);
  return req;
}

Deno.test("read_page: scripting granted, site access missing → ONE denial naming the site as a host origin (no raw Chrome string)", async () => {
  reset();
  grantedPermissions.add("scripting");
  const tab = addTab(`${EXAMPLE}/article`);
  const result = await readPage(tab.id);
  const req = assertHostDenial(result, EXAMPLE);
  assertEquals(req.permissions, [], "scripting is already granted — it is not re-requested");
  assertEquals(req.grantOrigins, [], "reading a page needs site access, not the browser-control grant");
  assertStringIncludes(req.reason, "example.com");
  assertEquals(executeScriptCalls, 0, "no injection is attempted without site access");
});

Deno.test("read_page: scripting AND site access missing → still ONE card naming both", async () => {
  reset();
  const tab = addTab(`${EXAMPLE}/`);
  const result = await tools().read_page.execute({ tabId: tab.id });
  const req = assertHostDenial(result, EXAMPLE);
  assert(req.permissions.includes("scripting"), `scripting is named too: ${JSON.stringify(req)}`);
});

Deno.test("read_page: site access withdrawn between the check and the injection → the backstop maps Chrome's message to the same denial", async () => {
  reset();
  grantedPermissions.add("scripting");
  grantedOrigins.add(`${EXAMPLE}/*`);
  withholdAfterCheck = [`${EXAMPLE}/*`];
  const tab = addTab(`${EXAMPLE}/`);
  const result = await readPage(tab.id);
  assertEquals(executeScriptCalls, 1, "the injection ran and was refused by Chrome");
  assertHostDenial(result, EXAMPLE);
});

Deno.test("read_page: with scripting and site access the page is read (no card)", async () => {
  reset();
  grantedPermissions.add("scripting");
  grantedOrigins.add(`${EXAMPLE}/*`);
  const tab = addTab(`${EXAMPLE}/`);
  const result = await readPage(tab.id);
  assertEquals(result.error, undefined, JSON.stringify(result));
  assertEquals(result.text, "hello from the page");
  assertEquals(result.untrusted, true);
});

Deno.test("read_page: a privileged chrome:// tab fails closed with a plain refusal (no card, no raw string)", async () => {
  reset();
  grantedPermissions.add("scripting");
  grantedOrigins.add("<all_urls>");
  const tab = addTab("chrome://settings/");
  const result = await readPage(tab.id);
  assert(typeof result.error === "string" && /http\(s\)/.test(result.error), JSON.stringify(result));
  assertEquals(result.waitingForPermission, undefined, "a privileged page is a refusal, never a permission card");
  assertEquals(executeScriptCalls, 0, "no injection into a privileged page");
});

Deno.test("read_page: a tab whose address is hidden (no tabs permission, site access withheld) asks for tabs, never a raw failure", async () => {
  reset();
  grantedPermissions.add("scripting");
  const tab = addTab(`${EXAMPLE}/`, { hideUrl: true });
  const result = await readPage(tab.id);
  assertEquals(result.waitingForPermission, true, JSON.stringify(result));
  const req = normalizePermissionRequirement(result);
  assert(req && req.permissions.includes("tabs"), `names the tabs permission: ${JSON.stringify(result)}`);
  assertEquals(executeScriptCalls, 0);
});

Deno.test("page actions: find_elements without site access names the site as a host origin in the SAME card as the browser-control grant", async () => {
  reset();
  grantedPermissions.add("scripting");
  await revokeBrowserControlGrant();
  const tab = addTab(`${EXAMPLE}/`);
  const result = await tools().find_elements.execute({ tabId: tab.id });
  const req = assertHostDenial(result, EXAMPLE);
  assert(req.grantOrigins.includes(EXAMPLE), `the browser-control grant is named on the same card: ${JSON.stringify(req)}`);
  assertEquals(executeScriptCalls, 0);
});

Deno.test("page actions: with the browser-control grant but no site access, only the host origin is asked for", async () => {
  reset();
  grantedPermissions.add("scripting");
  await setOriginBrowserControlGrant([EXAMPLE]);
  const tab = addTab(`${EXAMPLE}/`);
  const result = await tools().find_elements.execute({ tabId: tab.id });
  const req = assertHostDenial(result, EXAMPLE);
  assertEquals(req.grantOrigins, [], "the grant is already set — it is not re-requested");
});

Deno.test("capture_screenshot without site access names the site as a host origin (plus the missing browser-control grant)", async () => {
  reset();
  await revokeBrowserControlGrant();
  const tab = addTab(`${EXAMPLE}/`);
  const result = await tools().capture_screenshot.execute({ tabId: tab.id });
  const req = assertHostDenial(result, EXAMPLE);
  assert(req.grantOrigins.includes(EXAMPLE), JSON.stringify(req));
});

Deno.test("normaliser: a host-only requirement is a card; non-http(s) host origins are dropped; the key differs from a browser-control card for the same site", () => {
  const host = normalizePermissionRequirement({
    error: "x",
    waitingForPermission: true,
    permissionRequirement: { reason: "read the page on https://a.example", hostOrigins: ["https://a.example", "chrome://evil", "javascript:alert(1)"] },
  });
  assert(host !== null);
  assertEquals(host.hostOrigins, ["https://a.example"]);
  assertEquals(host.permissions, []);
  assertEquals(host.grantOrigins, []);
  const control = normalizePermissionRequirement({
    error: "x",
    waitingForPermission: true,
    permissionRequirement: { reason: "close a tab on https://a.example", grantOrigins: ["https://a.example"] },
  });
  assert(host.key !== control.key, "site access and browser control for the same site are different decisions");
  assertEquals(
    normalizePermissionRequirement({ error: "x", waitingForPermission: true, permissionRequirement: { hostOrigins: ["chrome://evil"] } }),
    null,
    "a forged non-http host origin never produces a card",
  );
});

Deno.test("approval: Allow requests EXACTLY the named site's host pattern from the click (one chrome.permissions.request) and writes no browser-control grant for a host-only card", async () => {
  const requests = [];
  const sent = [];
  const outcome = await approvePermissionRequirement(
    { reason: "read the page on https://a.example", permissions: [], grantOrigins: [], grantGlobal: false, hostOrigins: ["https://a.example"] },
    {
      sendFn: async (type, body) => { sent.push([type, body]); return { ok: true }; },
      requestPermissions: async (permissions, origins) => { requests.push({ permissions: [...permissions], origins: [...(origins ?? [])] }); return true; },
    },
  );
  assertEquals(outcome.ok, true, JSON.stringify(outcome));
  assertEquals(requests, [{ permissions: [], origins: ["https://a.example/*"] }], "the exact <origin>/* pattern, nothing wider");
  assertEquals(sent, [], "site access is not a browser-control grant");
});

Deno.test("approval: a card naming a permission AND a site makes ONE request carrying both (a single prompt from a single gesture)", async () => {
  const requests = [];
  const outcome = await approvePermissionRequirement(
    { reason: "read the page on https://a.example", permissions: ["scripting"], grantOrigins: [], grantGlobal: false, hostOrigins: ["https://a.example"] },
    {
      sendFn: async () => ({ ok: true }),
      requestPermissions: async (permissions, origins) => { requests.push({ permissions: [...permissions], origins: [...(origins ?? [])] }); return true; },
    },
  );
  assertEquals(outcome.ok, true);
  assertEquals(requests, [{ permissions: ["scripting"], origins: ["https://a.example/*"] }]);
});

Deno.test("approval: a declined site-access request grants nothing and says so", async () => {
  const sent = [];
  const outcome = await approvePermissionRequirement(
    { reason: "read the page on https://a.example", permissions: [], grantOrigins: ["https://a.example"], grantGlobal: false, hostOrigins: ["https://a.example"] },
    {
      sendFn: async (type, body) => { sent.push([type, body]); return { grant: { id: "g1" } }; },
      requestPermissions: async () => false,
    },
  );
  assertEquals(outcome.ok, false);
  assertEquals(sent, [], "no grant is written when the owner declined site access");
  assert(outcome.errors.length > 0);
});

// browser-control-grant-set.test.ts — CAP-FB-20260902-ORIGIN-GRANT-UNION-01.
// Per-origin browser-control grants are a SET, not one record: Allow on site B
// must keep site A granted; revoking one origin leaves the others; each grant
// keeps its OWN expiry; the set is bounded (oldest evicted first); the global
// grant stays a separate scope. Every mutation still runs under the grant lock
// and revoke still confirms absence before reporting success.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as bt from "../extension/lib/browser-tools.js";

const GRANT_KEY = "cap:browserControlGrant";
const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
  runtime: { id: "test" },
};

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";

async function reset() {
  store.clear();
}

Deno.test("grant set: Allow on B keeps A granted", async () => {
  await reset();
  await bt.setOriginBrowserControlGrant([A]);
  await bt.setOriginBrowserControlGrant([B]);
  assertEquals(await bt.isBrowserControlGranted(A), true, "A stays granted after B's Allow");
  assertEquals(await bt.isBrowserControlGranted(B), true, "B is granted");
  assertEquals(await bt.isBrowserControlGranted(C), false, "an origin never allowed is denied");
  const record = store.get(GRANT_KEY);
  assertEquals(record.scope, "origins");
  assertEquals([...record.origins].sort(), [A, B], "the record lists both origins");
});

Deno.test("grant set: revoke A leaves B", async () => {
  await reset();
  await bt.setOriginBrowserControlGrant([A]);
  await bt.setOriginBrowserControlGrant([B]);
  const res = await bt.revokeOriginBrowserControlGrant(A);
  assertEquals(res?.revoked, true, JSON.stringify(res));
  assertEquals(await bt.isBrowserControlGranted(A), false, "A is revoked");
  assertEquals(await bt.isBrowserControlGranted(B), true, "B is untouched");
  assertEquals(store.get(GRANT_KEY)?.origins, [B]);
});

Deno.test("grant set: revoking the last origin removes the record (nothing left to authorise)", async () => {
  await reset();
  await bt.setOriginBrowserControlGrant([A]);
  const res = await bt.revokeOriginBrowserControlGrant(A);
  assertEquals(res?.revoked, true);
  assertEquals(store.get(GRANT_KEY), undefined, "no empty origins record lingers");
  assertEquals(await bt.isBrowserControlGranted(A), false);
});

Deno.test("grant set: each origin keeps its OWN expiry — a timed A is not extended by a persistent B", async () => {
  await reset();
  await bt.setOriginBrowserControlGrant([A], 1); // 1 ms
  await bt.setOriginBrowserControlGrant([B]); // persistent
  await new Promise((r) => setTimeout(r, 15));
  assertEquals(await bt.isBrowserControlGranted(A), false, "A's own expiry passed");
  assertEquals(await bt.isBrowserControlGranted(B), true, "B is persistent");
  const listed = await bt.listOriginBrowserControlGrants();
  assertEquals(listed.map((g) => g.origin), [B], "the listing prunes the expired A");
  assertEquals(listed[0].expiresAt, null);
});

Deno.test("grant set: re-allowing an origin replaces its own entry (latest grant wins)", async () => {
  await reset();
  await bt.setOriginBrowserControlGrant([A], 1);
  await bt.setOriginBrowserControlGrant([A]); // persistent re-grant
  await new Promise((r) => setTimeout(r, 15));
  assertEquals(await bt.isBrowserControlGranted(A), true, "the persistent re-grant replaced the 1 ms one");
  assertEquals(store.get(GRANT_KEY).origins, [A], "no duplicate entry");
});

Deno.test("grant set: bounded — the 65th origin evicts the OLDEST grant first", async () => {
  await reset();
  const origins = Array.from({ length: 64 }, (_, i) => `https://o${i}.example`);
  for (const o of origins) await bt.setOriginBrowserControlGrant([o]);
  assertEquals(store.get(GRANT_KEY).origins.length, 64);
  await bt.setOriginBrowserControlGrant(["https://o64.example"]);
  const after = store.get(GRANT_KEY).origins;
  assertEquals(after.length, 64, "the set never exceeds the bound");
  assertEquals(after.includes("https://o0.example"), false, "the oldest grant was evicted");
  assertEquals(after.includes("https://o64.example"), true, "the newest grant is present");
  assertEquals(await bt.isBrowserControlGranted("https://o1.example"), true);
});

Deno.test("grant set: the global grant stays separate — revoking one origin under a global grant is refused", async () => {
  await reset();
  await bt.setGlobalBrowserControlGrant();
  const res = await bt.revokeOriginBrowserControlGrant(A);
  assertEquals(res?.revoked, false, JSON.stringify(res));
  assertEquals(await bt.isBrowserControlGranted(A), true, "the global grant is untouched");
  assertEquals(store.get(GRANT_KEY).scope, "global");
});

Deno.test("grant set: revoke-all still removes every origin at once", async () => {
  await reset();
  await bt.setOriginBrowserControlGrant([A]);
  await bt.setOriginBrowserControlGrant([B]);
  const res = await bt.revokeBrowserControlGrant();
  assertEquals(res?.revoked, true);
  assertEquals(await bt.isBrowserControlGranted(A), false);
  assertEquals(await bt.isBrowserControlGranted(B), false);
});

Deno.test("grant set: a legacy single-list record (no per-origin entries) is still honoured with its expiry", async () => {
  await reset();
  store.set(GRANT_KEY, { id: "legacy", scope: "origins", origins: [A], expiresAt: Date.now() + 60_000, grantedAt: Date.now() });
  assertEquals(await bt.isBrowserControlGranted(A), true);
  const listed = await bt.listOriginBrowserControlGrants();
  assertEquals(listed.length, 1);
  assertEquals(listed[0].origin, A);
  assert(typeof listed[0].expiresAt === "number");
  // Adding B unions with the legacy A rather than replacing it.
  await bt.setOriginBrowserControlGrant([B]);
  assertEquals(await bt.isBrowserControlGranted(A), true);
  assertEquals(await bt.isBrowserControlGranted(B), true);
});

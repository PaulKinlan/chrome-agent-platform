// Unit tests for the fail-closed KV shim (round-15 blocker 1): a storage
// BACKEND FAILURE (permission present but write/read throws) must REJECT, never
// silently fall back to a realm-local session value that contradicts the
// persistent backend. Only a genuinely ABSENT backend (permission ungranted →
// chrome.storage undefined) uses the session fallback.
// @ts-nocheck — the chrome mock is intentionally dynamic.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { freshKv } from "./test-hooks.js";

// Module isolation: kv.js owns its session/migration state in CLOSURE, so each
// test re-imports a FRESH module instance (cache-busted) rather than mutating
// shipped state. The bindings below are re-bound to the fresh instance's
// exports, so the bare `kvGet`/`kvSet`/... references below stay stable.
let kvGet, kvSet, kvRemove, storageAvailable, StorageBackendError,
  migrateSessionToStorage, snapshotPersistentToSession,
  snapshotPersistentToSessionLocked, onStoragePermissionTransition, withStorageModeLock;
async function resetKv() {
  const m = await freshKv();
  ({
    kvGet, kvSet, kvRemove, storageAvailable, StorageBackendError,
    migrateSessionToStorage, snapshotPersistentToSession,
    snapshotPersistentToSessionLocked, onStoragePermissionTransition, withStorageModeLock,
  } = m);
}


const store = new Map();
function makeChrome({ present = true, fail = false } = {}) {
  if (!present) {
    globalThis.chrome = {};
    return;
  }
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          if (fail) throw new Error("quota exceeded");
          const out = {};
          for (const k of (Array.isArray(key) ? key : [key])) {
            if (store.has(k)) out[k] = JSON.parse(JSON.stringify(store.get(k)));
          }
          return out;
        },
        set: async (obj) => {
          if (fail) throw new Error("quota exceeded");
          for (const [k, v] of Object.entries(obj)) store.set(k, JSON.parse(JSON.stringify(v)));
        },
        remove: async (keys) => {
          if (fail) throw new Error("quota exceeded");
          for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
        },
      },
    },
  };
}

Deno.test("kv reports storage unavailable when the backend is absent", async () => {
  await resetKv();
  makeChrome({ present: false });
  assertEquals(await storageAvailable(), false);
});

Deno.test("kvSet falls back to session ONLY when the backend is absent", async () => {
  await resetKv();
  makeChrome({ present: false });
  await kvSet({ "cap:x": 1 });
  assertEquals((await kvGet("cap:x"))["cap:x"], 1);
});

Deno.test("kvSet REJECTS on a backend failure (fail closed)", async () => {
  await resetKv();
  store.clear();
  makeChrome({ present: true, fail: true });
  await assertRejects(
    () => kvSet({ "cap:grant": { active: true } }),
    StorageBackendError,
  );
});

Deno.test("kvRemove REJECTS on a backend failure (fail closed)", async () => {
  await resetKv();
  store.clear();
  makeChrome({ present: true, fail: true });
  await assertRejects(() => kvRemove("cap:grant"), StorageBackendError);
});

Deno.test("kvGet REJECTS on a backend read failure (no stale session value)", async () => {
  await resetKv();
  store.clear();
  makeChrome({ present: true, fail: true });
  await assertRejects(() => kvGet("cap:grant"), StorageBackendError);
});

Deno.test("kvSet persists to the backend when it is present and healthy", async () => {
  await resetKv();
  store.clear();
  makeChrome({ present: true, fail: false });
  await kvSet({ "cap:x": { a: 1 } });
  // The value landed in the PERSISTENT store (not a session Map).
  assertEquals(store.get("cap:x"), { a: 1 });
});

Deno.test("kvSet reports durable vs session mode (the sidebar durability contract)", async () => {
  await resetKv();
  store.clear();
  makeChrome({ present: false });
  assertEquals(await kvSet({ "cap:x": 1 }), "session");
  makeChrome({ present: true, fail: false });
  assertEquals(await kvSet({ "cap:x": 2 }), "durable");
});

Deno.test("migrateSessionToStorage moves session fallback into the backend on grant (round-16)", async () => {
  await resetKv();
  store.clear();
  // Backend ABSENT → kvSet uses the session fallback.
  makeChrome({ present: false });
  await kvSet({ providerConfig: { provider: "openai" } });
  assertEquals((await kvGet("providerConfig"))["providerConfig"].provider, "openai");

  // Storage permission granted → backend appears. Migrate the session fallback.
  makeChrome({ present: true, fail: false });
  await migrateSessionToStorage();
  // The session value survived into the persistent backend (NOT reset to defaults).
  assertEquals(store.get("providerConfig").provider, "openai");
  // The session fallback is cleared after migration (no stale realm-local copy).
  const s = await kvGet("providerConfig");
  assertEquals(s["providerConfig"].provider, "openai");
});

Deno.test("migrateSessionToStorage preserves the session Map on a backend failure", async () => {
  await resetKv();
  store.clear();
  makeChrome({ present: false });
  await kvSet({ "cap:theme": "midnight" });

  // Backend appears but FAILS → migration must REJECT, leaving the session intact.
  makeChrome({ present: true, fail: true });
  await assertRejects(() => migrateSessionToStorage(), StorageBackendError);
  // The session value is preserved for a retry (never silently dropped).
  makeChrome({ present: false });
  assertEquals((await kvGet("cap:theme"))["cap:theme"], "midnight");
});

// ---- round-17 storage-transition tests (async permissions-aware availability) ----

/** A chrome mock where chrome.storage.local is TRUTHY but the permissions API
 * reports the `storage` permission as NOT granted (the post-Disable state). */
function makeChromeWithPermissions({ storageGranted = true } = {}) {
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          if (!storageGranted) throw new Error("'storage.get' is not available in this context");
          const out = {};
          const keys = key == null
            ? [...store.keys()]
            : (Array.isArray(key) ? key : [key]);
          for (const k of keys) {
            if (store.has(k)) out[k] = JSON.parse(JSON.stringify(store.get(k)));
          }
          return out;
        },
        set: async (obj) => {
          if (!storageGranted) throw new Error("'storage.set' is not available in this context");
          for (const [k, v] of Object.entries(obj)) store.set(k, JSON.parse(JSON.stringify(v)));
        },
        remove: async (keys) => {
          if (!storageGranted) throw new Error("'storage.remove' is not available in this context");
          for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
        },
      },
    },
    permissions: {
      contains: async ({ permissions }) => permissions.includes("storage") ? storageGranted : false,
    },
  };
}

Deno.test("storageAvailable uses permissions.contains as the authority (round-17 blocker)", async () => {
  await resetKv();
  store.clear();
  // chrome.storage.local is TRUTHY but the permission is absent (post-Disable).
  makeChromeWithPermissions({ storageGranted: false });
  assertEquals(await storageAvailable(), false, "truthy-but-unavailable storage must report absent");

  makeChromeWithPermissions({ storageGranted: true });
  assertEquals(await storageAvailable(), true);
});

Deno.test("kvSet uses the session fallback when storage is truthy-but-unavailable (round-17)", async () => {
  await resetKv();
  store.clear();
  makeChromeWithPermissions({ storageGranted: false });
  // Must NOT throw StorageBackendError — the permission is ABSENT, so this is
  // session-only mode, not a backend failure.
  await kvSet({ "cap:x": 42 });
  assertEquals((await kvGet("cap:x"))["cap:x"], 42);
});

Deno.test("snapshotPersistentToSession copies the persistent backend into the session Map", async () => {
  await resetKv();
  store.clear();
  makeChromeWithPermissions({ storageGranted: true });
  store.set("cap:theme", "midnight");
  store.set("providerConfig", { provider: "openai" });
  await snapshotPersistentToSession();

  // Now the backend is gone (Disable) — the session fallback must have the data.
  makeChrome({ present: false });
  assertEquals((await kvGet("cap:theme"))["cap:theme"], "midnight");
  assertEquals((await kvGet("providerConfig"))["providerConfig"].provider, "openai");
});

Deno.test("onStoragePermissionTransition (storage-permission transition) allows re-migration after a Disable→Enable cycle (round-17)", async () => {
  await resetKv();
  store.clear();
  // First grant: session → storage migration.
  makeChrome({ present: false });
  await kvSet({ providerConfig: { provider: "openai" } });
  makeChrome({ present: true });
  await migrateSessionToStorage();
  assertEquals(store.get("providerConfig").provider, "openai");

  // Disable: snapshot the persistent state back into session, reset migration.
  makeChrome({ present: false });
  onStoragePermissionTransition();
  // During the disabled period the owner changes the provider (session-only).
  await kvSet({ providerConfig: { provider: "anthropic" } });

  // Re-enable: migration must re-run and MERGE the session change over the old
  // persistent value (not restore the stale "openai").
  makeChrome({ present: true });
  await migrateSessionToStorage();
  assertEquals(store.get("providerConfig").provider, "anthropic");
});

Deno.test("withStorageModeLock serializes a concurrent kvSet behind a held transition (round-18)", async () => {
  await resetKv();
  store.clear();
  makeChromeWithPermissions({ storageGranted: true });
  store.set("cap:x", "v1");

  let snapshotDone = false;
  let writeRan = false;
  // Hold the storage-mode lock across snapshot (the disable transition).
  const transition = withStorageModeLock(async () => {
    await snapshotPersistentToSessionLocked();
    snapshotDone = true;
    // Give any (incorrectly) unsynchronized write a chance to run.
    await new Promise((r) => setTimeout(r, 10));
  });
  // A concurrent write issued during the held transition must QUEUE behind it,
  // not interleave with the snapshot (the round-18 storage-transition race).
  const write = kvSet({ "cap:x": "v2" }).then(() => {
    writeRan = true;
  });
  await transition;
  assert(snapshotDone, "snapshot completed inside the held transition");
  assert(!writeRan, "concurrent write must not run until the transition releases");
  await write;
  assert(writeRan, "concurrent write completes after the transition");
});

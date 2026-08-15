// Unit tests for the fail-closed KV shim (round-15 blocker 1): a storage
// BACKEND FAILURE (permission present but write/read throws) must REJECT, never
// silently fall back to a realm-local session value that contradicts the
// persistent backend. Only a genuinely ABSENT backend (permission ungranted →
// chrome.storage undefined) uses the session fallback.
// @ts-nocheck — the chrome mock is intentionally dynamic.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  kvGet,
  kvSet,
  kvRemove,
  storageAvailable,
  StorageBackendError,
  __resetSessionForTest,
} from "../extension/lib/kv.js";

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

Deno.test("kv reports storage unavailable when the backend is absent", () => {
  __resetSessionForTest();
  makeChrome({ present: false });
  assertEquals(storageAvailable(), false);
});

Deno.test("kvSet falls back to session ONLY when the backend is absent", async () => {
  __resetSessionForTest();
  makeChrome({ present: false });
  await kvSet({ "cap:x": 1 });
  assertEquals((await kvGet("cap:x"))["cap:x"], 1);
});

Deno.test("kvSet REJECTS on a backend failure (fail closed)", async () => {
  __resetSessionForTest();
  store.clear();
  makeChrome({ present: true, fail: true });
  await assertRejects(
    () => kvSet({ "cap:grant": { active: true } }),
    StorageBackendError,
  );
});

Deno.test("kvRemove REJECTS on a backend failure (fail closed)", async () => {
  __resetSessionForTest();
  store.clear();
  makeChrome({ present: true, fail: true });
  await assertRejects(() => kvRemove("cap:grant"), StorageBackendError);
});

Deno.test("kvGet REJECTS on a backend read failure (no stale session value)", async () => {
  __resetSessionForTest();
  store.clear();
  makeChrome({ present: true, fail: true });
  await assertRejects(() => kvGet("cap:grant"), StorageBackendError);
});

Deno.test("kvSet persists to the backend when it is present and healthy", async () => {
  __resetSessionForTest();
  store.clear();
  makeChrome({ present: true, fail: false });
  await kvSet({ "cap:x": { a: 1 } });
  // The value landed in the PERSISTENT store (not a session Map).
  assertEquals(store.get("cap:x"), { a: 1 });
});

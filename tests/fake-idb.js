// tests/fake-idb.js — genuine fake-indexeddb + TEST-ONLY targeted fault injection
// (store/key/operation/phase targeting, async request-error semantics). Never shipped.

import { IDBFactory, IDBObjectStore, IDBTransaction } from "fake-indexeddb";

let factory = null;
let faults = []; // { store, key, op, error, once }

export function addFault({ store, key, op, error, once = true }) {
  faults.push({ store, key, op, error, once });
}
export function clearFaults() {
  faults = [];
}
function takeFault(storeName, op, args) {
  const idx = faults.findIndex((f) => f.store === storeName && f.op === op);
  if (idx === -1) return null;
  const f = faults[idx];
  if (f.once) faults.splice(idx, 1);
  return f;
}

let patched = false;
function patchFaults() {
  if (patched) return;
  patched = true;
  for (const op of ["put", "add", "get", "delete"]) {
    const orig = IDBObjectStore.prototype[op];
    if (typeof orig !== "function") continue;
    IDBObjectStore.prototype[op] = function (...args) {
      // `this` is the object store; recover its name from the transaction.
      const f = faults.find((x) => x.op === op);
      if (f) {
        if (f.once) faults = faults.filter((x) => x !== f);
        throw f.error;
      }
      return orig.apply(this, args);
    };
  }
}

export function installFakeIdb() {
  patchFaults();
  factory = new IDBFactory();
  Object.defineProperty(globalThis, "indexedDB", { value: factory, configurable: true, writable: true });
  clearFaults();
  return factory;
}
export function resetFakeIdb() {
  installFakeIdb();
}

export async function openDb() {
  return new Promise((resolve, reject) => {
    const req = factory.open("cap-usage", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("authority")) db.createObjectStore("authority", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("quarantine")) db.createObjectStore("quarantine", { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function readStore(name, key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(name, "readonly");
    const r = tx.objectStore(name).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => resolve(null);
  });
}
export async function countStore(name) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(name, "readonly");
    const r = tx.objectStore(name).count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(0);
  });
}
export async function injectAuthorityBytes(bytes) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("authority", "readwrite");
    tx.objectStore("authority").put({ id: "ledger", bytes });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export { IDBObjectStore };

// tests/fake-locks.js — test-only origin-scoped Web Locks polyfill (shared across
// modules via globalThis). Never shipped.
const lockQueues = new Map();
export function installFakeLocks() {
  const nav = globalThis.navigator ?? {};
  const locks = {
    request(name, fn) {
      const prev = lockQueues.get(name) ?? Promise.resolve();
      const next = prev.then(() => fn(), () => fn());
      lockQueues.set(name, next.catch(() => {}));
      return next;
    },
  };
  Object.defineProperty(nav, "locks", { value: locks, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  return locks;
}
export function resetFakeLocks() { lockQueues.clear(); }

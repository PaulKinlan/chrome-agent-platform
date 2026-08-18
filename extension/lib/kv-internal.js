// kv-internal.js — the storage-mode in-memory state, shared between kv.js
// (the production module) and the Deno test harness. This is NOT a test seam:
// it is the same session Map / warned / migrated state that kv.js's
// migration/snapshot/fallback logic reads and writes. The test harness clears
// it directly between tests (no __*ForTest export anywhere in the shipped
// modules).

export const session = new Map();
export let warned = false;
export function setWarned(value) {
  warned = value;
}
export let migrated = false;
export function setMigrated(value) {
  migrated = value;
}

// extension/background/routes/index.js — route module registry and composition helpers.

export { requireSettingsSender } from "./auth.js";
export { kvRoutes } from "./kv.js";
export { permLeaseRoutes } from "./perm-lease.js";
export { createProviderRoutes } from "./provider.js";
export { createActivityRoutes, filterActivityEntries, ACTIVITY_STORE_CAPS } from "./activity.js";

/**
 * Merge route maps into a single frozen dictionary.
 * Fails closed (throws) if any route name is defined more than once.
 */
export function mergeRouteMaps(...maps) {
  const merged = {};
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const [key, handler] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        throw new Error(`Route collision: "${key}" is already registered`);
      }
      merged[key] = handler;
    }
  }
  return Object.freeze(merged);
}

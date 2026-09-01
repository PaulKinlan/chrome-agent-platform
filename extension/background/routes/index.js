// extension/background/routes/index.js — route module registry and composition helpers.

export { requireSettingsSender } from "./auth.js";
export { kvRoutes } from "./kv.js";
export { permLeaseRoutes } from "./perm-lease.js";
export { createProviderRoutes } from "./provider.js";
export { createMcpRoutes } from "./mcp.js";
export { createSchedulerRoutes } from "./scheduler.js";
export { createFsGrantRoutes } from "./fs-grants.js";
export { createAgentScheduleRoutes, createApplyAgentSchedule, createNamedAgentDeleteGate, normalizeScheduleTask } from "./agent-schedule.js";
export { createActivityRoutes, filterActivityEntries, ACTIVITY_STORE_CAPS } from "./activity.js";
export { closeAgentWorkerFor, createAgentWorkerRoutes, reconcileAgentWorkers } from "./agent-worker.js";
export {
  createMemoryRoutes,
  resolveMemory,
  trackMemoryWrite,
  awaitMemoryQuiescence,
  normalizeMemoryKey,
} from "./memory.js";

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

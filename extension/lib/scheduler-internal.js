// scheduler-internal.js — the worker-lifetime run state, shared between
// scheduler.js (production) and the Deno test harness. NOT a test seam: this is
// the same activeRuns Map + BOOT_AT instant that scheduler.js's lock-fence
// logic reads and writes. The test harness simulates a worker restart by
// clearing activeRuns + advancing the boot instant directly.

export const activeRuns = new Map();
export let BOOT_AT = Date.now();
export function advanceBoot() {
  BOOT_AT = Date.now();
}

// lib/run-context.js — the current run's SURFACE ATTRIBUTION, shared by the
// SW (which sets it around every runTask) and the durable tools that need to
// know WHICH agent/thread owns the side effect they persist.
//
// Same singleton-swap pattern as run-fence.js: the cached orchestrator (and
// therefore the tool closures) are shared across runs, so the SW stamps the
// active run's identity into this module per run and clears it afterward —
// combined with run serialization (withRunLock), only one run is ever active,
// so the context is unambiguous.
//
// WHY: a scheduled task fires LONG after the run that created it settled.
// Persisting the owner (threadId / agentRole / agentSurfaceRef) into the
// cap:scheduledTasks payload at SCHEDULE time is the only way the fired run
// can be attributed back to the owning agent/thread — without it the durable
// run record gets threadId:null / agentId:null and never projects into the
// Agents task/conversation surface (the owner report: "scheduled tasks via
// alarms don't appear in the Agents task/conversation").

/** @type {{ threadId: string|null, agentRole: string, agentSurfaceRef: string|null, folderGrants: Array<{ grantId: string, name: string }> } | null} */
let current = null;

// A run can carry at most this many attached folder grants (the /folder
// composer command). Bounded so a hostile/buggy caller cannot grow the run
// context without limit.
const MAX_FOLDER_GRANTS = 32;

// Bound every attribution string so a hostile/buggy caller can never grow the
// scheduled-task payload (and through it chrome.storage) without limit. The
// lengths match the durable run record's own bounding (threadId 200 in
// durable-runs.js; agentRole/agentSurfaceRef are short slugs by construction).
const MAX_ATTRIB_LEN = 200;

function boundedString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_ATTRIB_LEN);
}

/** The SW calls this inside runTask (under the run lock) BEFORE the agent
 * loop starts so every tool that runs inside THIS run can read its surface.
 * All fields are optional; absent fields normalize to null/"". */
/**
 * @param {{ threadId?: string|null, agentRole?: string, agentSurfaceRef?: string|null, folderGrants?: Array<{ grantId: string, name?: string }> }} [ctx]
 */
export function setRunContext({ threadId = null, agentRole = "", agentSurfaceRef = null, folderGrants = [] } = {}) {
  current = {
    threadId: boundedString(threadId),
    agentRole: boundedString(agentRole) ?? "",
    agentSurfaceRef: boundedString(agentSurfaceRef),
    // The folders attached to THIS run via the /folder composer command. Each
    // is the grant identity the file tools (grep_files / read_file / list_files
    // / find_files) resolve against so a task can actually operate on the
    // folder the owner provided. Bounded + string-checked.
    folderGrants: boundFolderGrants(folderGrants),
  };
}

function boundFolderGrants(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const grantId = boundedString(item.grantId);
    if (!grantId) continue;
    out.push({ grantId, name: boundedString(item.name) ?? grantId });
    if (out.length >= MAX_FOLDER_GRANTS) break;
  }
  return out;
}

/** The SW clears this in runTask's finally (next to clearRunFence) so a
 * settled run's identity can never leak into the NEXT run's tools. */
export function clearRunContext() {
  current = null;
}

/** The active run's surface attribution, or null when no run is active (e.g.
 * an owner-facing route that schedules outside any agent run — register-task).
 * Returns a COPY so a tool can never mutate the shared context. */
export function currentRunContext() {
  return current
    ? { ...current, folderGrants: (current.folderGrants || []).map((g) => ({ ...g })) }
    : null;
}

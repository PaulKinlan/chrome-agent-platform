// extension/lib/agent-config-save.js — Pure decision logic for agent config save outcomes.
// CAP-FB-20260908-AGENT-PARTIAL-SAVE-01 (chrome-agent-platform-9gn7).
//
// A successful schedule change with a failing persona update must NEVER be reported
// as ok: true or claim Settings approval. It must return ok: false, report the partial
// schedule success alongside the concrete persona failure, and preserve unsaved edits.

/**
 * Resolves the save outcome for an agent config edit given the schedule status
 * and the persona update result.
 *
 * @param {{ scheduleNote?: string, updateResult?: { ok?: boolean, error?: string } | null }} params
 * @returns {{ ok: boolean, error?: string, note?: string }}
 */
export function resolveAgentSaveResult({ scheduleNote = "", updateResult = null } = {}) {
  if (updateResult?.ok !== true) {
    return {
      ok: false,
      error: scheduleNote
        ? `${scheduleNote}, but persona update failed: ${updateResult?.error ?? "unknown"}`
        : (updateResult?.error ?? "unknown"),
    };
  }
  return scheduleNote ? { ok: true, note: scheduleNote } : { ok: true };
}

// extension/background/routes/hooks.js — the system-hooks routes, moved out of the service worker
// (chrome-agent-platform-atxc6, split by domain: hooks was the smallest real domain in the 5,010-line
// inline route map — 4 routes, 72 lines, and only two service-worker-scope references).
//
// This is a MOVE, not a rewrite: the handlers, their comments and their gating travel verbatim, so the
// security posture is unchanged and reviewable line by line:
//   * `hooks.status` is readable by the extension principal (the Settings panel).
//   * `hooks.deny` is OWNER-ONLY: the deny list is authoritative and the agent has no tool to change it,
//     so an agent can never un-deny a hook it was refused.
//   * `hooks.subscribe` / `hooks.unsubscribe` are approval-gated, and a MODEL caller may never author a
//     template (51cd): the owner authors, the model only ever gets the fenced fallback payload.
//
// The two service-worker-scope helpers are INJECTED rather than imported, because they are
// approval-gating machinery that lives in the worker (requireOwnerApproval dispatches to the ledger;
// payloadFields builds the canonical digest payload). Everything else this module needs is a library
// import, which is what makes the extraction a move instead of a refactor.
import {
  getHook,
  hookStatus,
  setHookDeny,
  subscribeHook,
  unsubscribeHook,
} from "../../lib/hooks.js";
import { canonicalField, canonicalOperationTarget, canonicalRecord } from "../../lib/owner-approval.js";

/**
 * @param {{
 *   requireOwnerApproval: (context: any, action: string, target: any, payload: any) => Promise<any>,
 *   payloadFields: (entries: [string, any][]) => any,
 * }} deps
 * @returns {Readonly<Record<string, Function>>} frozen route map
 */
export function createHooksRoutes({ requireOwnerApproval, payloadFields }) {
  if (typeof requireOwnerApproval !== "function") throw new Error("createHooksRoutes needs requireOwnerApproval");
  if (typeof payloadFields !== "function") throw new Error("createHooksRoutes needs payloadFields");
  return Object.freeze({
  async "hooks.status"() {
    // The Settings Hooks panel: every hook + denied state + subscribers.
    return { hooks: await hookStatus() };
  },
  // OWNER-ONLY: the deny-list is authoritative and can only be changed from the
  // Settings UI. It is deliberately NOT exposed to the agent toolset (no
  // `deny_hook` tool) — the agent can never un-deny a hook it was refused.
  async "hooks.deny"({ hookId, denied }, context) {
    if (context?.principal !== "owner-options") return { ok: false, error: "hook policy is owned by Settings" };
    if (!getHook(hookId)) return { ok: false, error: `unknown hook ${hookId}` };
    return await setHookDeny(hookId, denied !== false);
  },
  async "hooks.subscribe"({ hookId, skillId, recipeId, promptTemplate }, context) {
    const resolvedSkillId = skillId !== undefined ? skillId : recipeId;
    // chrome-agent-platform-51cd: the MODEL path may not author a template. Authorship belongs to the
    // owner; there is no owner subscribe UI today, so in practice a model-authored template is simply
    // unreachable, and the dispatch fallback (skill prompt + the fenced payload) is what runs instead
    // when the stored template is empty. Belt-and-braces on purpose: even if a future route forgets its
    // gate, an empty template cannot put model text into the instruction position.
    const authoredTemplate = context?.principal === "model" ? "" : promptTemplate;
    return await subscribeHook(
      { hookId, skillId: resolvedSkillId, recipeId: resolvedSkillId, promptTemplate: authoredTemplate },
      {
        gate: async ({ existing, candidate }) => {
          let payload;
          try {
            // `existing` is NULL on the create path (51cd made the gate unconditional), and the digest must
            // be STABLE across create and retry - an approved retry only matches when the payload it re-sends
            // is identical, so the absent-row form gets an explicit, fixed marker rather than throwing.
            payload = canonicalRecord(
              canonicalField("request", payloadFields([["hookId", candidate.hookId], ["recipeId", candidate.skillId ?? candidate.recipeId], ["promptTemplate", candidate.promptTemplate]])),
              existing
                ? canonicalField("existing", payloadFields([["hookId", existing.hookId], ["recipeId", existing.skillId ?? existing.recipeId], ["promptTemplate", existing.promptTemplate], ["enabled", existing.enabled], ["at", existing.at]]))
                : canonicalField("existing", payloadFields([["present", "false"]])),
            );
          }
          catch { return { ok: false, error: "hook subscription payload is not approvable" }; }
          return await requireOwnerApproval(
            context,
            "hooks.subscribe",
            canonicalOperationTarget("hook", candidate),
            payload,
          );
        },
      },
    );
  },
  async "hooks.unsubscribe"({ hookId, skillId, recipeId }, context) {
    const resolvedSkillId = skillId !== undefined ? skillId : recipeId;
    return await unsubscribeHook(
      { hookId, skillId: resolvedSkillId, recipeId: resolvedSkillId },
      {
        gateBeforeDelete: async ({ existing }) => {
          let payload;
          try { payload = payloadFields([["hookId", existing.hookId], ["recipeId", existing.skillId ?? existing.recipeId], ["promptTemplate", existing.promptTemplate], ["enabled", existing.enabled], ["at", existing.at]]); }
          catch { return { ok: false, error: "hook removal payload is not approvable" }; }
          return await requireOwnerApproval(
            context,
            "hooks.unsubscribe",
            canonicalOperationTarget("hook", existing),
            payload,
          );
        },
      },
    );
  },
  });
}

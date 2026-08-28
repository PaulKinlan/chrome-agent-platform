// lib/approval-bridge-audit.js — the EXACT production seam for the one-shot
// approval bridge + its owner-bridged audit (per-agent alarms P1-A).
//
// Extracted verbatim from the service worker's runTask block so tests can
// drive the real seam (not a re-implementation): the id shaping, the bridge,
// the degradation swallow, and the audit gate. The audit gate keys on
// bridged===true — {ok:true, bridged:false} (the approval already keyed to
// THIS run) must NEVER emit, or every re-entry of the same run audits a
// repeatable false bridge record.
import { bridgeApprovedApprovalToRun } from "./owner-approval.js";
import { securityApprovalEvent } from "./diagnostics.js";

export function bridgeAndAuditApprovalBindings({
  ownerApprovalStore,
  approvalBinding,
  executionId,
  auditEvent = securityApprovalEvent,
}) {
  const ids = (Array.isArray(approvalBinding) ? approvalBinding : [approvalBinding])
    .filter((aid) => typeof aid === "string" && aid.length > 0 && aid.length <= 160)
    .slice(0, 4);
  for (const aid of ids) {
    try {
      const bridged = bridgeApprovedApprovalToRun(ownerApprovalStore, aid, executionId);
      // Audit the bridge with the approval's opaque ref ("bridged" is an
      // allowlisted decision; the owner transparency surface shows it).
      // ONLY a real re-key audits: {ok:true, bridged:false} means the
      // approval was already keyed to THIS run — auditing every truthy ok
      // would emit a repeatable false bridge record on re-audit.
      if (bridged?.ok && bridged.bridged) auditEvent("bridged", bridged.action ?? "", bridged.targetRef ?? "");
    } catch { /* degraded — the tool re-requests */ }
  }
}

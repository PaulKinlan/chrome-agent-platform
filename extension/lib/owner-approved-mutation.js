// Complete an owner-approved Settings mutation without weakening the service
// worker's capability boundary. The first exact mutation creates a pending
// approval; only an explicit owner decision can resolve it, and approval is
// consumed by one exact retry. Ambiguous/stale approval queues fail closed.

const OWNER_APPROVAL_REQUIRED = "This operation requires owner approval.";

function cloneMessage(message) {
  if (!message || typeof message !== "object") throw new TypeError("message is required");
  return structuredClone(message);
}

async function safeSend(sendMessage, message) {
  try {
    return await sendMessage(cloneMessage(message));
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function approvals(response) {
  return Array.isArray(response?.approvals) ? response.approvals : null;
}

/**
 * Run a mutation that is gated by requireOwnerApproval.
 *
 * requestConfirmation is the UI boundary: it must return true only for a
 * genuine owner confirmation. A false/closed/error result denies the newly
 * created pending approval and never retries the mutation.
 */
export async function runOwnerApprovedMutation({
  message,
  action,
  sendMessage,
  requestConfirmation,
}) {
  if (typeof action !== "string" || !action || typeof sendMessage !== "function" || typeof requestConfirmation !== "function") {
    return { ok: false, error: "owner approval is unavailable" };
  }

  let exactMessage;
  try {
    exactMessage = cloneMessage(message);
  } catch {
    return { ok: false, error: "invalid mutation request" };
  }

  // Snapshot first so this save can claim only the approval row it creates.
  // Never guess from "the first row": another operation may be pending.
  const beforeResponse = await safeSend(sendMessage, { type: "management.pending-approvals" });
  const before = approvals(beforeResponse);
  if (beforeResponse?.ok !== true || before == null) {
    return { ok: false, error: "Could not inspect owner approvals; no changes were saved." };
  }
  const beforeIds = new Set(before.map((row) => row?.approvalId).filter((id) => typeof id === "string" && id));

  const first = await safeSend(sendMessage, exactMessage);
  if (first?.ok === true) return { ok: true, response: first, retried: false };
  if (first?.error !== OWNER_APPROVAL_REQUIRED) return { ok: false, error: first?.error ?? "mutation failed", response: first };

  const afterResponse = await safeSend(sendMessage, { type: "management.pending-approvals" });
  const after = approvals(afterResponse);
  if (afterResponse?.ok !== true || after == null) {
    return { ok: false, error: "Could not inspect the pending owner approval; no changes were saved.", stale: true };
  }
  const candidates = after.filter((row) =>
    row?.action === action &&
    typeof row?.approvalId === "string" && row.approvalId &&
    !beforeIds.has(row.approvalId)
  );
  if (candidates.length !== 1) {
    return { ok: false, error: "The owner approval changed before it could be confirmed; no changes were saved.", stale: true };
  }

  const candidate = candidates[0];
  let confirmed = false;
  try {
    confirmed = (await requestConfirmation({ action, targetRef: String(candidate.targetRef ?? "") })) === true;
  } catch {
    confirmed = false;
  }

  if (!confirmed) {
    const denied = await safeSend(sendMessage, {
      type: "management.resolve-approval",
      approvalId: candidate.approvalId,
      approve: false,
    });
    return {
      ok: false,
      cancelled: true,
      stale: denied?.ok !== true,
      error: denied?.ok === true
        ? "Provider change cancelled; no changes were saved."
        : "Provider change cancelled, but its pending approval was already stale; no changes were saved.",
    };
  }

  const resolved = await safeSend(sendMessage, {
    type: "management.resolve-approval",
    approvalId: candidate.approvalId,
    approve: true,
  });
  if (resolved?.ok !== true || resolved?.decision !== "approved") {
    return { ok: false, error: "That owner approval was stale; no changes were saved.", stale: true };
  }

  // No unrelated await belongs between capability resolution and consumption.
  const retry = await safeSend(sendMessage, exactMessage);
  return retry?.ok === true
    ? { ok: true, response: retry, retried: true }
    : { ok: false, error: retry?.error ?? "Approved provider change was not saved.", response: retry, retried: true };
}

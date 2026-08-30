// @ts-nocheck
// Approvals synthesis KATs — the owner's two requirements reconciled: the
// orphaned Settings "Approvals" section is REMOVED, and "revoke a permission"
// now confirms IN-CONTEXT (a native dialog via runOwnerApprovedMutation)
// instead of navigating to a settings list. Pins the SW approval contract +
// the absence of the #approvals detour.
import { assert, assertEquals } from "jsr:@std/assert@1";

const read = (rel) => Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test("approvals synthesis: the settings section + nav + wiring are fully removed", () => {
  const html = read("../extension/options/options.html");
  const js = read("../extension/options/options.js");
  assert(!html.includes('id="approvals"'), "approvals section removed");
  assert(!html.includes('data-section="approvals"'), "approvals nav removed");
  assert(!js.includes("renderApprovals"), "renderApprovals wiring removed");
  assert(!js.includes('"#approvals"'), "no navigation to the approvals section remains");
  assert(!js.includes("pendingCapabilityDisable"), "the pending-disable detour is gone");
});

Deno.test("approvals synthesis: the Permissions section has no Settings-list detours; Turn off is an in-context owner-approved revoke", () => {
  const js = read("../extension/options/options.js");
  // OPTIONAL + JIT model (owner directive 2026-08-29; superseding the
  // install-granted model this test was written under): capabilities are
  // runtime-revocable again, and the ONLY revoke control is the Turn off button
  // routed through the SW's capability.revoke via runOwnerApprovedMutation —
  // never the page-realm revokeCapability (CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01).
  assert(js.includes('action: "capability.revoke"'), "the Turn off control goes through capability.revoke");
  assert(!/\brevokeCapability\b/.test(js), "no page-realm revokeCapability in Settings");
  assert(!js.includes("grant-perm"), "no Enable-button detour");
  assert(!js.includes("revoke-perm"), "no Disable-button detour");
  // The in-context owner-approved mutation helper remains the path for real
  // runtime-grantable mutations (e.g. per-agent provider overrides).
  assert(/runOwnerApprovedMutation\(\{/.test(js), "the owner-approved mutation helper remains");
  assert(js.includes("confirmActionDialog"), "the in-context confirmation dialog remains");
});

Deno.test("approvals synthesis: the SW approval contract is consumed exactly once by the retry", async () => {
  // The helper (extension/lib/owner-approved-mutation.js) is the single
  // authority for the confirm → resolve → retry dance. Prove the contract with
  // a shim: first mutation → "requires owner approval", a NEW pending approval
  // appears, the in-context confirm resolves true, resolve-approval approves,
  // and the exact retry succeeds.
  const mod = await import("../extension/lib/owner-approved-mutation.js");

  const approvals = [];
  let revoked = false;
  let confirmCalled = 0;

  const sendMessage = async (msg) => {
    if (msg?.type === "management.pending-approvals") {
      return { ok: true, approvals };
    }
    if (msg?.type === "capability.revoke") {
      if (!revoked) return { ok: false, error: "This operation requires owner approval." };
      revoked = true;
      return { ok: true, revoked: true };
    }
    if (msg?.type === "management.resolve-approval") {
      return { ok: true, decision: msg.approve ? "approved" : "denied" };
    }
    return { ok: false, error: "unexpected message" };
  };

  // Seed: the first capability.revoke creates a pending approval.
  const origSend = sendMessage;
  let revokeCount = 0;
  const send = async (msg) => {
    if (msg?.type === "capability.revoke") {
      revokeCount++;
      if (revokeCount === 1) {
        // create the pending approval (the SW's requireOwnerApproval does this)
        approvals.push({ approvalId: "approval-1", action: "capability.revoke", targetRef: "storage" });
        return { ok: false, error: "This operation requires owner approval." };
      }
      // the retry, after approval, succeeds
      return { ok: true, revoked: true };
    }
    if (msg?.type === "management.pending-approvals") return { ok: true, approvals };
    if (msg?.type === "management.resolve-approval") return { ok: true, decision: msg.approve ? "approved" : "denied" };
    return { ok: false, error: "unexpected" };
  };

  const result = await mod.runOwnerApprovedMutation({
    message: { type: "capability.revoke", id: "storage" },
    action: "capability.revoke",
    sendMessage: send,
    requestConfirmation: async () => { confirmCalled++; return true; },
  });

  assertEquals(result.ok, true, "the revoke completes after in-context approval");
  assertEquals(confirmCalled, 1, "exactly one in-context confirmation");
  assertEquals(revokeCount, 2, "the exact mutation is retried once after approval");
});

Deno.test("approvals synthesis: the helper recognises the SW's Settings-originated refusal (\"…owner approval in Settings.\")", async () => {
  // requireOwnerApproval answers a Settings document with the "in Settings."
  // variant. The helper used to match only the bare sentence, so every Settings
  // mutation failed before its dialog opened. Guard: a first call answered
  // with the Settings variant must reach the confirmation and retry.
  const mod = await import("../extension/lib/owner-approved-mutation.js");
  const approvals = [];
  let done = false;
  let confirmCalled = 0;
  const sendMessage = async (m) => {
    if (m.type === "management.pending-approvals") return { ok: true, approvals: approvals.map((a) => ({ ...a })) };
    if (m.type === "management.resolve-approval") {
      const row = approvals.find((a) => a.approvalId === m.approvalId);
      if (!row) return { ok: false, error: "stale" };
      row.decision = m.approve ? "approved" : "denied";
      return { ok: true, decision: row.decision };
    }
    if (m.type === "capability.revoke") {
      const row = approvals.find((a) => a.action === "capability.revoke");
      if (row?.decision === "approved") { done = true; return { ok: true, revoked: true }; }
      if (!row) approvals.push({ approvalId: "a1", action: "capability.revoke", targetRef: "ref" });
      return { ok: false, error: "This operation requires owner approval in Settings." };
    }
    return { ok: false, error: "unknown" };
  };
  const res = await mod.runOwnerApprovedMutation({
    message: { type: "capability.revoke", id: "contextMenus" },
    action: "capability.revoke",
    sendMessage,
    requestConfirmation: async () => { confirmCalled++; return true; },
  });
  assertEquals(confirmCalled, 1);
  assertEquals(res.ok, true);
  assertEquals(res.retried, true);
  assertEquals(done, true);
});

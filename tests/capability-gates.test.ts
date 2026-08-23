// CAP-FB-20260823-ARTIFACT-DELETE-PERMISSION-01 — Settings permission rows must
// state which actions each capability gates (truth-in-UI), and artifact
// deletion must NEVER be gated by a Chrome permission (it lives in OPFS).
// @ts-nocheck
import { assert } from "jsr:@std/assert@1";
import { CAPABILITIES } from "../extension/lib/capabilities.js";

Deno.test("capability rows: every permission states the exact actions it gates", () => {
  for (const cap of CAPABILITIES) {
    assert(typeof cap.gates === "string" && cap.gates.length > 0, `${cap.id} has a gates statement`);
    assert(cap.gates.startsWith("Gates:"), `${cap.id} gates statement is actionable`);
    assert(cap.gates.length <= 220, `${cap.id} gates statement stays one bounded line`);
    // No row may CLAIM to gate artifact deletion (mentioning that artifacts are
    // exempt, in a separate sentence, is the required truth — see below).
    assert(!/gates[^.]*artifact/i.test(cap.gates), `${cap.id} must not claim to gate artifacts`);
  }
});

Deno.test("capability rows: pinned gate truths (no invisible dependencies)", () => {
  const byId = Object.fromEntries(CAPABILITIES.map((c) => [c.id, c]));
  // The storage row must carry the explicit exemption: artifacts/scripts live
  // in OPFS and never need the storage permission.
  assert(/artifacts? [^.]*never need/i.test(byId.storage.gates));
  // Spot-pin one more row so drift is caught exactly.
  assert(byId.tabs.gates.includes("opening, navigating, closing and listing tabs"));
});

Deno.test("owner-approval audit grammar still accepts the owner-direct marker", async () => {
  const mod = await import("../extension/lib/diagnostics.js");
  const ref = "c".repeat(32);
  const entry = mod.securityApprovalEvent("owner-direct", "asset.delete", ref);
  assert(entry && entry.kind === "owner-direct");
});

// tests/mcp-approval-contract.test.ts
// Regression coverage for chrome-agent-platform-gcuw:
// [CAP-FB-20260908-MCP-APPROVAL-CONTRACT-01] MCP mutation model-approval claim disagrees with store policy.
//
// Verifies that named-agent.set-mcp-servers is an owner-direct action that is
// strictly owner-only: absent from DESTRUCTIVE_ACTIONS, refused by createPendingApproval,
// not exposed to models, and documented truthfully without promising a phantom pending flow.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DESTRUCTIVE_ACTIONS,
  OWNER_DIRECT_ACTIONS,
  createApprovalStore,
  createPendingApproval,
  isOwnerDirectApproval,
} from "../extension/lib/owner-approval.js";
import { MANAGEMENT_TOOL_NAMES } from "../extension/lib/management-tools.js";

Deno.test("gcuw policy: named-agent.set-mcp-servers is owner-direct only and absent from DESTRUCTIVE_ACTIONS", () => {
  assert(
    OWNER_DIRECT_ACTIONS.has("named-agent.set-mcp-servers"),
    "named-agent.set-mcp-servers must be in OWNER_DIRECT_ACTIONS for in-dialog owner configuration",
  );
  assert(
    !DESTRUCTIVE_ACTIONS.has("named-agent.set-mcp-servers"),
    "named-agent.set-mcp-servers must NOT be in DESTRUCTIVE_ACTIONS (it is owner-only, not an approvable model mutation)",
  );
});

Deno.test("gcuw approval store: createPendingApproval refuses named-agent.set-mcp-servers as not approvable", () => {
  const store = createApprovalStore();
  const target = "named:agent-1";
  const digest = "a".repeat(64);

  const res = createPendingApproval(store, "run-1", "named-agent.set-mcp-servers", target, digest);
  assertEquals(res, { ok: false, error: "operation is not approvable" });
  assertEquals(store.approvals.size, 0, "no approval row may be created for an action outside DESTRUCTIVE_ACTIONS");
});

Deno.test("gcuw caller authority: isOwnerDirectApproval accepts extension UI documents and rejects model callers", () => {
  // Owner in extension UI document:
  assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, "named-agent.set-mcp-servers"), true);
  assertEquals(isOwnerDirectApproval({ principal: "owner-options", documentId: "doc-1" }, "named-agent.set-mcp-servers"), true);

  // Model caller:
  assertEquals(isOwnerDirectApproval({ principal: "model", executionId: "run-1", documentId: "doc-1" }, "named-agent.set-mcp-servers"), false);
  assertEquals(isOwnerDirectApproval({ principal: "model" }, "named-agent.set-mcp-servers"), false);

  // Web page caller:
  assertEquals(isOwnerDirectApproval({ principal: "page" }, "named-agent.set-mcp-servers"), false);

  // Missing or empty context:
  assertEquals(isOwnerDirectApproval({}, "named-agent.set-mcp-servers"), false);
  assertEquals(isOwnerDirectApproval(null, "named-agent.set-mcp-servers"), false);
  assertEquals(isOwnerDirectApproval(undefined, "named-agent.set-mcp-servers"), false);
});

Deno.test("gcuw tool surface: management tools do NOT expose named-agent.set-mcp-servers to models", () => {
  assert(!MANAGEMENT_TOOL_NAMES.includes("set_agent_mcp_servers"));
  assert(!MANAGEMENT_TOOL_NAMES.includes("set_mcp_servers"));
  assert(!MANAGEMENT_TOOL_NAMES.includes("named-agent.set-mcp-servers"));
});

Deno.test("gcuw truth in comments: owner-approval.js states owner-only policy without promising a model flow", async () => {
  const [ownerApprovalJs, ownerApprovalSecurityTest] = await Promise.all([
    Deno.readTextFile(new URL("../extension/lib/owner-approval.js", import.meta.url)),
    Deno.readTextFile(new URL("./owner-approval-security.test.ts", import.meta.url)),
  ]);

  assert(
    !ownerApprovalJs.includes("keeps the full pending-approval flow"),
    "owner-approval.js must NOT claim model callers keep a pending-approval flow for set-mcp-servers",
  );
  assert(
    !ownerApprovalSecurityTest.includes("keeps the full pending-approval flow"),
    "owner-approval-security.test.ts must NOT claim model callers keep a pending-approval flow for set-mcp-servers",
  );
});

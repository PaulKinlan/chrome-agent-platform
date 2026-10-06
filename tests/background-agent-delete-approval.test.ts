// tests/background-agent-delete-approval.test.ts — chrome-agent-platform-4h47,
// the acceptance for the `background-agent.delete` half: the route that had NO
// approval seam at all.
//
// THE DEFECT. `background-agent.delete` has been declared in OWNER_DIRECT_ACTIONS
// (extension/lib/owner-approval.js) since the census recorded the discrepancy, and
// docs/SW-DISPATCH-AUTHORITY-CENSUS.md classifies it OWNER_APPROVAL_DIRECT — but
// the route's handler took NO `context` parameter, so it could not have called the
// seam even if someone had meant it to. Any extension document could delete a
// background agent outright, with no owner-facing decision anywhere. A declaration
// with no possible call site is the most complete form of "declared, not called"
// (the "NOTHING AT ALL" row in this bead's scout map).
//
// THE DISPOSITION THIS FILE PINS (supervisor-approved). The action is NOT added to
// DESTRUCTIVE_ACTIONS: an owner-direct caller (an owner UI document with a
// browser-attested documentId) is unchanged, and a NON-owner caller FAILS CLOSED
// as "operation is not approvable" with NO pending card — the same strictly-owner-
// only disposition `named-agent.set-mcp-servers` carries
// (CAP-FB-20260908-MCP-APPROVAL-CONTRACT-01), and the safer of the two available.
// The policy lists were deliberately NOT widened to make the census sentence true;
// the census §4.3/§5.2 rows were corrected instead. THE TEST NAMES SAY "REFUSES"
// ON PURPOSE: a future reader must not expect a model-approval card here.
//
// WHAT THIS DRIVES. The REAL route member, AST-selected out of service-worker.js's
// `handlers` object literal and run in node:vm with the REAL owner-approval module
// (store, digest, canonical target). Only the route's downstream collaborators are
// stubbed, and they are stubs that RECORD, so "the gate ran first" is observable.
// @ts-nocheck — the vm context is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";
import { runInNewContext } from "node:vm";
import * as approvals from "../extension/lib/owner-approval.js";

const EXECUTION_ID = "exec-bgagent-delete";
const AGENT_ID = "tab-hygiene-custom-1759700000000";

/**
 * Load the production `background-agent.delete` member with the SW functions its
 * gate needs, and hand back the callable route. `calls` records what the route did
 * BEYOND the gate (teardown + registry write), which is how these tests prove the
 * gate runs FIRST and that a refusal removes nothing.
 */
async function loadRoute(approvalStore) {
  const source = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const functionNames = [
    "dispatchRoute",
    "approvalExecutionId",
    "isOwnerPrincipal",
    "requireOwnerApproval",
    "payloadFields",
  ];
  const functions = functionNames.map((name) => {
    const node = ast.body.find((n) => n.type === "FunctionDeclaration" && n.id.name === name);
    assert(node, `production function ${name} must exist`);
    return source.slice(node.start, node.end);
  });
  const handlers = ast.body
    .flatMap((n) => n.declarations ?? [])
    .find((n) => n.id.name === "handlers");
  assert(handlers, "the SW `handlers` route map must exist");
  const route = handlers.init.arguments
    .flatMap((n) => n.properties ?? [])
    .find((n) => n.key?.value === "background-agent.delete");
  assert(route, "the actual background-agent.delete dispatch member must exist");

  const calls = { teardown: [], registryWrites: [] };
  const dispatch = runInNewContext(
    `${functions.join("\n")}\nconst handlers = ({${source.slice(route.start, route.end)}}); dispatchRoute;`,
    {
      ...approvals,
      ownerApprovalStore: approvalStore,
      activeExecutions: new Set([EXECUTION_ID]),
      cancellingApprovalExecutions: new Set(),
      endedExecutions: new Set(),
      progressPorts: new Set(["conversation"]),
      opaqueTargetRef: async () => "opaque-test-ref",
      securityApprovalEvent: () => {},
      broadcastRegistryChanged: () => {},
      attention: { cardOpened: () => {}, cardClosed: () => {} },
      // The route's collaborators BELOW the gate. Recording stubs, so a test can
      // tell whether the body was reached at all.
      cancelScheduledTaskBackground: (name) => {
        calls.teardown.push(name);
        return { marked: Promise.resolve({ ok: true }) };
      },
      getCustomSkills: async () => [{ id: AGENT_ID, name: "Tab Hygiene (copy)", custom: true }],
      masterMemory: () => ({ set: async (key, value) => { calls.registryWrites.push([key, value]); } }),
      setTimeout,
      clearTimeout,
    },
  );
  return {
    calls,
    callAsModel: (body) => dispatch("background-agent.delete", body, {
      principal: "model",
      executionId: EXECUTION_ID,
      agentId: "hub",
      onApprovalEvent: async () => { throw new Error("a model background-agent.delete must never publish a card"); },
    }),
    callAsOwner: (body) => dispatch("background-agent.delete", body, {
      principal: "extension",
      documentId: "doc-options-1",
      senderUrl: "chrome-extension://test-extension-id/options/options.html",
    }),
  };
}

Deno.test("background-agent.delete from the MODEL path REFUSES (not approvable, no pending row) and removes nothing", async () => {
  const approvalStore = approvals.createApprovalStore();
  const { calls, callAsModel } = await loadRoute(approvalStore);

  const result = await callAsModel({ id: AGENT_ID });

  assertEquals(result.ok, false, `a model delete must be refused: ${JSON.stringify(result)}`);
  assertEquals(
    result.error,
    "operation is not approvable",
    "the refusal names the policy reason: the action is owner-only, so no model card can exist",
  );
  assertEquals(
    approvalStore.approvals.size,
    0,
    "no pending approval row may be raised — this action is deliberately absent from DESTRUCTIVE_ACTIONS",
  );
  // The gate is the FIRST statement in the route: neither the durable schedule
  // teardown nor the registry removal was reached.
  assertEquals(calls.teardown, [], "a refused delete must not tear the schedule down");
  assertEquals(calls.registryWrites, [], "a refused delete must not rewrite the custom-skill registry");
});

Deno.test("background-agent.delete from an OWNER document is direct (unchanged) and still removes the agent", async () => {
  const approvalStore = approvals.createApprovalStore();
  const { calls, callAsOwner } = await loadRoute(approvalStore);

  const result = await callAsOwner({ id: AGENT_ID });

  assertEquals(result.ok, true, `the owner's direct delete must still work: ${JSON.stringify(result)}`);
  assertEquals(result.stopping, true, "the non-blocking teardown shape is unchanged");
  assertEquals(approvalStore.approvals.size, 0, "an owner-direct delete raises no pending row");
  assertEquals(
    calls.teardown,
    [`skill:${AGENT_ID}`, `recipe:${AGENT_ID}`],
    "the owner path still tears down both spellings of the scheduled payload",
  );
  assertEquals(calls.registryWrites.length, 1, "the owner path still writes the filtered registry");
  assertEquals(
    calls.registryWrites[0][1],
    [],
    "the deleted agent is removed from the custom-skill list",
  );
});

Deno.test("background-agent.delete needs a canonical target: an absent id fails closed even for the owner", async () => {
  const approvalStore = approvals.createApprovalStore();
  const { calls, callAsOwner } = await loadRoute(approvalStore);

  const result = await callAsOwner({ id: "" });

  assertEquals(result.ok, false, `an empty id must not delete anything: ${JSON.stringify(result)}`);
  assertEquals(
    result.error,
    "This operation requires owner approval.",
    "an empty canonical target is refused by the seam itself, before any principal check",
  );
  assertEquals(calls.teardown, [], "no teardown for an unaddressable delete");
  assertEquals(calls.registryWrites, [], "no registry write for an unaddressable delete");
});

Deno.test("canonicalOperationTarget('background') binds the agent id verbatim and rejects an empty identity", () => {
  const target = approvals.canonicalOperationTarget("background", { id: AGENT_ID });
  assertEquals(target, `background:${new TextEncoder().encode(AGENT_ID).byteLength}:${AGENT_ID}`);
  // The kind is its OWN discriminator: a background agent may not render as the
  // same target ref as a named agent or a scheduled task with the same id string
  // (the drift this bead exists to remove).
  assert(
    target !== approvals.canonicalOperationTarget("named", { id: AGENT_ID }),
    "the background kind must not collapse into the named kind",
  );
  assert(
    target !== approvals.canonicalOperationTarget("scheduled", { id: AGENT_ID }),
    "the background kind must not collapse into the scheduled kind",
  );
  assertEquals(approvals.canonicalOperationTarget("background", { id: "" }), "", "an empty id is not a target");
  assertEquals(approvals.canonicalOperationTarget("background", {}), "", "an absent id is not a target");
  assertEquals(approvals.canonicalOperationTarget("background", null), "", "a null parts object is not a target");
});

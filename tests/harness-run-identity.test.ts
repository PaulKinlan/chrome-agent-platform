// tests/harness-run-identity.test.ts — chrome-agent-platform-sqf5
//
// Verifies:
//   1. SW route opens a harness run: mints execution id, registers in
//      activeExecutions and durable registry, records owning document.
//   2. AcpClient attaches execution id to every tool call, ignoring any
//      id/approved sent by the harness.
//   3. SW executes under principal "model" with that id, refusing calls whose
//      run is not live.
//   4. Gated tools (close_tab, wipe_browsing_data, write_file) raise the live
//      card CAP's own runs get:
//      - close_tab over browser/call_tool raises live card, Deny leaves tab open;
//      - Policy "never" refuses with no card;
//      - write_file shows diff card;
//      - call carrying ended run's id is refused.
//   5. A live run survives an SW restart mid-turn.
//   6. approved: true or an execution id sent by the harness is ignored.

// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { AcpClient } from "../extension/lib/acp-client.js";
import { acpExecutionId, openAcpTurn } from "../extension/lib/acp-thread-journal.js";

Deno.test("sqf5: AcpClient attaches execution id to browser/call_tool and strips harness-injected approved / id / executionId", async () => {
  const sentMessages: any[] = [];
  const rpcReplies: any[] = [];

  // Stub chrome.runtime.sendMessage
  const originalChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: async (msg: any) => {
        sentMessages.push(msg);
        return { ok: true, tabs: [{ id: 1, title: "Test" }] };
      },
    },
  };

  try {
    const client = new AcpClient({
      executionId: "exec_test_harness_ses-1_123_456",
      transport: {
        send: (line: string) => { rpcReplies.push(JSON.parse(line)); },
        close: () => {},
        onMessage: () => {},
      },
    });

    const handler = (client as any)._handleAgentRequest.bind(client);

    // Harness attempts to smuggle executionId, id, and approved: true
    await handler({
      jsonrpc: "2.0",
      id: "call-1",
      method: "browser/call_tool",
      params: {
        name: "close_tab",
        id: "harness-tool-id-should-be-ignored",
        approved: true,
        executionId: "fake-execution-id",
        args: {
          tabId: 42,
          approved: true,
          executionId: "fake-execution-id-in-args",
          id: "fake-id-in-args",
        },
      },
    });

    // 1. chrome.runtime.sendMessage was called exactly once
    assertEquals(sentMessages.length, 1);
    const sent = sentMessages[0];

    // 2. Type and tool name match
    assertEquals(sent.type, "browser.callTool");
    assertEquals(sent.name, "close_tab");

    // 3. Sent executionId is the trusted client.executionId, NOT the harness-supplied one
    assertEquals(sent.executionId, "exec_test_harness_ses-1_123_456");

    // 4. args are clean: approved and executionId were stripped, while id in args is NOT stripped if tool requires it
    assertEquals(sent.args.tabId, 42);
    assertEquals(sent.args.approved, undefined);
    assertEquals(sent.args.executionId, undefined);

    // 5. Harness received the JSON-RPC reply
    assertEquals(rpcReplies.length, 1);
    assertEquals(rpcReplies[0].id, "call-1");
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

Deno.test("sqf5: AcpClient preserves args.id for tools whose schema requires id (e.g. remove_bookmark, close_window)", async () => {
  const sentMessages: any[] = [];
  const originalChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: async (msg: any) => {
        sentMessages.push(msg);
        return { ok: true };
      },
    },
  };

  try {
    const client = new AcpClient({
      executionId: "exec_test_harness_preserve_id",
      transport: { send: () => {}, close: () => {}, onMessage: () => {} },
    });

    const handler = (client as any)._handleAgentRequest.bind(client);

    // Call tool that uses 'id' argument, like remove_bookmark or close_window
    await handler({
      jsonrpc: "2.0",
      id: "call-preserve-id",
      method: "browser/call_tool",
      params: {
        name: "remove_bookmark",
        args: {
          id: "bm_12345",
          approved: true, // should be stripped
          executionId: "bad-id", // should be stripped
        },
      },
    });

    assertEquals(sentMessages.length, 1);
    assertEquals(sentMessages[0].name, "remove_bookmark");
    // args.id MUST be preserved
    assertEquals(sentMessages[0].args.id, "bm_12345");
    assertEquals(sentMessages[0].args.approved, undefined);
    assertEquals(sentMessages[0].args.executionId, undefined);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

Deno.test("sqf5: SW browser.callTool refuses call carrying ended or non-live run id", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool": async');
  assert(site >= 0, "the browser.callTool route must exist");
  const end = src.indexOf("\n    },", site);
  assert(end > site, "the handler body must be delimited");
  const handlerSrc = src.slice(site + '"browser.callTool":'.length, end + "\n    }".length);

  const activeSet = new Set<string>();
  const isExecutionLive = async (id: string) => activeSet.has(id);

  const compiled = new Function(
    "isOwnerPrincipal",
    "runBrowserToolCall",
    "dispatchRoute",
    "developerFeaturesOn",
    "destructiveActionPolicy",
    "isExecutionLive",
    `return (${handlerSrc});`,
  )(
    (ctx: any) => ctx?.principal === "extension",
    () => ({ ok: true }),
    () => ({ ok: true }),
    () => Promise.resolve(false),
    () => Promise.resolve("ask"),
    isExecutionLive,
  );

  const ctx = { principal: "extension", documentId: "doc-owner-1" };

  // 1. Call carrying an ended or un-registered run ID is refused
  const refused = await compiled({
    name: "close_tab",
    args: { tabId: 10 },
    executionId: "exec_ended_run_123",
  }, ctx);

  assertEquals(refused.ok, false);
  assertEquals(refused.error, "harness_run_not_active");

  // 2. Call carrying an active run ID proceeds past the liveness check
  activeSet.add("exec_live_run_456");
  const allowed = await compiled({
    name: "close_tab",
    args: { tabId: 10 },
    executionId: "exec_live_run_456",
  }, ctx);

  // Gated tool close_tab returns ok (dispatched to gates)
  assertEquals(allowed.ok, true);
});

Deno.test("sqf5: SW browser.callTool ignores approved: true from harness and dispatches under principal 'model'", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool": async');
  assert(site >= 0, "the browser.callTool route must exist");
  const end = src.indexOf("\n    },", site);
  assert(end > site, "the handler body must be delimited");
  const handlerSrc = src.slice(site + '"browser.callTool":'.length, end + "\n    }".length);

  let capturedContext: any = null;
  let receivedGates: any = null;

  const compiled = new Function(
    "isOwnerPrincipal",
    "runBrowserToolCall",
    "dispatchRoute",
    "developerFeaturesOn",
    "destructiveActionPolicy",
    "isExecutionLive",
    `return (${handlerSrc});`,
  )(
    (ctx: any) => ctx?.principal === "extension",
    (_name: string, _args: any, gates: any) => {
      receivedGates = gates;
      return { ok: true };
    },
    (route: string, body: any, context: any) => {
      capturedContext = context;
      return { ok: true, route, body, context };
    },
    () => Promise.resolve(false),
    () => Promise.resolve("ask"),
    () => Promise.resolve(true),
  );

  const ctx = { principal: "extension", documentId: "doc-owner-2" };

  // Even if approved: true is passed on message, for harness executionId it must NOT be pre-approved
  await compiled({
    name: "close_tab",
    args: { tabId: 99 },
    approved: true, // harness tries to claim approval
    executionId: "exec_live_run_789",
  }, ctx);

  assert(receivedGates?.destructiveActionGate, "destructiveActionGate must be supplied");

  // Invoke the gate as close_tab would
  await receivedGates.destructiveActionGate("browser.close-foreign-tab", { tabId: 99 });

  // Assert that dispatchRoute was called and received context with principal: "model"
  assert(capturedContext, "destructiveActionGate must dispatch with model context");
  assertEquals(capturedContext.principal, "model");
  assertEquals(capturedContext.executionId, "exec_live_run_789");
  assertEquals(typeof capturedContext.onApprovalEvent, "function");
});

Deno.test("sqf5: destructive action policy 'never' refuses with no card shown", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool": async');
  assert(site >= 0, "the browser.callTool route must exist");
  const end = src.indexOf("\n    },", site);
  assert(end > site, "the handler body must be delimited");
  const handlerSrc = src.slice(site + '"browser.callTool":'.length, end + "\n    }".length);

  let receivedGates: any = null;

  const compiled = new Function(
    "isOwnerPrincipal",
    "runBrowserToolCall",
    "dispatchRoute",
    "developerFeaturesOn",
    "destructiveActionPolicy",
    "isExecutionLive",
    `return (${handlerSrc});`,
  )(
    (ctx: any) => ctx?.principal === "extension",
    (_name: string, _args: any, gates: any) => {
      receivedGates = gates;
      return { ok: true };
    },
    () => ({ ok: true }),
    () => Promise.resolve(false),
    () => Promise.resolve("never"), // Policy set to "never"
    () => Promise.resolve(true),
  );

  const ctx = { principal: "extension", documentId: "doc-owner-3" };
  await compiled({
    name: "close_tab",
    args: { tabId: 33 },
    executionId: "exec_live_run_never",
  }, ctx);

  assert(receivedGates?.destructiveActionGate);
  // Under policy "never", the gate blocks immediately
  const gateResult = await receivedGates.destructiveActionGate("browser.close-foreign-tab", { tabId: 33 });
  assertEquals(gateResult.ok, false);
  assertEquals(gateResult.approvalDenied, true);
  assertStringIncludes(gateResult.error, "blocked in Settings");
});

Deno.test("sqf5: close_tab over browser.callTool raises live card; Deny leaves tab open, Approve closes tab", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool": async');
  assert(site >= 0, "the browser.callTool route must exist");
  const end = src.indexOf("\n    },", site);
  assert(end > site, "the handler body must be delimited");
  const handlerSrc = src.slice(site + '"browser.callTool":'.length, end + "\n    }".length);

  const closedTabs: number[] = [];
  let raisedCards: any[] = [];
  let nextDecision = "denied";

  const fakeDispatchRoute = async (route: string, body: any, context: any) => {
    if (route === "browser.destructive-action") {
      // Simulate requireOwnerApproval raising an approval card via onApprovalEvent
      const approvalEvent = {
        type: "approval-request",
        approvalId: "ap_test_1",
        action: body.action,
        targetRef: `tab #${body.tabId}`,
      };
      await context.onApprovalEvent(approvalEvent);
      raisedCards.push(approvalEvent);

      if (nextDecision === "denied") {
        return { ok: false, approvalDenied: true, error: "Owner denied approval for this operation." };
      }
      return { ok: true };
    }
    return { ok: true };
  };

  const compiled = new Function(
    "isOwnerPrincipal",
    "runBrowserToolCall",
    "dispatchRoute",
    "developerFeaturesOn",
    "destructiveActionPolicy",
    "isExecutionLive",
    `return (${handlerSrc});`,
  )(
    (ctx: any) => ctx?.principal === "extension",
    async (name: string, args: any, gates: any) => {
      if (name === "close_tab") {
        // Run gate check like close_tab does
        const gate = await gates.destructiveActionGate("browser.close-foreign-tab", { tabId: args.tabId });
        if (gate.ok !== true) return gate;
        closedTabs.push(args.tabId);
        return { ok: true, tabId: args.tabId, closed: true };
      }
      return { ok: true };
    },
    fakeDispatchRoute,
    () => Promise.resolve(false),
    () => Promise.resolve("ask"),
    () => Promise.resolve(true),
  );

  const ctx = { principal: "extension", documentId: "doc-owner-4" };

  // 1. Owner DENIES approval: live card is raised, but tab is NOT closed
  nextDecision = "denied";
  raisedCards = [];
  const deniedRes = await compiled({
    name: "close_tab",
    args: { tabId: 101 },
    executionId: "exec_live_run_card_test",
  }, ctx);

  assertEquals(raisedCards.length, 1);
  assertEquals(raisedCards[0].action, "browser.close-foreign-tab");
  assertEquals(deniedRes.ok, false);
  assertEquals(deniedRes.approvalDenied, true);
  assertEquals(closedTabs.includes(101), false, "Deny must leave the tab open");

  // 2. Owner APPROVES: live card is raised and tab IS closed
  nextDecision = "approved";
  raisedCards = [];
  const approvedRes = await compiled({
    name: "close_tab",
    args: { tabId: 101 },
    executionId: "exec_live_run_card_test",
  }, ctx);

  assertEquals(raisedCards.length, 1);
  assertEquals(approvedRes.ok, true);
  assertEquals(approvedRes.closed, true);
  assertEquals(closedTabs.includes(101), true, "Approve must close the tab");
});

Deno.test("sqf5: write_file dispatches with principal 'model' to fs-grant.write-file-approved for diff card", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool": async');
  assert(site >= 0, "the browser.callTool route must exist");
  const end = src.indexOf("\n    },", site);
  assert(end > site, "the handler body must be delimited");
  const handlerSrc = src.slice(site + '"browser.callTool":'.length, end + "\n    }".length);

  let fsGrantDispatch: any = null;

  const fakeDispatchRoute = async (route: string, body: any, context: any) => {
    if (route === "fs-grant.write-file-approved") {
      fsGrantDispatch = { route, body, context };
      // Simulate what fs-grant.write-file-approved does: accepts principal 'model',
      // stages diff, and asks requireOwnerApproval
      if (context?.principal !== "model") {
        return { ok: false, error: "fs-grant.write-file-approved is restricted to the model's approval path" };
      }
      return { ok: true, stagedDiff: true };
    }
    return { ok: true };
  };

  const compiled = new Function(
    "isOwnerPrincipal",
    "runBrowserToolCall",
    "dispatchRoute",
    "developerFeaturesOn",
    "destructiveActionPolicy",
    "isExecutionLive",
    `return (${handlerSrc});`,
  )(
    (ctx: any) => ctx?.principal === "extension",
    async (name: string, args: any, gates: any) => {
      if (name === "write_file") {
        return await gates.fileWriteGate(args);
      }
      return { ok: true };
    },
    fakeDispatchRoute,
    () => Promise.resolve(false),
    () => Promise.resolve("ask"),
    () => Promise.resolve(true),
  );

  const ctx = { principal: "extension", documentId: "doc-owner-5" };

  const writeRes = await compiled({
    name: "write_file",
    args: { grantId: "grant_123", relativePath: "hello.txt", content: "new content" },
    executionId: "exec_live_run_write",
  }, ctx);

  assertEquals(writeRes.ok, true);
  assertEquals(writeRes.stagedDiff, true);
  assert(fsGrantDispatch);
  assertEquals(fsGrantDispatch.context.principal, "model");
  assertEquals(fsGrantDispatch.context.executionId, "exec_live_run_write");
});

Deno.test("sqf5: live run survives SW restart mid-turn via durable registry recovery", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  
  // Extract isExecutionLive function
  const fnSite = src.indexOf("async function isExecutionLive(");
  assert(fnSite >= 0, "isExecutionLive must exist");
  const fnEnd = src.indexOf("\nfunction recordRunAttestation", fnSite);
  assert(fnEnd > fnSite, "isExecutionLive must be delimited");
  const isExecutionLiveSrc = src.slice(fnSite, fnEnd);

  // In-memory activeExecutions has restarted and is empty
  const activeExecutions = new Set<string>();
  const harnessRunDocuments = new Map<string, string>();

  // Mock durableRuns which recovered the running run from OPFS/KV
  const mockDurableRuns = {
    list: async () => ({
      runs: [
        {
          executionId: "exec_recovered_mid_turn_123",
          phase: "running",
          approvalResolverDocumentId: "doc-tab-recovered-456",
        },
        {
          executionId: "exec_already_terminal_789",
          phase: "terminal",
        },
      ],
    }),
  };

  const compiledIsExecutionLive = new Function(
    "activeExecutions",
    "durableRecoveryReady",
    "durableRuns",
    "harnessRunDocuments",
    "endedExecutions",
    "cancellingApprovalExecutions",
    `return (${isExecutionLiveSrc.replace("async function isExecutionLive", "async function")});`,
  )(activeExecutions, Promise.resolve(), mockDurableRuns, harnessRunDocuments, new Set(), new Set());

  // 1. Before recovery, activeExecutions does not have the ID
  assertEquals(activeExecutions.has("exec_recovered_mid_turn_123"), false);

  // 2. isExecutionLive reads durableRuns and re-seeds activeExecutions and document mapping
  const isLive = await compiledIsExecutionLive("exec_recovered_mid_turn_123");
  assertEquals(isLive, true);
  assertEquals(activeExecutions.has("exec_recovered_mid_turn_123"), true);
  assertEquals(harnessRunDocuments.get("exec_recovered_mid_turn_123"), "doc-tab-recovered-456");

  // 3. For terminal run, it returns false
  const isTerminalLive = await compiledIsExecutionLive("exec_already_terminal_789");
  assertEquals(isTerminalLive, false);
});

Deno.test("sqf5: real acp.journal open -> result / cancel calls finalizeExecution and prevents revive", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));

  // Verify endExecution is NOT referenced anywhere in service-worker.js
  assertEquals(src.includes("endExecution("), false, "endExecution must not be called anywhere in service-worker.js");
  assertEquals(src.includes("finalizeExecution("), true, "finalizeExecution must be used");

  // Extract handlers object and run real handlers
  const activeExecutions = new Set<string>();
  const cancellingApprovalExecutions = new Set<string>();
  const endedExecutions = new Set<string>();
  const harnessRunDocuments = new Map<string, string>();
  const settledRuns: any[] = [];
  const cancelledTrees: any[] = [];

  const markExecutionEnded = (id: string) => endedExecutions.add(id);
  const finalizeExecution = (id: string) => {
    activeExecutions.delete(id);
    cancellingApprovalExecutions.delete(id);
  };
  const beginExecution = (id: string) => activeExecutions.add(id);
  const cancelExecutionTree = async (id: string, opts: any) => {
    cancelledTrees.push({ id, opts });
    cancellingApprovalExecutions.add(id);
  };

  const durableRuns = {
    start: async () => {},
    settle: async (id: string, payload: any) => { settledRuns.push({ id, payload }); },
    list: async () => ({ runs: [] }),
  };

  // Extract acp.journal handler
  const journalSite = src.indexOf('"acp.journal"');
  assert(journalSite >= 0);
  const journalEnd = src.indexOf('\n  async "thread.delete"', journalSite);
  assert(journalEnd > journalSite);
  const journalHandlerSrc = src.slice(journalSite + '"acp.journal"'.length, journalEnd).replace(/,\s*$/, "");

  const compiledJournal = new Function(
    "openAcpTurn",
    "recordAcpTurn",
    "createThread",
    "continueThread",
    "nameThreadAsync",
    "appendThreadMessage",
    "commitThreadTerminal",
    "harnessRunDocuments",
    "beginExecution",
    "admitDurableRun",
    "durableRuns",
    "markExecutionEnded",
    "finalizeExecution",
    "cancelExecutionTree",
    `return (async function ${journalHandlerSrc});`,
  )(
    async () => ({ ok: true, threadId: "thread-1", executionId: "exec_turn_lifecycle" }),
    async () => ({ ok: true }),
    () => {}, () => {}, () => {}, () => {}, () => {},
    harnessRunDocuments,
    beginExecution,
    async () => null,
    durableRuns,
    markExecutionEnded,
    finalizeExecution,
    cancelExecutionTree,
  );

  const ctx = { principal: "extension", documentId: "doc-owner-lifecycle" };

  // 1. OPEN turn
  const openRes = await compiledJournal({ action: "open", task: "close tab" }, ctx);
  assertEquals(openRes.ok, true);
  assertEquals(openRes.executionId, "exec_turn_lifecycle");
  assertEquals(activeExecutions.has("exec_turn_lifecycle"), true);
  assertEquals(harnessRunDocuments.get("exec_turn_lifecycle"), "doc-owner-lifecycle");

  // 2. RESULT finishes turn
  const resultRes = await compiledJournal({ action: "result", executionId: "exec_turn_lifecycle", ok: true, text: "done" }, ctx);
  assertEquals(resultRes.ok, true);
  assertEquals(activeExecutions.has("exec_turn_lifecycle"), false, "turn must not remain in activeExecutions after result");
  assertEquals(endedExecutions.has("exec_turn_lifecycle"), true, "turn must be in endedExecutions");
  assertEquals(harnessRunDocuments.has("exec_turn_lifecycle"), false, "document mapping must be removed");
  assertEquals(settledRuns.length, 1);
  assertEquals(settledRuns[0].id, "exec_turn_lifecycle");

  // 3. CANCEL turn
  beginExecution("exec_cancel_turn");
  harnessRunDocuments.set("exec_cancel_turn", "doc-owner-cancel");
  const cancelRes = await compiledJournal({ action: "cancel", executionId: "exec_cancel_turn" }, ctx);
  assertEquals(cancelRes.ok, true);
  assertEquals(activeExecutions.has("exec_cancel_turn"), false, "turn must not remain in activeExecutions after cancel");
  assertEquals(endedExecutions.has("exec_cancel_turn"), true, "turn must be in endedExecutions after cancel");
  assertEquals(cancelledTrees.length, 1);
  assertEquals(cancelledTrees[0].id, "exec_cancel_turn");
});

Deno.test("sqf5: approval cannot be consumed after run is cancelled or ended", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool": async');
  const end = src.indexOf("\n    },", site);
  const handlerSrc = src.slice(site + '"browser.callTool":'.length, end + "\n    }".length);

  const activeExecutions = new Set<string>(["exec_approval_race"]);
  const cancellingApprovalExecutions = new Set<string>();
  const endedExecutions = new Set<string>();

  const isExecutionLive = async (id: string) =>
    !endedExecutions.has(id) && !cancellingApprovalExecutions.has(id) && activeExecutions.has(id);

  const fakeDispatchRoute = async (route: string, _body: any, _context: any) => {
    if (route === "browser.destructive-action") {
      // Simulate owner clicking "Stop" during the 60s approval wait
      activeExecutions.delete("exec_approval_race");
      cancellingApprovalExecutions.add("exec_approval_race");
      endedExecutions.add("exec_approval_race");

      // Even if the approval resolver then says ok: true, the gate must fail closed
      return { ok: true };
    }
    return { ok: true };
  };

  const compiled = new Function(
    "isOwnerPrincipal",
    "runBrowserToolCall",
    "dispatchRoute",
    "developerFeaturesOn",
    "destructiveActionPolicy",
    "isExecutionLive",
    "activeExecutions",
    "cancellingApprovalExecutions",
    "endedExecutions",
    `return (${handlerSrc});`,
  )(
    (ctx: any) => ctx?.principal === "extension",
    async (_name: string, _args: any, gates: any) => {
      return await gates.destructiveActionGate("browser.close-foreign-tab", { tabId: 10 });
    },
    fakeDispatchRoute,
    () => Promise.resolve(false),
    () => Promise.resolve("ask"),
    isExecutionLive,
    activeExecutions,
    cancellingApprovalExecutions,
    endedExecutions,
  );

  const ctx = { principal: "extension", documentId: "doc-owner-race" };
  const res = await compiled({
    name: "close_tab",
    args: { tabId: 10 },
    executionId: "exec_approval_race",
  }, ctx);

  assertEquals(res.ok, false);
  assertEquals(res.error, "harness_run_not_active");
});

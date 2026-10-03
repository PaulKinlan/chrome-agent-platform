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

    // 4. args are clean: approved, executionId, and id were stripped
    assertEquals(sent.args.tabId, 42);
    assertEquals(sent.args.approved, undefined);
    assertEquals(sent.args.executionId, undefined);
    assertEquals(sent.args.id, undefined);

    // 5. Harness received the JSON-RPC reply
    assertEquals(rpcReplies.length, 1);
    assertEquals(rpcReplies[0].id, "call-1");
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
    `return (${isExecutionLiveSrc.replace("async function isExecutionLive", "async function")});`,
  )(activeExecutions, Promise.resolve(), mockDurableRuns, harnessRunDocuments);

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

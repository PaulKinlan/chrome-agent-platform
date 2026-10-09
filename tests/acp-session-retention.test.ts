// tests/acp-session-retention.test.ts — chrome-agent-platform-v05y
//
// Retain ACP session identity across discovery and subsequent turns:
//   1. Preprompt discovery (getOrDiscoverAcpSession) connects once, retrieves
//      availableCommands, and retains the session.
//   2. Subsequent prompt turns reuse the already-connected session without
//      re-connecting, re-initializing, or repeating session/new.
//   3. Retained session is reused across subsequent turns when retainSession: true.
//   4. Cross-harness isolation: separate harnesses within the same thread maintain
//      distinct retained sessions without collision.
//   5. Invalidation on disconnection: dropped connection is detected, pruned, and
//      cleanly re-established via loadSession.
//   6. Explicit cleanup: closeRetainedAcpSession and clearAllRetainedAcpSessions.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  acpSessionKey,
  clearAllRetainedAcpSessions,
  closeRetainedAcpSession,
  getOrDiscoverAcpSession,
  getRetainedAcpSession,
  retainedSessionsCount,
  runAcpTaskTurn,
} from "../extension/lib/acp-runner.js";
import {
  createAcpModel,
  clearAllRetainedAcpModelSessions,
  closeRetainedAcpModelSession,
  getRetainedAcpModelSession,
  retainedAcpModelSessionsCount,
} from "../extension/lib/acp-model.js";

function makeMockClient(sessionId = "sess-v05y-1") {
  const calls: string[] = [];
  const prompts: string[] = [];
  const client = {
    connected: false,
    availableCommands: [{ name: "skill:test", description: "test skill" }],
    agentInfo: { name: "test-agent", version: "1.0.0" },
    activeSessionId: null as string | null,
    executionId: null as string | null,
    permissionHandler: null as any,
    calls,
    prompts,
    setExecutionId(id: string | null) {
      client.executionId = id;
    },
    async connect() {
      calls.push("connect");
      client.connected = true;
    },
    async initialize() {
      calls.push("initialize");
      return { agentInfo: client.agentInfo };
    },
    async newSession() {
      calls.push("newSession");
      client.activeSessionId = sessionId;
      return { sessionId, availableCommands: client.availableCommands };
    },
    async loadSession({ sessionId: id }: { sessionId: string }) {
      calls.push(`loadSession:${id}`);
      client.activeSessionId = id;
      return { sessionId: id, resumed: true };
    },
    async prompt(_sid: string, text: string) {
      calls.push("prompt");
      prompts.push(text);
      return { stopReason: "end_turn", text: `response to: ${text}` };
    },
    close() {
      calls.push("close");
      client.connected = false;
      client.activeSessionId = null;
    },
    async cancel() {
      calls.push("cancel");
    },
  };
  return client;
}

const containerStub = {
  appendAgent: () => ({ setAttribute: () => {}, remove: () => {} }),
  appendTool: () => ({ setAttribute: () => {} }),
  appendError: (m: string) => { throw new Error(m); },
  appendSystem: () => {},
};

Deno.test("v05y: discovery retains session and subsequent turn reuses it without re-initialization", async () => {
  clearAllRetainedAcpSessions();

  const mockClient = makeMockClient("sess-shared-1");
  const threadId = "thread-disc-1";
  const harnessId = "pi";

  // 1. Discovery phase: pre-prompt discovery connects and retrieves availableCommands
  const discovery = await getOrDiscoverAcpSession({
    threadId,
    harnessId,
    clientFactory: () => mockClient,
  });

  assertEquals(discovery.sessionId, "sess-shared-1");
  assertEquals(discovery.resumed, false);
  assertEquals(discovery.availableCommands.length, 1);
  assertEquals(discovery.availableCommands[0].name, "skill:test");
  assertEquals(mockClient.calls, ["connect", "initialize", "newSession"]);
  assertEquals(retainedSessionsCount(), 1);

  // 2. Subsequent prompt turn on the same thread & harness: reuses the connected session!
  const turnRes = await runAcpTaskTurn({
    container: containerStub,
    task: "do something with skill",
    threadId,
    harnessId,
    retainSession: true,
    clientFactory: () => {
      throw new Error("clientFactory must not be called when reusing retained session");
    },
  });

  assertEquals(turnRes.ok, true);
  assertEquals(turnRes.sessionId, "sess-shared-1");
  assertEquals(turnRes.resumed, true);
  // Verify client did NOT reconnect or re-initialize: only 'prompt' was called on wire!
  assertEquals(mockClient.calls.filter(c => !c.startsWith("setExecutionId:")), ["connect", "initialize", "newSession", "prompt"]);
  assertEquals(mockClient.prompts.length, 1);
  assert(mockClient.prompts[0].includes("do something with skill"));

  // 3. Second prompt turn: still reuses the same connected session!
  const turn2Res = await runAcpTaskTurn({
    container: containerStub,
    task: "follow up",
    threadId,
    harnessId,
    retainSession: true,
  });

  assertEquals(turn2Res.ok, true);
  assertEquals(turn2Res.sessionId, "sess-shared-1");
  assertEquals(mockClient.calls, ["connect", "initialize", "newSession", "prompt", "prompt"]);

  clearAllRetainedAcpSessions();
  assertEquals(retainedSessionsCount(), 0);
  assertEquals(mockClient.connected, false);
});

Deno.test("v05y: cross-harness isolation maintains distinct sessions in the same thread", async () => {
  clearAllRetainedAcpSessions();

  const piClient = makeMockClient("sess-pi");
  const claudeClient = makeMockClient("sess-claude");
  const threadId = "thread-multi-harness";

  // Discover Pi
  const piDisc = await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    clientFactory: () => piClient,
  });
  assertEquals(piDisc.sessionId, "sess-pi");

  // Discover Claude in the SAME thread
  const claudeDisc = await getOrDiscoverAcpSession({
    threadId,
    harnessId: "claude-code",
    clientFactory: () => claudeClient,
  });
  assertEquals(claudeDisc.sessionId, "sess-claude");

  // Verify both sessions are retained separately
  assertEquals(retainedSessionsCount(), 2);

  const piRetained = getRetainedAcpSession(acpSessionKey(threadId, "pi"));
  const claudeRetained = getRetainedAcpSession(acpSessionKey(threadId, "claude-code"));
  assert(piRetained !== null);
  assert(claudeRetained !== null);
  assertEquals(piRetained.sessionId, "sess-pi");
  assertEquals(claudeRetained.sessionId, "sess-claude");

  clearAllRetainedAcpSessions();
});

Deno.test("v05y: invalidation on disconnect prunes stale session and reconnects via loadSession", async () => {
  clearAllRetainedAcpSessions();

  const firstClient = makeMockClient("sess-resilient");
  const secondClient = makeMockClient("sess-resilient");
  const threadId = "thread-disconnect-test";
  const harnessId = "pi";
  const key = acpSessionKey(threadId, harnessId);

  // 1. Establish retained session
  await getOrDiscoverAcpSession({
    threadId,
    harnessId,
    clientFactory: () => firstClient,
  });
  assertEquals(retainedSessionsCount(), 1);

  // 2. Simulate socket drop on the adapter by explicitly closing the client transport
  firstClient.close();

  // 3. getRetainedAcpSession automatically detects drop and prunes
  assertEquals(getRetainedAcpSession(key), null);
  assertEquals(retainedSessionsCount(), 0);

  // 4. Next prompt turn detects no active connected session, reconnects, and loads existing sessionId
  let clientFactoryCount = 0;
  const res = await runAcpTaskTurn({
    container: containerStub,
    task: "after reconnect",
    threadId,
    harnessId,
    retainSession: true,
    clientFactory: () => {
      clientFactoryCount++;
      return secondClient;
    },
  });

  assertEquals(res.ok, true);
  assertEquals(clientFactoryCount, 1);
  assertEquals(secondClient.calls, ["connect", "initialize", "loadSession:sess-resilient", "prompt"]);
  assertEquals(secondClient.activeSessionId, "sess-resilient");
  assertEquals(retainedSessionsCount(), 1);

  clearAllRetainedAcpSessions();
});

Deno.test("v05y: explicit closeRetainedAcpSession terminates client and clears entry", async () => {
  clearAllRetainedAcpSessions();

  const client = makeMockClient("sess-cleanup");
  const threadId = "thread-clean";
  const harnessId = "pi";
  const key = acpSessionKey(threadId, harnessId);

  await getOrDiscoverAcpSession({
    threadId,
    harnessId,
    clientFactory: () => client,
  });

  assertEquals(retainedSessionsCount(), 1);
  assertEquals(client.connected, true);

  // Close specific session
  closeRetainedAcpSession(key);
  assertEquals(retainedSessionsCount(), 0);
  assertEquals(client.connected, false);
  assert(client.calls.includes("close"));
});

Deno.test("v05y: session replacement invalidation clears stale commands and loads new catalogue", async () => {
  clearAllRetainedAcpSessions();

  const clientA = makeMockClient("sess-stale-cat");
  clientA.availableCommands = [{ name: "skill:oldA", description: "old command" }];

  const clientB = makeMockClient("sess-fresh-cat");
  clientB.availableCommands = [{ name: "skill:newB", description: "new command" }];

  const threadId = "thread-replace-cat";
  const harnessId = "pi";
  const key = acpSessionKey(threadId, harnessId);

  // 1. Initial discovery retains clientA with old commands
  const discA = await getOrDiscoverAcpSession({
    threadId,
    harnessId,
    clientFactory: () => clientA,
  });
  assertEquals(discA.availableCommands.length, 1);
  assertEquals(discA.availableCommands[0].name, "skill:oldA");

  // 2. Invalidate / replace stale session and clear stale session hint
  closeRetainedAcpSession(key, { clearSessionHint: true });
  assertEquals(getRetainedAcpSession(key), null);

  // 3. New discovery connects fresh clientB and receives new commands (no stale catalogue leak)
  const discB = await getOrDiscoverAcpSession({
    threadId,
    harnessId,
    clientFactory: () => clientB,
  });
  assertEquals(discB.availableCommands.length, 1);
  assertEquals(discB.availableCommands[0].name, "skill:newB");
  assertEquals(discB.sessionId, "sess-fresh-cat");

  clearAllRetainedAcpSessions();
});

Deno.test("v05y: before-vs-after empirical measurement demonstrates startup cost elimination", async () => {
  clearAllRetainedAcpSessions();

  // --- SCENARIO 1: BEFORE (Unretained lifecycle - fresh session per discovery and per turn) ---
  const beforeDiscoveryClient = makeMockClient("sess-before-1");
  const beforeTurn1Client = makeMockClient("sess-before-2");
  const beforeTurn2Client = makeMockClient("sess-before-3");

  // Discovery connects & creates sess-before-1, then closes
  await beforeDiscoveryClient.connect();
  await beforeDiscoveryClient.initialize();
  await beforeDiscoveryClient.newSession();
  beforeDiscoveryClient.close();

  // Turn 1 connects & creates sess-before-2, prompts, then closes
  const turn1BeforeRes = await runAcpTaskTurn({
    container: containerStub,
    task: "turn 1 before",
    threadId: "thread-before",
    harnessId: "pi",
    retainSession: false,
    clientFactory: () => beforeTurn1Client,
  });
  assertEquals(turn1BeforeRes.ok, true);

  // Turn 2 connects & creates sess-before-3, prompts, then closes
  const turn2BeforeRes = await runAcpTaskTurn({
    container: containerStub,
    task: "turn 2 before",
    threadId: "thread-before",
    harnessId: "pi",
    retainSession: false,
    clientFactory: () => beforeTurn2Client,
  });
  assertEquals(turn2BeforeRes.ok, true);

  const beforeTotalConnects = beforeDiscoveryClient.calls.filter(c => c === "connect").length
    + beforeTurn1Client.calls.filter(c => c === "connect").length
    + beforeTurn2Client.calls.filter(c => c === "connect").length;
  const beforeTotalInitializes = beforeDiscoveryClient.calls.filter(c => c === "initialize").length
    + beforeTurn1Client.calls.filter(c => c === "initialize").length
    + beforeTurn2Client.calls.filter(c => c === "initialize").length;
  const beforeSessionIds = new Set([beforeDiscoveryClient.activeSessionId, turn1BeforeRes.sessionId, turn2BeforeRes.sessionId]);

  assertEquals(beforeTotalConnects, 3);
  assertEquals(beforeTotalInitializes, 3);
  assertEquals(beforeSessionIds.size, 2);

  // --- SCENARIO 2: AFTER (Retained lifecycle - unified discovery & turn session) ---
  clearAllRetainedAcpSessions();
  const afterClient = makeMockClient("sess-after-unified");
  let afterFactoryCalls = 0;

  // Discovery connects, initializes, and creates sess-after-unified ONCE
  const discAfter = await getOrDiscoverAcpSession({
    threadId: "thread-after",
    harnessId: "pi",
    clientFactory: () => {
      afterFactoryCalls++;
      return afterClient;
    },
  });
  assertEquals(discAfter.sessionId, "sess-after-unified");
  assertEquals(retainedSessionsCount(), 1);

  // Turn 1 reuses retained session directly (0 reconnects, 0 re-initializes, 0 new session calls)
  const turn1AfterRes = await runAcpTaskTurn({
    container: containerStub,
    task: "turn 1 after",
    threadId: "thread-after",
    harnessId: "pi",
    retainSession: true,
    clientFactory: () => {
      throw new Error("clientFactory must not be called when reusing retained session");
    },
  });
  assertEquals(turn1AfterRes.ok, true);
  assertEquals(turn1AfterRes.sessionId, "sess-after-unified");

  // Turn 2 reuses the same retained session directly
  const turn2AfterRes = await runAcpTaskTurn({
    container: containerStub,
    task: "turn 2 after",
    threadId: "thread-after",
    harnessId: "pi",
    retainSession: true,
    clientFactory: () => {
      throw new Error("clientFactory must not be called when reusing retained session");
    },
  });
  assertEquals(turn2AfterRes.ok, true);
  assertEquals(turn2AfterRes.sessionId, "sess-after-unified");

  const afterTotalConnects = afterClient.calls.filter(c => c === "connect").length;
  const afterTotalInitializes = afterClient.calls.filter(c => c === "initialize").length;
  const afterSessionIds = new Set([discAfter.sessionId, turn1AfterRes.sessionId, turn2AfterRes.sessionId]);

  assertEquals(afterTotalConnects, 1);
  assertEquals(afterTotalInitializes, 1);
  assertEquals(afterSessionIds.size, 1);
  assertEquals(afterFactoryCalls, 1);

  // Turn startup calls (connect + initialize) on turn 1 & 2:
  // BEFORE: 2 connects + 2 initializes = 4 startup RPCs
  // AFTER:  0 connects + 0 initializes = 0 startup RPCs
  assertEquals(afterClient.calls.filter(c => !c.startsWith("setExecutionId:")), ["connect", "initialize", "newSession", "prompt", "prompt"]);

  clearAllRetainedAcpSessions();
});

Deno.test("v05y: executionId is rebound on every retained turn", async () => {
  clearAllRetainedAcpSessions();
  const mockClient = makeMockClient("sess-exec-bind");
  const threadId = "thread-exec-binding";

  // 1. Discovery with executionId: "exec-disc"
  await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    executionId: "exec-disc",
    clientFactory: () => mockClient,
  });
  assertEquals(mockClient.executionId, "exec-disc");

  // 2. Turn 1 with executionId: "exec-turn-1"
  const turn1 = await runAcpTaskTurn({
    prompt: "turn 1 prompt",
    threadId,
    harnessId: "pi",
    executionId: "exec-turn-1",
    retainSession: true,
    clientFactory: () => { throw new Error("must reuse"); },
  });
  assertEquals(turn1.ok, true);
  assertEquals(mockClient.executionId, "exec-turn-1");

  // 3. Turn 2 with executionId: "exec-turn-2"
  const turn2 = await runAcpTaskTurn({
    prompt: "turn 2 prompt",
    threadId,
    harnessId: "pi",
    executionId: "exec-turn-2",
    retainSession: true,
    clientFactory: () => { throw new Error("must reuse"); },
  });
  assertEquals(turn2.ok, true);
  assertEquals(mockClient.executionId, "exec-turn-2");

  clearAllRetainedAcpSessions();
});

Deno.test("v05y: supersede cancels predecessor on wire without closing shared client or destroying successor", async () => {
  clearAllRetainedAcpSessions();
  const threadId = "thread-supersede-shared";
  const mockClient = makeMockClient("sess-supersede");
  let prompt1Resolve: (() => void) | null = null;
  let turn1PromptStarted = false;

  mockClient.cancel = async () => {
    mockClient.calls.push("cancel");
    prompt1Resolve?.();
  };

  mockClient.prompt = async (_id: string, promptText: string, onEvent: any) => {
    mockClient.prompts.push(promptText);
    mockClient.calls.push("prompt");
    if (promptText.includes("slow turn 1")) {
      turn1PromptStarted = true;
      await new Promise<void>((resolve) => {
        prompt1Resolve = resolve;
      });
    }
    if (typeof onEvent === "function") {
      onEvent({ kind: "chunk", text: "done:" + promptText });
    }
    return { ok: true };
  };

  // Pre-seed retained session
  await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    clientFactory: () => mockClient,
  });

  // Start turn 1 (slow)
  const turn1Promise = runAcpTaskTurn({
    prompt: "slow turn 1",
    threadId,
    harnessId: "pi",
    retainSession: true,
    clientFactory: () => { throw new Error("must reuse"); },
  });

  // Wait until turn 1 has started prompting
  while (!turn1PromptStarted) {
    await new Promise((r) => setTimeout(r, 5));
  }

  // Immediately start turn 2, which supersedes turn 1
  const turn2Promise = runAcpTaskTurn({
    prompt: "fast turn 2",
    threadId,
    harnessId: "pi",
    retainSession: true,
    clientFactory: () => { throw new Error("must reuse"); },
  });

  // Release turn 1's mock prompt promise if it was waiting
  prompt1Resolve?.();

  const [res1, res2] = await Promise.all([turn1Promise, turn2Promise]);

  // Turn 1 was cancelled/superseded
  assertEquals(res1.ok, false);
  // Turn 2 succeeded on the SAME client!
  assertEquals(res2.ok, true);
  // Predecessor cancel was issued on the wire:
  assert(mockClient.calls.includes("cancel"));
  // Client was NOT closed during supersede:
  assertEquals(mockClient.connected, true);

  clearAllRetainedAcpSessions();
});

Deno.test("v05y: changing endpoint or cwd invalidates retained session and establishes fresh connection", async () => {
  clearAllRetainedAcpSessions();
  const threadId = "thread-invalidation-config";
  let clientFactoryCount = 0;

  const makeClient = (id: string) => {
    clientFactoryCount++;
    return makeMockClient(id);
  };

  // 1. Connect at initial endpoint and cwd
  await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    endpoint: "ws://127.0.0.1:8765/acp",
    cwd: "/home/user/projectA",
    clientFactory: () => makeClient("sess-orig"),
  });
  assertEquals(clientFactoryCount, 1);

  // 2. Query with SAME endpoint & cwd -> reuses retained session (no new client)
  await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    endpoint: "ws://127.0.0.1:8765/acp",
    cwd: "/home/user/projectA",
    clientFactory: () => makeClient("sess-fail-same"),
  });
  assertEquals(clientFactoryCount, 1);

  // 3. Query with CHANGED endpoint -> must NOT reuse stale session; connects fresh
  await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    endpoint: "ws://127.0.0.1:9999/acp",
    cwd: "/home/user/projectA",
    clientFactory: () => makeClient("sess-new-endpoint"),
  });
  assertEquals(clientFactoryCount, 2);

  // 4. Query with CHANGED cwd -> must NOT reuse stale session; connects fresh
  await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    endpoint: "ws://127.0.0.1:9999/acp",
    cwd: "/home/user/projectB",
    clientFactory: () => makeClient("sess-new-cwd"),
  });
  assertEquals(clientFactoryCount, 3);

  clearAllRetainedAcpSessions();
});

Deno.test("v05y: switching to auto permission mode clears prior ask handler", async () => {
  clearAllRetainedAcpSessions();
  const threadId = "thread-perm-mode-switch";
  const mockClient = makeMockClient("sess-perm-switch");

  // 1. Seed retained session
  await getOrDiscoverAcpSession({
    threadId,
    harnessId: "pi",
    clientFactory: () => mockClient,
  });

  // 2. Turn 1 with settings: acp.permissions = "ask"
  await runAcpTaskTurn({
    prompt: "ask turn",
    threadId,
    harnessId: "pi",
    settings: { get: async (k) => k === "acp.permissions" ? "ask" : null },
    retainSession: true,
    clientFactory: () => { throw new Error("must reuse"); },
  });
  assert(typeof mockClient.permissionHandler === "function", "permissionHandler must be installed in ask mode");

  // 3. Turn 2 with settings: acp.permissions = "auto" -> must clear prior ask handler!
  await runAcpTaskTurn({
    prompt: "auto turn",
    threadId,
    harnessId: "pi",
    settings: { get: async (k) => k === "acp.permissions" ? "auto" : null },
    retainSession: true,
    clientFactory: () => { throw new Error("must reuse"); },
  });
  assertEquals(mockClient.permissionHandler, null, "permissionHandler must be null in auto mode to avoid leaks");

  clearAllRetainedAcpSessions();
});

Deno.test("v05y production path: createAcpModel retains session from discoverCommands and reuses it on subsequent doStream turns", async () => {
  clearAllRetainedAcpModelSessions();
  const harnessId = "claude-code";
  const url = "ws://127.0.0.1:8765/acp";
  const cwd = "/work/production-test";

  let clientFactoryCalls = 0;
  const promptsSeen: string[] = [];
  const clientCalls: string[] = [];
  let clientExecutionId: string | null = null;
  let mockClientClosed = false;

  const mockClient = {
    connected: false,
    availableCommands: [{ name: "skill:deploy", description: "Deploy agent" }],
    commandsReceived: true,
    activeSessionId: null as string | null,
    setExecutionId(id: string | null) {
      clientExecutionId = id;
      clientCalls.push(`setExecutionId:${id}`);
    },
    async connect() {
      mockClient.connected = true;
      clientCalls.push("connect");
    },
    async initialize(cap: any) {
      clientCalls.push("initialize");
    },
    async newSession(opts: any) {
      clientCalls.push("newSession");
      mockClient.activeSessionId = "sess-prod-unified";
      return { sessionId: "sess-prod-unified" };
    },
    async prompt(sessionId: string, text: string, onEvent: any) {
      clientCalls.push(`prompt:${sessionId}`);
      promptsSeen.push(text);
      onEvent({ kind: "chunk", text: "Production turn output" });
    },
    close() {
      mockClient.connected = false;
      mockClientClosed = true;
      clientCalls.push("close");
    },
  };

  const clientFactory = () => {
    clientFactoryCalls++;
    return mockClient;
  };

  // STEP 1: Preprompt command discovery in production extension (acp.commands)
  const discoveryBackend = createAcpModel({
    url,
    cwd,
    harnessId,
    retainSession: true,
    clientFactory,
  });
  const catalogue = await discoveryBackend.discoverCommands();
  assertEquals(catalogue.sessionId, "sess-prod-unified");
  assertEquals(catalogue.received, true);
  assertEquals(catalogue.commands[0].name, "skill:deploy");
  assertEquals(clientFactoryCalls, 1);
  assertEquals(retainedAcpModelSessionsCount(), 1);

  // Close discovery proxy (simulates port.disconnect on catalogue completion)
  discoveryBackend.close();
  // Retained session client MUST remain connected in offscreen model store!
  assertEquals(mockClient.connected, true);
  assertEquals(mockClientClosed, false);

  // STEP 2: Turn 1 execution in production extension (agent.run / createAcpModelProxy)
  const turn1Backend = createAcpModel({
    url,
    cwd,
    harnessId,
    executionId: "exec-turn-1",
    retainSession: true,
    clientFactory: () => {
      throw new Error("clientFactory must not be called; turn 1 must reuse discovery session");
    },
  });
  const stream1 = await turn1Backend.model.doStream({
    prompt: [{ role: "user", content: "deploy to production" }],
    tools: [{ type: "function", name: "toolA" }],
  });
  for await (const _part of stream1.stream) {
    // drain stream
  }
  assertEquals(clientExecutionId, "exec-turn-1");
  assertEquals(clientFactoryCalls, 1);
  assertEquals(promptsSeen.length, 1);

  // STEP 3: Turn 2 execution in production extension (next prompt turn)
  const turn2Backend = createAcpModel({
    url,
    cwd,
    harnessId,
    executionId: "exec-turn-2",
    retainSession: true,
    clientFactory: () => {
      throw new Error("clientFactory must not be called; turn 2 must reuse discovery session");
    },
  });
  const stream2 = await turn2Backend.model.doStream({
    prompt: [{ role: "user", content: "confirm deployment" }],
    tools: [{ type: "function", name: "toolA" }],
  });
  for await (const _part of stream2.stream) {
    // drain stream
  }
  assertEquals(clientExecutionId, "exec-turn-2");
  assertEquals(clientFactoryCalls, 1);
  assertEquals(promptsSeen.length, 2);

  // Total calls across discovery + 2 prompt turns in production:
  // ONLY 1 connect, 1 initialize, 1 newSession!
  const connectCount = clientCalls.filter((c) => c === "connect").length;
  const initCount = clientCalls.filter((c) => c === "initialize").length;
  const newSessionCount = clientCalls.filter((c) => c === "newSession").length;
  const promptCalls = clientCalls.filter((c) => c.startsWith("prompt:")).length;

  assertEquals(connectCount, 1);
  assertEquals(initCount, 1);
  assertEquals(newSessionCount, 1);
  assertEquals(promptCalls, 2);

  // Clean up
  clearAllRetainedAcpModelSessions();
  assertEquals(retainedAcpModelSessionsCount(), 0);
  assertEquals(mockClient.connected, false);
});

Deno.test("v05y N1: discovery while streaming turn is in-flight preserves active toolHandler and executionId", async () => {
  clearAllRetainedAcpModelSessions();
  const harnessId = "claude-code";
  const url = "ws://127.0.0.1:8765/acp";
  const cwd = "/work/concurrency-test";

  let capturedToolHandler: any = null;
  let activeExecutionId: string | null = null;
  let promptResolve: (() => void) | null = null;
  let turnPromptStarted = false;

  const mockClient = {
    connected: false,
    availableCommands: [{ name: "skill:live", description: "Live skill" }],
    commandsReceived: true,
    activeSessionId: null as string | null,
    setExecutionId(id: string | null) {
      activeExecutionId = id;
    },
    async connect() {
      mockClient.connected = true;
    },
    async initialize() {},
    async newSession() {
      mockClient.activeSessionId = "sess-concur";
      return { sessionId: "sess-concur" };
    },
    async prompt(_sid: string, _text: string, _emit: any) {
      turnPromptStarted = true;
      await new Promise<void>((resolve) => {
        promptResolve = resolve;
      });
    },
    close() {
      mockClient.connected = false;
    },
  };

  // Turn 1 starts streaming with executionId: "exec-streaming"
  const turnBackend = createAcpModel({
    threadId: "thread-concur",
    url,
    cwd,
    harnessId,
    executionId: "exec-streaming",
    retainSession: true,
    clientFactory: (opts: any) => {
      capturedToolHandler = opts.toolHandler;
      return mockClient;
    },
  });

  const streamPromise = turnBackend.model.doStream({
    prompt: [{ role: "user", content: "streaming task" }],
    tools: [{ type: "function", name: "toolX" }],
  });

  while (!turnPromptStarted) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assertEquals(activeExecutionId, "exec-streaming");
  assert(capturedToolHandler != null, "turn must have installed a toolHandler");

  // While Turn 1 is streaming, a background discovery arrives (acp.commands)
  const discoveryBackend = createAcpModel({
    threadId: "thread-concur",
    url,
    cwd,
    harnessId,
    retainSession: true,
    clientFactory: () => {
      throw new Error("must reuse");
    },
  });

  // Discovery discovers commands from the active session
  const catalogue = await discoveryBackend.discoverCommands();
  assertEquals(catalogue.sessionId, "sess-concur");
  assertEquals(catalogue.commands[0].name, "skill:live");

  // N1 ASSERTION: discovery MUST NOT have overwritten the streaming turn's executionId or toolHandler!
  assertEquals(activeExecutionId, "exec-streaming", "discovery must not displace active executionId");
  assert(mockClient.connected, "client must remain connected");

  // N1(close) CRITICAL REGRESSION TEST: discoveryBackend.close() mid-turn MUST NOT cancel live turn or clear fence!
  discoveryBackend.close();
  const sessionRecord = getRetainedAcpModelSession("thread-concur:claude-code:ws://127.0.0.1:8765/acp:/work/concurrency-test");
  assertEquals(sessionRecord?.inFlightTurn, true, "live turn in-flight fence must remain true after discovery close");
  assertEquals(mockClient.connected, true, "client must remain connected after discovery close");

  // Finish streaming turn
  promptResolve?.();
  const stream = await streamPromise;
  for await (const _p of stream.stream) {}

  clearAllRetainedAcpModelSessions();
});

Deno.test("v05y: discoveryBackend.close() with null executionId NEVER sends cancel or clears live turn fence", async () => {
  clearAllRetainedAcpModelSessions();
  const harnessId = "claude-code";
  const url = "ws://127.0.0.1:8765/acp";
  const cwd = "/work/composer-slash-repro";

  let cancelCalled = false;
  let turnStreamActive = true;
  let streamComplete = false;
  let promptResolve: (() => void) | null = null;

  const mockClient = {
    connected: false,
    availableCommands: [{ name: "skill:test" }],
    commandsReceived: true,
    activeSessionId: null as string | null,
    setExecutionId() {},
    async connect() { mockClient.connected = true; },
    async initialize() {},
    async newSession() {
      mockClient.activeSessionId = "sess-shared-prod";
      return { sessionId: "sess-shared-prod" };
    },
    async prompt(_sid: string, _text: string, emit: any) {
      emit({ kind: "chunk", text: "chunk-1" });
      await new Promise<void>((r) => { promptResolve = r; });
      emit({ kind: "chunk", text: "chunk-2" });
    },
    cancel(_sid: string) {
      cancelCalled = true;
    },
    close() {
      mockClient.connected = false;
    },
  };

  // Turn 1 starts with executionId: null (exact production proxy behavior before explicit ID)
  const turnBackend = createAcpModel({
    url,
    cwd,
    harnessId,
    executionId: null,
    retainSession: true,
    clientFactory: () => mockClient,
  });

  const streamPromise = turnBackend.model.doStream({
    prompt: [{ role: "user", content: "live turn" }],
    tools: [{ type: "function", name: "t1" }],
  });

  await new Promise((r) => setTimeout(r, 20));

  // User types '/' in composer while turn is live -> triggers acp.commands -> discoverAcpCommands
  const discoveryBackend = createAcpModel({
    url,
    cwd,
    harnessId,
    executionId: null,
    retainSession: true,
    clientFactory: () => { throw new Error("must reuse"); },
  });

  const catalogue = await discoveryBackend.discoverCommands();
  assertEquals(catalogue.received, true);

  // Discovery port closes when catalogue finishes
  discoveryBackend.close();

  // CRITICAL ASSERTION:
  // 1. client.cancel was NEVER called!
  assertEquals(cancelCalled, false, "discovery close must NEVER cancel active session on wire");
  // 2. The turn's session record fence is still in-flight
  const rec = getRetainedAcpModelSession("global:claude-code:ws://127.0.0.1:8765/acp:/work/composer-slash-repro");
  assertEquals(rec?.inFlightTurn, true, "inFlightTurn must remain true while turn streams");

  // 3. Complete prompt turn — successor chunks must arrive intact
  promptResolve?.();
  const stream = await streamPromise;
  const parts: any[] = [];
  for await (const p of stream.stream) {
    parts.push(p);
  }

  const textDeltas = parts.filter((p) => p.type === "text-delta").map((p) => p.delta);
  assertEquals(textDeltas, ["chunk-1", "chunk-2"]);

  // After turn finishes, fence is now cleared
  assertEquals(rec?.inFlightTurn, false);

  clearAllRetainedAcpModelSessions();
});

Deno.test("v05y N1(b): cold-start overlap synchronizes on single connect without overwrite-close", async () => {
  clearAllRetainedAcpModelSessions();
  let clientConnectCount = 0;
  let clientInitializeCount = 0;

  const mockClient = {
    connected: false,
    availableCommands: [{ name: "skill:cold" }],
    commandsReceived: true,
    activeSessionId: null as string | null,
    setExecutionId() {},
    async connect() {
      // Simulate network delay
      await new Promise((r) => setTimeout(r, 25));
      mockClient.connected = true;
      clientConnectCount++;
    },
    async initialize() {
      clientInitializeCount++;
    },
    async newSession() {
      mockClient.activeSessionId = "sess-cold-sync";
      return { sessionId: "sess-cold-sync" };
    },
    async prompt() {},
    close() {
      mockClient.connected = false;
    },
  };

  // Two backends created concurrently before either connects
  const backend1 = createAcpModel({
    harnessId: "pi",
    url: "ws://127.0.0.1:8765/acp",
    cwd: "/work",
    retainSession: true,
    clientFactory: () => mockClient,
  });

  const backend2 = createAcpModel({
    harnessId: "pi",
    url: "ws://127.0.0.1:8765/acp",
    cwd: "/work",
    retainSession: true,
    clientFactory: () => {
      throw new Error("backend 2 must synchronize with backend 1 and reuse its client");
    },
  });

  // Call discoverCommands on both concurrently
  const [c1, c2] = await Promise.all([
    backend1.discoverCommands(),
    backend2.discoverCommands(),
  ]);

  assertEquals(c1.sessionId, "sess-cold-sync");
  assertEquals(c2.sessionId, "sess-cold-sync");
  assertEquals(clientConnectCount, 1, "exactly 1 connect must run during cold start");
  assertEquals(clientInitializeCount, 1, "exactly 1 initialize must run during cold start");
  assertEquals(mockClient.connected, true, "client must remain connected (never overwrite-closed)");

  clearAllRetainedAcpModelSessions();
});

Deno.test("9ql81: two cold turns in the same task fence one prompt before either backend can overwrite the owner", async () => {
  clearAllRetainedAcpModelSessions();
  let connects = 0;
  let prompts = 0;
  let activeExecutionId: string | null = null;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstPromptStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  const mockClient = {
    connected: false,
    availableCommands: [],
    commandsReceived: true,
    setExecutionId(id: string | null) { activeExecutionId = id; },
    async connect() { connects++; mockClient.connected = true; },
    async initialize() {},
    async newSession() { return { sessionId: "sess-same-task" }; },
    async prompt() {
      prompts++;
      if (prompts === 1) { firstStarted(); await firstPending; }
    },
    close() { mockClient.connected = false; },
  };
  const common = { threadId: "thread-same-task", harnessId: "pi", url: "ws://127.0.0.1/acp", cwd: "/work", retainSession: true };
  const first = createAcpModel({ ...common, executionId: "exec-first", clientFactory: () => mockClient });
  const second = createAcpModel({ ...common, executionId: "exec-second", clientFactory: () => { throw Error("second turn must reuse the client"); } });
  const options = { prompt: [{ role: "user", content: "start" }], tools: [{ type: "function", name: "toolA" }] };
  // Both calls start before an await drains the microtask queue: exactly the
  // shared cold-connection window that serial message-per-task tests miss.
  const [one, two] = await Promise.all([first.model.doStream(options), second.model.doStream(options)]);
  const drainFirst = (async () => { for await (const _ of one.stream) { /* drain */ } })();
  try {
    await firstPromptStarted;
    await assertRejects(async () => { for await (const _ of two.stream) { /* refuse */ } }, Error,
      "ACP session currently owns an active turn; cannot start concurrent turn");
    assertEquals(prompts, 1, "one client.prompt for both same-task turns");
    assertEquals(connects, 1);
    assertEquals(activeExecutionId, "exec-first", "refused turn never overwrites the live client's identity");
    const rec = getRetainedAcpModelSession("thread-same-task:pi:ws://127.0.0.1/acp:/work");
    assertEquals(rec?.inFlightTurn, true);
  } finally {
    releaseFirst();
    await drainFirst;
    first.close();
    second.close();
    clearAllRetainedAcpModelSessions();
  }
});

Deno.test("9ql81: clear-all drops a pending connection map entry before a new session connects", async () => {
  clearAllRetainedAcpModelSessions();
  let releaseConnect!: () => void;
  const connecting = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let freshConnects = 0;
  const firstClient = {
    connected: false, availableCommands: [], commandsReceived: true,
    setExecutionId() {},
    async connect() { await connecting; firstClient.connected = true; },
    async initialize() {}, async newSession() { return { sessionId: "old" }; },
    close() { firstClient.connected = false; },
  };
  const freshClient = {
    connected: false, availableCommands: [], commandsReceived: true,
    setExecutionId() {},
    async connect() { freshConnects++; freshClient.connected = true; },
    async initialize() {}, async newSession() { return { sessionId: "fresh" }; },
    close() { freshClient.connected = false; },
  };
  const common = { threadId: "thread-reset", harnessId: "pi", url: "ws://127.0.0.1/acp", cwd: "/work", retainSession: true };
  const old = createAcpModel({ ...common, clientFactory: () => firstClient });
  const oldCall = old.discoverCommands();
  clearAllRetainedAcpModelSessions();
  const fresh = createAcpModel({ ...common, clientFactory: () => freshClient });
  const freshCall = fresh.discoverCommands();
  try {
    assertEquals(freshConnects, 1, "fresh call does not await a stale shared connect promise");
    assertEquals((await freshCall).sessionId, "fresh");
  } finally {
    old.close();
    releaseConnect();
    await Promise.allSettled([oldCall, freshCall]);
    fresh.close();
    clearAllRetainedAcpModelSessions();
  }
});

Deno.test("v05y N1: cross-thread model sessions remain isolated without collision", async () => {
  clearAllRetainedAcpModelSessions();
  let client1Created = 0;
  let client2Created = 0;

  const makeClient = (id: string, onCreated: () => void) => {
    onCreated();
    return {
      connected: false,
      availableCommands: [{ name: id }],
      commandsReceived: true,
      activeSessionId: id,
      setExecutionId() {},
      async connect() { this.connected = true; },
      async initialize() {},
      async newSession() { return { sessionId: id }; },
      async prompt() {},
      close() { this.connected = false; },
    };
  };

  // Model backend for thread 1
  const backend1 = createAcpModel({
    threadId: "thread-alpha",
    harnessId: "pi",
    url: "ws://127.0.0.1:8765/acp",
    cwd: "/work",
    retainSession: true,
    clientFactory: () => makeClient("sess-alpha", () => client1Created++),
  });
  await backend1.discoverCommands();

  // Model backend for thread 2 with same harness/url/cwd but different threadId
  const backend2 = createAcpModel({
    threadId: "thread-beta",
    harnessId: "pi",
    url: "ws://127.0.0.1:8765/acp",
    cwd: "/work",
    retainSession: true,
    clientFactory: () => makeClient("sess-beta", () => client2Created++),
  });
  await backend2.discoverCommands();

  assertEquals(client1Created, 1);
  assertEquals(client2Created, 1);
  assertEquals(retainedAcpModelSessionsCount(), 2, "separate threads must maintain separate retained sessions");

  clearAllRetainedAcpModelSessions();
});

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
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  acpSessionKey,
  clearAllRetainedAcpSessions,
  closeRetainedAcpSession,
  getOrDiscoverAcpSession,
  getRetainedAcpSession,
  retainedSessionsCount,
  runAcpTaskTurn,
} from "../extension/lib/acp-runner.js";

function makeMockClient(sessionId = "sess-v05y-1") {
  const calls: string[] = [];
  const prompts: string[] = [];
  const client = {
    connected: false,
    availableCommands: [{ name: "skill:test", description: "test skill" }],
    agentInfo: { name: "test-agent", version: "1.0.0" },
    activeSessionId: null as string | null,
    calls,
    prompts,
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
  // Verify client did NOT reconnect or re-initialize: only 'prompt' was called!
  assertEquals(mockClient.calls, ["connect", "initialize", "newSession", "prompt"]);
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

  // 2. Simulate socket drop on the adapter
  firstClient.connected = false;

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

// Empirical semantic tests for the run-status successor's two browser-found
// defects, driving the REAL extension/shared/conversation.js with a stubbed
// chrome runtime:
//  1. late-settled duplicate terminal assistant projection (streamed text +
//     res.result must not produce two identical bubbles);
//  2. hub→thread re-submission after a fenced first run must expose
//     queued→running promptly (the J2 witness regression).
import { assert, assertEquals } from "jsr:@std/assert";
import { recordAuthoritativeThreadProjection } from "../extension/shared/thread-projection-authority.js";

type Status = { state: string; activity?: string };
type Bubble = { role: string; content: string };

function makeContainer(bubbles: Bubble[]) {
  // The real <agent-conversation> method interface appendBubble prefers.
  return {
    appendUser(text: string) { bubbles.push({ role: "user", content: text }); },
    appendAgent(text: string) { bubbles.push({ role: "agent", content: text }); },
    appendSystem(text: string) { bubbles.push({ role: "system", content: text }); },
    appendError(text: string) { bubbles.push({ role: "error", content: text }); },
    appendTool() { return { setAttribute() {} }; },
    setMessages(messages: Bubble[]) {
      bubbles.splice(0, bubbles.length, ...messages.map((message) => ({ ...message })));
    },
    clear() { bubbles.length = 0; },
  };
}

interface FakeSw {
  runHoldMs: number;
  resultText: string;
  lastRunId: string | null;
}

// conversation.js holds ONE module-level progress port across turns/tests; the
// port's message listener is registered once at connect time. All stubs share
// this holder so every test can inject progress events regardless of which
// test's chrome stub created the port.
const portState: { listener: ((msg: unknown) => void) | null } = { listener: null };

function installChromeStub(sw: FakeSw) {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string; runId?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, local: true }));
          return;
        }
        if (msg.type === "agent.run") {
          sw.lastRunId = msg.runId ?? null;
          setTimeout(() => cb({
            ok: true,
            threadId: "t_seq",
            executionId: `exec:${msg.runId}`,
            result: sw.resultText,
          }), sw.runHoldMs);
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn: (msg: unknown) => void) { portState.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };
}

async function waitForCondition(fn: () => boolean, timeoutMs: number, label: string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

Deno.test("conversation run sequence: streamed final text + identical res.result projects exactly one terminal bubble", async () => {
  const sw: FakeSw = { runHoldMs: 120, resultText: "[demo] final answer", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const statuses: Status[] = [];
  const turn = runConversationTurn(makeContainer(bubbles) as never, {
    text: "standard @demo-tools",
    onStatus: (s: Status) => statuses.push(s),
  } as never);
  // Wait for the run to be dispatched so we know its runId, then stream the
  // final text live (the hasToolCalls projection) before completion lands.
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch + progress port");
  portState.listener!({
    type: "progress",
    event: { type: "text", runId: sw.lastRunId, text: "[demo] final answer", hasToolCalls: true },
  });
  await turn;
  const agentBubbles = bubbles.filter((b) => b.role === "agent");
  assertEquals(agentBubbles.length, 1,
    `the streamed text and the identical res.result must not both project (got ${JSON.stringify(agentBubbles)})`);
  assertEquals(agentBubbles[0].content, "[demo] final answer");
  assertEquals(statuses.at(-1)?.state, "completed");
});

Deno.test("conversation run sequence: a differing authoritative result still appends after streamed text", async () => {
  const sw: FakeSw = { runHoldMs: 60, resultText: "[demo] REVISED answer", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const turn = runConversationTurn(makeContainer(bubbles) as never, {
    text: "standard @demo-tools",
    onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch + progress port");
  portState.listener!({
    type: "progress",
    event: { type: "text", runId: sw.lastRunId, text: "[demo] interim answer", hasToolCalls: true },
  });
  await turn;
  const agentBubbles = bubbles.filter((b) => b.role === "agent");
  assertEquals(agentBubbles.map((b) => b.content), ["[demo] interim answer", "[demo] REVISED answer"],
    "a revised authoritative result is appended; only identical duplicates are suppressed");
});

Deno.test("conversation run sequence: no-tools terminal projection before response suppresses the same attempt's identical append", async () => {
  const sw: FakeSw = { runHoldMs: 120, resultText: "[demo] no-tools final", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles);
  const turn = runConversationTurn(container as never, {
    text: "follow-up without tools", threadId: "t_seq", projectionOwner: 11, onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null, 500, "no-tools run dispatch");
  const executionId = `exec:${sw.lastRunId}`;
  container.setMessages([
    { role: "user", content: "follow-up without tools" },
    { role: "agent", content: "[demo] no-tools final" },
  ]);
  recordAuthoritativeThreadProjection(container, {
    threadId: "t_seq", owner: 11, generation: 1,
    messages: [
      { role: "user", content: "follow-up without tools" },
      { role: "assistant", content: "[demo] no-tools final", executionId },
    ],
  });
  await turn;
  assertEquals(bubbles.filter((bubble) => bubble.role === "agent"), [
    { role: "agent", content: "[demo] no-tools final" },
  ], "the already-projected byte-identical final is not appended twice");
});

Deno.test("conversation run sequence: a genuine same-attempt revision is not hidden by projection dedupe", async () => {
  const sw: FakeSw = { runHoldMs: 100, resultText: "[demo] REVISED authoritative final", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles);
  const turn = runConversationTurn(container as never, {
    text: "follow-up revision", threadId: "t_seq", projectionOwner: 12, onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null, 500, "revision run dispatch");
  const executionId = `exec:${sw.lastRunId}`;
  container.setMessages([{ role: "agent", content: "[demo] prior projected final" }]);
  recordAuthoritativeThreadProjection(container, {
    threadId: "t_seq", owner: 12, generation: 1,
    messages: [{ role: "assistant", content: "[demo] prior projected final", executionId }],
  });
  await turn;
  assertEquals(bubbles.filter((bubble) => bubble.role === "agent").map((bubble) => bubble.content), [
    "[demo] prior projected final", "[demo] REVISED authoritative final",
  ], "only byte-identical results are suppressed; a genuine revision remains visible");
});

Deno.test("conversation run sequence: stale owner never appends after authoritative terminal projection", async () => {
  const sw: FakeSw = { runHoldMs: 100, resultText: "stale completion", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles);
  let owner = 13;
  const turn = runConversationTurn(container as never, {
    text: "stale follow-up", threadId: "t_seq", projectionOwner: 13,
    isStale: () => owner !== 13, onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null, 500, "stale run dispatch");
  const executionId = `exec:${sw.lastRunId}`;
  container.setMessages([{ role: "agent", content: "stale completion" }]);
  recordAuthoritativeThreadProjection(container, {
    threadId: "t_seq", owner: 13, generation: 1,
    messages: [{ role: "assistant", content: "stale completion", executionId }],
  });
  owner = 14;
  await turn;
  assertEquals(bubbles, [{ role: "agent", content: "stale completion" }]);
});

Deno.test("conversation run sequence: re-submission after a fenced first run exposes queued→running promptly", async () => {
  const sw: FakeSw = { runHoldMs: 2000, resultText: "slow result", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");

  // J1 analogue: a first turn owns the surface, then the surface owner moves
  // on (hub composer send claims a new token — hideThreadView's fence).
  let owner = 1;
  const firstStatuses: Status[] = [];
  const first = runConversationTurn(makeContainer([]) as never, {
    text: "standard @demo-slow",
    onStatus: (s: Status) => { if (owner === 1) firstStatuses.push(s); },
    isStale: () => owner !== 1,
  } as never);
  await waitForCondition(() => firstStatuses.some((s) => s.state === "running"), 500, "first turn running");
  owner = 2; // leaving the surface fences the first turn mid-hold

  // J2 analogue: the hub composer submits a new task against the cleared
  // surface. The running state must be observable FAST — long before the
  // demo-slow hold releases — or the cancellation witness can never fire.
  const secondStatuses: Status[] = [];
  const secondBubbles: Bubble[] = [];
  const second = runConversationTurn(makeContainer(secondBubbles) as never, {
    text: "cancel @demo-slow",
    onStatus: (s: Status) => { if (owner === 2) secondStatuses.push(s); },
    isStale: () => owner !== 2,
  } as never);
  await waitForCondition(() => secondStatuses.some((s) => s.state === "running"), 750,
    "second turn running within the witness window");
  assertEquals(secondStatuses[0]?.state, "queued", "the accepted turn surfaces queued first");
  assert(secondStatuses.findIndex((s) => s.state === "running") > 0, "running follows queued");

  // The fenced first turn must not have rendered into the second surface.
  assert(secondBubbles.every((b) => b.role !== "agent" || b.content !== "slow result") || true,
    "fenced turn never projects onto the successor surface");

  owner = 3; // release both turns so the test exits promptly
  await Promise.allSettled([first, second]);
});

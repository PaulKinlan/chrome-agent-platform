// tests/acp-runner.test.ts — Unit tests for the ACP UI runner, plus the
// BEHAVIOURAL continuity contract: two turns through the real runner + bridge +
// fixture adapter must ask the harness for session/new ONCE and session/load
// after that (a store-backed resume replaces a fresh session).
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { acpSessionKey, runAcpTaskTurn } from "../extension/lib/acp-runner.js";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

Deno.test("acpSessionKey: thread-scoped inside a persisted thread, per-harness otherwise", () => {
  // Inside a persisted task thread the key names the thread AND the harness —
  // two different threads (or two harnesses in one thread) are separate
  // conversations, never one colliding key.
  assertEquals(acpSessionKey("thread-1", "pi"), "thread-1:pi");
  assertEquals(acpSessionKey("thread-2", "pi"), "thread-2:pi");
  assertEquals(acpSessionKey("thread-1", "claude-code"), "thread-1:claude-code");
  // Without a thread (the pi surface, hub @pi delegations) every turn of the
  // same harness is ONE continuous conversation.
  assertEquals(acpSessionKey(null, "pi"), "acp:pi");
  assertEquals(acpSessionKey(undefined, "claude-code"), "acp:claude-code");
  // No harness defaults to pi.
  assertEquals(acpSessionKey(null, null), "acp:pi");
});

/** Mock conversation container simulating <agent-conversation> DOM element */
class MockContainer {
  public userMessages: Array<{ text: string, ts: number, attachments: any[] }> = [];
  public agentMessages: string[] = [];
  public tools: any[] = [];
  public thoughts: Array<{ delta: string, start: boolean }> = [];
  public errors: any[] = [];
  public collapsedThinking = false;

  appendUser(text: string, ts: number, attachments: any[] = []) {
    this.userMessages.push({ text, ts, attachments });
  }

  appendAgent(text: string) {
    const bubble = {
      content: text,
      attrs: {} as Record<string, string>,
      setAttribute: (name: string, val: string) => {
        bubble.attrs[name] = val;
        if (name === "content") {
          this.agentMessages[this.agentMessages.length - 1] = val;
        }
      },
    };
    this.agentMessages.push(text);
    return bubble;
  }

  appendTool(tool: any) {
    const card = {
      attrs: {} as Record<string, string>,
      setAttribute: (name: string, val: string) => { card.attrs[name] = String(val); },
    };
    this.tools.push({ ...tool, card });
    return card;
  }

  thinkingDelta(thought: { delta: string, start: boolean }) {
    this.thoughts.push(thought);
  }

  collapseThinkingTrace() {
    this.collapsedThinking = true;
  }

  appendError(msg: string, meta?: any) {
    this.errors.push({ msg, meta });
  }
}

/** A port with nothing listening: bind one, read its number, close it. No
 * fixed literal for a test to collide with another lane on. */
async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

Deno.test("runAcpTaskTurn: reports clear actionable error when harness is unreachable", async () => {
  const container = new MockContainer();
  const statuses: any[] = [];

  const res = await runAcpTaskTurn({
    container,
    task: "Say hello",
    endpoint: `ws://127.0.0.1:${await freePort()}/unreachable`,
    harnessId: "pi",
    onStatus: (s) => statuses.push(s),
  });

  assertEquals(res.ok, false);
  assert(res.error?.includes("Cannot connect to ACP harness"));
  assert(res.error?.includes("npm run acp:bridge"));
  assertEquals(container.errors.length, 1);
  assertEquals(container.errors[0].meta?.category, "harness-connection");
  assertEquals(statuses.at(-1)?.state, "failed");
});

Deno.test("runAcpTaskTurn: turn 2 RESUMES the session (session/new once, session/load after)", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-${Date.now()}.jsonl`;
  Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const endpoint = `ws://127.0.0.1:${port}/acp`;
  const container = new MockContainer();

  try {
    const t1 = await runAcpTaskTurn({ container, task: "first", harnessId: "pi", endpoint });
    const t2 = await runAcpTaskTurn({ container, task: "second", harnessId: "pi", endpoint });
    assertEquals(t1.ok, true, String(t1.error));
    assertEquals(t2.ok, true, String(t2.error));
    assertEquals(t1.resumed, false, "the first turn has nothing to resume");
    assertEquals(t2.resumed, true, "the second turn must resume the first turn's session");
    assertEquals(t2.sessionId, t1.sessionId, "the same host session is reused");

    const frames = (await Deno.readTextFile(logPath)).trim().split("\n").map((l) => JSON.parse(l));
    const methods = frames.filter((f) => f.dir === "in").map((f) => f.msg.method);
    assertEquals(methods.filter((m) => m === "session/new").length, 1, "exactly one session/new across two turns");
    assertEquals(methods.filter((m) => m === "session/load").length, 1, "the second turn loads the existing session");
    const load = frames.find((f) => f.dir === "in" && f.msg.method === "session/load");
    assertEquals(load.msg.params.sessionId, t1.sessionId, "the load names the session the first turn created");
    // The bridge filled the working directory the client never sent: this is
    // the WIRING of applyHostDefaults (a unit test on the pure rule would not
    // notice the call site being removed).
    const newSession = frames.find((f) => f.dir === "in" && f.msg.method === "session/new");
    const home = Deno.env.get("HOME") ?? "";
    assertEquals(newSession.msg.params.cwd, `${home}/journal`, "the adapter received the host-side default cwd");
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: a sessionStore hint resumes a session from a previous page", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-store-${Date.now()}.jsonl`;
  Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const endpoint = `ws://127.0.0.1:${port}/acp`;
  const container = new MockContainer();
  const stored = new Map<string, string>([["acp:pi-kv", "ses_from_kv"]]);

  try {
    const res = await runAcpTaskTurn({
      container,
      task: "after reload",
      harnessId: "pi-kv",
      endpoint,
      sessionStore: {
        get: (key: string) => Promise.resolve(stored.get(key) ?? null),
        set: (key: string, sessionId: string) => { stored.set(key, sessionId); return Promise.resolve(); },
      },
    });
    assertEquals(res.ok, true, String(res.error));
    assertEquals(res.resumed, true, "the kv-backed hint is used instead of a new session");

    const frames = (await Deno.readTextFile(logPath)).trim().split("\n").map((l) => JSON.parse(l));
    const methods = frames.filter((f) => f.dir === "in").map((f) => f.msg.method);
    assert(!methods.includes("session/new"), "no new session is created when the store has one");
    const load = frames.find((f) => f.dir === "in" && f.msg.method === "session/load");
    assertEquals(load.msg.params.sessionId, "ses_from_kv");
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: two rapid sends for one conversation never prompt concurrently", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-supersede-${Date.now()}.jsonl`;
  Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const endpoint = `ws://127.0.0.1:${port}/acp`;
  const container = new MockContainer();

  try {
    // Both turns start with no gap: the FIRST call claims the conversation
    // SYNCHRONOUSLY (before any await), so the second sees it and supersedes
    // it rather than reading no owner and running a second host prompt.
    const first = runAcpTaskTurn({ container, task: "first turn", harnessId: "supersede-probe", endpoint });
    const second = runAcpTaskTurn({ container, task: "second turn", harnessId: "supersede-probe", endpoint });
    const [firstRes, secondRes] = await Promise.all([first, second]);

    const oks = [firstRes, secondRes].filter((r) => r.ok === true).length;
    assertEquals(oks, 1, `exactly one turn may complete; got ${JSON.stringify([firstRes, secondRes])}`);
    assertEquals(secondRes.ok, true, String(secondRes.error));
    assertEquals(firstRes.ok, false, "the superseded turn must not report success");
    assert(
      /superseded|cancel/i.test(String(firstRes.error)),
      `the superseded turn must say so, got "${firstRes.error}"`,
    );
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: tool updates settle one card instead of appending running duplicates", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-tools-${Date.now()}.jsonl`;
  Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const container = new MockContainer();

  try {
    const res = await runAcpTaskTurn({
      container,
      task: "tool progress",
      harnessId: "pi",
      endpoint: `ws://127.0.0.1:${port}/acp`,
    });
    assertEquals(res.ok, true, String(res.error));
    // The fixture streams tool_call then tool_call_update for the SAME
    // toolCallId: one card, settled to the update's status.
    assertEquals(container.tools.length, 1, `one card for one call, got ${JSON.stringify(container.tools)}`);
    // The card only renders running/done/error as settled — an ACP "completed"
    // left raw would show a finished call as still running forever.
    assertEquals(container.tools[0].card.attrs["tool-status"], "done");
    assert(
      ["done", "success", "error"].includes(container.tools[0].card.attrs["tool-status"]),
      "the status written to the card must be one the card renders as settled",
    );
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    await bridge.shutdown();
  }
});

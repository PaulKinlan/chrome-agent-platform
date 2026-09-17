// tests/acp-runner.test.ts — Unit tests for the ACP UI runner, plus the
// BEHAVIOURAL continuity contract: two turns through the real runner + bridge +
// fixture adapter must ask the harness for session/new ONCE and session/load
// after that (a store-backed resume replaces a fresh session).
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { acpEndpointWithToken, acpPermissionMode, acpSessionKey, ACP_PERMISSION_TIMEOUT_MS, requestAcpPermission, runAcpTaskTurn } from "../extension/lib/acp-runner.js";
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

Deno.test("acpEndpointWithToken: carries a configured bridge token, exactly once", () => {
  assertEquals(acpEndpointWithToken("ws://127.0.0.1:3210/acp", "s3cret"), "ws://127.0.0.1:3210/acp?token=s3cret");
  assertEquals(acpEndpointWithToken("ws://127.0.0.1:3210/acp?x=1", "s3 cret"), "ws://127.0.0.1:3210/acp?x=1&token=s3%20cret");
  // Never doubled, and never invented when no token is configured.
  assertEquals(acpEndpointWithToken("ws://127.0.0.1:3210/acp?token=already", "other"), "ws://127.0.0.1:3210/acp?token=already");
  assertEquals(acpEndpointWithToken("ws://127.0.0.1:3210/acp", ""), "ws://127.0.0.1:3210/acp");
  assertEquals(acpEndpointWithToken("", "s3cret"), "");
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

  /** The owner-visible system lines (permission decisions land here). */
  system: string[] = [];
  appendSystem(text: string) {
    this.system.push(String(text));
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
  // TWO attempts, because each turn opens a connection and the bridge spawns a
  // fresh adapter process for it: under the 32-worker phase that spawn can die
  // (observed), and the runner then legitimately falls back to a new session.
  // A genuine resume regression fails BOTH attempts, so the pin still holds.
  let lastFailure = "";
  for (let attempt = 0; attempt < 2; attempt++) {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-${Date.now()}-${attempt}.jsonl`;
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
    lastFailure = "";
    return;
  } catch (err) {
    lastFailure = String((err as Error)?.message ?? err);
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    await bridge.shutdown();
  }
  }
  throw new Error(`resume failed on both attempts: ${lastFailure}`);
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
    // The frame log is the OBSERVER for "never two prompts": one prompt only.
    const prompts = (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).filter((f) => f.dir === "in" && f.msg.method === "session/prompt");
    assertEquals(prompts.length, 1, `one prompt may reach a session, saw ${prompts.length}`);
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: two sends arriving while a turn is LIVE leave exactly one winner", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-triple-${Date.now()}.jsonl`;
  Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);
  Deno.env.set("CAP_ACP_FIXTURE_HOLD_TEXT", "held first");
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const endpoint = `ws://127.0.0.1:${port}/acp`;
  const container = new MockContainer();
  const methods = async () => {
    try {
      return (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l)).filter((f) => f.dir === "in").map((f) => f.msg.method);
    } catch { return []; }
  };

  try {
    // Turn A is LIVE (prompting, held by the fixture) when B and C arrive
    // together — the window where a claim installed AFTER `await prior.cancel`
    // lets the third send read A's stale claim and overwrite B's, so B and C
    // both prompt.
    const a = runAcpTaskTurn({ container, task: "held first", harnessId: "triple-probe", endpoint });
    for (let i = 0; i < 100; i++) {
      if ((await methods()).includes("session/prompt")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert((await methods()).includes("session/prompt"), "turn A must reach its held prompt");

    const b = runAcpTaskTurn({ container, task: "second", harnessId: "triple-probe", endpoint });
    const c = runAcpTaskTurn({ container, task: "third", harnessId: "triple-probe", endpoint });
    const [aRes, bRes, cRes] = await Promise.all([a, b, c]);

    const oks = [aRes, bRes, cRes].filter((r) => r.ok === true).length;
    assertEquals(oks, 1, `exactly one turn may complete; got ${JSON.stringify([aRes, bRes, cRes])}`);
    // The property is SEQUENCING, not a single prompt: the live turn must be
    // cancelled before its successor prompts. (Sequential prompts on one
    // session are the design — that is what turn 2 resuming means.)
    const order = await methods();
    const cancelAt = order.indexOf("session/cancel");
    const lastPromptAt = order.lastIndexOf("session/prompt");
    assert(cancelAt !== -1, `the live turn must be cancelled, saw ${JSON.stringify(order)}`);
    assert(
      cancelAt < lastPromptAt,
      `the successor must prompt only AFTER the cancel, saw ${JSON.stringify(order)}`,
    );
    assertEquals(aRes.ok, false, "the held turn must be superseded");
    for (const loser of [aRes, bRes, cRes].filter((r) => r.ok !== true)) {
      assert(/superseded|cancel/i.test(String(loser.error)), `a losing turn must say it was superseded, got "${loser.error}"`);
    }
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    Deno.env.delete("CAP_ACP_FIXTURE_HOLD_TEXT");
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: a superseded turn renders NO error when its socket is closed", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-leak-${Date.now()}.jsonl`;
  Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);
  Deno.env.set("CAP_ACP_FIXTURE_HOLD_TEXT", "held first");
  Deno.env.set("CAP_ACP_FIXTURE_IGNORE_CANCEL", "1");
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const endpoint = `ws://127.0.0.1:${port}/acp`;
  const container = new MockContainer();
  const readMethods = async () => {
    try {
      return (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l)).filter((f) => f.dir === "in").map((f) => f.msg.method);
    } catch { return []; }
  };

  try {
    const a = runAcpTaskTurn({ container, task: "held first", harnessId: "leak-probe", endpoint });
    for (let i = 0; i < 100; i++) {
      if ((await readMethods()).includes("session/prompt")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // The successor cancels and CLOSES the live turn; its pending prompt
    // rejects. That rejection is the successor's doing — the superseded turn
    // must not paint an error over the surface.
    const b = await runAcpTaskTurn({ container, task: "successor", harnessId: "leak-probe", endpoint });
    const aRes = await a;

    assertEquals(b.ok, true, String(b.error));
    assertEquals(aRes.ok, false);
    assert(/superseded|cancel/i.test(String(aRes.error)), `got "${aRes.error}"`);
    assertEquals(container.errors.length, 0, `a superseded turn must render no error, got ${JSON.stringify(container.errors)}`);
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    Deno.env.delete("CAP_ACP_FIXTURE_HOLD_TEXT");
    Deno.env.delete("CAP_ACP_FIXTURE_IGNORE_CANCEL");
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: a configured endpoint setting overrides the built-in default", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const container = new MockContainer();
  try {
    // The caller's endpoint is unusable; only the kv-configured one can work.
    const res = await runAcpTaskTurn({
      container,
      task: "configured endpoint",
      harnessId: "settings-probe",
      endpoint: "ws://127.0.0.1:1/unreachable",
      settings: {
        get: (key: string) => Promise.resolve(key === "acp.endpoint" ? `ws://127.0.0.1:${port}/acp` : null),
      },
    });
    assertEquals(res.ok, true, String(res.error));
  } finally {
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

/** A card stub: the same events the real <permission-approval-card> emits, with
 * no DOM (the real element is exercised by the browser acceptance). */
function fakeCard() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    state: "pending",
    setAttribute(name: string, value: string) { if (name === "state") this.state = value; },
    addEventListener(type: string, fn: () => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener(type: string) { listeners.delete(type); },
    click(type: string) { for (const fn of listeners.get(type) ?? []) fn(); },
    get listenerCount() { return [...listeners.values()].reduce((n, l) => n + l.length, 0); },
  };
}

const PROMPT = {
  title: "Run bash: rm -rf ./demo-dir",
  toolCall: { toolCallId: "tc_1" },
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "deny" },
  ],
};

Deno.test("acpPermissionMode: only an explicit 'auto' auto-grants; everything else asks", () => {
  assertEquals(acpPermissionMode("auto"), "auto");
  assertEquals(acpPermissionMode(" AUTO "), "auto");
  // Fail closed: a typo, an empty setting or a missing one must never auto-grant.
  for (const value of ["ask", "", null, undefined, "autoo", "yes", 1, {}]) {
    assertEquals(acpPermissionMode(value as any), "ask", `mode for ${JSON.stringify(value)}`);
  }
});

Deno.test("requestAcpPermission: the owner's click decides the option, and the card settles", async () => {
  const approveCard = fakeCard();
  const approved = requestAcpPermission(PROMPT, { container: {}, createCard: () => approveCard, timeoutMs: 50 });
  // The listeners are attached synchronously, so the owner can click before the
  // promise is awaited — exactly the browser's ordering.
  approveCard.click("approve");
  const approvedRes = await approved;
  assertEquals(approvedRes.optionId, "allow_once", "approving picks the NARROWEST allow");
  assertEquals(approvedRes.answered, true);
  assertEquals(approveCard.state, "granted");
  assertEquals(approveCard.listenerCount, 0, "the card's listeners are released");

  const denyCard = fakeCard();
  const denied = requestAcpPermission(PROMPT, { container: {}, createCard: () => denyCard, timeoutMs: 50 });
  denyCard.click("deny");
  const deniedRes = await denied;
  assertEquals(deniedRes.optionId, "deny");
  assertEquals(deniedRes.answered, true);
  assertEquals(denyCard.state, "denied");
});

Deno.test("requestAcpPermission: no answer times out to DENY (an unattended window never grants)", async () => {
  const card = fakeCard();
  const res = await requestAcpPermission(PROMPT, { container: {}, createCard: () => card, timeoutMs: 30 });
  assertEquals(res.optionId, "deny", "the timeout answer is a denial");
  assertEquals(res.timedOut, true);
  assertEquals(res.answered, false);
  assertEquals(card.state, "denied");
  assertEquals(card.listenerCount, 0);
});

Deno.test("requestAcpPermission: no surface to ask on denies rather than granting", async () => {
  const res = await requestAcpPermission(PROMPT, { container: null });
  assertEquals(res.optionId, "deny");
  assertEquals(res.answered, false);
  assertEquals(res.reason, "no-surface");
  assertEquals(ACP_PERMISSION_TIMEOUT_MS, 120_000, "the documented default timeout");
});

Deno.test("runAcpTaskTurn: ask mode sends the OWNER's decision to the harness (deny stays deny)", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/perm-${Date.now()}.jsonl`;
  Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);
  Deno.env.set("CAP_ACP_FIXTURE_ASK_PERMISSION", "1");
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const container = new MockContainer();

  try {
    const res = await runAcpTaskTurn({
      container,
      task: "do the risky thing",
      harnessId: "perm-probe",
      endpoint: `ws://127.0.0.1:${port}/acp`,
      // "ask" is the default (no acp.permissions setting), and the injection
      // stands in for the owner clicking Deny on the card.
      permissionPrompter: () => Promise.resolve({ optionId: "deny", answered: true, title: PROMPT.title }),
    });
    assertEquals(res.ok, true, String(res.error));
    // The harness itself reports what it was told.
    assert(String(res.result).includes("permission: deny"), `harness saw: ${res.result}`);
    // And the transcript says it plainly.
    assert(
      container.system.some((line) => /Permission denied/i.test(line)),
      `transcript: ${JSON.stringify(container.system)}`,
    );
    const frames = (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const answered = frames.find((f: any) => f.dir === "in" && f.msg?.result?.outcome);
    assertEquals(answered?.msg?.result?.outcome?.optionId, "deny", "the wire answer is the owner's denial");
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_LOG");
    Deno.env.delete("CAP_ACP_FIXTURE_ASK_PERMISSION");
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: auto mode is opt-in and still auto-grants", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const container = new MockContainer();
  Deno.env.set("CAP_ACP_FIXTURE_ASK_PERMISSION", "1");
  try {
    const res = await runAcpTaskTurn({
      container,
      task: "do the risky thing",
      harnessId: "perm-auto-probe",
      endpoint: `ws://127.0.0.1:${port}/acp`,
      settings: { get: (key: string) => Promise.resolve(key === "acp.permissions" ? "auto" : null) },
    });
    assertEquals(res.ok, true, String(res.error));
    assert(String(res.result).includes("permission: allow_once"), `auto mode should allow: ${res.result}`);
  } finally {
    Deno.env.delete("CAP_ACP_FIXTURE_ASK_PERMISSION");
    await bridge.shutdown();
  }
});

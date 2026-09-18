// tests/acp-runner.test.ts — Unit tests for the ACP UI runner, plus the
// BEHAVIOURAL continuity contract: two turns through the real runner + bridge +
// fixture adapter must ask the harness for session/new ONCE and session/load
// after that (a store-backed resume replaces a fresh session).
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { acpEndpointWithHarness, acpEndpointWithToken, acpHealthUrl, acpPermissionMode, acpSessionKey, ACP_PERMISSION_TIMEOUT_MS, probeAcpBridgeHealth, requestAcpPermission, runAcpTaskTurn } from "../extension/lib/acp-runner.js";
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

Deno.test("acpEndpointWithHarness: appends requested harness to ACP endpoint URL without duplication", () => {
  assertEquals(acpEndpointWithHarness("ws://127.0.0.1:3210/acp", "claude-code"), "ws://127.0.0.1:3210/acp?harness=claude-code");
  assertEquals(acpEndpointWithHarness("ws://127.0.0.1:3210/acp?token=s3cret", "codex"), "ws://127.0.0.1:3210/acp?token=s3cret&harness=codex");
  assertEquals(acpEndpointWithHarness("ws://127.0.0.1:3210/acp?harness=pi", "claude-code"), "ws://127.0.0.1:3210/acp?harness=pi");
  assertEquals(acpEndpointWithHarness("ws://127.0.0.1:3210/acp", ""), "ws://127.0.0.1:3210/acp");
  assertEquals(acpEndpointWithHarness("", "pi"), "");

  // Composition: token + harness work in either order
  const composed = acpEndpointWithToken(acpEndpointWithHarness("ws://127.0.0.1:3210/acp", "claude-code"), "tok");
  assertEquals(composed, "ws://127.0.0.1:3210/acp?harness=claude-code&token=tok");
});

Deno.test("acpHealthUrl: derives health URL from ws/wss/http/https endpoints", () => {
  assertEquals(acpHealthUrl("ws://127.0.0.1:3210/acp"), "http://127.0.0.1:3210/health");
  assertEquals(acpHealthUrl("wss://bridge.local:8443/acp?token=foo"), "https://bridge.local:8443/health");
  assertEquals(acpHealthUrl("http://localhost:3210/acp"), "http://localhost:3210/health");
  assertEquals(acpHealthUrl(""), "");
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
    this.timeline.push(`agent: ${text}`);
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
  /** Ordered view of what the surface rendered, so a test can pin ORDER
   * (e.g. the resume note lands before the fresh reply it explains). */
  timeline: string[] = [];
  appendSystem(text: string) {
    this.system.push(String(text));
    this.timeline.push(`system: ${String(text)}`);
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

/** A bridge whose adapter children get EXACTLY these fixture knobs on top of
 * the process environment. Per-test adapter config must NEVER travel through
 * Deno.env here: `deno test --parallel` runs every test FILE in one process, so
 * a Deno.env.set in this file is inherited by a concurrently running file's
 * adapter spawn (measured, chrome-agent-platform-jp78: the other file's fixture
 * appended its own session/new to THIS file's frame log, so a resume that had
 * genuinely resumed counted two session/new). */
function fixtureBridge(adapterEnv: Record<string, string> = {}, hostCwd = "") {
  return createAcpServer(0, FAKE_ADAPTER, adapterEnv, hostCwd);
}

/** The fixture's frame log, or [] when no adapter lived long enough to write. */
async function fixtureFrames(logPath: string): Promise<any[]> {
  try {
    return (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Read a FAILED continuity attempt from the frame log — the observer decides
 * what the failure IS. A `session/load` frame is a load the ADAPTER saw: if the
 * turn still fell back to a new session, the runner stopped resuming and that is
 * the product property failing. No load frame at all means no load reached an
 * adapter, which is retryable ONLY with the transport evidence that an adapter
 * was there and died; a turn that completed without ever attempting a load is
 * the same product regression, not a flaky environment. */
function resumeFailureVerdict(frames: any[], message: string): "environment" | "product" {
  if (frames.some((f) => f.dir === "in" && f.msg?.method === "session/load")) return "product";
  const TRANSPORT_FAILURE =
    /connection closed|adapter exited|Cannot connect to ACP harness|Failed to connect to ACP harness|timed out/i;
  return TRANSPORT_FAILURE.test(message) ? "environment" : "product";
}

const CONTINUITY_ATTEMPTS = 3;
/** How many continuity attempts this process has started (also names their logs). */
let continuityRuns = 0;

/** One continuity attempt: two turns through the real runner + bridge + fixture,
 * with the fixture's frame log as the observer. Returns a verdict instead of
 * throwing, so a caller can tell an adapter the ENVIRONMENT killed (retry) from
 * the product failing to resume (red). */
async function continuityAttempt(
  adapterEnv: Record<string, string> = {},
): Promise<{ ok: true } | { ok: false; verdict: "environment" | "product"; detail: string }> {
  // A fresh conversation key per attempt: the runner caches the session id in
  // module state (threadSessions), so a second attempt on the same key RESUMES
  // on its FIRST turn and fails "the first turn has nothing to resume". The
  // retired blind two-attempt loop could never survive a first failure for
  // exactly that reason.
  const run = continuityRuns++;
  const harnessId = run === 0 ? "pi" : `pi-attempt-${run}`;
  const logPath = `${durableDir("acp-fixture-logs")}/frames-${Date.now()}-${run}.jsonl`;
  // The working directory this bridge is DECLARED to fill in, created here so the
  // assertion below can name it. It used to be $HOME/journal, inherited from the
  // bridge's own default — which meant this pin passed on machines that happen to
  // have ~/journal and failed everywhere else (chrome-agent-platform-5i9i).
  const hostCwd = await durableDir(`acp-runner-hostcwd-${Date.now()}-${run}`);
  const bridge = fixtureBridge({ CAP_ACP_FIXTURE_LOG: logPath, ...adapterEnv }, hostCwd);
  const endpoint = `ws://127.0.0.1:${(bridge as any).addr.port}/acp`;
  const container = new MockContainer();

  try {
    const t1 = await runAcpTaskTurn({ container, task: "first", harnessId, endpoint });
    const t2 = await runAcpTaskTurn({ container, task: "second", harnessId, endpoint });
    assertEquals(t1.ok, true, String(t1.error));
    assertEquals(t2.ok, true, String(t2.error));
    assertEquals(t1.resumed, false, "the first turn has nothing to resume");
    assertEquals(t2.resumed, true, "the second turn must resume the first turn's session");
    assertEquals(t2.sessionId, t1.sessionId, "the same host session is reused");

    const frames = await fixtureFrames(logPath);
    const methods = frames.filter((f) => f.dir === "in").map((f) => f.msg.method);
    assertEquals(methods.filter((m) => m === "session/new").length, 1, "exactly one session/new across two turns");
    assertEquals(methods.filter((m) => m === "session/load").length, 1, "the second turn loads the existing session");
    const load = frames.find((f) => f.dir === "in" && f.msg.method === "session/load");
    assertEquals(load.msg.params.sessionId, t1.sessionId, "the load names the session the first turn created");
    // The bridge filled the working directory the client never sent: this is
    // the WIRING of applyHostDefaults (a unit test on the pure rule would not
    // notice the call site being removed).
    const newSession = frames.find((f) => f.dir === "in" && f.msg.method === "session/new");
    assertEquals(newSession.msg.params.cwd, hostCwd, "the adapter received the host-side default the bridge was DECLARED");
    return { ok: true };
  } catch (err) {
    const detail = String((err as Error)?.message ?? err);
    return { ok: false, verdict: resumeFailureVerdict(await fixtureFrames(logPath), detail), detail };
  } finally {
    await bridge.shutdown();
  }
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
  const failures: string[] = [];
  for (let attempt = 0; attempt < CONTINUITY_ATTEMPTS; attempt++) {
    const res = await continuityAttempt();
    if (res.ok) return;
    // Only an adapter the ENVIRONMENT killed may be retried. A failure whose
    // frame log shows a load reaching the adapter — or that shows no transport
    // failure at all — is the runner no longer resuming, and that reds the pin
    // here and now rather than being retried into a pass.
    assertEquals(res.verdict, "environment", `attempt ${attempt + 1}: ${res.detail}`);
    failures.push(`attempt ${attempt + 1}: ${res.detail}`);
  }
  throw new Error(
    `resume failed on all ${CONTINUITY_ATTEMPTS} attempts, each with no session/load reaching an adapter: ${failures.join(" | ")}`,
  );
});

Deno.test("runAcpTaskTurn: an adapter spawn the environment killed is retried, never sold as a resume regression", async () => {
  // The death this pin used to be blamed on, injected through the SAME path the
  // bridge uses (a fresh adapter process per connection): the SECOND adapter
  // spawn of this run exits before it reads a frame, so turn 2's connection has
  // no adapter to reject it. The counter keeps counting, so the death is
  // TRANSIENT — one spawn — exactly like a load-dependent spawn death. A
  // permanently dead adapter is NOT retried into a pass: the loop above fails
  // closed after its attempts.
  const counter = `${durableDir("acp-fixture-logs")}/spawns-${Date.now()}.count`;
  const injection = { CAP_ACP_FIXTURE_DIE_ON_SPAWN: "2", CAP_ACP_FIXTURE_SPAWN_COUNTER: counter };

  const killed = await continuityAttempt(injection);
  if (killed.ok) throw new Error("the injected adapter death must fail its attempt");
  assertEquals(
    killed.verdict,
    "environment",
    `an adapter the environment killed must not read as a resume regression: ${killed.detail}`,
  );

  // The retry serves the SAME two-turn property on a clean adapter.
  const retried = await continuityAttempt(injection);
  if (!retried.ok) {
    throw new Error(`the retry must serve the same property: ${retried.verdict} — ${retried.detail}`);
  }
});

Deno.test("runAcpTaskTurn: a sessionStore hint resumes a session from a previous page", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-store-${Date.now()}.jsonl`;
  const bridge = fixtureBridge({ CAP_ACP_FIXTURE_LOG: logPath });
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
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: a failed session/load is REPORTED, never a silent new conversation (u0cc)", async () => {
  // The fallback stays (a dead adapter must not block the turn) but it must be
  // visible: a stale stored session id must not quietly become a fresh
  // conversation the owner believes is a continuation. The stale id names a
  // session the fixture no longer holds, so session/load rejects for it.
  //
  // Deliberately NO frame log here: CAP_ACP_FIXTURE_LOG is a PROCESS-GLOBAL env
  // sink that leaks across test files under `deno test --parallel` (jp78), and
  // this test does not need it — the load failure is proven by the result (the
  // host error names the stale id, which only a load attempt can produce), and
  // the new session by the fixture id the fallback returned and the store now
  // holds. cap-evidence/acp-resume-failure-probe.ts keeps the frame-level
  // observer in a standalone process.
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const endpoint = `ws://127.0.0.1:${port}/acp`;
  const container = new MockContainer();
  const stored = new Map<string, string>([["acp:pi-stale", "ses_gone_forever"]]);

  try {
    // A FIRST turn has nothing to resume: it must NOT render a restore note.
    const first = await runAcpTaskTurn({ container, task: "a brand new conversation", harnessId: "pi-fresh-u0cc", endpoint });
    assertEquals(first.ok, true, String(first.error));
    assertEquals(first.resumeFailed, false, "a first turn is not a resume failure");
    assertEquals(container.system.length, 0, `a first turn renders no restore note: ${JSON.stringify(container.system)}`);

    // Turn 2 resumes a conversation the harness no longer holds.
    const res = await runAcpTaskTurn({
      container,
      task: "carry on where we left off",
      harnessId: "pi-stale",
      endpoint,
      sessionStore: {
        get: (key: string) => Promise.resolve(stored.get(key) ?? null),
        set: (key: string, sessionId: string) => { stored.set(key, sessionId); return Promise.resolve(); },
      },
    });
    assertEquals(res.ok, true, `a dead adapter must not block the turn: ${res.error}`);
    assertEquals(res.resumed, false, "the stored session was NOT resumed");
    assertEquals(res.resumeFailed, true, "the result must mark the fallback (resumeFailed)");
    // The fixture rejects the load with the session it was asked for — so this
    // text can only exist if the runner really attempted the resume.
    assert(/ses_gone_forever/.test(String(res.resumeError)), `the result carries the host's reason: ${res.resumeError}`);
    assertEquals(res.result, "fake reply", "the turn itself still ran");
    assertEquals(res.sessionId, "ses_fake_1", "the fallback created the fixture's new session and used it");

    // The SURFACE is told, in words, and the note lands BEFORE the fresh reply
    // it explains — the owner must not read a context-free answer first.
    const note = container.timeline.find((line) => line.startsWith("system:"));
    assert(note, `the surface must be told the session was not restored: ${JSON.stringify(container.timeline)}`);
    assert(/could not be restored/i.test(note), `the note names what happened: ${note}`);
    assert(/ses_gone_forever/.test(note), `the note carries the why: ${note}`);
    const noteAt = container.timeline.indexOf(note);
    const replyAfterNote = container.timeline.findIndex((line, i) => i > noteAt && line.startsWith("agent:"));
    assert(replyAfterNote > noteAt, `the note precedes this turn's fresh reply: ${JSON.stringify(container.timeline)}`);
    assertEquals(container.errors.length, 0, "a fallback is not a hard failure card");

    // The stale hint is replaced, so the NEXT turn resumes the new conversation.
    assertEquals(stored.get("acp:pi-stale"), "ses_fake_1", "the store now points at the new session");
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: two rapid sends for one conversation never prompt concurrently", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-supersede-${Date.now()}.jsonl`;
  const bridge = fixtureBridge({ CAP_ACP_FIXTURE_LOG: logPath });
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
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: two sends arriving while a turn is LIVE leave exactly one winner", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-triple-${Date.now()}.jsonl`;
  const bridge = fixtureBridge({ CAP_ACP_FIXTURE_LOG: logPath, CAP_ACP_FIXTURE_HOLD_TEXT: "held first" });
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
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: a superseded turn renders NO error when its socket is closed", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-leak-${Date.now()}.jsonl`;
  const bridge = fixtureBridge({
    CAP_ACP_FIXTURE_LOG: logPath,
    CAP_ACP_FIXTURE_HOLD_TEXT: "held first",
    CAP_ACP_FIXTURE_IGNORE_CANCEL: "1",
  });
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
  const bridge = fixtureBridge({ CAP_ACP_FIXTURE_LOG: logPath });
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
  const bridge = fixtureBridge({ CAP_ACP_FIXTURE_LOG: logPath, CAP_ACP_FIXTURE_ASK_PERMISSION: "1" });
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
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: auto mode is opt-in and still auto-grants", async () => {
  const bridge = fixtureBridge({ CAP_ACP_FIXTURE_ASK_PERMISSION: "1" });
  const port = (bridge as any).addr.port;
  const container = new MockContainer();
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
    await bridge.shutdown();
  }
});

Deno.test("runAcpTaskTurn: detects harness mismatch and reports requested vs started harness with reinstall command", async () => {
  // Simulate Paul's exact failure: bridge started 'pi' when user clicked 'claude-code'
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade required", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      socket.close(1011, 'adapter for harness "pi" exited: Could not start pi: executable not found (command: /path/to/pi)');
    };
    return response;
  });
  const port = (server as any).addr.port;
  const container = new MockContainer();

  try {
    const res = await runAcpTaskTurn({
      container,
      task: "hello claude",
      harnessId: "claude-code",
      endpoint: `ws://127.0.0.1:${port}/acp`,
    });
    assertEquals(res.ok, false);
    assertEquals(res.requestedHarness, "claude-code");
    assertEquals(res.startedHarness, "pi");
    assert(res.error?.includes('Harness mismatch: requested "claude-code", but running bridge started "pi"'), res.error);
    assert(res.error?.includes("npm run acp:service install --harness claude-code"), res.error);
    assert(res.error?.includes("Could not start pi: executable not found"), res.error);

    assertEquals(container.errors.length, 1);
    assertEquals(container.errors[0].meta.requestedHarness, "claude-code");
    assertEquals(container.errors[0].meta.startedHarness, "pi");
  } finally {
    await server.shutdown();
  }
});

Deno.test("runAcpTaskTurn: requested harness is honoured and completes turn", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;
  const container = new MockContainer();

  try {
    const res = await runAcpTaskTurn({
      container,
      task: "hello claude",
      harnessId: "claude-code",
      endpoint: `ws://127.0.0.1:${port}/acp`,
    });
    assertEquals(res.ok, true, String(res.error));
    assertEquals(res.result, "fake reply");
  } finally {
    await bridge.shutdown();
  }
});


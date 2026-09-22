// tests/acp-end-to-end.test.ts — End-to-end driven test of the ACP client over
// the loopback bridge. TWO modes, both real:
//
//   1. DEFAULT (suite, deterministic): the bridge spawns a fake stdio adapter
//      (tests/fixtures/acp-fake-adapter.mjs) — exercises the full
//      WebSocket→bridge→stdio JSON-RPC plumbing with NO live pi, no tokens,
//      no machine state. Runs on every `npm test`.
//   2. LIVE (opt-in, CAP_ACP_LIVE=1 via `npm run test:acp:live`): drives the
//      REAL pi harness through pi-acp — handshake, skill discovery, streamed
//      thoughts/chunks, a completed turn. Needs pi-acp installed and Paul's
//      pi session; it is NOT part of the default suite for that reason.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { AcpClient, type AcpTurnEvent } from "../extension/lib/acp-client.js";

const LIVE = Deno.env.get("CAP_ACP_LIVE") === "1";
const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));
// The cwd is a protocol string the fake adapter never touches; route it
// through the durable-root convention so the static guard stays honest.
const FIXTURE_CWD = durableDir("acp-fixture");
// All fixture knobs explicitly pinned off so ambient process environment
// can never contaminate this run (chrome-agent-platform-tqfg).
export const CLEAN_FIXTURE_ENV: Record<string, string> = {
  CAP_ACP_FIXTURE_AGENT_NAME: "",
  CAP_ACP_FIXTURE_LOG: "",
  CAP_ACP_FIXTURE_DIE_ON_SPAWN: "0",
  CAP_ACP_FIXTURE_SPAWN_COUNTER: "",
  CAP_ACP_FIXTURE_HOLD_TEXT: "",
  CAP_ACP_FIXTURE_ASK_PERMISSION: "0",
  CAP_ACP_FIXTURE_IGNORE_CANCEL: "0",
};
// The LIVE journey's working directory: DECLARED by the operator as $CAP_ACP_CWD,
// never guessed. It used to fall back to $HOME/journal — this fleet's convention,
// wrong on any machine that keeps its work elsewhere, and the exact default that
// produced Paul's "cwd does not exist on the machine running the agent"
// (chrome-agent-platform-7p7e / 5i9i). The live test fails loudly without it.
const LIVE_CWD = Deno.env.get("CAP_ACP_CWD") ?? "";

Deno.test("ACP End-to-End (fixture): drives a full turn through the loopback bridge", async () => {
  // Fail loudly if any concurrent test published a stray fixture knob to process env.
  const strayEnv = Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("CAP_ACP_FIXTURE_"));
  assertEquals(
    strayEnv,
    [],
    `acp-end-to-end must run in a clean environment without stray fixture knobs: ${strayEnv.join(", ")}`,
  );

  // Kernel-assigned port (never a fixed literal): two lanes, or a stray
  // process, can never collide on it. All knobs pinned cleanly.
  const bridge = createAcpServer(0, FAKE_ADAPTER, CLEAN_FIXTURE_ENV);
  const TEST_PORT = (bridge as any).addr.port;

  const client = new AcpClient({
    url: `ws://127.0.0.1:${TEST_PORT}/acp`,
    defaultCwd: FIXTURE_CWD,
  });

  const events: AcpTurnEvent[] = [];

  try {
    // 1. Connect over WebSocket
    await client.connect();
    assertEquals(client.connected, true);

    // 2. Handshake
    const init = await client.initialize();
    assertEquals(init.protocolVersion, 1);
    assertEquals(client.agentInfo?.name, "fake-acp-adapter");

    // 3. New session + command advertisement
    const session = await client.newSession({ cwd: FIXTURE_CWD });
    assertEquals(session.sessionId, "ses_fake_1");
    await new Promise((r) => setTimeout(r, 50));
    assert(client.availableCommands.length > 0, "adapter must advertise available commands");
    assert(
      client.availableCommands.some((c: any) => c.name === "skill:beads"),
      "advertised commands must include the fixture skills",
    );

    // 4. Prompt turn with streamed updates
    const turn = await client.prompt(
      session.sessionId,
      "fixture prompt",
      (ev) => events.push(ev),
    );

    assertEquals(turn.stopReason, "end_turn");
    assertEquals(turn.text, "fake reply");
    assert(events.some((e) => e.kind === "thought"), "must stream a thought chunk");
    assert(events.some((e) => e.kind === "tool"), "must stream a tool call");
    assert(events.some((e) => e.kind === "chunk"), "must stream a message chunk");

    // 5. Session resume round-trips across a reconnect (the runner's lifecycle)
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    const client2 = new AcpClient({ url: `ws://127.0.0.1:${TEST_PORT}/acp`, defaultCwd: FIXTURE_CWD });
    await client2.connect();
    await client2.initialize();
    const loaded = await client2.loadSession({ sessionId: session.sessionId, cwd: FIXTURE_CWD });
    assertEquals(loaded.resumed, true);
    client2.close();
  } finally {
    client.close();
    await bridge.shutdown();
  }
});

Deno.test("ACP tool servers: Pi refuses new/load before the adapter; empty Pi and other adapters still work", async () => {
  const servers = [
    { name: "stdio-probe", command: "unused-command", args: [], env: [] },
    { name: "http-probe", type: "http", url: "https://tools.invalid/secret-probe", headers: [] },
    { name: "sse-probe", type: "sse", url: "https://tools.invalid/secret-probe", headers: [] },
  ];
  // Inverse control: labelling a fixed non-Pi adapter "pi" must not block it.
  // This proves the decision follows the actual adapter, not a renamed URL key.
  for (const [adapter, names] of [
    ["pi-acp", ["pi", "Pi", "pi-acp", "not-a-harness", "claude-code"]],
    ["claude-agent-acp", ["claude-code", "pi"]],
    ["codex-acp", ["codex", "pi"]],
  ] as const) {
    const logPath = `${durableDir("acp-tool-server-refusal")}/frames-${crypto.randomUUID()}.jsonl`;
    const bridge = createAcpServer(0, FAKE_ADAPTER, {
      ...CLEAN_FIXTURE_ENV, CAP_ACP_FIXTURE_LOG: logPath, CAP_ACP_FIXTURE_AGENT_NAME: adapter,
    });
    let expectedForwards = 0;
    try {
    for (const harness of names) {
      const client = new AcpClient({ url: `ws://127.0.0.1:${bridge.addr.port}/acp?harness=${harness}`, requestTimeoutMs: 5000 });
      try {
        await client.connect();
        if (harness === "not-a-harness") {
          await assertRejects(() => client.newSession({ mcpServers: servers }), Error,
            "CAP cannot identify this custom adapter");
        }
        await client.initialize();
        for (const server of servers) {
          for (const method of ["session/new", "session/load"]) {
            const params = { cwd: FIXTURE_CWD, sessionId: "ses_fake_1", mcpServers: [server] };
            const request = () => method === "session/new" ? client.newSession(params) : client.loadSession(params);
            if (adapter === "pi-acp") {
              const err = await assertRejects(request, Error,
                "Pi's ACP adapter does not mount supplied MCP servers");
              assert(err.message.includes("Claude Code or Codex"), "refusal must name a supported alternative");
              assert(err.message.includes("local tools only"), "empty-server remedy must disclose its limitation");
              assert(!err.message.includes("secret-probe"), "do not echo server configuration into the error");
              assertEquals(client.activeSessionId, null, "rejected requests must not activate a session");
            } else {
              await request();
              expectedForwards++;
            }
          }
        }
        // A refusal does not kill the connection or silently strip the servers
        // and retry. Deliberate empty-server sessions remain a valid choice.
        const empty = await client.newSession({ cwd: FIXTURE_CWD, mcpServers: [] });
        assertEquals(empty.sessionId, "ses_fake_1");
        assertEquals((await client.loadSession({ sessionId: empty.sessionId, mcpServers: [] })).resumed, true);
        const frames = Deno.readTextFileSync(logPath).trim().split("\n").map((line) => JSON.parse(line));
        const forwarded = frames.filter((f) => f.dir === "in" && f.msg.params?.mcpServers?.length);
        assertEquals(forwarded.length, expectedForwards,
          "the adapter itself must see no rejected requests, but every supported request");
        if (adapter !== "pi-acp") {
          assertEquals(forwarded.slice(-6).map((f) => f.msg.params.mcpServers), servers.flatMap((s) => [[s], [s]]),
            "supported adapters receive the original descriptors unchanged");
        }
      } finally { client.close(); }
    }
    } finally { await bridge.shutdown(); }
  }
});

Deno.test({
  name: "ACP End-to-End (LIVE pi): drives real pi harness turn via loopback bridge",
  // Registered-but-ignored by default: the live journey needs pi-acp + a live
  // pi session and spends real tokens, so it is opt-in (npm run test:acp:live).
  // An ignored test is LOUD — it reports as ignored, never as passed.
  ignore: !LIVE,
  fn: async () => {
  assert(LIVE_CWD, "set CAP_ACP_CWD (or $HOME) — the live journey needs a working directory");

  const bridge = createAcpServer(0);
  const TEST_PORT = (bridge as any).addr.port;

  const client = new AcpClient({
    url: `ws://127.0.0.1:${TEST_PORT}/acp`,
    defaultCwd: LIVE_CWD,
  });

  const events: AcpTurnEvent[] = [];

  try {
    // 1. Connect over WebSocket
    await client.connect();
    assertEquals(client.connected, true);

    // 2. Handshake
    const init = await client.initialize();
    assertEquals(init.protocolVersion, 1);
    assertEquals(client.agentInfo?.name, "pi-acp");
    console.log(`[test] Handshake complete with agent: ${client.agentInfo?.title} (${client.agentInfo?.version})`);

    // 3. New Session
    const session = await client.newSession({ cwd: LIVE_CWD });
    assert(session.sessionId.length > 0);
    console.log(`[test] Session created: ${session.sessionId}`);

    // Wait briefly for available_commands_update if in flight
    await new Promise((r) => setTimeout(r, 600));
    assert(client.availableCommands.length > 0, "pi must advertise available commands/skills");
    const hasBeads = client.availableCommands.some((c: any) => c.name?.includes("beads"));
    assert(hasBeads, "pi's local skills (e.g. skill:beads) must be visible to the ACP client");
    console.log(`[test] Verified skills discovered: ${client.availableCommands.length} commands (including beads)`);

    // 4. Prompt Turn
    const turn = await client.prompt(
      session.sessionId,
      "Reply with 'ACP test OK' and exit turn.",
      (ev) => {
        events.push(ev);
        if (ev.kind === "chunk") console.log(`[test-stream chunk] ${ev.text}`);
        if (ev.kind === "thought") console.log(`[test-stream thought] ${ev.text}`);
      },
    );

    assertEquals(turn.stopReason, "end_turn");
    assert(turn.text.length > 0, "Turn must produce agent text");
    console.log(`[test] Turn completed successfully with stopReason: ${turn.stopReason}`);
    console.log(`[test] Full collected response: "${turn.text}"`);

    // Assert that events were received
    const hasChunks = events.some((e) => e.kind === "chunk");
    assert(hasChunks, "Must have streamed at least one message chunk");
  } finally {
    client.close();
    await bridge.shutdown();
  }
  },
});

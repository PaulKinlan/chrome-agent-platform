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

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { AcpClient, type AcpTurnEvent } from "../extension/lib/acp-client.js";

const LIVE = Deno.env.get("CAP_ACP_LIVE") === "1";
const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));
// The cwd is a protocol string the fake adapter never touches; route it
// through the durable-root convention so the static guard stays honest.
const FIXTURE_CWD = durableDir("acp-fixture");
// The LIVE journey's working directory: $CAP_ACP_CWD, else $HOME/journal
// resolved at RUN time (a machine path is never a source literal, 3khn).
const HOME_ENV = Deno.env.get("HOME") ?? "";
const LIVE_CWD = Deno.env.get("CAP_ACP_CWD") ?? (HOME_ENV ? `${HOME_ENV}/journal` : "");

Deno.test("ACP End-to-End (fixture): drives a full turn through the loopback bridge", async () => {
  // Kernel-assigned port (never a fixed literal): two lanes, or a stray
  // process, can never collide on it.
  const bridge = createAcpServer(0, FAKE_ADAPTER);
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

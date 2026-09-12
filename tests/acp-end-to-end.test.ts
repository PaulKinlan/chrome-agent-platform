// tests/acp-end-to-end.test.ts — End-to-end driven test connecting AcpClient to live pi harness via ACP bridge.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { AcpClient, type AcpTurnEvent } from "../extension/lib/acp-client.js";

Deno.test("ACP End-to-End: drives real pi harness turn via loopback bridge", async () => {
  const TEST_PORT = 3218;
  const bridge = createAcpServer(TEST_PORT);

  const client = new AcpClient({
    url: `ws://127.0.0.1:${TEST_PORT}/acp`,
    defaultCwd: "/home/paulkinlan/journal",
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
    const session = await client.newSession({ cwd: "/home/paulkinlan/journal" });
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
});

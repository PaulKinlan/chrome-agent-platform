// cap-evidence/acp-resume-probe.ts — TEMPORARY live probe: does session/load
// restore pi conversation memory AFTER the adapter process was killed (the
// exact per-turn lifecycle acp-runner.js uses: connect → prompt → close)?
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { AcpClient } from "../extension/lib/acp-client.js";

const bridge = createAcpServer(0);
const port = (bridge as any).addr.port;
const cwd = "/home/paulkinlan/journal";

async function connectClient() {
  const c = new AcpClient({ url: `ws://127.0.0.1:${port}/acp`, defaultCwd: cwd });
  await c.connect();
  await c.initialize();
  return c;
}

try {
  // Turn 1: fresh session, plant a memory
  const c1 = await connectClient();
  const s1 = await c1.newSession({ cwd });
  console.log(`[probe] session id: ${s1.sessionId}`);
  const t1 = await c1.prompt(s1.sessionId, "Remember the word kumquat-4242 and reply just 'stored'.");
  console.log(`[probe] turn1: "${t1.text}" (stopReason=${t1.stopReason})`);
  c1.close();
  // Adapter killed by bridge on close — wait for SIGTERM to land
  await new Promise((r) => setTimeout(r, 1500));

  // Turn 2: NEW connection (fresh adapter process), load the same session
  const c2 = await connectClient();
  try {
    await c2.loadSession({ sessionId: s1.sessionId, cwd });
    console.log("[probe] loadSession: OK");
    const t2 = await c2.prompt(
      s1.sessionId,
      "What was the word I asked you to remember? Reply with ONLY the word.",
    );
    console.log(`[probe] turn2: "${t2.text}"`);
    const ok = /kumquat-?4242/.test(t2.text);
    console.log(`[probe] RESUME MEMORY: ${ok ? "PASS — session restored across adapter restart" : "FAIL — memory lost"}`);
    if (!ok) Deno.exit(1);
  } catch (e) {
    console.log(`[probe] loadSession FAILED: ${e?.message ?? e}`);
    Deno.exitCode = 1;
  } finally {
    c2.close();
  }
} finally {
  await bridge.shutdown();
}

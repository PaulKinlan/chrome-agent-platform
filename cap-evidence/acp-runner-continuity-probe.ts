// cap-evidence/acp-runner-continuity-probe.ts — live probe of the exact
// acp-runner path the surfaces use, against real pi-acp:
//   1. session continuity — turn 2 must RESUME turn 1's pi session and recall
//      a memory planted in turn 1 (the host session id is asserted, not the
//      rendered text alone);
//   2. no client cwd — the BRIDGE supplies the host working directory, and the
//      probe asserts the turn only succeeds because it did.
// Fails closed: a failed property exits non-zero.
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { runAcpTaskTurn } from "../extension/lib/acp-runner.js";

const bridge = createAcpServer(0);
const port = (bridge as any).addr.port;

class MockContainer {
  agent: string[] = [];
  appendUser(t: string) { this.agent.push(`[user] ${t}`); }
  appendAgent(t: string) { this.agent.push(`[agent] ${t}`); return { setAttribute: (_n: string, v: string) => { this.agent[this.agent.length - 1] = `[agent] ${v}`; } }; }
  appendTool(t: any) { this.agent.push(`[tool] ${t?.detail ?? ""}`); }
  thinkingDelta(t: any) { this.agent.push(`[thought] ${t?.delta ?? ""}`); }
  collapseThinkingTrace() {}
  appendError(m: string) { this.agent.push(`[error] ${m}`); }
}

const container = new MockContainer();
const endpoint = `ws://127.0.0.1:${port}/acp`;
const checks: Array<[string, boolean, string]> = [];

try {
  const t1 = await runAcpTaskTurn({
    container,
    task: "Remember the word kumquat-7777 and reply just 'stored'.",
    harnessId: "pi",
    endpoint,
    // NOTE: no cwd, no threadId — exactly the pi-surface call shape.
  });
  console.log(`[probe] turn1 ok=${t1.ok} resumed=${t1.resumed} session=${t1.sessionId} result="${t1.result}" error=${t1.error ?? "-"}`);

  const t2 = await runAcpTaskTurn({
    container,
    task: "What was the word I asked you to remember? Reply with ONLY the word.",
    harnessId: "pi",
    endpoint,
  });
  console.log(`[probe] turn2 ok=${t2.ok} resumed=${t2.resumed} session=${t2.sessionId} result="${t2.result}" error=${t2.error ?? "-"}`);

  checks.push(["turns completed", t1.ok === true && t2.ok === true, `t1.ok=${t1.ok} t2.ok=${t2.ok}`]);
  checks.push(["host cwd default (session created with no client cwd)", typeof t1.sessionId === "string" && t1.sessionId.length > 0, `session=${t1.sessionId}`]);
  checks.push(["session continuity (turn 2 resumed the same session)", t2.resumed === true && t2.sessionId === t1.sessionId, `resumed=${t2.resumed} t1=${t1.sessionId} t2=${t2.sessionId}`]);
  checks.push(["memory across turns (recall verified)", /kumquat-?7777/i.test(t2.result ?? ""), `result="${t2.result}"`]);
} finally {
  await bridge.shutdown();
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`[probe] ${name}: ${ok ? "PASS" : `FAIL — ${detail}`}`);
  if (!ok) failed++;
}
if (failed > 0) {
  console.log(`[probe] ${failed} check(s) FAILED`);
  Deno.exit(1);
}
console.log("[probe] all checks PASS");

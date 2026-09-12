// cap-evidence/acp-runner-continuity-probe.ts — TEMPORARY live probe of the
// exact acp-runner path the NTP uses (no cwd passed, no threadId):
//   1. host-side cwd default — the bridge must fill session/new's cwd ($HOME/journal)
//   2. per-harness session continuity — turn 2 must RESUME turn 1's pi session
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { runAcpTaskTurn } from "../extension/lib/acp-runner.js";

const bridge = createAcpServer(3226);

class MockContainer {
  agent = [];
  appendUser(t: string) { this.agent.push(`[user] ${t}`); }
  appendAgent(t: string) { this.agent.push(`[agent] ${t}`); return { setAttribute: (_n: string, v: string) => { this.agent[this.agent.length - 1] = `[agent] ${v}`; } }; }
  appendTool(t: any) { this.agent.push(`[tool] ${t?.detail ?? ""}`); }
  thinkingDelta(t: any) { this.agent.push(`[thought] ${t?.delta ?? ""}`); }
  collapseThinkingTrace() {}
  appendError(m: string) { this.agent.push(`[error] ${m}`); }
}

const container = new MockContainer();
const endpoint = "ws://127.0.0.1:3226/acp";

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

  const cwdOk = t1.ok && t1.sessionId?.length > 0;
  const resumeOk = t2.resumed === true;
  const memoryOk = /kumquat-?7777/i.test(t2.result ?? "");
  console.log(`[probe] HOST CWD DEFAULT: ${cwdOk ? "PASS — session created with no client cwd" : "FAIL"}`);
  console.log(`[probe] SESSION CONTINUITY: ${resumeOk ? "PASS — turn 2 resumed the session" : "FAIL — turn 2 did not resume"}`);
  console.log(`[probe] MEMORY ACROSS TURNS: ${memoryOk ? "PASS — recall verified" : "FAIL — memory lost"}`);
} finally {
  await bridge.shutdown();
}

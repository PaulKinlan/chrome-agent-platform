// tests/acp-runner.test.ts — Unit tests for the ACP UI runner.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { acpSessionKey, runAcpTaskTurn } from "../extension/lib/acp-runner.js";

Deno.test("acpSessionKey: thread-scoped inside a persisted thread, per-harness otherwise", () => {
  // Inside a persisted task thread the key is the threadId — two different
  // threads are two conversations.
  assertEquals(acpSessionKey("thread-1", "pi"), "thread-1");
  assertEquals(acpSessionKey("thread-2", "pi"), "thread-2");
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
      setAttribute: (name: string, val: string) => {
        if (name === "content") {
          this.agentMessages[this.agentMessages.length - 1] = val;
        }
      },
    };
    this.agentMessages.push(text);
    return bubble;
  }

  appendTool(tool: any) {
    this.tools.push(tool);
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

Deno.test("runAcpTaskTurn: reports clear actionable error when harness is unreachable", async () => {
  const container = new MockContainer();
  const statuses: any[] = [];

  const res = await runAcpTaskTurn({
    container,
    task: "Say hello",
    endpoint: "ws://127.0.0.1:59999/unreachable", // non-existent port
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

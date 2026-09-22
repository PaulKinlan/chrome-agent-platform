// tests/acp-bridge-mcp-isolation.test.ts — a CAP-spawned harness session must
// not inherit the machine's MCP config, because on this machine that config
// hands the harness a browser-automation server that launches its own headless
// Chrome. The owner's stated architecture is the opposite: the tools live in
// the client, the harness asks, and the request routes back to the client,
// which acts on the tab the owner is looking at. "A local process asking to run
// Google Chrome" is the rejected behaviour (owner-reported 2026-09-22).
//
// Two layers are pinned, and they are different claims:
//   1. the RULE (which harness gets isolated, what counts as browser-launching)
//      — pure, over the exported functions;
//   2. the WIRING (that the env actually reaches the spawned adapter child)
//      — driven against a real bridge and a real child process, because a rule
//        that is never applied is exactly the defect this repo keeps finding.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createAcpServer,
  harnessMcpIsolationEnv,
  PI_MCP_EXCLUSIVE_ENV,
} from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

Deno.test("harnessMcpIsolationEnv: pi is isolated, the ACP-injectable harnesses are not", () => {
  // pi-acp 0.0.33 stores `params.mcpServers` and never reads them, and pi reads
  // its own host MCP config, so isolation is the only control that reaches it.
  assertEquals(harnessMcpIsolationEnv("pi"), { [PI_MCP_EXCLUSIVE_ENV]: "exclusive" });

  // claude-agent-acp and codex-acp DO thread `mcpServers` through to their
  // harness, so CAP controls those by injection. Isolating them too would strip
  // servers the operator configured for no reason.
  assertEquals(harnessMcpIsolationEnv("claude-code"), {});
  assertEquals(harnessMcpIsolationEnv("codex"), {});

  // An unknown harness is not guessed at.
  assertEquals(harnessMcpIsolationEnv("not-a-harness"), {});
  assertEquals(harnessMcpIsolationEnv(""), {});
});


Deno.test("createAcpServer: the isolation env REACHES the pi adapter child, and only for pi", async () => {
  // A mock adapter that records the environment it was actually spawned with.
  // Reading the rule function would only prove the rule; this proves the wiring.
  const dir = durableDir("acp-mcp-isolation-fixture");
  const logFor = (harness: string) => `${dir}/env-${harness}.json`;
  const mockAdapter = `${dir}/mock-adapter.mjs`;
  Deno.writeTextFileSync(
    mockAdapter,
    `import { writeFileSync } from "node:fs";
const out = process.env.PI_ACP_HARNESS === "pi"
  ? ${JSON.stringify(logFor("pi"))}
  : ${JSON.stringify(logFor("claude-code"))};
writeFileSync(out, JSON.stringify({
  harness: process.env.PI_ACP_HARNESS,
  isolation: process.env.PI_MCP_CONFIG_MODE ?? null,
}));
process.exit(0);
`,
  );

  const server = createAcpServer(0, mockAdapter);
  const port = (server as any).addr.port;
  try {
    for (const harness of ["pi", "claude-code"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp?harness=${harness}`);
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        ws.onclose = done;
        ws.onerror = done;
        // The mock exits immediately; the bridge closes on adapter exit.
        setTimeout(done, 5000);
      });
    }

    const piEnv = JSON.parse(Deno.readTextFileSync(logFor("pi")));
    assertEquals(piEnv.harness, "pi", "the mock must report the harness it ran as");
    assertEquals(
      piEnv.isolation,
      "exclusive",
      "a pi session must be spawned with host MCP discovery off, or the machine's chrome-devtools-mcp launches a second browser",
    );

    const claudeEnv = JSON.parse(Deno.readTextFileSync(logFor("claude-code")));
    assertEquals(claudeEnv.harness, "claude-code");
    assertEquals(
      claudeEnv.isolation,
      null,
      "claude-code takes its servers from ACP, so it must NOT be isolated — isolating it would strip the operator's own servers",
    );
  } finally {
    await server.shutdown();
  }
});

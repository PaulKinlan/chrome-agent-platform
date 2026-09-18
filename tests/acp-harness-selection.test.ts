// tests/acp-harness-selection.test.ts — chrome-agent-platform-lpmv:
// Verification that clicking Claude or Codex honours the selected harness,
// or makes any bridge process mismatch completely legible and actionable.
//
// Root Cause: acp-bridge.ts previously fixed the harness at process level
// (defaulting to "pi"), so a background service installed with `--harness pi`
// served the pi adapter no matter what the extension UI requested, and errors
// named "pi" instead of the clicked harness.
//
// Solved in both directions:
// 1. Bridge honours per-connection harness selection via `?harness=...`.
// 2. Extension acp-runner passes selected `harnessId` in WebSocket upgrade URL.
// 3. Adapter exit / spawn errors explicitly name the harness actually started.
// 4. Runner detects any harness mismatch and reports:
//    - The requested harness
//    - The actually started harness
//    - The exact one-command remediation: `npm run acp:service install --harness <harness>`
// 5. Bridge /health endpoint supports `?harness=...` probe and reports `supportsHarnessSelection`.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { clipCloseReason, createAcpServer, HARNESS_ADAPTERS } from "../scripts/acp-bridge.ts";
import { acpEndpointWithHarness, acpHealthUrl, probeAcpBridgeHealth, runAcpTaskTurn } from "../extension/lib/acp-runner.js";

const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

Deno.test("acp harness selection (direction 1): bridge honours per-connection ?harness= query", async () => {
  // Use mock adapter that writes out process.env.PI_ACP_HARNESS
  const dir = durableDir("acp-selection-probe");
  const logFile = `${dir}/harness-selected.json`;
  const adapterPath = `${dir}/adapter-probe.mjs`;
  Deno.writeTextFileSync(
    adapterPath,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({
  PI_ACP_HARNESS: process.env.PI_ACP_HARNESS,
}));
process.exit(0);
`,
  );

  const server = createAcpServer(0, adapterPath);
  const port = (server as any).addr.port;

  try {
    // 1. Connect requesting claude-code
    const wsClaude = new WebSocket(`ws://127.0.0.1:${port}/acp?harness=claude-code`);
    await new Promise<void>((resolve) => {
      wsClaude.onclose = (ev) => {
        assert(ev.reason.includes('adapter for harness "claude-code" exited'), ev.reason);
        resolve();
      };
    });
    const loggedClaude = JSON.parse(Deno.readTextFileSync(logFile));
    assertEquals(loggedClaude.PI_ACP_HARNESS, "claude-code");

    // 2. Connect requesting codex
    const wsCodex = new WebSocket(`ws://127.0.0.1:${port}/acp?harness=codex`);
    await new Promise<void>((resolve) => {
      wsCodex.onclose = (ev) => {
        assert(ev.reason.includes('adapter for harness "codex" exited'), ev.reason);
        resolve();
      };
    });
    const loggedCodex = JSON.parse(Deno.readTextFileSync(logFile));
    assertEquals(loggedCodex.PI_ACP_HARNESS, "codex");

    // 3. Connect requesting pi (default)
    const wsPi = new WebSocket(`ws://127.0.0.1:${port}/acp`);
    await new Promise<void>((resolve) => {
      wsPi.onclose = (ev) => {
        assert(ev.reason.includes('adapter for harness "pi" exited'), ev.reason);
        resolve();
      };
    });
    const loggedPi = JSON.parse(Deno.readTextFileSync(logFile));
    assertEquals(loggedPi.PI_ACP_HARNESS, "pi");
  } finally {
    await server.shutdown();
  }
});

Deno.test("acp harness selection (direction 1): runAcpTaskTurn drives full turn for claude-code and codex", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER);
  const port = (bridge as any).addr.port;

  const mockContainer = {
    appendUser: () => {},
    appendAgent: () => {},
    appendTool: () => {},
    thinkingDelta: () => {},
    collapseThinkingTrace: () => {},
    appendError: () => {},
    appendSystem: () => {},
  };

  try {
    // Turn for claude-code
    const resClaude = await runAcpTaskTurn({
      container: mockContainer,
      task: "test claude turn",
      harnessId: "claude-code",
      endpoint: `ws://127.0.0.1:${port}/acp`,
    });
    assertEquals(resClaude.ok, true, String(resClaude.error));
    assertEquals(resClaude.result, "fake reply");

    // Turn for codex
    const resCodex = await runAcpTaskTurn({
      container: mockContainer,
      task: "test codex turn",
      harnessId: "codex",
      endpoint: `ws://127.0.0.1:${port}/acp`,
    });
    assertEquals(resCodex.ok, true, String(resCodex.error));
    assertEquals(resCodex.result, "fake reply");
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("acp harness selection (direction 2): unservable/unknown harness rejected with 400 naming known harnesses", async () => {
  const server = createAcpServer(0);
  const port = (server as any).addr.port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/acp?harness=not-a-real-harness`);
    assertEquals(res.status, 400);
    const body = await res.text();
    assert(body.includes('unknown harness "not-a-real-harness"'), body);
    for (const known of Object.keys(HARNESS_ADAPTERS)) {
      assert(body.includes(known), `must name known harness ${known}`);
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("acp harness selection (direction 2): mismatch between requested harness and running bridge is legible with one-command fix", async () => {
  // Simulates Paul's exact reported error on macOS:
  // User clicked "Claude" or "Codex", but the bridge running as LaunchAgent
  // started "pi", which exited with "Could not start pi: executable not found".
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Upgrade required", { status: 426 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      // Bridge reports it started "pi"
      socket.close(
        1011,
        clipCloseReason(
          'adapter for harness "pi" exited: Internal error: Could not start pi: executable not found (command: /Users/paulkinlan/.local/bin/pi)',
        ),
      );
    };
    return response;
  });
  const port = (server as any).addr.port;

  const capturedErrors: any[] = [];
  const mockContainer = {
    appendUser: () => {},
    appendAgent: () => {},
    appendTool: () => {},
    thinkingDelta: () => {},
    collapseThinkingTrace: () => {},
    appendError: (msg: string, meta: any) => capturedErrors.push({ msg, meta }),
    appendSystem: () => {},
  };

  try {
    const res = await runAcpTaskTurn({
      container: mockContainer,
      task: "run code in claude",
      harnessId: "claude-code",
      endpoint: `ws://127.0.0.1:${port}/acp`,
    });

    assertEquals(res.ok, false);
    assertEquals(res.requestedHarness, "claude-code");
    assertEquals(res.startedHarness, "pi");

    // Must clearly state the mismatch
    assert(
      res.error?.includes('Harness mismatch: requested "claude-code", but running bridge started "pi"'),
      `error must describe mismatch: ${res.error}`,
    );

    // Must offer the exact one-command fix
    assert(
      res.error?.includes("npm run acp:service install --harness claude-code"),
      `error must suggest reinstallation: ${res.error}`,
    );

    // Must retain the raw underlying error
    assert(
      res.error?.includes("Could not start pi: executable not found"),
      `error must preserve original failure text: ${res.error}`,
    );

    // Error card metadata in container must attribute both harnesses
    assertEquals(capturedErrors.length, 1);
    assertEquals(capturedErrors[0].meta.requestedHarness, "claude-code");
    assertEquals(capturedErrors[0].meta.startedHarness, "pi");
  } finally {
    await server.shutdown();
  }
});

Deno.test("acp harness selection (legibility): /health endpoint reports default and per-harness probe info", async () => {
  const server = createAcpServer(0);
  const port = (server as any).addr.port;
  try {
    const defaultHealth = await probeAcpBridgeHealth(`ws://127.0.0.1:${port}/acp`);
    assertEquals(defaultHealth.ok, true);
    assertEquals(defaultHealth.harness, "pi");
    assertEquals(defaultHealth.supportsHarnessSelection, true);
    assertEquals(defaultHealth.knownHarnesses, ["pi", "claude-code", "codex"]);

    const claudeHealth = await probeAcpBridgeHealth(`ws://127.0.0.1:${port}/acp`, "claude-code");
    assertEquals(claudeHealth.ok, true);
    assertEquals(claudeHealth.harness, "pi");
    assertEquals(claudeHealth.probeHarness, "claude-code");
    assertEquals(claudeHealth.harnessCli, "claude");

    const codexHealth = await probeAcpBridgeHealth(`ws://127.0.0.1:${port}/acp`, "codex");
    assertEquals(codexHealth.ok, true);
    assertEquals(codexHealth.harness, "pi");
    assertEquals(codexHealth.probeHarness, "codex");
    assertEquals(codexHealth.harnessCli, "codex");
  } finally {
    await server.shutdown();
  }
});

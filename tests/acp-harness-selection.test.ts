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
import { TEST_BRIDGE_TOKEN } from "./fixtures/acp-bridge-token.ts";

/** jsjy: the bridge refuses an unauthenticated upgrade, so clients carry the secret on the endpoint. */
const authedEndpoint = (port: number | string, harness?: string) =>
  `ws://127.0.0.1:${port}/acp?token=${TEST_BRIDGE_TOKEN}${harness ? `&harness=${harness}` : ""}`;
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

  const server = createAcpServer(0, adapterPath, {}, "", TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    // 1. Connect requesting claude-code
    const wsClaude = new WebSocket(authedEndpoint(port, "claude-code"));
    await new Promise<void>((resolve) => {
      wsClaude.onclose = (ev) => {
        assert(ev.reason.includes('adapter for harness "claude-code" exited'), ev.reason);
        resolve();
      };
    });
    const loggedClaude = JSON.parse(Deno.readTextFileSync(logFile));
    assertEquals(loggedClaude.PI_ACP_HARNESS, "claude-code");

    // 2. Connect requesting codex
    const wsCodex = new WebSocket(authedEndpoint(port, "codex"));
    await new Promise<void>((resolve) => {
      wsCodex.onclose = (ev) => {
        assert(ev.reason.includes('adapter for harness "codex" exited'), ev.reason);
        resolve();
      };
    });
    const loggedCodex = JSON.parse(Deno.readTextFileSync(logFile));
    assertEquals(loggedCodex.PI_ACP_HARNESS, "codex");

    // 3. Connect requesting pi (default)
    const wsPi = new WebSocket(authedEndpoint(port));
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
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", TEST_BRIDGE_TOKEN);
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
      endpoint: authedEndpoint(port),
    });
    assertEquals(resClaude.ok, true, String(resClaude.error));
    assertEquals(resClaude.result, "fake reply");

    // Turn for codex
    const resCodex = await runAcpTaskTurn({
      container: mockContainer,
      task: "test codex turn",
      harnessId: "codex",
      endpoint: authedEndpoint(port),
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
      endpoint: authedEndpoint(port),
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
    const defaultHealth = await probeAcpBridgeHealth(authedEndpoint(port));
    assertEquals(defaultHealth.ok, true);
    assertEquals(defaultHealth.harness, "pi");
    assertEquals(defaultHealth.supportsHarnessSelection, true);
    assertEquals(defaultHealth.knownHarnesses, ["pi", "claude-code", "codex"]);
    assertEquals(defaultHealth.adapterPresent, null);

    const claudeHealth = await probeAcpBridgeHealth(authedEndpoint(port), "claude-code");
    assertEquals(claudeHealth.ok, true);
    assertEquals(claudeHealth.harness, "pi");
    assertEquals(claudeHealth.probeHarness, "claude-code");
    assertEquals(claudeHealth.harnessCli, "claude");
    assertEquals(claudeHealth.adapterPresent, null);

    const codexHealth = await probeAcpBridgeHealth(authedEndpoint(port), "codex");
    assertEquals(codexHealth.ok, true);
    assertEquals(codexHealth.harness, "pi");
    assertEquals(codexHealth.probeHarness, "codex");
    assertEquals(codexHealth.harnessCli, "codex");
    assertEquals(codexHealth.adapterPresent, null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("57g6b: prototype-key ?harness= names (constructor/toString/hasOwnProperty) are refused by /health and /acp", async () => {
  const server = createAcpServer(0, undefined, {}, "", TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;
  try {
    for (const protoKey of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      // 1. /health endpoint: must not report false green (adapterPresent: false, adapter: "(unresolved)")
      const healthRes = await fetch(`http://127.0.0.1:${port}/health?harness=${encodeURIComponent(protoKey)}`);
      assertEquals(healthRes.status, 200);
      const healthJson = await healthRes.json();
      assertEquals(healthJson.ok, true);
      assertEquals(healthJson.adapterPresent, false, `adapterPresent must be false for ${protoKey}`);
      assertEquals(healthJson.adapter, "(unresolved)", `adapter must be (unresolved) for ${protoKey}`);
      assert(healthJson.error?.includes(`unknown harness "${protoKey}"`), `error must name unknown harness for ${protoKey}`);
      assertEquals(healthJson.harnessCli, null);
      assertEquals(healthJson.harnessCliPath, null);

      // 2. /acp endpoint: must reject with HTTP 400 unknown harness instead of bypassing guard
      const acpRes = await fetch(`http://127.0.0.1:${port}/acp?token=${TEST_BRIDGE_TOKEN}&harness=${encodeURIComponent(protoKey)}`, {
        headers: { "Authorization": `Bearer ${TEST_BRIDGE_TOKEN}` },
      });
      assertEquals(acpRes.status, 400);
      const acpText = await acpRes.text();
      assert(acpText.includes(`ACP Bridge: unknown harness "${protoKey}"`), `acp response must refuse ${protoKey}: ${acpText}`);
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("akodp: /health adapterPresent distinguishes npx registry packages (null) from node adapters (boolean)", async () => {
  // 1. Unpinned bridge: npx registry packages (pi, claude-code, codex) report adapterPresent: null
  // because availability is determined at run time by npx, not claimed by the bridge at boot.
  const server = createAcpServer(0);
  const port = (server as any).addr.port;
  try {
    for (const harness of ["pi", "claude-code", "codex"]) {
      const res = await fetch(`http://127.0.0.1:${port}/health?harness=${harness}`);
      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.ok, true);
      assertEquals(json.probeHarness, harness);
      assertEquals(json.adapterPresent, null, `adapterPresent must be null for npx harness ${harness}`);
      assert(typeof json.adapter === "string" && json.adapter.includes("via"), `adapter describe must name npx resolver for ${harness}`);
      assertEquals(json.error, undefined);
    }

    // Invalid harness probe: adapterPresent must be false, error must be set
    const badRes = await fetch(`http://127.0.0.1:${port}/health?harness=not-a-real-harness`);
    assertEquals(badRes.status, 200);
    const badJson = await badRes.json();
    assertEquals(badJson.ok, true);
    assertEquals(badJson.adapterPresent, false);
    assertEquals(badJson.adapter, "(unresolved)");
    assert(badJson.error?.includes('unknown harness "not-a-real-harness"'));
  } finally {
    await server.shutdown();
  }

  // 2. Bridge pinned to existing node adapter file: reports adapterPresent: true
  const existingPath = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));
  const pinnedServer = createAcpServer(0, existingPath);
  const pinnedPort = (pinnedServer as any).addr.port;
  try {
    const res = await fetch(`http://127.0.0.1:${pinnedPort}/health`);
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.ok, true);
    assertEquals(json.pinnedAdapter, true);
    assertEquals(json.adapterPresent, true, "adapterPresent must be true when node adapter file exists");
    assertEquals(json.adapter, existingPath);
    assertEquals(json.error, undefined);
  } finally {
    await pinnedServer.shutdown();
  }

  // 3. Bridge pinned to missing node adapter file: reports adapterPresent: false with error
  const missingPath = fromFileUrl(new URL("./fixtures/non-existent-adapter-missing.mjs", import.meta.url));
  const missingServer = createAcpServer(0, missingPath);
  const missingPort = (missingServer as any).addr.port;
  try {
    const res = await fetch(`http://127.0.0.1:${missingPort}/health`);
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.ok, true);
    assertEquals(json.pinnedAdapter, true);
    assertEquals(json.adapterPresent, false, "adapterPresent must be false when node adapter file is missing");
    assert(json.error?.length > 0, "error must report stat failure for missing adapter file");
  } finally {
    await missingServer.shutdown();
  }
});

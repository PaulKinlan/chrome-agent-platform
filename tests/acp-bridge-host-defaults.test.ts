// tests/acp-bridge-host-defaults.test.ts — the bridge's host-side session
// defaults: a session request that arrives without a working directory gets the
// bridge's --cwd / $HOME/journal, an explicit one is never touched, and nothing
// is invented when no host default exists (the adapter reports it instead).
// Pure over the exported rule, so the contract is pinned by behaviour rather
// than by a substring.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyHostDefaults, childEnvForHarness, clipCloseReason, createAcpServer, harnessCliWarning, resolveAdapter, resolveCliOnPath, HARNESS_ADAPTERS } from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const sessionNew = (params: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params });

Deno.test("applyHostDefaults: fills a missing working directory on session/new and session/load", () => {
  const filledNew = JSON.parse(applyHostDefaults(sessionNew({ mcpServers: [] }), "/host/journal"));
  assertEquals(filledNew.params.cwd, "/host/journal");
  assertEquals(filledNew.params.mcpServers, [], "other params survive");

  const filledLoad = JSON.parse(applyHostDefaults(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "ses_1" } }),
    "/host/journal",
  ));
  assertEquals(filledLoad.params.cwd, "/host/journal");
  assertEquals(filledLoad.params.sessionId, "ses_1");
});

Deno.test("applyHostDefaults: an explicit cwd (and an empty host default) is never overwritten", () => {
  const explicit = JSON.parse(applyHostDefaults(sessionNew({ cwd: "/caller/chosen" }), "/host/journal"));
  assertEquals(explicit.params.cwd, "/caller/chosen");

  const noHostDefault = JSON.parse(applyHostDefaults(sessionNew({}), ""));
  assertEquals("cwd" in noHostDefault.params, false, "no host default means no invented cwd");
});

Deno.test("applyHostDefaults: other methods and malformed frames pass through untouched", () => {
  const prompt = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s", prompt: [] } });
  assertEquals(applyHostDefaults(prompt, "/host/journal"), prompt);

  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} });
  assertEquals(applyHostDefaults(initialize, "/host/journal"), initialize);

  assertEquals(applyHostDefaults("not json", "/host/journal"), "not json");
});

Deno.test("resolveAdapter: local install > absolute npx > loud refusal", () => {
  const dir = durableDir("acp-adapter-fixture");
  const binDir = `${dir}/bin`;
  try { Deno.mkdirSync(binDir, { recursive: true }); } catch { /* exists */ }
  const npx = `${binDir}/npx`;
  Deno.writeTextFileSync(npx, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(npx, 0o755);

  // npx is resolved to an ABSOLUTE path: Deno.Command's PATH lookup happens in
  // the launcher's environment, and a launchd/Chrome-spawned bridge cannot see
  // the shell's PATH ("Failed to spawn 'npx': entity not found").
  const viaNpx = resolveAdapter("claude-code", "", binDir, { home: "/nonexistent-home" });
  assertEquals(viaNpx.cmd, npx);
  assertEquals(viaNpx.args, ["-y", "@agentclientprotocol/claude-agent-acp@0.78.0"]);

  // A LOCAL adapter install wins: no npx, no network.
  const localHome = `${dir}/home`;
  const localEntry = `${localHome}/.pi/agent/npm/node_modules/pi-acp/dist/index.js`;
  const viaLocal = resolveAdapter("pi", "", "", {
    home: localHome,
    exists: (p) => p === localEntry,
  });
  assertEquals(viaLocal.cmd, "node");
  assertEquals(viaLocal.args, [localEntry]);

  // No npx anywhere and no local install: refuse, naming the fix.
  let threw = "";
  try { resolveAdapter("codex", "", "/nonexistent-bin", { home: "/nonexistent-home" }); }
  catch (e) { threw = String((e as Error)?.message ?? e); }
  assert(threw.includes("npx"), threw);
  assert(threw.includes("--adapter"), threw);

  // An explicit adapter wins and runs through node.
  const customPath = `${dir}/my-adapter.mjs`;
  const custom = resolveAdapter("pi", customPath);
  assertEquals(custom.cmd, "node");
  assertEquals(custom.args, [customPath]);

  // An unknown harness fails loudly with the known list instead of spawning.
  let unknown = "";
  try { resolveAdapter("not-a-harness", "", binDir); } catch (e) { unknown = String((e as Error)?.message ?? e); }
  assert(unknown.includes("unknown harness"), unknown);
  for (const known of Object.keys(HARNESS_ADAPTERS)) assert(unknown.includes(known), unknown);
});

Deno.test("clipCloseReason: a WebSocket close reason is always <= 123 bytes", () => {
  const long = `adapter not found: /Users/someone/very/long/path/that/keeps/going/and/going/and/going/past/the/websocket/limit/pi-acp/dist/index.js`;
  const clipped = clipCloseReason(`Failed to spawn adapter: ${long}`);
  assert(new TextEncoder().encode(clipped).length <= 123, `clipped reason is ${new TextEncoder().encode(clipped).length} bytes`);
  // Short reasons pass through untouched, and multi-byte characters never split.
  assertEquals(clipCloseReason("adapter exited: boom"), "adapter exited: boom");
  const multibyte = clipCloseReason("é".repeat(200));
  assert(new TextEncoder().encode(multibyte).length <= 123);
  assertEquals(new TextDecoder().decode(new TextEncoder().encode(multibyte)), multibyte);
});

Deno.test("harness CLI resolution: found on PATH, handed to the adapter as an absolute path", () => {
  const dir = durableDir("acp-cli-fixture");
  const cli = `${dir}/pi`;
  Deno.writeTextFileSync(cli, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(cli, 0o755);

  assertEquals(resolveCliOnPath("pi", dir), cli);
  assertEquals(resolveCliOnPath("pi", "/nonexistent:/usr/bin"), "");
  assertEquals(resolveCliOnPath("pi", ""), "");

  // Every known adapter honours an explicit-CLI env var (verified against the
  // pinned packages 2026-09-18: pi-acp PI_ACP_PI_COMMAND; claude-agent-acp@0.78.0
  // CLAUDE_CODE_EXECUTABLE; codex-acp@1.12.0 CODEX_PATH), so a CLI the bridge
  // can see is handed over as an ABSOLUTE path even under a minimal launcher PATH.
  assertEquals(childEnvForHarness("pi", dir), { PI_ACP_PI_COMMAND: cli });
  assertEquals(childEnvForHarness("pi", "/nonexistent"), {});

  const claudeCli = `${dir}/claude`;
  Deno.writeTextFileSync(claudeCli, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(claudeCli, 0o755);
  const codexCli = `${dir}/codex`;
  Deno.writeTextFileSync(codexCli, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(codexCli, 0o755);
  assertEquals(childEnvForHarness("claude-code", dir), { CLAUDE_CODE_EXECUTABLE: claudeCli });
  assertEquals(childEnvForHarness("codex", dir), { CODEX_PATH: codexCli });
  // Off the bridge's PATH nothing is invented: claude/codex fall back to their
  // bundled CLI, pi relies on the startup warning naming the fix.
  assertEquals(childEnvForHarness("claude-code", "/nonexistent"), {});
  assertEquals(childEnvForHarness("codex", "/nonexistent"), {});
  assertEquals(childEnvForHarness("nope", dir), {});
});

Deno.test("harnessCliWarning: a PATH miss is fatal only for adapters without a bundled CLI", () => {
  const dir = durableDir("acp-cli-warning-fixture");
  const cli = `${dir}/pi`;
  Deno.writeTextFileSync(cli, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(cli, 0o755);

  // Visible on PATH: silence, for every harness.
  assertEquals(harnessCliWarning("pi", dir), []);
  assertEquals(harnessCliWarning("not-a-harness", "/nonexistent"), []);

  // pi has no fallback: the warning must say the adapter WILL fail and name the fix.
  const piWarning = harnessCliWarning("pi", "/nonexistent").join("\n");
  assert(piWarning.includes("will fail"), piWarning);
  assert(piWarning.includes("executable not found"), piWarning);
  assert(piWarning.includes("acp:service install"), piWarning);
  assert(piWarning.includes("npm install -g @earendil-works/pi-coding-agent"), piWarning);

  // claude-code/codex bundle a CLI: a PATH miss is a NOTE naming the fallback,
  // never a false "will fail" alarm (the adapters run their bundled CLI).
  const claudeNote = harnessCliWarning("claude-code", "/nonexistent").join("\n");
  assert(claudeNote.includes("bundled native binary"), claudeNote);
  assert(!claudeNote.includes("will fail"), claudeNote);
  const codexNote = harnessCliWarning("codex", "/nonexistent").join("\n");
  assert(codexNote.includes("bundled @openai/codex CLI"), codexNote);
  assert(!codexNote.includes("will fail"), codexNote);
});

Deno.test("createAcpServer: /health supports ?harness= query and returns supportsHarnessSelection", async () => {
  const server = createAcpServer(0);
  const port = (server as any).addr.port;
  try {
    // Default probe
    const resDefault = await fetch(`http://127.0.0.1:${port}/health`);
    assertEquals(resDefault.ok, true);
    const jsonDefault = await resDefault.json();
    assertEquals(jsonDefault.harness, "pi");
    assertEquals(jsonDefault.probeHarness, "pi");
    assertEquals(jsonDefault.supportsHarnessSelection, true);
    assertEquals(jsonDefault.knownHarnesses, ["pi", "claude-code", "codex"]);

    // Explicit claude-code probe
    const resClaude = await fetch(`http://127.0.0.1:${port}/health?harness=claude-code`);
    assertEquals(resClaude.ok, true);
    const jsonClaude = await resClaude.json();
    assertEquals(jsonClaude.harness, "pi", "default server harness remains pi");
    assertEquals(jsonClaude.probeHarness, "claude-code", "probe harness matches query");
    assertEquals(jsonClaude.harnessCli, "claude");
    assert(jsonClaude.adapter.includes("claude-agent-acp"), jsonClaude.adapter);
  } finally {
    await server.shutdown();
  }
});

Deno.test("createAcpServer: rejects unknown harness with HTTP 400 naming known harnesses", async () => {
  const server = createAcpServer(0);
  const port = (server as any).addr.port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/acp?harness=unknown-harness`);
    assertEquals(res.status, 400);
    const text = await res.text();
    assert(text.includes('unknown harness "unknown-harness"'), text);
    for (const known of Object.keys(HARNESS_ADAPTERS)) {
      assert(text.includes(known), `must name known harness ${known}`);
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("createAcpServer: per-connection harness selection passes PI_ACP_HARNESS and childEnv to adapter", async () => {
  // Use a mock adapter script that echoes its environment into a log file
  const dir = durableDir("acp-harness-env-test");
  const logFile = `${dir}/env.json`;
  const mockAdapter = `${dir}/mock-adapter.mjs`;
  Deno.writeTextFileSync(
    mockAdapter,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({
  PI_ACP_HARNESS: process.env.PI_ACP_HARNESS,
  CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE || null,
  CODEX_PATH: process.env.CODEX_PATH || null,
  PI_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND || null,
}));
process.exit(0);
`,
  );

  const server = createAcpServer(0, mockAdapter);
  const port = (server as any).addr.port;

  try {
    // Connect with ?harness=claude-code
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp?harness=claude-code`);
    await new Promise<void>((resolve) => {
      ws.onclose = (event) => {
        // Must name started harness in close reason
        assert(event.reason.includes('adapter for harness "claude-code" exited'), event.reason);
        resolve();
      };
    });

    // Verify adapter child received PI_ACP_HARNESS = claude-code
    assert(Deno.statSync(logFile).isFile, "mock adapter must have written env log");
    const loggedEnv = JSON.parse(Deno.readTextFileSync(logFile));
    assertEquals(loggedEnv.PI_ACP_HARNESS, "claude-code");
  } finally {
    await server.shutdown();
  }
});


// tests/acp-bridge-host-defaults.test.ts — the bridge's host-side session
// defaults: a session request that arrives without a working directory gets the
// bridge's --cwd / $HOME/journal, an explicit one is never touched, and nothing
// is invented when no host default exists (the adapter reports it instead).
// Pure over the exported rule, so the contract is pinned by behaviour rather
// than by a substring.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyHostDefaults, childEnvForHarness, clipCloseReason, resolveAdapter, resolveCliOnPath, HARNESS_ADAPTERS } from "../scripts/acp-bridge.ts";
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

Deno.test("resolveAdapter: registry packages by harness, npx needs nothing installed", () => {
  const pi = resolveAdapter("pi");
  assertEquals(pi.cmd, "npx");
  assertEquals(pi.args[0], "-y");
  assertEquals(pi.args[1], "pi-acp@0.0.33");

  const claude = resolveAdapter("claude-code");
  assertEquals(claude.args[1], "@agentclientprotocol/claude-agent-acp@0.78.0");
  const codex = resolveAdapter("codex");
  assertEquals(codex.args[1], "@agentclientprotocol/codex-acp@1.12.0");

  // An explicit adapter wins and runs through node.
  const customPath = `${durableDir("acp-adapter-fixture")}/my-adapter.mjs`;
  const custom = resolveAdapter("pi", customPath);
  assertEquals(custom.cmd, "node");
  assertEquals(custom.args, [customPath]);

  // An unknown harness fails loudly with the known list instead of spawning.
  let threw = "";
  try { resolveAdapter("not-a-harness"); } catch (e) { threw = String((e as Error)?.message ?? e); }
  assert(threw.includes("unknown harness"));
  for (const known of Object.keys(HARNESS_ADAPTERS)) assert(threw.includes(known));
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

  // pi-acp honours PI_ACP_PI_COMMAND: without it the adapter searches its own
  // PATH, which is exactly the launchd/Chrome minimal-PATH failure.
  assertEquals(childEnvForHarness("pi", dir), { PI_ACP_PI_COMMAND: cli });
  assertEquals(childEnvForHarness("pi", "/nonexistent"), {});
  assertEquals(childEnvForHarness("claude-code", dir), {}, "adapters without an override get nothing extra");
  assertEquals(childEnvForHarness("nope", dir), {});
});

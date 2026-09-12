// tests/acp-bridge-host-defaults.test.ts — the bridge's host-side session
// defaults: a session request that arrives without a working directory gets the
// bridge's --cwd / $HOME/journal, an explicit one is never touched, and nothing
// is invented when no host default exists (the adapter reports it instead).
// Pure over the exported rule, so the contract is pinned by behaviour rather
// than by a substring.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assertEquals } from "jsr:@std/assert@1";
import { applyHostDefaults } from "../scripts/acp-bridge.ts";

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

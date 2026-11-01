// tests/acp-run-config-guard.test.ts — acp.endpoint kv value is parsed with a named refusal, not a raw Invalid URL (chrome-agent-platform-nvlou)

import { assert } from "jsr:@std/assert@1";
import { acpRunConfig } from "../extension/lib/acp-run-config.js";
import { DEFAULT_ACP_ENDPOINT, acpEndpointWithHarness } from "../extension/lib/acp-runner.js";

const readWith = (endpoint: unknown) => (key: string) => Promise.resolve(key === "acp.endpoint" ? endpoint : null);

Deno.test("acp.endpoint: an invalid kv value refuses with a diagnostic naming the setting (nvlou)", async () => {
  let err: unknown;
  try {
    await acpRunConfig("claude-code", readWith("not a url at all"));
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error && err.message.includes("acp.endpoint") && err.message.includes("is invalid"), `expected a named acp.endpoint refusal, got: ${(err as Error | undefined)?.message}`);
});

Deno.test("acp.endpoint: a valid kv value still parses, and no value still uses the default (nvlou)", async () => {
  const configured = await acpRunConfig("claude-code", readWith("ws://127.0.0.1:8787/acp"));
  assert(configured.url.startsWith("ws://127.0.0.1:8787/acp?"), `configured endpoint must flow through, got: ${configured.url}`);
  const fallback = await acpRunConfig("claude-code", readWith(null));
  assert(fallback.url === acpEndpointWithHarness(DEFAULT_ACP_ENDPOINT, "claude-code"), `default endpoint must still apply, got: ${fallback.url}`);
});

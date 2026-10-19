// tests/acp-settings.test.ts — ACP settings surface & working directory propagation (chrome-agent-platform-khkk)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { runAcpTaskTurn } from "../extension/lib/acp-runner.js";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { TEST_BRIDGE_TOKEN } from "./fixtures/acp-bridge-token.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const FAKE_ADAPTER = fileURLToPath(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

/** jsjy: the bridge refuses an unauthenticated upgrade; the token travels on the endpoint here. */
const authedEndpoint = (port: number | string) => `ws://127.0.0.1:${port}/acp?token=${TEST_BRIDGE_TOKEN}`;

class MockContainer {
  tools: any[] = [];
  system: string[] = [];
  agentMessages: string[] = [];
  errors: any[] = [];
  appendSystem(text: string) {
    this.system.push(String(text));
  }
}

Deno.test("acp.cwd: setting in kv configures the working directory when none is passed in options (khkk)", async () => {
  const logPath = `${durableDir("acp-fixture-logs")}/frames-settings-cwd-${Date.now()}.jsonl`;
  const bridge = createAcpServer(0, FAKE_ADAPTER, { CAP_ACP_FIXTURE_LOG: logPath }, "", TEST_BRIDGE_TOKEN);
  const port = (bridge as any).addr.port;
  const endpoint = authedEndpoint(port);
  const container = new MockContainer();

  const customCwd = `${durableDir("scratch")}/cap-custom-acp-workdir`;
  try {
    const res = await runAcpTaskTurn({
      container,
      task: "test configured cwd",
      harnessId: "settings-cwd-probe",
      endpoint,
      settings: {
        get: (key: string) => Promise.resolve(key === "acp.cwd" ? customCwd : null),
      },
    });
    assertEquals(res.ok, true, String(res.error));

    // The fixture's frame log proves the adapter received the configured working directory
    const frames = (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const newSession = frames.find((f: any) => f.dir === "in" && f.msg?.method === "session/new");
    assert(newSession, "session/new frame must be sent");
    assertEquals(newSession.msg.params.cwd, customCwd, "adapter received the configured acp.cwd");
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("acp settings: options surface declares endpoint, token, cwd, permissions and transport fields", async () => {
  const html = await Deno.readTextFile(fileURLToPath(new URL("../extension/options/options.html", import.meta.url)));
  assert(html.includes('id="acp-endpoint"'), "endpoint input exists");
  assert(html.includes('id="acp-token"'), "token input exists");
  assert(html.includes('id="acp-cwd"'), "working directory input exists");
  assert(html.includes('id="acp-permissions"'), "permissions select exists");
  assert(html.includes('id="acp-transport"'), "transport select exists");
  assert(html.includes('id="acp-test-btn"'), "test connection button exists");
});

Deno.test("acp settings: options.js implements renderAcpSettings with KV read/write/remove bindings", async () => {
  const code = await Deno.readTextFile(fileURLToPath(new URL("../extension/options/panels/agents.js", import.meta.url)));
  assert(code.includes("async function renderAcpSettings()"), "renderAcpSettings function declared");
  assert(code.includes('await storage.get(["acp.endpoint"'), "reads acp keys from storage");
  assert(code.includes('await storage.set({ "acp.cwd":'), "persists acp.cwd");
  assert(code.includes('await storage.set({ "acp.endpoint":'), "persists acp.endpoint");
  assert(code.includes('await storage.set({ "acp.token":'), "persists acp.token");
  assert(code.includes('await storage.set({ "acp.permissions":'), "persists acp.permissions");
  assert(code.includes('await storage.set({ "acp.transport":'), "persists acp.transport");
});

Deno.test("acp settings: selecting the Native host transport requests the optional nativeMessaging grant in the handler (chrome-agent-platform-o65r)", async () => {
  const code = await Deno.readTextFile(fileURLToPath(new URL("../extension/options/panels/agents.js", import.meta.url)));
  // Anchored to the LIVE CALL SITES, not the import line: an import is a shadow
  // (substring-pin-honesty), so the pin that must survive deleting the construct is
  // the invocation with its argument list.
  assert(code.includes("ensureAcpNativePermission()"), "the grant helper is invoked from the settings handlers");
  // The persistence of acp.transport="native" sits INSIDE the grant's success path: the
  // handler asks (the select change is the user gesture) and on refusal reverts the select
  // and surfaces the error — a saved "native" the runtime can never use would silently
  // downgrade every turn to the bridge.
  const handler = code.slice(
    code.indexOf('transportEl.addEventListener("change"'),
    code.indexOf('if (testBtn)'),
  );
  assert(handler.includes("ensureAcpNativePermission()"), "the transport change handler asks for the grant");
  const guarded = handler.indexOf("ensureAcpNativePermission()") < handler.indexOf('await storage.set({ "acp.transport": val })');
  assert(guarded, "the grant precedes the persistence — selecting native without the grant must not save");
  assert(handler.includes('transportEl.value = s?.["acp.transport"]'), "a refusal reverts the select to the persisted transport");
});

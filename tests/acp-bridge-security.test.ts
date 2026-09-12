// tests/acp-bridge-security.test.ts — the ACP bridge's loopback Origin guard.
// A browser ALWAYS sends Origin on a WebSocket upgrade, so refusing non-extension
// origins is what stops an arbitrary web page from driving the local agent
// harness (shell commands, file writes) through the bridge. Raw TCP so the
// request can carry an Origin header exactly as a browser would.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { createAcpServer } from "../scripts/acp-bridge.ts";

const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

/** Send a WebSocket upgrade by hand and return the response status line. */
async function upgradeStatus(port: number, origin: string | null): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const headers = [
      "GET /acp HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      ...(origin ? [`Origin: ${origin}`] : []),
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "",
      "",
    ].join("\r\n");
    await conn.write(new TextEncoder().encode(headers));
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    return new TextDecoder().decode(buf.subarray(0, n ?? 0)).split("\r\n")[0];
  } finally {
    try { conn.close(); } catch { /* already closed by the server on refusal */ }
  }
}

Deno.test("ACP bridge: a web page's Origin is refused, an extension's is accepted", async () => {
  const PORT = 3227;
  const bridge = createAcpServer(PORT, FAKE_ADAPTER);
  try {
    const web = await upgradeStatus(PORT, "https://evil.example");
    assertEquals(web.includes("403"), true, `a web-page origin must be refused, got: ${web}`);

    const extension = await upgradeStatus(PORT, "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    assertEquals(extension.includes("101"), true, `an extension origin must be accepted, got: ${extension}`);
  } finally {
    await bridge.shutdown();
  }
});

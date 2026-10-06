// tests/acp-bridge-security.test.ts — the ACP bridge's loopback authentication.
// Two guards, both required: an ORIGIN guard (a browser ALWAYS sends Origin on a
// WebSocket upgrade, so refusing non-extension origins is what stops an arbitrary
// web page from driving the local agent harness — shell commands, file writes —
// through the bridge) and a SHARED SECRET on every upgrade, because a local
// process sends no Origin at all and would otherwise be admitted by the origin
// guard by design (chrome-agent-platform-jsjy). Raw TCP so the request can carry
// an Origin header exactly as a browser would.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { AcpClient } from "../extension/lib/acp-client.js";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

/** Send a WebSocket upgrade by hand and return the response status line. */
async function upgradeStatus(port: number, origin: string | null, token?: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const headers = [
      `GET /acp${token ? `?token=${token}` : ""} HTTP/1.1`,
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
  const token = "origin-guard-test-token";
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", token);
  const PORT = (bridge as any).addr.port;
  try {
    const web = await upgradeStatus(PORT, "https://evil.example", token);
    assertEquals(web.includes("403"), true, `a web-page origin must be refused, got: ${web}`);

    const extension = await upgradeStatus(PORT, EXTENSION_ORIGIN, token);
    assertEquals(extension.includes("101"), true, `an extension origin must be accepted, got: ${extension}`);
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("ACP bridge: --allow-origin admits the EXACT origin, never a confusable one", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run", "-A", "scripts/acp-bridge.ts",
      "--port", String(port),
      "--adapter", FAKE_ADAPTER,
      "--allow-origin", "https://trusted.example",
      "--token", "allow-origin-test-token",
    ],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const c = await Deno.connect({ hostname: "127.0.0.1", port }); c.close(); up = true; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    assertEquals(up, true, "the bridge CLI must start listening");
    assertEquals(
      (await upgradeStatus(port, "https://trusted.example", "allow-origin-test-token")).includes("101"),
      true,
      "the allowed exact origin must be accepted",
    );
    assertEquals(
      (await upgradeStatus(port, "https://trusted.example.evil.test", "allow-origin-test-token")).includes("403"),
      true,
      "a prefix-extension of the allowed origin must NOT be accepted",
    );
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await child.status.catch(() => null);
  }
});

Deno.test("ACP bridge: --token requires the shared secret on the upgrade", async () => {
  // Kernel-assigned port for the CLI child (it prints the bound port).
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "scripts/acp-bridge.ts", "--port", String(port), "--token", "s3cret", "--adapter", FAKE_ADAPTER],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const c = await Deno.connect({ hostname: "127.0.0.1", port }); c.close(); up = true; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    assertEquals(up, true, "the bridge CLI must start listening");
    assertEquals((await upgradeStatus(port, null)).includes("403"), true, "no token must be refused");
    assertEquals((await upgradeStatus(port, null, "wrong")).includes("403"), true, "a wrong token must be refused");
    assertEquals((await upgradeStatus(port, null, "s3cret")).includes("101"), true, "the right token is accepted");
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await child.status.catch(() => null);
  }
});

// jsjy: the DEFAULT must be authenticated. Before this, a loopback bind with no
// --token left TOKEN empty, the token check was skipped entirely, and a local
// process that sent no Origin (which the origin guard admits by design) drove the
// harness's approval surface. The falsification for this test is recorded on the
// bead: restoring the old `isLoopbackHost(HOST) ? "" : …` default makes the FIRST
// assertion below fail, because the unauthenticated upgrade is then served with
// 101 instead of refused with 403.
Deno.test("ACP bridge: auth is required BY DEFAULT — a loopback upgrade with no token is refused, and the token is generated + persisted on first use", async () => {
  const scratch = durableDir(`jsjy-default-auth-${Deno.pid}`);
  try {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    const root = fileURLToPath(new URL("..", import.meta.url));
    // NO --token: this is the default configuration the defect is about.
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "scripts/acp-bridge.ts", "--port", String(port), "--adapter", FAKE_ADAPTER],
      cwd: root,
      env: { XDG_CONFIG_HOME: scratch },
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { const c = await Deno.connect({ hostname: "127.0.0.1", port }); c.close(); up = true; }
        catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      assertEquals(up, true, "the bridge CLI must start listening");

      // (a) The defect itself: an upgrade with NO token is refused, loopback and
      // an extension origin included.
      assertEquals(
        (await upgradeStatus(port, EXTENSION_ORIGIN)).includes("403"),
        true,
        "an unauthenticated upgrade must be REFUSED even on loopback",
      );
      // (b) Generated AND persisted on first use, mode 0600.
      const tokenFile = `${scratch}/cap-acp/bridge-token`;
      const token = Deno.readTextFileSync(tokenFile).trim();
      assert(token.length >= 32, `a token must be persisted on first use, got ${JSON.stringify(token)}`);
      const mode = (Deno.statSync(tokenFile).mode ?? 0) & 0o777;
      assertEquals(mode, 0o600, `the persisted token must be mode 0600, got ${mode.toString(8)}`);
      // (c) And the legitimate client still works with it.
      assertEquals(
        (await upgradeStatus(port, EXTENSION_ORIGIN, token)).includes("101"),
        true,
        "the persisted token must be accepted",
      );
      assertEquals(
        (await upgradeStatus(port, EXTENSION_ORIGIN, "not-the-token")).includes("403"),
        true,
        "a wrong token must still be refused",
      );
    } finally {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      await child.status.catch(() => null);
    }
  } finally {
    try { Deno.removeSync(scratch, { recursive: true }); } catch { /* best effort */ }
  }
});

// jsjy: the CLIENT half of the same boundary. acp.endpoint is operator-settable,
// and a non-loopback endpoint means plain ws:// (and the token) crossing a
// network to a peer that is not provably this machine's bridge.
Deno.test("ACP client: a non-loopback endpoint is refused, and every loopback form is accepted", async () => {
  for (const url of ["ws://192.168.1.5:3210/acp", "wss://harness.example.test/acp", "ws://10.0.0.7:3210/acp"]) {
    assertThrows(() => new AcpClient({ url }), Error, "not on loopback", `${url} must be refused`);
  }
  for (const url of ["ws://127.0.0.1:3210/acp", "ws://localhost:3210/acp", "ws://[::1]:3210/acp", "ws://127.9.9.9:3210/acp"]) {
    assertEquals(new AcpClient({ url }).url, url, `${url} is loopback and must be accepted`);
  }
  // The override path must refuse too, not only the constructor.
  const client = new AcpClient({ url: "ws://127.0.0.1:3210/acp" });
  await assertRejects(
    () => client.connect("ws://10.0.0.7:3210/acp"),
    Error,
    "not on loopback",
    "connect(urlOverride) must refuse a non-loopback endpoint",
  );
});

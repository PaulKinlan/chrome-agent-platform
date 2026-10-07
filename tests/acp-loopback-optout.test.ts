// tests/acp-loopback-optout.test.ts — the explicit loopback-only tokenless opt-out
// (--allow-anonymous-loopback, Paul 2026-10-07).
//
// jsjy made auth required on EVERY upgrade (loopback included) on 2026-10-06. Paul's
// decision (2026-10-07) adds ONE deliberate, visible, LOOPBACK-ONLY exception: an
// operator may start the bridge with --allow-anonymous-loopback to run tokenless on
// 127.0.0.1. The default is unchanged (token required everywhere), the flag refuses
// to start on a non-loopback bind, and it logs loudly. This file pins every one of
// those properties so the opt-out cannot silently widen into "unauthenticated by
// default" or "anonymous on a routable address".
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { createAcpServer, isValidatedLiteralLoopback } from "../scripts/acp-bridge.ts";
import { TEST_BRIDGE_TOKEN } from "./fixtures/acp-bridge-token.ts";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

/** Send a WebSocket upgrade by hand and return the response status line, exactly
 * as tests/acp-bridge-security.test.ts does so an Origin header can be set. */
async function upgradeStatus(port: number, origin: string | null, token?: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const headers = [
      `GET /acp${token !== undefined ? `?token=${encodeURIComponent(token)}` : ""} HTTP/1.1`,
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

/** Probe /acp/preflight exactly as the extension would (HTTP GET with an Origin). */
async function preflight(port: number, { token, origin = EXTENSION_ORIGIN }: {
  token?: string; origin?: string | null;
}) {
  const qs = token !== undefined ? `?token=${encodeURIComponent(token)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/acp/preflight${qs}`, {
    headers: origin ? { Origin: origin } : {},
  });
  return { status: res.status, body: await res.json() };
}

// (a) The default is UNCHANGED: no flag, loopback, no token → still refused.
Deno.test("ACP loopback opt-out: default (no flag) still requires a token on loopback", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", TEST_BRIDGE_TOKEN);
  const port = (bridge as any).addr.port;
  try {
    const noToken = await upgradeStatus(port, EXTENSION_ORIGIN);
    assertEquals(noToken.includes("403"), true, `a tokenless upgrade must be refused by default, got: ${noToken}`);
    const wrongToken = await upgradeStatus(port, EXTENSION_ORIGIN, "not-the-token");
    assertEquals(wrongToken.includes("403"), true, "a wrong token must be refused by default");
    const correct = await upgradeStatus(port, EXTENSION_ORIGIN, TEST_BRIDGE_TOKEN);
    assertEquals(correct.includes("101"), true, "the correct token must be accepted by default");
  } finally {
    await bridge.shutdown();
  }
});

// (b) Flag + loopback + no token → the upgrade succeeds (tokenless).
Deno.test("ACP loopback opt-out: --allow-anonymous-loopback admits a tokenless loopback upgrade", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", "", true);
  const port = (bridge as any).addr.port;
  try {
    const noToken = await upgradeStatus(port, EXTENSION_ORIGIN);
    assertEquals(noToken.includes("101"), true, `a tokenless loopback upgrade must succeed under the opt-out, got: ${noToken}`);
  } finally {
    await bridge.shutdown();
  }
});

// (c) Flag + token supplied and WRONG → still accepted on loopback (the operator
//     chose tokenless access, so a stray/wrong token is ignored, never a refusal).
Deno.test("ACP loopback opt-out: a wrong (or any) token is irrelevant while the opt-out is active", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", "some-supplied-token", true);
  const port = (bridge as any).addr.port;
  try {
    const wrongToken = await upgradeStatus(port, EXTENSION_ORIGIN, "not-the-token");
    assertEquals(wrongToken.includes("101"), true, `a wrong token must be ignored under the opt-out, got: ${wrongToken}`);
    const noToken = await upgradeStatus(port, EXTENSION_ORIGIN);
    assertEquals(noToken.includes("101"), true, "no token must also be accepted under the opt-out");
  } finally {
    await bridge.shutdown();
  }
});

// (d) Flag + non-loopback or hostname bind → the bridge refuses to start (fail closed).
//     P1: hostnames like "localhost" are rejected outright; malformed/out-of-range
//     127-ish strings are rejected; literal 127.0.0.1 and ::1 start.

Deno.test("ACP loopback opt-out: isValidatedLiteralLoopback accepts only genuine literal loopback IPs", () => {
  // Valid
  assertEquals(isValidatedLiteralLoopback("127.0.0.1"), true);
  assertEquals(isValidatedLiteralLoopback("127.0.0.2"), true);
  assertEquals(isValidatedLiteralLoopback("127.255.255.254"), true);
  assertEquals(isValidatedLiteralLoopback("::1"), true);
  assertEquals(isValidatedLiteralLoopback("[::1]"), true);

  // Hostnames (fail closed — resolver dependent)
  assertEquals(isValidatedLiteralLoopback("localhost"), false);
  assertEquals(isValidatedLiteralLoopback("localhost.localdomain"), false);
  assertEquals(isValidatedLiteralLoopback("my-host"), false);

  // Malformed or out-of-range 127-ish
  assertEquals(isValidatedLiteralLoopback("127.999.1.1"), false);
  assertEquals(isValidatedLiteralLoopback("127.1.2.3.4"), false);
  assertEquals(isValidatedLiteralLoopback("127.1.2"), false);
  assertEquals(isValidatedLiteralLoopback("127.0.0.01"), false);
  assertEquals(isValidatedLiteralLoopback("127.0.0.1 "), false);
  assertEquals(isValidatedLiteralLoopback(" 127.0.0.1"), false);
  assertEquals(isValidatedLiteralLoopback("127.0.0.1.evil.com"), false);

  // Other non-loopback
  assertEquals(isValidatedLiteralLoopback("0.0.0.0"), false);
  assertEquals(isValidatedLiteralLoopback("192.168.1.1"), false);
  assertEquals(isValidatedLiteralLoopback("10.0.0.1"), false);
  assertEquals(isValidatedLiteralLoopback("::"), false);
  assertEquals(isValidatedLiteralLoopback(""), false);
});

async function runCliWithHost(host: string, allowAnonymous = true): Promise<{ code: number; stderr: string }> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run", "-A", "scripts/acp-bridge.ts",
      "--host", host,
      ...(allowAnonymous ? ["--allow-anonymous-loopback"] : []),
      "--adapter", FAKE_ADAPTER,
      "--port", "0",
    ],
    cwd: root,
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const stderr = new TextDecoder().decode(await child.output().then((o) => o.stderr));
  const status = await child.status;
  return { code: status.code, stderr };
}

Deno.test("ACP loopback opt-out: flag + 'localhost' refuses to start (actionable error)", async () => {
  const { code, stderr } = await runCliWithHost("localhost");
  assertEquals(code, 1, "flag + 'localhost' must refuse to start");
  assertEquals(
    /refusing to start: --allow-anonymous-loopback requires a validated literal loopback IP/.test(stderr),
    true,
    `error must explain that literal loopback IP is required, got: ${stderr}`,
  );
  assertEquals(
    /Hostnames like "localhost".*cannot guarantee fail-closed/.test(stderr),
    true,
    `error must explain why hostnames are rejected, got: ${stderr}`,
  );
  assertEquals(
    /bind to a literal loopback IP.*or remove --allow-anonymous-loopback/.test(stderr),
    true,
    `error must give actionable fix, got: ${stderr}`,
  );

  // In-process createAcpServer also asserts the invariant
  assertThrows(
    () => createAcpServer(0, FAKE_ADAPTER, {}, "", "", true, "localhost"),
    Error,
    "--allow-anonymous-loopback requires a validated literal loopback IP",
  );
});

Deno.test("ACP loopback opt-out: flag + '127.999.1.1' and malformed 127 strings refuse to start", async () => {
  for (const badHost of ["127.999.1.1", "127.1.2.3.4", "127.0.0.1 "]) {
    const { code, stderr } = await runCliWithHost(badHost);
    assertEquals(code, 1, `flag + '${badHost}' must refuse to start`);
    assertEquals(
      /refusing to start: --allow-anonymous-loopback requires a validated literal loopback IP/.test(stderr),
      true,
      `refusal for '${badHost}' must name validated literal loopback requirement, got: ${stderr}`,
    );

    assertThrows(
      () => createAcpServer(0, FAKE_ADAPTER, {}, "", "", true, badHost),
      Error,
      "--allow-anonymous-loopback requires a validated literal loopback IP",
    );
  }
});

Deno.test("ACP loopback opt-out: flag + '0.0.0.0' refuses to start", async () => {
  const { code, stderr } = await runCliWithHost("0.0.0.0");
  assertEquals(code, 1, "flag + '0.0.0.0' must refuse to start");
  assertEquals(
    /refusing to start: --allow-anonymous-loopback requires a validated literal loopback IP/.test(stderr),
    true,
    `refusal must name validated literal loopback requirement, got: ${stderr}`,
  );

  assertThrows(
    () => createAcpServer(0, FAKE_ADAPTER, {}, "", "", true, "0.0.0.0"),
    Error,
    "--allow-anonymous-loopback requires a validated literal loopback IP",
  );
});

Deno.test("ACP loopback opt-out: flag + '127.0.0.1' starts", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", "", true, "127.0.0.1");
  const port = (bridge as any).addr.port;
  try {
    const res = await upgradeStatus(port, EXTENSION_ORIGIN);
    assertEquals(res.includes("101"), true, `must start and upgrade on 127.0.0.1, got: ${res}`);
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("ACP loopback opt-out: flag + '::1' starts", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", "", true, "::1");
  const port = (bridge as any).addr.port;
  try {
    const conn = await Deno.connect({ hostname: "::1", port });
    try {
      const headers = [
        "GET /acp HTTP/1.1",
        `Host: [::1]:${port}`,
        `Origin: ${EXTENSION_ORIGIN}`,
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
      const res = new TextDecoder().decode(buf.subarray(0, n ?? 0)).split("\r\n")[0];
      assertEquals(res.includes("101"), true, `must start and upgrade on ::1, got: ${res}`);
    } finally {
      try { conn.close(); } catch { /* closed */ }
    }
  } finally {
    await bridge.shutdown();
  }
});

// (e) The /acp/preflight diagnostic runs the SAME guards: tokenless loopback is
//     admitted under the flag, but a web-page Origin is STILL refused (the origin
//     guard is kept, never bypassed by the opt-out).
Deno.test("ACP loopback opt-out: /acp/preflight agrees with the live path under the flag", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", "", true);
  const port = (bridge as any).addr.port;
  try {
    const tokenless = await preflight(port, {});
    assertEquals(tokenless.status, 200);
    assertEquals(tokenless.body, { ok: true });

    const webOrigin = await preflight(port, { origin: "https://evil.example" });
    assertEquals(webOrigin.status, 403);
    assertEquals(webOrigin.body.reason, "origin-rejected");
  } finally {
    await bridge.shutdown();
  }
});

// (f) Service status reports installed mode from the unit/plist file, not CLI flags,
//     and labels output as an assumption when not installed (P2 finding).
Deno.test("ACP service status: reports installed mode from unit file, not CLI flags, and labels uninstalled as assumption", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const script = `${root}/scripts/acp-service.mjs`;

  // 1. Installed with anonymous loopback: plain status reports anonymous
  const anonUnit = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(anonUnit, "ExecStart=/usr/bin/deno run scripts/acp-bridge.ts --port 3210 --allow-anonymous-loopback\n");
    const child1 = new Deno.Command("node", {
      args: [script, "status", "--unit", anonUnit],
      stdout: "piped",
      stderr: "piped",
    });
    const out1 = new TextDecoder().decode(child1.outputSync().stdout);
    assertEquals(
      out1.includes("auth: ANONYMOUS loopback (installed with --allow-anonymous-loopback)"),
      true,
      `plain status on anonymous install must report anonymous from unit, got:\n${out1}`,
    );
  } finally {
    try { Deno.removeSync(anonUnit); } catch { /* ignore */ }
  }

  // 2. Installed with token: passing --allow-anonymous-loopback to status does NOT fake anonymous mode
  const authUnit = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(authUnit, "ExecStart=/usr/bin/deno run scripts/acp-bridge.ts --port 3210 --harness pi\n");
    const child2 = new Deno.Command("node", {
      args: [script, "status", "--unit", authUnit, "--allow-anonymous-loopback"],
      stdout: "piped",
      stderr: "piped",
    });
    const out2 = new TextDecoder().decode(child2.outputSync().stdout);
    assertEquals(
      out2.includes("auth: token required (installed service uses generated token"),
      true,
      `status on authenticated install with --allow-anonymous-loopback CLI flag must still report token required from unit, got:\n${out2}`,
    );
  } finally {
    try { Deno.removeSync(authUnit); } catch { /* ignore */ }
  }

  // 3. Not installed: reports assumption clearly
  const child3 = new Deno.Command("node", {
    args: [script, "status", "--unit", "/nonexistent/unit/path"],
    stdout: "piped",
    stderr: "piped",
  });
  const out3 = new TextDecoder().decode(child3.outputSync().stdout);
  assertEquals(
    out3.includes("auth (assumption; service not installed):"),
    true,
    `status with no installed unit must explicitly label output as assumption, got:\n${out3}`,
  );
});

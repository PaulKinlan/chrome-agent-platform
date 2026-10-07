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

import { assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { createAcpServer } from "../scripts/acp-bridge.ts";
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

// (d) Flag + non-loopback host → the bridge refuses to start (fail closed).
Deno.test("ACP loopback opt-out: a non-loopback bind with the flag refuses to start", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "scripts/acp-bridge.ts", "--host", "0.0.0.0", "--allow-anonymous-loopback", "--adapter", FAKE_ADAPTER],
    cwd: root,
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const stderr = new TextDecoder().decode(await child.output().then((o) => o.stderr));
  const status = await child.status;
  assertEquals(status.code, 1, "a non-loopback bind with --allow-anonymous-loopback must exit non-zero");
  assertEquals(
    /refusing to start.*--allow-anonymous-loopback/.test(stderr),
    true,
    `the refusal must name the flag and the reason, got stderr: ${stderr}`,
  );
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

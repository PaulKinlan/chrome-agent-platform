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
import {
  createAcpServer,
  extensionOriginIdentity,
  normalizeTrustedExtensionIds,
  originRefusalDetail,
  originRefusalLogLine,
} from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { AcpClient } from "../extension/lib/acp-client.js";

const TRUSTED_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
// ks4on: an extension Origin is admitted only when its ID is pinned, so the id and
// the origin have to come from the same constant.
const EXTENSION_ORIGIN = `chrome-extension://${TRUSTED_EXTENSION_ID}`;
const OTHER_EXTENSION_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));

/** Send a WebSocket upgrade by hand and return the response status line. */
async function upgradeStatus(port: number, origin: string | null, token?: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const headers = [
      // jsjy review F5: `token !== undefined` (not truthiness) so a caller can send an
      // EXPLICIT empty `?token=` — that is a distinct bypass shape and must be testable.
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

Deno.test("ACP bridge: a web page's Origin is refused, the PINNED extension's is accepted, another extension's is not (ks4on)", async () => {
  const token = "origin-guard-test-token";
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", token, false, "127.0.0.1", [TRUSTED_EXTENSION_ID]);
  const PORT = (bridge as any).addr.port;
  try {
    const web = await upgradeStatus(PORT, "https://evil.example", token);
    assertEquals(web.includes("403"), true, `a web-page origin must be refused, got: ${web}`);

    const extension = await upgradeStatus(PORT, EXTENSION_ORIGIN, token);
    assertEquals(extension.includes("101"), true, `the pinned extension origin must be accepted, got: ${extension}`);

    // ks4on: ANY OTHER installed extension is a different identity. Before the pin,
    // this line upgraded — a tokenless shell-capable harness under the opt-out.
    const other = await upgradeStatus(PORT, OTHER_EXTENSION_ORIGIN, token);
    assertEquals(
      other.includes("403"),
      true,
      `a DIFFERENT installed extension's origin must be refused even with a valid token, got: ${other}`,
    );
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
      args: ["run", "-A", "scripts/acp-bridge.ts", "--port", String(port), "--adapter", FAKE_ADAPTER, "--extension-id", TRUSTED_EXTENSION_ID],
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
      // jsjy review F5: an EXPLICIT empty `?token=` is a distinct bypass shape from a
      // missing one and must be refused too.
      assertEquals(
        (await upgradeStatus(port, EXTENSION_ORIGIN, "")).includes("403"),
        true,
        "an explicit empty ?token= must be refused, not compared as equal to an empty secret",
      );

      // jsjy review F5: RESTART REUSE. A second bridge on the same config dir must
      // READ the persisted token rather than rotating it — otherwise "persisted on
      // first use" would be true only for the process that created it, and the
      // operator's pasted acp.token would break on every restart.
      const before = Deno.readTextFileSync(tokenFile).trim();
      const listener2 = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port2 = (listener2.addr as Deno.NetAddr).port;
      listener2.close();
      const child2 = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "scripts/acp-bridge.ts", "--port", String(port2), "--adapter", FAKE_ADAPTER, "--extension-id", TRUSTED_EXTENSION_ID],
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { XDG_CONFIG_HOME: scratch },
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        let up2 = false;
        for (let i = 0; i < 60 && !up2; i++) {
          try { const c = await Deno.connect({ hostname: "127.0.0.1", port: port2 }); c.close(); up2 = true; }
          catch { await new Promise((r) => setTimeout(r, 200)); }
        }
        assertEquals(up2, true, "the second bridge must start listening");
        assertEquals(
          Deno.readTextFileSync(tokenFile).trim(),
          before,
          "a restart must NOT rotate the persisted token",
        );
        assertEquals(
          (await upgradeStatus(port2, EXTENSION_ORIGIN, before)).includes("101"),
          true,
          "the token persisted by the FIRST start must still be accepted after a restart",
        );
      } finally {
        try { child2.kill("SIGTERM"); } catch { /* already gone */ }
        await child2.status.catch(() => null);
      }
    } finally {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      await child.status.catch(() => null);
    }
  } finally {
    try { Deno.removeSync(scratch, { recursive: true }); } catch { /* best effort */ }
  }
});

// jsjy review F4: the fail-closed invariant is now ASSERTED, so an empty secret cannot
// be passed by a future caller or a test harness without changing this deliberately.
Deno.test("ACP bridge: createAcpServer REFUSES an empty secret rather than building an unauthenticated bridge", () => {
  assertThrows(
    () => createAcpServer(0, FAKE_ADAPTER, {}, "", ""),
    Error,
    "non-empty token",
    "an empty tokenOverride must throw instead of accepting an empty ?token=",
  );
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


// ============================================================================
// chrome-agent-platform-ks4on: the Origin guard is an IDENTITY test.
//
// The guard used to end in a scheme PREFIX test, so ANY page of ANY installed
// extension was an admitted Origin; under --allow-anonymous-loopback (which skips
// the token guard) that handed a shell-capable harness to any installed extension
// with no credential at all. Coord's ruling (2026-11-14) is option (a): the id the
// operator pins with --extension-id is the ONLY extension identity admitted, and no
// pin means every extension page is refused. These cases are the deliverable: each
// one REDS if the predicate regresses to a scheme prefix.
// ============================================================================

const OTHER_EXTENSION_ID_CONST = "ponmlkjihgfedcbaponmlkjihgfedcba";
const KS4ON_TOKEN = "ks4on-extension-identity-token";
const FIREFOX_EXTENSION_ID = "12345678-1234-1234-1234-1234567890ab";
const FIREFOX_EXTENSION_ORIGIN = `moz-extension://${FIREFOX_EXTENSION_ID}`;

/** Parse the preflight's JSON answer (the diagnostic a browser CAN read). */
async function preflight(port: number, origin: string | null, token?: string) {
  const url = `http://127.0.0.1:${port}/acp/preflight${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const res = await fetch(url, { headers: origin ? { Origin: origin } : {} });
  return { status: res.status, body: await res.json() };
}

Deno.test("ks4on: an extension Origin parses into an IDENTITY (scheme + host id), never a scheme match", () => {
  assertEquals(extensionOriginIdentity(EXTENSION_ORIGIN), { scheme: "chrome-extension", id: TRUSTED_EXTENSION_ID });
  assertEquals(extensionOriginIdentity(`${EXTENSION_ORIGIN}/`), { scheme: "chrome-extension", id: TRUSTED_EXTENSION_ID });
  // Case is folded: a browser lower-cases the host it writes into Origin.
  assertEquals(extensionOriginIdentity(EXTENSION_ORIGIN.toUpperCase()), { scheme: "chrome-extension", id: TRUSTED_EXTENSION_ID });
  assertEquals(extensionOriginIdentity(FIREFOX_EXTENSION_ORIGIN), { scheme: "moz-extension", id: FIREFOX_EXTENSION_ID });

  // Shapes that are NOT an identity. Each one used to satisfy the scheme prefix.
  for (
    const notAnIdentity of [
      `${EXTENSION_ORIGIN}/options/options.html`, // a path is not part of an Origin
      `chrome-extension://${TRUSTED_EXTENSION_ID}:8443`, // a port is not part of an Origin
      `chrome-extension://user@${TRUSTED_EXTENSION_ID}`, // userinfo is not part of an Origin
      `${EXTENSION_ORIGIN}?x=1`,
      `${EXTENSION_ORIGIN}#frag`,
      "chrome-extension://", // empty host: no identity at all
      "moz-extension://",
      "chrome-extension:///", // empty host with a path
      `${TRUSTED_EXTENSION_ID}`, // a bare id is not an origin
      "https://evil.example",
      "safari-web-extension://abcdefghijklmnopabcdefghijklmnop",
      "not a url",
      "",
      null,
    ]
  ) {
    assertEquals(
      extensionOriginIdentity(notAnIdentity as string | null),
      null,
      `${String(notAnIdentity)} must not parse as an extension identity`,
    );
  }
});

Deno.test("ks4on: --extension-id values are validated fail-closed (bare ids, case folded, deduped)", () => {
  assertEquals(normalizeTrustedExtensionIds([TRUSTED_EXTENSION_ID, TRUSTED_EXTENSION_ID.toUpperCase(), FIREFOX_EXTENSION_ID]), [TRUSTED_EXTENSION_ID, FIREFOX_EXTENSION_ID]);
  assertEquals(normalizeTrustedExtensionIds(["  ", ""]), []);
  for (const bad of [`chrome-extension://${TRUSTED_EXTENSION_ID}`, `${TRUSTED_EXTENSION_ID}/options.html`, `${TRUSTED_EXTENSION_ID} extra`, `a:${TRUSTED_EXTENSION_ID}`, "mycustomid"]) {
    assertThrows(
      () => normalizeTrustedExtensionIds([bad]),
      Error,
      "--extension-id",
    );
  }
});

Deno.test("ks4on: the guard admits the PINNED id and refuses a DIFFERENT installed extension (mutation: prefix match -> this reds)", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", KS4ON_TOKEN, false, "127.0.0.1", [TRUSTED_EXTENSION_ID]);
  const port = (bridge as any).addr.port;
  try {
    assertEquals(
      (await upgradeStatus(port, EXTENSION_ORIGIN, KS4ON_TOKEN)).includes("101"),
      true,
      "the pinned extension must still be able to drive the harness",
    );
    const other = await upgradeStatus(port, OTHER_EXTENSION_ORIGIN, KS4ON_TOKEN);
    assertEquals(
      other.includes("403"),
      true,
      `a DIFFERENT installed extension must be refused even with a valid token, got: ${other}`,
    );
    // ...and the refusal is not silent: /acp/preflight names the cause.
    const diag = await preflight(port, OTHER_EXTENSION_ORIGIN, KS4ON_TOKEN);
    assertEquals(diag.status, 403);
    assertEquals(diag.body.reason, "origin-rejected");
    assert(
      String(diag.body.detail).includes("extension origin not pinned"),
      `the detail must say the extension identity is not pinned, got: ${diag.body.detail}`,
    );
    assert(
      String(diag.body.detail).includes(TRUSTED_EXTENSION_ID),
      "the detail must name the pinned id so the operator can compare it with chrome://extensions",
    );
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("ks4on: under --allow-anonymous-loopback the wrong extension is STILL refused (the tokenless shell hole)", async () => {
  // This is the bead's actual harm: the opt-out skips the token guard, so the
  // Origin guard is the ONLY thing between an installed extension and a shell.
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", "", true, "127.0.0.1", [TRUSTED_EXTENSION_ID]);
  const port = (bridge as any).addr.port;
  try {
    assertEquals(
      (await upgradeStatus(port, EXTENSION_ORIGIN)).includes("101"),
      true,
      "the pinned extension must be admitted tokenless on loopback (the documented opt-out)",
    );
    const other = await upgradeStatus(port, OTHER_EXTENSION_ORIGIN);
    assertEquals(
      other.includes("403"),
      true,
      `with NO token, a different installed extension must be refused, got: ${other}`,
    );
    const diag = await preflight(port, OTHER_EXTENSION_ORIGIN);
    assertEquals(diag.status, 403);
    assertEquals(diag.body.reason, "origin-rejected");
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("ks4on: with NO id pinned, every extension origin is refused (narrow default, not 'any extension')", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", KS4ON_TOKEN, false, "127.0.0.1", []);
  const port = (bridge as any).addr.port;
  try {
    assertEquals(
      (await upgradeStatus(port, EXTENSION_ORIGIN, KS4ON_TOKEN)).includes("403"),
      true,
      "an unpinned bridge must not admit any extension page",
    );
    const diag = await preflight(port, EXTENSION_ORIGIN, KS4ON_TOKEN);
    assertEquals(diag.status, 403);
    assert(
      String(diag.body.detail).includes("--extension-id"),
      "the refusal must tell the operator which flag pins their extension id",
    );
    // A local script client (no Origin) is unaffected: it authenticates by token.
    assertEquals(
      (await upgradeStatus(port, null, KS4ON_TOKEN)).includes("101"),
      true,
      "a local script client sends no Origin and must still be admitted by its token",
    );
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("ks4on: moz-extension:// follows the SAME identity rule and has no second scheme path", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", KS4ON_TOKEN, false, "127.0.0.1", [FIREFOX_EXTENSION_ID]);
  const port = (bridge as any).addr.port;
  try {
    assertEquals(
      (await upgradeStatus(port, FIREFOX_EXTENSION_ORIGIN, KS4ON_TOKEN)).includes("101"),
      true,
      "the pinned Firefox extension id must be admitted",
    );
    assertEquals(
      (await upgradeStatus(port, "moz-extension://99999999-9999-9999-9999-999999999999", KS4ON_TOKEN)).includes("403"),
      true,
      "a different moz-extension uuid must be refused",
    );
    // A Chrome-scheme page carrying the Firefox id is not the same identity either:
    // the id alone is not the whole identity, so the scheme is compared too.
    assertEquals(
      (await upgradeStatus(port, `chrome-extension://${FIREFOX_EXTENSION_ID}`, KS4ON_TOKEN)).includes("403"),
      true,
      "an id pinned for one scheme must not be admitted under the other",
    );
    // A confusable host must never be read as the pinned id.
    assertEquals(
      (await upgradeStatus(port, `chrome-extension://${FIREFOX_EXTENSION_ID}.evil.example`, KS4ON_TOKEN)).includes("403"),
      true,
      "a host that merely CONTAINS the pinned id must be refused",
    );
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("ks4on: a refused Origin is logged (sanitised), so the refusal is observable and not silent", () => {
  const pinned = originRefusalLogLine(OTHER_EXTENSION_ORIGIN, [TRUSTED_EXTENSION_ID]);
  assert(pinned.includes("[acp-bridge] refused origin"), "the log line must say an origin was refused");
  assert(pinned.includes(OTHER_EXTENSION_ORIGIN), "the log line must name the refused origin");
  assert(pinned.includes(TRUSTED_EXTENSION_ID), "the log line must name the pinned id the operator expects");
  // An extension scheme that is NOT an identity is described as malformed, not as a
  // web origin, so the operator is not sent looking at the wrong rule.
  assert(
    originRefusalDetail(`${EXTENSION_ORIGIN}/options/options.html`, [TRUSTED_EXTENSION_ID]).includes("malformed extension origin"),
    "an extension-scheme Origin carrying a path must be described as malformed",
  );
  // A hostile origin cannot forge log lines or inject control characters.
  const injected = originRefusalLogLine("chrome-extension://evil\n[acp-bridge] Client connected from trusted", [TRUSTED_EXTENSION_ID]);
  assert(!injected.includes("\n"), "the log line must be single-line");
  assertEquals(originRefusalDetail("https://evil.example", [TRUSTED_EXTENSION_ID]), "web origins are not allowed to drive the harness");
});

Deno.test("ks4on: a malformed --extension-id refuses to start, naming the flag (CLI)", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "scripts/acp-bridge.ts", "--port", "0", "--extension-id", `chrome-extension://${TRUSTED_EXTENSION_ID}`, "--token", KS4ON_TOKEN],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  assertEquals(child.code, 1, "a malformed --extension-id must refuse to start");
  const err = new TextDecoder().decode(child.stderr);
  assert(err.includes("--extension-id"), `the refusal must name --extension-id, got: ${err}`);
  assert(err.includes("--allow-origin"), "the refusal must point at --allow-origin for a full origin");
});

// tests/acp-connect-error.test.ts — the ACP bridge must tell a connecting client
// WHY it refused, and the client must surface that reason (chrome-agent-platform-e25gk).
//
// Paul's failure (2026-10-07): a healthy bridge (token required) was reached by
// the extension at ws://127.0.0.1:3210/acp?harness=claude-code with NO token, the
// bridge refused with 403 "missing or wrong token", the browser hid the status/body,
// and the client reported only "Failed to connect to ACP harness at …" — with no
// mention of auth, token or origin. Two halves, both pinned here:
//   1. the bridge exposes /acp/preflight (the SAME guards, as a JSON probe) so the
//      reason is readable at all; and
//   2. the client probes it and maps the reason to an actionable message.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import {
  AcpClient,
  acpConnectionErrorMessage,
  acpPreflightUrl,
} from "../extension/lib/acp-client.js";
import { TEST_BRIDGE_TOKEN } from "./fixtures/acp-bridge-token.ts";

const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/** Probe the preflight endpoint exactly as the extension would: an HTTP GET with
 * an Origin header, returning the raw status + parsed JSON. */
async function preflight(port: number, { token, harness = "", origin = EXTENSION_ORIGIN }: {
  token?: string; harness?: string; origin?: string | null;
}) {
  const qs = [];
  if (harness) qs.push(`harness=${encodeURIComponent(harness)}`);
  if (token !== undefined) qs.push(`token=${encodeURIComponent(token)}`);
  const res = await fetch(
    `http://127.0.0.1:${port}/acp/preflight${qs.length ? `?${qs.join("&")}` : ""}`,
    { headers: origin ? { Origin: origin } : {} },
  );
  return { status: res.status, body: await res.json() };
}

Deno.test("ACP bridge /acp/preflight: reports the EXACT refusal reason the upgrade would hide", async () => {
  const bridge = createAcpServer(0, FAKE_ADAPTER, {}, "", TEST_BRIDGE_TOKEN);
  const port = (bridge as any).addr.port;
  try {
    const noToken = await preflight(port, { harness: "claude-code" });
    assertEquals(noToken.status, 403);
    assertEquals(noToken.body, {
      ok: false,
      reason: "token-missing",
      detail: "authentication required: the bridge needs its shared token (paste it into the acp.token setting)",
    });

    const wrongToken = await preflight(port, { harness: "claude-code", token: "not-the-token" });
    assertEquals(wrongToken.status, 403);
    assertEquals(wrongToken.body.reason, "token-invalid");

    const webOrigin = await preflight(port, { token: TEST_BRIDGE_TOKEN, origin: "https://evil.example" });
    assertEquals(webOrigin.status, 403);
    assertEquals(webOrigin.body.reason, "origin-rejected");

    const ok = await preflight(port, { harness: "claude-code", token: TEST_BRIDGE_TOKEN });
    assertEquals(ok.status, 200);
    assertEquals(ok.body, { ok: true });

    // A local script (no Origin) is still admitted past the origin guard and
    // authenticated by the token — the same contract as the upgrade itself.
    const okNoOrigin = await preflight(port, { token: TEST_BRIDGE_TOKEN, origin: null });
    assertEquals(okNoOrigin.status, 200);
    assertEquals(okNoOrigin.body, { ok: true });
  } finally {
    await bridge.shutdown();
  }
});

Deno.test("acpPreflightUrl: derives the HTTP probe from a WS endpoint, keeping token + harness", () => {
  assertEquals(
    acpPreflightUrl("ws://127.0.0.1:3210/acp?harness=claude-code"),
    "http://127.0.0.1:3210/acp/preflight?harness=claude-code",
  );
  assertEquals(
    acpPreflightUrl("ws://127.0.0.1:3210/acp?token=s3cret&harness=codex"),
    "http://127.0.0.1:3210/acp/preflight?token=s3cret&harness=codex",
  );
  assertEquals(
    acpPreflightUrl("wss://harness.example/acp?token=s3cret"),
    "https://harness.example/acp/preflight?token=s3cret",
  );
  assertEquals(acpPreflightUrl(""), "");
  assertEquals(acpPreflightUrl("http://127.0.0.1:3210/acp"), "");
  assertEquals(acpPreflightUrl("not-a-url"), "");
});

Deno.test("acpConnectionErrorMessage: maps each refusal reason to actionable words", () => {
  assert(
    /Authentication required/.test(acpConnectionErrorMessage({ reason: "token-missing", detail: "" })),
    "token-missing must say authentication is required",
  );
  assert(
    /acp\.token setting/.test(acpConnectionErrorMessage({ reason: "token-missing", detail: "" })),
    "token-missing must name the acp.token setting",
  );
  assert(
    /does not match/.test(acpConnectionErrorMessage({ reason: "token-invalid", detail: "" })),
    "token-invalid must say the token does not match",
  );
  assert(
    /Origin rejected/.test(acpConnectionErrorMessage({ reason: "origin-rejected", detail: "" })),
    "origin-rejected must say the origin was rejected",
  );
  // Unknown reasons fall back to the bridge's detail; no refusal means no message.
  assertEquals(acpConnectionErrorMessage(null), "");
  assert(
    /Failed to connect/.test(acpConnectionErrorMessage({ reason: "refused", detail: "HTTP 500" })),
    "an unrecognised refusal still surfaces the detail",
  );
});

Deno.test("AcpClient.connect: a refused upgrade surfaces the bridge's token-missing reason", async () => {
  const realWebSocket = globalThis.WebSocket;
  const realFetch = globalThis.fetch;
  const endpoint = "ws://127.0.0.1:3210/acp?harness=claude-code";
  let instance: any = null;
  try {
    // A fake WebSocket that reproduces the browser's refused-upgrade sequence:
    // an opaque "error", then close 1006 (no server status or body exposed).
    class FakeWebSocket {
      url: string;
      onopen: ((...a: any[]) => void) | null = null;
      onerror: ((...a: any[]) => void) | null = null;
      onclose: ((...a: any[]) => void) | null = null;
      onmessage: ((...a: any[]) => void) | null = null;
      constructor(url: string) { this.url = url; instance = this; }
      close() {}
      send() {}
    }
    (globalThis as any).WebSocket = FakeWebSocket;

    // The preflight the client performs reads the JSON reason the browser hid.
    let preflightUrl = "";
    (globalThis as any).fetch = async (url: any) => {
      preflightUrl = String(url);
      return new Response(
        JSON.stringify({ ok: false, reason: "token-missing", detail: "authentication required" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new AcpClient({ url: endpoint });
    const connecting = client.connect();
    instance.onerror?.({});
    instance.onclose?.({ code: 1006, reason: "" });

    await assertRejects(() => connecting, Error, "Authentication required");
    await assertRejects(() => connecting, Error, "acp.token setting");

    // The probe carried the SAME endpoint's query so it reported THIS refusal.
    assertEquals(preflightUrl, "http://127.0.0.1:3210/acp/preflight?harness=claude-code");
  } finally {
    globalThis.WebSocket = realWebSocket;
    globalThis.fetch = realFetch;
  }
});

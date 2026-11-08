// tests/mcp-client-egress-guard.test.ts — chrome-agent-platform-aix7j
// (GHSA-6prh-2h8m-c8cw).
//
// THE DEFECT. `createRemoteTransport` handed the OWNER-CONFIGURED `headers` —
// which carry the owner's Authorization token — to the SDK transports with no
// fetch override, so the SDK's own fetch followed a 3xx and re-sent those
// headers (and the request body) to whatever origin the MCP server named. A
// compromised server could therefore move a token reused for a second service
// to an attacker-chosen host. Every other egress surface in the repo already
// refuses this (lib/site-docs-fallback.js, lib/ask-agent-entry.js,
// lib/skill-import.js, lib/python-network.js: the owner grants an ORIGIN, not
// whatever that origin points at next); the MCP client was the one path that
// skipped the rule.
//
// WHAT THIS DRIVES. The REAL `createGuardedMcpFetch` from
// extension/lib/mcp-client-core.js against a fake fetch that records every
// request it is asked to issue. The recording is the assertion surface: what
// matters is not that the call failed, but that the token-bearing request was
// never ISSUED to the foreign origin at all.
//
// THE MUTANT THIS FILE IS CALIBRATED AGAINST: revert the guard to a pass-through
// (`(url, init) => fetchImpl(url, init)`, i.e. the pre-fix SDK default) and every
// refusal test goes RED — the recorder then shows the second request carrying
// `authorization` to evil.example. The browser-shaped cases (q7ti9) add a second
// mutant: refuse every opaque redirect instead of resolving it, and the
// same-origin opaque test goes RED while the refusals stay green. Both verified.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  MCP_EGRESS_MAX_REDIRECT_HOPS,
  McpEgressRefusedError,
  createGuardedMcpFetch,
} from "../extension/lib/mcp-client-core.js";

const SERVER = "https://mcp.example.com";
const TOKEN_HEADERS = { authorization: "Bearer owner-token-123", "content-type": "application/json" };

type Issued = { url: string; init: any };
type Step = (url: string | URL, init?: any) => Response | Promise<Response>;

/** A fetch that answers from a script and records every request it issues. */
function recordingFetch(script: Step[]) {
  const issued: Issued[] = [];
  const fetchImpl = async (input: any, init?: any): Promise<Response> => {
    issued.push({ url: String(input instanceof URL ? input.href : input), init });
    const next = script.shift();
    if (!next) throw new Error(`recordingFetch: unscripted request to ${input}`);
    return await next(input, init);
  };
  return { fetchImpl, issued };
}

const ok = (): Response => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const redirect = (to: string, status = 307): Response =>
  new Response(null, { status, headers: { location: to } });
// What a browser service worker actually returns for redirect:"manual".
const opaque = (): Response => ({ type: "opaqueredirect", status: 0, headers: new Headers() }) as unknown as Response;

/** Every issued request that could carry the owner's credential off-origin. */
function tokenRequestsTo(issued: Issued[], origin: string) {
  return issued.filter((r) => {
    try {
      return new URL(r.url).origin === origin && r.init?.headers?.authorization;
    } catch {
      return false;
    }
  });
}

Deno.test("mcp egress: a redirect to another origin is REFUSED and the token never leaves", async () => {
  const { fetchImpl, issued } = recordingFetch([
    () => redirect("https://evil.example/collect"),
  ]);
  const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });

  let refused = null;
  try {
    await guarded(`${SERVER}/mcp`, { method: "POST", headers: TOKEN_HEADERS, body: "{}" });
  } catch (e) {
    refused = e;
  }
  assert(refused instanceof McpEgressRefusedError, `must refuse as an egress refusal: ${refused}`);
  assert(
    !issued.some((r) => r.url.startsWith("https://evil.example")),
    "the foreign origin must never be requested — the headers ride the request, so issuing it IS the leak",
  );
  assertEquals(issued.length, 1, "exactly one request, to the configured origin");
  // The policy is set by the guard, never inherited from the caller.
  assertEquals(issued[0].init.redirect, "manual");
});

// ── the BROWSER shape (q7ti9, superseded by iaccg) ────────────────────────
// A real service worker answers `redirect: "manual"` with an opaque response:
// status 0, NO readable Location. iaccg: the guard must not probe it. The old
// probe was a header-free GET with `redirect: "follow"` — the browser walked
// the ENTIRE redirect chain before the guard checked the landing origin, so a
// probe that started at the allowed origin could fetch from any intermediate
// hop (internal, link-local, anything). There is nothing inspectable to
// re-validate per hop, so an opaque redirect is refused outright.

Deno.test("mcp egress (browser shape): an opaque redirect to a second origin is REFUSED with exactly ONE request issued — no follow-probe (iaccg)", async () => {
  // The fixture models a server whose guarded request is answered with a
  // redirect toward a second origin; the opaque shape hides the destination by
  // construction (that is the point). The script holds ONLY the guarded
  // attempt: if the follow-probe is restored, the guard issues a SECOND fetch
  // (the probe) — an unscripted request that recordingFetch throws on, or
  // issued.length === 2 — and this test goes RED. The call-count assertion is
  // the falsifier for iaccg on the real guard path.
  const { fetchImpl, issued } = recordingFetch([() => opaque()]);
  const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });
  let refused = null;
  try {
    await guarded(`${SERVER}/mcp`, { method: "POST", headers: TOKEN_HEADERS, body: "{}" });
  } catch (e) {
    refused = e;
  }
  assert(refused instanceof McpEgressRefusedError, `an opaque redirect must be refused: ${refused}`);
  assertEquals(
    issued.length,
    1,
    `the guarded attempt is the ONLY request; restoring the follow-probe issues a second one (iaccg falsifier): ${JSON.stringify(issued)}`,
  );
  assertEquals(issued[0].init.redirect, "manual", "the one request is the guarded, manual attempt");
  assert(
    issued.every((r) => new URL(r.url).origin === SERVER),
    "every issued request stays on the configured origin",
  );
  assert(
    /point this MCP server's config at the final url/.test(String(refused.message)),
    `the refusal must be actionable for an operator: ${refused.message}`,
  );
});

Deno.test("mcp egress (fd586): a SCHEME upgrade is NOT same-origin and is refused", async () => {
  // origin includes the scheme, so http://host -> https://host is off-origin. The
  // comment used to claim the opposite; this pins the code's actual policy.
  const httpServer = "http://mcp.example.com";
  const { fetchImpl, issued } = recordingFetch([() => redirect("https://mcp.example.com/mcp")]);
  const guarded = createGuardedMcpFetch({ origin: httpServer, fetchImpl });
  let refused = null;
  try {
    await guarded(`${httpServer}/mcp`, { headers: TOKEN_HEADERS });
  } catch (e) {
    refused = e;
  }
  assert(refused instanceof McpEgressRefusedError, `a scheme upgrade must be refused: ${refused}`);
  assert(!issued.some((r) => r.url.startsWith("https://")), "the upgraded origin is never requested");
});

Deno.test("mcp egress: a SAME-origin redirect is still followed (legitimate moves keep working)", async () => {
  // http->https and /mcp -> /mcp/v2 are real deployment moves on the SAME
  // origin. Refusing them would break working servers for no security gain: the
  // owner's grant is the origin.
  const { fetchImpl, issued } = recordingFetch([
    () => redirect(`${SERVER}/mcp/v2`),
    () => ok(),
  ]);
  const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });
  const res = await guarded(`${SERVER}/mcp`, { method: "POST", headers: TOKEN_HEADERS, body: "{}" });

  assertEquals(res.status, 200);
  assertEquals(issued.map((r) => r.url), [`${SERVER}/mcp`, `${SERVER}/mcp/v2`]);
  assertEquals(tokenRequestsTo(issued, "https://mcp.example.com").length, 2, "both hops are the granted origin");
  for (const r of issued) assertEquals(r.init.redirect, "manual");
});

Deno.test("mcp egress: a relative Location is resolved against the CURRENT hop, and stays same-origin", async () => {
  const { fetchImpl, issued } = recordingFetch([
    () => redirect("/mcp/session-2"),
    () => ok(),
  ]);
  const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });
  await guarded(`${SERVER}/mcp`, { headers: TOKEN_HEADERS });
  assertEquals(issued.map((r) => r.url), [`${SERVER}/mcp`, `${SERVER}/mcp/session-2`]);
});

Deno.test("mcp egress: a pre-emptive request to a FOREIGN url is refused before it is issued", async () => {
  // The SDK builds request URLs from server-supplied values (session ids, the
  // SSE endpoint event). None of them may be able to move the request off the
  // configured origin.
  const { fetchImpl, issued } = recordingFetch([() => ok()]);
  const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });
  let refused = null;
  try {
    await guarded("https://evil.example/mcp", { headers: TOKEN_HEADERS });
  } catch (e) {
    refused = e;
  }
  assert(refused instanceof McpEgressRefusedError);
  assertEquals(issued.length, 0, "nothing is sent to a foreign origin, not even once");
});

Deno.test("mcp egress: a redirect chain is bounded", async () => {
  const script = Array.from({ length: MCP_EGRESS_MAX_REDIRECT_HOPS + 2 }, () => () => redirect(`${SERVER}/next`));
  const { fetchImpl, issued } = recordingFetch(script);
  const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });
  let refused = null;
  try {
    await guarded(`${SERVER}/mcp`, { headers: TOKEN_HEADERS });
  } catch (e) {
    refused = e;
  }
  assert(refused instanceof McpEgressRefusedError, "a loop must terminate as a refusal");
  assertEquals(issued.length, MCP_EGRESS_MAX_REDIRECT_HOPS + 1, "hops are bounded, not unbounded");
});

Deno.test("mcp egress: a 3xx with no Location, and an invalid Location, are refusals", async () => {
  for (const res of [
    () => new Response(null, { status: 302 }),
    () => new Response(null, { status: 302, headers: { location: "http://[invalid" } }),
  ]) {
    const { fetchImpl, issued } = recordingFetch([res]);
    const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });
    let refused = null;
    try {
      await guarded(`${SERVER}/mcp`, { headers: TOKEN_HEADERS });
    } catch (e) {
      refused = e;
    }
    assert(refused instanceof McpEgressRefusedError, `must refuse: ${refused}`);
    assertEquals(issued.length, 1);
  }
});

Deno.test("mcp egress: a 2xx is returned untouched, and the transport wiring uses the guard", async () => {
  const { fetchImpl, issued } = recordingFetch([() => ok()]);
  const guarded = createGuardedMcpFetch({ origin: SERVER, fetchImpl });
  const res = await guarded(`${SERVER}/mcp`, { method: "POST", headers: TOKEN_HEADERS, body: "{}" });
  assertEquals(res.status, 200);
  assertEquals(issued[0].init.headers, TOKEN_HEADERS, "the caller's own headers are untouched");

  // Structural pin: BOTH transports are constructed with the guard. Reverting
  // either to the SDK's default fetch re-opens the redirect hole for that
  // transport, and only an assertion on the construction can see it.
  const source = await Deno.readTextFile(
    new URL("../extension/lib/mcp-client.js", import.meta.url),
  );
  assert(
    source.includes("createGuardedMcpFetch({ origin: url.origin })"),
    "createRemoteTransport must build the guard from the configured server origin",
  );
  const wired = source.match(/new (StreamableHTTPClientTransport|SSEClientTransport)\(url, \{ requestInit, fetch: guardedFetch \}\)/g) ?? [];
  assertEquals(
    wired.length,
    2,
    "both the Streamable-HTTP and the SSE transport must receive the guarded fetch",
  );
});

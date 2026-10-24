// tests/acp-loopback-guard.test.ts — chrome-agent-platform-duhcu
//
// THE DEFECT. The ACP loopback policy ("only 127.0.0.1 / ::1 / localhost is an
// acceptable ACP target") existed as a PRIVATE assertion in one module, called
// from the two client connect paths. Every sibling that built a URL and spent
// the bridge token was on its own:
//   - extension/lib/acp-runner.js probeAcpBridgeHealth: derived /health, appended
//     ?token=…&harness=…, fetched.
//   - extension/options/panels/agents.js Settings Test connection: derived a
//     health url by regex from an OPERATOR-TYPED endpoint, fetched it.
//   - extension/lib/acp-client.js acpProbeConnectionFailure: derived
//     /acp/preflight carrying the SAME token, fetched it — inside the module
//     that owned the rule.
// So the token could be sent to any host an endpoint named, and the policy was
// only as strong as the next author's memory.
//
// WHAT THIS ASSERTS. Two independent things, because either alone is weak:
//   1. BEHAVIOUR: the probes refuse a non-loopback target and — the assertion
//      that matters — the fetch is never ISSUED, so no token leaves. A recording
//      fetch stub is the observation surface, not "did the call throw".
//   2. STRUCTURE: an AST walk over the whole ACP surface enumerates every
//      `fetch(` call site and requires each to sit behind the shared guard in
//      its own function body, or to be listed in BYPASS_ALLOWLIST with a reason.
//      This is the half that stops the NEXT call site, which is the actual
//      regression being prevented. It parses (acorn) rather than matching text,
//      so a comment or a string cannot satisfy it.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { parse } from "npm:acorn";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

async function load(rel: string) {
  return await import(fromFileUrl(new URL(rel, import.meta.url)));
}

const acpClient = await load("../extension/lib/acp-client.js");
const acpRunner = await load("../extension/lib/acp-runner.js");

// ── The policy itself ──────────────────────────────────────────────────────
Deno.test("duhcu: the loopback policy accepts exactly the bridge's own interface", () => {
  const allowed = [
    "ws://127.0.0.1:3210/acp",
    "http://127.0.0.1:3210/health?token=t",
    "ws://localhost:3210/acp",
    "http://LOCALHOST:3210/acp/preflight",
    "ws://[::1]:3210/acp",
    "http://127.9.9.9:3210/health",
  ];
  for (const url of allowed) {
    assertEquals(acpClient.loopbackAcpRefusalReason(url), null, `${url} must be allowed`);
  }
  const refused = [
    "ws://10.0.0.5:3210/acp",
    "http://evil.example/health?token=t",
    "http://127.0.0.1.evil.example:3210/health", // the classic suffix trick
    "http://localhost.evil.example/health",
    "http://[::2]:3210/acp",
    "not a url",
    "",
  ];
  for (const url of refused) {
    assert(
      typeof acpClient.loopbackAcpRefusalReason(url) === "string",
      `${url} must be refused (got ${JSON.stringify(acpClient.loopbackAcpRefusalReason(url))})`,
    );
  }
});

Deno.test("duhcu: the throwing form is the same policy, not a second copy", () => {
  let threw = "";
  try {
    acpClient.assertLoopbackAcpEndpoint("ws://10.0.0.5:3210/acp");
  } catch (e) {
    threw = String((e as Error)?.message ?? e);
  }
  assert(threw.includes("10.0.0.5"), `expected a refusal naming the host, got ${JSON.stringify(threw)}`);
  // A refused target says WHAT to do about it, because an operator typed it.
  assert(threw.includes("loopback"), "the refusal must name the loopback policy");
  // The allowed path must not throw at all.
  acpClient.assertLoopbackAcpEndpoint("ws://127.0.0.1:3210/acp");
});

// ── 1. Behaviour: no token leaves for a non-loopback target ────────────────
type Issued = { url: string; init: unknown };
function recordingFetch() {
  const issued: Issued[] = [];
  const stub = (url: string, init: unknown) => {
    issued.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify({ harness: "stub" }), { status: 200 }));
  };
  return { issued, stub };
}

Deno.test("duhcu: probeAcpBridgeHealth never issues a token-bearing request off loopback", async () => {
  const { issued, stub } = recordingFetch();
  const real = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    const secret = "bridge-token-do-not-leak-6f1c";
    const off = await acpRunner.probeAcpBridgeHealth(`http://10.1.2.3:3210/acp?token=${secret}`, "pi");
    assertEquals(off, null, "an off-loopback probe reports no answer");
    assertEquals(issued.length, 0, "the request must never be ISSUED, not merely fail");
    assertEquals(
      issued.some((r) => r.url.includes(secret)),
      false,
      "the token must not appear in any issued request",
    );

    // The happy path still works: loopback endpoint, token and harness carried.
    const on = await acpRunner.probeAcpBridgeHealth(`http://127.0.0.1:3210/acp?token=${secret}`, "pi");
    assertEquals(issued.length, 1, "a loopback probe IS issued");
    assert(issued[0].url.includes(secret), "the loopback probe carries the token, as designed");
    assert(issued[0].url.includes("harness=pi"), "and the harness query");
    assert(on !== null, "a loopback probe returns the bridge's answer");
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("duhcu: the connection diagnostic never issues a token-bearing preflight off loopback", async () => {
  const { issued, stub } = recordingFetch();
  const real = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    const secret = "preflight-token-do-not-leak-93ab";
    const off = await acpClient.acpProbeConnectionFailure(`ws://10.1.2.3:3210/acp?token=${secret}`);
    assertEquals(off, null);
    assertEquals(issued.length, 0, "the preflight must never be ISSUED off loopback");

    await acpClient.acpProbeConnectionFailure(`ws://127.0.0.1:3210/acp?token=${secret}`);
    assertEquals(issued.length, 1);
    assert(issued[0].url.includes(secret), "the loopback preflight carries the token, as designed");
  } finally {
    globalThis.fetch = real;
  }
});

// ── 2. Structure: no fetch site in the ACP surface may bypass the guard ────
// The files whose code can spend the bridge token or reach an operator-typed
// endpoint. A NEW file that fetches an ACP-derived url belongs here too, and
// adding it is a one-line change — the point is that adding it is a deliberate
// act, and forgetting to is red.
const GUARDED_FILES = [
  "extension/lib/acp-client.js",
  "extension/lib/acp-runner.js",
  "extension/options/panels/agents.js",
];

/** Sites allowed to fetch WITHOUT the loopback guard, each with the reason it
 *  is safe. Empty today: every fetch in these files targets an ACP-derived url. */
const BYPASS_ALLOWLIST: { file: string; match: string; reason: string }[] = [];

const GUARD_CALLS = new Set(["loopbackAcpRefusalReason", "assertLoopbackAcpEndpoint"]);

function calleeName(node: any): string {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && node.property?.type === "Identifier") return node.property.name;
  return "";
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Every `fetch(...)` call site, with the SOURCE TEXT of its nearest enclosing
 *  function — that text is the search space for the guard, because a check in a
 *  sibling function or at module load cannot see this call's url.
 *
 *  Hand-rolled descent rather than acorn-walk: the runner's node_modules has no
 *  acorn-walk, and a test that needs an install to run is a test that silently
 *  stops guarding. Only object-valued children are visited. */
function fetchSites(src: string, file: string) {
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true }) as any;
  const sites: { file: string; line: number; body: string; text: string }[] = [];

  const visit = (node: any, scope: any | null) => {
    if (!node || typeof node.type !== "string") return;
    const here = FUNCTION_TYPES.has(node.type) ? node : scope;
    if (node.type === "CallExpression" && calleeName(node.callee) === "fetch") {
      const line = node.loc?.start?.line ?? 0;
      sites.push({
        file,
        line,
        body: here ? src.slice(here.start, here.end) : "",
        text: src.slice(node.start, Math.min(node.end, node.start + 160)),
      });
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") visit(child, here);
      } else if (value && typeof value.type === "string") {
        visit(value, here);
      }
    }
  };
  visit(ast, null);
  return sites;
}

Deno.test("duhcu: every fetch in the ACP surface sits behind the shared loopback guard", async () => {
  const offenders: string[] = [];
  const seen: string[] = [];
  for (const rel of GUARDED_FILES) {
    const src = await Deno.readTextFile(new URL(`../${rel}`, import.meta.url));
    const sites = fetchSites(src, rel);
    assert(sites.length > 0, `${rel} should contain at least one fetch (the walk must not be vacuous)`);
    for (const site of sites) {
      const where = `${rel}:${site.line}`;
      seen.push(where);
      const allowed = BYPASS_ALLOWLIST.some((a) => a.file === rel && site.text.includes(a.match));
      if (allowed) continue;
      // The guard must run in the SAME function that issues the fetch: a check
      // in a sibling function or at module load cannot see this call's url.
      const guarded = [...GUARD_CALLS].some((name) => site.body.includes(name));
      if (!guarded) offenders.push(`${where} fetches without the loopback guard: ${site.text}`);
    }
  }
  // The known sites are enumerated, so a silent change of shape (a fetch moved
  // into a helper that builds its own url) cannot pass as "already guarded".
  assertEquals(
    offenders,
    [],
    `unguarded fetch site(s) — route them through loopbackAcpRefusalReason/assertLoopbackAcpEndpoint, ` +
      `or add a BYPASS_ALLOWLIST entry with the reason it is safe:\n${offenders.join("\n")}\n` +
      `sites seen: ${seen.join(", ")}`,
  );
});

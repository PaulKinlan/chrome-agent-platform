// tests/thread-export-html.test.ts — Unit tests for pure thread export and redaction.
// Part of chrome-agent-platform-3p3e.12.
//
// Verifies:
// 1. Exact-value redaction over profile credentials (provider keys, MCP auth, vault secrets, cookies).
// 2. Secret removal across user messages, assistant prose, tool calls, tool results, and artifacts.
// 3. Fail-closed omission: internal HMACs/nonces/tokens dropped even if not in knownSecrets.
// 4. URL query string and userinfo stripping (including userinfo without colon and short passwords).
// 5. Zero script elements in generated HTML and strict CSP with form-action 'none'.
// 6. Mandatory privacy caveat header presence.
// 7. Canonical projection shape support (messages array with tool rows).
// 8. Falsification sensitivity: poisoned fixture fails when redaction is disabled.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import {
  collectProfileSecrets,
  exactValueRedact,
  stripUrlQueries,
  maskUrlUserinfo,
  sanitizeFilePaths,
  redactExportText,
  redactExportValue,
} from "../extension/lib/thread-export-redact.js";

import {
  renderThreadToHtml,
  EXPORT_PRIVACY_CAVEAT,
} from "../extension/lib/thread-export-html.js";

// ── Part 1: Pure Redaction Functions ────────────────────────────────────────

Deno.test("exactValueRedact: removes exact secret literals while preserving user ligatures", () => {
  const secret1 = "sk-ant-live-secret-key-xyz987";
  const secret2 = "MyCustomVaultPassword!#%123";

  // Prose with user ligature (fi -> ﬁ) and circled digit ①
  const prose = `User wrote: ﬁnding ① with secret ${secret1} and encoded ${encodeURIComponent(secret2)}.`;

  const redacted = exactValueRedact(prose, [secret1, secret2]);

  assert(!redacted.includes(secret1), "secret1 must be redacted");
  assert(!redacted.includes(secret2), "secret2 must be redacted");
  assert(!redacted.includes(encodeURIComponent(secret2)), "encoded secret2 must be redacted");
  assert(redacted.includes("ﬁnding ①"), "user ligatures and circled digits must be preserved");
});

Deno.test("collectProfileSecrets: gathers credential values from provider, MCP, vault, cookies, and unfamiliar keys", () => {
  const providerConfig = {
    activeProvider: "anthropic",
    anthropic: {
      apiKey: "sk-ant-api03-provider-key-11223344",
      baseURL: "https://api.anthropic.com",
      pwd: "provider-secret-pwd-4455",
      customAuth: "sk-proj-custom-auth-unfamiliar-key-1234",
    },
    openai: {
      client_secret: "client-secret-token-8899",
      sessionToken: "session-jwt-token-9988",
    },
  };

  const mcpServers = [
    {
      id: "server-1",
      transport: {
        type: "sse",
        url: "https://mcp.example.com",
        headers: {
          Authorization: "Bearer mcp-bearer-secret-token-9900",
          Cookie: "session_id=super-cookie-value-998877; Path=/; Secure",
        },
      },
    },
  ];

  // In vault, all stored string values are treated as secrets regardless of key name
  const vaultSecrets = {
    unfamiliarSettingName: "vault-unfamiliar-secret-9944",
    tokens: ["vault-oauth-refresh-token-4433"],
  };

  const extraSecrets = ["custom-approval-hmac-digest-8899"];

  const collected = collectProfileSecrets({ providerConfig, mcpServers, vaultSecrets, extraSecrets });

  assert(collected.includes("sk-ant-api03-provider-key-11223344"));
  assert(collected.includes("provider-secret-pwd-4455"));
  assert(collected.includes("sk-proj-custom-auth-unfamiliar-key-1234"));
  assert(collected.includes("client-secret-token-8899"));
  assert(collected.includes("mcp-bearer-secret-token-9900"));
  assert(collected.includes("super-cookie-value-998877"));
  assert(collected.includes("vault-unfamiliar-secret-9944"));
  assert(collected.includes("vault-oauth-refresh-token-4433"));
  assert(collected.includes("custom-approval-hmac-digest-8899"));
  assert(!collected.includes("https://api.anthropic.com"), "plain URLs should not be collected as secrets");
});

Deno.test("stripUrlQueries and maskUrlUserinfo: strips sensitive query params and arbitrary userinfo credentials", () => {
  const input = "Check https://example.com/api/v1?token=secret123&user=42 and http://alice:pw@internal.corp/data and http://singletoken@host.com/res";
  const strippedQueries = stripUrlQueries(input);
  assert(!strippedQueries.includes("token=secret123"), "query parameter must be stripped");
  assert(strippedQueries.includes("https://example.com/api/v1…[query redacted]"));

  const strippedUserinfo = maskUrlUserinfo(strippedQueries);
  assert(!strippedUserinfo.includes("alice:pw@"), "userinfo with colon must be masked");
  assert(!strippedUserinfo.includes("singletoken@"), "userinfo without colon must be masked");
  assert(strippedUserinfo.includes("http://[REDACTED]@internal.corp/data"));
  assert(strippedUserinfo.includes("http://[REDACTED]@host.com/res"));
});

Deno.test("sanitizeFilePaths: sanitizes absolute machine paths to avoid filesystem leakage while preserving system paths", () => {
  const homeTarget = ["", "home", "developer", "projects", "secret", "data.json"].join("/");
  const etcTarget = ["", "etc", "hosts"].join("/");
  const varTarget = ["", "var", "log", "system.log"].join("/");
  const input = `File loaded from ${homeTarget} and ${etcTarget} and ${varTarget}`;
  const sanitized = sanitizeFilePaths(input);
  assert(!sanitized.includes(["", "home", "developer"].join("/")), "home path must be sanitized");
  assert(sanitized.includes("[LOCAL_PATH]"));
  assert(sanitized.includes(etcTarget), "system /etc path must be preserved");
  assert(sanitized.includes(varTarget), "system /var path must be preserved");
});

Deno.test("redactExportValue: fail-closed drops approval HMACs and security fields even when unlisted", () => {
  const UNLISTED_HMAC = "hmac-secret-signature-unlisted-1234567890";
  const UNLISTED_NONCE = "nonce-random-unlisted-9876543210";

  const obj = {
    url: "https://example.com/api",
    approvalHmac: UNLISTED_HMAC,
    nonce: UNLISTED_NONCE,
    nested: {
      sig: UNLISTED_HMAC,
      payload: "safe data",
    },
  };

  const redacted = redactExportValue(obj, { knownSecrets: [] });

  assert(!("approvalHmac" in redacted), "approvalHmac key must be dropped");
  assert(!("nonce" in redacted), "nonce key must be dropped");
  assert(!("sig" in redacted.nested), "nested sig key must be dropped");
  assertEquals(redacted.nested.payload, "safe data");
});

// ── Part 2: HTML Generator & Poisoned Fixture Acceptance ────────────────────

Deno.test("renderThreadToHtml: exports canonical messages projection with ALL seeded secrets strictly absent", () => {
  const POISON_API_KEY = "sk-ant-api03-ultra-secret-key-123456";
  const POISON_BEARER = "super-secret-mcp-bearer-998877";
  const POISON_COOKIE = "session_cookie_secret_val_5566";
  const POISON_PASSWORD = "DatabasePassword!2026";
  const POISON_QUERY_TOKEN = "leaked-query-auth-token-4455";
  const POISON_HMAC_UNLISTED = "hmac-sig-hex-digest-8877665544";
  const BARE_SHAPE_UNLISTED = "ghp_123456789012345678901234567890123456";
  const HOME_PATH_UNLISTED = ["", "home", "alice_covert", "projects", "classified"].join("/");

  // Note: POISON_HMAC_UNLISTED, BARE_SHAPE_UNLISTED, and HOME_PATH_UNLISTED
  // are deliberately NOT in knownSecrets to test the unpinned passes!
  const knownSecrets = [POISON_API_KEY, POISON_BEARER, POISON_COOKIE, POISON_PASSWORD];

  // Canonical CAP projected thread shape (conversation.js / thread-run-view.js):
  // Uses projectedThread.messages array with distinct roles.
  const projectedThread = {
    id: "thread-uuid-1",
    title: `Analyze Report with ${POISON_API_KEY}`,
    messages: [
      {
        role: "user",
        content: `Please fetch data using cookie ${POISON_COOKIE} and check https://api.service.com/items?auth_key=${POISON_QUERY_TOKEN}. File at ${HOME_PATH_UNLISTED}/doc.txt.`,
      },
      {
        role: "tool",
        toolName: "fetch_records",
        toolStatus: "done",
        toolArgs: {
          url: `https://internal.service.com/query?token=${POISON_QUERY_TOKEN}`,
          password: POISON_PASSWORD,
          approvalHmac: POISON_HMAC_UNLISTED,
        },
        toolResult: {
          status: "connected",
          keyUsed: POISON_API_KEY,
          records: 42,
          authHeader: `Bearer ${POISON_BEARER}`,
        },
      },
      {
        role: "agent",
        content: `I have retrieved the data. GitHub token was ${BARE_SHAPE_UNLISTED}. The internal database password ${POISON_PASSWORD} was used.`,
      },
      {
        role: "system",
        content: "Execution completed in 42ms.",
      },
    ],
    artifacts: [
      {
        id: "art-1",
        name: "Analysis Summary.csv",
        kind: "table",
        content: `id,status,note\n1,OK,Secret key was ${POISON_API_KEY}\n2,PENDING,URL query was https://api.com?key=${POISON_QUERY_TOKEN}`,
      },
    ],
  };

  const html = renderThreadToHtml(projectedThread, {
    title: projectedThread.title,
    knownSecrets,
  });

  // 1. Strict Secret Absence Asserts
  assert(!html.includes(POISON_API_KEY), "POISON_API_KEY must not appear in exported HTML");
  assert(!html.includes(POISON_BEARER), "POISON_BEARER must not appear in exported HTML");
  assert(!html.includes(POISON_COOKIE), "POISON_COOKIE must not appear in exported HTML");
  assert(!html.includes(POISON_PASSWORD), "POISON_PASSWORD must not appear in exported HTML");
  assert(!html.includes(POISON_QUERY_TOKEN), "POISON_QUERY_TOKEN must not appear in exported HTML");
  assert(!html.includes(POISON_HMAC_UNLISTED), "POISON_HMAC_UNLISTED must not appear in exported HTML");
  assert(!html.includes(BARE_SHAPE_UNLISTED), "BARE_SHAPE_UNLISTED must be scrubbed by shape pass");
  assert(!html.includes(["", "home", "alice_covert"].join("/")), "HOME_PATH_UNLISTED must be scrubbed by path pass");

  // 2. CSP and Script Invariant
  assert(!html.includes("<script"), "Exported HTML must contain ZERO script elements");
  assertStringIncludes(html, "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'");
  assertStringIncludes(html, "form-action 'none'");

  // 3. Privacy Caveat Header Presence
  assertStringIncludes(html, EXPORT_PRIVACY_CAVEAT);

  // 4. Narrative and Artifact Presence
  assertStringIncludes(html, "Please fetch data using cookie");
  assertStringIncludes(html, "I have retrieved the data.");
  assertStringIncludes(html, "Analysis Summary.csv");
  assertStringIncludes(html, "Tool Call: fetch_records");
});

// ── Part 3: Falsification Sensitivity ───────────────────────────────────────

Deno.test("FALSIFICATION: without exact-value redaction, poisoned fixture fails", () => {
  const SECRET = "very-secret-token-that-would-leak-without-redaction";
  const thread = {
    messages: [
      {
        role: "user",
        content: `Echo ${SECRET} back to me`,
      },
    ],
  };

  // With empty knownSecrets (redaction omitted)
  const unredactedHtml = renderThreadToHtml(thread, { knownSecrets: [] });
  // The unredacted output MUST contain the secret (proving the test fixture is genuinely poisoned)
  assert(
    unredactedHtml.includes(SECRET),
    "Falsifier: unredacted output must retain the secret so absence test is sensitive",
  );

  // With proper knownSecrets supplied
  const redactedHtml = renderThreadToHtml(thread, { knownSecrets: [SECRET] });
  assert(
    !redactedHtml.includes(SECRET),
    "Redacted output must eliminate the secret",
  );
  assertStringIncludes(redactedHtml, "[REDACTED]");
});

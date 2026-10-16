import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createThreadExportRoute, exportHtmlFilename, exportSenderAllowed } from "../extension/lib/thread-export-route.js";
import { renderThreadToHtml } from "../extension/lib/thread-export-html.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const hub = `chrome-extension://${extensionId}/ntp/ntp.html#thread=thread-1`;
const artifactPage = `chrome-extension://${extensionId}/artifact/artifact.html?id=artifact-1&origin=master`;
const owner = (url = hub) => ({ principal: "extension", sender: { id: extensionId, url } });
const forbidden = "sk-ant-very-private-value-246810";
const vaultValue = "vault-password-special-778899";
const cookie = "session-cookie-value-213456";
const mcpToken = "mcp-password-unique-995522";
const hmac = "approval-hmac-private-882233";
const unlistedShape = "ghp_123456789012345678901234567890123456";
const thread = {
  id: "thread-1",
  name: "Customer summary",
  messages: [
    { role: "user", content: `Summarize ${forbidden} with cookie ${cookie} and literal <script>alert(1)</script>` },
    { role: "tool", toolName: "summarize", toolArgs: { approvalHmac: hmac, instruction: vaultValue }, toolResult: `Response ${mcpToken}` },
    { role: "assistant", content: `Summary is complete. Secret-shaped ${unlistedShape}` },
  ],
  artifacts: [{ id: "artifact-1", name: "Report", kind: "text", content: `Final report ${forbidden} / ${vaultValue}` }],
};
const artifact = { id: "artifact-1", name: "Status report", kind: "text", content: `Summary body ${cookie}, ${forbidden}, ${vaultValue}` };

function handler(overrides = {}) {
  return createThreadExportRoute({
    extensionId,
    getThreadView: async (id: string) => id === thread.id ? { ok: true, thread } : { ok: false },
    getArtifact: async (origin: string, id: string) => origin === "master" && id === artifact.id ? { ok: true, asset: artifact } : { ok: false },
    getProviderConfig: async () => ({ provider: "anthropic", apiKey: forbidden, cookie }),
    getCredentialStores: async () => ({ globalMcpServers: [{ auth: { token: mcpToken } }], namedAgents: [] }),
    listVaultKeys: async () => ["CUSTOM_PASSWORD"],
    readVaultSecret: async () => vaultValue,
    ...overrides,
  });
}

Deno.test("export route: both Chrome-attested sender.id and exact page path are required", async () => {
  assert(exportSenderAllowed(owner(), extensionId, "thread"));
  assert(exportSenderAllowed(owner(artifactPage), extensionId, "artifact"));
  for (const context of [
    { principal: "model", sender: { id: extensionId, url: hub } },
    { principal: "page", sender: { id: extensionId, url: hub } },
    { principal: "extension", sender: { id: "another-extension", url: hub } },
    owner(`chrome-extension://${extensionId}/ntp/ntp.html.evil#thread=thread-1`),
    owner(`chrome-extension://${extensionId}/options/options.html`),
    owner(`https://example.test/ntp/ntp.html`),
  ]) {
    assertEquals((await handler()({ kind: "thread", id: "thread-1" }, context)).error, "export_not_authorized");
  }
  assertEquals((await handler()({ kind: "thread", id: "thread-1" }, owner(artifactPage))).error, "export_not_authorized");
});

Deno.test("export route: authoritative thread, profile and vault data are redacted BEFORE templating", async () => {
  const result = await handler()({ kind: "thread", id: "thread-1", html: `<script>alert(1)</script>`, token: "caller-token" }, owner());
  assertEquals(result.ok, true);
  assertEquals(result.mimeType, "text/html");
  assertEquals(result.filename, "Customer summary.html");
  assert(typeof result.html === "string");
  assertStringIncludes(result.html, "Summary is complete");
  assertStringIncludes(result.html, "Summary body");
  assert(!result.html.includes("Final report"), "the stored artifact body, not stale inline metadata, is authoritative");
  assertStringIncludes(result.html, "Review before forwarding");
  assertStringIncludes(result.html, "Status report");
  for (const secret of [forbidden, vaultValue, cookie, mcpToken, hmac, unlistedShape, "caller-token"]) {
    assert(!result.html.includes(secret), `leaked secret ${secret.slice(0, 7)}`);
  }
  assert(!result.html.includes("<script"));
  assertStringIncludes(result.html, "default-src 'none'");
});

Deno.test("export route: renderer receives already-redacted DATA, not markup filtered afterward", async () => {
  let observed = false;
  const render = (view: Record<string, unknown>, options: { title: string; knownSecrets: string[]; artifacts: Record<string, unknown>[] }) => {
    observed = true;
    const data = JSON.stringify({ view, artifacts: options.artifacts, title: options.title });
    for (const secret of [forbidden, vaultValue, cookie, mcpToken, hmac]) {
      assert(!data.includes(secret), `raw ${secret.slice(0, 5)} reached template input`);
    }
    return renderThreadToHtml(view, options);
  };
  const result = await handler({ render })({ kind: "thread", id: "thread-1" }, owner());
  assert(observed, "template must be invoked");
  assertEquals(result.ok, true);
});

Deno.test("export route: one artifact returns one standalone HTML file without thread content", async () => {
  const result = await handler()({ kind: "artifact", id: "artifact-1", origin: "master" }, owner(artifactPage));
  assertEquals(result.ok, true);
  assertEquals(result.filename, "Status report.html");
  assert(typeof result.html === "string");
  assertStringIncludes(result.html, "Summary body");
  assert(!result.html.includes("Summarize "), "artifact export must not leak the parent thread");
  for (const secret of [forbidden, cookie, vaultValue]) assert(!result.html.includes(secret));
});

Deno.test("export route: a thread artifact row resolves the authoritative body, not just its metadata", async () => {
  const projected = { id: "thread-1", name: "Thread with artifact", messages: [
    { role: "user", content: "Make a report" },
    { role: "artifact", artifact: { id: "stored-asset-1", origin: "master", name: "Report metadata" } },
  ] };
  const actual = { id: "stored-asset-1", origin: "master", name: "Report body", kind: "text", content: `Complete stored deliverable ${vaultValue}` };
  const route = handler({
    getThreadView: async () => ({ ok: true, thread: projected }),
    getArtifact: async () => ({ ok: true, asset: actual }),
  });
  const result = await route({ kind: "thread", id: "thread-1" }, owner());
  assert(result.ok && typeof result.html === "string");
  assertStringIncludes(result.html, "Complete stored deliverable");
  assert(!result.html.includes(vaultValue));
  const missing = await handler({
    getThreadView: async () => ({ ok: true, thread: projected }),
    getArtifact: async () => ({ ok: false }),
  })({ kind: "thread", id: "thread-1" }, owner());
  assertEquals(missing, { ok: false, error: "export_unavailable" }, "never ship a complete-looking file with a missing artifact body");
});

Deno.test("export route: degraded or incomplete thread projections never masquerade as a complete export", async () => {
  for (const flag of ["hasMore", "viewDegraded", "repairFailed", "truncatedLogs"] as const) {
    const result = await handler({ getThreadView: async () => ({ ok: true, thread: { ...thread, [flag]: true } }) })(
      { kind: "thread", id: "thread-1" }, owner(),
    );
    assertEquals(result, { ok: false, error: "export_unavailable" });
  }
});

Deno.test("export route: unavailable vault inventory or raw value fails CLOSED without a partial HTML file", async () => {
  for (const h of [
    handler({ listVaultKeys: async () => { throw new Error(vaultValue); } }),
    handler({ readVaultSecret: async () => { throw new Error(vaultValue); } }),
    handler({ listVaultKeys: async () => null }),
  ]) {
    const result = await h({ kind: "thread", id: "thread-1" }, owner());
    assertEquals(result, { ok: false, error: "export_unavailable" });
  }
});

Deno.test("export route: an active known credential too short for the pure redactor refuses the entire file", async () => {
  for (const h of [
    handler({ getProviderConfig: async () => ({ apiKey: "abc" }) }),
    handler({ getCredentialStores: async () => ({ globalMcpServers: [{ auth: { token: "xyz" } }] }) }),
    handler({ readVaultSecret: async () => "pw" }),
  ]) {
    const result = await h({ kind: "thread", id: "thread-1" }, owner());
    assertEquals(result, { ok: false, error: "export_unavailable" });
  }
});

Deno.test("export route: residual known literal in static template fails CLOSED, not a leaked or partial file", async () => {
  // The renderer itself contains this literal in the mandatory caveat. It is
  // not thread data and should never be filtered as markup after rendering.
  const result = await handler({ getProviderConfig: async () => ({ apiKey: "Notice" }) })(
    { kind: "thread", id: "thread-1" }, owner(),
  );
  assertEquals(result, { ok: false, error: "export_redaction_incomplete" });
});

Deno.test("export route: invalid ids, injected raw content and filename traversal do not change authority", async () => {
  assertEquals((await handler()({ kind: "thread", id: "" }, owner())).error, "export_invalid_target");
  assertEquals((await handler()({ kind: "thread", id: `bad\nname` }, owner())).error, "export_invalid_target");
  assertEquals((await handler()({ kind: "artifact", id: "artifact-1", origin: "bad\rpath" }, owner(artifactPage))).error, "export_invalid_target");
  assertEquals(exportHtmlFilename("../private\\file\u0000.html"), "private-file.html");
  assertEquals(exportHtmlFilename("   "), "thread.html");
  assert(!/[\\/\u0000-\u001f]/.test(exportHtmlFilename("../../unsafe\tartifact.html")));
});

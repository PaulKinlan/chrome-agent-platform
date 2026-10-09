import { assert, assertEquals } from "jsr:@std/assert@1";
import { createEphemeralSiteToolConsentStore } from "../extension/lib/ephemeral-site-tool-consent.js";
import { formatAttachedDeclaredContext } from "../extension/lib/attached-webmcp-disclosure.js";

const origin = "https://declared.test";
const documentId = "chrome-document-one";
const tool = Object.freeze({ origin, name: "search_products", description: "Find products", inputSchema: { type: "object" }, source: "declared" });
const token = "aabbccddeeff00112233445566778899";
function setup() {
  const consentStore = createEphemeralSiteToolConsentStore();
  const bound = consentStore.begin({ runId: "run-1", threadId: "thread-1", origin, tabId: 7, documentId });
  const bindings = [{ candidate: { origin, tabId: 7, documentId, toolCount: 1 }, token: bound }];
  return { consentStore, bound, bindings };
}

Deno.test("ckebt Q2: only an active Chrome-attested run token projects bounded fenced descriptors", async () => {
  const { consentStore, bindings } = setup();
  const calls: unknown[] = [];
  const text = await formatAttachedDeclaredContext({ bindings, consentStore, untrustedToken: token,
    runActive: () => true,
    read: async (candidate: unknown) => { calls.push(candidate); return [tool]; },
  });
  assertEquals(calls, [{ origin, tabId: 7, documentId, toolCount: 1 }]);
  assert(text.includes("<<<UNTRUSTED run:" + token + ">>>"));
  assert(text.includes("search_products"));
  assert(!text.includes("invoke-tool"));
});

Deno.test("ckebt Q2: ended or cancelled run, wrong token/document, and absent fence disclose nothing", async () => {
  const { consentStore, bindings, bound } = setup();
  const read = async () => [tool];
  for (const config of [
    { runActive: () => false },
    { untrustedToken: null },
    { bindings: [{ ...bindings[0], candidate: { ...bindings[0].candidate, documentId: "wrong" } }] },
    { bindings: [{ ...bindings[0], token: Object.freeze({}) }] },
  ]) assertEquals(await formatAttachedDeclaredContext({ bindings, consentStore, untrustedToken: token,
    runActive: () => true, read, ...config }), "");
  consentStore.end(bound);
  assertEquals(await formatAttachedDeclaredContext({ bindings, consentStore, untrustedToken: token,
    runActive: () => true, read }), "");
});

Deno.test("ckebt Q2: cancellation during asynchronous page read and aggregate overflow fail closed", async () => {
  const { consentStore, bindings } = setup();
  let active = true;
  assertEquals(await formatAttachedDeclaredContext({ bindings, consentStore, untrustedToken: token,
    runActive: () => active,
    read: async () => { active = false; return [tool]; },
  }), "");
  const giant = { ...tool, description: "p".repeat(40000) };
  assertEquals(await formatAttachedDeclaredContext({ bindings, consentStore, untrustedToken: token,
    runActive: () => true, read: async () => [giant],
  }), "");
});

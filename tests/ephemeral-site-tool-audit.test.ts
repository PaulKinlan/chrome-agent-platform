import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createEphemeralSiteToolAuditPrincipal } from "../extension/lib/ephemeral-site-tool-audit.js";
import { createEphemeralSiteToolConsentStore } from "../extension/lib/ephemeral-site-tool-consent.js";

const origin = "https://booking.example";
const documentId = "document-51";
const runId = "run-51";
const make = () => {
  const store = createEphemeralSiteToolConsentStore();
  const token = store.begin({ origin, tabId: 51, documentId, runId });
  return { store, token };
};
const row = { ephemeral: true, enrollmentGen: 0, origin, documentId, runId, source: "declared", tool: "change-seat" };

Deno.test("ephemeral audit: only live run+top-level document attestation can append a required row", async () => {
  const { store, token } = make();
  let appended = 0;
  const principal = createEphemeralSiteToolAuditPrincipal({
    consentStore: store,
    attest: async (tabId: number) => ({ tabId, documentId, origin }),
    runActive: (id: string) => id === runId,
    append: async (value: object) => { appended++; return value; },
    profileEpoch: () => 1,
    resetting: () => false,
  });
  assertEquals(await principal.append(token, row), row);
  assertEquals(appended, 1);
  for (const forged of [
    { ...row, runId: "another-run" }, { ...row, origin: "https://evil.example" },
    { ...row, documentId: "stale-doc" }, { ...row, source: "inferred" },
    { ...row, ephemeral: false }, { ...row, enrollmentGen: 1 },
  ]) await assertRejects(() => principal.append(token, forged), Error, "site_tool_audit_unavailable");
  assertEquals(appended, 1);
  store.end(token);
  await assertRejects(() => principal.append(token, row), Error, "site_tool_audit_unavailable");
  assertEquals(appended, 1);
});

Deno.test("ephemeral audit: same-origin navigation, run end and reset mid-attestation refuse append", async () => {
  const { store, token } = make();
  let appended = 0;
  let active = true;
  let epoch = 7;
  let reset = false;
  let liveDocumentId = documentId;
  const principal = createEphemeralSiteToolAuditPrincipal({
    consentStore: store,
    attest: async (tabId: number) => ({ tabId, documentId: liveDocumentId, origin }),
    runActive: (_id: string) => active,
    append: async (value: object) => { appended++; return value; },
    profileEpoch: () => epoch,
    resetting: () => reset,
  });
  liveDocumentId = "document-52";
  await assertRejects(() => principal.append(token, row), Error, "site_tool_audit_unavailable");
  liveDocumentId = documentId;
  active = false;
  await assertRejects(() => principal.append(token, row), Error, "site_tool_audit_unavailable");
  active = true;
  reset = true;
  await assertRejects(() => principal.append(token, row), Error, "site_tool_audit_unavailable");
  reset = false;
  const epochChange = createEphemeralSiteToolAuditPrincipal({
    consentStore: store,
    attest: async (tabId: number) => { epoch++; return { tabId, documentId, origin }; },
    runActive: () => true,
    append: async (value: object) => { appended++; return value; },
    profileEpoch: () => epoch,
    resetting: () => false,
  });
  await assertRejects(() => epochChange.append(token, row), Error, "site_tool_audit_unavailable");
  assertEquals(appended, 0);
});

Deno.test("ephemeral audit: WAL failure is fail-closed, never an invocation permit", async () => {
  const { store, token } = make();
  const principal = createEphemeralSiteToolAuditPrincipal({
    consentStore: store,
    attest: async (tabId: number) => ({ tabId, documentId, origin }),
    runActive: () => true,
    append: async () => { throw new Error("disk unavailable"); },
    profileEpoch: () => 0,
    resetting: () => false,
  });
  await assertRejects(() => principal.append(token, row), Error, "site_tool_audit_unavailable");
});

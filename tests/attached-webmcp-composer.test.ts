import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { resolveComposerCommandSelection } from "../extension/shared/composer-commands.js";

const tab = { id: "tabs:9", kind: "tab", attachment: {
  kind: "tab", tabId: 9, name: "Owner-picked tab", url: "https://untrusted.example/attachment-text",
} };

Deno.test("3p3e.3: /tabs owner pick obtains browser-attested document only, never inserts model-visible descriptors", async () => {
  const sent: unknown[] = [];
  const picked = await resolveComposerCommandSelection(tab, { runtimeSend: async (route, payload) => {
    sent.push([route, payload]);
    return { ok: true, origin: "https://example.test", tabId: 9, documentId: "doc-one", toolCount: 2 };
  } });
  assertEquals(sent, [["agent.attached-webmcp-document", { tabId: 9 }]]);
  assertEquals(picked?.attachment?.documentId, "doc-one");
  assertEquals(picked?.attachment?.toolCount, undefined);
  assertEquals(picked?.text, "/tabs:9");
});

Deno.test("3p3e.3: /tabs scripting is requested only after owner pick; denied permission keeps ordinary tab context", async () => {
  const calls: string[] = [];
  const picked = await resolveComposerCommandSelection(tab, {
    runtimeSend: async () => { calls.push("reattest"); return { ok: false, needScripting: true }; },
    chromeApi: { permissions: { request: async () => { calls.push("request"); return false; } } },
  });
  assertEquals(calls, ["reattest", "request"]);
  assertEquals(picked?.attachment?.documentId, undefined);
  assertMatch(picked?.notice ?? "", /scripting.*denied/i);
});

Deno.test("3p3e.3: granted scripting reattests before binding, navigation means plain context", async () => {
  let queries = 0;
  const picked = await resolveComposerCommandSelection(tab, {
    runtimeSend: async () => (++queries === 1 ? { ok: false, needScripting: true } : { ok: false, error: "stale document" }),
    chromeApi: { permissions: { request: async () => true } },
  });
  assertEquals(queries, 2);
  assertEquals(picked?.attachment?.documentId, undefined);
});

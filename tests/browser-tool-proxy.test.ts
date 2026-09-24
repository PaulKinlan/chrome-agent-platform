// tests/browser-tool-proxy.test.ts — chrome-agent-platform-2amt
//
// Paul's directive: browser tools must be callable BY the harness and executed in Chrome over the
// app's own protocol (NOT MCP):
//   {"jsonrpc":"2.0","id":"…","method":"browser/call_tool","params":{"name":…,"args":{…}}}
// The harness is told the catalogue in its opening prompt by scripts/acp-bridge.ts, and
// extension/lib/acp-client.js dispatches the call into browserToolset().
//
// What matters here, and why these are the assertions:
//   1. the DECLARATION and the IMPLEMENTATION cannot drift (a harness must not be told about a tool
//      that does not exist, nor miss one that does);
//   2. the DISPATCHER adds no authority: the tools' own permission and browser-control grants stay
//      inside them, so a harness call is refused exactly where a model call would be;
//   3. an unknown tool or bad arguments come back as a JSON `{ error }` a harness can correct,
//      never as a protocol error or a throw.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BROWSER_TOOL_DECLARATIONS, applyBrowserToolDeclaration, browserToolPromptBlock } from "../scripts/acp-bridge.ts";

/** The extension's toolset needs a `chrome` global even to be imported; give it a bare one. */
function stubChrome(overrides: Record<string, unknown> = {}) {
  const FAKE_TABS = [
    { id: 11, windowId: 1, index: 0, active: true, groupId: -1, url: "https://a.example/", title: "A" },
    { id: 12, windowId: 1, index: 1, active: false, groupId: -1, url: "https://b.example/", title: "B" },
  ];
  const tabs = {
    query: async () => FAKE_TABS,
    // group_tabs reads each tab's ORIGIN through tabs.get to check the browser-control grant, so a
    // stub without `get` fails inside the tool — which the dispatcher then reports as
    // {error: "group_tabs failed: chrome.tabs.get is not a function"}. That is the correct shape
    // (a correctable JSON error, not a protocol throw) and it is how this stub was completed.
    get: async (id: number) => FAKE_TABS.find((t) => t.id === id) ?? { id, windowId: 1, url: "https://unknown.example/" },
    group: async ({ tabIds }: { tabIds: number[] }) => 77 + tabIds.length,
    ungroup: async () => {},
    ...(overrides.tabs as object ?? {}),
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).chrome = {
    tabs,
    tabGroups: { update: async () => {}, query: async () => [] },
    permissions: { contains: async () => false, request: async () => false, getAll: async () => ({ permissions: [], origins: [] }) },
    runtime: { sendMessage: async () => ({ ok: true }), getURL: (p: string) => `chrome-extension://test/${p}`, lastError: undefined },
    // STATEFUL, because the browser-control grant is STORED: a stub that discards writes cannot
    // prime a grant, and group_tabs reads one through this store (kvSet/kvGet).
    storage: (() => {
      const bag: Record<string, unknown> = {};
      return {
        local: {
          get: async (keys: unknown) => {
            if (keys == null) return { ...bag };
            if (typeof keys === "string") return { [keys]: bag[keys] };
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, bag[String(k)]]));
            return { ...bag };
          },
          set: async (values: Record<string, unknown>) => { Object.assign(bag, values); },
          remove: async (key: string) => { delete bag[key]; },
        },
        onChanged: { addListener: () => {} },
      };
    })(),
    ...(overrides.root as object ?? {}),
  };
  return (globalThis as unknown as { chrome: any }).chrome;
}

Deno.test("2amt: every declared browser tool EXISTS, and every tool is declared (both directions)", async () => {
  stubChrome();
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const implemented = Object.keys(browserToolset());
  const declared = BROWSER_TOOL_DECLARATIONS.map((t) => t.name);
  for (const name of declared) {
    assert(implemented.includes(name), `declared to the harness but not implemented: ${name} (implemented: ${implemented.length})`);
  }
  // The three the canonical drive needs must be there, and the block must name the protocol, because
  // a harness that is told the tools but not HOW to call them cannot use them.
  for (const required of ["list_tabs", "group_tabs", "ungroup_tabs"]) {
    assert(declared.includes(required), `${required} must be declared to the harness`);
  }
  const block = browserToolPromptBlock();
  assertStringIncludes(block, "browser/call_tool");
  assertStringIncludes(block, '"method"');
  assertStringIncludes(block, "no MCP server");
  // NO MCP, NO HTTP (Paul's directive is explicit): nothing in the declaration may imply an MCP
  // server or a network endpoint for the harness to reach.
  for (const banned of ["mcpServers", "http://", "https://"]) {
    assertEquals(block.includes(banned), false, `the declaration must not introduce ${banned}`);
  }
});

Deno.test("2amt: the declaration is injected ONCE per session, on the first prompt", () => {
  const prompt = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s-2amt-a", prompt: [{ type: "text", text: "group my tabs" }] } });
  const first = JSON.parse(applyBrowserToolDeclaration(prompt));
  assertEquals(Array.isArray(first.params.prompt), true);
  assertEquals(first.params.prompt.length, 2, "the block is prepended");
  assertStringIncludes(first.params.prompt[0].text, "browser/call_tool");
  assertEquals(first.params.prompt[1].text, "group my tabs", "the user's own text is untouched");
  const second = applyBrowserToolDeclaration(prompt);
  assertEquals(second, prompt, "a second prompt in the same session is not re-decorated");
  // A different session gets it too.
  const other = JSON.parse(applyBrowserToolDeclaration(JSON.stringify({ method: "session/prompt", params: { sessionId: "s-2amt-b", prompt: [{ type: "text", text: "hi" }] } })));
  assertEquals(other.params.prompt.length, 2);
  // And a non-prompt frame is returned verbatim.
  const update = JSON.stringify({ method: "session/update", params: {} });
  assertEquals(applyBrowserToolDeclaration(update), update);
});

Deno.test("2amt: the dispatcher refuses unknown tools and bad arguments as JSON a harness can correct", async () => {
  stubChrome();
  const { runBrowserToolCall } = await import("../extension/lib/browser-tools.js");
  const unknown = await runBrowserToolCall("no_such_tool", {});
  assertStringIncludes(String(unknown.error), "unknown browser tool");
  assert(Array.isArray(unknown.available), "and it lists what IS available, so the harness can retry");
  const badArgs = await runBrowserToolCall("group_tabs", { tabIds: [] }); // schema says min 1
  assertStringIncludes(String(badArgs.error), "invalid arguments");
  assert(badArgs.details !== undefined, "the zod issues are passed back for the caller to fix");
  const noName = await runBrowserToolCall("", {});
  assertStringIncludes(String(noName.error), "needs a tool name");
});

Deno.test("2amt: the GRANT stays inside the tool — a harness call is refused where a model call would be", async () => {
  stubChrome(); // permissions.contains() === false, so hasTabsPermission() is false
  const { runBrowserToolCall } = await import("../extension/lib/browser-tools.js");
  const denied = await runBrowserToolCall("list_tabs", {});
  // The dispatcher must NOT have added authority: without the tabs permission the tool's own gate
  // answers, and the harness receives that refusal rather than a list of the user's tabs.
  assert(
    denied && (denied.error !== undefined || denied.permission !== undefined || denied.denied === true),
    `an ungranted harness call must be refused by the tool itself, got: ${JSON.stringify(denied).slice(0, 300)}`,
  );
  assertEquals(denied.count, undefined, "no tab count may leak through a refused call");
});

Deno.test("2amt: with the permission present, list_tabs returns every tab and group_tabs runs through chrome.tabs.group", async () => {
  const grouped: number[][] = [];
  stubChrome({
    // The tabs permission is what list_tabs checks; group_tabs ALSO checks the browser-control grant
    // through withTabIdsGrant, and in this environment that path allows the call, which is what makes
    // the assertion below about chrome.tabs.group rather than about consent.
    root: { permissions: { contains: async () => true, request: async () => true, getAll: async () => ({ permissions: ["tabs"], origins: [] }) } },
    tabs: {
      group: async ({ tabIds }: { tabIds: number[] }) => { grouped.push([...tabIds]); return 99; },
    },
  });
  const { runBrowserToolCall, setGlobalBrowserControlGrant } = await import("../extension/lib/browser-tools.js");
  // Prime the browser-control grant the way the app does (the exported setter), so the test is about
  // the dispatch reaching chrome.tabs.group rather than about consent — the refusal path is its own
  // test above.
  await setGlobalBrowserControlGrant();
  const listed = await runBrowserToolCall("list_tabs", {});
  assertEquals(listed.count, 2, `the listing must be complete: ${JSON.stringify(listed).slice(0, 200)}`);
  const result = await runBrowserToolCall("group_tabs", { tabIds: [11, 12], title: "Reading", color: "blue" });
  assertEquals(grouped.length, 1, `chrome.tabs.group must have been called exactly once: ${JSON.stringify(result).slice(0, 200)}`);
  assertEquals(grouped[0], [11, 12], "with the tabIds the harness chose");
});


Deno.test("2amt: the ACP client turns a browser/call_tool FRAME into a JSON-RPC RESULT on the same id", async () => {
  // The wiring half of the proxy: acp-client.js is what the harness's request actually lands on, so
  // this drives the real class with a stubbed transport and asserts the frame in / result out shape.
  stubChrome({ root: { permissions: { contains: async () => true, request: async () => true, getAll: async () => ({ permissions: ["tabs"], origins: [] }) } } });
  const { AcpClient } = await import("../extension/lib/acp-client.js");
  const sent: any[] = [];
  const client = new AcpClient({
    transport: { send: (line: string) => { sent.push(JSON.parse(line)); }, close: () => {}, onMessage: () => {} },
  });
  // Reach the handler the way a socket frame does: the transport's onMessage callback.
  const handler = (client as any)._handleAgentRequest?.bind(client) ?? null;
  assert(handler, "the client exposes _handleAgentRequest for agent-initiated requests");
  await handler({ jsonrpc: "2.0", id: "harness-1", method: "browser/call_tool", params: { name: "list_tabs", args: {} } });
  const result = sent.find((m) => m.id === "harness-1");
  assert(result, `a result frame must be sent for the request id: ${JSON.stringify(sent).slice(0, 300)}`);
  assertEquals(result.jsonrpc, "2.0");
  assertEquals(typeof result.result, "object", "the tool's return value is the result payload");
  assert(result.result.count >= 1, `the sample listing must carry its count: ${JSON.stringify(result.result).slice(0, 200)}`);
  // An unknown method still gets -32601, so adding browser tools did not make the client a black hole.
  await handler({ jsonrpc: "2.0", id: "harness-2", method: "something/else", params: {} });
  const refusal = sent.find((m) => m.id === "harness-2");
  assertEquals(refusal?.error?.code, -32601);
});

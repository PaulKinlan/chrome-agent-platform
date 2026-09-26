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
    // The client messages the SW for tools now (SW authority), so the stub answers that route by
    // running the real dispatcher — otherwise the frame test would assert against a stub.
    runtime: {
      sendMessage: async (message: { type?: string; name?: string; args?: Record<string, unknown> }) => {
        if (message?.type === "browser.callTool") {
          const { runBrowserToolCall } = await import("../extension/lib/browser-tools.js");
          return await runBrowserToolCall(String(message.name ?? ""), message.args ?? {});
        }
        return { ok: true };
      },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
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
  // wfo5: the refusal case must be a name that is genuinely not a browser tool.
  // It used to be `open_tab`, which was refused only because the permitted set
  // was three names long — that assertion asserted the allow-list's SIZE, not
  // its behaviour, and inverted the moment the set widened.
  const unknown = await runBrowserToolCall("non_existent_tool", {});
  assertStringIncludes(String(unknown.error), 'tool "non_existent_tool" is not permitted for harness execution');
  assert(Array.isArray(unknown.available), "and it lists what IS available, so the harness can retry");
  const badArgs = await runBrowserToolCall("group_tabs", { tabIds: [] }); // schema says min 1
  assertStringIncludes(String(badArgs.error), "invalid arguments");
  assert(badArgs.details !== undefined, "the zod issues are passed back for the caller to fix");
  const noName = await runBrowserToolCall("", {});
  assertStringIncludes(String(noName.error), "needs a tool name");
});

Deno.test("wfo5: every browser tool is permitted to the harness, derived from the toolset", async () => {
  // Paul's directive (2026-09-24): "now I need the other tools that we have in Chrome to work via
  // claude code... let's get all the other browser tools available". Before this, THREE of 135 were
  // callable — open_tab, read_page, capture_screenshot and 129 others were refused by the allow-list
  // even though they are implemented, permission-checked and grant-gated.
  stubChrome();
  const { browserToolset, harnessPermittedBrowserTools } = await import("../extension/lib/browser-tools.js");
  const permitted = harnessPermittedBrowserTools();
  const implemented = Object.keys(browserToolset());
  assert(implemented.length > 100, `the toolset must be the real one, got ${implemented.length}`);
  for (const name of implemented) {
    assert(permitted.has(name), `implemented but not permitted to the harness: ${name}`);
  }
  // Named explicitly because these are the capabilities the directive asked for by name; a future
  // narrowing that drops them should fail HERE, with the reason, not in a count.
  for (const name of ["open_tab", "navigate_tab", "read_page", "capture_screenshot", "close_tab", "click_element", "type_text", "scroll_page", "download_file", "search_history", "create_bookmark", "create_window", "get_system_memory"]) {
    assert(permitted.has(name), `${name} must be callable by the harness (Paul's directive names it)`);
  }
  // DERIVED, not retyped: the set is exactly the toolset's keys, so adding a tool cannot leave the
  // harness unable to call it and a list cannot drift.
  const developerView = Object.keys(browserToolset(false, { developerFeatures: true }));
  assertEquals(permitted.size, developerView.length, "the permitted set is the developer-view toolset, exactly");
  // The set is NOT authority: a permitted name still has to EXIST in this build.
  // get_cookie is developer-only AND gated, so the gate check runs first — the
  // existence refusal is only reachable once a gate is supplied. (Measured: the
  // first version of this assertion had the order backwards and this test said
  // so, which is the order the dispatcher actually uses.)
  const { runBrowserToolCall } = await import("../extension/lib/browser-tools.js");
  const devOnly = await runBrowserToolCall("get_cookie", { origin: "https://a.example", name: "x" }, {
    cookieValueGate: () => ({ ok: true }),
    developerFeatures: false, // a DEFAULT build
  });
  assertStringIncludes(
    String(devOnly.error ?? ""),
    "unknown browser tool",
    "a developer-only tool is permitted by name but absent from a default build — the BUILD decides, not the allow-list",
  );
});

Deno.test("wfo5: a tool that owes the owner an approval card FAILS CLOSED without a gate, by name", async () => {
  // THE SAFETY HALF OF THE DIRECTIVE, and the reason permitting all 135 is not a one-line change.
  //
  // MEASURED on the pre-change source: runBrowserToolCall called browserToolset() with NO gate
  // arguments, and requireDestructiveApproval returns { ok: true } when destructiveActionGate is
  // null. So simply widening the allow-list would have made these six mutate the user's browser
  // with no owner card at all — close a window, wipe browsing data, remove a bookmark, silently.
  //
  // Asserted PER NAME rather than as a count: a count passes while an individual tool leaks.
  stubChrome();
  const { runBrowserToolCall, HARNESS_GATED_BROWSER_TOOLS } = await import("../extension/lib/browser-tools.js");
  const mustAsk = ["close_tab", "close_window", "wipe_browsing_data", "remove_bookmark", "set_cookie", "remove_cookie", "write_file", "schedule_task", "get_cookie"];
  for (const name of mustAsk) {
    assert(HARNESS_GATED_BROWSER_TOOLS.has(name), `${name} must be declared gated`);
    const refused = await runBrowserToolCall(name, {});
    assertStringIncludes(
      String(refused.error ?? ""),
      "needs owner approval, which this caller cannot request",
      `${name} must FAIL CLOSED when the caller cannot raise an approval card — got ${JSON.stringify(refused).slice(0, 140)}`,
    );
  }
  // …and the refusal is a correctable JSON result, not a throw, like every other refusal here.
  const refused = await runBrowserToolCall("close_tab", { tabId: 11 });
  assert(Array.isArray(refused.available), "the refusal still tells the harness what it may call");
});

Deno.test("wfo5: a gated tool REFUSES rather than mutates — the six destructive actions are not owner-direct", async () => {
  // THE HONEST LIMIT OF THIS CHANGE, asserted so nobody reads the headline as
  // "all 135 tools now work", and so nobody later "fixes" the refusal by
  // deleting it.
  //
  // MEASURED, in two steps:
  //   • OWNER_DIRECT_ACTIONS does NOT contain browser.close-foreign-tab,
  //     browser.close-window, browser.wipe, browser.remove-bookmark,
  //     browser.set-cookie or browser.remove-cookie.
  //   • A harness call arrives with principal "extension", not "model". So
  //     requireOwnerApproval skips the owner-direct shortcut AND skips the
  //     in-conversation approval card (that branch is principal === "model"),
  //     and falls to its tail: "This operation requires owner approval in
  //     Settings."
  //
  // So for those six the harness gets a bounded REFUSAL today — not a card, and
  // not a mutation. That is the correct end state here: the alternative, which
  // is what widening the allow-list alone would have produced, was an
  // UNAPPROVED mutation of the user's browser. A refusal the owner can act on
  // beats a silent close or wipe.
  const oa = await import("../extension/lib/owner-approval.js");
  const ctx = { principal: "extension", documentId: "doc-wfo5" };
  for (const action of ["browser.close-foreign-tab", "browser.close-window", "browser.wipe", "browser.remove-bookmark", "browser.set-cookie", "browser.remove-cookie"]) {
    assertEquals(
      oa.OWNER_DIRECT_ACTIONS.has(action),
      false,
      `${action} must NOT be owner-direct — an extension-surface call is not itself the owner's approval for a destructive browser mutation`,
    );
    assertEquals(oa.isOwnerDirectApproval(ctx, action), false, `${action} must not shortcut approval for an extension principal`);
  }
  // The service worker's tail refusal is what the harness actually sees; pinned
  // by string so an edit that turns it into a silent success is visible here.
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assertStringIncludes(
    sw,
    'return { ok: false, error: "This operation requires owner approval in Settings." };',
    "the non-model approval tail must stay a refusal",
  );
});

Deno.test("wfo5: the gated set mirrors the service worker's own GATED_WORKER_TOOLS", async () => {
  // Two lists naming the same policy in two files drift. This pins them together: the service
  // worker gates these names for worker tool calls (CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01
  // and the local-file write card), and a harness call must not be the cheaper path to the same
  // mutation. Read from source rather than imported, because service-worker.js cannot be loaded
  // outside the extension.
  const { HARNESS_GATED_BROWSER_TOOLS } = await import("../extension/lib/browser-tools.js");
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const block = sw.slice(sw.indexOf("const GATED_WORKER_TOOLS"), sw.indexOf("async function executeWorkerTool"));
  assert(block.length > 40, "GATED_WORKER_TOOLS must be findable in the service worker");
  const workerGated = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert(workerGated.length >= 9, `expected the worker's gated names, got ${JSON.stringify(workerGated)}`);
  for (const name of workerGated) {
    assert(
      HARNESS_GATED_BROWSER_TOOLS.has(name),
      `${name} is gated for worker tool calls but not for harness calls — the harness would be the cheaper path`,
    );
  }
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

Deno.test("wfo5: the ROUTE supplies the approval gates — a gateless call site must fail here", async () => {
  // THE CALLER-BINDING ASSERTION, and it exists because I have shipped this exact
  // defect twice: testing a helper's behaviour while nothing binds the CALL SITE
  // to it. runBrowserToolCall fails closed without gates, so a route that stopped
  // passing them would turn every destructive tool into a refusal — or, if a
  // later edit also relaxed the dispatcher, into a silent unapproved mutation.
  // Neither shows up in the tests above, which call the dispatcher directly.
  //
  // The handler is EXECUTED, not regex-matched: source-extracted and compiled
  // with its collaborators injected, then the recorded arguments are asserted.
  // (A structural pin says the text is present; this says the value arrives.)
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool": async');
  assert(site >= 0, "the browser.callTool route must exist");
  const end = src.indexOf("\n    },", site);
  assert(end > site, "the handler body must be delimited");
  const handlerSrc = src.slice(site + '"browser.callTool":'.length, end + "\n    }".length);

  const dispatched: Array<{ route: string; hasContext: boolean }> = [];
  let received: Record<string, unknown> | null = null;
  const compiled = new Function(
    "isOwnerPrincipal",
    "runBrowserToolCall",
    "dispatchRoute",
    "developerFeaturesOn",
    `return (${handlerSrc});`,
  )(
    (ctx: unknown) => (ctx as { principal?: string })?.principal === "extension",
    // deno-lint-ignore no-explicit-any
    (_name: string, _args: unknown, gates: any) => {
      received = gates;
      return { ok: true };
    },
    (route: string, _body: unknown, context: unknown) => {
      dispatched.push({ route, hasContext: context !== undefined && context !== null });
      return { ok: true };
    },
    () => Promise.resolve(false),
  );

  const ctx = { principal: "extension", documentId: "doc-wfo5" };
  const denied = await compiled({ name: "list_tabs", args: {} }, { principal: "page" });
  assertEquals(denied.error, "owner_extension_required", "the owner fence still answers first");

  await compiled({ name: "close_tab", args: { tabId: 11 } }, ctx);
  assert(received, "the route must pass a gates object to the dispatcher — without it every gated tool fails closed");
  const gates = received as Record<string, unknown>;
  for (const gate of ["scheduleScriptGate", "cookieValueGate", "destructiveActionGate", "fileWriteGate"]) {
    assertEquals(typeof gates[gate], "function", `${gate} must be supplied by the route`);
  }

  // …and each gate must reach its REAL approval route, carrying the call's
  // context (approvalExecutionId reads it; an unbound gate cannot approve).
  await (gates.destructiveActionGate as (a: string, p: unknown) => unknown)("browser.close-window", { ref: "w1" });
  await (gates.cookieValueGate as (p: unknown) => unknown)({ origin: "https://a.example", name: "x" });
  await (gates.fileWriteGate as (p: unknown) => unknown)({ path: "a.txt" });
  await (gates.scheduleScriptGate as (s: string) => unknown)("script-1");
  assertEquals(
    dispatched.map((d) => d.route).sort(),
    ["browser.cookie-value", "browser.destructive-action", "fs-grant.write-file-approved", "task.schedule-script"],
    "each gate must dispatch to its own approval route",
  );
  for (const d of dispatched) {
    assert(d.hasContext, `${d.route} must carry the call's context — approvalExecutionId reads it`);
  }
});

Deno.test("9842: browser.callTool is fenced with isOwnerPrincipal — the census class is pinned to the wiring", async () => {
  // The census classifies browser.callTool as OWNER_EXTENSION_FENCED
  // (isOwnerPrincipal(context), callers owner-options + extension). A handler
  // that drops the context check passes every behavioural test (the bare
  // toolset auto-approves the Destructive class), so the wiring itself is
  // pinned here — the 9t1p source-structure pattern; the alternative is
  // manufacturing an unfenced extension-page sender.
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const site = src.indexOf('"browser.callTool"');
  assert(site >= 0, "the browser.callTool route must exist");
  const handler = src.slice(site, src.indexOf("activityRoutes", site));
  assert(/isOwnerPrincipal\(/.test(handler), "the handler must fence with isOwnerPrincipal(context)");
  assert(/owner_extension_required/.test(handler), "the refusal must be the documented owner_extension_required");
});

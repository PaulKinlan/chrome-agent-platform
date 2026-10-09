// tests/working-set.test.ts — pure working-set reducer and ledger inverse tests
// (chrome-agent-platform-3p3e.9).
// @ts-nocheck — OPFS mock is dynamic.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  MAX_WORKING_SET_TABS,
  createWorkingSet,
  addTabToWorkingSet,
  removeTabFromWorkingSet,
  setWorkingSetGroup,
  reconcileWorkingSet,
  closeWorkingSet,
  restoreWorkingSetPlan,
  groupTitleForThread,
  syncWorkingSetTabGroup,
  closeWorkingSetTabs,
  restoreWorkingSetTabs,
  purgeTabFromWorkingSet,
} from "../extension/lib/working-set.js";
import { ledgerRowFor } from "../extension/lib/action-ledger.js";
import { browserToolset, setGlobalBrowserControlGrant } from "../extension/lib/browser-tools.js";
import { setRunContext, clearRunContext } from "../extension/lib/run-context.js";
import {
  createThread,
  getThread,
  listThreads,
  attachTabToThreadWorkingSet,
  updateThreadWorkingSet,
  continueThread,
} from "../extension/lib/threads.js";

// ---- minimal in-memory OPFS fake for threads ----
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      size: (node.content ?? "").length,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no dir ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no file ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true,
  writable: true,
});

Deno.test("working-set: createWorkingSet sanitizes inputs and bounds initial tabs", () => {
  const ws1 = createWorkingSet();
  assertEquals(ws1.groupId, null);
  assertEquals(ws1.tabIds, []);
  assertEquals(ws1.urls, []);

  const ws2 = createWorkingSet({
    groupId: 101,
    tabIds: [1, 2, -5, "foo" as any, 3],
    urls: ["https://example.com/1", "https://example.com/2", null as any, ""],
  });
  assertEquals(ws2.groupId, 101);
  assertEquals(ws2.tabIds, [1, 2, 3]);
  assertEquals(ws2.urls, ["https://example.com/1", "https://example.com/2"]);
});

Deno.test("working-set: addTabToWorkingSet updates existing tab or adds new instance", () => {
  let ws = createWorkingSet();
  ws = addTabToWorkingSet(ws, { tabId: 10, url: "https://example.com/a" });
  assertEquals(ws.tabIds, [10]);
  assertEquals(ws.urls, ["https://example.com/a"]);

  // Same tabId updates URL
  ws = addTabToWorkingSet(ws, { tabId: 10, url: "https://example.com/updated" });
  assertEquals(ws.tabIds, [10]);
  assertEquals(ws.urls, ["https://example.com/updated"]);
});

Deno.test("working-set: duplicate URLs are preserved as distinct tab entries and restore separately", async () => {
  let ws = createWorkingSet();
  // Two tabs on the exact same URL (e.g. comparing two views)
  ws = addTabToWorkingSet(ws, { tabId: 101, url: "https://github.com/issues" });
  ws = addTabToWorkingSet(ws, { tabId: 102, url: "https://github.com/issues" });

  assertEquals(ws.tabIds, [101, 102]);
  assertEquals(ws.urls, ["https://github.com/issues", "https://github.com/issues"]);
  assertEquals(ws.tabs.length, 2);

  // Close both tabs
  const { nextWorkingSet } = closeWorkingSet(ws);
  assertEquals(nextWorkingSet.tabIds, []);
  assertEquals(nextWorkingSet.tabs.length, 2);

  // Restore plan should restore BOTH tabs (length 2)
  const plan = restoreWorkingSetPlan(nextWorkingSet);
  assertEquals(plan.urlsToOpen, ["https://github.com/issues", "https://github.com/issues"]);

  // Simulate restore in fake Chrome
  let createdCount = 0;
  const fakeChrome = {
    tabs: {
      async create({ url }: { url: string }) {
        createdCount++;
        return { id: 300 + createdCount };
      },
      async group() { return 555; },
    },
    tabGroups: {
      async update() {},
    },
  };

  const restored = await restoreWorkingSetTabs(nextWorkingSet, {
    title: "Issue triage",
    chromeApi: fakeChrome,
  });

  assertEquals(createdCount, 2);
  assertEquals(restored.openedTabIds, [301, 302]);
  assertEquals(restored.nextWorkingSet.tabIds, [301, 302]);
  assertEquals(restored.nextWorkingSet.tabs.length, 2);
});

Deno.test("working-set: all live open tabs are retained while inactive history is capped at 32", () => {
  let ws = createWorkingSet();
  // 35 live tabs
  for (let i = 1; i <= 35; i++) {
    ws = addTabToWorkingSet(ws, { tabId: 100 + i, url: `https://example.com/${i}` });
  }
  // All 35 live tabs retained so Close tabs never abandons a tab
  assertEquals(ws.tabIds.length, 35);
  const { tabsToClose } = closeWorkingSet(ws);
  assertEquals(tabsToClose.length, 35);

  // Inactive entries capped at MAX_WORKING_SET_TABS (32)
  let inactiveWs = createWorkingSet();
  for (let i = 1; i <= 40; i++) {
    inactiveWs = addTabToWorkingSet(inactiveWs, { url: `https://example.com/inactive/${i}` });
  }
  assertEquals(inactiveWs.tabIds.length, 0);
  assertEquals(inactiveWs.tabs.length, MAX_WORKING_SET_TABS);
  assertEquals(inactiveWs.urls.length, MAX_WORKING_SET_TABS);
  assertEquals(inactiveWs.urls[inactiveWs.urls.length - 1], "https://example.com/inactive/40");
});

Deno.test("working-set: removeTabFromWorkingSet prunes tabId while preserving URLs for restoration", () => {
  let ws = createWorkingSet({
    tabIds: [1, 2, 3],
    urls: ["https://a.com", "https://b.com", "https://c.com"],
  });

  ws = removeTabFromWorkingSet(ws, 2);
  assertEquals(ws.tabIds, [1, 3]);
  assertEquals(ws.urls, ["https://a.com", "https://b.com", "https://c.com"]);
});

Deno.test("working-set: setWorkingSetGroup updates group ID or clears invalid group", () => {
  let ws = createWorkingSet({ tabIds: [1, 2] });
  assertEquals(ws.groupId, null);

  ws = setWorkingSetGroup(ws, 42);
  assertEquals(ws.groupId, 42);

  ws = setWorkingSetGroup(ws, -1);
  assertEquals(ws.groupId, null);
});

Deno.test("working-set: reconcileWorkingSet prunes closed tabs and stale group ID while retaining URLs", () => {
  const ws = createWorkingSet({
    groupId: 77,
    tabIds: [10, 20, 30],
    urls: ["https://a.com", "https://b.com", "https://c.com"],
  });

  // Browser only has tab 20 open; tab 10 and 30 were closed by the user
  const activeTabs = [{ id: 20 }, { id: 99 }];
  const activeGroups = [77];

  const result1 = reconcileWorkingSet(ws, activeTabs, activeGroups);
  assertEquals(result1.reconciled.tabIds, [20]);
  assertEquals(result1.reconciled.urls, ["https://a.com", "https://b.com", "https://c.com"]);
  assertEquals(result1.reconciled.groupId, 77);
  assertEquals(result1.staleTabIds, [10, 30]);
  assertEquals(result1.closedCount, 2);

  // If group 77 was closed in Chrome:
  const result2 = reconcileWorkingSet(ws, activeTabs, [88]);
  assertEquals(result2.reconciled.groupId, null);
});

Deno.test("working-set: closeWorkingSetTabs tracks only successfully removed tabs and keeps failed ones", async () => {
  const ws = createWorkingSet({
    groupId: 50,
    tabIds: [1, 2, 3],
    urls: ["https://x.com", "https://y.com", "https://z.com"],
  });

  const fakeChrome = {
    tabs: {
      async remove(tabId: number) {
        if (tabId === 2) {
          throw new Error("Cannot close tab 2: permission denied or locked");
        }
      },
    },
  };

  const result = await closeWorkingSetTabs(ws, { chromeApi: fakeChrome });
  // Tabs 1 and 3 closed, tab 2 failed to close
  assertEquals(result.closedTabIds, [1, 3]);
  // Tab 2 remains tracked as an active tabId
  assertEquals(result.nextWorkingSet.tabIds, [2]);
  // Group remains since tab 2 is still open
  assertEquals(result.nextWorkingSet.groupId, 50);
});

Deno.test("working-set: restoreWorkingSetTabs can restore only missing tabs for partially closed sets", async () => {
  let ws = createWorkingSet();
  ws = addTabToWorkingSet(ws, { tabId: 10, url: "https://example.com/open" });
  ws = addTabToWorkingSet(ws, { tabId: 20, url: "https://example.com/closed" });

  // Simulate tab 20 being closed in browser
  const reconciled = reconcileWorkingSet(ws, [{ id: 10 }]);
  ws = reconciled.reconciled;
  assertEquals(ws.tabIds, [10]);

  // Restore missing tabs only
  const openedUrls: string[] = [];
  const fakeChrome = {
    tabs: {
      async create({ url }: { url: string }) {
        openedUrls.push(url);
        return { id: 99 };
      },
      async group(args: any) {
        return 888;
      },
    },
    tabGroups: {
      async update() {},
    },
  };

  const result = await restoreWorkingSetTabs(ws, {
    title: "Partial Restore",
    onlyMissing: true,
    chromeApi: fakeChrome,
  });

  // Only the closed tab was reopened
  assertEquals(openedUrls, ["https://example.com/closed"]);
  assertEquals(result.openedTabIds, [99]);
  // Working set now has both tab 10 and newly opened tab 99
  assertEquals(result.nextWorkingSet.tabIds, [10, 99]);
  assertEquals(result.nextWorkingSet.groupId, 888);
});

Deno.test("working-set: action ledger close_tab provides open_tab inverse with url", () => {
  const row = ledgerRowFor(
    "close_tab",
    { tabId: 101, url: "https://example.com/dashboard" },
    { ok: true, closed: { title: "Dashboard", url: "https://example.com/dashboard" } },
  );
  assert(row !== null);
  assertEquals(row.sentence, "Closed Dashboard");
  assertEquals(row.inverse, {
    tool: "open_tab",
    args: { url: "https://example.com/dashboard" },
  });
});

Deno.test("working-set: syncWorkingSetTabGroup groups tabs and applies thread title", async () => {
  const groupedCalls: any[] = [];
  const updatedCalls: any[] = [];

  const fakeChrome = {
    tabs: {
      async group(args: any) {
        groupedCalls.push(args);
        return 999;
      },
    },
    tabGroups: {
      async update(groupId: number, props: any) {
        updatedCalls.push({ groupId, props });
      },
    },
  };

  const ws = createWorkingSet({ tabIds: [10, 20] });
  const result = await syncWorkingSetTabGroup(ws, {
    title: "Project Alpha",
    color: "blue",
    chromeApi: fakeChrome,
  });

  assertEquals(result.groupId, 999);
  assertEquals(result.nextWorkingSet.groupId, 999);
  assertEquals(groupedCalls, [{ tabIds: [10, 20] }]);
  assertEquals(updatedCalls, [{ groupId: 999, props: { title: "Project Alpha", color: "blue" } }]);
});

Deno.test("working-set: createThread initializes working set and automatically groups attached tabs", async () => {
  let groupedArgs: any = null;
  let updatedGroupProps: any = null;
  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      async group(args: any) {
        groupedArgs = args;
        return 444;
      },
    },
    tabGroups: {
      async update(groupId: number, props: any) {
        updatedGroupProps = { groupId, props };
      },
    },
  };

  try {
    const attachments = [
      { kind: "tab", tabId: 101, url: "https://example.com/tab1", name: "Tab 1" },
      { kind: "tab", tabId: 102, url: "https://example.com/tab2", name: "Tab 2" },
    ];
    const t = await createThread("Check attached tabs", attachments);
    const fetched = await getThread(t.id);
    assert(fetched !== null);
    assertEquals(fetched.workingSet.tabIds, [101, 102]);
    assertEquals(fetched.workingSet.groupId, 444);
    assertEquals(groupedArgs, { tabIds: [101, 102] });
    assertEquals(updatedGroupProps?.groupId, 444);

    const list = await listThreads();
    const row = list.find((r) => r.id === t.id);
    assert(row !== undefined);
    assertEquals(row.tabCount, 2);
  } finally {
    globalThis.chrome = prevChrome;
  }
});

Deno.test("working-set: attachTabToThreadWorkingSet dynamically attaches tab and updates index tabCount", async () => {
  const t = await createThread("Analyze document");
  await attachTabToThreadWorkingSet(t.id, { tabId: 55, url: "https://docs.google.com/test" });

  const fetched = await getThread(t.id);
  assertEquals(fetched.workingSet.tabIds, [55]);
  assertEquals(fetched.workingSet.urls, ["https://docs.google.com/test"]);

  const list = await listThreads();
  const row = list.find((r) => r.id === t.id);
  assertEquals(row?.tabCount, 1);
});

Deno.test("working-set: continueThread with tab attachments adds tabs to working set and groups them", async () => {
  let groupedArgs: any = null;
  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      async group(args: any) {
        groupedArgs = args;
        return 777;
      },
    },
    tabGroups: {
      async update() {},
    },
  };

  try {
    const t = await createThread("Initial prompt");
    const followUpAtt = [{ kind: "tab", tabId: 88, url: "https://github.com/pulls" }];
    await continueThread(t.id, "Follow-up with tab", followUpAtt);

    const fetched = await getThread(t.id);
    assertEquals(fetched.workingSet.tabIds, [88]);
    assertEquals(fetched.workingSet.groupId, 777);
    assertEquals(groupedArgs, { tabIds: [88] });

    const list = await listThreads();
    const row = list.find((r) => r.id === t.id);
    assertEquals(row?.tabCount, 1);
  } finally {
    globalThis.chrome = prevChrome;
  }
});

Deno.test("working-set: delta updates preserve concurrently attached tabs without erase", async () => {
  const t = await createThread("Concurrent test", [
    { kind: "tab", tabId: 10, url: "https://example.com/initial", name: "Initial" },
  ]);

  // Simulate concurrent attach: agent opens tab 20 while UI was closing tab 10
  await attachTabToThreadWorkingSet(t.id, { tabId: 20, url: "https://example.com/agent-opened" });

  // Simulate closeTabIds delta from UI (closing only tab 10)
  const toClose = new Set([10]);
  await updateThreadWorkingSet(t.id, (currentWs) => createWorkingSet({
    groupId: currentWs.groupId,
    tabs: currentWs.tabs.map((tab) => (toClose.has(tab.tabId) ? { url: tab.url, title: tab.title } : tab)),
  }));

  const finalThread = await getThread(t.id);
  // Tab 20 MUST be preserved as an active open tab!
  assertEquals(finalThread.workingSet.tabIds, [20]);
  // Tab 10 URL is preserved for restoration!
  assertEquals(finalThread.workingSet.urls, ["https://example.com/initial", "https://example.com/agent-opened"]);
});

Deno.test("working-set: restoreWorkingSetTabs supports targetUrls scoping for Undo with duplicate URLs", async () => {
  const ws = createWorkingSet({
    tabs: [
      { tabId: null, url: "https://example.com/undo-me" },
      { tabId: null, url: "https://example.com/undo-me" },
      { tabId: null, url: "https://example.com/keep-closed" },
    ],
  });

  const createdUrls: string[] = [];
  let tabIdCounter = 100;
  const fakeChrome = {
    tabs: {
      create: async ({ url }: { url: string }) => {
        createdUrls.push(url);
        return { id: tabIdCounter++ };
      },
    },
    tabGroups: {
      group: async () => 1,
      update: async () => {},
    },
  };

  // Close only ONE instance of https://example.com/undo-me and undo only that ONE
  const { nextWorkingSet, openedTabIds } = await restoreWorkingSetTabs(ws, {
    targetUrls: ["https://example.com/undo-me"],
    chromeApi: fakeChrome,
  });

  assertEquals(openedTabIds.length, 1);
  assertEquals(createdUrls, ["https://example.com/undo-me"]);
  // One was reopened with tabId, the other remains closed (tabId undefined)
  const opened = nextWorkingSet.tabs.filter((t) => t.url === "https://example.com/undo-me" && t.tabId != null);
  const stillClosed = nextWorkingSet.tabs.filter((t) => t.url === "https://example.com/undo-me" && t.tabId == null);
  assertEquals(opened.length, 1);
  assertEquals(stillClosed.length, 1);
});

Deno.test("working-set: explicit groupId null clears group without clearing open tabs", async () => {
  const t = await createThread("Group clear test", [
    { kind: "tab", tabId: 44, url: "https://example.com/still-open" },
  ]);

  // Set initial group
  await updateThreadWorkingSet(t.id, (ws) => setWorkingSetGroup(ws, 999));
  const before = await getThread(t.id);
  assertEquals(before.workingSet.groupId, 999);

  // Clear group explicitly (e.g. user manually ungrouped in browser)
  await updateThreadWorkingSet(t.id, (ws) => setWorkingSetGroup(ws, null));
  const after = await getThread(t.id);
  assertEquals(after.workingSet.groupId, null);
  assertEquals(after.workingSet.tabIds, [44]);
});

Deno.test("working-set: groupNamed is preserved across addTab and removeTab reducers", () => {
  let ws = createWorkingSet();
  ws = setWorkingSetGroup(ws, 123, true);
  assertEquals(ws.groupNamed, true);

  ws = addTabToWorkingSet(ws, { tabId: 1, url: "https://example.com/1" });
  assertEquals(ws.groupNamed, true);

  ws = removeTabFromWorkingSet(ws, 1);
  assertEquals(ws.groupNamed, true);
});

Deno.test("working-set: closeWorkingSetTabs captures navigated live URL before removal", async () => {
  const ws = createWorkingSet({
    tabs: [
      { tabId: 55, url: "https://example.com/initial-page", title: "Initial" },
    ],
  });

  const fakeChrome = {
    tabs: {
      get: async (id: number) => {
        if (id === 55) {
          return { id: 55, url: "https://example.com/navigated-page", title: "Navigated" };
        }
        return null;
      },
      remove: async () => {},
    },
  };

  const { nextWorkingSet, closedTabIds, closedTabs } = await closeWorkingSetTabs(ws, {
    chromeApi: fakeChrome,
  });

  assertEquals(closedTabIds, [55]);
  assertEquals(closedTabs.length, 1);
  assertEquals(closedTabs[0].url, "https://example.com/navigated-page");
  assertEquals(nextWorkingSet.tabs[0].url, "https://example.com/navigated-page");
});

Deno.test("working-set: group ID 0 is accepted and preserved as a valid group", () => {
  let ws = createWorkingSet();
  ws = setWorkingSetGroup(ws, 0, true);
  assertEquals(ws.groupId, 0);
  assertEquals(ws.groupNamed, true);
});

Deno.test("working-set: purgeTabFromWorkingSet completely purges tab entry without phantom restore", () => {
  let ws = createWorkingSet({
    tabs: [
      { tabId: 10, url: "https://example.com/keep" },
      { tabId: 20, url: "https://example.com/aborted" },
    ],
  });

  ws = purgeTabFromWorkingSet(ws, 20);
  assertEquals(ws.tabIds, [10]);
  assertEquals(ws.urls, ["https://example.com/keep"]);
  const plan = restoreWorkingSetPlan(ws);
  assertEquals(plan.urlsToOpen, []);
});

Deno.test("working-set: open_tab exercises syncWorkingSetTabGroup and persists group ID 0", async () => {
  const prevChrome = globalThis.chrome;
  const t = await createThread("OpenTab Group 0 test", []);

  globalThis.chrome = {
    permissions: { contains: async () => true, request: async () => true },
    tabs: {
      create: async ({ url }: { url: string }) => ({ id: 456, url, title: "Mock Tab" }),
      group: async () => 0, // returns group ID 0!
      query: async () => [{ id: 456 }],
    },
    tabGroups: {
      update: async () => {},
    },
  };

  try {
    await setGlobalBrowserControlGrant();
    setRunContext({ threadId: t.id });
    const tools = browserToolset(false);
    const res = await tools.open_tab.execute({ url: "https://example.com/live-0" });
    assertEquals(res.ok, true);

    const updated = await getThread(t.id);
    assertEquals(updated.workingSet.groupId, 0);
    assertEquals(updated.workingSet.groupNamed, true);
    assertEquals(updated.workingSet.tabIds, [456]);
  } finally {
    clearRunContext();
    globalThis.chrome = prevChrome;
  }
});

Deno.test("working-set: duplicate_tab exercises syncWorkingSetTabGroup and persists group ID 0", async () => {
  const prevChrome = globalThis.chrome;
  const t = await createThread("DuplicateTab Group 0 test", []);

  globalThis.chrome = {
    permissions: { contains: async () => true, request: async () => true },
    tabs: {
      get: async (id: number) => ({ id, url: "https://example.com/source", title: "Source" }),
      duplicate: async (_id: number) => ({ id: 789, url: "https://example.com/source", title: "Source" }),
      group: async () => 0, // returns group ID 0!
    },
    tabGroups: {
      update: async () => {},
    },
  };

  try {
    await setGlobalBrowserControlGrant();
    setRunContext({ threadId: t.id });
    const tools = browserToolset(false);
    const res = await tools.duplicate_tab.execute({ tabId: 100 });
    assertEquals(res.ok, true);

    const updated = await getThread(t.id);
    assertEquals(updated.workingSet.groupId, 0);
    assertEquals(updated.workingSet.groupNamed, true);
    assertEquals(updated.workingSet.tabIds, [789]);
  } finally {
    clearRunContext();
    globalThis.chrome = prevChrome;
  }
});

Deno.test("working-set: addTabToWorkingSet preserves pre-existing inactive tab and purge retains it", () => {
  let ws = createWorkingSet({
    tabs: [
      { url: "https://example.com/existing-closed", title: "Existing" },
    ],
  });

  // Open a new tab with the same URL
  ws = addTabToWorkingSet(ws, { tabId: 42, url: "https://example.com/existing-closed" });
  assertEquals(ws.tabs.length, 2);
  assertEquals(ws.tabIds, [42]);

  // Abort occurs: purge the opened tab 42
  ws = purgeTabFromWorkingSet(ws, 42);
  assertEquals(ws.tabIds, []);
  assertEquals(ws.tabs.length, 1);
  assertEquals(ws.tabs[0].url, "https://example.com/existing-closed");
  assertEquals(ws.tabs[0].tabId, undefined);

  // Restore plan still offers the pre-existing closed tab for restoration
  const plan = restoreWorkingSetPlan(ws);
  assertEquals(plan.urlsToOpen, ["https://example.com/existing-closed"]);
});

Deno.test("working-set: reconcileWorkingSet produces updatedTabs on live navigation", () => {
  let ws = createWorkingSet({
    tabs: [
      { tabId: 50, url: "https://example.com/initial", title: "Initial" },
    ],
  });

  // Browser tab has navigated to /navigated
  const activeTabs = [{ id: 50, url: "https://example.com/navigated", title: "Navigated" }];
  const res = reconcileWorkingSet(ws, activeTabs);

  assertEquals(res.urlsChanged, true);
  assertEquals(res.updatedTabs.length, 1);
  assertEquals(res.updatedTabs[0].tabId, 50);
  assertEquals(res.updatedTabs[0].url, "https://example.com/navigated");
  assertEquals(res.reconciled.urls, ["https://example.com/navigated"]);
});

Deno.test("working-set: close, restore, and reload persists against original entries without duplicating", async () => {
  const t = await createThread("Close Restore Cycle");

  // Attach a tab
  await updateThreadWorkingSet(t.id, (ws) => addTabToWorkingSet(ws, { tabId: 101, url: "https://example.com/cycle" }));
  let current = await getThread(t.id);
  assertEquals(current.workingSet.tabIds, [101]);

  // Simulate close via delta
  await updateThreadWorkingSet(t.id, (ws) => {
    return createWorkingSet({
      groupId: null,
      tabs: ws.tabs.map((tab) => ({ url: tab.url, title: tab.title })),
    });
  });

  current = await getThread(t.id);
  assertEquals(current.workingSet.tabIds, []);
  assertEquals(current.workingSet.tabs.length, 1);
  assertEquals(current.workingSet.tabs[0].tabId, undefined);

  // Restore tab: simulate restoreTabs mutation
  await updateThreadWorkingSet(t.id, (ws) => {
    const nextTabs = [...ws.tabs];
    const restored = { tabId: 202, url: "https://example.com/cycle" };
    const idx = nextTabs.findIndex((tab) => !tab.tabId && tab.url === restored.url);
    if (idx !== -1) {
      nextTabs[idx] = Object.freeze({ tabId: restored.tabId, url: restored.url });
    }
    return createWorkingSet({ tabs: nextTabs });
  });

  // Reload thread from storage
  current = await getThread(t.id);
  assertEquals(current.workingSet.tabIds, [202]);
  assertEquals(current.workingSet.tabs.length, 1);

  // Plan should show 0 missing tabs
  const plan = restoreWorkingSetPlan(current.workingSet);
  assertEquals(plan.urlsToOpen, []);
});

Deno.test("working-set: closing 35 tabs preserves complete batch for Undo and restores all 35 tabs", async () => {
  let ws = createWorkingSet();
  for (let i = 1; i <= 35; i++) {
    ws = addTabToWorkingSet(ws, { tabId: 200 + i, url: `https://example.com/batch/${i}` });
  }
  assertEquals(ws.tabIds.length, 35);

  const fakeChrome = {
    tabs: {
      removed: [] as number[],
      created: [] as { url: string }[],
      async remove(id: number) {
        fakeChrome.tabs.removed.push(id);
      },
      async create({ url }: { url: string }) {
        fakeChrome.tabs.created.push({ url });
        return { id: 500 + fakeChrome.tabs.created.length };
      },
      async group() { return 123; },
    },
    tabGroups: {
      async update() {},
    },
  };

  const { nextWorkingSet, closedTabIds, closedTabs } = await closeWorkingSetTabs(ws, { chromeApi: fakeChrome });
  assertEquals(closedTabIds.length, 35);
  assertEquals(closedTabs.length, 35);
  assertEquals(nextWorkingSet.tabs.length, 35);
  assertEquals(nextWorkingSet.tabIds.length, 0);

  // Undo triggers restore with targetUrls: closedUrls
  const closedUrls = closedTabs.map((t) => t.url);
  const restored = await restoreWorkingSetTabs(nextWorkingSet, {
    title: "Task with 35 tabs",
    targetUrls: closedUrls,
    chromeApi: fakeChrome,
  });

  assertEquals(restored.openedTabIds.length, 35);
  assertEquals(restored.nextWorkingSet.tabIds.length, 35);
  assertEquals(restored.nextWorkingSet.tabs.length, 35);
  assertEquals(fakeChrome.tabs.created.length, 35);
});

Deno.test("working-set: close 35 tabs, reload stored thread, and restore all 35 tabs", async () => {
  const t = await createThread("Thread with 35 tabs");

  // Attach 35 tabs to thread
  for (let i = 1; i <= 35; i++) {
    await attachTabToThreadWorkingSet(t.id, {
      tabId: 300 + i,
      url: `https://example.com/stored/${i}`,
    });
  }

  let stored = await getThread(t.id);
  assertEquals(stored.workingSet.tabIds.length, 35);
  assertEquals(stored.workingSet.tabs.length, 35);

  // Close all 35 tabs via close delta with preserveInactiveCount
  await updateThreadWorkingSet(t.id, (ws) => {
    return createWorkingSet({
      groupId: null,
      tabs: ws.tabs.map((tab) => ({ url: tab.url, title: tab.title })),
      preserveInactiveCount: ws.tabs.length,
    });
  });

  // Reload stored thread from storage (simulating page reload / fresh session)
  stored = await getThread(t.id);
  assertEquals(stored.workingSet.tabIds.length, 0);
  assertEquals(stored.workingSet.tabs.length, 35);
  assertEquals(stored.workingSet.urls.length, 35);

  // Restore tabs from reloaded thread
  const fakeChrome = {
    tabs: {
      created: [] as { url: string }[],
      async create({ url }: { url: string }) {
        fakeChrome.tabs.created.push({ url });
        return { id: 600 + fakeChrome.tabs.created.length };
      },
      async group() { return 999; },
    },
    tabGroups: {
      async update() {},
    },
  };

  const restored = await restoreWorkingSetTabs(stored.workingSet, {
    title: "Thread with 35 tabs",
    chromeApi: fakeChrome,
  });

  assertEquals(restored.openedTabIds.length, 35);
  assertEquals(restored.nextWorkingSet.tabIds.length, 35);
  assertEquals(restored.nextWorkingSet.tabs.length, 35);
  assertEquals(fakeChrome.tabs.created.length, 35);
});

Deno.test("working-set: close 35 tabs, intervening attach, reload, and restore remaining tabs", async () => {
  const t = await createThread("Intervening attach test");

  // Attach 35 tabs to thread
  for (let i = 1; i <= 35; i++) {
    await attachTabToThreadWorkingSet(t.id, {
      tabId: 400 + i,
      url: `https://example.com/item/${i}`,
    });
  }

  // Close all 35 tabs via close delta
  await updateThreadWorkingSet(t.id, (ws) => {
    return createWorkingSet({
      groupId: null,
      tabs: ws.tabs.map((tab) => ({ url: tab.url, title: tab.title })),
      preserveInactiveCount: ws.tabs.length,
    });
  });

  // Intervening update: an agent or user attaches a new tab 999
  await attachTabToThreadWorkingSet(t.id, {
    tabId: 999,
    url: "https://example.com/new-agent-tab",
  });

  // Reload stored thread from storage
  let stored = await getThread(t.id);
  // Live tabs: [999], inactive tabs: 35
  assertEquals(stored.workingSet.tabIds, [999]);
  assertEquals(stored.workingSet.tabs.length, 36);

  // Restore missing tabs
  const fakeChrome = {
    tabs: {
      created: [] as { url: string }[],
      async create({ url }: { url: string }) {
        fakeChrome.tabs.created.push({ url });
        return { id: 700 + fakeChrome.tabs.created.length };
      },
      async group() { return 888; },
    },
    tabGroups: {
      async update() {},
    },
  };

  const plan = restoreWorkingSetPlan(stored.workingSet);
  assertEquals(plan.urlsToOpen.length, 35);

  const restored = await restoreWorkingSetTabs(stored.workingSet, {
    title: "Intervening attach test",
    chromeApi: fakeChrome,
  });

  assertEquals(restored.openedTabIds.length, 35);
  // All 36 tabs are now open: 35 restored + 1 intervening
  assertEquals(restored.nextWorkingSet.tabIds.length, 36);
  assertEquals(restored.nextWorkingSet.tabs.length, 36);
});

Deno.test("working-set: restoreWorkingSetTabs with onlyMissing does not duplicate already open tab during Undo", async () => {
  // A is open (tabId: 10), B is missing (tabId: undefined)
  let ws = createWorkingSet({
    tabs: [
      { tabId: 10, url: "https://example.com/tab-a" },
      { url: "https://example.com/tab-b" },
    ],
  });

  const fakeChrome = {
    tabs: {
      created: [] as { url: string }[],
      async create({ url }: { url: string }) {
        fakeChrome.tabs.created.push({ url });
        return { id: 20 };
      },
      async group() { return 100; },
    },
    tabGroups: {
      async update() {},
    },
  };

  // Undo triggers with targetUrls containing both ["https://example.com/tab-a", "https://example.com/tab-b"]
  const res = await restoreWorkingSetTabs(ws, {
    onlyMissing: true,
    targetUrls: ["https://example.com/tab-a", "https://example.com/tab-b"],
    chromeApi: fakeChrome,
  });

  // Only B should be opened! A was already open and must NOT be duplicated!
  assertEquals(fakeChrome.tabs.created.length, 1);
  assertEquals(fakeChrome.tabs.created[0].url, "https://example.com/tab-b");
  assertEquals(res.openedTabIds.length, 1);
  assertEquals(res.nextWorkingSet.tabIds.length, 2);
  assertEquals(res.nextWorkingSet.tabIds.includes(10), true);
  assertEquals(res.nextWorkingSet.tabIds.includes(20), true);
});







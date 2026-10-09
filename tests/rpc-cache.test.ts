// tests/rpc-cache.test.ts — Unit tests for Hub RPC coalescing layer (extension/shared/rpc-cache.js)
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  cachedRpc,
  cacheKey,
  clearRpcCache,
  invalidateRpcCache,
  handleBroadcastEvent,
  getRpcCacheStats,
} from "../extension/shared/rpc-cache.js";
import {
  isInternalExtensionUrl,
  isWebTabUrl,
  createTabChangeNotifier,
} from "../extension/lib/pure.js";

Deno.test("rpc-cache: key generation is deterministic and payload-sensitive", () => {
  const k1 = cacheKey("settings.get", { a: 1, b: 2 });
  const k2 = cacheKey("settings.get", { b: 2, a: 1 });
  const k3 = cacheKey("settings.get", { a: 1, b: 3 });
  const k4 = cacheKey("agents.list", { a: 1, b: 2 });

  assertEquals(k1, k2, "keys with differently ordered properties must match");
  assert(k1 !== k3, "keys with different values must not match");
  assert(k1 !== k4, "keys with different route names must not match");
});

Deno.test("rpc-cache: single-flight deduplication coalesces concurrent calls into one send", async () => {
  clearRpcCache();
  let sendCount = 0;
  const mockSend = async (type: string, payload: any) => {
    sendCount++;
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, data: `${type}-${JSON.stringify(payload)}` };
  };

  const p1 = cachedRpc("settings.get", { key: "foo" }, { send: mockSend });
  const p2 = cachedRpc("settings.get", { key: "foo" }, { send: mockSend });
  const p3 = cachedRpc("settings.get", { key: "foo" }, { send: mockSend });

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assertEquals(sendCount, 1, "concurrent requests must coalesce into exactly one send call");
  assertEquals(r1, { ok: true, data: 'settings.get-{"key":"foo"}' });
  assertEquals(r2, r1);
  assertEquals(r3, r1);
});

Deno.test("rpc-cache: cached result is returned within TTL and expires after TTL", async () => {
  clearRpcCache();
  let sendCount = 0;
  const mockSend = async (type: string) => {
    sendCount++;
    return { ok: true, count: sendCount };
  };

  // 1st call: sends
  const res1 = await cachedRpc("agents.list", {}, { send: mockSend, ttlMs: 50 });
  assertEquals(res1, { ok: true, count: 1 });
  assertEquals(sendCount, 1);

  // 2nd call (immediate): served from cache
  const res2 = await cachedRpc("agents.list", {}, { send: mockSend, ttlMs: 50 });
  assertEquals(res2, { ok: true, count: 1 });
  assertEquals(sendCount, 1);

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 60));

  // 3rd call: expired, must re-fetch
  const res3 = await cachedRpc("agents.list", {}, { send: mockSend, ttlMs: 50 });
  assertEquals(res3, { ok: true, count: 2 });
  assertEquals(sendCount, 2);
});

Deno.test("rpc-cache: rejected promise is not cached", async () => {
  clearRpcCache();
  let attempts = 0;
  const mockSend = async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("transient worker failure");
    }
    return { ok: true, attempts };
  };

  await assertRejects(
    () => cachedRpc("skills.list", {}, { send: mockSend }),
    Error,
    "transient worker failure"
  );

  assertEquals(getRpcCacheStats().inFlightCount, 0, "in-flight map must be cleaned up on failure");

  // Subsequent call should retry and not return the rejection
  const retryResult = await cachedRpc("skills.list", {}, { send: mockSend });
  assertEquals(retryResult, { ok: true, attempts: 2 });
});

Deno.test("rpc-cache: failed response (ok: false) is not cached", async () => {
  clearRpcCache();
  let attempts = 0;
  const mockSend = async () => {
    attempts++;
    if (attempts === 1) {
      return { ok: false, error: "not ready" };
    }
    return { ok: true, attempts };
  };

  const res1 = await cachedRpc("harnesses.list", {}, { send: mockSend });
  assertEquals(res1, { ok: false, error: "not ready" });

  const res2 = await cachedRpc("harnesses.list", {}, { send: mockSend });
  assertEquals(res2, { ok: true, attempts: 2 }, "ok: false response must not be cached");
});

Deno.test("rpc-cache: explicit invalidation by prefix purges only matching entries", async () => {
  clearRpcCache();
  let agentCalls = 0;
  let providerCalls = 0;

  const mockSend = async (type: string) => {
    if (type.startsWith("agent.")) {
      agentCalls++;
      return { ok: true, agentCalls };
    }
    providerCalls++;
    return { ok: true, providerCalls };
  };

  await cachedRpc("agent.directory", {}, { send: mockSend });
  await cachedRpc("provider.status", {}, { send: mockSend });
  assertEquals(agentCalls, 1);
  assertEquals(providerCalls, 1);

  // Invalidate agent routes
  invalidateRpcCache("agent.");

  // agent.directory re-fetches
  await cachedRpc("agent.directory", {}, { send: mockSend });
  assertEquals(agentCalls, 2);

  // provider.status remains cached
  await cachedRpc("provider.status", {}, { send: mockSend });
  assertEquals(providerCalls, 1);
});

Deno.test("rpc-cache: write RPC invalidates corresponding read caches", async () => {
  clearRpcCache();
  let readCalls = 0;
  const mockSend = async (type: string) => {
    if (type === "settings.get") {
      readCalls++;
      return { ok: true, value: readCalls };
    }
    return { ok: true };
  };

  await cachedRpc("settings.get", { key: "theme" }, { send: mockSend });
  assertEquals(readCalls, 1);

  // Calling a write RPC (settings.set) triggers cache invalidation
  await cachedRpc("settings.set", { key: "theme", value: "dark" }, { send: mockSend });

  // Next read is a fresh fetch
  await cachedRpc("settings.get", { key: "theme" }, { send: mockSend });
  assertEquals(readCalls, 2);
});

Deno.test("8xhq7: creating a named agent evicts the same page's pre-create roster before repaint", async () => {
  clearRpcCache();
  const names = ["Research Analyst"];
  let rosterReads = 0;
  let unrelatedReads = 0;
  const send = async (type: string, payload: { name?: string } = {}) => {
    if (type === "named-agent.list") {
      rosterReads++;
      return { ok: true, agents: [...names] };
    }
    if (type === "named-agent.create") {
      names.push(payload.name!);
      return { ok: true };
    }
    if (type === "provider.status") {
      unrelatedReads++;
      return { ok: true, provider: "demo" };
    }
    throw new Error(`unexpected RPC: ${type}`);
  };

  // The create dialog warms this read when building its delegation choices.
  assertEquals((await cachedRpc("named-agent.list", {}, { send })).agents, ["Research Analyst"]);
  await cachedRpc("provider.status", {}, { send });
  await cachedRpc("named-agent.create", { name: "Bookmark Librarian" }, { send });

  // onSaved renders immediately; it must not reuse the roster from before create
  // even if the SW's separate named-agent-changed broadcast has not arrived.
  assertEquals((await cachedRpc("named-agent.list", {}, { send })).agents,
    ["Research Analyst", "Bookmark Librarian"]);
  assertEquals(rosterReads, 2, "the live page must request the new roster after its own write");
  await cachedRpc("provider.status", {}, { send });
  assertEquals(unrelatedReads, 1, "agent writes must not evict unrelated provider reads");
});

Deno.test("rpc-cache: broadcast events invalidate corresponding cached routes", async () => {
  clearRpcCache();
  let dirCalls = 0;
  const mockSend = async () => {
    dirCalls++;
    return { ok: true, dirCalls };
  };

  await cachedRpc("agent.directory", {}, { send: mockSend });
  assertEquals(dirCalls, 1);

  // Simulate agent-registry-changed broadcast
  handleBroadcastEvent("agent-registry-changed");

  await cachedRpc("agent.directory", {}, { send: mockSend });
  assertEquals(dirCalls, 2, "agent.directory must re-fetch after agent-registry-changed");
});

Deno.test("rpc-cache: mutating flows are never served from cache", async () => {
  clearRpcCache();
  let runs = 0;
  const mockSend = async (type: string) => {
    runs++;
    return { ok: true, runs };
  };

  const r1 = await cachedRpc("agent.run", { prompt: "test" }, { send: mockSend });
  const r2 = await cachedRpc("agent.run", { prompt: "test" }, { send: mockSend });

  assertEquals(runs, 2, "mutating flow agent.run must never be served from cache");
  assertEquals(r1, { ok: true, runs: 1 });
  assertEquals(r2, { ok: true, runs: 2 });
});

Deno.test("rpc-cache: every board progress event invalidates both cached board reads without polling", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/agent-board.js", import.meta.url));
  const emitted = [...source.matchAll(/\bfire\(\{ type: "(board-[^"]+)"/g)].map((match) => match[1]);
  assertEquals(emitted.length, 6, "a newly emitted board event requires an explicit invalidation review");
  for (const event of emitted) {
    clearRpcCache();
    let calls = 0;
    const send = async () => ({ ok: true, revision: ++calls });
    await cachedRpc("board.list", {}, { send });
    await cachedRpc("board.messages", { limit: 5 }, { send });
    assertEquals(calls, 2);
    handleBroadcastEvent(event);
    assertEquals(calls, 2, `${event} must not itself add a boot/idle RPC`);
    const board = await cachedRpc("board.list", {}, { send });
    const messages = await cachedRpc("board.messages", { limit: 5 }, { send });
    assertEquals(board.revision, 3, `${event} must invalidate stale jobs`);
    assertEquals(messages.revision, 4, `${event} must invalidate stale messages`);
  }
});

Deno.test("rpc-cache: board.message write invalidates both board reads even on the same page", async () => {
  clearRpcCache();
  let calls = 0;
  const send = async (type: string) => ({ ok: true, type, revision: ++calls });
  await cachedRpc("board.list", {}, { send });
  await cachedRpc("board.messages", { limit: 5 }, { send });
  await cachedRpc("board.message", { to: "broadcast", body: "New task" }, { send });
  assertEquals((await cachedRpc("board.list", {}, { send })).revision, 4);
  assertEquals((await cachedRpc("board.messages", { limit: 5 }, { send })).revision, 5);
});

Deno.test("rpc-cache: a board event detaches an in-flight stale read; its late result cannot replace fresh cache", async () => {
  clearRpcCache();
  const pending: Array<(value: { ok: true; revision: number }) => void> = [];
  const send = () => new Promise<{ ok: true; revision: number }>((resolve) => pending.push(resolve));
  const oldRead = cachedRpc("board.list", {}, { send });
  await Promise.resolve(); // send() starts in a microtask
  assertEquals(pending.length, 1);
  handleBroadcastEvent("board-job-posted");
  const freshRead = cachedRpc("board.list", {}, { send });
  await Promise.resolve();
  assertEquals(pending.length, 2, "refresh after an event must not join the old in-flight snapshot");
  pending[1]({ ok: true, revision: 2 });
  assertEquals((await freshRead).revision, 2);
  pending[0]({ ok: true, revision: 1 });
  assertEquals((await oldRead).revision, 1, "existing consumers still settle with their own earlier reply");
  assertEquals((await cachedRpc("board.list", {}, { send })).revision, 2,
    "late pre-event response must not overwrite or recache the post-event snapshot");
});

Deno.test("rpc-cache: an early stale reply cannot delete the newer in-flight board read", async () => {
  clearRpcCache();
  const pending: Array<(value: { ok: true; revision: number }) => void> = [];
  const send = () => new Promise<{ ok: true; revision: number }>((resolve) => pending.push(resolve));
  const oldRead = cachedRpc("board.list", {}, { send });
  await Promise.resolve();
  handleBroadcastEvent("board-job-completed");
  const newRead = cachedRpc("board.list", {}, { send });
  await Promise.resolve();
  assertEquals(pending.length, 2);
  pending[0]({ ok: true, revision: 1 });
  await oldRead;
  assertEquals(getRpcCacheStats().inFlightCount, 1, "stale settlement must preserve its live successor");
  const joinedRead = cachedRpc("board.list", {}, { send });
  await Promise.resolve();
  assertEquals(pending.length, 2, "a third caller must join the NEW flight, not start a third RPC");
  pending[1]({ ok: true, revision: 2 });
  assertEquals((await newRead).revision, 2);
  assertEquals((await joinedRead).revision, 2);
  assertEquals((await cachedRpc("board.list", {}, { send })).revision, 2);
});

Deno.test("rpc-cache: board.messages is a read and board events leave unrelated in-flight reads coalesced", async () => {
  clearRpcCache();
  let boardCalls = 0;
  const boardSend = async () => ({ ok: true, revision: ++boardCalls });
  await cachedRpc("board.list", {}, { send: boardSend });
  await cachedRpc("board.messages", { limit: 5 }, { send: boardSend });
  await cachedRpc("board.messages", { limit: 5 }, { send: boardSend });
  assertEquals((await cachedRpc("board.list", {}, { send: boardSend })).revision, 1,
    "cached board.messages READ must not flush cached board.list");
  let finish!: (value: { ok: true }) => void;
  let otherCalls = 0;
  const otherSend = () => { otherCalls++; return new Promise<{ ok: true }>((resolve) => { finish = resolve; }); };
  const first = cachedRpc("agent.directory", {}, { send: otherSend });
  await Promise.resolve();
  handleBroadcastEvent("board-job-posted");
  const second = cachedRpc("agent.directory", {}, { send: otherSend });
  assertEquals(otherCalls, 1, "board invalidation must not restart unrelated in-flight agent reads");
  finish({ ok: true });
  await Promise.all([first, second]);
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

Deno.test("h5hd9: sequential caller awaiting agent.directory before agent.tool-offers misses single-flight coalescing under load (deterministic clock)", async () => {
  clearRpcCache();
  const realNow = Date.now;
  let simulatedTime = 10000;
  Date.now = () => simulatedTime;

  try {
    let directoryCalls = 0;
    let toolOffersCalls = 0;

    const dirDeferred = createDeferred<{ ok: true; agents: any[] }>();
    const offers1Deferred = createDeferred<{ ok: true; offers: any[] }>();
    const offers2Deferred = createDeferred<{ ok: true; offers: any[] }>();

    const send = async (type: string) => {
      if (type === "agent.directory") {
        directoryCalls++;
        return dirDeferred.promise;
      }
      if (type === "agent.tool-offers") {
        toolOffersCalls++;
        return toolOffersCalls === 1 ? offers1Deferred.promise : offers2Deferred.promise;
      }
      throw new Error(`unexpected type: ${type}`);
    };

    const ttlMs = 2000;

    // Caller B (renderSiteOffer): starts tool-offers and directory concurrently
    const callerBOffers = cachedRpc("agent.tool-offers", {}, { send, ttlMs });
    const callerBDir = cachedRpc("agent.directory", {}, { send, ttlMs });
    const callerB = Promise.all([callerBOffers, callerBDir]);

    // Caller A (historic sequential renderSiteAgents):
    // awaits directory FIRST, then awaits tool-offers
    const callerA = (async () => {
      const dir = await cachedRpc("agent.directory", {}, { send, ttlMs });
      const offers = await cachedRpc("agent.tool-offers", {}, { send, ttlMs });
      return [dir, offers];
    })();

    // Allow microtasks to run so both initial calls reach send()
    await Promise.resolve();
    assertEquals(directoryCalls, 1, "directory called once");
    assertEquals(toolOffersCalls, 1, "tool-offers caller B initiated");

    // Resolve caller B's tool-offers quickly and let it populate cache at simulatedTime=10000
    offers1Deferred.resolve({ ok: true, offers: [] });
    await callerBOffers;

    // Advance clock past the 2000ms TTL while directory is STILL pending (simulating load delay)
    simulatedTime += 2500;

    // Now directory finally resolves
    dirDeferred.resolve({ ok: true, agents: [] });
    await callerBDir;

    // Allow caller A to resume after awaiting directory and issue its tool-offers call
    await Promise.resolve();
    await Promise.resolve();

    // Resolve second tool-offers
    offers2Deferred.resolve({ ok: true, offers: [] });

    await Promise.all([callerB, callerA]);

    // FALSIFICATION: Because caller A delayed initiating tool-offers until after directory,
    // and directory took longer than TTL, caller B's cached entry expired and caller A
    // sent a DUPLICATE RPC!
    assertEquals(toolOffersCalls, 2, "sequential pattern issues duplicate tool-offers RPC when directory resolution exceeds TTL");
    assertEquals(directoryCalls, 1);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("h5hd9: concurrent Promise.all in both callers guarantees single-flight coalescing regardless of directory delay (deterministic clock)", async () => {
  clearRpcCache();
  const realNow = Date.now;
  let simulatedTime = 10000;
  Date.now = () => simulatedTime;

  try {
    let directoryCalls = 0;
    let toolOffersCalls = 0;

    const dirDeferred = createDeferred<{ ok: true; agents: any[] }>();
    const offersDeferred = createDeferred<{ ok: true; offers: any[] }>();

    const send = async (type: string) => {
      if (type === "agent.directory") {
        directoryCalls++;
        return dirDeferred.promise;
      }
      if (type === "agent.tool-offers") {
        toolOffersCalls++;
        return offersDeferred.promise;
      }
      throw new Error(`unexpected type: ${type}`);
    };

    const ttlMs = 2000;

    // Both callers dispatch agent.directory and agent.tool-offers concurrently in the same turn
    const callerB = Promise.all([
      cachedRpc("agent.tool-offers", {}, { send, ttlMs }),
      cachedRpc("agent.directory", {}, { send, ttlMs }),
    ]);

    const callerACoalesced = Promise.all([
      cachedRpc("agent.directory", {}, { send, ttlMs }),
      cachedRpc("agent.tool-offers", {}, { send, ttlMs }),
    ]);

    // Allow microtasks to settle: both callers enter in the same synchronous turn
    await Promise.resolve();

    assertEquals(toolOffersCalls, 1, "both callers joined the single in-flight tool-offers promise");
    assertEquals(directoryCalls, 1, "both callers joined the single in-flight directory promise");

    // Advance clock arbitrarily — in-flight requests are immune to TTL expiration!
    simulatedTime += 100000;

    // Resolve both in-flight responses
    offersDeferred.resolve({ ok: true, offers: [] });
    dirDeferred.resolve({ ok: true, agents: [] });

    await Promise.all([callerB, callerACoalesced]);

    // VERIFICATION: Exactly ONE call to tool-offers and ONE call to directory!
    assertEquals(toolOffersCalls, 1, "concurrent Promise.all guarantees exactly 1 tool-offers RPC");
    assertEquals(directoryCalls, 1);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("h5hd9: open-tabs-changed broadcast preserves fresh invalidation for tab changes", async () => {
  clearRpcCache();
  let toolOffersCalls = 0;
  const send = async (type: string) => {
    if (type === "agent.tool-offers") {
      toolOffersCalls++;
      return { ok: true, offers: [] };
    }
    throw new Error(`unexpected type: ${type}`);
  };

  // 1. Initial query warms cache
  await cachedRpc("agent.tool-offers", {}, { send });
  assertEquals(toolOffersCalls, 1);

  // 2. Tab changes: open-tabs-changed invalidates agent.tool-offers so fresh tab offers appear
  handleBroadcastEvent("open-tabs-changed");

  // 3. Re-render after tab change re-queries
  await cachedRpc("agent.tool-offers", {}, { send });
  assertEquals(toolOffersCalls, 2, "open-tabs-changed invalidates agent.tool-offers for real tab changes");
});

Deno.test("h5hd9: isWebTabUrl correctly identifies web vs internal browser URLs", () => {
  assertEquals(isWebTabUrl("chrome-extension://abcdef/ntp/ntp.html"), false);
  assertEquals(isWebTabUrl("chrome://newtab"), false);
  assertEquals(isWebTabUrl("about:blank"), false);
  assertEquals(isWebTabUrl(undefined), false);
  assertEquals(isWebTabUrl(""), false);
  assertEquals(isWebTabUrl("https://example.com/shop"), true);
  assertEquals(isWebTabUrl("http://localhost:8080/"), true);
});

Deno.test("h5hd9: createTabChangeNotifier listeners filter non-web events and notify web events", async () => {
  let notifications = 0;
  const tabsMap = new Map<number, any>();

  const fakeChromeTabs = {
    get: (tabId: number, cb: (tab: any) => void) => {
      cb(tabsMap.get(tabId));
    },
  };

  const notifier = createTabChangeNotifier({
    notify: () => {
      notifications++;
    },
    chromeTabs: fakeChromeTabs,
    debounceMs: 5,
  });

  // 1. Cold boot NTP events: created with no URL, updated to ntp.html, activated
  tabsMap.set(1, { id: 1, url: "chrome-extension://abcdef/ntp/ntp.html" });
  notifier.handleCreated({ id: 1 });
  notifier.handleCreated({ id: 1, url: "about:blank" });
  notifier.handleUpdated(1, { status: "complete" }, { id: 1, url: "chrome-extension://abcdef/ntp/ntp.html" });
  notifier.handleActivated({ tabId: 1, windowId: 1 });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 0, "NTP / extension / blank tab events must NOT trigger notification");

  // 2. Real web tab created with https URL
  tabsMap.set(2, { id: 2, url: "https://example.com/api" });
  notifier.handleCreated({ id: 2, url: "https://example.com/api" });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 1, "creating a web tab must notify");

  // 3. Web tab navigation completes
  notifier.handleUpdated(2, { status: "complete" }, { id: 2, url: "https://example.com/products" });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 2, "navigating a web tab must notify");

  // 4. Web tab activation (switch to web tab)
  notifier.handleActivated({ tabId: 2, windowId: 1 });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 3, "activating a web tab must notify");

  // 5. Switching back to NTP tab does NOT notify
  notifier.handleActivated({ tabId: 1, windowId: 1 });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 3, "activating an internal NTP tab must NOT notify");

  // 6. Web tab navigates away to an internal page (web -> non-web transition)
  tabsMap.set(2, { id: 2, url: "chrome://settings" });
  notifier.handleUpdated(2, { status: "complete" }, { id: 2, url: "chrome://settings" });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 4, "navigating a web tab to an internal page MUST notify to purge stale offers");

  // 7. Non-web tab navigating to another non-web page does NOT notify
  notifier.handleUpdated(2, { status: "complete" }, { id: 2, url: "chrome://version" });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 4, "internal to internal navigation must NOT notify");

  // 8. Tab removal notifies
  notifier.handleRemoved(2);

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 5, "removing a tab must notify");
});

Deno.test("h5hd9: fresh notifier seeds baseline on startup and notifies when pre-existing web tab navigates to internal page", async () => {
  let notifications = 0;
  // Pre-existing open tabs prior to worker startup/restart
  const preExistingTabs = [
    { id: 10, url: "chrome-extension://abcdef/ntp/ntp.html" },
    { id: 20, url: "https://github.com/PaulKinlan/chrome-agent-platform" },
  ];

  const fakeChromeTabs = {
    query: (_queryInfo: any, cb: (tabs: any[]) => void) => {
      cb(preExistingTabs);
    },
    get: (tabId: number, cb: (tab: any) => void) => {
      cb(preExistingTabs.find((t) => t.id === tabId));
    },
  };

  // Fresh notifier instantiated (simulating service-worker restart)
  const freshNotifier = createTabChangeNotifier({
    notify: () => {
      notifications++;
    },
    chromeTabs: fakeChromeTabs,
    debounceMs: 5,
  });

  // Verify baseline seeded tab 20 as web tab and excluded internal tab 10
  assertEquals(freshNotifier.knownWebTabs.has(20), true, "pre-existing web tab 20 seeded in knownWebTabs");
  assertEquals(freshNotifier.knownWebTabs.has(10), false, "pre-existing internal tab 10 excluded from knownWebTabs");
  assertEquals(notifications, 0, "startup baseline query must NOT emit spurious notification");

  // Pre-existing web tab navigates to internal chrome://settings
  freshNotifier.handleUpdated(20, { status: "complete" }, { id: 20, url: "chrome://settings" });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 1, "navigating pre-existing web tab to internal page must notify after worker restart");
  assertEquals(freshNotifier.knownWebTabs.has(20), false, "navigated tab 20 removed from knownWebTabs");
});

Deno.test("h5hd9: fresh notifier reconciles updates occurring while baseline query is delayed/pending", async () => {
  let notifications = 0;
  const preExistingTabs = [
    { id: 10, url: "chrome-extension://abcdef/ntp/ntp.html" },
    { id: 30, url: "https://example.org/webpage" },
  ];

  let queryCallback!: (tabs: any[]) => void;
  const fakeChromeTabs = {
    query: (_queryInfo: any, cb: (tabs: any[]) => void) => {
      // Hold query callback to simulate delayed async response
      queryCallback = cb;
    },
    get: (tabId: number, cb: (tab: any) => void) => {
      cb(preExistingTabs.find((t) => t.id === tabId));
    },
  };

  // Fresh notifier instantiated (simulating worker restart with in-flight query)
  const freshNotifier = createTabChangeNotifier({
    notify: () => {
      notifications++;
    },
    chromeTabs: fakeChromeTabs,
    debounceMs: 5,
  });

  assertEquals(freshNotifier.isBaselinePending(), true, "baseline query is in-flight");

  // While query is pending:
  // 1. Cold boot NTP tab updates (must NOT notify)
  freshNotifier.handleUpdated(10, { status: "complete" }, { id: 10, url: "chrome-extension://abcdef/ntp/ntp.html" });

  // 2. Pre-existing web tab 30 navigates to internal page before baseline query finishes
  freshNotifier.handleUpdated(30, { status: "complete" }, { id: 30, url: "chrome://settings" });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 0, "no notifications while baseline query is in flight");

  // Now the delayed baseline query completes, returning tab 30 with its CURRENT internal URL
  queryCallback([
    { id: 10, url: "chrome-extension://abcdef/ntp/ntp.html" },
    { id: 30, url: "chrome://settings" },
  ]);

  assertEquals(freshNotifier.isBaselinePending(), false, "baseline query finished");

  // Reconciled: tab 30 transitioned to non-web and was reconciled from buffered update
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 1, "delayed query callback reconciles tab 30 transition and triggers notification");
  assertEquals(freshNotifier.knownWebTabs.has(30), false, "tab 30 is not in knownWebTabs");
  assertEquals(freshNotifier.knownWebTabs.has(10), false, "tab 10 is not in knownWebTabs");
});

Deno.test("h5hd9: web update followed by non-web update during pending baseline query removes ID and notifies", async () => {
  let notifications = 0;
  let queryCallback!: (tabs: any[]) => void;
  const fakeChromeTabs = {
    query: (_queryInfo: any, cb: (tabs: any[]) => void) => {
      queryCallback = cb;
    },
  };

  const freshNotifier = createTabChangeNotifier({
    notify: () => {
      notifications++;
    },
    chromeTabs: fakeChromeTabs,
    debounceMs: 5,
  });

  // Tab 40 updates to web while query is pending
  freshNotifier.handleUpdated(40, { status: "complete" }, { id: 40, url: "https://example.org/docs" });
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 1, "web update notifies");
  assertEquals(freshNotifier.knownWebTabs.has(40), true, "tab 40 added to knownWebTabs");

  // Tab 40 subsequent non-web update while query is still pending
  freshNotifier.handleUpdated(40, { status: "complete" }, { id: 40, url: "chrome://settings" });
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 2, "subsequent non-web update notifies of transition");
  assertEquals(freshNotifier.knownWebTabs.has(40), false, "tab 40 removed from knownWebTabs");

  // Baseline query now completes
  queryCallback([
    { id: 40, url: "chrome://settings" },
  ]);

  // Tab 40 is guaranteed NOT in knownWebTabs
  assertEquals(freshNotifier.knownWebTabs.has(40), false, "tab 40 stays removed from knownWebTabs after query callback");

  // A later internal update to tab 40 must NOT broadcast unnecessarily
  freshNotifier.handleUpdated(40, { status: "complete" }, { id: 40, url: "chrome://version" });
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 2, "later internal update to tab 40 must NOT broadcast");
});

Deno.test("h5hd9: pre-existing web tab navigating to about:blank or internal-extension during pending query is reconciled and notifies", async () => {
  let notifications = 0;
  let queryCallback!: (tabs: any[]) => void;
  const fakeChromeTabs = {
    query: (_queryInfo: any, cb: (tabs: any[]) => void) => {
      queryCallback = cb;
    },
  };

  const freshNotifier = createTabChangeNotifier({
    notify: () => {
      notifications++;
    },
    chromeTabs: fakeChromeTabs,
    debounceMs: 5,
  });

  // Cold boot tab 10 was created in this session as an internal blank/NTP tab
  freshNotifier.handleCreated({ id: 10, url: "about:blank" });
  freshNotifier.handleUpdated(10, { status: "complete" }, { id: 10, url: "chrome-extension://abcdef/ntp/ntp.html" });

  // While query is pending:
  // Pre-existing web tab 50 (which was already open, not created in this session) navigates to about:blank
  freshNotifier.handleUpdated(50, { status: "complete" }, { id: 50, url: "about:blank" });
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 0, "buffered while query is pending");

  // Query callback completes returning both tabs with their CURRENT internal URLs!
  queryCallback([
    { id: 10, url: "chrome-extension://abcdef/ntp/ntp.html" },
    { id: 50, url: "about:blank" },
  ]);

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 1, "delayed callback reconciles pre-existing tab 50 transition to about:blank and notifies");
  assertEquals(freshNotifier.knownWebTabs.has(50), false, "tab 50 removed from knownWebTabs");
  assertEquals(freshNotifier.knownWebTabs.has(10), false, "cold boot NTP tab 10 excluded from knownWebTabs and emitted no broadcasts");
});

Deno.test("h5hd9: newer web update during pending query is not erased by stale non-web snapshot", async () => {
  let notifications = 0;
  let queryCallback!: (tabs: any[]) => void;
  const fakeChromeTabs = {
    query: (_queryInfo: any, cb: (tabs: any[]) => void) => {
      queryCallback = cb;
    },
  };

  const freshNotifier = createTabChangeNotifier({
    notify: () => {
      notifications++;
    },
    chromeTabs: fakeChromeTabs,
    debounceMs: 5,
  });

  // Web update arrives for tab 60 while query is pending
  freshNotifier.handleUpdated(60, { status: "complete" }, { id: 60, url: "https://example.com/live" });
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 1, "web update notifies");
  assertEquals(freshNotifier.knownWebTabs.has(60), true, "tab 60 is known web tab");

  // Delayed query callback completes with a stale snapshot returning tab 60 as non-web
  queryCallback([
    { id: 60, url: "chrome://settings" },
  ]);

  // Newer live web update must NOT be erased by stale non-web query snapshot!
  assertEquals(freshNotifier.knownWebTabs.has(60), true, "stale query snapshot does not erase live web tab state");

  // Subsequent navigation from web to internal properly detects transition and notifies
  freshNotifier.handleUpdated(60, { status: "complete" }, { id: 60, url: "chrome://settings" });
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(notifications, 2, "transition from web to internal notifies");
  assertEquals(freshNotifier.knownWebTabs.has(60), false, "tab 60 removed from knownWebTabs");
});

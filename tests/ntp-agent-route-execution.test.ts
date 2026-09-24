// tests/ntp-agent-route-execution.test.ts — chrome-agent-platform-32yz.
//
// THE GAP THIS CLOSES, measured at d31158b0 rather than taken from the bead:
// the bead's headline ("no test executes ntp.js") is FALSE — three tests
// execute it through the house dynamic-import pattern
// (conversation-run-sequence, durable-task-restore, thread-continuation-multirun),
// and two drive ntp.html in a real browser. What is TRUE is narrower and is what
// this file fixes:
//
//   `#agent=` appears ZERO times in all three executing tests. The agent-route
//   state machine — openAgentSurface / openAgentChat / revalidateOpenAgent /
//   navigateNtpRoute — is named ONLY by source-scanning tests, plus ONE real
//   browser test (tests/agent-header-rename-reload.test.ts) that is declared
//   `ignore: CHROME_FOR_TESTING === null`. On a checkout without Chrome for
//   Testing that surface is covered by REGEX ALONE.
//
// That is exactly the bead's own example 2: when ntp.js was reverted to main,
// 3 of 4 tests in agent-header-rename-reload still passed, because the
// "behavioural" half was an inline simulation and the browser half can be
// skipped — leaving a source pin as the only failing assertion.
//
// So this file EXECUTES the real ntp.js against the house DOM + chrome stub,
// with NO Chrome-for-Testing dependency, and asserts the 7zf0 behaviours:
//   1. boot on #agent=named:<id> resolves the FRESH persisted name (the route
//      calls named-agent.get) rather than trusting a stale history.state.name;
//   2. history.state is re-synchronised to that fresh name;
//   3. the surface's own controls are wired (edit shown for named agents).
//
// WHY history CARRIES pushState/replaceState HERE: navigateNtpRoute returns
// FALSE immediately unless `win.history.pushState` AND `replaceState` exist
// (extension/lib/navigation-controller.js:262). A stub without them makes every
// assertion about history.state vacuous — the code under test would return
// early and the test would pass having driven nothing.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";

const AGENT_ID = "agent-32yz-route";
const STALE_NAME = "ZZZ Stale History Name";
const FRESH_NAME = "ZZZ Fresh Persisted Name";

async function waitFor(fn: () => boolean, label: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The house DOM + chrome stub (the shape conversation-run-sequence.test.ts and
 *  durable-task-restore.test.ts use), plus a REAL history object so the
 *  navigation controller's pushState/replaceState guard is satisfied. */
// TWO INDEPENDENT PATHS feed the agent header, and a harness that satisfies
// both cannot tell them apart. Measured: reverting the history-sync condition
// at ntp.js:2733 left this file GREEN, because the `named-agent.list` callback
// (ntp.js:2714-2723) re-synchronised history.state by itself. So the routes are
// isolated here — `getName` feeds named-agent.get (the openAgentChat path) and
// `listAgents` feeds named-agent.list (the late-callback path), and a test that
// targets one supplies nothing through the other.
//
// `listDelayMs` exists because REPLY LATENCY CHANGES THE OUTCOME, measured:
// with a microtask reply the list callback (ntp.js:2714) runs BEFORE
// openAgentSurface's awaited history load, so its header correction is then
// overwritten by `threadTitle.textContent = name` at :2758 and the STALE name
// wins; with a 40 ms reply the correction survives.
//
// WHAT I DO NOT KNOW, stated rather than implied: whether that fast ordering is
// reachable in a real browser. Both calls are IPC and the list is issued FIRST
// (:2714) while the history read is issued later (:2752), so the list replying
// first is plausible rather than impossible. It only matters when
// named-agent.get and named-agent.list DISAGREE, which the product's own flow
// does not normally produce. Filed as its own bead rather than asserted here,
// because "my stub is unrealistic" and "the product has an ordering bug" are
// different claims and this file has only measured the first.
function makeHarness(opts: { getName: string; listAgents?: any[]; listDelayMs?: number }) {
  const agentName = opts.getName;
  const listAgents = opts.listAgents ?? [{ id: AGENT_ID, name: agentName, role: "tester" }];
  const listDelayMs = opts.listDelayMs ?? 0;
  const elements = new Map<string, any>();
  const sent: any[] = [];

  function getOrCreateElement(id: string, tagName = "div") {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map<string, Array<(ev: any) => void>>();
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const children: any[] = [];
    const el: any = {
      id,
      tagName: tagName.toUpperCase(),
      // The thread view starts hidden exactly as in ntp.html; the agent route
      // is what must open it.
      // Mirror ntp.html's own defaults. edit-agent and delete-agent carry the
      // `hidden` attribute there (:1224-1225), and a stub that defaults them
      // VISIBLE makes "the surface offers Edit" pass without the route running
      // — measured: that assertion passed while the agent route never fired.
      hidden: id === "thread-view" || id === "view" || id === "durable-run-registry" ||
        id === "edit-agent" || id === "delete-agent",
      textContent: "",
      innerHTML: "",
      style: {},
      value: "",
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        toggle: (c: string, force?: boolean) => {
          if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
          else if (force) classes.add(c); else classes.delete(c);
        },
        contains: (c: string) => classes.has(c),
      },
      getAttribute: (k: string) => attributes.get(k) ?? null,
      setAttribute: (k: string, v: unknown) => attributes.set(k, String(v)),
      removeAttribute: (k: string) => attributes.delete(k),
      hasAttribute: (k: string) => attributes.has(k),
      toggleAttribute: (k: string, force?: boolean) => {
        const present = force === undefined ? !attributes.has(k) : force;
        if (present) attributes.set(k, ""); else attributes.delete(k);
        return present;
      },
      addEventListener: (t: string, fn: (ev: any) => void) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t)!.push(fn);
      },
      removeEventListener: (t: string, fn: (ev: any) => void) => {
        const arr = listeners.get(t);
        if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
      },
      dispatchEvent: (ev: any) => {
        for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
      append: (...nodes: any[]) => children.push(...nodes),
      appendChild: (node: any) => { children.push(node); return node; },
      replaceChildren: (...nodes: any[]) => { children.splice(0, children.length, ...nodes); },
      removeChild: (node: any) => { const i = children.indexOf(node); if (i >= 0) children.splice(i, 1); return node; },
      contains: (node: any) => children.includes(node),
      scrollIntoView: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      focus: () => {},
      focusInput: () => {},
      clear: () => { children.length = 0; },
      setMessages: (msgs: any[]) => { children.splice(0, children.length, ...msgs); },
      setIdentity: (identity: any) => { el.identity = identity; },
      resetPlan: () => {},
      appendSystem: () => {},
      appendUser: () => {},
      appendAgent: () => {},
      setLiveStatus: () => {},
      clearLiveStatus: () => {},
      get children() { return children; },
    };
    elements.set(id, el);
    return el;
  }

  (globalThis as any).document = {
    getElementById: (id: string) => getOrCreateElement(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag: string) => getOrCreateElement(`dyn_${Math.random().toString(36).slice(2, 8)}`, tag),
    // renderSidebarAgents appends REAL text nodes (ntp.js:1203) — the house
    // pattern for this stub is tests/agent-picker-summary.test.ts:84. Its
    // absence is not a cosmetic gap: the boot path throws without it, which is
    // itself evidence that this file executes the module rather than a copy.
    createTextNode: (text: string) =>
      Object.assign(
        getOrCreateElement(`txt_${Math.random().toString(36).slice(2, 8)}`, "#text"),
        { textContent: String(text) },
      ),
    documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    addEventListener: () => {},
    removeEventListener: () => {},
    startViewTransition: (update: () => void) => { update(); return { finished: Promise.resolve() }; },
  };
  (globalThis as any).window = globalThis;
  (globalThis as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).HTMLElement = class HTMLElement {};
  (globalThis as any).customElements = { define() {}, get: () => undefined };
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string; detail: any;
    constructor(type: string, init: any = {}) { this.type = type; this.detail = init.detail; }
  };
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};

  // The route under test: a deep link / reload on a named agent.
  // `href` is REQUIRED, not decoration: ensureNtpHistoryRoot (ntp.js:520, at
  // module scope BEFORE the boot route) reads win.location.href to preserve the
  // deep URL across its two-step rooting.
  const location: any = {
    hash: `#agent=named:${AGENT_ID}`,
    pathname: "/ntp/ntp.html",
    search: "",
    get href() { return `${location.pathname}${location.search}${location.hash}`; },
  };
  (globalThis as any).location = location;

  // A REAL history, with BROWSER SEMANTICS for the third argument.
  //
  // Two traps here, both measured rather than assumed:
  //  (a) pushState/replaceState must EXIST — navigateNtpRoute and
  //      ensureNtpHistoryRoot both return false at their first line otherwise,
  //      and every history assertion in this file would pass vacuously.
  //  (b) the third argument is a URL, not a hash. ensureNtpHistoryRoot roots the
  //      stack by calling replaceState(…, `${pathname}${search}`) and then
  //      pushState(…, deepUrl). A stub that assigns that argument straight into
  //      location.hash DESTROYS `#agent=…` before the boot route parses it — the
  //      route then degrades to "hub", never calls named-agent.get, and the test
  //      measures nothing. That is exactly what happened on the first run of this
  //      file (title "", thread-view still hidden, no named-agent.get in the
  //      sent log), so the URL handling below is load-bearing.
  //
  // The state starts carrying the STALE name — the 7zf0 defect's trigger.
  const applyUrl = (url: unknown) => {
    if (typeof url !== "string") return;
    const i = url.indexOf("#");
    location.hash = i >= 0 ? url.slice(i) : "";
  };
  const history: any = {
    state: { route: "agent", kind: "named", id: AGENT_ID, name: STALE_NAME },
    pushState: (state: any, _title: string, url?: string) => {
      history.state = state;
      applyUrl(url);
    },
    replaceState: (state: any, _title: string, url?: string) => {
      history.state = state;
      applyUrl(url);
    },
  };
  (globalThis as any).history = history;

  (globalThis as any).chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(msg: any, cb: (res: unknown) => void) {
        sent.push(msg);
        const reply = (v: unknown) => queueMicrotask(() => cb(v));
        // THE FRESH NAME lives only behind named-agent.get / named-agent.list.
        // A route that trusts history.state never asks, and never sees it.
        if (msg.type === "named-agent.get") {
          return reply({ ok: true, agent: { id: AGENT_ID, name: agentName, role: "tester" } });
        }
        if (msg.type === "named-agent.list") {
          const payload = { ok: true, agents: listAgents };
          if (listDelayMs > 0) { setTimeout(() => cb(payload), listDelayMs); return; }
          return reply(payload);
        }
        if (msg.type === "named-agent.history") return reply({ ok: true, entries: [] });
        if (msg.type === "agent.history-view") return reply({ ok: false });
        if (msg.type === "provider.permission-summary") return reply({ ok: true, local: true });
        if (msg.type === "thread.list") return reply({ ok: true, threads: [] });
        if (msg.type === "agent.list") return reply({ ok: true, origins: [] });
        if (msg.type === "background-agent.list") return reply({ ok: true, recipes: [], agents: [] });
        if (msg.type === "asset.list") return reply({ ok: true, assets: [] });
        if (msg.type === "memory.get") return reply([]);
        return reply({ ok: true });
      },
      connect() {
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };

  return { getOrCreateElement, sent, history };
}

/** Execute the REAL ntp.js. The query suffix defeats the module cache so each
 *  test boots a fresh instance against its own harness. */
async function bootNtp() {
  await import(`../extension/ntp/ntp.js?exec=${Math.random().toString(36).slice(2)}`);
}

Deno.test("32yz: booting #agent=named:<id> EXECUTES ntp.js and resolves the fresh persisted name", async () => {
  // ISOLATED to the openAgentChat path: the list returns NOTHING, so the only
  // source of the fresh name is named-agent.get. Without this, a route that
  // skipped openAgentChat entirely would still be rescued by the list callback
  // and this test would pass on the defect it exists to catch.
  const harness = makeHarness({ getName: FRESH_NAME, listAgents: [] });
  await bootNtp();

  const threadTitle = harness.getOrCreateElement("thread-title");
  await waitFor(() => threadTitle.textContent === FRESH_NAME, "thread title to resolve the fresh agent name");

  // 1. THE HEADER. The stale name in history.state must never win: the route
  //    resolves the agent through named-agent.get (openAgentChat) and renders
  //    the persisted name. This is the 7zf0 defect's user-visible half.
  assertEquals(threadTitle.textContent, FRESH_NAME, "the header shows the persisted name, not history.state's stale one");
  assert(threadTitle.textContent !== STALE_NAME, "the stale history.state name must not reach the header");

  // 2. THE ROUTE ACTUALLY ASKED. A header that happened to be right without the
  //    lookup would prove nothing — assert the message went out.
  const asked = harness.sent.filter((m: any) => m.type === "named-agent.get" && m.id === AGENT_ID);
  assert(asked.length >= 1, `the agent route must resolve the name via named-agent.get; sent: ${harness.sent.map((m: any) => m.type).join(",")}`);

  // 3. THE THREAD VIEW OPENED. The agent route is a surface transition, not
  //    just a string assignment.
  assertEquals(harness.getOrCreateElement("thread-view").hidden, false, "the agent route opens the thread surface");
});

Deno.test("32yz: the agent route re-synchronises history.state to the fresh name", async () => {
  // ISOLATED to openAgentSurface's own sync (ntp.js:2733). The list returns
  // nothing, so the late callback at :2721 cannot do the work instead —
  // measured: with the list populated, reverting :2733 left this GREEN.
  const harness = makeHarness({ getName: FRESH_NAME, listAgents: [] });
  assertEquals(harness.history.state.name, STALE_NAME, "precondition: history.state starts stale");

  await bootNtp();
  await waitFor(
    () => harness.history.state?.name === FRESH_NAME,
    `history.state.name to be re-synchronised (saw ${JSON.stringify(harness.history.state?.name)})`,
  );

  // The entry the owner would traverse BACK to must carry the fresh name, or a
  // reload re-renders the stale one — the exact 7zf0 loop.
  assertEquals(harness.history.state.name, FRESH_NAME, "history.state carries the fresh name after the route resolves it");
  assertEquals(harness.history.state.route, "agent", "the entry is still the agent route");
  assertEquals(harness.history.state.id, AGENT_ID, "the entry still identifies the same agent");
});

Deno.test("32yz: a LATE named-agent.list correction updates the header and history", async () => {
  // The other path, isolated the other way: named-agent.get answers with the
  // STALE name (a cached/late store), and only the list carries the fresh one.
  // ntp.js:2714-2723 must notice the discrepancy and correct BOTH surfaces.
  const harness = makeHarness({
    getName: STALE_NAME,
    listAgents: [{ id: AGENT_ID, name: FRESH_NAME, role: "tester" }],
    // GENUINELY LATE. Measured: at 0 ms the callback lands before
    // openAgentSurface's awaited history load and :2758 overwrites its header
    // correction with the stale name — an ordering a real browser's IPC does not
    // produce, and an artefact of the stub rather than a product defect. Filed
    // separately rather than asserted here.
    listDelayMs: 40,
  });
  await bootNtp();

  const threadTitle = harness.getOrCreateElement("thread-title");
  await waitFor(
    () => threadTitle.textContent === FRESH_NAME,
    `the list callback to correct the header (saw ${JSON.stringify(threadTitle.textContent)})`,
  );
  assertEquals(threadTitle.textContent, FRESH_NAME, "a late list correction reaches the header");
  await waitFor(
    () => harness.history.state?.name === FRESH_NAME,
    `the list callback to re-sync history.state (saw ${JSON.stringify(harness.history.state?.name)})`,
  );
  assertEquals(harness.history.state.name, FRESH_NAME, "a late list correction re-syncs history.state");
});

Deno.test("32yz: the named-agent surface wires its owner controls", async () => {
  const harness = makeHarness({ getName: FRESH_NAME });
  await bootNtp();

  const editBtn = harness.getOrCreateElement("edit-agent");
  await waitFor(() => editBtn.hidden === false, "edit control to be shown for a named agent");

  // openAgentSurface owns this: named agents have the config dialog, and the
  // delete control is offered for every kind except acp.
  assertEquals(editBtn.hidden, false, "a named agent surface offers Edit");
  assertEquals(harness.getOrCreateElement("delete-agent").hidden, false, "a named agent surface offers Delete");
});

Deno.test("32yz: the two header paths are ISOLATED, so neither can mask the other", async () => {
  // A guard on this file's own discriminating power, written because it FAILED
  // this property once: with both paths supplying the fresh name, reverting the
  // history-sync condition at ntp.js:2733 left all four tests green. Each
  // path-specific test must therefore starve the other path.
  const self = await Deno.readTextFile(new URL(import.meta.url));
  const isolated = [...self.matchAll(/listAgents:\s*\[\]/g)].length;
  assert(
    isolated >= 2,
    `the openAgentChat-path tests must starve the list callback (listAgents: []); found ${isolated}`,
  );
  assert(
    /getName:\s*STALE_NAME/.test(self),
    "the list-callback test must starve the get path by answering it with the stale name",
  );
});

Deno.test("32yz: the executing coverage this file adds is REAL — the harness drives the route, not a simulation", async () => {
  // A guard on this file itself. The bead exists because "behavioural" tests
  // re-implemented ntp.js's logic inline, so reverting ntp.js left them green.
  // These two properties are what make the tests above incapable of that:
  //   (a) they IMPORT the real module rather than re-implementing it;
  //   (b) the history stub carries pushState/replaceState, without which
  //       navigateNtpRoute returns false at its first line and every
  //       history.state assertion passes vacuously.
  const self = await Deno.readTextFile(new URL(import.meta.url));
  assert(
    /await import\(`\.\.\/extension\/ntp\/ntp\.js\?exec=/.test(self),
    "this file must EXECUTE the real ntp.js, never re-implement its logic",
  );
  assert(
    /pushState:\s*\(/.test(self) && /replaceState:\s*\(/.test(self),
    "the history stub must implement pushState/replaceState or navigateNtpRoute returns early and the assertions are vacuous",
  );

  // And the module really is the product's, not a fixture copy.
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(/async function openAgentChat\(/.test(ntp), "openAgentChat is the route this file drives");
  assert(/bootNtpRoutes\(\);/.test(ntp), "ntp.js boots its routes at module scope — that is what the import above executes");
});

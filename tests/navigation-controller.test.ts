// tests/navigation-controller.test.ts — Comprehensive KAT test suite for Navigation API
// routing and History fallback (CAP-FB-20260823-NAVIGATION-BACK-01).
// @ts-nocheck

import {
  createNavigationController,
  parseNtpHash,
  NAVIGATION_EVENT_TYPES,
} from "../extension/lib/navigation-controller.js";
import {
  SETTINGS_SECTIONS,
  normalizeSettingsSectionId,
  OPTIONS_PRODUCT_HASHES,
} from "../extension/lib/pure.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Mock DOM & Navigation API builder
function createMockNavigationEnvironment({ initialHash = "#providers", hasModernNav = true } = {}) {
  const listeners = new Map();
  let currentHref = `chrome-extension://test/options/options.html${initialHash}`;
  let currentHash = initialHash;
  const historyStack = [currentHref];
  let historyIndex = 0;

  const fakeLocation = {
    get href() {
      return currentHref;
    },
    get hash() {
      return currentHash;
    },
    set hash(val) {
      currentHash = val.startsWith("#") ? val : `#${val}`;
      currentHref = `chrome-extension://test/options/options.html${currentHash}`;
      historyStack.push(currentHref);
      historyIndex++;
    },
    pathname: "/options/options.html",
  };

  const fakeHistory = {
    pushState(state, title, url) {
      currentHash = url.startsWith("#") ? url : `#${url}`;
      currentHref = `chrome-extension://test/options/options.html${currentHash}`;
      historyStack.push(currentHref);
      historyIndex++;
    },
    replaceState(state, title, url) {
      currentHash = url.startsWith("#") ? url : `#${url}`;
      currentHref = `chrome-extension://test/options/options.html${currentHash}`;
      historyStack[historyIndex] = currentHref;
    },
    back() {
      if (historyIndex > 0) {
        historyIndex--;
        currentHref = historyStack[historyIndex];
        const u = new URL(currentHref);
        currentHash = u.hash;
        return true;
      }
      return false;
    },
  };

  let fakeNavigation = null;
  if (hasModernNav) {
    const navListeners = new Map();
    fakeNavigation = {
      addEventListener(type, cb) {
        if (!navListeners.has(type)) navListeners.set(type, new Set());
        navListeners.get(type).add(cb);
      },
      removeEventListener(type, cb) {
        navListeners.get(type)?.delete(cb);
      },
      navigate(url, { history = "push", info = null } = {}) {
        const u = new URL(url);
        currentHash = u.hash;
        currentHref = url;
        if (history === "replace") {
          historyStack[historyIndex] = currentHref;
        } else {
          historyStack.push(currentHref);
          historyIndex++;
        }
        const p = this.dispatchNavigate(url, { navigationType: history === "replace" ? "replace" : "push", canIntercept: true });
        return {
          finished: p,
        };
      },
      // Trigger navigation event simulation
      async dispatchNavigate(destinationUrl, { navigationType = "push", canIntercept = true } = {}) {
        let interceptedHandler = null;
        const event = {
          destination: { url: destinationUrl },
          navigationType,
          canIntercept,
          intercept({ handler }) {
            interceptedHandler = handler;
          },
        };
        const cbs = navListeners.get("navigate") || [];
        for (const cb of cbs) {
          cb(event);
        }
        if (interceptedHandler) {
          await interceptedHandler();
        }
      },
    };
  }

  const win = {
    location: fakeLocation,
    history: fakeHistory,
    navigation: fakeNavigation,
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    dispatch(type, eventData = {}) {
      const cbs = listeners.get(type) || [];
      for (const cb of cbs) {
        cb(eventData);
      }
    },
  };

  return { win, fakeLocation, fakeHistory, fakeNavigation, historyStack };
}

Deno.test("Navigation Controller: Modern Navigation API registers exactly once and handles section navigation", async () => {
  const env = createMockNavigationEnvironment({ initialHash: "#providers", hasModernNav: true });
  const navigated = [];

  const ctrl = createNavigationController({
    win: env.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId, isTraverse }) => {
      navigated.push({ sectionId, isTraverse });
    },
  });

  assert(ctrl.isModern, "controller must detect modern Navigation API");

  // Initial sync
  await ctrl.syncCurrent();
  assertEquals(navigated.length, 1, "initial sync should navigate to initial section");
  assertEquals(navigated[0].sectionId, "providers");
  assertEquals(navigated[0].isTraverse, false);

  // Navigate to #tool-library
  await ctrl.navigate("#tool-library");
  assertEquals(navigated.length, 2);
  assertEquals(navigated[1].sectionId, "tool-library");

  // Simulate Back Button via Modern Navigation API traverse
  await env.fakeNavigation.dispatchNavigate("chrome-extension://test/options/options.html#providers", {
    navigationType: "traverse",
    canIntercept: true,
  });

  assertEquals(navigated.length, 3);
  assertEquals(navigated[2].sectionId, "providers");
  assertEquals(navigated[2].isTraverse, true, "back navigation must be marked as isTraverse");

  // Clean disposal
  ctrl.dispose();
});

Deno.test("Navigation Controller: Deep links (#background-agents, #browser, #tool-library) normalize and survive", async () => {
  const env = createMockNavigationEnvironment({ initialHash: "#background-agents", hasModernNav: true });
  const navigated = [];

  const ctrl = createNavigationController({
    win: env.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId }) => {
      navigated.push(sectionId);
    },
  });

  await ctrl.syncCurrent();
  assertEquals(navigated.length, 1);
  assertEquals(navigated[0], "background", "#background-agents must normalize to 'background'");

  await ctrl.navigate("#browser");
  assertEquals(navigated[1], "browser");

  await ctrl.navigate("#tool-library");
  assertEquals(navigated[2], "tool-library");

  // Invalid/stale hash fails closed safely
  const invalidResult = await ctrl.navigate("#nonexistent-section-id");
  assertEquals(invalidResult, false, "unknown section must be rejected");
  assertEquals(navigated.length, 3, "invalid hash must not invoke onNavigate");

  ctrl.dispose();
});

Deno.test("Navigation Controller: History API Fallback handles popstate and hashchange when Navigation API is absent", async () => {
  const env = createMockNavigationEnvironment({ initialHash: "#providers", hasModernNav: false });
  const navigated = [];

  const ctrl = createNavigationController({
    win: env.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId, isTraverse }) => {
      navigated.push({ sectionId, isTraverse });
    },
  });

  assert(!ctrl.isModern, "controller must recognize lack of Navigation API");

  await ctrl.syncCurrent();
  assertEquals(navigated.length, 1);
  assertEquals(navigated[0].sectionId, "providers");

  // Push new section
  await ctrl.navigate("#permissions");
  assertEquals(navigated.length, 2);
  assertEquals(navigated[1].sectionId, "permissions");

  // Simulate popstate (back button in legacy browser)
  env.fakeLocation.hash = "#providers";
  env.win.dispatch("popstate", { state: { section: "providers" } });

  // Yield microtask for async handler
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(navigated.length, 3);
  assertEquals(navigated[2].sectionId, "providers");
  assertEquals(navigated[2].isTraverse, true);

  ctrl.dispose();
});

Deno.test("Navigation Controller: Multi-step back/forward chain keeps aria-current and render hooks synchronized", async () => {
  const env = createMockNavigationEnvironment({ initialHash: "#providers", hasModernNav: true });
  const renderLog = [];
  const currentSections = [];

  const ctrl = createNavigationController({
    win: env.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId, isTraverse }) => {
      currentSections.push(sectionId);
      if (sectionId === "approvals") renderLog.push(`renderApprovals(traverse=${isTraverse})`);
      if (sectionId === "usage") renderLog.push(`renderUsage(traverse=${isTraverse})`);
    },
  });

  await ctrl.syncCurrent();
  assertEquals(currentSections[currentSections.length - 1], "providers");

  // Step 1: Nav to approvals
  await ctrl.navigate("#approvals");
  assertEquals(currentSections[currentSections.length - 1], "approvals");
  assertEquals(renderLog.includes("renderApprovals(traverse=false)"), true);

  // Step 2: Nav to usage
  await ctrl.navigate("#usage");
  assertEquals(currentSections[currentSections.length - 1], "usage");
  assertEquals(renderLog.includes("renderUsage(traverse=false)"), true);

  // Step 3: Nav to local-models
  await ctrl.navigate("#local-models");
  assertEquals(currentSections[currentSections.length - 1], "local-models");

  // Step 4: Traverse back to usage
  await env.fakeNavigation.dispatchNavigate("chrome-extension://test/options/options.html#usage", {
    navigationType: "traverse",
    canIntercept: true,
  });
  assertEquals(currentSections[currentSections.length - 1], "usage");
  assertEquals(renderLog.includes("renderUsage(traverse=true)"), true);

  // Step 5: Traverse back to approvals
  await env.fakeNavigation.dispatchNavigate("chrome-extension://test/options/options.html#approvals", {
    navigationType: "traverse",
    canIntercept: true,
  });
  assertEquals(currentSections[currentSections.length - 1], "approvals");
  assertEquals(renderLog.includes("renderApprovals(traverse=true)"), true);

  ctrl.dispose();
});

Deno.test("Navigation Controller: Stale/malformed navigation error is safely captured by onError without crashing", async () => {
  const env = createMockNavigationEnvironment({ initialHash: "#providers", hasModernNav: true });
  const errors = [];

  const ctrl = createNavigationController({
    win: env.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId }) => {
      if (sectionId === "about") {
        throw new Error("Simulated transient render failure");
      }
    },
    onError: (err) => {
      errors.push(err.message);
    },
  });

  const res = await ctrl.navigate("#about");
  assertEquals(res, false, "failing onNavigate must return false");
  assertEquals(errors.length, 1);
  assertEquals(errors[0], "Simulated transient render failure");

  ctrl.dispose();
});

Deno.test("Navigation Controller: Reload-after-back preserves normalized target section consistently", async () => {
  // First visit with deep link
  const initialEnv = createMockNavigationEnvironment({ initialHash: "#background-agents", hasModernNav: true });
  let landedSection = null;

  const ctrl1 = createNavigationController({
    win: initialEnv.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId }) => {
      landedSection = sectionId;
    },
  });
  await ctrl1.syncCurrent();
  assertEquals(landedSection, "background", "initial load must normalize #background-agents to 'background'");
  ctrl1.dispose();

  // Navigate to #permissions, then back, then reload
  const reloadEnv = createMockNavigationEnvironment({ initialHash: "#background-agents", hasModernNav: true });
  const ctrl2 = createNavigationController({
    win: reloadEnv.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId }) => {
      landedSection = sectionId;
    },
  });
  await ctrl2.syncCurrent();
  assertEquals(landedSection, "background");

  await ctrl2.navigate("#permissions");
  assertEquals(landedSection, "permissions");

  await reloadEnv.fakeNavigation.dispatchNavigate("chrome-extension://test/options/options.html#background", {
    navigationType: "traverse",
    canIntercept: true,
  });
  assertEquals(landedSection, "background");

  // Reload simulation: new instance reading the hash
  reloadEnv.fakeLocation.hash = "#background";
  const reloadCtrl = createNavigationController({
    win: reloadEnv.win,
    normalizeHash: normalizeSettingsSectionId,
    isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
    onNavigate: async ({ sectionId }) => {
      landedSection = sectionId;
    },
  });
  await reloadCtrl.syncCurrent();
  assertEquals(landedSection, "background", "reload after back must maintain consistent section state");
  ctrl2.dispose();
  reloadCtrl.dispose();
});

Deno.test("parseNtpHash: correctly parses all multi-page NTP routes", () => {
  assertEquals(JSON.stringify(parseNtpHash("")), JSON.stringify({ route: "hub" }));
  assertEquals(JSON.stringify(parseNtpHash("#")), JSON.stringify({ route: "hub" }));
  assertEquals(JSON.stringify(parseNtpHash("#thread=task-123")), JSON.stringify({ route: "thread", id: "task-123" }));
  assertEquals(JSON.stringify(parseNtpHash("#agent=background:bg-agent-1")), JSON.stringify({ route: "agent", kind: "background", id: "bg-agent-1" }));
  assertEquals(JSON.stringify(parseNtpHash("#agent=named:reviewer")), JSON.stringify({ route: "agent", kind: "named", id: "reviewer" }));
  assertEquals(JSON.stringify(parseNtpHash("#view=options%2Foptions.html")), JSON.stringify({ route: "view", path: "options/options.html" }));
  assertEquals(JSON.stringify(parseNtpHash("#omnibox=thread:find-files")), JSON.stringify({ route: "omnibox", mode: "thread", query: "find-files" }));
  assertEquals(JSON.stringify(parseNtpHash("#unknown-hash")), JSON.stringify({ route: "hub" }));
});

Deno.test("Navigation Controller: Reload-restore correctly resolves each route class on startup", () => {
  const routesToTest = [
    { hash: "", expected: { route: "hub" } },
    { hash: "#", expected: { route: "hub" } },
    { hash: "#thread=thread-abc-123", expected: { route: "thread", id: "thread-abc-123" } },
    { hash: "#agent=background:cron-job-1", expected: { route: "agent", kind: "background", id: "cron-job-1" } },
    { hash: "#agent=named:writer", expected: { route: "agent", kind: "named", id: "writer" } },
    { hash: "#agent=site:https%3A%2F%2Fexample.com", expected: { route: "agent", kind: "site", id: "https://example.com" } },
    { hash: "#view=options%2Foptions.html", expected: { route: "view", path: "options/options.html" } },
    { hash: "#view=directory%2Fdirectory.html", expected: { route: "view", path: "directory/directory.html" } },
    { hash: "#view=recipes%2Findex.html", expected: { route: "view", path: "recipes/index.html" } },
    { hash: "#view=artifacts%2Findex.html", expected: { route: "view", path: "artifacts/index.html" } },
  ];

  for (const { hash, expected } of routesToTest) {
    const parsed = parseNtpHash(hash);
    assertEquals(JSON.stringify(parsed), JSON.stringify(expected), `route for ${hash} must match expected`);
  }
});

Deno.test("OPTIONS_PRODUCT_HASHES contains all allowed settings deep links", () => {
  const required = [
    "#providers",
    "#local-models",
    "#tool-library",
    "#agents",
    "#background",
    "#background-agents",
    "#appearance",
    "#browser",
    "#permissions",
    "#approvals",
    "#hooks",
    "#prompts",
    "#usage",
    "#data",
    "#about",
  ];

  for (const h of required) {
    assert(OPTIONS_PRODUCT_HASHES.has(h), `OPTIONS_PRODUCT_HASHES must contain ${h}`);
  }
});

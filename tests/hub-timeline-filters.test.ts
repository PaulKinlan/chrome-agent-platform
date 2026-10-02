// @ts-nocheck
// tests/hub-timeline-filters.test.ts — falsification tests for chrome-agent-platform-716s.6
// Hub timeline filter row: All · Runs · Waiting · Made · Scheduled with persisted selection,
// empty state copy in owner voice, and screen-reader status text deduplication.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  TIMELINE_FILTERS,
  filterTimeline,
  timelineMatchesFilter,
} from "../extension/lib/hub-timeline.js";

// Setup browser globals for Web Components test
const registry = new Map();

class ElementNodeStub {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.textContent = "";
    this.tabIndex = 0;
    this.listeners = {};
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  scrollIntoView() {}
  focus() {}
  addEventListener(event, handler) {
    (this.listeners[event] ??= []).push(handler);
  }
  removeEventListener(event, handler) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((h) => h !== handler);
    }
  }
  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    for (const h of [...(this.listeners[event.type] ?? [])]) {
      h(event);
    }
    if (event.bubbles && this.parentNode?.dispatchEvent) {
      this.parentNode.dispatchEvent(event);
    }
    return true;
  }
  click() {
    this.dispatchEvent({
      type: "click",
      target: this,
      bubbles: true,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (sel === '[role="tab"]' && cur.getAttribute?.("role") === "tab") return cur;
      if (sel === ".tabs" && cur.tagName === "div") return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

class HTMLElementStub {
  constructor() {
    this._attrs = new Map();
    this.listeners = {};
  }
  attachShadow(_init) {
    this._shadow = new ShadowRootStub(this);
    return this._shadow;
  }
  get shadowRoot() {
    return this._shadow || null;
  }
  getAttribute(n) {
    return this._attrs.has(n) ? this._attrs.get(n) : null;
  }
  hasAttribute(n) {
    return this._attrs.has(n);
  }
  setAttribute(n, v) {
    const old = this.getAttribute(n);
    this._attrs.set(n, String(v));
    if (typeof this.attributeChangedCallback === "function" && old !== String(v)) {
      this.attributeChangedCallback(n, old, String(v));
    }
  }
  removeAttribute(n) {
    this._attrs.delete(n);
  }
  dispatchEvent(e) {
    e.target ??= this;
    e.currentTarget = this;
    for (const h of [...(this.listeners[e.type] ?? [])]) {
      h(e);
    }
    return true;
  }
  addEventListener(event, handler) {
    (this.listeners[event] ??= []).push(handler);
  }
  removeEventListener(event, handler) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((h) => h !== handler);
    }
  }
}

class ShadowRootStub {
  constructor(host) {
    this.host = host;
    this._innerHTML = "";
    this._tabs = new ElementNodeStub("div");
    this._tabs.parentNode = this;
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(html) {
    this._innerHTML = String(html);
    this._tabs = new ElementNodeStub("div");
    this._tabs.parentNode = this;
  }
  querySelector(sel) {
    if (sel === ".tabs") return this._tabs;
    return null;
  }
  querySelectorAll(sel) {
    if (sel.includes("button") || sel.includes('[role="tab"]')) return this._tabs.children;
    return [];
  }
  dispatchEvent(e) {
    return this.host?.dispatchEvent(e) ?? true;
  }
}

if (!globalThis.HTMLElement) {
  globalThis.HTMLElement = HTMLElementStub;
  globalThis.customElements = {
    define(name, cls) {
      registry.set(name, cls);
    },
    get(name) {
      return registry.get(name);
    },
  };
  globalThis.window = globalThis;
  globalThis.document = {
    createElement(tag) {
      return new ElementNodeStub(tag);
    },
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail ?? {};
    }
  };
}

// ── Fixture rows ────────────────────────────────────────────────────────────
const fixtureRows = [
  {
    id: "t-run",
    kind: "thread",
    threadId: "t-run",
    title: "Group open tabs",
    status: "running",
    outcome: "Running…",
    time: 5000,
  },
  {
    id: "t-wait",
    kind: "thread",
    threadId: "t-wait",
    title: "Request permission to open tab",
    status: "paused",
    outcome: "Waiting for you",
    time: 4000,
  },
  {
    id: "t-done",
    kind: "thread",
    threadId: "t-done",
    title: "Summarise article",
    status: "done",
    outcome: "Finished summary",
    time: 3000,
  },
  {
    id: "run:sched-1",
    kind: "scheduled",
    executionId: "sched-1",
    title: "Daily morning digest",
    scheduleName: "Daily digest",
    status: "done",
    outcome: "3 articles summarised",
    time: 2000,
  },
  {
    id: "t-made",
    kind: "thread",
    threadId: "t-made",
    title: "Generate report chart",
    status: "done",
    outcome: "Made report.html",
    time: 1000,
  },
];

// ── Part 1: Pure filter predicate over timeline projection ─────────────────
Deno.test("716s.6: TIMELINE_FILTERS exports the 5 primary filters", () => {
  assertEquals([...TIMELINE_FILTERS], ["All", "Runs", "Waiting", "Made", "Scheduled"]);
});

Deno.test("716s.6: selecting Waiting shows only paused/waiting runs", () => {
  const waiting = filterTimeline(fixtureRows, "Waiting");
  assertEquals(waiting.length, 1);
  assertEquals(waiting[0].id, "t-wait");
  assertEquals(waiting[0].status, "paused");
});

Deno.test("716s.6: selecting Runs shows non-scheduled task/thread runs", () => {
  const runs = filterTimeline(fixtureRows, "Runs");
  const ids = runs.map((r) => r.id);
  assert(ids.includes("t-run"));
  assert(ids.includes("t-wait"));
  assert(ids.includes("t-done"));
  assert(!ids.includes("run:sched-1"));
});

Deno.test("716s.6: selecting Made shows artifact/deliverable rows", () => {
  const made = filterTimeline(fixtureRows, "Made");
  assertEquals(made.length, 1);
  assertEquals(made[0].id, "t-made");
});

Deno.test("716s.6: selecting Scheduled shows scheduled runs", () => {
  const sched = filterTimeline(fixtureRows, "Scheduled");
  assertEquals(sched.length, 1);
  assertEquals(sched[0].id, "run:sched-1");
});

Deno.test("716s.6: selecting All returns all rows", () => {
  const all = filterTimeline(fixtureRows, "All");
  assertEquals(all.length, fixtureRows.length);
});

// ── Part 2: Screen-reader status text deduplication ─────────────────────────
Deno.test("716s.6: screen-reader text per row contains the state word once", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;

  // Running row
  timeline.entries = [{
    id: "t-live",
    kind: "thread",
    title: "Active task",
    status: "running",
    outcome: "Running…",
  }];

  const html = timeline._root.innerHTML;
  // Inspect the accessible text of the row button (stripping HTML tags)
  const buttonHtml = html.slice(html.indexOf('<button type="button" class="tl-row"'));
  const accessibleText = buttonHtml.replace(/<[^>]+>/g, " ");
  const runningMatches = accessibleText.match(/Running/gi) || [];
  // Must appear once in tl-outcome, NOT duplicated in tl-sr!
  assertEquals(runningMatches.length, 1, `Expected 'Running' to appear once in accessible text, got: ${runningMatches.length} in "${accessibleText.trim()}"`);
});

// ── Part 3: DOM presence of the 5-item filter row in ntp.html ───────────────
Deno.test("716s.6: ntp.html contains #timeline-filters with 5 primary filter chips", async () => {
  const ntpRaw = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  assert(ntpRaw.includes('id="timeline-filters"'), "ntp.html must contain #timeline-filters");
  assert(
    ntpRaw.includes('items="All,Runs,Waiting,Made,Scheduled"'),
    "timeline-filters must have items='All,Runs,Waiting,Made,Scheduled'",
  );
});

// ── Part 4: AgentTimeline empty-state copy in owner voice ───────────────────
Deno.test("716s.6: AgentTimeline displays 'Nothing waiting on you.' when Waiting filter is empty", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;
  // Non-empty entries, but none matching "Waiting"
  timeline.entries = [{
    id: "t-done",
    kind: "thread",
    title: "Completed task",
    status: "done",
    outcome: "Finished",
  }];
  timeline.filter = "Waiting";

  const html = timeline._root.innerHTML;
  assert(
    html.includes("Nothing waiting on you."),
    `Expected empty state 'Nothing waiting on you.', got: ${html}`,
  );
});

// ── Part 5: AgentTimeline filtering by Waiting shows only paused runs ──────
Deno.test("716s.6: AgentTimeline filtering by Waiting displays only the waiting run", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;
  timeline.entries = fixtureRows;

  // Filter set to Waiting
  timeline.filter = "Waiting";
  const html = timeline._root.innerHTML;
  assert(html.includes("Request permission to open tab"), "Must include paused task title");
  assert(!html.includes("Group open tabs"), "Must not include running task");
  assert(!html.includes("Summarise article"), "Must not include done task");
  assert(!html.includes("Daily morning digest"), "Must not include scheduled task");
});

// ── Part 6: Timeline filter selection survives reload via localStorage ──────
Deno.test("716s.6: timeline filter selection key is documented and wired in ntp.js", async () => {
  const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(
    ntpJs.includes("cap:hub:timeline-filter") || ntpJs.includes("cap:timeline-filter"),
    "ntp.js must reference localStorage key cap:hub:timeline-filter",
  );
  assert(
    ntpJs.includes("timeline-filters"),
    "ntp.js must query and wire #timeline-filters",
  );
});

// ── Part 7: SegmentedControl supports role=toolbar and aria-pressed ─────────
Deno.test("716s.6: SegmentedControl supports role=toolbar with roving tabindex", async () => {
  await import("../extension/shared/components.js");
  const SegmentedControl = globalThis.customElements.get("segmented-control");
  const sc = new SegmentedControl();
  sc.setAttribute("role", "toolbar");
  sc.setAttribute("items", "All,Runs,Waiting,Made,Scheduled");
  sc.setAttribute("value", "Waiting");
  sc._rendered = true;
  sc._render();

  assertEquals(sc._root._tabs.getAttribute("role"), "toolbar");
  const waitingBtn = sc._root._tabs.children.find((c) => c.dataset?.val === "Waiting");
  assert(waitingBtn, "Must have Waiting button");
  assertEquals(waitingBtn.getAttribute("aria-pressed"), "true");
  assertEquals(waitingBtn.getAttribute("aria-selected"), "true");
  assertEquals(waitingBtn.tabIndex, 0);

  const allBtn = sc._root._tabs.children.find((c) => c.dataset?.val === "All");
  assert(allBtn, "Must have All button");
  assertEquals(allBtn.getAttribute("aria-pressed"), "false");
  assertEquals(allBtn.getAttribute("aria-selected"), "false");
  assertEquals(allBtn.tabIndex, -1);
});

// ── Part 8: Waiting filter matches approval-pending, waiting-for-permission, and blocked
Deno.test("716s.6: Waiting filter matches approval-pending, waiting-for-permission, and blocked statuses and kinds", () => {
  // Test statuses
  assertEquals(timelineMatchesFilter({ status: "approval-pending" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ status: "waiting-for-permission" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ status: "blocked" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ status: "paused" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ status: "waiting" }, "Waiting"), true);

  // Test kinds
  assertEquals(timelineMatchesFilter({ kind: "approval-pending" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ kind: "waiting-for-permission" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ kind: "blocked" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ kind: "approval-requested" }, "Waiting"), true);
  assertEquals(timelineMatchesFilter({ kind: "permission" }, "Waiting"), true);

  // Test non-waiting items do not match
  assertEquals(timelineMatchesFilter({ status: "running", kind: "task" }, "Waiting"), false);
  assertEquals(timelineMatchesFilter({ status: "done", kind: "task" }, "Waiting"), false);
});

// ── Part 9: More (N) disclosure visibility in AgentTimeline
Deno.test("716s.6: More (N) disclosure visibility in AgentTimeline is visible when secondary items exist, hidden when 0", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;

  // Zero secondary items: disclosure element has hidden attribute
  timeline.entries = fixtureRows;
  let html = timeline._root.innerHTML;
  assert(
    html.includes('class="tl-more" hidden') || html.includes('class="tl-more"  hidden') || html.includes('<details class="tl-more" hidden>'),
    `Expected tl-more disclosure to be hidden when 0 secondary items, got: ${html}`,
  );

  // With secondary items: disclosure is visible with More (N)
  timeline.entries = [
    ...fixtureRows,
    { id: "h-1", kind: "hook", title: "Tab hook", time: 8000 },
    { id: "p-1", kind: "page", title: "Page view", time: 7000 },
    { id: "s-1", kind: "spent", title: "Spent credits", time: 6000 },
  ];
  html = timeline._root.innerHTML;
  assert(
    !html.includes('<details class="tl-more" hidden>') && !html.includes('class="tl-more" hidden'),
    `Expected tl-more disclosure to not be hidden when secondary items exist, got: ${html}`,
  );
  assert(
    html.includes("More (3)"),
    `Expected More (3) disclosure text, got: ${html}`,
  );

  // Test single secondary item
  timeline.entries = [
    ...fixtureRows,
    { id: "h-1", kind: "hook", title: "Tab hook", time: 8000 },
  ];
  html = timeline._root.innerHTML;
  assert(
    html.includes("More (1)"),
    `Expected More (1) disclosure text, got: ${html}`,
  );
});

// ── Part 10: SegmentedControl button min-block-size: var(--control, 36px)
Deno.test("716s.6: SegmentedControl button min-block-size is var(--control, 36px)", async () => {
  const componentsJs = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  const scBlock = componentsJs.slice(
    componentsJs.indexOf("class SegmentedControl"),
    componentsJs.indexOf("customElements.define(\"segmented-control\"", componentsJs.indexOf("class SegmentedControl")),
  );
  assert(
    scBlock.includes("min-block-size:var(--control, 36px)") || scBlock.includes("min-block-size: var(--control, 36px)"),
    `SegmentedControl must declare min-block-size: var(--control, 36px)`,
  );
  assert(
    !scBlock.includes("min-block-size:30px") && !scBlock.includes("min-block-size: 30px"),
    "SegmentedControl must not use min-block-size: 30px",
  );
});

// ── Part 11: 914l Hub Timeline filter segmented-control unstick active selector ──
Deno.test("914l: segmented-control is NOT in NON_HUB_ELEMENTS", async () => {
  const { NON_HUB_ELEMENTS } = await import("../extension/shared/components.js");
  assert(
    !NON_HUB_ELEMENTS.has("segmented-control"),
    "'segmented-control' must not be in NON_HUB_ELEMENTS because it is used in ntp.html",
  );
});

Deno.test("914l: pre-upgrade own value property does not shadow SegmentedControl.prototype.value and clicking Runs activates Runs", async () => {
  await import("../extension/shared/components.js");
  const SegmentedControl = globalThis.customElements.get("segmented-control");
  const el = new SegmentedControl();
  el.setAttribute("items", "All,Runs,Waiting,Made,Scheduled");

  // Simulate pre-upgrade property-shadowing bug:
  // In unpatched code, ntp.js assigns timelineFilterEl.value = 'All' before upgrade, creating an own property
  Object.defineProperty(el, "value", {
    value: "All",
    writable: true,
    configurable: true,
    enumerable: true,
  });

  el.connectedCallback();

  const tabs = el._root.querySelectorAll('[role="tab"]');
  const allBtn = tabs.find((b) => b.dataset?.val === "All");
  const runsBtn = tabs.find((b) => b.dataset?.val === "Runs");
  assert(allBtn, "All button must exist");
  assert(runsBtn, "Runs button must exist");

  // Initial state should have All selected
  assertEquals(allBtn.getAttribute("aria-selected"), "true");
  assertEquals(runsBtn.getAttribute("aria-selected"), "false");

  // Click "Runs" tab
  runsBtn.click();

  // Own property must not shadow prototype getter/setter
  assertEquals(el.value, "Runs");
  assertEquals(runsBtn.getAttribute("aria-selected"), "true");
  assertEquals(allBtn.getAttribute("aria-selected"), "false");
});

Deno.test("914l: setting overflow filter clears selection, and clicking All re-selects All with change event", async () => {
  await import("../extension/shared/components.js");
  const SegmentedControl = globalThis.customElements.get("segmented-control");
  const el = new SegmentedControl();
  el.setAttribute("items", "All,Runs,Waiting,Made,Scheduled");
  el.connectedCallback();

  // Setting an overflow filter (not in items) should clear active selection on primary buttons
  el.value = "Hooks";

  const tabs = el._root.querySelectorAll('[role="tab"]');
  for (const btn of tabs) {
    assertEquals(
      btn.getAttribute("aria-selected"),
      "false",
      `Expected ${btn.dataset?.val} to have aria-selected='false' when value='Hooks'`,
    );
  }

  // Clicking "All" tab re-selects "All" and fires change event
  let changeFired = false;
  let changedValue = "";
  el.addEventListener("change", (e) => {
    changeFired = true;
    changedValue = e.detail?.value;
  });

  const allBtn = tabs.find((b) => b.dataset?.val === "All");
  assert(allBtn, "All button must exist");
  allBtn.click();

  assertEquals(el.value, "All");
  assertEquals(allBtn.getAttribute("aria-selected"), "true");
  assert(changeFired, "Expected change event to fire when clicking All after overflow filter");
  assertEquals(changedValue, "All");
});

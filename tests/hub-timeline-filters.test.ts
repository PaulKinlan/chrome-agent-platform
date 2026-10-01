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
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  scrollIntoView() {}
  focus() {}
}

class HTMLElementStub {
  constructor() {
    this._attrs = new Map();
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
  dispatchEvent(_e) {
    return true;
  }
  addEventListener() {}
  removeEventListener() {}
}

class ShadowRootStub {
  constructor(host) {
    this.host = host;
    this._innerHTML = "";
    this._tabs = new ElementNodeStub("div");
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(html) {
    this._innerHTML = String(html);
  }
  querySelector(sel) {
    if (sel === ".tabs") return this._tabs;
    return null;
  }
  querySelectorAll(sel) {
    if (sel.includes("button")) return this._tabs.children;
    return [];
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

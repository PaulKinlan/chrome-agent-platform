// @ts-nocheck
// tests/hub-timeline-filters.test.ts — falsification tests for chrome-agent-platform-djft
// Redesign Hub Timeline filters (All, Running, Waiting, Completed, Failed, Made, Scheduled),
// add pagination, search query filtering, topic grouping, and artifacts in timeline.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  TIMELINE_FILTERS,
  filterTimeline,
  timelineMatchesFilter,
  inferTimelineTopic,
  groupTimelineByTopic,
  buildTimeline,
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
    this.disabled = false;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "disabled") this.disabled = true;
  }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k === "disabled") this.disabled = false;
  }
  hasAttribute(k) { return k in this.attributes; }
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
    agent: "tab-master",
    time: 5000,
  },
  {
    id: "t-wait",
    kind: "thread",
    threadId: "t-wait",
    title: "Request permission to open tab",
    status: "paused",
    outcome: "Waiting for you",
    agent: "",
    time: 4000,
  },
  {
    id: "t-done",
    kind: "thread",
    threadId: "t-done",
    title: "Summarise article",
    status: "done",
    outcome: "Finished summary",
    agent: "researcher",
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
    agent: "digest-bot",
    time: 2000,
  },
  {
    id: "t-fail",
    kind: "thread",
    threadId: "t-fail",
    title: "Deploy flappy bird script",
    status: "failed",
    outcome: "Build error in script",
    agent: "coder",
    time: 1500,
  },
  {
    id: "artifact:master:a-1",
    kind: "artifact",
    title: "Made report.html",
    status: "done",
    outcome: "HTML artifact",
    agent: "chart-gen",
    time: 1000,
  },
];

// ── Part 1: TIMELINE_FILTERS constant & pure predicates ────────────────────
Deno.test("djft: TIMELINE_FILTERS exports the 7 redesigned filters", () => {
  assertEquals([...TIMELINE_FILTERS], ["All", "Running", "Waiting", "Completed", "Failed", "Made", "Scheduled"]);
});

Deno.test("djft: selecting Running matches running status", () => {
  const running = filterTimeline(fixtureRows, "Running");
  assertEquals(running.length, 1);
  assertEquals(running[0].id, "t-run");
});

Deno.test("djft: selecting Waiting shows only paused/waiting/blocked runs", () => {
  const waiting = filterTimeline(fixtureRows, "Waiting");
  assertEquals(waiting.length, 1);
  assertEquals(waiting[0].id, "t-wait");
  assertEquals(waiting[0].status, "paused");
});

Deno.test("djft: selecting Completed matches done and completed statuses and excludes artifacts", () => {
  const completed = filterTimeline(fixtureRows, "Completed");
  const ids = completed.map((r) => r.id);
  assert(ids.includes("t-done"));
  assert(ids.includes("run:sched-1"));
  assert(!ids.includes("artifact:master:a-1"));
  assert(!ids.includes("t-run"));
  assert(!ids.includes("t-fail"));
});

Deno.test("djft: selecting Failed matches failed and error statuses", () => {
  const failed = filterTimeline(fixtureRows, "Failed");
  assertEquals(failed.length, 1);
  assertEquals(failed[0].id, "t-fail");
});

Deno.test("djft: selecting Made shows artifact/deliverable rows", () => {
  const made = filterTimeline(fixtureRows, "Made");
  assertEquals(made.length, 1);
  assertEquals(made[0].id, "artifact:master:a-1");
});

Deno.test("djft: selecting Scheduled shows scheduled runs", () => {
  const sched = filterTimeline(fixtureRows, "Scheduled");
  assertEquals(sched.length, 1);
  assertEquals(sched[0].id, "run:sched-1");
});

Deno.test("djft: selecting All returns all rows", () => {
  const all = filterTimeline(fixtureRows, "All");
  assertEquals(all.length, fixtureRows.length);
});

Deno.test("djft: legacy Runs filter remains backwards-compatible", () => {
  const runs = filterTimeline(fixtureRows, "Runs");
  const runIds = runs.map((r) => r.id);
  assert(runIds.includes("t-run"));
  assert(runIds.includes("t-wait"));
  assert(!runIds.includes("run:sched-1"));
  assert(!runIds.includes("artifact:master:a-1"));
});

// ── Part 2: Search query filtering ─────────────────────────────────────────
Deno.test("djft: filterTimeline matches query across title, agent, outcome, or inferred topic", () => {
  // Title match
  const byTitle = filterTimeline(fixtureRows, "All", { query: "flappy" });
  assertEquals(byTitle.length, 1);
  assertEquals(byTitle[0].id, "t-fail");

  // Agent match
  const byAgent = filterTimeline(fixtureRows, "All", { query: "digest-bot" });
  assertEquals(byAgent.length, 1);
  assertEquals(byAgent[0].id, "run:sched-1");

  // Outcome match
  const byOutcome = filterTimeline(fixtureRows, "All", { query: "Waiting for you" });
  assertEquals(byOutcome.length, 1);
  assertEquals(byOutcome[0].id, "t-wait");

  // Topic match ("Research & summaries" matches t-done and run:sched-1)
  const byTopic = filterTimeline(fixtureRows, "All", { query: "Research & summaries" });
  assert(byTopic.some((r) => r.id === "t-done"));

  // Combined filter + search
  const filteredSearch = filterTimeline(fixtureRows, "Completed", { query: "article" });
  assertEquals(filteredSearch.length, 2); // t-done ("Summarise article") and run:sched-1 ("3 articles summarised")
});

// ── Part 3: Topic inference & grouping ─────────────────────────────────────
Deno.test("djft: inferTimelineTopic classifies entries into specified categories", () => {
  assertEquals(inferTimelineTopic({ title: "Group open tabs" }), "Tabs & browsing");
  assertEquals(inferTimelineTopic({ title: "Bookmark this website" }), "Tabs & browsing");
  assertEquals(inferTimelineTopic({ outcome: "Browsing history checked" }), "Tabs & browsing");
  assertEquals(inferTimelineTopic({ title: "Close current window" }), "Tabs & browsing");

  assertEquals(inferTimelineTopic({ title: "Draft tweet about release" }), "Social & content");
  assertEquals(inferTimelineTopic({ outcome: "Post shared to Hacker News" }), "Social & content");
  assertEquals(inferTimelineTopic({ title: "Check Bluesky notifications" }), "Social & content");
  assertEquals(inferTimelineTopic({ title: "Update LinkedIn bio" }), "Social & content");
  assertEquals(inferTimelineTopic({ title: "Weekly content planner" }), "Social & content");

  assertEquals(inferTimelineTopic({ title: "Summarise research findings" }), "Research & summaries");
  assertEquals(inferTimelineTopic({ outcome: "Generated brief report" }), "Research & summaries");
  assertEquals(inferTimelineTopic({ title: "Analyze financial metrics" }), "Research & summaries");
  assertEquals(inferTimelineTopic({ title: "Search web for news" }), "Research & summaries");
  assertEquals(inferTimelineTopic({ title: "Accessibility audit" }), "Research & summaries");

  assertEquals(inferTimelineTopic({ title: "Run python script" }), "Code & development");
  assertEquals(inferTimelineTopic({ title: "Build flappy bird game" }), "Code & development");
  assertEquals(inferTimelineTopic({ outcome: "Git commit for bead repo" }), "Code & development");
  assertEquals(inferTimelineTopic({ title: "Fix bug in background process" }), "Code & development");

  assertEquals(inferTimelineTopic({ title: "Book table at bistro" }), "Bookings & actions");
  assertEquals(inferTimelineTopic({ title: "Make dinner reservation" }), "Bookings & actions");
  assertEquals(inferTimelineTopic({ outcome: "Calendar invite and email sent" }), "Bookings & actions");
  assertEquals(inferTimelineTopic({ title: "Place grocery order" }), "Bookings & actions");

  assertEquals(inferTimelineTopic({ title: "Random unknown activity" }), "General tasks");
});

Deno.test("djft: groupTimelineByTopic clusters entries and orders by latest timestamp", () => {
  const entries = [
    { id: "e-gen", title: "Random task", time: 100 },
    { id: "e-tab-1", title: "Organize tabs", time: 500 },
    { id: "e-tab-2", title: "Close window", time: 900 },
    { id: "e-code", title: "Write python code", time: 1200 },
    { id: "e-social", title: "Post tweet", time: 700 },
  ];

  const groups = groupTimelineByTopic(entries);
  assertEquals(groups.length, 4);

  // e-code (time 1200) has latest timestamp -> Code & development is first
  assertEquals(groups[0].topic, "Code & development");
  assertEquals(groups[0].count, 1);
  assertEquals(groups[0].entries[0].id, "e-code");

  // Tabs & browsing has latest time 900 -> second
  assertEquals(groups[1].topic, "Tabs & browsing");
  assertEquals(groups[1].count, 2);
  assertEquals(groups[1].entries[0].id, "e-tab-2");
  assertEquals(groups[1].entries[1].id, "e-tab-1");

  // Social & content has time 700 -> third
  assertEquals(groups[2].topic, "Social & content");
  assertEquals(groups[2].count, 1);

  // General tasks has time 100 -> fourth
  assertEquals(groups[3].topic, "General tasks");
  assertEquals(groups[3].count, 1);
});

// ── Part 4: Pagination & Grouping in AgentTimeline ─────────────────────────
Deno.test("djft: AgentTimeline pagination renders range, page count, and handles next/prev", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;

  // Generate 25 entries
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `item-${i + 1}`,
    title: `Task item ${i + 1}`,
    status: "done",
    outcome: `Finished ${i + 1}`,
    time: 1000 + i * 10,
  })).reverse();

  timeline.pageSize = 10;
  timeline.entries = many;

  let html = timeline._root.innerHTML;
  assert(html.includes("1–10 of 25"), `Expected '1–10 of 25' in pagination footer, got: ${html}`);
  assert(html.includes("Page 1 of 3"), `Expected 'Page 1 of 3', got: ${html}`);
  assert(html.includes('data-page="prev" disabled'), "Previous button must be disabled on page 1");
  assert(html.includes('data-page="next"'), "Next button must be present");
  assert(!html.includes('data-page="next" disabled'), "Next button must not be disabled on page 1");

  // Advance to page 2
  timeline.page = 2;
  html = timeline._root.innerHTML;
  assert(html.includes("11–20 of 25"), `Expected '11–20 of 25' on page 2, got: ${html}`);
  assert(html.includes("Page 2 of 3"), `Expected 'Page 2 of 3', got: ${html}`);
  assert(!html.includes('data-page="prev" disabled'), "Previous button must be enabled on page 2");
  assert(!html.includes('data-page="next" disabled'), "Next button must be enabled on page 2");

  // Advance to page 3
  timeline.page = 3;
  html = timeline._root.innerHTML;
  assert(html.includes("21–25 of 25"), `Expected '21–25 of 25' on page 3, got: ${html}`);
  assert(html.includes("Page 3 of 3"), `Expected 'Page 3 of 3', got: ${html}`);
  assert(html.includes('data-page="next" disabled'), "Next button must be disabled on page 3");

  // Changing query or filter resets page to 1
  timeline.query = "Task item 1";
  assertEquals(timeline.page, 1, "Setting query must reset page to 1");

  timeline.page = 2;
  timeline.filter = "Running";
  assertEquals(timeline.page, 1, "Changing filter must reset page to 1");
});

Deno.test("djft: AgentTimeline groupBy='topic' renders collapsible details.tl-topic-group sections", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;
  timeline.entries = fixtureRows;
  timeline.groupBy = "topic";

  const html = timeline._root.innerHTML;
  assert(html.includes('<details class="tl-topic-group" open>'), `Expected collapsible topic group details, got: ${html}`);
  assert(html.includes('class="tl-topic-name">Tabs &amp; browsing</span>') || html.includes('class="tl-topic-name">Tabs & browsing</span>'), "Expected Tabs & browsing topic header");
  assert(html.includes('class="tl-topic-count">'), "Expected topic count badge");
});

// ── Part 5: Artifacts integration in buildTimeline ─────────────────────────
Deno.test("djft: buildTimeline with opts.artifacts projects Made <artifact> entries", () => {
  const threads = [{ id: "t-1", name: "Build app", status: "done", updatedAt: 2000 }];
  const runs = [];
  const artifacts = [
    { id: "art-1", title: "app.html", kind: "html", origin: "master", updatedAt: 3000 },
    { key: "chart.png", kind: "image", origin: "https://chart.example.com", createdAt: 4000 },
  ];
  const rows = buildTimeline(threads, runs, { artifacts });
  const madeRows = rows.filter((r) => r.kind === "artifact");
  assertEquals(madeRows.length, 2);
  assertEquals(madeRows[0].title, "Made chart.png");
  assertEquals(madeRows[0].outcome, "IMAGE artifact");
  assertEquals(madeRows[0].agent, "@chart.example.com");
  assertEquals(madeRows[1].title, "Made app.html");
  assertEquals(madeRows[1].outcome, "HTML artifact");

  // Appears under Made filter
  const filteredMade = filterTimeline(rows, "Made");
  assertEquals(filteredMade.length, 2);

  // Does not appear under Completed filter
  const filteredCompleted = filterTimeline(rows, "Completed");
  assertEquals(filteredCompleted.length, 1);
  assertEquals(filteredCompleted[0].id, "t-1");
});

// ── Part 6: Empty states & accessibility ───────────────────────────────────
Deno.test("djft: screen-reader text per row contains the state word once", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;

  timeline.entries = [{
    id: "t-live",
    kind: "thread",
    title: "Active task",
    status: "running",
    outcome: "Running…",
  }];

  const html = timeline._root.innerHTML;
  const buttonHtml = html.slice(html.indexOf('<button type="button" class="tl-row"'));
  const accessibleText = buttonHtml.replace(/<[^>]+>/g, " ");
  const runningMatches = accessibleText.match(/Running/gi) || [];
  assertEquals(runningMatches.length, 1);
});

Deno.test("djft: AgentTimeline displays 'Nothing waiting on you.' when Waiting filter is empty", async () => {
  await import("../extension/shared/components.js");
  const AgentTimeline = globalThis.customElements.get("agent-timeline");
  const timeline = new AgentTimeline();
  timeline._rendered = true;
  timeline.entries = [{
    id: "t-done",
    kind: "thread",
    title: "Completed task",
    status: "done",
    outcome: "Finished",
  }];
  timeline.filter = "Waiting";

  const html = timeline._root.innerHTML;
  assert(html.includes("Nothing waiting on you."));
});

// ── Part 7: ntp.html and ntp.js integration ─────────────────────────────────
Deno.test("djft: ntp.html contains #timeline-filters with 7 redesigned filter chips and search/group controls", async () => {
  const ntpRaw = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  assert(ntpRaw.includes('id="timeline-filters"'), "ntp.html must contain #timeline-filters");
  assert(
    ntpRaw.includes('items="All,Running,Waiting,Completed,Failed,Made,Scheduled"'),
    "timeline-filters must have items='All,Running,Waiting,Completed,Failed,Made,Scheduled'",
  );
  assert(ntpRaw.includes('id="timeline-search"'), "ntp.html must contain #timeline-search input");
  assert(ntpRaw.includes('id="timeline-group-toggle"'), "ntp.html must contain #timeline-group-toggle button");
  assert(!ntpRaw.includes('id="timeline-overflow"'), "ntp.html must not contain dead #timeline-overflow menu");
});

Deno.test("djft: ntp.js wires search, group toggle, normalizes legacy filters, and removes dead overflow", async () => {
  const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(ntpJs.includes("timeline-search"), "ntp.js must reference timeline-search");
  assert(ntpJs.includes("timeline-group-toggle"), "ntp.js must reference timeline-group-toggle");
  assert(ntpJs.includes("cap:hub:timeline-group"), "ntp.js must persist group toggle under cap:hub:timeline-group");
  assert(!ntpJs.includes("updateTimelineSecondaryOverflow"), "ntp.js must remove updateTimelineSecondaryOverflow");
  assert(ntpJs.includes("artifacts.list"), "ntp.js must query artifacts.list in refreshTimeline");
});

// ── Part 8: SegmentedControl toolbar support & regression pins ─────────────
Deno.test("djft: SegmentedControl supports role=toolbar with roving tabindex", async () => {
  await import("../extension/shared/components.js");
  const SegmentedControl = globalThis.customElements.get("segmented-control");
  const sc = new SegmentedControl();
  sc.setAttribute("role", "toolbar");
  sc.setAttribute("items", "All,Running,Waiting,Completed,Failed,Made,Scheduled");
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

Deno.test("djft: SegmentedControl button min-block-size is var(--control, 36px)", async () => {
  const componentsJs = await Deno.readTextFile(new URL("../extension/shared/components-core.js", import.meta.url));
  const scBlock = componentsJs.slice(
    componentsJs.indexOf("class SegmentedControl"),
    componentsJs.indexOf("customElements.define(\"segmented-control\"", componentsJs.indexOf("class SegmentedControl")),
  );
  assert(
    scBlock.includes("min-block-size:var(--control, 36px)") || scBlock.includes("min-block-size: var(--control, 36px)"),
    `SegmentedControl must declare min-block-size: var(--control, 36px)`,
  );
});

Deno.test("djft: segmented-control is NOT in NON_HUB_ELEMENTS", async () => {
  const { NON_HUB_ELEMENTS } = await import("../extension/shared/components.js");
  assert(
    !NON_HUB_ELEMENTS.has("segmented-control"),
    "'segmented-control' must not be in NON_HUB_ELEMENTS because it is used in ntp.html",
  );
});

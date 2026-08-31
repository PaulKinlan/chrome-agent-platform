import { assertEquals } from "jsr:@std/assert";
import { buildTimeline, timelineAgentLabel, timelineStatus } from "../extension/lib/hub-timeline.js";

// CAP-FB-20260828-HUB-AS-TIMELINE-01 — the hub is one reverse-chronological
// timeline of tasks + runs, not three object catalogs.

const threads = [
  { id: "t-old", name: "Summarise the design doc", status: "done", updatedAt: 1_000, createdAt: 900 },
  { id: "t-live", name: "Group my tabs by topic", status: "running", updatedAt: 5_000, createdAt: 4_000 },
  { id: "t-fail", name: "Watch this price", status: "error", updatedAt: 3_000, createdAt: 2_000 },
];

const runs = [
  // The live task's run — its outcome/agent overrides the bare thread status.
  { executionId: "r-live", threadId: "t-live", agentId: "master", kind: "task", phase: "running", updatedAt: 5_200 },
  // A settled run that failed — the terminal outcome, not the phase name, decides.
  { executionId: "r-fail", threadId: "t-fail", agentId: "master", kind: "task", phase: "done", terminal: { ok: false, summary: "provider origin not granted" }, updatedAt: 3_100 },
  // A scheduled run that never opened a task thread — a "came back while away" row.
  { executionId: "r-sched", threadId: null, agentId: "background:digest", kind: "scheduled", scheduleName: "Reading digest", phase: "done", terminal: { ok: true, summary: "3 articles summarised" }, updatedAt: 6_000 },
  // A bare failed dispatch (task, no thread) — belongs to the failed-runs rail, NOT the timeline.
  { executionId: "r-orphan", threadId: null, agentId: "master", kind: "task", phase: "failed", updatedAt: 7_000 },
];

Deno.test("timeline is reverse-chronological across threads and standalone runs", () => {
  const rows = buildTimeline(threads, runs, { agentNames: { "background:digest": "Reading digest" } });
  assertEquals(rows.map((r) => r.id), ["run:r-sched", "t-live", "t-fail", "t-old"]);
});

Deno.test("a bare task run with no thread is not a timeline row", () => {
  const rows = buildTimeline(threads, runs);
  assertEquals(rows.some((r) => r.id === "run:r-orphan"), false);
});

Deno.test("a thread row takes its outcome from the latest run, not the raw status", () => {
  const rows = buildTimeline(threads, runs);
  const fail = rows.find((r) => r.id === "t-fail");
  assertEquals(fail?.status, "failed");
  assertEquals(fail?.outcome, "provider origin not granted");
});

Deno.test("the scheduled run row carries its agent and settled outcome", () => {
  const rows = buildTimeline(threads, runs, { agentNames: { "background:digest": "Reading digest" } });
  const sched = rows.find((r) => r.id === "run:r-sched");
  assertEquals(sched?.agent, "Reading digest");
  assertEquals(sched?.status, "done");
  assertEquals(sched?.outcome, "3 articles summarised");
});

Deno.test("a plain owner task carries no agent chip", () => {
  const rows = buildTimeline(threads, runs);
  assertEquals(rows.find((r) => r.id === "t-live")?.agent, "");
});

Deno.test("the limit bounds the row count, keeping the most recent", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `x-${i}`, name: `Task ${i}`, status: "done", updatedAt: i }));
  const rows = buildTimeline(many, [], { limit: 40 });
  assertEquals(rows.length, 40);
  assertEquals(rows[0].id, "x-59");
});

Deno.test("timelineStatus maps a paused phase and a site agent label", () => {
  assertEquals(timelineStatus(null, { phase: "paused-permission" }), "paused");
  assertEquals(timelineAgentLabel({ agentId: "https://shop.example.com" }, {}), "@shop.example.com");
});

// tests/scheduled-run-report.test.ts — CAP-FB-20260830-SCHEDULED-RUN-OUTPUT-01.
// A scheduled run must leave a retrievable result behind: exactly ONE keyed
// report artifact per agent, written to the agent's own origin store, that
// ROLLS (each fire replaces the last, same id) rather than piling up.
// @ts-nocheck — the OPFS fake is intentionally dynamic (house style, matching
// tests/firstrun-cluster.test.ts).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createOrUpdateAssetKeyed, listAssets } from "../extension/lib/artifacts.js";
import {
  buildScheduledNotification,
  buildScheduledReportBody,
  scheduledNotificationClickAction,
  scheduledReportKey,
  scheduledReportSlug,
  SCHEDULED_NOTIFICATION_ICON,
  writeScheduledRunReport,
} from "../extension/lib/scheduled-run-report.js";

// ---- minimal in-memory OPFS fake (same shape as tests/firstrun-cluster.test.ts) ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, dirNode()); }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, fileNode("")); }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true, writable: true,
});

Deno.test("SCHEDULED-REPORT: a settling scheduled run writes ONE keyed report artifact to the agent store", async () => {
  // A named/background agent has no web origin, so its report rolls in the hub
  // (master) store, keyed per agent slug so agents never collide.
  const res = await writeScheduledRunReport(
    { createOrUpdateAssetKeyed },
    { origin: "master", scheduleName: "agent:tab-reporter", summary: "3 open tabs.", at: 1_700_000_000_000, agentLabel: "Tab Reporter" },
  );
  assert(res.ok === true, `report write must succeed: ${res.error}`);
  assert(res.created === true, "the first fire creates the report");
  const list = await listAssets("master");
  const rows = list.assets.filter((a) => a.pk === scheduledReportKey("tab-reporter"));
  assertEquals(rows.length, 1, "exactly one keyed report artifact after the first fire");
  assertEquals(rows[0].type, "text", "the report is a text artifact");
});

Deno.test("SCHEDULED-REPORT: a site agent's report is written to its OWN web origin, never the master store", async () => {
  // A Site Agent DOES carry a web origin — origin-keyed memory means its
  // report must land there and never leak into the hub store.
  const origin = "https://reports.example.com";
  const res = await writeScheduledRunReport(
    { createOrUpdateAssetKeyed },
    { origin, scheduleName: "agent:site-watcher", summary: "site ok", at: 1_700_000_000_000, agentLabel: "Site Watcher" },
  );
  assert(res.ok === true, `report write must succeed: ${res.error}`);
  const own = await listAssets(origin);
  assertEquals(own.assets.filter((a) => a.pk === scheduledReportKey("site-watcher")).length, 1, "the report lands in the site's own origin");
  const master = await listAssets("master");
  assertEquals(master.assets.filter((a) => a.pk === scheduledReportKey("site-watcher")).length, 0, "nothing leaks into the master store");
});

Deno.test("SCHEDULED-REPORT: a second fire ROLLS the report (same id, no pile-up)", async () => {
  const first = await writeScheduledRunReport(
    { createOrUpdateAssetKeyed },
    { origin: "master", scheduleName: "agent:roller", summary: "run one", at: 1_700_000_000_000, agentLabel: "Roller" },
  );
  assert(first.ok && first.created === true, `first fire must create: ${first.error}`);
  const second = await writeScheduledRunReport(
    { createOrUpdateAssetKeyed },
    { origin: "master", scheduleName: "agent:roller", summary: "run two", at: 1_700_000_060_000, agentLabel: "Roller" },
  );
  assert(second.ok === true, `second fire must succeed: ${second.error}`);
  assert(second.updated === true, "the second fire updates in place, it does not create a new artifact");
  assertEquals(second.id, first.id, "the report rolls onto the SAME asset id");
  const list = await listAssets("master");
  const rows = list.assets.filter((a) => a.pk === scheduledReportKey("roller"));
  assertEquals(rows.length, 1, "still exactly one report artifact after two fires — no pile-up");
});

Deno.test("SCHEDULED-REPORT: the slug is recovered from the schedule/alarm name and falls back to the task id", () => {
  assertEquals(scheduledReportSlug("agent:tab-reporter"), "tab-reporter");
  assertEquals(scheduledReportSlug("recipe:abc123"), "abc123");
  assertEquals(scheduledReportSlug("background:daily"), "daily");
  assertEquals(scheduledReportSlug("named:x"), "x");
  assertEquals(scheduledReportSlug("", "fallback-task"), "fallback-task");
  assertEquals(scheduledReportSlug(null, ""), "run");
  assertEquals(scheduledReportKey("tab-reporter"), "scheduled-report:tab-reporter");
});

Deno.test("SCHEDULED-NOTIFY: the click routes a named/background run to its AGENT surface, an owner task to the default thread", () => {
  // The named-agent falsification target: the run has no task thread, so the
  // click MUST navigate to the agent surface (a `thread:` target opens nothing).
  const named = scheduledNotificationClickAction("named:tab-reporter");
  assertEquals(named.type, "navigate", "a named-agent run's notification navigates");
  assert(named.path.includes("#agent=named:tab-reporter"), "…to the named agent surface");
  const bg = scheduledNotificationClickAction("background:daily-brief");
  assertEquals(bg.type, "navigate");
  assert(bg.path.includes("#agent=background:daily-brief"), "a background run navigates to its agent surface");
  // A plain owner task (no agent surface) keeps the default thread-open.
  assertEquals(scheduledNotificationClickAction(null).type, "default");
  assertEquals(scheduledNotificationClickAction("").type, "default");
  assertEquals(scheduledNotificationClickAction("hub").type, "default");
});

Deno.test("SCHEDULED-NOTIFY: the notification spec uses the shipped icon, a bounded message and a stable id", () => {
  const spec = buildScheduledNotification({
    taskId: "agent:tab-reporter",
    executionId: "exec:1",
    agentSurfaceRef: "named:tab-reporter",
    summary: "x".repeat(500),
  });
  assertEquals(spec.notificationId, "cap:task:agent:tab-reporter", "the id is stable per task");
  assertEquals(spec.iconPath, SCHEDULED_NOTIFICATION_ICON, "the shipped icon path");
  assertEquals(SCHEDULED_NOTIFICATION_ICON, "icons/icon128.png", "NOTIFY-ICON-PATH-01: the file that actually ships");
  assert(spec.message.length <= 160, "the message is bounded");
  assertEquals(spec.action.type, "navigate", "a named run's notification opens the agent");
  assert(spec.action.path.includes("#agent=named:tab-reporter"));
  assertEquals(spec.title, "Scheduled task complete");
});

Deno.test("SCHEDULED-REPORT: the report body carries the ISO time, the agent label and the bounded summary", () => {
  const body = buildScheduledReportBody({ summary: "hello", at: 1_700_000_000_000, agentLabel: "Tab Reporter" });
  assert(body.includes("Tab Reporter"), "the body names the agent");
  assert(body.includes("2023-11-14T"), "the body carries the ISO timestamp");
  assert(body.includes("hello"), "the body carries the run summary");
  const huge = buildScheduledReportBody({ summary: "x".repeat(9000), at: Date.now() });
  assert(huge.length < 5000, "the body is bounded even for a runaway result");
  const empty = buildScheduledReportBody({ summary: "", at: Date.now() });
  assert(empty.includes("no text output"), "an empty result still produces a readable report");
});

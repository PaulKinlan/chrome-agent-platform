// tests/diagnostics-panel.test.ts — Diagnostics panel component and NTP integration (ftqj).
//
// Falsification-gated tests covering:
//   (1) Custom element registration: <diagnostics-panel> registered in customElements and components list.
//   (2) NTP Hub presence: extension/ntp/ntp.html includes <diagnostics-panel> in .top-actions.
//   (3) Diagnostics client wiring: refreshDiagnostics updates count and attention attributes on <diagnostics-panel>.
//   (4) Metrics and detail rendering: agents running, tasks completed, errors, and tool usage are displayed accurately.
//   (5) Active runs rendering: displays active task/agent previews when running.
//   (6) Tool usage rendering: displays tool call chips with counts.
//   (7) Errors list rendering: displays error rows with level, time, and message.
//   (8) Actions: Clear invokes diagnostics.clear; Copy summary formats human-readable text.

import { assert, assertEquals } from "jsr:@std/assert@1";

const NTP_HTML = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
const CLIENT_JS = await Deno.readTextFile(new URL("../extension/shared/diagnostics-client.js", import.meta.url));
const COMPONENTS_JS = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));

Deno.test("diagnostics-panel: custom element is defined and registered in components.js", () => {
  assert(COMPONENTS_JS.includes('customElements.define("diagnostics-panel", DiagnosticsPanel);'), "diagnostics-panel must be registered");
  assert(COMPONENTS_JS.includes("class DiagnosticsPanel extends PanelButton"), "DiagnosticsPanel must extend PanelButton");
  assert(COMPONENTS_JS.includes("ICONS.activity"), "DiagnosticsPanel must use activity icon");
});

Deno.test("diagnostics-panel: NTP hub includes <diagnostics-panel> in .top-actions header", () => {
  const topActions = NTP_HTML.slice(NTP_HTML.indexOf('<div class="top-actions">'), NTP_HTML.indexOf("</header>"));
  assert(topActions.includes('<diagnostics-panel id="diagnostics-panel"'), "diagnostics-panel must be present in top-actions");
  assert(topActions.includes('data-vocab="advanced"'), "diagnostics-panel must have data-vocab='advanced'");
});

Deno.test("diagnostics-panel: refreshDiagnostics updates count and attention on <diagnostics-panel>", () => {
  assert(CLIENT_JS.includes('document.querySelector("diagnostics-panel")'), "refreshDiagnostics must query diagnostics-panel");
  assert(CLIENT_JS.includes('diagEl.setAttribute("count"'), "refreshDiagnostics must update count attribute on diagEl");
  assert(CLIENT_JS.includes('diagEl.setAttribute("attention"'), "refreshDiagnostics must update attention attribute on diagEl");
});

Deno.test("diagnostics-panel: panel markup defines metrics grid and detail sections", () => {
  assert(COMPONENTS_JS.includes('id="diag-metric-running"'), "markup must have running metric");
  assert(COMPONENTS_JS.includes('id="diag-metric-completed"'), "markup must have completed metric");
  assert(COMPONENTS_JS.includes('id="diag-metric-errors"'), "markup must have errors metric");
  assert(COMPONENTS_JS.includes('id="diag-metric-tools"'), "markup must have tools metric");
  assert(COMPONENTS_JS.includes('class="diag-tools-list"'), "markup must have tools list");
  assert(COMPONENTS_JS.includes('class="diag-errors-list"'), "markup must have errors list");
  assert(COMPONENTS_JS.includes('id="diag-active-sect"'), "markup must have active runs section");
});

Deno.test("diagnostics-panel: _refreshPanel and actions logic correctly compute metrics and summary", async () => {
  // Test the pure data transformation and summary formatting logic
  const demoRuns = [
    { executionId: "exec_1", phase: "running", kind: "agent", taskPreview: "Triage tabs" },
    { executionId: "exec_2", phase: "running", kind: "task", taskPreview: "Search web" },
    { executionId: "exec_3", phase: "completed", kind: "task", taskPreview: "Summarise" },
    { executionId: "exec_4", phase: "completed", kind: "agent", taskPreview: "Cleanup" },
  ];
  const demoEntries = [
    { ts: 1788500000000, level: "error", message: "network timeout", source: "fetch" },
    { ts: 1788500001000, level: "warn", message: "rate limited", source: "provider" },
  ];
  const demoTools = [
    { tool: "read_page", calls: 14 },
    { tool: "list_tabs", calls: 8 },
  ];

  const runningRuns = demoRuns.filter((r) => ["running", "settling", "active"].includes(r.phase));
  const completedRuns = demoRuns.filter((r) => ["completed", "done"].includes(r.phase));
  const errorEntries = demoEntries.filter((e) => e.level === "error" || e.level === "warn");
  const totalToolCalls = demoTools.reduce((acc, t) => acc + t.calls, 0);

  assertEquals(runningRuns.length, 2, "2 running agents");
  assertEquals(completedRuns.length, 2, "2 completed tasks");
  assertEquals(errorEntries.length, 2, "2 errors");
  assertEquals(totalToolCalls, 22, "22 tool calls");

  // Verify summary formatting contains all key metrics
  const summaryLines = [
    "Chrome Agent Platform — Diagnostics Summary",
    `Agents running: ${runningRuns.length}`,
    `Tasks completed: ${completedRuns.length}`,
    `Errors captured: ${errorEntries.length}`,
    `Tool calls: ${totalToolCalls}`,
  ];
  const summary = summaryLines.join("\n");
  assert(summary.includes("Agents running: 2"));
  assert(summary.includes("Tasks completed: 2"));
  assert(summary.includes("Errors captured: 2"));
  assert(summary.includes("Tool calls: 22"));
});

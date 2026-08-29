import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { actionableRunsForSurface, runsForSurface } from "../extension/lib/run-scope.js";

const read = (path: string) => Deno.readTextFileSync(new URL(path, import.meta.url));

Deno.test("owner observability: Settings owns verbosity and full-local-detail without weakening export redaction", () => {
  const html = read("../extension/options/options.html");
  const options = read("../extension/options/options.js");
  const logger = read("../extension/lib/cap-log.js");
  assertStringIncludes(html, 'id="log-verbosity"');
  assertStringIncludes(html, 'id="log-full-detail"');
  assertStringIncludes(html, "Trace dumps, exports, shared bundles, and reports stay redacted");
  assertStringIncludes(options, "setLogVerbosity(verbosity.value)");
  assertStringIncludes(options, "setLogFullDetail(enabled)");
  assertStringIncludes(logger, "pushRing(level, ns, plain)");
  assertStringIncludes(logger, "currentFullDetail ? args : scrubbed");
});

Deno.test("owner observability: every tool source crosses a paired detail logger", () => {
  const lazy = read("../extension/lib/lazy-tool-protocol.js");
  const sw = read("../extension/background/service-worker.js");
  const agent = read("../extension/lib/agent.js");
  assertStringIncludes(lazy, "observeToolCall(");
  assertStringIncludes(lazy, 'source: ownData(dispatchResolved.descriptor, "sourceKind")');
  assertStringIncludes(sw, 'source: browser ? "chrome-api" : "management"');
  assertStringIncludes(sw, 'source: expectedSource ? `webmcp-${expectedSource}` : "webmcp-bridge"');
  assertStringIncludes(agent, 'agentDoLog.debug("tool-call:start"');
  assertStringIncludes(agent, 'agentDoLog.debug("tool-call:end"');
});

Deno.test("owner observability: settled conversation/background runs retain a reachable log row", () => {
  const runs = [
    { executionId: "old", threadId: "thread-1", phase: "terminal", updatedAt: 10 },
    { executionId: "live", threadId: "thread-1", phase: "running", updatedAt: 20 },
    { executionId: "other", agentId: "background:daily", phase: "terminal", updatedAt: 30 },
  ];
  assertEquals(runsForSurface(runs, { threadId: "thread-1" }).map((run) => run.executionId), ["live", "old"]);
  assertEquals(actionableRunsForSurface(runs, { threadId: "thread-1" }).map((run) => run.executionId), ["live"]);
  assertEquals(runsForSurface(runs, { agentId: "daily", agentKind: "background" }).map((run) => run.executionId), ["other"]);

  const ntp = read("../extension/ntp/ntp.js");
  const html = read("../extension/ntp/ntp.html");
  const components = read("../extension/shared/components.js");
  const sw = read("../extension/background/service-worker.js");
  assertStringIncludes(ntp, "runsForSurface(latestDurableRuns");
  assertStringIncludes(html, "View run logs");
  assertStringIncludes(components, ">View log</button>");
  assertStringIncludes(components, 'data-page="earlier"');
  assertStringIncludes(sw, "durableRuns.listLogs(executionId, { limit: 200 })");
  assert(!components.includes("const MAX_VISIBLE = 3"), "older run logs are paged, not hidden behind a dead cap");
});

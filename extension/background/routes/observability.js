// extension/background/routes/observability.js — the owner's "what is it doing" surface, moved out of the
// service worker (chrome-agent-platform-atxc6 slice 5).
//
// Four routes, and the rare slice with ZERO injections: everything they touch is already a library import
// (lib/cap-log.js for the redacted ring buffer and verbosity, lib/cap-perf.js for the perf breakdown). The one
// piece of worker-scope state was `const pageMeasuresBuffer = []` — a 500-entry ring whose only users were
// these handlers — so it moved HERE with them. Injecting the array would have worked by identity and been
// exactly the shared-mutable-state-across-a-seam smell this whole split exists to remove.
//
// The trace-dump recipe in the banner below is how Paul reads a live install from an extension page console;
// it travels with the routes so the documentation stays next to the code that answers it.
import { capLog, dumpLogBuffer, clearLogBuffer, getLogVerbosity, setLogVerbosity } from "../../lib/cap-log.js";
import { mergePerfMeasures, perfClear, perfSummary } from "../../lib/cap-perf.js";

const swLog = capLog("sw");
// Bounded so a page that reports thousands of measures cannot grow the worker's heap: 500 entries, oldest
// dropped first.
const pageMeasuresBuffer = [];

/**
 * @returns {Readonly<Record<string, Function>>} frozen route map
 */
export function createObservabilityRoutes() {
  return Object.freeze({
// ---- observability trace dump (CAP-FB-20260826-OBSERVABILITY-01) ----
// The owner's "what is it doing" surface: recent log lines (ring buffer,
// redacted at write time) + the performance breakdown (cap:* measures).
// From any extension page console:
//   chrome.runtime.sendMessage({type:"observability.dumpTrace"}, console.log)
async "observability.page-measures"({ measures, page = "page" }, routeContext) {
  if (routeContext?.principal !== "extension" && routeContext?.principal !== "owner-options") {
    return { ok: false, error: "extension-only route" };
  }
  if (Array.isArray(measures)) {
    for (const m of measures.slice(0, 100)) {
      if (m && typeof m.name === "string") {
        pageMeasuresBuffer.push(m);
      }
    }
    while (pageMeasuresBuffer.length > 500) pageMeasuresBuffer.shift();
  }
  return { ok: true, accepted: Array.isArray(measures) ? measures.length : 0 };
},
async "observability.dumpTrace"() {
  const logs = dumpLogBuffer();
  const perf = mergePerfMeasures(perfSummary(), pageMeasuresBuffer);
  swLog.info("trace dump", { logEntries: logs.entries.length, dropped: logs.dropped, stages: perf.measures.length });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    verbosity: getLogVerbosity(),
    logs,
    perf,
  };
},
async "observability.clearTrace"() {
  clearLogBuffer();
  perfClear();
  pageMeasuresBuffer.length = 0;
  swLog.info("trace cleared");
  return { ok: true };
},

async "observability.setVerbosity"({ level } = {}) {
  try {
    await setLogVerbosity(level);
    swLog.info("verbosity set", { level: getLogVerbosity() });
    return { ok: true, level: getLogVerbosity() };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
},
  });
}

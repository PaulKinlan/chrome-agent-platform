// The h638 open trace must time a NEW in-flight execution of the clicked task.
// A queued/steered send can leave only the prior terminal row; timing that
// open would measure settled-log reads rather than the live-log skip.
import { actionableRunsForSurface, runsForSurface } from "../../extension/lib/run-scope.js";

type Row = { executionId?: string; phase?: string; threadId?: string; updatedAt?: number };
type Selection = { ok: true; executionId: string; phase: "running" } |
  { ok: false; reason: "missing_thread" | "send_absorbed" | "settled_before_click" | "different_live_run"; executionId?: string; phase?: string };

// provider.set succeeds with a REDACTED CONFIG (no `ok` property), whereas
// refusal replies are {ok:false,error}. kv.set uses a different reply shape.
export function isDemoProviderConfigured(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const reply = value as Record<string, unknown>;
  return reply.provider === "demo" && reply.ok !== false && !Object.hasOwn(reply, "error") &&
    reply.apiKey === "" && reply.hasApiKey === false;
}

export function requireTraceMeasures(dump: unknown): Array<{ name?: string; count?: number; totalMs?: number }> {
  if (!dump || typeof dump !== "object" || (dump as any).ok !== true ||
      !Array.isArray((dump as any).perf?.measures)) {
    // A failed trace fetch must never become an empty delta and a vacuous
    // "no live-log reads" pass. Do not log the trace's private buffer.
    throw new Error("observability.dumpTrace failed or returned no perf.measures array");
  }
  return (dump as any).perf.measures;
}

type RawSpan = { name?: string; count?: number };

// An empty but well-formed trace is not proof that the live path skipped its
// own log: it may simply contain no measurements (e.g. after a SW restart).
export function requireRunningOpenTrace(measure: { rawSpans?: RawSpan[]; liveLogReads?: number | null }, executionId: string): void {
  if (!Array.isArray(measure?.rawSpans) ||
    !measure.rawSpans.some((span) => span.name === "thread-view:project" && (span.count ?? 0) > 0)) {
    throw new Error("REFUSING live-open: no running thread-view:project span in the measured delta");
  }
  if (measure.liveLogReads !== 0) {
    throw new Error(`REFUSING live-open: view read live execution ${executionId}'s own log`);
  }
}

export function requireSettledOpenTrace(measure: { rawSpans?: RawSpan[] }, executionId: string): void {
  if (!Array.isArray(measure?.rawSpans) ||
    !measure.rawSpans.some((span) => span.name === `thread-view:logs:${executionId}` && (span.count ?? 0) > 0)) {
    throw new Error(`REFUSING settled-open: missing positive log-read span for ${executionId}`);
  }
}

export function requirePriorOpenReads(probe: { reads?: unknown } | null, executionId: string): void {
  if (!Array.isArray(probe?.reads) || probe.reads.length === 0 || probe.reads.includes(executionId)) {
    throw new Error("REFUSING live-open: viewProbe must read prior logs but not the running execution's log");
  }
}

export function selectLiveOpenExecution({ threadId, runs, priorIds }: {
  threadId: string; runs: Row[]; priorIds: string[];
}): Selection {
  if (!threadId) return { ok: false, reason: "missing_thread" };
  const surface = { threadId };
  const prior = new Set(priorIds);
  const fresh = runsForSurface(runs, surface).filter((r: Row) => r.executionId && !prior.has(r.executionId));
  if (!fresh.length) return { ok: false, reason: "send_absorbed" };
  // The page binds the newest ACTIONABLE run by updatedAt; a newer terminal
  // record by startedAt is not proof that the open used its settled logs.
  const candidate = actionableRunsForSurface(fresh, surface)[0] ?? fresh[0];
  if (candidate.phase !== "running") return { ok: false, reason: "settled_before_click", executionId: candidate.executionId, phase: candidate.phase };
  const bound = actionableRunsForSurface(runs, surface)[0];
  if (bound?.executionId !== candidate.executionId) {
    return { ok: false, reason: "different_live_run", executionId: candidate.executionId, phase: candidate.phase };
  }
  return { ok: true, executionId: candidate.executionId!, phase: "running" };
}

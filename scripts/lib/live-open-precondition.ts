// The h638 open trace must time a NEW in-flight execution of the clicked task.
// A queued/steered send can leave only the prior terminal row; timing that
// open would measure settled-log reads rather than the live-log skip.
import { actionableRunsForSurface, runsForSurface } from "../../extension/lib/run-scope.js";

type Row = { executionId?: string; phase?: string; threadId?: string; updatedAt?: number };
type Selection = { ok: true; executionId: string; phase: "running" } |
  { ok: false; reason: "missing_thread" | "send_absorbed" | "settled_before_click" | "different_live_run"; executionId?: string; phase?: string };

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

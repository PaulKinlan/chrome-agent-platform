// scripts/lib/reap-leader.ts — chrome-agent-platform-jjsz (security review N1 + N2).
//
// `reapLeaderAndSettle` kills a launched leader (Chrome), reaps it, and then WAITS for the
// lifeline's leader-exit sweep to finish before the caller goes on.
//
// WHY. Since the lifeline fires a one-shot sweep when its leader exits
// (`attachProcessLifeline` in scripts/lib/process-tree.ts), the leader's death starts a watcher
// shell that stays alive for at least ~110 ms:
//     kill -TERM -$group; sleep 0.1; kill -KILL -$group; pkill -9 -f '<profile>( |$)'
// A runner that does `proc.kill(...); await proc.status` and then exits, or goes on, does not wait
// for it. Two things follow:
//   1. The supervisor's residue judgement. scripts/security-suite-supervisor.mjs samples the
//      runner's descendants every 20 ms, takes one more sample after the runner exits, and then
//      calls `liveObservedResidue` (scripts/security-suite-custody.mjs) on what it saw: any observed
//      pid that is still alive (same start time, not a zombie) is RESIDUE, and the run exits 70
//      ("descendant-residue"). The still-running watcher is such a pid, so a green `npm run
//      test:security` could fail on a shell that was about to exit by itself. origin/main has a
//      lifeline too, but it is DISARMED the moment its leader exits (`proc.status.then(disarm,
//      disarm)`): it never sweeps, so nothing lingers. The leader-exit sweep is new with the jjsz
//      work, and so is this regression.
//   2. A same-profile relaunch. The acceptance journeys kill the browser they materialised the
//      profile with and then open a SECOND browser on the SAME profile (scripts/security-injection.ts
//      does it too, with no pause: its `boot()` runs twice). A sweep still running when
//      that browser starts ends with `pkill -9 -f 'user-data-dir=<profile>( |$)'`, which matches the
//      second browser's command line and kills it.
//
// THE RULE: a runner that kills its leader and then exits or relaunches MUST go through this
// function, or through `teardownChrome` in scripts/lib/chrome-launch.ts, which owns the cleanup AND
// the profile. Do not use `teardownChrome` where the profile belongs to someone else:
// scripts/security-suite.ts runs on a profile the supervisor issued, and `teardownChrome` deletes it
// before the supervisor's `cleanupExactProfile` has inspected it. "Relaunches" means a second
// launch on the same profile, not a second `launchChrome(` call site: scripts/security-injection.ts
// has one call site that runs twice. Four runners follow the rule today (scripts/security-suite.ts,
// scripts/page-actions-journey.ts, scripts/keyless-first-result.ts, scripts/security-injection.ts),
// each pinned per site in tests/jjsz-lifeline-runner-exit.test.ts; a fifth would not be caught by
// anything until bead chrome-agent-platform-80yqb makes `launchChrome` wait for an in-flight sweep.
//
// The wait is bounded. The sweep gives up on its own watcher after `sweepTimeoutMs` (5 s by
// default), SIGKILLs it and settles; `settled` never rejects.
//
// `lifelineState(proc).settled` is the promise of the transition out of `armed` (a sweep, or a
// disarm that finished earlier and is already resolved). It is null when none began: a
// `killProcessTree` owns the cleanup, the watcher never started, or no lifeline was attached, and
// then there is nothing to wait for. When a sweep is due, it is already in flight when `proc.status`
// resolves for the caller, because the lifeline registered its own `proc.status` reaction when it
// was attached, ahead of this one.
import { lifelineState } from "./process-tree.ts";

/**
 * Signal `proc` (default SIGKILL; the journeys pass SIGTERM so Chrome can flush its profile), wait
 * for it to exit, then wait for its lifeline's leader-exit sweep to finish. Never rejects: a leader
 * that is already dead, or a `status` that rejects, is fine.
 */
export async function reapLeaderAndSettle(
  proc: Deno.ChildProcess,
  signal: Deno.Signal = "SIGKILL",
): Promise<void> {
  try { proc.kill(signal); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await lifelineState(proc)?.settled;
}

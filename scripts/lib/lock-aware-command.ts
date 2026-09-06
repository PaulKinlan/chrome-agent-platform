// lock-aware-command.ts — run a child whose time budget starts when IT starts,
// not when it is queued behind the machine's browser gate.
// CAP-FB-20260830-SUITE-HONESTY-01; generalized by chrome-agent-platform-uzik.
//
// `tests/security-suite-custody.test.ts` wrapped the supervisor in
// `/usr/bin/timeout 20`. The supervisor's first act is `flock -x` on the
// canonical lock, so whenever another lane holds that lock (a journey run,
// a KAT, the security suite itself) the 20 s were spent QUEUEING and the test
// reported "supervisor emitted no result marker" — a load-dependent red for
// a supervisor that never got to run. Different subsets failed on each run.
//
// This helper watches the child's own output for a marker printed the moment
// the child is through the gate, and only then starts the budget. Two gates
// emit one: the security supervisor prints CAP_SECURITY_LOCK_ACQUIRED when it
// holds the exclusive canonical lock, and `launchChrome()` prints
// CAP_CHROME_GATE_ACQUIRED when it has a concurrency slot
// (scripts/lib/chrome-slots.ts, opt in with CAP_CHROME_SLOT_MARKER=1). The
// gate wait is bounded separately (a lane that never gets a browser is a real
// finding, reported as such), and a child that hangs AFTER the gate still
// fails after `budgetMs` of its OWN time: nothing here can turn a real failure
// green — it only stops queueing from masquerading as one.

export interface LockAwareResult {
  code: number;
  text: string;
  /** How long the child waited before the lock marker (0 when no marker is expected). */
  lockWaitMs: number;
  /** How long the child ran after the budget clock started. */
  ranMs: number;
  /** Why the child was killed, if it was. */
  killedFor: null | "lock-wait-exceeded" | "budget-exceeded";
}

export async function runLockAware(opts: {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  /** The child's own budget, counted from the lock marker (or from spawn when no marker is expected). */
  budgetMs: number;
  /** How long the child may queue for the lock before that is reported as its own finding. */
  lockWaitMs?: number;
  /** The stdout line prefix that means "I hold the lock now". Omit for a child that takes no lock. */
  lockMarker?: string;
  pollMs?: number;
}): Promise<LockAwareResult> {
  // The child runs in its OWN process group (setsid) so a kill reaches the
  // whole tree: a `flock … deno run …` wrapper killed on its own leaves the
  // harness alive, still holding the inherited lock fd, and the drain below
  // never ends (observed with a hanging KAT on 2026-09-02).
  const proc = new Deno.Command("setsid", {
    args: [opts.executable, ...opts.args],
    env: opts.env ? { ...Deno.env.toObject(), ...opts.env } : undefined,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const killGroup = async (signal: "TERM" | "KILL") => {
    try {
      await new Deno.Command("kill", { args: [`-${signal}`, "--", `-${proc.pid}`], stdout: "null", stderr: "null" }).output();
    } catch { /* gone */ }
    try { proc.kill(signal === "TERM" ? "SIGTERM" : "SIGKILL"); } catch { /* gone */ }
  };
  const decoder = new TextDecoder();
  let text = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  let exited = false;
  const status = proc.status.then((s) => { exited = true; return s; });

  const spawnedAt = Date.now();
  let budgetStartedAt = opts.lockMarker ? 0 : spawnedAt;
  let killedFor: LockAwareResult["killedFor"] = null;
  const poll = opts.pollMs ?? 50;
  const lockWait = opts.lockWaitMs ?? 600_000;

  while (!exited) {
    const now = Date.now();
    if (!budgetStartedAt && opts.lockMarker) {
      const idx = text.indexOf(opts.lockMarker);
      if (idx >= 0) budgetStartedAt = now;
      else if (now - spawnedAt > lockWait) { killedFor = "lock-wait-exceeded"; break; }
    }
    if (budgetStartedAt && now - budgetStartedAt > opts.budgetMs) { killedFor = "budget-exceeded"; break; }
    await new Promise((r) => setTimeout(r, poll));
  }
  if (killedFor) {
    await killGroup("TERM");
    const grace = new Promise((r) => setTimeout(r, 2000));
    await Promise.race([status, grace]);
    if (!exited) await killGroup("KILL");
  }
  const s = await status;
  // A killed group may leave a grandchild holding the pipes for a moment;
  // never wait on the drain forever.
  await Promise.race([drained, new Promise((r) => setTimeout(r, 5000))]);
  const endedAt = Date.now();
  const lockWaitMsActual = opts.lockMarker ? ((budgetStartedAt || endedAt) - spawnedAt) : 0;
  const ranMs = budgetStartedAt ? endedAt - budgetStartedAt : 0;
  if (killedFor === "lock-wait-exceeded") {
    text += `\n[lock-aware] killed: waited ${lockWaitMsActual} ms for the browser gate (another lane held every slot) — the child never ran\n`;
  } else if (killedFor === "budget-exceeded") {
    text += `\n[lock-aware] killed: exceeded its own ${opts.budgetMs} ms budget after the browser gate (queue wait ${lockWaitMsActual} ms excluded)\n`;
  }
  return { code: s.code, text, lockWaitMs: lockWaitMsActual, ranMs, killedFor };
}

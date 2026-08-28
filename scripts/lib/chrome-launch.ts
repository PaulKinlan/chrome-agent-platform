// chrome-launch.ts — the ONE way a harness in scripts/ starts a browser.
// CAP-FB-20260829-FIXED-DEBUG-PORTS-01
//
// Why this exists: a harness that hard-codes its debugging port (9351, say)
// does NOT get a guarantee that it is talking to the browser it just started.
// Chrome refuses to bind a port that is already taken and carries on running
// WITHOUT a debugging endpoint, so the harness's `fetch(127.0.0.1:9351)` then
// answers from whatever else is on that port — a zombie from a killed run, or
// a second lane's Chrome with a DIFFERENT extension loaded. The harness drives
// somebody else's browser and prints a confident PASS/FAIL about a tree it
// never loaded. Green against the wrong tree is worse than red: it reads as
// evidence.
//
// The fix is to never name a port. `--remote-debugging-port=0` makes the
// kernel hand Chrome a free port, and Chrome prints the resulting endpoint on
// stderr as `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/...`.
// That URL comes from THIS process, so there is no probe, no race, and no way
// to attach to a stranger. Two lanes can run concurrently by construction.
//
//   import { launchChrome } from "./lib/chrome-launch.ts";
//   const { proc, wsUrl } = await launchChrome({ binary: CHROMIUM, args: [...] });
//
// `freePort()` is the fallback for the rare harness that cannot read its own
// stderr; it is strictly weaker (probe-then-bind still races) and should not
// be reached for by default.

export interface LaunchedChrome {
  /** The spawned Chrome. The caller owns killing it. */
  proc: Deno.ChildProcess;
  /** The browser-level DevTools WebSocket URL, read from this process's stderr. */
  wsUrl: string;
  /** The port the kernel actually assigned. */
  port: number;
  /** The last few KB of Chrome's stderr — for honest failure messages. */
  stderrTail(): string;
}

const TAIL_LIMIT = 8192;

/**
 * Spawn Chrome with a kernel-assigned debugging port and return its real
 * DevTools endpoint. `args` must NOT contain `--remote-debugging-port`; a
 * fixed port is the defect this module exists to remove, so passing one is a
 * hard error rather than a silent override.
 */
export async function launchChrome(opts: {
  binary: string;
  args: string[];
  timeoutMs?: number;
  stdout?: "null" | "inherit";
}): Promise<LaunchedChrome> {
  const fixed = opts.args.find((a) => a.startsWith("--remote-debugging-port"));
  if (fixed) {
    throw new Error(
      `launchChrome: refusing a caller-chosen debugging port (${fixed}). ` +
        "The port is assigned by the kernel and read back from Chrome's own stderr.",
    );
  }

  const proc = new Deno.Command(opts.binary, {
    args: [...opts.args, "--remote-debugging-port=0"],
    stdout: opts.stdout ?? "null",
    stderr: "piped",
  }).spawn();

  let tail = "";
  const append = (chunk: string) => {
    tail = (tail + chunk).slice(-TAIL_LIMIT);
  };

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + (opts.timeoutMs ?? 20000);
  let seen = "";
  let wsUrl = "";
  while (!wsUrl && Date.now() < deadline) {
    let value: Uint8Array | undefined, done = false;
    try {
      ({ value, done } = await withTimeout(reader.read(), deadline - Date.now()));
    } catch {
      break; // read deadline — fall through to the honest error below
    }
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    append(text);
    seen += text;
    const m = seen.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) wsUrl = m[1];
  }

  if (!wsUrl) {
    try { reader.releaseLock(); } catch { /* already released */ }
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    try { await proc.status; } catch { /* already reaped */ }
    throw new Error(
      `launchChrome: Chrome never printed a DevTools endpoint (${opts.binary}). stderr tail: ${tail.slice(-600)}`,
    );
  }

  // Keep draining stderr in the background. An undrained pipe eventually fills
  // and blocks Chrome mid-run, which reads as a mysterious harness hang.
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
    } catch { /* the process went away; nothing to drain */ }
  })();

  return { proc, wsUrl, port: Number(new URL(wsUrl).port), stderrTail: () => tail };
}

export type CdpSend = (method: string, params?: any, sessionId?: string) => Promise<any>;

/**
 * Wait for the loaded extension's service-worker target to appear.
 *
 * Harnesses used to call `Target.getTargets` once, immediately after the CDP
 * handshake, and it worked only because polling a fixed port for
 * `/json/version` burned enough wall-clock for MV3 to register the worker.
 * Reading the endpoint off stderr removes that accidental delay, so the wait
 * has to be explicit — otherwise the harness reports "no service worker
 * target" for a browser that was merely still starting.
 *
 * Returns the target info, or null if it never registered within the deadline.
 */
export async function waitForServiceWorker(
  send: CdpSend,
  opts: { timeoutMs?: number; match?: (t: any) => boolean } = {},
): Promise<any | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15000);
  const match = opts.match ?? ((t: any) => t.type === "service_worker");
  for (;;) {
    const res = await send("Target.getTargets");
    const found = (res?.result?.targetInfos ?? []).find(match);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("deadline"));
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("deadline")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Fallback for a harness that genuinely cannot read Chrome's stderr: find a
 * port nothing answers on AND nothing is bound to. Weaker than `launchChrome`
 * — the window between the check and Chrome's bind is a real race — so prefer
 * `launchChrome` wherever the harness owns the spawn.
 */
export async function freePort(from = 9400, span = 500, attempts = 40): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = from + Math.floor(Math.random() * span);
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
      await probe.body?.cancel();
      continue; // somebody is already answering there
    } catch { /* nothing listening — try to claim it */ }
    try {
      const l = Deno.listen({ port, hostname: "127.0.0.1" });
      l.close();
      return port;
    } catch { /* raced or reserved; try another */ }
  }
  throw new Error("no free debugging port");
}

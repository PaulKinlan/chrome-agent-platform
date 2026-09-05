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

import { crypto } from "jsr:@std/crypto@1";

export interface LaunchedChrome {
  /** The spawned Chrome. The caller owns killing it. */
  proc: Deno.ChildProcess;
  /** The browser-level DevTools WebSocket URL, read from this process's stderr. */
  wsUrl: string;
  /** The port the kernel actually assigned. */
  port: number;
  /** The last few KB of Chrome's stderr — for honest failure messages. */
  stderrTail(): string;
  /** How long this launch queued behind another lane's browser (0 when it did not). */
  lockWaitMs: number;
}

const TAIL_LIMIT = 8192;

/** The browser every harness drives. */
export async function computeUnpackedExtensionId(path: string): Promise<string> {
  const absPath = Deno.realPathSync(path);
  const data = new TextEncoder().encode(absPath);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let id = "";
  for (let i = 0; i < 16; i++) {
    const byte = hash[i];
    const high = (byte >> 4) & 0x0f;
    const low = byte & 0x0f;
    id += String.fromCharCode(97 + high) + String.fromCharCode(97 + low);
  }
  return id;
}

export async function seedGrantedPermissions(
  profileDir: string,
  extIdOrPath: string,
  apis: string[] = ["tabs", "notifications"],
): Promise<string> {
  const isId = /^[a-p]{32}$/.test(extIdOrPath);
  const extId = isId ? extIdOrPath : await computeUnpackedExtensionId(extIdOrPath);
  const extPath = isId ? "" : (() => { try { return Deno.realPathSync(extIdOrPath); } catch { return ""; } })();

  const defaultDir = `${profileDir}/Default`;
  await Deno.mkdir(defaultDir, { recursive: true });
  const prefsPath = `${defaultDir}/Preferences`;
  let prefs: any = {};
  try {
    prefs = JSON.parse(await Deno.readTextFile(prefsPath));
  } catch {
    prefs = {};
  }
  prefs.extensions ??= {};
  prefs.extensions.settings ??= {};
  prefs.extensions.settings[extId] = {
    active_permissions: {
      api: apis,
      explicit_host: ["<all_urls>"],
      manifest_permissions: [],
      scriptable_host: [],
    },
    granted_permissions: {
      api: apis,
      explicit_host: ["<all_urls>"],
      manifest_permissions: [],
      scriptable_host: [],
    },
    location: 8,
    ...(extPath ? { path: extPath } : {}),
    withholding_permissions: false,
  };
  await Deno.writeTextFile(prefsPath, JSON.stringify(prefs, null, 2));
  return extId;
}

export const CHROMIUM = "/usr/bin/chromium";

// ── the serialized-Chrome lock ──────────────────────────────────────────────
// CAP-FB-20260830-SUITE-HONESTY-01. Two lanes driving headless Chromes at the
// same time produce CDP timeouts (Runtime.evaluate / Target.attachToTarget)
// in whichever suite loses the CPU — a red that says nothing about the tree.
// The canonical lock the security supervisor already takes is now taken HERE,
// for the lifetime of the browser, so every harness serializes by construction:
//   - bounded: the wait is capped (CAP_CHROME_LOCK_WAIT_MS, default 20 min) and
//     a lane that never gets the lock FAILS loudly — it is never turned green;
//   - honest: the wait is printed when it happens, with its length;
//   - reentrant within one process (a harness that launches two browsers);
//   - skipped inside the security supervisor, which already holds the lock
//     (CAP_SECURITY_NONCE), or when a runner says it holds it (CAP_CHROME_LOCK_HELD);
//   - released when the last browser this process launched exits, and by the
//     holder itself within a second of this process dying (no orphaned lock).
export const CHROME_LOCK_PATH = Deno.env.get("CAP_CHROME_LOCK_PATH") ?? "/tmp/cap-serialized-chrome-acceptance.lock";

// Lock state is PER PATH (chrome-agent-platform-51x4): the canonical lock
// serializes real browsers; fake-browser unit fixtures take their own
// isolated scope (launchChrome's lockPath option) so they never queue behind
// a real lane's 20-minute gate — and never dilute the real serialization.
const lockStates = new Map<string, { holder: Deno.ChildProcess | null; refs: number }>();

async function acquireChromeLock(lockPath: string = CHROME_LOCK_PATH): Promise<{ waitedMs: number; release: () => void }> {
  const noop = () => {};
  if (Deno.env.get("CAP_SECURITY_NONCE") || Deno.env.get("CAP_CHROME_LOCK_HELD") === "1") {
    return { waitedMs: 0, release: noop };
  }
  const state = lockStates.get(lockPath) ?? { holder: null, refs: 0 };
  lockStates.set(lockPath, state);
  const release = () => {
    state.refs = Math.max(0, state.refs - 1);
    if (state.refs === 0 && state.holder) {
      // Closing the holder's stdin is the release: `cat` sees EOF, the shell
      // exits, flock exits, the kernel drops the lock. The same EOF happens
      // by itself when this process dies, so a crashed harness never leaves
      // the lock held.
      const h = state.holder;
      state.holder = null;
      try { h.stdin.close().catch(() => {}); } catch { /* already closed */ }
    }
  };
  if (state.holder) {
    state.refs++;
    return { waitedMs: 0, release };
  }
  const waitMs = Number(Deno.env.get("CAP_CHROME_LOCK_WAIT_MS") ?? 20 * 60_000);
  const t0 = Date.now();
  // flock -w gives a bounded wait natively; the holder prints once it has the
  // lock and then holds it exactly until its stdin closes.
  const holder = new Deno.Command("flock", {
    args: [
      "-w", String(Math.max(1, Math.ceil(waitMs / 1000))),
      lockPath,
      "sh", "-c",
      "echo CAP_CHROME_LOCK_ACQUIRED; exec cat >/dev/null",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let notice: ReturnType<typeof setTimeout> | undefined;
  const deadline = t0 + waitMs + 2000;
  while (!seen.includes("CAP_CHROME_LOCK_ACQUIRED") && Date.now() < deadline) {
    if (notice === undefined) {
      notice = setTimeout(() => console.error(`launchChrome: waiting for the serialized-Chrome lock (${lockPath}) — another lane is driving a browser`), 1500);
    }
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await withTimeout(reader.read(), deadline - Date.now()); } catch { break; }
    if (chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
  }
  clearTimeout(notice);
  try { reader.releaseLock(); } catch { /* released */ }
  const waitedMs = Date.now() - t0;
  if (!seen.includes("CAP_CHROME_LOCK_ACQUIRED")) {
    try { await holder.stdin.close(); } catch { /* already closed */ }
    try { holder.kill("SIGKILL"); } catch { /* gone */ }
    try { await holder.status; } catch { /* reaped */ }
    throw new Error(
      `launchChrome: could not take the serialized-Chrome lock within ${waitMs} ms (${lockPath} is held by another lane's browser). ` +
        "Not started — a run that cannot get the browser is a failed run, not a skipped one.",
    );
  }
  if (waitedMs > 1500) console.error(`launchChrome: took the serialized-Chrome lock after ${waitedMs} ms`);
  // Drain the holder's stdout in the background (it prints nothing more).
  (async () => { try { for await (const _ of holder.stdout) { /* drain */ } } catch { /* gone */ } })();
  state.holder = holder;
  state.refs = 1;
  holder.status.then(() => { if (state.holder === holder) { state.holder = null; state.refs = 0; } }).catch(() => {});
  return { waitedMs, release };
}

/**
 * The flags every headless harness passes. Exported so a harness that builds
 * its own argv (a custom window size, an extra page) still shares one source
 * for the boring part instead of a private copy that drifts.
 */
export function chromeBaseArgs(opts: {
  profile?: string;
  extension?: string;
  windowSize?: string;
} = {}): string[] {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-allow-origins=*",
    `--window-size=${opts.windowSize ?? "1440,900"}`,
  ];
  if (opts.extension) {
    args.push("--silent-debugger-extension-api");
    args.push(`--disable-extensions-except=${opts.extension}`);
    args.push(`--load-extension=${opts.extension}`);
  }
  if (opts.profile) args.push(`--user-data-dir=${opts.profile}`);
  return args;
}

/**
 * Spawn Chrome with a kernel-assigned debugging port and return its real
 * DevTools endpoint. `args` must NOT contain `--remote-debugging-port`; a
 * fixed port is the defect this module exists to remove, so passing one is a
 * hard error rather than a silent override.
 *
 * Two ways to call it:
 *   - `args` only: the caller owns the full argv (the launcher appends the port).
 *   - `extension` / `profile` (+ optional `args` extras): the launcher builds the
 *     standard headless argv with `chromeBaseArgs()` and loads the extension.
 */
export async function launchChrome(opts: {
  binary?: string;
  args?: string[];
  extension?: string;
  profile?: string;
  windowSize?: string;
  timeoutMs?: number;
  stdout?: "null" | "inherit" | "piped";
  clearEnv?: boolean;
  /** Environment for the browser (with clearEnv: the whole environment — an allowlist). */
  env?: Record<string, string>;
  /** Pre-seed Chrome's Preferences with granted permissions before launch. */
  grantPermissions?: string[];
  /** Lock scope for this launch. Default: the canonical serialized-Chrome
   *  lock every real harness shares. Fake-browser unit fixtures pass their own
   *  path so they never queue behind (or block) the real browser queue
   *  (chrome-agent-platform-51x4). Never set this in a real acceptance run. */
  lockPath?: string;
}): Promise<LaunchedChrome> {
  if (Array.isArray(opts.grantPermissions) && opts.grantPermissions.length && opts.profile && opts.extension) {
    await seedGrantedPermissions(opts.profile, opts.extension, opts.grantPermissions);
  }
  const extras = opts.args ?? [];
  const fixed = extras.find((a) => a.startsWith("--remote-debugging-port"));
  if (fixed) {
    throw new Error(
      `launchChrome: refusing a caller-chosen debugging port (${fixed}). ` +
        "The port is assigned by the kernel and read back from Chrome's own stderr.",
    );
  }
  const args = (opts.extension || opts.profile)
    ? [
      ...chromeBaseArgs({ profile: opts.profile, extension: opts.extension, windowSize: opts.windowSize }),
      ...extras,
      ...(extras.some((a) => !a.startsWith("--")) ? [] : ["about:blank"]),
    ]
    : extras;

  const lock = await acquireChromeLock(opts.lockPath);
  const proc = new Deno.Command(opts.binary ?? CHROMIUM, {
    args: [...args, "--remote-debugging-port=0"],
    stdout: opts.stdout ?? "null",
    stderr: "piped",
    ...(opts.clearEnv ? { clearEnv: true } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  }).spawn();
  // The lock lives as long as this browser does.
  proc.status.then(() => lock.release()).catch(() => lock.release());

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
    lock.release();
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

  return { proc, wsUrl, port: Number(new URL(wsUrl).port), stderrTail: () => tail, lockWaitMs: lock.waitedMs };
}

export type CdpSend = (method: string, params?: any, sessionId?: string) => Promise<any>;

export interface CdpClient {
  /** Raw CDP send. Resolves with the full `{ result }` envelope; rejects on a protocol error. */
  send: CdpSend;
  /** Attach to a target (flatten) and enable Runtime + Page; returns the session id. */
  attach(targetId: string): Promise<string>;
  /** Open a URL in a new target and attach to it; returns the session id. */
  open(url: string): Promise<{ targetId: string; sessionId: string }>;
  /** `Runtime.evaluate` with awaitPromise + returnByValue; throws on a page exception. */
  eval(sessionId: string, expression: string): Promise<any>;
  /** Safely capture a screenshot of a target without wedging on quiesced headless frames (f5lb). */
  screenshot(sessionId: string, opts?: ScreenshotOptions): Promise<Uint8Array | null>;
  /** Wait (bounded) for the extension's service-worker target; returns its info or null. */
  serviceWorker(opts?: { timeoutMs?: number }): Promise<any | null>;
  /** Subscribe to a CDP event (e.g. Runtime.executionContextCreated). Returns an unsubscribe. */
  on(method: string, handler: (params: any, sessionId?: string) => void): () => void;
  close(): void;
}

/**
 * The minimal CDP client the harnesses used to each carry a private copy of.
 * One WebSocket over the browser endpoint `launchChrome()` returned; every
 * method is bounded and a protocol error REJECTS (never resolves as success).
 */
export async function openCdp(wsUrl: string, opts: { timeoutMs?: number } = {}): Promise<CdpClient> {
  const ws = new WebSocket(wsUrl);
  await withTimeout(
    new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("cdp websocket error"));
    }),
    opts.timeoutMs ?? 10000,
  );
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message ?? "cdp error"}`));
      else p.resolve({ result: m.result });
      return;
    }
    if (typeof m.method === "string") {
      for (const fn of listeners.get(m.method) ?? []) {
        try { fn(m.params, m.sessionId); } catch { /* a listener must not break the socket */ }
      }
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("cdp websocket closed"));
    pending.clear();
  };
  const send: CdpSend = (method, params = {}, sessionId) => {
    const mid = ++id;
    return withTimeout(
      new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      }),
      opts.timeoutMs ?? 30000,
    ).catch((e) => {
      pending.delete(mid);
      throw new Error(`${method}: ${e?.message ?? e}`);
    });
  };
  const attach = async (targetId: string) => {
    const a = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = a?.result?.sessionId as string;
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId).catch(() => {});
    return sessionId;
  };
  return {
    send,
    attach,
    async open(url: string) {
      const t = await send("Target.createTarget", { url });
      const targetId = t?.result?.targetId as string;
      return { targetId, sessionId: await attach(targetId) };
    },
    async eval(sessionId: string, expression: string) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      const res = r?.result;
      if (res?.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate threw");
      }
      return res?.result?.value;
    },
    screenshot: (sessionId, opts = {}) => safeCaptureScreenshot(send, sessionId, opts),
    serviceWorker: (o = {}) => waitForServiceWorker(send, o),
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(handler);
      return () => { listeners.get(method)?.delete(handler); };
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

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

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  fromSurface?: boolean;
  captureBeyondViewport?: boolean;
  timeoutMs?: number;
}

/**
 * Capture a screenshot safely without hanging on quiesced headless frames (chrome-agent-platform-f5lb).
 *
 * In headless Chromium with --disable-gpu, Page.captureScreenshot(fromSurface: true)
 * issued when the page has no pending visual work waits forever for a compositor
 * frame that is never scheduled (the renderer is idle, so Viz never gets an OnBeginFrame).
 *
 * This helper:
 *   1. Races the capture against a bounded timeout (default 8000ms).
 *   2. If fromSurface: true was requested or defaulted and times out or rejects,
 *      wakes the frame pipeline with a micro requestAnimationFrame / style tick
 *      and falls back to fromSurface: false (which reads from the backing store /
 *      Blink paint tree directly rather than waiting for an unscheduled Viz frame).
 *   3. Returns Uint8Array of bytes, or null on terminal failure (never wedges the process).
 */
export async function safeCaptureScreenshot(
  send: CdpSend,
  sessionId: string,
  opts: ScreenshotOptions = {},
): Promise<Uint8Array | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const captureCall = (fromSurface?: boolean) => {
    const params: Record<string, unknown> = {
      format: opts.format ?? "png",
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.clip ? { clip: opts.clip } : {}),
      ...(opts.captureBeyondViewport !== undefined ? { captureBeyondViewport: opts.captureBeyondViewport } : {}),
      ...(fromSurface !== undefined ? { fromSurface } : {}),
    };
    return send("Page.captureScreenshot", params, sessionId);
  };

  // Attempt 1: Caller's preferred fromSurface setting with bounded timeout
  try {
    const res = await withTimeout(captureCall(opts.fromSurface), timeoutMs);
    const b64 = res?.result?.data ?? res?.data;
    if (b64 && typeof b64 === "string") {
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
  } catch (_err) {
    // If fromSurface was true (or defaulted), the frame scheduler may be quiesced.
    // Fall through to wake the compositor and retry with fromSurface: false.
  }

  // Attempt 2: Wake up compositor and capture with fromSurface: false
  try {
    await withTimeout(
      send("Runtime.evaluate", {
        expression: "new Promise(r => requestAnimationFrame(() => r(true)))",
        awaitPromise: true,
      }, sessionId),
      1500,
    ).catch(() => {});
    const fallback = await withTimeout(captureCall(false), Math.min(timeoutMs, 4000));
    const b64 = fallback?.result?.data ?? fallback?.data;
    if (b64 && typeof b64 === "string") {
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
  } catch {
    return null;
  }

  return null;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
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

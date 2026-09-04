// agent-provider-picker.ts — the Settings → Agents per-agent provider/model
// picker journey (Paul 2026-08-18). Loads the REAL extension in headless
// Chromium over CDP, seeds a named agent through the service-worker route,
// then audits + drives the per-agent provider row AND the main Providers model
// control with genuine Input events: filter/search, keyboard navigation,
// global-provider toggle, persistence, catalogue freshness, custom-ID
// fallback, and EQUAL CONTROL HEIGHTS (measured in the rendered layout).
//
//   deno run -A scripts/agent-provider-picker.ts --phase audit   # before evidence
//   deno run -A scripts/agent-provider-picker.ts                 # full regression
//
// Screenshots + a measured-metrics JSON land in <durable-root>/cap-picker-<phase>-<ts>/
// (disk; bead chp).
// @ts-nocheck — dynamic CDP scripting (no types for the raw protocol).

import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { launchChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// ── evidence manifest (the final review's MEDIUM): commit + results + console ──
// ALL run state is declared BEFORE any git command: an early git failure or
// signal still has defined state and reaches the truthful coordinator.
let pass = 0, fail = 0;

// ── startup diagnostics state: initialized BEFORE ANY setup command so a
// failed test-build child's first cause can be recorded without a TDZ/undefined
// dereference (review 966da5a finding 1) ──
var chromiumExitState: any = null;
var chromiumLogLines: any[] = [];
var discoveredPort = 0;
function currentPort() { return discoveredPort; }
const CHROMIUM_LOG_MAX_LINES = 400;
const resultsLog: { name: string; pass: boolean }[] = [];
const shotsTaken: string[] = [];
var OUT: string = "";
var PHASE: string = "full";
const postTest: { rebuiltAt?: string; seamRefs?: number; clean?: boolean } = {};
const COMMIT = await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: ROOT, stdout: "piped" }).output()
  .then((o) => new TextDecoder().decode(o.stdout).trim());
const BRANCH = await new Deno.Command("git", { args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: ROOT, stdout: "piped" }).output()
  .then((o) => new TextDecoder().decode(o.stdout).trim());
const consoleTranscript: string[] = [];

// Git blob/rev helpers: identity is derived from COMMIT's object database, not
// the mutable working tree (review 966da5a finding 4).
async function gitRev(spec: string): Promise<string> {
  return await new Deno.Command("git", { args: ["rev-parse", spec], cwd: ROOT, stdout: "piped" }).output().then((o) => new TextDecoder().decode(o.stdout).trim());
}
async function gitBlob(spec: string): Promise<string | null> {
  const r = await new Deno.Command("git", { args: ["show", spec], cwd: ROOT, stdout: "piped", stderr: "null" }).output();
  return r.success ? new TextDecoder().decode(r.stdout) : null;
}
async function gitBlobRev(spec: string): Promise<string> {
  return await gitRev(spec);
}
// The TRUE start timestamp + the pristine-worktree attestation (captured
// BEFORE anything runs, so the manifest records a genuine start + status).
const __runCommand = `deno run -A scripts/agent-provider-picker.ts${Deno.args.length ? " " + Deno.args.join(" ") : ""}`;
const STATUS_SNAPSHOT = {
  head: COMMIT,
  branch: BRANCH,
  statusPorcelain: await new Deno.Command("git", { args: ["status", "--porcelain"], cwd: ROOT, stdout: "piped" }).output().then((o) => new TextDecoder().decode(o.stdout).trim() || "(clean)"),
  stagedAndUnstaged: await new Deno.Command("git", { args: ["diff", "HEAD", "--stat"], cwd: ROOT, stdout: "piped" }).output().then((o) => new TextDecoder().decode(o.stdout).trim() || "(no diff)"),
};

// LIFECYCLE (the successor review's CRITICAL): ONE cleanup promise. The
// first caller STORES the promise and every later caller (signals, exits,
// finally) AWAITS THE SAME promise — concurrent signals can never return
// early or kill a mid-flight cleanup. Cleanup step failures mark the run
// FAILED (fail++) while still running every remaining step. No Deno.exit
// inside the try; the audit/final paths exit only after the awaited promise.
let __startedAt = new Date().toISOString();
var OUT: string = "";
var AUDIT_DONE = false;
var metricsWritten = false;
var PHASE: string = "full";
var ws: WebSocket | null = null;
var proc: Deno.ChildProcess | null = null;
var launched: Awaited<ReturnType<typeof launchChrome>> | null = null;
var byoServer: { shutdown(): Promise<void> } | null = null;
var TEST_EXT: string | null = null;
var testBuildSeamVerified = false;
var profile: string | null = null;
let __cleanupPromise: Promise<void> | null = null;

function ensureCleanup(reason: string): Promise<void> {
  if (!__cleanupPromise) {
    __cleanupPromise = (async () => {
      const steps: { name: string; ok: boolean; note?: string }[] = [];
      const step = async (name: string, fn: () => Promise<unknown>) => {
        // HARD-bounded cleanup: a stuck child/server/build can never hang teardown.
        const bound = (p: Promise<unknown>, ms: number) => {
          // The bound timer is CLEARED when the step wins — no leaked timeouts.
          let t: ReturnType<typeof setTimeout> | null = null;
          const timeoutP = new Promise<never>((_, rej) => {
            t = setTimeout(() => rej(new Error(`cleanup step ${name} exceeded ${ms}ms`)), ms);
          });
          return Promise.race([p, timeoutP]).finally(() => { if (t) clearTimeout(t); }) as Promise<unknown>;
        };
        try { await bound(fn(), 120_000); steps.push({ name, ok: true }); }
        catch (e) { steps.push({ name, ok: false, note: String(e?.message ?? e).slice(0, 120) }); }
      };
      console.log(`cleanup (${reason}): starting…`);
      await step("ws close", () => new Promise<void>((resolve, reject) => {
        if (!ws) return resolve();
        if (ws.readyState === 3) return resolve();
        let settled = false;
        // ARMED BEFORE close(): a synchronous onclose (or a throw) can never
        // leave a live timer installed after resolution (review finding 2).
        const t: ReturnType<typeof setTimeout> = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (ws.readyState === 3) resolve();
          else reject(new Error(`ws not closed after 2s (readyState ${ws.readyState})`));
        }, 2000);
        const finish = () => { if (!settled) { settled = true; clearTimeout(t); resolve(); } };
        ws.onclose = () => finish();
        try { ws.close(); } catch { finish(); }
        // A synchronous onclose already ran finish() — t is cleared; if close()
        // resolves asynchronously, onclose clears it; if neither, the timeout
        // above settles once.
      }));
      await step("chromium kill+status", async () => {
        if (!proc) return;
        try { proc.kill(); } catch { /* already dead */ }
        const status = await proc.status.catch(() => null);
        if (status) void status;
      });
      await step("server stop", () => byoServer?.shutdown() ?? Promise.resolve());
      await step("profile dir remove", async () => {
        if (!profile) return;
        for (let i = 0; i < 10; i++) {
          try { await Deno.remove(profile, { recursive: true }); return; }
          catch (e) {
            if (!/not empty|no such/i.test(String(e?.message ?? e))) throw e;
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        throw new Error("profile dir still busy after retries");
      });
      await step("test-ext dir remove", () => TEST_EXT ? Deno.remove(TEST_EXT, { recursive: true }) : Promise.resolve());
      await step("production rebuild + seam scan", async () => {
        const rebuild = await new Deno.Command("npm", { args: ["run", "build"], cwd: ROOT, env: { PATH: Deno.env.get("PATH") ?? "" }, stdout: "piped", stderr: "piped" }).output();
        const prodText = await Deno.readTextFile(`${ROOT}extension/dist/background/service-worker.js`).catch(() => "");
        const seamRefs = (prodText.match(/key-sentinel|__CAP_TEST_SEAM|CAP_TEST_SEAM/g) ?? []).length;
        if (seamRefs > 0) throw new Error(`production tree dirty after rebuild: ${seamRefs} seam refs`);
        if (!rebuild.success) throw new Error("production rebuild failed");
      });
      const failed = steps.filter((s) => !s.ok);
      console.log(`cleanup (${reason}): ${steps.length - failed.length}/${steps.length} steps ok${failed.length ? " — FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
      if (failed.length) fail++; // a failed cleanup step FAILS the run
      (globalThis as never as { __cleanupSteps: unknown }).__cleanupSteps = steps;
    })();
  }
  return __cleanupPromise;
}

/** Manifest write AFTER cleanup on every path — EXACTLY ONCE (idempotent):
 *  the first call writes; later calls (finally + exit, or two signals) are
 *  no-ops returning the first result. Failure increments fail. */
let __manifestWritten = false;
let __manifestResult = true;
async function writeManifest(): Promise<boolean> {
  if (__manifestWritten) return __manifestResult;
  __manifestWritten = true;
  try {
    await ensureDir(OUT); // mkdir failure is FATAL for evidence (caught below → fail)
    const steps = ((globalThis as never as { __cleanupSteps?: { name: string; ok: boolean; note?: string }[] }).__cleanupSteps) ?? [];
    const rebuildStep = steps.find((s) => s.name === "production rebuild + seam scan");
    postTest.rebuiltAt = new Date().toISOString();
    postTest.seamRefs = rebuildStep?.ok ? 0 : -1;
    postTest.clean = Boolean(rebuildStep?.ok);
    postTest.rebuildOk = Boolean(rebuildStep?.ok);
    postTest.cleanupSteps = steps;
    // Final immutability assertion: the manifest may only attest THIS commit.
    const finalHead = await gitRev("HEAD");
    const finalStatus = await new Deno.Command("git", { args: ["status", "--porcelain"], cwd: ROOT, stdout: "piped" }).output().then((o) => new TextDecoder().decode(o.stdout).trim());
    const headMoved = finalHead !== COMMIT;
    if (headMoved || finalStatus !== "") fail++; // a moved HEAD/dirty tree invalidates the evidence
    await Deno.writeTextFile(`${OUT}/manifest.json`, JSON.stringify({
      commit: COMMIT, branch: BRANCH, phase: PHASE,
      startedAt: __startedAt, endedAt: new Date().toISOString(),
      // IDENTITY FROM THE CAPTURED COMMIT (atomically bound — never a mix of
      // startup commit + ending working tree): tree/version/script are read
      // from COMMIT's blobs, and the run FAILS if HEAD moved or the worktree
      // is dirty at manifest time.
      tree: await gitBlobRev(`${COMMIT}^{tree}`),
      version: await gitBlob(`${COMMIT}:package.json`).then((t) => JSON.parse(t ?? "{}")?.version ?? null),
      scriptSha256: await gitBlob(`${COMMIT}:scripts/agent-provider-picker.ts`).then(async (t) => t == null ? null : [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, "0")).join("")),
      // THE CHECKED SNAPSHOT ONLY — the exact finalHead/finalStatus values the
      // fail decision was computed from; never a second query that could
      // diverge from the decision (review 344df55 finding 2).
      finalHead,
      finalStatusClean: finalStatus === "",
      headMoved, finalStatusRaw: finalStatus.slice(0, 200),
      profilePath: profile,
      profileRemovedDuringCleanup: (() => {
        if (!profile) return null;
        try { Deno.statSync(profile); return false; }
        catch (e) { return (e instanceof Deno.errors.NotFound || String((e as Error)?.code ?? "") === "ENOENT") ? true : "stat-error"; }
      })(),
      command: __runCommand, worktreeStatus: STATUS_SNAPSHOT,
      checks: resultsLog, totals: { passed: pass, failed: fail },
      byoServer: { hits: byoHits, sawAuthorization: byoSawAuth },
      chromium: { exit: chromiumExitState ?? null, logTail: (chromiumLogLines ?? []).slice(-120), stderrTail: launched ? launched.stderrTail().slice(-2000) : null },
      testBuild: { isolatedCopy: TEST_EXT, seamVerified: Boolean(testBuildSeamVerified) },
      postTestProductionRebuild: postTest,
      residualNote: "headless auto-denies the origin-permission prompt; the adapter run is attested FAIL-CLOSED and its HTTP path via provider.test. A headed run with the user granting completes the chain.",
      consoleTranscript: consoleTranscript.slice(0, 200),
      // HONEST artifacts: only what was actually produced (shotsTaken is the
      // ground truth; the metrics file only when it was written).
      artifacts: [...new Set([...shotsTaken, "manifest.json", ...(metricsWritten ? [`metrics-${PHASE}.json`] : [])])],
    }, null, 2));
    console.log(`manifest: ${OUT}/manifest.json (commit ${COMMIT.slice(0, 8)})`);
    __manifestResult = true;
    return true;
  } catch (e) {
    console.error("manifest write FAILED (the run reports failure):", e);
    fail++;
    __manifestResult = false;
    return false;
  }
}

/** The ONE exit path: awaited cleanup FIRST, then the manifest (carrying the
 *  cleanup results), then a NONZERO exit when any assertion, cleanup step, or
 *  the manifest write itself failed. No Deno.exit inside the try. */
async function __exitWithCleanup(code: number): Promise<never> {
  return await __exitCoordinator(code);
}

// ONE coordinator: signals request an exit code; the shared pipeline
// (cleanup → manifest → exit) runs ONCE — a second signal is a no-op (the
// coordinator promise is shared), so concurrent signals can never race
// manifest writes or double-exit mid-cleanup.
let __exitStarted = false;
let __pendingExitCode: number | null = null;
async function __exitCoordinator(initialCode: number = 0): Promise<never> {
  if (__pendingExitCode === null) __pendingExitCode = initialCode;
  if (__exitStarted) {
    await new Promise(() => {}); // the in-flight coordinator exits the process
  }
  __exitStarted = true;
  await ensureCleanup(__pendingExitCode === 130 ? "SIGINT" : __pendingExitCode === 143 ? "SIGTERM" : "exit");
  const manifestOk = await writeManifest();
  const code = fail > 0 || !manifestOk ? Math.max(__pendingExitCode ?? 0, 1) : (__pendingExitCode ?? 0);
  Deno.exit(code);
}
function requestExit(code: number) {
  if (__pendingExitCode === null) __pendingExitCode = code;
  __exitCoordinator(code).catch(() => Deno.exit(code));
}
Deno.addSignalListener("SIGINT", () => requestExit(130));
Deno.addSignalListener("SIGTERM", () => requestExit(143));

// EVERYTHING (the successor review's CRITICAL) — test build, verification,
// profile, launch, CDP setup, and the journey itself — runs inside ONE try
// whose finally awaits the single cleanup promise: no setup exception can
// bypass cleanup, and the finally never kills mid-flight.
const sleep = (ms) => setTimeout(ms, 0), sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

let _consoleHooked = false;
function check(name, cond) {
  if (cond) pass++; else fail++;
  resultsLog.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}
// The evidence OUT dir exists BEFORE any resource-producing setup, so even
// an early failure emits a manifest.
PHASE = Deno.args.includes("--phase") ? Deno.args[Deno.args.indexOf("--phase") + 1] : "full";
OUT = durableDir(`cap-picker-${PHASE}-${Date.now()}`);
await ensureDir(OUT).catch(() => {});
try {
console.log("building the isolated test extension…");
const testBuild = await new Deno.Command("node", { args: ["scripts/build-test-extension.mjs"], cwd: ROOT, stdout: "piped", stderr: "piped" }).output();
if (!testBuild.success) {
  // PRESERVE THE FIRST CAUSE: the child's exit code + bounded stdout/stderr
  // flow into the early manifest — a generic message never hides them.
  chromiumExitState = { code: testBuild.code, signal: testBuild.signal ?? null };
  const outTail = new TextDecoder().decode(testBuild.stdout).split("\n").slice(-15).join("\n").slice(0, 2000);
  const errTail = new TextDecoder().decode(testBuild.stderr).split("\n").slice(-15).join("\n").slice(0, 2000);
  chromiumLogLines.push(`[test-build:stdout] ${outTail}`, `[test-build:stderr] ${errTail}`);
  console.error(errTail);
  throw new Error(`test-extension build failed (child exit code=${testBuild.code} signal=${testBuild.signal ?? "none"})`);
}
TEST_EXT = new TextDecoder().decode(testBuild.stdout).trim().split("\n").pop();
{
  const bundle = await Deno.readTextFile(`${TEST_EXT}/dist/background/service-worker.js`);
  if (!bundle.includes("TEST SEAM") || !bundle.includes("key-sentinel")) {
    throw new Error("the isolated test build did not include the seam — refusing to run");
  }
  testBuildSeamVerified = true; // only set after the actual verification
  const prodPath = `${ROOT}extension/dist/background/service-worker.js`;
  try {
    const prod = await Deno.readTextFile(prodPath);
    if (prod.includes("key-sentinel") || prod.includes("__CAP_TEST_SEAM")) {
      throw new Error("PRODUCTION tree already dirty before the run — aborting");
    }
  } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  console.log(`isolated test extension: ${TEST_EXT} (production tree verified clean)`);
}
const EXT = `${ROOT}extension`; // production (never loaded by the journey)
const LOAD_EXT = TEST_EXT; // the isolated test copy IS what Chrome loads


// ── launch ──────────────────────────────────────────────────────────────────
profile = await Deno.makeTempDir();
// The shared launcher (CAP-FB-20260829-FIXED-DEBUG-PORTS-01): the debugging
// port is kernel-assigned and the DevTools endpoint is read from THIS child's
// own stderr — never a probe of a named port. The launcher owns stderr (it
// keeps draining it; `stderrTail()` feeds the manifest); stdout stays piped so
// drainChromiumOutput() can log it and record the exit state as before.
// clearEnv + an explicit allowlist: Chromium must NOT inherit the coordinator's
// (possibly credential-bearing) parent environment; the platform needs only
// PATH (exec helpers), HOME (profile/prefs) and the XDG/locale variables.
launched = await launchChrome({
  extension: LOAD_EXT,
  profile,
  windowSize: "1400,2400",
  stdout: "piped",
  clearEnv: true,
  env: (() => {
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: Deno.env.get("HOME") ?? "/tmp",
    };
    for (const k of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "LANG", "LC_ALL"]) {
      const v = Deno.env.get(k);
      if (v) env[k] = v;
    }
    return env;
  })(),
});
proc = launched.proc;
discoveredPort = launched.port; // captured by the launcher, not re-parsed here
drainChromiumOutput();
const port = currentPort();
let version: any = null;
{
  const deadline = Date.now() + 10_000; // hard bound for the whole accept phase
  for (let i = 0; i < 40 && Date.now() < deadline && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000), // per-attempt hard timeout
      })).json();
    } catch { await sleepMs(250); } // endpoint accepts a beat after the stderr line
  }
}
if (!version) throw new Error(`DevTools endpoint never answered on :${port} (exit ${JSON.stringify(chromiumExitState)})`);

// ── robust CDP client ─────────────────────────────────────────────────────────
// Every request carries step/expression/session labels + a timestamp; sends
// refuse on a non-OPEN socket; timers clear on settle; protocol m.error
// rejects; ws close/error and Chromium exit reject ALL pending with the
// transport state (no more misattributed 15s expression timeouts). The
// Chromium child's stdout/stderr are drained continuously (bounded, kept
// for the manifest) and its exit code/signal recorded truthfully.


function drainChromiumOutput() {
  if (!proc) return;
  // Per-stream partial-line buffering: a "DevTools listening" line split across
  // chunk boundaries is reassembled before matching (the old push could split it).
  const buffers: Record<string, string> = { stdout: "", stderr: "" };
  // The port record is captured AT INGESTION (separate from the bounded log —
  // a burst >400 lines can never evict it).
  // (uses the hoisted discoveredPort)
  const push = (tag: string, chunk: string) => {
    buffers[tag] = (buffers[tag] ?? "") + chunk;
    const parts = buffers[tag].split("\n");
    buffers[tag] = parts.pop() ?? ""; // keep the trailing partial
    for (const line of parts) {
      if (!discoveredPort && line.includes("DevTools listening")) {
        discoveredPort = Number(line.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
      }
      if (!line.trim()) continue;
      chromiumLogLines.push(`[${tag}] ${line}`);
      if (chromiumLogLines.length > CHROMIUM_LOG_MAX_LINES) chromiumLogLines.shift();
    }
  };
  const flushTerminal = (tag: string) => {
    const partial = buffers[tag] ?? "";
    if (partial.trim()) {
      if (!discoveredPort && partial.includes("DevTools listening")) {
        discoveredPort = Number(partial.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
      }
      chromiumLogLines.push(`[${tag}] ${partial}`);
      if (chromiumLogLines.length > CHROMIUM_LOG_MAX_LINES) chromiumLogLines.shift();
    }
    buffers[tag] = "";
  };

  const pump = async (stream: ReadableStream<Uint8Array> | null, tag: string) => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        push(tag, new TextDecoder().decode(value));
      }
    } catch (e) {
      chromiumLogLines.push(`[pump:${tag}] read failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
    } finally {
      flushTerminal(tag); // a terminal partial line is never silently lost
    }
  };
  // stdout only: the launcher holds stderr's reader (it read the DevTools
  // endpoint from it and drains it for the manifest's stderrTail).
  void pump(proc.stdout, "stdout");
  void (async () => {
    try {
      const st = await proc.status;
      chromiumExitState = { code: st.code, signal: st.signal };
      goTerminal(`Chromium exited (code=${st.code} signal=${st.signal})`);
    } catch { /* already reaped */ }
  })();
}


/** The ONE bounded diagnostic formatter: every settlement/refusal/load path
 *  emits the same explicit field schema — id/sent/elapsed/session/expression,
 *  with "N/A" for fields an operation genuinely has none of. */
function cdpDiag(fields: {
  kind: string; label: string; id?: number | string | null;
  sentAt?: number | null; expression?: string | null; sessionId?: string | null;
  detail?: string;
}): string {
  // EVERY field is sanitized + individually capped, and the TOTAL message is
  // capped — hostile/peer-controlled error payloads, labels, session ids, and
  // terminal reasons can never produce an unbounded diagnostic (review
  // 344df55 finding 1). Control characters are stripped (single-line output).
  const clean = (s: unknown, cap: number): string => {
    const t = String(s ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
    return t.length > cap ? t.slice(0, cap - 1) + "…" : t;
  };
  const now = Date.now();
  const sentAt = fields.sentAt ?? null;
  const elapsed = sentAt != null ? `${now - sentAt}ms` : "N/A";
  const msg = [
    `${clean(fields.kind, 40)} [${clean(fields.label, 60)}]`,
    `id=${clean(fields.id ?? "N/A", 24)}`,
    `sent=${sentAt != null ? new Date(sentAt).toISOString() : "N/A"}`,
    `elapsed=${elapsed}`,
    `session=${clean(fields.sessionId ?? "N/A", 48)}`,
    fields.expression ? `expr=${clean(fields.expression, 80)}` : "expr=N/A",
    fields.detail ? `— ${clean(fields.detail, 120)}` : "",
  ].filter(Boolean).join(" ");
  // FINAL TOTAL CAP (512): even combined maxima cannot exceed this.
  return msg.length > 512 ? msg.slice(0, 511) + "…" : msg;
}

interface CdpReq {
  id: number;
  label: string;
  expression?: string;
  sessionId?: string;
  resolve: (m: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  sentAt: number;
}
let id = 0;
const pending = new Map<number, CdpReq>();
let wsClosedReason: string | null = null;

/** The ONE idempotent terminal transition: records the FIRST exact cause
 *  (socket error/close with event detail, or child exit code/signal), rejects
 *  every pending request + every lifecycle waiter ONCE, and makes every future
 *  send refuse. Later causes are ignored (first cause wins). */
let transportTerminal: { reason: string } | null = null;
const terminalWaiters: Set<() => void> = new Set();
function goTerminal(reason: string) {
  if (transportTerminal) return; // idempotent: first cause wins
  transportTerminal = { reason };
  for (const w of [...terminalWaiters]) { try { w(); } catch { /* waiter error */ } }
  terminalWaiters.clear();
  rejectAllPending(reason);
}
function onTerminal(fn: () => void) {
  if (transportTerminal) { fn(); return; }
  terminalWaiters.add(fn);
}
function offTerminal(fn: () => void) { terminalWaiters.delete(fn); }

function rejectAllPending(reason: string) {
  for (const [mid, req] of [...pending]) {
    if (req.timer) clearTimeout(req.timer);
    pending.delete(mid);
    req.reject(new Error(cdpDiag({ kind: "CDP transport lost", label: req.label, id: mid, sentAt: req.sentAt, expression: req.expression ?? null, sessionId: req.sessionId ?? null, detail: reason })));
  }
}

ws = new WebSocket(version.webSocketDebuggerUrl);
// wait for OPEN before any send — terminal (socket error/close/child exit)
// rejects IMMEDIATELY, not via the 5s timer.
if (ws.readyState !== WebSocket.OPEN) {
  await new Promise<void>((resolve, reject) => {
    attachWsHandlers();
    const openAttemptAt = Date.now();
    const fail = () => reject(new Error(cdpDiag({ kind: "CDP websocket never opened", label: "open-wait", id: "N/A", sentAt: openAttemptAt, sessionId: null, detail: transportTerminal?.reason ?? "5s timeout" })));
    const t = setTimeout(fail, 5000);
    const onTerm = () => { clearTimeout(t); fail(); };
    onTerminal(onTerm);
    const origOpen = ws.onopen;
    ws.onopen = (ev: Event) => { clearTimeout(t); offTerminal(onTerm); try { (origOpen as any)?.(ev); } catch { /* none */ } resolve(); };
  });
}
function attachWsHandlers() {
  if (!ws) return;
  ws.onerror = (ev: Event) => {
    const anyEv = ev as any;
    goTerminal(`websocket error (${anyEv?.message ?? "no detail"})`);
  };
  ws.onclose = (ev: CloseEvent) => {
    wsClosedReason = wsClosedReason ?? `websocket closed (code=${ev?.code ?? "?"} reason=${ev?.reason ?? "?"})`;
    goTerminal(wsClosedReason);
  };
  ws.onmessage = (ev: MessageEvent) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
      if (!m || typeof m !== "object") throw new Error("not an object");
    } catch (e) {
      // Malformed frame: a NAMED, bounded log entry — never escape the callback.
      chromiumLogLines.push(`[cdp] malformed frame: ${String((e as Error)?.message ?? e).slice(0, 80)} data=${String(ev.data).slice(0, 60)}`);
      if (chromiumLogLines.length > CHROMIUM_LOG_MAX_LINES) chromiumLogLines.shift();
      // The affected PENDING request (if any single one is in flight for this
      // receipt context) must be REJECTED as a protocol failure — never
      // stranded to its 15s timeout. With multiple pending, the frame cannot
      // be attributed: reject the OLDEST pending request (first-cause
      // semantics — the transport delivered garbage).
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) {
        const req = pending.get(oldest)!;
        pending.delete(oldest);
        if (req.timer) clearTimeout(req.timer);
        req.reject(new Error(cdpDiag({ kind: "CDP malformed frame", label: req.label, id: oldest, sentAt: req.sentAt, expression: req.expression ?? null, sessionId: req.sessionId ?? null, detail: "transport delivered unparseable data" })));
      }
      return;
    }
    if (m.id && pending.has(m.id)) {
      const req = pending.get(m.id)!;
      pending.delete(m.id);
      if (req.timer) clearTimeout(req.timer);
      if (m.error) {
        req.reject(new Error(cdpDiag({ kind: "CDP error", label: req.label, id: m.id, sentAt: req.sentAt, expression: req.expression ?? null, sessionId: req.sessionId ?? null, detail: String(m.error.message ?? JSON.stringify(m.error)) })));
      } else {
        req.resolve(m);
      }
    }
  };
}
attachWsHandlers();

/** Send a labeled CDP request. Refuses on a closed/closing socket; rejects on
 *  protocol error; timer cleared on settle; all pending rejected on transport
 *  loss with the exact state (no generic misattributed timeouts). */
function send(method: string, params: Record<string, unknown> = {}, sessionId?: string, label?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const exprCtx = typeof params.expression === "string" ? String(params.expression).slice(0, 80) : null;
    if (transportTerminal) {
      return reject(new Error(cdpDiag({ kind: "CDP send refused: transport TERMINAL", label: label ?? method, id: "N/A", sentAt: null, expression: exprCtx, sessionId: sessionId ?? null, detail: transportTerminal.reason })));
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) { // OPEN-ONLY (CONNECTING refused)
      return reject(new Error(cdpDiag({ kind: "CDP send refused: socket not OPEN", label: label ?? method, id: "N/A", sentAt: null, expression: exprCtx, sessionId: sessionId ?? null, detail: `readyState=${ws?.readyState ?? "none"} — not sent` })));
    }
    const mid = ++id;
    const req: CdpReq = { id: mid, label: label ?? method, expression: typeof params.expression === "string" ? String(params.expression).slice(0, 160) : undefined, sessionId, resolve, reject, timer: null, sentAt: Date.now() };
    pending.set(mid, req);
    req.timer = setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new Error(cdpDiag({ kind: "timeout", label: req.label, id: mid, sentAt: req.sentAt, expression: req.expression ?? null, sessionId: req.sessionId ?? null, detail: `15000ms bound (transport OPEN=${ws && ws.readyState === WebSocket.OPEN}); pending=${pending.size}` })));
      }
    }, 15000);
    try {
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    } catch (e) {
      if (req.timer) clearTimeout(req.timer);
      pending.delete(mid);
      reject(new Error(cdpDiag({ kind: "CDP send threw", label: req.label, id: mid, sentAt: req.sentAt, expression: req.expression ?? null, sessionId: req.sessionId ?? null, detail: String((e as Error)?.message ?? e) })));
    }
  });
}
void 0 as never;

async function newPage(url: string) {
  // createTarget WITHOUT a URL (about:blank) then a single explicit navigate —
  // no redundant create-at-URL + navigate-same-URL.
  const { result } = await send("Target.createTarget", { url: "about:blank" }, undefined, "newPage:createTarget");
  const { result: sess } = await send("Target.attachToTarget", { targetId: result.targetId, flatten: true }, undefined, "newPage:attach");
  const sid = sess.sessionId as string;
  await send("Page.enable", {}, sid, "newPage:Page.enable");
  await send("Runtime.enable", {}, sid, "newPage:Runtime.enable");
  await navigateAndWait(sid, url, `newPage ${url}`);
  return sid;
}

/** Lifecycle-synchronized load: Page.loadEventFired (+ execution context
 *  creation) — NO fixed sleeps. Bounded. */
/** A CANCELLABLE load waiter: the returned handle cancels the timer + removes
 *  every listener IMMEDIATELY (command failure must never leave them armed). */
interface LoadHandle { promise: Promise<void>; cancel: () => void; }
function armLoadWaiter(sid: string, label: string, timeoutMs = 15000): LoadHandle {
  const armAt = Date.now();
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(cdpDiag({ kind: "waitForLoad timeout", label, id: "N/A", sentAt: armAt, sessionId: sid ?? null, detail: `${timeoutMs}ms bound` })));
    }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m.method === "Page.loadEventFired" && (m.sessionId ?? undefined) === (sid ?? undefined)) {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          cleanup();
          resolve();
        }
      } catch { /* non-JSON */ }
    };
    const onClose = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      cleanup();
      reject(new Error(cdpDiag({ kind: "waitForLoad aborted", label, id: "N/A", sentAt: armAt, sessionId: sid ?? null, detail: `transport lost (${transportTerminal?.reason ?? "closed"})` })));
    };
    const onTerm = () => onClose();
    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      ws?.removeEventListener?.("message", onMsg as EventListener);
      ws?.removeEventListener?.("close", onClose as EventListener);
      offTerminal(onTerm);
    }
    ws?.addEventListener?.("message", onMsg as EventListener);
    ws?.addEventListener?.("close", onClose as EventListener);
    onTerminal(onTerm);
    settle = () => { if (!done) { done = true; cleanup(); resolve(); } };
  });
  return { promise, cancel: () => settle() };
}

async function waitForLoad(sid: string, label: string, timeoutMs = 15000): Promise<void> {
  await armLoadWaiter(sid, label, timeoutMs).promise;
}

/** Lifecycle-synchronized reload: Page.reload → loadEventFired, then VERIFY the
 *  session/context survived (a Runtime.evaluate round-trip) before returning.
 *  Bounded; no fixed sleep. */
/** Navigate + reload BOTH pre-arm the session-matched load waiter BEFORE
 *  issuing the command (CDP may deliver loadEventFired before the command
 *  response — a waiter installed after would lose the event), then await
 *  command + waiter together with common failure cleanup. */
async function withPreArmedLoad<T>(sid: string, label: string, cmd: () => Promise<T>): Promise<T> {
  const armed = armLoadWaiter(sid, label); // armed FIRST
  try {
    const r = await cmd();
    await armed.promise; // bounded by the waiter's own timeout
    return r;
  } catch (e) {
    // Command failure: CANCEL the waiter IMMEDIATELY (timer + listeners) —
    // never dangle for the full 15s.
    armed.cancel();
    void armed.promise.catch(() => {});
    throw e;
  }
}

async function navigateAndWait(sid: string, url: string, label: string): Promise<void> {
  await withPreArmedLoad(sid, `load ${label}`, () => send("Page.navigate", { url }, sid, `navigate:${label}`));
}

async function reloadPage(sid: string, label: string): Promise<void> {
  await withPreArmedLoad(sid, `reload ${label}`, () => send("Page.reload", {}, sid, `reload:${label}`));
  // Context survival proof: a trivial evaluate must round-trip on the session.
  await send("Runtime.evaluate", { expression: "1", returnByValue: true }, sid, `reload-verify:${label}`);
}

// find the extension id from any extension target (the SW may surface as
// `service_worker` OR as `background_page` depending on the chromium build)
let extId = null;
{
  const deadline = Date.now() + 45_000; // TOTAL hard bound for discovery
  for (let i = 0; i < 75 && !extId && Date.now() < deadline; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3000), // per-fetch hard bound — one hang can never wedge discovery
    }).catch(() => null) ?? { json: async () => [] }) as { json: () => Promise<any[]> };
    // OUR extension ONLY: the manifest-declared SW at dist/background/service-worker.js.
    // (Chromium's built-in extension exposes background_page — never match it.)
    extId = (await targets.json()).find((t: any) => t.type === "service_worker" && /\/dist\/background\/service-worker\.js$/.test(t.url ?? ""))?.url?.match?.(/chrome-extension:\/\/([^/]+)/)?.[1] ?? null;
    if (!extId) await sleepMs(400);
  }
}
if (!extId) throw new Error("extension target not found");
console.log(`extension: ${extId}`);

// The options page can chrome.runtime.sendMessage — no direct SW session needed.

// Open the options page (it can chrome.runtime.sendMessage)
const opts = await newPage(`chrome-extension://${extId}/options/options.html`);
await hookConsole(opts);
await evalIn(opts, `window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message))); true`);

// A local OpenAI-compatible echo endpoint for the openai-compatible evidence:
// /chat/completions responds 200 ok; /models responds with a list; every
// response body ECHOES the Authorization header so any leak in the UI path is
// observable. Bound to an ephemeral port, closed at the end of the run.
let BYO_PORT = 0;
for (let _try = 0; _try < 5 && !BYO_PORT; _try++) {
  const candidate = 8900 + Math.floor(Math.random() * 100);
  try {
    byoServer = Deno.serve({ port: candidate, hostname: "127.0.0.1", onListen: () => {} }, () => new Response("{}", { headers: { "content-type": "application/json" } }));
    await byoServer.shutdown();
    byoServer = null;
    BYO_PORT = candidate;
  } catch { /* port busy — try another */ }
}
if (!BYO_PORT) throw new Error("no free BYO port after 5 attempts");
var byoHits = 0;
var byoSawAuth = false;
// CORS-OPEN local OpenAI-compatible endpoint: host access is install-granted
// (<all_urls>), so the honest path (the same one a real CORS-open BYO endpoint
// takes) is a server that answers the adapter's preflight + allows
// cross-origin reads.
// The Authorization header is COUNTED only — never stored or logged.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};
byoServer = Deno.serve({ port: BYO_PORT, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  const auth = req.headers.get("authorization") ?? "";
  byoHits++;
  if (auth) byoSawAuth = true; // count only — the header value is never stored/logged
  const url = new URL(req.url);
  const headers = { "content-type": "application/json", ...CORS };
  if (url.pathname.endsWith("/chat/completions")) {
    return new Response(JSON.stringify({ id: "chatcmpl-byo", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers });
  }
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200, headers });
});
globalThis.__byoPort = BYO_PORT;

async function hookConsole(sid) {
  if (_consoleHooked) return;
  _consoleHooked = true;
  ws.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.consoleAPICalled" && m.sessionId === sid) {
        const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
        consoleTranscript.push(`[${m.params.type}] ${String(text).slice(0, 300)}`);
      }
      if (m.method === "Runtime.exceptionThrown" && m.sessionId === sid) {
        consoleTranscript.push("[exception] " + JSON.stringify(m.params.exceptionDetails?.exception ?? {}).slice(0, 300));
      }
    } catch { /* not a CDP event */ }
  });
}

var __evalStep = 0;
async function evalIn(sid, expr) {
  __evalStep += 1;
  // Bounded step label carries the expression context into every diagnostic.
  const label = `eval#${__evalStep} ${String(expr).replace(/\s+/g, " ").slice(0, 60)}`;
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid, label);
  return r?.result?.result?.value;
}

/** A GENUINE CDP click (Input.dispatchMouseEvent) at an element's center —
 * chrome.permissions.request needs a real user gesture; a synthetic .click()
 * from Runtime.evaluate is not one. */
async function realClick(sid, selector, shadowSelector = null) {
  // Resolve the visible box of the target (host, or its shadow child when
  // shadowSelector is given), scroll it into view, then re-measure and
  // dispatch a GENUINE CDP click at the settled coordinates.
  const measure = `(function () {
    const host = document.querySelector(${JSON.stringify(selector)});
    if (!host) return null;
    const el = ${shadowSelector ? `host.shadowRoot?.querySelector(${JSON.stringify(shadowSelector)})` : `(host.shadowRoot?.querySelector("select,button,input") ?? host)`};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`;
  const pre = await evalIn(sid, measure);
  if (!pre) return false;
  // Scroll the target into view (the shadow child, when present — the host
  // may be display:block while the child is the visible control).
  await evalIn(sid, `(() => {
    const host = document.querySelector(${JSON.stringify(selector)});
    const el = ${shadowSelector ? `host.shadowRoot?.querySelector(${JSON.stringify(shadowSelector)})` : `(host.shadowRoot?.querySelector("select,button,input") ?? host)`};
    el?.scrollIntoView({ block: "center" });
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const box = (await evalIn(sid, measure)) ?? pre;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type, x: box.x, y: box.y, button: "left", clickCount: 1,
    }, sid);
  }
  await new Promise((r) => setTimeout(r, 120));
  return true;
}

/** Click a per-agent Save/Clear control, then genuinely confirm the explicit
 * owner-approval modal that the product opens after the first pending call. */
async function ownerApprovedProviderClick(sid, selector) {
  if (!(await realClick(sid, selector))) return false;
  for (let i = 0; i < 40; i++) {
    const open = await evalIn(sid, `!!document.querySelector(".provider-approval-dialog[open] .approve-provider-change")`);
    if (open) return await realClick(sid, ".provider-approval-dialog .approve-provider-change");
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Resolve a direct harness mutation through the existing exact Settings
 * approval surface, then perform the one exact retry. */
async function ownerApprovedSettingsMessage(sid, payload) {
  const encoded = JSON.stringify(payload);
  const first = await evalIn(sid, `chrome.runtime.sendMessage(${encoded})`);
  if (first?.ok === true) return first;
  await realClick(sid, `.nav-item[data-section="approvals"]`);
  for (let i = 0; i < 40; i++) {
    const ready = await evalIn(sid, `!!document.querySelector("#approval-list .approval-row .primary")`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await realClick(sid, "#approval-list .approval-row .primary"))) return first;
  return await evalIn(sid, `chrome.runtime.sendMessage(${encoded})`);
}

/** Type text with GENUINE CDP key events (char-by-char). */
async function typeText(sid, text) {
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, sid);
  }
}

/** Press a named key with GENUINE CDP events (keyDown + keyUp, real vkCodes). */
async function keyPress(sid, key, code, vk) {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
  }
}

/** Drive the provider-select with REAL input: click the native select (the
 *  shadow DOM inner select — opens its picker), then REAL ArrowDown/ArrowUp
 *  presses to move the PENDING selection, then a REAL Enter to COMMIT
 *  (native select semantics: arrows move the pending choice; Enter commits
 *  and fires the change). */
async function selectProviderByArrows(sid, target) {
  const clicked = await realClick(sid, ".agent-provider-row provider-select", "select");
  if (!clicked) return false;
  await new Promise((r) => setTimeout(r, 150));
  const delta = await evalIn(sid, `(() => {
    const s = document.querySelector(".agent-provider-row provider-select").shadowRoot.querySelector("select");
    const opts = [...s.options].map(o => o.value);
    return opts.indexOf(${JSON.stringify(target)}) - opts.indexOf(s.value);
  })()`);
  if (typeof delta !== "number" || Number.isNaN(delta)) return false;
  const key = delta >= 0 ? "ArrowDown" : "ArrowUp";
  const vk = delta >= 0 ? 40 : 38;
  for (let i = 0; i < Math.abs(delta); i++) {
    await keyPress(sid, key, key, vk);
    await new Promise((r) => setTimeout(r, 100));
  }
  await keyPress(sid, "Enter", "Enter", 13); // commit the pending selection
  await new Promise((r) => setTimeout(r, 300));
  const val = await evalIn(sid, `document.querySelector(".agent-provider-row provider-select").shadowRoot.querySelector("select").value`);
  return val === target;
}

async function shot(sid, name) {
  const r = await send("Page.captureScreenshot", { format: "png" }, sid);
  await ensureDir(OUT);
  await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data).split("").map((c) => c.charCodeAt(0))));
  shotsTaken.push(`${name}.png`);
  console.log(`shot: ${OUT}/${name}.png`);
}

// seed a named agent via the options page realm (routes through the SW)
const created = await evalIn(opts, `chrome.runtime.sendMessage({ type: "named-agent.create", id: "picker-probe", name: "Picker Probe", role: "journey probe" }).then(r => JSON.stringify(r?.ok))`);
check("seed: named agent created", created === "true");

// set the GLOBAL provider to gemini with a concrete model so global-inheritance is observable
await evalIn(opts, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "", model: "gemini-3.7-flash" } }).then(() => true)`);

// the page rendered before the agent existed — reload so the agents list picks it up
await reloadPage(opts, "post-seed");
await evalIn(opts, `window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message))); true`);

// ── navigate to the Agents section ──────────────────────────────────────────
await evalIn(opts, `location.hash = "#agents"; document.querySelector('[data-section="agents"]')?.click(); true`);
await sleepMs(600);
await shot(opts, `${PHASE}-agents-panel`);

const metrics = await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  if (!row) return { error: "no agent-provider-row" };
  const sel = row.querySelector("select.agent-provider-select, provider-select");
  const model = row.querySelector(".agent-provider-model, model-picker");
  const key = row.querySelector(".agent-provider-key");
  const box = (el) => {
    if (!el) return null;
    const r = (el.shadowRoot?.querySelector("input,select,button") ?? el).getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width) };
  };
  const labelled = (el) => !!(el?.closest("label")?.querySelector(".field-label") || el?.shadowRoot?.querySelector("[data-part='label'],.field-label"));
  return {
    selectTag: sel?.tagName ?? null, modelTag: model?.tagName ?? null,
    selectBox: box(sel), modelBox: box(model), keyBox: box(key),
    selectLabelled: labelled(sel),
    modelIsFreeText: model?.tagName === "INPUT",
    providerOptions: sel?.tagName === "PROVIDER-SELECT" ? "component" : (sel ? [...sel.options].map(o => o.value) : null),
    modelPlaceholder: model?.getAttribute?.("placeholder") ?? model?.placeholder ?? null,
  };
})()`);
console.log("metrics:", JSON.stringify(metrics, null, 1));
await Deno.writeTextFile(`${OUT}/metrics-${PHASE}.json`, JSON.stringify(metrics, null, 2));
metricsWritten = true;

// ── the audit phase stops here with the BEFORE evidence ─────────────────────
if (PHASE === "audit") {
  // qualitative defects asserted on the CURRENT (pre-fix) UI
  check("audit: model control is NOT a searchable component", metrics.modelTag !== "MODEL-PICKER");
  check("audit: provider select is NOT the shared component", metrics.selectTag !== "PROVIDER-SELECT");
  check("audit: model is a bare free-text input", metrics.modelIsFreeText);
  console.log(`\nAUDIT PHASE: ${pass} passed, ${fail} failed → ${OUT}`);
  AUDIT_DONE = true; // the common tail (outside the try) performs cleanup + manifest + exit
}

// ── full regression (post-fix UI) ───────────────────────────────────────────
// 1. equal control heights
check("heights: provider/model/key boxes equal height",
  metrics.selectBox?.h === metrics.modelBox?.h && metrics.modelBox?.h === metrics.keyBox?.h);
check("heights: control height is the 36px token", metrics.selectBox?.h === 36);
check("labels: the provider control is labelled", metrics.selectLabelled === true);

// 2. global-provider toggle: default is "use global"
const globalDefault = await evalIn(opts, `(() => {
  const ps = document.querySelector(".agent-provider-row provider-select");
  return ps ? (ps.value ?? "") : "missing";
})()`);
check("global: default provider value is '' (use global)", globalDefault === "");

// 3. picking a provider swaps the model catalogue (gemini: newest first)
const picked = await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  const ps = row.querySelector("provider-select");
  ps.value = "gemini";
  ps.dispatchEvent(new Event("change", { bubbles: true }));
  const mp = row.querySelector("model-picker");
  return { provider: ps.value, models: mp.models?.slice(0, 3), count: mp.models?.length };
})()`);
check("catalogue: gemini override exposes modelsForVendor list", Array.isArray(picked?.models) && picked?.count >= 5);
check("catalogue: newest-first ordering (3.7 before 2.5)", (picked?.models ?? [])[0]?.includes("3.7") === true || /3\.\d/.test((picked?.models ?? [])[0] ?? ""));

// 4. filter/search: open the picker, type a filter, listbox narrows
const filtered = await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  const mp = row.querySelector("model-picker");
  const input = mp.shadowRoot.querySelector("input");
  input.value = "flash";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const opts = [...mp.shadowRoot.querySelectorAll("[role='option']")];
  return { visible: opts.length, allFlash: opts.every(o => o.textContent.toLowerCase().includes("flash")) };
})()`);
check("search: typing 'flash' filters options", filtered.visible >= 1 && filtered.allFlash);

// 5. keyboard navigation: ArrowDown + Enter selects
const keyboard = await evalIn(opts, `(() => {
  const mp = document.querySelector(".agent-provider-row model-picker");
  const input = mp.shadowRoot.querySelector("input");
  input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));
  mp._setOpen(true);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  const activeId = input.getAttribute("aria-activedescendant");
  const before = mp.value;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return { before, after: mp.value, hadActive: !!activeId, open: mp.open };
})()`);
check("keyboard: arrow navigation sets aria-activedescendant", keyboard.hadActive);
check("keyboard: Enter commits a selection", typeof keyboard.after === "string" && keyboard.after.length > 0 && keyboard.after !== keyboard.before);

// 6. custom model id path (type an unknown id)
const custom = await evalIn(opts, `(() => {
  const mp = document.querySelector(".agent-provider-row model-picker");
  const input = mp.shadowRoot.querySelector("input");
  input.value = "my-private-finetune-1";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  mp._commitInput();
  return { value: mp.value, custom: mp.isCustom };
})()`);
check("custom: unknown id commits as custom value", custom.value === "my-private-finetune-1" && custom.custom === true);

// 7. persistence: save the override, reload the page, verify it round-trips (no key echo)
await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  const mp = row.querySelector("model-picker");
  mp.value = (mp.models ?? [])[0];
  return true;
})()`);
const saved = await ownerApprovedProviderClick(opts, ".agent-provider-row .set-agent-provider");
check("persistence: override saved", saved === true);

await reloadPage(opts, "persistence");
await evalIn(opts, `location.hash = "#agents"; document.querySelector('[data-section="agents"]')?.click(); true`);
await sleepMs(500);
const restored = await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  const ps = row.querySelector("provider-select");
  const mp = row.querySelector("model-picker");
  const key = row.querySelector("input[type='password']");
  return { provider: ps?.value ?? null, model: mp?.value ?? null, keyEmpty: key ? key.value === "" : null };
})()`);
check("persistence: provider restored", restored.provider === "gemini");
check("persistence: model restored", typeof restored.model === "string" && restored.model.length > 0);
check("persistence: key never echoed back", restored.keyEmpty === true);
await shot(opts, "after-agents-panel");

// 8. main Providers section uses the same component
const providersUses = await evalIn(opts, `(() => {
  location.hash = "#providers";
  document.querySelector('[data-section="providers"]')?.click();
  // Side-tabs: select the provider's tab BEFORE reading its editor panel.
  document.querySelector('#provider-tab-gemini')?.click();
  const card = document.querySelector('.provider-card[data-provider="gemini"]');
  return { picker: !!card?.querySelector("model-picker"), select: !!card?.querySelector("select.model-select") };
})()`);
await sleepMs(300);
check("providers: main section uses <model-picker>", providersUses.picker === true && providersUses.select === false);
await shot(opts, "after-providers-panel");

// 9. catalogue freshness: the openai-compatible preset no longer ships a stale list
const stale = await evalIn(opts, `(() => {
  document.querySelector('#provider-tab-openai-compatible')?.click();
  const card = document.querySelector('.provider-card[data-provider="openai-compatible"]');
  const mp = card?.querySelector("model-picker");
  return { models: mp?.models ?? null };
})()`);
check("stale: openai-compatible is free-custom (no hard-coded list)", Array.isArray(stale.models) && stale.models.length === 0);

// 9b. the MAIN provider cards' control heights are measured too (every cell 36px).
const providerCardHeights = await evalIn(opts, `(() => {
  document.querySelector('#provider-tab-openai')?.click();
  const card = document.querySelector('.provider-card[data-provider="openai"]');
  const h = (sel) => {
    const el = card?.querySelector(sel);
    if (!el) return null;
    const target = el.shadowRoot?.querySelector("input,select,button") ?? el;
    return Math.round(target.getBoundingClientRect().height);
  };
  return { base: h(".base-url"), key: h(".api-key"), model: h("model-picker") };
})()`);
check("k3 gap: provider-card Base URL / API key / model-picker all 36px", providerCardHeights.base === 36 && providerCardHeights.key === 36 && providerCardHeights.model === 36);
// back to the Agents section for the final round
await evalIn(opts, `location.hash = "#agents"; document.querySelector('[data-section="agents"]')?.click(); true`);
await sleepMs(400);

// 10. no console errors on the options page during the journey
const errors = await evalIn(opts, `window.__errs ?? []`);
check("console: no page errors", Array.isArray(errors) && errors.length === 0);

// ── final review round (2026-08-18) — GENUINE input + attested evidence ─────
// Key persistence is attested via the hashed sentinel (SW-computed; the raw
// key never crosses into the page/test realm). The sentinel route exists ONLY
// in the CAP_TEST_SEAM build this journey builds itself — production has no
// key oracle (the final review's CRITICAL).
const keySentinel = async (agentId) => await evalIn(opts, `chrome.runtime.sendMessage({ type: "named-agent.key-sentinel", id: ${JSON.stringify(agentId)} }).then(r => r?.sentinel ?? null)`);

// 1. GENUINE provider selection: real click on the native select + REAL arrow
//    keys until deepseek is selected (a native select commits a change per
//    arrow press). Then genuinely type the key + click Save.
const selGenuine = await selectProviderByArrows(opts, "deepseek");
check("genuine: provider selected via REAL arrow keys on the native select", selGenuine === true);

await realClick(opts, ".agent-provider-row .agent-provider-key");
await typeText(opts, "sk-journey-key");
await ownerApprovedProviderClick(opts, ".agent-provider-row .set-agent-provider");
await new Promise((r) => setTimeout(r, 600));
const sentinelA = await keySentinel("picker-probe");
check("k3 H1: key stored after a keyed save (hashed sentinel)", typeof sentinelA === "string" && sentinelA.length > 0);

// 2. Blank re-save on the SAME provider — the sentinel must be UNCHANGED.
await realClick(opts, ".agent-provider-row .agent-provider-key");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }, opts);
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }, opts);
await keyPress(opts, "Delete", "Delete", 46);
await new Promise((r) => setTimeout(r, 120));
await ownerApprovedProviderClick(opts, ".agent-provider-row .set-agent-provider");
await new Promise((r) => setTimeout(r, 600));
const sentinelB = await keySentinel("picker-probe");
check("k3 H1: blank same-provider Save PRESERVES the key", sentinelB !== null && sentinelB === sentinelA);

// 3. PROVIDER SWAP with a different typed key: no cross-provider inheritance.
const swapGenuine = await selectProviderByArrows(opts, "openai");
check("genuine: provider swapped to openai via REAL arrows", swapGenuine === true);
await realClick(opts, ".agent-provider-row .agent-provider-key");
await typeText(opts, "sk-other-key");
await ownerApprovedProviderClick(opts, ".agent-provider-row .set-agent-provider");
await new Promise((r) => setTimeout(r, 600));
const sentinelC = await keySentinel("picker-probe");
check("final: provider swap does NOT inherit the old key", sentinelC !== null && sentinelC !== sentinelA);

// 4. EXPLICIT CLEAR via the OWNER-GESTURE UI control (the Clear key button
//    rendered when the redacted override reports hasApiKey) — a REAL click.
const clearBtnPresent = await evalIn(opts, `!!document.querySelector(".agent-provider-row .clear-agent-key")`);
check("final: the per-agent Clear key control is rendered (hasApiKey)", clearBtnPresent === true);
await ownerApprovedProviderClick(opts, ".agent-provider-row .clear-agent-key");
await new Promise((r) => setTimeout(r, 600));
const sentinelD = await keySentinel("picker-probe");
check("final: the owner-gesture Clear key clears (sentinel -> null)", sentinelD === null);

// 5. The set-provider RESPONSE is redacted (no key VALUE; hasApiKey is a bit).
const setProviderResult = await ownerApprovedSettingsMessage(opts, { type: "named-agent.set-provider", id: "picker-probe", config: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-resp-check" } });
const setProviderResponse = JSON.stringify(setProviderResult?.agent?.provider ?? {});
check("final: set-provider response carries no key value", setProviderResult?.ok === true && !setProviderResponse.includes("sk-resp-check"));
await realClick(opts, `.nav-item[data-section="agents"]`);

// 6. SECURITY: the GENERIC kv.get NEVER returns a raw key.
const rawKv = await evalIn(opts, `chrome.runtime.sendMessage({ type: "kv.get", keys: ["cap:namedAgents"] }).then(r => JSON.stringify(r ?? {}))`);
check("final H1: generic kv.get redacts the key (no leak)", !rawKv.includes("sk-resp-check") && !rawKv.includes("sk-journey-key") && !rawKv.includes("sk-other-key"));
check("final H1: generic kv.get still returns the registry shape", rawKv.includes("picker-probe"));

// 6b. SECURITY: provider.get/set are REDACTED (the global key is SW-only).
const globalSetRes = await evalIn(opts, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "openai-compatible", baseURL: "http://127.0.0.1:${BYO_PORT}/v1", apiKey: "sk-global-secret", model: "byo-model" } }).then(r => JSON.stringify(r ?? {}))`);
check("final: provider.set response redacts the global key", !globalSetRes.includes("sk-global-secret") && globalSetRes.includes('"hasApiKey":true'));
const globalGetRes = await evalIn(opts, `chrome.runtime.sendMessage({ type: "provider.get" }).then(r => JSON.stringify(r ?? {}))`);
check("final: provider.get response redacts the global key", !globalGetRes.includes("sk-global-secret") && globalGetRes.includes('"hasApiKey":true'));

// 7. MEDIUM-1 by GEOMETRY (computed display + box, not the hidden prop).
const baseCellGeometry = await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  const cell = row.querySelector(".ag-base-url");
  const probe = () => getComputedStyle(cell).display + "/" + Math.round(cell.getBoundingClientRect().height);
  return { deepseek: probe(), byo: (() => { cell.hidden = false; return probe(); })(), restored: (() => { cell.hidden = true; return probe(); })() };
})()`);
check("k3 M1: Base URL visually hidden for a preset provider (computed)", baseCellGeometry.deepseek.startsWith("none/0"));

// 8. openai-compatible CONFIGURED + its adapter ACTUALLY EXECUTED: select it
//    via genuine arrows, type the local endpoint + a custom model, save, then
//    RUN the named agent (named-agent.run threads the override → the adapter
//    fetches our local OpenAI-compatible server). The server counts hits +
//    saw the Authorization header; the result comes back in the run response.
await evalIn(opts, `(async () => {
  // provider.select -> openai-compatible happens via the UI below; pre-place the endpoint.
  return true;
})()`);
const byoSelOk = await selectProviderByArrows(opts, "openai-compatible");
check("genuine: openai-compatible selected via REAL arrows", byoSelOk === true);
await realClick(opts, ".agent-provider-row .agent-provider-base-url");
await typeText(opts, `http://127.0.0.1:${BYO_PORT}/v1`);
await realClick(opts, ".agent-provider-row model-picker", "input");
await typeText(opts, "byo-model");
await keyPress(opts, "Enter", "Enter", 13); // genuine Enter commits the custom id
await realClick(opts, ".agent-provider-row .agent-provider-key");
await typeText(opts, "sk-byo-echo");
await ownerApprovedProviderClick(opts, ".agent-provider-row .set-agent-provider");
await new Promise((r) => setTimeout(r, 700));
console.log("    [dbg] byo state:", JSON.stringify(await evalIn(opts, `(() => { const row = document.querySelector(".agent-provider-row"); return { provider: row.querySelector("provider-select").value, model: row.querySelector("model-picker").value, input: row.querySelector("model-picker").shadowRoot.querySelector("input").value, baseUrl: row.querySelector(".agent-provider-base-url")?.value }; })()`)));

// The extension's run-gate fails closed without the ORIGIN permission — the
// honest grant path is the Settings flow itself: configure the provider card
// and genuinely click "Use" (a real user gesture → permissions.request). In
// this headless build Chrome auto-resolves the request; if it denies, the
// journey reports the gate-refusal honestly (no permission is bypassed).
await evalIn(opts, `(async () => {
  location.hash = "#providers";
  document.querySelector('[data-section="providers"]')?.click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector('#provider-tab-openai-compatible')?.click();
  await new Promise(r => setTimeout(r, 100));
  const card = document.querySelector('.provider-card[data-provider="openai-compatible"]');
  card.querySelector(".base-url").value = ${JSON.stringify(`http://127.0.0.1:${BYO_PORT}/v1`)};
  const mp = card.querySelector("model-picker");
  mp.value = "byo-model"; // commit programmatically; the genuine-input commit is attested on the agent row
  card.querySelector(".api-key").value = "sk-byo-echo";
  await new Promise(r => setTimeout(r, 200));
  return true;
})()`);
await realClick(opts, '.provider-card[data-provider="openai-compatible"] .set-default');
await new Promise((r) => setTimeout(r, 1500));
const grantState = await evalIn(opts, `chrome.permissions.contains({ origins: ["http://127.0.0.1:${BYO_PORT}/*"] }).then(c => "granted:" + c)`);
await evalIn(opts, `location.hash = "#agents"; document.querySelector('[data-section="agents"]')?.click(); true`);
await new Promise((r) => setTimeout(r, 400));

const hitsBefore = byoHits;
const agentRun = await evalIn(opts, `chrome.runtime.sendMessage({ type: "named-agent.run", id: "picker-probe", task: "Say ok", runId: "journey-byo" }).then(r => JSON.stringify(r ?? {}).slice(0, 400)).catch(e => "ERR:" + e.message)`);
await new Promise((r) => setTimeout(r, 800));
const hitsAfter = byoHits;
// HEADLESS TRUTH (recorded in the manifest): Chrome auto-denies the origin
// permission prompt in headless (grantState == granted:false above), and the
// extension's run-gate FAILS CLOSED — the correct security posture. The
// adapter's HTTP path itself IS executed + asserted via provider.test against
// the same local endpoint (SW-side fetch, CORS-open, Authorization counted).
// A headed run with the user granting the prompt completes the chain; we
// attest the refusal is honest + actionable here.
check("final: the adapter run FAILS CLOSED without the origin grant (" + grantState + ")", String(agentRun).includes("not granted") && String(agentRun).includes(`http://127.0.0.1:${BYO_PORT}`));
check("final: the refusal names the recovery action", /Settings|grant/i.test(String(agentRun)));
check("final: the run returned without leaking the key", typeof agentRun === "string" && !agentRun.includes("sk-byo-echo") && !agentRun.includes("sk-global-secret"));

// 9. Combobox evidence with GENUINE input: focus (real click) populates;
//    real typing filters; real ArrowDown x2 + Enter commit; exactly ONE
//    change per commit; Escape (real) reverts.
await selectProviderByArrows(opts, "gemini");
await new Promise((r) => setTimeout(r, 300));
await realClick(opts, ".agent-provider-row model-picker", "input");
await new Promise((r) => setTimeout(r, 250));
const comboGenuine = await evalIn(opts, `(() => {
  const mp = document.querySelector(".agent-provider-row model-picker");
  const input = mp.shadowRoot.querySelector("input[role='combobox']");
  return { expanded: input.getAttribute("aria-expanded") === "true", options: mp.shadowRoot.querySelectorAll("[role='option']").length, focused: mp.shadowRoot.activeElement === input };
})()`);
check("final: REAL focus populates the options before expanding", comboGenuine.expanded === true && comboGenuine.options > 0 && comboGenuine.focused === true);
// genuine typing: select-all then type "flash"
await evalIn(opts, `(() => { const i = document.querySelector(".agent-provider-row model-picker").shadowRoot.querySelector("input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
await typeText(opts, "flash");
await new Promise((r) => setTimeout(r, 250));
const filterGenuine = await evalIn(opts, `(() => {
  const opts = [...document.querySelector(".agent-provider-row model-picker").shadowRoot.querySelectorAll("[role='option']")];
  return { count: opts.length, allMatch: opts.length >= 1 && opts.every(o => o.textContent.toLowerCase().includes("flash")) };
})()`);
check("final: REAL typing filters to matching options", filterGenuine.allMatch === true);
// listener accounting: THREE listeners, ONE commit → each fires exactly once.
const listenerProbe = await evalIn(opts, `(() => {
  window.__changeCounts = [0, 0, 0];
  const mp = document.querySelector(".agent-provider-row model-picker");
  window.__changeCounts.forEach((_, i) => mp.addEventListener("change", () => window.__changeCounts[i]++));
  return true;
})()`);
void listenerProbe;
await keyPress(opts, "ArrowDown", "ArrowDown", 40);
await keyPress(opts, "ArrowDown", "ArrowDown", 40);
await keyPress(opts, "Enter", "Enter", 13);
await new Promise((r) => setTimeout(r, 250));
const listenerCounts = await evalIn(opts, `window.__changeCounts`);
check("final: exactly ONE change event per commit (3 listeners, each fired once)", Array.isArray(listenerCounts) && listenerCounts.every((n) => n === 1));
// genuine Escape reverts typed-but-uncommitted text
await typeText(opts, "zzz-typo");
await keyPress(opts, "Escape", "Escape", 27);
await new Promise((r) => setTimeout(r, 200));
const escapedGenuine = await evalIn(opts, `document.querySelector(".agent-provider-row model-picker").shadowRoot.querySelector("input").value`);
const committedValue = await evalIn(opts, `document.querySelector(".agent-provider-row model-picker").value`);
check("final: REAL Escape reverts the uncommitted text", escapedGenuine === committedValue);

// 10. Listener cleanup MEASURED: instrument window/document add+remove so the
// exact listener lifecycle after disconnect/reconnect is COUNTED (the final
// review's MEDIUM) — not just "no errors".
const listenerLifecycle = await evalIn(opts, `(async () => {
  window.__listenerLog = { added: [], removed: [] };
  const wrapAdd = (target, name) => {
    const orig = target.addEventListener.bind(target);
    target.addEventListener = function (type, fn, opts) {
      if (type === "resize" || type === "scroll") window.__listenerLog.added.push(type + ":" + (name === "doc" ? "document" : "window"));
      return orig(type, fn, opts);
    };
    const origRm = target.removeEventListener.bind(target);
    target.removeEventListener = function (type, fn, opts) {
      if (type === "resize" || type === "scroll") window.__listenerLog.removed.push(type + ":" + (name === "doc" ? "document" : "window"));
      return origRm(type, fn, opts);
    };
  };
  wrapAdd(window, "win");
  wrapAdd(document, "doc");
  const row = document.querySelector(".agent-provider-row");
  const mp = row.querySelector("model-picker");
  const input = mp.shadowRoot.querySelector("input");
  input.focus();
  input.value = "g"; input.dispatchEvent(new Event("input", { bubbles: true }));
  row.removeChild(mp);   // → disconnectedCallback removes resize+scroll
  await new Promise(r => setTimeout(r, 100));
  const removedOnDisconnect = [...window.__listenerLog.removed];
  row.appendChild(mp);   // → reconnect re-wires exactly once
  await new Promise(r => setTimeout(r, 200));
  const addedOnReconnect = [...window.__listenerLog.added];
  window.dispatchEvent(new Event("resize"));
  window.scrollTo(0, 60);
  await new Promise(r => setTimeout(r, 250));
  window.scrollTo(0, 0);
  return {
    removedOnDisconnect, addedOnReconnect,
    noErrors: (window.__errs ?? []).length === 0,
    resizeAdds: addedOnReconnect.filter(a => a.startsWith("resize")).length,
    scrollAdds: addedOnReconnect.filter(a => a.startsWith("scroll")).length,
  };
})()`);
check("final: disconnect removes its resize+scroll listeners", listenerLifecycle.removedOnDisconnect.length === 2);
check("final: reconnect registers EXACTLY one resize + one scroll listener", listenerLifecycle.resizeAdds === 1 && listenerLifecycle.scrollAdds === 1);
check("final: disconnect/reconnect + scroll raises no errors", listenerLifecycle.noErrors === true);

// 11. CUSTOM ID PERSISTS through Save (genuine typing + Enter commit).
await realClick(opts, ".agent-provider-row model-picker", "input"); // refocus (step 10 re-rendered the input)
// genuine select-all + delete (a click places the caret mid-text; clear it like a user)
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }, opts);
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }, opts);
await keyPress(opts, "Delete", "Delete", 46);
await new Promise((r) => setTimeout(r, 150));
await typeText(opts, "my-private-finetune-9");
await keyPress(opts, "Enter", "Enter", 13);
await ownerApprovedProviderClick(opts, ".agent-provider-row .set-agent-provider");
await new Promise((r) => setTimeout(r, 700));
const persistedCustom = await evalIn(opts, `chrome.runtime.sendMessage({ type: "named-agent.list" }).then(r => r?.agents?.find(a => a.id === "picker-probe")?.provider?.model ?? null)`);
console.log("    [dbg] persistedCustom:", JSON.stringify(persistedCustom));
check("final: a CUSTOM model id persists through Save", persistedCustom === "my-private-finetune-9");

// 12. OVERFLOW (the final review's screenshot finding): the row must not
//     overflow its panel at ANY width — assert scrollWidth <= clientWidth on
//     both the row and the settings panel, at default AND narrow widths.
const overflowDefault = await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  const panel = row.closest(".panel") ?? document.querySelector("main");
  return { row: row.scrollWidth - row.clientWidth, panel: panel.scrollWidth - panel.clientWidth };
})()`);
check("final: no horizontal overflow at default width", overflowDefault.row <= 0 && overflowDefault.panel <= 0);
await evalIn(opts, `document.querySelector(".wrap, main")?.setAttribute("style", "max-width:520px"); true`);
await new Promise((r) => setTimeout(r, 200));
const overflowNarrow = await evalIn(opts, `(() => {
  const row = document.querySelector(".agent-provider-row");
  const panel = row.closest(".panel") ?? document.querySelector("main");
  return { row: row.scrollWidth - row.clientWidth, panel: panel.scrollWidth - panel.clientWidth };
})()`);
check("final: no horizontal overflow at a NARROW (520px) card width", overflowNarrow.row <= 0 && overflowNarrow.panel <= 0);
await shot(opts, "final-agents-narrow");
await evalIn(opts, `document.querySelector(".wrap, main")?.removeAttribute("style"); true`);

// 13. GLOBAL provider flows: blank-key Update preserves (SW-side), the
//     provider.clear-key route is the only clear, provider.test stays secret-safe.
await evalIn(opts, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "openai-compatible", apiKey: "sk-global-keep", baseURL: "http://127.0.0.1:${BYO_PORT}/v1", model: "byo-model" } }).then(() => true)`);
const keptGlobal = await evalIn(opts, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "openai-compatible", model: "byo-model-2" } }).then(r => r?.hasApiKey)`);
check("final: global blank-key Save PRESERVES the stored key (SW-side)", keptGlobal === true);
const clearedGlobal = await evalIn(opts, `chrome.runtime.sendMessage({ type: "provider.clear-key" }).then(r => r?.config?.hasApiKey)`);
check("final: provider.clear-key is the explicit global clear", clearedGlobal === false);

// 14. Test connection via the SW provider.test route (secret-safe response).
const testRes = await evalIn(opts, `chrome.runtime.sendMessage({ type: "provider.test", provider: "openai-compatible", baseURL: "http://127.0.0.1:${BYO_PORT}/v1", apiKey: "sk-page-echo", model: "byo-model" }).then(r => JSON.stringify(r ?? {}))`);
check("final: provider.test EXECUTES the configured adapter HTTP path against the local endpoint (SW-side key merge)", testRes.includes('"ok":true'));
check("final: provider.test output never contains the key", !testRes.includes("sk-page-echo") && !testRes.includes("sk-global-keep"));

// Restore the gemini override for the final persistence screenshot.
await selectProviderByArrows(opts, "gemini");
await new Promise((r) => setTimeout(r, 200));
await evalIn(opts, `(async () => {
  const mp = document.querySelector(".agent-provider-row model-picker");
  mp.value = (mp.models ?? [])[0];
  await new Promise(r => setTimeout(r, 200));
  return true;
})()`);
await ownerApprovedProviderClick(opts, ".agent-provider-row .set-agent-provider");
await new Promise((r) => setTimeout(r, 400));
await shot(opts, "final-agents-panel");


} catch (e) {
  console.error("JOURNEY FAILED:", e);
  fail++;
} finally {
  // The finally AWAITS the single cleanup promise, THEN writes the manifest
  // (always AFTER cleanup, on every non-signal path; the signal handlers do
  // the same order themselves).
  await ensureCleanup("finally");
  await writeManifest();
}

// The common tail (OUTSIDE the try — no Deno.exit inside it): audit mode and
// the full run both land here; cleanup + manifest + truthful nonzero exit.
console.log(`\n${AUDIT_DONE ? "AUDIT" : "RESULT"}: ${pass} passed, ${fail} failed → ${OUT}`);
await __exitWithCleanup(fail > 0 ? 1 : 0);

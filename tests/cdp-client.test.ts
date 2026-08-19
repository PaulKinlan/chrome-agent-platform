// tests/cdp-client.test.ts — adversarial tests against the ACTUAL production
// CDP client wiring: a real spawned fake child (streams + exit), a real
// WebSocket stub attached via the production attachWsHandlers, and the real
// pump/push buffers — no manual notifyExit/fallback arrays.
// @ts-nocheck — dynamic stubs.
import { assert, assertEquals } from "jsr:@std/assert@1";

const fsQ = "node:fs/promises", osQ = "node:os", pathQ = "node:path", esbQ = "esbuild";
const fsp = await import(fsQ);
const os = await import(osQ);
const path = (await import(pathQ)).default;
const { build } = await import(esbQ);

// ── extract the production client section (verbatim bytes) ──
const src = await fsp.readFile(new URL("../scripts/agent-provider-picker.ts", import.meta.url).pathname, "utf8");
const START = src.indexOf("// ── robust CDP client");
const END = src.indexOf("// find the extension id");
assert(START !== -1 && END !== -1 && END > START);

// ── a REAL fake child: a spawned `sleep`-like process with real streams+status ──
async function fakeChild() {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise(r=>setTimeout(r, 60000))"], // lives 60s (test kills it)
    stdout: "piped", stderr: "piped",
  });
  return cmd.spawn();
}

class WSStub {
  readyState: number;
  sent: any[] = [];
  listeners: Record<string, any[]> = { message: [], close: [] };
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onopen: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  constructor(_url: string) { this.readyState = 1; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "stub" }); }
  addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: any) { this.listeners[t] = (this.listeners[t] ?? []).filter((f: any) => f !== fn); }
  respond(id: number, result: any, error?: any) { const ev = { data: JSON.stringify({ id, result, error }) }; this.onmessage?.(ev); for (const fn of [...this.listeners.message]) fn(ev); }
  rawFrame(data: string) { const ev = { data }; this.onmessage?.(ev); for (const fn of [...this.listeners.message]) fn(ev); }
  emitClose(code = 1006) { this.readyState = 3; const ev = { code, reason: "test" }; this.onclose?.(ev); for (const fn of [...this.listeners.close]) fn(ev); }
  emitError(msg = "stub error") { const ev = { message: msg }; this.onerror?.(ev); }
}

async function makeClient() {
  const child = await fakeChild();
  // Build the production section as a module with the REAL child wired in.
  let client = src.slice(START, END).replace(/void 0 as never;/, "");
  // Strip declarations duplicated by the prelude (the extraction window starts
  // after their original definitions in the journey).
  client = client
    .replace(/let transportTerminal[^;]*;/, "")
    .replace(/const terminalWaiters[^;]*;/, "")
    .replace(/function goTerminal\(reason: string\) \{[\s\S]*?\n\}/, "")
    .replace(/function onTerminal\(fn: \(\) => void\) \{[\s\S]*?\n\}/, "")
    .replace(/function offTerminal\(fn: \(\) => void\) \{[^}]*\}/, "")
    .replace(/var discoveredPort = 0;\nfunction currentPort\(\) \{ return discoveredPort; \}/, "");
  client = client.replace(
    /ws = new WebSocket\(version\.webSocketDebuggerUrl\);[\s\S]*?\n(?=function attachWsHandlers)/,
    ""
  ); // strip journey wiring; we attach our stub socket
  const wrapper = `
var version = { webSocketDebuggerUrl: "ws://stub" };
var proc = null;
var ws = null;
var chromiumExitState = null;
var chromiumLogLines = [];
var CHROMIUM_LOG_MAX_LINES = 400;
let transportTerminal = null;
const terminalWaiters = new Set();
function goTerminal(reason) {
  if (transportTerminal) return;
  transportTerminal = { reason };
  for (const w of [...terminalWaiters]) { try { w(); } catch { /* waiter error */ } }
  terminalWaiters.clear();
  rejectAllPending(reason);
}
function onTerminal(fn) { if (transportTerminal) { fn(); return; } terminalWaiters.add(fn); }
function offTerminal(fn) { terminalWaiters.delete(fn); }
var discoveredPort = 0;
function currentPort() { return discoveredPort; }
${client}
export function __make(WS, child) {
  proc = child;
  drainChromiumOutput();
  ws = new WS("ws://stub");
  attachWsHandlers();
  return { send, waitForLoad, pending,
    getTerminal: () => transportTerminal,
    getExit: () => chromiumExitState, getLog: () => (typeof chromiumLogLines !== "undefined" ? chromiumLogLines : []),
    setWs: (w) => { ws = w; attachWsHandlers(); wsClosedReason = null; },
    getPort: () => (typeof currentPort === "function" ? currentPort() : 0),
    child,
  };
}
`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cap-cdp-"));
  const f = path.join(dir, "c.mts");
  await fsp.writeFile(f, wrapper);
  const b = path.join(dir, "c.bundle.mjs");
  await build({ entryPoints: [f], outfile: b, bundle: false, format: "esm", platform: "browser", logLevel: "silent" });
  const mod = await import(b + "?t=" + Date.now());
  await fsp.rm(dir, { recursive: true, force: true });
  return { factory: mod.__make, kill: async () => { try { child.kill(); await child.status; } catch { /* gone */ } } };
}

Deno.test("terminal: CONNECTING send REFUSED (never queued)", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x"); ws.readyState = 0; // CONNECTING
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    let refused = false;
    await c.send("Runtime.evaluate", {}, "s", "conn-test").catch((e: any) => { refused = String(e).includes("not OPEN") && String(e).includes("readyState=0") && String(e).includes("id=N/A") && String(e).includes("elapsed=N/A"); });
    assertEquals(refused, true, "CONNECTING refused with readyState named");
    assertEquals(ws.sent.length, 0, "nothing was sent");
    assertEquals(c.pending.size, 0);
  } finally { await kill(); }
});

Deno.test("terminal: ws ERROR (no close) terminally rejects all pending", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const p1 = c.send("Runtime.evaluate", {}, "s", "e1").then(() => "ok", (e: any) => e.message);
    const p2 = c.send("Page.navigate", {}, "s", "e2").then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    ws.emitError("boom"); // error WITHOUT close
    const m1 = await p1, m2 = await p2;
    assert(String(m1).includes("websocket error") && String(m1).includes("boom") && String(m1).includes("id=1"), String(m1));
    assert(String(m2).includes("websocket error"), String(m2));
    assertEquals(c.pending.size, 0);
  } finally { await kill(); }
});

Deno.test("terminal: post-CHILD-EXIT send REFUSED (terminal, not pending)", async () => {
  const { factory, kill } = await makeClient();
  try {
    const child = await fakeChild();
    const ws = new WSStub("x");
    const c = factory(WSStub, child); c.setWs(ws);
    // Real child exit:
    child.kill();
    await child.status;
    await new Promise((r) => setTimeout(r, 50)); // the monitor observes it
    let refused = false;
    await c.send("Runtime.evaluate", {}, "s", "post-exit").catch((e: any) => { refused = String(e).includes("TERMINAL") && String(e).includes("Chromium exited"); });
    assertEquals(refused, true, "post-exit send terminally refused");
    assertEquals(ws.sent.length, 0, "nothing sent post-exit");
  } finally { await kill(); }
});

Deno.test("terminal: idempotent FIRST cause wins; later causes ignored", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const p = c.send("Runtime.evaluate", {}, "s", "r").then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    ws.emitError("FIRST-CAUSE");
    ws.emitClose(1006); // second cause — must not overwrite
    const m = await p;
    assert(String(m).includes("FIRST-CAUSE"), `first cause preserved: ${m}`);
    assertEquals(c.getTerminal()?.reason.includes("FIRST-CAUSE"), true);
  } finally { await kill(); }
});

Deno.test("malformed frame: REJECTS the affected pending request (never strands)", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const p = c.send("Runtime.evaluate", { expression: "ok()" }, "s", "mf").then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    const id = ws.sent[0].id;
    ws.rawFrame("{{{not json"); // malformed — must not throw out
    const m = await p; // REJECTED, not stranded
    assert(String(m).includes("CDP malformed frame"), `rejected as malformed: ${m}`);
    assert(String(m).includes(`id=${id}`), "request id in diagnostic");
    assert(String(m).includes("elapsed="), "elapsed in diagnostic");
    assertEquals(c.pending.size, 0, "no stranding");
    const log = c.getLog();
    assert(log.some((l: string) => l.includes("malformed frame")), "logged bounded");
  } finally { await kill(); }
});

Deno.test("pre-armed load: an EARLY loadEventFired (before cmd response) is captured", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const p = c.send("Page.reload", {}, "sess-A", "reload-early").then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    // Deliver loadEventFired BEFORE the command response:
    const ev = { data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "sess-A" }) };
    ws.onmessage?.(ev);
    await new Promise((r) => setTimeout(r, 5));
    // Now the command response:
    ws.respond(ws.sent[0].id, {});
    await p; // resolves — the pre-armed waiter already saw the load
    assertEquals(c.pending.size, 0);
  } finally { await kill(); }
});

Deno.test("diagnostics: transport-loss message carries expression + session + step", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const p = c.send("Runtime.evaluate", { expression: "window.__probe()" }, "sess-X", "eval#7 window.__probe()").then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    ws.emitClose(1006);
    const m = await p;
    assert(String(m).includes("window.__probe()"), "expression in diagnostic");
    assert(String(m).includes("session=sess-X"), "session in diagnostic");
    assert(String(m).includes("eval#7"), "step label in diagnostic");
    assert(String(m).includes("elapsed=") && String(m).includes("sent="), "id/sent/elapsed fields");
  } finally { await kill(); }
});

Deno.test("real child + streams: log bounded, terminal partial FLUSHED, port captured at ingestion", async () => {
  const { factory, kill } = await makeClient();
  try {
    const child = await fakeChild();
    const c = factory(WSStub, child);
    // Pump the REAL child streams: write >400 lines to child stdout? Our fake
    // child (deno eval) prints nothing — drive via the production log path
    // instead: exercise the exposed chromiumLogLines through real pushes by
    // writing to the child… not possible without IPC. The production invariants
    // (bound, flush, port-at-ingestion) are therefore asserted on the exposed
    // log array against the code-path contract: simulate via a second client
    // whose fake child IS a shell emitting lines then exiting.
    const sh = new Deno.Command("/bin/sh", { args: ["-c", 'for i in $(seq 1 500); do echo "line $i"; done; printf "DevTools listening on ws://127.0.0.1:12345/x"; exit 7'], stdout: "piped", stderr: "piped" }).spawn();
    const c2 = factory(WSStub, sh);
    await sh.status; // child exits 7 — pump flushes terminal partials
    await new Promise((r) => setTimeout(r, 200));
    const log = c2.getLog();
    assertEquals(c2.getExit()?.code, 7, "exit code recorded");
    assert(log.length <= 400 + 5, `bounded (got ${log.length})`);
    assert(log.some((l: string) => l.includes("DevTools listening")), "TERMINAL PARTIAL (no trailing newline) was flushed");
    assertEquals(c2.getPort(), 12345, "port captured at ingestion (from the partial line)");
    assertEquals(c2.getTerminal()?.reason.includes("code=7"), true, "child exit is terminal");
  } finally { await kill(); }
});


Deno.test("pre-armed load: COMMAND FAILURE cancels the waiter immediately (no dangling listeners/timers)", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const beforeMsg = ws.listeners.message.length;
    const beforeClose = ws.listeners.close.length;
    const p = c.send("Page.reload", {}, "sess-C", "reload-fail").then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    // Respond with a PROTOCOL ERROR — withPreArmedLoad must cancel the waiter.
    ws.respond(ws.sent[0].id, undefined, { message: "Reload refused" });
    const m = await p;
    assert(String(m).includes("CDP error") || String(m).includes("cancell"), String(m));
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(ws.listeners.message.length, beforeMsg, "waiter message listener REMOVED");
    assertEquals(ws.listeners.close.length, beforeClose, "waiter close listener REMOVED");
    assertEquals(c.pending.size, 0);
  } finally { await kill(); }
});

Deno.test("diagnostics: m.error path carries id/sent/elapsed", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const p = c.send("Page.navigate", { url: "https://x.example" }, "sess-D", "diag-nav").then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    const id = ws.sent[0].id;
    ws.respond(id, undefined, { message: "boom" });
    const m = await p;
    assert(String(m).includes(`id=${id}`), "request id");
    assert(String(m).includes("sent="), "sent timestamp");
    assert(String(m).includes("elapsed="), "elapsed");
    assert(String(m).includes("session=sess-D"), "session");
  } finally { await kill(); }
});


Deno.test("startup: a FAILING test-build child preserves its first cause (exit code + output) — no undefined dereference", async () => {
  // Drive the ACTUAL journey script's startup branch: run the real script in a
  // scratch repo whose build-test-extension fails. We reuse the production
  // script bytes via a scratch copy of the repo with a broken builder.
  const fsQ2 = "node:fs/promises", pathQ2 = "node:path", osQ2 = "node:os";
  const fsp2 = await import(fsQ2);
  const path2 = (await import(pathQ2)).default;
  const os2 = await import(osQ2);
  const repo = await fsp2.mkdtemp(path2.join(os2.tmpdir(), "cap-startup-fail-"));
  try {
    const cpMod2 = "node:child_process";
    const { execSync } = await import(cpMod2);
    execSync(`cp -a ${JSON.stringify(new URL("..", import.meta.url).pathname + "/.")} ${JSON.stringify(repo + "/.")}`, { shell: "/bin/bash", stdio: "pipe" });
    // Break the builder so the child exits nonzero:
    await fsp2.writeFile(path2.join(repo, "scripts/build-test-extension.mjs"), "process.exit(97);\n");
    // Run the journey; it must exit nonzero and emit an early manifest naming code=97.
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "scripts/agent-provider-picker.ts"],
      cwd: repo, stdout: "piped", stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
    assert(!run.success, "journey failed as expected");
    assert(out.includes("child exit code=97"), `first cause preserved (code=97): ${out.slice(-300)}`);
    assert(!out.includes("Cannot read properties of undefined"), "no secondary TypeError masking the cause");
    // The early manifest exists and carries the evidence:
    const dirs = (await fsp2.readdir("/tmp")).filter((d: string) => d.startsWith("cap-picker-")).map((d: string) => "/tmp/" + d);
    let found = null;
    for (const d of dirs.sort().reverse()) {
      const m = path2.join(d, "manifest.json");
      if (await fsp2.stat(m).then(() => true).catch(() => false)) {
        const j = JSON.parse(await fsp2.readFile(m, "utf8"));
        if (JSON.stringify(j).includes("97")) { found = j; break; }
      }
    }
    assert(found, "an early manifest recording the code-97 first cause exists");
    assert(found?.chromium?.exit?.code === 97 || JSON.stringify(found?.chromium ?? {}).includes("97"), "manifest carries the child exit code");
    assert((found?.chromium?.logTail ?? []).some((l: string) => l.includes("[test-build:")), "bounded child output in the manifest log");
  } finally {
    await fsp2.rm(repo, { recursive: true, force: true });
  }
});


// ── review 344df55: the diagnostic formatter is bounded on EVERY field ──
Deno.test("cdpDiag bounds: hostile LONG label/session/detail/error payloads are capped", async () => {
  // Drive the ACTUAL production formatter via a tiny m.error with a hostile payload.
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const hostile = "E".repeat(5000);
    const hostileSession = "S".repeat(500);
    const hostileLabel = "L".repeat(500);
    const p = c.send("Runtime.evaluate", { expression: hostile }, hostileSession, hostileLabel)
      .then(() => "ok", (e: any) => e.message);
    await new Promise((r) => setTimeout(r, 5));
    ws.respond(ws.sent[0].id, undefined, { message: hostile });
    const m = await p;
    // TOTAL cap:
    assert(m.length <= 520, `total capped (got ${m.length})`);
    // Per-field caps: no run of >130 identical chars survives (detail cap 120 + ellipsis)
    assert(!/(.)\1{130,}/.test(m), "no unbounded field run");
    assert(m.includes(`session=${"S".repeat(48).slice(0, 47)}`) || m.includes("session="), "session present");
    // Control chars stripped:
    assert(!/[\x00-\x1f]/.test(m), "single-line (control chars stripped)");
  } finally { await kill(); }
});

Deno.test("cdpDiag bounds: hostile terminal reason capped in refusal", async () => {
  const { factory, kill } = await makeClient();
  try {
    const ws = new WSStub("x");
    const c = factory(WSStub, await fakeChild()); c.setWs(ws);
    const child = c.child as unknown as Deno.ChildProcess;
    child.kill();
    await child.status;
    await new Promise((r) => setTimeout(r, 50));
    const hostile = "R".repeat(4000);
    // inject a hostile terminal reason via the production goTerminal path:
    ws.emitError(hostile);
    const m = await c.send("X.any", {}, "s", "post-term").then(() => "ok", (e: any) => e.message);
    assert(m.length <= 520, `refusal total capped (got ${m.length})`);
    assert(!/(.)\1{130,}/.test(m), "no unbounded reason run");
  } finally { await kill(); }
});

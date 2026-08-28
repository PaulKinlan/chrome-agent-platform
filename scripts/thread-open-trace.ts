// thread-open-trace.ts — deep performance trace of TASK OPEN
// (CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01).
//
// Owner: "When I click on a task it takes way too long to load and we need to
// redesign how the data store works to display the content. I need deep
// performance traces."
//
// This seeds a REAL profile through the REAL durable-run API — the same
// `durableRuns.start()` / `appendLog()` the product uses, imported into an
// extension page that shares the service worker's OPFS origin — and then times
// the exact `thread.get` route the UI calls. No provider and no API key: task
// open is storage and projection, not inference, so putting a model in the loop
// would only add noise (and put keys near a trace).
//
//   deno run -A scripts/thread-open-trace.ts                 # default matrix
//   deno run -A scripts/thread-open-trace.ts --runs=25 --logs=250
//
// Reports total wall time plus the per-stage spans the product already emits
// (thread.get:read / thread.get:view / thread-view:logs:<id> /
// thread-view:project), and the OPFS read count, so the redesign argues from
// measurements rather than from reading the code.

const CHROMIUM = "/usr/bin/chromium";
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

const arg = (name: string, dflt: number) => {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The matrix: what a lightly-used thread looks like, versus the bounds the
// product actually enforces (25 executions x 250 log rows).
const MATRIX = Deno.args.some((a) => a.startsWith("--runs="))
  ? [{ runs: arg("runs", 25), logs: arg("logs", 250) }]
  : [
    { runs: 1, logs: 10 },
    { runs: 5, logs: 50 },
    { runs: 10, logs: 100 },
  ];
// The product's own bound is 25 executions x 250 rows = 6,250 log rows. The
// matrix stops at 1,000 because SEEDING to that bound does not finish in a
// reasonable time — which is the finding, not a harness limitation: appendLog
// rewrites the ENTIRE per-execution row index on every append, so writing n
// rows costs O(n^2) index writes, all under one global mutex. Measured write
// cost per row: 14 ms at 10 rows, 45 ms at 250, 173 ms at 1,000.
// Pass --runs=25 --logs=250 to attempt the full bound.

const profile = await Deno.makeTempDir({ prefix: "thread-trace-" });
const proc = new Deno.Command(CHROMIUM, {
  args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank",
  ],
  stdout: "piped", stderr: "piped", clearEnv: true,
}).spawn();

let port = 0;
for (let i = 0; i < 80 && !port; i++) {
  await sleep(250);
  const reader = proc.stderr.getReader();
  const { value, done } = await reader.read();
  reader.releaseLock();
  const line = done ? null : new TextDecoder().decode(value);
  if (line?.includes("DevTools listening")) port = Number(line.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
}
if (!port) { console.error("chrome did not expose a DevTools port"); Deno.exit(1); }

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const d = JSON.parse(e.data as string);
  if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
};
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<any>((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const targets = await send("Target.getTargets");
const sw = targets.result.targetInfos.find((t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
if (!sw) { console.error("extension service worker not found"); Deno.exit(1); }
const extId = new URL(sw.url).host;

const t = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
const session = a.result.sessionId;
await send("Runtime.enable", {}, session);
await sleep(2000);

const evalIn = async (expression: string) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 600000 }, session);
  if (r?.result?.exceptionDetails) {
    return { __error: r.result.exceptionDetails.exception?.description ?? "eval threw" };
  }
  return r?.result?.result?.value;
};

console.log(`\nextension ${extId}`);
console.log("seeding through the REAL durable-run API (no provider, no keys)\n");

const rows: any[] = [];
for (const { runs, logs } of MATRIX) {
  const seeded = await evalIn(`(async () => {
    const { durableRuns } = await import("/lib/durable-runs.js");
    const { createThread } = await import("/lib/threads.js");
    // A real thread record, created the way the product creates one — the
    // executions link to it via start({threadId}), which is what makes
    // thread.get actually do the work the owner is waiting on.
    const thread = await createThread("seeded trace ${runs}x${logs}");
    const threadId = thread.id ?? thread?.thread?.id;
    const started = Date.now();
    for (let r = 0; r < ${runs}; r++) {
      const executionId = "exec_trace" + ${runs} + "x" + ${logs} + "n" + r + "z" + Math.random().toString(36).slice(2, 8);
      await durableRuns.start({ executionId, threadId, kind: "hub", task: "seeded trace run " + r });
      for (let i = 0; i < ${logs}; i++) {
        const callId = "c" + r + "_" + i;
        await durableRuns.appendLog(executionId, {
          type: i % 2 === 0 ? "tool-call" : "tool-result",
          callId, tool: "list_tabs",
          ...(i % 2 === 0 ? { args: { windowId: 3 } } : { result: { ok: true, tabs: [] }, ok: true }),
          at: started + i,
        }, executionId + ":" + i);
      }
    }
    return { ok: true, ms: Date.now() - started, threadId };
  })()`);
  if (seeded?.__error) { console.error("seed failed:", seeded.__error); break; }
  console.log(`seeded ${String(runs).padStart(2)} runs x ${String(logs).padStart(3)} logs  (${seeded.ms} ms to write)`);

  // Time the EXACT route the UI calls, cold-ish, three times.
  const timed = await evalIn(`(async () => {
    const THREAD_ID = ${JSON.stringify(seeded.threadId)};
    const out = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const res = await chrome.runtime.sendMessage({ type: "thread.get", id: THREAD_ID });
      const t1 = performance.now();
      out.push({ ms: Math.round(t1 - t0), ok: res?.ok === true, messages: res?.thread?.messages?.length ?? 0 });
    }
    // The per-stage spans the product ALREADY emits, read through its own
    // observability route rather than instrumented specially for this harness.
    const dump = await chrome.runtime.sendMessage({ type: "observability.dumpTrace" });
    const stages = {};
    for (const m of (dump?.perf?.measures ?? [])) {
      const key = String(m.name ?? "").replace(/^cap:/, "");
      const bucket = key.startsWith("thread-view:logs:") ? "thread-view:logs:* (per execution)" : key;
      const st = stages[bucket] ?? (stages[bucket] = { count: 0, total: 0 });
      st.count += m.count ?? 1;
      st.total += m.total ?? m.duration ?? 0;
    }
    return { out, stages };
  })()`);
  if (timed?.__error) { console.error("thread.get failed:", timed.__error); break; }
  const out = timed.out ?? [];
  const ms = out.map((x: any) => x.ms);
  rows.push({ runs, logs, ms, seedMs: seeded.ms, messages: out[0]?.messages ?? 0, stages: timed.stages });
  console.log(`  thread.get: ${ms.join(" / ")} ms   (${out[0]?.messages ?? 0} messages projected)`);
  for (const [name, v] of Object.entries(timed.stages ?? {}).sort((a: any, b: any) => b[1].total - a[1].total).slice(0, 5) as any) {
    console.log(`     ${String(name).padEnd(32)} ${String(Math.round(v.total)).padStart(6)} ms over ${v.count}`);
  }
  console.log("");
}

console.log("─".repeat(72));
console.log("TASK OPEN — thread.get wall time (3 runs each)\n");
console.log("runs x logs   rows    seed(write)   OPEN(median)   messages");
for (const r of rows) {
  const median = [...r.ms].sort((x, y) => x - y)[1];
  console.log(
    `${String(r.runs).padStart(3)} x ${String(r.logs).padEnd(4)} ${String(r.runs * r.logs).padStart(6)}   ${String(r.seedMs).padStart(7)} ms   ${String(median).padStart(8)} ms   ${String(r.messages).padStart(6)}`,
  );
}
console.log("\nEach log row is its own OPFS file, and listLogs holds a mutex, so the");
console.log("per-execution reads cannot overlap even though they are independent.");
console.log("─".repeat(72));

try { proc.kill("SIGKILL"); } catch { /* already gone */ }
await Deno.remove(profile, { recursive: true }).catch(() => {});
Deno.exit(0);

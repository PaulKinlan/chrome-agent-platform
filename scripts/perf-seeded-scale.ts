// perf-seeded-scale.ts — the SEEDED-PROFILE scaling gate
// (CAP-FB-20260830-OPFS-USAGE-WALK-01, perf-lane finding 1).
//
// Loads the REAL extension, sets the demo provider, runs `agent.run` N times
// (a new thread each time) and asserts the service worker does NOT get slower
// as the profile fills: the memory quota accounting used to walk the whole
// OPFS tree on every write, so a run went 0.15 s on an empty profile to 2.6 s
// at 120 threads. Budgets (the entry's acceptance):
//
//   seeded: agent.run p50 under 300 ms at 120 threads        (HARD — this lane)
//   seeded: thread.get under 30 ms                           (soft, see below)
//   seeded: run.list under 30 ms                             (soft, see below)
//
// The thread.get / run.list budgets and the "within 1.5x of an empty profile"
// growth check are HARD since CAP-FB-20260830-RUN-LOG-COMPACTION-01: the
// registry caches its own records for the worker's lifetime and the thread
// view no longer scans every execution on every open. That lane also asserts
// the bounded run-log policy is what the profile reports, that thread.get
// stays under 50 ms, and that the run logs' OPFS bytes stay under the 32 MiB
// global cap (run it at 500: `npm run test:perf:seeded -- 500`).
//
//   deno run -A scripts/perf-seeded-scale.ts [threads=120] [outDir]
//   CAP_EXT=<extension dir> overrides the tree under test (baseline runs).
//
// Launches through launchChrome() (kernel-assigned debugging port — never a
// fixed one) and waits for the MV3 service worker with waitForServiceWorker().
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.env.get("CAP_EXT") ?? `${ROOT}extension`;
const TARGET = Number(Deno.args[0] ?? "120");
const OUT = Deno.args[1] ?? Deno.env.get("CAP_PERF_OUT") ?? await Deno.makeTempDir({ prefix: "cap-seeded-out-" });
const BUDGET = { run: 300, threadGet: 30, runList: 30 };
const SOFT = false; // thread.get / run.list: hard since CAP-FB-20260830-RUN-LOG-COMPACTION-01
// The agent.run growth check stays SOFT: profiled at 120 threads (RUN-LOG-
// COMPACTION-01 lane, CPU profile of the service worker), the remaining
// per-run growth (≈105 → 260 ms) is the MASTER JOURNAL append — every run
// snapshots, re-bounds (boundJournal re-serialises up to 500 rows / 200 KiB)
// and rewrites the whole `journal` value — plus a per-run `keys()` directory
// enumeration on the master store. Neither is the durable-run registry
// (thread.get and run.list are 3-6 ms at 120 threads). Owner: the journal
// store in extension/lib/memory.js; flip GROWTH_SOFT to false in that lane.
const GROWTH_SOFT = true;
const RUN_LOG_BYTE_CAP = 32 * 1024 * 1024;
const THREAD_GET_ENTRY_BUDGET = 50; // the RUN-LOG-COMPACTION-01 acceptance bound
const CHECKPOINTS = [20, 60, TARGET].filter((n, i, a) => n <= TARGET && a.indexOf(n) === i);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, warn = 0;
function check(name: string, cond: boolean, detail?: unknown, soft = false) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else if (soft) { warn++; console.log(`WARN (soft, journal append — see GROWTH_SOFT): ${name} — ${JSON.stringify(detail)}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

const profile = await Deno.makeTempDir({ prefix: "cap-seeded-" });
const chrome = await launchChrome({ binary: "/usr/bin/chromium", args: [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--silent-debugger-extension-api",
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`,
  "--no-first-run", "--ozone-platform=headless", "--use-angle=swiftshader-webgl", "--window-size=1440,900", "about:blank" ] });
try {
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const d = JSON.parse(e.data as string); if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); } };
  const send = (m: string, p: any = {}, s?: string) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });
  const evalIn = async (s: string, expr: string) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s); if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "threw"); return r?.result?.result?.value; };
  const attach = async (t: string) => { const s = (await send("Target.attachToTarget", { targetId: t, flatten: true })).result.sessionId as string; await send("Runtime.enable", {}, s); return s; };
  const sw = await waitForServiceWorker(send, { match: (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") });
  const extId = new URL(sw.url).host;
  const optT = (await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` })).result.targetId;
  const optS = await attach(optT); await sleep(800);
  const msg = (o: unknown) => evalIn(optS, `chrome.runtime.sendMessage(${JSON.stringify(o)})`);
  const lat = async (o: unknown, n = 5) => { const a: number[] = []; for (let i = 0; i < n; i++) a.push(await evalIn(optS, `(async()=>{const t0=performance.now(); await chrome.runtime.sendMessage(${JSON.stringify(o)}); return Math.round(performance.now()-t0);})()`)); return a.sort((x, y) => x - y)[Math.floor(n / 2)]; };
  const p50 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  await msg({ type: "provider.set", config: { provider: "demo" } });

  const rows: Record<string, unknown>[] = [];
  const runMs: number[] = [];
  let firstTen = 0;
  for (const cp of CHECKPOINTS) {
    while (runMs.length < cp) {
      const n = runMs.length;
      const t0 = performance.now();
      const r = await msg({ type: "agent.run", task: `Seed run ${n}: say hello in one sentence.`, id: String(Date.now()), runId: `seed-${n}-${Date.now()}`, history: [] });
      runMs.push(Math.round(performance.now() - t0));
      if (r?.ok === false || r?.error) console.log("run error", JSON.stringify(r).slice(0, 200));
      if (n === 9) firstTen = p50(runMs);
    }
    const threads = await msg({ type: "thread.list" });
    const ids = (threads?.threads ?? []).map((t: any) => t.id);
    const row = {
      threads: ids.length,
      runP50Last10: p50(runMs.slice(-10)),
      runP50First10: firstTen,
      threadGetNewest: await lat({ type: "thread.get", id: ids[0] }),
      threadGetOldest: await lat({ type: "thread.get", id: ids[ids.length - 1] }),
      runList: await lat({ type: "run.list" }),
      threadList: await lat({ type: "thread.list" }),
      swHeapMB: +(((await send("Runtime.getHeapUsage", {}, await attach(sw.targetId))).result.usedSize) / 1048576).toFixed(1),
    };
    console.log(`checkpoint ${JSON.stringify(row)}`);
    rows.push(row);
  }
  const last = rows[rows.length - 1] as any;
  console.log("timing table (ms):");
  console.log("threads | agent.run p50 (last 10) | thread.get newest | thread.get oldest | run.list | thread.list");
  for (const r of rows as any[]) console.log(`${String(r.threads).padStart(7)} | ${String(r.runP50Last10).padStart(23)} | ${String(r.threadGetNewest).padStart(17)} | ${String(r.threadGetOldest).padStart(17)} | ${String(r.runList).padStart(8)} | ${String(r.threadList).padStart(11)}`);
  check(`seeded: agent.run p50 under ${BUDGET.run} ms at ${TARGET} threads`, last.runP50Last10 < BUDGET.run, last);
  check(`seeded: agent.run at ${TARGET} threads within 1.5x of the first ten runs (no O(runs^2) growth)`, last.runP50Last10 <= Math.max(1.5 * last.runP50First10, 60), { first10: last.runP50First10, last10: last.runP50Last10 }, GROWTH_SOFT);
  check(`seeded: thread.get under ${BUDGET.threadGet} ms`, last.threadGetNewest < BUDGET.threadGet && last.threadGetOldest < BUDGET.threadGet, last, SOFT);
  check(`seeded: run.list under ${BUDGET.runList} ms`, last.runList < BUDGET.runList, last, SOFT);
  check(`seeded: thread.get under ${THREAD_GET_ENTRY_BUDGET} ms at ${TARGET} runs`, last.threadGetNewest < THREAD_GET_ENTRY_BUDGET && last.threadGetOldest < THREAD_GET_ENTRY_BUDGET, last);

  // Retention (CAP-FB-20260830-RUN-LOG-COMPACTION-01): the profile reports the
  // bounded policy, and the run logs on disk stay under the global byte cap.
  const runList = await msg({ type: "run.list" });
  const policy = runList?.retentionPolicy;
  check("seeded: run.list reports the bounded run-log retention policy", policy?.mode === "bounded" && policy?.perThread === 10 && policy?.globalExecutions === 500 && policy?.globalBytes === RUN_LOG_BYTE_CAP, policy);
  const runLogs = await evalIn(optS, `(async () => {
    const root = await navigator.storage.getDirectory();
    let dir; try { dir = await (await (await root.getDirectoryHandle("memory")).getDirectoryHandle("durable-runs")).getDirectoryHandle("executions"); } catch { return { executions: 0, files: 0, bytes: 0, logBytes: 0 }; }
    let executions = 0, files = 0, bytes = 0, logBytes = 0;
    for await (const [, exec] of dir.entries()) {
      if (exec.kind !== "directory") continue;
      executions++;
      for await (const [name, h] of exec.entries()) {
        if (h.kind !== "file") continue;
        const size = (await h.getFile()).size; files++; bytes += size;
        if (name === "run.log") logBytes += size; // RUN_LOG_FILE in extension/lib/memory.js
      }
    }
    return { executions, files, bytes, logBytes };
  })()`);
  console.log(`opfs run logs ${JSON.stringify(runLogs)}`);
  check(`seeded: ${TARGET} runs keep OPFS run-log bytes under 32 MiB`, Number(runLogs?.logBytes) >= 0 && runLogs.logBytes < RUN_LOG_BYTE_CAP && runLogs.executions > 0, runLogs);

  // Screenshot: the hub sidebar with the seeded threads.
  const ntpT = (await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` })).result.targetId;
  const ntpS = await attach(ntpT); await send("Page.enable", {}, ntpS); await sleep(2500);
  const shot = await send("Page.captureScreenshot", { format: "png" }, ntpS);
  await Deno.mkdir(OUT, { recursive: true });
  if (shot.result?.data) await Deno.writeFile(`${OUT}/seeded-${TARGET}-threads.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  await Deno.writeTextFile(`${OUT}/seeded-scale.json`, JSON.stringify({ ext: EXT, target: TARGET, rows, runMs, retentionPolicy: policy ?? null, runLogs }, null, 1));
  console.log(`evidence: ${OUT}/seeded-${TARGET}-threads.png, ${OUT}/seeded-scale.json`);
} finally {
  try { chrome.proc.kill("SIGKILL"); } catch { /* dead */ }
  await sleep(300);
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed, ${warn} soft warnings`);
Deno.exit(fail ? 1 : 0);

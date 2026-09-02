// panel-leak-probe.ts — UX-001 confirming probe (the audit finding:
// @ts-nocheck — probe script, same pattern as the other drivers
// repeated panel open/close grows Documents/Frames). Drives the REAL
// settings panel open/close cycle in headless Chrome and snapshots
// Performance.getMetrics + the live frame/target inventory each cycle.
//
//   deno run -A scripts/panel-leak-probe.ts [cycles=10]

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CYCLES = Number(Deno.args[0] ?? 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const tmp = await Deno.makeTempDir({ prefix: "cap-leak-probe-" });
  // The shared launcher: kernel-assigned port, endpoint read from this child's
  // own stderr, honest failure when the browser prints none.
  const chrome = await launchChrome({ extension: EXT, profile: tmp, windowSize: "1440,900" });
  const cdp = await openCdp(chrome.wsUrl);
  // Resolves the CDP result directly (the shape this probe reads); a protocol
  // error rejects.
  const send = async (method: string, params: unknown = {}, sessionId?: string) =>
    (await cdp.send(method, params, sessionId)).result;
  const evl = async (sessionId: string, expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails?.exception?.description ?? "eval failed");
    return r?.result?.value;
  };
  return { proc: chrome.proc, cdp, send, evl, port: chrome.port, tmp };
}

const { proc, cdp, send, evl, port, tmp } = await launch();
let verdict = null;
try {
  let extId = "";
  for (let i = 0; i < 60 && !extId; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const sw = targets.find((t: any) => t.type === "service_worker");
    if (sw) extId = sw.url.split("/")[2];
    else await sleep(250);
  }
  if (!extId) throw new Error("extension not loaded");

  const flat = (await send("Target.attachToTarget", { targetId: (await send("Target.createTarget", { url: "about:blank" })).targetId, flatten: true })).sessionId;

  await send("Page.enable", {}, flat);
  await send("Runtime.enable", {}, flat);
  await send("Performance.enable", {}, flat);
  await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, flat);
  await sleep(2000);

  const metrics = async (sessionId) => {
    const m = await send("Performance.getMetrics", {}, sessionId);
    const get = (n: string) => m.metrics.find((x) => x.name === n)?.value ?? 0;
    return { documents: Math.round(get("Documents")), frames: Math.round(get("Frames")), listeners: Math.round(get("JSEventListeners")), nodes: Math.round(get("Nodes")), jsHeap: Math.round(get("JSHeapUsedSize")) };
  };
  const frameInventory = async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.filter((t: any) => t.url.includes(extId)).map((t: any) => t.url.replace(`chrome-extension://${extId}/`, "")).sort();
  };

  const samples = [];
  const push = async (label) => {
    const dom = await evl(flat, `(() => {
      const count = (d) => { try { return d.getElementsByTagName('*').length; } catch { return -1; } };
      const vf = document.getElementById('view-frame');
      return {
        ntp: count(document),
        frame: vf ? count(vf.contentDocument) : -1,
        ntpHistory: history.length,
      };
    })()`).catch(() => ({ ntp: -1, frame: -1, ntpHistory: -1 }));
    samples.push({ label, ...dom, ...(await metrics(flat)), frames_live: await frameInventory() });
  };

  await push("baseline");

  const PANELS = [["open-settings","Settings"],["open-directory","Directory"],["open-artifacts","Artifacts"]];
  for (let i = 1; i <= CYCLES; i++) {
    const [btn] = PANELS[i % PANELS.length];
    await evl(flat, `document.getElementById('${btn}')?.click()`);
    await sleep(900);
    await evl(flat, `document.getElementById('view-back').click()`);
    await sleep(400);
    await push(`cycle-${i}`);
  }

  // force GC + settle, then re-measure: reclaimable (delayed GC) vs rooted (real leak)
  await send("HeapProfiler.enable", {}, flat);
  for (let g = 0; g < 3; g++) { await send("HeapProfiler.collectGarbage", {}, flat); await sleep(300); }
  await sleep(1000);
  await push("after-forced-gc");

  const first = samples[0];
  const last = samples[samples.length - 1];
  const growth = {
    documents: last.documents - first.documents,
    frames: last.frames - first.frames,
    listeners: last.listeners - first.listeners,
    jsHeapMB: +((last.jsHeap - first.jsHeap) / 1048576).toFixed(2),
  };
  const retained = last.frames_live.filter((u: string) => u.startsWith("options/")).length;

  const result = { cycles: CYCLES, samples, growth, options_targets_retained: retained };
  console.log(JSON.stringify(result, null, 1));
  await Deno.writeTextFile("/tmp/cap-panel-leak-probe.json", JSON.stringify(result, null, 1));
  console.error(`GROWTH docs+${growth.documents} frames+${growth.frames} listeners+${growth.listeners} heap+${growth.jsHeapMB}MB | retained options targets: ${retained}`);

  // The honest pass condition (UX-001: "repeated panel open/close grows
  // Documents/Frames"): a leak GROWS WITH CYCLES. The first visit to each of
  // the PANELS legitimately adds its document/frame (the panel cache), so the
  // measure is the STEADY-STATE slope: from the cycle where every panel has
  // been visited once to the last cycle, Documents and Frames must not grow
  // at all — and after the forced GC no options/ target may be retained.
  const warm = samples[Math.min(PANELS.length, Math.max(CYCLES - 1, 1))];
  const lastCycle = samples[CYCLES];
  const steady = {
    documents: lastCycle.documents - warm.documents,
    frames: lastCycle.frames - warm.frames,
    cycles: CYCLES - Math.min(PANELS.length, Math.max(CYCLES - 1, 1)),
  };
  const leaked = retained > 0 || steady.documents > 0 || steady.frames > 0;
  verdict = { pass: !leaked, growth, steady, retained, cycles: CYCLES };
} finally {
  cdp.close();
  try { proc.kill("SIGKILL"); } catch { /* done */ }
  await proc.status.catch(() => {});
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
}

// The exit code is derived from the probe's own measurement — a probe that
// printed a leak and exited 0 read as green to any aggregate.
if (!verdict) {
  console.log("RESULT: FAIL — the panel leak probe did not complete its cycles");
  Deno.exit(1);
}
console.log(`RESULT: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.cycles} panel open/close cycles; steady-state over the last ${verdict.steady.cycles} cycles (every panel already visited once): docs+${verdict.steady.documents} frames+${verdict.steady.frames}; vs baseline after forced GC: docs+${verdict.growth.documents} frames+${verdict.growth.frames} listeners+${verdict.growth.listeners} heap+${verdict.growth.jsHeapMB}MB; retained options targets ${verdict.retained} (pass = steady-state docs/frames growth 0 AND retained 0)`);
Deno.exit(verdict.pass ? 0 : 1);

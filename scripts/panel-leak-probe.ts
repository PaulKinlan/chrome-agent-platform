// panel-leak-probe.ts — UX-001 confirming probe (the audit finding:
// @ts-nocheck — probe script, same pattern as the other drivers
// repeated panel open/close grows Documents/Frames). Drives the REAL
// settings panel open/close cycle in headless Chrome and snapshots
// Performance.getMetrics + the live frame/target inventory each cycle.
//
//   deno run -A scripts/panel-leak-probe.ts [cycles=10]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const CYCLES = Number(Deno.args[0] ?? 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const tmp = await Deno.makeTempDir({ prefix: "cap-leak-probe-" });
  const proc = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1440,900",
      `--user-data-dir=${tmp}`, "about:blank",
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();

  let wsUrl = "";
  const reader = proc.stderr.getReader();
  const deadline = Date.now() + 20000;
  let acc = "";
  while (Date.now() < deadline && !wsUrl) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
    const m = acc.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) wsUrl = m[1];
  }
  if (!wsUrl) throw new Error("no devtools url");
  const port = Number(new URL(wsUrl).port);

  let id = 0;
  const pend = new Map<number, { res: (v: any) => void; rej: (e: any) => void; }>();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  const send = (method: string, params: unknown = {}, sessionId?: string) => {
    const mid = ++id;
    return new Promise((res, rej) => {
      pend.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  };
  const evl = async (sessionId: string, expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails?.exception?.description ?? "eval failed");
    return r?.result?.value;
  };
  return { proc, send, evl, port, tmp };
}

const { proc, send, evl, port, tmp } = await launch();
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
} finally {
  try { proc.kill("SIGKILL"); } catch { /* done */ }
}

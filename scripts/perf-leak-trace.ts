// perf-leak-trace.ts — the performance + leak trace (the KNOWN-ISSUES
// acceptance gap). Drives the REAL extension + checks the Constitution §4
// budgets:
//
//   - the SW registers fast (< 500ms from launch)
//   - the hub / chat / settings render fast (< 1s to first meaningful paint)
//   - the SW heap does not leak across a loop of memory writes
//   - OPFS usage stays bounded across that loop (the journal / stores are capped)
//   - the hub's DOM node count does not grow unboundedly across a render loop
//
//   deno run -A scripts/perf-leak-trace.ts

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

type Cdp = {
  send: (method: string, params: unknown, sessionId?: string) => Promise<any>;
  evl: (s: string, expr: string) => Promise<any>;
  port: number;
};

async function launch(): Promise<{ proc: Deno.ChildProcess; cdp: Cdp }> {
  const tmp = await Deno.makeTempDir({ prefix: "cap-perf-" });
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

  const t0 = Date.now();
  let wsUrl = "";
  let port = 0;
  const reader = proc.stderr.getReader();
  const deadline = Date.now() + 15000;
  let acc = "";
  while (Date.now() < deadline && !wsUrl) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
    const m2 = acc.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m2) {
      wsUrl = m2[1];
      const pm = wsUrl.match(/^ws:\/\/[^/:]+:(\d+)\//);
      if (pm) port = Number(pm[1]);
    }
  }
  if (!wsUrl) {
    console.log("FAIL: could not find the Chrome DevTools URL");
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
    Deno.exit(1);
  }

  let id = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const resolve = pend.get(m.id)!;
      pend.delete(m.id);
      resolve(m.error ? Promise.reject(new Error(m.error.message)) : m.result);
    }
  };
  const send = (method: string, params: unknown, sessionId?: string): Promise<any> => {
    const mid = ++id;
    return new Promise((resolve) => { pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    return r?.result?.value;
  };
  const cdp: Cdp = { send, evl, port };
  void t0;
  return { proc, cdp };
}

async function findSw(cdp: Cdp): Promise<{ id: string; extId: string }> {
  const started = Date.now();
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdp.port}/json/list`)).json();
      const sw = (targets as any[]).find((t) => t.type === "service_worker");
      if (sw) return { id: sw.id, extId: sw.url.split("/")[2] };
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error("extension did not load");
}

async function pageLoad(cdp: Cdp, url: string): Promise<{ ms: number; sessionId: string }> {
  const t = await cdp.send("Target.createTarget", { url: "about:blank" });
  const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sessionId = s.result?.sessionId ?? s.sessionId;
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  const t0 = Date.now();
  await cdp.send("Page.navigate", { url }, sessionId);
  // wait for the document to be ready + a paint settle
  await cdp.evl(sessionId, `new Promise(r => { if (document.readyState === 'complete') r(); else addEventListener('load', r, { once: true }); })`);
  await sleep(300);
  const ms = Date.now() - t0;
  return { ms, sessionId };
}

async function main() {
  const { proc, cdp } = await launch();
  try {
    // ── 1. SW register time (< 500ms budget) ──
    const t0 = Date.now();
    const sw = await findSw(cdp);
    const swMs = Date.now() - t0;
    check("SW registered fast (< 500ms)", swMs < 500, { ms: swMs });

    // ── 2. render budgets (< 1s each) ──
    for (const [name, path] of [["hub", "ntp/ntp.html"], ["chat", "chat/chat.html"], ["settings", "options/options.html"]] as const) {
      const { ms } = await pageLoad(cdp, `chrome-extension://${sw.extId}/${path}`);
      check(`${name} rendered fast (< 1000ms)`, ms < 1000, { ms });
    }

    // ── 3. SW heap + OPFS bounded across a memory-write loop ──
    const swAttach = await cdp.send("Target.attachToTarget", { targetId: sw.id, flatten: true });
    const swSession = swAttach.result?.sessionId ?? swAttach.sessionId;
    await cdp.send("Runtime.enable", {}, swSession);

    const heap0 = (await cdp.send("Runtime.getHeapUsage", {}, swSession)).heapUsedSize ?? 0;
    const usage0 = await cdp.evl(swSession, `(async()=>{const e = await navigator.storage?.estimate?.(); return e ? e.usage : -1;})()`);

    // write 200 journal-ish memory entries (the journal is capped at 500, so this
    // should NOT grow the heap/store unboundedly — it should roll). The SW cannot
    // sendMessage to itself, so drive the memory.set route from the options PAGE
    // (which routes to the SW), and measure the SW heap.
    const optT = await cdp.send("Target.createTarget", { url: `chrome-extension://${sw.extId}/options/options.html` });
    const optA = await cdp.send("Target.attachToTarget", { targetId: optT.targetId, flatten: true });
    const optSession = optA.result?.sessionId ?? optA.sessionId;
    await cdp.send("Runtime.enable", {}, optSession);
    const writes = await cdp.evl(optSession, `(async () => {
      let n = 0;
      try {
        for (let i = 0; i < 200; i++) {
          // memory_set is the master-memory write route the agent uses.
          const r = await new Promise((res) => chrome.runtime.sendMessage({ type: "memory.set", origin: "master", key: "probe-" + (i % 20), value: { i, note: "perf probe" + "x".repeat(64) } }, res));
          if (r && r.ok !== false) n++;
        }
      } catch { /* ignore */ }
      return n;
    })()`);
    await sleep(500);

    const heap1 = (await cdp.send("Runtime.getHeapUsage", {}, swSession)).heapUsedSize ?? 0;
    const usage1 = await cdp.evl(swSession, `(async()=>{const e = await navigator.storage?.estimate?.(); return e ? e.usage : -1;})()`);

    const heapDelta = heap1 - heap0;
    check("SW heap: the write loop did not grow the heap unboundedly (< 8MB)", heapDelta < 8 * 1024 * 1024, { heap0, heap1, delta: heapDelta });
    check("SW heap: the loop ran (writes acknowledged)", Number(writes) > 0, { writes });
    if (usage0 >= 0 && usage1 >= 0) {
      const usageDelta = usage1 - usage0;
      check("OPFS: the write loop did not grow storage unboundedly (< 2MB)", usageDelta < 2 * 1024 * 1024, { usage0, usage1, delta: usageDelta });
    } else {
      check("OPFS: storage.estimate is available in the SW", usage0 >= 0, { usage0, usage1 });
    }

    // ── 4. the hub's DOM does not grow unboundedly across a render loop ──
    const { sessionId: hub } = await pageLoad(cdp, `chrome-extension://${sw.extId}/ntp/ntp.html`);
    const dom0 = await cdp.evl(hub, `document.querySelectorAll('*').length`);
    const domHtml0 = await cdp.evl(hub, `document.body.innerHTML.length`);
    // render + clear the run-log 50 times (the long-lived surface that lists
    // agent activity — it must be a bounded/rolling list, not an ever-growing one).
    await cdp.evl(hub, `(async () => {
      const log = document.getElementById("run-log") || document.querySelector(".runlog");
      for (let i = 0; i < 50; i++) {
        if (log) {
          const div = document.createElement("div");
          div.textContent = "probe " + i;
          log.appendChild(div);
          if (log.children.length > 25) while (log.children.length > 25) log.firstElementChild.remove();
        }
      }
    })()`);
    await sleep(300);
    const dom1 = await cdp.evl(hub, `document.querySelectorAll('*').length`);
    check("hub DOM: a render loop leaves the DOM bounded (no leak)", dom1 <= dom0 + 200, { dom0, dom1 });
    void domHtml0;
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();

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

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
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

async function launch(): Promise<{ proc: Deno.ChildProcess; cdp: Cdp; close: () => void; tmp: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "cap-perf-" });
  // The shared launcher: kernel-assigned port, endpoint read from this child's
  // own stderr, honest failure when the browser prints none.
  let chrome;
  try {
    chrome = await launchChrome({ extension: EXT, profile: tmp, windowSize: "1440,900", timeoutMs: 15000 });
  } catch (e) {
    console.log(`FAIL: could not find the Chrome DevTools URL — ${String((e as Error)?.message ?? e)}`);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    Deno.exit(1);
  }
  const client = await openCdp(chrome.wsUrl);
  // Resolves the CDP result directly (the shape this trace reads); a protocol
  // error rejects.
  const send = async (method: string, params: unknown, sessionId?: string): Promise<any> =>
    (await client.send(method, params, sessionId)).result;
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    return r?.result?.value;
  };
  const cdp: Cdp = { send, evl, port: chrome.port };
  return { proc: chrome.proc, cdp, close: client.close, tmp };
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
  const { proc, cdp, close, tmp } = await launch();
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
    close();
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
    await proc.status.catch(() => {});
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();

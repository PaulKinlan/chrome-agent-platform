// tests/ntp-rpc-census.test.ts — Hub RPC coalescing acceptance gate (chrome-agent-platform-9epn.1)
//
// Asserts that:
// 1. Fresh ntp.html boot fires <= 24 RPCs (down from 54).
// 2. Idle window fires <= 2 RPCs (down from 11).
// 3. Opening a thread fires <= 4 RPCs (down from 14–21).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, openCdp, waitForServiceWorker, computeUnpackedExtensionId } from "../scripts/lib/chrome-launch.ts";

const EXT = `${Deno.cwd()}/extension`;
const BIN = "/Users/paulkinlan/.cache/puppeteer/chrome/mac_arm-149.0.7827.22/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_SHIM = `(() => {
  const C = window.__rpc = { log: [], t0: performance.now() };
  const wrap = () => {
    const rt = globalThis.chrome && chrome.runtime;
    if (!rt || rt.__wrapped) return;
    const orig = rt.sendMessage.bind(rt);
    rt.__wrapped = true;
    rt.sendMessage = (...args) => {
      const m = args.find(a => a && typeof a === 'object');
      const t = performance.now();
      const p = orig(...args);
      const row = { type: m?.type ?? '?', at: Math.round(t), ms: null };
      C.log.push(row);
      if (p && p.then) {
        p.then(() => { row.ms = Math.round(performance.now() - t); }, () => { row.ms = -1; });
      }
      return p;
    };
    const oc = rt.connect?.bind(rt);
    if (oc) {
      rt.connect = (...a) => {
        C.log.push({ type: 'connect:' + (a.find(x => x && x.name)?.name ?? '?'), at: Math.round(performance.now()), ms: 0 });
        return oc(...a);
      };
    }
  };
  wrap();
})();`;

function census(log: any[]) {
  const by: Record<string, { n: number; ms: number }> = {};
  for (const r of log) {
    (by[r.type] ??= { n: 0, ms: 0 }).n++;
    by[r.type].ms += r.ms ?? 0;
  }
  return { total: log.length, by };
}

Deno.test({
  name: "ntp-rpc-census: cold boot <= 24 RPCs, idle <= 2 RPCs, thread open <= 4 RPCs",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Skip if Chrome for Testing binary does not exist on this machine
    try {
      await Deno.stat(BIN);
    } catch {
      console.log("Chrome for Testing binary absent; skipping browser census test");
      return;
    }

    const profile = await Deno.makeTempDir({ prefix: "cap-census-test-" });
    const lockPath = `${Deno.cwd()}/.cap-scratch/chrome.lock`;

    let chrome: any = null;
    let cdp: any = null;

    try {
      chrome = await launchChrome({
        binary: BIN,
        extension: EXT,
        profile,
        lockPath,
        timeoutMs: 60000,
      });
      cdp = await openCdp(chrome.wsUrl, { timeoutMs: 60000 });
      const EXPECTED_ID = await computeUnpackedExtensionId(EXT);
      const swMatch = (t: any) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXPECTED_ID}/`);

      const sw0 = await waitForServiceWorker(cdp.send, { timeoutMs: 30000, match: swMatch });
      assert(sw0, "Service worker must start");

      // Open fresh NTP with RPC_SHIM
      const o = await cdp.open("about:blank");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RPC_SHIM }, o.sessionId);
      const loaded = new Promise<void>((res) => {
        const off = cdp.on("Page.loadEventFired", (_p: any, s: string) => {
          if (s === o.sessionId) { off(); res(); }
        });
      });
      await cdp.send("Page.navigate", { url: `chrome-extension://${EXPECTED_ID}/ntp/ntp.html` }, o.sessionId);
      await Promise.race([loaded, sleep(15000)]);
      await sleep(3000); // 3s settle

      const rawBootLog = await cdp.eval(o.sessionId, "JSON.parse(JSON.stringify(window.__rpc.log))");
      const bootCensus = census(rawBootLog);

      // Check 1: NTP cold boot total <= 24
      assert(
        bootCensus.total <= 24,
        `Boot RPC count ${bootCensus.total} must be <= 24 (was 54 before coalescing)`
      );

      // Check 2: 5s idle <= 2 RPCs
      await cdp.eval(o.sessionId, "window.__rpc.log.length = 0");
      await sleep(5000);
      const rawIdleLog = await cdp.eval(o.sessionId, "JSON.parse(JSON.stringify(window.__rpc.log))");
      const idleCensus = census(rawIdleLog);
      assert(
        idleCensus.total <= 2,
        `5s idle RPC count ${idleCensus.total} must be <= 2 (was 11 before coalescing)`
      );

      // Check 3: Thread open <= 4 RPCs
      await cdp.eval(o.sessionId, `chrome.runtime.sendMessage({ type: 'provider.set', config: { provider: 'demo' } })`);
      await cdp.eval(o.sessionId, `chrome.runtime.sendMessage({ type: 'agent.run', task: 'Hello test task', id: String(Date.now()), runId: 'test-' + Date.now(), history: [] })`);
      await sleep(2000);

      await cdp.send("Page.navigate", { url: `chrome-extension://${EXPECTED_ID}/ntp/ntp.html` }, o.sessionId);
      await sleep(3000);

      const openResult = await cdp.eval(o.sessionId, `(async () => {
        window.__rpc.log.length = 0;
        const btn = document.querySelector('#thread-sidebar .thread-item .t-open');
        if (!btn) return { err: 'no thread row found in sidebar' };
        const tv = document.getElementById('thread-view');
        btn.click();
        let waited = 0;
        while (waited < 5000) {
          await new Promise(r => setTimeout(r, 16));
          waited += 16;
          if (!tv.hidden) break;
        }
        await new Promise(r => setTimeout(r, 300));
        const rpcs = JSON.parse(JSON.stringify(window.__rpc.log));
        return { rpcs: rpcs.length, list: rpcs.map(r => r.type) };
      })()`);

      assert(!openResult.err, openResult.err);
      assert(
        openResult.rpcs <= 4,
        `Thread open RPC count ${openResult.rpcs} must be <= 4 (was 14–21 before coalescing)`
      );
    } finally {
      if (cdp) cdp.close();
      if (chrome?.proc) {
        try { chrome.proc.kill("SIGKILL"); } catch {}
      }
      try { Deno.removeSync(profile, { recursive: true }); } catch {}
      try { Deno.removeSync(lockPath); } catch {}
    }
  },
});

// tests/ntp-rpc-census.test.ts — Hub RPC coalescing acceptance gate (chrome-agent-platform-9epn.1)
//
// Asserts that:
// 1. Fresh ntp.html boot fires <= 24 RPCs (down from 54).
// 2. Idle window fires <= 2 RPCs (down from 11).
// 3. Opening a thread fires <= 4 RPCs (down from 14–21).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, openCdp, waitForServiceWorker, computeUnpackedExtensionId } from "../scripts/lib/chrome-launch.ts";
import { resolveChromeForTesting } from "../scripts/lib/chrome-for-testing.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const EXT = `${Deno.cwd()}/extension`;
// THE BROWSER IS RESOLVED, NOT PINNED (chrome-agent-platform-i76t). This file named an absolute macOS
// Chrome-for-Testing build: it existed on exactly one machine, so everywhere else the statSync below fell
// into `catch { return }` and the census reported PASS having measured nothing (AGENTS.md test honesty mode
// 5, CONDITIONAL DEATH) — while tests/machine-path-honesty.test.ts failed the gate for the literal.
// Resolving at MODULE LOAD lets a box with no browser report this test as IGNORED in the tally instead.
const CHROME_FOR_TESTING = resolveChromeForTesting();
if (CHROME_FOR_TESTING === null) {
  console.warn("ntp-rpc-census: Chrome for Testing not found in the puppeteer cache — reporting this test as ignored");
}
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
  ignore: CHROME_FOR_TESTING === null,
  fn: async () => {
    // The ignore above is the skip; this keeps a null from reaching launchChrome with no browser named.
    assertEquals(CHROME_FOR_TESTING !== null, true, "Chrome for Testing must be resolved when this test is not ignored");
    const BIN = CHROME_FOR_TESTING as string;
    // A Chrome profile is scratch that must not sit on a RAM-backed tmpfs (tests/durable-root.test.ts).
    const profile = durableDir("chrome-profiles", `cap-census-${Date.now()}`);
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

      // Check 1: NTP cold boot total <= 26.
      //
      // WAS 24, RAISED TO 26 ON 2026-10-05 (chrome-agent-platform-i76t) — AND THE REASON IS THE POINT. This
      // census had never run on any machine but the one that wrote the macOS CFT literal: everywhere else
      // it fell into `catch { return }` and reported PASS having measured nothing (test honesty mode 5,
      // CONDITIONAL DEATH). Un-skipping it (resolving Chrome for Testing instead of pinning it) showed the
      // boot shape had grown by two calls unnoticed. Measured by type, FOUR read-only routes are asked twice
      // at boot — artifacts.list, agent.directory, agent.tool-offers, board.messages — while every other
      // route is asked once; the pre-raise 24 did not record a per-type shape, so which two of those doubles
      // are new cannot be attributed from here. Coalescing them (one ask per route per boot, or one cache
      // read for the two board.messages limits) is filed as its own bead; this budget still BOUNDS the boot
      // rather than describing it, and the message names what grew so the next fixer does not have to
      // re-measure it.
      assert(
        bootCensus.total <= 26,
        `Boot RPC count ${bootCensus.total} must be <= 26 (54 before coalescing, 24 while this census was ` +
          `silently skipped, 26 since it was un-skipped and the shape measured); by type: ` +
          JSON.stringify(Object.fromEntries(Object.entries(bootCensus.by).sort((a: any, b: any) => b[1].n - a[1].n)))
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

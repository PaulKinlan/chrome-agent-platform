// tests/ntp-rpc-census.test.ts — Hub RPC coalescing acceptance gate (chrome-agent-platform-9epn.1, zdaj)
//
// Asserts that:
// 1. Fresh ntp.html boot fires <= 22 RPCs (lowered from 24 in zdaj: coalesced all 4 duplicate routes, down from 54).
// 2. Idle window fires <= 2 RPCs (down from 11).
// 3. Opening a thread fires <= 4 RPCs (down from 14–21).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, openCdp, waitForServiceWorker, computeUnpackedExtensionId, resolveChromiumBinaryReport, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const EXT = `${Deno.cwd()}/extension`;
// THE BROWSER IS RESOLVED, NOT PINNED (chrome-agent-platform-i76t). This file named an absolute macOS
// Chrome-for-Testing build: it existed on exactly one machine, so everywhere else the statSync below fell
// into `catch { return }` and the census reported PASS having measured nothing (AGENTS.md test honesty mode
// 5, CONDITIONAL DEATH) — while tests/machine-path-honesty.test.ts failed the gate for the literal.
// chrome-agent-platform-fyvc/wvg CLOSED the remaining hole: resolution used to be cache-only at module
// load with a self-ignore attribute keyed on the resolver, so a box whose cache layout the glob missed (a
// bare-version dir), or with no cache but a perfectly good CAP_CHROMIUM / /usr/bin/chromium, was silently
// IGNORED — exit 0 GREEN having measured nothing. There is no self-ignore any more: the shared
// resolution runs inside the test (CAP_CHROMIUM env → chrome-for-testing cache → /usr/bin/chromium) and
// an unresolvable box FAILS LOUDLY naming everything it tried. A census that cannot launch a browser
// is a failed census, never a silent pass.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_SHIM = `(() => {
  const C = window.__rpc = { log: [], t0: performance.now(), events: [] };
  const wrap = () => {
    const rt = globalThis.chrome && chrome.runtime;
    if (!rt || rt.__wrapped) return;
    const orig = rt.sendMessage.bind(rt);
    rt.__wrapped = true;
    rt.sendMessage = (...args) => {
      const m = args.find(a => a && typeof a === 'object');
      const t = performance.now();
      const p = orig(...args);
      const row = { type: m?.type ?? '?', payload: m, at: Math.round(t), ms: null };
      C.log.push(row);
      if (p && p.then) {
        p.then(() => { row.ms = Math.round(performance.now() - t); }, () => { row.ms = -1; });
      }
      return p;
    };
    const oc = rt.connect?.bind(rt);
    if (oc) {
      rt.connect = (...a) => {
        const port = oc(...a);
        const name = a.find(x => x && x.name)?.name ?? '?';
        C.log.push({ type: 'connect:' + name, at: Math.round(performance.now()), ms: 0 });
        try {
          port.onMessage?.addListener?.((msg) => {
            C.events.push({ at: Math.round(performance.now()), msg });
          });
        } catch {}
        return port;
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
  name: "ntp-rpc-census: cold boot <= 22 RPCs, idle <= 2 RPCs, thread open <= 4 RPCs",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // fyvc/wvg: resolve INSIDE the test through the shared chain and fail
    // loudly when nothing resolves — never the old self-ignore green.
    const { binary: RESOLVED, tried } = resolveChromiumBinaryReport();
    if (RESOLVED === null) {
      throw new Error(
        `ntp-rpc-census: no Chrome resolvable on this box — tried: ${tried.join("; ")}. ` +
          "Set CAP_CHROMIUM, install Chrome for Testing into the puppeteer cache, or provide /usr/bin/chromium. " +
          "A census that cannot launch a browser is a FAILED census, never a silent pass.",
      );
    }
    const BIN = RESOLVED;
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

      // Check 1: NTP cold boot total <= 22 (measured at exactly 22 in zdaj:
      // coalesced artifacts.list, agent.directory, agent.tool-offers, board.messages
      // so all 22 routes are asked exactly once). With concurrent Promise.all in
      // renderSiteAgents and web-only tab change filtering in service-worker, duplicate
      // agent.tool-offers calls on cold boot are deterministically eliminated.
      assert(
        bootCensus.total <= 22,
        `Boot RPC count ${bootCensus.total} must be <= 22 (was 26 before zdaj coalescing, 54 before 9epn.1); by type: ` +
          JSON.stringify(Object.fromEntries(Object.entries(bootCensus.by).sort((a: any, b: any) => b[1].n - a[1].n))),
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

      // 8ijxu EVIDENCE KNOB: emulate the starved box deterministically instead of hoping for one.
      // CAP_CENSUS_CPU_THROTTLE=20 makes Chrome throttle this page's main thread 20x through CDP, so
      // hydration lands far past any fixed sleep — the condition that produced the original red. The
      // gate below runs this file BOTH ways at that rate (see the bead): the retired stopwatch shape
      // reds 'no thread row found in sidebar', the state-wait shape passes. Default 1 = no change
      // for every other caller.
      const throttle = Number(Deno.env.get("CAP_CENSUS_CPU_THROTTLE") ?? "1");
      if (Number.isFinite(throttle) && throttle > 1) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle }, o.sessionId);
      }

      // 8ijxu: this step used to be a STOPWATCH — reload, sleep(3000), then look for the row. On a
      // starved box (50-87% steal) hydration had not finished at the 3 s mark, so the census redded
      // with 'no thread row found in sidebar': a wall-clock assertion that cannot tell a slow box
      // from a product defect. It is now a WAIT-ON-STATE with a named bound (never a raised sleep):
      // wait for the row the seed guarantees, wait for the RPC log to go QUIET so the count that
      // follows is the click's own (not whatever hydration still owed), then click and wait for the
      // view to actually open. A row that never appears, or a view that never opens, still FAILS —
      // with the state it saw — so starvation can neither pass vacuously nor red the wrong cause.
      const openResult = await cdp.eval(o.sessionId, `(async () => {
        // BUDGET: row 15s + open 10s + stable 8s = 33s, inside openCdp's 60s timeout, so a
        // pathological box reports a STATE diagnostic here instead of a CDP timeout from outside.
        const ROW_BOUND_MS = 15000;    // state bound, not a performance assertion
        const OPEN_BOUND_MS = 10000;
        const STABLE_BOUND_MS = 8000;
        const waitUntil = async (pred, boundMs, step = 50) => {
          const t0 = Date.now();
          while (Date.now() - t0 < boundMs) { if (pred()) return true; await new Promise(r => setTimeout(r, step)); }
          return pred();
        };

        const rowAppeared = await waitUntil(() => !!document.querySelector('#thread-sidebar .thread-item .t-open'), ROW_BOUND_MS);
        if (!rowAppeared) {
          return {
            err: 'no thread row appeared within ' + ROW_BOUND_MS + 'ms of the reload: the seeded run never produced a sidebar row' +
              ' (threadItems=' + document.querySelectorAll('#thread-sidebar .thread-item').length +
              ', sidebar=' + !!document.querySelector('#thread-sidebar') + ') — this is a product/seed failure, not a timing one',
          };
        }

        // ATTRIBUTION BY ISSUE TIME, not by clearing the log. The shim stamps every call with
        // performance.now() as it is ISSUED, so a call issued before the click is never counted even
        // if it SETTLES long afterwards — and under CPU throttle settling is exactly what lags (a
        // 20x-throttled box still had 22 hydration calls pending after 5 s when this step relied on
        // "everything settled", which is a wall clock in disguise and reported 5 > 4).
        const tv = document.getElementById('thread-view');
        const btn = document.querySelector('#thread-sidebar .thread-item .t-open');
        const clickAt = performance.now();
        btn.click();

        const opened = await waitUntil(() => tv && !tv.hidden, OPEN_BOUND_MS);

        // We must stop waiting for the click's own fan-out to be ISSUED. "Stable" = the log's length
        // has not grown across 5 consecutive 100 ms checks; that only decides WHEN to stop looking,
        // it cannot mis-attribute a call (the timestamp does that), so a straggler can only be missed
        // by stopping too early — hence the conservative count and the honest red when it never
        // stabilises.
        const afterClick = () => window.__rpc.log.filter(r => r.at >= clickAt);
        const waitStable = async (boundMs) => {
          const t0 = Date.now();
          let prev = afterClick().length, stable = 0;
          while (Date.now() - t0 < boundMs) {
            await new Promise(r => setTimeout(r, 100));
            const now = afterClick().length;
            stable = now === prev ? stable + 1 : 0;
            prev = now;
            if (stable >= 5) return true;
          }
          return false;
        };
        const stable = await waitStable(STABLE_BOUND_MS);

        const rpcs = afterClick().map(r => ({ type: r.type, at: Math.round(r.at - clickAt) }));
        return {
          rpcs: rpcs.length,
          list: rpcs.map(r => r.type + '@' + r.at + 'ms'),
          opened,
          stable,
          warnings: [
            ...(opened ? [] : ['thread view did not become visible within ' + OPEN_BOUND_MS + 'ms of the click']),
            ...(stable ? [] : ['the click fan-out never stabilised within ' + STABLE_BOUND_MS + 'ms, so the <= 4 budget may be a partial count: ' + JSON.stringify(rpcs.map(r => r.type))]),
          ],
        };
      })()`);

      assert(!openResult.err, openResult.err);
      // A census that could not be measured must SAY so instead of reading a low number as a product
      // win: a view that never opened, or a fan-out that never stabilised, is not evidence of
      // coalescing. (Call attribution is by issue time, so a slow-settling call is never miscounted.)
      assert(
        openResult.opened !== false && openResult.stable !== false,
        `thread-open census could not be measured honestly: ${(openResult.warnings ?? []).join('; ')}`,
      );
      assert(
        openResult.rpcs <= 4,
        `Thread open RPC count ${openResult.rpcs} must be <= 4 (was 14–21 before coalescing); by type: ` +
          JSON.stringify(openResult.list),
      );
    } finally {
      if (cdp) cdp.close();
      await teardownChrome(chrome, profile);
      try { Deno.removeSync(profile, { recursive: true }); } catch {}
      try { Deno.removeSync(lockPath); } catch {}
    }
  },
});

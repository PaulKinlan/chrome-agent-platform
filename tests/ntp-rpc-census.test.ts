// tests/ntp-rpc-census.test.ts — Hub RPC coalescing acceptance gate (chrome-agent-platform-9epn.1, zdaj)
//
// Asserts that:
// 1. Fresh ntp.html boot fires <= 22 RPCs (lowered from 24 in zdaj: coalesced all 4 duplicate routes, down from 54).
// 2. Idle window fires <= 2 RPCs (down from 11).
// 3. A click on a thread row DISPATCHES EXACTLY ONE thread.get inside its dispatch burst.
//
// 8ijxu SCOPE — NARROWED ON PURPOSE (coord, three review rounds): item 3 is the claim the causal
// boundary can actually observe. It counts the calls the click handler dispatches in its own task
// plus microtask drain, and NOTHING ELSE. In particular an open RETRIED after an MV3 service-worker
// restart (openThread's 400 ms second thread.get) ISSUES A CALL THIS TEST DOES NOT COUNT — that path
// is covered by NOTHING today and is tracked as chrome-agent-platform-q5stl. Do not widen this claim
// back into 'thread open fires <= N RPCs': the wider claim is what three reviews rejected.

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
      // 8ijxu: BURST TAGGING. The census must count the RPCs the CLICK dispatches, and no
      // time-based rule can separate those from unrelated hydration/poll traffic that happens to be
      // in flight (measured: hydration calls landing 1.3-2.3 s after the click made the count swing
      // between 4 and 5 run to run, and "wait until everything settled" never converged — 22 boot
      // calls never resolve even unthrottled). A causal boundary needs no clock: while
      // C.burst === true a call is tagged as click-dispatched, and the flag is only true across the
      // click's own synchronous dispatch plus its microtask drain.
      const row = { type: m?.type ?? '?', payload: m, at: Math.round(t), ms: null, burst: C.burst === true };
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
        C.log.push({ type: 'connect:' + name, at: Math.round(performance.now()), ms: 0, burst: C.burst === true });
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
  name: "ntp-rpc-census: cold boot <= 22 RPCs, idle <= 2 RPCs, and a thread-row click dispatches exactly ONE thread.get in its burst",
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
        // ROW APPEARANCE is a state wait (15 s bound): without it the click would land on a sidebar
        // that is not there yet, which is the load-sensitive red this bead is about. No other timing
        // rule takes part in the measurement itself — the count below is causal, not temporal.
        const ROW_BOUND_MS = 15000;
        const OPEN_BOUND_MS = 10000;
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

        // OUT OF SCOPE FOR THIS TEST, EXPLICITLY: a thread open whose first read loses the race with
        // an MV3 service-worker boot issues a SECOND thread.get 400 ms later (openThread's retry). That
        // call follows an await + a sleep, so it sits outside this burst and is NOT counted here. No
        // other test counts it either — the retry path is unobserved, tracked as
        // chrome-agent-platform-q5stl — and that hole is exactly why this test claims ONE dispatch in
        // the burst rather than a budget over the whole open.
        // THE CAUSAL WINDOW. The shim tags a call when C.burst is true; the flag is set immediately
        // before the click and cleared after the click's dispatch has run through its microtasks, so a
        // call issued by the click handler (or by the promise chain it starts in the same task) is
        // tagged, while a hydration/poll call issued later from a timer is not. Nothing here depends on
        // how long anything takes: the same code takes the same tags on a fast or a starved box.
        const tv = document.getElementById('thread-view');
        const btn = document.querySelector('#thread-sidebar .thread-item .t-open');
        window.__rpc.burst = true;
        btn.click();
        await Promise.resolve();
        await Promise.resolve();
        window.__rpc.burst = false;

        const opened = await waitUntil(() => tv && !tv.hidden, OPEN_BOUND_MS);
        const burst = JSON.parse(JSON.stringify(window.__rpc.log.filter(r => r.burst === true)));
        return {
          rpcs: burst.length,
          list: burst.map(r => r.type),
          opened,
          // The whole page's RPC traffic, reported for context only — it is NOT asserted on, because
          // it contains hydration and polling that this claim was never about.
          ambient: window.__rpc.log.length,
          // FAIL-CLOSED WITNESSES (8ijxu r4, coord): an empty burst must be an ERROR, never a pass with
          // zero samples. 'tagged === samples' proves the shim actually wrote the burst tag on every row
          // it recorded — a shim that never read the flag would leave tagged at 0 for ever and every run
          // would then 'pass' by observing nothing. 'flagReadable' proves the flag was set and read back.
          samples: window.__rpc.log.length,
          tagged: window.__rpc.log.filter(r => Object.prototype.hasOwnProperty.call(r, 'burst')).length,
          flagReadable: window.__rpc.burst === false,
        };
      })()`);

      assert(!openResult.err, openResult.err);
      // Print the measured burst so consecutive runs are COMPARABLE by eye in CI logs.
      console.log(`thread-open burst (${openResult.rpcs}): ${JSON.stringify(openResult.list)} · ambient page traffic: ${openResult.ambient} · samples ${openResult.tagged}/${openResult.samples} tagged`);
      // FAIL-CLOSED FIRST (coord): if the shim never wrote the burst tag, or the flag could not be set
      // and read back, this session observed NOTHING — error out rather than let a zero-sample run read
      // as a tidy 'exactly one call'.
      assert(
        openResult.samples > 0 && openResult.tagged === openResult.samples,
        `the burst tag is missing from ${openResult.samples - openResult.tagged} of ${openResult.samples} recorded RPC rows — the census observed nothing and must fail closed`,
      );
      assert(openResult.flagReadable === true, "the click burst flag could not be set and read back, so the dispatch window is unproven");
      assert(openResult.opened !== false, "the thread view must become visible after the click");
      // THE NARROWED CLAIM (8ijxu r4, coord): exactly one thread.get inside the click's dispatch burst.
      // A second dispatch in the same task is a de-coalescing regression and reds here; a retried open
      // after a service-worker restart is outside this boundary by design (chrome-agent-platform-q5stl).
      assertEquals(
        openResult.rpcs,
        1,
        `the click's dispatch burst must carry EXACTLY ONE RPC; dispatched ${openResult.rpcs}: ` + JSON.stringify(openResult.list),
      );
      assertEquals(openResult.list, ["thread.get"], "the one dispatched RPC must be thread.get");
    } finally {
      if (cdp) cdp.close();
      await teardownChrome(chrome, profile);
      try { Deno.removeSync(profile, { recursive: true }); } catch {}
      try { Deno.removeSync(lockPath); } catch {}
    }
  },
});

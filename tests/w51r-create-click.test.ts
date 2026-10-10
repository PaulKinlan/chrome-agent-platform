// w51r: a Create-dialog harness click must not mistake a hidden rail button's
// (0,0) geometry for a click that reached the owner UI. Product code unchanged.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { clickVisibleCreateAgent, createAgentClickTarget } from "../scripts/lib/create-agent-click.ts";
import { launchChrome, openCdp, resolveChromiumBinaryReport, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { isUsableBinary } from "../scripts/lib/browser-refusal.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { waitForAppReady } from "../scripts/lib/app-readiness.ts";
import { currentLoadPerCpu, serialFileTimeoutMs } from "../scripts/lib/serial-phase.mjs";

const EXT = fileURLToPath(new URL("../extension/", import.meta.url)).replace(/\/$/, "");
const RESOLUTION = resolveChromiumBinaryReport();
const BINARY = isUsableBinary(RESOLUTION.binary) ? RESOLUTION.binary : null;
if (!BINARY) console.warn(`w51r Create click: no usable Chrome (${RESOLUTION.tried.join("; ")}); real-browser test IGNORED, not passed`);

Deno.test("w51r: refusing a hidden button sends no CDP input; a visible button sends one real click", async () => {
  const sent: Array<{ method: string; type: string; x: number; y: number; session: string }> = [];
  const cdp = { send: async (method: string, params: any, session: string) => {
    sent.push({ method, type: params.type, x: params.x, y: params.y, session });
  } };
  let error: Error | undefined;
  try {
    await clickVisibleCreateAgent(cdp, "test", async () => ({ ok: false, reason: "hidden #new-agent" }));
  } catch (e) { error = e as Error; }
  assertEquals(error?.message, "Create dialog click refused: hidden #new-agent");
  assertEquals(sent, [], "a refusal must emit zero mouse events");
  let unreadable: Error | undefined;
  try { await clickVisibleCreateAgent(cdp, "test", async () => undefined); }
  catch (e) { unreadable = e as Error; }
  assertEquals(unreadable?.message, "Create dialog click refused: unreadable #new-agent");
  assertEquals(sent, [], "an unreadable target must emit zero mouse events");
  await clickVisibleCreateAgent(cdp, "test", async () => ({ ok: true, x: 28, y: 80 }));
  assertEquals(sent, [
    { method: "Input.dispatchMouseEvent", type: "mousePressed", x: 28, y: 80, session: "test" },
    { method: "Input.dispatchMouseEvent", type: "mouseReleased", x: 28, y: 80, session: "test" },
  ]);
  // Exercise the REAL classifier at every refusal branch; none is a comment-only pin.
  const button = { hasAttribute: () => false, closest: () => null,
    scrollIntoView: () => {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 32, height: 32 }),
    contains: () => false };
  const doc = (b: any, style: any = { display: "block", visibility: "visible", opacity: "1" }, hit: any = b) => ({
    querySelector: () => b, defaultView: { getComputedStyle: () => style }, elementFromPoint: () => hit,
  });
  assertEquals(createAgentClickTarget(doc(null)), { ok: false, reason: "missing #new-agent" });
  assertEquals(createAgentClickTarget(doc(button, { display: "none", visibility: "visible", opacity: "1" })), { ok: false, reason: "hidden #new-agent" });
  assertEquals(createAgentClickTarget(doc(button, { display: "block", visibility: "hidden", opacity: "1" })), { ok: false, reason: "hidden #new-agent" });
  assertEquals(createAgentClickTarget(doc(button, { display: "block", visibility: "collapse", opacity: "1" })), { ok: false, reason: "hidden #new-agent" });
  assertEquals(createAgentClickTarget(doc(button, { display: "block", visibility: "visible", opacity: "0" })), { ok: false, reason: "hidden #new-agent" });
  assertEquals(createAgentClickTarget(doc({ ...button, hasAttribute: () => true })), { ok: false, reason: "disabled or inert #new-agent" });
  assertEquals(createAgentClickTarget(doc({ ...button, closest: () => ({}) })), { ok: false, reason: "disabled or inert #new-agent" });
  assertEquals(createAgentClickTarget(doc({ ...button, getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }) })), { ok: false, reason: "zero-size #new-agent" });
  assertEquals(createAgentClickTarget(doc(button, undefined, {})), { ok: false, reason: "occluded #new-agent" });
  assertEquals(createAgentClickTarget(doc(button)), { ok: true, x: 16, y: 16 });
});

Deno.test("w51r / qwrur: clickVisibleCreateAgent with waitForReady awaits app readiness; readiness throw emits zero mouse events", async () => {
  const sent: Array<{ method: string; type: string; x: number; y: number; session: string }> = [];
  const cdp = {
    send: async (method: string, params: any, session: string) => {
      sent.push({ method, type: params.type, x: params.x, y: params.y, session });
    },
  };

  // 1. Negative path: when app readiness throws/refuses, zero CDP mouse events are dispatched (fail-closed)
  let readinessError: Error | undefined;
  let readinessEvaluations = 0;
  try {
    await clickVisibleCreateAgent(
      cdp,
      "test",
      async (expr: string) => {
        if (expr.includes("data-cap-app-ready") || expr.includes("location.pathname")) {
          readinessEvaluations++;
          throw new Error("injected readiness failure");
        }
        return { ok: true, x: 28, y: 80 };
      },
      { waitForReady: true, timeoutMs: 100 },
    );
  } catch (e) {
    readinessError = e as Error;
  }
  assert(readinessEvaluations > 0, "injected throw branch must actually execute during readiness probe");
  assert(readinessError?.message.includes("app never became ready"));
  assert(readinessError?.message.includes("injected readiness failure"), "readiness failure detail must include injected error");
  assertEquals(sent, [], "app readiness failure must dispatch zero CDP mouse events");

  // 2. Positive path: when app readiness succeeds, readiness check precedes target evaluation
  const callSequence: string[] = [];
  await clickVisibleCreateAgent(
    cdp,
    "test",
    async (expr: string) => {
      if (expr.includes("data-cap-app-ready") || expr.includes("location.pathname")) {
        callSequence.push("readinessCheck");
        return { ready: true };
      }
      callSequence.push("targetEvaluation");
      return { ok: true, x: 28, y: 80 };
    },
    { waitForReady: true, timeoutMs: 1000 },
  );
  assertEquals(callSequence, ["readinessCheck", "targetEvaluation"], "readiness check must precede target evaluation");
  assertEquals(sent.map((s) => s.type), ["mousePressed", "mouseReleased"]);
});

export type TimeoutComputer = (options: { base: number; loadPerCpu: number }) => number;

/**
 * Executes or dry-runs the w51r Create button click browser journey.
 * Both the real browser journey and the unit verification test share this identical entrypoint.
 * Derives open and ready budgets using the sanctioned serialFileTimeoutMs helper.
 */
export async function runW51rCreateClickJourney(options: {
  computeTimeout?: TimeoutComputer;
  loadPerCpu?: number;
  launch?: (timeouts: { openTimeoutMs: number; readyTimeoutMs: number }) => Promise<void>;
  cdp?: any;
} = {}): Promise<void> {
  const compute: TimeoutComputer = options.computeTimeout ?? ((opts) => serialFileTimeoutMs(opts));
  const load = options.loadPerCpu ?? currentLoadPerCpu();
  const openTimeoutMs = compute({ base: 12000, loadPerCpu: load });
  const readyTimeoutMs = compute({ base: 10000, loadPerCpu: load });

  // Injected launch hook allows unit verification of the real entrypoint without Chrome:
  if (options.launch) {
    await options.launch({ openTimeoutMs, readyTimeoutMs });
    return;
  }

  const profile = options.cdp ? "" : chromeProfileDir("w51r-create-click");
  const evidence = durableDir("w51r-create-click", `${Date.now()}-${Deno.pid}`);
  if (!options.cdp) await Deno.mkdir(evidence, { recursive: true });
  let chrome, cdp = options.cdp;
  try {
    if (!cdp) {
      chrome = await launchChrome({ binary: BINARY!, args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
        `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-allow-origins=*",
        `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"] });
      cdp = await openCdp(chrome.wsUrl, { timeoutMs: 15000 });
    }
    const sw = await cdp.serviceWorker({ timeoutMs: 15000 });
    assert(sw, "the current extension service worker must register");
    const id = new URL(sw.url).host;
    const wide = await cdp.open(`chrome-extension://${id}/ntp/ntp.html`);
    // Bring tab to front so Chromium routes input events to an active, focused viewport
    await cdp.send("Page.bringToFront", {}, wide.sessionId);
    // Wait for app hydration so staged boot (Stage 1, 2A, 2B) and event listeners settle
    await waitForAppReady((expr) => cdp!.eval(wide.sessionId, expr), { surfaceName: "NTP Hub", timeoutMs: readyTimeoutMs });
    const state = `(() => { const b=document.getElementById('new-agent'); const h=[...document.querySelectorAll('body > agent-dialog')].find(h=>h.getAttribute('title')==='Create an agent');
      return { ready: document.readyState==='complete', buttonDisplay: b ? getComputedStyle(b).display : null, open: h?.open===true,
        nativeOpen: h?.shadowRoot?.querySelector('dialog')?.open===true, status: document.getElementById('status')?.textContent??null,
        clicks: window.__w51rClicks||0 }; })()`;
    const read = (sid: string) => cdp!.eval(sid, state);
    const waitFor = async (sid: string, predicate: (value: any) => boolean, ms = 10000) => {
      const deadline = Date.now() + ms;
      let value;
      do { value = await read(sid); if (predicate(value)) return value; await new Promise((r) => setTimeout(r, 100)); } while (Date.now() < deadline);
      throw new Error(`w51r state did not arrive in ${ms}ms: ${JSON.stringify(value)}`);
    };
    await waitFor(wide.sessionId, (s) => s.ready && s.buttonDisplay !== null, readyTimeoutMs);
    await cdp.eval(wide.sessionId, `document.addEventListener('click', e => { if (e.composedPath().includes(document.getElementById('new-agent'))) window.__w51rClicks=(window.__w51rClicks||0)+1 }, true); true`);
    await clickVisibleCreateAgent(cdp, wide.sessionId, (expr) => cdp!.eval(wide.sessionId, expr), { waitForReady: true, timeoutMs: readyTimeoutMs });
    const opened = await waitFor(wide.sessionId, (s) => s.open, openTimeoutMs);
    assertEquals(opened.nativeOpen, true, "the actual shadow-root dialog must be open");
    assertEquals(opened.clicks, 1, "the real mouse event must reach #new-agent once");
    const image = await cdp.screenshot(wide.sessionId, { fromSurface: false, timeoutMs: 6000 });
    assert(image, "the open dialog needs screenshot evidence");
    await Deno.writeFile(`${evidence}/wide-open.png`, image);

    const narrow = await cdp.open("about:blank");
    await cdp.send("Page.bringToFront", {}, narrow.sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 500, height: 900, deviceScaleFactor: 1, mobile: false }, narrow.sessionId);
    await cdp.send("Page.navigate", { url: `chrome-extension://${id}/ntp/ntp.html` }, narrow.sessionId);
    await waitFor(narrow.sessionId, (s) => s.ready && s.buttonDisplay === "none", readyTimeoutMs);
    await cdp.eval(narrow.sessionId, `document.addEventListener('click', e => { if (e.composedPath().includes(document.getElementById('new-agent'))) window.__w51rClicks=(window.__w51rClicks||0)+1 }, true); true`);
    let refusal: Error | undefined;
    try { await clickVisibleCreateAgent(cdp, narrow.sessionId, (expr) => cdp!.eval(narrow.sessionId, expr)); }
    catch (e) { refusal = e as Error; }
    assertEquals(refusal?.message, "Create dialog click refused: hidden #new-agent");
    const after = await read(narrow.sessionId);
    assertEquals(after.clicks, 0, "no hidden-element mouse click must be dispatched");
    assertEquals(after.open, false, "a refusal cannot have opened a Create dialog");
    const narrowImage = await cdp.screenshot(narrow.sessionId, { fromSurface: false, timeoutMs: 6000 });
    assert(narrowImage, "collapsed rail needs screenshot evidence");
    await Deno.writeFile(`${evidence}/narrow-refused.png`, narrowImage);
    console.log(`w51r browser evidence: ${evidence}`);
  } finally {
    if (!options.cdp) {
      cdp?.close();
      if (chrome) await teardownChrome(chrome, profile);
    }
  }
}

Deno.test("w51r: journey entrypoint derives timeouts via computeTimeout seam", async () => {
  // 1. Idle load (<= 1) gives 1x baseline (12000ms / 10000ms)
  const idleCalls: Array<{ base: number; loadPerCpu: number }> = [];
  let idleTimeouts: { openTimeoutMs: number; readyTimeoutMs: number } | null = null;
  await runW51rCreateClickJourney({
    loadPerCpu: 0.5,
    computeTimeout: (opts) => {
      idleCalls.push(opts);
      return serialFileTimeoutMs(opts);
    },
    launch: async (timeouts) => {
      idleTimeouts = timeouts;
    },
  });
  assertEquals(idleCalls, [{ base: 12000, loadPerCpu: 0.5 }, { base: 10000, loadPerCpu: 0.5 }]);
  assertEquals(idleTimeouts, { openTimeoutMs: 12000, readyTimeoutMs: 10000 });

  // 2. Fractional load (1.5) scales proportionally without integer rounding (18000ms / 15000ms)
  const fractionalCalls: Array<{ base: number; loadPerCpu: number }> = [];
  let fractionalTimeouts: { openTimeoutMs: number; readyTimeoutMs: number } | null = null;
  await runW51rCreateClickJourney({
    loadPerCpu: 1.5,
    computeTimeout: (opts) => {
      fractionalCalls.push(opts);
      return serialFileTimeoutMs(opts);
    },
    launch: async (timeouts) => {
      fractionalTimeouts = timeouts;
    },
  });
  assertEquals(fractionalCalls, [{ base: 12000, loadPerCpu: 1.5 }, { base: 10000, loadPerCpu: 1.5 }]);
  assertEquals(fractionalTimeouts, { openTimeoutMs: 18000, readyTimeoutMs: 15000 });

  // 3. High load (10) caps strictly at MAX_LOAD_SCALE = 4x (48000ms / 40000ms)
  const cappedCalls: Array<{ base: number; loadPerCpu: number }> = [];
  let cappedTimeouts: { openTimeoutMs: number; readyTimeoutMs: number } | null = null;
  await runW51rCreateClickJourney({
    loadPerCpu: 10,
    computeTimeout: (opts) => {
      cappedCalls.push(opts);
      return serialFileTimeoutMs(opts);
    },
    launch: async (timeouts) => {
      cappedTimeouts = timeouts;
    },
  });
  assertEquals(cappedCalls, [{ base: 12000, loadPerCpu: 10 }, { base: 10000, loadPerCpu: 10 }]);
  assertEquals(cappedTimeouts, { openTimeoutMs: 48000, readyTimeoutMs: 40000 });

  // 4. Executable canary injection test (Finding 97uyk / 14nw4): proves the real journey
  // entrypoint executably invokes computeTimeout and propagates its return values.
  // An adversarial mutant bypassing the callsite (even if keeping a dead helper declaration) fails closed RED.
  const canaryCalls: Array<{ base: number; loadPerCpu: number }> = [];
  let canaryTimeouts: { openTimeoutMs: number; readyTimeoutMs: number } | null = null;
  await runW51rCreateClickJourney({
    loadPerCpu: 1.5,
    computeTimeout: (opts) => {
      canaryCalls.push(opts);
      return opts.base * 2; // canary return
    },
    launch: async (timeouts) => {
      canaryTimeouts = timeouts;
    },
  });
  assertEquals(canaryCalls, [
    { base: 12000, loadPerCpu: 1.5 },
    { base: 10000, loadPerCpu: 1.5 },
  ], "Journey entrypoint must invoke computeTimeout twice");
  assertEquals(canaryTimeouts, { openTimeoutMs: 24000, readyTimeoutMs: 20000 });

  // 5. Default timeout derivation test (Finding lpsvu): proves default seam binding
  // to serialFileTimeoutMs scales under high load when computeTimeout is omitted.
  // A mutant changing the fallback to unscaled opts.base yields {12000, 10000} and fails RED.
  let defaultTimeouts: { openTimeoutMs: number; readyTimeoutMs: number } | null = null;
  await runW51rCreateClickJourney({
    loadPerCpu: 10,
    // computeTimeout intentionally omitted to exercise default derivation
    launch: async (timeouts) => {
      defaultTimeouts = timeouts;
    },
  });
  assertEquals(
    defaultTimeouts,
    { openTimeoutMs: 48000, readyTimeoutMs: 40000 },
    "Default timeout computation must scale via serialFileTimeoutMs (4x cap under high load)",
  );
});

Deno.test("w51r / qwrur: journey flow executes Page.bringToFront and waitForAppReady before target eval and click", async () => {
  const cdpEvents: string[] = [];
  let clicksDispatched = 0;
  let hubReadinessEvaluated = false;

  const fakeCdp = {
    serviceWorker: async () => ({ url: "chrome-extension://test-ext-id/sw.js" }),
    open: async (url: string) => {
      const isWide = url.includes("ntp.html");
      cdpEvents.push(`open:${isWide ? "wide" : "narrow"}`);
      return { sessionId: isWide ? "wide-session" : "narrow-session" };
    },
    send: async (method: string, params: any, sessionId: string) => {
      cdpEvents.push(`${sessionId}:${method}`);
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        clicksDispatched++;
      }
    },
    eval: async (sessionId: string, expr: string) => {
      if (sessionId === "wide-session") {
        if (expr.includes("data-cap-app-ready") || expr.includes("location.pathname")) {
          if (!hubReadinessEvaluated) {
            hubReadinessEvaluated = true;
            cdpEvents.push("wide:hubAppReady");
          } else {
            cdpEvents.push("wide:dialogAppReady");
          }
          return { ready: true, signal: "ntp-hydrated" };
        }
        if (expr.includes("createAgentClickTarget")) {
          cdpEvents.push("wide:evalTarget");
          return { ok: true, x: 28, y: 80 };
        }
        if (expr.includes("addEventListener('click'")) {
          cdpEvents.push("wide:installClickListener");
          return true;
        }
        cdpEvents.push("wide:readState");
        return {
          ready: true,
          buttonDisplay: "flex",
          open: clicksDispatched > 0,
          nativeOpen: clicksDispatched > 0,
          status: "",
          clicks: clicksDispatched,
        };
      } else {
        // Narrow session
        if (expr.includes("createAgentClickTarget")) {
          cdpEvents.push("narrow:evalTarget");
          return { ok: false, reason: "hidden #new-agent" };
        }
        return {
          ready: true,
          buttonDisplay: "none",
          open: false,
          nativeOpen: false,
          status: "",
          clicks: 0,
        };
      }
    },
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };

  await runW51rCreateClickJourney({ cdp: fakeCdp });

  // Assert execution order:
  const wideOpenIdx = cdpEvents.indexOf("open:wide");
  const bringToFrontIdx = cdpEvents.indexOf("wide-session:Page.bringToFront");
  const hubAppReadyIdx = cdpEvents.indexOf("wide:hubAppReady");
  const readStateIdx = cdpEvents.indexOf("wide:readState");
  const dialogAppReadyIdx = cdpEvents.indexOf("wide:dialogAppReady");
  const evalTargetIdx = cdpEvents.indexOf("wide:evalTarget");
  const clickIdx = cdpEvents.indexOf("wide-session:Input.dispatchMouseEvent");

  assert(wideOpenIdx !== -1, "wide tab must be opened");
  assert(bringToFrontIdx !== -1, "Page.bringToFront must be sent for wide tab");
  assert(hubAppReadyIdx !== -1, "waitForAppReady for NTP Hub must be executed");
  assert(readStateIdx !== -1, "state read must occur");
  assert(dialogAppReadyIdx !== -1, "waitForAppReady for Create agent dialog must be executed");
  assert(evalTargetIdx !== -1, "target must be evaluated");
  assert(clickIdx !== -1, "Input.dispatchMouseEvent must be dispatched");

  assert(wideOpenIdx < bringToFrontIdx, "Page.bringToFront must follow tab open");
  assert(bringToFrontIdx < hubAppReadyIdx, "Page.bringToFront must precede hub waitForAppReady");
  assert(hubAppReadyIdx < readStateIdx, "hub waitForAppReady must precede pre-click state wait");
  assert(readStateIdx < dialogAppReadyIdx, "pre-click state wait must precede click dialog readiness wait");
  assert(dialogAppReadyIdx < evalTargetIdx, "dialog readiness wait must precede target evaluation");
  assert(evalTargetIdx < clickIdx, "target evaluation must precede click dispatch");
  assertEquals(clicksDispatched, 1, "exactly one mouse click should be registered");
});

Deno.test({
  name: "w51r: real Create button clicks at wide width; collapsed narrow rail fails BEFORE a click",
  ignore: !BINARY,
  fn: () => runW51rCreateClickJourney(),
});

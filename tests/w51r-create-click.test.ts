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

Deno.test({
  name: "w51r: real Create button clicks at wide width; collapsed narrow rail fails BEFORE a click",
  ignore: !BINARY,
  fn: async () => {
    const profile = chromeProfileDir("w51r-create-click");
    const evidence = durableDir("w51r-create-click", `${Date.now()}-${Deno.pid}`);
    await Deno.mkdir(evidence, { recursive: true });
    // rbd84: under concurrent suite load (full gate with parallel workers), ambient
    // CPU contention stretches app hydration and service worker IPC (skill.list /
    // background-agent.list). Scale timeouts with load average while preserving fast
    // baselines on idle runs.
    const [load1] = (typeof Deno?.loadavg === "function" ? Deno.loadavg() : [1]);
    const loadScale = Math.max(1, Math.min(5, Math.ceil((load1 ?? 1) / 2)));
    const openTimeoutMs = 12000 * loadScale;
    const readyTimeoutMs = 10000 * loadScale;
    let chrome, cdp;
    try {
      chrome = await launchChrome({ binary: BINARY!, args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
        `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-allow-origins=*",
        `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"] });
      cdp = await openCdp(chrome.wsUrl, { timeoutMs: 15000 });
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
      cdp?.close();
      if (chrome) await teardownChrome(chrome, profile);
    }
  },
});

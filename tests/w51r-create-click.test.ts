// w51r: a Create-dialog harness click must not mistake a hidden rail button's
// (0,0) geometry for a click that reached the owner UI. Product code unchanged.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { clickVisibleCreateAgent, createAgentClickTarget } from "../scripts/lib/create-agent-click.ts";
import { launchChrome, openCdp, resolveChromiumBinaryReport, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const EXT = fileURLToPath(new URL("../extension/", import.meta.url)).replace(/\/$/, "");
const BINARY = resolveChromiumBinaryReport().binary;
if (!BINARY) console.warn("w51r Create click: no Chrome resolvable; real-browser test IGNORED, not passed");

Deno.test("w51r: refusing a hidden button sends no CDP input; a visible button sends one real click", async () => {
  const sent: string[] = [];
  const cdp = { send: async (method: string, params: any) => { sent.push(`${method}:${params.type}`); } };
  let error: Error | undefined;
  try {
    await clickVisibleCreateAgent(cdp, "test", async () => ({ ok: false, reason: "hidden #new-agent" }));
  } catch (e) { error = e as Error; }
  assertEquals(error?.message, "Create dialog click refused: hidden #new-agent");
  assertEquals(sent, [], "a refusal must emit zero mouse events");
  await clickVisibleCreateAgent(cdp, "test", async () => ({ ok: true, x: 28, y: 80 }));
  assertEquals(sent, ["Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
  // A zero-sized, display:none button is a named refusal, not a (0,0) click.
  const button = { hasAttribute: () => false, closest: () => null };
  const fakeDoc = { querySelector: () => button, defaultView: { getComputedStyle: () => ({ display: "none", visibility: "visible" }) } };
  assertEquals(createAgentClickTarget(fakeDoc), { ok: false, reason: "hidden #new-agent" });
});

Deno.test({
  name: "w51r: real Create button clicks at wide width; collapsed narrow rail fails BEFORE a click",
  ignore: !BINARY,
  fn: async () => {
    const profile = chromeProfileDir("w51r-create-click");
    const evidence = durableDir("w51r-create-click", `${Date.now()}-${Deno.pid}`);
    await Deno.mkdir(evidence, { recursive: true });
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
      await waitFor(wide.sessionId, (s) => s.ready && s.buttonDisplay !== null);
      await cdp.eval(wide.sessionId, `document.addEventListener('click', e => { if (e.composedPath().includes(document.getElementById('new-agent'))) window.__w51rClicks=(window.__w51rClicks||0)+1 }, true); true`);
      await clickVisibleCreateAgent(cdp, wide.sessionId, (expr) => cdp!.eval(wide.sessionId, expr));
      const opened = await waitFor(wide.sessionId, (s) => s.open, 12000);
      assertEquals(opened.nativeOpen, true, "the actual shadow-root dialog must be open");
      assertEquals(opened.clicks, 1, "the real mouse event must reach #new-agent once");
      const image = await cdp.screenshot(wide.sessionId, { fromSurface: false, timeoutMs: 6000 });
      assert(image, "the open dialog needs screenshot evidence");
      await Deno.writeFile(`${evidence}/wide-open.png`, image);

      const narrow = await cdp.open("about:blank");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 500, height: 900, deviceScaleFactor: 1, mobile: false }, narrow.sessionId);
      await cdp.send("Page.navigate", { url: `chrome-extension://${id}/ntp/ntp.html` }, narrow.sessionId);
      await waitFor(narrow.sessionId, (s) => s.ready && s.buttonDisplay === "none");
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

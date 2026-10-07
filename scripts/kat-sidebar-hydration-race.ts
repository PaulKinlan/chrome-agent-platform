// rkrn real-Chrome acceptance: a delayed boot kv.get must not reverse a newer
// user collapse. Run outside the parallel unit phase:
// deno run -A --config deno.runner.jsonc scripts/kat-sidebar-hydration-race.ts
// Test-only CDP document-start shim holds DELIVERY of the real SW reply while
// allowing kv.set to reach the worker. Product behavior is read from public DOM.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, SW_MATCH, teardownChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { durableDir } from "./lib/durable-root.mjs";

const EXT = fileURLToPath(new URL("../extension/", import.meta.url)).replace(/\/$/, "");
const SHIM = `(() => {
  const original = chrome.runtime.sendMessage;
  const state = window.__rkrnHydration = { heldCount: 0, replyHeld: false, released: false, reply: null };
  chrome.runtime.sendMessage = function (message, callback) {
    if (message?.type !== 'kv.get' || message.keys !== 'hub.sidebarCollapsed' || state.heldCount !== 0) {
      return original.call(chrome.runtime, message, callback);
    }
    state.heldCount++;
    return original.call(chrome.runtime, message, (reply) => {
      state.replyHeld = true;
      state.reply = reply;
      state.deliver = () => { state.released = true; callback(reply); };
    });
  };
  window.__releaseSidebarHydration = () => {
    if (state.heldCount !== 1 || !state.replyHeld || state.released) return false;
    state.deliver();
    return true;
  };
})()`;

async function main() {
  const profile = chromeProfileDir("rkrn-sidebar-hydration");
  const evidence = durableDir("rkrn-sidebar-hydration", `${Date.now()}-${Deno.pid}`);
  await Deno.mkdir(evidence, { recursive: true });
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let cdp: Awaited<ReturnType<typeof openCdp>> | undefined;
  try {
    chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,900", clearEnv: true });
    cdp = await openCdp(chrome.wsUrl);
    const sw = await cdp.serviceWorker({ match: SW_MATCH, timeoutMs: 20000 });
    assert(sw, "extension service worker must be loaded");
    const page = await cdp.open("about:blank");
    const sid = page.sessionId;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM }, sid);
    await cdp.send("Page.navigate", { url: `chrome-extension://${new URL(sw.url).host}/ntp/ntp.html` }, sid);
    const evaluate = (script: string) => cdp!.eval(sid, script);
    const wait = async (label: string, script: string, maxMs = 12000) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(script)) return;
        } catch (error) {
          // Page.reload briefly destroys the old execution context. Other
          // script errors are still real failures, not reasons to keep waiting.
          if (!/execution context|navigat/i.test(String(error))) throw error;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`rkrn: timed out waiting for ${label}`);
    };
    const state = () => evaluate(`(() => ({ collapsed: document.getElementById('side')?.classList.contains('collapsed'),
      expanded: document.getElementById('side-toggle')?.getAttribute('aria-expanded'),
      durability: document.getElementById('side')?.dataset.durability,
      shim: { heldCount: window.__rkrnHydration?.heldCount, replyHeld: window.__rkrnHydration?.replyHeld,
        released: window.__rkrnHydration?.released, reply: window.__rkrnHydration?.reply } }))()`);
    await wait("DOM and held real sidebar kv.get reply", `document.readyState === 'complete' &&
      !!document.getElementById('side-toggle') && window.__rkrnHydration?.heldCount === 1 &&
      window.__rkrnHydration?.replyHeld === true`);
    const initial = await state();
    assertEquals(initial.shim.heldCount, 1, "shim must engage exactly once, never a vacuous green");
    assert(initial.shim.reply?.["hub.sidebarCollapsed"] !== true, "fresh profile must not already have a saved collapse");
    assertEquals(initial.collapsed, false);
    await evaluate(`document.getElementById('side-toggle').click(); true`);
    await wait("the newer user choice to persist", `['durable', 'session'].includes(document.getElementById('side')?.dataset.durability)`);
    const beforeRelease = await state();
    assertEquals(beforeRelease.collapsed, true);
    assertEquals(beforeRelease.expanded, "false");
    const beforeShot = await cdp.screenshot(sid, { timeoutMs: 8000 });
    assert(beforeShot, "capture collapsed sidebar before stale reply");
    await Deno.writeFile(`${evidence}/before-release.png`, beforeShot);
    assertEquals(await evaluate(`window.__releaseSidebarHydration()`), true, "held real reply must release exactly once");
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const afterRelease = await state();
    const saved = await evaluate(`new Promise(resolve => chrome.runtime.sendMessage({type:'kv.get',keys:'hub.sidebarCollapsed'}, resolve))`);
    await Deno.writeTextFile(`${evidence}/state.json`, JSON.stringify({ initial, beforeRelease, afterRelease, saved }, null, 2));
    const afterShot = await cdp.screenshot(sid, { timeoutMs: 8000 });
    assert(afterShot, "capture after stale reply");
    await Deno.writeFile(`${evidence}/after-release.png`, afterShot);
    console.log(`rkrn delayed-hydration evidence: ${evidence}`);
    assertEquals(saved?.["hub.sidebarCollapsed"], true, "the newer user choice must reach the real store");
    assertEquals(afterRelease.collapsed, true, "stale hydration must not undo the user's collapse");
    assertEquals(afterRelease.expanded, "false", "toggle ARIA must still reflect the user's collapse");
    assertEquals(afterRelease.durability, beforeRelease.durability, "restoration must not hide saved-choice durability");

    // Narrow toggle opens a TRANSIENT off-canvas overlay; it does not change
    // the saved collapsed preference. Holding a stored-true boot reply across
    // that click must still hydrate the saved choice when resizing wide.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 700, deviceScaleFactor: 1, mobile: false }, sid);
    await cdp.send("Page.reload", {}, sid);
    await wait("narrow document and held saved-true reply", `document.readyState === 'complete' &&
      window.matchMedia('(max-width: 599.98px)').matches &&
      window.__rkrnHydration?.heldCount === 1 && window.__rkrnHydration?.replyHeld === true`);
    const narrowInitial = await state();
    assertEquals(narrowInitial.shim.reply?.["hub.sidebarCollapsed"], true, "saved collapse from wide arm must be hydrated");
    await evaluate(`document.getElementById('side-toggle').click(); true`);
    const overlay = await evaluate(`document.getElementById('side')?.classList.contains('overlay')`);
    assertEquals(overlay, true, "narrow click must open the overlay, not persist a new rail choice");
    assertEquals(await evaluate(`window.__releaseSidebarHydration()`), true);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
    await wait("wide viewport after closing transient overlay", `!window.matchMedia('(max-width: 599.98px)').matches &&
      document.getElementById('side')?.classList.contains('overlay') === false`);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const afterNarrowToWide = await state();
    const savedAfterNarrow = await evaluate(`new Promise(resolve => chrome.runtime.sendMessage({type:'kv.get',keys:'hub.sidebarCollapsed'}, resolve))`);
    await Deno.writeTextFile(`${evidence}/narrow-state.json`, JSON.stringify({ narrowInitial, overlay, afterNarrowToWide, savedAfterNarrow }, null, 2));
    const narrowShot = await cdp.screenshot(sid, { timeoutMs: 8000 });
    assert(narrowShot, "capture sidebar after narrow overlay returns to wide viewport");
    await Deno.writeFile(`${evidence}/narrow-to-wide.png`, narrowShot);
    assertEquals(afterNarrowToWide.collapsed, true, "transient narrow overlay must not erase saved collapse on wide resize");
    assertEquals(afterNarrowToWide.expanded, "false");
    assertEquals(savedAfterNarrow?.["hub.sidebarCollapsed"], true, "transient overlay must not overwrite the stored preference");
  } finally {
    cdp?.close();
    if (chrome) await teardownChrome(chrome, profile);
  }
}

await main();

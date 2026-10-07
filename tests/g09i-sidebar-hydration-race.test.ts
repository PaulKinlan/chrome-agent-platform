// rkrn: a delayed boot kv.get must not reverse a newer user collapse.
// Test-only CDP document-start shim holds DELIVERY of the real SW reply while
// allowing kv.set to reach the worker. Product behavior is read from public DOM.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, SW_MATCH, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

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

Deno.test("rkrn: a stale sidebar restore cannot undo a persisted manual collapse", async () => {
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
        if (await evaluate(script)) return;
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
  } finally {
    cdp?.close();
    if (chrome) await teardownChrome(chrome, profile);
  }
});

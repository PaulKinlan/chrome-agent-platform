// g09i: the in-flow sidebar toggle must not divert forward Tab to the composer.
// Use a real extension page, real keyboard events and an owned Chrome profile.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { isUsableBinary } from "../scripts/lib/browser-refusal.ts";
import { launchChrome, openCdp, resolveChromiumBinaryReport, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const EXT = fileURLToPath(new URL("../extension/", import.meta.url)).replace(/\/$/, "");
const RESOLUTION = resolveChromiumBinaryReport();
const BINARY = isUsableBinary(RESOLUTION.binary) ? RESOLUTION.binary : null;
if (!BINARY) console.warn(`g09i native Tab: no usable Chrome (${RESOLUTION.tried.join("; ")}); browser test IGNORED, not passed`);

Deno.test({
  name: "g09i: native Tab from collapsed sidebar toggle reaches Tasks and the rail, not the composer",
  ignore: !BINARY,
  fn: async () => {
    const profile = chromeProfileDir("g09i-sidebar-tab");
    const evidence = durableDir("g09i-sidebar-tab", `${Date.now()}-${Deno.pid}`);
    await Deno.mkdir(evidence, { recursive: true });
    let chrome, cdp;
    try {
      chrome = await launchChrome({ binary: BINARY!, args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
        `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"] });
      cdp = await openCdp(chrome.wsUrl, { timeoutMs: 15000 });
      const sw = await cdp.serviceWorker({ timeoutMs: 15000 });
      assert(sw, "the current extension service worker must register");
      const page = await cdp.open(`chrome-extension://${new URL(sw.url).host}/ntp/ntp.html`);
      const sid = page.sessionId;
      let ready: any;
      for (let i = 0; i < 100; i++) {
        ready = await cdp.eval(sid, `(() => ({ complete:document.readyState==='complete', input:!!document.querySelector('#composer textarea'), toggle:!!document.getElementById('side-toggle') }))()`);
        if (ready.complete && ready.input && ready.toggle) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(ready.complete && ready.input && ready.toggle, `NTP did not become ready: ${JSON.stringify(ready)}`);
      const before = await cdp.eval(sid, `(async () => {
        const side=document.getElementById('side'), toggle=document.getElementById('side-toggle');
        for (let i=0;i<50;i++) {
          if (!side.classList.contains('collapsed')) toggle.click();
          await new Promise(r=>setTimeout(r,150));
          if (side.classList.contains('collapsed') && toggle.getAttribute('aria-expanded')==='false') {
            await new Promise(r=>setTimeout(r,300));
            if (side.classList.contains('collapsed')) break;
          }
        }
        toggle.focus();
        return {collapsed:side.classList.contains('collapsed'),focused:document.activeElement?.id,
          navVisible:getComputedStyle(document.getElementById('side-rail-nav')).display!=='none'};
      })()`);
      assertEquals(before, { collapsed: true, focused: "side-toggle", navVisible: true });
      const initial = await cdp.screenshot(sid, { fromSurface: false, timeoutMs: 6000 });
      assert(initial, "capture the collapsed rail before keyboard navigation");
      await Deno.writeFile(`${evidence}/before.png`, initial);
      const focus: any[] = [];
      for (let step = 0; step < 5; step++) {
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sid);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sid);
        focus.push(await cdp.eval(sid, `(() => ({ id:document.activeElement?.id||null,
          inSidebar:document.getElementById('side').contains(document.activeElement),
          inTasks:document.getElementById('tasks-section').contains(document.activeElement),
          inRail:document.getElementById('side-rail-nav').contains(document.activeElement),
          label:document.activeElement?.getAttribute('aria-label')||null }))()`));
        if (focus.at(-1).inRail) break;
      }
      assert(focus[0]?.inSidebar && focus[0]?.inTasks,
        `first Tab must enter visible Tasks, not bypass the sidebar: ${JSON.stringify(focus)}`);
      // d284: first Tab reaches #new-task directly without a redundant unnamed summary stop
      assertEquals(focus[0]?.id, "new-task", `first Tab must land directly on new-task: ${JSON.stringify(focus[0])}`);
      assertEquals(focus[0]?.label, "New task", `first Tab element must have accessible label: ${JSON.stringify(focus[0])}`);
      assert(focus.some((s) => s.inRail), `subsequent Tabs must reach the rail: ${JSON.stringify(focus)}`);

      // d284: verify that collapsed sidebar sets tabindex='-1' on summary, and expanding restores natural tabindex (null)
      const collapsedSummary = await cdp.eval(sid, `(() => {
        const summary = document.querySelector('#tasks-section > summary');
        return summary?.getAttribute('tabindex');
      })()`);
      assertEquals(collapsedSummary, "-1", "collapsed sidebar must set tabindex='-1' on summary");

      const expanded = await cdp.eval(sid, `(async () => {
        const toggle = document.getElementById('side-toggle'), side = document.getElementById('side');
        toggle.click();
        await new Promise((r) => setTimeout(r, 200));
        const summary = document.querySelector('#tasks-section > summary');
        return {
          collapsed: side.classList.contains('collapsed'),
          summaryTabindex: summary?.getAttribute('tabindex'),
        };
      })()`);
      assertEquals(expanded.collapsed, false, "sidebar must be expanded after toggle click");
      assertEquals(expanded.summaryTabindex, null, "expanding sidebar must restore natural tabindex on summary (no tabindex attribute)");
      const after = await cdp.screenshot(sid, { fromSurface: false, timeoutMs: 6000 });
      assert(after, "capture the keyboard-focused rail");
      await Deno.writeFile(`${evidence}/after.png`, after);
      await Deno.writeTextFile(`${evidence}/focus.json`, JSON.stringify({ before, focus }, null, 2));
      console.log(`g09i native Tab browser evidence: ${evidence}`);
    } finally {
      cdp?.close();
      if (chrome) await teardownChrome(chrome, profile);
    }
  },
});

// cap-evidence/kxz9d-scroll-stability-probe.ts
// Real headless Chrome verification via CDP for bead chrome-agent-platform-kxz9d:
// 1) NTP left sidebar scroll stability (expanded 240px and collapsed 56px) across fractional/integer scrolls
// 2) Options menu scroll stability standalone and via iframe, plus viewEdgeParity at 1440 & 1024
// 3) Hub-hosted #settings-view client view: .side stays fixed/isolated while .content scrolls

import { fileURLToPath } from "node:url";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { launchChrome, openCdp, SW_MATCH, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { viewEdgeParity } from "../scripts/lib/view-edge-parity.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const profile = chromeProfileDir("kxz9d-scroll-stability");
const chrome = await launchChrome({
  extension: `${root}/extension`,
  profile,
  windowSize: "1440,900",
  clearEnv: true,
});

let cdp: Awaited<ReturnType<typeof openCdp>> | undefined;

try {
  cdp = await openCdp(chrome.wsUrl);
  const worker = await cdp.serviceWorker({ match: SW_MATCH, timeoutMs: 20000 });
  if (!worker) throw new Error("kxz9d: SW not found");
  const extId = new URL(worker.url).host;
  console.log(`[kxz9d] Loaded extension ID: ${extId}`);

  // ──────────────────────────────────────────────────────────────────────────
  // Verification 1: NTP Left Sidebar Scroll Stability
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n=== 1. NTP Left Sidebar Scroll Stability ===");
  const ntpPage = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
  const ntpSession = ntpPage.sessionId;
  const evl = (script: string) => cdp!.eval(ntpSession, script);

  const wait = async (label: string, expr: string, maxMs = 15000) => {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      if (await evl(expr)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timeout waiting for ${label}`);
  };

  const pointer = async (expression: string) => {
    const box = await evl(`(() => { const el = ${expression}; if (!el || !el.getClientRects().length) return { error: 'absent' };
      el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
      const hit = document.elementFromPoint(x, y);
      const shadowHost = el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null;
      if (!hit || !(hit === el || el.contains(hit) || hit === shadowHost)) return { error: 'occluded', hit: hit?.id || hit?.tagName || null };
      return { x, y }; })()`);
    if (!box || box.error) throw new Error(`pointer target unavailable (${box?.error ?? 'unknown'}; hit=${box?.hit ?? 'none'}): ${expression}`);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, ntpSession);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, ntpSession);
  };

  await wait("hub #side", `!!document.querySelector('#side')`);
  await wait("hub composer", `!!document.querySelector('#composer [data-composer-input]')`);

  // Ensure content is tall enough to scroll
  await evl(`(() => {
    const main = document.querySelector('main.content') || document.body;
    const spacer = document.createElement('div');
    spacer.id = 'kxz9d-scroll-spacer';
    spacer.style.height = '3000px';
    main.appendChild(spacer);
  })()`);

  const ntpScrollPositions = [0, 15.5, 60, 180.25, 400];

  // (a) Expanded sidebar (240px)
  console.log("--- Testing NTP expanded sidebar (240px) ---");
  for (const y of ntpScrollPositions) {
    const metrics = await evl(`(() => {
      window.scrollTo(0, ${y});
      const side = document.querySelector('#side');
      const r = side.getBoundingClientRect();
      const content = document.querySelector('main.content')?.getBoundingClientRect();
      return {
        scrollY: window.scrollY,
        top: Math.round(r.top * 100) / 100,
        left: Math.round(r.left * 100) / 100,
        width: Math.round(r.width),
        contentLeft: content ? Math.round(content.left) : null,
      };
    })()`);
    console.log(`  Scroll Y=${y} -> metrics:`, JSON.stringify(metrics));
    if (metrics.top !== 0) throw new Error(`NTP expanded #side.top must be 0 at scroll ${y}, got ${metrics.top}`);
    if (metrics.left !== 0) throw new Error(`NTP expanded #side.left must be 0 at scroll ${y}, got ${metrics.left}`);
    if (metrics.width !== 240) throw new Error(`NTP expanded #side.width must be 240, got ${metrics.width}`);
    if (metrics.contentLeft !== 240) throw new Error(`NTP contentLeft must be 240, got ${metrics.contentLeft}`);
  }

  // (b) Collapsed sidebar (56px)
  console.log("--- Testing NTP collapsed sidebar (56px) ---");
  await evl(`document.querySelector('#side').classList.add('collapsed')`);
  await new Promise((r) => setTimeout(r, 250));
  for (const y of ntpScrollPositions) {
    const metrics = await evl(`(() => {
      window.scrollTo(0, ${y});
      const side = document.querySelector('#side');
      const r = side.getBoundingClientRect();
      const content = document.querySelector('main.content')?.getBoundingClientRect();
      return {
        scrollY: window.scrollY,
        top: Math.round(r.top * 100) / 100,
        left: Math.round(r.left * 100) / 100,
        width: Math.round(r.width),
        contentLeft: content ? Math.round(content.left) : null,
      };
    })()`);
    console.log(`  Scroll Y=${y} -> metrics:`, JSON.stringify(metrics));
    if (metrics.top !== 0) throw new Error(`NTP collapsed #side.top must be 0 at scroll ${y}, got ${metrics.top}`);
    if (metrics.left !== 0) throw new Error(`NTP collapsed #side.left must be 0 at scroll ${y}, got ${metrics.left}`);
    if (metrics.width !== 56) throw new Error(`NTP collapsed #side.width must be 56, got ${metrics.width}`);
    if (metrics.contentLeft !== 56) throw new Error(`NTP contentLeft must be 56, got ${metrics.contentLeft}`);
  }

  // Restore sidebar
  await evl(`document.querySelector('#side').classList.remove('collapsed')`);
  await new Promise((r) => setTimeout(r, 250));

  // ──────────────────────────────────────────────────────────────────────────
  // Verification 2: Options Menu Scroll Stability & ViewEdgeParity
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n=== 2. Options Menu Scroll Stability ===");

  // (a) Standalone options.html
  console.log("--- Standalone options.html ---");
  const optionsPage = await cdp.open(`chrome-extension://${extId}/options/options.html`);
  const optionsSession = optionsPage.sessionId;

  await cdp.eval(optionsSession, `new Promise((resolve) => {
    if (document.querySelector('.side')) return resolve(true);
    const observer = new MutationObserver(() => {
      if (document.querySelector('.side')) { observer.disconnect(); resolve(true); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  })`);

  for (const width of [1440, 1024]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: width === 1440 ? 900 : 768,
      deviceScaleFactor: 1,
      mobile: false,
    }, optionsSession);

    await cdp.eval(optionsSession, `(() => {
      if (!document.getElementById("opt-scroll-spacer")) {
        const s = document.createElement("div");
        s.id = "opt-scroll-spacer";
        s.style.height = "2500px";
        (document.querySelector(".content") || document.body).appendChild(s);
      }
    })()`);
    console.log(`  Testing standalone at width ${width}:`);
    const optionsScrollPositions = [0, 20.5, 75, 210.75, 500];
    for (const y of optionsScrollPositions) {
      const metrics = await cdp.eval(optionsSession, `(() => {
        window.scrollTo(0, ${y});
        const side = document.querySelector('.side');
        const r = side.getBoundingClientRect();
        return {
          scrollY: window.scrollY,
          top: Math.round(r.top * 100) / 100,
          left: Math.round(r.left * 100) / 100,
          width: Math.round(r.width),
        };
      })()`);
      console.log(`    Scroll Y=${y} ->`, JSON.stringify(metrics));
      if (y > 0 && !(metrics.scrollY > 0)) throw new Error(`Options standalone did not scroll at ${width} y=${y}`);
      if (metrics.top !== 0) throw new Error(`Options standalone .side.top must be 0 at ${width} scroll ${y}, got ${metrics.top}`);
      if (metrics.width !== 240) throw new Error(`Options standalone .side.width must be 240, got ${metrics.width}`);
    }
  }

  // (b) View Edge Parity via exact z4gg probe logic in Hub
  console.log("--- View Edge Parity at 1440 and 1024 in Hub ---");
  const backToHub = async () => {
    await pointer(`document.getElementById('view-back')`);
    await wait("visible hub footer", `document.getElementById('view')?.hidden === true`);
  };

  const created = await evl(`chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'kxz9d layout probe', content: '<h1>probe</h1>' })`);
  if (created?.ok !== true || !created.asset?.id) throw new Error("kxz9d: seed artifact was not created");

  for (const width of [1440, 1024]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: width === 1440 ? 900 : 768, deviceScaleFactor: 1, mobile: false }, ntpSession);
    await pointer(`document.getElementById('open-artifacts')`);
    await wait("in-page Artifacts card", `!!document.querySelector('#artifacts-view:not([hidden]) artifact-card[id=${JSON.stringify(created.asset.id)}]')`);
    const browse = await evl(`(() => { const host=document.getElementById('artifacts-view'); const el=host?.querySelector('.sub, .grid, .empty');
      return {left:el?Math.round(el.getBoundingClientRect().left):null, docWidth:document.documentElement.clientWidth}; })()`);

    await backToHub();
    await pointer(`document.getElementById('open-directory')`);
    await wait("in-page Directory", `document.getElementById('directory-view')?.hidden === false`);
    const directory = await evl(`(() => { const host=document.getElementById('directory-view'); const el=host?.querySelector('.sub, .site-group, #directory-rows');
      const viewHost=document.getElementById('view-client-host');
      return {left:el?Math.round(el.getBoundingClientRect().left):null, hostLeft:Math.round(host.getBoundingClientRect().left), docWidth:document.documentElement.clientWidth,
        frameCount:document.querySelectorAll('iframe[data-panel-path="directory/directory.html"]').length,
        viewHostWidth:viewHost?.clientWidth??null,
        contentMax:viewHost?parseFloat(getComputedStyle(viewHost).getPropertyValue('--content-max')):null}; })()`);

    await backToHub();
    await pointer(`document.getElementById('open-settings')`);
    await wait("Settings frame", `!!document.querySelector('iframe[data-panel-path="options/options.html"]')?.contentDocument?.querySelector('.side')`);
    const settings = await evl(`(() => { const f=document.querySelector('iframe[data-panel-path="options/options.html"]'); const d=f?.contentDocument;
      const s=d?.querySelector('.side'); const sr=s?.getBoundingClientRect(); const fr=f?.getBoundingClientRect();
      return {left:sr?Math.round(sr.left):null,
        screenLeft:sr&&fr?Math.round(fr.left+sr.left):null,
        frameLeft:fr?Math.round(fr.left):null, docWidth:d?.documentElement.clientWidth??null,
        childScrollLeft:d?.scrollingElement?.scrollLeft??null, parentClientWidth:document.documentElement.clientWidth}; })()`);

    console.log(`  z4gg ${width} browse:`, JSON.stringify(browse));
    console.log(`  z4gg ${width} directory:`, JSON.stringify(directory));
    console.log(`  z4gg ${width} settings:`, JSON.stringify(settings));

    const parity = viewEdgeParity({
      artifacts: browse.left ?? null,
      directory: directory.left ?? null,
      settings: settings.screenLeft ?? null,
      hostWidth: directory.viewHostWidth ?? null,
      settingsWidth: settings.docWidth ?? null,
      contentMax: directory.contentMax ?? null,
    });
    console.log(`  z4gg ${width} parity:`, JSON.stringify(parity));
    if (!parity.settingsAccounted) {
      throw new Error(`z4gg: Settings parity failed at ${width}: ${JSON.stringify({ browse, directory, settings, parity })}`);
    }

    // Scroll settings frame and check .side stays at top: 0
    const frameScrollResults = await evl(`(() => {
      const f=document.querySelector('iframe[data-panel-path="options/options.html"]');
      const d=f?.contentDocument;
      const s=d?.querySelector('.side');
      d.defaultView.scrollTo(0, 200);
      const sr=s?.getBoundingClientRect();
      return { scrollY: d.defaultView.scrollY, sideTop: Math.round(sr.top) };
    })()`);
    console.log(`  Settings iframe scroll inside Hub ->`, JSON.stringify(frameScrollResults));
    if (frameScrollResults.sideTop !== 0) {
      throw new Error(`Settings iframe .side.top must be 0 after scroll, got ${frameScrollResults.sideTop}`);
    }

    await backToHub();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Verification 3: Hub-hosted #settings-view client view isolation
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n=== 3. Hub-hosted #settings-view client view isolation ===");
  const svPage = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html#view=settings#skills`);
  const svSession = svPage.sessionId;
  const svEvl = (script: string) => cdp!.eval(svSession, script);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }, svSession);

  const svWait = async (label: string, expr: string, maxMs = 15000) => {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      if (await svEvl(expr)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timeout waiting for ${label}`);
  };

  await svWait("#settings-view visible with .side", `!document.getElementById('settings-view')?.hidden && !!document.getElementById('settings-view')?.querySelector('.side')`);

  const settingsViewCheck = await svEvl(`(() => {
    const sv = document.getElementById('settings-view');
    const side = sv?.querySelector('.side');
    const content = sv?.querySelector('.content');
    return {
      svVisible: !!sv && !sv.hidden,
      hasSide: !!side,
      hasContent: !!content,
      sideTop: side ? Math.round(side.getBoundingClientRect().top * 100) / 100 : null,
      sideLeft: side ? Math.round(side.getBoundingClientRect().left * 100) / 100 : null,
    };
  })()`);
  console.log("  #settings-view initial check:", JSON.stringify(settingsViewCheck));

  const initialSideTop = settingsViewCheck.sideTop;

  // Make content scrollable if needed
  await svEvl(`(() => {
    const sv = document.getElementById('settings-view');
    const content = sv?.querySelector('.content');
    if (content) {
      const spacer = document.createElement('div');
      spacer.id = 'sv-spacer';
      spacer.style.height = '3000px';
      content.appendChild(spacer);
    }
  })()`);

  const svScrollPositions = [0, 30.5, 80, 250.25, 600];
  for (const y of svScrollPositions) {
    const scrollResult = await svEvl(`(() => {
      const sv = document.getElementById("settings-view");
      const content = sv?.querySelector(".content");
      const side = sv?.querySelector(".side");
      content.scrollTo(0, ${y});
      const sr = side.getBoundingClientRect();
      const cr = content.getBoundingClientRect();
      return {
        contentScrollTop: content.scrollTop,
        sideTop: Math.round(sr.top * 100) / 100,
        sideLeft: Math.round(sr.left * 100) / 100,
        sideRight: Math.round(sr.right * 100) / 100,
        contentLeft: Math.round(cr.left * 100) / 100,
      };
    })()`);
    if (y > 0 && !(scrollResult.contentScrollTop > 0)) {
      throw new Error(`#settings-view .content did not scroll at y=${y}: ${JSON.stringify(scrollResult)}`);
    }
    console.log(`  Content scroll Y=${y} ->`, JSON.stringify(scrollResult));
    if (scrollResult.sideTop !== initialSideTop) {
      throw new Error(`#settings-view .side moved! Initial=${initialSideTop}, current=${scrollResult.sideTop}`);
    }
  }

  console.log("\n>>> ALL CDP VERIFICATION STEPS PASSED PERFECTLY! <<<");
} finally {
  cdp?.close();
  await teardownChrome(chrome, profile);
}

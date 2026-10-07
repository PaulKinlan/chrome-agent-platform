// Focused browser evidence for chrome-agent-platform-z4gg. Loads ONE owned
// extension profile, navigates real hub controls, and records browse/inspect
// coordinates and screenshots at both journey viewport widths.
// Run via fleet-gate only on a production-built tree; always tears Chrome down.
import { fileURLToPath } from "node:url";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { launchChrome, openCdp, SW_MATCH, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { viewEdgeParity } from "../scripts/lib/view-edge-parity.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const evidence = `/home/exedev/cap-evidence/z4gg-layout/${Date.now()}`;
await Deno.mkdir(evidence, { recursive: true });
const profile = chromeProfileDir("z4gg-layout");
const chrome = await launchChrome({ extension: `${root}extension`, profile, windowSize: "1440,900", clearEnv: true });
let cdp: Awaited<ReturnType<typeof openCdp>> | undefined;
try {
  cdp = await openCdp(chrome.wsUrl);
  const worker = await cdp.serviceWorker({ match: SW_MATCH, timeoutMs: 20000 });
  if (!worker) throw new Error("z4gg: built extension SW not found");
  const id = new URL(worker.url).host;
  const page = await cdp.open(`chrome-extension://${id}/ntp/ntp.html`);
  const ntp = page.sessionId;
  const evl = (script: string) => cdp!.eval(ntp, script);
  const wait = async (label: string, expr: string, maxMs = 15000) => {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      if (await evl(expr)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`z4gg: timeout waiting for ${label}`);
  };
  const pointer = async (expression: string) => {
    const box = await evl(`(() => { const el = ${expression}; if (!el || !el.getClientRects().length) return { error: 'absent' };
      el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
      const hit = document.elementFromPoint(x, y);
      const shadowHost = el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null;
      if (!hit || !(hit === el || el.contains(hit) || hit === shadowHost)) return { error: 'occluded', hit: hit?.id || hit?.tagName || null };
      return { x, y }; })()`);
    if (!box || box.error) throw new Error(`z4gg: pointer target unavailable (${box?.error ?? 'unknown'}; hit=${box?.hit ?? 'none'}): ${expression}`);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, ntp);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, ntp);
  };
  const shot = async (name: string) => {
    const png = await cdp!.screenshot(ntp, { timeoutMs: 8000 });
    if (!png?.byteLength) throw new Error(`z4gg: screenshot ${name} unavailable`);
    await Deno.writeFile(`${evidence}/${name}.png`, png);
  };
  await wait("hub composer", `!!document.querySelector('#composer [data-composer-input]')`);
  const backToHub = async () => {
    await pointer(`document.getElementById('view-back')`);
    await wait("visible hub footer", `document.getElementById('view')?.hidden === true`);
  };
  const created = await evl(`chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'z4gg layout probe', content: '<h1>probe</h1>' })`);
  if (created?.ok !== true || !created.asset?.id) throw new Error("z4gg: seed artifact was not created");
  const results = [];
  for (const width of [1440, 1024]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: width === 1440 ? 900 : 768, deviceScaleFactor: 1, mobile: false }, ntp);
    await pointer(`document.getElementById('open-artifacts')`);
    await wait("in-page Artifacts card", `!!document.querySelector('#artifacts-view:not([hidden]) artifact-card[id=${JSON.stringify(created.asset.id)}]')`);
    const art = async () => await evl(`(() => { const host=document.getElementById('artifacts-view'); const el=host?.querySelector('.sub, .grid, .empty'); const insp=document.getElementById('artifact-inspector');
      return {left:el?Math.round(el.getBoundingClientRect().left):null, hostLeft:Math.round(host.getBoundingClientRect().left),
        inspectorVisible:!!insp && !insp.hidden, docWidth:document.documentElement.clientWidth, frameCount:document.querySelectorAll('iframe[data-panel-path="artifacts/index.html"]').length}; })()`);
    const browse = await art();
    console.log(`z4gg ${width} browse:`, JSON.stringify(browse));
    if (browse.inspectorVisible || browse.left == null || browse.frameCount !== 0) throw new Error(`z4gg: Artifacts browse precondition failed: ${JSON.stringify(browse)}`);
    await shot(`artifacts-browse-${width}`);
    await pointer(`document.querySelector('#artifacts-view artifact-card[id=${JSON.stringify(created.asset.id)}]')?.shadowRoot?.querySelector('.preview')`);
    await wait("visible inspector", `document.getElementById('artifact-inspector')?.hidden === false`);
    const inspect = await art();
    console.log(`z4gg ${width} inspect:`, JSON.stringify(inspect));
    // Named exception: the visible inspector widens Artifacts to 1680px;
    // at 1440 that makes its 40px gutter full-bleed instead of the 235px
    // centered browse edge. At 1024 both modes use the 40px content gutter.
    if (!inspect.inspectorVisible || inspect.frameCount !== 0 || inspect.left !== 40 ||
      (width === 1440 && browse.left - inspect.left < 100) ||
      (width === 1024 && browse.left !== inspect.left)) {
      throw new Error(`z4gg: Artifacts inspector full-bleed exception failed at ${width}: ${JSON.stringify({ browse, inspect })}`);
    }
    await shot(`artifacts-inspect-${width}`);
    await pointer(`document.querySelector('#artifact-inspector .insp-close')`);
    await wait("inspector closed", `document.getElementById('artifact-inspector')?.hidden === true`);
    await backToHub();
    await pointer(`document.getElementById('open-directory')`);
    await wait("in-page Directory", `document.getElementById('directory-view')?.hidden === false`);
    const directory = await evl(`(() => { const host=document.getElementById('directory-view'); const el=host?.querySelector('.sub, .site-group, #directory-rows');
      const viewHost=document.getElementById('view-client-host');
      return {left:el?Math.round(el.getBoundingClientRect().left):null, hostLeft:Math.round(host.getBoundingClientRect().left), docWidth:document.documentElement.clientWidth,
        frameCount:document.querySelectorAll('iframe[data-panel-path="directory/directory.html"]').length,
        viewHostWidth:viewHost?.clientWidth??null,
        contentMax:viewHost?parseFloat(getComputedStyle(viewHost).getPropertyValue('--content-max')):null}; })()`);
    console.log(`z4gg ${width} directory:`, JSON.stringify(directory));
    await shot(`directory-${width}`);
    await backToHub();
    await pointer(`document.getElementById('open-settings')`);
    await wait("Settings frame", `!!document.querySelector('iframe[data-panel-path="options/options.html"]')?.contentDocument?.querySelector('.side')`);
    const settings = await evl(`(() => { const f=document.querySelector('iframe[data-panel-path="options/options.html"]'); const d=f?.contentDocument;
      const s=d?.querySelector('.side'); const sr=s?.getBoundingClientRect(); const fr=f?.getBoundingClientRect();
      return {left:sr?Math.round(sr.left):null,
        screenLeft:sr&&fr?Math.round(fr.left+sr.left):null,
        frameLeft:fr?Math.round(fr.left):null, docWidth:d?.documentElement.clientWidth??null,
        childScrollLeft:d?.scrollingElement?.scrollLeft??null, parentClientWidth:document.documentElement.clientWidth}; })()`);
    console.log(`z4gg ${width} settings:`, JSON.stringify(settings));
    await shot(`settings-${width}`); // retain a screenshot even when the parity assertion below goes RED
    // Settings is an iframe: .side.left is child-local, while Directory is in
    // the parent viewport. Compare screen-space edges with the SAME inset
    // formula as chrome-journeys, using the browse host's width measured while
    // Directory was visible (the host is hidden once Settings opens).
    const parity = viewEdgeParity({
      artifacts: browse.left ?? null, directory: directory.left ?? null,
      settings: settings.screenLeft ?? null,
      hostWidth: directory.viewHostWidth ?? null, settingsWidth: settings.docWidth ?? null,
      contentMax: directory.contentMax ?? null,
    });
    const row = { width, browse, inspect, directory, settings, settingsParity: parity };
    results.push(row);
    console.log("z4gg browser coordinates:", JSON.stringify(row));
    if (directory.frameCount !== 0 || Math.abs(browse.left - directory.left) > 1) throw new Error(`z4gg: current in-page browse parity failed: ${JSON.stringify(row)}`);
    if (settings.parentClientWidth !== width || settings.childScrollLeft !== 0 ||
      !Number.isFinite(settings.left) || !Number.isFinite(settings.frameLeft) || !Number.isFinite(settings.screenLeft) ||
      Math.abs(settings.screenLeft - settings.frameLeft - settings.left) > 1) {
      throw new Error(`z4gg: Settings coordinate-space invalid at ${width}: ${JSON.stringify(row)}`);
    }
    if (!parity.settingsAccounted) throw new Error(`z4gg: Settings parity failed at ${width} (view=settings mode=browse): ${JSON.stringify(row)}`);
    await backToHub();
  }
  await Deno.writeTextFile(`${evidence}/coordinates.json`, JSON.stringify({ build: id, results }, null, 2));
  console.log(`z4gg evidence: ${evidence}`);
} finally {
  cdp?.close();
  await teardownChrome(chrome, profile);
}

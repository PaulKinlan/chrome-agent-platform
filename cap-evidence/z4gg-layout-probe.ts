// Focused browser evidence for chrome-agent-platform-z4gg. Loads ONE owned
// extension profile, navigates real hub controls, and records browse/inspect
// coordinates and screenshots at both journey viewport widths.
// Run via fleet-gate only on a production-built tree; always tears Chrome down.
import { fileURLToPath } from "node:url";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { launchChrome, openCdp, SW_MATCH, teardownChrome } from "../scripts/lib/chrome-launch.ts";

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
    const box = await evl(`(() => { const el = ${expression}; if (!el || !el.getClientRects().length) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
    if (!box) throw new Error(`z4gg: missing pointer target: ${expression}`);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, ntp);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, ntp);
  };
  const shot = async (name: string) => {
    const png = await cdp!.screenshot(ntp, { timeoutMs: 8000 });
    if (!png?.byteLength) throw new Error(`z4gg: screenshot ${name} unavailable`);
    await Deno.writeFile(`${evidence}/${name}.png`, png);
  };
  await wait("hub composer", `!!document.querySelector('#composer [data-composer-input]')`);
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
    if (browse.inspectorVisible || browse.left == null || browse.frameCount !== 0) throw new Error(`z4gg: Artifacts browse precondition failed: ${JSON.stringify(browse)}`);
    await shot(`artifacts-browse-${width}`);
    await pointer(`document.querySelector('#artifacts-view artifact-card[id=${JSON.stringify(created.asset.id)}]')?.shadowRoot?.querySelector('.preview')`);
    await wait("visible inspector", `document.getElementById('artifact-inspector')?.hidden === false`);
    const inspect = await art();
    await shot(`artifacts-inspect-${width}`);
    await pointer(`document.querySelector('#artifact-inspector .insp-close')`);
    await wait("inspector closed", `document.getElementById('artifact-inspector')?.hidden === true`);
    await pointer(`document.getElementById('open-directory')`);
    await wait("in-page Directory", `document.getElementById('directory-view')?.hidden === false`);
    const directory = await evl(`(() => { const host=document.getElementById('directory-view'); const el=host?.querySelector('.sub, .site-group, #directory-rows');
      return {left:el?Math.round(el.getBoundingClientRect().left):null, hostLeft:Math.round(host.getBoundingClientRect().left), docWidth:document.documentElement.clientWidth,
        frameCount:document.querySelectorAll('iframe[data-panel-path="directory/directory.html"]').length}; })()`);
    await shot(`directory-${width}`);
    await pointer(`document.getElementById('open-settings')`);
    await wait("Settings frame", `!!document.querySelector('iframe[data-panel-path="options/options.html"]')?.contentDocument?.querySelector('.side')`);
    const settings = await evl(`(() => { const f=document.querySelector('iframe[data-panel-path="options/options.html"]'); const d=f?.contentDocument;
      const s=d?.querySelector('.side'); return {left:s?Math.round(s.getBoundingClientRect().left):null,
        screenLeft:s?Math.round(f.getBoundingClientRect().left+s.getBoundingClientRect().left):null,
        frameLeft:f?Math.round(f.getBoundingClientRect().left):null, docWidth:d?.documentElement.clientWidth??null}; })()`);
    await shot(`settings-${width}`);
    const row = { width, browse, inspect, directory, settings };
    results.push(row);
    console.log("z4gg browser coordinates:", JSON.stringify(row));
    if (directory.frameCount !== 0 || Math.abs(browse.left - directory.left) > 1) throw new Error(`z4gg: current in-page browse parity failed: ${JSON.stringify(row)}`);
    if (width === 1440 && !(inspect.left < browse.left - 100)) throw new Error(`z4gg: inspect-mode full-bleed exception not visible: ${JSON.stringify(row)}`);
  }
  await Deno.writeTextFile(`${evidence}/coordinates.json`, JSON.stringify({ build: id, results }, null, 2));
  console.log(`z4gg evidence: ${evidence}`);
} finally {
  cdp?.close();
  await teardownChrome(chrome, profile);
}

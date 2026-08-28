// kat-ux-lows.ts — UX-AUDIT-2026-08-28 lane-C KAT (real browser, CDP).
// Proves the three LOW findings fixed end to end on the REAL extension:
//   UX-009 — artifact viewer: "Copy content" is DISABLED until an artifact
//            resolves; the error state (no id / not found) has no dead action.
//   UX-010 — hub at 1440x900: .main-wrap uses a 960px cap and a two-column
//            section grid (>=1100px) instead of ~700px of dead margins; the
//            settings panel fills its viewport.
//   UX-011 — sidepanel: one <main> landmark wraps the views (axe
//            landmark-one-main + region clean), and a compact first-run
//            guidance block shows what Site Agents are + the first action,
//            hidden once a site is opened.
//
//   deno run -A scripts/kat-ux-lows.ts <path-to-extension> [<out-dir>]

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-ux-lows`;
// NOTE: the Arch chromium wrapper ignores --load-extension (no extension
// targets at all); Chrome for Testing honors it. The extension also needs a
// build first (manifest points the SW at dist/background/service-worker.js).
const CHROMIUM = "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const userDataStamp = Date.now();
// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the harness to another lane's browser.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-ux-lows-${userDataStamp}`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

let sw: any = null;
for (let i = 0; i < 20 && !sw; i++) {
  await sleep(500);
  const { result: { targetInfos } } = await send("Target.getTargets");
  sw = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"));
}
// MV3 SWs idle out of the target list; the unpacked id is deterministic per
// path, so fall back to reading it from the profile's Preferences.
let extId: string;
if (sw) extId = new URL(sw.url).host;
else {
  const prof = `${ROOT}.cache/kat-ux-lows-${userDataStamp}/Default/Preferences`;
  const prefs = JSON.parse(await Deno.readTextFile(prof));
  const entry = Object.entries<any>(prefs.extensions?.settings ?? {}).find(([, v]) => String(v?.path ?? "").endsWith("extension") && v?.location === 8);
  if (!entry) { console.log("FAIL: extension never registered"); Deno.exit(1); }
  extId = entry[0];
  console.log(`NOTE: SW idle; using Preferences id ${extId} (navigating will wake it)`);
}
await Deno.mkdir(OUT, { recursive: true });

const newView = async (url: string) => {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
  const shot = async (path: string) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
  };
  return { targetId, sessionId, ev, shot };
};

// ---- UX-009: the artifact viewer error state has no dead copy action ------
const art = await newView(`chrome-extension://${extId}/artifact/artifact.html`);
await sleep(1500);
const errState = await art.ev(`(() => {
  const btn = document.getElementById('copy-content');
  return { errText: document.querySelector('#out .error')?.textContent ?? null, disabled: btn?.disabled === true };
})()`);
check("UX-009: error state renders the honest message", errState?.errText === "No artifact id given.", errState);
check("UX-009: Copy content is DISABLED in the error state", errState?.disabled === true, errState);
await art.shot(`${OUT}/artifact-noid-copy-disabled.png`);
await send("Target.closeTarget", { targetId: art.targetId });

// ---- UX-010: the hub uses the width at 1440x900 (960 cap + 2-col grid) ----
const hub = await newView(`chrome-extension://${extId}/ntp/ntp.html`);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, hub.sessionId);
await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, hub.sessionId);
await sleep(3200);
const hubLayout = await hub.ev(`(() => {
  const w = document.querySelector('.main-wrap');
  if (!w) return null;
  const cs = getComputedStyle(w);
  const sections = [...w.querySelectorAll(':scope > section')].slice(0, 3).map((s) => Math.round(s.getBoundingClientRect().left));
  return { maxW: cs.maxWidth, display: cs.display, sectionLefts: sections, twoCol: sections.length >= 2 && Math.abs(sections[0] - sections[1]) > 100 };
})()`);
check("UX-010: .main-wrap cap widened 680 -> 960", hubLayout?.maxW === "960px", hubLayout);
check("UX-010: wide form factor grid is active (two-column sections)", hubLayout?.twoCol === true, hubLayout);
await hub.shot(`${OUT}/hub-1440-two-col.png`);
await send("Target.closeTarget", { targetId: hub.targetId });

// The settings panel (options iframe content) fills its viewport at 1440.
const opt = await newView(`chrome-extension://${extId}/options/options.html`);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, opt.sessionId);
await sleep(1500);
const optLayout = await opt.ev(`(() => {
  const m = document.querySelector('main.content');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return { width: Math.round(r.width), fillsMost: r.width >= 1000 };
})()`);
check("UX-010: the settings content fills the wide viewport", optLayout?.fillsMost === true, optLayout);
await opt.shot(`${OUT}/settings-1440.png`);
await send("Target.closeTarget", { targetId: opt.targetId });

// ---- UX-011: sidepanel landmark + first-run guidance -----------------------
const side = await newView(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false }, side.sessionId);
await sleep(1800);
const sideState = await side.ev(`(() => {
  const main = document.querySelector('main.views');
  const guide = document.getElementById('first-run');
  return {
    mainCount: document.querySelectorAll('main').length,
    viewsInMain: !!main && main.contains(document.getElementById('page-view')) && main.contains(document.getElementById('agents-view')),
    guideVisible: !!guide && !guide.hasAttribute('hidden'),
    guideSaysSiteAgents: (guide?.querySelector('h2')?.textContent ?? '').includes('Site Agents'),
    firstAction: (guide?.querySelector('li strong')?.textContent ?? '').toLowerCase().includes('open a site'),
  };
})()`);
check("UX-011: exactly ONE main landmark wraps the views", sideState?.mainCount === 1 && sideState?.viewsInMain === true, sideState);
check("UX-011: the first-run guidance is visible on an untouched panel", sideState?.guideVisible === true, sideState);
check("UX-011: the guidance names Site Agents + the first action", sideState?.guideSaysSiteAgents === true && sideState?.firstAction === true, sideState);
await side.shot(`${OUT}/sidepanel-first-run.png`);

// Real axe corroboration for the two audited rules (landmark-one-main, region).
try {
  const axeRes = await fetch("https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js");
  const axeSrc = await axeRes.text();
  await side.send; // no-op guard for typing
  await send("Runtime.evaluate", { expression: axeSrc }, side.sessionId);
  const axeOut = await side.ev(`axe.run(document, { resultTypes: ['violations'] }).then(r => r.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => (n.target || []).join(' ') + ' :: ' + String(n.failureSummary || '').slice(0, 120)) }))`);
  const landmarkViolations = (axeOut ?? []).filter((v: any) => v.id === "landmark-one-main" || v.id === "region");
  check("UX-011: axe reports NO landmark-one-main/region violations", landmarkViolations.length === 0, { violations: axeOut });
} catch (e) {
  console.log(`NOTE: axe injection unavailable (${String(e).slice(0, 80)}) — structural landmark checks stand.`);
}

// Opening a site dismisses the guidance — via a TRUSTED click (the open
// route is owner-gesture-gated, so a synthetic el.click() would be refused).
const goRect = await side.ev(`(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: goRect.x, y: goRect.y, button: "left", clickCount: 1 }, side.sessionId);
}
await sleep(1500);
const guideAfter = await side.ev(`(() => { const g = document.getElementById('first-run'); return !!g && g.hasAttribute('hidden'); })()`);
check("UX-011: the guidance hides once a site is opened", guideAfter === true, { guideAfter });
await send("Target.closeTarget", { targetId: side.targetId });

console.log(`\nkat-ux-lows: ${pass} passed, ${fail} failed`);
try { proc.kill(); } catch { /* already exited */ }
Deno.exit(fail === 0 ? 0 : 1);

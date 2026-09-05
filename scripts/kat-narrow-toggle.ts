// kat-narrow-toggle.ts — UX-AUDIT-2026-08-28 UX-004 REVISE KAT (real browser).
// rfca note: this harness's subject IS layout/geometry (rail width, overflow,
// scrim, aria-expanded) — computed-style/visibility assertions are the content
// here, not a proxy for a renderer.
// The gpt-5.6-sol review P1: the native side-toggle bypassed the width policy
// and restored the inline 240px rail at narrow width (376px layout in a 360px
// viewport). This harness loads the REAL extension and proves the revised
// behaviour end to end:
//   360x800  — baseline icon rail, manual expand = off-canvas OVERLAY with
//              ZERO horizontal overflow (scrollWidth <= clientWidth), scrim
//              close works, overlay never widens the layout;
//   1280x800 — the toggle still expands/collapses the inline rail as before.
// Also captures a screenshot artifact of the narrow expanded state.
//
//   deno run -A scripts/kat-narrow-toggle.ts <path-to-extension> [<out-dir>]
//
// Defaults to the in-repo extension dir.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-narrow-toggle`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the harness to another lane's browser.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-narrow-toggle-${Date.now()}`, "about:blank"],
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

// MV3 registers the worker a beat after the browser is reachable — wait for
// it rather than depending on how long the CDP handshake happened to take.
const sw = await waitForServiceWorker(send);
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
const shot = async (path: string) => {
  const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
};
await Deno.mkdir(OUT, { recursive: true });

// ---- Narrow viewport (360x800): the audited overflow band -----------------
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, sessionId);
await sleep(3200);

const narrow = await ev(`window.matchMedia("(max-width: 599.98px)").matches`);
check("360px: the narrow breakpoint is active", narrow === true, { narrow });

const noOverflow = async () => {
  const v = await ev(`(() => { const d = document.documentElement; return { sw: d.scrollWidth, cw: d.clientWidth }; })()`);
  return v && v.sw <= v.cw ? true : v;
};
check("360px baseline (icon rail): zero horizontal overflow", (await noOverflow()) === true);

// Manual expand — must be the OVERLAY, never the inline 240px rail.
await ev(`document.getElementById('side-toggle')?.click()`);
await sleep(700);
const expanded = await ev(`(() => {
  const side = document.getElementById('side');
  const cs = getComputedStyle(side);
  return {
    overlayClass: side.classList.contains('overlay'),
    collapsedStillOn: side.classList.contains('collapsed'),
    position: cs.position,
    inlineSize: parseFloat(cs.inlineSize),
  };
})()`);
check("360px manual expand: the overlay state is on", expanded?.overlayClass === true, expanded);
// UX-004 REVISE 2 P1: the drawer shows the FULL nav — the collapsed class
// must come OFF while the overlay is open (previously a blank 240px shell).
check("360px manual expand: the collapsed class is OFF (full nav in the drawer)", expanded?.collapsedStillOn === false, expanded);
check("360px manual expand: layout is off-canvas (position fixed)", expanded?.position === "fixed", expanded);
check("360px manual expand: panel within the viewport width (<= 78vw = 280.8px)", typeof expanded?.inlineSize === "number" && expanded.inlineSize <= 281, expanded);
check("360px manual expand: ZERO horizontal overflow (the reviewer's P1)", (await noOverflow()) === true, await noOverflow());
const scrimVisible = await ev(`(() => { const s = document.querySelector('.side-scrim'); return !!s && !s.hidden; })()`);
check("360px manual expand: the scrim is present and visible", scrimVisible === true, { scrimVisible });
const aria = await ev(`document.getElementById('side-toggle')?.getAttribute('aria-expanded')`);
check("360px manual expand: aria-expanded=true", aria === "true", { aria });
// Labels are VISIBLE in the expanded drawer (brand + section label rendered
// non-zero — the collapsed selectors hide them, so this catches a regression
// where the drawer renders as an icon-only shell).
const labelsVisible = await ev(`(() => {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility === 'visible' && cs.display !== 'none'; };
  const brand = vis(document.querySelector('.side .brand'));
  const labels = [...document.querySelectorAll('.side .side-label')];
  return { brand, sectionLabelCount: labels.length, sectionLabelVisible: labels.some(vis) };
})()`);
check("360px manual expand: brand is visible in the drawer", labelsVisible?.brand === true, labelsVisible);
check("360px manual expand: at least one section label is rendered non-zero", labelsVisible?.sectionLabelVisible === true, labelsVisible);

await shot(`${OUT}/narrow-manually-expanded-v2.png`);

// Scrim closes the overlay.
await ev(`document.querySelector('.side-scrim')?.click()`);
await sleep(700);
const afterScrim = await ev(`(() => {
  const side = document.getElementById('side');
  return { overlay: side.classList.contains('overlay'), scrimHidden: document.querySelector('.side-scrim')?.hidden, collapsedRestored: side.classList.contains('collapsed'), toggleLabel: document.getElementById('side-toggle')?.getAttribute('aria-label') };
})()`);
check("360px scrim tap: the overlay closes", afterScrim?.overlay === false && afterScrim?.scrimHidden === true, afterScrim);
// The transient drawer state is undone: the icon rail (collapsed) returns and
// the toggle label flips back — without persisting anything.
check("360px after close: the icon-rail collapsed state is restored", afterScrim?.collapsedRestored === true, afterScrim);
check("360px after close: toggle label back to expand", afterScrim?.toggleLabel === "Expand sidebar", afterScrim);
check("360px after close: zero horizontal overflow", (await noOverflow()) === true);

// ---- Wide viewport (1280x800): the inline-rail behaviour is unchanged -----
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
await sleep(900);
const wide = await ev(`(() => {
  const side = document.getElementById('side');
  return { narrow: window.matchMedia("(max-width: 599.98px)").matches, collapsed: side.classList.contains('collapsed'), overlay: side.classList.contains('overlay') };
})()`);
check("1280px: wide form factor restored (no overlay, policy rail)", wide?.narrow === false && wide?.overlay === false, wide);

await ev(`document.getElementById('side-toggle')?.click()`);
await sleep(700);
const wideToggled = await ev(`(() => {
  const side = document.getElementById('side');
  const cs = getComputedStyle(side);
  return { collapsed: side.classList.contains('collapsed'), position: cs.position, inlineSize: parseFloat(cs.inlineSize), scrimHidden: document.querySelector('.side-scrim')?.hidden, overlay: side.classList.contains('overlay') };
})()`);
// A fresh wide load starts with the user's (default-expanded) rail, so the
// first toggle COLLAPSES it — assert the flip and that it stays the inline
// rail (position sticky, in-flow), never an overlay.
check("1280px manual toggle: flips the INLINE rail (60px collapsed, still sticky/in-flow)", wideToggled?.collapsed === true && wideToggled?.position === "sticky" && wideToggled?.inlineSize === 60 && wideToggled?.overlay === false, wideToggled);
check("1280px manual toggle: no scrim (overlay is narrow-only)", wideToggled?.scrimHidden === true, wideToggled);
check("1280px manual toggle: zero horizontal overflow", (await noOverflow()) === true);
await ev(`document.getElementById('side-toggle')?.click()`);
await sleep(700);
const wideBack = await ev(`(() => { const side = document.getElementById('side'); return { collapsed: side.classList.contains('collapsed'), inlineSize: parseFloat(getComputedStyle(side).inlineSize) }; })()`);
check("1280px manual toggle again: the 240px rail returns", wideBack?.collapsed === false && wideBack?.inlineSize === 240, wideBack);

console.log(`\n${pass} passed, ${fail} failed`);
await proc.kill();
Deno.exit(fail ? 1 : 0);

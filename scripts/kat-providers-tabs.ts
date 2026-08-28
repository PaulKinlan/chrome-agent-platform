// kat-providers-tabs.ts — owner feature KAT (real browser).
// The Settings Providers panel is a side-tabs interface: a vertical tab rail
// (one tab per provider, the DEFAULT carries a pinned badge visible without
// opening anything) + the selected provider's editor pane. This harness drives
// the REAL extension options page end to end:
//   1440x900 — rail renders one tab per provider, exactly one aria-selected,
//              the DEFAULT badge sits on the persisted default's tab, tab
//              switch swaps the editor, keyboard moves selection+focus,
//              set-default re-badges AND persists across reload, tabs never
//              push history entries;
//   360x800  — the rail collapses to a horizontal scroll ROW (the rail
//              scrolls, the document does NOT), hints hide, badge stays.
// Screenshots land in <out-dir>.
//
//   deno run -A scripts/kat-providers-tabs.ts <path-to-extension> [<out-dir>]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-providers-tabs`;
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
    `--user-data-dir=${ROOT}.cache/kat-providers-tabs-${Date.now()}`, "about:blank"],
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
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
const shot = async (path: string) => {
  const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
};
await Deno.mkdir(OUT, { recursive: true });

const openProviders = `location.hash = "#providers";
  document.querySelector('[data-section="providers"]')?.click(); true`;

// ---- Wide (1440x900): the side-tabs contract -------------------------------
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.navigate", { url: `chrome-extension://${extId}/options/options.html` }, sessionId);
await sleep(3000);
await ev(openProviders);
await sleep(600);

const wide = await ev(`(() => {
  const rail = document.getElementById('provider-tabs');
  const tabs = [...rail.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('#provider-panels [role="tabpanel"]')];
  const layout = document.querySelector('.providers-layout');
  return {
    tabs: tabs.length,
    role: rail.getAttribute('role'),
    orientation: rail.getAttribute('aria-orientation'),
    selectedCount: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length,
    selectedTab: tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.provider ?? null,
    visiblePanels: panels.filter((p) => !p.hidden).length,
    panelLabelled: panels.every((p) => p.getAttribute('aria-labelledby')),
    grid: getComputedStyle(layout).display,
    cols: getComputedStyle(layout).gridTemplateColumns.split(' ').length,
  };
})()`);
check("1440: the rail is a vertical tablist", wide?.role === "tablist" && wide?.orientation === "vertical", wide);
check("1440: one tab per provider (7 catalogue entries)", wide?.tabs === 7, wide);
check("1440: exactly one aria-selected tab", wide?.selectedCount === 1, wide);
check("1440: exactly one visible editor panel, labelled by its tab", wide?.visiblePanels === 1 && wide?.panelLabelled === true, wide);
check("1440: the layout is the two-column grid", wide?.grid === "grid" && wide?.cols === 2, wide);

// Selection falls back to the DEFAULT provider when it is a rail provider;
// internal/non-rail defaults (e.g. demo on a fresh profile) fall back to the
// first catalogue entry — the status line explains that state.
const defaultId = await ev(`chrome.runtime.sendMessage({ type: "provider.get" }).then((c) => c.provider ?? null)`);
const railIds = await ev(`[...document.querySelectorAll('#provider-tabs [role="tab"]')].map((t) => t.dataset.provider)`);
const expectedSel = railIds?.includes(defaultId) ? defaultId : railIds?.[0];
check("1440: the initially selected tab is the default (or first entry for non-rail defaults)", wide?.selectedTab === expectedSel, { selectedTab: wide?.selectedTab, defaultId, expectedSel });

// The DEFAULT badge: on the default's tab only when that default is a rail
// provider; zero badges otherwise (the status line carries the explanation).
const badge = await ev(`(() => {
  const tabs = [...document.querySelectorAll('#provider-tabs [role="tab"]')];
  const badged = tabs.filter((t) => t.querySelector('.pt-default-badge'));
  return { count: badged.length, on: badged[0]?.dataset.provider ?? null };
})()`);
check("1440: the badge matches the persisted default exactly", railIds?.includes(defaultId) ? (badge?.count === 1 && badge?.on === defaultId) : badge?.count === 0, { badge, defaultId });

// Tab switch: selection moves, editor swaps, history does NOT grow.
const historyBefore = await ev(`history.length`);
await ev(`document.querySelector('#provider-tab-gemini')?.click()`);
await sleep(300);
const switched = await ev(`(() => {
  const tabs = [...document.querySelectorAll('#provider-tabs [role="tab"]')];
  const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
  const panel = document.getElementById(sel?.getAttribute('aria-controls') ?? '');
  return { sel: sel?.dataset.provider ?? null, panelVisible: panel ? !panel.hidden : false,
           panelId: panel?.id ?? null,
           editor: !!panel?.querySelector('fieldset, .provider-head') };
})()`);
check("1440: clicking a tab selects it and swaps the editor", switched?.sel === "gemini" && switched?.panelVisible === true && switched?.editor === true, switched);
check("1440: tab clicks do not push history entries", (await ev(`history.length`)) === historyBefore, { historyBefore });

// Keyboard: ArrowDown moves selection AND focus (vertical tablist contract).
await ev(`document.querySelector('#provider-tab-gemini')?.focus()`);
await ev(`(() => {
  const tab = document.querySelector('#provider-tab-gemini');
  tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(200);
const keyed = await ev(`(() => {
  const sel = document.querySelector('#provider-tabs [role="tab"][aria-selected="true"]');
  return { sel: sel?.dataset.provider ?? null, focused: document.activeElement?.dataset.provider ?? null, tabindex: sel?.tabIndex };
})()`);
check("1440: ArrowDown moves selection to the next tab", keyed?.sel === "deepseek", keyed);
check("1440: focus follows the selection (roving tabindex)", keyed?.focused === "deepseek" && keyed?.tabindex === 0, keyed);

// Set default from the editor: the badge MOVES and persists.
await ev(`document.querySelector('#provider-tab-gemini')?.click()`);
await sleep(200);
await ev(`(() => { const c = document.querySelector('.provider-card[data-provider="gemini"] .set-default'); c?.click(); return true; })()`);
await sleep(1500);
const afterSet = await ev(`(async () => {
  const cfg = await chrome.runtime.sendMessage({ type: "provider.get" });
  const tabs = [...document.querySelectorAll('#provider-tabs [role="tab"]')];
  const badged = tabs.filter((t) => t.querySelector('.pt-default-badge')).map((t) => t.dataset.provider);
  return { provider: cfg.provider ?? null, badged };
})()`);
check("1440: set-default persists (provider.get now reports the new default)", afterSet?.provider === "gemini", afterSet);
check("1440: the badge moved to the new default's tab", afterSet?.badged?.length === 1 && afterSet?.badged?.[0] === "gemini", afterSet);
await shot(`${OUT}/providers-tabs-1440.png`);

// Reload: badge + selection survive (default badge from persisted state).
await send("Page.navigate", { url: `chrome-extension://${extId}/options/options.html` }, sessionId);
await sleep(3000);
await ev(openProviders);
await sleep(600);
const reloaded = await ev(`(() => {
  const tabs = [...document.querySelectorAll('#provider-tabs [role="tab"]')];
  const badged = tabs.filter((t) => t.querySelector('.pt-default-badge')).map((t) => t.dataset.provider);
  const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.provider ?? null;
  return { badged, sel };
})()`);
check("1440: after reload the badge is still on the persisted default", reloaded?.badged?.length === 1 && reloaded?.badged?.[0] === "gemini", reloaded);
check("1440: after reload the selected tab falls back to the default", reloaded?.sel === "gemini", reloaded);

// ---- Narrow (360x800): the rail is a horizontal scroll ROW -----------------
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
await sleep(500);
const narrowDoc = await ev(`(() => {
  const d = document.documentElement;
  const rail = document.querySelector('.provider-tabs');
  const cs = getComputedStyle(rail);
  const tab = rail.querySelector('.provider-tab');
  const hint = tab?.querySelector('.pt-hint');
  const badge = rail.querySelector('.pt-default-badge');
  return {
    docOverflow: d.scrollWidth <= d.clientWidth,
    railDir: cs.flexDirection,
    railScrolls: rail.scrollWidth >= rail.clientWidth,
    railOverflowX: cs.overflowX,
    hintHidden: hint ? getComputedStyle(hint).display === 'none' : true,
    badgeVisible: !!badge && badge.getBoundingClientRect().width > 0,
  };
})()`);
check("360px: ZERO document-level horizontal overflow", narrowDoc?.docOverflow === true, narrowDoc);
check("360px: the rail is a horizontal row that scrolls itself", narrowDoc?.railDir === "row" && narrowDoc?.railOverflowX === "auto", narrowDoc);
check("360px: hints hide at narrow width", narrowDoc?.hintHidden === true, narrowDoc);
check("360px: the DEFAULT badge stays visible on its tab", narrowDoc?.badgeVisible === true, narrowDoc);
await shot(`${OUT}/providers-tabs-360.png`);

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);

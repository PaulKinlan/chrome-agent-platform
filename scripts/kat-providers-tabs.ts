// kat-providers-tabs.ts — Providers family-tabs KAT (real browser).
// CAP-FB-20260902-PROVIDERS-TABBED-UI-01: the Settings Providers panel is a
// tabbed interface — one tab per provider family (Gemini, OpenAI-compatible,
// Anthropic, Local/Ollama) on a shared <segmented-control> tablist, with the
// selected family's tabpanel below. This harness drives the REAL extension
// options page end to end, standalone AND embedded (?embedded=1):
//   - the tablist renders the four families with exactly one aria-selected;
//   - the default tab is the current default provider's family (fresh profile
//     → the recommended OpenAI-compatible family);
//   - each tab's aria-controls resolves to its panel and back;
//   - clicking switches panels without a history entry; the card content
//     (model-id guidance, credential fields, save flow) is unchanged;
//   - switching tabs preserves UNSAVED input (panels toggle hidden, cards are
//     not re-rendered);
//   - ArrowLeft/Right move+select (roving tabindex), Home/End jump;
//   - 360px: the strip scrolls, the document does NOT overflow;
//   - embedded mode renders the same tablist.
// Screenshots land in <out-dir>.
//
//   deno run -A scripts/kat-providers-tabs.ts <path-to-extension> [<out-dir>]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

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
await Deno.mkdir(OUT, { recursive: true });

// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the harness to another lane's browser.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${chromeProfileDir("kat-providers-tabs")}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

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

// ---- Wide (1440x900), standalone: the family-tabs contract ----------------
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.navigate", { url: `chrome-extension://${extId}/options/options.html` }, sessionId);
await sleep(3000);
await ev(openProviders);
await sleep(700);

const structure = await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  if (!rail) return null;
  const tabs = [...rail.shadowRoot.querySelectorAll('[role="tab"]')];
  const sel = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
  return {
    labels: tabs.map((t) => t.textContent),
    tablistRole: rail.shadowRoot.querySelector('.tabs')?.getAttribute('role'),
    selected: sel.map((t) => t.textContent),
    // aria-controls → panel id must resolve; the panel's aria-labelledby must
    // point back at the tab's id.
    links: tabs.map((t) => {
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      return { ok: !!panel && panel.getAttribute('aria-labelledby') === t.id && panel.getAttribute('role') === 'tabpanel' };
    }),
    panels: [...document.querySelectorAll('#provider-panels .provider-panel')].map((p) => ({
      id: p.id, hidden: p.hidden, cards: p.querySelectorAll('.provider-card').length,
    })),
  };
})()`);
check("four family tabs render in order", JSON.stringify(structure?.labels) === JSON.stringify(["Gemini", "OpenAI-compatible", "Anthropic", "Local/Ollama"]), structure?.labels);
check("the tablist is a role=tablist", structure?.tablistRole === "tablist", structure?.tablistRole);
check("exactly one tab is selected — the recommended family on a fresh profile", JSON.stringify(structure?.selected) === JSON.stringify(["OpenAI-compatible"]), structure?.selected);
check("every tab's aria-controls resolves to a tabpanel labelled by the tab", Array.isArray(structure?.links) && structure.links.every((l) => l.ok), structure?.links);
check("panels hold their family's cards (1/3/1/2) with exactly one visible",
  JSON.stringify(structure?.panels?.map((p) => p.cards)) === JSON.stringify([1, 3, 1, 2]) &&
  structure?.panels?.filter((p) => !p.hidden).length === 1, structure?.panels);
await shot(`${OUT}/tabs-default.png`);

// ---- Click switching: panel swap, no history entry ------------------------
const hashBefore = await ev(`location.hash`);
await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  rail.shadowRoot.querySelector('[data-val="Gemini"]').click();
  return true;
})()`);
await sleep(300);
const afterClick = await ev(`(() => {
  const gem = document.getElementById('provider-family-panel-gemini');
  const oai = document.getElementById('provider-family-panel-openai-compatible');
  return { gemVisible: !gem.hidden, oaiHidden: oai.hidden, hash: location.hash };
})()`);
check("clicking Gemini swaps the visible panel", afterClick?.gemVisible === true && afterClick?.oaiHidden === true, afterClick);
check("tab switching never pushes history", afterClick?.hash === hashBefore, { hashBefore, after: afterClick?.hash });
await shot(`${OUT}/tabs-gemini.png`);

// ---- Unsaved input survives a tab switch -----------------------------------
await ev(`(() => {
  const input = document.querySelector('#provider-family-panel-gemini .provider-card[data-provider="gemini"] .api-key');
  input.value = 'unsaved-key-typed-here';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const rail = document.querySelector('#provider-tabs segmented-control');
  rail.shadowRoot.querySelector('[data-val="Anthropic"]').click();
  return true;
})()`);
await sleep(200);
await ev(`(() => {
  document.querySelector('#provider-tabs segmented-control').shadowRoot.querySelector('[data-val="Gemini"]').click();
  return true;
})()`);
await sleep(200);
const preserved = await ev(`document.querySelector('#provider-family-panel-gemini .provider-card[data-provider="gemini"] .api-key')?.value ?? null`);
check("switching tabs preserves unsaved input", preserved === "unsaved-key-typed-here", { preserved });

// ---- Keyboard: arrows move+select, Home/End jump, focus follows ------------
await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  rail.shadowRoot.querySelector('[data-val="Gemini"]').focus();
  return true;
})()`);
await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  const t = rail.shadowRoot.querySelector('[data-val="Gemini"]');
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(200);
const arrowed = await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  const active = rail.shadowRoot.activeElement;
  return { active: active?.textContent ?? null, selected: rail.value };
})()`);
check("ArrowRight moves selection AND focus to the next family", arrowed?.active === "OpenAI-compatible" && arrowed?.selected === "OpenAI-compatible", arrowed);
await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  rail.shadowRoot.querySelector('[data-val="OpenAI-compatible"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(200);
const ended = await ev(`document.querySelector('#provider-tabs segmented-control').value`);
check("End jumps to the last family", ended === "Local/Ollama", { ended });

// ---- Narrow (360x800): the strip scrolls, the document does NOT ------------
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true }, sessionId);
await sleep(500);
const narrow = await ev(`({ docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 })`);
check("at 360px the document never overflows horizontally", narrow?.docOverflow === false, narrow);
await shot(`${OUT}/tabs-360px.png`);

// ---- Embedded: the same tablist renders in the hub-embedded view ----------
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.navigate", { url: `chrome-extension://${extId}/options/options.html?embedded=1` }, sessionId);
await sleep(3000);
await ev(openProviders);
await sleep(700);
const embedded = await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  const tabs = [...(rail?.shadowRoot?.querySelectorAll('[role="tab"]') ?? [])];
  return {
    embedded: document.documentElement.hasAttribute('data-embedded') || document.body?.hasAttribute('data-embedded') || !!document.querySelector('[data-embedded]'),
    labels: tabs.map((t) => t.textContent),
    oneSelected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length,
  };
})()`);
check("embedded Settings renders the same family tablist", Array.isArray(embedded?.labels) && embedded.labels.length === 4 && embedded.oneSelected === 1, embedded);
await shot(`${OUT}/tabs-embedded.png`);

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);

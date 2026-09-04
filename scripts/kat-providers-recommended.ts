// kat-providers-recommended.ts — owner feature KAT (real browser).
// CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01: the Settings → Providers
// panel LEADS with a recommended card (OpenAI, gpt-5.6-luna pre-filled) in its
// family tab and an alternative (Gemini) in the Gemini family tab
// (CAP-FB-20260902-PROVIDERS-TABBED-UI-01); the flow is pick → paste key →
// Test → Use, with Use disabled until Test passes.
//
// This harness drives the REAL extension options page and captures:
//   providers-recommended-after.png  — the recommended card block (key field,
//                                        Test/Use)
//   providers-family-tabs.png        — the family tab strip
//   hub-strip-no-model.png            — the hub strip on a fresh profile
//
//   deno run -A scripts/kat-providers-recommended.ts <path-to-extension> [<out-dir>]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-providers-recommended`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-providers-recommended-${Date.now()}`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
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

await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.navigate", { url: `chrome-extension://${extId}/options/options.html` }, sessionId);
await sleep(3000);
await ev(openProviders);
await sleep(700);

// ── The recommended card's family panel (OpenAI-compatible family) ─────────
const lead = await ev(`(() => {
  const panel = document.getElementById('provider-family-panel-openai-compatible');
  const cards = [...panel.querySelectorAll('.provider-card')];
  const openai = panel.querySelector('.provider-card[data-provider="openai"]');
  const picker = openai?.querySelector('model-picker');
  return {
    groupRole: panel.querySelector('.provider-cards')?.getAttribute('role'),
    leadIds: cards.map((c) => c.dataset.provider),
    openaiBadge: openai?.querySelector('.provider-badge.recommended')?.textContent ?? null,
    openaiRadio: openai?.getAttribute('role'),
    prefillModel: picker?.getAttribute('value') ?? null,
    getKey: openai?.querySelector('.get-key')?.getAttribute('href') ?? null,
    getKeyRel: openai?.querySelector('.get-key')?.getAttribute('rel') ?? null,
    useDisabled: openai?.querySelector('.set-default')?.disabled ?? null,
  };
})()`);
check("the family's card group is a radiogroup", lead?.groupRole === "radiogroup", lead);
check("OpenAI leads the OpenAI-compatible family", JSON.stringify(lead?.leadIds) === JSON.stringify(["openai", "deepseek", "openai-compatible"]), lead);
check("OpenAI carries the Recommended pill", lead?.openaiBadge === "Recommended", lead);
check("each card is a role=radio", lead?.openaiRadio === "radio", lead);
check("the model field pre-fills gpt-5.6-luna", lead?.prefillModel === "gpt-5.6-luna", lead);
check("Get a key links the OpenAI key page with rel=noopener", lead?.getKey === "https://platform.openai.com/api-keys" && lead?.getKeyRel === "noopener", lead);
check("Use is disabled before a Test passes", lead?.useDisabled === true, lead);
await shot(`${OUT}/providers-recommended-after.png`);

// The Gemini alternative pre-fills gemini-3.7-flash and carries its pill — it
// lives in its own family tab's panel now.
const gemini = await ev(`(() => {
  const card = document.querySelector('#provider-family-panel-gemini .provider-card[data-provider="gemini"]');
  return {
    badge: card?.querySelector('.provider-badge')?.textContent ?? null,
    model: card?.querySelector('model-picker')?.getAttribute('value') ?? null,
  };
})()`);
check("Gemini carries the Alternative pill", gemini?.badge === "Alternative", gemini);
check("the Gemini card pre-fills gemini-3.7-flash", gemini?.model === "gemini-3.7-flash", gemini);

// ── The family tabs hold the remaining presets ─────────────────────────────
const tabs = await ev(`(() => {
  const rail = document.querySelector('#provider-tabs segmented-control');
  const labels = [...(rail?.shadowRoot?.querySelectorAll('[role=tab]') ?? [])].map((t) => t.textContent);
  const anth = [...document.querySelectorAll('#provider-family-panel-anthropic .provider-card')].map((c) => c.dataset.provider);
  const local = [...document.querySelectorAll('#provider-family-panel-local-ollama .provider-card')].map((c) => c.dataset.provider);
  return { labels, anth, local };
})()`);
check("four family tabs render in order", JSON.stringify(tabs?.labels) === JSON.stringify(["Gemini", "OpenAI-compatible", "Anthropic", "Local/Ollama"]), tabs);
check("Anthropic's panel holds anthropic; Local/Ollama holds the local servers", JSON.stringify(tabs?.anth) === JSON.stringify(["anthropic"]) && JSON.stringify(tabs?.local) === JSON.stringify(["ollama", "lm-studio"]), tabs);
await shot(`${OUT}/providers-family-tabs.png`);

// ── Use stays disabled until a test passes; typing a key does not enable it ──
await ev(`(() => {
  const k = document.querySelector('.provider-card[data-provider="openai"] .api-key');
  k.value = 'sk-not-a-real-key'; k.dispatchEvent(new Event('input', { bubbles: true })); return true;
})()`);
await sleep(200);
const afterType = await ev(`document.querySelector('.provider-card[data-provider="openai"] .set-default')?.disabled`);
check("Use is STILL disabled after typing a key (before Test)", afterType === true, { afterType });

// ── radiogroup keyboard: ArrowDown moves the roving focus ──────────────────
await ev(`document.querySelector('.provider-card[data-provider="openai"]').focus()`);
await ev(`(() => {
  const c = document.querySelector('.provider-card[data-provider="openai"]');
  c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(200);
const keyed = await ev(`document.activeElement?.dataset?.provider ?? null`);
check("ArrowDown moves focus to the next card (deepseek)", keyed === "deepseek", { keyed });

// ── The hub strip on a fresh profile (no keyed model) ──────────────────────
await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, sessionId);
await sleep(3000);
const strip = await ev(`(() => {
  const s = document.getElementById('provider-status');
  return { hidden: s?.hidden, text: s?.textContent ?? null };
})()`);
check("the hub strip reads 'No model connected yet' on a fresh profile", strip?.hidden === false && /No model connected yet/.test(String(strip?.text)), strip);
check("the fresh-profile strip never says 'Internal testing provider active'", !/Internal testing provider/.test(String(strip?.text)), strip);
await shot(`${OUT}/hub-strip-no-model.png`);

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);

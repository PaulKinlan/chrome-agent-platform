// kat-usage-viz.ts — Usage-panel KAT (real browser). The FolioLM-style
// visualizations must render honest charts from SEEDED ledger data, switch
// time ranges, and show an honest empty state when cleared.
//
//   deno run -A scripts/kat-usage-viz.ts <path-to-extension> [outDir]
//
// Seeding goes through the extension's OWN modules (usage-store.usageWrite +
// usage.recordToolCall) evaluated in the options page — the real storage
// contracts, no test-only routes.
//
// DOCUMENTED SCOPE (86oj review): this KAT deliberately uses the owner/options
// production seam and NO model run. The tool-usage counter is incremented on
// the owner/route path; a model run's tool executions do NOT increment it
// (that bookkeeping split is the product question tracked as
// chrome-agent-platform-q2we). What this harness proves: the Usage panel
// renders honestly from real stored data. Counter-on-run behavior, if the
// product decision changes, needs a run-driven probe then.
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir("cap-usage-viz-kats");
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
    `--user-data-dir=${chromeProfileDir("kat-usage-viz")}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
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
await sleep(1200);

async function evaluate<T = any>(expression: string): Promise<T> {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  return r.result?.result?.value;
}
async function screenshot(name: string) {
  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(shot.result.data), c => c.charCodeAt(0)));
}

// ── Seed through the extension's own storage modules (real contracts) ──────
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const seedRows = [] as any[];
for (const [off, agent, provider, model, inp, outp, cost] of [
  [0, "hub", "openai", "gpt-5.4-mini", 5200, 1400, 0.012],
  [0.2 * day, "agent-sites", "anthropic", "claude-sonnet-5", 2100, 900, 0.006],
  [1 * day, "hub", "openai", "gpt-5.4-mini", 4400, 1100, 0.01],
  [2 * day, "agent-sites", "google", "gemini-3.7-flash", 1500, 700, 0.001],
  [3 * day, "hub", "openai", "gpt-5.4-mini", 3600, 980, 0.009],
] as any[]) {
  seedRows.push({ id: `seed-${off}-${model}`, timestamp: iso(now - off), agentId: agent, taskId: "kat",
    provider, model, inputTokens: inp, outputTokens: outp, totalTokens: inp + outp, estimatedCost: cost });
}
await evaluate(`(async () => {
  const store = await import(chrome.runtime.getURL("lib/usage-store.js"));
  await store.usageWrite(${JSON.stringify(seedRows)});
  return "ledger-seeded";
})()`);
// Tool counters are seeded through the extension's OWN usage module — the
// REAL counting function (usage.recordToolCall) evaluated in the options
// page, the same module the SW imports; pure kv storage, no test-only route.
// (A live run's tool executions do not increment this counter — that is the
// worker-bridge route's behavior, not this KAT's subject: this KAT charts
// seeded usage data.)
const toolSeed = await evaluate(`(async () => {
  const usage = await import(chrome.runtime.getURL("lib/usage.js"));
  await usage.recordToolCall("list_tabs"); await usage.recordToolCall("list_tabs");
  await usage.recordToolCall("list_agents"); await usage.recordToolCall("list_agents"); await usage.recordToolCall("list_agents");
  return "tools-seeded";
})()`);
check("tool counters seeded through the extension's own usage module", toolSeed === "tools-seeded", toolSeed);

// Open the Usage section (the nav click is the real user path).
await evaluate(`(() => { document.querySelector('[data-section="usage"]')?.click(); return document.querySelector("#usage")?.classList?.contains("active") ?? "clicked"; })()`);
await sleep(900);

const cards = await evaluate(`(() => {
  const cards = [...document.querySelectorAll("#usage-cards .usage-stat")];
  return cards.map((c) => ({ label: c.querySelector(".l")?.textContent, value: c.querySelector(".n")?.textContent }));
})()`);
check("5 stat cards render (tokens/in/out/cost/calls)", cards.length === 5, cards);
const costNote = await evaluate(`document.querySelector(".usage-cost-note")?.textContent ?? ""`);
check("cost card is labelled an estimate", String(costNote).includes("estimate"), costNote);

const daily = await evaluate(`(() => {
  const svg = document.querySelector("#usage-chart-days svg");
  return { present: !!svg, bars: svg ? svg.querySelectorAll(".usage-bar-in").length : 0, outBars: svg ? svg.querySelectorAll(".usage-bar-out").length : 0, role: svg?.getAttribute("role"), label: svg?.getAttribute("aria-label") };
})()`);
check("daily chart renders with in+out bars", daily.present === true && daily.bars >= 3 && daily.outBars >= 3, daily);
check("daily chart is an accessible image (role=img + aria-label)", daily.role === "img" && !!daily.label, daily);

const models = await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#usage-chart-models .usage-share-row")];
  return { count: rows.length, labels: rows.map((r) => r.querySelector(".usage-share-label")?.textContent) };
})()`);
check("per-model share bars render (gpt-5.4-mini leads)", models.count >= 2 && models.labels[0] === "gpt-5.4-mini", models);

const agents = await evaluate(`document.querySelectorAll("#usage-chart-agents .usage-share-row").length`);
check("per-agent share bars render", agents >= 2, agents);

const tools = await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#usage-chart-tools .usage-share-row")];
  return { count: rows.length, first: rows[0]?.querySelector(".usage-share-label")?.textContent, firstVal: rows[0]?.querySelector(".usage-share-value")?.textContent };
})()`);
check("tool-usage chart renders the executed tools (list_agents leads)", tools.count === 2 && tools.first === "list_agents", tools);

// Scroll the Usage section into view (single-page settings; the shot must
// show the panel under test) and wait for the smooth scroll to settle.
await evaluate(`document.querySelector("#usage").scrollIntoView({ behavior: "instant", block: "start" })`);
await sleep(700);
await screenshot("usage-1440-light");

// Dark scheme renders the same data with themed colors (token-driven).
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
await sleep(500);
const bgDark = await evaluate(`getComputedStyle(document.body).backgroundColor`);
await screenshot("usage-1440-dark");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
await sleep(500);
const bgLight = await evaluate(`getComputedStyle(document.body).backgroundColor`);
check("emulated dark actually flips the palette", bgDark !== bgLight && typeof bgDark === "string", { bgDark, bgLight });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
await sleep(400);
check("chart fills resolve through theme tokens (var-backed, not inline)", !(await evaluate(`!!document.querySelector('#usage-chart-days svg [style*="fill"]')`)), "no inline fills");

// Range switch: 24h shows fewer day buckets but stays honest.
await evaluate(`[...document.querySelectorAll(".usage-range")].find((b) => b.dataset.range === "24h")?.click()`);
await sleep(600);
const rangeState = await evaluate(`(() => ({
  selected: document.querySelector('.usage-range[aria-selected="true"]')?.dataset.range,
  bars: document.querySelectorAll("#usage-chart-days .usage-bar-in").length,
}))()`);
check("24h range switches and re-renders", rangeState.selected === "24h" && rangeState.bars >= 1, rangeState);

// Narrow viewport screenshot (360px) — no horizontal overflow.
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
await sleep(500);
const overflow360 = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check("no horizontal overflow at 360px", Number(overflow360) <= 0, overflow360);
await screenshot("usage-360-light");
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
await sleep(300);

// Honest empty state: clear through the real route, re-render.
await evaluate(`(async () => {
  const usage = await import(chrome.runtime.getURL("lib/usage.js"));
  await usage.clearUsage();
})()`);
await evaluate(`document.querySelector('[data-section="hub"], [data-section]:not([data-section="usage"])')?.click()`);
await sleep(300);
await evaluate(`document.querySelector('[data-section="usage"]')?.click()`);
await sleep(900);
const empty = await evaluate(`document.querySelector("#usage-chart-days svg")?.getAttribute("aria-label") ?? ""`);
check("cleared ledger shows the honest empty state", empty.includes("no data"), empty);
await screenshot("usage-empty");

await send("Target.closeTarget", { targetId });
await proc.kill();
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);

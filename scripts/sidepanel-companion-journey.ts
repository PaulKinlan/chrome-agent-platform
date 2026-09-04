// sidepanel-companion-journey.ts — CAP-FB-20260830-SIDE-PANEL-COMPANION-01.
//
// Drives the REAL loaded extension in headless Chromium to attest the side
// panel Page view is a companion pinned to the current tab:
//   - at 360px and 400px no control wraps (every visible button ≤ 44px tall)
//     and there is exactly one <h1> (the two-H1 bug is gone),
//   - the header shows the ACTIVE tab's host (the panel queries chrome.tabs and
//     updates when the active tab changes),
//   - a keyless @demo-tools run from the panel's own composer renders tool
//     cards INSIDE the panel conversation.
// Screenshots: sidepanel-360.png, sidepanel-companion.png.
//
// The debugging port is kernel-assigned and read back from THIS Chrome by the
// shared launcher (never a fixed port — CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
//
//   deno run -A scripts/sidepanel-companion-journey.ts [extension-dir] [out-dir]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`sidepanel-companion-${Date.now()}`);
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await Deno.mkdir(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map<string, (v: any) => void>();
const cdp = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse((m as any).data);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const evaluate = async (expr: string, sessionId: string) => {
  const j = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  return j.result?.result?.value ?? null;
};

try {
  const sw = await waitForServiceWorker((m, p, s) => cdp(m, p, s));
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;
  const { result: { sessionId: swS } } = await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  const swEval = (expr: string) => evaluate(expr, swS);
  check("extension loaded", typeof extId === "string" && extId.length > 0, { extId });

  // The keyless demo model's markers (@demo-tools) drive deterministic REAL
  // tool calls with no API key — best-effort enable the developer flag (a no-op
  // where markers are not flag-gated).
  await swEval(`new Promise(res => { try { chrome.storage?.local?.set({ "cap:developerFeatures": true }, () => res(true)); } catch { res(false); } })`).catch(() => {});

  // Open a real http tab so the companion has an active tab to pin to.
  await cdp("Target.createTarget", { url: "https://example.com/" });
  await sleep(1500);
  // Open the side panel page as a target and attach.
  const { result: { targetId: spTarget } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel/sidepanel.html` });
  await sleep(1800);
  const { result: { sessionId: sp } } = await cdp("Target.attachToTarget", { targetId: spTarget, flatten: true });
  await cdp("Page.enable", {}, sp);
  const spEval = (expr: string) => evaluate(expr, sp);

  // Make the example.com tab the ACTIVE tab so the companion pins to it (the
  // panel page keeps running while not itself active — as a real side panel).
  await swEval(`new Promise(async res => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => (x.url || "").startsWith("https://example.com"));
    if (t) await chrome.tabs.update(t.id, { active: true });
    res(!!t);
  })`);
  await sleep(1500);

  // ── The active-tab header ───────────────────────────────────────────────
  const host = await spEval(`document.getElementById('tab-host')?.textContent ?? ''`);
  check("side panel: header shows the active tab host", host === "example.com", { host });

  // ── Layout at 360px and 400px: one h1, no control wraps ─────────────────
  async function layoutAt(width: number) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 760, deviceScaleFactor: 1, mobile: false }, sp);
    await sleep(400);
    return await spEval(`(() => {
      const h1 = document.querySelectorAll('h1').length;
      const btns = [...document.querySelectorAll('#page-view button, .tabs [role="tab"]')]
        .filter(b => b.offsetParent !== null);
      const heights = btns.map(b => b.clientHeight);
      const bodyOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      return { h1, maxBtn: Math.max(0, ...heights), count: btns.length, bodyOverflow };
    })()`);
  }
  const l360 = await layoutAt(360);
  check("side panel: exactly one <h1> at 360px", l360?.h1 === 1, l360);
  check("side panel: no control wraps at 360px (every visible button ≤ 44px tall)", l360?.maxBtn <= 44, l360);
  check("side panel: no horizontal body overflow at 360px", l360?.bodyOverflow <= 0, l360);
  await Deno.writeFile(`${OUT}/sidepanel-360.png`, decodeShot((await cdp("Page.captureScreenshot", { format: "png" }, sp)).result.data));

  const l400 = await layoutAt(400);
  check("side panel: exactly one <h1> at 400px", l400?.h1 === 1, l400);
  check("side panel: no control wraps at 400px (every visible button ≤ 44px tall)", l400?.maxBtn <= 44, l400);

  // ── A keyless @demo-tools run renders tool cards INSIDE the panel ───────
  await cdp("Emulation.setDeviceMetricsOverride", { width: 500, height: 820, deviceScaleFactor: 1, mobile: false }, sp);
  await sleep(300);
  await spEval(`(() => { document.getElementById('page-composer').dispatchEvent(new CustomEvent('send', { detail: { text: '@demo-tools list my open tabs', attachments: [] }, bubbles: true })); return true; })()`);
  // wait for the run to settle and the tool cards to render
  let toolCards = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    toolCards = await spEval(`document.getElementById('page-history')?.querySelectorAll('message-bubble[role="tool"]').length ?? 0`);
    if (toolCards >= 1) break;
  }
  check("side panel: a keyless @demo-tools run renders tool cards in the panel", toolCards >= 1, { toolCards });

  // "Continue in hub" becomes available once the run settles and the tab has a
  // thread (the send handler un-hides it after the turn resolves).
  let continueVisible = false;
  for (let i = 0; i < 20; i++) {
    continueVisible = await spEval(`(() => { const b = document.getElementById('continue-hub'); return !!b && !b.hidden; })()`);
    if (continueVisible) break;
    await sleep(1000);
  }
  check("side panel: 'Continue in hub' is offered once the tab has a thread", continueVisible === true, { continueVisible });

  await Deno.writeFile(`${OUT}/sidepanel-companion.png`, decodeShot((await cdp("Page.captureScreenshot", { format: "png" }, sp)).result.data));

  console.log(`\nsidepanel-companion-journey: ${pass} passed, ${fail} failed`);
  console.log(`evidence: ${OUT}`);
} catch (e) {
  console.error("HARNESS ERROR:", e);
  fail++;
} finally {
  try { ws.close(); } catch { /* */ }
  try { proc.kill("SIGKILL"); } catch { /* */ }
  try { await proc.status; } catch { /* */ }
}

function decodeShot(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.exit(fail === 0 ? 0 : 1);

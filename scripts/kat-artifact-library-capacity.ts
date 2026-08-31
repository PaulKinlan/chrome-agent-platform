// kat-artifact-library-capacity.ts — real loaded-extension check for
// CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01. Proves (1) the `asset.capacity`
// route answers with the real library's byte accounting, and (2) the artifacts
// gallery renders the capacity indicator for the filling and full states and
// keeps it hidden in the steady state. The full/filling states are driven by
// stubbing the `asset.capacity` response in the page BEFORE the module loads
// (addScriptToEvaluateOnNewDocument), which exercises the REAL renderCapacity
// DOM path — the store's 2 MiB bound cannot be filled in a headless run.
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${Deno.env.get("HOME")}/.cache/cap-artifact-library-capacity`;
const CHROME = "/usr/lib/chromium/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const results: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
function check(name: string, condition: boolean, detail?: unknown) {
  results.push({ name, passed: condition, ...(condition ? {} : { detail }) });
  if (condition) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

await Deno.mkdir(OUT, { recursive: true });
const profile = `${OUT}/profile-${Date.now()}`;
const { proc, wsUrl } = await launchChrome({
  binary: CHROME,
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`, "--remote-allow-origins=*",
    "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => ws.onopen = resolve);
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
};
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<any>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

async function openPage(url: string, onNewDoc?: string) {
  const created = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
  const page = attached.result.sessionId;
  await send("Runtime.enable", {}, page);
  await send("Page.enable", {}, page);
  if (onNewDoc) await send("Page.addScriptToEvaluateOnNewDocument", { source: onNewDoc }, page);
  await send("Page.navigate", { url }, page);
  await sleep(2500);
  return page;
}
async function evaluate(page: string, expression: string) {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, page);
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? "evaluate failed");
  return res.result?.result?.value;
}
async function screenshot(page: string, name: string) {
  const shot = await send("Page.captureScreenshot", { format: "png" }, page);
  if (shot.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
}

// A page-side stub of chrome.runtime.sendMessage for `asset.capacity` only —
// every other route falls through to the real service worker.
function stub(cap: Record<string, unknown>) {
  return `(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (msg, cb) {
      if (msg && msg.type === 'asset.capacity') {
        const res = ${JSON.stringify({ ok: true, ...cap })};
        if (typeof cb === 'function') { cb(res); return; }
        return Promise.resolve(res);
      }
      return real(msg, cb);
    };
  })();`;
}

try {
  const worker = await waitForServiceWorker(send, {
    match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"),
  });
  if (!worker) throw new Error("service worker did not register");
  const extId = new URL(worker.url).host;
  const galleryUrl = `chrome-extension://${extId}/artifacts/index.html`;

  // 2) Steady state (few artifacts): the indicator stays hidden. Open the real
  //    gallery page — an extension page can invoke the routes.
  const pageSteady = await openPage(galleryUrl);

  // 1) The real route answers with the store's byte accounting (called from the
  //    gallery page context; the SW cannot sendMessage to itself). Create a
  //    couple of artifacts first so count reflects them.
  const cap = await evaluate(pageSteady, `(async () => {
    const s = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    await s({ type: 'asset.create', origin: 'master', assetType: 'text', name: 'cap probe 1', content: 'a' });
    await s({ type: 'asset.create', origin: 'master', assetType: 'text', name: 'cap probe 2', content: 'b' });
    return await s({ type: 'asset.capacity' });
  })()`);
  check("asset.capacity route returns ok with byte accounting", !!cap && cap.ok === true
    && Number.isFinite(cap.usedBytes) && cap.maxBytes === 2 * 1024 * 1024 && cap.count >= 2 && cap.full === false, cap);

  const steadyHidden = await evaluate(pageSteady, `document.getElementById('capacity')?.hidden === true`);
  check("capacity indicator hidden in the steady state", steadyHidden === true, steadyHidden);
  await screenshot(pageSteady, "01-steady-hidden");

  // 3) Filling state (85%): a warning indicator appears.
  const pageWarn = await openPage(galleryUrl, stub({ count: 12000, usedBytes: Math.round(2 * 1024 * 1024 * 0.85), maxBytes: 2 * 1024 * 1024, fraction: 0.85, regenerableCount: 0, full: false }));
  const warn = await evaluate(pageWarn, `(() => { const c = document.getElementById('capacity'); return { hidden: c.hidden, cls: c.className, text: c.textContent }; })()`);
  check("capacity indicator shows a filling-up warning at 85%", warn && warn.hidden === false && /warn/.test(warn.cls) && /filling up/i.test(warn.text) && /85%/.test(warn.text), warn);
  await screenshot(pageWarn, "02-filling-warn");

  // 4) Full state: a red 'Library full' indicator; copy says nothing is dropped.
  const pageFull = await openPage(galleryUrl, stub({ count: 15200, usedBytes: 2 * 1024 * 1024, maxBytes: 2 * 1024 * 1024, fraction: 1, regenerableCount: 0, full: true }));
  const full = await evaluate(pageFull, `(() => { const c = document.getElementById('capacity'); return { hidden: c.hidden, cls: c.className, text: c.textContent }; })()`);
  check("capacity indicator shows a FULL state that promises nothing is auto-removed", full && full.hidden === false && /full/.test(full.cls) && /Library full/i.test(full.text) && /removed automatically/i.test(full.text), full);
  await screenshot(pageFull, "03-full");

} catch (e) {
  check("harness completed without throwing", false, String((e as Error)?.message ?? e));
} finally {
  await Deno.writeTextFile(`${OUT}/report.json`, JSON.stringify({ passed, failed, results }, null, 2));
  try { ws.close(); } catch { /* ignore */ }
  try { proc.kill("SIGKILL"); } catch { /* ignore */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
Deno.exit(failed === 0 ? 0 : 1);

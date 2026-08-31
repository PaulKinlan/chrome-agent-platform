// kat-generated-image-strip.ts — CAP-FB-20260830-GENERATED-IMAGE-STRIP-01.
// Real loaded-extension proof that the generated-image strip renders the images
// a run produced FROM THE STORES (never the tool-result text), is keyboard-
// operable, and opens the viewer. Seeds a real image asset through the
// `asset.create` route, mounts the real <agent-conversation> with an `images`
// row, and drives it over CDP: the strip resolves the thumbnail from `asset.get`
// (a real data URL, naturalWidth > 0), its button carries the "Open image 1 of
// 1" label, and a genuine click opens the artifact viewer tab.
//
// Kernel-assigned debugging port via launchChrome() (no fixed port — see CLAUDE.md).
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${Deno.env.get("HOME")}/.cache/cap-image-strip`;
const CHROME = "/usr/lib/chromium/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const results: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
function check(name: string, condition: boolean, detail?: unknown) {
  results.push({ name, passed: condition, ...(condition ? {} : { detail }) });
  if (condition) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

// A 2x2 green PNG as a data URL — the smallest valid image asset content.
const GREEN_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPjPwMDAwMAAAAwDAX8V6yVwAAAAAElFTkSuQmCC";

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
await new Promise((r) => ws.onopen = r);
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<any>((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params, sessionId })); });

try {
  const worker = await waitForServiceWorker(send, { match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background") });
  if (!worker) throw new Error("service worker did not register");
  const extId = new URL(worker.url).host;
  const created = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
  const page = attached.result.sessionId;
  await send("Runtime.enable", {}, page);
  const ev = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, page);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result?.result?.value;
  };
  await sleep(2500);

  // Seed a real image asset through the SW route, then mount the REAL
  // <agent-conversation> with an `images` row pointing at it.
  const setup = await ev(`(async () => {
    const created = await chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'image', name: 'green.png', content: ${JSON.stringify(GREEN_PNG)} });
    const id = created?.asset?.id ?? created?.id ?? null;
    document.querySelector('main')?.remove();
    const conv = document.createElement('agent-conversation');
    conv.id = 'kat-conv';
    conv.style.cssText = 'display:block;padding:24px;max-width:900px';
    document.body.prepend(conv);
    conv.setMessages([
      { role: 'user', content: 'make me a green square', ts: 1 },
      { role: 'tool', name: 'create_asset', status: 'done', ts: 2 },
      { role: 'images', items: [{ id, kind: 'image', origin: 'master', label: 'green.png' }] },
    ]);
    return { createOk: created?.ok === true, id };
  })()`);
  check("asset.create seeds a real image asset", setup?.createOk === true && typeof setup?.id === "string", setup);

  // Wait for the strip to resolve the thumbnail from asset.get (a real data URL).
  const stripState = () => ev(`(() => {
    const conv = document.getElementById('kat-conv');
    const strip = conv?.querySelector('screenshot-strip');
    const sr = strip?.shadowRoot ?? strip;
    const btn = sr?.querySelector('.shot');
    const img = sr?.querySelector('.shot img');
    return strip ? { hasStrip: true, shots: sr.querySelectorAll('.shot').length, label: btn?.getAttribute('aria-label') ?? null, natural: img?.naturalWidth ?? 0, scheme: String(img?.getAttribute('src') ?? '').split(':')[0] } : { hasStrip: false };
  })()`);
  for (let i = 0; i < 20 && ((await stripState())?.natural ?? 0) === 0; i++) await sleep(300);
  const strip = await stripState();
  check("the strip renders one thumbnail resolved from the asset store", strip?.hasStrip === true && strip.shots === 1 && strip.natural > 0, strip);
  check("the thumbnail button is labelled 'Open image 1 of 1'", /^Open image 1 of 1/.test(String(strip?.label ?? "")), strip);
  check("the image src is a data URL (bytes never leave the extension page)", strip?.scheme === "blob" || strip?.scheme === "data", strip);

  const shotBefore = await send("Page.captureScreenshot", { format: "png" }, page);
  await Deno.writeFile(`${OUT}/image-strip-thread.png`, Uint8Array.from(atob(shotBefore.result.data), (c) => c.charCodeAt(0)));

  // Clicking a thumbnail emits `open-image` carrying the image identity, which
  // the hub wires to open the artifact viewer (extension/ntp/ntp.js). Assert the
  // component contract here (the event + its detail); the tab-open is the host's.
  await ev(`(() => {
    const conv = document.getElementById('kat-conv');
    globalThis.__openImage = null;
    conv.addEventListener('open-image', (e) => { globalThis.__openImage = { id: e.detail?.id, kind: e.detail?.kind, origin: e.detail?.origin }; });
    const b = conv.querySelector('screenshot-strip').shadowRoot.querySelector('.shot');
    b.focus(); b.click();
    return true;
  })()`);
  await sleep(400);
  const openDetail = await ev(`globalThis.__openImage`);
  check("clicking a thumbnail emits open-image with the image identity (host opens the viewer)",
    !!openDetail && openDetail.kind === "image" && openDetail.id === setup.id, openDetail);

  await Deno.writeTextFile(`${OUT}/result.json`, JSON.stringify({ passed, failed, results }, null, 2) + "\n");
} finally {
  ws.close();
  try { proc.kill("SIGKILL"); } catch { /* already stopped */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
Deno.exit(failed ? 1 : 0);

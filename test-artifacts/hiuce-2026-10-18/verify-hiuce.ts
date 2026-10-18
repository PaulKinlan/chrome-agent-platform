// test-artifacts/hiuce-2026-10-18/verify-hiuce.ts — bounded real-browser pass for chrome-agent-platform-hiuce
//
// (1) 89rk4: the Settings diagnostics copy that replaced the retired page-console
//     WebMCP diagnostic must READ correctly and name service-worker injection logs.
// (2) oagmf: the <approval-card> script-registration disclosure must render the
//     digest / id / matches / runAt / world for a real payload, list a nine-match
//     request in full (no silent truncation), and a >8 request must be REFUSED by
//     the projection rather than truncated.
//
// One browser, closed in a finally. Screenshots land beside this script.
//   deno run -A test-artifacts/hiuce-2026-10-18/verify-hiuce.ts
import { launchChrome, teardownChrome } from "../../scripts/lib/chrome-launch.ts";
import { durableDir } from "../../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = fileURLToPath(new URL(".", import.meta.url));
await Deno.mkdir(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail).slice(0, 600)}`); }
}

const tmp = durableDir(`cap-hiuce-${Date.now()}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chrome: any = null;
let ws: WebSocket | null = null;

try {
  chrome = await launchChrome({
    binary: "/home/exedev/.cache/puppeteer/chrome/linux-154.0.8037.92/chrome-linux64/chrome",
    extension: `${ROOT}extension`,
    profile: tmp,
    lockPath: `${tmp}/chrome.lock`,
    timeoutMs: 30000,
    // Chrome 137+ gates the --load-extension switch behind a feature flag; a CfT build
    // otherwise ignores it and the extension never appears (no service worker target).
    args: ["--disable-features=DisableLoadExtensionCommandLineSwitch"],
  });
  const port = chrome.port;
  let worker = null;
  for (let i = 0; i < 60 && !worker; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    worker = targets.find((t: any) => t.type === "service_worker" && typeof t.url === "string" && t.url.includes("dist/background/service-worker.js"));
    if (!worker) await sleep(200);
  }
  if (!worker) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    throw new Error("extension service worker did not load; targets: " + list.map((t: any) => `${t.type} ${t.url}`).join(" | ").slice(0, 600));
  }
  console.log("worker:", worker.url);
  const extId = new URL(worker.url).host;

  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws = new WebSocket(chrome.wsUrl);
  await new Promise<void>((res, rej) => { (ws as WebSocket).onopen = () => res(); (ws as WebSocket).onerror = () => rej(new Error("cdp ws failed")); });
  (ws as WebSocket).onmessage = (event) => {
    const msg = JSON.parse(event.data as string);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  };
  const send = (method: string, params: unknown = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      (ws as WebSocket).send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  const evaluate = async (sessionId: string, expression: string) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const shot = async (sessionId: string, name: string) => {
    const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
    await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
  };

  // ── (1) the Settings diagnostics copy ────────────────────────────────────
  const target = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
  const page = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, page);
  await send("Page.enable", {}, page);
  await sleep(2500);

  const copy = await evaluate(page, `(() => {
    const el = document.querySelector('[data-i18n="options_diagnostics_logs_help"]');
    // The diagnostics row lives inside a collapsed section, so body.innerText omits it; the
    // rendered copy is the element's own text (this is what an owner reads once expanded).
    const text = (el ? el.innerText : '') + ' ' + document.body.innerText;
    const pageConsole = (text.match(/page-console/gi) ?? []).length;
    const liveToggle = !!document.querySelector('#diag-page-console, [id*="page-console"]');
    return {
      rendered: el ? el.innerText : null,
      hasServiceWorkerCopy: /service-worker DevTools console/i.test(text),
      pageConsoleMentions: pageConsole,
      rawKeyVisible: text.includes('options_diagnostics_logs_help'),
      liveToggle,
      textLength: text.length,
    };
  })()`);
  console.log("options:", JSON.stringify(copy));
  check("options: the diagnostics help renders as copy, not as a raw i18n key", copy.rawKeyVisible === false && (copy.rendered ?? "").length > 20, copy);
  check("options: it names the service-worker DevTools console", copy.hasServiceWorkerCopy === true, copy);
  check("options: 'Page-console diagnostics remain off' is the ONLY page-console mention", copy.pageConsoleMentions === 1, copy);
  check("options: no live page-console diagnostic control remains", copy.liveToggle === false, copy);

  await evaluate(page, `(() => { const el = document.querySelector('[data-i18n="options_diagnostics_logs_help"]'); el?.scrollIntoView({block:'center'}); return true; })()`);
  await sleep(400);
  await shot(page, "1-options-diagnostics");

  // ── (2) the approval card's script-registration disclosure ───────────────
  const hubTarget = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const hub = (await send("Target.attachToTarget", { targetId: hubTarget.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, hub);
  await send("Page.enable", {}, hub);
  await sleep(3000);
  const DIGEST = "b".repeat(64);
  const cardReport = await evaluate(hub, `(async () => {
    // conversation.js only exports helpers (it defines no custom elements), so importing it
    // beside the page's own bundle cannot double-define the design system.
    const { boundScriptRegistrationApprovalDetail } = await import('/shared/conversation.js');
    if (!customElements.get('approval-card')) throw new Error('the hub bundle did not register approval-card');
    const host = document.createElement('div');
    host.id = 'cap-hiuce-card-host';
    host.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:2147483647;background:#fff;padding:12px;max-height:80vh;overflow:auto';
    document.body.append(host);

    const payload = (n) => ({
      kind: 'script-registration',
      scriptKind: 'content_script',
      id: 'script-42',
      digest: ${JSON.stringify(DIGEST)},
      matches: Array.from({ length: n }, (_, i) => 'https://site' + i + '.example/*'),
      jsBytes: 48213,
      runAt: 'document_idle',
      world: 'ISOLATED',
    });

    const eight = boundScriptRegistrationApprovalDetail(payload(8));
    const nine = boundScriptRegistrationApprovalDetail(payload(9));
    const card = document.createElement('approval-card');
    card.setAttribute('title', 'Register a content script?');
    card.setAttribute('body', 'This page wants to register a content script in every matching tab.');
    card.detail = payload(8);
    host.append(card);
    await new Promise((r) => setTimeout(r, 250));
    const sr = card.shadowRoot;
    const text = sr ? sr.textContent : '';
    const box = card.getBoundingClientRect();
    const scroll = host.scrollWidth - host.clientWidth;
    const matches = sr ? sr.querySelectorAll('.registration-detail li').length : -1;
    const digestEl = sr?.querySelector('.digest')?.textContent ?? '';
    return {
      eight: eight ? { matches: eight.matches.length, digest: eight.digest.slice(0, 8), runAt: eight.runAt, world: eight.world } : null,
      nineRefused: nine === undefined,
      text,
      width: Math.round(box.width), height: Math.round(box.height),
      overflowX: scroll,
      matchesRendered: matches,
      digestRendered: digestEl === ${JSON.stringify(DIGEST)},
      approveButtons: sr ? sr.querySelectorAll('button.approve').length : 0,
      denyButtons: sr ? sr.querySelectorAll('button.deny').length : 0,
    };
  })()`);
  console.log("card:", JSON.stringify(cardReport).slice(0, 900));
  check("card: an eight-match registration projects (8 matches kept whole)", cardReport.eight?.matches === 8, cardReport.eight);
  check("card: a nine-match registration is REFUSED, not truncated", cardReport.nineRefused === true, cardReport.nineRefused);
  check("card: the card takes a real box (not zero/one-line)", cardReport.width > 300 && cardReport.height > 120, { w: cardReport.width, h: cardReport.height });
  check("card: no horizontal overflow (body bound removed did not break layout)", cardReport.overflowX === 0, cardReport.overflowX);
  check("card: the full SHA-256 digest renders", cardReport.digestRendered === true, cardReport.digestRendered);
  check("card: the script id renders", /script-42/.test(cardReport.text), cardReport.text.slice(0, 300));
  check("card: runAt and world render", /document_idle/.test(cardReport.text) && /ISOLATED/.test(cardReport.text), cardReport.text.slice(0, 300));
  check("card: all eight matches are listed", cardReport.matchesRendered === 8, cardReport.matchesRendered);
  check("card: size renders in bytes", /48,213 bytes/.test(cardReport.text), cardReport.text.slice(0, 300));
  check("card: approve and deny affordances present", cardReport.approveButtons === 1 && cardReport.denyButtons === 1, cardReport);

  await shot(hub, "2-approval-card-script-registration");
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { if (chrome) await teardownChrome(chrome, tmp); } catch { /* ignore */ }
  try { await Deno.remove(tmp, { recursive: true }); } catch { /* ignore */ }
}
console.log(`\n${fail === 0 ? "GREEN" : "RED"}: ${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);

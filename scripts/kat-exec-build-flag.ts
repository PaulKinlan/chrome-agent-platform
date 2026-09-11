// kat-exec-build-flag.ts — CAP-FB-20260830-EXEC-BUILD-FLAG-01 KAT.
//
// Drives the REAL loaded extension's Settings page in headless Chromium on a
// FRESH profile (so `cap:developerFeatures` is unset → the flag is OFF) and
// proves:
//   1. With the flag OFF the developer nav items + panels (tool-library,
//      board-permissions, hooks, prompts) and the provider server-tools card
//      are HIDDEN — the default nav is the reduced set.
//   2. A deep link to a hidden developer section (#hooks) is NOT a dead link —
//      the "Developer feature … turn on in About" notice appears.
//   3. Toggling "Show developer features" ON in About reveals every developer
//      nav item + panel and the server-tools card (nothing was deleted).
//
//   deno run -A scripts/kat-exec-build-flag.ts
//
// Uses the mandated launchChrome() (kernel-assigned port, read from stderr) —
// never a fixed debugging port.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const EVIDENCE = Deno.env.get("CAP_EVIDENCE_DIR") ?? durableDir("cap-exec-build-flag-kats");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

// ── minimal CDP client ──────────────────────────────────────────────────────
class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: number }>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data as string);
      if (d.id && this.pending.has(d.id)) {
        const { resolve, reject, timer } = this.pending.get(d.id)!;
        clearTimeout(timer);
        this.pending.delete(d.id);
        d.error ? reject(new Error(`cdp ${d.error.code}: ${d.error.message}`)) : resolve(d);
      }
    };
  }
  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function openSession(cdp: Cdp, port: number, url: string) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: "PUT" });
  const target = await res.json();
  const a = await cdp.send("Target.attachToTarget", { targetId: target.id, flatten: true });
  const session = a.result.sessionId as string;
  await cdp.send("Runtime.enable", {}, session);
  await cdp.send("Page.enable", {}, session);
  return { session, targetId: target.id as string };
}

async function evalIn(cdp: Cdp, session: string, expression: string) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.result?.exceptionDetails) throw new Error(`eval threw: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
  return r.result?.result?.value;
}

async function shot(cdp: Cdp, session: string, name: string) {
  // Evidence is best-effort — a capture flake must never fail the KAT (the
  // assertions above already carry the verdict).
  try {
    await cdp.send("Emulation.setScrollbarsHidden", { hidden: true }, session).catch(() => {});
    const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, session);
    const b64 = r.result?.data;
    if (!b64) return false;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await Deno.mkdir(EVIDENCE, { recursive: true });
    await Deno.writeFile(`${EVIDENCE}/${name}`, bytes);
    console.log(`  evidence: ${EVIDENCE}/${name} (${bytes.length} bytes)`);
    return true;
  } catch (e) {
    console.log(`  (screenshot ${name} skipped: ${String((e as Error)?.message ?? e)})`);
    return false;
  }
}

// The four developer sections and a couple of user-facing controls that must
// STAY visible with the flag off.
const DEV = ["tool-library", "board-permissions", "hooks", "prompts"];
const USER = ["providers", "agents", "permissions", "skills", "usage", "data", "about"];

const VISIBILITY = (ids: string[]) => `(() => {
  const out = {};
  for (const id of ${JSON.stringify(ids)}) {
    const nav = document.querySelector('.nav-item[data-section="' + id + '"]');
    const sec = document.getElementById(id);
    out[id] = {
      navHidden: nav ? nav.hidden || getComputedStyle(nav).display === 'none' : null,
      secHidden: sec ? sec.hidden || getComputedStyle(sec).display === 'none' : null,
    };
  }
  const card = document.getElementById('server-tools-card');
  out.__serverToolsHidden = card ? card.hidden || getComputedStyle(card).display === 'none' : null;
  out.__visibleNav = [...document.querySelectorAll('.nav-item')].filter((n) => !(n.hidden || getComputedStyle(n).display === 'none')).map((n) => n.dataset.section);
  return out;
})()`;

async function main() {
  const profile = await Deno.makeTempDir({ prefix: "cap-exec-flag-kat-" });
  const { proc, wsUrl } = await launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--window-size=1400,2200", `--user-data-dir=${profile}`, "about:blank",
    ],
    stdout: "null",
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = (e) => rej(e); });
  const cdp = new Cdp(ws);
  const sw = await waitForServiceWorker(cdp.send.bind(cdp), { timeoutMs: 20000 });
  if (!sw) { console.log("FAIL: service worker never registered"); Deno.exit(1); }
  const extId = sw.url.split("/")[2];
  console.log(`extension id: ${extId}`);

  try {
    // ── 1. Fresh profile → flag OFF → reduced Settings nav ──────────────────
    const opts = `chrome-extension://${extId}/options/options.html`;
    const { session: s1 } = await openSession(cdp, port(wsUrl), opts);
    await sleep(1500); // bootstrap + flag read + applyDeveloperVisibility

    const v = await evalIn(cdp, s1, VISIBILITY([...DEV, ...USER]));
    for (const id of DEV) {
      check(`flag off: developer nav item "${id}" is hidden`, v[id]?.navHidden === true, v[id]);
      check(`flag off: developer section "${id}" is hidden`, v[id]?.secHidden === true, v[id]);
    }
    check("flag off: the provider server-tools card is hidden", v.__serverToolsHidden === true, v.__serverToolsHidden);
    for (const id of USER) {
      check(`flag off: user section "${id}" stays visible`, v[id]?.navHidden === false, v[id]);
    }
    check("flag off: no developer section is in the visible nav",
      DEV.every((id) => !v.__visibleNav.includes(id)), v.__visibleNav);
    await shot(cdp, s1, "settings-default-nav.png");

    // ── 2. Deep link to a hidden dev section shows a notice, not nothing ────
    // A fresh page (flag still OFF in kv — step 3 has not run yet); navigate to
    // #hooks the way a deep link does (hash assignment → the nav controller).
    const { session: s2 } = await openSession(cdp, port(wsUrl), opts);
    await sleep(1500);
    await evalIn(cdp, s2, `location.hash = '#hooks'`);
    await sleep(800);
    const notice = await evalIn(cdp, s2, `(() => {
      const n = document.getElementById('developer-locked-notice');
      return { present: !!n, visible: n ? !n.hidden : false, text: n ? n.textContent : '', hash: location.hash };
    })()`);
    check("deep link to #hooks (flag off) shows the developer-locked notice", notice.visible === true, notice);
    check("the notice points at the About toggle", /developer features/i.test(notice.text ?? ""), notice.text);

    // ── 3. Toggle ON in About reveals every developer surface ───────────────
    // Navigate to About and click the switch-toggle's inner button (shadow DOM).
    await evalIn(cdp, s1, `document.querySelector('.nav-item[data-section="about"]').click()`);
    await sleep(600);
    const clicked = await evalIn(cdp, s1, `(() => {
      const t = document.getElementById('developer-features');
      const btn = t?.shadowRoot?.querySelector('.sw');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    check("the About developer-features toggle exists and was clicked", clicked === true);
    await sleep(1500); // persist + applyDeveloperVisibility + render

    const v2 = await evalIn(cdp, s1, VISIBILITY(DEV));
    for (const id of DEV) {
      check(`flag on: developer nav item "${id}" is revealed`, v2[id]?.navHidden === false, v2[id]);
      check(`flag on: developer section "${id}" is revealed`, v2[id]?.secHidden === false, v2[id]);
    }
    check("flag on: the provider server-tools card is revealed", v2.__serverToolsHidden === false, v2.__serverToolsHidden);
    check("flag on: all thirteen nav items are visible", v2.__visibleNav.length === 13, v2.__visibleNav);
    await evalIn(cdp, s1, `window.scrollTo(0, 0)`).catch(() => {});
    await sleep(300);
    await shot(cdp, s1, "settings-developer-nav.png");
  } finally {
    try { ws.close(); } catch { /* */ }
    try { proc.kill("SIGKILL"); } catch { /* */ }
    try { await proc.status; } catch { /* */ }
    try { await Deno.remove(profile, { recursive: true }); } catch { /* */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

function port(wsUrl: string) { return Number(new URL(wsUrl).port); }

await main();

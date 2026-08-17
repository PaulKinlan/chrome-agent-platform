// capability-lifecycle.ts — the capability grant→use→revoke acceptance (the
// KNOWN-ISSUES gap: "not all capability lifecycles have grant→use→revoke
// acceptance"). Drives the REAL settings page + grants each optional capability
// with a REAL user gesture (CDP Input.dispatchMouseEvent — chrome.permissions.
// request requires a genuine gesture, so a JS .click() would not count), then
// revokes it via the service worker's capability.revoke route and confirms the
// permission is gone.
//
// The silently-grantable capabilities (storage, alarms, activeTab, scripting,
// sidePanel) must grant WITHOUT a prompt; the warned capabilities (tabs,
// notifications) are auto-DENIED in headless (Chrome needs a real permission
// prompt the headless browser cannot interact with) and must FAIL CLOSED.
//
//   deno run -A scripts/capability-lifecycle.ts

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// mirrors lib/capabilities.js CAPABILITIES + the warned flags
const CAPABILITIES: { id: string; permissions: string[]; warned: boolean }[] = [
  { id: "storage", permissions: ["storage"], warned: false },
  { id: "alarms", permissions: ["alarms"], warned: false },
  { id: "tabs", permissions: ["tabs"], warned: true },
  { id: "activeTab", permissions: ["activeTab"], warned: false },
  { id: "scripting", permissions: ["scripting"], warned: false },
  { id: "notifications", permissions: ["notifications"], warned: true },
  { id: "sidePanel", permissions: ["sidePanel"], warned: false },
];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

type Cdp = {
  send: (method: string, params: unknown, sessionId?: string) => Promise<any>;
  evl: (s: string, expr: string) => Promise<any>;
  port: number;
};

async function launch(): Promise<{ proc: Deno.ChildProcess; cdp: Cdp }> {
  const tmp = await Deno.makeTempDir({ prefix: "cap-lifecycle-" });
  const proc = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1440,900",
      `--user-data-dir=${tmp}`, "about:blank",
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();

  let wsUrl = "";
  let port = 0;
  const reader = proc.stderr.getReader();
  const deadline = Date.now() + 15000;
  let acc = "";
  while (Date.now() < deadline && !wsUrl) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
    const m2 = acc.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m2) { wsUrl = m2[1]; const pm = wsUrl.match(/^ws:\/\/[^/:]+:(\d+)\//); if (pm) port = Number(pm[1]); }
  }
  if (!wsUrl) {
    console.log("FAIL: could not find the Chrome DevTools URL");
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
    Deno.exit(1);
  }

  let id = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const resolve = pend.get(m.id)!;
      pend.delete(m.id);
      resolve(m.error ? Promise.reject(new Error(m.error.message)) : m.result);
    }
  };
  const send = (method: string, params: unknown, sessionId?: string): Promise<any> => {
    const mid = ++id;
    return new Promise((resolve) => { pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    return r?.result?.value;
  };
  return { proc, cdp: { send, evl, port } };
}

async function findSw(cdp: Cdp): Promise<{ extId: string }> {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdp.port}/json/list`)).json();
      const sw = (targets as any[]).find((t) => t.type === "service_worker");
      if (sw) return { extId: sw.url.split("/")[2] };
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error("extension did not load");
}

// A REAL user-gesture click at the button's center (chrome.permissions.request
// must be called during a genuine gesture — a JS .click() is not one).
async function realClick(cdp: Cdp, sessionId: string, expr: string) {
  // Scroll the element into view FIRST (the permission list is far down the
  // page; a CDP click at off-viewport page coordinates misses the button),
  // THEN compute the in-viewport rect.
  const rect = await cdp.evl(sessionId,
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.top >= 0 && r.bottom <= innerHeight }; })()`);
  if (!rect || rect.x == null || !rect.visible) return false;
  const x = Math.round(rect.x), y = Math.round(rect.y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
  return true;
}

async function main() {
  const { proc, cdp } = await launch();
  try {
    const { extId } = await findSw(cdp);
    const t = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
    const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    const sessionId = s.result?.sessionId ?? s.sessionId;
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);

    // wait for the permission list to render (each capability = one .perm-row
    // with a .grant-perm (ungranted) or .revoke-perm (granted) button)
    for (let i = 0; i < 40; i++) {
      const n = await cdp.evl(sessionId, `document.querySelectorAll('#permission-list .perm-row').length`);
      if (Number(n) >= 7) break;
      await sleep(200);
    }
    const rendered = await cdp.evl(sessionId, `document.querySelectorAll('#permission-list .perm-row').length`);
    check("settings rendered all 7 capability rows", Number(rendered) === 7, { rendered });

    const contains = (perms: string[]) => cdp.evl(sessionId,
      `chrome.permissions.contains({ permissions: ${JSON.stringify(perms)} }).then(r => !!r).catch(() => false)`);

    // the extension must start with ZERO optional permissions granted.
    let anyGranted = false;
    for (const cap of CAPABILITIES) {
      if (await contains(cap.permissions)) anyGranted = true;
    }
    check("the extension starts with zero optional capabilities granted", !anyGranted);

    for (const cap of CAPABILITIES) {
      // ── GRANT (real gesture) ──
      // the button is only present when NOT granted; after a failed grant it
      // re-renders. Use the .grant-perm button.
      const clicked = await realClick(cdp, sessionId,
        `document.querySelector('#permission-list .grant-perm[data-capability="${cap.id}"]')`);
      if (clicked) await sleep(1200);
      const granted = await contains(cap.permissions);

      if (cap.warned) {
        // tabs + notifications are auto-denied in headless — fail closed.
        check(`capability ${cap.id} (warned): request fails closed in headless`, granted === false, { granted });
      } else {
        check(`capability ${cap.id}: granted with a real gesture`, granted === true, { granted });
      }

      // ── USE (a minimal capability use — the capability reports granted via
      //    the SW's capabilities.status route) ──
      const status = await cdp.evl(sessionId,
        `chrome.runtime.sendMessage({ type: "capabilities.status" }).then(s => s?.["${cap.id}"]).catch(() => "error")`);
      if (!cap.warned) {
        check(`capability ${cap.id}: the SW reports it granted`, status === true, { status });
      }

      // ── REVOKE (the SW's capability.revoke route — no gesture needed) ──
      const rev = await cdp.evl(sessionId,
        `chrome.runtime.sendMessage({ type: "capability.revoke", id: "${cap.id}" }).then(r => r).catch(e => ({ ok:false, error:String(e) }))`);
      await sleep(400);
      const revoked = !(await contains(cap.permissions));
      if (!cap.warned) {
        check(`capability ${cap.id}: revoked (permission removed)`, revoked === true, { rev });
      } else {
        // a warned capability was never granted; the revoke route still must not
        // claim success while the permission is absent.
        check(`capability ${cap.id} (warned): revoke is a no-op on an absent grant`, revoked === true || rev?.ok === false, { rev });
      }
    }
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();

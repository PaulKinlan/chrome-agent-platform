// ui-integration.ts — a UI integration test set: loads the BUILT extension in
// headless Chrome and DRIVES the real surfaces (NTP hub, settings, chat),
// asserting the UI RENDERED + BEHAVED (not just "no crash") — the visual/
// interaction bugs Paul has been finding manually (the collapsed-sidebar text
// leak, the off-screen popups, the blank toggles, the recent-activity padding).
//
//   deno run -A scripts/ui-integration.ts

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launchChrome(profile: string) {
  return new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--remote-debugging-port=0",
      "--window-size=1400,900",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
  }).spawn();
}

async function waitForPort(proc: Deno.ChildProcess): Promise<number> {
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const reader = proc.stderr.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    const line = done ? null : new TextDecoder().decode(value);
    if (line?.includes("DevTools listening")) {
      const port = Number(line.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
      if (port) return port;
    }
  }
  throw new Error("chrome did not expose a DevTools port");
}

class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    };
  }
  send(method: string, params?: unknown, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async eval(sessionId: string, expression: string): Promise<any> {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    return r.result?.value;
  }
}

// Is a rect fully inside the viewport (the popups must not fall off-screen)?
function inBounds(rect: { left: number; top: number; right: number; bottom: number }, vw: number, vh: number) {
  return rect.left >= 0 && rect.top >= 0 && rect.right <= vw && rect.bottom <= vh;
}

const profile = await Deno.makeTempDir({ prefix: "cap-ui-" });
const proc = launchChrome(profile);
let exitCode = 1;
try {
  const port = await waitForPort(proc);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new Cdp(ws);

  // Discover the extension id from the service-worker target.
  let extId = "";
  for (let i = 0; i < 60 && !extId; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const sw = targets.find((t: any) => t.type === "service_worker" && t.url.includes("chrome-extension://"));
    if (sw) extId = new URL(sw.url).host;
    if (!extId) await sleep(200);
  }
  check("extension loaded (a service worker exists)", Boolean(extId), { extId });

  async function openPage(url: string): Promise<string> {
    const t = await cdp.send("Target.createTarget", { url });
    const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await cdp.send("Page.enable", {}, s.sessionId);
    await cdp.send("Runtime.enable", {}, s.sessionId);
    await sleep(1500);
    return s.sessionId;
  }

  // ---- NTP hub ----
  const hub = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);

  // 1. The composer renders with its sub-controls (the input + mic + attach + run).
  const composer = await cdp.eval(hub, `(() => {
    const c = document.querySelector('agent-composer');
    const inp = c ? (c.shadowRoot ? c.shadowRoot.querySelector('textarea,input') : c.querySelector('textarea,input')) : document.querySelector('#task-input,textarea');
    const hasMic = !!document.querySelector('mic-button');
    const btns = Array.from(document.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.title || b.textContent.trim().slice(0,12)));
    return { hasInput: !!inp, hasMic, hasAttach: !!document.querySelector('attach-button'), hasRun: btns.some(x=>/run task/i.test(x)) };
  })()`);
  check("NTP composer renders (input + mic + attach + run)", composer?.hasInput && composer?.hasMic && composer?.hasRun, composer);

  // 2. The sidebar collapses to an icon rail (the empty-state TEXT must be hidden).
  const collapse = await cdp.eval(hub, `(() => {
    const btn = document.querySelector('.side-toggle,[aria-label*=collapse i],[aria-label*=Collapse]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(500);
  const collapsedText = await cdp.eval(hub, `(() => {
    const side = document.querySelector('aside,.sidebar,[class*=sidebar]');
    if (!side) return { note: 'no sidebar' };
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
    const text = Array.from(side.querySelectorAll('*')).filter(el => el.children.length===0 && (el.textContent||'').trim().length>0 && vis(el)).map(el=>el.textContent.trim());
    return { sidebarWidth: side.getBoundingClientRect().width, visibleText: text.join(' | ').slice(0,120) };
  })()`);
  check("sidebar collapse hides the empty-state text (no 'No tasks yet' leak)", collapse && !/No tasks yet/i.test(collapsedText?.visibleText ?? ""), collapsedText);
  check("sidebar collapses to a narrow icon rail", collapsedText?.sidebarWidth != null && collapsedText.sidebarWidth < 120, collapsedText);

  // 3. The + menu opens AND stays in-bounds.
  const attach = await cdp.eval(hub, `(() => {
    const ab = document.querySelector('attach-button');
    const btn = ab ? (ab.shadowRoot ? ab.shadowRoot.querySelector('button') : ab.querySelector('button')) : null;
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(400);
  const menuRect = await cdp.eval(hub, `(() => {
    const ab = document.querySelector('attach-button');
    const menu = ab && ab.shadowRoot ? ab.shadowRoot.querySelector('[role=menu],.menu') : null;
    const open = menu && !menu.hidden && getComputedStyle(menu).display !== 'none';
    const r = open ? menu.getBoundingClientRect() : null;
    return { open: !!open, rect: r ? { left:r.left, top:r.top, right:r.right, bottom:r.bottom } : null, vw: innerWidth, vh: innerHeight };
  })()`);
  check("the + menu opens on click", attach && menuRect?.open, menuRect);
  if (menuRect?.open && menuRect.rect) {
    check("the + menu stays in-bounds", inBounds(menuRect.rect, menuRect.vw, menuRect.vh), menuRect.rect);
  }

  // 4. The error console opens AND stays in-bounds.
  const consoleOpen = await cdp.eval(hub, `(() => {
    const ec = document.querySelector('error-console');
    if (!ec) return false;
    const btn = ec.shadowRoot ? ec.shadowRoot.querySelector('button') : ec.querySelector('button');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(400);
  const consoleRect = await cdp.eval(hub, `(() => {
    const ec = document.querySelector('error-console');
    const panels = Array.from(ec && ec.shadowRoot ? ec.shadowRoot.querySelectorAll('[popover]:popover-open,[class*=panel],[class*=console]') : []);
    const p = panels.find(el => /console|errors/i.test(el.textContent?.slice(0,40)));
    const r = p ? p.getBoundingClientRect() : null;
    return { found: !!p, rect: r ? { left:r.left, top:r.top, right:r.right, bottom:r.bottom } : null, vw: innerWidth, vh: innerHeight };
  })()`);
  check("the error console opens", consoleOpen && consoleRect?.found, consoleRect);
  if (consoleRect?.found && consoleRect.rect) {
    check("the error console stays in-bounds", inBounds(consoleRect.rect, consoleRect.vw, consoleRect.vh), consoleRect.rect);
  }

  // 5. The recent-activity rows (or its empty state) have horizontal padding
  // (not flush against the panel border).
  const padding = await cdp.eval(hub, `(() => {
    const el = document.querySelector('.runlog .empty, .runlog .rl, #run-log .rl');
    if (!el) return { note: 'no runlog row/empty found' };
    const cs = getComputedStyle(el);
    return { paddingLeft: parseFloat(cs.paddingLeft), paddingTop: parseFloat(cs.paddingTop) };
  })()`);
  check("the recent-activity panel has horizontal padding (not edge-to-edge)", (padding?.paddingLeft ?? 0) > 0, padding);

  // ---- Settings ----
  const settings = await openPage(`chrome-extension://${extId}/options/options.html`);

  // 6. Every settings section heading renders.
  const sections = await cdp.eval(settings, `(() => {
    const nav = Array.from(document.querySelectorAll('nav a.nav-item,nav button,[role=tab]'));
    return nav.map(b => b.textContent.trim()).filter(Boolean);
  })()`);
  const expected = ["Providers", "Agents", "Appearance", "Browser control", "Permissions", "Hooks", "Usage", "Data & memory"];
  const missing = expected.filter((s) => !(sections ?? []).some((x) => x.includes(s)));
  check("all settings sections render", missing.length === 0, { sections, missing });

  // 7. The toggles RENDER (a visible switch, not blank) + toggle.
  const toggle = await cdp.eval(settings, `(() => {
    const sw = document.querySelector('switch-toggle');
    if (!sw) return { note: 'no switch-toggle' };
    const sr = sw.shadowRoot;
    const knob = sr ? sr.querySelector('.switch,.knob,[role=switch],button') : sw;
    const r = knob.getBoundingClientRect();
    return { rendered: r.width > 0 && r.height > 0, w: r.width, h: r.height };
  })()`);
  check("settings toggles render a visible switch", toggle?.rendered === true, toggle);

  // 8. The provider Test-connection button renders.
  const testBtn = await cdp.eval(settings, `(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => /test connection/i.test(b.textContent));
    return !!b;
  })()`);
  check("the provider Test-connection button renders", testBtn);

  // ---- Chat ----
  const chat = await openPage(`chrome-extension://${extId}/chat/chat.html`);
  const chatComposer = await cdp.eval(chat, `(() => {
    const inp = document.querySelector('#input,textarea,input[type=text]');
    const send = Array.from(document.querySelectorAll('button')).some(b => /send/i.test(b.textContent||b.getAttribute('aria-label')||''));
    return { hasInput: !!inp, hasSend: send };
  })()`);
  check("chat composer renders (input + send)", chatComposer?.hasInput && chatComposer?.hasSend, chatComposer);

  exitCode = fail === 0 ? 0 : 1;
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { await Deno.remove(profile, { recursive: true }); } catch { /* best-effort */ }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
Deno.exit(exitCode);

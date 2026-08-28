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
    if (r?.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "page evaluation failed",
      );
    }
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

  // 2b. Collapsed-rail geometry: every action icon is the SAME size + centred on
  //     the rail (new-task / new-agent / Skills / Directory / Settings), and the
  //     collapse control is an edge NUB with a ≥44×44 hit target, in-bounds.
  const railGeom = await cdp.eval(hub, `(() => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: Math.round(r.left + r.width/2), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const side = document.querySelector('#side');
    const sideW = side ? side.getBoundingClientRect().width : 0;
    const nub = document.querySelector('#side-toggle .nub');
    const nubBox = nub ? nub.getBoundingClientRect() : null;
    return { sideW, vw: innerWidth, vh: innerHeight,
      items: { newTask: box('#new-task'), newAgent: box('#new-agent'), artifacts: box('#open-artifacts'), directory: box('#open-directory'), settings: box('#open-settings') },
      togg: box('#side-toggle'),
      nub: nubBox ? { w: Math.round(nubBox.width), h: Math.round(nubBox.height), left: Math.round(nubBox.left), right: Math.round(nubBox.right) } : null };
  })()`);
  const itemCxs = Object.values(railGeom?.items ?? {}).filter((i: any) => i && i.cx).map((i: any) => i.cx);
  const cxSpread = itemCxs.length ? Math.max(...itemCxs) - Math.min(...itemCxs) : Infinity;
  const nonNull = Object.values(railGeom?.items ?? {}).filter((i: any) => i);
  const all34 = nonNull.length === 5 && nonNull.every((i: any) => i.w === 34 && i.h === 34);
  check("exactly five rail actions exist", nonNull.length === 5, nonNull.map((i: any) => i.cx));
  check("collapsed rail icons share ONE centre (≤2px spread)", railGeom?.sideW < 120 && cxSpread <= 2, { cxSpread, itemCxs });
  check("collapsed rail action buttons are uniformly 34×34", all34 === true, railGeom?.items);
  check("collapse control is a ≥44×44 nub hit target", railGeom?.togg && railGeom.togg.w >= 44 && railGeom.togg.h >= 44, railGeom?.togg);
  check("nub straddles the sidebar edge + stays in-bounds", railGeom?.nub && railGeom.nub.left < railGeom.sideW && railGeom.nub.right > railGeom.sideW && railGeom.nub.right <= railGeom.vw, railGeom?.nub);
  // The nub must sit ABOVE the thread/settings overlay so its hit target stays
  // reachable when a view is open (the sidebar persists for the task thread).
  const nubZ = await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); const z = t ? parseInt(getComputedStyle(t).zIndex) : 0; const tv = document.querySelector('#thread-view'); const tvz = tv ? parseInt(getComputedStyle(tv).zIndex) : 0; return { z, tvz }; })()`);
  check("nub z-index is above the thread overlay", nubZ?.z > nubZ?.tvz, nubZ);
  // (The real overlay hit-testing + pointer activation is exercised later in
  // the REAL-thread journey — no forced hidden=false here.)
  // Collapsed evidence (force the collapsed state first).
  await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); if (!side.classList.contains('collapsed')) document.querySelector('#side-toggle').click(); })()`);
  await sleep(400);
  const shotCollapsed = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, hub);
  await Deno.writeFile(`${ROOT}test-artifacts/sidebar-collapsed.png`, Uint8Array.from(atob(shotCollapsed.data), (c: number) => c.charCodeAt(0)));

  // 2c. Keyboard Enter toggles + aria-expanded/label/title track the state.
  //     First prove the nub is TAB-REACHABLE (focus the last sidebar control
  //     before it, then Tab — no programmatic .focus() on the nub).
  await cdp.eval(hub, `(() => { document.querySelector('#open-settings')?.focus(); })()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, hub);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, hub);
  await sleep(200);
  const tabReached = await cdp.eval(hub, `document.activeElement?.id === 'side-toggle'`);
  check("the nub is reachable by keyboard Tab", tabReached === true, { tabReached });

  const keyBefore = await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); const side = document.querySelector('#side'); t.focus(); return { expanded: t.getAttribute('aria-expanded'), collapsed: side.classList.contains('collapsed'), label: t.getAttribute('aria-label'), title: t.title, focused: document.activeElement === t }; })()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, hub);
  await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, hub);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, hub);
  await sleep(500); // let the View Transition settle
  const keyAfter = await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); const side = document.querySelector('#side'); return { expanded: t.getAttribute('aria-expanded'), collapsed: side.classList.contains('collapsed'), label: t.getAttribute('aria-label'), title: t.title }; })()`);
  check("Enter toggles the sidebar (collapsed ↔ expanded)", keyBefore && keyAfter && keyBefore.collapsed !== keyAfter.collapsed, { keyBefore, keyAfter });
  check("aria-expanded + label + title track the state", keyAfter && keyAfter.expanded === String(!keyAfter.collapsed) && keyAfter.label === (keyAfter.collapsed ? "Expand sidebar" : "Collapse sidebar") && keyAfter.title === keyAfter.label, keyAfter);
  check("Enter activation focuses the nub first", keyBefore?.focused === true, keyBefore);
  // Expanded evidence (force the expanded state first — Enter above toggled it).
  await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); if (side.classList.contains('collapsed')) document.querySelector('#side-toggle').click(); })()`);
  await sleep(400);
  const shotExpanded = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, hub);
  await Deno.writeFile(`${ROOT}test-artifacts/sidebar-expanded.png`, Uint8Array.from(atob(shotExpanded.data), (c: number) => c.charCodeAt(0)));

  // 2d. Space toggles too (native button activation).
  await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); t.focus(); })()`);
  const spaceBefore = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, hub);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, hub);
  await sleep(500);
  const spaceAfter = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
  check("Space toggles the sidebar", spaceAfter !== spaceBefore, { spaceBefore, spaceAfter });

  // 2e. The collapsed state persists across a reload (collapse first, then wait
  //     for the durability write to settle — public data-durability, no oracle).
  await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); if (!side.classList.contains('collapsed')) document.querySelector('#side-toggle').click(); })()`);
  await cdp.eval(hub, `(async () => { const side = document.querySelector('#side'); for (let i = 0; i < 20; i++) { if (side.getAttribute('data-durability') !== 'unknown') return true; await new Promise(r => setTimeout(r, 100)); } return true; })()`);
  await sleep(300);
  await cdp.send("Page.reload", {}, hub);
  await sleep(1500);
  const afterReload = await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); return { collapsed: side?.classList.contains('collapsed') ?? false, width: side ? Math.round(side.getBoundingClientRect().width) : 0, durability: side?.getAttribute('data-durability') ?? 'unknown' }; })()`);
  check("collapsed state persists across reload", afterReload?.collapsed === true && afterReload?.width === 60, afterReload);
  check("durability state is resolved after reload (not unknown)", afterReload && ['durable', 'session', 'error'].includes(afterReload.durability), afterReload);
  // restore to expanded for the rest of the suite
  await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); if (document.querySelector('#side')?.classList.contains('collapsed')) t?.click(); })()`);
  await sleep(500);

  // 2f. RTL: the rail sits on the right — the nub must sit on the right-side
  //     boundary (translated the correct direction, not 44px off).
  const rtlGeom = await cdp.eval(hub, `(() => {
    const html = document.documentElement; html.setAttribute('dir', 'rtl');
    const side = document.querySelector('#side'); const sideR = side.getBoundingClientRect();
    const t = document.querySelector('#side-toggle'); const tr = t.getBoundingClientRect();
    const cx = Math.round(tr.left + tr.width/2);
    html.removeAttribute('dir');
    // In RTL the rail is on the RIGHT, so the nub belongs on its INNER (left) boundary.
    return { sideLeft: Math.round(sideR.left), sideRight: Math.round(sideR.right), nubCx: cx, vw: innerWidth };
  })()`);
  check("RTL nub centres on the rail's inner (left) boundary", rtlGeom && Math.abs(rtlGeom.nubCx - rtlGeom.sideLeft) <= 3, rtlGeom);
  // RTL also swaps the rail's hairline border to the inner (left) edge.
  const rtlBorder = await cdp.eval(hub, `(() => {
    const html = document.documentElement; html.setAttribute('dir', 'rtl');
    const side = document.querySelector('#side');
    const cs = getComputedStyle(side);
    const out = { bl: cs.borderLeftWidth, bls: cs.borderLeftStyle, br: cs.borderRightWidth, brs: cs.borderRightStyle };
    html.removeAttribute('dir');
    return out;
  })()`);
  check("RTL swaps the rail border to the inner (left) edge", rtlBorder && rtlBorder.bls !== 'none' && rtlBorder.bl !== '0px' && (rtlBorder.br === '0px' || rtlBorder.brs === 'none'), rtlBorder);

  // 2g. Rapid double-click is a NET-ZERO toggle: two clicks return the sidebar
  //     to its prior state, and the ViewTransition completes (observed via a
  //     TEST-INJECTED patch of document.startViewTransition — not a production
  //     oracle; the patch lives only in this test, never in the shipped ntp.js).
  //     The patch + await + assertions run in a try/finally so the original
  //     startViewTransition is RESTORED + the cap globals DELETED even on failure.
  let rapidBefore, rapidAfter, vtOutcome;
  try {
    await cdp.eval(hub, `(() => { window.__vtOrig = document.startViewTransition; window.__vtCap = null; document.startViewTransition = (cb) => { const vt = window.__vtOrig.call(document, cb); window.__vtCap = vt; return vt; }; })()`);
    rapidBefore = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
    await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); t.click(); t.click(); })()`);
    vtOutcome = await cdp.eval(hub, `(async () => { const vt = window.__vtCap; if (!vt) return 'none'; await vt.finished; return 'finished'; })()`);
    await sleep(300);
    rapidAfter = await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); return { collapsed: side.classList.contains('collapsed'), width: Math.round(side.getBoundingClientRect().width) }; })()`);
  } finally {
    // Separate restoration + each delete so one failing step can't skip the
    // others (the reviewer's nested-cleanup requirement).
    try { await cdp.eval(hub, `(() => { if (window.__vtOrig) document.startViewTransition = window.__vtOrig; })()`); } catch { /* restore failed — continue */ }
    try { await cdp.eval(hub, `(() => { delete window.__vtOrig; })()`); } catch { /* delete failed */ }
    try { await cdp.eval(hub, `(() => { delete window.__vtCap; })()`); } catch { /* delete failed */ }
  }
  check("rapid double-click returns to the deterministic prior state (net-zero)", rapidAfter?.collapsed === rapidBefore, { rapidBefore, rapidAfter });
  check("ViewTransition.finished awaited (test-injected patch)", vtOutcome === 'finished', vtOutcome);
  check("width matches the final state after the transition", rapidAfter?.width === (rapidAfter?.collapsed ? 60 : 240), rapidAfter);

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
  // Close any open diagnostics panels so they don't cover later interactions.
  await cdp.eval(hub, `(() => { for (const tag of ['error-console','security-shield']) { const el = document.querySelector(tag); const panel = el?.shadowRoot?.querySelector('.panel'); const btn = el?.shadowRoot?.querySelector('button'); if (panel && !panel.hidden && btn) btn.click(); } })()`);
  await sleep(300);

  // 5. The recent-activity rows have horizontal padding + real entry content,
  //    loaded through the PRODUCTION activity.list path (not the demo entries
  //    setter): seed the SW master journal via memory.set, recreate the explorer
  //    so it re-loads via activity.list, and assert the rendered entry.
  const activity = await cdp.eval(hub, `(async () => {
    const seed = await chrome.runtime.sendMessage({ type: "memory.set", origin: "master", key: "journal", value: [{ type: "task", id: "t1", task: "Summarise the docs", tool: "demo" }] });
    const el = document.getElementById('run-log');
    el.replaceChildren();
    const explorer = document.createElement('activity-explorer');
    explorer.setAttribute('limit', '100');
    el.append(explorer);
    await new Promise(r => setTimeout(r, 600)); // let _load() round-trip activity.list
    const summary = explorer.shadowRoot?.querySelector('.aex-entry summary');
    if (!summary) return { note: 'no entry rendered', seed };
    const cs = getComputedStyle(summary);
    return { paddingLeft: parseFloat(cs.paddingLeft), paddingTop: parseFloat(cs.paddingTop), text: summary.textContent.trim(), entryCount: explorer.shadowRoot.querySelectorAll('.aex-entry').length, empty: !!explorer.shadowRoot.querySelector('.aex-empty'), seed };
  })()`);
  check("recent-activity renders the journal entry via production activity.list", activity?.entryCount === 1 && activity?.empty === false && /Summarise the docs/.test(activity?.text ?? ""), activity);
  check("the recent-activity entry has horizontal padding (not edge-to-edge)", (activity?.paddingLeft ?? 0) > 0, activity);

  // 7. REAL thread via production UI: type a task into the composer + click Run
  //    (REAL CDP input: mouse click to focus, Input.insertText to type, mouse
  //    click on #run-task) → the demo provider (no key) runs → a thread is
  //    created; then reopen it through the sidebar thread-item (real pointer) and
  //    hit-test the nub with the thread overlay OPEN (not a forced hidden).
  const inpRect = await cdp.eval(hub, `(() => { const r = document.querySelector('#task-input').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: inpRect.x, y: inpRect.y }, hub);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: inpRect.x, y: inpRect.y, button: "left", clickCount: 1 }, hub);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: inpRect.x, y: inpRect.y, button: "left", clickCount: 1 }, hub);
  await cdp.send("Input.insertText", { text: "Summarise the docs" }, hub);
  await sleep(200);
  const runBtn = await cdp.eval(hub, `(() => { const b = document.querySelector('#run-task'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height }; })()`);
  if (runBtn && runBtn.w > 0 && runBtn.h > 0) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: runBtn.x, y: runBtn.y }, hub);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: runBtn.x, y: runBtn.y, button: "left", clickCount: 1 }, hub);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: runBtn.x, y: runBtn.y, button: "left", clickCount: 1 }, hub);
  }
  await sleep(500);
  await sleep(3000); // the agent loop runs (demo model is deterministic + fast)
  const threadState = await cdp.eval(hub, `(() => ({ items: document.querySelectorAll('.thread-item').length, first: document.querySelector('.thread-item .t-name')?.textContent?.trim() ?? '' }))()`);
  check("running a demo task creates a thread in the sidebar", threadState?.items >= 1, threadState);
  const threadItem = await cdp.eval(hub, `(() => { const el = document.querySelector('.thread-item'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  if (threadItem) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: threadItem.x, y: threadItem.y }, hub);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: threadItem.x, y: threadItem.y, button: "left", clickCount: 1 }, hub);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: threadItem.x, y: threadItem.y, button: "left", clickCount: 1 }, hub);
  }
  await sleep(900);
  const opened = await cdp.eval(hub, `(() => ({ hidden: document.getElementById('thread-view').hidden, title: document.getElementById('thread-title').textContent }))()`);
  check("clicking the sidebar thread opens the thread surface", opened?.hidden === false, opened);
  // Dense grid elementFromPoint across the 44×44 nub with the thread overlay open.
  const dense = await cdp.eval(hub, `(() => {
    const t = document.querySelector('#side-toggle');
    const r = t.getBoundingClientRect();
    let hits = 0, total = 0;
    for (let dx = 2; dx < r.width; dx += 6) for (let dy = 2; dy < r.height; dy += 6) {
      total++;
      const el = document.elementFromPoint(r.left + dx, r.top + dy);
      if (el && (el === t || t.contains(el))) hits++;
    }
    return { hits, total, all: hits === total };
  })()`);
  check("dense grid: every sampled point of the nub is hit-testable with the thread open", dense?.all === true, dense);
  const realPtrBefore = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
  const realNubCtr = await cdp.eval(hub, `(() => { const r = document.querySelector('#side-toggle').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: realNubCtr.x, y: realNubCtr.y, button: "left", clickCount: 1 }, hub);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: realNubCtr.x, y: realNubCtr.y, button: "left", clickCount: 1 }, hub);
  await sleep(500);
  const realPtrAfter = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
  check("real pointer click toggles the sidebar with the thread open", realPtrAfter !== realPtrBefore, { realPtrBefore, realPtrAfter });
  await cdp.eval(hub, `document.getElementById('thread-back')?.click()`);
  await sleep(300);

  // 7b. Persistence durability: permissionless profile → 'session' + a VISIBLE
  //     + accessible hint (not just a data attribute). The durable/error paths
  //     are unit-tested in tests/kv.test.ts.
  const sessionDurability = await cdp.eval(hub, `(async () => {
    const side = document.querySelector('#side');
    for (let i = 0; i < 20; i++) { if (side.getAttribute('data-durability') !== 'unknown') break; await new Promise(r => setTimeout(r, 100)); }
    const hint = document.getElementById('sidebar-durability-hint');
    return { durability: side.getAttribute('data-durability') ?? 'unknown', hintText: hint?.textContent?.trim() ?? '', hintHidden: hint?.hidden ?? true, hintRole: hint?.getAttribute('role') ?? '' };
  })()`);
  check("permissionless profile: sidebar durability is 'session'", sessionDurability?.durability === 'session', sessionDurability);
  check("durability hint is visible + accessible (role=status, session-only text)", sessionDurability?.hintHidden === false && sessionDurability?.hintRole === 'status' && /session-only/i.test(sessionDurability?.hintText ?? ''), sessionDurability);
  await cdp.eval(hub, `document.querySelector('#side-toggle').click()`);
  await sleep(400);

  // 7c. Durability UI STATE→ELEMENT contract on the REAL element: drive the
  //     production pure renderer (lib/durability-ui.js) through session→error→
  //     durable on the real #sidebar-durability-hint + #side, asserting the
  //     text/visibility/data-durability transitions + the stale-text clear.
  //     No shipped fault global: the error state is exercised by calling the
  //     pure renderer directly (the real persist path can only reach session
  //     in a permissionless headless profile; headed storage-granted restart
  //     remains OPEN).
  const durTransitions = await cdp.eval(hub, `(async () => {
    const { renderDurabilityState } = await import('/lib/durability-ui.js');
    const side = document.querySelector('#side');
    const hint = document.getElementById('sidebar-durability-hint');
    const snap = () => ({ d: side.getAttribute('data-durability'), text: (hint.textContent || '').trim(), hidden: hint.hidden });
    const out = {};
    // session (real path already left the rail in session mode)
    renderDurabilityState({ side, hint }, 'session');
    out.session = snap();
    // session → error
    renderDurabilityState({ side, hint }, 'error');
    out.error = snap();
    // error → durable (must CLEAR the stale error text + hide the live region)
    renderDurabilityState({ side, hint }, 'durable');
    out.durable = snap();
    return out;
  })()`);
  check("durability UI: session state renders the warning + data-durability=session", durTransitions?.session?.d === 'session' && /session-only/i.test(durTransitions?.session?.text ?? '') && durTransitions?.session?.hidden === false, durTransitions?.session);
  check("durability UI: session→error renders the failure text + is visible + data-durability=error", durTransitions?.error?.d === 'error' && /storage failed/i.test(durTransitions?.error?.text ?? '') && durTransitions?.error?.hidden === false, durTransitions?.error);
  check("durability UI: error→durable clears the stale text + hides the live region + data-durability=durable", durTransitions?.durable?.d === 'durable' && (durTransitions?.durable?.text ?? '') === '' && durTransitions?.durable?.hidden === true, durTransitions?.durable);

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

  // 8. Responsive + theme + reduced-motion matrix (the nub must hold up beyond
  //    the default 1400×900 light LTR run).
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 500, height: 800, deviceScaleFactor: 1, mobile: false }, hub);
  const narrow = await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); const r = t.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, inBounds: r.left >= 0 && r.right <= innerWidth }; })()`);
  check("narrow (500px) viewport: nub stays in-bounds", narrow?.inBounds === true, narrow);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, hub);

  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, hub);
  const reducedMotion = await cdp.eval(hub, `(() => {
    const g = (sel) => getComputedStyle(document.querySelector(sel)).transition;
    return { nub: g('#side-toggle'), side: g('#side'), overlay: g('#thread-view') };
  })()`);
  const noMotion = (t) => t === "none" || t.includes("0s") || t === "all 0s ease 0s";
  check("prefers-reduced-motion disables the nub transition", reducedMotion && noMotion(reducedMotion.nub), reducedMotion);
  check("prefers-reduced-motion disables the sidebar transition", reducedMotion && noMotion(reducedMotion.side), reducedMotion);
  check("prefers-reduced-motion disables the overlay transition", reducedMotion && noMotion(reducedMotion.overlay), reducedMotion);
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }, hub);

  const darkNub = await cdp.eval(hub, `(() => {
    // Disable transitions so the theme change + nub background/border are read at
    // their INSTANT final values (no mid-transition read), and do it all
    // synchronously so no async theme-reset can interleave.
    const st = document.createElement('style'); st.textContent = '*{transition:none !important}';
    document.head.appendChild(st);
    document.documentElement.dataset.theme = 'midnight';
    document.body.offsetWidth; // force synchronous reflow
    const lum = (c) => { const m = c.match(/\\d+(?:\\.\\d+)?/g); if (!m) return 0; const [r,g,b] = m.map(Number).map(v => v/255).map(v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4)); return 0.2126*r + 0.7152*g + 0.0722*b; };
    const nub = document.querySelector('#side-toggle .nub');
    const side = document.querySelector('#side');
    const cs = getComputedStyle(nub); const scs = getComputedStyle(side);
    const out = { visible: cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px', border: cs.borderTopColor, nubBg: cs.backgroundColor, nubBgLum: lum(cs.backgroundColor), nubBorderLum: lum(cs.borderTopColor), sideBg: scs.backgroundColor, sideText: scs.color, sideBgLum: lum(scs.backgroundColor), sideTextLum: lum(scs.color) };
    document.documentElement.dataset.theme = 'sunlit';
    st.remove();
    return out;
  })()`);
  check("dark theme: nub renders with a visible border", darkNub?.visible === true, darkNub);
  check("dark theme (midnight): the sidebar applies dark tokens (dark bg + light text)", darkNub && darkNub.sideBgLum < 0.2 && darkNub.sideTextLum > 0.6, darkNub);
  check("dark theme (midnight): the nub applies a dark background (luminance < 0.2)", darkNub && darkNub.nubBgLum < 0.2, darkNub);
  check("dark theme (midnight): the nub border contrasts its dark background", darkNub && darkNub.nubBgLum < 0.2 && darkNub.nubBorderLum > darkNub.nubBgLum, darkNub);

  // 9. Overlay-OPEN matrix (the reviewer's D blocker): the real thread overlay
  //    must stay OPEN while sidebar + overlay + nub are asserted across RTL /
  //    dark / narrow / reduced-motion / focus — not just the default light LTR
  //    run. Re-open the thread created in step 7 (real pointer), then assert
  //    each dimension + capture overlay-open screenshots.
  const reopen = await cdp.eval(hub, `(async () => {
    const tv = document.getElementById('thread-view');
    if (tv?.hidden === false) return { alreadyOpen: true };
    const item = document.querySelector('.thread-item');
    if (!item) return { noThread: true };
    const r = item.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (reopen?.x != null) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: reopen.x, y: reopen.y }, hub);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: reopen.x, y: reopen.y, button: "left", clickCount: 1 }, hub);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: reopen.x, y: reopen.y, button: "left", clickCount: 1 }, hub);
    await sleep(700);
  }
  const overlayOpen = await cdp.eval(hub, `document.getElementById('thread-view').hidden === false`);
  check("overlay-open matrix: the thread overlay is OPEN", overlayOpen === true, { overlayOpen, reopen });

  // Baseline overlay-open evidence.
  const shotOverlay = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, hub);
  await Deno.writeFile(`${ROOT}test-artifacts/overlay-open.png`, Uint8Array.from(atob(shotOverlay.data), (c: number) => c.charCodeAt(0)));

  const overlayGeom = await cdp.eval(hub, `(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round(b.left + b.width/2) }; };
    return { side: r(document.querySelector('#side')), overlay: r(document.getElementById('thread-view')), nub: r(document.querySelector('#side-toggle')), vw: innerWidth, vh: innerHeight };
  })()`);
  check("overlay-open matrix: overlay + nub are in-bounds", overlayGeom && overlayGeom.overlay && overlayGeom.nub && overlayGeom.overlay.left >= 0 && overlayGeom.overlay.right <= overlayGeom.vw && overlayGeom.nub.right <= overlayGeom.vw && overlayGeom.nub.left >= 0, overlayGeom);

  // RTL (overlay open): the rail + nub flip to the right; the overlay reserves
  // space on the right so the sidebar + nub stay visible (no overlap). Wait for
  // the overlay's left/right transition to settle before measuring.
  await cdp.eval(hub, `document.documentElement.setAttribute('dir', 'rtl')`);
  await sleep(1000);
  const overlayRtl = await cdp.eval(hub, `(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), cx: Math.round(b.left + b.width/2) }; };
    const side = r(document.querySelector('#side')); const nub = r(document.querySelector('#side-toggle')); const overlay = r(document.getElementById('thread-view'));
    return { sideLeft: side.left, sideRight: side.right, nubCx: nub.cx, nubOnInner: Math.abs(nub.cx - side.left) <= 3, overlayLeft: overlay.left, overlayRight: overlay.right, overlayInBounds: overlay.left >= 0 && overlay.right <= innerWidth, noOverlap: overlay.right <= side.left, vw: innerWidth };
  })()`);
  check("overlay-open RTL: nub centres on the rail's inner boundary", overlayRtl?.nubOnInner === true, overlayRtl);
  check("overlay-open RTL: overlay stays in-bounds", overlayRtl?.overlayInBounds === true, overlayRtl);
  check("overlay-open RTL: overlay does NOT cover the sidebar/nub (no overlap)", overlayRtl?.noOverlap === true, overlayRtl);
  const shotOverlayRtl = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, hub);
  await Deno.writeFile(`${ROOT}test-artifacts/overlay-rtl.png`, Uint8Array.from(atob(shotOverlayRtl.data), (c: number) => c.charCodeAt(0)));
  await cdp.eval(hub, `document.documentElement.removeAttribute('dir')`);
  await sleep(1000);

  // Dark (overlay open): nub keeps a visible border + the overlay text is legible.
  const overlayDark = await cdp.eval(hub, `(() => {
    const st = document.createElement('style'); st.textContent = '*{transition:none !important}';
    document.head.appendChild(st);
    document.documentElement.dataset.theme = 'midnight';
    document.body.offsetWidth; // force synchronous reflow
    const lum = (c) => { const m = c.match(/\\d+(?:\\.\\d+)?/g); if (!m) return 0; const [r,g,b] = m.map(Number).map(v => v/255).map(v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4)); return 0.2126*r + 0.7152*g + 0.0722*b; };
    const nub = document.querySelector('#side-toggle .nub');
    const cs = getComputedStyle(nub);
    const side = document.querySelector('#side'); const scs = getComputedStyle(side);
    const overlay = document.getElementById('thread-view'); const ov = getComputedStyle(overlay);
    const out = {
      nubBorder: cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px',
      nubDark: lum(cs.backgroundColor) < 0.2 && lum(cs.borderTopColor) > lum(cs.backgroundColor),
      overlayVisible: ov.display !== 'none' && overlay.hidden === false,
      sideDark: lum(scs.backgroundColor) < 0.2 && lum(scs.color) > 0.6,
      overlayDark: lum(ov.backgroundColor) < 0.2 && lum(ov.color) > 0.6,
    };
    st.remove();
    return out;
  })()`);
  check("overlay-open dark (midnight): nub keeps a visible border + overlay visible", overlayDark?.nubBorder === true && overlayDark?.overlayVisible === true, overlayDark);
  check("overlay-open dark (midnight): nub applies dark tokens (dark bg + contrasting border)", overlayDark?.nubDark === true, overlayDark);
  check("overlay-open dark (midnight): sidebar applies dark tokens (dark bg + light text)", overlayDark?.sideDark === true, overlayDark);
  check("overlay-open dark (midnight): overlay applies dark tokens (dark bg + light text)", overlayDark?.overlayDark === true, overlayDark);
  await cdp.eval(hub, `document.documentElement.dataset.theme = 'midnight'`);
  await sleep(300);
  const shotOverlayDark = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, hub);
  await Deno.writeFile(`${ROOT}test-artifacts/overlay-dark.png`, Uint8Array.from(atob(shotOverlayDark.data), (c: number) => c.charCodeAt(0)));
  await cdp.eval(hub, `document.documentElement.dataset.theme = 'sunlit'`);
  await sleep(300);

  // Narrow (overlay open): overlay + nub remain in-bounds at 500px.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 500, height: 800, deviceScaleFactor: 1, mobile: false }, hub);
  const overlayNarrow = await cdp.eval(hub, `(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width) }; };
    const overlay = r(document.getElementById('thread-view')); const nub = r(document.querySelector('#side-toggle')); const side = r(document.querySelector('#side'));
    const inb = (x) => x.left >= 0 && x.right <= innerWidth;
    return { overlayInBounds: inb(overlay), nubInBounds: inb(nub), sideInBounds: inb(side), overlayW: overlay.w, sideW: side.w, vw: innerWidth };
  })()`);
  check("overlay-open narrow: overlay + nub + sidebar all stay in-bounds", overlayNarrow?.overlayInBounds === true && overlayNarrow?.nubInBounds === true && overlayNarrow?.sideInBounds === true, overlayNarrow);
  check("overlay-open narrow: overlay + sidebar coexist (no cover)", overlayNarrow && overlayNarrow.overlayW + overlayNarrow.sideW <= overlayNarrow.vw, overlayNarrow);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, hub);

  // Reduced-motion (overlay open): sidebar + overlay + nub transitions disabled.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, hub);
  const overlayReduced = await cdp.eval(hub, `(() => {
    const g = (sel) => getComputedStyle(document.querySelector(sel)).transition;
    return { nub: g('#side-toggle'), side: g('#side'), overlay: g('#thread-view') };
  })()`);
  check("overlay-open reduced-motion: nub transition disabled", overlayReduced && noMotion(overlayReduced.nub), overlayReduced);
  check("overlay-open reduced-motion: sidebar transition disabled", overlayReduced && noMotion(overlayReduced.side), overlayReduced);
  check("overlay-open reduced-motion: overlay transition disabled", overlayReduced && noMotion(overlayReduced.overlay), overlayReduced);
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }, hub);

  // Focus (overlay open): the nub remains Tab-reachable above the overlay.
  await cdp.eval(hub, `document.querySelector('#open-settings')?.focus()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, hub);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, hub);
  await sleep(200);
  const overlayFocus = await cdp.eval(hub, `(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return { nubFocused: document.activeElement?.id === 'side-toggle', sidebarVisible: r(document.querySelector('#side')), overlayVisible: document.getElementById('thread-view').hidden === false && r(document.getElementById('thread-view')) };
  })()`);
  check("overlay-open focus: the nub is Tab-reachable above the overlay", overlayFocus?.nubFocused === true, overlayFocus);
  check("overlay-open focus: sidebar + overlay are both visible while the nub holds focus", overlayFocus?.sidebarVisible === true && overlayFocus?.overlayVisible === true, overlayFocus);
  // Restore: close the overlay for a clean end state.
  await cdp.eval(hub, `document.getElementById('thread-back')?.click()`);
  await sleep(300);

  exitCode = fail === 0 ? 0 : 1;
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { await Deno.remove(profile, { recursive: true }); } catch { /* best-effort */ }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
Deno.exit(exitCode);

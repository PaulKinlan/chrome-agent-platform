// ui-integration.ts — a UI integration test set: loads the BUILT extension in
// headless Chrome and DRIVES the real surfaces (NTP hub, settings, chat),
// asserting the UI RENDERED + BEHAVED (not just "no crash") — the visual/
// interaction bugs Paul has been finding manually (the collapsed-sidebar text
// leak, the off-screen popups, the blank toggles, the recent-activity padding).
//
//   deno run -A scripts/ui-integration.ts

import { CHROMIUM, launchChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

// Hard wall-clock budget: every CDP call below awaits a response with no
// per-call timeout, so a hung renderer would otherwise leave this script
// running forever (the bead-5ht "never finishes" symptom). Diagnose + exit 2.
const WATCHDOG_MS = 6 * 60 * 1000;
setTimeout(() => {
  console.error(`ui-integration: exceeded its ${WATCHDOG_MS / 60000} min wall-clock budget — a CDP call never resolved (hung renderer?)`);
  Deno.exit(2);
}, WATCHDOG_MS);

// Evidence (screenshots) + the Chrome profile land on DURABLE storage (bead
// chp — /tmp is RAM-backed and has lost retained runs); `--retain` opts into
// overwriting the tracked test-artifacts/ PNGs.
const RUN_DIR = durableDir(`cap-ui-${Date.now()}`);
const RETAIN = Deno.args.includes("--retain");
const SHOTS = RETAIN ? `${ROOT}test-artifacts` : RUN_DIR;
console.log(`evidence dir: ${RUN_DIR}${RETAIN ? " (screenshots → tracked test-artifacts/)" : ""}`);

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

// The spawn goes through the shared launcher: the debugging port is
// kernel-assigned and the endpoint is read back from THIS child's own stderr
// (never a probe of a shared port). The argv below is the harness's own.
function launch(profile: string) {
  return launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--window-size=1400,900",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    clearEnv: true,
  });
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

const profile = `${RUN_DIR}/profile`;
const chrome = await launch(profile);
const proc = chrome.proc;
let exitCode = 1;
try {
  const port = chrome.port;
  const ws = new WebSocket(chrome.wsUrl);
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
  await Deno.writeFile(`${SHOTS}/sidebar-collapsed.png`, Uint8Array.from(atob(shotCollapsed.data), (c: string) => c.charCodeAt(0)));

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
  await Deno.writeFile(`${SHOTS}/sidebar-expanded.png`, Uint8Array.from(atob(shotExpanded.data), (c: string) => c.charCodeAt(0)));

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

  // 2g. Rapid double-click is a NET-ZERO toggle: two clicks return the
  //     sidebar to its prior state, and the final width matches the state.
  //     (The old ViewTransition.finished assertion was REMOVED: 6759766e
  //     deleted the view-transition machinery as a zero-behavior-change
  //     cleanup, so there is no transition left to await — these two behavior
  //     checks are the guard.)
  const rapidBefore = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
  await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); t.click(); t.click(); })()`);
  await sleep(600); // let the sidebar CSS transition settle
  const rapidAfter = await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); return { collapsed: side.classList.contains('collapsed'), width: Math.round(side.getBoundingClientRect().width) }; })()`);
  check("rapid double-click returns to the deterministic prior state (net-zero)", rapidAfter?.collapsed === rapidBefore, { rapidBefore, rapidAfter });
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

  // 4. The idle hub header carries no developer icons: the console moved to
  //    Settings → Advanced → Diagnostics (checked there, below) and the shield
  //    renders only while it has a security event to show
  //    (CAP-FB-20260830-HUB-CHROME-POLISH-01).
  const idleHeader = await cdp.eval(hub, `(() => {
    const shield = document.querySelector('security-shield');
    const r = shield?.getBoundingClientRect();
    return { console: !!document.querySelector('error-console'), shieldVisible: !!(r && r.width > 0 && r.height > 0) };
  })()`);
  check("the idle hub header has no console and no visible shield", idleHeader?.console === false && idleHeader?.shieldVisible === false, idleHeader);

  // 5. The hub's Activity ledger (sidebar <action-ledger>, the surface that
  //    replaced #run-log/activity-explorer in 585e59c5's hub-as-timeline
  //    redesign) renders real entries with padding, loaded through the
  //    PRODUCTION actions.list path: seed the SW ledger (memory key
  //    "cap:action-ledger") via memory.set, refresh() the mounted component,
  //    assert the row + the section un-hiding on a non-zero count.
  const activity = await cdp.eval(hub, `(async () => {
    const seed = await chrome.runtime.sendMessage({ type: "memory.set", origin: "master", key: "cap:action-ledger", value: [{ id: "ui5", sentence: "Closed the docs tab", ts: Date.now(), inverse: null }] });
    const ledger = document.getElementById('side-action-ledger');
    if (!ledger) return { note: 'no action-ledger mounted', seed };
    await ledger.refresh();
    await new Promise(r => setTimeout(r, 300)); // let entries-change un-hide the section
    const section = document.getElementById('activity-ledger-section');
    const row = ledger.shadowRoot?.querySelector('.al-row');
    if (!row) return { note: 'no row rendered', sectionHidden: section?.hidden, seed };
    const sentence = row.querySelector('.al-sentence');
    const cs = getComputedStyle(row);
    return { rowCount: ledger.shadowRoot.querySelectorAll('.al-row').length, sectionHidden: section?.hidden ?? true, text: sentence?.textContent?.trim() ?? '', paddingLeft: parseFloat(cs.paddingLeft), paddingTop: parseFloat(cs.paddingTop), empty: !!ledger.shadowRoot.querySelector('.al-empty'), seed };
  })()`);
  check("the hub Activity ledger renders the seeded entry via production actions.list", activity?.rowCount === 1 && activity?.sectionHidden === false && /Closed the docs tab/.test(activity?.text ?? ""), activity);
  check("the Activity ledger row has padding (not edge-to-edge)", (activity?.paddingLeft ?? 0) > 0 && (activity?.paddingTop ?? 0) > 0, activity);

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

  // 7b. Durability contract on the REAL path: the state resolves to a known
  //     value (durable on a disk-backed profile, session on a permissionless
  //     one — either is CORRECT) and the hint visibility matches the state:
  //     visible + accessible iff storage is session-only or failed, hidden
  //     when durable. (7c below drives all three states through the real
  //     renderer; this catches the real path landing in an inconsistent
  //     STATE→ELEMENT combination.)
  const realDurability = await cdp.eval(hub, `(async () => {
    const side = document.querySelector('#side');
    for (let i = 0; i < 20; i++) { if (side.getAttribute('data-durability') !== 'unknown') break; await new Promise(r => setTimeout(r, 100)); }
    const hint = document.getElementById('sidebar-durability-hint');
    return { durability: side.getAttribute('data-durability') ?? 'unknown', hintText: hint?.textContent?.trim() ?? '', hintHidden: hint?.hidden ?? true, hintRole: hint?.getAttribute('role') ?? '' };
  })()`);
  const knownDurability = ['durable', 'session', 'error'].includes(realDurability?.durability);
  const durabilityContract = realDurability?.durability === 'durable'
    ? realDurability?.hintHidden === true
    : knownDurability && realDurability?.hintHidden === false && realDurability?.hintRole === 'status' && (realDurability?.hintText ?? '').length > 0;
  check("sidebar durability resolves to a known state (not unknown)", knownDurability === true, realDurability);
  check("the durability hint visibility matches the state (visible iff session/error, role=status)", durabilityContract === true, realDurability);
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
  const expected = ["Providers", "Agents", "Browser control", "Permissions", "Skills", "Hooks", "Usage", "Data & memory"];
  const missing = expected.filter((s) => !(sections ?? []).some((x: string) => x.includes(s)));
  check("all settings sections render", missing.length === 0, { sections, missing });

  // 7. The toggles RENDER (a visible switch, not blank). The default
  //    Providers section has none — navigate to Browser control (hash routing)
  //    and find a RENDERED switch-toggle (hidden sections leave theirs 0×0).
  const toggle = await cdp.eval(settings, `(async () => {
    location.hash = '#browser';
    await new Promise(r => setTimeout(r, 400));
    const sw = Array.from(document.querySelectorAll('switch-toggle')).find(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
    if (!sw) return { note: 'no visible switch-toggle' };
    const sr = sw.shadowRoot;
    const knob = sr ? sr.querySelector('.switch,.knob,[role=switch],button') : sw;
    const r = knob.getBoundingClientRect();
    return { rendered: r.width > 0 && r.height > 0, w: r.width, h: r.height };
  })()`);
  check("settings toggles render a visible switch", toggle?.rendered === true, toggle);

  // 8. The provider Test-connection button renders — the provider cards render
  //    asynchronously through the SW provider.get round-trip, so poll briefly
  //    instead of sampling too early (the 95aw tabbed Providers UI keeps the
  //    per-family cards mounted; no configured provider is needed for the card).
  const testBtn = await cdp.eval(settings, `(async () => {
    location.hash = '#providers';
    for (let i = 0; i < 20; i++) {
      const b = Array.from(document.querySelectorAll('button')).find(b => /test connection/i.test(b.textContent));
      if (b) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return { note: 'no Test-connection button after 4s', panels: document.getElementById('provider-panels')?.textContent?.trim().slice(0, 120) };
  })()`);
  check("the provider Test-connection button renders", testBtn === true, testBtn);

  // 8b. The error console (Advanced → Diagnostics) opens AND stays in-bounds.
  //     Advanced is developer-gated; reveal the section for the probe.
  const consoleOpen = await cdp.eval(settings, `(() => {
    const sect = document.getElementById('prompts');
    if (sect) sect.hidden = false;
    location.hash = '#prompts';
    const ec = document.querySelector('#prompts error-console');
    if (!ec) return false;
    const btn = ec.shadowRoot ? ec.shadowRoot.querySelector('button') : ec.querySelector('button');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(400);
  const consoleRect = await cdp.eval(settings, `(() => {
    const ec = document.querySelector('#prompts error-console');
    const panels = Array.from(ec && ec.shadowRoot ? ec.shadowRoot.querySelectorAll('[popover]:popover-open,[class*=panel],[class*=console]') : []);
    const p = panels.find(el => /console|errors/i.test(el.textContent?.slice(0,40)));
    const r = p ? p.getBoundingClientRect() : null;
    return { found: !!p, rect: r ? { left:r.left, top:r.top, right:r.right, bottom:r.bottom } : null, vw: innerWidth, vh: innerHeight };
  })()`);
  check("the error console opens from Settings → Advanced → Diagnostics", consoleOpen && consoleRect?.found, consoleRect);
  if (consoleRect?.found && consoleRect.rect) {
    check("the error console stays in-bounds", inBounds(consoleRect.rect, consoleRect.vw, consoleRect.vh), consoleRect.rect);
  }
  await cdp.eval(settings, `(() => { const el = document.querySelector('#prompts error-console'); const panel = el?.shadowRoot?.querySelector('.panel'); const btn = el?.shadowRoot?.querySelector('button'); if (panel && !panel.hidden && btn) btn.click(); })()`);
  await sleep(300);

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
  const noMotion = (t: string) => t === "none" || t.includes("0s") || t === "all 0s ease 0s";
  check("prefers-reduced-motion disables the nub transition", reducedMotion && noMotion(reducedMotion.nub), reducedMotion);
  check("prefers-reduced-motion disables the sidebar transition", reducedMotion && noMotion(reducedMotion.side), reducedMotion);
  check("prefers-reduced-motion disables the overlay transition", reducedMotion && noMotion(reducedMotion.overlay), reducedMotion);
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }, hub);

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
  await Deno.writeFile(`${SHOTS}/overlay-open.png`, Uint8Array.from(atob(shotOverlay.data), (c: string) => c.charCodeAt(0)));

  const overlayGeom = await cdp.eval(hub, `(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round(b.left + b.width/2) }; };
    return { side: r(document.querySelector('#side')), overlay: r(document.getElementById('thread-view')), nub: r(document.querySelector('#side-toggle')), vw: innerWidth, vh: innerHeight };
  })()`);
  check("overlay-open matrix: overlay + nub are in-bounds", overlayGeom && overlayGeom.overlay && overlayGeom.nub && overlayGeom.overlay.left >= 0 && overlayGeom.overlay.right <= overlayGeom.vw && overlayGeom.nub.right <= overlayGeom.vw && overlayGeom.nub.left >= 0, overlayGeom);

  // RTL (overlay open): the rail + nub flip to the right; the overlay reserves
  // space on the right so the sidebar + nub stay visible (no overlap). Wait for
  // the overlay's left/right transition to settle before measuring.
  // RTL flip with transitions DISABLED: the overlay's left/right transition
  // only advances when the headless renderer produces frames, and forcing a
  // frame mid-transition deadlocks a subsequent Page.captureScreenshot — so
  // flip with an instant style and a synchronous reflow instead (the geometry
  // assertions below are transition-independent; reduced-motion coverage of
  // the transition itself is separate).
  await cdp.eval(hub, `(() => {
    const st = document.createElement('style'); st.id = 'uitest-no-transition'; st.textContent = '#thread-view { transition: none !important }';
    document.head.appendChild(st);
    document.documentElement.setAttribute('dir', 'rtl');
    document.getElementById('thread-view').offsetWidth; // force synchronous reflow to the final geometry
  })()`);
  await sleep(300);
  const overlayRtl = await cdp.eval(hub, `(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), cx: Math.round(b.left + b.width/2) }; };
    const side = r(document.querySelector('#side')); const nub = r(document.querySelector('#side-toggle')); const tv = document.getElementById('thread-view'); const overlay = r(tv);
    const tcs = getComputedStyle(tv);
    return { sideLeft: side.left, sideRight: side.right, nubCx: nub.cx, nubOnInner: Math.abs(nub.cx - side.left) <= 3, overlayLeft: overlay.left, overlayRight: overlay.right, overlayInBounds: overlay.left >= 0 && overlay.right <= innerWidth, noOverlap: overlay.right <= side.left, vw: innerWidth,
      dbg: { dir: document.documentElement.getAttribute('dir'), hidden: tv.hidden, cls: tv.className, matches: tv.matches('[dir="rtl"] #thread-view.view-overlay'), cssLeft: tcs.left, cssRight: tcs.right, display: tcs.display, pos: tcs.position } };
  })()`);
  check("overlay-open RTL: nub centres on the rail's inner boundary", overlayRtl?.nubOnInner === true, overlayRtl);
  check("overlay-open RTL: overlay stays in-bounds", overlayRtl?.overlayInBounds === true, overlayRtl);
  check("overlay-open RTL: overlay does NOT cover the sidebar/nub (no overlap)", overlayRtl?.noOverlap === true, overlayRtl);
  // NOTE: no RTL screenshot here — Page.captureScreenshot on a visually
  // SETTLED headless page waits for a frame that never gets scheduled (the
  // 5ht hang, pinpointed by marker bisection: the capture call never returns;
  // runs 05-10 in ~/logs/cap-5ht-gates/). The three RTL assertions above are
  // the gate; overlay-open.png (taken while the open transition keeps the
  // frame source alive) remains the visual evidence.
  await cdp.eval(hub, `(() => {
    document.documentElement.removeAttribute('dir');
    document.getElementById('uitest-no-transition')?.remove();
    document.getElementById('thread-view').offsetWidth; // reflow back to LTR geometry
  })()`);
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

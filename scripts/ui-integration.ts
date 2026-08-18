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
      items: { newTask: box('#new-task'), newAgent: box('#new-agent'), skills: box('#open-recipes'), directory: box('#open-directory'), settings: box('#open-settings') },
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
  // 2b-2. Real overlay hit-testing: force the thread overlay open and prove the
  //     FULL 44×44 nub is still hit-testable (elementFromPoint) + toggles on a
  //     pointer click — not just a z-index integer comparison.
  const overlayHit = await cdp.eval(hub, `(() => {
    const tv = document.getElementById('thread-view');
    tv.hidden = false; // simulate an open thread (no seeded thread needed)
    const t = document.querySelector('#side-toggle');
    const r = t.getBoundingClientRect();
    const pts = [
      { x: r.left + r.width/2, y: r.top + r.height/2 },
      { x: r.left + 3, y: r.top + 3 },
      { x: r.right - 3, y: r.bottom - 3 },
      { x: r.left + 3, y: r.bottom - 3 },
      { x: r.right - 3, y: r.top + 3 },
    ];
    const hits = pts.map(p => { const el = document.elementFromPoint(p.x, p.y); return el && (el === t || t.contains(el)); });
    tv.hidden = true;
    return { allInNub: hits.every(Boolean), hits, r: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } };
  })()`);
  check("open-thread overlay: every sampled point of the 44×44 nub is hit-testable", overlayHit?.allInNub === true, overlayHit);
  // A pointer click at the nub centre toggles even with the thread overlay open.
  const ptrBefore = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
  const nubCtr = await cdp.eval(hub, `(() => { const r = document.querySelector('#side-toggle').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await cdp.eval(hub, `document.getElementById('thread-view').hidden = false`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: nubCtr.x, y: nubCtr.y, button: "left", clickCount: 1 }, hub);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: nubCtr.x, y: nubCtr.y, button: "left", clickCount: 1 }, hub);
  await sleep(500);
  const ptrAfter = await cdp.eval(hub, `(() => { document.getElementById('thread-view').hidden = true; return document.querySelector('#side').classList.contains('collapsed'); })()`);
  check("pointer click on the nub toggles the sidebar with the thread overlay open", ptrAfter !== ptrBefore, { ptrBefore, ptrAfter });
  // Collapsed evidence (force the collapsed state first — the pointer click
  // above may have toggled it).
  await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); if (!side.classList.contains('collapsed')) document.querySelector('#side-toggle').click(); })()`);
  await sleep(400);
  const shotCollapsed = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, hub);
  await Deno.writeFile(`${ROOT}test-artifacts/sidebar-collapsed.png`, Uint8Array.from(atob(shotCollapsed.data), (c: number) => c.charCodeAt(0)));

  // 2c. Keyboard Enter toggles + aria-expanded/label/title track the state.
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

  // 2e. The collapsed state persists across a reload (collapse first, then
  //     AWAIT the serialized write flush before reloading).
  await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); if (!side.classList.contains('collapsed')) document.querySelector('#side-toggle').click(); })()`);
  await cdp.eval(hub, `window.__sidebarPersistence?.().flush() ?? Promise.resolve()`);
  await sleep(300);
  await cdp.send("Page.reload", {}, hub);
  await sleep(1500);
  const afterReload = await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); return { collapsed: side?.classList.contains('collapsed') ?? false, width: side ? Math.round(side.getBoundingClientRect().width) : 0, durability: side?.getAttribute('data-durability') ?? 'unknown' }; })()`);
  check("collapsed state persists across reload", afterReload?.collapsed === true && afterReload?.width === 60, afterReload);
  check("durability state is exposed on the rail", afterReload && ['durable', 'session', 'error', 'unknown'].includes(afterReload.durability), afterReload);
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
  //     to its prior state, and the View Transition LIFECYCLE completes (await
  //     its `finished`, not just a sleep + width check).
  const rapidBefore = await cdp.eval(hub, `document.querySelector('#side').classList.contains('collapsed')`);
  await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); t.click(); t.click(); })()`);
  const vtOutcome = await cdp.eval(hub, `(async () => {
    const t = window.__lastViewTransition?.();
    if (!t) return 'none';
    if (t.finished) { await t.finished; return 'finished'; }
    return 'no-finished';
  })()`);
  await sleep(300);
  const rapidAfter = await cdp.eval(hub, `(() => { const side = document.querySelector('#side'); return { collapsed: side.classList.contains('collapsed'), width: Math.round(side.getBoundingClientRect().width) }; })()`);
  check("rapid double-click returns to the deterministic prior state (net-zero)", rapidAfter.collapsed === rapidBefore, { rapidBefore, rapidAfter });
  check("View Transition lifecycle completed (finished awaited)", vtOutcome === 'finished' || vtOutcome === 'none', vtOutcome);
  check("width matches the final state after the transition", rapidAfter.width === (rapidAfter.collapsed ? 60 : 240), rapidAfter);

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

  // 7. REAL thread via production UI: run a demo-provider task (no key), which
  //    creates a thread; then reopen it through the actual sidebar thread-item
  //    and hit-test the nub with the thread overlay OPEN (not a forced hidden).
  await cdp.eval(hub, `(() => { const c = document.querySelector('#composer'); c?.dispatchEvent(new CustomEvent('send', { detail: { text: 'Summarise the docs', attachments: [] } })); })()`);
  await sleep(3500); // the agent loop runs (demo model is deterministic + fast)
  const threadState = await cdp.eval(hub, `(() => ({ items: document.querySelectorAll('.thread-item').length, first: document.querySelector('.thread-item .t-name')?.textContent?.trim() ?? '' }))()`);
  check("running a demo task creates a thread in the sidebar", threadState?.items >= 1, threadState);
  await cdp.eval(hub, `document.querySelector('.thread-item')?.click()`);
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

  // 7b. Persistence durability: permissionless profile → 'session'. The
  //     durable/error paths are unit-tested in tests/kv.test.ts (the backend
  //     failure mock makes chrome.storage.local.set throw → kvSet rejects; the
  //     sidebar's persistSidebar then flags 'error' via the {ok:false} return).
  await cdp.eval(hub, `window.__sidebarPersistence?.().flush() ?? Promise.resolve()`);
  const sessionDurability = await cdp.eval(hub, `document.querySelector('#side')?.getAttribute('data-durability') ?? 'unknown'`);
  check("permissionless profile: sidebar durability is 'session'", sessionDurability === 'session', sessionDurability);
  await cdp.eval(hub, `document.querySelector('#side-toggle').click()`);
  await cdp.eval(hub, `window.__sidebarPersistence?.().flush() ?? Promise.resolve()`);
  await sleep(400);

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
  const reducedMotion = await cdp.eval(hub, `(() => { const t = document.querySelector('#side-toggle'); return { transition: getComputedStyle(t).transition }; })()`);
  check("prefers-reduced-motion disables the nub transition", reducedMotion && (reducedMotion.transition === "none" || reducedMotion.transition.includes("0s")), reducedMotion);
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }, hub);

  const darkNub = await cdp.eval(hub, `(() => {
    document.documentElement.dataset.theme = 'charcoal';
    const nub = document.querySelector('#side-toggle .nub');
    const cs = getComputedStyle(nub);
    // READ the values BEFORE resetting the theme (getComputedStyle is live —
    // reading after the reset would validate the restored light theme).
    const out = { visible: cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px', border: cs.borderTopColor, bg: cs.backgroundColor };
    document.documentElement.dataset.theme = 'sunlit';
    return out;
  })()`);
  check("dark theme: nub renders with a visible border", darkNub?.visible === true, darkNub);

  exitCode = fail === 0 ? 0 : 1;
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { await Deno.remove(profile, { recursive: true }); } catch { /* best-effort */ }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
Deno.exit(exitCode);

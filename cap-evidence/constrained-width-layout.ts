// cap-evidence/constrained-width-layout.ts — REAL-BROWSER measurement of the
// two constrained-width layout defects the owner reported:
//
//   1. NTP hub: the Jobs board holds its column open, overflowing .main-wrap and
//      pushing the Agents box off the side; the board's content is also flush to
//      the panel edge where its own header is inset.
//   2. Side panel: collapsing the panel squeezes the harness buttons.
//
// Measures GEOMETRY, never appearance (the operator cannot see images):
// scrollWidth vs clientWidth to find the first element that refuses to shrink,
// computed padding to compare the board's inset with its own header's, and
// bounding rects to test whether a sibling is still inside the viewport.
//
// Run: deno run -A cap-evidence/constrained-width-layout.ts
// @ts-nocheck — untyped CDP scripting in the house pattern.

import { launchChrome } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = Deno.env.get("CAP_ACCEPTANCE_EXT") || `${ROOT}extension`;
const EVIDENCE_DIR = durableDir(`cap-constrained-width-${Date.now()}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${JSON.stringify(detail).slice(0, 600)}`); }
}

const profile = durableDir(`cap-constrained-width-profile-${Date.now()}`);
const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,1000", clearEnv: false });
await Deno.mkdir(EVIDENCE_DIR, { recursive: true });

const ws = new WebSocket(chrome.wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let idc = 0;
const pend = new Map();
ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
  const id = ++idc;
  return new Promise<any>((res, rej) => {
    pend.set(id, (m: any) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
};

// The extension id, read off its own service worker target (no key in the manifest).
async function extensionId(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"));
    if (sw) return String(sw.url).split("/")[2];
    await sleep(250);
  }
  throw new Error("the extension service worker never registered");
}
const extId = await extensionId();
console.log(`extension id: ${extId}`);

async function openPage(url: string, width: number, height = 900) {
  // No width/height here: CDP only accepts those with newWindow, and the
  // per-width measurement is done with Emulation.setDeviceMetricsOverride below.
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await sleep(600);
  return sessionId;
}
async function evaluate(sessionId: string, expression: string) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

// ---------------------------------------------------------------------------
// 1. THE HUB — the Jobs column must not hold .main-wrap open.
// ---------------------------------------------------------------------------
const HUB_PROBE = `(() => {
  const mw = document.querySelector('.main-wrap');
  if (!mw) return { error: 'no .main-wrap' };
  const cs = (el) => el ? getComputedStyle(el) : null;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const jobs = document.querySelector('#jobs-section');
  const agents = document.querySelector('#agents-section');
  const board = document.querySelector('#jobs-board-host');

  // WHO REFUSES TO SHRINK. An element's min-content width is what it will not go
  // below however little room it is given. Forcing width:0 and reading
  // scrollWidth measures exactly that (then restored). This is the instrument
  // that finds the culprit; comparing scrollWidth to the parent's clientWidth
  // does not, because a grid TRACK can be forced wide without any child
  // overflowing its own parent.
  const shrinkHolders = [];
  if (jobs) {
    for (const el of jobs.querySelectorAll('*')) {
      const prev = el.style.width;
      el.style.width = '0px';
      const minContent = el.scrollWidth;
      el.style.width = prev;
      if (minContent > 150) shrinkHolders.push({
        tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), id: el.id || '',
        minContent, whiteSpace: cs(el)?.whiteSpace, overflow: cs(el)?.overflow,
        overflowWrap: cs(el)?.overflowWrap, minWidth: cs(el)?.minWidth,
        text: (el.textContent || '').trim().slice(0, 60),
      });
    }
  }
  shrinkHolders.sort((a, b) => b.minContent - a.minContent);
  // WHO IS IN WHICH COLUMN, and what each grid child's own content refuses to go
  // below. The shadow root is crossed here (a plain querySelectorAll does not
  // see inside <jobs-board>, which is where the board's rows actually live).
  const deepMinContent = (el) => {
    let worst = 0, worstEl = '';
    const probe = (node) => {
      const prev = node.style.width;
      node.style.width = '0px';
      const m = node.scrollWidth;
      node.style.width = prev;
      if (m > worst) { worst = m; worstEl = node.tagName.toLowerCase() + '.' + String(node.className || ''); }
      const kids = [...node.children];
      if (node.shadowRoot) kids.push(...node.shadowRoot.children);
      for (const k of kids) probe(k);
    };
    probe(el);
    return { worst, worstEl };
  };
  const children = [...mw.children].map((el) => {
    const g = cs(el);
    const r = el.getBoundingClientRect();
    const deep = deepMinContent(el);
    return { tag: el.tagName.toLowerCase(), id: el.id || '', cls: String(el.className || '').slice(0, 40),
      order: g?.order, gridColumn: g?.gridColumn, gridRow: g?.gridRow,
      w: Math.round(r.width), x: Math.round(r.x),
      deepMinContent: deep.worst, deepMinContentAt: deep.worstEl };
  });
  // THE COMPANION RULES, EXERCISED, and measured as REAL SPILL: a rect that
  // extends past its row's content box. scrollWidth > clientWidth would NOT
  // work here — an ellipsised nowrap element (the honest design for a one-line
  // excerpt) always reports its clipped text in scrollWidth, so that comparison
  // calls correct truncation an overflow.
  let rowSpill = { worst: 0, worstAt: '', rows: 0 };
  let padAlign = null;
  const boardEl = document.querySelector('#jobs-board-host jobs-board');
  if (boardEl && boardEl.shadowRoot) {
    const rows = boardEl.shadowRoot.querySelectorAll('.jb-row');
    rowSpill.rows = rows.length;
    for (const row of rows) {
      const rr = row.getBoundingClientRect();
      for (const sel of ['.jb-desc', '.jb-msg', '.jb-party', '.jb-excerpt']) {
        for (const el of row.querySelectorAll(sel)) {
          const er = el.getBoundingClientRect();
          const over = Math.max(Math.round(er.right - rr.right), Math.round(rr.left - er.left), 0);
          if (over > rowSpill.worst) {
            rowSpill = { worst: over, worstAt: sel + ' "' + el.textContent.trim().slice(0, 36) + '"', rows: rows.length };
          }
        }
      }
    }
    // The board's content inset, against the panel header's own title inset:
    // "padding issues for the content inside it".
    const first = boardEl.shadowRoot.querySelector('.jb-head') || boardEl.shadowRoot.querySelector('.jb-desc');
    const titleEl = document.querySelector('#jobs-title');
    if (first && titleEl) {
      const c = Math.round(first.getBoundingClientRect().left), h = Math.round(titleEl.getBoundingClientRect().left);
      padAlign = { contentLeft: c, headLeft: h, delta: c - h };
    }
  }
  // Whether the board's own body scrolls vertically rather than pushing the hub
  // down — the intent stated at ntp.html's .jobs-board-body comment.
  const bodyScrolls = board ? board.scrollHeight > board.clientHeight && cs(board)?.overflowY !== 'visible' : null;
  const vw = window.innerWidth;
  const agRect = agents ? agents.getBoundingClientRect() : null;
  return {
    viewport: vw,
    mainWrap: { rect: rect(mw), scrollWidth: mw.scrollWidth, clientWidth: mw.clientWidth,
      overflowsBy: mw.scrollWidth - mw.clientWidth,
      scrollWidthDoc: document.documentElement.scrollWidth },
    jobsSection: jobs ? { rect: rect(jobs), minWidth: cs(jobs)?.minWidth,
      scrollWidth: jobs.scrollWidth, clientWidth: jobs.clientWidth, minContent: (() => {
        const p = jobs.style.width; jobs.style.width = '0px'; const w = jobs.scrollWidth; jobs.style.width = p; return w; })() } : null,
    agentsSection: agents ? { rect: rect(agents), minWidth: cs(agents)?.minWidth, hidden: agents.hidden,
      right: agRect ? Math.round(agRect.right) : 0,
      width: agRect ? Math.round(agRect.width) : 0,
      insideViewport: !!agRect && agRect.width > 0 && agRect.right <= vw + 1 } : null,
    board: board ? { rect: rect(board), padding: cs(board)?.padding, overflowY: cs(board)?.overflowY,
      maxHeight: cs(board)?.maxHeight, scrollHeight: board.scrollHeight, clientHeight: board.clientHeight } : null,
    panelHeadPadding: cs(document.querySelector('#jobs-section .panel-head'))?.padding,
    panelBodyPadding: cs(board)?.padding,
    gridTemplateColumns: cs(mw)?.gridTemplateColumns,
    rowSpill,
    padAlign,
    bodyScrolls,
    children,
    shrinkHolders: shrinkHolders.slice(0, 8),
  };
})()`;

const HUB_WIDTHS = [1440, 1280, 1100, 900];
const hubResults: Record<string, any> = {};
const wsHub = await openPage(`chrome-extension://${extId}/ntp/ntp.html`, 1440);
for (const w of HUB_WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 1000, deviceScaleFactor: 1, mobile: false }, wsHub);
  await sleep(400);
  // Show the Agents section: it is `hidden` until it has ever had a row, so a
  // fresh profile measures a ZERO-WIDTH box and "the Agents box is inside the
  // viewport" passes trivially. The owner has agents, so his is visible; make
  // the measurement match the condition the report is about.
  const hubSetup = await evaluate(wsHub, `(() => {
    const ag = document.querySelector('#agents-section');
    if (ag) ag.hidden = false;
    const host = document.querySelector('#jobs-board-host');
    const board = host && host.querySelector('jobs-board');
    if (!board) return 'no jobs-board';
    const longToken = 'run_01a0c8745ce17f4dad12a174bd9f3c12';
    board.jobs = [
      { id: 'j1', status: 'open', createdAt: Date.now() - 60000,
        description: 'Reindex the OPFS memory shards for the ' + longToken + ' run and report the byte totals',
        postedBy: 'owner', posterId: 'owner' },
      { id: 'j2', status: 'claimed', claimantId: 'acp:claude-code', claimantName: 'Claude Code',
        createdAt: Date.now() - 600000, claimedAt: Date.now() - 300000,
        description: 'Audit the harness permission surface against the constitution ' + longToken,
        postedBy: 'pi', posterId: 'pi', targetName: 'the hub' },
      { id: 'j3', status: 'blocked', blockedByOpen: 3, createdAt: Date.now() - 900000,
        description: 'Land the constrained-width layout fixes without widening scope',
        postedBy: 'owner', posterId: 'owner' },
      { id: 'j4', status: 'completed', settledAt: Date.now() - 120000, claimantName: 'Codex',
        description: 'Summarise the board',
        result: 'A long settled result body that has to stay inside its own panel: ' + longToken.repeat(3) }
    ];
    board.messages = [{ id: 'm1', fromName: 'pi', toName: 'Claude Code',
      body: 'Taking j2 — the token ' + longToken + ' needs care', ts: Date.now() - 30000 }];
    return 'agents visible=' + (ag ? !ag.hidden : false) + ' rows=' + board.shadowRoot.querySelectorAll('.jb-row').length;
  })()`);
  await sleep(350);
  hubResults[String(w)] = await evaluate(wsHub, HUB_PROBE);
  hubResults[String(w)].setup = hubSetup;
}

console.log("\n=== HUB: .main-wrap overflow by width");
for (const w of HUB_WIDTHS) {
  const r = hubResults[String(w)];
  const d = r.mainWrap;
  console.log(`  ${w}px  main-wrap ${d.clientWidth} client / ${d.scrollWidth} scroll  overflowBy=${d.overflowsBy}  doc=${d.scrollWidthDoc}`);
  console.log(`         grid=[${r.gridTemplateColumns}]  jobs min-content=${r.jobsSection?.minContent} shown=${r.jobsSection?.clientWidth}  agents.w=${r.agentsSection?.width} inside=${r.agentsSection?.insideViewport}  boardPad="${r.board?.padding}" headPad="${r.panelHeadPadding}"`);
  for (const o of (r.shrinkHolders || []).slice(0, 3)) {
    console.log(`         HOLDS OPEN <${o.tag} class="${o.cls}"> minContent=${o.minContent} ws=${o.whiteSpace} wrap=${o.overflowWrap} "${o.text.slice(0, 44)}"`);
  }
}

// The invariants the owner reported.
for (const w of HUB_WIDTHS) {
  const r = hubResults[String(w)];
  check(`hub ${w}px: .main-wrap does not overflow horizontally`, r.mainWrap.overflowsBy <= 1,
    { overBy: r.mainWrap.overflowsBy, scroll: r.mainWrap.scrollWidth, client: r.mainWrap.clientWidth });
  // Guarded non-vacuously: a hidden or zero-width Agents box satisfies
  // "inside the viewport" without any layout having happened.
  check(`hub ${w}px: the Agents box is visible AND inside the viewport`,
    r.agentsSection?.hidden === false && r.agentsSection?.width > 0 && r.agentsSection?.insideViewport === true,
    { agents: r.agentsSection, setup: r.setup });
}
// The Jobs column must not win the width fight: it is one of the two columns.
for (const w of [1440, 1280, 1100]) {
  const r = hubResults[String(w)];
  const share = r.jobsSection ? r.jobsSection.clientWidth / r.mainWrap.clientWidth : 1;
  check(`hub ${w}px: the Jobs column does not take more than 60% of the grid`,
    share <= 0.6, { jobsWidth: r.jobsSection?.clientWidth, wrapWidth: r.mainWrap.clientWidth, share: Number(share.toFixed(3)), grid: r.gridTemplateColumns });
}
// Padding: the board's content inset vs its own panel header's inset.
const pad1440 = hubResults["1440"];
const bodyLeft = parseFloat(String(pad1440.panelBodyPadding || "0").split(" ")[1] ?? "0");
const headLeft = parseFloat(String(pad1440.panelHeadPadding || "0").split(" ")[1] ?? "0");
check("hub: the Jobs board's content is inset like its own panel header", Math.abs(bodyLeft - headLeft) <= 1,
  { bodyPadding: pad1440.panelBodyPadding, headPadding: pad1440.panelHeadPadding });
check("hub: nothing inside the Jobs column holds the grid track open",
  (pad1440.shrinkHolders || []).every((o: any) => o.minContent <= 320),
  { shrinkHolders: (pad1440.shrinkHolders || []).slice(0, 4) });
// The companion rules, at the widths where the column is narrowest, and with a
// guard that the board actually rendered rows.
for (const w of [1100, 900]) {
  const r = hubResults[String(w)];
  check(`hub ${w}px: the board rendered rows (so the row checks mean something)`,
    r.rowSpill?.rows > 0, { rowSpill: r.rowSpill });
  check(`hub ${w}px: no board row's text spills past its own row`,
    r.rowSpill?.rows > 0 && r.rowSpill.worst <= 1, { rowSpill: r.rowSpill });
  check(`hub ${w}px: the board's body scrolls its own overflow rather than pushing the hub down`,
    r.bodyScrolls === true, { bodyScrolls: r.bodyScrolls });
}
check("hub: the board's content sits on the same inset as its own panel header",
  pad1440.padAlign && Math.abs(pad1440.padAlign.delta) <= 1, { padAlign: pad1440.padAlign });

// ---------------------------------------------------------------------------
// 2. THE SIDE PANEL — the harness buttons must not be squeezed when collapsed.
// ---------------------------------------------------------------------------
const PANEL_PROBE = `(() => {
  const el = document.querySelector('#harness-quick') || document.querySelector('#harness-quick-page');
  if (!el) return { error: 'no harness-quick container' };
  const btns = [...el.querySelectorAll('.hq')];
  return {
    viewport: window.innerWidth,
    containerVisible: el.getBoundingClientRect().width > 0,
    containerWidth: el.clientWidth,
    containerScrollWidth: el.scrollWidth,
    containerOverflowsBy: el.scrollWidth - el.clientWidth,
    buttons: btns.map((b) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const markEl = b.querySelector('.hq-mark');
      const mark = markEl && markEl.firstElementChild;
      const label = b.querySelector('.hq-label');
      // EXACT line count of the LABEL only. A Range over the whole button also
      // counts the (clipped) hidden label's boxes, which reads as a wrap that
      // did not happen.
      let lines = 0;
      const labelClipped = label ? getComputedStyle(label).clip !== "auto" : false;
      if (label && !labelClipped) {
        try {
          const range = document.createRange();
          range.selectNodeContents(label);
          lines = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0).length;
        } catch { lines = -1; }
      }
      // WHETHER THE LABEL WRAPPED, measured as height against a COMPUTED
      // single-line height — not against the Range's rect count, which reports
      // an extra rect for the ellipsised remainder of a clipped line and would
      // call a one-line chip wrapped. This is the observable the owner's
      // "compresses and looks weird" corresponds to.
      const lh = parseFloat(cs.lineHeight) || 0;
      const singleLine = Math.round(lh + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth));
      const wrapped = singleLine > 0 && r.height > singleLine + 3;
      return {
        text: b.textContent.trim().slice(0, 40),
        w: Math.round(r.width), h: Math.round(r.height),
        scrollWidth: b.scrollWidth, clientWidth: b.clientWidth,
        textOverflowsBy: b.scrollWidth - b.clientWidth,
        flexShrink: cs.flexShrink, whiteSpace: cs.whiteSpace,
        lines,
        singleLine,
        wrapped,
        labelClipped,
        overflowsContainer: r.right > el.getBoundingClientRect().right + 1,
        hasMark: !!mark,
        markTag: mark ? mark.tagName.toLowerCase() : null,
        markNS: mark ? (mark.namespaceURI || "") : null,
        markW: markEl ? Math.round(markEl.getBoundingClientRect().width) : 0,
        labelVisible: label ? getComputedStyle(label).display !== 'none' : null,
        ariaLabel: b.getAttribute('aria-label'),
      };
    }),
  };
})()`;

// The collapsed side panel is a genuinely narrow viewport; 260-300px is the
// range a dragged-in panel reaches. 400px is the comfortable case.
const PANEL_WIDTHS = [260, 300, 400];
const panelResults: Record<string, any> = {};
const wsPanel = await openPage(`chrome-extension://${extId}/sidepanel/sidepanel.html`, 400, 800);
// The harness buttons live in the Agents tabpanel, which starts `hidden`. A
// probe taken without switching tabs measures display:none and reports every
// button as 0x0 — the checks would then PASS on geometry that does not exist.
const tabSwitch = await evaluate(wsPanel, `(() => {
  const tab = document.getElementById('tab-agents');
  if (!tab) return 'no #tab-agents';
  tab.click();
  return document.getElementById('agents-view')?.hidden === false ? 'agents view shown' : 'still hidden after click';
})()`);
console.log(`  side panel tab switch: ${tabSwitch}`);
await sleep(400);
for (const w of PANEL_WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false }, wsPanel);
  await sleep(500);
  panelResults[String(w)] = await evaluate(wsPanel, PANEL_PROBE);
}

console.log("\n=== SIDE PANEL: harness buttons by width");
for (const w of PANEL_WIDTHS) {
  const r = panelResults[String(w)];
  if (r.error) { console.log(`  ${w}px  ${r.error}`); continue; }
  console.log(`  ${w}px  container=${r.containerWidth} scroll=${r.containerScrollWidth} overBy=${r.containerOverflowsBy}  buttons=${r.buttons.length}`);
  for (const b of r.buttons.slice(0, 5)) {
    console.log(`         "${b.text}" w=${b.w} h=${b.h} textOver=${b.textOverflowsBy} wrapped=${b.wrappedToMultipleLines} shrink=${b.flexShrink} ws=${b.whiteSpace} mark=${b.hasMark}`);
  }
}

const panelHasButtons = !panelResults["300"].error && panelResults["300"].buttons.length > 0;
check("side panel: the harness buttons rendered", panelHasButtons, { probe: panelResults["300"] });
// The guard that stops every check below passing vacuously: a hidden tabpanel
// yields 0x0 rects and would satisfy "nothing overflows" without any layout
// having happened. Geometry must EXIST before it can be judged.
check("side panel: the Agents view is actually laid out (non-zero geometry)",
  panelHasButtons && panelResults["300"].containerVisible === true &&
    panelResults["300"].buttons.every((b: any) => b.w > 0 && b.h > 0),
  { containerVisible: panelResults["300"].containerVisible, buttons: panelResults["300"].buttons.map((b: any) => ({ t: b.text, w: b.w, h: b.h })) });

// THE STRESS CASE that makes the reported compression observable. The registry
// bounds a harness's DISPLAY NAME not at all, and .hq carries flex-shrink:1 with
// white-space:normal — so a longer registered name shrinks the pill and wraps
// the label inside it. Measured with the real registered names first, then with
// one long name, so the difference is attributable to the CSS and not to the
// fixture.
const stressResults: Record<string, any> = {};
for (const w of PANEL_WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false }, wsPanel);
  await sleep(300);
  // Stressing the LABEL, not the button: replacing the button's whole contents
  // would delete the mark and the label element, so the container query that
  // hides the label no longer applies and the measurement stops being about the
  // CSS under test. The name is long enough to exceed the container at the width
  // where labels are VISIBLE, which is the only place the no-wrap/no-overflow
  // rules can be exercised at all.
  await evaluate(wsPanel, `(() => {
    const el = document.querySelector('#harness-quick') || document.querySelector('#harness-quick-page');
    const label = el && el.querySelector('.hq .hq-label');
    if (!label) return 'no label';
    label.dataset.origText = label.textContent;
    label.textContent = 'Claude Code with a long registered harness name that cannot fit the panel';
    return 'stressed';
  })()`);
  await sleep(200);
  stressResults[String(w)] = await evaluate(wsPanel, PANEL_PROBE);
  await evaluate(wsPanel, `(() => {
    const el = document.querySelector('#harness-quick') || document.querySelector('#harness-quick-page');
    const label = el && el.querySelector('.hq .hq-label');
    if (label && label.dataset.origText) { label.textContent = label.dataset.origText; delete label.dataset.origText; }
    return 'restored';
  })()`);
  await sleep(150);
}

console.log("\n=== SIDE PANEL: long registered name (stress)");
for (const w of PANEL_WIDTHS) {
  const r = stressResults[String(w)];
  const b = r?.buttons?.[0];
  if (!b) { console.log(`  ${w}px  (no button)`); continue; }
  console.log(`  ${w}px  "${b.text}" w=${b.w} h=${b.h} singleLine=${b.singleLine} wrapped=${b.wrapped} clipped=${b.labelClipped} shrink=${b.flexShrink} ws=${b.whiteSpace} overflow=${b.overflowsContainer} mark=${b.markTag}@${String(b.markNS).split('/').pop()}`);
  check(`panel ${w}px (long name): the label stays on one line OR is hidden`, b.labelClipped || !b.wrapped, b);
  check(`panel ${w}px (long name): the chip does not overflow its container`, !b.overflowsContainer, b);
  check(`panel ${w}px (long name): the chip does not exceed the container width`,
    b.labelClipped || b.w <= r.containerWidth + 1, { w: b.w, containerWidth: r.containerWidth });
}

if (panelHasButtons) {
  for (const w of PANEL_WIDTHS) {
    const r = panelResults[String(w)];
    check(`panel ${w}px: no harness button's text overflows its own box`,
      r.buttons.every((b: any) => b.textOverflowsBy <= 1), { buttons: r.buttons });
    check(`panel ${w}px: no harness button wraps its label to more than one line`,
      r.buttons.every((b: any) => b.labelClipped || !b.wrapped), { buttons: r.buttons.map((b: any) => ({ t: b.text, h: b.h, singleLine: b.singleLine, wrapped: b.wrapped })) });
    check(`panel ${w}px: every harness button stays inside its container`,
      r.buttons.every((b: any) => !b.overflowsContainer), { containerWidth: r.containerWidth, buttons: r.buttons });
  }
  // At the collapsed width the mark must carry the identity.
  const collapsed = panelResults["260"];
  check("panel 260px: every harness button carries a mark", collapsed.buttons.every((b: any) => b.hasMark && b.markW >= 12),
    { buttons: collapsed.buttons.map((b: any) => ({ t: b.text, hasMark: b.hasMark, markW: b.markW, tag: b.markTag, ns: b.markNS })) });
  check("panel 260px: the accessible name still states the full harness name",
    collapsed.buttons.every((b: any) => (b.ariaLabel || "").length > 4), { buttons: collapsed.buttons.map((b: any) => b.ariaLabel) });
}

await Deno.writeTextFile(`${EVIDENCE_DIR}/geometry.json`,
  JSON.stringify({ extId, hub: hubResults, panel: panelResults, pass, fail, failures }, null, 2));
console.log(`\n=== ${pass} passed / ${fail} failed`);
if (failures.length) console.log(`FAILURES:\n  - ${failures.join("\n  - ")}`);
console.log(`evidence: ${EVIDENCE_DIR}/geometry.json`);
try { await send("Browser.close"); } catch { /* already gone */ }
Deno.exit(fail ? 1 : 0);

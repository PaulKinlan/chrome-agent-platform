// component-gallery-smoke.ts — headless-Chrome interaction regression for the
// design-system Web Components (docs/components.html, served over HTTP because
// ES-module imports are blocked on file://).
//
// Drives the REAL components and asserts the interaction bugs that shipped
// before the base-Component re-wire fix:
//   - attach-button toggles open → close → reopen → close → reopen (no dead
//     state after the first close),
//   - agent-dialog (native <dialog>) closes via X, backdrop click, and Escape,
//     and returns focus to the trigger,
//   - permission-row Enable/Disable toggles,
//   - mic-button toggles on/off.
//
//   deno run -A scripts/component-gallery-smoke.ts

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DOCS = `${ROOT}docs`;

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

// Drift guard: the docs/ component gallery must match the canonical extension/
// sources AFTER the deterministic import rewrite scripts/sync-gallery.mjs
// applies (the gallery sits one directory shallower, so a handful of lib/
// imports are rewritten on the way). The raw byte compare that used to live
// here ignored that rewrite and failed by design on docs/components.js
// (CAP-FB-20260830-SUITE-HONESTY-01); the ONE source of truth for drift is
// the sync script's own --check mode, so this asks it.
const drift = await new Deno.Command("node", {
  args: [`${ROOT}scripts/sync-gallery.mjs`, "--check"],
  stdout: "piped",
  stderr: "piped",
}).output();
const driftOut = (new TextDecoder().decode(drift.stdout) + new TextDecoder().decode(drift.stderr)).trim();
check("gallery sync: docs/ matches extension/ after the sync rewrite (sync-gallery --check)", drift.code === 0, driftOut.slice(0, 600));

// A tiny static file server for the docs/ gallery (ES modules need HTTP).
function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: ac.signal, onListen: ({ port }) => {
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: async () => { ac.abort(); await server.shutdown(); },
        });
      } },
      async (req) => {
        const url = new URL(req.url);
        let path = decodeURIComponent(url.pathname);
        if (path === "/") path = "/components.html";
        const safe = `${DOCS}${path}`;
        try {
          const body = await Deno.readFile(safe);
          const type = path.endsWith(".js") ? "text/javascript"
            : path.endsWith(".css") ? "text/css"
            : path.endsWith(".html") ? "text/html"
            : "application/octet-stream";
          return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    );
  });
}

async function main() {
  const { url, close } = await serve();

  const tmp = await Deno.makeTempDir({ prefix: "cap-gallery-" });
  // The shared launcher: kernel-assigned port, endpoint read from this child's
  // own stderr, honest failure when the browser prints none.
  const chrome = await launchChrome({ profile: tmp, windowSize: "1440,900" });
  const proc = chrome.proc;
  const cdp = await openCdp(chrome.wsUrl);
  const send = async (method: string, params: unknown, sessionId?: string): Promise<any> =>
    (await cdp.send(method, params, sessionId)).result;
  const evl = (s: string, expr: string): Promise<any> => cdp.eval(s, expr);

  try {
    const t = await send("Target.createTarget", { url: `${url}/components.html` });
    const s = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await send("Runtime.enable", {}, s.sessionId);
    await sleep(2500);

    // attach-button reopen
    const att = await evl(s.sessionId, `(()=>{
      const a=document.querySelector('attach-button');
      const menuOpen=()=>!a.shadowRoot.querySelector('.menu').hidden;
      const clickPlus=()=>a.shadowRoot.querySelector('.plus').click();
      const seq=[]; for(let i=0;i<5;i++){clickPlus(); seq.push(menuOpen());} return seq;
    })()`);
    check("attach open→close→reopen→close→reopen", JSON.stringify(att) === "[true,false,true,false,true]", att);

    // dialog X / backdrop / Escape / focus return
    const dlg = await evl(s.sessionId, `(()=>{
      const d=document.getElementById('dialog');
      const trigger=document.getElementById('open-dialog');
      const isOpen=()=>d.shadowRoot.querySelector('dialog').open;
      const out={};
      trigger.click(); out.opens=isOpen();
      d.shadowRoot.querySelector('.x').click(); out.closedByX=!isOpen();
      trigger.click();
      const de=d.shadowRoot.querySelector('dialog');
      de.dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true}));
      out.closedByBackdrop=!isOpen();
      return out;
    })()`);
    check("dialog opens", dlg.opens === true, dlg);
    check("dialog X closes", dlg.closedByX === true, dlg);
    check("dialog backdrop click closes", dlg.closedByBackdrop === true, dlg);

    // Escape via real key + focus return
    await evl(s.sessionId, `(()=>{const tr=document.getElementById('open-dialog'); tr.focus(); tr.click();})()`);
    await sleep(200);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, s.sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, s.sessionId);
    await sleep(200);
    const esc = await evl(s.sessionId, `(()=>{const d=document.getElementById('dialog'); const tr=document.getElementById('open-dialog'); return {open:d.shadowRoot.querySelector('dialog').open, focusOnTrigger:document.activeElement===tr};})()`);
    check("dialog Escape closes + focus returns", esc.open === false && esc.focusOnTrigger === true, esc);

    // permission-row toggle
    const perm = await evl(s.sessionId, `(()=>{
      const row=document.querySelector('#perm-rows permission-row');
      const btn=()=>row.shadowRoot.querySelector('.btn');
      btn().click(); const g1=row.hasAttribute('granted');
      btn().click(); const g2=row.hasAttribute('granted');
      btn().click(); const g3=row.hasAttribute('granted');
      return {g1,g2,g3};
    })()`);
    check("permission-row enable→disable→enable", perm.g1 === true && perm.g2 === false && perm.g3 === true, perm);

    // mic toggle — the mic now requests the mic permission (getUserMedia) first
    // + surfaces a start() error, so stub BOTH the media permission and the
    // recognition (headless has neither) + await the async start.
    await evl(s.sessionId, `(()=>{
      navigator.mediaDevices = navigator.mediaDevices || {};
      navigator.mediaDevices.getUserMedia = () => Promise.resolve({ getTracks: () => [{ stop() {} }] });
      class MockSR { constructor(){ this.onresult=null; this.onerror=null; this.onend=null; } start(){} stop(){ this.onend?.(); } abort(){} }
      window.SpeechRecognition = MockSR;
    })()`);
    const mic = await evl(s.sessionId, `(async ()=>{
      const m=document.querySelector('mic-button');
      const clickMic=()=>m.shadowRoot.querySelector('.mic').click();
      const wait=()=>new Promise(r=>setTimeout(r,50));
      clickMic(); await wait(); const on1=m.hasAttribute('listening');
      clickMic(); await wait(); const on2=m.hasAttribute('listening');
      clickMic(); await wait(); const on3=m.hasAttribute('listening');
      return {on1,on2,on3};
    })()`);
    check("mic on→off→on", mic.on1 === true && mic.on2 === false && mic.on3 === true, mic);

    // capability-row open-delete (the background-agent row since the owner
    // removed the toggle primitive): renders a chevron (open the agent's view)
    // AND a Delete button — and NO enable/disable switch.
    const od = await evl(s.sessionId, `(()=>{
      const row = document.querySelector('capability-row[action="open-delete"]');
      if (!row) return { found: false };
      const open = row.shadowRoot.querySelector('.open');
      const del = row.shadowRoot.querySelector('button.delete, button[part="delete"]');
      const st = row.shadowRoot.querySelector('switch-toggle');
      return { found: true, hasOpen: !!open, hasDelete: !!del, hasToggle: !!st };
    })()`);
    check("capability-row open-delete has a chevron + Delete and no switch", od.found && od.hasOpen && od.hasDelete && !od.hasToggle, od);

    // The direct <switch-toggle> specimen still renders a visible 36×20 switch
    // (the blank-toggle bug: the pill styling lived in document-scope
    // theme.css, unreachable from the Shadow DOM — now in the component's own
    // scoped style). The switch lives on permission rows and other non-agent
    // controls — NOT on background-agent rows (delete is the primitive there).
    const sw = await evl(s.sessionId, `(()=>{
      const st = document.querySelector('.stage switch-toggle');
      if (!st) return { found: false };
      const sw = st.shadowRoot ? st.shadowRoot.querySelector('.sw') : null;
      if (!sw) return { found: false };
      const cs = getComputedStyle(sw);
      return { found: true, w: cs.width, h: cs.height, pressed: sw.getAttribute('aria-pressed') };
    })()`);
    check("standalone switch-toggle is a visible switch (36×20)", sw.found && sw.w === "36px" && sw.h === "20px", sw);

    // composer / command palette opens (the static namespace registry; the
    // data-driven sub-items need chrome.runtime, which the showcase lacks).
    const pal = await evl(s.sessionId, `(()=>{
      const c = document.querySelector('#composer');
      const ta = c.querySelector('#task-input');
      const pop = c.querySelector('.popup');
      ta.focus(); ta.value = "/"; ta.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(r => setTimeout(() => r({ hidden: pop.hidden, count: pop.querySelectorAll('.item').length }), 100));
    })()`);
    check("composer / palette opens", pal.hidden === false && pal.count > 0, pal);

    // L9 (light-DOM styling contract): the composer + conversation controls
    // render light-DOM (shadow() → false for CDP), so their styles come from a
    // document-scope <style>. A CSS collision (the blank-toggle mechanism) would
    // zero their size — assert every key control has a non-zero computed box.
    const sizes = await evl(s.sessionId, `(()=>{
      const vis = (el) => { if(!el) return -1; const r=el.getBoundingClientRect(); return r.width*r.height; };
      const c = document.querySelector('#composer');
      const cv = document.getElementById('conv-example');
      return {
        taskInput: vis(c?.querySelector('#task-input')),
        runTask: vis(c?.querySelector('#run-task, .run')),
        composer: vis(c),
        conversation: vis(cv),
      };
    })()`);
    const zeroSized = Object.entries(sizes ?? {}).filter(([, v]) => typeof v === "number" && v <= 0);
    check("composer/conversation controls have non-zero size", zeroSized.length === 0, sizes);

    // <agent-conversation> renders a full turn: a fenced code block in the user
    // message, a collapsible thinking trace, structured tool cards (done/error),
    // and a system response with code + inline code + a list (the conversation
    // regression: code blocks were unstyled raw text + tool calls were text).
    const conv = await evl(s.sessionId, `(()=>{
      const c = document.getElementById('conv-example');
      if (!c) return { found:false };
      const bubbles = [...c.querySelectorAll('message-bubble')];
      const codeCount = (b) => b.shadowRoot ? b.shadowRoot.querySelectorAll('code-block').length : 0;
      const user = bubbles.find(b=>b.getAttribute('role')==='user');
      const sys = bubbles.find(b=>b.getAttribute('role')==='system');
      const tool = bubbles.find(b=>b.getAttribute('role')==='tool');
      const think = bubbles.find(b=>b.getAttribute('role')==='thinking');
      return {
        found:true,
        count: bubbles.length,
        userCodeBlock: user ? codeCount(user) : 0,
        userCodeLang: user?.shadowRoot?.querySelector('code-block')?.getAttribute('lang'),
        systemCodeBlock: sys ? codeCount(sys) : 0,
        systemInlineCode: !!sys?.shadowRoot?.querySelector('code.inline-code'),
        systemList: !!sys?.shadowRoot?.querySelector('ul'),
        toolName: tool?.getAttribute('tool-name'),
        toolStatus: tool?.shadowRoot?.querySelector('.tool-status')?.textContent?.trim(),
        toolHasResult: tool?.hasAttribute('tool-result'),
        thinkingCollapsible: !!think?.shadowRoot?.querySelector('details.think'),
      };
    })()`);
    check("agent-conversation renders 5 messages", conv.found && conv.count === 5, conv);
    check("user message renders a fenced code block", conv.userCodeBlock === 1 && conv.userCodeLang === "tool_code", conv);
    check("system response renders code + inline code + list", conv.systemCodeBlock === 1 && conv.systemInlineCode === true && conv.systemList === true, conv);
    check("tool call renders a structured card", conv.toolName != null && conv.toolStatus === "done" && conv.toolHasResult === true, conv);
    check("thinking renders as a collapsible trace", conv.thinkingCollapsible === true, conv);

    // HTML output renders in a SANDBOXED iframe; non-HTML stays markdown (no
    // iframe). The wider-goal item: a tool/agent that returns HTML should show
    // it as live HTML, not escaped text (the co-do double-iframe pattern).
    const htmlFrame = await evl(s.sessionId, `(()=>{
      const mk=(role,content)=>{const b=document.createElement('message-bubble'); b.setAttribute('role',role); b.setAttribute('content',content); document.body.appendChild(b); return b;};
      const doc=mk('agent','<!doctype html><html><body><h1>Hi</h1><p>rendered</p></body></html>');
      const frag=mk('agent','<div><section><h2>Fragment</h2></section></div>');
      const md=mk('agent','Just **markdown** text with a [link](https://example.com).');
      return new Promise(r=>setTimeout(()=>{
        const f=(b)=>b.shadowRoot.querySelector('iframe');
        const df=f(doc), ff=f(frag), mf=f(md);
        r({
          docIframe: !!df, docSandbox: df?.getAttribute('sandbox')||'',
          fragmentIframe: !!ff,
          markdownIframe: !!mf,
        });
      }, 250));
    })()`);
    check("full HTML doc renders in a sandboxed iframe", htmlFrame.docIframe === true && htmlFrame.docSandbox.includes("allow-scripts"), htmlFrame);
    check("block-level HTML fragment renders in an iframe", htmlFrame.fragmentIframe === true, htmlFrame);
    check("markdown does NOT render an iframe", htmlFrame.markdownIframe === false, htmlFrame);

    // A provider/config error bubble shows the UNWRAPPED reason + the action +
    // a "Fix in Settings" button (the actionable provider-failure path).
    const errBubble = await evl(s.sessionId, `(()=>{
      const b=document.createElement('message-bubble');
      b.setAttribute('role','error');
      b.setAttribute('error-reason','the provider returned 401 (invalid API key)');
      b.setAttribute('error-action','Check the API key in Settings.');
      b.setAttribute('error-category','provider-auth');
      document.body.appendChild(b);
      return new Promise(r=>setTimeout(()=>r({
        reason: b.shadowRoot?.querySelector('.err-reason')?.textContent?.trim(),
        action: !!b.shadowRoot?.querySelector('.err-action'),
        fixBtn: !!b.shadowRoot?.querySelector('.err-fix'),
      }), 150));
    })()`);
    check("error bubble shows the unwrapped reason + action + Fix button", errBubble.reason?.includes('401') === true && errBubble.action === true && errBubble.fixBtn === true, errBubble);

    // error-console copy-all button (per-line copy is only present with entries;
    // the showcase degrades to the empty state, but the header control must exist).
    const consoleCopy = await evl(s.sessionId, `(()=>{
      const c=document.querySelector('error-console');
      return !!c?.shadowRoot?.querySelector('[data-copy-all]');
    })()`);
    check("error-console has a Copy all button", consoleCopy === true, consoleCopy);


    // <activity-explorer> — the browsable/searchable activity log. Seeded demo
    // entries must render rows (one per entry), the agent filter must list the
    // distinct sources, and a search query must narrow the list.
    const activity = await evl(s.sessionId, `(()=>{
      const a = document.getElementById('activity-demo');
      if (!a?.shadowRoot) return { found:false };
      const rows = a.shadowRoot.querySelectorAll('.aex-entry').length;
      const options = [...a.shadowRoot.querySelectorAll('.aex-agent option')].map(o=>o.value).filter(Boolean);
      const texts = [...a.shadowRoot.querySelectorAll('.aex-text')].map(x=>x.textContent);
      const search = a.shadowRoot.querySelector('.aex-search');
      search.value = 'paul';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(r => setTimeout(() => r({
        found:true, rows, options, texts,
        filteredRows: a.shadowRoot.querySelectorAll('.aex-entry').length,
      }), 80));
    })()`);
    check("activity-explorer renders rows + agent filter", activity.found === true && activity.rows >= 5 && activity.options.length >= 3, activity);
    check("activity-explorer search narrows the list", activity.found === true && activity.filteredRows < activity.rows && activity.filteredRows >= 1, activity);
    // The tool-result summary must be READABLE — never the double-escaped JSON.
    const readable = (activity.texts || []).every((t: string) => !t.includes('\\"') && !t.includes('modelContent'));
    check("activity tool-result renders a readable summary (no escaped JSON)", readable === true, activity.texts || []);

    // Regression: clicking the console's own buttons (copy-all / clear) must
    // NOT close the panel. The bug was host.contains() not traversing the shadow
    // root, so every in-panel click read as an outside click + closed it.
    const consoleButtons = await evl(s.sessionId, `(async()=>{
      const c=document.querySelector('error-console');
      if(!c?.shadowRoot) return {found:false};
      c.shadowRoot.querySelector('.trigger').click();
      await new Promise(r=>setTimeout(r,60));
      const panel=c.shadowRoot.querySelector('.panel');
      const openAfterTrigger = !panel.hidden;
      c.shadowRoot.querySelector('[data-copy-all]').click();
      await new Promise(r=>setTimeout(r,60));
      const openAfterCopyAll = !panel.hidden;
      c.shadowRoot.querySelector('[data-clear]').click();
      await new Promise(r=>setTimeout(r,80));
      const openAfterClear = !panel.hidden;
      return {found:true, openAfterTrigger, openAfterCopyAll, openAfterClear};
    })()`);
    check("console buttons (copy-all/clear) do NOT close the panel",
      consoleButtons.found === true &&
      consoleButtons.openAfterTrigger === true &&
      consoleButtons.openAfterCopyAll === true &&
      consoleButtons.openAfterClear === true, consoleButtons);

    // <artifact-diff> — the bakery diff renders in BOTH modes with a real width,
    // the header carries the counts, and the keyboard walk (] ] [) lands focus
    // on a hunk section with the live region saying "Change 2 of 2".
    const adiff = await evl(s.sessionId, `(async()=>{
      const d = document.getElementById('artifact-diff-demo');
      const btn = document.getElementById('artifact-diff-mode');
      if (!d?.shadowRoot || !btn) return { found:false };
      const wait = () => new Promise(r => setTimeout(r, 80));
      const info = () => {
        const sr = d.shadowRoot;
        const r = d.getBoundingClientRect();
        return {
          width: r.width, height: r.height,
          mode: sr.querySelector('.body')?.dataset.mode,
          counts: [...(sr.querySelector('.counts')?.children ?? [])].map(c => c.textContent.trim()).join(' '),
          changes: sr.querySelector('.changes')?.textContent.trim(),
          hunks: sr.querySelectorAll('.hunk').length,
          unifiedRows: sr.querySelectorAll('.ln').length,
          pairRows: sr.querySelectorAll('.pair').length,
          region: sr.querySelector('.body')?.getAttribute('aria-label'),
          rawHtml: [...sr.querySelectorAll('.tx')].some(t => t.children.length > 0),
        };
      };
      const unified = info();
      btn.click(); await wait();
      const split = info();
      btn.click(); await wait();
      const back = info();
      return { found:true, unified, split, back };
    })()`);
    check("artifact-diff specimen renders unified with width > 200px + the +10 -2 header", adiff.found && adiff.unified.width > 200 && adiff.unified.mode === "unified" && adiff.unified.counts === "+10 -2" && adiff.unified.changes === "2 changes" && adiff.unified.hunks === 2 && adiff.unified.unifiedRows > 0, adiff);
    check("artifact-diff specimen renders split with width > 200px (paired rows)", adiff.found && adiff.split.width > 200 && adiff.split.mode === "split" && adiff.split.pairRows > 0 && adiff.split.unifiedRows === 0 && adiff.split.hunks === 2, adiff);
    check("artifact-diff region is labelled with the counts + rows carry no child markup", adiff.found && adiff.unified.region === "Diff, 10 additions, 2 deletions, 2 changes" && adiff.unified.rawHtml === false && adiff.back.mode === "unified", adiff);

    // Keyboard walk with REAL key events: focus the first hunk (the Tab stop),
    // press ] twice (clamps at 2) and [ once, then ] again → "Change 2 of 2".
    await evl(s.sessionId, `document.getElementById('artifact-diff-demo').shadowRoot.querySelector('.hunk').focus()`);
    const key = async (k: string, code: number) => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k === "]" ? "BracketRight" : "BracketLeft", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: k }, s.sessionId);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k === "]" ? "BracketRight" : "BracketLeft", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, s.sessionId);
      await sleep(60);
    };
    await key("]", 221); await key("]", 221); await key("[", 219); await key("]", 221);
    const walk = await evl(s.sessionId, `(()=>{
      const d = document.getElementById('artifact-diff-demo');
      const deep = (() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a; })();
      return {
        activeIsHunk: !!deep && deep.classList.contains('hunk') && deep.getRootNode() === d.shadowRoot,
        activeIndex: deep?.dataset?.index,
        current: d.shadowRoot.querySelector('.hunk[data-current]')?.dataset.index,
        status: d.shadowRoot.querySelector('.status')?.textContent,
      };
    })()`);
    check("artifact-diff keyboard walk ] ] [ ] focuses the hunk + announces 'Change 2 of 2'", walk.activeIsHunk === true && walk.activeIndex === "1" && walk.current === "1" && walk.status === "Change 2 of 2", walk);

    // CAP-FB-20260830-HUB-CHROME-POLISH-01: no visible specimen renders at ZERO
    // width. A block host with `container-type: inline-size` and no explicit
    // inline size collapses to 0 px inside a column stage (the directory card
    // measured 0 px wide and 3,599 px tall — one character per line). Every
    // custom-element specimen placed directly on a stage must take real width,
    // and the directory card specifically must be wider than 200 px.
    const widths = await evl(s.sessionId, `(()=>{
      const out = [];
      for (const stage of document.querySelectorAll('.stage')) {
        for (const el of stage.children) {
          if (!el.tagName.includes('-') || el.hidden) continue;
          const r = el.getBoundingClientRect();
          if (r.height <= 0) continue; // an empty/lazy specimen has no box to measure
          out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      const card = document.getElementById('tool-directory-demo')?.getBoundingClientRect();
      return { specimens: out, card: card ? { w: Math.round(card.width), h: Math.round(card.height) } : null };
    })()`);
    const zeroWidth = (widths?.specimens ?? []).filter((x: { w: number }) => x.w <= 0);
    check("gallery: no visible specimen renders at zero width", widths?.specimens?.length > 0 && zeroWidth.length === 0, zeroWidth);
    check("tool-directory-card specimen renders wider than 200px", widths?.card !== null && widths.card.w > 200, widths?.card);

    // The BeautifulUI-inspired primitives render their shadow content (not
    // empty/blank) + expose the key affordances.
    const bui = await evl(s.sessionId, `(()=>{
      const pick = (n) => document.querySelector(n);
      const renderLen = (n) => { const e = pick(n); return e && e.shadowRoot ? e.shadowRoot.textContent.trim().length : -1; };
      return {
        loadingGrid: !!(pick('loading-state')?.shadowRoot?.querySelector('.grid')),
        thinkingDetails: !!(pick('thinking-trace')?.shadowRoot?.querySelector('details')),
        toolChipCount: (pick('tool-chips')?.shadowRoot?.querySelectorAll('.chip')?.length ?? 0),
        taskRowInd: !!(pick('task-row')?.shadowRoot?.querySelector('.ind')),
        streamingCaret: !!(pick('streaming-text[streaming]')?.shadowRoot?.querySelector('.body')),
        approvalButtons: (pick('approval-card')?.shadowRoot?.querySelectorAll('button')?.length ?? 0),
        promptBarInput: !!(pick('prompt-bar')?.shadowRoot?.querySelector('#pb-input')),
      };
    })()`);
    check("loading-state renders the pixel grid", bui.loadingGrid === true, bui);
    check("thinking-trace renders a collapsible details", bui.thinkingDetails === true, bui);
    check("tool-chips renders 3 chips", bui.toolChipCount === 3, bui);
    check("task-row renders a status indicator", bui.taskRowInd === true, bui);
    check("streaming-text[streaming] renders the body + caret", bui.streamingCaret === true, bui);
    check("approval-card renders Approve/Deny buttons", bui.approvalButtons === 2, bui);
    check("prompt-bar renders the composer input", bui.promptBarInput === true, bui);
  } finally {
    cdp.close();
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    await close();
    try { await Deno.remove(tmp, { recursive: true }); } catch { /* ignore */ }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail ? 1 : 0);
}

await main();

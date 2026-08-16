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

const ROOT = new URL("..", import.meta.url).pathname;
const DOCS = `${ROOT}docs`;
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

// Drift guard: the docs/ component gallery must be byte-identical to the
// canonical extension/shared/ design-system source (single source of truth).
// Fails the gate if the deploy copy has drifted from the canonical files.
const DRIFT_FILES: [string, string][] = [
  ["extension/shared/components.js", "docs/components.js"],
  ["extension/shared/theme.css", "docs/theme.css"],
];
for (const [src, dst] of DRIFT_FILES) {
  const [a, b] = await Promise.all([
    Deno.readFile(`${ROOT}${src}`),
    Deno.readFile(`${ROOT}${dst}`),
  ]);
  const identical = a.length === b.length &&
    a.every((byte, i) => byte === b[i]);
  check(`gallery sync: ${dst} matches ${src}`, identical, { srcBytes: a.length, dstBytes: b.length });
}

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
  const proc = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--remote-debugging-port=0", "--remote-allow-origins=*",
      "--window-size=1440,900", `--user-data-dir=${tmp}`, "about:blank",
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();

  let wsUrl = "";
  const buf = new Uint8Array(1024);
  // Read stderr until the DevTools URL appears (bounded).
  const reader = proc.stderr.getReader();
  const deadline = Date.now() + 15000;
  let acc = "";
  while (Date.now() < deadline && !wsUrl) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
    const m = acc.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) wsUrl = m[1];
  }

  if (!wsUrl) {
    console.log("FAIL: could not find the Chrome DevTools URL");
    await close();
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
    return new Promise((resolve) => {
      pend.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r?.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    // Runtime.evaluate returns { result: RemoteObject, exceptionDetails }; the
    // RemoteObject carries the actual value.
    return r?.result?.value;
  };

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

    // mic toggle
    const mic = await evl(s.sessionId, `(()=>{
      const m=document.querySelector('mic-button');
      const clickMic=()=>m.shadowRoot.querySelector('.mic').click();
      clickMic(); const on1=m.hasAttribute('listening');
      clickMic(); const on2=m.hasAttribute('listening');
      clickMic(); const on3=m.hasAttribute('listening');
      return {on1,on2,on3};
    })()`);
    check("mic on→off→on", mic.on1 === true && mic.on2 === false && mic.on3 === true, mic);

    // capability-row toggle renders a visible switch (the blank-toggle bug: the
    // pill styling lived in document-scope theme.css, unreachable from the Shadow
    // DOM — now in the component's own scoped style).
    const sw = await evl(s.sessionId, `(()=>{
      const row = document.querySelector('capability-row[action="toggle"]');
      if (!row) return { found: false };
      const st = row.shadowRoot.querySelector('switch-toggle');
      const sw = st ? st.shadowRoot.querySelector('.sw') : null;
      if (!sw) return { found: false };
      const cs = getComputedStyle(sw);
      return { found: true, w: cs.width, h: cs.height, pressed: sw.getAttribute('aria-pressed') };
    })()`);
    check("capability-row toggle is a visible switch (36×20)", sw.found && sw.w === "36px" && sw.h === "20px", sw);

    // composer / command palette opens (the static namespace registry; the
    // data-driven sub-items need chrome.runtime, which the showcase lacks).
    const pal = await evl(s.sessionId, `(()=>{
      const c = document.querySelector('#composer');
      const ta = c.querySelector('#task-input');
      const pop = c.querySelector('#popup');
      ta.focus(); ta.value = "/"; ta.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(r => setTimeout(() => r({ hidden: pop.hidden, count: pop.querySelectorAll('.item').length }), 100));
    })()`);
    check("composer / palette opens", pal.hidden === false && pal.count > 0, pal);

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
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    await close();
    try { await Deno.remove(tmp, { recursive: true }); } catch { /* ignore */ }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail ? 1 : 0);
}

await main();

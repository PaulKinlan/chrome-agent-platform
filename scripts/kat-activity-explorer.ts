// kat-activity-explorer.ts — CAP-FB-20260826-RECENT-ACTIVITY-FILTER-01 KAT.
// Drives the REAL <activity-explorer> (extension/shared/components.js) in
// headless Chromium against three backend shapes:
//   A. HANGING backend (the worker never answers — the MV3-kill failure mode
//      that produced Paul's dead controls): the component MUST settle with an
//      honest error + Retry, and the agent select must never be option-less.
//   B. ERRORING backend: the honest error + Retry appears immediately.
//   C. WORKING backend: search narrows, per-agent filter narrows, 'All agents'
//      restores, clearing search restores.
//
//   deno run -A scripts/kat-activity-explorer.ts

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENTRIES = [
  { ts: 1000, source: "master", agentLabel: "hub", type: "task", task: "Summarise the latest content from paul.kinlan.me" },
  { ts: 900, source: "agent:paul", agentLabel: "Paul", type: "tool-call", tool: "list_agents", args: "{}" },
  { ts: 800, source: "background:recipe:sort", agentLabel: "Sorting Hat", type: "tool-result", tool: "tab_group", result: "grouped 12 tabs into 3 domains" },
];

function page(chromeStub: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>aex-kat</title>
  <script>${chromeStub}</script>
  <script type="module">
    import "/extension/shared/components.js";
    const a = document.createElement("activity-explorer");
    a.setAttribute("limit", "50");
    document.body.append(a);
  </script>
  </head><body></body></html>`;
}

const STUBS = {
  // Never calls the callback — the MV3-kill hang shape.
  hang: `window.chrome = { runtime: { sendMessage: (_m, cb) => { /* never */ } } };`,
  // Calls back with an error envelope.
  error: `window.chrome = { runtime: { sendMessage: (_m, cb) => cb({ ok: false, error: "boom" }) } };`,
  // Calls back with real entries.
  ok: `window.chrome = { runtime: { sendMessage: (_m, cb) => cb({ entries: ${JSON.stringify(ENTRIES)}, count: ${ENTRIES.length}, total: ${ENTRIES.length} }) } };`,
};

function serve(pages: Record<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    Deno.serve(
      { port: 0, signal: ac.signal, onListen: ({ port }) =>
        resolve({ url: `http://127.0.0.1:${port}`, close: async () => { ac.abort(); } }) },
      async (req) => {
        const path = new URL(req.url).pathname;
        // Serve the REAL extension tree (components.js imports sibling modules
        // — agent-registry/command-parser/run-status/tool-tree — so a lone
        // /components.js route 404s the module graph and the element never
        // mounts; that was the harness-only mount failure).
        if (path.startsWith("/extension/")) {
          try {
            const body = await Deno.readFile(`${ROOT}${path.slice(1)}`);
            const type = path.endsWith(".js") ? "text/javascript"
              : path.endsWith(".css") ? "text/css" : "application/octet-stream";
            return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
          } catch { return new Response("not found", { status: 404 }); }
        }
        const key = path.slice(1);
        if (pages[key]) {
          return new Response(pages[key], { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        return new Response("not found", { status: 404 });
      },
    );
  });
}

async function main() {
  const { url, close } = await serve({ hang: page(STUBS.hang), error: page(STUBS.error), ok: page(STUBS.ok) });
  const tmp = await Deno.makeTempDir({ prefix: "cap-aex-kat-" });
  // The shared launcher: kernel-assigned port, endpoint read from this child's
  // own stderr, honest failure when the browser prints none.
  let chrome;
  try {
    chrome = await launchChrome({ profile: tmp, windowSize: "1200,800" });
  } catch (e) {
    console.log(`FAIL: no DevTools URL — ${String(e)}`);
    await close();
    Deno.exit(1);
  }
  const proc = chrome.proc;
  const cdp = await openCdp(chrome.wsUrl);
  const send = async (method: string, params: unknown, sessionId?: string): Promise<any> =>
    (await cdp.send(method, params, sessionId)).result;
  const open = async (path: string) => {
    const t = await send("Target.createTarget", { url: `${url}/${path}` });
    const s = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await send("Runtime.enable", {}, s.sessionId);
    return s.sessionId;
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  };

  try {
    // ── Scenario A: hanging backend ───────────────────────────────────────
    {
      const s = await open("hang");
      await sleep(2500);
      const early = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        const sel=a.shadowRoot.querySelector('.aex-agent');
        return { options: sel.options.length, first: sel.options[0]?.textContent };
      })()`);
      check("hang: agent select shows 'All agents' immediately (never option-less)",
        early.options >= 1 && early.first === "All agents", early);
      // Wait out the 12s bounded load.
      await sleep(11500);
      const settled = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        const empty=a.shadowRoot.querySelector('.aex-empty');
        const retry=a.shadowRoot.querySelector('.aex-retry');
        return { text: empty?.textContent, hasRetry: !!retry, loadError: a._loadError ?? null };
      })()`);
      check("hang: load settles with an honest error (no infinite hang)", Boolean(settled.loadError), settled);
      check("hang: honest message + Retry rendered", Boolean(settled.hasRetry) && /didn't answer/.test(settled.text || ""), settled);
      // The controls still respond (search filters the empty list without error).
      const ctrl = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        const search=a.shadowRoot.querySelector('.aex-search');
        search.value='paul';
        search.dispatchEvent(new Event('input',{bubbles:true}));
        return { rows: a.shadowRoot.querySelectorAll('.aex-entry').length };
      })()`);
      check("hang: search control still responds", ctrl.rows === 0, ctrl);
      await send("Target.closeTarget", { targetId: (await send("Target.getTargets", {})).targetInfos.find((t:any)=>t.url.endsWith("/hang"))?.id }).catch(() => {});
    }

    // ── Scenario B: erroring backend ──────────────────────────────────────
    {
      const s = await open("error");
      await sleep(2500);
      const r = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        return { text: a.shadowRoot.querySelector('.aex-empty')?.textContent,
          hasRetry: !!a.shadowRoot.querySelector('.aex-retry'),
          options: a.shadowRoot.querySelector('.aex-agent').options.length };
      })()`);
      check("error: honest backend error + Retry rendered", /boom/.test(r.text || "") && r.hasRetry, r);
      check("error: select still populated", r.options >= 1, r);
    }

    // ── Scenario C: working backend — the filter contract ─────────────────
    {
      const s = await open("ok");
      await sleep(2500);
      const init = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        return { rows: a.shadowRoot.querySelectorAll('.aex-entry').length,
          options: [...a.shadowRoot.querySelector('.aex-agent').options].map(o=>o.value),
          err: a._loadError ?? null };
      })()`);
      check("ok: entries render through the backend path", init.rows === 3 && init.err === null, init);
      check("ok: agent options populated from sources", JSON.stringify(init.options) === JSON.stringify(["", "master", "agent:paul", "background:recipe:sort"]), init);

      const search = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        const el=a.shadowRoot.querySelector('.aex-search');
        el.value='paul';
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'l'}));
        return a.shadowRoot.querySelectorAll('.aex-entry').length;
      })()`);
      check("ok: typing in search narrows the list (3→2)", search === 2, search);

      const cleared = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        const el=a.shadowRoot.querySelector('.aex-search');
        el.value='';
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
        return a.shadowRoot.querySelectorAll('.aex-entry').length;
      })()`);
      check("ok: clearing search restores the list (2→3)", cleared === 3, cleared);

      const agent = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        const sel=a.shadowRoot.querySelector('.aex-agent');
        sel.value='agent:paul';
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        return a.shadowRoot.querySelectorAll('.aex-entry').length;
      })()`);
      check("ok: per-agent filter narrows (3→1)", agent === 1, agent);

      const all = await evl(s, `(()=>{
        const a=document.querySelector('activity-explorer');
        const sel=a.shadowRoot.querySelector('.aex-agent');
        sel.value='';
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        return a.shadowRoot.querySelectorAll('.aex-entry').length;
      })()`);
      check("ok: 'All agents' restores the full list (1→3)", all === 3, all);
    }
  } finally {
    cdp.close();
    try { proc.kill(); } catch {}
    await close();
  }

  console.log(`\nKAT: ${pass} pass ${fail} fail`);
  Deno.exit(fail > 0 ? 1 : 0);
}
await main();

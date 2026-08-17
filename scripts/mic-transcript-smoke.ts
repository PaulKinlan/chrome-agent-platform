// mic-transcript-smoke.ts — headless-Chrome regression for the mic → transcript
// → composer-input path. Headless Chrome has no real microphone, so we stub
// SpeechRecognition and drive the REAL mic-button + agent-composer to prove the
// onresult → transcript → input.value chain is wired (no silent no-op).
//
//   deno run -A scripts/mic-transcript-smoke.ts

const ROOT = new URL("..", import.meta.url).pathname;
const DOCS = `${ROOT}docs`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: ac.signal, onListen: ({ port }) => {
        resolve({ url: `http://127.0.0.1:${port}`, close: async () => { ac.abort(); await server.shutdown(); } });
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
        } catch { return new Response("not found", { status: 404 }); }
      },
    );
  });
}

async function main() {
  const { url, close } = await serve();
  const tmp = await Deno.makeTempDir({ prefix: "cap-mic-" });
  const proc = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1440,900",
      `--user-data-dir=${tmp}`, "about:blank",
    ],
    stdout: "null", stderr: "piped",
  }).spawn();

  let wsUrl = "";
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
  if (!wsUrl) { console.log("FAIL: no DevTools URL"); await close(); Deno.exit(1); }

  let id = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const resolve = pend.get(m.id)!; pend.delete(m.id); resolve(m.result); }
  };
  const send = (method: string, params: unknown, sessionId?: string): Promise<any> => {
    const mid = ++id;
    return new Promise((resolve) => { pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  };

  try {
    const t = await send("Target.createTarget", { url: `${url}/components.html` });
    const s = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await send("Runtime.enable", {}, s.sessionId);
    await sleep(2500);

    // Stub SpeechRecognition + getUserMedia (headless has no microphone, so a
    // real getUserMedia would reject → the mic would fail-closed). The stub
    // proves the permission gate passes + the transcript path is wired.
    await evl(s.sessionId, `(()=>{
      window.__sr = null;
      navigator.mediaDevices = navigator.mediaDevices || {};
      navigator.mediaDevices.getUserMedia = () => Promise.resolve({
        getTracks: () => [{ stop() {} }],
      });
      class MockSpeechRecognition {
        constructor(){ this.continuous=false; this.interimResults=false; this.lang=''; this.onresult=null; this.onerror=null; this.onend=null; }
        start(){ this.started = true; }
        stop(){ this.stopped = true; this.onend?.(); }
        abort(){ this.onend = null; }
      }
      window.SpeechRecognition = MockSpeechRecognition;
      window.__fireResult = (text, isFinal) => {
        const rec = window.__sr;
        if (!rec || !rec.onresult) return 'no-rec';
        const res = { isFinal, 0: { transcript: text } };
        rec.onresult({ results: { length: 1, 0: res, [0]: res } });
        return 'fired';
      };
      // Patch the MicButton.start to capture the instance it constructs.
    })()`);

    // Click the mic in the agent-composer (light DOM — #mic is directly reachable).
    // start() is now async (it awaits the mic-permission request), so await it.
    const opened = await evl(s.sessionId, `(async ()=>{
      const composer = document.querySelector('agent-composer#composer') || document.querySelector('agent-composer');
      const mic = composer.querySelector('mic-button') || composer.querySelector('#mic');
      if (!mic) return 'no-mic';
      const Orig = window.SpeechRecognition;
      window.SpeechRecognition = class extends Orig {
        constructor(){ super(); window.__sr = this; }
      };
      mic.shadowRoot.querySelector('.mic').click();
      await new Promise(r => setTimeout(r, 60));
      return { listening: mic.hasAttribute('listening'), started: window.__sr ? window.__sr.started : false };
    })()`);
    check("mic toggles listening on click", opened?.listening === true, opened);
    check("recognition started", opened?.started === true, opened);

    // Fire a transcript result + assert the composer input shows it.
    const out = await evl(s.sessionId, `(()=>{
      const composer = document.querySelector('agent-composer#composer') || document.querySelector('agent-composer');
      const ta = composer.querySelector('#task-input');
      const before = ta.value;
      const fired = window.__fireResult('hello world', false);
      return { fired, before, after: ta.value };
    })()`);
    check("onresult fires", out?.fired === "fired", out);
    check("transcript reaches the composer input", out?.after === "hello world", out);
  } catch (e) {
    check("mic transcript smoke ran without error", false, String(e));
  } finally {
    await close();
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();

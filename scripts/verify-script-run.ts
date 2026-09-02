// Real-browser verification of the agent-generated-script execution
// (extension/lib/scripts.js + offscreen/offscreen.js + the script.* routes).
// Loads the built extension unpacked, drives a script through the service
// worker's `script.run` route (via chrome.runtime.sendMessage from a page
// context), and asserts the sandboxed script returns its result.
// @ts-nocheck
import { launchChrome } from "./lib/chrome-launch.ts";

const CHROMIUM = Deno.env.get("CHROMIUM") || "/usr/bin/chromium";
const EXT = new URL("../extension", import.meta.url).pathname;

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

// The spawn goes through the shared launcher: the debugging port is
// kernel-assigned and the endpoint is read back from THIS child's own stderr.
function launch(profile) {
  return launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--window-size=1200,900", `--user-data-dir=${profile}`,
      "about:blank",
    ],
    clearEnv: true,
  });
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }; }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
}

async function main() {
  const profile = await Deno.makeTempDir({ prefix: "cap-script-" });
  const { proc, wsUrl } = await launch(profile);
  const cdp = new Cdp(wsUrl);
  await cdp.ready;
  await sleep(1200);

  // Get the extension id via the management API in the browser context.
  const tgt = await cdp.send("Target.createTarget", { url: "chrome://extensions" });
  const ses = await cdp.send("Target.attachToTarget", { targetId: tgt.targetId, flatten: true });
  const extId = (await cdp.send("Runtime.evaluate", {
    expression: `(async()=>{const e=(await chrome.management.getAll()).find(x=>x.name&&x.name.toLowerCase().includes('agent')); return e?e.id:null;})()`,
    returnByValue: true, awaitPromise: true,
  }, ses.sessionId)).result.value;

  if (!extId) { console.error("ext not found"); Deno.exit(1); }

  // Open the NTP page so we have a trusted extension page to run the route from.
  const ntp = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const ns = await cdp.send("Target.attachToTarget", { targetId: ntp.targetId, flatten: true });
  await sleep(2000);

  const run = (expression) => cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ns.sessionId);

  // 1. Create a script (a computed value + a log — no network needed).
  const created = await run(`(async()=>{ const r = await chrome.runtime.sendMessage({ type:'script.create', origin:'master', name:'verify-42', source:'log("hi from script"); return 42;' }); return r; })()`);
  console.log("create:", JSON.stringify(created.result?.value ?? created));

  const scriptId = created.result?.value?.script?.id;
  if (!scriptId) { console.error("no script id"); Deno.exit(1); }

  // 2. Run the script — must return { ok:true, result:42 } through the sandbox.
  const ran = await run(`(async()=>{ const r = await chrome.runtime.sendMessage({ type:'script.run', origin:'master', id:${JSON.stringify(scriptId)} }); return r; })()`);
  console.log("run:", JSON.stringify(ran.result?.value ?? ran));

  const ok = ran.result?.value?.ok === true && ran.result?.value?.result === 42;
  console.log(ok ? "SCRIPT-RUN-PASS" : "SCRIPT-RUN-FAIL");
  proc.kill("SIGKILL");
  Deno.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); Deno.exit(1); });

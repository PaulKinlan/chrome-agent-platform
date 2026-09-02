// scripts/validate-package-load.ts — load the PACKAGED archive (the real
// production artifact, dereferenced) in headless Chromium and assert the SW
// registers + the options page renders the shared picker. No seam — this is
// the shipped extension exactly as a user would load it.
// @ts-nocheck
import { CHROMIUM, launchChrome } from "./lib/chrome-launch.ts";
const ROOT = new URL("..", import.meta.url).pathname;
const archives = [];
for await (const f of Deno.readDir(ROOT + "dist-archives")) { if (f.name.endsWith(".zip")) archives.push(ROOT + "dist-archives/" + f.name); }
archives.sort();
const zip = Deno.args[0] ?? archives[archives.length - 1];
if (!zip) throw new Error("no archive");
const ext = await Deno.makeTempDir({ prefix: "cap-pkg-load-" });
const unzip = new Deno.Command("unzip", { args: ["-q", zip, "-d", ext] }).output();
if (!(await unzip).success) throw new Error("unzip failed");
console.log("package:", zip, "->", ext);

const profile = await Deno.makeTempDir({ prefix: "cap-pkg-profile-" });
// The spawn goes through the shared launcher: the debugging port is
// kernel-assigned and the endpoint is read back from THIS child's own stderr.
// The argv is this harness's own (the PACKAGED build is what gets loaded).
const { proc, port } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--silent-debugger-extension-api",
    `--disable-extensions-except=${ext}`,`--load-extension=${ext}`,`--user-data-dir=${profile}`,"about:blank"],
  clearEnv: true,
});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let sw=null;
for (let i=0;i<75&&!sw;i++){ const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); sw = t.find(x=> x.type==="service_worker" && /\/dist\/background\/service-worker\.js$/.test(x.url??"")); if(!sw) await sleep(400); }
console.log("PRODUCTION PACKAGE SW LOADED:", Boolean(sw));
if (!sw) { proc.kill(); throw new Error("the packaged extension's SW did not load"); }
const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
// options page: the shared picker renders (production bundle, no seam).
const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extId}/options/options.html`)}`, {method:"PUT"})).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let n=0; const pend=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const f=pend.get(m.id); pend.delete(m.id); f(m);}};
const send=(method,params={})=>new Promise(res=>{const mid=++n;pend.set(mid,res);ws.send(JSON.stringify({id:mid,method,params}));});
await send("Runtime.enable"); await sleep(2500);
// Seed a named agent via the real route so the per-agent row (provider-select) renders.
await send("Runtime.evaluate",{expression:`chrome.runtime.sendMessage({type:"named-agent.create", id:"pkg-probe", name:"Pkg Probe"}).then(()=>1)`,returnByValue:true,awaitPromise:true});
await send("Page.reload");
await sleep(2000);
const r = await send("Runtime.evaluate",{expression:`JSON.stringify({providerCards: document.querySelectorAll(".provider-card").length, picker: !!document.querySelector("model-picker"), providerSelect: !!document.querySelector("provider-select")})`,returnByValue:true});
console.log("options render:", r?.result?.result?.value);
const parsed = JSON.parse(r?.result?.result?.value ?? "{}");
const ok = parsed.providerCards >= 5 && parsed.picker && parsed.providerSelect;
console.log("PRODUCTION PACKAGE VALIDATION:", ok ? "PASS" : "FAIL");
proc.kill();
await Deno.remove(ext, { recursive: true }).catch(()=>{});
Deno.exit(ok ? 0 : 1);

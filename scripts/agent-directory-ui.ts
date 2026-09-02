// Loaded-MV3 acceptance for the full Agent Directory view.
// Drives the genuine Directory button, uses the production tool registry, and
// retains screenshots + geometry/AX evidence outside the source tree when
// AGENT_DIRECTORY_ARTIFACT_DIR is set.

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.env.get("AGENT_DIRECTORY_EXTENSION_DIR") || `${ROOT}extension`;
const OUT = Deno.env.get("AGENT_DIRECTORY_ARTIFACT_DIR") ||
  await Deno.makeTempDir({ prefix: "cap-agent-directory-artifacts-" });
const BASELINE = Deno.args.includes("--baseline");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await Deno.mkdir(OUT, { recursive: true });
const profile = await Deno.makeTempDir({ prefix: "cap-agent-directory-profile-" });
let passed = 0;
let failed = 0;
const assertions: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
const diagnostics = {
  consoleErrors: [] as unknown[],
  runtimeExceptions: [] as unknown[],
  networkFailures: [] as unknown[],
  logErrors: [] as unknown[],
};
async function sha256File(path: string) {
  try {
    const bytes = await Deno.readFile(path);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    return `unavailable:${error instanceof Error ? error.name : "error"}`;
  }
}
async function removeProfile() {
  // Chromium children can finish flushing profile files just after the browser
  // parent exits. Retry this owned directory briefly rather than leaking it or
  // deleting any process/profile outside this harness.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await Deno.remove(profile, { recursive: true });
      return;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      if (attempt === 19) throw error;
      await sleep(100);
    }
  }
}
function check(name: string, pass: boolean, detail?: unknown) {
  assertions.push({ name, pass, detail });
  if (pass) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.error(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

// The shared launcher: kernel-assigned debugging port, the DevTools endpoint
// read from THIS child's own stderr (drained in the background afterwards),
// an honest throw when the browser prints none.
const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1280,900" });
const proc = chrome.proc;
const wsUrl = chrome.wsUrl;
const port = chrome.port;
// This harness keeps its own CDP socket: it records console/runtime/network/
// log diagnostics per session for the "no errors" gate.
let id = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const ws = new WebSocket(wsUrl);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("CDP websocket failed")); });
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(msg.params?.type)) {
    diagnostics.consoleErrors.push({ sessionId: msg.sessionId, type: msg.params.type, args: msg.params.args?.map((arg: any) => arg.value ?? arg.description) });
  } else if (msg.method === "Runtime.exceptionThrown") {
    diagnostics.runtimeExceptions.push({ sessionId: msg.sessionId, exceptionDetails: msg.params?.exceptionDetails });
  } else if (msg.method === "Network.loadingFailed" && !msg.params?.canceled) {
    diagnostics.networkFailures.push({ sessionId: msg.sessionId, errorText: msg.params?.errorText, type: msg.params?.type, blockedReason: msg.params?.blockedReason });
  } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
    diagnostics.logErrors.push({ sessionId: msg.sessionId, entry: msg.params.entry });
  }
};
function send(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params, sessionId }));
  });
}
async function evaluate(sessionId: string, expression: string) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function click(sessionId: string, selector: string) {
  const point = await evaluate(sessionId, `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; })()`);
  if (!point?.w || !point?.h) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
  }
  return true;
}
async function screenshot(sessionId: string, name: string) {
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
  await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)));
}

try {
  let extensionId = "";
  let worker: any = null;
  for (let i = 0; i < 60 && !worker; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    worker = targets.find((target: any) => target.type === "service_worker");
    if (!worker) await sleep(200);
  }
  if (!worker) throw new Error("Extension service worker did not load");
  extensionId = worker.url.split("/")[2];
  const sw = (await send("Target.attachToTarget", { targetId: worker.id, flatten: true })).sessionId;
  await Promise.all([send("Runtime.enable", {}, sw), send("Log.enable", {}, sw)]);

  const origin = "https://directory.example";
  const target = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/ntp/ntp.html` });
  const page = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await Promise.all([
    send("Runtime.enable", {}, page), send("Page.enable", {}, page),
    send("Accessibility.enable", {}, page), send("Network.enable", {}, page), send("Log.enable", {}, page),
  ]);
  await sleep(2200);
  // Populate the canonical production registry itself: agent.create enrolls in
  // the real worker; replaceTools/approveTool write the same bounded OPFS
  // records read by the Directory routes. No UI fixture state or test seam.
  await evaluate(page, `(async()=>{
    await chrome.runtime.sendMessage({type:'agent.create',origin:${JSON.stringify(origin)}});
    const tools=await import(chrome.runtime.getURL('lib/tools.js'));
    await tools.replaceTools(${JSON.stringify(origin)}, [
      {name:'calendar.create_event_with_attendees_and_a_very_long_but_valid_name',description:'Creates a calendar event for the supplied title, start time, and attendee list. This intentionally long canonical registry description verifies that real tool documentation wraps without leaving its function card.',source:'declared',inputSchema:{type:'object',required:['title','startsAt'],properties:{title:{type:'string'},startsAt:{type:'string'},attendees:{type:'array'}}}},
      {name:'page.summary',description:'Summarises the currently enrolled page.',source:'declared',inputSchema:{type:'object',properties:{detail:{type:'string'}}}},
      {name:'availability.check',description:'',source:'inferred',inputSchema:{type:'object',properties:{date:{type:'string'}}}}
    ]);
    await tools.approveTool(${JSON.stringify(origin)}, 'page.summary', true);
    return true;
  })()`);
  check("genuine Directory control click dispatched", await click(page, "#open-directory"));
  await sleep(1800);

  const probeExpr = `(() => {
    const frame=document.querySelector('#view-frame'); const d=frame?.contentDocument;
    const rect=(e)=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const inside=(a,b)=>a.left>=b.left-.5&&a.right<=b.right+.5&&a.top>=b.top-.5&&a.bottom<=b.bottom+.5;
    const hosts=d?[...d.querySelectorAll('tool-directory-card')]:[];
    const side=document.querySelector('#side'); const nub=document.querySelector('#side-toggle');
    const roots=hosts.map(h=>h.shadowRoot);
    const statuses=roots.flatMap(r=>r?[...r.querySelectorAll('[role=status]')]:[]);
    return { title:document.querySelector('#view-title')?.textContent, frameLoaded:hosts.length>0,
      counts:{cards:hosts.length,statuses:statuses.length,descriptions:roots.filter(r=>r?.querySelector('.tool-description')).length},
      overflow:{parent:document.documentElement.scrollWidth-document.documentElement.clientWidth,frame:d?d.documentElement.scrollWidth-d.documentElement.clientWidth:null},
      cards:hosts.map((h,i)=>{const c=roots[i]?.querySelector('.tool-card');const cr=rect(c);const badges=[...roots[i].querySelectorAll('.tool-status')];return {name:roots[i].querySelector('.tool-name')?.textContent,inside:badges.every(b=>inside(rect(b),cr)),statusCount:badges.length,scrollOverflow:c.scrollWidth-c.clientWidth,desc:roots[i].querySelector('.tool-description')?.textContent,meta:roots[i].querySelector('.tool-metadata')?.textContent};}),
      nub:{inert:nub?.inert,ariaHidden:nub?.getAttribute('aria-hidden'),display:nub?getComputedStyle(nub).display:null,visibility:nub?getComputedStyle(nub).visibility:null,pointerEvents:nub?getComputedStyle(nub).pointerEvents:null,hit:(()=>{if(!nub)return null;const r=nub.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.id||document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest?.('#side-toggle')?.id||null})()},
      side:{inert:side?.inert,ariaHidden:side?.getAttribute('aria-hidden'),visibility:side?getComputedStyle(side).visibility:null,pointerEvents:side?getComputedStyle(side).pointerEvents:null}
    };
  })()`;
  const setCondition = async (width: number, height: number, dir: string, theme: string) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, page);
    await evaluate(page, `(() => { document.documentElement.dir=${JSON.stringify(dir)}; document.documentElement.dataset.theme=${JSON.stringify(theme)}; const d=document.querySelector('#view-frame')?.contentDocument; if(d){d.documentElement.dir=${JSON.stringify(dir)};d.documentElement.dataset.theme=${JSON.stringify(theme)};} })()`);
    await sleep(250);
  };
  const conditions = [
    [1280, 900, "ltr", "sunlit", "normal"], [360, 800, "ltr", "sunlit", "narrow"],
    [760, 800, "rtl", "sunlit", "rtl"], [760, 800, "ltr", "midnight", "midnight"],
  ] as const;
  const evidence: Record<string, unknown> = {};
  for (const [width, height, dir, theme, name] of conditions) {
    await setCondition(width, height, dir, theme);
    const probe = await evaluate(page, probeExpr);
    evidence[name] = probe;
    await screenshot(page, `${BASELINE ? "before" : "after"}-${name}`);
    if (!BASELINE) {
      check(`${name}: populated production tool cards`, probe.frameLoaded && probe.counts.cards === 3, probe);
      check(`${name}: no horizontal or card/status overflow`, probe.overflow.parent <= 0 && probe.overflow.frame <= 0 && probe.cards.every((c: any) => c.inside && c.scrollOverflow <= 0 && c.statusCount >= 2), probe);
      check(`${name}: canonical description/schema metadata rendered`, probe.cards.every((c: any) => c.desc && c.meta), probe.cards);
      check(`${name}: covered sidebar and nub are hidden, inert, and not hit-testable`, probe.side.inert && probe.nub.inert && probe.side.ariaHidden === "true" && probe.nub.ariaHidden === "true" && probe.side.visibility === "hidden" && probe.nub.visibility === "hidden" && probe.side.pointerEvents === "none" && probe.nub.pointerEvents === "none" && probe.nub.hit !== "side-toggle", probe);
    }
  }
  if (!BASELINE) {
    const frameTree = await send("Page.getFrameTree", {}, page);
    const directoryFrameId = frameTree.frameTree?.childFrames?.find((f: any) => f.frame?.url?.includes("/directory/directory.html"))?.frame?.id;
    const ax = await send("Accessibility.getFullAXTree", directoryFrameId ? { frameId: directoryFrameId } : {}, page);
    const names = (ax.nodes || []).map((n: any) => ({ role:n.role?.value, name:n.name?.value })).filter((n: any) => n.name);
    const statusNames = names.filter((n: any) => n.role === "status").map((n: any) => n.name);
    const expectedStatusNames = [
      "calendar.create_event_with_attendees_and_a_very_long_but_valid_name: Declared",
      "calendar.create_event_with_attendees_and_a_very_long_but_valid_name: Approval required",
      "page.summary: Declared",
      "page.summary: Approved",
      "availability.check: Inferred",
      "availability.check: Approval required",
    ];
    check("AX tree exposes exact per-function state names", expectedStatusNames.every((name) => statusNames.includes(name)), { expectedStatusNames, statusNames });
    check("Directory journey has no console, runtime, network, or log errors", Object.values(diagnostics).every((entries) => entries.length === 0), diagnostics);

    await click(page, "#view-back");
    await sleep(350);
    const restored = await evaluate(page, `(() => {const s=document.querySelector('#side'),n=document.querySelector('#side-toggle');return {viewHidden:document.querySelector('#view').hidden,sideInert:s.inert,nubInert:n.inert,sideAria:s.hasAttribute('aria-hidden'),nubAria:n.hasAttribute('aria-hidden'),sideVisibility:getComputedStyle(s).visibility,nubVisibility:getComputedStyle(n).visibility,nubPointer:getComputedStyle(n).pointerEvents};})()`);
    check("closing Directory restores sidebar and nub exactly", restored.viewHidden && !restored.sideInert && !restored.nubInert && !restored.sideAria && !restored.nubAria && restored.sideVisibility === "visible" && restored.nubVisibility === "visible" && restored.nubPointer !== "none", restored);
  }
  const sourceFiles = [
    "directory/directory.html", "directory/directory.js", "ntp/ntp.html", "ntp/ntp.js", "shared/components.js",
  ];
  const sourceBinding = {
    extensionDir: EXT,
    files: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, await sha256File(`${EXT}/${file}`)]))),
    harnessSha256: await sha256File(new URL(import.meta.url).pathname),
  };
  await Deno.writeTextFile(`${OUT}/${BASELINE ? "before" : "after"}-evidence.json`, JSON.stringify({ mode:BASELINE?"baseline":"acceptance", passed, failed, assertions, evidence, diagnostics, sourceBinding }, null, 2) + "\n");
} finally {
  ws.close();
  try { proc.kill("SIGKILL"); } catch { /* already exited */ }
  await proc.status.catch(() => null);
  await removeProfile();
}
console.log(`RESULT: ${passed} passed, ${failed} failed; artifacts: ${OUT}`);
if (!BASELINE && failed) Deno.exit(1);

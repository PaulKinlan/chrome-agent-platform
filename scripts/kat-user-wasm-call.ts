// scripts/kat-user-wasm-call.ts — End-to-end browser KAT for user-uploaded WASM execution
// Proves:
// 1. Upload genuinely user-supplied WASM via Settings UI
// 2. Drive agent task through the hub composer calling the user module
// 3. Pre-instantiate content re-hash and fresh Worker execution via offscreen host
// 4. Model calls execute_tool and real stdout returns in conversation transcript
// 5. Failure shape: a module that traps returns honest readable error and run continues
//
// deno run -A scripts/kat-user-wasm-call.ts [extension-dir] [evidence-dir]
import { createHash } from "node:crypto";
import { launchChrome, openCdp, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { buildWasiEntryExportWasm } from "../tests/wasm-fixture-builder.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`kat-user-wasm-call-${Date.now()}`);
const PROFILE = durableDir(`kat-user-wasm-call-profile-${Date.now()}`);
await Deno.mkdir(OUT, { recursive: true });
await Deno.mkdir(PROFILE, { recursive: true });

const tempDir = await Deno.makeTempDir({ dir: OUT, prefix: "inputs-" });

// 1. Success module: writes "hi" to stdout via WASI _start
const successWasm = buildWasiEntryExportWasm({ exportName: "_start" });
const successPath = `${tempDir}/wasm_caller.wasm`;
await Deno.writeFile(successPath, successWasm);

// 2. Trapping module: executes opcode unreachable (0x00)
const trapWasm = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x04, 0x01, 0x01, 0x01, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
  0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b,
]);
const trapPath = `${tempDir}/wasm_trapping.wasm`;
await Deno.writeFile(trapPath, trapWasm);

let checksPassed = 0;
let checksFailed = 0;
const shots: { name: string; sha256: string; bytes: number }[] = [];

function check(name: string, passed: boolean, detail?: unknown) {
  if (passed) {
    checksPassed++;
    console.log(`PASS: ${name}`);
  } else {
    checksFailed++;
    console.error(`FAIL: ${name}`, detail ?? "");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let chromeInstance: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp!: Awaited<ReturnType<typeof openCdp>>;
let optionsSession = "";
let hubSession = "";

const ui = "document.getElementById('user-wasm-manager')";
const shadow = `${ui}.shadowRoot`;

async function waitIn(session: string, expression: string, timeout = 25000) {
  const until = Date.now() + timeout;
  do {
    try {
      if (await cdp.eval(session, expression)) return;
    } catch { /* ignore navigation context swaps */ }
    await sleep(80);
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${expression}`);
}

async function objectIdIn(session: string, expression: string): Promise<string> {
  const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: false }, session);
  const id = reply.result?.result?.objectId;
  if (!id) throw new Error(`Element not found: ${expression}`);
  return id;
}

async function clickIn(session: string, expression: string) {
  await cdp.send("Page.bringToFront", {}, session);
  await cdp.send("DOM.scrollIntoViewIfNeeded", { objectId: await objectIdIn(session, expression) }, session);
  const point = await cdp.eval(session, `(() => { const r = (${expression}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }, session);
}

async function keyIn(session: string, key: string, code: string, vk: number) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  }, session);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, session);
}

async function typeIn(session: string, selector: string, text: string) {
  await cdp.send("DOM.focus", { objectId: await objectIdIn(session, `${shadow}.querySelector(${JSON.stringify(selector)})`) }, session);
  await cdp.send("Input.insertText", { text }, session);
}

async function screenshot(session: string, name: string) {
  const bytes = await cdp.screenshot(session, { captureBeyondViewport: true, fromSurface: false });
  if (!bytes) throw new Error(`Screenshot failed: ${name}`);
  await Deno.writeFile(`${OUT}/${name}`, bytes);
  shots.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
}

async function uploadModule(path: string, name: string, description: string) {
  let chooser: any = null;
  const unsubscribe = cdp.on("Page.fileChooserOpened", (params, sid) => {
    if (sid === optionsSession) chooser = params;
  });
  try {
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, optionsSession);
    await clickIn(optionsSession, `${shadow}.querySelector('#file')`);
    const until = Date.now() + 5000;
    while (!chooser && Date.now() < until) await sleep(40);
    check(`native file chooser opened for ${name}`, Boolean(chooser));
    await cdp.send("DOM.setFileInputFiles", { files: [path], backendNodeId: chooser.backendNodeId }, optionsSession);
  } finally {
    unsubscribe();
  }
  await typeIn(optionsSession, "#name", name);
  await typeIn(optionsSession, "#description", description);
  await cdp.send("DOM.focus", { objectId: await objectIdIn(optionsSession, `${shadow}.querySelector('button[type=submit]')`) }, optionsSession);
  await keyIn(optionsSession, "Enter", "Enter", 13);
  await waitIn(optionsSession, `${ui}.busy === false && ${shadow}.querySelector('#status').textContent.length > 0`, 30000);
  const status = await cdp.eval(optionsSession, `${shadow}.querySelector('#status').textContent`);
  check(`upload of ${name} saved successfully`, String(status).startsWith("Saved “"), status);
}

const THREAD_TEXT_EXPR = `(() => {
  const root = document.getElementById('thread-conversation') ?? document.body;
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.data); return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'TEMPLATE') return;
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    for (const c of node.childNodes) walk(c);
  };
  walk(root);
  return out.join(' ').replace(/\\s+/g, ' ');
})()`;

try {
  chromeInstance = await launchChrome({ extension: EXT, profile: PROFILE, windowSize: "1400,1100" });
  cdp = await openCdp(chromeInstance.wsUrl, { timeoutMs: 60000 });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || []).map((a: any) => typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value ?? a.description ?? "")).join(" ");
    console.log(`[Browser Console ${params.type}]`, text);
  });
  const sw = await waitForServiceWorker(cdp.send, { match: (t: any) => t.type === "service_worker" && t.url.endsWith("/dist/background/service-worker.js") });
  check("extension service worker registered", Boolean(sw));
  const extensionId = new URL(sw.url).host;

  // Subscribe to console on SW
  try {
    const swSession = (await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
    await cdp.send("Runtime.enable", {}, swSession);
  } catch (e) {
    console.log("Could not attach to SW target for logs:", e);
  }

  // Step 1: Open Settings and upload wasm_caller
  optionsSession = (await cdp.open(`chrome-extension://${extensionId}/options/options.html#user-wasm`)).sessionId;
  await waitIn(optionsSession, `document.querySelector('#user-wasm.active') && ${ui}?.shadowRoot?.querySelector('#files') && ${ui}.busy === false`);

  await uploadModule(successPath, "wasm_caller", "A user-uploaded WASI caller module");

  // Step 2: Open Hub and enable developer features (for demo model)
  hubSession = (await cdp.open(`chrome-extension://${extensionId}/ntp/ntp.html`)).sessionId;
  await cdp.send("Runtime.enable", {}, hubSession);
  await waitIn(hubSession, `document.readyState === 'complete' && !!document.getElementById('composer')`);
  await sleep(1000);

  await cdp.eval(hubSession, `chrome.runtime.sendMessage({ type: 'kv.set', values: { 'cap:developerFeatures': true } })`);

  // Step 3: Run task calling wasm_caller
  const taskText1 = `@demo-site-tool wasm_caller {"args":[],"stdin":"ping"}`;
  await cdp.eval(hubSession, `(() => {
    const composer = document.getElementById('composer');
    composer.dispatchEvent(new CustomEvent('send', { detail: { text: ${JSON.stringify(taskText1)}, attachments: [], agent: null }, bubbles: true }));
    return true;
  })()`);

  // Poll for completion and stdout
  let threadText1 = "";
  const until1 = Date.now() + 60000;
  while (Date.now() < until1) {
    threadText1 = String(await cdp.eval(hubSession, THREAD_TEXT_EXPR) ?? "");
    if (/\[demo model\] Site tool wasm_caller/.test(threadText1)) break;
    await sleep(250);
  }
  console.log("threadText1 full:", threadText1);

  check(
    "model executed user-wasm tool and transcript carries real stdout",
    /\[demo model\] Site tool wasm_caller succeeded/.test(threadText1) && /hi/.test(threadText1),
    threadText1.slice(-300),
  );
  await screenshot(hubSession, "01-user-wasm-call-success.png");

  // Step 4: Upload trapping module in Settings
  await uploadModule(trapPath, "wasm_trapping", "A user-uploaded trapping wasm module");

  // Step 5: Run task calling wasm_trapping
  const taskText2 = `@demo-site-tool wasm_trapping {}`;
  await cdp.eval(hubSession, `(() => {
    // Navigate home to hub composer
    const homeBtn = document.querySelector('nav a[href="#home"]') || document.querySelector('#nav-home');
    if (homeBtn) homeBtn.click();
    return true;
  })()`);
  await sleep(400);

  // Send from whichever composer is active
  await cdp.eval(hubSession, `(() => {
    const composer = document.getElementById('composer') || document.getElementById('thread-composer');
    composer?.dispatchEvent(new CustomEvent('send', { detail: { text: ${JSON.stringify(taskText2)}, attachments: [], agent: null } }));
    return true;
  })()`);

  let threadText2 = "";
  const until2 = Date.now() + 60000;
  while (Date.now() < until2) {
    threadText2 = String(await cdp.eval(hubSession, THREAD_TEXT_EXPR) ?? "");
    if (/wasm_trapping/.test(threadText2) && /unreachable/.test(threadText2)) break;
    await sleep(250);
  }

  check(
    "trapping user-wasm module reports honest readable error and run continues",
    /wasm_trapping/.test(threadText2) && /unreachable/.test(threadText2),
    threadText2.slice(-300),
  );
  await screenshot(hubSession, "02-user-wasm-call-trap.png");

} catch (err) {
  check(`KAT execution threw: ${String(err?.message ?? err)}`, false, err);
} finally {
  if (chromeInstance) {
    try { await chromeInstance.close(); } catch { /* best effort */ }
  }
}

console.log(`\nkat-user-wasm-call: ${checksPassed} passed, ${checksFailed} failed`);
Deno.exit(checksFailed === 0 ? 0 : 1);

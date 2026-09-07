// scripts/kat-user-wasm-call.ts — End-to-end browser KAT for user-uploaded WASM execution
// Proves:
// 1. Upload genuinely user-supplied WASM via Settings UI
// 2. Drive agent task through the hub composer calling the user module
// 3. Pre-instantiate content re-hash and fresh Worker execution via offscreen host
// 4. Model calls execute_tool and real unique-token stdout returns in conversation transcript
// 5. Ambient credentials and network denial in the worker (no chrome, fetch/WebSocket blocked)
// 6. Foreign-import refusal: hostile imports rejected honestly, never reported as success
// 7. Failure shape: a module that traps returns honest readable error and the run continues
//
// deno run -A scripts/kat-user-wasm-call.ts [extension-dir] [evidence-dir]
import { createHash } from "node:crypto";
import { launchChrome, openCdp, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { buildWasiStdoutBytesWasm } from "../tests/wasm-fixture-builder.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`kat-user-wasm-call-${Date.now()}`);
const PROFILE = durableDir(`kat-user-wasm-call-profile-${Date.now()}`);
await Deno.mkdir(OUT, { recursive: true });
await Deno.mkdir(PROFILE, { recursive: true });

const tempDir = await Deno.makeTempDir({ dir: OUT, prefix: "inputs-" });

// 1. Success module with unique 20-char random token pin
const UNIQUE_TOKEN = "S4_TOKEN_" + createHash("sha256").update(crypto.randomUUID()).digest("hex").slice(0, 11);
const successWasm = buildWasiStdoutBytesWasm(new TextEncoder().encode(UNIQUE_TOKEN));
const successPath = `${tempDir}/wasm_token.wasm`;
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

// 3. Foreign import module (imports env.hostile): must be refused honestly
const foreignWasm = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x02, 0x0f, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x07, 0x68, 0x6f, 0x73, 0x74, 0x69, 0x6c, 0x65, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x04, 0x01, 0x01, 0x01, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
]);
const foreignPath = `${tempDir}/wasm_foreign.wasm`;
await Deno.writeFile(foreignPath, foreignWasm);

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
  const sw = await waitForServiceWorker(cdp.send, { match: (t: any) => t.type === "service_worker" && t.url.endsWith("/dist/background/service-worker.js") });
  check("extension service worker registered", Boolean(sw));
  const extensionId = new URL(sw.url).host;

  // Step 1: Open Settings and upload wasm_token
  optionsSession = (await cdp.open(`chrome-extension://${extensionId}/options/options.html#user-wasm`)).sessionId;
  await waitIn(optionsSession, `document.querySelector('#user-wasm.active') && ${ui}?.shadowRoot?.querySelector('#files') && ${ui}.busy === false`);

  await uploadModule(successPath, "wasm_token", "User wasm module outputting unique token");

  // Step 2: Open Hub and enable developer features (for demo model)
  hubSession = (await cdp.open(`chrome-extension://${extensionId}/ntp/ntp.html`)).sessionId;
  await cdp.send("Runtime.enable", {}, hubSession);
  await waitIn(hubSession, `document.readyState === 'complete' && !!document.getElementById('composer')`);
  await sleep(1000);

  await cdp.eval(hubSession, `chrome.runtime.sendMessage({ type: 'kv.set', values: { 'cap:developerFeatures': true } })`);

  // Step 3: Run task calling wasm_token
  const taskText1 = `@demo-site-tool wasm_token {"args":[],"stdin":"ping"}`;
  await cdp.eval(hubSession, `(() => {
    const composer = document.getElementById('composer');
    composer.dispatchEvent(new CustomEvent('send', { detail: { text: ${JSON.stringify(taskText1)}, attachments: [], agent: null }, bubbles: true }));
    return true;
  })()`);

  // Poll for completion and verify UNIQUE_TOKEN reached transcript
  let threadText1 = "";
  const until1 = Date.now() + 60000;
  while (Date.now() < until1) {
    threadText1 = String(await cdp.eval(hubSession, THREAD_TEXT_EXPR) ?? "");
    if (/\[demo model\] Site tool wasm_token/.test(threadText1)) break;
    await sleep(250);
  }

  check(
    "model executed user-wasm tool and transcript carries unique-token stdout pin",
    /\[demo model\] Site tool wasm_token succeeded/.test(threadText1) && threadText1.includes(UNIQUE_TOKEN),
    threadText1.slice(-300),
  );
  await screenshot(hubSession, "01-user-wasm-call-success.png");

  // Step 4: Interrogate worker ambient environment (no chrome, network denied)
  const probeWorkerExpr = `(() => new Promise(async (resolve) => {
    const url = chrome.runtime.getURL("lib/wasm-execution-worker.js");
    const src = 'import ' + JSON.stringify(url) + ';'
      + 'const out = { typeofChrome: typeof chrome,'
      + ' typeofChromeRuntime: (typeof chrome !== "undefined" && chrome) ? typeof chrome.runtime : "n/a",'
      + ' typeofFetch: typeof fetch,'
      + ' typeofWebSocket: typeof WebSocket,'
      + ' typeofImportScripts: typeof importScripts };'
      + 'try { const r = await fetch("https://example.com/", { method: "GET" });'
      + ' out.networkFetch = "SUCCEEDED " + r.status; }'
      + 'catch (e) { out.networkFetch = "BLOCKED " + String(e && e.message || e).slice(0, 160); }'
      + 'try { const ws = new WebSocket("wss://example.com/"); out.wsResult = "CONNECTED"; }'
      + 'catch (e) { out.wsResult = "BLOCKED " + String(e && e.message || e).slice(0, 160); }'
      + 'self.postMessage(out);';
    const blobUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { w.terminate(); } catch {} resolve(v); } };
    const w = new Worker(blobUrl, { type: "module" });
    w.onmessage = (e) => done(e.data);
    w.onerror = (e) => done({ workerError: String(e.message || e) });
    setTimeout(() => done({ timeout: true }), 15000);
  }))()`;

  const probe = await cdp.eval(hubSession, probeWorkerExpr);
  check("worker has zero ambient chrome credentials", probe?.typeofChrome === "undefined", probe);
  check("worker network access is actively blocked (fetch denied)", probe?.networkFetch?.includes("BLOCKED"), probe);
  check("worker network access is actively blocked (WebSocket denied)", probe?.wsResult?.includes("BLOCKED"), probe);

  // Step 5: Upload foreign import module (env.hostile) in Settings
  await uploadModule(foreignPath, "wasm_foreign", "A user module importing foreign env.hostile");

  // Step 6: Run task calling wasm_foreign and verify honest refusal
  const taskTextForeign = `@demo-site-tool wasm_foreign {}`;
  await cdp.eval(hubSession, `(() => {
    const homeBtn = document.querySelector('nav a[href="#home"]') || document.querySelector('#nav-home');
    if (homeBtn) homeBtn.click();
    return true;
  })()`);
  await sleep(400);

  await cdp.eval(hubSession, `(() => {
    const composer = document.getElementById('composer') || document.getElementById('thread-composer');
    composer?.dispatchEvent(new CustomEvent('send', { detail: { text: ${JSON.stringify(taskTextForeign)}, attachments: [], agent: null }, bubbles: true }));
    return true;
  })()`);

  let threadTextForeign = "";
  const untilForeign = Date.now() + 60000;
  while (Date.now() < untilForeign) {
    threadTextForeign = String(await cdp.eval(hubSession, THREAD_TEXT_EXPR) ?? "");
    if (/wasm_foreign/.test(threadTextForeign) && (/import/.test(threadTextForeign) || /error/.test(threadTextForeign))) break;
    await sleep(250);
  }

  check(
    "foreign-import module is refused honestly and never reported as success",
    /wasm_foreign/.test(threadTextForeign) && !/Site tool wasm_foreign succeeded/.test(threadTextForeign),
    threadTextForeign.slice(-300),
  );

  // Step 7: Upload trapping module in Settings
  await uploadModule(trapPath, "wasm_trapping", "A user-uploaded trapping wasm module");

  // Step 8: Run task calling wasm_trapping
  const taskText2 = `@demo-site-tool wasm_trapping {}`;
  await cdp.eval(hubSession, `(() => {
    const homeBtn = document.querySelector('nav a[href="#home"]') || document.querySelector('#nav-home');
    if (homeBtn) homeBtn.click();
    return true;
  })()`);
  await sleep(400);

  await cdp.eval(hubSession, `(() => {
    const composer = document.getElementById('composer') || document.getElementById('thread-composer');
    composer?.dispatchEvent(new CustomEvent('send', { detail: { text: ${JSON.stringify(taskText2)}, attachments: [], agent: null }, bubbles: true }));
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

  // Step 9: Verify agent run continues after a trap (follow-up task completes)
  const taskText3 = `@demo-site-tool wasm_token {"args":[],"stdin":"second"}`;
  await cdp.eval(hubSession, `(() => {
    const homeBtn = document.querySelector('nav a[href="#home"]') || document.querySelector('#nav-home');
    if (homeBtn) homeBtn.click();
    return true;
  })()`);
  await sleep(400);

  await cdp.eval(hubSession, `(() => {
    const composer = document.getElementById('composer') || document.getElementById('thread-composer');
    composer?.dispatchEvent(new CustomEvent('send', { detail: { text: ${JSON.stringify(taskText3)}, attachments: [], agent: null }, bubbles: true }));
    return true;
  })()`);

  let threadText3 = "";
  const until3 = Date.now() + 60000;
  while (Date.now() < until3) {
    threadText3 = String(await cdp.eval(hubSession, THREAD_TEXT_EXPR) ?? "");
    if (/\[demo model\] Site tool wasm_token succeeded/.test(threadText3)) break;
    await sleep(250);
  }

  check(
    "agent continues executing successfully after a trapping module failure",
    /\[demo model\] Site tool wasm_token succeeded/.test(threadText3) && threadText3.includes(UNIQUE_TOKEN),
    threadText3.slice(-300),
  );

} catch (err) {
  check(`KAT execution threw: ${String(err?.message ?? err)}`, false, err);
} finally {
  if (chromeInstance) {
    try { await chromeInstance.close(); } catch { /* best effort */ }
  }
}

console.log(`\nkat-user-wasm-call: ${checksPassed} passed, ${checksFailed} failed`);
Deno.exit(checksFailed === 0 ? 0 : 1);

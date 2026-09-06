// Real Settings upload → OPFS → reload → duplicate/update → remove KAT.
// Native file chooser interception + CDP keyboard/mouse input; no mocked store,
// no pregranted permissions, no giant runtime JSON payload, no Wasm execution.
// deno run -A scripts/kat-user-wasm-store.ts [extension-dir] [evidence-dir]
import { createHash } from "node:crypto";
import { launchChrome, openCdp, waitForServiceWorker, withTimeout } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`kat-user-wasm-${Date.now()}`);
const PROFILE = durableDir(`kat-user-wasm-profile-${Date.now()}`);
await Deno.mkdir(OUT, { recursive: true });
await Deno.mkdir(PROFILE, { recursive: true });
const inputs = await Deno.makeTempDir({ dir: OUT, prefix: "inputs-" });
const small = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const smallDigest = createHash("sha256").update(small).digest("hex");
await Deno.writeFile(`${inputs}/owner.wasm`, small);
const bigPath = `${inputs}/large.wasm`;
const bigHash = createHash("sha256");
const bigFile = await Deno.open(bigPath, { create: true, write: true, truncate: true });
const block = new Uint8Array(1024 * 1024).fill(0xa7);
async function writeAll(file: Deno.FsFile, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}
try {
  for (let i = 0; i < 65; i++) { await writeAll(bigFile, block); bigHash.update(block); }
  const tail = new Uint8Array([1, 2, 3]);
  await writeAll(bigFile, tail);
  bigHash.update(tail);
} finally { bigFile.close(); }
const bigDigest = bigHash.digest("hex");
const bigSize = 65 * 1024 * 1024 + 3;
const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
const shots: { name: string; sha256: string; bytes: number }[] = [];
const sourcePins: Record<string, string> = {};
for (const path of [
  "extension/lib/user-wasm-store.js", "extension/lib/pure.js",
  "extension/lib/user-wasm-store-client.js", "extension/lib/user-wasm-store-worker.js",
  "extension/options/user-wasm-panel.js", "extension/options/options.html",
  "extension/shared/components.js", "extension/dist/options.bundle.js",
]) sourcePins[path] = createHash("sha256").update(await Deno.readFile(`${ROOT}${path}`)).digest("hex");
const head = new TextDecoder().decode((await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: ROOT, stdout: "piped" }).output()).stdout).trim();
const dirty = new TextDecoder().decode((await new Deno.Command("git", { args: ["status", "--porcelain"], cwd: ROOT, stdout: "piped" }).output()).stdout).trim().length > 0;
function check(name: string, passed: boolean, detail?: unknown) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}`);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp!: Awaited<ReturnType<typeof openCdp>>;
let options = "";
let error: string | null = null;
let browserVersion: unknown;
const ui = "document.getElementById('user-wasm-manager')";
const shadow = `${ui}.shadowRoot`;
async function wait(expression: string, timeout = 20000) {
  const until = Date.now() + timeout;
  do {
    try { if (await cdp.eval(options, expression)) return; } catch { /* navigation may replace the context */ }
    await sleep(80);
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${expression}`);
}
async function objectId(expression: string): Promise<string> {
  const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: false }, options);
  const id = reply.result?.result?.objectId;
  if (!id) throw new Error(`Element not found: ${expression}`);
  return id;
}
async function click(expression: string) {
  await cdp.send("Page.bringToFront", {}, options);
  await cdp.send("DOM.scrollIntoViewIfNeeded", { objectId: await objectId(expression) }, options);
  const point = await cdp.eval(options, `(() => { const r = (${expression}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }, options);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }, options);
}
async function key(key: string, code: string, vk: number) {
  // Native button/form activation needs the character event, not only raw
  // keydown (which exercises custom key handlers but emits no keypress).
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  }, options);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, options);
}
async function type(selector: string, text: string) {
  await cdp.send("DOM.focus", { objectId: await objectId(`${shadow}.querySelector(${JSON.stringify(selector)})`) }, options);
  await cdp.send("Input.insertText", { text }, options);
}
async function screenshot(name: string) {
  const bytes = await cdp.screenshot(options, { captureBeyondViewport: true, fromSurface: false });
  if (!bytes) throw new Error(`Screenshot failed: ${name}`);
  await Deno.writeFile(`${OUT}/${name}`, bytes);
  shots.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
}
async function rows() {
  return await cdp.eval(options, `[...${shadow}.querySelectorAll('#files li')].map(row => ({ digest:row.dataset.digest, name:row.querySelector('.name').textContent, description:row.querySelector('.description').textContent, meta:row.querySelector('.meta').textContent }))`);
}
async function upload(path: string, name: string, description: string, captureProgress = false) {
  let chooser: any = null;
  const unsubscribe = cdp.on("Page.fileChooserOpened", (params, sid) => { if (sid === options) chooser = params; });
  try {
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, options);
    await click(`${shadow}.querySelector('#file')`);
    const until = Date.now() + 5000;
    while (!chooser && Date.now() < until) await sleep(40);
    check("native file chooser opened", Boolean(chooser));
    await cdp.send("DOM.setFileInputFiles", { files: [path], backendNodeId: chooser.backendNodeId }, options);
  } finally { unsubscribe(); }
  await type("#name", name);
  await type("#description", description);
  await cdp.send("DOM.focus", { objectId: await objectId(`${shadow}.querySelector('button[type=submit]')`) }, options);
  check("chosen file and typed metadata satisfy the real form", await cdp.eval(options, `${shadow}.querySelector('form').checkValidity()`));
  // Harness-only observation; never installed in shipped source. Retain the
  // trusted keypress + submit evidence rather than inferring it from focus.
  await cdp.eval(options, `(() => {
    globalThis.__userWasmInputLog = [];
    const record = event => globalThis.__userWasmInputLog.push({ type:event.type, key:event.key, trusted:event.isTrusted });
    ${shadow}.addEventListener('keypress', record, {once:true, capture:true});
    ${shadow}.addEventListener('submit', record, {once:true, capture:true});
  })()`);
  await key("Enter", "Enter", 13); // real keyboard activation, not .click().
  const inputLog = await cdp.eval(options, "globalThis.__userWasmInputLog");
  check("trusted keyboard activation submits the native form", inputLog.some((e: any) => e.type === "keypress" && e.key === "Enter" && e.trusted) && inputLog.some((e: any) => e.type === "submit" && e.trusted), inputLog);
  if (captureProgress) {
    await wait(`${ui}.busy === true`);
    await screenshot("03-large-upload-in-progress.png");
  }
  await wait(`${ui}.busy === false && ${shadow}.querySelector('#status').textContent.length > 0`, 60000);
  const status = await cdp.eval(options, `${shadow}.querySelector('#status').textContent`);
  check("upload reports committed save, not merely a rendered panel", status.startsWith("Saved “"), status);
}
async function reload() {
  await cdp.send("Page.reload", {}, options);
  await wait(`document.querySelector('#user-wasm.active') && ${ui}?.shadowRoot?.querySelector('#files') && ${ui}.busy === false`);
}
async function inspectBytes(digest: string) {
  return await cdp.eval(options, `(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('cap-owner-blobs-v1');
    const file = await (await directory.getFileHandle('${digest}.bin')).getFile();
    const metadata = JSON.parse(await (await (await directory.getFileHandle('${digest}.json')).getFile()).text());
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return { size:file.size, metadata, kind:metadata.kind, digest:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('') };
  })()`);
}
try {
  chrome = await launchChrome({ extension: EXT, profile: PROFILE, windowSize: "1400,1100" });
  cdp = await openCdp(chrome.wsUrl, { timeoutMs: 60000 });
  browserVersion = (await cdp.send("Browser.getVersion")).result;
  const sw = await waitForServiceWorker(cdp.send, { match: (t: any) => t.type === "service_worker" && t.url.endsWith("/dist/background/service-worker.js") });
  check("this fresh-profile extension registered its service worker", Boolean(sw));
  const extensionId = new URL(sw.url).host;
  options = (await cdp.open(`chrome-extension://${extensionId}/options/options.html#user-wasm`)).sessionId;
  await wait(`document.querySelector('#user-wasm.active') && ${ui}?.shadowRoot?.querySelector('#files') && ${ui}.busy === false`);
  check("fresh Settings list is empty", (await rows()).length === 0);
  await screenshot("01-empty.png");
  const firstName = `Owner file ${Date.now()}`;
  const firstDescription = "A real owner-selected Wasm file, saved without running it.";
  await upload(`${inputs}/owner.wasm`, firstName, firstDescription);
  let list = await rows();
  check("typed name, description and content digest appear in the actual list", list.length === 1 && list[0].name === firstName && list[0].description === firstDescription && list[0].digest === smallDigest, list);
  let stored = await inspectBytes(smallDigest);
  check("real OPFS bytes match the independently computed digest, stored as kind wasm", stored.digest === smallDigest && stored.size === small.length && stored.kind === "wasm", stored);
  await screenshot("02-small-saved.png");
  await reload();
  list = await rows();
  check("name and description survive a real Settings reload", list.length === 1 && list[0].name === firstName && list[0].description === firstDescription, list);

  const renamed = "Same name, distinct files";
  const inertDescription = '<img src=x onerror="document.documentElement.dataset.injected=1"> is owner text, not HTML.';
  await upload(`${inputs}/owner.wasm`, renamed, inertDescription);
  list = await rows();
  check("re-uploading identical bytes updates metadata without adding an entry", list.length === 1 && list[0].name === renamed && list[0].description === inertDescription, list);
  check("owner markup is inert text", await cdp.eval(options, `!${shadow}.querySelector('#files img') && !document.documentElement.dataset.injected`));
  await upload(bigPath, renamed, "Large opaque owner bytes; not valid WebAssembly. Stored without an admission gate.", true);
  list = await rows();
  check("different bytes with the same name remain separately listed", list.length === 2 && list.every((row: any) => row.name === renamed) && new Set(list.map((row: any) => row.digest)).size === 2, list);
  stored = await inspectBytes(bigDigest);
  check("65 MiB + 3 bytes survive exactly, beyond the runtime message boundary", stored.size === bigSize && stored.digest === bigDigest && stored.metadata.size === bigSize, stored);
  await screenshot("04-both-saved.png");
  await reload();
  check("both entries persist after reload", (await rows()).length === 2);

  const ntp = await cdp.open(`chrome-extension://${extensionId}/ntp/ntp.html`);
  const rejected = await cdp.eval(ntp.sessionId, `(async () => {
    const client = await import(chrome.runtime.getURL('lib/user-wasm-store-client.js'));
    try { await client.runOwnerBlobStore('remove', {digest:'${smallDigest}'}); return false; }
    catch (error) { return error.message.includes('only be managed in Settings'); }
  })()`);
  check("non-Settings extension page cannot use the owner storage client", rejected);
  await cdp.send("Target.closeTarget", { targetId: ntp.targetId });
  check("denied caller did not remove stored bytes", (await inspectBytes(smallDigest)).digest === smallDigest);

  for (const digest of [smallDigest, bigDigest]) {
    await click(`${shadow}.querySelector('[data-remove="${digest}"]')`);
    await wait(`document.querySelector('dialog.cap-confirm-dialog[open]')`);
    await click("document.querySelector('dialog.cap-confirm-dialog .cap-confirm-accept')");
    await wait(`${ui}.busy === false && !${shadow}.querySelector('[data-remove="${digest}"]')`);
  }
  check("Remove controls delete every list row", (await rows()).length === 0);
  await reload();
  check("removed files stay gone after reload", (await rows()).length === 0);
  const remaining = await cdp.eval(options, `(async () => { const root=await navigator.storage.getDirectory(); const dir=await root.getDirectoryHandle('cap-owner-blobs-v1'); const names=[]; for await(const name of dir.keys()) names.push(name); return names; })()`);
  check("removal leaves neither bytes nor metadata nor staging files", remaining.length === 0, remaining);
  await screenshot("05-removed-after-reload.png");
} catch (e) {
  error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(error);
  if (options) await screenshot("failure.png").catch(() => {});
} finally {
  await Deno.writeTextFile(`${OUT}/result.json`, JSON.stringify({
    state: error ? "OPEN" : "GREEN", error, head, dirty, sourcePins, browserVersion,
    input: { smallDigest, smallBytes: small.length, bigDigest, bigBytes: bigSize },
    checks, screenshots: shots, lockWaitMs: chrome?.lockWaitMs ?? null,
    note: "Functional upload/storage/UI only. No executor, tool registration, or runtime compatibility claim.",
  }, null, 2) + "\n");
  if (cdp) await cdp.send("Browser.close").catch(() => {});
  if (chrome) await withTimeout(chrome.proc.status, 8000).catch(() => { try { chrome?.proc.kill("SIGKILL"); } catch { /* already exited */ } });
  cdp?.close();
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
  await Deno.remove(inputs, { recursive: true }).catch(() => {});
}
console.log(`RESULT: ${checks.filter((c) => c.passed).length} passed; ${error ? "OPEN" : "GREEN"}; evidence ${OUT}`);
Deno.exit(error ? 1 : 0);

// x9r8k.2: one real Chromium SW -> offscreen -> module Worker -> OPFS -> SW.
// Fixture-only instrumentation seeds a LIVE synthetic run and committed registry
// in a COPY of the built SW bundle. No production source, default branch,
// credential, model tool, Settings guard or browser profile is modified.
// The product staging function, host/Worker protocol and OPFS run unchanged.
import { cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openCdp } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const source = fileURLToPath(new URL("../extension/", import.meta.url));
const scratch = durableDir("emscripten-staging-browser", crypto.randomUUID());
const ext = join(scratch, "extension");
const profile = join(scratch, "profile");
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
let ws: Awaited<ReturnType<typeof openCdp>> | undefined;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`staging browser: ${message}`);
}
async function sha256(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function asset(path: string, bytes: Uint8Array) {
  const target = join(ext, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { path: `extension/${path}`, sha256: await sha256(bytes), size: bytes.length };
}
try {
  // Follow the dist symlink INTO this temporary copy; NEVER rewrite a shared
  // build artifact in the worktree when installing the fixture hooks below.
  await cp(source, ext, { recursive: true, dereference: true });
  await writeFile(join(ext, "probe.html"), "<!doctype html><title>Sender probe</title>");
  const enc = new TextEncoder();
  const pkg = "cap.stage.browser";
  const ver = "1.0.0";
  const base = `wasm/runtime/${pkg}/${ver}`;
  const glue = await asset(`${base}/stage-glue.mjs`, enc.encode(
    "export default async () => ({ hash: () => 0 });\n"));
  const adapter = await asset(`${base}/stage-adapter.mjs`, enc.encode(
    "export function createBlake3Adapter() { return { hash: () => new Uint8Array(65539).fill(23) }; }\n"));
  const wasmBytes = new Uint8Array([1]);
  const mainWasm = await asset(`wasm/cas/${await sha256(wasmBytes)}.wasm`, wasmBytes);
  const manifest = {
    package: { id: pkg, version: ver },
    assets: [{ role: "glue", ...glue }, { role: "adapter", ...adapter },
      { role: "main-wasm", ...mainWasm }],
    entry: { adapterId: "cap-blake3-wasm-v1", operations: [{
      id: "hash", kind: "native-buffer-v1", exportName: "hash", result: "buffer", params: [],
    }] },
    resources: { lifecycle: { startupMs: 3000, callMs: 3000, concurrentJobs: 1 } },
  };

  const bundle = join(ext, "dist/background/service-worker.js");
  assert((await Deno.realPath(bundle)).startsWith(scratch + "/"),
    "dist must be a temporary COPY, never a symlink into the shared checkout");
  let text = await readFile(bundle, "utf8");
  const symbol = 'Symbol.for("cap.emscripten.stage-only")';
  const at = text.indexOf(symbol);
  assert(at >= 0 && text.indexOf(symbol, at + symbol.length) < 0, "unique SW stage binding required");
  const readStart = text.indexOf("readPackages:async()=>", at);
  const readEnd = text.indexOf(",ensureHost:", readStart);
  assert(readStart > at && readEnd > readStart && readEnd - readStart < 120,
    "fixture can replace only the stage binding's registry reader");
  const binding = text.slice(at, at + 700);
  const match = binding.match(/active:([A-Za-z_$][\w$]*),cancelled:[A-Za-z_$][\w$]*,ended:[A-Za-z_$][\w$]*,workerRun:([A-Za-z_$][\w$]*)\.get\(/u);
  assert(match, "fixture must bind actual SW active-run and run-control variables");
  text = text.slice(0, readStart) +
    'readPackages:async()=>globalThis[Symbol.for("cap.emscripten.fixture-packages")]()' +
    text.slice(readEnd);
  const closing = text.slice(at, at + 800).match(/configurable:![01]\}\);/u);
  assert(closing?.index !== undefined, "fixture may only follow the private staging capability");
  const insertion = at + closing.index + closing[0].length;
  const register = `globalThis[Symbol.for("cap.emscripten.fixture-run")]=(id)=>{${match[1]}.add(id);return ${match[2]}.register({executionId:id,threadId:null,surface:null,kind:"task"})};`;
  text = text.slice(0, insertion) + register + text.slice(insertion);
  await writeFile(bundle, text);

  browser = await launchChrome({ extension: ext, profile, timeoutMs: 30000 });
  ws = await openCdp(browser.wsUrl);
  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
    (await ws!.send(method, params, sessionId)).result;
  const evaluate = async (sessionId: string, expression: string) => {
    const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (value?.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result?.value;
  };
  let sw: any = null;
  for (let attempt = 0; attempt < 60 && !sw; attempt++) {
    const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    sw = targets.find((t: any) => t.type === "service_worker" &&
      String(t.url).endsWith("/dist/background/service-worker.js"));
    if (!sw) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(sw, "extension SW did not load");
  const extId = String(sw.url).split("/")[2];
  const swSession = (await send("Target.attachToTarget", { targetId: sw.id, flatten: true })).sessionId;
  await send("Runtime.enable", {}, swSession);
  const graphDigest = "a".repeat(64);
  const outcome = await evaluate(swSession, `(async () => {
    const runId = 'exec_browser_stage_123456';
    const owner = 'agent:' + runId + ':|hub';
    const root = await navigator.storage.getDirectory();
    const streams = await root.getDirectoryHandle('wasm-tool-streams-v1', { create:true });
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    const dir = await streams.getDirectoryHandle(id, { create:true });
    const input = await dir.getFileHandle('stdin.bin', {create:true});
    const empty = await input.createWritable(); await empty.close();
    const meta = await dir.getFileHandle('authority.json', {create:true});
    const writer = await meta.createWritable();
    await writer.write(JSON.stringify({version:1,id,type:'input',owner,sealed:true,bytes:0,createdAt:Date.now()}));
    await writer.close();
    const inputRef = {version:1,id,kind:'input'};
    const manifest = ${JSON.stringify(manifest)};
    globalThis[Symbol.for('cap.emscripten.fixture-packages')] = () => ({ok:true,packages:new Map([[
      manifest.package.id,{version:manifest.package.version,graphDigest:${JSON.stringify(graphDigest)},manifest} ]])});
    const registered = globalThis[Symbol.for('cap.emscripten.fixture-run')](runId);
    const stage = globalThis[Symbol.for('cap.emscripten.stage-only')];
    const raw = {type:'cap:emscripten-sw-stage-only',runId,agentId:null,inputRef,
      packageId:manifest.package.id,version:manifest.package.version,
      graphDigest:${JSON.stringify(graphDigest)},operationId:'hash',args:[]};
    const result = await stage(raw);
    const intents = await root.getDirectoryHandle('emscripten-sw-intent-v1');
    const names = []; for await (const [name] of intents.entries()) names.push(name);
    if (names.length !== 1) return {result,intents:names.length,registered};
    const intentDir = await intents.getDirectoryHandle(names[0]);
    const intent = JSON.parse(await (await (await intentDir.getFileHandle('intent.json')).getFile()).text());
    const retained = JSON.parse(await (await (await intentDir.getFileHandle('retained.json')).getFile()).text());
    const ledgerRoot = await root.getDirectoryHandle('emscripten-host-evidence-v1');
    const ledgerDir = await ledgerRoot.getDirectoryHandle(intent.identity.outputRef.id + '-' + intent.identity.generation);
    const ledger = JSON.parse(await (await (await ledgerDir.getFileHandle('closed.json')).getFile()).text());
    const output = await streams.getDirectoryHandle(intent.identity.outputRef.id);
    const stdout = await (await output.getFileHandle('stdout.bin')).getFile();
    const authority = JSON.parse(await (await (await output.getFileHandle('authority.json')).getFile()).text());
    const cancelled = await stage({...raw,runId:'exec_browser_cancel_123456'});
    return { result, registered:!!registered, retained:retained.state, reason:retained.reason,
      bytes:stdout.size, sealed:authority.sealed, ledgerState:ledger.state,
      ledgerBytes:ledger.proof?.bytes, cancelled, inputId:id, outputId:intent.identity.outputRef.id };
  })()`);
  assert(outcome?.registered === true, `synthetic run did not bind SW state: ${JSON.stringify(outcome)}`);
  assert(outcome?.result?.ok === false && outcome.result.error === "emscripten_worker_termination_unproved",
    `staging must remain termination UNKNOWN: ${JSON.stringify(outcome)}`);
  assert(outcome?.bytes === 65539 && outcome?.ledgerBytes === 65539 && outcome.ledgerState === "closed",
    `host did not persist independently read bytes: ${JSON.stringify(outcome)}`);
  assert(outcome?.sealed === false && outcome?.retained === "retained-not-deleted" &&
    outcome?.reason === "termination_unproved" && outcome?.inputId !== outcome?.outputId,
    "output must remain unsealed and retained");
  assert(outcome?.cancelled?.error === "emscripten_run_not_live", "unregistered run must refuse");

  const page = await send("Target.createTarget", { url: `chrome-extension://${extId}/probe.html` });
  const pageSession = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, pageSession);
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    ready = await evaluate(pageSession, `location.href === 'chrome-extension://${extId}/probe.html'`);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, "foreign sender page did not commit");
  const foreign = await evaluate(pageSession, `(async () => {
    const host = await chrome.runtime.sendMessage({ type:'cap:emscripten-host-stage-only' });
    const sw = await chrome.runtime.sendMessage({ type:'cap:emscripten-sw-stage-only' })
      .then(value=>({value}),error=>({error:error.message}));
    return {host,sw};
  })()`);
  // Both the generic SW router and the offscreen listener see a broadcast.
  // Chrome may surface either negative response first for HOST; neither is
  // permission. The SW stage type is never registered as a message handler.
  const hostError = foreign?.host?.error;
  assert(foreign?.host?.ok === false &&
    ["emscripten_stage_sender", "unknown message: cap:emscripten-host-stage-only"].includes(hostError) &&
    foreign?.sw?.value?.ok === false &&
    foreign?.sw?.value?.error === "unknown message: cap:emscripten-sw-stage-only",
    `foreign extension context crossed SW-only boundary: ${JSON.stringify(foreign)}`);
  const count = await evaluate(swSession, `(async()=>{
    let n=0;const root=await navigator.storage.getDirectory();
    const intents=await root.getDirectoryHandle('emscripten-sw-intent-v1');
    for await(const _ of intents.entries()) n++;
    return n;
  })()`);
  assert(count === 1, `foreign page created a second SW intent: ${count}`);
  console.log(JSON.stringify({ok:true,browser:"Chromium",fixture:"temporary bundle only: live run+admitted registry",
    result:outcome.result,bytes:outcome.bytes,sealed:outcome.sealed,
    retained:outcome.retained,ledgerState:outcome.ledgerState,
    cancelled:outcome.cancelled.error,foreign}));
} finally {
  ws?.close();
  if (browser) await browser.close?.();
  await Deno.remove(scratch, { recursive:true }).catch(() => {});
}

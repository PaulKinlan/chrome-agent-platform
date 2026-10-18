// x9r8k.2 acceptance: real Chrome SW -> offscreen -> module Worker -> host
// OPFS ledger -> SW rehash. Runs one isolated browser and tears it down.
// Invocation after production build: deno run -A scripts/emscripten-staging-browser.ts
import { cp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const source = new URL("../extension/", import.meta.url).pathname;
const scratch = await Deno.makeTempDir({ prefix: "cap-stage-browser-" });
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
  await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await writeFile(target, bytes);
  return { path: `extension/${path}`, sha256: await sha256(bytes), size: bytes.length };
}
try {
  await cp(source, ext, { recursive: true });
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
    const { createWasmStreamInput, sealWasmStreamInput } = await import(chrome.runtime.getURL('lib/wasm-stream-files.js'));
    const { emscriptenJobOwner } = await import(chrome.runtime.getURL('lib/emscripten-custody.js'));
    const { stageTrustedEmscriptenBinary } = await import(chrome.runtime.getURL('lib/emscripten-sw-stage.js'));
    const { createEmscriptenHostEvidence } = await import(chrome.runtime.getURL('lib/emscripten-host-evidence.js'));
    const runId = 'exec_browser_stage_123456';
    const agentId = 'hub';
    const owner = emscriptenJobOwner({ runId, agentId });
    const inputRef = await createWasmStreamInput({ owner, storage: navigator.storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage: navigator.storage });
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html',
        reasons: ['WORKERS', 'DOM_SCRAPING'], justification: 'SW-only staged binary writer acceptance' });
    }
    const manifest = ${JSON.stringify(manifest)};
    const raw = { type: 'cap:emscripten-sw-stage-only', runId, agentId: null, inputRef,
      packageId: manifest.package.id, version: manifest.package.version,
      graphDigest: ${JSON.stringify(graphDigest)}, operationId: 'hash', args: [] };
    const result = await stageTrustedEmscriptenBinary(raw, {
      storage: navigator.storage, runtime: chrome.runtime,
      isLive: () => true, ensureHost: async () => ({ ok: true }),
      readPackages: async () => ({ ok: true, packages: new Map([[manifest.package.id,
        { version: manifest.package.version, graphDigest: ${JSON.stringify(graphDigest)}, manifest }]]) }),
    });
    const root = await navigator.storage.getDirectory();
    const intents = await root.getDirectoryHandle('emscripten-sw-intent-v1');
    const names = []; for await (const [name] of intents.entries()) names.push(name);
    if (names.length !== 1) return { result, intents: names.length };
    const dir = await intents.getDirectoryHandle(names[0]);
    const intent = JSON.parse(await (await (await dir.getFileHandle('intent.json')).getFile()).text());
    const retained = JSON.parse(await (await (await dir.getFileHandle('retained.json')).getFile()).text());
    const identity = Object.fromEntries(['runId', 'agentId', 'outputRef', 'generation',
      'packageId', 'graphDigest', 'operationId'].map(key => [key, intent.identity[key]]));
    const ledger = await createEmscriptenHostEvidence({storage:navigator.storage}).read(identity);
    const streams = await root.getDirectoryHandle('wasm-tool-streams-v1');
    const output = await streams.getDirectoryHandle(identity.outputRef.id);
    const stdout = await (await output.getFileHandle('stdout.bin')).getFile();
    const authority = JSON.parse(await (await (await output.getFileHandle('authority.json')).getFile()).text());
    const cancelled = await stageTrustedEmscriptenBinary({ ...raw, runId: 'exec_browser_cancel_123456' }, {
      storage:navigator.storage, isLive: () => false,
    });
    return { result, retained:retained.state, reason:retained.reason,
      bytes:stdout.size, sealed:authority.sealed, ledgerState:ledger.state,
      ledgerBytes:ledger.proof?.bytes, cancelled, inputId:inputRef.id, outputId:identity.outputRef.id };
  })()`);
  assert(outcome?.result?.ok === false && outcome.result.error === "emscripten_worker_termination_unproved",
    `positive staging must remain termination UNKNOWN: ${JSON.stringify(outcome)}`);
  assert(outcome?.bytes === 65539 && outcome?.ledgerBytes === 65539 && outcome.ledgerState === "closed",
    `real host did not persist independently read bytes: ${JSON.stringify(outcome)}`);
  assert(outcome?.sealed === false && outcome?.retained === "retained-not-deleted" &&
    outcome?.reason === "termination_unproved" && outcome?.inputId !== outcome?.outputId,
    "staging output must remain unsealed and retained");
  assert(outcome?.cancelled?.error === "emscripten_run_not_live", "cancellation must refuse before allocation");
  // Same-extension page is NOT a SW sender: host denies it, and there is no
  // SW message listener for the private stage type.
  const page = await send("Target.createTarget", { url: `chrome-extension://${extId}/probe.html` });
  const pageSession = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, pageSession);
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    ready = await evaluate(pageSession, `location.href === 'chrome-extension://${extId}/probe.html'`);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, "foreign sender probe page did not commit");
  const foreign = await evaluate(pageSession, `(async () => {
    const host = await chrome.runtime.sendMessage({ type: 'cap:emscripten-host-stage-only' });
    const sw = await chrome.runtime.sendMessage({ type: 'cap:emscripten-sw-stage-only' })
      .then(value => ({ value }), error => ({ error: error.message }));
    return { host, sw };
  })()`);
  assert(foreign?.host?.error === "emscripten_stage_sender" &&
    foreign?.sw?.error?.includes("Receiving end does not exist"),
    `foreign extension page crossed SW-only boundary: ${JSON.stringify(foreign)}`);
  console.log(JSON.stringify({ ok: true, browser: "Chromium", sw: sw.url,
    result: outcome.result, bytes: outcome.bytes, sealed: outcome.sealed,
    retained: outcome.retained, ledgerState: outcome.ledgerState,
    cancelled: outcome.cancelled.error, foreign }));
} finally {
  ws?.close();
  if (browser) await browser.close?.();
  await Deno.remove(scratch, { recursive: true }).catch(() => {});
}

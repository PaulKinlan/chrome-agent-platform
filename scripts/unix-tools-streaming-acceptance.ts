// Loaded-extension acceptance for the nine file-backed Unix tools.
//
// Stages one exact 100 MiB JSONL fixture through the owner-only Settings
// routes, runs every shipped executable through offscreen -> fresh Worker ->
// WASI -> OPFS, and verifies complete byte/SHA-256 receipts. Large stdout is
// sampled by range and removed after verification; tr stdout is also chained
// by reference into wc. A hostile grep program must fail without leaving an
// unsealed output directory. Evidence and the Chrome profile live on durable
// disk.

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION = `${ROOT}extension`;
const INPUT_BYTES = 100 * 1024 * 1024;
const INPUT_SHA256 = "a795474f28638d77ba005fab9a310e390f530092b153115940cfb6f1d99fd4d0";
const TIMESTAMP = new Date().toISOString().replaceAll(":", "-");
const EVIDENCE = durableDir("kat-unix-tools-streaming", TIMESTAMP);
const PROFILE = durableDir("chrome-profiles", `kat-unix-tools-${crypto.randomUUID()}`);

const EXPECTED_CAS = Object.freeze({
  base64: "20d6324f4925ee8263322bb74eb818861f13fbd0d4ce080b13c2140b213232cf",
  grep: "04d32c115c9e3a979d59cfe27ea0e5ece616efd64ff958d4fcc96bb217191588",
  sort: "e0543d170ac9bd0cd55b274604b55add18c17c5d87169ebfdf25b4b7245a386a",
  tr: "bec02b43bdeb1997f9616d95499ce91010e124aecb1cad6e6bd97102c0956f3f",
  uniq: "973d78aa28f825019fbfb4aa9463dc6940a65d7da6de80590ba1a691443154df",
  wc: "ce303be0226d2675019191dddbcded6d83de100922fcc10e5ee48a058c0d27d5",
  sed: "3e553ca399ce02c6d796cf80e08057ae41730f32f507d9bc2561e75faa4c2438",
  awk: "e48cd71ae08b03a62e06cf3e0c21acdf051bd9ecfd7e83812be4307502f1fb23",
  jq: "e884973be3742724a5bdf4637644dfd7f9630d54132835d3849b44da9e4e4234",
});

const EXPECTED = Object.freeze({
  wc: { args: [], bytes: 24, sha256: "b725562ab693b243d9e5da0c053ff2932aebd8c7a71675bcabda1d300b292fd0", stdout: "819200 819200 104857600\n" },
  grep: { args: ["-c", "MATCH"], bytes: 7, sha256: "e74efe4d945539d4f05c3f55a03346ecc0d3cf68a2add9afe639c95c9a694b3f", stdout: "409600\n" },
  awk: { args: ["/MATCH/{c++} END{print c}"], bytes: 7, sha256: "e74efe4d945539d4f05c3f55a03346ecc0d3cf68a2add9afe639c95c9a694b3f", stdout: "409600\n" },
  jq: { args: ["-c", "select(.value == \"MATCH\") | .value"], bytes: 3_276_800, sha256: "18be7c54d4dc5459c5ff042f46cd05fe50b274d9b7114eccf2ef34b3e336092c", stdout: null },
  sed: { args: ["-n", "-e", "/MATCH/p"], bytes: 52_428_800, sha256: "b2d79e53b82f86cff9ac0985a809e44ba0ce90da2545c9800e66d52d2e0c1cb8", stdout: null },
  uniq: { args: [], bytes: 52_428_800, sha256: "831c2fc7680e25e9082ae3535463cd04e91fb7be07b9ff9fe5c5da8944cbd69a", stdout: null },
  tr: { args: ["a-z", "A-Z"], bytes: INPUT_BYTES, sha256: "273bd7ade2a1aefa02e247b6e2dae86b1ecfdabf6bc484123450fde00bd128bc", stdout: null },
  base64: { args: [], bytes: 139_810_137, sha256: "2f38389045fbddaa101ffae9f4a1be596048dc7addcf3a83c8832bb61abdba26", stdout: null },
  sort: { args: [], bytes: INPUT_BYTES, sha256: "ac32f6742ceb213c9a48358f860fade29cf0aed49c185b0cf5c54e319f55b2c8", stdout: null },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function gitHead() {
  const output = await new Deno.Command("git", {
    args: ["-C", ROOT, "rev-parse", "HEAD"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success, "cannot resolve git HEAD");
  return new TextDecoder().decode(output.stdout).trim();
}

async function persist(value: unknown) {
  await Deno.writeTextFile(`${EVIDENCE}/result.json`, `${JSON.stringify(value, null, 2)}\n`);
}

function runExpression(toolId: string, args: string[], inputRef: unknown, removeOutput: boolean) {
  return `(async () => {
    const result = await chrome.runtime.sendMessage(${JSON.stringify({
      type: "tool-stream.run",
      toolId,
      args,
      inputRef,
    })});
    if (!result?.ok) return { result };
    const receipt = await chrome.runtime.sendMessage({ type: "tool-stream.output.receipt", ref: result.output.ref });
    const sampleLength = Math.min(256, result.output.bytes);
    const first = await chrome.runtime.sendMessage({ type: "tool-stream.output.read", ref: result.output.ref, offset: 0, length: sampleLength });
    const last = await chrome.runtime.sendMessage({ type: "tool-stream.output.read", ref: result.output.ref, offset: Math.max(0, result.output.bytes - sampleLength), length: sampleLength });
    let removed = null;
    let postRemove = null;
    if (${JSON.stringify(removeOutput)}) {
      removed = await chrome.runtime.sendMessage({ type: "tool-stream.remove", ref: result.output.ref });
      postRemove = await chrome.runtime.sendMessage({ type: "tool-stream.output.receipt", ref: result.output.ref });
    }
    return { result, receipt, first, last, removed, postRemove };
  })()`;
}

function verifyRun(toolId: string, probe: any, expected: { bytes: number; sha256: string; stdout: string | null }, input = { bytes: INPUT_BYTES, sha256: INPUT_SHA256 }) {
  assert(probe?.result?.ok === true, `${toolId}: execution failed: ${JSON.stringify(probe?.result)}`);
  const result = probe.result;
  assert(result.phase === "completed" && result.exitCode === 0, `${toolId}: non-completed result`);
  assert(result.toolId === toolId, `${toolId}: result identity drift`);
  assert(result.output?.bytes === expected.bytes, `${toolId}: output bytes ${result.output?.bytes} != ${expected.bytes}`);
  assert(result.output?.sha256 === expected.sha256, `${toolId}: output digest ${result.output?.sha256}`);
  assert(result.input?.bytesRead === input.bytes, `${toolId}: incomplete input ${result.input?.bytesRead} != ${input.bytes}`);
  assert(result.input?.sha256 === input.sha256, `${toolId}: input digest ${result.input?.sha256}`);
  assert(result.stdoutComplete === (expected.stdout !== null), `${toolId}: inline completeness drift`);
  assert(result.stdout === expected.stdout, `${toolId}: inline stdout drift`);
  assert(typeof result.workerInstanceId === "string" && result.workerInstanceId.length > 0, `${toolId}: no worker identity`);
  assert(probe.receipt?.ok === true, `${toolId}: sealed receipt is unreadable`);
  assert(probe.receipt.receipt?.stdoutBytes === expected.bytes, `${toolId}: persisted receipt byte drift`);
  assert(probe.receipt.receipt?.stdoutSha256 === expected.sha256, `${toolId}: persisted receipt digest drift`);
  assert(probe.first?.ok === true && probe.first.offset === 0 && probe.first.size === expected.bytes, `${toolId}: first range read failed`);
  assert(probe.last?.ok === true && probe.last.end === expected.bytes && probe.last.eof === true, `${toolId}: last range read failed`);
}

let browser: Deno.ChildProcess | null = null;
let cdp: Awaited<ReturnType<typeof openCdp>> | null = null;
let pageSession: string | null = null;
let inputRef: any = null;
let trOutputRef: any = null;
const state: any = {
  schemaVersion: 1,
  pass: false,
  commit: await gitHead(),
  extensionId: null,
  input: { bytes: INPUT_BYTES, sha256: INPUT_SHA256, ref: null, sealed: null },
  loadedPackages: null,
  runs: {},
  chain: null,
  binaryDecode: null,
  failureCleanup: null,
  workerInstanceIds: [],
  cleanup: { input: null, trOutput: null },
  error: null,
};

try {
  const launched = await launchChrome({ extension: EXTENSION, profile: PROFILE, timeoutMs: 30_000 });
  browser = launched.proc;
  cdp = await openCdp(launched.wsUrl, { timeoutMs: 240_000 });
  const serviceWorker = await cdp.serviceWorker({ timeoutMs: 30_000 });
  assert(serviceWorker, "extension service worker did not register");
  const extensionId = new URL(serviceWorker.url).host;
  state.extensionId = extensionId;
  const page = await cdp.open(`chrome-extension://${extensionId}/options/options.html`);
  pageSession = page.sessionId;

  const before = await cdp.screenshot(pageSession, { format: "png", timeoutMs: 10_000 });
  assert(before, "before screenshot failed");
  await Deno.writeFile(`${EVIDENCE}/before.png`, before);

  state.loadedPackages = await cdp.eval(page.sessionId, `(async () => {
    const { PREVIEW_SPECS } = await import(chrome.runtime.getURL("lib/tool-exec-preview.js"));
    const out = {};
    for (const toolId of ${JSON.stringify(Object.keys(EXPECTED_CAS))}) {
      const spec = PREVIEW_SPECS[toolId];
      const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL("wasm/cas/" + spec.casSha + ".wasm"))).arrayBuffer());
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
      out[toolId] = { specSha256: spec.casSha, fetchedSha256: digest, bytes: bytes.byteLength };
    }
    return out;
  })()`);
  for (const [toolId, sha256] of Object.entries(EXPECTED_CAS)) {
    const loaded = state.loadedPackages?.[toolId];
    assert(loaded?.specSha256 === sha256 && loaded?.fetchedSha256 === sha256 && loaded?.bytes > 0,
      `${toolId}: loaded CAS identity mismatch`);
  }

  const staged = await cdp.eval(page.sessionId, `(async () => {
    const zeta = '{"kind":"zeta","value":"MATCH","padding":"' + 'x'.repeat(83) + '"}\\n';
    const alpha = '{"kind":"alpha","value":"other","padding":"' + 'x'.repeat(82) + '"}\\n';
    const cycle = new TextEncoder().encode(zeta + zeta + alpha + alpha);
    if (cycle.byteLength !== 512) throw new Error("fixture cycle is " + cycle.byteLength + " bytes");
    const chunk = new Uint8Array(4 * 1024 * 1024);
    for (let offset = 0; offset < chunk.byteLength; offset += cycle.byteLength) chunk.set(cycle, offset);
    let binary = '';
    for (let offset = 0; offset < chunk.byteLength; offset += 32768) {
      binary += String.fromCharCode(...chunk.subarray(offset, offset + 32768));
    }
    const base64 = btoa(binary);
    const created = await chrome.runtime.sendMessage({ type: "tool-stream.input.create" });
    if (!created?.ok) throw new Error(JSON.stringify(created));
    for (let offset = 0; offset < ${INPUT_BYTES}; offset += chunk.byteLength) {
      const appended = await chrome.runtime.sendMessage({ type: "tool-stream.input.append", ref: created.ref, base64 });
      if (!appended?.ok || appended.bytes !== offset + chunk.byteLength) throw new Error(JSON.stringify(appended));
    }
    const sealed = await chrome.runtime.sendMessage({ type: "tool-stream.input.seal", ref: created.ref });
    return { ref: created.ref, sealed };
  })()`);
  assert(staged?.sealed?.ok === true && staged.sealed.bytes === INPUT_BYTES, "100 MiB input did not seal exactly");
  inputRef = staged.ref;
  state.input.ref = inputRef;
  state.input.sealed = staged.sealed;
  await persist(state);

  for (const toolId of Object.keys(EXPECTED)) {
    const expected = EXPECTED[toolId as keyof typeof EXPECTED];
    const holdOutput = toolId === "tr";
    const probe = await cdp.eval(page.sessionId, runExpression(toolId, [...expected.args], inputRef, !holdOutput));
    verifyRun(toolId, probe, expected);
    if (holdOutput) trOutputRef = probe.result.output.ref;
    else {
      assert(probe.removed?.ok === true, `${toolId}: output cleanup failed`);
      assert(probe.postRemove?.ok === false, `${toolId}: removed output remained readable`);
    }
    state.runs[toolId] = probe;
    state.workerInstanceIds.push(probe.result.workerInstanceId);
    await persist(state);
    console.log(`PASS ${toolId}: ${expected.bytes} bytes ${expected.sha256}`);
  }

  const chainExpected = EXPECTED.wc;
  const chainProbe = await cdp.eval(page.sessionId, runExpression("wc", [], trOutputRef, true));
  verifyRun("wc", chainProbe, chainExpected, { bytes: INPUT_BYTES, sha256: EXPECTED.tr.sha256 });
  assert(chainProbe.removed?.ok === true && chainProbe.postRemove?.ok === false, "chain output cleanup failed");
  state.chain = { from: "tr", to: "wc", probe: chainProbe };
  state.workerInstanceIds.push(chainProbe.result.workerInstanceId);

  state.binaryDecode = await cdp.eval(page.sessionId, `(async () => {
    let inputRef = null;
    let outputRef = null;
    const probe = { result: null, window: null, inputRemoved: null, outputRemoved: null };
    try {
      const created = await chrome.runtime.sendMessage({ type: "tool-stream.input.create" });
      if (!created?.ok) throw new Error(JSON.stringify(created));
      inputRef = created.ref;
      const appended = await chrome.runtime.sendMessage({
        type: "tool-stream.input.append",
        ref: inputRef,
        base64: btoa("AP+A\\n"),
      });
      if (!appended?.ok) throw new Error(JSON.stringify(appended));
      const sealed = await chrome.runtime.sendMessage({ type: "tool-stream.input.seal", ref: inputRef });
      if (!sealed?.ok) throw new Error(JSON.stringify(sealed));
      probe.result = await chrome.runtime.sendMessage({
        type: "tool-stream.run",
        toolId: "base64",
        args: ["-d"],
        inputRef,
      });
      if (!probe.result?.ok) throw new Error(JSON.stringify(probe.result));
      outputRef = probe.result.output.ref;
      probe.window = await chrome.runtime.sendMessage({
        type: "tool-stream.output.read",
        ref: outputRef,
        offset: 0,
        length: 3,
      });
    } finally {
      if (outputRef) probe.outputRemoved = await chrome.runtime.sendMessage({ type: "tool-stream.remove", ref: outputRef });
      if (inputRef) probe.inputRemoved = await chrome.runtime.sendMessage({ type: "tool-stream.remove", ref: inputRef });
    }
    return probe;
  })()`);
  assert(state.binaryDecode?.result?.ok === true, "base64 binary decode failed");
  assert(state.binaryDecode.result.output?.type === "binary" &&
    state.binaryDecode.result.output?.mediaType === "application/octet-stream" &&
    state.binaryDecode.result.output?.lifetime === "explicit-remove",
  "base64 decode did not return an explicit owner-controlled binary descriptor");
  assert(state.binaryDecode.result.output?.bytes === 3 &&
    state.binaryDecode.result.output?.sha256 === "f742b965f156c10374bc23aea96e3a8aff8facd6fc079defeaa30219ad86f211",
  "base64 binary decode receipt drifted");
  assert(state.binaryDecode.result.stdout === null && state.binaryDecode.result.stdoutComplete === false &&
    state.binaryDecode.window?.base64 === "AP+A",
  "base64 binary decode was text-decoded or lost exact bytes");
  assert(state.binaryDecode.outputRemoved?.ok === true && state.binaryDecode.inputRemoved?.ok === true,
    "base64 binary probe cleanup failed");
  state.workerInstanceIds.push(state.binaryDecode.result.workerInstanceId);
  assert(new Set(state.workerInstanceIds).size === state.workerInstanceIds.length, "a worker instance was reused across jobs");

  state.failureCleanup = await cdp.eval(page.sessionId, `(async () => {
    async function entries() {
      const root = await navigator.storage.getDirectory();
      let streams;
      try { streams = await root.getDirectoryHandle("wasm-tool-streams-v1"); }
      catch (error) { if (error?.name === "NotFoundError") return []; throw error; }
      const names = [];
      for await (const name of streams.keys()) names.push(name);
      return names.sort();
    }
    const before = await entries();
    const result = await chrome.runtime.sendMessage(${JSON.stringify({
      type: "tool-stream.run",
      toolId: "grep",
      args: ["["],
      inputRef,
    })});
    const after = await entries();
    return { before, result, after };
  })()`);
  assert(state.failureCleanup?.result?.ok === false, "hostile grep unexpectedly succeeded");
  assert(state.failureCleanup.result.phase === "failed" && state.failureCleanup.result.exitCode === 2,
    `hostile grep did not preserve its rejected exit: ${JSON.stringify(state.failureCleanup.result)}`);
  assert(JSON.stringify(state.failureCleanup.before) === JSON.stringify(state.failureCleanup.after),
    "failed execution left an unsealed OPFS directory");

  state.cleanup.trOutput = await cdp.eval(page.sessionId,
    `chrome.runtime.sendMessage(${JSON.stringify({ type: "tool-stream.remove", ref: trOutputRef })})`);
  assert(state.cleanup.trOutput?.ok === true, "retained tr output cleanup failed");
  trOutputRef = null;
  state.cleanup.input = await cdp.eval(page.sessionId,
    `chrome.runtime.sendMessage(${JSON.stringify({ type: "tool-stream.remove", ref: inputRef })})`);
  assert(state.cleanup.input?.ok === true, "input cleanup failed");
  inputRef = null;

  state.pass = true;
  await persist(state);
  await cdp.eval(page.sessionId, `(() => {
    const prior = document.getElementById("unix-stream-acceptance-result");
    if (prior) prior.remove();
    const card = document.createElement("pre");
    card.id = "unix-stream-acceptance-result";
    card.textContent = ${JSON.stringify("PASS — loaded extension, exact 100 MiB OPFS input\n")}
      + ${JSON.stringify(Object.entries(EXPECTED).map(([id, row]) => `${id.padEnd(7)} ${String(row.bytes).padStart(9)} B  ${row.sha256.slice(0, 16)}…`).join("\n"))}
      + ${JSON.stringify("\ntr → wc chained by sealed OPFS reference\nbinary base64 decode: exact 00 ff 80\nfresh workers: 11/11 · rejected-exit cleanup: complete")};
    Object.assign(card.style, {
      position: "fixed", inset: "48px", zIndex: "2147483647", margin: "0",
      padding: "28px", overflow: "auto", border: "3px solid #087f5b",
      borderRadius: "14px", background: "#f1fff8", color: "#12372a",
      font: "600 18px/1.55 ui-monospace, monospace", whiteSpace: "pre-wrap"
    });
    document.body.append(card);
    return true;
  })()`);
  const after = await cdp.screenshot(page.sessionId, { format: "png", timeoutMs: 10_000 });
  assert(after, "after screenshot failed");
  await Deno.writeFile(`${EVIDENCE}/after.png`, after);
  console.log(`PASS: all nine loaded-extension Unix tools processed the complete 100 MiB fixture`);
  console.log(`evidence: ${EVIDENCE}`);
} catch (error) {
  state.error = String((error as Error)?.stack ?? error);
  await persist(state).catch(() => {});
  console.error(`FAIL: ${String((error as Error)?.message ?? error)}`);
  console.error(`evidence: ${EVIDENCE}`);
} finally {
  if (cdp && pageSession && trOutputRef) {
    state.cleanup.trOutput = await cdp.eval(pageSession,
      `chrome.runtime.sendMessage(${JSON.stringify({ type: "tool-stream.remove", ref: trOutputRef })})`).catch(() => null);
  }
  if (cdp && pageSession && inputRef) {
    state.cleanup.input = await cdp.eval(pageSession,
      `chrome.runtime.sendMessage(${JSON.stringify({ type: "tool-stream.remove", ref: inputRef })})`).catch(() => null);
  }
  await persist(state).catch(() => {});
  try { cdp?.close(); } catch { /* gone */ }
  try { browser?.kill("SIGKILL"); } catch { /* gone */ }
  try { if (browser) await browser.status; } catch { /* gone */ }
  try { await Deno.remove(PROFILE, { recursive: true }); } catch { /* preserve failed profile if Chrome still owns it */ }
}

Deno.exit(state.pass ? 0 : 1);

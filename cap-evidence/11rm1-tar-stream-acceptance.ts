// cap-evidence/11rm1-tar-stream-acceptance.ts — real-Chrome acceptance for
// chrome-agent-platform-11rm.1: stream OPFS files through the production
// encodeTarStream module using native Web Streams in an isolated Chromium profile.
//
// Run: deno run -A cap-evidence/11rm1-tar-stream-acceptance.ts
// @ts-nocheck

import { launchChrome } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}/extension`;
const EVIDENCE_DIR = durableDir(`cap-11rm1-evidence-${Date.now()}`);
await Deno.mkdir(EVIDENCE_DIR, { recursive: true });

const profile = durableDir(`cap-11rm1-profile-${Date.now()}`);
console.log("[11rm.1 acceptance] launching Chrome with extension...");
const chrome = await launchChrome({ extension: EXT, profile, clearEnv: true });
const port = chrome.port;

const ws = new WebSocket(chrome.wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let idc = 0;
const pend = new Map();
ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const mid = ++idc;
    const timer = setTimeout(() => { pend.delete(mid); reject(new Error(`cdp timeout: ${method}`)); }, 30000);
    pend.set(mid, (m: any) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

try {
  // Find extension ID by waiting for our service worker
  let sw: any = null;
  for (let i = 0; i < 50 && !sw; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    sw = targets.find((t: any) => t.type === "service_worker" && t.url.includes("service-worker.js"));
    if (!sw) await new Promise((r) => setTimeout(r, 200));
  }
  if (!sw) throw new Error("Could not find loaded extension service worker target");
  const extId = sw.url.split("/")[2];
  console.log(`[11rm.1 acceptance] extension loaded: ${extId}`);

  // Open Options page
  const optionsUrl = `chrome-extension://${extId}/options/options.html`;
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${optionsUrl}`, { method: "PUT" })).json();
  const sid = (await send("Target.attachToTarget", { targetId: t.id, flatten: true })).sessionId;
  await send("Page.enable", {}, sid);
  await send("Runtime.enable", {}, sid);
  await new Promise((r) => setTimeout(r, 2000));

  // Evaluate in Options page context: import /lib/tar-stream.js, write sample to OPFS, stream to TAR in OPFS, verify
  console.log("[11rm.1 acceptance] driving encodeTarStream in browser OPFS...");
  const evalResult = await send("Runtime.evaluate", {
    expression: `(async () => {
      const moduleUrl = chrome.runtime.getURL("lib/tar-stream.js");
      const { encodeTarStream } = await import(moduleUrl);
      const root = await navigator.storage.getDirectory();
      
      // 1. Create test source file in OPFS
      const sourceFileHandle = await root.getFileHandle("sample-opfs-source.txt", { create: true });
      const testData = new TextEncoder().encode("Hello from real Chrome OPFS stream! 🔥");
      const srcWritable = await sourceFileHandle.createWritable();
      await srcWritable.write(testData);
      await srcWritable.close();
      
      // 2. Create destination TAR file in OPFS
      const tarFileHandle = await root.getFileHandle("backup.tar", { create: true });
      const tarWritable = await tarFileHandle.createWritable();
      
      // 3. Read source from OPFS and stream through encodeTarStream
      const srcFile = await sourceFileHandle.getFile();
      const entries = [
        {
          name: "opfs/sample-opfs-source.txt",
          size: srcFile.size,
          body: srcFile.stream(),
        }
      ];
      
      const stats = await encodeTarStream(entries, tarWritable);
      
      // 4. Read back the TAR from OPFS and verify ustar header
      const tarFile = await tarFileHandle.getFile();
      const tarBuffer = new Uint8Array(await tarFile.arrayBuffer());
      const headerMagic = new TextDecoder().decode(tarBuffer.subarray(257, 263));
      const headerName = new TextDecoder().decode(tarBuffer.subarray(0, 100)).replace(/\\0.*$/, "");
      
      return {
        ok: true,
        stats: {
          files: stats.files,
          totalBytes: stats.totalBytes.toString(),
          archiveBytes: stats.archiveBytes.toString(),
        },
        tarFileSizeBytes: tarFile.size,
        headerMagic,
        headerName,
        sourceBytesLength: testData.length,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sid);

  if (evalResult.exceptionDetails) {
    throw new Error(`Browser execution error: ${evalResult.exceptionDetails.exception?.description || evalResult.exceptionDetails.text}`);
  }

  const res = evalResult.result.value;
  console.log("[11rm.1 acceptance] browser result:", JSON.stringify(res, null, 2));

  // Assertions
  if (res.headerMagic !== "ustar\0") throw new Error(`Invalid header magic: expected "ustar\\0", got ${JSON.stringify(res.headerMagic)}`);
  if (res.headerName !== "opfs/sample-opfs-source.txt") throw new Error(`Header name mismatch: got ${res.headerName}`);
  if (res.stats.files !== 1) throw new Error(`Expected 1 file, got ${res.stats.files}`);
  if (Number(res.stats.totalBytes) !== res.sourceBytesLength) throw new Error("Total bytes mismatch");

  // Save screenshot
  const ss = await send("Page.captureScreenshot", { format: "png" }, sid);
  await Deno.writeFile(`${EVIDENCE_DIR}/options-tar-stream.png`, Uint8Array.from(atob(ss.data), (c) => c.charCodeAt(0)));
  await Deno.writeTextFile(`${EVIDENCE_DIR}/acceptance-result.json`, JSON.stringify(res, null, 2));

  console.log(`[11rm.1 acceptance] PASS — browser evidence saved to ${EVIDENCE_DIR}`);
} finally {
  try { ws.close(); } catch {}
  try { chrome.proc.kill("SIGKILL"); } catch {}
  try { await Deno.remove(profile, { recursive: true }); } catch {}
}

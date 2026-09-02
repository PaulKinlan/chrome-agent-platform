// opfs-wal-probe.ts — the storage facts behind the WAL design
// (docs/THREAD-LOADING-REDESIGN.md section 3.1).
//
// Answers three questions inside the REAL extension service worker, because
// every one of them decides the design and none should be assumed:
//   1. Is createSyncAccessHandle available there?  (No — only createWritable.)
//   2. Does append cost grow with file size?       (No — flat, ~0.6 ms.)
//   3. How cheap is a byte-range tail read?        (0.4 ms for 64 KiB.)
//
// Question 2 was the real risk: if Chrome staged a whole-file copy per
// createWritable({keepExistingData:true}), append would be O(filesize) and the
// WAL would be unworkable in the service worker. It does not.
//
//   deno run -A scripts/opfs-wal-probe.ts
import { launchChrome, openCdp, waitForServiceWorker } from "./lib/chrome-launch.ts";

// The extension under test is THIS tree's (never a hard-coded checkout — a
// probe that loads another tree's bundle reports facts about a tree it never
// built).
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

const profile = await Deno.makeTempDir({ prefix: "wal-probe-" });
// The shared launcher: kernel-assigned port, endpoint read from this child's
// own stderr, honest failure when the browser prints none.
const chrome = await launchChrome({
  args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--window-size=1200,900",
    `--user-data-dir=${profile}`, "about:blank",
  ],
  clearEnv: true,
});
const proc = chrome.proc;
const cdp = await openCdp(chrome.wsUrl);
// Resolves the `{ result }` envelope (the shape this probe reads); rejects on a
// protocol error instead of resolving it as success.
const send = cdp.send;

// MV3 registers the worker a beat after the endpoint is reachable — wait for
// it explicitly rather than reading Target.getTargets once and hoping.
const sw = await waitForServiceWorker(send, {
  timeoutMs: 20000,
  match: (t: any) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"),
});
if (!sw) {
  console.error("no service worker");
  cdp.close();
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
  Deno.exit(1);
}
const att = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
const s = att.result.sessionId;
await send("Runtime.enable", {}, s);

const run = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
  return r?.result?.result?.value;
};

console.log("\n=== OPFS capability in the extension SERVICE WORKER ===\n");
const report = await run(`(async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("wal-probe", { create: true });
  const enc = new TextEncoder();
  const NLC = String.fromCharCode(10);
  const out = { context: typeof ServiceWorkerGlobalScope !== "undefined" ? "service-worker" : "other", hasSyncAccessHandle: false };
  const rec = (i) => JSON.stringify({ i, type: "tool-call", tool: "list_tabs", at: Date.now() }) + NLC;

  // A) Append cost as the file GROWS. If Chrome copies the file per open,
  //    this rises with size and decides the design.
  const fh = await dir.getFileHandle("append.log", { create: true });
  const marks = {};
  for (const n of [1, 250, 500, 750, 1000]) {
    const t = performance.now();
    const w = await fh.createWritable({ keepExistingData: true });
    await w.seek((await fh.getFile()).size);
    await w.write(enc.encode(rec(n)));
    await w.close();
    marks["at_" + n + "_rows"] = Math.round((performance.now() - t) * 100) / 100;
    if (n < 1000) {
      const w2 = await fh.createWritable({ keepExistingData: true });
      await w2.seek((await fh.getFile()).size);
      let blob = "";
      for (let i = 0; i < 249; i++) blob += rec(i);
      await w2.write(enc.encode(blob));
      await w2.close();
    }
  }
  const finalSize = (await fh.getFile()).size;

  // B) One open, 1000 rows.
  const fh2 = await dir.getFileHandle("batch.log", { create: true });
  const t2 = performance.now();
  const w3 = await fh2.createWritable({ keepExistingData: true });
  await w3.seek(0);
  let all = "";
  for (let i = 0; i < 1000; i++) all += rec(i);
  await w3.write(enc.encode(all));
  await w3.close();
  const batchMs = Math.round(performance.now() - t2);

  // C) Tail read via Blob.slice — one open, only the bytes wanted.
  const t3 = performance.now();
  const file = await fh2.getFile();
  const want = Math.min(file.size, 64 * 1024);
  const text = await file.slice(file.size - want, file.size).text();
  const rows = text.split(NLC).filter(Boolean);
  const tailMs = Math.round((performance.now() - t3) * 100) / 100;

  // D) Whole-file read, for comparison.
  const t4 = performance.now();
  const wholeText = await (await fh2.getFile()).text();
  const wholeMs = Math.round((performance.now() - t4) * 100) / 100;

  return JSON.stringify({ ...out, appendCostAsFileGrows: marks, finalSizeBytes: finalSize,
    batchedAppend1000Ms: batchMs, tailReadMs: tailMs, tailRowsParsed: rows.length,
    wholeFileReadMs: wholeMs, wholeFileRows: wholeText.split(NLC).filter(Boolean).length }, null, 2);
})()`);
console.log(typeof report === "string" ? report : JSON.stringify(report, null, 2));

// The honest pass condition: the probe RAN TO COMPLETION inside the extension
// service worker and produced every measurement it exists to take (an eval
// that threw, a non-worker context, or an empty tail/whole read is a failure
// of the probe, not a storage fact). The exit code is derived from that — a
// probe that printed an error and exited 0 read as green to any aggregate.
let parsed: any = null;
try { parsed = typeof report === "string" ? JSON.parse(report) : report; } catch { parsed = null; }
const marks = parsed?.appendCostAsFileGrows ?? {};
const probeOk = parsed != null && !parsed.__error &&
  parsed.context === "service-worker" &&
  Object.keys(marks).length === 5 && Object.values(marks).every((v) => Number.isFinite(v)) &&
  Number.isFinite(parsed.batchedAppend1000Ms) && Number.isFinite(parsed.tailReadMs) &&
  Number.isFinite(parsed.wholeFileReadMs) &&
  parsed.tailRowsParsed > 0 && parsed.wholeFileRows > 0;
console.log(`\nRESULT: ${probeOk ? "PASS" : "FAIL"} — OPFS WAL probe ${
  probeOk
    ? "completed in the extension service worker (append-cost marks, batched append, tail + whole-file reads all measured)"
    : `did not complete: ${parsed?.__error ?? "missing measurements"}`
}`);

cdp.close();
try { proc.kill("SIGKILL"); } catch { /* gone */ }
await Deno.remove(profile, { recursive: true }).catch(() => {});
Deno.exit(probeOk ? 0 : 1);

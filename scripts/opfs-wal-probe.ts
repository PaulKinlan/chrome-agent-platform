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
const CHROMIUM = "/usr/bin/chromium";
const EXT = "/home/paulkinlan/chrome-agent-platform/extension";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = await Deno.makeTempDir({ prefix: "wal-probe-" });
const proc = new Deno.Command(CHROMIUM, {
  args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--window-size=1200,900",
    `--user-data-dir=${profile}`, "about:blank",
  ],
  stdout: "piped", stderr: "piped", clearEnv: true,
}).spawn();

let port = 0;
for (let i = 0; i < 80 && !port; i++) {
  await sleep(250);
  const reader = proc.stderr.getReader();
  const { value, done } = await reader.read();
  reader.releaseLock();
  const line = done ? null : new TextDecoder().decode(value);
  if (line?.includes("DevTools listening")) port = Number(line.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
}
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => { const d = JSON.parse(e.data as string); if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); } };
const send = (m: string, p: any = {}, s?: string) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });

const targets = await send("Target.getTargets");
const sw = targets.result.targetInfos.find((t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
if (!sw) { console.error("no service worker"); Deno.exit(1); }
const att = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
const s = att.result.sessionId;
await send("Runtime.enable", {}, s);

const run = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
  return r?.result?.result?.value;
};

console.log("\n=== OPFS capability in the extension SERVICE WORKER ===\n");
console.log(await run(`(async () => {
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
})()`));

try { proc.kill("SIGKILL"); } catch { /* gone */ }
await Deno.remove(profile, { recursive: true }).catch(() => {});
Deno.exit(0);

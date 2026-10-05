// perf-gallery-previews.ts — the artifacts-gallery preview-waterfall gate
// (bead chrome-agent-platform-0iln, station perf-review, severity HIGH).
//
// THE DEFECT. updateFilteredView() awaited send("asset.get") once per card,
// sequentially, for up to MAX_PREVIEWS = 24 artifacts, so a full gallery
// converged over the SUM of up to 24 chrome.runtime -> SW -> OPFS round-trips
// instead of a bounded number of them. The fix is a bounded pool
// (PREVIEW_CONCURRENCY in extension/artifacts/index.js).
//
// WHY THIS IS NOT A MOCK. Chrome loads the REAL extension (--load-extension), the
// REAL artifacts module is imported into the REAL NTP page, and every asset.get
// travels the REAL service worker to REAL OPFS. The only instrumentation wraps
// chrome.runtime.sendMessage in the page to timestamp each asset.get and count
// how many are in flight; it observes the shipped call pattern rather than
// replacing it with a fake transport.
//
//   deno run -A scripts/perf-gallery-previews.ts [artifacts=30] [outDir]
//   CAP_EXT=<extension dir>      measure another tree — this is how the BASELINE
//                               (pre-fix) run is produced, and the two runs are
//                               the measurement the bead asks for.
//   CAP_GALLERY_CONCURRENCY=<n>  the pool bound the tree declares (default 8)
//
// JUDGEMENTS (HARD):
//   1. peak in-flight asset.get <= pool bound   — no unbounded 24-way burst
//   2. total time <= batches * p50 + slack      — converges in batches, not per read
//   3. first preview <= ~one read + slack       — visible work is not queued behind 24
//
// The headline number to read in the output is serialReadEquivalents: how many
// p50 reads the gallery's wall time is worth. Serially that is ~the read count;
// with a bounded pool it is ~ceil(count / concurrency).
import { fileURLToPath } from "node:url";
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = Deno.env.get("CAP_EXT") ?? `${ROOT}extension`;
const SEED = Number(Deno.args[0] ?? "30");
const CONCURRENCY = Number(Deno.env.get("CAP_GALLERY_CONCURRENCY") ?? "8");
const OUT = Deno.args[1] ?? Deno.env.get("CAP_PERF_OUT") ?? await Deno.makeTempDir({ prefix: "cap-gallery-out-" });
const MAX_PREVIEWS = 24; // extension/artifacts/index.js MAX_PREVIEWS
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`);
  }
}

// Installed before any page module runs: timestamps each asset.get and tracks the
// number in flight. Deliberately does not alter the request or the resolution.
const OBSERVER = `
(() => {
  const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
  const R = { inflight: 0, peak: 0, calls: [] };
  globalThis.__capPreviewReads = R;
  chrome.runtime.sendMessage = (...args) => {
    const m = args[0];
    if (!m || m.type !== "asset.get") return orig(...args);
    const rec = { t0: performance.now(), t1: null };
    R.calls.push(rec);
    R.inflight++;
    if (R.inflight > R.peak) R.peak = R.inflight;
    const done = () => { rec.t1 = performance.now(); R.inflight--; };
    const last = args[args.length - 1];
    if (typeof last === "function") return orig(...args.slice(0, -1), (...r) => { done(); last(...r); });
    const p = orig(...args);
    if (p && typeof p.then === "function") p.then(done, done);
    return p;
  };
})();
`;

// Drives the real module the way ntp.js does, then reports what was observed.
const drive = (seed: number) => `
(async () => {
  const el = document.getElementById("artifacts-view");
  const mod = await import(chrome.runtime.getURL("artifacts/index.js"));
  const R = globalThis.__capPreviewReads;
  R.calls.length = 0; R.peak = 0; R.inflight = 0;
  const cards = () => [...document.querySelectorAll("artifact-card")];
  const withPreview = () => cards().filter((c) => (c.preview ?? "").length > 0).length;
  const want = Math.min(${seed}, ${MAX_PREVIEWS});
  const t0 = performance.now();
  let firstPreviewMs = null;
  const render = mod.renderArtifactsView(el, { path: "", onAttachArtifact: () => {}, onGoHome: () => {} });
  const deadline = t0 + 20000;
  for (;;) {
    const n = withPreview();
    if (firstPreviewMs === null && n > 0) firstPreviewMs = performance.now() - t0;
    if (R.inflight === 0 && R.calls.length > 0 && n >= want) break;
    if (performance.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await render.catch(() => {});
  const totalMs = performance.now() - t0;
  const reads = R.calls.filter((c) => c.t1 != null).map((c) => c.t1 - c.t0).sort((a, b) => a - b);
  // DOM-independent metric: how long the FIRST pool-sized batch of reads took.
  // This is "the visible previews" without depending on custom-element internals:
  // a serial loop cannot finish any batch before issuing ~all of them, so this
  // single number separates "one read" from "24 reads" on its own.
  const batch = R.calls.slice(0, ${CONCURRENCY}).filter((c) => c.t1 != null);
  const firstBatchMs = batch.length
    ? Math.round(Math.max(...batch.map((c) => c.t1)) - Math.min(...batch.map((c) => c.t0)))
    : null;
  return {
    totalMs: Math.round(totalMs),
    firstPreviewMs: firstPreviewMs === null ? null : Math.round(firstPreviewMs),
    firstBatchMs,
    fetched: R.calls.length,
    peakInflight: R.peak,
    readsDone: reads.length,
    readsP50: reads.length ? Math.max(1, Math.round(reads[Math.floor(reads.length / 2)])) : 0,
    readsMax: reads.length ? Math.round(reads[reads.length - 1]) : 0,
    previews: withPreview(),
    cards: cards().length,
  };
})()
`;

const profile = await Deno.makeTempDir({ prefix: "cap-gallery-" });
const chrome = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--no-first-run", "--ozone-platform=headless", "--use-angle=swiftshader-webgl", "--window-size=1440,900", "about:blank",
  ],
});

try {
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((r) => { ws.onopen = r as () => void; });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data as string);
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
  };
  const send = (m: string, p: any = {}, s?: string) =>
    new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });
  const evalIn = async (s: string, expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate threw");
    return r?.result?.result?.value;
  };
  const attach = async (t: string) => {
    const s = (await send("Target.attachToTarget", { targetId: t, flatten: true })).result.sessionId as string;
    await send("Runtime.enable", {}, s);
    return s;
  };

  const sw = await waitForServiceWorker(send, { match: (t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") });
  const extId = new URL(sw.url).host;
  console.log(`tree under test: ${EXT}`);
  console.log(`extension id: ${extId}`);

  // Seed a gallery's worth of artifacts through the extension's own API.
  const adminT = (await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` })).result.targetId;
  const adminS = await attach(adminT);
  await sleep(800);
  const adminMsg = (o: unknown) => evalIn(adminS, `chrome.runtime.sendMessage(${JSON.stringify(o)})`);
  for (let i = 0; i < SEED; i++) {
    const r = await adminMsg({ type: "asset.create", origin: "master", assetType: "text", name: `gallery-seed-${String(i).padStart(2, "0")}`, content: `seed artifact ${i}` });
    if (!r?.ok) throw new Error(`asset.create ${i} failed: ${JSON.stringify(r)}`);
  }
  const listed = await adminMsg({ type: "asset.list", origin: "master" });
  const listedCount = (listed?.assets ?? []).length;
  console.log(`seeded ${SEED} artifacts; asset.list reports ${listedCount}`);

  // The real NTP page, with the observer installed before any module runs.
  const pageT = (await send("Target.createTarget", { url: "about:blank" })).result.targetId;
  const pageS = await attach(pageT);
  await send("Page.enable", {}, pageS).catch(() => {});
  await send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER }, pageS);
  await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, pageS);
  let domReady = false;
  for (let i = 0; i < 150; i++) {
    domReady = !!(await evalIn(pageS, `!!document.getElementById("artifacts-view")`));
    if (domReady) break;
    await sleep(100);
  }
  if (!domReady) throw new Error("ntp.html never exposed #artifacts-view");

  const result = await evalIn(pageS, drive(SEED));
  const want = Math.min(SEED, MAX_PREVIEWS);
  const batches = Math.max(1, Math.ceil(result.fetched / CONCURRENCY));
  const serialEquivalents = result.readsP50 ? +(result.totalMs / result.readsP50).toFixed(2) : null;
  const report = {
    tree: EXT,
    seed: SEED,
    poolBound: CONCURRENCY,
    ...result,
    batchesIfPooled: batches,
    serialReadEquivalents: serialEquivalents,
    serialWouldBeMs: result.fetched * result.readsP50,
  };
  console.log(JSON.stringify(report, null, 2));

  check("gallery issues one asset.get per previewable card", result.fetched === want, { fetched: result.fetched, expected: want });
  check("every fetched read completed", result.readsDone === result.fetched, { readsDone: result.readsDone, fetched: result.fetched });
  check("all previews rendered", result.previews >= want, { previews: result.previews, expected: want });
  check("no unbounded burst: peak in-flight within the pool bound", result.peakInflight <= CONCURRENCY, { peakInflight: result.peakInflight, poolBound: CONCURRENCY });
  check(
    "converges in batches, not the sum of reads",
    result.totalMs <= batches * result.readsP50 + 250,
    { totalMs: result.totalMs, batches, readsP50: result.readsP50, serialWouldBeMs: result.fetched * result.readsP50 },
  );
  check(
    "visible previews land in about one read, not behind 24",
    result.firstPreviewMs !== null && result.firstPreviewMs <= result.readsP50 * 2 + 150,
    { firstPreviewMs: result.firstPreviewMs, readsP50: result.readsP50 },
  );
  check(
    "the first pool-sized batch completes in about one read (DOM-independent)",
    result.firstBatchMs !== null && result.firstBatchMs <= result.readsP50 * 2 + 150,
    { firstBatchMs: result.firstBatchMs, readsP50: result.readsP50 },
  );

  await Deno.writeTextFile(`${OUT}/gallery-previews.json`, JSON.stringify(report, null, 2));
  console.log(`wrote ${OUT}/gallery-previews.json`);
  console.log(`SUMMARY: pass=${pass} fail=${fail} fetched=${result.fetched} peak=${result.peakInflight} totalMs=${result.totalMs} p50Ms=${result.readsP50} serialEquivalents=${serialEquivalents}`);
} finally {
  try { chrome.proc.kill(); } catch { /* already gone */ }
}

if (fail > 0) Deno.exit(1);

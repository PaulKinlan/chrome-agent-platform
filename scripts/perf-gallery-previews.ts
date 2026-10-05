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
  if (!globalThis.chrome?.runtime?.sendMessage) return;
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
  const el = (() => {
    const old = document.getElementById("qazo-gallery-host");
    if (old) old.remove();
    const host = document.createElement("div");
    host.id = "qazo-gallery-host";
    document.body.appendChild(host);
    return host;
  })();
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

// Teardown discipline (coord, 2026-10-05): the reaper collected four orphaned
// Chrome children from an earlier run of this harness. Two causes, both fixed
// here: (1) chrome.proc.kill() kills the main process but NOT the renderer/GPU
// children, which reparent to init and keep running; (2) a SIGTERM'd deno process
// never reaches its finally block, so the browser outlives the harness. So: sweep
// children by this run's unique profile dir, do it from signal handlers as well as
// the finally, and bound the whole session with a watchdog that is far inside the
// reaper's orphan window.
const BUDGET_MS = Number(Deno.env.get("CAP_GALLERY_BUDGET_MS") ?? "300000");
const killBrowser = async () => {
  try { chrome.proc.kill("SIGKILL"); } catch { /* already gone */ }
  try {
    await new Deno.Command("pkill", { args: ["-f", `--user-data-dir=${profile}`] }).output();
  } catch { /* pkill missing or nothing matched */ }
};
const cleanup = async () => {
  await killBrowser();
  await sleep(300);
  await Deno.remove(profile, { recursive: true }).catch(() => {});
};
const hardStop = async (why: string, code: number) => {
  console.error(`harness stop (${code}): ${why}`);
  await cleanup().catch(() => {});
  Deno.exit(code);
};
for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  try {
    Deno.addSignalListener(sig, () => { hardStop(sig, code).catch(() => Deno.exit(code)); });
  } catch { /* signal not supported here */ }
}
const watchdog = setTimeout(() => { hardStop(`wall-clock budget ${BUDGET_MS}ms exceeded`, 124).catch(() => Deno.exit(124)); }, BUDGET_MS);

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
  // A freshly created extension target does not expose chrome.* immediately:
  // evaluating too early reads chrome off undefined (measured: the first harness
  // run died on 'reading sendMessage' at 800 ms). Wait for the API, do not sleep
  // and hope.
  const waitFor = async (s: string, expr: string, tries = 40, ms = 150) => {
    for (let i = 0; i < tries; i++) {
      try { if (await evalIn(s, expr)) return true; } catch { /* context still coming up */ }
      await sleep(ms);
    }
    return false;
  };
  // An evaluate whose promise never settles would hang the harness silently
  // (awaitPromise waits forever), so every seed/drive evaluate goes through a bound.
  const evalInT = async (s: string, expr: string, ms = 30000, label = "evaluate") => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} did not settle within ${ms}ms`)), ms); });
    try {
      return await Promise.race([evalIn(s, expr), guard]);
    } finally {
      clearTimeout(timer);
    }
  };
  const probe = async (s: string) => {
    try {
      return await evalIn(s, `JSON.stringify({ href: location.href, ready: document.readyState, title: document.title, chromeType: typeof chrome, runtimeType: typeof (globalThis.chrome && chrome.runtime), sendType: typeof (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) })`);
    } catch (e) {
      return `probe threw: ${(e as Error).message}`;
    }
  };
  const CHROME_READY = "typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)";

  console.log(`tree under test: ${EXT}`);
  // Identify OUR extension by asking each extension service worker for its own
  // manifest name. Matching on "a chrome-extension:// service worker" is not
  // enough: that picked a COMPONENT extension on this box, so every subsequent
  // chrome-extension://<id>/... navigation landed on chrome-error:// (the first
  // two harness runs proved it — the page title was the URL and href was the
  // error page).
  const wantName = JSON.parse(await Deno.readTextFile(`${EXT}/manifest.json`)).name as string;
  await waitForServiceWorker(send, { match: (t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") }).catch(() => null);
  let extId = "";
  for (let attempt = 0; attempt < 60 && !extId; attempt++) {
    const targets = (await send("Target.getTargets")).result.targetInfos
      .filter((t: any) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"));
    for (const t of targets) {
      const s = await attach(t.targetId).catch(() => null);
      if (!s) continue;
      const gotName = await evalIn(s, "chrome.runtime.getManifest().name").catch(() => null);
      if (gotName === wantName) {
        extId = new URL(t.url).host;
        console.log(`matched extension ${extId} (${gotName})`);
        break;
      }
    }
    if (!extId) await sleep(250);
  }
  if (!extId) throw new Error(`no service worker reports the manifest name ${JSON.stringify(wantName)} (tree ${EXT})`);

  // Seed from the GALLERY page using the CALLBACK form, which is what the working
  // kat-artifact-library-capacity.ts harness does:
  //   const s = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res))
  // An asset.create from the OPTIONS page never settled, and the promise form from
  // ntp.html hung intermittently on a loaded box (reads answered, writes did not), so
  // this follows the proven sender rather than inventing another one.
  const adminT = (await send("Target.createTarget", { url: `chrome-extension://${extId}/artifacts/index.html` })).result.targetId;
  const adminS = await attach(adminT);
  if (!(await waitFor(adminS, CHROME_READY))) throw new Error(`the seed page never exposed chrome.runtime — context says ${await probe(adminS)}`);
  // Warm the service worker BEFORE seeding. The first sendMessage after a page load
  // has to wake a cold extension, and on a box at load 17 that alone blew an 8s bound
  // on the FIRST message (measured 2026-10-05), while the same harness had seeded
  // 6/6 minutes earlier. A handshake that waits for one real answer removes the
  // race instead of tuning the bound until it usually passes.
  const warm = await evalInT(
    adminS,
    `(async () => {
      const t0 = performance.now();
      for (let i = 0; i < 120; i++) {
        try { const r = await chrome.runtime.sendMessage({ type: "asset.list", origin: "master" }); if (r) return Math.round(performance.now() - t0); }
        catch { /* service worker still waking */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      return -1;
    })()`,
    90000,
    "service worker warm-up",
  );
  if (warm === -1) throw new Error("the service worker never answered asset.list");
  console.log(`service worker answered after ${warm}ms`);
  const seedExpr = `(async () => {
    const s = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    let created = 0;
    for (let i = 0; i < ${SEED}; i++) {
      const r = await s({ type: "asset.create", origin: "master", assetType: "text", name: "gallery-seed-" + String(i).padStart(2, "0"), content: "seed artifact " + i });
      if (r && r.ok) created++;
    }
    const listed = await s({ type: "asset.list", origin: "master" });
    return JSON.stringify({ created, asked: ${SEED}, listed: (listed && listed.assets) ? listed.assets.length : -1 });
  })()`;
  const seeded = JSON.parse(await evalInT(adminS, seedExpr, 180000, "seed batch"));
  if (seeded.created !== SEED || seeded.listed < SEED) {
    throw new Error(`seeding failed: ${JSON.stringify(seeded)}`);
  }
  console.log(`seeded ${seeded.created}/${seeded.asked}; asset.list reports ${seeded.listed}`);

  // The MEASUREMENT page is the options page: it defines artifact-card (it imports
  // shared/components.js) and, unlike ntp.html, it does not mount an artifacts view of
  // its own — so the reads being timed are the ones our render issues and nothing else.
  // The observer is installed by evaluating it into the loaded page, which is enough
  // because the gallery only reads when we call it.
  const pageT = (await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` })).result.targetId;
  const pageS = await attach(pageT);
  if (!(await waitFor(pageS, CHROME_READY))) throw new Error(`the measurement page never exposed chrome.runtime — context says ${await probe(pageS)}`);
  console.log("stage: seed page ready, measurement page ready");
  if (!(await waitFor(pageS, `!!customElements.get("artifact-card")`))) throw new Error("the measurement page never defined artifact-card");
  await evalInT(pageS, OBSERVER, 15000, "install observer");
  if (!(await evalIn(pageS, `!!globalThis.__capPreviewReads`))) throw new Error("the observer did not install");

  console.log(`stage: driving the real gallery render (seed=${SEED}, pool=${CONCURRENCY})`);
  let result;
  try {
    result = await evalInT(pageS, drive(SEED), 60000, "gallery drive");
  } catch (e) {
    // Never let a drive failure be silent: the earlier shape (rc=1, no message)
    // cost a full slot to diagnose.
    console.error(`DRIVE FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    throw e;
  }
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
  // Persist BEFORE the checks: if anything after this point dies, the numbers survive.
  await Deno.writeTextFile(`${OUT}/gallery-previews.json`, JSON.stringify(report, null, 2));

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
  clearTimeout(watchdog);
  await cleanup();
}

// Natural exit, NOT Deno.exit(1): with stdout redirected to a file, Deno.exit
// discards whatever is still buffered, so a completed run that failed a check
// vanished entirely — rc=1 and an empty log, which reads like a crash and is the
// worst possible shape for evidence. Setting exitCode lets the runtime flush.
Deno.exitCode = fail > 0 ? 1 : 0;

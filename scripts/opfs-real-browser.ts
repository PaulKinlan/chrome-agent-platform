// opfs-real-browser.ts — REAL-browser verification that OPFS memory works in the
// actual MV3 service worker (closes the "it serves ≠ it works" honesty gap for
// the whole stack: O1 from GLM-5.3's review).
//
// The e2e-task.test.ts is deliberately mock-based (an in-memory chrome.storage +
// a Map memory fake). This script loads the BUILT extension unpacked in headless
// Chrome and, in the REAL service worker, proves:
//   1. navigator.storage.getDirectory() works (a raw OPFS write + read round-trip
//      in the SW's own context — the un-shimmed primitive), and
//   2. the memory module's real path (memory.set / memory.get routes) persists a
//      value to OPFS and reads it back, for the MASTER store, a NAMED-agent store
//      (agent:<id>), and a BACKGROUND store (background:<id>).
//
// It also PINS the four OPFS platform facts that chrome-agent-platform-g2dje's
// writer decision rests on (bead n87j0). Before this phase they existed only as
// prose (extension/lib/run-log-wal.js:18-31 and the ADR), so a Chrome update
// could invalidate the decision while every gate stayed green:
//   (a) createSyncAccessHandle() is exclusive per file (NoModificationAllowedError);
//   (b) createWritable() with no mode is SILOED and does NOT exclude another
//       writer (two concurrent writables are accepted, last close wins) while it
//       DOES refuse a sync access handle;
//   (c) createWritable({mode:"exclusive"}) is honoured by the shipped Chrome;
//   (d) Worker.terminate() releases the terminated realm's sync access handle,
//       with a CONTROL (a live holder must block the probe) that makes (d)
//       meaningful.
// A drift FAILS here and names x9r8k, ltkj.7 and ltkj.8. The measured Chrome
// version is printed. tests/opfs-platform-facts-pin.test.ts is the always-on
// half: it keeps these assertions wired and fails if production adopts a writer
// mode or a sync-handle site this measurement does not cover.
//
//   deno run -A scripts/opfs-real-browser.ts

import { fileURLToPath } from "node:url";
import { launchChrome, openCdp } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string) {
  const r = await fetch(url);
  return r.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// OPFS platform facts (bead n87j0). One page and one dedicated worker per
// measurement, served from this script's own 127.0.0.1 fixture: an extension
// page's CSP (`script-src 'self'`) refuses a blob: worker, and shipping a
// probe-only worker in extension/ would put test bytes in the product.
// ─────────────────────────────────────────────────────────────────────────────
const FACTS_WORKER_SRC = `
self.onmessage = async (ev) => {
  const reply = (o) => self.postMessage(o);
  const { op, path, budgetMs } = ev.data;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("n87j0", { create: true });
    const open = async (p) => (await dir.getFileHandle(p, { create: true })).createSyncAccessHandle();

    if (op === "open2") {
      const first = await open(path);
      let secondOpened = false, secondErr = null;
      try { const h = await open(path); secondOpened = true; h.close(); } catch (e) { secondErr = e && e.name; }
      let otherFileOk = false, otherFileErr = null;
      try { const o = await open("other-" + path); otherFileOk = true; o.close(); } catch (e) { otherFileErr = e && e.name; }
      first.close();
      reply({ op, secondOpened, secondErr, otherFileOk, otherFileErr });
      return;
    }
    if (op === "hold") {
      const h = await open(path);
      h.write(new Uint8Array([65]), { at: 0 });
      h.flush();
      reply({ op, holding: true });
      const until = Date.now() + 120000;
      while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      return;
    }
    if (op === "tryopen") {
      const t0 = performance.now();
      let ok = false, err = null;
      while (performance.now() - t0 < (budgetMs || 5000)) {
        try { const h = await open(path); h.close(); ok = true; break; } catch (e) { err = e && e.name; }
        await new Promise((r) => setTimeout(r, 25));
      }
      reply({ op, ok, err, ms: Math.round(performance.now() - t0) });
      return;
    }
    reply({ op, error: "unknown op" });
  } catch (e) {
    reply({ op, fatal: String((e && e.name) || e) + ": " + String((e && e.message) || "") });
  }
};
`;

const FACTS_PAGE_HTML = '<!doctype html><meta charset="utf-8"><title>n87j0</title><body>n87j0</body>';

/** Drive the four facts. Returns the raw observations; the caller asserts them. */
async function measureOpfsPlatformFacts(
  send: (method: string, params: unknown, sessionId?: string) => Promise<any>,
  origin: string,
): Promise<Record<string, any>> {
  const target = await send("Target.createTarget", { url: `${origin}/page.html` });
  const session = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await send("Runtime.enable", {}, session);
  const evl = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  };
  // Target.createTarget returns before the document commits, and a worker URL
  // resolves against the DOCUMENT's base: evaluating too early builds
  // new Worker("/worker.js") against about:blank and throws "'/worker.js' is not
  // a valid URL". Wait (bounded) for the fixture origin to be the page's own.
  const deadline = Date.now() + 15000;
  let committed = false;
  while (Date.now() < deadline) {
    committed = (await evl(`location.origin === ${JSON.stringify(origin)} && document.readyState !== "loading"`)) === true;
    if (committed) break;
    await sleep(50);
  }
  if (!committed) throw new Error(`the fixture page never committed at ${origin}`);
  // One worker, one reply, bounded: a worker that never answers is a failed
  // measurement with a name, never a hung harness.
  const ask = (body: Record<string, unknown>, timeoutMs = 20000) =>
    evl(`(async () => {
      const w = new Worker("/worker.js");
      try {
        return await new Promise((resolve) => {
          w.onmessage = (e) => resolve(e.data);
          w.postMessage(${JSON.stringify(body)});
          setTimeout(() => resolve({ op: ${JSON.stringify(String(body.op))}, timeout: true }), ${timeoutMs});
        });
      } finally { w.terminate(); }
    })()`);

  try {
    const syncHandle = await ask({ op: "open2", path: "a.txt" });

    const silo = await evl(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("n87j0", { create: true });
      const fh = await dir.getFileHandle("b.txt", { create: true });
      const w = await fh.createWritable();
      await w.write("WRITTEN-BUT-UNCLOSED");
      const during = await (await (await dir.getFileHandle("b.txt", { create: true })).getFile()).text();
      await w.close();
      const after = await (await (await dir.getFileHandle("b.txt", { create: true })).getFile()).text();
      return { during, after };
    })()`);

    const twoWriters = await evl(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("n87j0", { create: true });
      const fh = await dir.getFileHandle("b2.txt", { create: true });
      let a = null, b = null, aErr = null, bErr = null;
      try { a = await fh.createWritable(); } catch (e) { aErr = e && e.name; }
      try { b = await (await dir.getFileHandle("b2.txt", { create: true })).createWritable(); } catch (e) { bErr = e && e.name; }
      if (a) { await a.write("FROM-A"); await a.close(); }
      if (b) { await b.write("FROM-B-LONGER"); await b.close(); }
      const finalText = await (await (await dir.getFileHandle("b2.txt", { create: true })).getFile()).text();
      return { bothOpened: !!a && !!b, aErr, bErr, finalText };
    })()`);

    await evl(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("n87j0", { create: true });
      const fh = await dir.getFileHandle("b3.txt", { create: true });
      globalThis.__n87j0Writable = await fh.createWritable();
      await globalThis.__n87j0Writable.write("HELD");
      return true;
    })()`);
    const defaultBlocksSyncHandle = await ask({ op: "tryopen", path: "b3.txt", budgetMs: 1200 });
    await evl(`(async () => { await globalThis.__n87j0Writable.close(); return true; })()`).catch(() => {});

    const exclusiveWritable = await evl(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("n87j0", { create: true });
      const fh = await dir.getFileHandle("c.txt", { create: true });
      let first = null, acceptErr = null, secondOk = false, secondErr = null;
      try { first = await fh.createWritable({ mode: "exclusive" }); } catch (e) { acceptErr = e && e.name; }
      if (first) {
        try { const s = await (await dir.getFileHandle("c.txt", { create: true })).createWritable({ mode: "exclusive" }); secondOk = true; await s.close(); }
        catch (e) { secondErr = e && e.name; }
        await first.close();
      }
      return { accepted: !!first, acceptErr, secondOk, secondErr };
    })()`);

    const exclusiveHeld = await evl(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("n87j0", { create: true });
      const fh = await dir.getFileHandle("c2.txt", { create: true });
      globalThis.__n87j0Exclusive = await fh.createWritable({ mode: "exclusive" });
      return true;
    })()`).catch(() => false);
    const exclusiveBlocksDefault = exclusiveHeld
      ? await evl(`(async () => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle("n87j0", { create: true });
          const fh = await dir.getFileHandle("c2.txt", { create: true });
          try { const d = await fh.createWritable(); await d.close(); return { succeeded: true, err: null }; }
          catch (e) { return { succeeded: false, err: e && e.name }; }
        })()`)
      : { succeeded: true, err: "the exclusive writable was never held" };
    const exclusiveBlocksSyncHandle = exclusiveHeld
      ? await ask({ op: "tryopen", path: "c2.txt", budgetMs: 1200 })
      : { op: "tryopen", ok: true, err: "the exclusive writable was never held" };
    if (exclusiveHeld) await evl(`(async () => { await globalThis.__n87j0Exclusive.close(); return true; })()`).catch(() => {});

    const terminated = await evl(`(async () => {
      const holder = new Worker("/worker.js");
      const opened = await new Promise((resolve) => {
        holder.onmessage = (e) => resolve(e.data);
        holder.postMessage({ op: "hold", path: "d.txt" });
        setTimeout(() => resolve({ timeout: true }), 10000);
      });
      if (!opened || opened.timeout || !opened.holding) {
        return { released: false, err: "the holder worker never held the handle: " + JSON.stringify(opened), ms: -1, termMs: -1 };
      }
      const t0 = performance.now();
      holder.terminate();
      const termMs = Math.round(performance.now() - t0);
      const probe = new Worker("/worker.js");
      const res = await new Promise((resolve) => {
        probe.onmessage = (e) => resolve(e.data);
        probe.postMessage({ op: "tryopen", path: "d.txt", budgetMs: 5000 });
        setTimeout(() => resolve({ timeout: true }), 12000);
      });
      probe.terminate();
      return { released: !!(res && res.ok), err: (res && (res.err ?? null)) ?? null, ms: (res && res.ms) ?? -1, termMs };
    })()`);

    const control = await evl(`(async () => {
      const holder = new Worker("/worker.js");
      const opened = await new Promise((resolve) => {
        holder.onmessage = (e) => resolve(e.data);
        holder.postMessage({ op: "hold", path: "d-control.txt" });
        setTimeout(() => resolve({ timeout: true }), 10000);
      });
      if (!opened || opened.timeout || !opened.holding) {
        return { liveHolderBlocks: false, err: "the control holder never held the handle: " + JSON.stringify(opened) };
      }
      const probe = new Worker("/worker.js");
      const res = await new Promise((resolve) => {
        probe.onmessage = (e) => resolve(e.data);
        probe.postMessage({ op: "tryopen", path: "d-control.txt", budgetMs: 1200 });
        setTimeout(() => resolve({ timeout: true }), 8000);
      });
      probe.terminate();
      holder.terminate();
      return { liveHolderBlocks: !!(res && res.ok === false), err: (res && res.err) ?? null };
    })()`);

    return { syncHandle, silo, twoWriters, defaultBlocksSyncHandle, exclusiveWritable, exclusiveBlocksDefault, exclusiveBlocksSyncHandle, terminated, control };
  } finally {
    await send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  }
}

/** What was measured, and on which Chrome. A behaviour change fails; a newer
 *  Chrome with the same behaviour passes and is reported. */
const PINNED_FACTS = {
  measuredOn: "154.0.8037.92",
  measuredOnDate: "2026-10-18",
  syncHandleIsExclusive: true,
  syncHandleLeavesOtherFilesAlone: true,
  defaultWritableIsNotMutuallyExclusive: true,
  exclusiveWritableModeHonoured: true,
  terminatedWorkerHandleReleased: true,
  liveHolderBlocksAnotherWorker: true,
} as const;

async function main() {
  const profile = durableDir(`cap-opfs-${Date.now()}`);
  await Deno.mkdir(profile, { recursive: true });
  // The shared launcher: kernel-assigned port, endpoint read from this child's
  // own stderr, honest failure when the browser prints none
  // (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
  const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,1200" });
  const proc = chrome.proc;
  // The platform-facts phase's own fixture (started below, closed in the finally).
  let factsServer: Deno.HttpServer | null = null;

  try {
    const port = chrome.port;
    const ws = await openCdp(chrome.wsUrl);
    const send = async (method: string, params: unknown, sessionId?: string): Promise<any> =>
      (await ws.send(method, params, sessionId)).result;
    const evl = async (s: string, expr: string): Promise<any> => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
      if (r?.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r?.result?.value;
    };

    // Find OUR service worker target. `targets.find(t => t.type ===
    // "service_worker")` is not that: this Chrome also lists other extensions'
    // workers (measured on 2026-10-18: an ntp.html URL built from the first one
    // is an invalid extension id, and the page commits as
    // chrome-error://chromewebdata with `chrome` undefined — a red that reads
    // like a broken extension). Match the manifest's own service_worker path.
    const swPath = JSON.parse(await Deno.readTextFile(`${EXT}/manifest.json`)).background?.service_worker;
    let sw = null;
    let swCandidates = 0;
    for (let i = 0; i < 60 && !sw; i++) {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const workers = targets.filter((t: any) => t.type === "service_worker");
      swCandidates = workers.length;
      sw = workers.find((t: any) => swPath && String(t.url).endsWith(`/${swPath}`)) ?? null;
      if (!sw) await sleep(200);
    }
    check(`extension loaded (service worker at ${swPath})`, !!sw, { candidates: swCandidates });
    if (!sw) throw new Error(`extension did not load: no service worker whose URL ends with /${swPath}`);
    const extId = sw.url.split("/")[2];

    // 1. RAW OPFS round-trip IN the service worker's own context — the
    //    un-shimmed navigator.storage.getDirectory() primitive, no module path.
    const swAttach = await send("Target.attachToTarget", { targetId: sw.id, flatten: true });
    const swSession = swAttach?.sessionId;
    await send("Runtime.enable", {}, swSession);
    const rawProbe = await evl(swSession, `(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('opfs-probe', { create: true });
      const fh = await dir.getFileHandle('probe.json', { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify({ probe: 'hello-opfs' }));
      await w.close();
      const rf = await dir.getFileHandle('probe.json');
      const f = await rf.getFile();
      return JSON.parse(await f.text()).probe;
    })()`);
    check("raw OPFS (navigator.storage.getDirectory) round-trips in the SW", rawProbe === "hello-opfs", rawProbe);

    // 2. The memory MODULE's real path (memory.set → OPFS → memory.get) via the
    //    message router, for master + named-agent + background stores.
    const ntp = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
    const ntpSession = (await send("Target.attachToTarget", { targetId: ntp.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ntpSession);
    // A FIXED SLEEP IS NOT A COMMIT. Target.createTarget returns before the new
    // document commits, and an evaluate that lands first runs in the initial
    // empty document, where `chrome` is undefined: "Cannot read properties of
    // undefined (reading 'sendMessage')" — a red that blames the extension for
    // the machine being slow (observed on a loaded box, 2026-10-18). Wait
    // (bounded) for the NTP page's OWN origin before sending anything.
    {
      const until = Date.now() + 15000;
      let ready = false;
      while (Date.now() < until) {
        const origin = await evl(ntpSession, "String(location.origin + '|' + document.readyState)").catch(() => "");
        ready = origin === `chrome-extension://${extId}|complete` || origin === `chrome-extension://${extId}|interactive`;
        if (ready) break;
        await sleep(100);
      }
      check("NTP page committed on the extension origin before messaging", ready);
    }

    const sendMsg = (payload: unknown) =>
      evl(ntpSession, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: e.message }))`);
    const msgValue = async (payload: unknown) => {
      const inner = await sendMsg(payload);
      if (inner && typeof inner === "object" && "v" in inner) return inner.v;
      if (inner && typeof inner === "object" && "err" in inner) return inner.err;
      return inner;
    };

    const probe = `opfs-${Date.now()}`;
    const stores = [
      ["master", "master"],
      ["named agent", `agent:opfs-probe-agent`],
      ["background agent", `background:opfs-probe-bg`],
    ];
    let allRoundTrip = true;
    for (const [label, origin] of stores) {
      const wrote = await msgValue({ type: "memory.set", origin, key: "probe", value: { hello: probe } });
      const read = await msgValue({ type: "memory.get", origin, key: "probe" });
      const ok = wrote !== undefined && read && typeof read === "object" && read.hello === probe;
      check(`memory.set/get round-trips through OPFS (${label})`, ok, { wrote, read });
      if (!ok) allRoundTrip = false;
      // Clean up the probe store so the run leaves no residue.
      await msgValue({ type: "memory.clear", origin });
    }
    check("all three stores (master/named/background) round-trip through OPFS", allRoundTrip);

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 3 (bead n87j0): the four OPFS platform facts g2dje's writer
    // decision rests on. Each check names the beads that depend on it, so a
    // drift points at a decision to re-read rather than at a test to update.
    // ─────────────────────────────────────────────────────────────────────
    const browserVersion = String((await send("Browser.getVersion", {})).product ?? "unknown");
    console.log(`\nOPFS platform facts: measured on ${browserVersion} (pin recorded on Chrome/${PINNED_FACTS.measuredOn}, ${PINNED_FACTS.measuredOnDate})`);
    if (browserVersion !== `Chrome/${PINNED_FACTS.measuredOn}`) {
      console.log("OPFS platform facts: NOTE — a different Chrome than the pin; the behaviours below are asserted, not the version.");
    }
    factsServer = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/worker.js") return new Response(FACTS_WORKER_SRC, { headers: { "content-type": "text/javascript" } });
      return new Response(FACTS_PAGE_HTML, { headers: { "content-type": "text/html" } });
    });
    const factsOrigin = `http://127.0.0.1:${factsServer.addr.port}`;
    const facts = await measureOpfsPlatformFacts(send, factsOrigin);
    const dep = `x9r8k, ltkj.7, ltkj.8; on ${browserVersion} vs the pin Chrome/${PINNED_FACTS.measuredOn}`;

    check(
      `OPFS fact (a): createSyncAccessHandle is exclusive per file — a second open throws NoModificationAllowedError (${dep})`,
      facts.syncHandle.secondOpened === !PINNED_FACTS.syncHandleIsExclusive && facts.syncHandle.secondErr === "NoModificationAllowedError",
      facts.syncHandle,
    );
    check(
      `OPFS fact (a'): exclusivity is per file — a different file is still openable (${dep})`,
      facts.syncHandle.otherFileOk === PINNED_FACTS.syncHandleLeavesOtherFilesAlone && !facts.syncHandle.otherFileErr,
      facts.syncHandle,
    );
    check(
      `OPFS fact (b): default createWritable() is SILOED — an unclosed write is invisible to readers and appears on close (${dep})`,
      facts.silo?.during === "" && facts.silo?.after === "WRITTEN-BUT-UNCLOSED",
      facts.silo,
    );
    check(
      `OPFS fact (b'): default createWritable() does NOT exclude another writer — two concurrent writables accepted, last close wins, so run-log-wal.js's single writer is conventional (${dep})`,
      facts.twoWriters?.bothOpened === PINNED_FACTS.defaultWritableIsNotMutuallyExclusive &&
        !facts.twoWriters?.aErr && !facts.twoWriters?.bErr && facts.twoWriters?.finalText === "FROM-B-LONGER",
      facts.twoWriters,
    );
    check(
      `OPFS fact (b''): an OPEN default writable DOES refuse a sync access handle — g2dje alternative (iii)'s post-terminate probe depends on it (${dep})`,
      facts.defaultBlocksSyncHandle?.ok === false && facts.defaultBlocksSyncHandle?.err === "NoModificationAllowedError",
      facts.defaultBlocksSyncHandle,
    );
    check(
      `OPFS fact (c): the shipped Chrome HONOURS createWritable({mode:"exclusive"}) (${dep})`,
      facts.exclusiveWritable?.accepted === PINNED_FACTS.exclusiveWritableModeHonoured && !facts.exclusiveWritable?.acceptErr,
      facts.exclusiveWritable,
    );
    check(
      `OPFS fact (c'): a second exclusive writable is refused (NoModificationAllowedError) (${dep})`,
      facts.exclusiveWritable?.secondOk === false && facts.exclusiveWritable?.secondErr === "NoModificationAllowedError",
      facts.exclusiveWritable,
    );
    check(
      `OPFS fact (c''): an exclusive writable excludes BOTH writer kinds — a default writable and a worker's sync access handle are refused (${dep})`,
      facts.exclusiveBlocksDefault?.succeeded === false && facts.exclusiveBlocksSyncHandle?.ok === false,
      { defaultWrite: facts.exclusiveBlocksDefault, syncHandle: facts.exclusiveBlocksSyncHandle },
    );
    check(
      `OPFS fact (d') CONTROL: a LIVE holder of the handle blocks another worker, so the release probe can detect a held handle (${dep})`,
      facts.control?.liveHolderBlocks === PINNED_FACTS.liveHolderBlocksAnotherWorker,
      facts.control,
    );
    check(
      `OPFS fact (d): Worker.terminate() RELEASES the terminated realm's sync access handle — another worker re-acquires it (${dep})`,
      facts.terminated?.released === PINNED_FACTS.terminatedWorkerHandleReleased,
      facts.terminated,
    );

    // Clean up the raw probe directory too.
    await evl(swSession, `(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('opfs-probe', { recursive: true }).catch(() => {});
      return true;
    })()`);

    ws.close();
  } finally {
    if (factsServer) await factsServer.shutdown().catch(() => {});
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    // Remove the profile dir (best-effort — a leak would be caught by the parent).
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail > 0 ? 1 : 0);
}

await main();

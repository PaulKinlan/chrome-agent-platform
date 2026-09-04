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
//   deno run -A scripts/opfs-real-browser.ts

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
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

async function main() {
  const profile = durableDir(`cap-opfs-${Date.now()}`);
  await Deno.mkdir(profile, { recursive: true });
  // The shared launcher: kernel-assigned port, endpoint read from this child's
  // own stderr, honest failure when the browser prints none
  // (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
  const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,1200" });
  const proc = chrome.proc;

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

    // Find the service worker target.
    let sw = null;
    for (let i = 0; i < 60 && !sw; i++) {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      sw = targets.find((t: any) => t.type === "service_worker");
      if (!sw) await sleep(200);
    }
    check("extension loaded (service worker present)", !!sw);
    if (!sw) throw new Error("extension did not load");
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
    await sleep(1500);

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

    // Clean up the raw probe directory too.
    await evl(swSession, `(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('opfs-probe', { recursive: true }).catch(() => {});
      return true;
    })()`);

    ws.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    // Remove the profile dir (best-effort — a leak would be caught by the parent).
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail > 0 ? 1 : 0);
}

await main();

// scripts/kat-python-wheel-install.ts — End-to-end KAT for pure-Python wheel install,
// materialization, and per-run isolation (chrome-agent-platform-4p7j, Slice 2).
//
// Run:
//   deno run -A scripts/kat-python-wheel-install.ts

import { launchChrome, waitForServiceWorker, teardownChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}/extension`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${typeof detail === "object" ? JSON.stringify(detail) : String(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeWheelZip(files: Array<{ name: string; content: string | Uint8Array }>): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  let offset = 0;

  for (const { name, content } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const crc = crc32(dataBytes);
    const size = dataBytes.byteLength;

    const local = new Uint8Array(30 + nameBytes.byteLength + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.byteLength);
    localChunks.push(local);

    const cd = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdChunks.push(cd);
    offset += local.byteLength;
  }

  const cdSize = cdChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const c of localChunks) { out.set(c, pos); pos += c.byteLength; }
  for (const c of cdChunks) { out.set(c, pos); pos += c.byteLength; }
  out.set(eocd, pos);
  return out;
}

const profile = chromeProfileDir("kat-python-wheel-install");
const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${profile}`, "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.onopen = r);
let id = 0;
const pending = new Map<string, (v: unknown) => void>();
const send = (method: string, params: unknown = {}, sessionId?: string) =>
  new Promise<any>((res) => {
    const mid = ++id;
    pending.set(String(mid), res as (v: unknown) => void);
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

try {
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  check("extension service worker present", Boolean(sw));
  const extId = new URL(sw.url).host;

  const openPage = async (url: string) => {
    const page = await send("Target.createTarget", { url });
    const sess = (await send("Target.attachToTarget", { targetId: page.result.targetId, flatten: true })).result?.sessionId;
    await send("Runtime.enable", {}, sess);
    return sess as string;
  };
  const evaluate = async (sess: string, expression: string) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sess);
    if (r?.result?.exceptionDetails) {
      throw new Error(`Evaluation threw: ${JSON.stringify(r.result.exceptionDetails)}`);
    }
    return r?.result?.result?.value;
  };

  // Open Options page (runs under owner-options principal for store administration)
  const optionsSess = await openPage(`chrome-extension://${extId}/options/options.html`);
  await sleep(1500);

  // Open NTP page (runs under extension principal for executing user code)
  const ntpSess = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(2500);

  const sendMessageOptions = async (msg: unknown) => {
    const expr = `(async()=>{const r=await chrome.runtime.sendMessage(${JSON.stringify(msg)});return JSON.stringify(r);})()`;
    const raw = await evaluate(optionsSess, expr);
    try { return JSON.parse(String(raw)); } catch { return { ok: false, error: String(raw ?? "no response") }; }
  };

  const runPython = async (code: string) => {
    const expr = `(async()=>{const r=await chrome.runtime.sendMessage({type:"python.execute",code:${JSON.stringify(code)},stdin:""});return JSON.stringify(r);})()`;
    const raw = await evaluate(ntpSess, expr);
    try { return JSON.parse(String(raw)); } catch { return { ok: false, error: String(raw ?? "no response") }; }
  };

  // 1. Initial State: wheel.list is empty
  const initialList = await sendMessageOptions({ type: "wheel.list" });
  check("wheel.list initially returns array", Array.isArray(initialList?.wheels), initialList);
  check("no wheels installed initially", initialList?.wheels?.length === 0, initialList);

  // 2. Negative Control: disguised binary wheel (.so file inside) must be rejected
  const disguisedBinary = makeWheelZip([
    { name: "bad_pkg/__init__.py", content: "import bad_pkg.native\n" },
    { name: "bad_pkg/native.so", content: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) },
    { name: "bad_pkg-1.0.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);
  const badPut = await sendMessageOptions({
    type: "wheel.put",
    name: "bad_pkg-1.0.0-py3-none-any.whl",
    bytes: Array.from(disguisedBinary),
  });
  check("disguised binary wheel rejected by content", badPut?.ok === false && badPut?.refused === "binary-wheel-rejected", badPut);

  // 3. Negative Control: path-traversal wheel must be rejected
  const traversalWheel = makeWheelZip([
    { name: "../../bad_pkg/__init__.py", content: "x = 1\n" },
    { name: "bad_pkg-1.0.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);
  const traversalPut = await sendMessageOptions({
    type: "wheel.put",
    name: "bad_pkg-1.0.0-py3-none-any.whl",
    bytes: Array.from(traversalWheel),
  });
  check("path-traversal wheel rejected", traversalPut?.ok === false && traversalPut?.refused === "path-traversal-rejected", traversalPut);

  // 4. Clean Run BEFORE install: import fails
  const beforeInstall = await runPython(`
try:
    import offline_greeter
    print('unexpected')
except Exception as e:
    print("BEFORE_EXC:", type(e).__name__, str(e))
`);
  check("module missing before wheel install",
    beforeInstall?.ok === true && String(beforeInstall?.stdout).includes("BEFORE_EXC: ModuleNotFoundError"),
    beforeInstall);

  // 5. Install valid pure-Python wheel via wheel.put
  const pureWheel = makeWheelZip([
    {
      name: "offline_greeter/__init__.py",
      content: "def greet(name):\n    return f'Hello offline, {name}!'\n",
    },
    {
      name: "offline_greeter-1.0.0.dist-info/WHEEL",
      content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    },
  ]);
  const putResult = await sendMessageOptions({
    type: "wheel.put",
    name: "offline_greeter-1.0.0-py3-none-any.whl",
    bytes: Array.from(pureWheel),
  });
  check("pure wheel ingested successfully", putResult?.ok === true && typeof putResult?.digest === "string", putResult);
  const installedDigest = String(putResult?.digest ?? "");

  // 6. Verify wheel is listed
  const listAfterPut = await sendMessageOptions({ type: "wheel.list" });
  check("wheel.list contains the installed wheel",
    Array.isArray(listAfterPut?.wheels) && listAfterPut.wheels.some((w: any) => w.digest === installedDigest),
    listAfterPut);

  // 7. Run Python in a FRESH worker: unpacks wheel and executes offline
  const runWithWheel = await runPython(`
try:
    import offline_greeter
    print(offline_greeter.greet('CAP'))
except Exception as e:
    print("RUN_EXC:", type(e).__name__, str(e))
`);
  check("fresh worker unpacks wheel and runs code offline",
    runWithWheel?.ok === true && String(runWithWheel?.stdout).trim() === "Hello offline, CAP!",
    runWithWheel);

  // 8. Delete the wheel from OPFS via wheel.delete
  const deleteResult = await sendMessageOptions({
    type: "wheel.delete",
    digest: installedDigest,
  });
  check("wheel deleted cleanly from OPFS", deleteResult?.ok === true, deleteResult);

  // Verify list is empty again
  const listAfterDelete = await sendMessageOptions({ type: "wheel.list" });
  check("wheel.list no longer contains the deleted wheel",
    Array.isArray(listAfterDelete?.wheels) && listAfterDelete.wheels.length === 0,
    listAfterDelete);

  // 9. PROVE PER-RUN ISOLATION (Coord Mandate):
  // Run Python in the NEXT fresh worker: must fail with ModuleNotFoundError because the wheel was deleted!
  const runAfterDelete = await runPython(`
try:
    import offline_greeter
    print('unexpected')
except Exception as e:
    print("AFTER_DELETE_EXC:", type(e).__name__, str(e))
`);
  check("next fresh worker fails with ModuleNotFoundError after wheel deletion (per-run isolation proven)",
    runAfterDelete?.ok === true && String(runAfterDelete?.stdout).includes("AFTER_DELETE_EXC: ModuleNotFoundError"),
    runAfterDelete);

} finally {
  try { ws.close(); } catch {}
  await teardownChrome(proc, profile);
  try { await Deno.remove(profile, { recursive: true }); } catch {}
}

console.log(`\nKAT COMPLETE: ${pass} passed, ${fail} failed.`);
if (fail > 0) Deno.exit(1);

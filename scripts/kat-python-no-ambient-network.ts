// scripts/kat-python-no-ambient-network.ts — the Python interpreter has NO
// ambient network reach (bead chrome-agent-platform-4p7j.1).
//
// Why this harness exists at all: the property it protects was measured ABSENT
// on 2026-09-06. Through this same route, `import js` exposed fetch,
// XMLHttpRequest, WebSocket, EventSource, importScripts, Worker, indexedDB and
// caches, and a real cross-origin request returned a status — it left the
// browser. The worker runs at the chrome-extension:// origin and the extension
// holds host_permissions <all_urls>, so model-authored Python could reach any
// origin with the extension's privileges and leave nothing in the transcript.
//
// The assertions CALL each name rather than checking that it exists. Presence
// is not the test — power is. An earlier cut of the guard left `js.fetch`
// resolving to None: a `hasattr` check would have called that a pass while the
// error a caller actually saw ("'NoneType' object is not callable") taught
// nothing. So each name must be present AND must refuse, with a message that
// says what to do instead.
//
// When the permissioned proxy bridge lands (bead chrome-agent-platform-4p7j.2)
// this harness stays exactly as it is: the bridge grants network through an
// explicit per-origin route, never by restoring an ambient global. If a future
// change makes any name below callable again, that is the regression this
// exists to catch.
//
//   deno run -A scripts/kat-python-no-ambient-network.ts

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 800)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DENIED = [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "importScripts", "Worker", "SharedWorker", "WebTransport",
];

const profile = chromeProfileDir("kat-python-no-ambient-network");
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

  // A service worker does not receive its OWN chrome.runtime.sendMessage, so the
  // route is driven from a real extension page, exactly as the product does.
  const page = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const sess = (await send("Target.attachToTarget", { targetId: page.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, sess);
  await sleep(2500);

  const runPython = async (code: string) => {
    const expr = `(async()=>{const r=await chrome.runtime.sendMessage({type:"python.execute",code:${JSON.stringify(code)},stdin:""});return JSON.stringify(r);})()`;
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sess);
    const raw = r?.result?.result?.value;
    try { return JSON.parse(String(raw)); } catch { return { ok: false, error: String(raw ?? "no response") }; }
  };

  const baseline = await runPython(`print("python-ok")`);
  check("python still runs (the strip must not break the interpreter)",
    baseline?.ok === true && String(baseline.stdout ?? "").includes("python-ok"), baseline);

  // Each name must REFUSE when called. `absent` also passes — the property is
  // "no ambient network", not "a guard object exists".
  const denials = await runPython(`
import js
for n in ${JSON.stringify(DENIED)}:
    fn = getattr(js, n, None)
    if fn is None:
        print(n + "=absent")
        continue
    try:
        fn("https://example.com/cap-kat-probe")
        print(n + "=CALLABLE")
    except Exception:
        print(n + "=denied")
try:
    js.navigator.sendBeacon("https://example.com/cap-kat-probe", "x")
    print("sendBeacon=CALLABLE")
except Exception:
    print("sendBeacon=denied")
`);
  const out = String(denials?.stdout ?? "");
  for (const name of [...DENIED, "sendBeacon"]) {
    check(`${name} is not callable from Python`,
      out.includes(`${name}=denied`) || out.includes(`${name}=absent`), out.slice(0, 400));
  }

  // The gate: a real cross-origin request must not reach the network. Before the
  // guard this printed "REACHED status: 404" — the request left the browser.
  const gate = await runPython(`
import js
try:
    resp = await js.fetch("https://example.com/cap-kat-probe")
    print("REACHED status:", resp.status)
except Exception as e:
    print("BLOCKED:", str(e)[:200])
`);
  const gateOut = String(gate?.stdout ?? "");
  check("a real cross-origin request from Python does NOT reach the network",
    gateOut.startsWith("BLOCKED:") && !gateOut.includes("REACHED"), gateOut.slice(0, 300));
  check("the refusal TEACHES what to do instead (not a bare null-call error)",
    /no ambient network access/i.test(gateOut) && !/NoneType/.test(gateOut), gateOut.slice(0, 300));

  // The strip must not cost the offline install path the feature is built on.
  const install = await runPython(`
import io, zipfile, site
import pyodide_js
from pyodide.ffi import to_js
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("cap_kat_mod/__init__.py", "VALUE='installed'")
pyodide_js.unpackArchive(to_js(buf.getvalue()), "zip", extract_dir=site.getsitepackages()[0])
import cap_kat_mod
print("install:", cap_kat_mod.VALUE)
`);
  check("the offline module-install path still works after the strip",
    String(install?.stdout ?? "").includes("install: installed"), install);
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);

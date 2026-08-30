// kat-notify-icon.ts — live-browser KAT for CAP-FB-20260830-NOTIFY-ICON-PATH-01.
// `notifications` is a WARNING permission, so headless Chrome auto-denies the
// JIT request and the journey suite can only assert the honest denial. This
// harness seeds the grant into a FRESH profile's extension prefs BEFORE launch
// (the extension id of an unpacked extension is sha256(path) in the a–p
// alphabet), then drives the REAL `notify` tool through the REAL executor route
// (agent-worker.tool) from an extension page and asserts
// `{ ok: true, notificationId }` — the exact call that failed with
// "Unable to download all specified images." while the default icon path was
// wrong.
//
//   deno run -A scripts/kat-notify-icon.ts [<path-to-extension>] [<out-dir>]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-notify-icon`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// Chrome's id for an unpacked extension: sha256 of the absolute path, first 32
// hex digits, each mapped 0-9a-f → a-p.
async function unpackedExtensionId(path: string): Promise<string> {
  const abs = await Deno.realPath(path);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(abs)));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

const profile = `${ROOT}.cache/kat-notify-icon-profile-${Date.now()}`;
const expectedId = await unpackedExtensionId(EXT);
const perms = { api: ["notifications"], explicit_host: [], manifest_permissions: [], scriptable_host: [] };
const prefs = { extensions: { settings: { [expectedId]: { granted_permissions: perms, active_permissions: perms } } } };
await Deno.mkdir(`${profile}/Default`, { recursive: true });
await Deno.writeTextFile(`${profile}/Default/Preferences`, JSON.stringify(prefs));
await Deno.writeTextFile(`${profile}/Default/Secure Preferences`, JSON.stringify(prefs));

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = () => r(null); });
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const evalIn = async (expr: string, sid: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  return r?.result?.result?.value;
};

let code = 1;
try {
  const sw = await waitForServiceWorker(send);
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;
  check("seeded profile: the computed unpacked id matches the loaded extension", extId === expectedId, { extId, expectedId });
  const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const { result: { sessionId: pageSession } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, pageSession);
  await sleep(1500);

  const granted = await evalIn(`chrome.permissions.contains({ permissions: ["notifications"] })`, pageSession);
  check("seeded profile: notifications is granted at boot", granted === true, granted);

  const res = await evalIn(`chrome.runtime.sendMessage({ type: "agent-worker.tool", toolName: "notify", args: { title: "KAT", message: "notify icon path" } }).then(v => ({ v }), e => ({ err: String(e?.message ?? e) }))`, pageSession);
  const out = res?.v ?? res;
  console.log("notify ->", JSON.stringify(out));
  await Deno.writeTextFile(`${OUT}/notify-result.json`, JSON.stringify(out, null, 2));
  check("notify: returns ok with notifications seeded", out?.ok === true && typeof out?.notificationId === "string", out);

  // Headless Chrome has no notification surface, so notifications.create does
  // NOT download the icon there and the call above succeeds even with a wrong
  // path (observed: the pre-fix build also returned ok here). The discriminating
  // browser check is therefore the resource itself: every packaged icon path
  // the BUILT service worker hands to getURL must be fetchable from the
  // extension origin — a missing file is the "Unable to download all specified
  // images." failure a headed Chrome reports.
  const bundle = await Deno.readTextFile(`${EXT}/dist/background/service-worker.js`);
  const iconPaths = [...new Set([...bundle.matchAll(/getURL\(\s*["'](icons\/[^"']+)["']\s*\)/g)].map((m) => m[1]))];
  const fetched = await evalIn(`Promise.all(${JSON.stringify(iconPaths)}.map(async (p) => {
    try { const r = await fetch(chrome.runtime.getURL(p)); return { p, ok: r.ok, type: r.headers.get("content-type") }; }
    catch (e) { return { p, ok: false, err: String(e?.message ?? e) }; }
  }))`, pageSession);
  console.log("icon paths ->", JSON.stringify(fetched));
  check(
    "notify: every packaged icon path the built worker references is fetchable from the extension origin",
    iconPaths.length > 0 && Array.isArray(fetched) && fetched.length === iconPaths.length && fetched.every((f: any) => f.ok === true),
    fetched,
  );
  code = fail === 0 ? 0 : 1;
} catch (e) {
  console.log(`FAIL: harness error — ${String((e as Error)?.message ?? e)}`);
} finally {
  try { ws.close(); } catch { /* closed */ }
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}
console.log(`kat-notify-icon: ${pass} pass, ${fail} fail`);
Deno.exit(code);

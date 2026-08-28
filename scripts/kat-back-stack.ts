// kat-back-stack.ts — CAP-FB-20260826-BACK-STACK-02 KAT (real browser).
// The first back-stack fix (0.2.296) changed the OPTIONS iframe's internal
// navigationController, but the real bug lives in the TOP frame's joint session
// history: `viewFrame.src = "about:blank"` on close + `viewFrame.src = url` on
// open both append joint-history entries, so Back from Artifacts/Directory
// needed TWO presses (a blank intermediate). This harness loads the REAL
// extension, opens each view, presses Back once, and asserts the overlay is
// hidden (returned to the hub) in a single step.
//
//   deno run -A scripts/kat-back-stack.ts <path-to-extension>
//
// Defaults to the in-repo extension dir.

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const PORT = 9344;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-back-stack-${Date.now()}`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();

const wsUrl = await new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no devtools url")), 15000);
  (async () => { for (;;) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); clearTimeout(t); resolve(j.webSocketDebuggerUrl); return; } catch { await sleep(300); } } })();
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

const { result: { targetInfos } } = await send("Target.getTargets");
const sw = targetInfos.find((t: any) => t.type === "service_worker");
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
await sleep(3000);

// Open each view, press Back once, assert the overlay is hidden.
const flows: Array<[string, string]> = [
  ["Settings", `document.getElementById('open-settings')?.click()`],
  ["Artifacts", `document.getElementById('open-artifacts')?.click()`],
  ["Directory", `document.getElementById('open-directory')?.click()`],
];
for (const [name, open] of flows) {
  await ev(open);
  await sleep(2200);
  const openHidden = await ev(`document.getElementById('view')?.hidden`);
  check(`${name}: opens (overlay visible)`, openHidden === false, { openHidden });
  await ev(`history.back()`);
  await sleep(1200);
  const hidden = await ev(`document.getElementById('view')?.hidden`);
  const hash = await ev(`location.hash`);
  check(`${name}: one Back returns to hub (overlay hidden)`, hidden === true, { hidden, hash });
}

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);

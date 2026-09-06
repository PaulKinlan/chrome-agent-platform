// kat-provider-keyed-strip.ts — the KEYED proof for the recommended flow
// (CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01). Sets OpenAI + a real key
// via provider.set, then confirms provider.status is Ready with gpt-5.6-luna,
// the hub strip reads "Ready — OpenAI · gpt-5.6-luna", and drives one real run.
//
// The key is read from OPENAI_API_KEY, sent once over the local CDP socket, and
// NEVER printed, logged, screenshotted or written to disk.
//
//   set -a; . ~/.env; set +a
//   deno run -A scripts/kat-provider-keyed-strip.ts extension .cache/kat-keyed

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-keyed`;
const CHROMIUM = "/usr/bin/chromium";
const KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODEL = Deno.env.get("CAP_LIVE_MODEL") ?? "gpt-5.6-luna";
if (!KEY) { console.error("needs OPENAI_API_KEY in the environment"); Deno.exit(2); }

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${chromeProfileDir("kat-keyed")}`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

const sw = await waitForServiceWorker(send);
if (!sw) { console.log("FAIL: no service worker target"); proc.kill(); Deno.exit(1); }
const extId = new URL(sw.url).host;

// attach helper: open a target + flat session.
async function attach(url: string) {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  return sessionId as string;
}
// evalSilent: never echoes the expression (it may carry the key).
const evalOn = async (sid: string, expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value;
const shotOn = async (sid: string, path: string) => {
  const { result } = await send("Page.captureScreenshot", { format: "png" }, sid);
  await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
};
await Deno.mkdir(OUT, { recursive: true });

// provider.set is restricted to the OPTIONS surface (owner-options principal) —
// send it from the real options page, exactly as the Use click does. The key is
// embedded ONLY in this one message and is never printed.
const optSid = await attach(`chrome-extension://${extId}/options/options.html`);
await sleep(2500);
const setRes = await evalOn(optSid,
  `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "openai", baseURL: "https://api.openai.com/v1", model: ${JSON.stringify(MODEL)}, apiKey: ${JSON.stringify(KEY)} } }).then((r) => ({ ok: !(r && r.ok === false), provider: r.provider, hasApiKey: r.hasApiKey }))`,
);
check("provider.set persisted OpenAI + key (key never printed)", setRes?.ok === true && setRes?.provider === "openai" && setRes?.hasApiKey === true, { provider: setRes?.provider, hasApiKey: setRes?.hasApiKey });

const status = await evalOn(optSid, `chrome.runtime.sendMessage({ type: "provider.status" })`);
check("provider.status is Ready with the recommended model", status?.ok === true && status?.modelId === MODEL, { ok: status?.ok, modelId: status?.modelId, reason: status?.reason });

// The hub strip reads "Ready — OpenAI · <model>".
const sessionId = await attach(`chrome-extension://${extId}/ntp/ntp.html`);
const evalSilent = (expr: string) => evalOn(sessionId, expr);
const shot = (path: string) => shotOn(sessionId, path);
await sleep(3000);
const strip = await evalSilent(`(() => { const s = document.getElementById('provider-status'); return { text: s?.textContent ?? null, ready: s?.classList?.contains('ready') }; })()`);
check(`the hub strip reads "Ready — OpenAI · ${MODEL}"`, strip?.text === `Ready — OpenAI · ${MODEL}` && strip?.ready === true, strip);
await shot(`${OUT}/hub-ready-strip.png`);

// One real run: "open a new tab with https://example.com and tell me its title".
await evalSilent(`(() => {
  const c = document.getElementById('composer');
  if (c?.setValue) c.setValue('open a new tab with https://example.com and tell me its title');
  else { const ta = c?.querySelector('textarea'); if (ta) { ta.value = 'open a new tab with https://example.com and tell me its title'; ta.dispatchEvent(new Event('input', { bubbles: true })); } }
  c?.focusInput?.();
  return true;
})()`);
await sleep(500);
await evalSilent(`(() => {
  const c = document.getElementById('composer');
  const form = c?.querySelector('form') || c;
  const btn = c?.querySelector('button[type="submit"], .send, [data-send]');
  if (btn) btn.click();
  else form?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
// Give the run up to ~90s to settle. The proof for THIS entry is that the KEYED
// provider round-trips and the model drives a tool: either it answers "Example
// Domain", OR it reports the honest browser-control error (a fresh headless
// profile cannot grant the tab-open approval — CAP-FB-20260829-SILENT-PROVIDER-
// RUN-01; that grant is out of this entry's scope). A frozen "[demo model]" or
// "returned no content" is the failure this entry removes.
let responded = false, answered = false, transcript = "";
for (let i = 0; i < 45; i++) {
  await sleep(2000);
  transcript = await evalSilent(`(document.body?.innerText || "")`) ?? "";
  if (/example domain/i.test(transcript)) { answered = true; responded = true; break; }
  if (/browser-control|could(?:n't| not) open the tab|approval expired/i.test(transcript)) { responded = true; break; }
}
check("the keyed run reaches the model (no [demo model], no 'returned no content')",
  responded && !/\[demo model\]|returned no content/i.test(transcript),
  { answered, respondedWithToolAttempt: responded });
await shot(`${OUT}/hub-first-answer.png`);

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);

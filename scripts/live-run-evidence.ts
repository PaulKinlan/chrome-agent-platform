// scripts/live-run-evidence.ts — drive a REAL task through the loaded extension
// and report what the transcript actually rendered.
//
// The unit suite and the component gallery both exercise the tool cards against
// constructed payloads. This drives the whole path instead: a real composer
// send, a real dispatch, the real run log, and the real cards — which is the
// only way to catch a defect that lives in the seam between them (the
// `execute_tool` envelope leaking into the transcript was exactly that).
//
// Usage:
//   deno run -A scripts/live-run-evidence.ts ["your prompt"]
//     → the DEMO provider: local, no network, no host permission. The default,
//       and what CI can run.
//   CAP_LIVE_PROVIDER=anthropic ANTHROPIC_API_KEY=... deno run -A scripts/live-run-evidence.ts
//     → a real keyed provider. NOTE: a keyed provider needs the extension's
//       OPTIONAL host permission for the provider origin, which a fresh
//       headless profile cannot grant (Chrome's prompt has no one to answer
//       it). See CAP-FB-20260829-SILENT-PROVIDER-RUN-01.
//
// The key is read from the environment, sent once over the local CDP socket,
// and redacted from every line this script prints. It is never written to disk.
//
// Port discipline: this launches with --remote-debugging-port=0 and reads the
// real port off the DevTools line, so it can never attach to another lane's
// browser (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
const CHROMIUM = "/usr/bin/chromium";
const EXT = "/home/paulkinlan/chrome-agent-platform/extension";
const SHOTS = Deno.env.get("CAP_EVIDENCE_DIR") ?? "./evidence/live-run";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WANT_REAL = Deno.env.get("CAP_LIVE_PROVIDER") === "anthropic";
const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
if (WANT_REAL && !KEY) { console.error("CAP_LIVE_PROVIDER=anthropic needs ANTHROPIC_API_KEY"); Deno.exit(1); }
const MODEL = Deno.env.get("CAP_LIVE_MODEL") ?? "claude-sonnet-4-5-20250929";
const PROMPT = Deno.args.join(" ") || "List my open tabs, then tell me what is open.";

await Deno.mkdir(SHOTS, { recursive: true });
const profile = await Deno.makeTempDir({ prefix: "live-run-" });
const proc = new Deno.Command(CHROMIUM, {
  args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--window-size=1440,1600",
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
if (!port) { console.error("no devtools port"); proc.kill("SIGKILL"); Deno.exit(1); }

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map<number, (v: any) => void>();
const logs: string[] = [];
ws.onmessage = (e) => {
  const d = JSON.parse(e.data as string);
  if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); return; }
  // Console + uncaught errors from EVERY attached target — the fastest way to
  // see why a send is dropped without guessing at the handler.
  if (d.method === "Runtime.consoleAPICalled") {
    const args = (d.params?.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ");
    logs.push(`[${d.params?.type}] ${args}`.slice(0, 400));
  }
  if (d.method === "Runtime.exceptionThrown") {
    const ex = d.params?.exceptionDetails;
    logs.push(`[EXCEPTION] ${ex?.exception?.description ?? ex?.text ?? "?"}`.slice(0, 600));
  }
};
const send = (m: string, p: any = {}, s?: string) =>
  new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });

// ---- attach to the service worker and configure the provider ----
let swTarget: any = null;
for (let i = 0; i < 40 && !swTarget; i++) {
  const t = await send("Target.getTargets");
  swTarget = t.result.targetInfos.find((x: any) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
  if (!swTarget) await sleep(250);
}
if (!swTarget) { console.error("no service worker"); proc.kill("SIGKILL"); Deno.exit(1); }
const extId = new URL(swTarget.url).host;
const swSession = (await send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true })).result.sessionId;
await send("Runtime.enable", {}, swSession);

const evalSw = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, swSession);
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
  return r?.result?.result?.value;
};

// The provider is configured from a PAGE context: chrome.runtime.sendMessage
// inside the service worker has no receiver (it would be messaging itself),
// which is why the first attempt returned "Receiving end does not exist".
const optsTarget = (await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` })).result.targetId;
const optsSession = (await send("Target.attachToTarget", { targetId: optsTarget, flatten: true })).result.sessionId;
await send("Runtime.enable", {}, optsSession);
await sleep(1500);
const evalOpts = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, optsSession);
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
  return r?.result?.result?.value;
};
const setProvider = await evalOpts(`chrome.runtime.sendMessage(${JSON.stringify({
  type: "provider.set",
  config: WANT_REAL
    ? { provider: "anthropic", apiKey: KEY, model: MODEL }
    : { provider: "demo" },
})})`);
console.log("provider.set ->", JSON.stringify(setProvider)?.replace(KEY || "\u0000never", "<redacted>"));
const got = await evalOpts(`chrome.runtime.sendMessage({ type: "provider.get" })`);
console.log("provider.get ->", JSON.stringify(got)?.replace(KEY || "\u0000never", "<redacted>"));
await send("Target.closeTarget", { targetId: optsTarget });

// ---- open the hub and run a real task ----
const page = (await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` })).result.targetId;
const pageSession = (await send("Target.attachToTarget", { targetId: page, flatten: true })).result.sessionId;
await send("Runtime.enable", {}, pageSession);
await send("Page.enable", {}, pageSession);
await sleep(2500);

const evalPage = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, pageSession);
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
  return r?.result?.result?.value;
};

// A couple of extra tabs so list_tabs has something real to report.
await send("Target.createTarget", { url: "https://example.com/" });
await send("Target.createTarget", { url: "https://example.org/" });
await sleep(1200);

console.log("\nprompt:", PROMPT);
// Type with REAL CDP input events into the focused composer. Writing the
// textarea's .value from script did not reach the element the component holds
// in this._input, so _send() saw an empty string and returned silently.
const focused = await evalPage(`(() => {
  const c = document.getElementById('composer');
  if (!c) return 'NO_COMPOSER';
  if (typeof c.focusInput === 'function') { c.focusInput(); return 'FOCUSED_VIA_API'; }
  const root = c.shadowRoot ?? c;
  const ta = root.querySelector('textarea, input[type=text]');
  if (!ta) return 'NO_INPUT';
  ta.focus();
  return 'FOCUSED_DIRECT';
})()`);
console.log("focus ->", focused);
await send("Input.insertText", { text: PROMPT }, pageSession);
await sleep(400);
const started = await evalPage(`(() => {
  const c = document.getElementById('composer');
  const root = c.shadowRoot ?? c;
  const ta = root.querySelector('#task-input');
  if (!ta || !ta.value.trim()) return 'INPUT_EMPTY';
  const run = root.querySelector('#run-task');
  if (!run) return 'NO_RUN_BUTTON';
  // Read the length BEFORE clicking — the send clears the input, so reading
  // afterwards always reports 0.
  const typed = ta.value.length;
  run.click();
  return 'SENT(' + typed + ' chars typed)';
})()`);
console.log("composer ->", started);

// ---- wait for the run to settle ----
let settled = false;
for (let i = 0; i < 90 && !settled; i++) {
  await sleep(2000);
  const state = await evalPage(`(() => {
    const roots = [document, ...[...document.querySelectorAll('*')].map(e => e.shadowRoot).filter(Boolean)];
    const cards = roots.flatMap(r => [...r.querySelectorAll('details.tool')]);
    const running = cards.filter(c => (c.querySelector('.tool-status')?.textContent ?? '').includes('running')).length;
    const bubbles = document.querySelectorAll('message-bubble').length;
    const statusEl = document.querySelector('[role=status], .run-status, #run-status');
    return JSON.stringify({ cards: cards.length, running, bubbles,
      status: statusEl?.textContent?.trim()?.slice(0,120) ?? null,
      names: cards.map(c => c.querySelector('.tool-name')?.textContent),
      // Read the CONVERSATION, through its shadow root, bubble by bubble.
      // An earlier version of this probe sampled document.body.innerText and
      // concluded the product had rendered nothing, when in fact it had
      // rendered a correct error inside the shadow DOM. A harness that can
      // report "nothing happened" when something did is worse than no harness.
      convo: (() => {
        const el = document.getElementById('thread-conversation');
        const r = el?.shadowRoot ?? el;
        if (!r) return 'NO_CONTAINER';
        return [...r.children].map(b => {
          const br = b.shadowRoot ?? b;
          const body = br.querySelector('.body, .msg');
          return (b.getAttribute('role') || b.tagName.toLowerCase()) + ': ' + (body?.textContent ?? '').trim().slice(0, 200);
        }).join(' | ').slice(0, 900);
      })() });
  })()`);
  const s = typeof state === "string" ? JSON.parse(state) : null;
  if (i % 3 === 0) console.log(`  t+${(i + 1) * 2}s`, JSON.stringify(s));
  if (s && s.cards > 0 && s.running === 0 && s.bubbles >= 2) settled = true;
}
console.log("settled:", settled);
console.log("\n=== page/SW console (last 30) ===");
for (const l of logs.slice(-30)) console.log("  " + l.replace(KEY || "\u0000never", "<redacted>"));

// ---- what did the REAL transcript render? ----
const dump = await evalPage(`(() => {
  const roots = [document, ...[...document.querySelectorAll('*')].map(e => e.shadowRoot).filter(Boolean)];
  const cards = roots.flatMap(r => [...r.querySelectorAll('details.tool')]);
  return JSON.stringify(cards.map(c => {
    const head = c.querySelector('.tool-head');
    const blocks = [...c.querySelectorAll('.tt-block')].map(b => ({
      label: b.querySelector('.tt-block-label')?.textContent,
      rows: [...b.querySelectorAll('.tt-row')].filter(r => !r.hidden).slice(0, 6).map(r => ({
        key: r.querySelector('.tt-key')?.textContent,
        preview: r.querySelector('.tt-preview')?.textContent ?? null,
        val: r.querySelector('.tt-val')?.textContent ?? null,
      })),
      hasRaw: !!b.querySelector('.tt-raw-toggle'),
      hasCopy: !!b.querySelector('.tt-copy-all'),
    }));
    return {
      name: c.querySelector('.tool-name')?.textContent,
      lead: c.querySelector('.tool-lead')?.textContent ?? null,
      status: c.querySelector('.tool-status')?.textContent,
      open: c.open,
      heightClosed: null,
      blocks,
    };
  }), null, 1);
})()`);
console.log("\n=== REAL tool cards ===\n" + dump);

// Envelope leakage is the owner's exact original complaint — assert on the
// rendered text, not on what the code is supposed to do.
const leak = await evalPage(`(() => {
  const roots = [document, ...[...document.querySelectorAll('*')].map(e => e.shadowRoot).filter(Boolean)];
  const t = roots.map(r => r === document ? document.body.innerText : (r.textContent ?? '')).join(' ');
  const hits = [];
  for (const marker of ['execute_tool', 'selectionRef', 'modelContent', 'requiresLiveAuthorization', 'was not safely serializable', '{keys}']) {
    if (t.includes(marker)) hits.push(marker);
  }
  return JSON.stringify(hits);
})()`);
console.log("\nenvelope leakage in the visible transcript:", leak);

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, pageSession);
if (shot?.result?.data) {
  await Deno.writeFile(`${SHOTS}/live-run.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  console.log("captured live-run.png");
}

try { proc.kill("SIGKILL"); } catch { /* gone */ }
await Deno.remove(profile, { recursive: true }).catch(() => {});
Deno.exit(0);

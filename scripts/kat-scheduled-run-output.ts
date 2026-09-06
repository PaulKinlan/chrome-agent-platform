// kat-scheduled-run-output.ts — CAP-FB-20260830-SCHEDULED-RUN-OUTPUT-01.
//
// A scheduled agent used to run and leave nothing the owner could see. This
// KAT drives a REAL scheduled named-agent run in a loaded extension (a live
// alarm, accelerated only in its timing) and asserts the three things a
// returning owner must find:
//   (a) a row on the hub timeline with its outcome, on REOPEN, no navigation;
//   (b) a retrievable result — the keyed `scheduled-report:<slug>` artifact;
//   (c) a chrome.notifications completion notification whose click opens the agent.
//
//   deno run -A scripts/kat-scheduled-run-output.ts [extension] [out-dir]
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-scheduled-run-output`;
const CHROME =
  "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";
const STAMP = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

await Deno.mkdir(OUT, { recursive: true });
const { proc, wsUrl } = await launchChrome({
  binary: CHROME,
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", "--window-size=1440,1600",
    `--user-data-dir=${chromeProfileDir("kat-scheduled-run-output")}`,
    "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.onopen = r);
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
const send = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params, sessionId })); });

try {
  const worker = await waitForServiceWorker(send, {
    timeoutMs: 15000,
    match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"),
  });
  if (!worker) throw new Error("service worker did not register");
  const extensionId = new URL(worker.url).host;

  const openPage = async (url: string) => {
    const created = await send("Target.createTarget", { url });
    const targetId = created.result.targetId;
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.result.sessionId;
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    const evaluate = async (expr: string) =>
      (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
    const screenshot = async (name: string) => {
      const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      await Deno.writeFile(`${OUT}/${name}`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
    };
    const clickPoint = async (point: { x: number; y: number } | null) => {
      if (!point) return false;
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
      return true;
    };
    return { targetId, sessionId, evaluate, screenshot, clickPoint };
  };

  const ntp = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html`);
  await sleep(2500);
  const prompt = `@demo-tools scheduled probe ${STAMP}`;
  const seeded = await ntp.evaluate(`(async () => {
    const send = (m) => chrome.runtime.sendMessage(m);
    await send({ type: 'kv.set', values: { 'cap:developerFeatures': true } });
    const created = await send({ type: 'named-agent.create', name: 'Tab Reporter', role: 'Report scheduled work concisely.' });
    const id = created.agent.id;
    const scheduled = await send({ type: 'named-agent.set-schedule', id, periodInMinutes: 1, task: ${JSON.stringify(prompt)} });
    return { id, name: created.agent.name, ok: created.ok && scheduled.ok };
  })()`);
  check("real named agent + recurring schedule created", seeded?.ok === true, seeded);

  // NOTE on the completion notification: the `notifications` permission is
  // OPTIONAL and its grant prompt has NO UI to accept under `--headless`
  // (chrome.permissions.request hangs), and an alarm is dispatched to a FRESH
  // service-worker instance so a monkeypatched permission gate never reaches
  // the alarm handler. The notification wiring (the shipped icon path, the
  // bounded message, and the click routing to the AGENT surface) is therefore
  // verified deterministically in tests/scheduled-run-report.test.ts
  // (SCHEDULED-NOTIFY). This KAT drives the two things that ARE observable in a
  // real headless run: the retrievable artifact and the timeline row.
  console.log("NOTE: completion notification wiring is unit-covered (SCHEDULED-NOTIFY) — not headless-observable.");
  const targets = await send("Target.getTargets");
  const liveWorker = targets.result.targetInfos.find((t: any) => t.type === "service_worker" && t.url.includes("dist/background"));
  const swAttached = await send("Target.attachToTarget", { targetId: liveWorker.targetId, flatten: true });
  const swSession = swAttached.result.sessionId;
  await send("Runtime.enable", {}, swSession);
  const swEval = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, swSession)).result?.result?.value;

  // Accelerate ONLY the alarm timing; the persisted schedule stays recurring
  // and the real alarm handler/run path is unchanged.
  await swEval(`chrome.alarms.create(${JSON.stringify(`agent:${seeded.id}`)}, { when: Date.now() + 800 })`);

  let fired: any = null;
  for (let i = 0; i < 40; i++) {
    fired = await ntp.evaluate(`chrome.runtime.sendMessage({ type: 'run.list' }).then(r =>
      (r?.runs ?? []).find(run => run.scheduleName === ${JSON.stringify(`agent:${seeded.id}`)} && run.phase === 'terminal') ?? null)`);
    if (fired) break;
    await sleep(500);
  }
  check("the accelerated scheduled agent run reaches durable terminal state", Boolean(fired), fired);

  // (b) retrievable result — the keyed report artifact in the hub store.
  let report: any = null;
  for (let i = 0; i < 20; i++) {
    report = await ntp.evaluate(`(async () => {
      const send = (m) => chrome.runtime.sendMessage(m);
      const list = await send({ type: 'asset.list', origin: 'master' });
      const row = (list?.assets ?? []).find(a => a.pk === 'scheduled-report:' + ${JSON.stringify(seeded.id)}) ?? null;
      if (!row) return null;
      const full = await send({ type: 'asset.get', origin: 'master', id: row.id });
      return { id: row.id, type: row.type, name: row.name, content: full?.asset?.content ?? full?.content ?? '' };
    })()`);
    if (report) break;
    await sleep(500);
  }
  check("a keyed scheduled-report artifact exists after the alarm fires", Boolean(report) && report.type === "text", report && { id: report.id, type: report.type, name: report.name });
  check("the report artifact carries the run's outcome text", Boolean(report?.content) && String(report.content).includes("[demo model]"), report?.content?.slice?.(0, 120));

  // (a) the hub timeline row appears on REOPEN, no navigation.
  const ntp2 = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html`);
  await sleep(4000);
  const timeline = await ntp2.evaluate(`(() => {
    const el = document.getElementById('hub-timeline');
    const entries = el?.entries ?? [];
    return { sectionHidden: document.getElementById('timeline-section')?.hasAttribute('hidden'), entries };
  })()`);
  const row = (timeline?.entries ?? []).find((e: any) => e.agent === seeded.name || e.title === prompt);
  await ntp2.screenshot("hub-while-away.png");
  check("the timeline section is revealed on reopen", timeline?.sectionHidden === false, timeline?.sectionHidden);
  check("a timeline row names the scheduled agent and shows its outcome",
    Boolean(row) && row.agent === seeded.name && Boolean(row.outcome),
    row);
} finally {
  ws.close();
  try { proc.kill("SIGTERM"); } catch { /* already exited */ }
}

console.log(`\nkat-scheduled-run-output: ${pass} passed, ${fail} failed`);
if (fail) Deno.exit(1);

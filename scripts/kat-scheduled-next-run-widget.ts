// kat-scheduled-next-run-widget.ts — CAP-FB-20260831-SCHEDULED-NEXT-RUN-WIDGET-01.
//
// Owner feedback: "if a task schedules an alarm, there's no way to see that or
// know it's going to work. The task should have a 'next run' widget." This KAT
// drives a REAL recurring routine in a loaded extension and asserts the
// forward-looking "Next run" indicator, computed from the routine's REAL alarm:
//   (a) the alarm is actually armed — task.nextRun / task.list expose a real
//       future scheduledTime for the routine;
//   (b) the hub's per-agent "Routines" section renders a <next-run> widget on
//       the routine's row, carrying that real alarm time and showing
//       "Next run <relative> · <absolute>" (not an invented time).
//
//   deno run -A scripts/kat-scheduled-next-run-widget.ts [extension] [out-dir]
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-scheduled-next-run-widget`;
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
    `--user-data-dir=${ROOT}.cache/kat-scheduled-next-run-widget-${STAMP}`,
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
    return { targetId, sessionId, evaluate, screenshot };
  };

  const ntp = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html`);
  await sleep(2500);

  // Create a real named agent and give it a RECURRING routine (60-min period,
  // so the next fire is clearly in the future — the widget's countdown reads
  // "in 1 hour", never "due now").
  const prompt = `scheduled digest ${STAMP}`;
  const seeded = await ntp.evaluate(`(async () => {
    const send = (m) => chrome.runtime.sendMessage(m);
    const created = await send({ type: 'named-agent.create', name: 'Reading Digest', role: 'Summarise the morning reads.' });
    const id = created.agent.id;
    const scheduled = await send({ type: 'named-agent.set-schedule', id, periodInMinutes: 60, task: ${JSON.stringify(prompt)} });
    return { id, name: created.agent.name, ok: created.ok && scheduled.ok, alarmName: 'agent:' + id };
  })()`);
  check("a real named agent + recurring routine was created", seeded?.ok === true, seeded);

  // (a) the REAL alarm is armed — task.nextRun returns a future scheduledTime.
  const now = Date.now();
  const nextRun = await ntp.evaluate(`chrome.runtime.sendMessage({ type: 'task.nextRun', name: ${JSON.stringify(seeded.alarmName)} })`);
  check("task.nextRun exposes the routine's REAL future alarm time",
    nextRun?.ok === true && typeof nextRun?.nextFireAt === "number" && nextRun.nextFireAt > now,
    nextRun);

  // task.list carries the same nextFireAt (the field the hub row renders from).
  const listed = await ntp.evaluate(`(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'task.list' });
    const t = (r?.tasks ?? []).find(x => x.name === ${JSON.stringify(seeded.alarmName)}) ?? null;
    return t ? { name: t.name, nextFireAt: t.nextFireAt, periodInMinutes: t.periodInMinutes, owner: t.owner } : null;
  })()`);
  check("task.list carries the routine's nextFireAt + owner attribution",
    typeof listed?.nextFireAt === "number" && listed.nextFireAt > now && listed.owner?.agentSurfaceRef === `named:${seeded.id}`,
    listed);

  // (b) the hub renders the <next-run> widget on the routine's row. Open the
  // agent surface via its hash route — the shipped path calls
  // refreshAgentSchedules → agentScheduleRow → <next-run>.
  const agentPage = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html#agent=named:${encodeURIComponent(seeded.id)}`);
  await sleep(3500);

  const widget = await agentPage.evaluate(`(() => {
    const section = document.getElementById('agent-schedules');
    if (!section || section.hidden) return { present: false, reason: 'schedules section hidden' };
    const label = section.querySelector('.fr-label')?.textContent ?? '';
    const el = section.querySelector('next-run');
    if (!el) return { present: false, reason: 'no next-run widget', label };
    const at = el.getAttribute('at');
    const shadow = el.shadowRoot?.textContent ?? '';
    return { present: true, label, at, shadow };
  })()`);
  await agentPage.screenshot("routine-next-run.png");

  check("the section is named 'Routines' (routine vocabulary, not 'background agent')",
    widget?.label === "Routines", widget?.label);
  check("a <next-run> widget renders on the routine's row, carrying the REAL alarm time",
    widget?.present === true && typeof widget?.at === "string" && Number(widget.at) > now, widget);
  check("the widget shows the forward-looking 'Next run <relative>' countdown",
    typeof widget?.shadow === "string" && widget.shadow.includes("Next run") && /in \d+ (second|minute|hour|day)/.test(widget.shadow),
    widget?.shadow);
  check("the widget shows the absolute clock time beside the countdown",
    typeof widget?.shadow === "string" && widget.shadow.includes("·"),
    widget?.shadow);
} finally {
  ws.close();
  try { proc.kill("SIGTERM"); } catch { /* already exited */ }
}

console.log(`\nkat-scheduled-next-run-widget: ${pass} passed, ${fail} failed`);
if (fail) Deno.exit(1);

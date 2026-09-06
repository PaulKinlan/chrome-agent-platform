// kat-background-run-transcript.ts — real-browser regression for scheduled
// named-agent runs disappearing from that agent's conversation.
//
// Creates a real named agent + recurring schedule through the extension bus,
// accelerates the live alarm, waits for the real background run to settle,
// opens the agent with a trusted click, and asserts its scheduled turn is shown.
//
//   deno run -A scripts/kat-background-run-transcript.ts [extension] [out-dir]
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-background-run-transcript`;
const CHROME =
  "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";
const STAMP = Date.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`);
  }
}

await Deno.mkdir(OUT, { recursive: true });
const { proc, wsUrl } = await launchChrome({
  binary: CHROME,
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    "--window-size=1400,2000",
    `--user-data-dir=${chromeProfileDir("kat-background-run-transcript")}`,
    "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => ws.onopen = resolve);
let nextId = 0;
const pending = new Map<number, (value: any) => void>();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message);
    pending.delete(message.id);
  }
};
const send = (
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
) =>
  new Promise<any>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

try {
  const worker = await waitForServiceWorker(send, {
    timeoutMs: 15_000,
    match: (target: any) =>
      target.type === "service_worker" &&
      String(target.url).includes("dist/background"),
  });
  if (!worker) throw new Error("service worker did not register");
  const extensionId = new URL(worker.url).host;

  const openPage = async (url: string) => {
    const created = await send("Target.createTarget", { url });
    const targetId = created.result.targetId;
    const attached = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.result.sessionId;
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    const evaluate = async (expression: string) =>
      (await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId)).result?.result?.value;
    const screenshot = async (name: string) => {
      const shot = await send(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      );
      await Deno.writeFile(
        `${OUT}/${name}`,
        Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)),
      );
    };
    const clickPoint = async (point: { x: number; y: number } | null) => {
      if (!point) return false;
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      }, sessionId);
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      }, sessionId);
      return true;
    };
    return { targetId, sessionId, evaluate, screenshot, clickPoint };
  };

  // Grant the optional alarm capability through the real Settings control.
  const options = await openPage(
    `chrome-extension://${extensionId}/options/options.html`,
  );
  await sleep(1800);
  const grantPoint = await options.evaluate(`(() => {
    const el = document.querySelector('.grant-perm[data-capability="alarms"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await options.clickPoint(grantPoint);
  await sleep(1200);
  const granted = await options.evaluate(
    `chrome.permissions.contains({ permissions: ['alarms'] })`,
  );
  check(
    "alarms permission granted through the real Settings UI",
    granted === true,
    granted,
  );
  await send("Target.closeTarget", { targetId: options.targetId });

  const ntp = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html`);
  await sleep(2500);
  const prompt = `@demo-tools scheduled transcript probe ${STAMP}`;
  const expectedResult =
    "[demo model] Tool calls executed in sequence: memory_set wrote the shopping list, then memory_get read it back twice.";
  const seeded = await ntp.evaluate(`(async () => {
    const send = (message) => chrome.runtime.sendMessage(message);
    // the marker demo model sits behind the developer flag (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01)
    await send({ type: 'kv.set', values: { 'cap:developerFeatures': true } });
    const created = await send({ type: 'named-agent.create', name: 'Scheduled Transcript Probe', role: 'Report scheduled work concisely.' });
    if (!created?.ok) return { created };
    const id = created.agent.id;
    const scheduled = await send({ type: 'named-agent.set-schedule', id, periodInMinutes: 1, task: ${
    JSON.stringify(prompt)
  } });
    return { created, scheduled, id, name: created.agent.name };
  })()`);
  check(
    "real named agent and recurring schedule created",
    seeded?.created?.ok === true && seeded?.scheduled?.ok === true,
    seeded,
  );

  // Replace only the live alarm timing with a short one-shot. The persisted
  // schedule remains recurring and the real alarm handler/run path is unchanged.
  const targets = await send("Target.getTargets");
  const liveWorker = targets.result.targetInfos.find((target: any) =>
    target.type === "service_worker" && target.url.includes("dist/background")
  );
  if (!liveWorker) {
    throw new Error("service worker unavailable after scheduling");
  }
  const swAttached = await send("Target.attachToTarget", {
    targetId: liveWorker.targetId,
    flatten: true,
  });
  const swSession = swAttached.result.sessionId;
  await send("Runtime.enable", {}, swSession);
  await send("Runtime.evaluate", {
    expression: `chrome.alarms.create(${
      JSON.stringify(`agent:${seeded.id}`)
    }, { when: Date.now() + 800 })`,
    awaitPromise: true,
    returnByValue: true,
  }, swSession);

  let fired: any = null;
  for (let i = 0; i < 30; i++) {
    fired = await ntp.evaluate(
      `chrome.runtime.sendMessage({ type: 'run.list' }).then(r =>
      (r?.runs ?? []).find(run => run.scheduleName === ${
        JSON.stringify(`agent:${seeded.id}`)
      } && run.phase === 'terminal') ?? null)`,
    );
    if (fired) break;
    await sleep(500);
  }
  check(
    "the accelerated scheduled agent run reaches durable terminal state",
    Boolean(fired),
    fired,
  );

  await sleep(500); // registry broadcast updates the real capability row
  const rowPoint = await ntp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#named-agents capability-row')]
      .find(el => el.getAttribute('name') === ${JSON.stringify(seeded.name)});
    const open = row?.shadowRoot?.querySelector('.row.clickable');
    if (!open) return null;
    open.scrollIntoView({ block: 'center' });
    const r = open.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  check(
    "the scheduled agent appears in the real agents list",
    Boolean(rowPoint),
    rowPoint,
  );
  await ntp.clickPoint(rowPoint);
  let conversation: any = null;
  for (let i = 0; i < 30; i++) {
    conversation = await ntp.evaluate(`(() => {
      const host = document.getElementById('thread-conversation');
      const bubbles = [...(host?.querySelectorAll('message-bubble') ?? [])]
        .map(bubble => ({ role: bubble.getAttribute('role'), content: bubble.getAttribute('content') ?? '', rendered: bubble.shadowRoot?.textContent ?? '' }));
      return { title: document.getElementById('thread-title')?.textContent ?? '', bubbles };
    })()`);
    const hasUser = conversation?.bubbles?.some((bubble: any) =>
      bubble.role === "user" && bubble.content === prompt
    );
    const hasResult = conversation?.bubbles?.some((bubble: any) =>
      bubble.role === "agent" && bubble.content === expectedResult
    );
    if (hasUser && hasResult) break;
    await sleep(200);
  }
  await ntp.screenshot("scheduled-agent-conversation.png");
  check(
    "opening the agent shows the scheduled user turn",
    conversation?.bubbles?.some((bubble: any) =>
      bubble.role === "user" && bubble.content === prompt
    ) === true,
    conversation,
  );
  check(
    "opening the agent shows the deterministic non-empty model result",
    conversation?.bubbles?.some((bubble: any) =>
      bubble.role === "agent" && bubble.content === expectedResult
    ) === true,
    conversation,
  );
} finally {
  ws.close();
  try {
    proc.kill("SIGTERM");
  } catch { /* already exited */ }
}

console.log(`\nkat-background-run-transcript: ${pass} passed, ${fail} failed`);
if (fail) Deno.exit(1);

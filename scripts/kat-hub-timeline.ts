// kat-hub-timeline.ts — CAP-FB-20260828-HUB-AS-TIMELINE-01.
// The hub below the composer is ONE reverse-chronological timeline of what
// happened (tasks + agent runs), replacing the three object catalogs. This KAT
// drives the real loaded extension:
//   - a FRESH profile shows the composer + chips and NO timeline (empty state),
//   - the old Recent artifacts (#artifacts) and Recent activity (#run-log)
//     catalog cards are GONE,
//   - after a task runs, the timeline reveals a row naming the task, WITHOUT a
//     reload (the same live-refresh property the old activity card guarded),
//   - before/after screenshots at 1440x900 and 1024x700.
//
//   deno run -A scripts/kat-hub-timeline.ts [extension-dir] [out-dir]

import { launchChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`kat-hub-timeline-${Date.now()}`);
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

await Deno.mkdir(OUT, { recursive: true });

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map<string, (v: any) => void>();
const cdp = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse((m as any).data);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const evaluate = async (expr: string, sessionId: string) => {
  const j = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  return j.result?.result?.value ?? null;
};

try {
  let sw: any = null;
  for (let i = 0; i < 30 && !sw; i++) {
    const { result: { targetInfos } } = await cdp("Target.getTargets");
    sw = targetInfos.find((t: any) => t.type === "service_worker");
    if (!sw) await sleep(500);
  }
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;

  const { result: { targetId } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  await sleep(3000);
  const { result: { targetInfos: t2 } } = await cdp("Target.getTargets");
  const page = t2.find((t: any) => t.url.includes("ntp.html"));
  const { result: { sessionId: ui } } = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await cdp("Page.enable", {}, ui);
  const uiEval = (expr: string) => evaluate(expr, ui);

  const setViewport = async (width: number, height: number) => {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, ui);
    await sleep(400);
  };
  const shot = async (name: string) => {
    const j = await cdp("Page.captureScreenshot", { format: "png" }, ui);
    if (j.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(j.result.data), (c) => c.charCodeAt(0)));
  };

  const timelineState = () => uiEval(`(() => {
    const section = document.getElementById("timeline-section");
    const host = document.getElementById("hub-timeline");
    const root = host?.shadowRoot ?? null;
    return {
      sectionExists: !!section,
      sectionHidden: section ? section.hidden : null,
      rows: root ? root.querySelectorAll(".tl-row").length : -1,
      titles: root ? [...root.querySelectorAll(".tl-title")].map((n) => n.textContent).slice(0, 6) : [],
      empty: !!root?.querySelector(".tl-empty"),
      artifactsCardGone: !document.getElementById("artifacts-section") && !document.getElementById("artifacts"),
      activityCardGone: !document.getElementById("activity-section") && !document.getElementById("run-log"),
      composerAboveTimeline: (() => {
        const c = document.getElementById("composer");
        const s = document.getElementById("timeline-section");
        if (!c || !s || s.hidden) return null; // only meaningful once the timeline shows
        return c.getBoundingClientRect().top < s.getBoundingClientRect().top;
      })(),
    };
  })()`);

  // ── A. Fresh profile: composer + chips, NO timeline ─────────────────────
  await setViewport(1440, 900);
  const fresh = await timelineState();
  check("fresh profile: timeline section exists in the DOM", fresh.sectionExists === true, fresh);
  check("fresh profile: timeline is HIDDEN (empty on a fresh profile)", fresh.sectionHidden === true, fresh);
  check("the Recent artifacts catalog card is GONE", fresh.artifactsCardGone === true, fresh);
  check("the Recent activity catalog card is GONE", fresh.activityCardGone === true, fresh);
  await shot("01-before-1440x900");

  // ── B. Run a task → the timeline reveals a row WITHOUT a reload ─────────
  await uiEval(`(async () => {
    document.getElementById("composer")?.dispatchEvent(new CustomEvent("send", { detail: { text: "kat: hub timeline probe task", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  await sleep(6000);
  // The hub send opens the thread view (the hub is covered); return to it.
  const covered = await uiEval(`document.getElementById("thread-view")?.hidden === false`);
  if (covered) await uiEval(`document.getElementById("thread-back")?.click()`);
  await sleep(500);
  let live = await timelineState();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && (live.sectionHidden !== false || live.rows <= 0)) {
    await sleep(1000);
    live = await timelineState();
  }
  check("LIVE: the timeline reveals after a task, WITHOUT a reload", live.sectionHidden === false && live.rows > 0, live);
  check("LIVE: a timeline row names the task", (live.titles ?? []).some((t: string) => (t || "").includes("hub timeline probe task")), live.titles);
  check("the composer (the hero) renders ABOVE the timeline", live.composerAboveTimeline === true, live);
  await setViewport(1440, 900);
  await shot("02-after-1440x900");
  await setViewport(1024, 700);
  await shot("03-after-1024x700");

  // ── C. Persistence across an NTP reload ─────────────────────────────────
  await cdp("Page.reload", {}, ui);
  await sleep(3500);
  await setViewport(1440, 900);
  const reloaded = await timelineState();
  check("persistence: the timeline survives an NTP reload", reloaded.sectionHidden === false && reloaded.rows > 0, reloaded);
  await shot("04-after-reload-1440x900");

  console.log(`\n${pass}/${pass + fail} checks passed — screenshots in ${OUT}`);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
}

if (fail > 0) Deno.exit(1);

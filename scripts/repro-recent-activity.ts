// repro-recent-activity.ts — REPRODUCE the owner's bug: NTP "Recent activity"
// stays empty/stale even as runs happen. Drives the REAL extension in headless
// Chromium: opens the NTP, seeds journal activity through the REAL write path
// (a hub composer send → the SW's runTask journalAppend), and observes whether
// the <activity-explorer> in the NTP (a) shows the entries after reload and
// (b) updates WITHOUT a reload when new activity lands.
//
//   deno run -A scripts/repro-recent-activity.ts [extension-dir]

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `/tmp/repro-recent-activity-${Date.now()}`;
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Kernel-assigned debugging port, read back from THIS Chrome by the shared
// launcher — a named port can silently attach to another lane's browser
// (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
const { proc, wsUrl, port } = await launchChrome({
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

const report: Record<string, unknown> = { observations: [] };
// The verdict this probe exits with (CAP-FB-20260830-SUITE-HONESTY-01: it
// used to set no exit code at all): 0 when the live explorer showed the new
// activity without a reload, 1 when the bug reproduced or the probe broke.
let liveOk = false;
const note = (k: string, v: unknown) => { (report.observations as any[]).push({ [k]: v }); console.log(`OBS ${k}: ${JSON.stringify(v)}`); };

try {
  // The SW can register AFTER the first target list — poll for it.
  let sw: any = null;
  for (let i = 0; i < 30 && !sw; i++) {
    const { result: { targetInfos } } = await cdp("Target.getTargets");
    sw = targetInfos.find((t: any) => t.type === "service_worker");
    if (!sw) await sleep(500);
  }
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;
  const { result: { sessionId: swS } } = await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  const swEval = (expr: string) => evaluate(expr, swS);

  const { result: { targetId } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  await sleep(3000);
  const { result: { targetInfos: t2 } } = await cdp("Target.getTargets");
  const page = t2.find((t: any) => t.url.includes("ntp.html"));
  const { result: { sessionId: ui } } = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const uiEval = (expr: string) => evaluate(expr, ui);

  // ── 1. Baseline: what does the NTP show on a fresh profile? ────────────
  const explorerState = () => uiEval(`(() => {
    const host = document.querySelector("#run-log activity-explorer");
    if (!host) return { mounted: false };
    const root = host.shadowRoot;
    const rows = root ? root.querySelectorAll(".aex-entry").length : -1;
    const empty = root?.querySelector(".aex-empty")?.textContent ?? null;
    const err = host._loadError ?? null;
    return { mounted: true, rows, empty, err, entries: (host._entries || []).length };
  })()`);
  note("baseline-explorer", await explorerState());

  // What does the SW's activity.list answer right now?
  const activityCount = () => swEval(`new Promise(res => chrome.runtime.sendMessage({ type: "activity.list", limit: 100 }, r => res(JSON.stringify(r))))`);
  note("baseline-activity.list", await activityCount());

  // ── 2. Drive a REAL run through the hub composer ───────────────────────
  await uiEval(`(async () => {
    document.getElementById("composer")?.dispatchEvent(new CustomEvent("send", { detail: { text: "repro: recent activity probe", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  await sleep(8000); // the run settles (success or provider-fail — either way journal entries land)
  note("after-run-activity.list", await activityCount());
  note("after-run-explorer-no-reload", await explorerState());

  // ── 3. NEW activity lands AFTER mount: does the live explorer see it? ──
  // Seed a second task and watch WITHOUT reload.
  await uiEval(`(async () => {
    document.getElementById("composer")?.dispatchEvent(new CustomEvent("send", { detail: { text: "repro: second probe", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  await sleep(6000);
  const liveState = await explorerState();
  note("live-explorer-after-second-run", liveState);
  liveOk = liveState?.mounted === true && (Number(liveState.rows) > 0 || Number(liveState.entries) > 0);

  // ── 4. Reload the NTP: does persisted activity render? ────────────────
  await cdp("Page.enable", {}, ui);
  await cdp("Page.reload", {}, ui);
  await sleep(3000);
  note("after-reload-explorer", await explorerState());

  await Deno.writeTextFile(`${OUT}/repro.json`, JSON.stringify(report, null, 2));
  console.log(`report: ${OUT}/repro.json`);
} finally {
  try { proc.kill(); } catch { /* best effort */ }
}
console.log(`RESULT: ${liveOk ? "PASS" : "FAIL"} — the live explorer ${liveOk ? "showed" : "did not show"} new activity without a reload`);
Deno.exit(liveOk ? 0 : 1);

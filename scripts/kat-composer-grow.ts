// kat-composer-grow.ts — live-browser KAT for the composer auto-grow fix
// (owner bug 2026-08-28: after 1–2 lines the task input auto-scrolled and the
// text being typed left the viewport; the composer must GROW up to ~10 lines,
// then scroll internally).
//
// Drives the REAL <agent-composer> on the REAL NTP (hub composer #composer and
// the task-view composer #thread-composer are the SAME custom element; the hub
// one is driven live, the thread one's wiring is proven structurally + live
// once its view is shown):
//   1. one line typed → height stays at the rows=2 base (no jump);
//   2. 12 lines typed → height caps at ~10 computed lines and the textarea
//      scrolls internally (scrollHeight > clientHeight);
//   3. the caret line stays visible while typing at the cap (scrollTop tracks
//      the bottom — the browser's caret-following behavior on overflow-y:auto);
//   4. deleting back to empty returns to the base height;
//   5. a 50-line PASTE caps immediately (single input event, no interim states);
//   6. the thread composer (hidden at boot) is NOT pinned to 0px — the hidden
//      guard leaves it alone until its first input;
//   7. narrow (360px) — same growth contract, no horizontal overflow.
// Screenshots land in the out dir.
//
//   deno run -A scripts/kat-composer-grow.ts <path-to-extension> [<out-dir>]

import { launchChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-composer-grow`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the harness to another lane's browser.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${chromeProfileDir("kat-composer-grow")}`, "about:blank"],
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
  if (r?.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r?.result?.result?.value;
};
let pageSession = "";
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, pageSession);
  if (r?.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

let sw: any = null;
for (let i = 0; i < 100; i++) {
  const { result: { targetInfos } } = await send("Target.getTargets");
  if (i === 0) console.log("DEBUG targets:", JSON.stringify(targetInfos.map((t: any) => t.type + " " + String(t.url).slice(0, 70))));
  sw = targetInfos.find((t: any) => t.type === "service_worker" && t.url.includes("chrome-extension://"));
  if (sw) break;
  await sleep(300);
}
if (!sw) { console.log("FAIL: no service worker target"); proc.kill(); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
({ result: { sessionId: pageSession } } = await send("Target.attachToTarget", { targetId, flatten: true }));
await send("Runtime.enable", {}, pageSession);
await send("Page.enable", {}, pageSession);
await sleep(1500);

// Helper injected once: drive the composer's textarea exactly as the input
// event path does (the handler is _onComposerInput, wired to "input").
await evalIn(`(() => {
  window.__kat = {
    el: () => document.querySelector("#composer"),
    input: () => document.querySelector("#composer")?.querySelector?.("#task-input")
      ?? document.querySelector("#composer #task-input"),
    set(v) {
      const i = this.input();
      i.value = v;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return this.measure();
    },
    measure() {
      const i = this.input();
      const cs = getComputedStyle(i);
      const line = parseFloat(cs.lineHeight);
      return {
        h: i.getBoundingClientRect().height,
        scroll: i.scrollHeight,
        client: i.clientHeight,
        top: i.scrollTop,
        line,
        overflowY: cs.overflowY,
        resize: cs.resize,
        docW: document.documentElement.scrollWidth,
        winW: innerWidth,
      };
    },
    lines(n) { return Array.from({ length: n }, (_, k) => "line " + (k + 1) + " of the task text").join("\\n"); },
  };
  return true;
})()`, pageSession);

// ── 1. one line → base height (rows=2 base, no growth) ──────────────────────
const one = await evalIn(`window.__kat.set("a single line of text")`, pageSession);
const lineH = one?.line ?? 0;
check("auto-grow: the line-height is measurable (the cap derives from it)", lineH > 10 && lineH < 40, one);
const base = one?.h ?? 0;
check("one line typed → height stays at the base (≤ 2 lines + pad)", base > 0 && base <= lineH * 2 + 8, { base, lineH });
check("manual resize is disabled (auto-grow owns the height)", one?.resize === "none", one);

// ── 2/3. 12 lines → capped at ~10 lines, internal scroll, caret visible ─────
const twelve = await evalIn(`window.__kat.set(window.__kat.lines(12))`, pageSession);
const cap = lineH * 10 + 8; // 10 computed lines + tolerance
check("12 lines typed → height caps at ~10 lines", twelve?.h > lineH * 8 && twelve?.h <= cap, { h: twelve?.h, cap });
check("12 lines → the textarea scrolls internally (scrollHeight > clientHeight)", (twelve?.scroll ?? 0) > (twelve?.client ?? 0) && twelve?.overflowY === "auto", twelve);
// Caret visibility must be proven through the REAL typing path: a
// programmatic value-set leaves the caret at 0; CDP Input.insertText inserts
// at the caret like keystrokes, and the browser must scroll it into view.
await evalIn(`(() => { const i = window.__kat.input(); i.focus(); i.setSelectionRange(i.value.length, i.value.length); return true; })()`, pageSession);
await send("Input.insertText", { text: "\ntyped at the end" }, pageSession);
await sleep(200);
const caret = await evalIn(`window.__kat.measure()`, pageSession);
check("caret line stays visible while typing at the cap (scrollTop follows the caret)", (caret?.top ?? -1) > 0 && Math.abs((caret?.top ?? 0) - ((caret?.scroll ?? 0) - (caret?.client ?? 0))) < (caret?.line ?? 20) * 2, caret);
await shot("01-composer-12-lines");

// ── 4. delete to empty → back to base ────────────────────────────────────────
const empty = await evalIn(`window.__kat.set("")`, pageSession);
check("deleted to empty → height returns to the base", Math.abs((empty?.h ?? -1) - base) <= 2, { h: empty?.h, base });
await shot("02-composer-empty");

// ── 5. 50-line paste caps immediately ────────────────────────────────────────
const paste = await evalIn(`window.__kat.set(window.__kat.lines(50))`, pageSession);
check("50-line paste → capped at ~10 lines immediately", paste?.h > lineH * 8 && paste?.h <= cap, { h: paste?.h, cap });
await shot("03-composer-50-line-paste");

// ── 6. hidden thread composer is NOT pinned to 0px ───────────────────────────
const thread = await evalIn(`(() => {
  const t = document.querySelector("#thread-composer #task-input");
  if (!t) return { missing: true };
  return { styleH: t.style.height, value: t.value };
})()`, pageSession);
check("hidden thread composer untouched by auto-grow (no 0px pin)", !thread?.missing && thread?.styleH === "", thread);

// ── 7. narrow (360px): same contract, no horizontal overflow ─────────────────
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, pageSession);
await sleep(400);
const narrow = await evalIn(`window.__kat.set(window.__kat.lines(12))`, pageSession);
check("360px: 12 lines still cap at ~10 lines", narrow?.h > lineH * 8 && narrow?.h <= cap, { h: narrow?.h, cap });
check("360px: no horizontal overflow introduced", (narrow?.docW ?? 9999) <= (narrow?.winW ?? 0), narrow);
await shot("04-composer-narrow-360");
await send("Emulation.clearDeviceMetricsOverride", {}, pageSession);

console.log(`\nKAT composer-grow: ${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);

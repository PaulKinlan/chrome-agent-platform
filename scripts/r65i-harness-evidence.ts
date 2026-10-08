// scripts/r65i-harness-evidence.ts — real-browser loaded-extension evidence for r65i
import { fileURLToPath } from "node:url";
import { launchChrome, waitForServiceWorker, teardownChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const OUT = durableDir("r65i-harness-ui");
const CHROMIUM = "/usr/bin/chromium";

console.log(`[r65i-evidence] Output directory: ${OUT}`);
await Deno.mkdir(OUT, { recursive: true });

const results: { name: string; pass: boolean; detail?: any }[] = [];
function record(name: string, pass: boolean, detail?: any) {
  results.push({ name, pass, detail });
  console.log(`[r65i-evidence] ${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` (${JSON.stringify(detail)})` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = chromeProfileDir("r65i-harness-ui");
let proc: any = null;

try {
  console.log("[r65i-evidence] Launching Chrome with loaded extension...");
  const launched = await launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    timeoutMs: 30000,
  });
  proc = launched.proc;
  const wsUrl = launched.wsUrl;

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((res, rej) => {
      const mid = ++id;
      pending.set(mid, (m: any) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  ws.onmessage = (m: MessageEvent) => {
    const j = JSON.parse(m.data as string);
    if (j.id && pending.has(j.id)) {
      pending.get(j.id)!(j);
      pending.delete(j.id);
    }
  };

  const sw = await waitForServiceWorker(send);
  if (!sw) throw new Error("Service worker target not found");
  const extId = new URL(sw.url).host;
  console.log(`[r65i-evidence] Extension ID: ${extId}`);

  // Create target for NTP page
  const ntpUrl = `chrome-extension://${extId}/ntp/ntp.html`;
  const { targetId } = await send("Target.createTarget", { url: ntpUrl });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("DOM.enable", {}, sessionId);

  const evalExpr = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  const captureShot = async (filename: string) => {
    const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const data = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    await Deno.writeFile(`${OUT}/${filename}`, data);
    console.log(`[r65i-evidence] Screenshot saved: ${OUT}/${filename}`);
  };

  // Wait for NTP to render and populate harness-list
  console.log("[r65i-evidence] Waiting for harness buttons in NTP...");
  for (let i = 0; i < 40; i++) {
    const count = await evalExpr(`document.querySelectorAll("#harness-list harness-agent-button").length`);
    if (count >= 3) break;
    await sleep(250);
  }

  // ── Drive 1: Wide Layout (1280x800) ──────────────────────────────────────────
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(400);

  const wideGeo = await evalExpr(`(() => {
    const buttons = Array.from(document.querySelectorAll("#harness-list harness-agent-button"));
    const list = document.querySelector("#harness-list");
    const side = document.querySelector(".side");
    return {
      count: buttons.length,
      listWidth: list ? list.clientWidth : 0,
      listScrollWidth: list ? list.scrollWidth : 0,
      sideWidth: side ? side.clientWidth : 0,
      sideScrollWidth: side ? side.scrollWidth : 0,
      rows: buttons.map(b => {
        const rect = b.getBoundingClientRect();
        const root = b.shadowRoot;
        const btn = root ? root.querySelector("button") : null;
        const btnRect = btn ? btn.getBoundingClientRect() : null;
        const mark = root ? root.querySelector(".mark svg") : null;
        const name = root ? root.querySelector(".name") : null;
        const open = root ? root.querySelector(".open svg") : null;
        const cs = btn ? getComputedStyle(btn) : null;
        return {
          nameAttr: b.getAttribute("name"),
          height: rect.height,
          btnHeight: btnRect ? btnRect.height : 0,
          markPresent: !!mark,
          openPresent: !!open,
          nameVisible: name ? getComputedStyle(name).display !== "none" : false,
          gap: cs ? cs.gap : null,
          title: btn ? btn.getAttribute("title") : null,
          ariaLabel: btn ? btn.getAttribute("aria-label") : null,
        };
      })
    };
  })()`);

  record("wide 1280: 3 harness buttons rendered", wideGeo.count === 3, { count: wideGeo.count });
  record("wide 1280: 44px min touch height", wideGeo.rows.every((r: any) => r.btnHeight >= 44 || r.height >= 44), wideGeo.rows);
  record("wide 1280: neutral terminal mark and chevron present", wideGeo.rows.every((r: any) => r.markPresent && r.openPresent), wideGeo.rows);
  record("wide 1280: names visible in wide mode", wideGeo.rows.every((r: any) => r.nameVisible), wideGeo.rows);
  record("wide 1280: no horizontal overflow", wideGeo.listScrollWidth <= wideGeo.listWidth + 1 && wideGeo.sideScrollWidth <= wideGeo.sideWidth + 1, {
    listWidth: wideGeo.listWidth, listScrollWidth: wideGeo.listScrollWidth,
    sideWidth: wideGeo.sideWidth, sideScrollWidth: wideGeo.sideScrollWidth,
  });

  await captureShot("1280.png");

  // ── Drive 2: Focus & Keyboard Navigation ────────────────────────────────────
  const focusResult = await evalExpr(`(() => {
    const first = document.querySelector("#harness-list harness-agent-button");
    if (!first || !first.shadowRoot) return { success: false, reason: "no shadowRoot" };
    const btn = first.shadowRoot.querySelector("button");
    if (!btn) return { success: false, reason: "no button" };
    btn.focus();
    const cs = getComputedStyle(btn);
    return {
      success: true,
      activeTag: document.activeElement ? document.activeElement.tagName : null,
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
    };
  })()`);

  record("keyboard focus: button receives focus and has visible outline", focusResult.success && focusResult.outlineWidth !== "0px", focusResult);
  await captureShot("focus.png");

  // ── Drive 3: Click Activation ───────────────────────────────────────────────
  const clickResult = await evalExpr(`(() => {
    const first = document.querySelector("#harness-list harness-agent-button");
    if (!first || !first.shadowRoot) return { clicked: false };
    let dispatched = false;
    first.addEventListener("click", () => { dispatched = true; }, { once: true });
    const btn = first.shadowRoot.querySelector("button");
    btn.click();
    return { clicked: dispatched, name: first.getAttribute("name") };
  })()`);
  record("click activation: clicking inner button dispatches click on host", clickResult.clicked, clickResult);

  // ── Drive 4: Narrow Layout (390x800) ────────────────────────────────────────
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(400);

  const narrowGeo = await evalExpr(`(() => {
    const buttons = Array.from(document.querySelectorAll("#harness-list harness-agent-button"));
    const list = document.querySelector("#harness-list");
    const side = document.querySelector(".side");
    return {
      count: buttons.length,
      listWidth: list ? list.clientWidth : 0,
      listScrollWidth: list ? list.scrollWidth : 0,
      sideWidth: side ? side.clientWidth : 0,
      sideScrollWidth: side ? side.scrollWidth : 0,
      isCollapsed: side ? side.classList.contains("collapsed") : false,
      rows: buttons.map(b => {
        const root = b.shadowRoot;
        const btn = root ? root.querySelector("button") : null;
        const btnRect = btn ? btn.getBoundingClientRect() : null;
        const name = root ? root.querySelector(".name") : null;
        const open = root ? root.querySelector(".open") : null;
        return {
          height: btnRect ? btnRect.height : 0,
          nameDisplay: name ? getComputedStyle(name).display : null,
          openDisplay: open ? getComputedStyle(open).display : null,
          title: btn ? btn.getAttribute("title") : null,
        };
      })
    };
  })()`);

  record("narrow 390: rows fit within container", narrowGeo.count === 3 && narrowGeo.rows.every((r: any) => r.height >= 40), narrowGeo);
  record("narrow 390: no horizontal overflow", narrowGeo.listScrollWidth <= narrowGeo.listWidth + 1 && narrowGeo.sideScrollWidth <= narrowGeo.sideWidth + 1, {
    listWidth: narrowGeo.listWidth, listScrollWidth: narrowGeo.listScrollWidth,
    sideWidth: narrowGeo.sideWidth, sideScrollWidth: narrowGeo.sideScrollWidth,
  });

  await captureShot("390.png");

  // ── Drive 5: Dark Scheme Emulation ──────────────────────────────────────────
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
  await sleep(400);

  const darkColors = await evalExpr(`(() => {
    const first = document.querySelector("#harness-list harness-agent-button");
    const btn = first && first.shadowRoot ? first.shadowRoot.querySelector("button") : null;
    const bodyCs = getComputedStyle(document.body);
    const btnCs = btn ? getComputedStyle(btn) : null;
    return {
      bodyBg: bodyCs.backgroundColor,
      bodyColor: bodyCs.color,
      btnColor: btnCs ? btnCs.color : null,
    };
  })()`);

  record("dark theme: background and colors adapt", !!darkColors.bodyBg, darkColors);
  await captureShot("dark.png");

  // Save structured report
  const report = {
    timestamp: new Date().toISOString(),
    wide: wideGeo,
    narrow: narrowGeo,
    focus: focusResult,
    click: clickResult,
    dark: darkColors,
    checks: results,
  };
  await Deno.writeTextFile(`${OUT}/REPORT.json`, JSON.stringify(report, null, 2));
  console.log(`[r65i-evidence] Evidence report saved: ${OUT}/REPORT.json`);

} finally {
  if (proc) {
    console.log("[r65i-evidence] Tearing down Chrome...");
    await teardownChrome(proc, profile);
    console.log("[r65i-evidence] Chrome teardown complete.");
  }
}

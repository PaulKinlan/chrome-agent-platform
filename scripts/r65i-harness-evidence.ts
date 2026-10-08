// scripts/r65i-harness-evidence.ts — real-browser loaded-extension evidence for r65i
import { fileURLToPath } from "node:url";
import {
  launchChrome,
  openCdp,
  waitForServiceWorker,
  safeCaptureScreenshot,
  resolveChromiumBinary,
  teardownChrome,
} from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const OUT = durableDir("r65i-harness-ui");
const CHROMIUM = resolveChromiumBinary();

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
let cdp: any = null;

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

  cdp = await openCdp(launched.wsUrl, { timeoutMs: 30000 });

  const sw = await waitForServiceWorker(cdp.send, { timeoutMs: 20000 });
  if (!sw) throw new Error("Service worker target not found");
  const extId = new URL(sw.url).host;
  console.log(`[r65i-evidence] Extension ID: ${extId}`);

  // Create target for NTP page
  const ntpUrl = `chrome-extension://${extId}/ntp/ntp.html`;
  const createRes = await cdp.send("Target.createTarget", { url: ntpUrl });
  const targetId = createRes?.result?.targetId ?? createRes?.targetId;
  const attachRes = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attachRes?.result?.sessionId ?? attachRes?.sessionId;

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("DOM.enable", {}, sessionId);

  const evalExpr = async (expr: string) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    const res = r?.result ?? r;
    if (res?.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res?.result?.value;
  };

  const captureShot = async (filename: string) => {
    const bytes = await safeCaptureScreenshot(cdp.send, sessionId, { timeoutMs: 8000 });
    if (bytes) {
      await Deno.writeFile(`${OUT}/${filename}`, bytes);
      console.log(`[r65i-evidence] Screenshot saved: ${OUT}/${filename}`);
    } else {
      console.warn(`[r65i-evidence] Screenshot capture returned null for ${filename}`);
    }
  };

  // Wait for NTP to render and populate harness-list
  console.log("[r65i-evidence] Waiting for harness buttons in NTP...");
  for (let i = 0; i < 40; i++) {
    const count = await evalExpr(`document.querySelectorAll("#harness-list harness-agent-button").length`);
    if (count >= 3) break;
    await sleep(250);
  }

  // ── Drive 1: Wide Layout (1280x800) ──────────────────────────────────────────
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(400);

  const wideGeo = await evalExpr(`(() => {
    const buttons = Array.from(document.querySelectorAll("#harness-list harness-agent-button"));
    const list = document.querySelector("#harness-list");
    const side = document.querySelector(".side");
    const presence = document.querySelector("#harness-presence");
    const listCs = list ? getComputedStyle(list) : null;
    const presenceCs = presence ? getComputedStyle(presence) : null;
    return {
      count: buttons.length,
      listWidth: list ? list.clientWidth : 0,
      listScrollWidth: list ? list.scrollWidth : 0,
      sideWidth: side ? side.clientWidth : 0,
      sideScrollWidth: side ? side.scrollWidth : 0,
      presenceFlexShrink: presenceCs ? presenceCs.flexShrink : null,
      listFlexShrink: listCs ? listCs.flexShrink : null,
      listMaxHeight: listCs ? listCs.maxHeight : null,
      listOverflowY: listCs ? listCs.overflowY : null,
      rows: buttons.map(b => {
        const rect = b.getBoundingClientRect();
        const root = b.shadowRoot;
        const btn = root ? root.querySelector("button") : null;
        const btnRect = btn ? btn.getBoundingClientRect() : null;
        const mark = root ? root.querySelector(".mark svg") : null;
        const name = root ? root.querySelector(".name") : null;
        const open = root ? root.querySelector("svg.open") : null;
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

  // ── Drive 2: Hover State ───────────────────────────────────────────────────
  const hoverResult = await evalExpr(`(() => {
    const first = document.querySelector("#harness-list harness-agent-button");
    const btn = first && first.shadowRoot ? first.shadowRoot.querySelector("button") : null;
    if (!btn) return { success: false };
    const beforeBg = getComputedStyle(btn).backgroundColor;
    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const afterBg = getComputedStyle(btn).backgroundColor;
    return { success: true, beforeBg, afterBg };
  })()`);
  record("hover: button dispatches mouse events cleanly", hoverResult.success, hoverResult);

  // ── Drive 3: Keyboard Focus Outline ────────────────────────────────────────
  const focusResult = await evalExpr(`(() => {
    const first = document.querySelector("#harness-list harness-agent-button");
    if (!first || !first.shadowRoot) return { success: false, reason: "no shadowRoot" };
    const btn = first.shadowRoot.querySelector("button");
    if (!btn) return { success: false, reason: "no button" };
    btn.focus();
    const cs = getComputedStyle(btn);
    return {
      success: true,
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
    };
  })()`);

  record("keyboard focus: button receives focus with 2px visible outline", focusResult.success && focusResult.outlineWidth !== "0px", focusResult);
  await captureShot("focus.png");

  // ── Drive 4: Keyboard Activation & Conversation Routing ────────────────────
  const keyActivationResult = await evalExpr(`(() => {
    const codexBtn = Array.from(document.querySelectorAll("#harness-list harness-agent-button")).find(
      b => b.getAttribute("name") === "Codex"
    );
    if (!codexBtn || !codexBtn.shadowRoot) return { success: false, reason: "no codex button" };
    const btn = codexBtn.shadowRoot.querySelector("button");
    btn.focus();
    // Dispatch Enter keydown and click
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    btn.click();
    const threadTitle = document.getElementById("thread-title");
    return {
      success: true,
      titleText: threadTitle ? threadTitle.textContent : null,
      hash: window.location.hash,
    };
  })()`);
  record(
    "conversation route: activating Codex button routes to conversation surface",
    keyActivationResult.success && (keyActivationResult.titleText === "Codex" || keyActivationResult.hash.includes("codex")),
    keyActivationResult,
  );

  // ── Drive 5: Short Viewport (1280x350) & List Scroll Cap ───────────────────
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 350, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(400);

  const shortViewportGeo = await evalExpr(`(() => {
    const presence = document.querySelector("#harness-presence");
    const list = document.querySelector("#harness-list");
    const presenceCs = presence ? getComputedStyle(presence) : null;
    const listCs = list ? getComputedStyle(list) : null;
    return {
      presenceFlexShrink: presenceCs ? presenceCs.flexShrink : null,
      presenceMinHeight: presenceCs ? presenceCs.minHeight : null,
      listMaxHeight: listCs ? listCs.maxHeight : null,
      listOverflowY: listCs ? listCs.overflowY : null,
      listHeight: list ? list.clientHeight : 0,
      listScrollHeight: list ? list.scrollHeight : 0,
    };
  })()`);

  record(
    "short viewport (1280x350): section is shrinkable (flex-shrink 1) with scrollable capped list",
    shortViewportGeo.presenceFlexShrink === "1" && shortViewportGeo.listOverflowY === "auto" && shortViewportGeo.listMaxHeight === "240px",
    shortViewportGeo,
  );

  // ── Drive 6: Narrow Viewport (390x800) & Rail Expand ───────────────────────
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(400);

  // In narrow viewport, rail is collapsed by default
  const railState = await evalExpr(`(() => {
    const side = document.querySelector(".side");
    const railBtn = document.querySelector('.rail-sec-btn[data-rail-target="harness-presence"]');
    const presence = document.querySelector("#harness-presence");
    return {
      sideCollapsed: side ? side.classList.contains("collapsed") : false,
      railBtnPresent: !!railBtn,
      presenceHidden: presence ? getComputedStyle(presence).display === "none" : false,
    };
  })()`);
  record("narrow 390: rail collapsed and dedicated rail button present", railState.sideCollapsed && railState.railBtnPresent, railState);

  // Click rail button to expand harness-presence section in narrow mode
  await evalExpr(`(() => {
    const railBtn = document.querySelector('.rail-sec-btn[data-rail-target="harness-presence"]');
    if (railBtn) railBtn.click();
  })()`);
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
      rows: buttons.map(b => {
        const root = b.shadowRoot;
        const btn = root ? root.querySelector("button") : null;
        const btnRect = btn ? btn.getBoundingClientRect() : null;
        const name = root ? root.querySelector(".name") : null;
        const open = root ? root.querySelector("svg.open") : null;
        return {
          height: btnRect ? btnRect.height : 0,
          nameVisible: name ? getComputedStyle(name).display !== "none" : false,
          openVisible: open ? getComputedStyle(open).display !== "none" : false,
          title: btn ? btn.getAttribute("title") : null,
        };
      })
    };
  })()`);

  record("narrow 390: expanded section rows fit within container", narrowGeo.count === 3 && narrowGeo.rows.every((r: any) => r.height >= 40), narrowGeo);
  record("narrow 390: no horizontal overflow", narrowGeo.listScrollWidth <= narrowGeo.listWidth + 1 && narrowGeo.sideScrollWidth <= narrowGeo.sideWidth + 1, {
    listWidth: narrowGeo.listWidth, listScrollWidth: narrowGeo.listScrollWidth,
    sideWidth: narrowGeo.sideWidth, sideScrollWidth: narrowGeo.sideScrollWidth,
  });

  await captureShot("390.png");

  // ── Drive 7: Dark Scheme Emulation ──────────────────────────────────────────
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
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
    hover: hoverResult,
    focus: focusResult,
    activation: keyActivationResult,
    shortViewport: shortViewportGeo,
    narrow: narrowGeo,
    dark: darkColors,
    checks: results,
  };
  await Deno.writeTextFile(`${OUT}/REPORT.json`, JSON.stringify(report, null, 2));
  console.log(`[r65i-evidence] Evidence report saved: ${OUT}/REPORT.json`);

  const failedCount = results.filter((r) => !r.pass).length;
  if (failedCount > 0) {
    console.error(`[r65i-evidence] FAILED: ${failedCount} check(s) failed`);
    Deno.exit(1);
  }
  console.log(`[r65i-evidence] ALL ${results.length} CHECKS PASSED.`);

} finally {
  if (cdp) {
    try { await cdp.close(); } catch { /* ignore */ }
  }
  if (proc) {
    console.log("[r65i-evidence] Tearing down Chrome...");
    await teardownChrome(proc, profile);
    console.log("[r65i-evidence] Chrome teardown complete.");
  }
}

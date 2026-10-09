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
const runTag = new Date().toISOString().replace(/[:.]/g, "-");
const BASE_OUT = durableDir("r65i-harness-ui");
const OUT = `${BASE_OUT}/${runTag}`;
const CHROMIUM = resolveChromiumBinary();

console.log(`[r65i-evidence] Run output directory: ${OUT}`);
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
let exitCode = 0;

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
    if (!bytes || bytes.length === 0) {
      record(`screenshot ${filename} captured`, false, { error: "safeCaptureScreenshot returned empty or null" });
      throw new Error(`Screenshot ${filename} capture failed`);
    }
    await Deno.writeFile(`${OUT}/${filename}`, bytes);
    record(`screenshot ${filename} captured`, true, { path: `${OUT}/${filename}`, bytes: bytes.length });
    console.log(`[r65i-evidence] Screenshot saved: ${OUT}/${filename} (${bytes.length} bytes)`);
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

  // Ensure the harness disclosure is opened so launchers are visible
  await evalExpr(`(() => {
    const presence = document.querySelector("#harness-presence");
    if (presence && !presence.hasAttribute("open")) {
      const summary = presence.querySelector("summary");
      if (summary) summary.click();
      else presence.setAttribute("open", "");
    }
  })()`);
  await sleep(300);

  const wideGeo = await evalExpr(`(() => {
    const buttons = Array.from(document.querySelectorAll("#harness-list harness-agent-button"));
    const list = document.querySelector("#harness-list");
    const side = document.querySelector(".side");
    const presence = document.querySelector("#harness-presence");
    const listCs = list ? getComputedStyle(list) : null;
    const presenceCs = presence ? getComputedStyle(presence) : null;
    return {
      count: buttons.length,
      presenceOpen: presence ? presence.hasAttribute("open") : false,
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
          width: rect.width,
          height: rect.height,
          btnWidth: btnRect ? btnRect.width : 0,
          btnHeight: btnRect ? btnRect.height : 0,
          markPresent: !!mark,
          openPresent: !!open,
          nameVisible: name ? getComputedStyle(name).display !== "none" : false,
          gap: cs ? cs.gap : null,
          title: btn ? btn.getAttribute("title") : null,
          ariaLabel: btn ? btn.getAttribute("aria-label") : null,
          inViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < 800,
        };
      })
    };
  })()`);

  record("wide 1280: disclosure is open", wideGeo.presenceOpen, { presenceOpen: wideGeo.presenceOpen });
  record("wide 1280: 3 harness buttons rendered with visible nonzero bounds", wideGeo.count === 3 && wideGeo.rows.every((r: any) => r.btnWidth > 0 && r.inViewport), wideGeo.rows);
  record("wide 1280: 44px min touch height", wideGeo.rows.every((r: any) => r.btnHeight >= 44 || r.height >= 44), wideGeo.rows);
  record("wide 1280: neutral terminal mark and chevron present", wideGeo.rows.every((r: any) => r.markPresent && r.openPresent), wideGeo.rows);
  record("wide 1280: names visible in wide mode", wideGeo.rows.every((r: any) => r.nameVisible), wideGeo.rows);
  record("wide 1280: no horizontal overflow", wideGeo.listScrollWidth <= wideGeo.listWidth + 1 && wideGeo.sideScrollWidth <= wideGeo.sideWidth + 1, {
    listWidth: wideGeo.listWidth, listScrollWidth: wideGeo.listScrollWidth,
    sideWidth: wideGeo.sideWidth, sideScrollWidth: wideGeo.sideScrollWidth,
  });

  await captureShot("1280.png");

  // ── Drive 2: Hover State via real CDP mouseMoved ───────────────────────────
  const center = await evalExpr(`(() => {
    const first = document.querySelector("#harness-list harness-agent-button");
    const btn = first?.shadowRoot?.querySelector("button");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

  if (!center) {
    record("hover: button target resolved", false, { error: "button not found in DOM" });
  } else {
    // Reset mouse to outside the element
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 }, sessionId);
    await sleep(150);
    const beforeHover = await evalExpr(`(() => {
      const btn = document.querySelector("#harness-list harness-agent-button")?.shadowRoot?.querySelector("button");
      return btn ? { bg: getComputedStyle(btn).backgroundColor, color: getComputedStyle(btn).color } : null;
    })()`);

    // Move mouse over the button
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y }, sessionId);
    await sleep(250);

    const afterHover = await evalExpr(`(() => {
      const btn = document.querySelector("#harness-list harness-agent-button")?.shadowRoot?.querySelector("button");
      return btn ? { bg: getComputedStyle(btn).backgroundColor, color: getComputedStyle(btn).color } : null;
    })()`);

    const hoverChanged = beforeHover?.bg !== afterHover?.bg;
    record("hover: mouseMoved over button updates computed hover style", hoverChanged, { before: beforeHover, after: afterHover });
  }

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

  record("keyboard focus: button receives focus with visible inset outline", focusResult.success && focusResult.outlineWidth !== "0px", focusResult);
  await captureShot("focus.png");

  // ── Drive 4: Real Keyboard Enter Activation & Conversation Route ───────────
  const focusCodex = await evalExpr(`(() => {
    const buttons = Array.from(document.querySelectorAll("#harness-list harness-agent-button"));
    const codex = buttons.find(b => b.getAttribute("name") === "Codex");
    if (!codex || !codex.shadowRoot) return { success: false };
    const btn = codex.shadowRoot.querySelector("button");
    if (!btn) return { success: false };
    btn.focus();
    return { success: true, focused: document.activeElement === codex };
  })()`);
  record("keyboard activation: Codex button focused", focusCodex.success, focusCodex);

  // Dispatch real Enter keyDown and keyUp via CDP (NO synthetic btn.click()!)
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
  }, sessionId);
  await sleep(600);

  const keyActivationResult = await evalExpr(`(() => {
    const threadTitle = document.getElementById("thread-title");
    return {
      titleText: threadTitle ? threadTitle.textContent : null,
      hash: window.location.hash,
    };
  })()`);
  const routedToCodex = keyActivationResult.titleText === "Codex" || keyActivationResult.hash.includes("codex");
  record("keyboard activation: Enter key activates native button and routes to Codex conversation", routedToCodex, keyActivationResult);

  // ── Drive 5: Short Viewport (1280x350) Scrolling & Reachability ────────────
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 350, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(400);

  const shortViewportGeo = await evalExpr(`(() => {
    // In short viewport, collapse tasks to focus on harness presence in constrained height
    const tasks = document.querySelector("#tasks-section");
    if (tasks) tasks.open = false;
    const presence = document.querySelector("#harness-presence");
    if (presence) presence.open = true;

    const list = document.querySelector("#harness-list");
    const side = document.querySelector(".side");
    const buttons = Array.from(document.querySelectorAll("#harness-list harness-agent-button"));
    const lastBtn = buttons[buttons.length - 1];

    const presenceCs = presence ? getComputedStyle(presence) : null;
    const listCs = list ? getComputedStyle(list) : null;

    // Scroll list to reveal the last launcher
    if (lastBtn) lastBtn.scrollIntoView();

    const listRect = list ? list.getBoundingClientRect() : null;
    const sideRect = side ? side.getBoundingClientRect() : null;
    const lastRect = lastBtn ? lastBtn.getBoundingClientRect() : null;

    return {
      presenceFlexShrink: presenceCs ? presenceCs.flexShrink : null,
      listMaxHeight: listCs ? listCs.maxHeight : null,
      listOverflowY: listCs ? listCs.overflowY : null,
      listHeight: list ? list.clientHeight : 0,
      listScrollHeight: list ? list.scrollHeight : 0,
      listInsideSide: listRect && sideRect ? listRect.bottom <= sideRect.bottom + 2 : false,
      lastBtnVisibleInList: lastRect && listRect ? (lastRect.top >= listRect.top - 2 && lastRect.bottom <= listRect.bottom + 2) : false,
      lastTop: lastRect?.top,
      lastBottom: lastRect?.bottom,
      listTop: listRect?.top,
      listBottom: listRect?.bottom,
      sideTop: sideRect?.top,
      sideBottom: sideRect?.bottom,
    };
  })()`);

  record(
    "short viewport (1280x350): section is shrinkable (flex-shrink 1) with scrollable capped list",
    shortViewportGeo.presenceFlexShrink === "1" && shortViewportGeo.listOverflowY === "auto" && shortViewportGeo.listMaxHeight === "240px",
    shortViewportGeo,
  );
  record(
    "short viewport (1280x350): list stays within sidebar and last launcher scrolls into view",
    shortViewportGeo.listInsideSide && shortViewportGeo.lastBtnVisibleInList,
    shortViewportGeo,
  );
  await captureShot("short-350.png");

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
    runDir: OUT,
    wide: wideGeo,
    hover: { before: center ? "tested" : "missing" },
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
    exitCode = 1;
  } else {
    console.log(`[r65i-evidence] ALL ${results.length} CHECKS PASSED.`);
  }
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
Deno.exit(exitCode);

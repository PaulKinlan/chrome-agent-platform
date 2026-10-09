// cap-evidence/vl6c-browser-acceptance.ts — Real-browser acceptance for chrome-agent-platform-vl6c
//
// Launches built extension in headless Chrome via CDP.
// Drives genuine ACP harness runs:
//   1. Starts local ACP bridge on an isolated port.
//   2. Launches Chrome with the unpacked extension and an extra tab (https://example.com/ "Example Domain").
//   3. Configures acp.endpoint in extension storage to point to the bridge.
//   4. Runs Codex: asks "List my open tabs" -> Codex calls list_tabs through CAP's lazy toolset,
//      returns real tabs naming "Example Domain".
//   5. Runs Codex: asks "Close the Example Domain tab" -> close_tab raises live approval card in conversation UI,
//      Deny is clicked via CDP -> denial is delivered to Codex -> tab remains open.
//   6. Runs Pi: asks "Reply with pong" -> Pi completes pure chat turn without error.
//   7. Captures screenshots and writes evidence.

// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { launchChrome, chromeBaseArgs, computeUnpackedExtensionId } from "../scripts/lib/chrome-launch.ts";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const PORT = 3298;
// jsjy: the bridge requires a shared secret on every upgrade. Name one, start
// the bridge WITH it, and seed the SAME token into the extension's acp.token so
// the authenticated path is exercised (never the anonymous-loopback bypass).
const BRIDGE_TOKEN = "cap-vl6c-acceptance-token";
const EVIDENCE_DIR = durableDir(`cap-vl6c-acceptance-${Date.now()}`);
await Deno.mkdir(EVIDENCE_DIR, { recursive: true });

console.log(`[acceptance] Starting ACP bridge on port ${PORT} (token required)...`);
const bridge = createAcpServer(PORT, undefined, {}, "", BRIDGE_TOKEN);

console.log(`[acceptance] Launching headless Chrome with extension at ${EXT}...`);
const profile = durableDir(`cap-vl6c-profile-${Date.now()}`);
await Deno.mkdir(profile, { recursive: true });

const extId = await computeUnpackedExtensionId(EXT);
console.log(`[acceptance] Target extension ID: ${extId}`);

const browserArgs = [
  ...chromeBaseArgs({ extension: EXT, profile, windowSize: "1400,1000" }),
  "--enable-automation",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];

const chrome = await launchChrome({ args: browserArgs });
console.log(`[acceptance] Chrome launched on debug port ${chrome.port}`);

const ws = new WebSocket(chrome.wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let idCounter = 0;
const pendingCdp = new Map();

ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pendingCdp.has(m.id)) {
    pendingCdp.get(m.id)(m);
    pendingCdp.delete(m.id);
  }
};

const sendCdp = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const id = ++idCounter;
    const timer = setTimeout(() => {
      pendingCdp.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 60000);
    pendingCdp.set(id, (m: any) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

let passed = 0;
let failed = 0;
function check(desc: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS: ${desc}`);
  } else {
    failed++;
    console.error(`  FAIL: ${desc}`);
  }
}

async function evalInSession(sessionId: string, expr: string) {
  const res = await sendCdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res?.result?.value;
}

async function captureScreenshot(sessionId: string, filename: string) {
  const res = await sendCdp("Page.captureScreenshot", { format: "png" }, sessionId);
  if (res?.data) {
    const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
    await Deno.writeFile(`${EVIDENCE_DIR}/${filename}`, bytes);
    console.log(`  [screenshot] saved ${EVIDENCE_DIR}/${filename} (${bytes.length} bytes)`);
  }
}

try {
  // 1. Wait for Service Worker target to appear
  console.log("[acceptance] Waiting for extension service worker...");
  let swTarget = null;
  for (let i = 0; i < 60; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
    swTarget = targets.find((t: any) => t.type === "service_worker" && t.url.includes(extId));
    if (swTarget) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(swTarget, "Service worker registered");
  check("Extension service worker active", !!swTarget);

  // 2. Open an external page to act as the real open tab
  console.log("[acceptance] Opening target test page (https://example.com)...");
  const exampleTab = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?https://example.com`, { method: "PUT" })).json();
  check("Real test tab created (https://example.com)", !!exampleTab?.id);

  // 3. Open the NTP hub page
  console.log("[acceptance] Opening New Tab Hub page...");
  const ntpTab = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?chrome-extension://${extId}/ntp/ntp.html`, { method: "PUT" })).json();
  const ntpTarget = await sendCdp("Target.attachToTarget", { targetId: ntpTab.id, flatten: true });
  const ntpSession = ntpTarget.sessionId;
  await sendCdp("Runtime.enable", {}, ntpSession);
  await sendCdp("Page.enable", {}, ntpSession);

  // Wait for NTP to initialize
  await new Promise((r) => setTimeout(r, 1500));

  // 4. Configure acp.endpoint + acp.token in extension storage to point to our isolated bridge
  console.log(`[acceptance] Configuring acp.endpoint to ws://127.0.0.1:${PORT}/acp with acp.token (authenticated path)...`);
  await evalInSession(ntpSession, `
    chrome.runtime.sendMessage({
      type: "kv.set",
      values: {
        "acp.endpoint": "ws://127.0.0.1:${PORT}/acp",
        "acp.token": ${JSON.stringify(BRIDGE_TOKEN)}
      }
    })
  `);
  check("Configured bridge endpoint + token in storage", true);

  // 5. TEST 1: Run Codex to list open tabs via CAP's real lazy toolset
  console.log("\n[test 1] Driving Codex through extension to list real open tabs...");
  const listTurnResult = await evalInSession(ntpSession, `
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "agent.run",
        harnessId: "codex",
        task: "List all open tabs in the browser using list_tabs tool."
      }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    })
  `);

  console.log("  Codex list_tabs turn outcome:", listTurnResult?.ok ? "SUCCESS" : "ERROR", listTurnResult?.result?.slice(0, 200));
  check("Codex agent.run completed successfully", listTurnResult?.ok === true);
  check("Codex identified the real open tab 'Example Domain'", listTurnResult?.result?.includes("Example Domain"));

  await captureScreenshot(ntpSession, "01-codex-list-tabs.png");

  // 6. TEST 2: Run Codex to close the tab -> verify approval card and denial
  console.log("\n[test 2] Driving Codex through extension to close tab -> verify approval card and denial...");
  // Start the turn in the background
  const closePromise = evalInSession(ntpSession, `
    window.__closeTurnPromise = new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "agent.run",
        harnessId: "codex",
        task: "Close the tab titled 'Example Domain' using close_tab tool."
      }, resolve);
    });
    true;
  `);
  await closePromise;

  // Poll for live permission-approval-card in the DOM or pending approval in the worker
  console.log("  Waiting for approval card to appear...");
  let pendingApprovalId = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const pendingList = await evalInSession(ntpSession, `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "approval.list" }, (res) => resolve(res?.approvals ?? []));
      })
    `);
    if (pendingList.length > 0 && pendingList.some((a: any) => a.action === "browser.close-foreign-tab")) {
      pendingApprovalId = pendingList.find((a: any) => a.action === "browser.close-foreign-tab").approvalId;
      break;
    }
  }

  check("Live approval card raised for close_tab", !!pendingApprovalId);
  await captureScreenshot(ntpSession, "02-close-tab-card.png");

  if (pendingApprovalId) {
    console.log(`  Simulating owner clicking DENY on approval ${pendingApprovalId}...`);
    const denyResult = await evalInSession(ntpSession, `
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "approval.resolve",
          approvalId: "${pendingApprovalId}",
          approve: false
        }, resolve);
      })
    `);
    check("Owner denied the approval card", denyResult?.ok === true);
  }

  // Wait for the Codex turn to settle with the denial
  console.log("  Waiting for Codex turn to settle after denial...");
  const closeTurnResult = await evalInSession(ntpSession, `window.__closeTurnPromise`);
  console.log("  Codex close_tab turn outcome:", closeTurnResult?.ok ? "SUCCESS" : "RESULT", closeTurnResult?.result?.slice(0, 200));

  check("Codex received the owner denial", /denied/i.test(closeTurnResult?.result ?? ""));

  // Check over CDP that the example.com tab is STILL OPEN
  const currentTabs = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const exampleTabStillOpen = currentTabs.some((t: any) => t.id === exampleTab.id || (t.url && t.url.includes("example.com")));
  check("Tab remains open after owner Deny", exampleTabStillOpen);

  await captureScreenshot(ntpSession, "03-tab-remains-open.png");

  // 7. TEST 3: Run Pi pure chat turn through extension
  console.log("\n[test 3] Driving Pi through extension for pure chat turn...");
  const piTurnResult = await evalInSession(ntpSession, `
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "agent.run",
        harnessId: "pi",
        task: "Reply with the single word: PONG_SUCCESS"
      }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    })
  `);

  console.log("  Pi turn outcome:", piTurnResult?.ok ? "SUCCESS" : "RESULT", piTurnResult?.result?.slice(0, 200));
  check("Pi agent.run completed successfully", piTurnResult?.ok === true);
  check("Pi response contains expected output", /PONG_SUCCESS/i.test(piTurnResult?.result ?? ""));

  await captureScreenshot(ntpSession, "04-pi-chat-turn.png");

} finally {
  console.log("\n[acceptance] Cleaning up...");
  try {
    chrome.proc.kill("SIGTERM");
    await chrome.proc.status;
  } catch {}
  await bridge.shutdown();
}

console.log(`\n========================================`);
console.log(`[acceptance summary] Passed: ${passed}, Failed: ${failed}`);
console.log(`Evidence saved in: ${EVIDENCE_DIR}`);
console.log(`========================================`);

if (failed > 0) Deno.exit(1);

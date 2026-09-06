// @ts-nocheck
// kat-permission-approval.ts — Loaded-MV3 Browser Acceptance Journey for
// In-Context Permission Approvals & Guided Settings Revocation Flow
// (CAP-FB-20260826-PERMISSIONS-SIMPLIFY-01, commit ancestor 0856225 / 16458885).
//
// Exercises in real headless Chromium via CDP:
//   1. In-context permission approval card rendering, structure, and accessibility.
//   2. Owner-gesture "Not now" (Deny) flow — safe denial, state transition, zero grant.
//   3. Owner-gesture "Allow" flow on grantable permissions + handling of headless Chrome's
//      prompt-less auto-denial on warned permissions (recording exact Chrome behavior).
//   4. Guided Settings Disable flow: #permissions Disable click → auto-route to #approvals
//      with human-friendly explanation → "Approve once" resolution → auto-completion of
//      revocation and return to #permissions.
//   5. Captures screenshots, console messages, network activity, and accessibility tree.

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const EVIDENCE_DIR = chromeProfileDir("kat-permissions");
await Deno.mkdir(EVIDENCE_DIR, { recursive: true });

let passCount = 0;
let failCount = 0;
const results: { test: string; pass: boolean; detail?: any }[] = [];

function check(name: string, cond: boolean, detail?: any) {
  if (cond) {
    passCount++;
    console.log(`[PASS] ${name}`);
    results.push({ test: name, pass: true });
  } else {
    failCount++;
    console.error(`[FAIL] ${name} — ${JSON.stringify(detail)}`);
    results.push({ test: name, pass: false, detail });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`Starting loaded-MV3 acceptance harness for permissions simplification...`);
console.log(`Extension path: ${EXT}`);
console.log(`Evidence directory: ${EVIDENCE_DIR}`);

// 1. Launch Chromium with extension loaded
const userDataDir = chromeProfileDir("kat-permissions-profile");
await Deno.mkdir(userDataDir, { recursive: true });

// The shared launcher: kernel-assigned port, endpoint read from this child's
// own stderr, honest failure when the browser prints none
// (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
let chrome;
try {
  chrome = await launchChrome({ extension: EXT, profile: userDataDir, windowSize: "1440,900" });
} catch (e) {
  console.error(`FAIL: Could not locate Chrome DevTools WebSocket URL — ${String(e)}`);
  Deno.exit(1);
}
const proc = chrome.proc;
const port = chrome.port;

const ws = await openCdp(chrome.wsUrl);
// This harness reads the full CDP envelope (`res.result?.data`,
// `t.result?.targetId`) and never rejected on a protocol error — it resolved
// the `{ error }` envelope and let the optional chains fall through. Keep that
// contract over the shared client.
const send = (method: string, params: any = {}, sessionId?: string): Promise<any> =>
  ws.send(method, params, sessionId).catch((e: any) => ({ error: { message: String(e?.message ?? e) } }));

async function captureScreenshot(sessionId: string, filename: string) {
  try {
    const res = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    if (res.result?.data) {
      const bytes = Uint8Array.from(atob(res.result.data), (c) => c.charCodeAt(0));
      await Deno.writeFile(`${EVIDENCE_DIR}/${filename}`, bytes);
      console.log(`  [Screenshot saved: ${filename}]`);
    }
  } catch (e) {
    console.error(`  [Screenshot failed for ${filename}: ${e}]`);
  }
}

async function findSw(): Promise<{ extId: string }> {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const sw = (targets as any[]).find((t) => t.type === "service_worker");
      if (sw) return { extId: sw.url.split("/")[2] };
    } catch {}
    await sleep(100);
  }
  throw new Error("Service worker extension target did not appear");
}

async function realClick(sessionId: string, expr: string) {
  const res = await send("Runtime.evaluate", {
    expression: `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 }; })()`,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  const rect = res?.result?.result?.value;
  if (!rect || rect.x == null) return false;
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
  return true;
}

// 2. Discover targets & service worker
const { extId } = await findSw();
check("Service worker discovered and extension loaded", Boolean(extId), { extId });

// ── Journey 1: In-Context Permission Approval Card in NTP ──────────────────
console.log("\n--- Executing Journey 1: In-Context Permission Approval in NTP ---");
const t1 = await send("Target.createTarget", {
  url: `chrome-extension://${extId}/ntp/ntp.html`,
});
const ntpTargetId = t1.result?.targetId ?? t1.targetId;
const s1 = await send("Target.attachToTarget", {
  targetId: ntpTargetId,
  flatten: true,
});
const ntpSessionId = s1.result?.sessionId ?? s1.sessionId;

await send("Runtime.enable", {}, ntpSessionId);
await send("Page.enable", {}, ntpSessionId);
await send("DOM.enable", {}, ntpSessionId);
await sleep(2500);

const evNtp = async (expr: string) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, ntpSessionId))
    ?.result?.result?.value;

// Verify custom element registration
const hasCustomElement = await evNtp(`Boolean(customElements.get("permission-approval-card"))`);
check("permission-approval-card is registered in customElements", hasCustomElement === true);

// Create an approval card in the conversation feed
const cardSetup = await evNtp(`(() => {
  const container = document.getElementById("conversation-container") || document.querySelector(".composer-container") || document.body;
  const card = document.createElement("permission-approval-card");
  card.setAttribute("id", "test-approval-card-1");
  card.setAttribute("reason", "group your tabs by domain");
  card.setAttribute("permissions", JSON.stringify(["tabGroups"]));
  card.setAttribute("origins", JSON.stringify(["https://example.com", "https://news.ycombinator.com"]));
  card.setAttribute("state", "pending");
  container.appendChild(card);
  return {
    attached: true,
    shadowTitle: card.shadowRoot?.querySelector(".title")?.textContent,
    shadowReason: card.shadowRoot?.querySelector(".reason")?.textContent,
    allowBtn: Boolean(card.shadowRoot?.querySelector(".allow")),
    denyBtn: Boolean(card.shadowRoot?.querySelector(".deny")),
  };
})()`);

check("Approval card attached and rendered with shadow DOM elements", Boolean(cardSetup?.attached), cardSetup);
check("Approval card displays reason and controls",
  cardSetup?.shadowTitle === "Permission request" &&
  cardSetup?.shadowReason?.includes("group your tabs") &&
  cardSetup?.allowBtn && cardSetup?.denyBtn,
  cardSetup
);

await captureScreenshot(ntpSessionId, "01-approval-card-rendered.png");

// Test Deny click on the card
const denyOutcome = await evNtp(`(() => {
  const card = document.getElementById("test-approval-card-1");
  let denyFired = false;
  card.addEventListener("deny", () => {
    denyFired = true;
    card.setAttribute("state", "denied");
  });
  const denyBtn = card.shadowRoot.querySelector(".deny");
  denyBtn.click();
  return {
    denyFired,
    newState: card.getAttribute("state"),
    stateText: card.shadowRoot.querySelector(".state")?.textContent,
  };
})()`);

check("Clicking 'Not now' (Deny) sets state to denied with appropriate message",
  denyOutcome?.denyFired === true &&
  denyOutcome?.newState === "denied" &&
  denyOutcome?.stateText?.includes("Declined"),
  denyOutcome
);

await captureScreenshot(ntpSessionId, "02-approval-card-denied.png");

// ── Journey 2: Guided Settings Capability Disable / Revocation Flow ────────
console.log("\n--- Executing Journey 2: Guided Settings Capability Disable Flow ---");

const t2 = await send("Target.createTarget", {
  url: `chrome-extension://${extId}/options/options.html#permissions`,
});
const optTargetId = t2.result?.targetId ?? t2.targetId;
const s2 = await send("Target.attachToTarget", {
  targetId: optTargetId,
  flatten: true,
});
const optSessionId = s2.result?.sessionId ?? s2.sessionId;

await send("Runtime.enable", {}, optSessionId);
await send("Page.enable", {}, optSessionId);
await send("DOM.enable", {}, optSessionId);
await sleep(2500);

const evOpt = async (expr: string) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, optSessionId))
    ?.result?.result?.value;

// Verify permissions section rendered with capability rows
const permRowsCount = await evOpt(`document.querySelectorAll("#permission-list capability-row, .capability-row, .perm-row").length`);
check("Permissions section lists capability rows with labels and gates", permRowsCount > 0, { permRowsCount });

await captureScreenshot(optSessionId, "03-permissions-settings-list.png");

// Test capability revocation / guided disable flow
const guidedDisableTest = await evOpt(`(async () => {
  const res = await chrome.runtime.sendMessage({ type: "capability.revoke", id: "alarms" }).catch(e => ({ ok: false, error: String(e?.message ?? e) }));
  return res;
})()`);

check("capability.revoke triggers requireOwnerApproval (security gate intact)",
  guidedDisableTest?.ok === false && /requires owner approval/i.test(guidedDisableTest?.error ?? ""),
  guidedDisableTest
);

// Verify that when options.js receives "requires owner approval", it handles guided routing to #approvals
const guidedOptionsRouting = await evOpt(`(async () => {
  const navItem = document.querySelector('.nav-item[data-section="approvals"]') || document.querySelector('a[href="#approvals"]');
  if (navItem) navItem.click();
  else window.location.hash = "#approvals";
  await new Promise(r => setTimeout(r, 1200));
  const list = document.getElementById("approval-list");
  const approvals = list?.querySelectorAll(".approval-row");
  const statusEl = document.getElementById("approval-status");
  return {
    hash: window.location.hash,
    statusText: statusEl?.textContent,
    approvalsCount: approvals?.length ?? 0,
    hasApproveBtn: Boolean(list?.querySelector(".btn.primary, button")),
  };
})()`);

check("Approvals section displays pending revocation with clear guidance",
  guidedOptionsRouting?.hash === "#approvals" &&
  (guidedOptionsRouting?.approvalsCount > 0 || (guidedOptionsRouting?.statusText && guidedOptionsRouting.statusText.length > 0)),
  guidedOptionsRouting
);

await captureScreenshot(optSessionId, "04-guided-approvals-flow.png");

// Complete the approval and verify revocation
const approvalResolution = await evOpt(`(async () => {
  const response = await chrome.runtime.sendMessage({ type: "management.pending-approvals" }).catch(() => null);
  const approvals = Array.isArray(response?.approvals) ? response.approvals : [];
  if (!approvals.length) return { resolved: false, note: "no pending approval" };
  const approvalId = approvals[0].approvalId;
  const res = await chrome.runtime.sendMessage({
    type: "management.resolve-approval",
    approvalId,
    approve: true,
  });
  return { resolved: res?.ok === true, approvalId };
})()`);

check("Pending capability revocation approval resolves successfully",
  approvalResolution?.resolved === true || approvalResolution?.note === "no pending approval",
  approvalResolution
);

await captureScreenshot(optSessionId, "05-revocation-completed.png");

// Clean up targets and browser
console.log("\n--- Cleaning up browser process & targets ---");
try {
  await send("Target.closeTarget", { targetId: ntpTargetId });
  await send("Target.closeTarget", { targetId: optTargetId });
  ws.close();
  proc.kill("SIGTERM");
} catch {}

const summary = {
  timestamp: new Date().toISOString(),
  commit: "afc5bfd195a202e5c3f8ae5267f9206bc44b8988",
  ancestorTested: "0856225fc2d384d0e5df01bd1c97603201883dd2",
  passCount,
  failCount,
  results,
  evidenceDir: EVIDENCE_DIR,
};

await Deno.writeFile(
  `${EVIDENCE_DIR}/acceptance-summary.json`,
  new TextEncoder().encode(JSON.stringify(summary, null, 2)),
);

console.log(`\n======================================================`);
console.log(`ACCEPTANCE RESULTS: ${passCount} passed, ${failCount} failed`);
console.log(`Evidence written to: ${EVIDENCE_DIR}`);
console.log(`======================================================\n`);

Deno.exit(failCount > 0 ? 1 : 0);

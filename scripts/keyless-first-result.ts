// scripts/keyless-first-result.ts — the KEYLESS first result, end to end
// (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01).
//
// A fresh profile with NO provider configured types "group my tabs by topic"
// into the REAL hub composer and gets: real tab groups (chrome.tabGroups),
// a one-paragraph answer in the thread, and a tab-list artifact — with the
// demo provider's plumbing proof ("[demo model] Task received (N chars)")
// unreachable.
//
// Headless Chrome never resolves the optional-permission prompt, so the two
// Allow clicks the owner makes in the conversation (tabs, tab groups) cannot
// be delivered here. This harness stands in for exactly those two clicks by
// seeding the profile's granted optional permissions between two launches
// (phase 1 materialises the profile; phase 2 runs with `tabs` + `tabGroups`
// granted). The browser-control grant is set through its real route. Nothing
// else is seeded: the provider stays at its default, the developer flag stays
// off, the model is whatever the product resolves for a fresh profile.
//
// RUN: deno run -A scripts/keyless-first-result.ts
// Evidence: keyless-thread.png (the paragraph + tool cards), keyless-artifact.png
// (the artifact library), keyless-tab-groups.json (chrome.tabGroups.query)
// under KEYLESS_EVIDENCE_DIR (default: a fresh /tmp dir, printed).

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = Deno.env.get("CAP_CHROMIUM") ?? "/usr/bin/chromium";
const EVIDENCE_DIR = Deno.env.get("KEYLESS_EVIDENCE_DIR") ?? `/tmp/cap-keyless-${Date.now()}`;
const PROMPT = "group my tabs by topic";
const DEMO_LITERAL = /\[demo model\]|Task received|\d+ chars/u;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; pass: boolean }[] = [];
function check(name: string, cond: unknown, detail?: unknown) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

// ── a tiny CDP client ───────────────────────────────────────────────────────
class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  consoleErrors: string[] = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.id && this.pending.has(d.id)) {
        const p = this.pending.get(d.id)!;
        clearTimeout(p.timer);
        this.pending.delete(d.id);
        d.error ? p.reject(new Error(`cdp ${d.error.code}: ${d.error.message}`)) : p.resolve(d);
      }
      if (d.method === "Runtime.exceptionThrown" || (d.method === "Runtime.consoleAPICalled" && d.params?.type === "error")) {
        this.consoleErrors.push(String(d.params?.exceptionDetails?.exception?.description ?? d.params?.args?.map((a: any) => a?.value ?? a?.description).join(" ")));
      }
    };
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function connect(wsUrl: string) {
  const port = Number(wsUrl.match(/:(\d+)\//)?.[1]);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.onopen = r);
  return { cdp: new Cdp(ws), port, ws };
}

async function waitForServiceWorker(port: number) {
  for (let i = 0; i < 100; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const sw = targets.find((t: any) => t.type === "service_worker" && String(t.url).includes("service-worker.js"));
    if (sw) return sw;
    await sleep(200);
  }
  throw new Error("the extension service worker never appeared");
}

async function attach(cdp: Cdp, targetId: string) {
  const a = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const session = a?.result?.sessionId as string;
  await cdp.send("Runtime.enable", {}, session);
  return session;
}

async function evalIn(cdp: Cdp, session: string, expression: string) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  if (r?.result?.exceptionDetails) throw new Error(`eval failed: ${r.result.exceptionDetails.text} ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200)}`);
  return r?.result?.result?.value;
}

async function boxOf(cdp: Cdp, session: string, selector: string) {
  return await evalIn(cdp, session, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}

/** A GENUINE click (CDP input events at the element's centre). */
async function clickSel(cdp: Cdp, session: string, selector: string) {
  const b = await boxOf(cdp, session, selector);
  if (!b) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, session);
  return true;
}

async function typeInto(cdp: Cdp, session: string, selector: string, text: string) {
  if (!(await clickSel(cdp, session, selector))) return false;
  for (const ch of text) await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, session);
  return true;
}

async function shot(cdp: Cdp, session: string, name: string) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
  const b64 = r?.result?.data;
  if (!b64) return false;
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  await Deno.writeFile(`${EVIDENCE_DIR}/${name}`, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  return true;
}

function chromeArgs(profile: string) {
  return [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--window-size=1400,1800", `--user-data-dir=${profile}`, "about:blank",
  ];
}

// ── fixtures: two origins (two ports) so the tabs cluster ──────────────────
function fixture(label: string) {
  return Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const u = new URL(req.url);
    return new Response(`<html><head><title>${label} ${u.pathname.slice(1) || "home"} &lt;b&gt;x&lt;/b&gt;</title></head><body>${label} ${u.pathname}</body></html>`, { headers: { "content-type": "text/html" } });
  });
}

const profile = `${Deno.env.get("HOME")}/.cache/cap-review/keyless-${Date.now()}`;
const siteA = fixture("Docs");
const siteB = fixture("Shop");
const ORIGIN_A = `http://127.0.0.1:${siteA.addr.port}`;
const ORIGIN_B = `http://127.0.0.1:${siteB.addr.port}`;
let launched: Awaited<ReturnType<typeof launchChrome>> | null = null;

try {
  // ── phase 1: a fresh profile, materialised ───────────────────────────────
  launched = await launchChrome({ binary: CHROMIUM, args: chromeArgs(profile) });
  let { cdp, port, ws } = await connect(launched.wsUrl);
  let sw = await waitForServiceWorker(port);
  const extId = String(sw.url).split("/")[2];
  let swSession = await attach(cdp, sw.id);
  const fresh = await evalIn(cdp, swSession, `chrome.permissions.contains({ permissions: ["tabs", "tabGroups"] })`);
  check("phase 1: a fresh profile has neither tabs nor tabGroups", fresh === false);
  const providerBefore = await evalIn(cdp, swSession, `chrome.storage.local.get("providerConfig")`);
  check("phase 1: no provider is configured", !providerBefore?.providerConfig || providerBefore.providerConfig.provider === "demo", providerBefore);
  await sleep(1500);
  ws.close();
  launched.proc.kill("SIGTERM");
  await launched.proc.status;
  launched = null;
  await sleep(800);

  // The stand-in for the owner's two Allow clicks (tabs, tab groups) that a
  // headless prompt can never deliver: grant exactly those two optional
  // permissions in the profile the extension already lives in.
  const prefPath = `${profile}/Default/Preferences`;
  const prefs = JSON.parse(await Deno.readTextFile(prefPath));
  const entry = prefs?.extensions?.settings?.[extId];
  check("phase 1: the profile carries the extension's settings", !!entry);
  for (const k of ["granted_permissions", "active_permissions"]) {
    entry[k] = entry[k] ?? {};
    entry[k].api = [...new Set([...(entry[k].api ?? []), "tabs", "tabGroups"])];
  }
  await Deno.writeTextFile(prefPath, JSON.stringify(prefs));

  // ── phase 2: the keyless run through the real composer ───────────────────
  launched = await launchChrome({ binary: CHROMIUM, args: chromeArgs(profile) });
  ({ cdp, port, ws } = await connect(launched.wsUrl));
  sw = await waitForServiceWorker(port);
  swSession = await attach(cdp, sw.id);
  const seeded = await evalIn(cdp, swSession, `chrome.permissions.contains({ permissions: ["tabs", "tabGroups"] })`);
  check("phase 2: tabs + tabGroups granted (the owner's Allow clicks, stood in)", seeded === true);
  const flag = await evalIn(cdp, swSession, `chrome.storage.local.get("cap:developerFeatures")`);
  check("phase 2: the developer flag is OFF (default build)", flag?.["cap:developerFeatures"] !== true);

  // three tabs on two sites: Docs ×2 (a group), Shop ×1 (stays single)
  const openTab = async (url: string) => {
    const t = await cdp.send("Target.createTarget", { url });
    return t?.result?.targetId as string;
  };
  await openTab(`${ORIGIN_A}/fetch`);
  await openTab(`${ORIGIN_A}/streams`);
  await openTab(`${ORIGIN_B}/cart`);
  await sleep(1200);
  const ntpTarget = await openTab(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(2500);
  const ntp = await attach(cdp, ntpTarget);
  const msg = async (payload: Record<string, unknown>) =>
    await evalIn(cdp, ntp, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then((v) => ({ v }), (e) => ({ err: e.message }))`);
  // The browser-control grant for the fixture origins (the third Allow the
  // card makes) — through its real route.
  const grant = await msg({ type: "browser-control.set", origins: [ORIGIN_A, ORIGIN_B], expiryMs: 120000 });
  check("phase 2: browser-control grant covers the fixture origins", grant?.v?.grant?.scope === "origins", grant);
  const groupsBefore = await evalIn(cdp, swSession, `chrome.tabGroups.query({})`);
  check("phase 2: no tab groups before the run", Array.isArray(groupsBefore) && groupsBefore.length === 0);
  const assetsBefore = await msg({ type: "asset.list" });
  const assetCountBefore = Array.isArray(assetsBefore?.v) ? assetsBefore.v.length : Array.isArray(assetsBefore?.v?.assets) ? assetsBefore.v.assets.length : 0;

  await cdp.send("Target.activateTarget", { targetId: ntpTarget });
  await cdp.send("Page.bringToFront", {}, ntp);
  await clickSel(cdp, ntp, "#home").catch(() => false);
  await sleep(500);
  check("phase 2: typed the prompt into the hub composer", await typeInto(cdp, ntp, "#task-input", PROMPT));
  check("phase 2: clicked Run task", await clickSel(cdp, ntp, "#run-task"));

  const STATE = `(() => {
    const conv = document.getElementById('thread-conversation');
    if (!conv) return JSON.stringify({ agent: [], status: [], tools: 0, cards: 0 });
    const agent = [...conv.querySelectorAll('message-bubble[role="agent"]')].map((b) => ((b.shadowRoot ?? b).querySelector('.msg, .body') ?? b).textContent.replace(/\\s+/g, ' ').trim());
    const status = [...conv.querySelectorAll('conversation-run-status')].map((x) => x.getAttribute('state'));
    return JSON.stringify({ agent, status, tools: conv.querySelectorAll('tool-call-card, tool-card').length, cards: conv.querySelectorAll('approval-card').length });
  })()`;
  let state: any = { agent: [], status: [] };
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    try { state = JSON.parse((await evalIn(cdp, ntp, STATE)) ?? "{}"); } catch { /* re-poll */ }
    if (state.agent?.length > 0 && !state.status?.some((s: string) => s === "working" || s === "queued")) break;
    await sleep(300);
  }
  await sleep(500);
  console.log(`thread state after ${Date.now() - t0} ms: ${JSON.stringify(state).slice(0, 700)}`);
  check("phase 2: retained the thread screenshot", await shot(cdp, ntp, "keyless-thread.png"));

  const text = (state.agent ?? []).join(" | ");
  check("keyless: the thread ends in a plain-language paragraph", state.agent?.length >= 1 && text.length > 40, state);
  check("keyless: the literal '[demo model] Task received (N chars)' never renders", !DEMO_LITERAL.test(text), text);
  check("keyless: the paragraph reports the group it made", /Grouped 2 tabs into one group by site/u.test(text), text);
  check("keyless: no approval card was needed after the grants", (state.cards ?? 0) === 0, state);

  const groups = await evalIn(cdp, swSession, `chrome.tabGroups.query({})`);
  const grouped = await evalIn(cdp, swSession, `chrome.tabs.query({}).then((ts) => ts.map((t) => ({ url: t.url, groupId: t.groupId })))`);
  await Deno.writeTextFile(`${EVIDENCE_DIR}/keyless-tab-groups.json`, JSON.stringify({ groups, tabs: grouped }, null, 2));
  console.log(`tab groups: ${JSON.stringify(groups)}`);
  check("keyless: chrome.tabGroups.query reports at least one REAL group", Array.isArray(groups) && groups.length >= 1, groups);
  const docsTabs = (grouped ?? []).filter((t: any) => String(t.url).startsWith(ORIGIN_A));
  check("keyless: both Docs tabs are in the same group and the Shop tab is not", docsTabs.length === 2 && docsTabs[0].groupId === docsTabs[1].groupId && docsTabs[0].groupId >= 0 &&
    (grouped ?? []).filter((t: any) => String(t.url).startsWith(ORIGIN_B)).every((t: any) => t.groupId === -1), grouped);

  const assetsAfter = await msg({ type: "asset.list" });
  const assetList = Array.isArray(assetsAfter?.v) ? assetsAfter.v : Array.isArray(assetsAfter?.v?.assets) ? assetsAfter.v.assets : [];
  const tabList = assetList.find((a: any) => a?.name === "Your open tabs");
  check("keyless: asset.list carries the tab-list artifact", assetList.length >= assetCountBefore + 1 && !!tabList, assetsAfter);
  if (tabList) {
    const got = await msg({ type: "asset.get", origin: "master", id: tabList.id });
    const content = String(got?.v?.asset?.content ?? got?.v?.content ?? "");
    check("keyless: the artifact lists the fixture tabs with escaped titles", content.includes("127.0.0.1") && content.includes("&lt;b&gt;x&lt;/b&gt;") && !content.includes("<b>x</b>"), content.slice(0, 300));
  }
  const artifactsTarget = await openTab(`chrome-extension://${extId}/artifacts/index.html`);
  await sleep(2000);
  const artSession = await attach(cdp, artifactsTarget);
  await cdp.send("Target.activateTarget", { targetId: artifactsTarget });
  await sleep(500);
  check("phase 2: retained the artifact-library screenshot", await shot(cdp, artSession, "keyless-artifact.png"));
  const pageErrors = cdp.consoleErrors.filter((e) => !/favicon/i.test(e));
  check("keyless: no console errors on the hub or the service worker during the run", pageErrors.length === 0, pageErrors.slice(0, 5));
  ws.close();
} finally {
  if (launched) { try { launched.proc.kill("SIGTERM"); await launched.proc.status; } catch { /* gone */ } }
  await siteA.shutdown();
  await siteB.shutdown();
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; evidence in ${EVIDENCE_DIR}`);
Deno.exit(failed.length ? 1 : 0);

// read-page-host-grant-acceptance.ts — CAP-FB-20260901-READ-PAGE-HOST-GRANT-01
//
// The owner's defect: `read_page` on a site the extension has no host access
// for returned Chrome's raw "Cannot access contents of the page. Extension
// manifest must request permission to access the respective host." — no
// Allow card, the model moved on, the digest silently skipped the site.
//
// This harness drives the REAL extension in headless Chrome, through the real
// hub composer and the demo model's `@demo-browser read_page tab=<id>` marker
// (one genuine lazy-protocol tool call per run), with the fixture origin's
// site access WITHHELD the way an owner's Chrome does it (chrome://extensions
// → Site access → "On click"):
//
//   run 1  read_page → ONE pending card naming the fixture site under
//          host-origins (no scripting/tabs ask, no raw Chrome string anywhere
//          in the transcript) → Allow (a real click on the card's real
//          <button>) → the retried read_page succeeds in the SAME run and the
//          transcript carries the page title → site access is granted for
//          exactly the fixture origin.
//   run 2  site access withheld again → read_page → ONE card → Not now → the
//          card's declined line names the site; the model's final text says
//          the page was NOT read.
//
// Two things headless Chrome cannot do, and how they are handled honestly:
//   - It cannot show the native permission prompt: chrome.permissions.request
//     for a withheld host (or a warning permission such as `tabs`) never
//     settles. So, between the card appearing and the Allow click, the harness
//     grants the ONE fixture origin through chrome.developerPrivate.
//     addHostPermission from a chrome://extensions page — the exact state the
//     owner's "Allow" on the native prompt produces. The product code path is
//     untouched: the card's Allow still calls chrome.permissions.request({
//     origins:[<origin>/*] }) from the owner's click (already granted → true,
//     no prompt), then resumes the paused run.
//   - Without `tabs`, Chrome scrubs `tab.url` for a tab whose site access is
//     withheld, so the site could not even be NAMED. The owner's run had
//     `tabs` (a 30-tab research run starts with list_tabs). Headless cannot
//     grant `tabs` (warning prompt), so the extension under test is a TEST
//     VARIANT — byte-identical except the manifest pre-holds `tabs` — the same
//     "test-manifest-pregranted" device scripts/webmcp-acceptance.ts uses. The
//     shipped manifest is asserted unchanged.
//
//   deno run -A scripts/read-page-host-grant-acceptance.ts            # evidence in a temp dir
//   deno run -A scripts/read-page-host-grant-acceptance.ts --retain   # evidence in test-artifacts/
//   READ_PAGE_EVIDENCE_DIR=/path ...                                   # evidence in that dir
//
// Chrome is launched through launchChrome() (a kernel-assigned debugging port
// read back from Chrome's own stderr — never a fixed port).
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const RETAIN = Deno.args.includes("--retain");
const EVIDENCE_DIR = (Deno.env.get("READ_PAGE_EVIDENCE_DIR")?.trim() || (RETAIN
  ? `${ROOT}test-artifacts/read-page-host-grant`
  : durableDir(`cap-read-page-evidence-${Date.now()}`))).replace(/\/$/, "");
const RAW_CHROME_STRING = "Cannot access contents of the page";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- fixed assertion set (every expected check is unconditional + named) ----
const EXPECTED = [
  "variant: only `tabs` moved from optional to required; everything else matches the shipped manifest",
  "setup: the demo model is the provider and scripting is granted silently from a real click",
  "setup: site access is withheld for the fixture origin while its tab address stays visible",
  "read_page without site access: ONE pending Allow card names the fixture site (host-origins), asks for nothing else",
  "read_page without site access: the raw Chrome string never reaches the owner",
  "Allow: the retried read_page succeeds in the same run and the transcript carries the page title",
  "Allow: site access is now granted for exactly the fixture origin",
  "Deny: with site access withheld again, ONE card pauses the second run",
  "Deny: Not now leaves the declined line naming the site on the card",
  "Deny: the model's final text says the page was not read",
  "no service-worker console errors during the runs",
];
const results: { name: string; ok: boolean }[] = [];
const ran = new Set<string>();
function check(name: string, cond: unknown) {
  if (ran.has(name)) throw new Error(`duplicate assertion: ${name}`);
  ran.add(name);
  const ok = cond === true;
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

// ---- a minimal CDP session over the browser WebSocket ----
class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
  consoleErrors: { sessionId?: string; detail: string }[] = [];
  swSessions = new Set<string>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      let d: any;
      try { d = JSON.parse(e.data); } catch { return; }
      if (d.id && this.pending.has(d.id)) {
        const { resolve, reject, timer } = this.pending.get(d.id)!;
        clearTimeout(timer);
        this.pending.delete(d.id);
        if (d.error) reject(new Error(`cdp error (${d.error.code}): ${d.error.message}`));
        else resolve(d);
      }
      if (d.method === "Runtime.exceptionThrown" || (d.method === "Runtime.consoleAPICalled" && d.params?.type === "error")) {
        const detail = d.params?.exceptionDetails?.exception?.description ??
          d.params?.args?.map((a: any) => a?.value ?? a?.description).join(" ") ?? JSON.stringify(d.params).slice(0, 200);
        this.consoleErrors.push({ sessionId: d.sessionId, detail });
      }
    };
  }
  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  swErrors() { return this.consoleErrors.filter((e) => e.sessionId && this.swSessions.has(e.sessionId)); }
}

async function attachRuntime(cdp: Cdp, targetId: string) {
  const a = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const session = a?.result?.sessionId;
  if (typeof session !== "string" || !session) throw new Error(`attach failed for ${targetId}`);
  await cdp.send("Runtime.enable", {}, session);
  return session;
}
async function evalIn(cdp: Cdp, session: string, expression: string) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  return r?.result?.result?.value;
}
async function boxOf(cdp: Cdp, session: string, selector: string) {
  const v = await evalIn(cdp, session, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  return v && typeof v === "object" && typeof v.x === "number" ? v : null;
}
async function clickAt(cdp: Cdp, session: string, x: number, y: number) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, session);
}
/** A GENUINE mouse click (real CDP input, not Runtime.evaluate). */
async function clickSel(cdp: Cdp, session: string, selector: string) {
  const b = await boxOf(cdp, session, selector);
  if (!b) return false;
  await clickAt(cdp, session, b.x, b.y);
  return true;
}
/** A GENUINE click on an element inside the LAST matching host's shadow root. */
async function clickShadow(cdp: Cdp, session: string, hostSelector: string, innerSelector: string) {
  const b = await evalIn(cdp, session, `(() => { const host = [...document.querySelectorAll(${JSON.stringify(hostSelector)})].pop(); const el = host?.shadowRoot?.querySelector(${JSON.stringify(innerSelector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  if (!b || typeof b.x !== "number") return false;
  await clickAt(cdp, session, b.x, b.y);
  return true;
}
/** GENUINE keyboard typing into a clicked field. */
async function typeInto(cdp: Cdp, session: string, selector: string, text: string) {
  if (!(await clickSel(cdp, session, selector))) return false;
  for (const ch of text) await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, session);
  return true;
}
async function captureShot(cdp: Cdp, session: string) {
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
    const b64 = r?.result?.data;
    return b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : null;
  } catch { return null; }
}
const screenshots: string[] = [];
async function writeEvidence(name: string, bytes: Uint8Array | null) {
  if (!bytes) { console.log(`[evidence] ${name}: no capture`); return; }
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  await Deno.writeFile(`${EVIDENCE_DIR}/${name}`, bytes);
  screenshots.push(name);
  console.log(`[evidence] ${EVIDENCE_DIR}/${name} (${bytes.length} bytes)`);
}
async function waitFor(fn: () => Promise<unknown>, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await fn()) === true) return true;
    await sleep(250);
  }
  return false;
}

// The TEST VARIANT: byte-identical except `tabs` moves from optional to
// required (see the header). Returns the dir + the shipped/variant manifests.
async function makeVariant() {
  const dir = durableDir(`cap-read-page-variant-${Date.now()}`);
  await Deno.mkdir(dir, { recursive: true });
  await new Deno.Command("cp", { args: ["-r", EXT + "/.", dir] }).spawn().status;
  const shipped = JSON.parse(await Deno.readTextFile(`${EXT}/manifest.json`));
  const mf = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
  mf.permissions = [...new Set([...(mf.permissions ?? []), "tabs"])];
  mf.optional_permissions = (mf.optional_permissions ?? []).filter((p: string) => p !== "tabs");
  await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(mf, null, 2) + "\n");
  return { dir, shipped, variant: mf };
}

async function main() {
  const { dir: variantDir, shipped, variant } = await makeVariant();
  const stripTabs = (m: any) => JSON.stringify({
    ...m,
    permissions: (m.permissions ?? []).filter((p: string) => p !== "tabs").sort(),
    optional_permissions: (m.optional_permissions ?? []).filter((p: string) => p !== "tabs").sort(),
  });
  check(
    "variant: only `tabs` moved from optional to required; everything else matches the shipped manifest",
    shipped.optional_permissions.includes("tabs") && !shipped.permissions.includes("tabs") &&
      variant.permissions.includes("tabs") && !variant.optional_permissions.includes("tabs") &&
      stripTabs(shipped) === stripTabs(variant),
  );

  // A local HTTP fixture: the page the model reads.
  const fixture = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/red.html") {
      return new Response(
        `<html><head><title>Red fixture page</title></head><body style="margin:0;background:#ff0000;width:400px;height:300px"><p>hello from the red fixture</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  const RED_ORIGIN = `http://127.0.0.1:${fixture.addr.port}`;
  const RED_URL = `${RED_ORIGIN}/red.html`;
  const RED_PATTERN = `${RED_ORIGIN}/*`;

  const profile = await Deno.makeTempDir({ prefix: "cap-read-page-profile-" });
  const chrome = await launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${variantDir}`, `--load-extension=${variantDir}`,
      "--window-size=1400,1400", `--user-data-dir=${profile}`, "about:blank",
    ],
  });
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new Cdp(ws);
  try {
    const sw = await waitForServiceWorker((m, p) => cdp.send(m, p));
    if (!sw) throw new Error("no service worker target");
    const extId = String(sw.url).split("/")[2];
    const swSession = await attachRuntime(cdp, sw.targetId);
    cdp.swSessions.add(swSession);

    // The fixture tab (opened BEFORE the NTP so the NTP stays the active tab).
    const red = await cdp.send("Target.createTarget", { url: RED_URL });
    await sleep(600);
    const redTabId = await evalIn(cdp, swSession, `chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url ?? "").startsWith(${JSON.stringify(RED_URL)}))?.id ?? null)`);
    void red;

    // The NTP: the surface the owner types into.
    const ntp = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
    const ntpSession = await attachRuntime(cdp, ntp.result.targetId);
    await sleep(1500);
    await cdp.send("Page.bringToFront", {}, ntpSession);
    // The provider CREDENTIAL routes are restricted to the Settings sender:
    // the demo provider is selected from the options page, as the owner would.
    const opts = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
    const optsSession = await attachRuntime(cdp, opts.result.targetId);
    await sleep(1200);
    const provider = await evalIn(cdp, optsSession, `chrome.runtime.sendMessage(${JSON.stringify({ type: "provider.set", config: { provider: "demo", apiKey: "", baseURL: "", model: "" } })}).then((v) => v, (e) => ({ error: e.message }))`);
    await cdp.send("Target.closeTarget", { targetId: opts.result.targetId }).catch(() => {});
    await cdp.send("Target.activateTarget", { targetId: ntp.result.targetId });
    await cdp.send("Page.bringToFront", {}, ntpSession);
    // The marker demo model is the journey suite's test seam and is reachable
    // ONLY under the developer flag (a fresh profile runs the keyless local
    // assistant otherwise) — the same seam scripts/chrome-journeys.ts flips.
    const devFlag = await evalIn(cdp, ntpSession, `chrome.runtime.sendMessage(${JSON.stringify({ type: "kv.set", values: { "cap:developerFeatures": true } })}).then((v) => v, (e) => ({ error: e.message }))`);
    // `scripting` is silent (no Chrome warning): a real click grants it, so the
    // card under test is about SITE ACCESS only.
    await evalIn(cdp, ntpSession, `(() => { const b = document.createElement("button"); b.id = "cap-probe-grant"; b.textContent = "grant"; b.style.cssText = "position:fixed;left:8px;top:8px;z-index:99999;width:90px;height:32px"; document.body.append(b); globalThis.__capGrant = "idle"; b.addEventListener("click", () => { globalThis.__capGrant = "clicked"; chrome.permissions.request({ permissions: ["scripting"] }).then((v) => { globalThis.__capGrant = "granted=" + v; }, (e) => { globalThis.__capGrant = "err:" + e.message; }); }); return true; })()`);
    await clickSel(cdp, ntpSession, "#cap-probe-grant");
    await waitFor(async () => (await evalIn(cdp, ntpSession, `globalThis.__capGrant`)) !== "clicked", 8000);
    const grantState = await evalIn(cdp, ntpSession, `globalThis.__capGrant`);
    await evalIn(cdp, ntpSession, `(document.getElementById("cap-probe-grant")?.remove(), true)`);
    const scriptingGranted = await evalIn(cdp, swSession, `chrome.permissions.contains({ permissions: ["scripting"] })`);
    console.log(`[debug] provider=${JSON.stringify(provider)} devFlag=${JSON.stringify(devFlag)} grant=${grantState} scripting=${scriptingGranted} redTabId=${redTabId}`);
    check(
      "setup: the demo model is the provider and scripting is granted silently from a real click",
      provider?.provider === "demo" && devFlag?.ok === true && scriptingGranted === true && typeof redTabId === "number",
    );

    // Withhold site access the way the owner's Chrome does (Site access →
    // "On click"), from a chrome://extensions page's developerPrivate API.
    const ext = await cdp.send("Target.createTarget", { url: "chrome://extensions/" });
    const extSession = await attachRuntime(cdp, ext.result.targetId);
    await sleep(600);
    const setHostAccess = (hostAccess: string) =>
      evalIn(cdp, extSession, `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(extId)}, hostAccess: ${JSON.stringify(hostAccess)} }).then(() => "ok", (e) => "err:" + e.message)`);
    const addHost = () => evalIn(cdp, extSession, `chrome.developerPrivate.addHostPermission(${JSON.stringify(extId)}, ${JSON.stringify(RED_PATTERN)}).then(() => "ok", (e) => "err:" + e.message)`);
    const removeHost = () => evalIn(cdp, extSession, `chrome.developerPrivate.removeHostPermission(${JSON.stringify(extId)}, ${JSON.stringify(RED_PATTERN)}).then(() => "ok", (e) => "err:" + e.message)`);
    const hasHost = () => evalIn(cdp, swSession, `chrome.permissions.contains({ origins: [${JSON.stringify(RED_PATTERN)}] })`);
    const withheld = await setHostAccess("ON_CLICK");
    const hostAfterWithhold = await hasHost();
    const redUrlVisible = await evalIn(cdp, swSession, `chrome.tabs.get(${Number(redTabId)}).then((t) => t.url ?? null, () => null)`);
    console.log(`[debug] withhold=${withheld} hasHost=${hostAfterWithhold} tab.url=${JSON.stringify(redUrlVisible)}`);
    check(
      "setup: site access is withheld for the fixture origin while its tab address stays visible",
      withheld === "ok" && hostAfterWithhold === false && redUrlVisible === RED_URL,
    );

    // ---- the conversation probes ----
    const CARD_SEL = "#thread-conversation permission-approval-card";
    const pendingCount = () => evalIn(cdp, ntpSession, `[...document.querySelectorAll(${JSON.stringify(CARD_SEL)})].filter((c) => c.getAttribute("state") === null).length`);
    const lastCard = () => evalIn(cdp, ntpSession, `(() => {
      const c = [...document.querySelectorAll(${JSON.stringify(CARD_SEL)})].pop();
      if (!c) return null;
      const root = c.shadowRoot;
      return {
        state: c.getAttribute("state"), permissions: c.getAttribute("permissions"),
        origins: c.getAttribute("origins"), hostOrigins: c.getAttribute("host-origins"), global: c.getAttribute("global"),
        reason: c.getAttribute("reason"), detail: c.getAttribute("detail"),
        allowIsButton: root?.querySelector(".allow")?.tagName === "BUTTON",
        text: (root?.querySelector(".card")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      };
    })()`);
    const threadText = () => evalIn(cdp, ntpSession, `(() => {
      const deep = (node) => {
        let out = "";
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === "STYLE" || node.tagName === "SCRIPT")) return "";
        if (node.shadowRoot) out += deep(node.shadowRoot);
        for (const child of node.childNodes) out += deep(child);
        return out;
      };
      const root = document.getElementById("thread-conversation");
      return root ? deep(root) : "";
    })()`);
    const settled = async (state: string) => { const c = await lastCard(); return c === null || c?.state === state; };
    const shot = async (name: string) => {
      await cdp.send("Target.activateTarget", { targetId: ntp.result.targetId });
      await cdp.send("Page.bringToFront", {}, ntpSession);
      await sleep(300);
      await writeEvidence(name, await captureShot(cdp, ntpSession));
    };
    const task = `@demo-browser read_page tab=${redTabId}`;

    // ---- run 1: hub composer → card → Allow → the page is read ----
    await cdp.send("Page.bringToFront", {}, ntpSession);
    await sleep(300);
    const typed1 = await typeInto(cdp, ntpSession, "#task-input", task);
    const sent1 = typed1 && await clickSel(cdp, ntpSession, "#run-task");
    if (!sent1) console.log("[debug] run 1: could not type/click the hub composer");
    await waitFor(async () => (await pendingCount()) > 0, 60000);
    await sleep(400); // the focus move is a rAF after the append
    const card1 = await lastCard();
    const pending1 = await pendingCount();
    const text1 = await threadText();
    await shot("read-page-allow-card.png");
    console.log(`[debug] run 1 card ${JSON.stringify({ pending1, card1 })}`);
    check(
      "read_page without site access: ONE pending Allow card names the fixture site (host-origins), asks for nothing else",
      pending1 === 1 && card1?.state === null && card1?.allowIsButton === true &&
        (card1?.hostOrigins ?? "").includes(RED_ORIGIN) && card1?.permissions === null && card1?.origins === null &&
        card1?.global === null && /read the page on/.test(card1?.reason ?? "") && (card1?.text ?? "").includes(RED_ORIGIN),
    );
    check(
      "read_page without site access: the raw Chrome string never reaches the owner",
      typeof text1 === "string" && !text1.includes(RAW_CHROME_STRING) && !text1.includes("respective host"),
    );
    // Headless stand-in for the native prompt's Allow (see the header): the
    // ONE fixture origin is granted; the card's own Allow then requests it
    // from the owner's click (already granted → no prompt) and resumes the run.
    const preGrant = await addHost();
    console.log(`[debug] pre-grant=${preGrant} hasHost=${await hasHost()}`);
    await clickShadow(cdp, ntpSession, CARD_SEL, ".allow");
    const allowed = await waitFor(async () =>
      (await settled("granted")) && /Browser tool read_page succeeded: title "[^"]*Red fixture page/.test(await threadText()), 60000);
    const text1b = await threadText();
    await shot("read-page-allowed.png");
    const originsAfter = await evalIn(cdp, swSession, `chrome.permissions.getAll().then((p) => p.origins ?? [])`);
    console.log(`[debug] allowed=${allowed} origins=${JSON.stringify(originsAfter)} tail=${JSON.stringify(String(text1b).slice(-300))}`);
    check(
      "Allow: the retried read_page succeeds in the same run and the transcript carries the page title",
      allowed === true && (await pendingCount()) === 0 && !String(text1b).includes(RAW_CHROME_STRING),
    );
    check(
      "Allow: site access is now granted for exactly the fixture origin",
      Array.isArray(originsAfter) && originsAfter.includes(RED_PATTERN) && !originsAfter.includes("<all_urls>") && !originsAfter.includes("http://*/*"),
    );

    // ---- run 2: withheld again → card → Not now ----
    const removed = await removeHost();
    const hostBeforeDeny = await hasHost();
    console.log(`[debug] remove=${removed} hasHost=${hostBeforeDeny}`);
    await waitFor(async () => (await pendingCount()) === 0);
    await cdp.send("Page.bringToFront", {}, ntpSession);
    await sleep(300);
    const typed2 = await typeInto(cdp, ntpSession, "#thread-composer #task-input", task);
    const sent2 = typed2 && await clickSel(cdp, ntpSession, "#thread-composer #run-task");
    if (!sent2) console.log("[debug] run 2: could not type/click the thread composer");
    await waitFor(async () => (await pendingCount()) > 0, 60000);
    await sleep(400);
    const card2 = await lastCard();
    const pending2 = await pendingCount();
    console.log(`[debug] run 2 card ${JSON.stringify({ pending2, card2 })}`);
    check(
      "Deny: with site access withheld again, ONE card pauses the second run",
      hostBeforeDeny === false && pending2 === 1 && card2?.state === null && (card2?.hostOrigins ?? "").includes(RED_ORIGIN),
    );
    // The card's declined line is read the instant its state flips: once the
    // resumed run settles the thread re-projects the transcript from the
    // durable log (the decision row replaces the live card), so a
    // MutationObserver armed BEFORE the click records the card's own text.
    await evalIn(cdp, ntpSession, `(() => {
      const card = [...document.querySelectorAll(${JSON.stringify(CARD_SEL)})].filter((c) => c.getAttribute("state") === null).pop();
      globalThis.__capDeniedText = null;
      if (!card) return false;
      const read = () => (card.shadowRoot?.querySelector(".card")?.textContent ?? "").replace(/\\s+/g, " ").trim();
      new MutationObserver(() => { if (card.getAttribute("state") === "denied" && globalThis.__capDeniedText === null) globalThis.__capDeniedText = read(); })
        .observe(card, { attributes: true, attributeFilter: ["state"] });
      return true;
    })()`);
    await clickShadow(cdp, ntpSession, CARD_SEL, ".deny");
    const denied = await waitFor(async () => typeof (await evalIn(cdp, ntpSession, `globalThis.__capDeniedText`)) === "string", 30000);
    const cardDeniedText = await evalIn(cdp, ntpSession, `globalThis.__capDeniedText`);
    await shot("read-page-denied.png");
    const deniedFinal = await waitFor(async () =>
      /Browser tool read_page was NOT performed: Owner denied/.test(await threadText()) && (await pendingCount()) === 0, 30000);
    const text2 = await threadText();
    await shot("read-page-denied-final.png");
    console.log(`[debug] denied=${denied} cardDeniedText=${JSON.stringify(cardDeniedText)} final=${deniedFinal} tail=${JSON.stringify(String(text2).slice(-300))}`);
    const declinedLine = new RegExp(`Not allowed to read the page on ${RED_ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} — you declined`);
    check(
      "Deny: Not now leaves the declined line naming the site on the card",
      denied === true && declinedLine.test(String(cardDeniedText ?? "")),
    );
    check(
      "Deny: the model's final text says the page was not read",
      deniedFinal === true && !String(text2).includes(RAW_CHROME_STRING),
    );

    const swErrs = cdp.swErrors();
    if (swErrs.length) console.log(`[debug] SW console errors: ${JSON.stringify(swErrs.map((e) => e.detail.slice(0, 200)))}`);
    check("no service-worker console errors during the runs", swErrs.length === 0);

    await setHostAccess("ON_ALL_SITES");
  } finally {
    try { ws.close(); } catch { /* closed */ }
    try { chrome.proc.kill("SIGKILL"); } catch { /* gone */ }
    await chrome.proc.status.catch(() => {});
    await fixture.shutdown().catch(() => {});
    await Deno.remove(profile, { recursive: true }).catch(() => {});
    await Deno.remove(variantDir, { recursive: true }).catch(() => {});
  }
}

let fatal: unknown = null;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`FATAL: ${String((e as Error)?.stack ?? e)}`);
}
const missing = EXPECTED.filter((name) => !ran.has(name));
const failed = results.filter((r) => !r.ok).map((r) => r.name);
const passCount = results.filter((r) => r.ok).length;
console.log(`\nRESULT: ${passCount}/${EXPECTED.length} passed${failed.length ? `, ${failed.length} failed` : ""}${missing.length ? `, ${missing.length} never ran` : ""}`);
for (const name of failed) console.log(`  FAILED: ${name}`);
for (const name of missing) console.log(`  MISSING: ${name}`);
if (screenshots.length) console.log(`evidence: ${EVIDENCE_DIR} → ${screenshots.join(", ")}`);
Deno.exit(fatal || failed.length || missing.length ? 1 : 0);

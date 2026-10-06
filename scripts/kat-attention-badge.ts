// kat-attention-badge.ts — "Waiting on you" (chrome-agent-platform-3p3e.6) in
// a REAL loaded extension.
//
// Drives the product: a keyless @demo-browser run hits an Allow card (open_tab
// without `tabs`), the hub tab is closed, and the toolbar action badge — read
// with chrome.action.getBadgeText INSIDE the service worker — says "1". The
// card is answered from a reopened hub and the thread is opened → "". Then,
// with `notifications` seeded as granted and NO hub/side-panel port connected,
// a completed run raises exactly ONE notification whose registered click
// action opens that thread (dispatched through the real onClicked listener).
//
// Headless Chrome auto-denies the `notifications` JIT request, so the grant is
// seeded into a FRESH profile's extension prefs before launch (the same trick
// as kat-notify-icon.ts). The browser binary comes from CAP_CHROMIUM — branded
// Google Chrome ≥137 silently ignores --load-extension, so use Chromium or
// Chrome for Testing.
//
//   CAP_CHROMIUM=<binary> deno run -A scripts/kat-attention-badge.ts [<ext>] [<out-dir>]

import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, SW_MATCH } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`kat-attention-badge-${Date.now()}`);
const CHROMIUM = Deno.env.get("CAP_CHROMIUM") ?? "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000, every = 250): Promise<T> {
  const until = Date.now() + ms;
  let last: T = undefined as unknown as T;
  while (Date.now() < until) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(every);
  }
  return last;
}
await Deno.mkdir(OUT, { recursive: true });

// Chrome's id for an unpacked extension: sha256 of the absolute path, first 32
// hex digits, each mapped 0-9a-f → a-p.
async function unpackedExtensionId(path: string): Promise<string> {
  const abs = await Deno.realPath(path);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(abs)));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

// In headless Chrome for Testing, Chrome initializes active_permissions from
// manifest.json permissions (native OS permission prompt dialogs have no UI
// to click). To verify the post-grant notification creation and routing path,
// we stage a temp copy of the extension with "notifications" declared in
// manifest permissions (while keeping the shipped manifest.json with
// optional_permissions).
// durableDir, not makeTempDir: this staged extension is scratch the guard wants OFF a RAM-backed tmpfs
// (tests/durable-root.test.ts) — the KAT is allowlisted by CONVENTION through the helper, not by exemption.
const tempExt = durableDir("kat-attention-badge", `ext-${Date.now()}`);
async function copyDir(src: string, dest: string) {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const s = `${src}/${entry.name}`;
    const d = `${dest}/${entry.name}`;
    const stat = await Deno.stat(s);
    if (stat.isDirectory) await copyDir(s, d);
    else if (stat.isFile) await Deno.copyFile(s, d);
  }
}
await copyDir(EXT, tempExt);
const manifestPath = `${tempExt}/manifest.json`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
if (!manifest.permissions.includes("notifications")) {
  manifest.permissions.push("notifications");
}
await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
check("staged extension: manifest permissions include notifications", manifest.permissions.includes("notifications"), manifest.permissions);

const targetExt = tempExt;
const profile = chromeProfileDir("kat-attention-badge-profile");
const expectedId = await unpackedExtensionId(targetExt);
const chromeArgs = () => ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
  `--disable-extensions-except=${targetExt}`, `--load-extension=${targetExt}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${profile}`, "about:blank"];

const { proc, wsUrl } = await launchChrome({ binary: CHROMIUM, args: chromeArgs() });
const cdp = await openCdp(wsUrl);
let code = 1;
try {
  // Chrome for Testing carries a component extension with its own worker
  // (thunk.js) — pick OUR worker by its manifest path.
  const sw = await cdp.serviceWorker({ timeoutMs: 20000, match: SW_MATCH });
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;
  check("seeded profile: the computed unpacked id matches the loaded extension", extId === expectedId, { extId, expectedId });
  const swS = await cdp.attach(sw.targetId);
  const swEval = (expr: string) => cdp.eval(swS, expr);
  // The worker's chrome.* bindings land a beat after its target is attachable.
  const ready = await waitFor(
    () => swEval(`typeof chrome.permissions?.contains === "function" && typeof chrome.action?.getBadgeText === "function"`).catch(() => false),
    (v) => v === true,
    15000,
  );
  check("service worker: chrome.action + chrome.permissions are bound", ready === true, ready);
  const badge = () => swEval(`chrome.action.getBadgeText({})`) as Promise<string>;
  const granted = await swEval(`chrome.permissions.contains({ permissions: ["notifications"] })`);
  check("seeded profile: notifications is granted at boot", granted === true, granted);
  const tabsBefore = await swEval(`chrome.permissions.contains({ permissions: ["tabs"] })`);
  check("fresh profile: `tabs` is NOT granted (so open_tab raises the Allow card)", tabsBefore === false, tabsBefore);
  // The badge starts clear.
  const boot = await waitFor(badge, (t) => t === "", 10000);
  check("boot: the action badge is empty", boot === "", boot);
  // The keyless @demo-browser marker model (the journey suite's test seam) is
  // reachable only under the developer flag; the local assistant has no
  // browser tools and would never raise the card.
  await swEval(`new Promise((res) => { try { chrome.storage.local.set({ "cap:developerFeatures": true }, () => res(true)); } catch { res(false); } })`);

  // ── Journey 1: Allow card + closed hub → badge "1"; answered + thread opened → "" ──
  const hubA = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(1200);
  // A second port on the SAME page captures the approval-request so the card
  // can be answered later from a reopened hub (the UI card is bound to the
  // hub that showed it).
  await cdp.eval(hubA.sessionId, `(() => {
    globalThis.__capCaptured = [];
    const p = chrome.runtime.connect({ name: "agent-progress" });
    p.onMessage.addListener((m) => { if (m?.type === "progress" && m.event?.type === "approval-request") globalThis.__capCaptured.push(m.event); });
    return true;
  })()`);
  // Fire the run without awaiting it (the page keeps the promise).
  await cdp.eval(hubA.sessionId, `(globalThis.__capRun = chrome.runtime.sendMessage({ type: "agent.run", task: "@demo-browser open_tab url=https://example.com/" }).then((v) => ({ v }), (e) => ({ err: String(e?.message ?? e) })), true)`);
  const captured = await waitFor(
    () => cdp.eval(hubA.sessionId, `globalThis.__capCaptured[0] ?? null`),
    (v: any) => Boolean(v?.requestId),
    30000,
  ) as any;
  check("journey: the @demo-browser open_tab run raised an inline Allow card", Boolean(captured?.requestId), captured);
  const threadId = String(captured?.threadId ?? "");
  const whileOpen = await waitFor(badge, (t) => t === "1", 5000);
  check("journey: a pending Allow card the hub is not showing badges \"1\" (the hub is open but not on that thread)", whileOpen === "1", whileOpen);
  const shotA = await cdp.screenshot(hubA.sessionId);
  if (shotA) await Deno.writeTextFile(`${OUT}/hub-before-close.png`, "", { create: true }).then(() => Deno.writeFile(`${OUT}/hub-before-close.png`, shotA));
  // Close the hub tab → no port at all → the badge stays "1".
  await cdp.send("Target.closeTarget", { targetId: hubA.targetId });
  await sleep(600);
  const afterClose = await waitFor(badge, (t) => t === "1", 5000);
  check("journey: close the hub tab → badge text \"1\" (read via chrome.action.getBadgeText in the SW)", afterClose === "1", afterClose);
  const swSnapshot = await swEval(`(async () => { const r = await chrome.action.getBadgeText({}); const c = await chrome.action.getBadgeBackgroundColor({}); return { text: r, color: c }; })()`);
  console.log("badge ->", JSON.stringify(swSnapshot));
  check("journey: the badge colour is the design accent (petrol teal), not red", Array.isArray(swSnapshot?.color) && swSnapshot.color[0] === 0x0e && swSnapshot.color[1] === 0x6e && swSnapshot.color[2] === 0x63, swSnapshot);

  // Reopen the hub on its home view: still "1" (connected, but not on that
  // thread).
  const hubB = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(1200);
  const reopened = await badge();
  check("journey: a reopened hub NOT on the thread still shows \"1\"", reopened === "1", reopened);
  // Open the thread the way the SW's open-thread action does for a closed hub:
  // a fresh hub document carrying `#omnibox=thread:<id>` (a same-document hash
  // change would not re-run the omnibox entry). Viewing the thread clears the
  // badge even while the card is still pending — the owner is looking at it.
  const hubC = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html#omnibox=thread:${encodeURIComponent(threadId)}`);
  const cleared = await waitFor(badge, (t) => t === "", 15000);
  check("journey: opening that thread in the hub → badge \"\"", cleared === "", cleared);
  const shotB = await cdp.screenshot(hubC.sessionId);
  if (shotB) await Deno.writeFile(`${OUT}/hub-thread-open.png`, shotB);
  // Answer the card from the hub that is viewing the thread ("Not now" —
  // deterministic: an Allow would need the `tabs` grant gesture; both exits
  // clear the card). The run settles while its thread is on screen, so it is
  // a SEEN result: the badge stays "" now and after the hub closes.
  const resolved = await cdp.eval(hubC.sessionId, `chrome.runtime.sendMessage(${JSON.stringify({ type: "run.resolve-inline-approval", requestId: captured?.requestId, approve: false })}).then((v) => v, (e) => ({ err: String(e?.message ?? e) }))`);
  check("journey: the card was answered from the reopened hub", resolved?.ok === true, resolved);
  const settledRun = await waitFor(
    () => cdp.eval(hubC.sessionId, `chrome.runtime.sendMessage({ type: "run.list" }).then((r) => (r?.runs ?? []).find((x) => x.threadId === ${JSON.stringify(threadId)}) ?? null, () => null)`),
    (r: any) => r && (r.phase === "terminal" || r.phase === "cancelled"),
    30000,
  ) as any;
  check("journey: the run settled after the card was answered", Boolean(settledRun) && ["terminal", "cancelled"].includes(settledRun.phase), settledRun);
  await sleep(600);
  const answered = await badge();
  check("journey: answered from the reopened hub → badge \"\"", answered === "", answered);
  await cdp.send("Target.closeTarget", { targetId: hubC.targetId });
  await cdp.send("Target.closeTarget", { targetId: hubB.targetId });
  await sleep(600);
  const stillClear = await badge();
  check("journey: a seen result does not come back when the hub closes", stillClear === "", stillClear);

  // ── Journey 2: a completed run with NO hub/side-panel port → exactly one notification ──
  const notifBound = await swEval(`typeof chrome.notifications?.getAll === "function"`);
  check("notify: chrome.notifications is bound in the SW (the optional permission is granted)", notifBound === true, notifBound);
  await swEval(`chrome.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id))))`).catch(() => {});
  // Settings does not connect a progress port, so a run from there settles
  // with zero ports connected.
  const opts = await cdp.open(`chrome-extension://${extId}/options/options.html`);
  await sleep(1000);
  const ports = await swEval(`typeof progressPorts === "object" && progressPorts ? progressPorts.size : -1`).catch(() => -1);
  console.log("progress ports with only Settings open ->", ports);
  const run2 = await cdp.eval(opts.sessionId, `chrome.runtime.sendMessage({ type: "agent.run", task: "say hello" }).then((v) => v, (e) => ({ err: String(e?.message ?? e) }))`) as any;
  check("notify: the keyless run completed from Settings", run2?.ok === true && typeof run2?.threadId === "string", run2);
  const all = await waitFor(
    () => swEval(`chrome.notifications?.getAll ? chrome.notifications.getAll() : {}`),
    (a: any) => Object.keys(a ?? {}).some((id) => id.startsWith("cap:attention:")),
    10000,
  ) as Record<string, unknown>;
  const attentionIds = Object.keys(all ?? {}).filter((id) => id.startsWith("cap:attention:"));
  check("notify: a completed run with no hub port raised exactly ONE attention notification", attentionIds.length === 1, all);
  const record = await cdp.eval(opts.sessionId, `chrome.runtime.sendMessage({ type: "notification.get", id: ${JSON.stringify(attentionIds[0] ?? "")} }).then((v) => v, (e) => ({ err: String(e?.message ?? e) }))`) as any;
  check("notify: its registered click action opens THAT thread", record?.ok === true && record.notification?.action?.type === "open-thread" && record.notification.action.threadId === run2?.threadId, record);
  const badgeAfterRun2 = await waitFor(badge, (t) => t === "1", 5000);
  check("notify: the unseen result also badges \"1\"", badgeAfterRun2 === "1", badgeAfterRun2);
  // Dispatch the real click through the extension event → the click handler
  // opens/focuses an extension tab on the thread.
  const dispatched = await swEval(`(async () => { try { chrome.notifications?.onClicked?.dispatch(${JSON.stringify(attentionIds[0] ?? "")}); return true; } catch (e) { return String(e?.message ?? e); } })()`);
  const threadTab = await waitFor(
    async () => {
      const res = await cdp.send("Target.getTargets");
      return (res?.result?.targetInfos ?? []).map((t: any) => t.url ?? "");
    },
    (urls: any) => Array.isArray(urls) && urls.some((u) => u.includes(encodeURIComponent(run2?.threadId ?? "∅"))),
    10000,
  ) as string[];
  check("notify: clicking the notification opens the thread in the hub", dispatched === true && Array.isArray(threadTab) && threadTab.some((u) => u.includes(encodeURIComponent(run2?.threadId ?? "∅"))), { dispatched, threadTab });
  const badgeAfterClick = await waitFor(badge, (t) => t === "", 15000);
  check("notify: the opened thread clears the badge", badgeAfterClick === "", badgeAfterClick);
  await Deno.writeTextFile(`${OUT}/verdict.json`, JSON.stringify({ pass, fail, captured, swSnapshot, attentionIds, record: record?.notification ?? null }, null, 2));
  code = fail === 0 ? 0 : 1;
} catch (e) {
  fail += 1;
  console.log(`FAIL: harness error — ${String((e as Error)?.stack ?? (e as Error)?.message ?? e)}`);
} finally {
  cdp.close();
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
  await Deno.remove(tempExt, { recursive: true }).catch(() => {});
}
console.log(`kat-attention-badge: ${pass} pass, ${fail} fail (evidence: ${OUT})`);
Deno.exit(code);

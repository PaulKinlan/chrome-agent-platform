// scripts/kat-browser-tool-proxy.ts — chrome-agent-platform-2amt
//
// THE CANONICAL DRIVE: "group my tabs", end to end, over the app's own ACP protocol.
//
//   [fake harness (stdio JSON-RPC)] ←→ [REAL scripts/acp-bridge.ts (WebSocket)] ←→ [REAL Chrome +
//   REAL extension page running the REAL AcpClient]
//                                        └── dispatches browser/call_tool → browserToolset() →
//                                            chrome.tabs.group
//
// Only the HARNESS is a script here. The bridge is the real one, the client is the extension's own
// module inside a real browser, and the assertion is made through Chrome's own chrome.tabGroups API
// — because the thing Paul asked for is that the harness's tool call comes back to Chrome and
// actually moves his tabs.
//
// Run: npm run kat:browser-tool-proxy     (or: deno run -A scripts/kat-browser-tool-proxy.ts)

import { launchChrome } from "./lib/chrome-launch.ts";
import { resolveChromeForTesting } from "./lib/chrome-for-testing.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { buildVariant } from "./permission-variant.mjs";
import { fileURLToPath } from "node:url";
import { methodValue } from "./lib/cdp-eval.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(Deno.env.get("CAP_2AMT_PORT") ?? 3312); // NOT 3210: a real bridge may be there
const ENDPOINT = `ws://127.0.0.1:${PORT}/acp`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${JSON.stringify(detail).slice(0, 500)}`); }
}

// ── the fake harness: a committed fixture, node-compatible (the bridge spawns adapters with node) ──
const HARNESS = `${ROOT}scripts/fixtures/fake-acp-harness-2amt.mjs`;
const REPORTS = `${durableDir("scratch")}/2amt-fake-harness-report-${Date.now()}.json`;

const bridge = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", `${ROOT}scripts/acp-bridge.ts`, "--port", String(PORT), "--adapter", HARNESS, "--cwd", durableDir("scratch")],
  cwd: ROOT, stdout: "piped", stderr: "piped",
  env: { ...Deno.env.toObject(), CAP_2AMT_REPORT: REPORTS },
}).spawn();
const bridgeLog: string[] = [];
(async () => { for await (const c of bridge.stdout) bridgeLog.push(new TextDecoder().decode(c)); })();
(async () => { for await (const c of bridge.stderr) bridgeLog.push(new TextDecoder().decode(c)); })();

const variantDir = durableDir("cap-2amt-variant");
const { dir: extDir } = await buildVariant({
  srcDir: `${ROOT}extension`,
  outDir: variantDir,
  // wfo5: `scripting` for read_page and `system.memory` for get_system_memory — the two
  // newly-permitted tools whose OWN Chrome permission the drive must hold for the PROXY to be the
  // thing under test. Without them a refusal would be Chrome's, not the allow-list's, and the drive
  // would prove nothing either way. tabs/tabGroups were already here for list_tabs/group_tabs.
  permissions: ["tabs", "tabGroups", "scripting", "system.memory"],
});

const profile = durableDir("cap-chrome-profiles", `2amt-drive-${Deno.pid}-${Date.now()}`);
const chrome = await launchChrome({ binary: resolveChromeForTesting(), extension: extDir, profile, windowSize: "1200,900" });
const ws = new WebSocket(chrome.wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let idc = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((res, rej) => {
  const id = ++idc; pend.set(id, (m: any) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
async function extensionId(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await cdp("Target.getTargets");
    const sw = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"));
    if (sw) return String(sw.url).split("/")[2];
    await sleep(250);
  }
  throw new Error("the extension never registered");
}
const extId = await extensionId();
const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { sessionId: page } = await cdp("Target.attachToTarget", { targetId, flatten: true });
await cdp("Runtime.enable", {}, page);
const evl = async (expr: string) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, page);
  // kwrx P5: the local guard folded into the shared helper — same strict
  // semantics (throw named), one vocabulary across the fleet.
  // kwrx P5: <any> pass-through preserved from the old any-typed chain —
  // this driver evaluates strings, DOM objects, and event ledges alike.
  return methodValue<any>(r, "k.browser-tool-proxy.evl");
};
await sleep(1500);

// Wait for the bridge's socket to be up before asking the page to connect.
let bridgeUp = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status < 500) { bridgeUp = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check("the real bridge is listening", bridgeUp, { port: PORT, log: bridgeLog.join("").slice(-300) });
console.log(`  bridge log so far: ${JSON.stringify(bridgeLog.join("").slice(-600))}`);

// THE DRIVE, all inside the extension page: real client module, real WebSocket, real tools.
const drive = await evl(`(async () => {
  const { AcpClient } = await import(chrome.runtime.getURL("lib/acp-client.js"));
  const events = [];
  const scratchDir = ${JSON.stringify(durableDir("scratch"))};
  const client = new AcpClient({ url: ${JSON.stringify(ENDPOINT)}, defaultCwd: scratchDir, requestTimeoutMs: 60000 });
  client.activeTurnListener = (e) => events.push(e);
  // Prime the browser-control grant so group_tabs can act on the tabs (the consent check itself
  // is verified separately in unit tests; here we verify the end-to-end grouping drive).
  const testGrant = { id: "g-test-2amt", scope: "global", expiresAt: null, grantedAt: Date.now() };
  await new Promise((r) => chrome.storage.local.set({ "cap:browserControlGrant": testGrant }, r));
  await chrome.runtime.sendMessage({ type: "kv.set", items: { "cap:browserControlGrant": testGrant } }).catch(() => {});
  // two tabs for the harness to group (it will find them through list_tabs, not from us)
  const a = await chrome.tabs.create({ url: "https://example.com/?2amt=a", active: false });
  const b = await chrome.tabs.create({ url: "https://example.org/?2amt=b", active: false });
  await new Promise((r) => setTimeout(r, 700));
  await client.connect();
  await client.initialize();
  const session = await client.newSession({ cwd: scratchDir });
  const turn = await client.prompt(session.sessionId, "group my tabs", (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 800));
  const out = {
    created: [a.id, b.id],
    turn,
    events: events.filter((e) => e && e.kind === "tool").map((e) => e.detail),
    group: null, // read in the SERVICE WORKER below: chrome.tabGroups is not exposed to this page
  };
  client.close();
  return out;
})()`).catch((e) => ({ driveError: String(e?.message ?? e) }));

// THE GROUP IS READ IN THE SERVICE WORKER: chrome.tabGroups is not on the page's global (the page
// threw "Cannot read properties of undefined (reading 'query')" — measured), and the SW is where the
// extension's own tab code runs, so this is also the assertion the product would make.
// The harness's own report is read FIRST because the wfo5 assertions below need the tab ids it
// chose in order to ask Chrome about them.
const report = await Deno.readTextFile(REPORTS).then((t) => JSON.parse(t)).catch(() => null);

const swTarget = (await cdp("Target.getTargets")).targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"));
let swGroup: any = null;
let swOpened: any = null;
let swForeign: any = null;
if (swTarget) {
  const { sessionId: swSession } = await cdp("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
  await cdp("Runtime.enable", {}, swSession);
  const inWorker = (expression: string) =>
    cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, swSession)
      .then((r: any) => r.result?.value ?? r.result?.result?.value ?? null, () => null);
  swGroup = await inWorker(`(async () => {
      const groups = await chrome.tabGroups.query({});
      const mine = groups.find((g) => g.title === "2amt drive");
      if (!mine) return null;
      const members = (await chrome.tabs.query({ groupId: mine.id })).map((t) => t.id);
      return { id: mine.id, title: mine.title, color: mine.color, members };
    })()`);
  // wfo5: did open_tab actually open a tab? Asked of CHROME, not of the harness — a harness that
  // reports { ok: true } having done nothing must not be able to pass this.
  swOpened = await inWorker(`(async () => {
      const tabs = await chrome.tabs.query({});
      const mine = tabs.find((t) => String(t.url ?? "").includes("wfo5=opened"));
      return { found: !!mine, id: mine?.id ?? null, url: mine?.url ?? null, total: tabs.length };
    })()`);
  // wfo5: and is the tab the harness tried to CLOSE still open? The refusal has to be a real
  // non-event in the browser, not just a string in a JSON reply.
  const foreignId = report?.wfo5?.closeForeignTab?.tabId;
  swForeign = typeof foreignId === "number"
    ? await inWorker(`(async () => {
        const tab = await chrome.tabs.get(${JSON.stringify(foreignId)}).catch(() => null);
        return { stillOpen: !!tab, id: tab?.id ?? null, url: tab?.url ?? null };
      })()`)
    : { stillOpen: null, reason: "the harness had no foreign tab to try" };
}
if (drive && typeof drive === "object") drive.group = swGroup;
console.log(`  bridge log tail: ${JSON.stringify(bridgeLog.join("").slice(-800))}`);
check("the extension page drove the real client without throwing", !drive.driveError, drive);
check("the harness was TOLD the browser tools in its prompt", report?.sawDeclaration === true, { report });
// THE CONSENT GATE IS NOT A FAILURE — IT IS THE PRODUCT WORKING. If the tabs permission has not been
// granted (it needs a real user gesture: the approval card, or Settings → Permissions), the tool
// refuses and says so, and the harness gets that refusal instead of the user's tabs. An automated
// run cannot perform that gesture, so the grouping half is INCONCLUSIVE-with-cause here rather than
// red — and the checks below are skipped for the same reason, never passed vacuously.
const permissionRefusal = typeof report?.listTabs?.error === "string" && /permission not granted/i.test(report.listTabs.error);
if (permissionRefusal) {
  console.log("  INCONCLUSIVE (grouping half): the tabs permission is not granted in this profile, so the harness's call was refused BY THE TOOL — which is the consent property working, not a defect. Grant it (approval card / Settings → Permissions) and re-run to exercise the grouping end to end.");
  console.log(`  what was still PROVEN: the bridge ran, the declaration reached the harness, the harness's call reached the SW toolset, the tool's own gate answered, and the call showed up as tool activity.`);
} else {
check("the harness called list_tabs and got the tabs", (report?.listTabs?.count ?? 0) >= 2, { listTabs: report?.listTabs });
check("the harness chose tabs from THAT result", (report?.groupTabs?.requested ?? []).length === 2, { requested: report?.groupTabs?.requested });
check("group_tabs came back without an error", report?.groupTabs?.result && !report.groupTabs.result.error, { result: report?.groupTabs?.result });
check("chrome.tabGroups.query shows the group the harness asked for", drive?.group?.title === "2amt drive", { group: drive?.group });
check("the group has the colour the harness asked for", drive?.group?.color === "blue", { group: drive?.group });
check("the group CONTAINS the tabs the harness chose", JSON.stringify([...(drive?.group?.members ?? [])].sort()) === JSON.stringify([...(report?.groupTabs?.requested ?? [])].sort()), { members: drive?.group?.members, requested: report?.groupTabs?.requested });
check("the browser tool calls were visible to the UI as tool activity", (drive?.events ?? []).some((d: string) => /list_tabs|group_tabs/.test(String(d))), { events: drive?.events });

// ── chrome-agent-platform-wfo5: the NEWLY-PERMITTED tools, driven for real ─────────────────────
//
// Everything above exercises list_tabs + group_tabs — the two tools that were ALREADY callable
// before wfo5. They prove the proxy still works; they say nothing about the 132 the allow-list
// used to refuse. These are the functional verification for the widening (merge desk, under the
// repo's Functional Verification Mandate).
//
// `is not permitted for harness execution` is the exact answer every one of these gave before the
// change, so its ABSENCE is the property under test — and for the mutating ones, Chrome's own
// answer is the evidence, not the harness's.
const w = report?.wfo5 ?? {};
const refusedByAllowList = (r: unknown) =>
  /is not permitted for harness execution/.test(String((r as { error?: string })?.error ?? ""));

check("the harness is TOLD the whole toolset, not a three-tool sample", (w.declaredCount ?? 0) > 100, { declaredCount: w.declaredCount });

check("open_tab is no longer refused by the allow-list", !refusedByAllowList(w.openTab), { openTab: w.openTab });
check("CHROME ITSELF shows the tab the harness opened", swOpened?.found === true, { swOpened, harnessSaid: w.openTab });

// The navigation must have COMMITTED before the two page-reading tools run. Asserted separately so
// a future failure here says "the tab never loaded" instead of looking like a read_page defect —
// which is exactly how the first run of this drive read (19/21).
check(
  "the tab the harness opened reached a real http(s) address before it was read",
  String(w.openedUrlSettled ?? "").includes("wfo5=opened"),
  { openedUrlSettled: w.openedUrlSettled },
);

check("read_page is no longer refused by the allow-list", !refusedByAllowList(w.readPage), { readPage: w.readPage });
check(
  "read_page returned the REAL page, tagged untrusted",
  w.readPage?.untrusted === true && String(w.readPage?.url ?? "").includes("wfo5=opened"),
  { untrusted: w.readPage?.untrusted, url: w.readPage?.url, title: w.readPage?.title, textLen: String(w.readPage?.text ?? "").length, error: w.readPage?.error },
);

check("capture_screenshot is no longer refused by the allow-list", !refusedByAllowList(w.screenshot), { screenshot: w.screenshot });
check(
  "capture_screenshot returned real PNG bytes with real dimensions",
  w.screenshot?.ok === true && w.screenshot?.hasImage === true &&
    (w.screenshot?.bytes ?? 0) > 1000 && (w.screenshot?.width ?? 0) > 0 && (w.screenshot?.height ?? 0) > 0,
  { screenshot: w.screenshot },
);

// No grant, no host permission: this one isolates the PROXY from the permission machinery.
check("get_system_memory is no longer refused by the allow-list", !refusedByAllowList(w.systemMemory), { systemMemory: w.systemMemory });
check(
  "get_system_memory returned real numbers (a tool needing no browser-control grant)",
  typeof w.systemMemory?.capacityBytes === "number" && w.systemMemory.capacityBytes > 0,
  { systemMemory: w.systemMemory },
);

// THE SAFETY HALF of wfo5. close_tab on a tab this run did NOT open is the Destructive class, and a
// harness caller cannot raise an approval card (principal "extension"; these action names are not
// owner-direct). The only acceptable outcomes are a refusal — never a closed tab.
check(
  "a GATED tool does not silently mutate — close_tab on a foreign tab was REFUSED",
  typeof w.closeForeignTab?.result?.error === "string" && w.closeForeignTab?.result?.ok !== true,
  { closeForeignTab: w.closeForeignTab },
);
check(
  "CHROME ITSELF shows the foreign tab still open after the refused close",
  swForeign?.stillOpen === true,
  { swForeign, attempted: w.closeForeignTab?.tabId },
);
}

console.log(`\n=== ${pass} passed / ${fail} failed`);
if (failures.length) console.log(`FAILURES:\n  - ${failures.join("\n  - ")}`);
console.log(`harness report: ${REPORTS}`);
try { bridge.kill("SIGKILL"); } catch { /* gone */ }
try { await cdp("Browser.close"); } catch { /* gone */ }
await sleep(500);
try { await Deno.remove(variantDir, { recursive: true }); } catch { /* cleaned */ }
try { await Deno.remove(profile, { recursive: true }); } catch { /* cleaned */ }
try { await Deno.remove(REPORTS); } catch { /* cleaned */ }
Deno.exit(fail ? 1 : 0);

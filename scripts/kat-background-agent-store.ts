// kat-background-agent-store.ts — the wz6i store-merge journey (real browser, CDP).
//
// chrome-agent-platform-wz6i merged the built-in recipe-backed background
// agents into the named-agent store. This journey proves the real behaviour
// end to end on the LOADED extension:
//   1. a built-in background agent (the Sorting Hat) is a SEED record in the
//      agent store: named-agent.list returns it with seeded/builtin markers
//      and its LEGACY runtime identity (surfaceRef background:<id>,
//      memoryKey recipe:<id>) — while DISABLED it renders in NO agent row
//      (a template, not an agent — the hub contract),
//   2. enabling it through the REAL background-agent.set route mints the
//      UNIFIED `agent:<id>` schedule (never a new `recipe:<id>` one), and the
//      agent then renders EXACTLY ONCE on the hub (the one-list projection),
//   3. disabling through the same route removes the schedule and the row.
//
// Scope note: the startup re-key of pre-existing `recipe:<id>` schedules is
// covered by the REAL migration driven with fakes in tests/agent-seeds.test.ts
// (an MV3 worker restart mid-journey makes the re-key's boot path undrivable
// here without destabilising every other assertion).
//
//   deno run -A scripts/kat-background-agent-store.ts <path-to-extension> [<out-dir>]
import { wireValue } from "./lib/cdp-eval.ts";
import { fileURLToPath } from "node:url";
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { resolveChromeForTesting } from "./lib/chrome-for-testing.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-background-agent-store`;
const CHROMIUM = resolveChromeForTesting();
if (!CHROMIUM) {
  console.log("FAIL: no Chrome for Testing binary in the puppeteer cache — install one with: npx @puppeteer/browsers install chrome@stable");
  Deno.exit(1);
}
console.log(`NOTE: Chrome for Testing: ${CHROMIUM}`);
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try { await Deno.stat(`${EXT}/dist/background/service-worker.js`); } catch {
  console.log("FAIL: extension is not built (missing dist/background/service-worker.js) — run npm run build:production first");
  Deno.exit(1);
}

let proc!: Deno.ChildProcess;
let ws: WebSocket | null = null;
try {
  const launched = await launchChrome({
    binary: CHROMIUM,
    args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${chromeProfileDir("kat-background-agent-store")}`, "about:blank"],
  });
  proc = launched.proc;
  ws = new WebSocket(launched.wsUrl);
  await new Promise((r) => ws!.onopen = r);
} catch (e) {
  console.log(`FAIL: could not start Chrome for Testing — ${String(e)}`);
  Deno.exit(1);
}
let id = 0; const pending = new Map<string, (v: any) => void>();
ws!.onmessage = (m: MessageEvent) => { const j = JSON.parse(m.data); if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); } };
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws!.send(JSON.stringify({ id: mid, method, params, sessionId }));
});

const sw = await waitForServiceWorker(send, {
  timeoutMs: 10000,
});
if (!sw) { console.log("FAIL: the extension service worker never appeared"); Deno.exit(1); }
const extId = new URL(sw.url).host;
await Deno.mkdir(OUT, { recursive: true });

const newView = async (url: string) => {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  const ev = async (expr: string) => wireValue<any>(await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId), "k.bgagent-store");
  const shot = async (path: string) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
  };
  const clickSel = async (selector: string) => {
    const b = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!b) return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
    return true;
  };
  return { targetId, sessionId, ev, shot, clickSel };
};

// ── 0. the alarms capability through the REAL Settings permissions UI ─────
const opts = await newView(`chrome-extension://${extId}/options/options.html`);
await sleep(1800);
await opts.clickSel('.grant-perm[data-capability="alarms"]');
await sleep(1500);
const alarmsOk = await opts.ev(`(async () => {
  const msg = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }));
  const st = await msg({ type: "capabilities.status" });
  return (st?.capabilities ?? st ?? []).find?.((c) => c.id === "alarms")?.granted ?? (chrome.alarms ? true : false);
})()`);
check("journey: the alarms capability is granted via the real Settings UI", alarmsOk === true, { alarmsOk });
await send("Target.closeTarget", { targetId: opts.targetId });

const ntp = await newView(`chrome-extension://${extId}/ntp/ntp.html`);
await sleep(2500);

const MSG = `(m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }))`;

// ── 1. the built-in is a SEED record in the agent store, and NO row while disabled ──
const seedState = await ntp.ev(`(async () => {
  const msg = ${MSG};
  const named = await msg({ type: "named-agent.list" });
  const agents = Array.isArray(named?.agents) ? named.agents : [];
  const hat = agents.find((a) => a?.id === "auto-group-by-domain");
  const bg = await msg({ type: "background-agent.list" });
  const bgHat = (Array.isArray(bg?.agents) ? bg.agents : []).find((a) => a?.id === "auto-group-by-domain");
  const rows = [...(document.querySelector("#named-agents agent-picker")?.shadowRoot?.querySelectorAll(".opt .name") ?? [])]
    .map((el) => el.textContent ?? "");
  return {
    hat: hat ? {
      seeded: hat.seeded, builtin: hat.builtin, enabled: hat.enabled,
      surfaceRef: hat.surfaceRef, memoryKey: hat.memoryKey,
      defaultPeriod: hat.defaultSchedule?.periodInMinutes ?? null,
      liveSchedule: hat.schedule ?? null,
      skillIds: (Array.isArray(hat.skills) ? hat.skills : []).map((s) => s?.id ?? s),
    } : null,
    bgEnabled: bgHat?.enabled ?? null,
    hatRows: rows.filter((n) => n === "Sorting Hat").length,
    rowNames: rows,
  };
})()`);
check("store: the Sorting Hat is a seeded record in the named-agent store",
  seedState?.hat?.seeded === true && seedState?.hat?.builtin === true, seedState?.hat);
check("store: the seed carries its legacy runtime identity (background:<id> surface, recipe:<id> memory)",
  seedState?.hat?.surfaceRef === "background:auto-group-by-domain" &&
  seedState?.hat?.memoryKey === "recipe:auto-group-by-domain", seedState?.hat);
check("store: the seed carries its skill + default cadence, and NO live schedule while disabled",
  seedState?.hat?.skillIds?.includes("auto-group-by-domain") === true &&
  seedState?.hat?.defaultPeriod === 30 &&
  seedState?.hat?.liveSchedule === null &&
  seedState?.hat?.enabled === false, seedState?.hat);
check("store: a DISABLED built-in renders in NO agent row (a template, not an agent)",
  seedState?.hatRows === 0, seedState?.rowNames);
check("store: the background management surface agrees it is disabled",
  seedState?.bgEnabled === false, seedState?.bgEnabled);
await ntp.shot(`${OUT}/01-disabled-no-row.png`);

// ── 2. enable through the REAL route → the UNIFIED agent:<id> schedule ────
const enabled = await ntp.ev(`(async () => {
  const msg = ${MSG};
  const en = await msg({ type: "background-agent.set", id: "auto-group-by-domain", enabled: true });
  if (!en?.ok) return { step: "enable", en };
  const tasks = await msg({ type: "task.list" });
  const names = (tasks?.tasks ?? tasks ?? []).map?.((t) => t?.name) ?? [];
  const named = await msg({ type: "named-agent.list" });
  const hat = (Array.isArray(named?.agents) ? named.agents : []).find((a) => a?.id === "auto-group-by-domain");
  const bg = await msg({ type: "background-agent.list" });
  const bgHat = (Array.isArray(bg?.agents) ? bg.agents : []).find((a) => a?.id === "auto-group-by-domain");
  return {
    step: "done",
    en,
    agentTask: names.includes("agent:auto-group-by-domain"),
    recipeTask: names.includes("recipe:auto-group-by-domain"),
    taskNames: names,
    liveSchedule: hat?.schedule ?? null,
    seedEnabled: hat?.enabled ?? null,
    bgEnabled: bgHat?.enabled ?? null,
  };
})()`);
check("enable: background-agent.set on a built-in succeeds", enabled?.step === "done", enabled);
check("enable: the schedule is the UNIFIED agent:<id>, never a new recipe:<id>",
  enabled?.agentTask === true && enabled?.recipeTask === false, enabled?.taskNames);
check("enable: the seed's LIVE schedule + enabled arrive through the ONE enrichment",
  enabled?.liveSchedule?.periodInMinutes === 30 && enabled?.seedEnabled === true,
  { live: enabled?.liveSchedule, seedEnabled: enabled?.seedEnabled });
check("enable: the background management surface reflects the unified task too",
  enabled?.bgEnabled === true, enabled?.bgEnabled);

// The registry broadcast re-renders the hub; the enabled agent renders ONCE.
await sleep(1500);
const rowState = await ntp.ev(`(() => {
  const rows = [...(document.querySelector("#named-agents agent-picker")?.shadowRoot?.querySelectorAll(".opt") ?? [])];
  const hats = rows.filter((r) => (r.querySelector(".name")?.textContent ?? "") === "Sorting Hat");
  return {
    hatRows: hats.length,
    chip: hats[0]?.textContent ?? "",
    rowNames: rows.map((r) => r.querySelector(".name")?.textContent ?? ""),
  };
})()`);
check("enable: the agent renders EXACTLY ONCE on the hub (the one-list projection)",
  rowState?.hatRows === 1, rowState?.rowNames);
check("enable: the row carries its schedule marker",
  /30|min|every/i.test(rowState?.chip ?? ""), rowState?.chip);
await ntp.shot(`${OUT}/02-enabled-one-row.png`);

// ── 3. disable through the same route → schedule + row gone ───────────────
const disabled = await ntp.ev(`(async () => {
  const msg = ${MSG};
  const dis = await msg({ type: "background-agent.set", id: "auto-group-by-domain", enabled: false });
  if (!dis?.ok) return { step: "disable", dis };
  const tasks = await msg({ type: "task.list" });
  const names = (tasks?.tasks ?? tasks ?? []).map?.((t) => t?.name) ?? [];
  return { step: "done", agentTask: names.includes("agent:auto-group-by-domain"), recipeTask: names.includes("recipe:auto-group-by-domain"), taskNames: names };
})()`);
check("disable: the unified schedule is removed", disabled?.step === "done" && disabled?.agentTask === false && disabled?.recipeTask === false, disabled);
await sleep(1500);
const finalRows = await ntp.ev(`(() => {
  const rows = [...(document.querySelector("#named-agents agent-picker")?.shadowRoot?.querySelectorAll(".opt .name") ?? [])];
  return rows.map((el) => el.textContent ?? "").filter((n) => n === "Sorting Hat").length;
})()`);
check("disable: the row leaves the hub list (a template again)", finalRows === 0, finalRows);
await ntp.shot(`${OUT}/03-disabled-gone.png`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: kat-background-agent-store — ${pass} passed, ${fail} failed`);
try { await send("Browser.close"); } catch { proc!.kill("SIGKILL"); }
Deno.exit(fail === 0 ? 0 : 1);

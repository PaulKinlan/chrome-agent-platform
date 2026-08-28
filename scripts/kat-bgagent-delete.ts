// kat-bgagent-delete.ts — background-agent DELETE journey (real browser, CDP).
//
// The REVISE blocker: tests/bgagent-delete.test.ts only regex-scanned source.
// This journey proves the real behaviour end to end on the LOADED extension:
//   1. seed a real CUSTOM background agent through the REAL message bus
//      (recipe.duplicate → background-agent.set enable → the recipe:<id> task
//      exists in task.list),
//   2. find its real capability-row on the NTP and click the REAL Delete
//      button (shadow-root event → confirmActionDialog), accept the REAL
//      confirm dialog,
//   3. assert the deletion is real and COMPLETE: the recipe:<id> task is GONE
//      from the task store, the custom recipe is gone from the registry, the
//      row is gone from the DOM, and a focus successor is placed,
//   4. the UI is NON-BLOCKING: the confirm → row-removal round-trip completes
//      in seconds (the old blocking cancel waited up to 5s on a RUNNING task;
//      the unit-level running-task proof lives in tests/alarm-orphan.test.ts).
//
//   deno run -A scripts/kat-bgagent-delete.ts <path-to-extension> [<out-dir>]
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-bgagent-delete`;
// The Arch chromium wrapper ignores --load-extension (no extension targets at
// all); Chrome for Testing honors it. The SW must be built first (the manifest
// points at dist/background/service-worker.js).
const CHROMIUM = "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";
const BASE_PORT = 9357;
// Pick a free debug port — killed KAT runs leave zombie chromiums holding the
// fixed port, which then hangs every subsequent run's CDP handshake.
async function freePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p++) {
    const l = Deno.listen({ port: p });
    try { l.close(); return p; } catch { /* taken */ }
  }
  throw new Error("no free debug port in range");
}
const PORT = await freePort(BASE_PORT);
const STAMP = Date.now();
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fail fast (with an honest message) when the extension isn't built.
try { await Deno.stat(`${EXT}/dist/background/service-worker.js`); } catch {
  console.log("FAIL: extension is not built (missing dist/background/service-worker.js) — run npm run build:production first");
  Deno.exit(1);
}

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-bgagent-delete-${STAMP}`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();
let ws: WebSocket | null = null;
try {
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no devtools url")), 15000);
    (async () => { for (;;) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); clearTimeout(t); resolve(j.webSocketDebuggerUrl); return; } catch { await sleep(300); } } })();
  });
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws!.onopen = r);
} catch (e) {
  console.log(`FAIL: could not start Chrome for Testing — ${String(e)}`);
  proc.kill(); Deno.exit(1);
}
let id = 0; const pending = new Map<string, (v: any) => void>();
ws!.onmessage = (m: MessageEvent) => { const j = JSON.parse(m.data); if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); } };
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws!.send(JSON.stringify({ id: mid, method, params, sessionId }));
});

// The extension id: prefer the live SW target; fall back to the profile's
// Preferences (the unpacked id is deterministic per path).
let sw: any = null;
for (let i = 0; i < 20 && !sw; i++) {
  await sleep(500);
  const { result: { targetInfos } } = await send("Target.getTargets");
  sw = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"));
}
let extId: string;
if (sw) extId = new URL(sw.url).host;
else {
  const prof = `${ROOT}.cache/kat-bgagent-delete-${STAMP}/Default/Preferences`;
  // Under fleet load Chrome can take >10s to materialize the profile — poll.
  let prefsRaw: string | null = null;
  for (let i = 0; i < 30 && prefsRaw === null; i++) {
    prefsRaw = await Deno.readTextFile(prof).catch(() => null);
    if (prefsRaw === null) await sleep(1000);
  }
  if (prefsRaw === null) { console.log("FAIL: Chrome profile never materialized (Preferences absent after 30s)"); Deno.exit(1); }
  const prefs = JSON.parse(prefsRaw);
  const entry = Object.entries<any>(prefs.extensions?.settings ?? {}).find(([, v]) => String(v?.path ?? "").endsWith("extension") && v?.location === 8);
  if (!entry) { console.log("FAIL: extension never registered"); Deno.exit(1); }
  extId = entry[0];
  console.log("NOTE: SW idle; using Preferences id (navigating wakes it)");
}
await Deno.mkdir(OUT, { recursive: true });

const newView = async (url: string) => {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
  const shot = async (path: string) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
  };
  // GENUINE CDP mouse click at a selector's box (a trusted user gesture —
  // element.click() from evaluate is NOT trusted, so permission requests
  // would silently no-op).
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
  // Trusted click at an ARBITRARY evaluated point — for elements inside
  // shadow roots that document.querySelector cannot reach.
  const clickXY = async (xy: { x: number; y: number } | null | undefined) => {
    if (!xy || typeof xy.x !== "number" || typeof xy.y !== "number") return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: xy.x, y: xy.y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: xy.x, y: xy.y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
    return true;
  };
  return { targetId, sessionId, ev, shot, clickSel, clickXY };
};

// ── 1. Seed a REAL custom background agent via the REAL message bus ────────
// Scheduling needs the OPTIONAL alarms permission — granted through the REAL
// Settings permissions UI (a genuine click; silent permissions auto-grant
// under CDP-driven user activation, exactly as chrome-journeys does).
const opts = await newView(`chrome-extension://${extId}/options/options.html`);
await sleep(1800);
const grantedClicked = await opts.clickSel('.grant-perm[data-capability="alarms"]');
await sleep(1500); // the permission request + SW activation + re-render settle
const alarmsOk = await opts.ev(`(async () => {
  const msg = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }));
  const st = await msg({ type: "capabilities.status" });
  return (st?.capabilities ?? st ?? []).find?.((c) => c.id === "alarms")?.granted
    ?? (chrome.alarms ? true : false);
})()`);
check("journey: the alarms capability is granted via the real Settings UI", alarmsOk === true, { alarmsOk });
await send("Target.closeTarget", { targetId: opts.targetId });

const ntp = await newView(`chrome-extension://${extId}/ntp/ntp.html`);
await sleep(2500); // first paint + registry hydration

const seed = await ntp.ev(`(async () => {
  const msg = (m) => new Promise((res) => {
    chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); });
  });
  const dup = await msg({ type: "recipe.duplicate", id: "auto-group-by-domain" });
  if (!dup?.ok) return { step: "duplicate", dup };
  const en = await msg({ type: "background-agent.set", id: dup.recipe.id, enabled: true });
  if (!en?.ok) return { step: "enable", en };
  const tasks = await msg({ type: "task.list" });
  const scheduled = (tasks?.tasks ?? tasks ?? []).some?.((t) => t?.name === \`recipe:\${dup.recipe.id}\`)
    ?? JSON.stringify(tasks ?? {}).includes(\`recipe:\${dup.recipe.id}\`);
  return { step: "done", id: dup.recipe.id, name: dup.recipe.name, scheduled };
})()`);
check("journey: the custom background agent seeds + schedules for real", seed?.step === "done" && seed.scheduled === true, seed);
const agentId = seed?.id;
const agentName = seed?.name ?? "";
await ntp.shot(`${OUT}/01-seeded-enabled.png`);

// ── 2. The REAL Delete button on the agent's REAL row ─────────────────────
// The registry broadcast re-renders the list; give it a beat, then find the
// row whose name matches the seeded agent (its Delete lives in the shadow root).
await sleep(1200);
const rowFound = await ntp.ev(`(() => {
  const rows = [...document.querySelectorAll("#named-agents capability-row")];
  const row = rows.find((r) => (r.getAttribute("name") || "") === ${JSON.stringify(agentName)});
  if (!row) return { found: false, names: rows.map((r) => r.getAttribute("name")) };
  const del = row.shadowRoot.querySelector('button.delete, button[part="delete"]');
  return { found: true, hasDelete: !!del };
})()`);
check("journey: the seeded agent's row renders with a real Delete button", rowFound?.found === true && rowFound.hasDelete === true, rowFound);

// Click the real Delete with a TRUSTED CDP pointer gesture — the button lives
// in capability-row's shadow root, so resolve its box through the shadow path
// and dispatch real Input events (element.click() from evaluate is NOT
// trusted; the delete must prove it works for a real user).
const delRect = await ntp.ev(`(() => {
  const rows = [...document.querySelectorAll("#named-agents capability-row")];
  const row = rows.find((r) => (r.getAttribute("name") || "") === ${JSON.stringify(agentName)});
  const del = row?.shadowRoot?.querySelector('button.delete, button[part="delete"]');
  if (!del) return null;
  del.scrollIntoView({ block: "center" });
  const r = del.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
const delClicked = await ntp.clickXY(delRect);
check("journey: the Delete button received a trusted pointer click", delClicked === true, { delRect });
await sleep(600); // the confirm dialog renders
const dialogUp = await ntp.ev(`(() => {
  const d = document.querySelector(".cap-confirm-dialog");
  const accept = d?.querySelector(".cap-confirm-accept");
  return { up: !!d, title: d?.querySelector(".cap-confirm-title")?.textContent ?? null, hasAccept: !!accept };
})()`);
check("journey: the real confirm dialog appears (destructive delete)", dialogUp?.up === true && dialogUp.hasAccept === true, dialogUp);
await ntp.shot(`${OUT}/02-confirm-dialog.png`);

// ── 3. Accept → deletion must be REAL, COMPLETE, and NON-BLOCKING ─────────
// The confirm-accept click is ALSO trusted (the accept handler is a real
// user-gesture path).
const t0 = Date.now();
const acceptClicked = await ntp.clickSel(".cap-confirm-dialog .cap-confirm-accept");
check("journey: the confirm accept received a trusted pointer click", acceptClicked === true, null);
// Poll the DOM: the row must disappear promptly (non-blocking UI).
let rowGoneMs = -1;
for (let i = 0; i < 60 && rowGoneMs < 0; i++) {
  await sleep(250);
  const gone = await ntp.ev(`(() => {
    const rows = [...document.querySelectorAll("#named-agents capability-row")];
    return !rows.some((r) => (r.getAttribute("name") || "") === ${JSON.stringify(agentName)});
  })()`);
  if (gone === true) rowGoneMs = Date.now() - t0;
}
check("journey: the row disappears from the DOM after accepting", rowGoneMs > 0, { rowGoneMs });
check("journey: the delete round-trip is prompt (non-blocking UI, < 5s)", rowGoneMs > 0 && rowGoneMs < 5000, { rowGoneMs });

// The task store must lose the recipe:<id> task (async teardown completes).
let taskGone = false;
for (let i = 0; i < 40 && !taskGone; i++) {
  await sleep(250);
  taskGone = await ntp.ev(`(async () => {
    const msg = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }));
    const tasks = await msg({ type: "task.list" });
    return !JSON.stringify(tasks ?? {}).includes("recipe:${agentId}");
  })()`) === true;
}
check("journey: the recipe:<id> task is GONE from the task store", taskGone === true, { agentId });

// The custom recipe record must be gone from the registry (a full delete).
const registryAfter = await ntp.ev(`(async () => {
  const msg = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }));
  const bg = await msg({ type: "background-agent.list" });
  return !(bg?.agents ?? []).some((a) => a.id === "${agentId}");
})()`);
check("journey: the custom agent is gone from background-agent.list", registryAfter === true, { agentId });
await ntp.shot(`${OUT}/03-after-delete.png`);

// A focus successor must be placed (the re-render destroyed the Delete button).
const focusAfter = await ntp.ev(`(() => {
  const active = document.activeElement;
  const inList = active?.closest?.("#named-agents") != null || document.getElementById("named-agents") === active;
  return { tag: active?.tagName ?? null, cls: active?.className ?? null, inList };
})()`);
check("journey: a focus successor is placed after re-render", focusAfter?.inList === true, focusAfter);

await send("Target.closeTarget", { targetId: ntp.targetId });
ws!.close();
proc.kill();
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);

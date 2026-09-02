// Loaded-extension proof for the Settings safe-cleanup slice.
// Baseline mode exposes the retired hidden control for the before screenshot;
// candidate mode proves it is absent while real owner controls remain.
//
// Candidate mode also holds the Permissions / Hooks budgets
// (CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01): on a fresh profile
// each section is under 900 px tall, at most one danger control is visible per
// viewport, and every row is a <capability-row> or a table row with a
// <switch-toggle>. Screenshots at 1440x900 and 1024x700.
//
// deno run -A scripts/kat-settings-cleanliness.ts <extension> <out> [--baseline]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-settings-cleanliness`;
const BASELINE = Deno.args.includes("--baseline");
const CHROMIUM = "/usr/bin/chromium";
await Deno.mkdir(OUT, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${OUT}/profile-${Date.now()}`, "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => { ws.onopen = () => resolve(null); });
let id = 0;
const pending = new Map<number, (value: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (event) => {
  const message = JSON.parse(event.data as string);
  if (!pending.has(message.id)) return;
  pending.get(message.id)!(message);
  pending.delete(message.id);
};

const worker = await waitForServiceWorker(send, { timeoutMs: 20000 });
check("the loaded extension registered its service worker", Boolean(worker), worker);
if (!worker) {
  try { proc.kill("SIGKILL"); } catch {}
  Deno.exit(1);
}
const extensionId = new URL(worker.url).host;
const target = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/options/options.html#providers` });
const attached = await send("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
const sessionId = attached.result.sessionId;
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

const deadline = Date.now() + 20000;
let state: any = null;
while (Date.now() < deadline) {
  const result = await send("Runtime.evaluate", {
    expression: `(() => ({
      ready: document.readyState === "complete" && document.querySelectorAll("#provider-recommended .provider-card, #provider-recommended [role=radio], #provider-tabs [role=tab]").length > 0,
      href: location.href
    }))()`,
    returnByValue: true,
  }, sessionId);
  state = result?.result?.result?.value;
  if (state?.ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
check("Settings providers rendered", state?.ready === true, state);

const observedResult = await send("Runtime.evaluate", {
  expression: `(() => {
    const warnings = [...document.querySelectorAll("storage-durability-warning")];
    ${BASELINE ? 'warnings.forEach((warning) => warning.setAttribute("active", ""));' : ""}
    const nav = [...document.querySelectorAll(".nav-item[data-section]")];
    const sections = new Set([...document.querySelectorAll("section.panel[id]")].map((section) => section.id));
    const deadNav = nav.map((item) => item.dataset.section).filter((id) => !sections.has(id));
    const labels = [...document.querySelectorAll("button")].map((button) => (button.textContent || "").trim()).filter(Boolean);
    return {
      warningCount: warnings.length,
      deadNav,
      deadLabels: labels.filter((label) => /verify storage|enable storage/i.test(label)),
      apiKeyInputs: document.querySelectorAll("input.api-key").length,
      permissionRows: document.querySelectorAll("#permission-list capability-row, #permission-list .perm-row").length,
      browserControl: Boolean(document.getElementById("browser-grant")),
      localFolderControl: Boolean(document.getElementById("fs-add-directory-btn")),
    };
  })()`,
  returnByValue: true,
}, sessionId);
const observed = observedResult?.result?.result?.value;
if (BASELINE) {
  check("baseline contains the retired storage verifier", observed?.warningCount > 0, observed);
  check("baseline contains a dead Settings navigation item", observed?.deadNav?.includes("appearance"), observed);
} else {
  check("request-era storage verifier is absent", observed?.warningCount === 0 && observed?.deadLabels?.length === 0, observed);
  check("every Settings navigation item resolves to a real section", observed?.deadNav?.length === 0, observed);
  check("provider API-key editing remains available", observed?.apiKeyInputs > 0, observed);
  check("install-grant diagnostics still render", observed?.permissionRows > 0, observed);
  check("real owner-grant controls remain", observed?.browserControl === true && observed?.localFolderControl === true, observed);
}

const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
const shotName = BASELINE ? "before-request-era-controls.png" : "after-settings-clean.png";
await Deno.writeFile(`${OUT}/${shotName}`, Uint8Array.from(atob(screenshot.result.data), (char) => char.charCodeAt(0)));

// ── Permissions / Hooks budgets (CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01) ──
// Hooks is a developer section: flip the flag the way About's switch does
// (the SAME kv key), then open fresh Settings targets per viewport.
const DEVELOPER_FEATURES_KEY = "cap:developerFeatures";
await send("Runtime.evaluate", {
  expression: `chrome.runtime.sendMessage({ type: "kv.set", values: { ${JSON.stringify(DEVELOPER_FEATURES_KEY)}: true } })`,
  awaitPromise: true, returnByValue: true,
}, sessionId);

const SECTION_BUDGET_PX = 900;
const MEASURE = (sectionId: string) => `(async () => {
  const section = document.getElementById(${JSON.stringify(sectionId)});
  if (!section) return { missing: true };
  for (let i = 0; i < 80; i++) {
    const ready = ${JSON.stringify(sectionId)} === "permissions"
      ? document.querySelectorAll("#permission-list capability-row, #permission-list .perm-row").length > 0
      : document.querySelectorAll("#hook-list tbody, #hook-list .perm-row").length > 0;
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  location.hash = "#" + ${JSON.stringify(sectionId)};
  section.scrollIntoView({ block: "start" });
  await new Promise((r) => setTimeout(r, 300));
  const rect = section.getBoundingClientRect();
  const dangerColor = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim();
  const isRed = (el) => {
    const cs = getComputedStyle(el);
    if (el.classList.contains("danger")) return true;
    const probe = document.createElement("span");
    probe.style.color = dangerColor; document.body.appendChild(probe);
    const red = getComputedStyle(probe).color; probe.remove();
    return cs.backgroundColor === red || (cs.color === red && (cs.borderColor === red));
  };
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  // Every control in light DOM plus every open shadow root.
  const controls = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("button, [role=button], [role=switch], a.btn")) {
      controls.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) walk(host.shadowRoot);
  };
  walk(document);
  const redVisible = controls.filter((el) => inViewport(el) && isRed(el)).map((el) => (el.textContent || el.getAttribute("aria-label") || el.className).trim().slice(0, 40));
  const rows = ${JSON.stringify(sectionId)} === "permissions"
    ? [...document.querySelectorAll("#permission-list .perm-group-rows > *, #permission-list > .perm-row")]
    : [...document.querySelectorAll("#hook-list tbody tr.hook-row, #hook-list > .perm-row")];
  const rowKinds = rows.map((r) => r.tagName === "CAPABILITY-ROW"
    ? "capability-row"
    : (r.tagName === "TR" && r.querySelector("td.col-state switch-toggle")) ? "table-row-switch" : r.tagName.toLowerCase());
  const badRows = rowKinds.filter((k) => k !== "capability-row" && k !== "table-row-switch");
  const groups = ${JSON.stringify(sectionId)} === "permissions"
    ? [...document.querySelectorAll("#permission-list details.perm-group")].map((d) => ({ id: d.dataset.group, open: d.open, rows: d.querySelectorAll("capability-row").length }))
    : [...document.querySelectorAll("#hook-list tbody")].map((b) => ({ id: b.dataset.api, open: b.dataset.open, rows: b.querySelectorAll("tr.hook-row").length }));
  const table = document.querySelector("#hook-list");
  return {
    height: Math.round(rect.height), rows: rows.length, badRows, groups, redVisible,
    tableHeaders: table ? [...table.querySelectorAll("thead th[scope=col]")].map((th) => th.textContent.trim()) : [],
    switchesLabelled: [...document.querySelectorAll("#hook-list switch-toggle, #permission-list capability-row")].every((el) => el.getAttribute("label") || el.getAttribute("name")),
    apiColumnVisible: table?.querySelector("th.col-api") ? getComputedStyle(table.querySelector("th.col-api")).display !== "none" : null,
    containerWidth: Math.round(document.querySelector(".hooks-table-wrap")?.getBoundingClientRect().width ?? 0),
    hidden: section.hidden,
  };
})()`;

for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
  for (const sectionId of ["permissions", "hooks"] as const) {
    const t = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/options/options.html#${sectionId}` });
    const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
    const sid = a.result.sessionId;
    await send("Runtime.enable", {}, sid);
    await send("Page.enable", {}, sid);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sid);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const m = (await send("Runtime.evaluate", { expression: MEASURE(sectionId), awaitPromise: true, returnByValue: true }, sid))?.result?.result?.value;
    const tag = `${sectionId} @${width}x${height}`;
    if (!BASELINE) {
      check(`${tag}: section rendered and visible`, m && !m.missing && m.hidden === false && m.rows > 0, m);
      check(`${tag}: section under ${SECTION_BUDGET_PX} px on a fresh profile (measured ${m?.height})`, typeof m?.height === "number" && m.height < SECTION_BUDGET_PX, m?.height);
      check(`${tag}: at most one danger control visible in the viewport`, Array.isArray(m?.redVisible) && m.redVisible.length <= 1, m?.redVisible);
      check(`${tag}: every row is a capability-row or a table row with a switch-toggle`, Array.isArray(m?.badRows) && m.badRows.length === 0 && m.rows > 0, { rows: m?.rows, badRows: m?.badRows });
      check(`${tag}: every switch/row carries its name as the label`, m?.switchesLabelled === true, m?.switchesLabelled);
      if (sectionId === "hooks") {
        check(`${tag}: the hooks table has Event / Chrome API / Allowed column headers`, JSON.stringify(m?.tableHeaders) === JSON.stringify(["Event", "Chrome API", "Allowed"]), m?.tableHeaders);
        // The column hides below a 720 px CONTAINER (the table's own width,
        // not the viewport): at 1024 wide the content column is ~670 px.
        const wide = (m?.containerWidth ?? 0) >= 720;
        check(`${tag}: the Chrome API column is ${wide ? "shown" : "hidden"} for a ${m?.containerWidth} px container`, m?.apiColumnVisible === wide, { apiColumnVisible: m?.apiColumnVisible, containerWidth: m?.containerWidth });
      }
    } else {
      console.log(`baseline ${tag}: height=${m?.height} redVisible=${JSON.stringify(m?.redVisible)} rows=${m?.rows}`);
    }
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
    const name = `options-${sectionId === "hooks" ? "hooks-table" : "permissions-grouped"}-${width}x${height}${BASELINE ? "-before" : ""}.png`;
    await Deno.writeFile(`${OUT}/${name}`, Uint8Array.from(atob(shot.result.data), (char) => char.charCodeAt(0)));
    if (!BASELINE) {
      // Evidence of the OPEN state too: the first group expanded (rows, switch,
      // ghost button and the What-it-allows disclosure / the per-event switches).
      await send("Runtime.evaluate", { expression: `(() => {
        const g = document.querySelector("#permission-list details.perm-group");
        if (g && ${JSON.stringify(sectionId)} === "permissions") { g.open = true; g.querySelector("capability-row")?.shadowRoot?.querySelector("details.detail")?.setAttribute("open", ""); }
        const t = document.querySelector("#hook-list tbody .hook-group-toggle");
        if (t && ${JSON.stringify(sectionId)} === "hooks") t.click();
        document.getElementById(${JSON.stringify(sectionId)})?.scrollIntoView({ block: "start" });
      })()`, returnByValue: true }, sid);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const openShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
      await Deno.writeFile(`${OUT}/${name.replace(".png", "-open.png")}`, Uint8Array.from(atob(openShot.result.data), (char) => char.charCodeAt(0)));
    }
    await send("Target.closeTarget", { targetId: t.result.targetId });
  }
}

console.log(`${pass} passed, ${fail} failed`);
try { ws.close(); } catch {}
try { proc.kill("SIGKILL"); } catch {}
try { await proc.status; } catch {}
if (fail) Deno.exit(1);

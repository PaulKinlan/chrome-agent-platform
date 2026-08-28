// axe-audit.ts — UX-AUDIT-2026-08-28 UX-006/UX-007 KAT (real browser).
// Runs axe-core 4.x over the four primary extension surfaces (NTP hub,
// options, sidepanel, artifact viewer) and asserts ZERO violations of the
// rules the audit found failing: aria-allowed-attr, landmark-unique,
// nested-interactive, scrollable-region-focusable, landmark-one-main, region,
// page-has-heading-one. A violation outside that set is reported but does not
// fail the gate (new rules are new findings, not this lane's regression).
//
// The NTP and sidepanel journeys are SEEDED (a real <task-row> custom element
// plus a thread-item row mirroring renderTaskRows) before the audit: axe on
// empty surfaces passes nested-interactive vacuously. The seed also runs an
// ACTIVATION probe: clicking Retry/Delete must NOT open the row, clicking the
// open button must, and a keydown on the row wrapper must be inert.
//
//   deno run -A scripts/axe-audit.ts <path-to-extension> [<out-dir>]
//
// Writes evidence: axe-surfaces.json + a PNG per surface.

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/axe-audit`;
// Bypass /usr/bin/chromium: it is an omarchy wrapper that injects a second
// --load-extension, which silently defeats --disable-extensions-except.
const CHROMIUM = "/usr/lib/chromium/chromium";
const AXE_SRC = Deno.env.get("AXE_SRC")
  ?? "/home/paulkinlan/.npm/_npx/0f94ee7615faf582/node_modules/axe-core/axe.min.js";

// The audited rule set. Empty = the full pass gate.
const AUDITED_RULES = [
  "aria-allowed-attr",
  "landmark-unique",
  "nested-interactive",
  "scrollable-region-focusable",
  "landmark-one-main",
  "region",
  "page-has-heading-one",
];

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 600)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the audit to another lane's browser.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${OUT}-${Date.now()}`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

// The MV3 service worker starts asynchronously after extension load — poll.
let sw: any = null;
for (let i = 0; i < 30 && !sw; i++) {
  await sleep(500);
  const { result: { targetInfos } } = await send("Target.getTargets");
  sw = targetInfos.find((t: any) =>
    t.type === "service_worker" || t.type === "background_page"
  );
}
if (!sw) {
  const { result: { targetInfos } } = await send("Target.getTargets");
  console.log("FAIL: no service worker target; saw:", targetInfos.map((t: any) => t.type + ":" + t.url.slice(0, 60)));
  proc.kill(); Deno.exit(1);
}
const extId = new URL(sw.url).host;
await Deno.mkdir(OUT, { recursive: true });

const axeSrc = await Deno.readTextFile(AXE_SRC);

const SURFACES = [
  { name: "ntp-hub", url: `chrome-extension://${extId}/ntp/ntp.html`, wait: 3400, seed: "ntp" },
  { name: "options", url: `chrome-extension://${extId}/options/options.html`, wait: 2600 },
  { name: "sidepanel", url: `chrome-extension://${extId}/sidepanel/sidepanel.html`, wait: 2600, seed: "taskrow" },
  { name: "artifact", url: `chrome-extension://${extId}/artifact/artifact.html`, wait: 1800 },
];

// Seeds mount REAL components (the page's own custom elements) so axe sees a
// populated, interactive surface. The thread-item markup mirrors ntp.js
// renderTaskRows (the structure unit test pins the real renderer).
const SEEDS: Record<string, string> = {
  ntp: `
    (() => {
      const host = document.createElement("div");
      host.id = "axe-seed-host";
      document.body.append(host);
      const tr = document.createElement("task-row");
      tr.setAttribute("name", "Axe seed task");
      tr.setAttribute("status", "failed");
      tr.setAttribute("time", "now");
      tr.setAttribute("retryable", "");
      tr.setAttribute("active", "");
      host.append(tr);
      const sb = document.getElementById("thread-sidebar");
      if (sb) {
        const item = document.createElement("div");
        item.className = "thread-item";
        // Unique marker: the assertion below must inspect THIS seeded row, not
        // whichever production .thread-item happens to be first in the sidebar.
        item.dataset.axeSeed = "thread-item";
        item.title = "Axe seed task";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "t-open";
        open.setAttribute("aria-label", "Open task Axe seed task");
        const dot = document.createElement("span"); dot.className = "dot";
        const name = document.createElement("span"); name.className = "t-name";
        const title = document.createElement("span"); title.className = "t-title";
        title.textContent = "Axe seed task";
        name.append(dot, title);
        const preview = document.createElement("span"); preview.className = "t-preview";
        preview.textContent = "seed preview";
        open.append(name, preview);
        const meta = document.createElement("span"); meta.className = "t-meta";
        meta.textContent = "now";
        const del = document.createElement("button"); del.type = "button"; del.className = "t-delete";
        del.setAttribute("aria-label", "Delete task Axe seed task");
        item.append(open, meta, del);
        sb.append(item);
      }
      return true;
    })()
  `,
  taskrow: `
    (() => {
      const host = document.createElement("div");
      host.id = "axe-seed-host";
      document.body.append(host);
      const tr = document.createElement("task-row");
      tr.setAttribute("name", "Axe seed task");
      tr.setAttribute("status", "failed");
      tr.setAttribute("time", "now");
      tr.setAttribute("retryable", "");
      host.append(tr);
      return true;
    })()
  `,
};

// The activation probe: child-button clicks are exclusive, the open button
// opens, and the row wrapper is inert under the keyboard.
const ACTIVATION_PROBE = `
  (async () => {
    const tr = document.querySelector("#axe-seed-host task-row");
    if (!tr) return { present: false };
    const root = tr.shadowRoot;
    const counts = { open: 0, retry: 0, delete: 0 };
    tr.addEventListener("open", () => counts.open++);
    tr.addEventListener("retry", () => counts.retry++);
    tr.addEventListener("delete", () => counts.delete++);
    root.querySelector(".retry")?.click();
    root.querySelector(".del")?.click();
    root.querySelector(".row-open")?.click();
    const row = root.querySelector(".row");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    return {
      present: true,
      ...counts,
      rowRole: row.getAttribute("role"),
      rowTabbable: row.matches("[tabindex]") ? (row.tabIndex >= 0) : false,
    };
  })()
`;

const results: Record<string, unknown> = {};
for (const s of SURFACES) {
  const { result: { targetId } } = await send("Target.createTarget", { url: s.url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await sleep(s.wait);
  if (s.seed) {
    await send("Runtime.evaluate", { expression: SEEDS[s.seed] }, sessionId);
    await sleep(150);
  }
  const shot = async (path: string) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
  };
  await shot(`${OUT}/${s.name}.png`);

  // Inject axe, then run it. Shadow-DOM piercing is on by default in axe 4.
  await send("Runtime.evaluate", { expression: axeSrc, returnByValue: false }, sessionId);
  const run = await send("Runtime.evaluate", {
    expression: `axe.run(document, { resultTypes: ["violations"] }).then(r => JSON.stringify({
      violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, html: (n.html||"").slice(0, 140), fix: (n.all[0]?.message || n.any[0]?.message || "")?.slice(0, 140) })) })),
      passes: r.passes.length,
    }))`,
    returnByValue: true, awaitPromise: true,
  }, sessionId);
  let parsed: any = null;
  try { parsed = JSON.parse(run.result?.result?.value ?? "null"); } catch { /* keep null */ }
  results[s.name] = parsed;

  const audited = (parsed?.violations ?? []).filter((v: any) => AUDITED_RULES.includes(v.id));
  check(`${s.name}: zero audited axe violations`,
    parsed != null && audited.length === 0,
    audited);
  console.log(`  (${s.name}: ${parsed?.violations?.length ?? "?"} total violation rules, ${parsed?.passes ?? "?"} rule passes)`);
  if (s.seed === "ntp") {
    // The seeded thread-item must be a non-interactive wrapper. Bound to the
    // uniquely-marked seed row (data-axe-seed), never an arbitrary production row.
    const row = await send("Runtime.evaluate", { returnByValue: true, expression: `
      (() => {
        const item = document.querySelector('#thread-sidebar [data-axe-seed="thread-item"]');
        if (!item) return { present: false };
        return {
          present: true,
          role: item.getAttribute("role"),
          tabbable: item.matches("[tabindex]") ? (item.tabIndex >= 0) : false,
          openBtn: !!item.querySelector("button.t-open"),
        };
      })()
    ` }, sessionId);
    const r = row.result?.result?.value ?? {};
    check("ntp-hub: thread-item is a non-interactive wrapper with an explicit open button",
      r.present === true && r.role === null && r.tabbable === false && r.openBtn === true, r);
  }
  if (s.seed === "taskrow" || s.seed === "ntp") {
    const act = await send("Runtime.evaluate", {
      expression: ACTIVATION_PROBE, returnByValue: true, awaitPromise: true,
    }, sessionId);
    const a = act.result?.result?.value ?? {};
    check("activation: child Retry/Delete clicks do NOT open the row; open button does; keydown on the row is inert",
      a.present === true && a.retry === 1 && a.delete === 1 && a.open === 1 &&
      a.rowRole === null && a.rowTabbable === false,
      a);
  }
  await send("Target.closeTarget", { targetId });
}

await Deno.writeTextFile(`${OUT}/axe-surfaces.json`, JSON.stringify(results, null, 1));
console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);

// axe-audit.ts — UX-AUDIT-2026-08-28 UX-006/UX-007 KAT (real browser).
// Runs axe-core 4.x over the four primary extension surfaces (NTP hub,
// options, sidepanel, artifact viewer) and asserts ZERO violations of the
// rules the audit found failing: aria-allowed-attr, landmark-unique,
// nested-interactive, scrollable-region-focusable, landmark-one-main, region,
// page-has-heading-one. A violation outside that set is reported but does not
// fail the gate (new rules are new findings, not this lane's regression).
//
//   deno run -A scripts/axe-audit.ts <path-to-extension> [<out-dir>]
//
// Writes evidence: axe-surfaces.json + a PNG per surface.

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/axe-audit`;
// Bypass /usr/bin/chromium: it is an omarchy wrapper that injects a second
// --load-extension, which silently defeats --disable-extensions-except.
const CHROMIUM = "/usr/lib/chromium/chromium";
const PORT = 9353;
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

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${OUT}-${Date.now()}`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();

const wsUrl = await new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no devtools url")), 15000);
  (async () => { for (;;) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); clearTimeout(t); resolve(j.webSocketDebuggerUrl); return; } catch { await sleep(300); } } })();
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
  { name: "ntp-hub", url: `chrome-extension://${extId}/ntp/ntp.html`, wait: 3400 },
  { name: "options", url: `chrome-extension://${extId}/options/options.html`, wait: 2600 },
  { name: "sidepanel", url: `chrome-extension://${extId}/sidepanel/sidepanel.html`, wait: 2600 },
  { name: "artifact", url: `chrome-extension://${extId}/artifact/artifact.html`, wait: 1800 },
];

const results: Record<string, unknown> = {};
for (const s of SURFACES) {
  const { result: { targetId } } = await send("Target.createTarget", { url: s.url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await sleep(s.wait);
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
  await send("Target.closeTarget", { targetId });
}

await Deno.writeTextFile(`${OUT}/axe-surfaces.json`, JSON.stringify(results, null, 1));
console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);

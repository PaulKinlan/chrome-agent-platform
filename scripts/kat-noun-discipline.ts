// kat-noun-discipline.ts — CAP-FB-20260828-NOUN-DISCIPLINE-01 KAT (real browser).
//
// "It serves" is not "it works": this loads the REAL extension and asserts the
// nouns a person actually reads. One view, ONE name — the sidebar, the quick
// drawer, and BOTH openView call sites must all say Artifacts, and the Agents
// card must name itself once rather than three times nested.
//
//   deno run -A scripts/kat-noun-discipline.ts [out-dir]
//
// Screenshots land in <out-dir> (default ./.cache/kat-noun-discipline).

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const OUT = Deno.args[0] ?? `${ROOT}.cache/kat-noun-discipline`;
const CHROMIUM = "/usr/bin/chromium";
await Deno.mkdir(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A FIXED debugging port silently attaches to somebody else's browser when two
// lanes run at once — which produced a full page of false failures against a
// stale extension before this was hardened. The port is assigned by the kernel
// and read back from THIS Chrome's stderr, so there is nothing to collide with.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    "--window-size=1280,900",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-noun-discipline-${Date.now()}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

// MV3 registers the worker a beat after the browser is reachable — wait for
// it rather than depending on how long the CDP handshake happened to take.
const sw = await waitForServiceWorker(send);
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
const ev = async (expr: string) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  if (r.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};
await sleep(3500);

// ── the sidebar noun ──────────────────────────────────────────────────────
const rail = await ev(`JSON.stringify({
  btn: document.getElementById('open-artifacts')?.textContent.trim(),
  btnTitle: document.getElementById('open-artifacts')?.title,
  oldBtn: !!document.getElementById('open-assets'),
  drawerTag: document.querySelector('artifact-quick-drawer')?.tagName?.toLowerCase() ?? null,
  drawerLabel: document.querySelector('artifact-quick-drawer')?.getAttribute('label'),
  agentsLabels: [...document.querySelectorAll('section [class*=panel-subhead] span, section h2')].map(e=>e.textContent.trim()),
  bodyHasAssets: /\\bAssets?\\b/.test(document.body.innerText)
})`);
const r = JSON.parse(rail);
check("sidebar button says Artifacts", r.btn === "Artifacts", r);
check("its title/tooltip says Artifacts", r.btnTitle === "Artifacts", r);
check("no #open-assets button survives", r.oldBtn === false, r);
check("the quick drawer element is artifact-quick-drawer", r.drawerTag === "artifact-quick-drawer", r);
check("the drawer label says artifacts", r.drawerLabel === "Quick access artifacts", r);
check("no rendered text on the hub says Asset/Assets", r.bodyHasAssets === false, { text: r.bodyHasAssets });
check("Agents names the card once (Agents, Yours, Site Agents)",
  JSON.stringify(r.agentsLabels).includes('"Agents"') &&
  r.agentsLabels.filter((t: string) => t === "Agents").length === 1, r.agentsLabels);
await shot("01-hub");

// ── the quick drawer ──────────────────────────────────────────────────────
await ev(`document.querySelector('artifact-quick-drawer').shadowRoot.querySelector('.trigger').click()`);
await sleep(1200);
const drawer = await ev(`JSON.stringify({
  title: document.querySelector('artifact-quick-drawer').shadowRoot.querySelector('h2')?.textContent.trim(),
  browse: document.querySelector('artifact-quick-drawer').shadowRoot.querySelector('.browse')?.textContent.trim(),
  search: document.querySelector('artifact-quick-drawer').shadowRoot.querySelector('label[for=artifact-quick-search]')?.textContent.trim(),
  empty: document.querySelector('artifact-quick-drawer').shadowRoot.querySelector('.list')?.textContent.trim(),
  open: document.querySelector('artifact-quick-drawer').shadowRoot.querySelector('.trigger')?.getAttribute('aria-expanded')
})`);
const d = JSON.parse(drawer);
check("drawer heading says Recent artifacts", d.title === "Recent artifacts", d);
check("drawer browse action says Browse all artifacts", d.browse === "Browse all artifacts", d);
check("drawer search field says Search artifacts", (d.search ?? "").startsWith("Search artifacts"), d);
check("drawer empty state says artifacts", /artifacts/.test(d.empty ?? "") && !/assets/i.test(d.empty ?? ""), d);
await shot("02-quick-drawer");
await ev(`document.querySelector('artifact-quick-drawer').close()`);
await sleep(500);

// ── the view title, from BOTH call sites ──────────────────────────────────
await ev(`document.getElementById('open-artifacts').click()`);
await sleep(2500);
const viaButton = await ev(`document.getElementById('view-title')?.textContent.trim()`);
check("sidebar → view title is Artifacts", viaButton === "Artifacts", { viaButton });
await shot("03-artifacts-view-from-sidebar");
await ev(`history.back()`);
await sleep(1500);

await ev(`document.getElementById('browse-artifacts').click()`);
await sleep(2500);
const viaCard = await ev(`document.getElementById('view-title')?.textContent.trim()`);
check("hub card 'Browse all' → view title is Artifacts (same name, second call site)", viaCard === "Artifacts", { viaCard });
check("ONE view, ONE title", viaButton === viaCard, { viaButton, viaCard });
await shot("04-artifacts-view-from-card");

const errors = await ev(`JSON.stringify((window.__capErrors ?? []).slice(0,5))`);
console.log("page errors:", errors);
console.log(`\n${pass} passed, ${fail} failed — screenshots in ${OUT}`);
try { proc.kill(); } catch { /* already gone */ }
ws.close();
Deno.exit(fail === 0 ? 0 : 1);

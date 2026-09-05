// scripts/kat-settings-multi-section.ts — CAP-FB-20260827-SETTINGS-MONOLITH-01 / q94
//
// Drives real Chromium with loaded extension:
// 1. Load Settings (#providers by default) -> assert only #providers is visible (.panel.active), others hidden.
// 2. Click sidebar nav for "Browser control" -> assert #browser is visible, #providers is hidden.
// 3. Navigate directly to #skills deep link -> assert #skills is visible, others hidden.
// 4. Navigate directly to #about deep link -> assert #about is visible, others hidden.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 800)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const profile = `${ROOT}.cache/kat-settings-multi-section-${Date.now()}`;
const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank"
  ],
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = () => r(null); ws.onerror = j; });
let id = 0; const pending = new Map<string, (v: any) => void>();
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
const evalIn = async (sid: string, expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r?.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r?.result?.result?.value;
};
const clickSelector = async (sid: string, expr: string) => {
  const box = await evalIn(sid, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
  if (!box || typeof box.x !== "number") return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, sid);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, sid);
  return true;
};

try {
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  check("extension service worker present", !!sw);
  const extId = new URL(sw.url).host;

  // 1. Open Settings default
  const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
  const opts = (await send("Target.attachToTarget", { targetId: optT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, opts);
  await sleep(1600);

  const visiblePanels1 = await evalIn(opts, `[...document.querySelectorAll("section.panel")].filter(s => getComputedStyle(s).display !== "none").map(s => s.id)`);
  check("initial load: only #providers panel is visible", JSON.stringify(visiblePanels1) === JSON.stringify(["providers"]), visiblePanels1);

  // rfca/hy91: visibility alone was GREEN for the whole life of the P0 blank-
  // boot — options.html marks #providers class="panel active" STATICALLY, so a
  // section whose renderer never ran still passed. Assert the CONTENT a first
  // user looks for: provider tabs, rendered provider panels, and an API-key
  // field (all produced by renderProviders(), never present in static HTML).
  const providerContent = await evalIn(opts, `(() => ({
    tabs: document.querySelectorAll("#provider-tabs > *").length,
    panels: document.getElementById("provider-panels")?.children.length ?? 0,
    keyFields: document.querySelectorAll("#providers input.api-key").length,
  }))()`);
  check("initial load: providers panel shows real content (tabs, rendered provider panels, an API-key field) — never a blank shell",
    (providerContent?.tabs ?? 0) > 0 && (providerContent?.panels ?? 0) > 0 && (providerContent?.keyFields ?? 0) > 0, providerContent);

  // 2. Click "Browser control" nav link
  // rfca: visibility alone proves the panel switched, not that its renderer
  // ran (the hy91 blind spot). renderBrowser() binds the auto-close toggle
  // from storage — seed a non-default value BEFORE navigating, then assert
  // the toggle reflects it. If the renderer never runs the seed never
  // reaches the DOM.
  await evalIn(opts, `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:autoCloseRunTabs": true } }).then(v => v)`);
  const clickedBrowser = await clickSelector(opts, `document.querySelector('.nav-item[data-section="browser"]')`);
  check("clicked Browser control nav link", clickedBrowser);
  await sleep(600);

  const visiblePanels2 = await evalIn(opts, `[...document.querySelectorAll("section.panel")].filter(s => getComputedStyle(s).display !== "none").map(s => s.id)`);
  check("after nav click: only #browser panel is visible", JSON.stringify(visiblePanels2) === JSON.stringify(["browser"]), visiblePanels2);

  const browserContent = await evalIn(opts, `(() => ({ autoCloseChecked: document.getElementById("auto-close-run-tabs")?.hasAttribute("checked") ?? null }))()`);
  check("after nav click: #browser shows rendered content (the auto-close toggle reflects seeded storage state)",
    browserContent?.autoCloseChecked === true, browserContent);

  // 3. Navigate directly to #skills deep link
  const skillsT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#skills` });
  const skillsSess = (await send("Target.attachToTarget", { targetId: skillsT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, skillsSess);
  await sleep(1600);

  const visiblePanelsSkills = await evalIn(skillsSess, `[...document.querySelectorAll("section.panel")].filter(s => getComputedStyle(s).display !== "none").map(s => s.id)`);
  check("deep link #skills: only #skills panel is visible", JSON.stringify(visiblePanelsSkills) === JSON.stringify(["skills"]), visiblePanelsSkills);

  // rfca: the skills section's static HTML (heading, import row) is present
  // whether or not mountSkillsSection ran. The mount marks the section with
  // dataset.skillsMounted and wires the Import button — that marker is the
  // renderer-ran proof (CAP-FB-20260901-SKILLS-IMPORT-BUTTON-01).
  const skillsContent = await evalIn(skillsSess, `(() => ({ mounted: document.getElementById("skills")?.dataset.skillsMounted === "1", importBtn: !!document.querySelector("#skills .import-btn") }))()`);
  check("deep link #skills: the skills panel is MOUNTED (renderer ran, Import wired) — not just visible",
    skillsContent?.mounted === true && skillsContent?.importBtn === true, skillsContent);

  // 4. Navigate directly to #about deep link
  const aboutT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#about` });
  const aboutSess = (await send("Target.attachToTarget", { targetId: aboutT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, aboutSess);
  await sleep(1600);

  const visiblePanelsAbout = await evalIn(aboutSess, `[...document.querySelectorAll("section.panel")].filter(s => getComputedStyle(s).display !== "none").map(s => s.id)`);
  check("deep link #about: only #about panel is visible", JSON.stringify(visiblePanelsAbout) === JSON.stringify(["about"]), visiblePanelsAbout);

  // rfca: the About panel's static HTML ships href="#" on the release-notes
  // link; renderAbout() rewrites it to the bundled changelog URL. Assert the
  // rewritten href — the renderer ran — not the version field (that one is
  // filled by top-level boot code and says nothing about renderAbout).
  const aboutContent = await evalIn(aboutSess, `(() => ({ href: document.getElementById("full-release-notes")?.getAttribute("href") ?? "" }))()`);
  check("deep link #about: the release-notes link carries the bundled changelog URL (renderAbout ran), never the static # placeholder",
    typeof aboutContent?.href === "string" && aboutContent.href.endsWith("CHANGELOG.md"), aboutContent);

} finally {
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);

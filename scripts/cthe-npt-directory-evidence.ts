// cthe-npt-directory-evidence.ts — real-browser evidence for
// chrome-agent-platform-cthe: a passively-detected WebMCP page surfaces on the
// HUB'S DIRECTORY BUTTON, not only in Settings or the hub chip.
//
// It drives the real surfaces in order: the fixture shop on 127.0.0.1:8934 is
// opened (passive detection target), the hub's OWN "Find site tools" gesture
// grants scripting and arms detection (the real user path — no injected probe
// button), then the hub's "Directory" button (#open-directory) is clicked and
// the embedded directory frame is asserted for the discovered row.
//
// One-off evidence script (not a registered harness), kept beside the evidence.
// deno run -A scripts/cthe-npt-directory-evidence.ts [outDir]
import { fileURLToPath } from "node:url";
import { launchChrome, openCdp } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const OUT = Deno.args[0] ?? durableDir("cthe-npt-directory");
const SHOP = "http://127.0.0.1:8934/shop";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

await Deno.mkdir(OUT, { recursive: true });

const server = new Deno.Command("deno", {
  args: ["run", "-A", `${ROOT}fixtures/webmcp-server.ts`],
  stdout: "null", stderr: "null",
}).spawn();
await sleep(1200);

const { proc, wsUrl } = await launchChrome({ extension: EXT, timeoutMs: 40_000 });
try {
  const cdp = await openCdp(wsUrl);
  const send = cdp.send;
  const ev = (s: string, e: string) => cdp.eval(s, e);
  const click = async (sessionId: string, selector: string) => {
    const box = await ev(sessionId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId);
    return true;
  };

  const sw = await cdp.serviceWorker({ timeoutMs: 20_000 });
  check("service worker alive", !!sw, sw?.url);
  const host = new URL(sw!.url).hostname;
  const swSession = await cdp.attach(sw!.targetId);

  // 1. The page that will be discovered.
  const { sessionId: shopSession } = await cdp.open(SHOP);
  await sleep(2500);
  check("shop page reachable", (await ev(shopSession, `fetch(location.href).then(() => true)`)) === true);

  // 2. The hub itself — and the REAL first-run path to the scripting grant.
  // The Agents section stays hidden until it has data (`noteHubData`,
  // ntp.js:598/697, gated on `cap:hub-seen:agents`), so the first reachable
  // gesture on a fresh profile is the composer chip's "Check open pages for
  // site tools" variant (#site-offer with the `check` attribute). Its real
  // click settles the JIT scripting request, the SW re-arms the already-open
  // shop tab's detector, the offer lands, the section reveals — and only then
  // does "Find site tools" exist to click. This harness drives that whole
  // chain; nothing is injected.
  const { sessionId: ntpSession } = await cdp.open(`chrome-extension://${host}/ntp/ntp.html`);
  await sleep(2500);

  const chip = await (async () => {
    for (let i = 0; i < 30; i++) {
      const found = await ev(ntpSession, `(() => {
        const el = document.getElementById("site-offer");
        if (!el || el.hidden || !el.hasAttribute("check")) return null;
        const card = el.shadowRoot?.querySelector(".card");
        if (!card) return null;
        card.scrollIntoView({ block: "center" });
        const r = card.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.shadowRoot?.textContent ?? "").replace(/\\s+/g, " ").trim(), w: r.width };
      })()`);
      if (found && found.w > 0) return found;
      await sleep(500);
    }
    return null;
  })();
  check("fresh profile: the composer offers the one named first click (\"Check open pages for site tools\")",
    !!chip && /Check open pages for site tools/.test(String(chip.text)), chip);
  if (!chip) throw new Error("no first-click chip on the fresh profile");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: chip.x, y: chip.y, button: "left", buttons: 1, clickCount: 1 }, ntpSession);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: chip.x, y: chip.y, button: "left", buttons: 0, clickCount: 1 }, ntpSession);

  // The click's JIT request must settle granted without a prompt.
  let granted = false;
  for (let i = 0; i < 20; i++) {
    granted = (await ev(swSession, `chrome.permissions.contains({ permissions: ["scripting"] })`)) === true;
    if (granted) break;
    await sleep(500);
  }
  check("fresh profile: the check click settled the JIT scripting grant (no inject, no prompt)", granted === true, granted);

  // 3. Detection must actually have reported this origin before the directory
  // could ever show it — otherwise a passing directory assertion would be a
  // coincidence. Poll the SW registry; this is a precondition, not a claim.
  let regState: unknown = null;
  for (let i = 0; i < 40; i++) {
    regState = await ev(swSession, `(async () => {
      const got = await chrome.storage.local.get(null);
      const entries = got["cap:knownWebmcpOrigins"] ?? got["cap:webmcpRegistry"] ?? [];
      return entries.map((e) => ({ origin: e.origin, tools: e.documents?.[0]?.toolCount }));
    })()`);
    if (Array.isArray(regState) && regState.some((e: any) => e.origin === "http://127.0.0.1:8934")) break;
    await sleep(500);
  }
  const detected = Array.isArray(regState) && regState.some((e: any) => e.origin === "http://127.0.0.1:8934");
  check("PRECONDITION: the shop origin was detected (registry holds it)", detected, regState);

  // The first click's user-visible outcome, asserted: the Agents section
  // reveals (noteHubData) and "Find site tools" becomes a real target; the
  // chip flips from the check variant to the offer.
  const revealed = await (async () => {
    for (let i = 0; i < 30; i++) {
      const r = await ev(ntpSession, `(() => {
        const sec = document.getElementById("agents-section");
        const link = document.getElementById("discover-page");
        const offer = document.getElementById("site-offer");
        return {
          sectionHidden: sec ? sec.hidden : null,
          linkWidth: link ? Math.round(link.getBoundingClientRect().width) : 0,
          chipOrigin: offer ? offer.getAttribute("origin") : null,
          chipCheck: offer ? offer.hasAttribute("check") : null,
        };
      })()`);
      if (r && r.sectionHidden === false && r.linkWidth > 0) return r;
      await sleep(500);
    }
    return null;
  })();
  check("fresh profile: the Agents section revealed and Find site tools is a real target",
    !!revealed && revealed.sectionHidden === false && revealed.linkWidth > 0, revealed);
  check("the chip flipped from the check variant to the offer",
    !!revealed && revealed.chipOrigin === "http://127.0.0.1:8934", revealed);

  // The hub already surfaces the offer itself (the chip/banner) — record it, so
  // the directory claim is measured in a state where discovery IS visible.
  const hubOffer = await ev(ntpSession, `(() => {
    const text = document.body.innerText;
    return { mentionsOrigin: text.includes("8934"), banner: text.includes("Discovered open pages") };
  })()`);
  console.log("hub-level offer at the time of the directory check:", JSON.stringify(hubOffer));

  // 4. THE CLAIM: the hub's Directory button, clicked for real, shows the
  // discovered page — VISIBLY, reachable, and its action opens the REAL
  // Settings surface. Structural presence is not the claim; a blank region
  // with the right nodes in it must fail.
  check("hub's Directory button is present", (await ev(ntpSession, `!!document.getElementById("open-directory")`)) === true);
  await click(ntpSession, "#open-directory");
  let frame: any = { loaded: false };
  for (let i = 0; i < 30; i++) {
    frame = await ev(ntpSession, `(() => {
      const f = [...document.querySelectorAll("iframe")].find((x) => (x.getAttribute("src") || "").includes("directory/directory.html"));
      const d = f && f.contentDocument;
      if (!d || !f) return { loaded: false };
      const heading = d.getElementById("discovered-heading");
      const section = heading ? heading.closest("section") : null;
      const rows = [...d.querySelectorAll(".policy-note")].map((p) => p.textContent);
      const addBtn = [...d.querySelectorAll("button")].find((b) => b.textContent === "Add in Settings") || null;
      const fr = f.getBoundingClientRect();
      const sr = section ? section.getBoundingClientRect() : null;
      const br = addBtn ? addBtn.getBoundingClientRect() : null;
      const vw = d.defaultView.innerWidth, vh = d.defaultView.innerHeight;
      const sectionVisible = !!(section && sr && sr.width > 1 && sr.height > 1 &&
        sr.bottom > 0 && sr.top < vh && sr.right > 0 && sr.left < vw &&
        section.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      const hitInFrame = !!(addBtn && br && d.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) === addBtn);
      const topX = fr.left + (br ? br.left + br.width / 2 : 0);
      const topY = fr.top + (br ? br.top + br.height / 2 : 0);
      const hit = f.ownerDocument.elementFromPoint(topX, topY);
      return {
        loaded: true, frameUrl: f.getAttribute("src"),
        heading: heading ? heading.textContent : null, rows,
        hasAdd: !!addBtn, empty: !!d.querySelector(".empty"),
        sectionVisible,
        sectionRect: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
        iframeRect: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) },
        hitInFrame, hitAtTop: hit ? (hit.tagName + (hit.id ? "#" + hit.id : "")) : null,
        topX: Math.round(topX), topY: Math.round(topY),
      };
    })()`);
    if (frame?.heading) break;
    await sleep(500);
  }
  check("directory frame loaded", frame?.loaded === true, frame?.frameUrl);
  check("directory shows the Discovered section", frame?.heading === "Discovered — pages offering tools", frame);
  check("the shop row names the origin and its tool count",
    Array.isArray(frame?.rows) && frame.rows.some((r: string) => r.includes("127.0.0.1:8934") && r.includes("5 tools")), frame?.rows);
  check("the discovered section is VISIBLE: non-zero box in the viewport + checkVisibility",
    frame?.sectionVisible === true,
    { sectionVisible: frame?.sectionVisible, sectionRect: frame?.sectionRect, iframeRect: frame?.iframeRect });
  check("the discovered row's action is REACHABLE: hit-testable inside the frame and through the iframe at the top level",
    frame?.hitInFrame === true && /IFRAME/.test(String(frame?.hitAtTop)),
    { hitInFrame: frame?.hitInFrame, hitAtTop: frame?.hitAtTop });

  // 4a. The same two properties at the narrow width the reviewer checked.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 650, deviceScaleFactor: 1, mobile: true }, ntpSession);
  await sleep(800);
  const narrow = await ev(ntpSession, `(() => {
    const f = [...document.querySelectorAll("iframe")].find((x) => (x.getAttribute("src") || "").includes("directory/directory.html"));
    const d = f && f.contentDocument;
    const section = d && d.getElementById("discovered-heading")?.closest("section");
    const addBtn = d && [...d.querySelectorAll("button")].find((b) => b.textContent === "Add in Settings");
    const sr = section ? section.getBoundingClientRect() : null;
    const br = addBtn ? addBtn.getBoundingClientRect() : null;
    const vw = d?.defaultView?.innerWidth ?? 0, vh = d?.defaultView?.innerHeight ?? 0;
    const visible = !!(section && sr && sr.width > 1 && sr.height > 1 && sr.bottom > 0 && sr.top < vh && sr.right > 0 && sr.left < vw &&
      section.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    const reachable = !!(addBtn && br && d.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) === addBtn);
    return { visible, reachable, rect: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null };
  })()`);
  check("at 390x650 the discovered section is still VISIBLE and its action reachable",
    narrow?.visible === true && narrow?.reachable === true, narrow);
  await send("Emulation.clearDeviceMetricsOverride", {}, ntpSession);
  await sleep(500);
  check("the directory is not showing the empty state while discovery exists", frame?.empty === false, frame);

  // 4b. NATIVE ACTION: a real mouse event at the TOP-level coordinates (through
  // the iframe) on "Add in Settings", then the REAL Settings surface must
  // actually open — not a stand-in for the action the user is asked to take.
  if (frame?.topX) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: frame.topX, y: frame.topY, button: "left", buttons: 1, clickCount: 1 }, ntpSession);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: frame.topX, y: frame.topY, button: "left", buttons: 0, clickCount: 1 }, ntpSession);
  }
  let settings: any = { openedTarget: null, contexts: [], embedded: false };
  for (let i = 0; i < 20; i++) {
    // Two independent observables of the REAL Settings surface opening: the
    // browser's target list (this client wraps replies as {result:{...}}) and
    // chrome.runtime.getContexts, which — unlike chrome.tabs.query — shows
    // extension document URLs.
    const raw: any = await send("Target.getTargets").catch(() => null);
    const targetUrls: string[] = (raw?.result?.targetInfos ?? raw?.targetInfos ?? []).map((t: any) => String(t.url || ""));
    const contexts: string[] = await ev(swSession, `chrome.runtime.getContexts({}).then((c) => c.map((x) => x.documentUrl || x.contextType))`).catch(() => []);
    const targetOpts = targetUrls.find((u) => u.includes("/options/options.html"));
    const ctxOpts = (contexts ?? []).find((u) => u.includes("/options/options.html"));
    const embedded = await ev(ntpSession, `(() => {
      const f = [...document.querySelectorAll("iframe")].find((x) => (x.getAttribute("src") || "").includes("options/options.html"));
      if (!f) return false;
      const r = f.getBoundingClientRect();
      return !f.hidden && r.width > 1 && r.height > 1;
    })()`);
    settings = { openedTarget: targetOpts ?? ctxOpts ?? null, contexts, targetUrls, embedded };
    if (settings.openedTarget || settings.embedded) break;
    await sleep(500);
  }
  check("the Add in Settings action opens the REAL Settings surface", !!(settings.openedTarget || settings.embedded), settings);

  const shot = await cdp.screenshot(ntpSession);
  if (shot) await Deno.writeFile(`${OUT}/ntp-directory-discovered.png`, shot);
  console.log(`screenshot: ${OUT}/ntp-directory-discovered.png`);
  cdp.close();
} finally {
  proc.kill("SIGKILL");
  server.kill("SIGKILL");
}
console.log(`RESULT: ${pass} passed, ${fail} failed; evidence: ${OUT}`);
Deno.exit(fail ? 1 : 0);

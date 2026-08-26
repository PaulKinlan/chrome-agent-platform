// scripts/headed-acceptance.ts — the HEADED acceptance journey (production path).
//
// CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01. Consolidates the three residuals
// that headless CANNOT prove into ONE repeatable macro:
//   (a) the screenshot SUCCESS path (headless auto-denies arbitrary-tab
//       capture; only a real action click grants the transient activeTab),
//   (b) the full enrollment lifecycle as one journey — enroll, discover,
//       invoke, clean up, retry — through the REAL extension UI (real CDP
//       clicks; the same #enroll-origin / #enroll-btn / #discover-page /
//       picker / .disenroll-origin selectors the headless suite drives),
//   (c) the two WebMCP OS permission prompts (tabs at "Discover this page",
//       host access at the picker pick) from docs/WEBMCP-ACCEPTANCE.md.
//
// It drives production code only (the shipped extension, no manifest variant,
// no injected main-world source) — the round-28 block was acceptance that
// bypassed the implementation.
//
// RUN (headed only — it REFUSES to run without a real display; exit 2):
//   HEADED_EVIDENCE_DIR=$HOME/cap-evidence/headed-acceptance-$(date +%s) \
//     deno run -A scripts/headed-acceptance.ts --headed
//
// Evidence goes to DURABLE storage (default
// $HOME/cap-evidence/headed-acceptance/<ISO-timestamp>; /tmp and /dev/shm are
// refused). Every step is labelled MANUAL (a human clicked an OS prompt) or
// AUTOMATED, in the printed log AND in headed-acceptance-manifest.json.
// The headless suites are untouched and still assert fail-closed denial.
//
// Pre-flight (fail-closed, before any browser launch):
//   1. --headed must be passed.
//   2. A display must be reachable: WAYLAND_DISPLAY (+ grim) or DISPLAY.
//   3. On Wayland/Hyprland: `hyprctl -j monitors` must be non-empty — a locked
//      or idle session (monitors: []) cannot show the OS permission prompts.
//   4. /usr/bin/chromium must exist.

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const FIXTURE_PORT = 8934;
const PAGE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

const HEADED = Deno.args.includes("--headed");

// ── evidence dir (durable only) ──────────────────────────────────────────────
function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
const EVIDENCE_DIR = Deno.env.get("HEADED_EVIDENCE_DIR") ??
  `${Deno.env.get("HOME") ?? "."}/cap-evidence/headed-acceptance/${isoStamp()}`;

// ── bounded helpers ──────────────────────────────────────────────────────────
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(t!);
  }
}

async function fetchJson(url: string, opts?: RequestInit) {
  const res = await withTimeout(fetch(url, opts), 8000, `fetch ${url}`);
  return await withTimeout(res.json(), 8000, `json ${url}`);
}

function runBounded(cmd: string, args: string[], env?: Record<string, string>, timeoutMs = 30000) {
  const proc = new Deno.Command(cmd, {
    args,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const child = proc.spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }, timeoutMs);
  const outP = (async () => {
    const out = await child.output();
    if (timedOut) throw new Error(`run ${cmd} timed out (killed)`);
    return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
  })();
  return { child, out: outP, clear: () => clearTimeout(timer) };
}

async function runWait(cmd: string, args: string[], env?: Record<string, string>, timeoutMs = 30000) {
  const r = runBounded(cmd, args, env, timeoutMs);
  const out = await r.out;
  r.clear();
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── pre-flight (fail closed) ─────────────────────────────────────────────────
const displayEnv: Record<string, string> = { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };
async function preflight() {
  if (!HEADED) {
    console.error("REFUSED: this script runs HEADED ONLY (a human clicks real OS permission prompts).\n" +
      "The headless suites (chrome-journeys, webmcp-acceptance automated mode) already assert fail-closed denial.\n" +
      "Run with --headed on a machine with an unlocked graphical session.");
    Deno.exit(2);
  }
  const wayland = Deno.env.get("WAYLAND_DISPLAY") ?? "wayland-1";
  const xdgRuntime = Deno.env.get("XDG_RUNTIME_DIR") ?? "/run/user/1000";
  const hyprSig = (() => {
    try {
      const dir = Deno.readDirSync(`${xdgRuntime}/hypr`);
      let sig: string | null = null;
      for (const e of dir) if (e.isDirectory) sig = e.name;
      return sig;
    } catch { return null; }
  })();

  const isWayland = Deno.env.get("WAYLAND_DISPLAY") !== undefined || (hyprSig !== null && !Deno.env.get("DISPLAY"));
  if (isWayland) {
    displayEnv.WAYLAND_DISPLAY = wayland;
    displayEnv.XDG_RUNTIME_DIR = xdgRuntime;
    if (hyprSig) displayEnv.HYPRLAND_INSTANCE_SIGNATURE = hyprSig;
    // grim must exist (the retained screenshot mechanism).
    const grim = await runWait("which", ["grim"], displayEnv, 5000);
    if (grim.code !== 0) {
      console.error("REFUSED: Wayland display detected but grim is missing — install grim (screenshots are the evidence).");
      Deno.exit(2);
    }
    // An unlocked session with an active monitor is the scheduling precondition.
    const mons = await runWait("hyprctl", ["-j", "monitors"], displayEnv, 8000);
    if (mons.code !== 0) {
      console.error("REFUSED: hyprctl could not reach the compositor — is a graphical session running?");
      Deno.exit(2);
    }
    try {
      if (JSON.parse(mons.stdout).length === 0) {
        console.error("REFUSED: no active monitors (session locked/idle — monitors: []).\n" +
          "Run this macro in an unlocked session with at least one active monitor.");
        Deno.exit(2);
      }
    } catch {
      console.error("REFUSED: could not parse hyprctl monitors output.");
      Deno.exit(2);
    }
  } else if (Deno.env.get("DISPLAY")) {
    displayEnv.DISPLAY = Deno.env.get("DISPLAY")!;
  } else {
    console.error("REFUSED: no display — set DISPLAY (X11) or run inside a Wayland session.");
    Deno.exit(2);
  }

  const chrome = await runWait("test", ["-x", CHROMIUM], displayEnv, 5000);
  if (chrome.code !== 0) {
    console.error(`REFUSED: ${CHROMIUM} not found.`);
    Deno.exit(2);
  }
  if (EVIDENCE_DIR.startsWith("/tmp") || EVIDENCE_DIR.startsWith("/dev/shm")) {
    console.error(`REFUSED: evidence dir ${EVIDENCE_DIR} is RAM-backed. Evidence must live on durable storage.`);
    Deno.exit(2);
  }
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  await Deno.mkdir(`${EVIDENCE_DIR}/screenshots`, { recursive: true });
  console.log(`preflight ok: display=${isWayland ? `wayland ${wayland}` : Deno.env.get("DISPLAY")} evidence=${EVIDENCE_DIR}`);
}

// ── grim screenshot to durable storage ───────────────────────────────────────
let grimSeq = 0;
async function grimShot(label: string): Promise<string | null> {
  const name = `${String(++grimSeq).padStart(2, "0")}-${label}.png`;
  const path = `${EVIDENCE_DIR}/screenshots/${name}`;
  const out = await runWait("grim", ["-o", path], displayEnv, 10000);
  if (out.code !== 0) {
    console.log(`WARN: grim ${label} failed: ${out.stderr.trim()}`);
    return null;
  }
  console.log(`evidence: grim ${name}`);
  return path;
}

// ── CDP plumbing ─────────────────────────────────────────────────────────────
interface Cdp {
  ws: WebSocket;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<{ id: number; result?: Record<string, unknown>; error?: { message: string } }>;
}
async function connectCdp(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error(`ws connect failed: ${wsUrl}`));
  });
  let nextId = 1;
  const pending = new Map<number, (v: { id: number; result?: Record<string, unknown>; error?: { message: string } }) => void>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  };
  return {
    ws,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

async function evalIn(cdp: Cdp, session: string, expr: string) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, session);
  if (r.error) throw new Error(`eval failed: ${r.error.message}`);
  const ex = (r.result as any)?.exceptionDetails;
  if (ex) throw new Error(`eval exception: ${JSON.stringify(ex.exception?.description ?? ex.text)}`);
  return (r.result as any)?.result?.value;
}

async function until<T>(fn: () => Promise<T | null | false>, timeoutMs: number, stepMs = 500): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v !== null && v !== false) return v as T;
    await sleep(stepMs);
  }
  return null;
}

async function boxOf(cdp: Cdp, session: string, selector: string) {
  return await evalIn(cdp, session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`) as { x: number; y: number } | null;
}

async function clickSel(cdp: Cdp, session: string, selector: string) {
  const b = await boxOf(cdp, session, selector);
  if (!b) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, session);
  return true;
}

async function typeText(cdp: Cdp, session: string, text: string) {
  for (const ch of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, session);
  }
}

async function typeInto(cdp: Cdp, session: string, selector: string, text: string) {
  const clicked = await clickSel(cdp, session, selector);
  if (!clicked) return false;
  await typeText(cdp, session, text);
  return true;
}

async function captureShot(cdp: Cdp, session: string) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
  const b64 = (r.result as any)?.data;
  if (!b64) return null;
  return new Uint8Array(atob(b64).split("").map((c) => c.charCodeAt(0)));
}

// ── assertions + evidence manifest ───────────────────────────────────────────
const results: { step: string; gesture: "manual-user-click" | "automated"; pass: boolean }[] = [];
const ran = new Set<string>();
function check(name: string, cond: boolean, gesture: "manual-user-click" | "automated" = "automated") {
  if (ran.has(name)) throw new Error(`duplicate assertion: ${name}`);
  ran.add(name);
  results.push({ step: name, gesture, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: [${gesture === "manual-user-click" ? "MANUAL" : "auto"}] ${name}`);
}

async function manual(n: number, of: number, what: string, poll: () => Promise<boolean>, timeoutMs = 180000) {
  console.log(`\n=== MANUAL STEP ${n} of ${of}: ${what} ===\n`);
  const ok = await until(async () => (await poll()) ? true : null, timeoutMs);
  return ok === true;
}

async function writeEvidence(name: string, bytes: Uint8Array) {
  const path = `${EVIDENCE_DIR}/screenshots/${name}`;
  await Deno.writeFile(path, bytes);
  console.log(`evidence: ${name}`);
  return path;
}

// ── chrome launch (HEADED) ───────────────────────────────────────────────────
function launchHeadedChrome(profile: string) {
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--remote-debugging-port=0",
    "--window-size=1400,2400",
    `--user-data-dir=${profile}`,
  ];
  if (displayEnv.WAYLAND_DISPLAY) {
    args.push("--ozone-platform=wayland", "--ozone-platform-hint=wayland");
  }
  args.push("about:blank");
  return new Deno.Command(CHROMIUM, {
    args,
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: displayEnv,
  }).spawn();
}

async function waitForPort(proc: Deno.ChildProcess): Promise<number> {
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const reader = proc.stderr.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    if (done) break;
    const m = new TextDecoder().decode(value).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return Number(m[1]);
  }
  throw new Error("chrome DevTools port never appeared");
}

// ── the journey ──────────────────────────────────────────────────────────────
async function main() {
  await preflight();

  // Fresh build — the SW bundle must match the sources under test.
  const build = await runWait("npm", ["run", "build"], {}, 300000);
  if (build.code !== 0) {
    console.error("REFUSED: npm run build failed — the headed macro must drive the freshly built production bundle.");
    Deno.exit(1);
  }

  const fixture = new Deno.Command("deno", { args: ["run", "-A", `${ROOT}fixtures/webmcp-server.ts`], stdout: "null", stderr: "null" }).spawn();

  const profile = `${EVIDENCE_DIR}/profile`;
  const chrome = launchHeadedChrome(profile);
  const port = await waitForPort(chrome);
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = await connectCdp(version.webSocketDebuggerUrl);

  try {
    // Attach the extension service worker (find it by URL).
    await sleep(1500); // let the SW register
    const sw = await until(async () => {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      return list.find((t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://")) ?? null;
    }, 20000);
    if (!sw) throw new Error("extension service worker never appeared");
    const extId = sw.url.split("/")[2];
    const sws = (await cdp.send("Target.attachToTarget", { targetId: sw.id, flatten: true })).result!.sessionId as string;
    await cdp.send("Runtime.enable", {}, sws);

    const msgSw = (msg: unknown) => evalIn(cdp, sws, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

    // Hub (NTP) + Settings sessions.
    const optT = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
    const opts = (await cdp.send("Target.attachToTarget", { targetId: optT.result!.targetId, flatten: true })).result!.sessionId as string;
    await cdp.send("Runtime.enable", {}, opts);
    await cdp.send("Page.enable", {}, opts);
    const nT = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
    const ns = (await cdp.send("Target.attachToTarget", { targetId: nT.result!.targetId, flatten: true })).result!.sessionId as string;
    await cdp.send("Runtime.enable", {}, ns);
    await cdp.send("Page.enable", {}, ns);
    const msgNs = (msg: unknown) => evalIn(cdp, ns, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

    // Fixture page (attach BEFORE any injection so main-world scriptParsed events are honest).
    const fT = await cdp.send("Target.createTarget", { url: `${PAGE_ORIGIN}/index.html` });
    const wsess = (await cdp.send("Target.attachToTarget", { targetId: fT.result!.targetId, flatten: true })).result!.sessionId as string;
    await cdp.send("Runtime.enable", {}, wsess);
    await cdp.send("Page.enable", {}, wsess);
    await until(() => evalIn(cdp, wsess, `document.getElementById("msg")?.textContent === "fixture loaded" ? true : null`), 8000);
    check("fixture page loaded", true);
    const fixtureTabId = await evalIn(cdp, sws, `chrome.tabs.query({}).then(ts => ts.find(t => t.url && t.url.startsWith(${JSON.stringify(PAGE_ORIGIN)}))?.id ?? null)`);

    // ── STEP E — ENROLL (the headless fail-closed path's headed success). ──
    check("Settings: Enroll input present", (await boxOf(cdp, opts, "#enroll-origin")) !== null);
    check("Settings: typed the fixture origin into the Enroll field", await typeInto(cdp, opts, "#enroll-origin", PAGE_ORIGIN));
    check("Settings: clicked Enroll via a real click", await clickSel(cdp, opts, "#enroll-btn"));
    const enrolled = await manual(1, 4,
      "a Chrome prompt is asking for host access to 127.0.0.1:8934 — click ALLOW.",
      async () => (await msgSw({ type: "agent.list" }))?.includes?.(PAGE_ORIGIN) === true);
    check("enrollment: OS prompt granted → origin ENROLLED (headed success of the headless fail-closed denial)", enrolled, "manual-user-click");
    await grimShot("enrolled-settings");

    // ── STEP S — SCREENSHOT SUCCESS (the headed-only capture path). ──
    // (a) the TRANSIENT owner-invoked path: the human clicks the extension
    // ACTION icon while viewing the fixture page → activeTab for THAT tab →
    // captureTabScreenshot(ownerInvoked) → journaled to the hub memory.
    await cdp.send("Target.activateTarget", { targetId: fT.result!.targetId });
    await sleep(500);
    const journalBefore = await msgNs({ type: "memory.get", origin: "master", key: "journal" }).catch(() => null);
    const shotsBefore = Array.isArray(journalBefore) ? journalBefore.filter((e: any) => e?.type === "screenshot").length : 0;
    const actionShot = await manual(2, 4,
      "click the extension ACTION icon (puzzle → Chrome Agent Platform) while viewing the 127.0.0.1 fixture page — this is the transient owner-invoked screenshot gesture.",
      async () => {
        const j = await msgNs({ type: "memory.get", origin: "master", key: "journal" }).catch(() => null);
        return Array.isArray(j) && j.filter((e: any) => e?.type === "screenshot").length > shotsBefore;
      });
    check("screenshot: owner action click journaled a REAL screenshot entry to the hub memory (the headless auto-denied path)", actionShot, "manual-user-click");
    // (b) the exact-host path: with the OS host grant from STEP E, capture.tab
    // returns real PNG bytes (headless asserts this FAILS — see the journeys'
    // screenshot matrix; headed asserts the SUCCESS here).
    const capture = await msgNs({ type: "capture.tab", tabId: fixtureTabId });
    const pngOk = typeof capture?.screenshot === "string" && capture.screenshot.startsWith("data:image/png") && capture.screenshot.length > 200;
    check("screenshot: capture.tab returns real PNG bytes once the OS host grant is live", pngOk);
    await grimShot("fixture-page-with-extension");
    const shot = await captureShot(cdp, wsess);
    if (shot) await writeEvidence("fixture-page-cdp.png", shot);

    // ── STEP D — DISCOVER (WebMCP OS prompt #1: tabs). ──
    check("hub: clicked Discover this page via a real click", await clickSel(cdp, ns, `document.getElementById("discover-page")`));
    const tabsGranted = await manual(3, 4,
      "a Chrome permission prompt is showing — click ALLOW (tabs). This is WebMCP OS prompt 1 of 2.",
      async () => (await evalIn(cdp, sws, `chrome.permissions.contains({ permissions: ["tabs"] })`)) === true);
    check("webmcp prompt 1: the tabs permission was granted via the real OS prompt", tabsGranted, "manual-user-click");
    const pickerHasFixture = await until(() => evalIn(cdp, ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      if (!dlg) return null;
      const rows = [...dlg.querySelectorAll("capability-row")];
      return rows.some((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)}) ? true : null;
    })()`), 12000);
    check("hub: the tab picker lists the fixture tab (exact tab identity)", pickerHasFixture === true);
    await grimShot("tab-picker");

    // ── STEP P — PICK (WebMCP OS prompt #2: host access). ──
    const rowClicked = await clickSel(cdp, ns, `document.querySelector("agent-dialog capability-row[description=${JSON.stringify(PAGE_ORIGIN)}]")`);
    check("hub: picked the fixture tab in the picker via a real click", rowClicked);
    const hostGranted = await manual(4, 4,
      "a Chrome permission prompt is showing — click ALLOW (host access for 127.0.0.1:8934). This is WebMCP OS prompt 2 of 2.",
      async () => (await evalIn(cdp, sws, `chrome.permissions.contains({ origins: [${JSON.stringify(PAGE_ORIGIN + "/*")}] })`)) === true);
    check("webmcp prompt 2: the fixture host permission was granted via the real OS prompt", hostGranted, "manual-user-click");

    // ── STEP I — INVOKE (production site invocation with a visible side effect). ──
    const toolNames = await until(async () => {
      const list = await msgNs({ type: "tools.list", origin: PAGE_ORIGIN });
      const names = Array.isArray(list) ? list.map((t: any) => t.name) : [];
      return names.includes("greet") && names.includes("shop.total") && names.includes("shop.catalog") && names.includes("shop.coupon") ? names : null;
    }, 15000);
    check("declared + inferred tools discovered through the production bridge", !!toolNames);
    const decoyT = await cdp.send("Target.createTarget", { url: `${PAGE_ORIGIN}/index.html?decoy=1` });
    const decoy = (await cdp.send("Target.attachToTarget", { targetId: decoyT.result!.targetId, flatten: true })).result!.sessionId as string;
    await cdp.send("Runtime.enable", {}, decoy);
    await until(() => evalIn(cdp, decoy, `document.readyState === "complete" ? true : null`), 8000);
    const greetRes = await msgNs({ type: "tools.invoke", origin: PAGE_ORIGIN, name: "greet", args: { name: "paul" } });
    check("production tools.invoke: directory → exact approved tab/document → MAIN returns the page function result", greetRes?.ok === true && greetRes?.result === "hello paul");
    const sideEffect = await evalIn(cdp, wsess, `({ msg: document.getElementById("msg")?.textContent, calls: window.__greetCalls })`);
    const decoyEffect = await evalIn(cdp, decoy, `({ msg: document.getElementById("msg")?.textContent, calls: window.__greetCalls })`);
    check("invoke: VISIBLE side effect occurs exactly once in the approved tab/document", sideEffect?.msg === "greeted paul (#1)" && sideEffect?.calls === 1);
    check("invoke: the second same-origin tab is NOT invoked", decoyEffect?.calls === 0);
    await grimShot("invoke-side-effect");

    // ── STEP C — CLEAN UP (disenroll, no second approval). ──
    check("Settings: Disenroll button present for the enrolled agent", (await boxOf(cdp, opts, ".disenroll-origin")) !== null);
    check("Settings: clicked Disenroll via a real click", await clickSel(cdp, opts, ".disenroll-origin"));
    await sleep(800);
    const afterDisenroll = await msgSw({ type: "agent.list" });
    check("disenroll: agent removed from the list (an owner click needs no second approval)", !Array.isArray(afterDisenroll) || !afterDisenroll.includes(PAGE_ORIGIN));

    // ── STEP R — RETRY (re-enroll + re-invoke; the lifecycle is repeatable). ──
    check("retry: typed the origin again", await typeInto(cdp, opts, "#enroll-origin", PAGE_ORIGIN));
    check("retry: clicked Enroll again", await clickSel(cdp, opts, "#enroll-btn"));
    const reenrolled = await until(async () => (await msgSw({ type: "agent.list" }))?.includes?.(PAGE_ORIGIN) === true ? true : null, 15000);
    check("retry: re-enrolled without a second OS prompt (permission already granted)", reenrolled === true);
    const greetAgain = await msgNs({ type: "tools.invoke", origin: PAGE_ORIGIN, name: "greet", args: { name: "paul" } });
    check("retry: production invocation works again on the re-enrolled bridge", greetAgain?.ok === true && greetAgain?.result === "hello paul");

    // ── manifest + verdict ───────────────────────────────────────────────────
    const manifest = {
      overallStatus: results.every((r) => r.pass) ? "ATTESTED" : "OPEN",
      permissionGrant: "manual-user-allow",
      testedSourceCommit: (await runWait("git", ["rev-parse", "HEAD"], {}, 8000)).stdout.trim(),
      evidenceDir: EVIDENCE_DIR,
      manualSteps: results.filter((r) => r.gesture === "manual-user-click").map((r) => r.step),
      steps: results,
    };
    await Deno.writeFile(`${EVIDENCE_DIR}/headed-acceptance-manifest.json`, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    const fails = results.filter((r) => !r.pass).length;
    console.log(`\nheaded acceptance: ${results.length - fails}/${results.length} passed — manifest at ${EVIDENCE_DIR}/headed-acceptance-manifest.json`);
    return fails === 0 ? 0 : 1;
  } finally {
    try { chrome.kill("SIGKILL"); } catch { /* gone */ }
    try { fixture.kill("SIGKILL"); } catch { /* gone */ }
  }
}

Deno.exit(await main());

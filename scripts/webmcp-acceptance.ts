// webmcp-acceptance.ts — the PRODUCTION-PATH WebMCP discovery acceptance
// journey (replaces the round-28-rejected scripts/webmcp-integration.ts, which
// bypassed the implementation under test: it Runtime.evaluate'd the MAIN-world
// source into the page, faked the bridge handshake, and called agent.create /
// tools.upsert directly from an extension page).
//
// This journey drives the REAL loaded-MV3 path end-to-end:
//   1. the REAL discovery UI (hub "Discover this page" → the tab picker → the
//      exact picked tab), clicked with real CDP Input events;
//   2. the REAL permission request (chrome.permissions.request on the click);
//   3. dynamic registration + current-tab injection of BOTH packaged scripts;
//   4. CDP Debugger.scriptParsed evidence that chrome-extension://…/content/
//      main-world.js and …/content/content-script.js really executed in the
//      picked tab (never a fetch-200 "it serves" inference);
//   5. [WebMCP] console lifecycle events from both worlds;
//   6. discovery WITHOUT a reload (immediate injection), then AFTER a reload
//      (dynamic registration + the bridge startup enrollment sync) and after a
//      cross-document navigation;
//   7. GENUINE model invocation: the composer creates a real foreground run,
//      the exact first-use approval card appears in that conversation, a real
//      owner click persists Allow, and only then does the lazy protocol reach
//      invokeSiteTool → isolated → MAIN and visibly mutate the page. Follow-up
//      model runs prove silent reuse and sticky Deny; Settings clicks prove
//      rearm/reset, bounded audit pagination, and in-flight result suppression.
//      Owner-only `tools.invoke` remains only for lower-level bridge negatives.
//   8. re-enrollment singleton: repeated enrollment yields exactly ONE live
//      bridge (one side effect per invoke);
//   9. screenshots + a machine-verifiable manifest (test-artifacts/ by
//      default, or WEBMCP_ARTIFACT_DIR for exact-clean-commit external evidence).
//
// THE PERMISSION GESTURE. `scripting` and `tabs` are OPTIONAL on the shipped
// manifest, but the discovery flow needs NO permission prompt at all (probed
// 2026-08-30):
//   - scripting carries NO install warning once <all_urls> host access is
//     install-granted, so chrome.permissions.request({permissions:["scripting"]})
//     settles silently — even headless — when issued from a real user gesture.
//     The hub's "Discover this page" click requests it JIT before listing, and
//     the SW's permissions.onAdded nudge re-arms the passive detectors in
//     already-open pages (their first arm predated the grant).
//   - tabs is WARNED, but the picker doesn't need it: install-granted
//     <all_urls> already exposes tab URLs/titles to chrome.tabs.query.
//
// Two modes:
//
//   deno run -A scripts/webmcp-acceptance.ts            # automated, status OPEN
//   deno run -A scripts/webmcp-acceptance.ts --headed   # full SHIPPED-bytes attestation
//
// Automated mode FIRST drives a FRESH PROFILE on the SHIPPED manifest: ONE real
// Discover click must settle the JIT scripting grant, re-arm the already-open
// fixture tab's detector, and open the picker listing it — the fresh-profile
// deadlock (review P1) can never return without failing this run. It then loads
// a TEST VARIANT (byte-identical EXCEPT the manifest pre-holds scripting+tabs)
// for the deep discovery/injection/invocation checks; shipped <all_urls> host
// access is unchanged (permissionGrant:"test-manifest-pregranted"). Status
// stays OPEN because the deep path is attested on variant bytes.
//
// --headed mode drives the SHIPPED extension end-to-end with NO manual step —
// the JIT grant is silent, so enrollment + invocation are asserted on shipped
// bytes (permissionGrant:"jit-silent-no-prompt"; status ATTESTED on success).
// See docs/WEBMCP-ACCEPTANCE.md.
//
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const FIXTURE_PORT = 8934;
const PAGE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const SHOWCASE_URL = `${PAGE_ORIGIN}/shop`;
const HEADED = Deno.args.includes("--headed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal flat-session CDP client over the browser endpoint launchChrome()
 * read from Chrome's own stderr (the showcase block below uses it). */
async function cdpConnect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  let id = 0;
  const pend = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id)!; pend.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  // Every call is bounded: a CDP command against a stale or backgrounded
  // target can otherwise hang the whole suite (the 93531db2 finding).
  const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pend.delete(mid); rej(new Error(`cdp timeout: ${method}`)); }, 30000);
    pend.set(mid, { res: (v: any) => { clearTimeout(timer); res(v); }, rej: (e: Error) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  const evalIn = async (sess: string, e: string) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, sess);
    if (r?.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    return r?.result?.value;
  };
  const attach = async (targetId: string) => {
    const sess = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;
    await send("Runtime.enable", {}, sess);
    return sess;
  };
  const click = async (sess: string, box: { x: number; y: number }) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, sess);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, sess);
  };
  /** A GENUINE click on an element found by an expression (may reach into an
   * open shadow root); returns false when the element is absent. */
  const clickExpr = async (sess: string, expr: string) => {
    const box = await evalIn(sess, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
    if (!box || typeof box.x !== "number") return false;
    await click(sess, box);
    return true;
  };
  const until = async (fn: () => any, ms: number, step = 250) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const v = await fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };
  return { send, evalIn, attach, click, clickExpr, until, close: () => ws.close() };
}

let pass = 0, fail = 0;
const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  checks.push({ name, pass: !!cond, ...(cond ? {} : { detail }) });
  if (cond) { pass++; console.log("PASS: " + name); }
  else { fail++; console.log("FAIL: " + name + " — " + JSON.stringify(detail)); }
}

async function fetchJson(url: string) { const r = await fetch(url); return r.json(); }
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function launchFixture(logPath?: string) {
  // The server's stderr is copied to the artifact dir (a bind failure — a
  // stale server holding 8934 — used to be silent and read as a product
  // failure).
  const proc = new Deno.Command("deno", {
    args: ["run", "-A", `${ROOT}fixtures/webmcp-server.ts`],
    stdout: "null",
    stderr: logPath ? "piped" : "null",
  }).spawn();
  if (logPath) {
    (async () => {
      const file = await Deno.open(logPath, { write: true, create: true, truncate: true });
      try { await proc.stderr.pipeTo(file.writable); } catch { /* the server went away */ }
    })();
  }
  return proc;
}

/** Wait until the fixture server answers (or report why it does not). */
async function waitForFixture(ms = 10000): Promise<{ ok: boolean; detail?: string }> {
  const deadline = Date.now() + ms;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${PAGE_ORIGIN}/shop`, { signal: AbortSignal.timeout(1500) });
      const text = await r.text();
      if (r.ok && text.includes("Showcase Shop")) return { ok: true };
      lastError = `HTTP ${r.status} (${text.slice(0, 60)})`;
    } catch (e) {
      lastError = String((e as Error)?.message ?? e);
    }
    await sleep(250);
  }
  return { ok: false, detail: lastError };
}

// The TEST VARIANT: byte-identical extension except the manifest pre-holds the
// API permissions exercised by the headed flow. Shipped host access is unchanged.
async function makeVariant() {
  const dir = durableDir(`cap-webmcp-variant-${Date.now()}`);
  await Deno.mkdir(dir, { recursive: true });
  const cp = new Deno.Command("cp", { args: ["-r", EXT + "/.", dir] }).spawn();
  await cp.status;
  const mf = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
  mf.permissions = [...new Set([...(mf.permissions ?? []), "scripting", "tabs"])];
  mf.optional_permissions = (mf.optional_permissions ?? []).filter((permission: string) =>
    permission !== "scripting" && permission !== "tabs"
  );
  await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(mf, null, 2) + "\n");
  return dir;
}

// Every spawn goes through the shared launcher: the debugging port is
// kernel-assigned and the endpoint is read back from THIS child's own stderr
// (never a probe of a port another lane's Chrome might be answering on).
function launch(profile: string, extDir: string) {
  const args = [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank",
  ];
  if (!HEADED) args.unshift("--headless=new");
  return launchChrome({ binary: CHROMIUM, args });
}

async function main() {
  // 0. Fresh build (the SW bundle must match the sources under test) + fixture.
  const build = new Deno.Command("node", { args: [`${ROOT}build.mjs`], stdout: "null", stderr: "null", cwd: ROOT }).spawn();
  const buildStatus = await build.status;
  check("build succeeded (dist matches sources)", buildStatus.success);

  const configuredArtifactDir = Deno.env.get("WEBMCP_ARTIFACT_DIR")?.trim();
  const artifactDir = (configuredArtifactDir || `${ROOT}test-artifacts`).replace(/\/$/, "");
  await Deno.mkdir(artifactDir, { recursive: true });

  const passiveDetectorFiles = [
    `${EXT}/lib/webmcp-detection-registry.js`,
    `${EXT}/content/webmcp-detect-main.js`,
    `${EXT}/content/webmcp-detect-relay.js`,
  ];
  const passiveDetectorAvailable = (await Promise.all(passiveDetectorFiles.map((file) =>
    Deno.stat(file).then(() => true).catch(() => false)
  ))).every(Boolean);
  if (!passiveDetectorAvailable) {
    const git = async (args: string[]) => new TextDecoder().decode(
      (await new Deno.Command("git", { args, cwd: ROOT, stdout: "piped" }).output()).stdout,
    ).trim();
    const commit = await git(["rev-parse", "HEAD"]);
    const dirty = await git(["status", "--porcelain"]);
    const manifest = {
      testedSourceCommit: commit,
      evidenceCommitNote: dirty
        ? "working-tree run; worktreeDirtyFiles lists every difference from testedSourceCommit"
        : "exact clean testedSourceCommit; evidence was written separately from source",
      worktreeDirtyFiles: dirty ? dirty.split("\n").filter(Boolean) : [],
      runId: `webmcp-acceptance-${Date.now()}`,
      ts: new Date().toISOString(),
      mode: HEADED ? "headed-manual" : "automated-variant",
      permissionGrant: "not-run",
      overallStatus: "NOT RUNNABLE — this base predates main's passive WebMCP detector; run after merge",
      variantNote: "the manifest variant preserves boot-critical permissions and moves only scripting+tabs from optional to required",
      passed: pass,
      failed: fail,
      checks,
      notRun: [
        "fresh-profile passive detection, picker discovery, enrollment, injection, and invocation require main's passive detector",
      ],
      evidence: { scriptParsedUrls: [], consoleEvents: [], screenshots: [] },
    };
    await Deno.writeTextFile(
      `${artifactDir}/webmcp-acceptance-manifest.json`,
      JSON.stringify(manifest, null, 2) + "\n",
    );
    console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${manifest.notRun.length} not runnable — status: ${manifest.overallStatus}`);
    return;
  }

  const fixture = launchFixture(`${artifactDir}/webmcp-fixture-server.log`);
  const fixtureUp = await waitForFixture();
  check("fixture server answers on 127.0.0.1:8934 (/ and /shop)", fixtureUp.ok, fixtureUp.detail);
  if (!fixtureUp.ok) {
    try { fixture.kill("SIGKILL"); } catch { /* already dead */ }
    console.log(`\nRESULT: ${pass} passed, ${fail} failed — the fixture server never answered; see ${artifactDir}/webmcp-fixture-server.log`);
    Deno.exit(1);
  }

  // Evidence collectors.
  const scriptParsedUrls: string[] = [];
  const consoleEvents: string[] = [];
  const screenshots: { name: string; sha256: string; bytes: number }[] = [];

  // 0.5 FRESH PROFILE on the SHIPPED manifest (no variant pregrants) — the
  // review-P1 proof. ONE real Discover click carries the whole chain: the JIT
  // scripting request settles granted (warningless, no prompt — even
  // headless), the SW's permissions.onAdded nudge re-arms the already-open
  // fixture tab's passive detector (its first arm predated the grant), and
  // the picker opens listing that tab. `tabs` is not required (install-granted
  // <all_urls> already exposes tab URLs/titles). This block carries its own
  // minimal plumbing so the proven variant flow below is untouched.
  if (!HEADED) {
    const freshProfile = durableDir(`cap-webmcp-fresh-${Date.now()}`);
    await Deno.mkdir(freshProfile, { recursive: true });
    const fresh = await launch(freshProfile, EXT);
    const freshProc = fresh.proc;
    try {
      const freshPort = fresh.port;
      const fws = new WebSocket(fresh.wsUrl);
      await new Promise<void>((res, rej) => { fws.onopen = () => res(); fws.onerror = rej; });
      let fid = 0; const fpend = new Map();
      fws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && fpend.has(m.id)) {
          const p = fpend.get(m.id); fpend.delete(m.id);
          m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        }
      };
      const fsend = (method: string, params: any, sessionId?: string) => new Promise<any>((res, rej) => {
        const mid = ++fid; fpend.set(mid, { res, rej });
        fws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
      const feval = async (sess: string, e: string) => {
        const r = await fsend("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, sess);
        if (r?.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
        return r?.result?.value;
      };
      const funtil = async (fn: () => any, ms: number, step = 300) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const v = await fn();
          if (v) return v;
          await sleep(step);
        }
        return null;
      };
      let fsw: any = null;
      for (let i = 0; i < 60 && !fsw; i++) {
        const ts = await fetchJson(`http://127.0.0.1:${freshPort}/json/list`);
        fsw = ts.find((t: any) => t.type === "service_worker");
        if (!fsw) await sleep(200);
      }
      check("fresh profile (shipped manifest): extension loaded", !!fsw);
      const fExtId = fsw.url.split("/")[2];
      const fsws = (await fsend("Target.attachToTarget", { targetId: fsw.id, flatten: true })).sessionId;
      await fsend("Runtime.enable", {}, fsws);

      const freshPerms = await feval(fsws, `Promise.all([
        chrome.permissions.contains({ permissions: ["scripting"] }),
        chrome.permissions.contains({ permissions: ["tabs"] }),
      ])`);
      check("fresh profile (shipped manifest): scripting + tabs start ungranted",
        Array.isArray(freshPerms) && freshPerms[0] === false && freshPerms[1] === false, freshPerms);

      // The fixture tab: passive detection needs no optional permission (the
      // detectors are statically registered content scripts).
      await fsend("Target.createTarget", { url: `${PAGE_ORIGIN}/index.html` });
      await sleep(1500);

      // The hub on a fresh profile. Today's hub hides the Agents section (and
      // its "Find site tools" link) until it has data, and no page can report
      // tools before the one-time `scripting` grant (arming the MAIN-world
      // probe needs it) — so the first reachable gesture is the composer chip
      // "Check open pages for site tools" (CAP-FB-20260825-SITE-AGENT-
      // SHOWCASE-01). Its real click settles the JIT scripting grant
      // (warningless, no prompt), the SW's permissions.onAdded nudge re-arms
      // the already-open fixture tab's detector, its count lands, the Agents
      // section appears with the discovered-pages banner, and "Find site
      // tools" opens the picker listing that tab.
      const fNT = await fsend("Target.createTarget", { url: `chrome-extension://${fExtId}/ntp/ntp.html` });
      const fns = (await fsend("Target.attachToTarget", { targetId: fNT.targetId, flatten: true })).sessionId;
      await fsend("Runtime.enable", {}, fns);
      await fsend("Page.enable", {}, fns);
      await sleep(1600);
      await fsend("Target.activateTarget", { targetId: fNT.targetId });
      const checkChip = await funtil(() => feval(fns, `(() => {
        const el = document.getElementById("site-offer");
        if (!el || el.hidden || !el.hasAttribute("check")) return null;
        const card = el.shadowRoot?.querySelector(".card");
        if (!card) return null;
        card.scrollIntoView({block:"center"});
        const r = card.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.shadowRoot?.textContent ?? "").replace(/\\s+/g, " ").trim() };
      })()`), 8000);
      check("fresh profile: the composer offers the one named first click (\"Check open pages for site tools\") before any grant",
        !!checkChip && /Check open pages for site tools/.test(String(checkChip.text)), checkChip);
      if (checkChip) {
        await fsend("Input.dispatchMouseEvent", { type: "mousePressed", x: checkChip.x, y: checkChip.y, button: "left", buttons: 1, clickCount: 1 }, fns);
        await fsend("Input.dispatchMouseEvent", { type: "mouseReleased", x: checkChip.x, y: checkChip.y, button: "left", buttons: 0, clickCount: 1 }, fns);
      }
      // Host access is install-granted (<all_urls>, owner decision Q18), so
      // only the API permissions can change here: scripting lands, tabs stays.
      const jitGranted = await funtil(
        () => feval(fsws, `Promise.all([
          chrome.permissions.contains({ permissions: ["scripting"] }),
          chrome.permissions.contains({ permissions: ["tabs"] }),
        ]).then(([s, t]) => s && !t ? true : null)`),
        10000,
      );
      check("fresh profile: the check click issued the JIT scripting request and it settled granted (warningless, no prompt) — tabs stays ungranted",
        jitGranted === true);
      // The grant re-arms the fixture tab's detector → its count lands → the
      // Agents section (with the discovered-pages banner) becomes visible and
      // "Find site tools" is reachable.
      const fBox = await funtil(() => feval(fns, `(() => { const el = document.getElementById("discover-page"); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return r.width > 0 ? {x:r.x+r.width/2, y:r.y+r.height/2} : null; })()`), 10000);
      if (fBox && typeof fBox.x === "number") {
        await fsend("Input.dispatchMouseEvent", { type: "mousePressed", x: fBox.x, y: fBox.y, button: "left", buttons: 1, clickCount: 1 }, fns);
        await fsend("Input.dispatchMouseEvent", { type: "mouseReleased", x: fBox.x, y: fBox.y, button: "left", buttons: 0, clickCount: 1 }, fns);
      }
      check("fresh profile: Find site tools became reachable and was clicked via a real click", !!(fBox && typeof fBox.x === "number"));

      // The picker-open proof the review demanded: the SAME first Discover
      // click carries the whole fresh-profile chain — JIT scripting grant →
      // the SW's permissions.onAdded nudge re-arms the already-open fixture
      // tab's detector → its first snapshot lands → the hub's bounded poll
      // lists it → the picker opens with the fixture row. No variant
      // pregrant, no prompt, no Settings detour. The deadline covers the
      // grant + re-arm + first snapshot + the hub's own 5s poll.
      const pickerRow = await funtil(() => feval(fns, `(() => {
        const dlg = document.querySelector("agent-dialog");
        if (!dlg) return null;
        const rows = [...dlg.querySelectorAll("capability-row")];
        return rows.some((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)}) ? true : null;
      })()`), 15000);
      check("fresh profile (SHIPPED manifest, no pregrants): the picker opens from the discover gesture listing the fixture tab",
        pickerRow === true);
      const fShot = await fsend("Page.captureScreenshot", { format: "png" }, fns).catch(() => null);
      if (fShot?.data) {
        const bytes = Uint8Array.from(atob(fShot.data), (c: string) => c.charCodeAt(0));
        await Deno.writeFile(`${artifactDir}/webmcp-acceptance-fresh-profile.png`, bytes);
        screenshots.push({ name: "webmcp-acceptance-fresh-profile.png", sha256: await sha256Hex(bytes), bytes: bytes.length });
      }
      fws.close();
    } finally {
      try { freshProc.kill("SIGKILL"); } catch { /* already dead */ }
      await Deno.remove(freshProfile, { recursive: true }).catch(() => {});
    }
  }

  // 0.6 THE SHOWCASE (CAP-FB-20260825-SITE-AGENT-SHOWCASE-01): sites as
  // sub-agents demonstrable in under a minute, on a FRESH profile with the
  // SHIPPED manifest and no API key. The path an owner walks: open the hub,
  // open the Showcase Shop, the composer shows "<host> offers 5 tools — use
  // them?" within 3 s (no permission involved yet), ONE click grants
  // scripting + that exact origin and enrolls that exact tab (the grant names
  // the origin), then a task calls the site's add_to_cart through the real
  // lazy protocol: the page's cart changes and the transcript's tool card
  // names the site's tool. Timed end to end. Then the service worker is
  // restarted and the site's tool still runs without re-enrollment.
  // Enrollment grants discovery and worker custody, never automatic model use.
  // The negative asserted here is that BEFORE enrollment nothing can run; after
  // enrollment the first exact model-selected tool still pauses for its own
  // owner-bound consent card.
  if (!HEADED) {
    const showcaseProfile = durableDir(`cap-webmcp-showcase-${Date.now()}`);
    await Deno.mkdir(showcaseProfile, { recursive: true });
    const launched = await launchChrome({
      binary: CHROMIUM,
      args: [
        "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
        "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
        "--remote-allow-origins=*", "--window-size=1400,1200",
        `--user-data-dir=${showcaseProfile}`, "about:blank",
      ],
    });
    try {
      const c = await cdpConnect(launched.wsUrl);
      // waitForServiceWorker reads `res.result.targetInfos` (the raw CDP
      // message shape); cdpConnect resolves with the bare result, so wrap it.
      const rawSend = (method: string, params?: any) => c.send(method, params ?? {}).then((result) => ({ result }));
      const sw = await waitForServiceWorker(rawSend, { timeoutMs: 20000 });
      check("showcase: fresh profile (shipped manifest) loaded the extension", !!sw);
      if (!sw) throw new Error("showcase: no service worker target");
      const extId = new URL(sw.url).host;
      const sws = await c.attach(sw.targetId);
      const perms0 = await c.evalIn(sws, `Promise.all([
        chrome.permissions.contains({ permissions: ["scripting"] }),
        chrome.permissions.contains({ permissions: ["tabs"] }),
      ])`);
      check("showcase: scripting + tabs start ungranted", Array.isArray(perms0) && perms0[0] === false && perms0[1] === false, perms0);

      // The hub FIRST (t0 = hub load): the chip must appear while the owner is
      // already looking at the hub, pushed by the page's detection report.
      const t0 = Date.now();
      const hubT = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
      const ns = await c.attach(hubT.targetId);
      await c.send("Page.enable", {}, ns);
      const hubReady = await c.until(() => c.evalIn(ns, `(() => { const el = document.getElementById("site-offer"); return el ? { hidden: el.hidden } : null; })()`), 10000);
      // rfca justification: hidden-while-empty IS the contract under test
      // (the chip must not advertise before any site offers tools); the
      // offer-present direction is content-checked by the showcase probes
      // below (5 products, cart contents).
      check("showcase: the hub declares the site-offer chip, hidden while nothing offers tools", hubReady?.hidden === true, hubReady);
      // Real clicks need the tab in front (a user activation comes from a
      // focused frame), and screenshots of a backgrounded tab are unreliable.
      const front = async (targetId: string, sess: string) => {
        await c.send("Target.activateTarget", { targetId }).catch(() => {});
        await c.send("Page.bringToFront", {}, sess).catch(() => {});
        await sleep(150);
      };
      const shotOf = async (sess: string, name: string) => {
        const shot = await c.send("Page.captureScreenshot", { format: "png" }, sess).catch(() => null);
        if (!shot?.data) return;
        const bytes = Uint8Array.from(atob(shot.data), (ch: string) => ch.charCodeAt(0));
        await Deno.writeFile(`${artifactDir}/${name}`, bytes);
        screenshots.push({ name, sha256: await sha256Hex(bytes), bytes: bytes.length });
      };
      await front(hubT.targetId, ns);

      // Open the Showcase Shop in another tab, then come back to the hub —
      // the owner is looking at the hub when the chip appears.
      const tOpen = Date.now();
      const shopT = await c.send("Target.createTarget", { url: SHOWCASE_URL });
      const shop = await c.attach(shopT.targetId);
      await c.send("Page.enable", {}, shop);
      await front(hubT.targetId, ns);
      const shopLoaded = await c.until(() => c.evalIn(shop, `(() => { const c = document.getElementById("cart-count"); const n = document.querySelectorAll("#products li").length; return c && n === 5 && !!document.modelContext ? { cart: c.textContent, products: n } : null; })()`), 8000, 100);
      check("showcase: the Showcase Shop loaded (5 products, an empty cart, document.modelContext present)", shopLoaded?.products === 5 && shopLoaded?.cart === "0", shopLoaded);
      // FRESH PROFILE: no page can report a count before the one-time
      // `scripting` grant (arming the MAIN-world probe needs it), so the chip
      // first offers exactly that click — "Check open pages for site tools" —
      // within 3 s, with NOTHING granted yet.
      const checkText = await c.until(() => c.evalIn(ns, `(() => {
        const el = document.getElementById("site-offer");
        if (!el || el.hidden || !el.hasAttribute("check")) return null;
        return (el.shadowRoot?.textContent ?? "").replace(/\\s+/g, " ").trim();
      })()`), 8000, 100);
      const checkMs = Date.now() - tOpen;
      check("showcase (fresh): the chip offers the named first click (\"Check open pages for site tools\") within 3 s of opening the tab",
        typeof checkText === "string" && /Check open pages for site tools/.test(checkText) && checkMs <= 3000, { checkText, checkMs });
      const checkA11y = await c.evalIn(ns, `(() => { const card = document.getElementById("site-offer")?.shadowRoot?.querySelector(".card"); return card ? { role: card.getAttribute("role"), label: card.getAttribute("aria-label") } : null; })()`);
      check("showcase (fresh): the check chip's accessible name says what the click grants (look for tools on open pages)",
        checkA11y?.role === "button" && /look for tools on pages you have open/.test(String(checkA11y?.label)), checkA11y);
      // Host access is install-granted (<all_urls>, owner decision Q18): the
      // only things a click can change are the API permissions and the
      // enrollment. Before the check click neither scripting nor tabs is held
      // and nothing is enrolled.
      const permsBeforeCheck = await c.evalIn(sws, `Promise.all([
        chrome.permissions.contains({ permissions: ["scripting"] }),
        chrome.permissions.contains({ permissions: ["tabs"] }),
      ])`);
      const enrolledBefore = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
      check("showcase (fresh): no API permission is granted and nothing is enrolled before the check click",
        Array.isArray(permsBeforeCheck) && permsBeforeCheck.every((p: boolean) => p === false) && Array.isArray(enrolledBefore) && enrolledBefore.length === 0,
        { permsBeforeCheck, enrolledBefore });
      await front(hubT.targetId, ns);
      await shotOf(ns, "showcase-check.png");
      const checkClicked = await c.clickExpr(ns, `document.getElementById("site-offer")?.shadowRoot?.querySelector(".card")`);
      check("showcase (fresh): clicked the check chip via a real click", checkClicked);
      const scriptingOnly = await c.until(() => c.evalIn(sws, `Promise.all([
        chrome.permissions.contains({ permissions: ["scripting"] }),
        chrome.permissions.contains({ permissions: ["tabs"] }),
      ]).then(([s, t]) => s && !t ? true : null)`), 10000, 100);
      const tGrant = Date.now();
      const enrolledAfterCheck = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
      check("showcase (fresh): the check click granted exactly scripting (silent, no prompt) — tabs stays ungranted, nothing enrolled",
        scriptingOnly === true && Array.isArray(enrolledAfterCheck) && enrolledAfterCheck.length === 0, { scriptingOnly, enrolledAfterCheck });
      // The grant re-arms the already-open shop tab's detector; its count
      // lands and the chip becomes the offer within 3 s of the grant.
      const chipText = await c.until(() => c.evalIn(ns, `(() => {
        const el = document.getElementById("site-offer");
        if (!el || el.hidden || !el.hasAttribute("offer")) return null;
        const text = (el.shadowRoot?.textContent ?? "").replace(/\\s+/g, " ").trim();
        return text.includes("offers") ? text : null;
      })()`), 8000, 100);
      const chipMs = Date.now() - tGrant;
      check("showcase: the offer chip appears within 3 s of detection becoming possible (the grant)", typeof chipText === "string" && chipMs <= 3000, { chipText, chipMs, sinceTabOpenMs: Date.now() - tOpen });
      check("showcase: the chip names the host and the tool count (\"127.0.0.1:8934 offers 5 tools — use them?\")",
        /127\.0\.0\.1:8934 offers 5 tools — use them\?/.test(String(chipText)), chipText);
      const chipA11y = await c.evalIn(ns, `(() => { const card = document.getElementById("site-offer")?.shadowRoot?.querySelector(".card"); return card ? { role: card.getAttribute("role"), tabindex: card.getAttribute("tabindex"), label: card.getAttribute("aria-label") } : null; })()`);
      check("showcase: the chip is a keyboard-operable button whose accessible name names the host",
        chipA11y?.role === "button" && chipA11y?.tabindex === "0" && /127\.0\.0\.1:8934/.test(String(chipA11y?.label)), chipA11y);
      const enrolledBeforeOffer = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
      check("showcase: the site is NOT a Site Agent before the owner's offer click (offer, not authority)",
        Array.isArray(enrolledBeforeOffer) && !enrolledBeforeOffer.includes(PAGE_ORIGIN), enrolledBeforeOffer);
      const invokeBefore = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(PAGE_ORIGIN)}, name: "add_to_cart", args: { sku: "widget-basic" } })`);
      const cartBefore = await c.evalIn(shop, `document.getElementById("cart-count")?.textContent`);
      check("showcase: before the click the site's tools cannot be invoked (not enrolled) and the cart is untouched",
        invokeBefore?.ok === false && cartBefore === "0", { invokeBefore, cartBefore });
      await front(hubT.targetId, ns);
      await shotOf(ns, "showcase-chip.png");

      // ONE real click on the chip.
      const statusSeen: string[] = [];
      const statusWatch = (async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const s = await c.evalIn(ns, `(() => { const el = document.getElementById("status"); return el && !el.hidden ? el.textContent : null; })()`).catch(() => null);
          if (typeof s === "string" && s && !statusSeen.includes(s)) statusSeen.push(s);
          if (statusSeen.some((x) => x.includes(PAGE_ORIGIN))) break;
          await sleep(80);
        }
      })();
      const clicked = await c.clickExpr(ns, `document.getElementById("site-offer")?.shadowRoot?.querySelector(".card")`);
      check("showcase: clicked the chip via a real click", clicked);
      const granted = await c.until(() => c.evalIn(sws, `Promise.all([
        chrome.permissions.contains({ permissions: ["scripting"] }),
        chrome.permissions.contains({ origins: [${JSON.stringify(PAGE_ORIGIN + "/*")}] }),
        chrome.permissions.contains({ permissions: ["tabs"] }),
      ]).then(([s, o, t]) => s && o && !t ? true : null)`), 10000);
      check("showcase: after the offer click scripting + host access for the showcase origin are held and tabs stays ungranted (no prompt)", granted === true);
      const enrolled = await c.until(async () => {
        const list = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
        return Array.isArray(list) && list.includes(PAGE_ORIGIN) ? list : null;
      }, 15000);
      check("showcase: one click enrolled the showcase origin as a Site Agent", !!enrolled, enrolled);
      await statusWatch;
      check("showcase: the grant names the exact origin in the hub's status", statusSeen.some((s) => s.includes(PAGE_ORIGIN)), statusSeen);
      const usingText = await c.until(() => c.evalIn(ns, `(() => {
        const el = document.getElementById("site-offer");
        if (!el || el.hidden || !el.hasAttribute("using")) return null;
        const text = (el.shadowRoot?.querySelector(".offer-text")?.textContent ?? "").replace(/\\s+/g, " ").trim();
        return text.startsWith("Using") ? text : null;
      })()`), 10000);
      check("showcase: the chip becomes \"Using 127.0.0.1:8934 · 5 tools\"", /^Using 127\.0\.0\.1:8934 · 5 tools$/.test(String(usingText)), usingText);
      const injected = await c.until(async () => {
        const s = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "webmcp.status" })`);
        return s?.status?.origin === PAGE_ORIGIN && s.status.scriptStatus === "injected" ? s.status : null;
      }, 10000);
      const shopTabId = await c.evalIn(sws, `chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(SHOWCASE_URL)})?.id ?? null)`);
      check("showcase: the EXACT showcase tab was injected (injection.ready contains its tab id)",
        Array.isArray(injected?.injection?.ready) && injected.injection.ready.includes(shopTabId), { ready: injected?.injection?.ready, shopTabId });
      const toolNames = await c.until(async () => {
        const list = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.list", origin: ${JSON.stringify(PAGE_ORIGIN)} })`);
        const names = Array.isArray(list) ? list.map((t: any) => t.name) : [];
        return ["list_products", "search_products", "add_to_cart", "remove_from_cart", "cart_total"].every((n) => names.includes(n)) ? names : null;
      }, 15000);
      check("showcase: the five declared tools were discovered through the production bridge", !!toolNames, toolNames);
      await front(hubT.targetId, ns);
      await shotOf(ns, "showcase-grant.png");

      // A fresh profile has NO model connected: the keyless default answers
      // the tab tasks only (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01). The
      // marker demo model (which honours @demo-site-tool) sits behind the
      // developer flag — set it from the Settings page, as the MCP KAT does,
      // so the run genuinely goes through the model loop with no API key.
      const optT = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
      const opts = await c.attach(optT.targetId);
      await sleep(800);
      const devFlag = await c.until(async () => {
        const r = await c.evalIn(opts, `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:developerFeatures": true } })`);
        return r?.ok === true ? r : null;
      }, 10000, 500);
      check("showcase: the developer-flag demo model is enabled through the Settings route (no API key)", devFlag?.ok === true, devFlag);
      await c.send("Target.closeTarget", { targetId: optT.targetId }).catch(() => {});
      await front(hubT.targetId, ns);

      // The task, from the composer, addressed to the SITE AGENT the way an
      // owner does it — "@" opens the mention popup, the site row is chosen
      // with a real click — so the run is routed to that site's own worker
      // (agent.delegate), whose catalog carries the page's tools. The demo
      // model then calls add_to_cart through the REAL lazy protocol.
      const focused = await c.clickExpr(ns, `document.querySelector("#task-input")`);
      check("showcase: focused the composer via a real click", focused);
      await c.send("Input.insertText", { text: "@127" }, ns);
      const mentionRow = await c.until(() => c.evalIn(ns, `(() => {
        const rows = [...document.querySelectorAll('agent-composer#composer .popup .item[role="option"]')];
        const hit = rows.find((r) => (r.textContent || "").includes("127.0.0.1:8934"));
        return hit ? (hit.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120) : null;
      })()`), 8000, 100);
      check("showcase: typing @ offers the showcase site as a mention (the site is an agent the owner can address)", typeof mentionRow === "string", mentionRow);
      const mentionClicked = await c.clickExpr(ns, `[...document.querySelectorAll('agent-composer#composer .popup .item[role="option"]')].find((r) => (r.textContent || "").includes("127.0.0.1:8934"))`);
      check("showcase: chose the site mention via a real click", mentionClicked);
      const selected = await c.until(() => c.evalIn(ns, `(() => { const a = document.querySelector("agent-composer#composer")?.selectedAgent; return a && a.kind === "site" ? { kind: a.kind, id: a.id } : null; })()`), 5000, 100);
      check("showcase: the composer routes this task to the site agent (selected kind = site, id = the origin)", selected?.id === PAGE_ORIGIN, selected);
      const taskTail = ` add the cheapest widget to my cart and tell me the total @demo-site-tool add_to_cart {"sku":"widget-basic"}`;
      await c.send("Input.insertText", { text: taskTail }, ns);
      const typed = await c.evalIn(ns, `document.querySelector("#task-input")?.value`);
      check("showcase: the task is in the composer", typeof typed === "string" && typed.endsWith(taskTail), typed);
      const ran = await c.clickExpr(ns, `document.querySelector("#run-task")`);
      check("showcase: clicked Run task via a real click", ran);
      const firstUseCard = await c.until(() => c.evalIn(ns, `(() => {
        const cards = [...document.querySelectorAll("approval-card")];
        const card = cards.find((candidate) => candidate.getAttribute("title")?.includes("add_to_cart") && candidate.getAttribute("state") !== "granted");
        if (!card) return null;
        const root = card.shadowRoot;
        return {
          title: card.getAttribute("title"),
          body: card.getAttribute("body"),
          approve: root?.querySelector(".approve")?.textContent?.trim(),
          deny: root?.querySelector(".deny")?.textContent?.trim(),
          focused: root?.activeElement?.classList?.contains("approve") === true,
        };
      })()`), 15000, 100);
      check("first use: the genuine model run pauses on the exact site/tool card",
        firstUseCard?.title === `Use ${PAGE_ORIGIN}’s add_to_cart?` &&
          String(firstUseCard?.body).includes(`Site: ${PAGE_ORIGIN}`) &&
          String(firstUseCard?.body).includes("Tool: add_to_cart"), firstUseCard);
      check("first use: the card offers exact Allow automatically and Deny controls",
        firstUseCard?.approve === "Allow automatically" && firstUseCard?.deny === "Deny", firstUseCard);
      const firstUseFocus = await c.until(() => c.evalIn(ns, `[...document.querySelectorAll("approval-card")].some((card) => card.getAttribute("title")?.includes("add_to_cart") && card.shadowRoot?.activeElement?.classList?.contains("approve")) ? true : null`), 3000, 50);
      check("first use: keyboard focus moves to Allow automatically", firstUseFocus === true);
      const pendingCart = await c.evalIn(shop, `document.getElementById("cart-count")?.textContent`);
      check("first use: no page side effect crosses before the owner decides", pendingCart === "0", pendingCart);
      await front(hubT.targetId, ns);
      await shotOf(ns, "showcase-first-use-card.png");
      const allowedFirstUse = await c.clickExpr(ns, `[...document.querySelectorAll("approval-card")].find((card) => card.getAttribute("title")?.includes("add_to_cart") && card.getAttribute("state") !== "granted")?.shadowRoot?.querySelector(".approve")`);
      check("first use: clicked Allow automatically in the originating conversation", allowedFirstUse);
      const settledFirstUse = await c.until(() => c.evalIn(ns, `[...document.querySelectorAll("approval-card")].some((card) => card.getAttribute("title")?.includes("add_to_cart") && card.getAttribute("state") === "granted") ? true : null`), 10000, 100);
      check("first use: the exact card settles granted", settledFirstUse === true);
      const cartChanged = await c.until(() => c.evalIn(shop, `(() => {
        const count = document.getElementById("cart-count")?.textContent;
        const total = document.getElementById("cart-total")?.textContent;
        const line = document.querySelector('#cart-items li[data-sku="widget-basic"]')?.textContent ?? "";
        return count === "1" && total === "$4.50" ? { count, total, line } : null;
      })()`), 40000);
      const tChanged = Date.now();
      check("showcase: add_to_cart changed the page (cart shows Widget (basic) × 1, total $4.50)", !!cartChanged, cartChanged);
      check("showcase: under 60 s from hub load to the page changing", tChanged - t0 < 60000, { ms: tChanged - t0 });
      const toolCard = await c.until(() => c.evalIn(ns, `(() => {
        const cards = [...document.querySelectorAll('message-bubble[role="tool"]')];
        const hit = cards.find((b) => (b.getAttribute("tool-name") || "") === "add_to_cart");
        if (!hit) return null;
        const status = hit.getAttribute("tool-status");
        return status === "success" ? { name: hit.getAttribute("tool-name"), status, text: (hit.shadowRoot?.textContent ?? "").replace(/\\s+/g, " ").slice(0, 300) } : null;
      })()`), 20000);
      check("showcase: the transcript's tool card shows the site's tool name (add_to_cart) with a successful result", toolCard?.name === "add_to_cart" && toolCard?.status === "success", toolCard);
      const firstActivityControl = await c.evalIn(ns, `(() => {
        const card = [...document.querySelectorAll('message-bubble[role="tool"]')].find((bubble) => bubble.getAttribute("tool-name") === "add_to_cart");
        let activity = null;
        try { activity = JSON.parse(card?.getAttribute("site-activity") || "null"); } catch {}
        const button = card?.shadowRoot?.querySelector(".site-activity");
        return card && button ? { activity, label: button.textContent?.trim(), aria: button.getAttribute("aria-label") } : null;
      })()`);
      check("first use: the completed site-tool bubble exposes its exact owner-only activity control",
        firstActivityControl?.activity?.origin === PAGE_ORIGIN && firstActivityControl?.activity?.tool === "add_to_cart" &&
          Object.keys(firstActivityControl.activity).length === 2 && firstActivityControl?.label === "View site activity",
        firstActivityControl);
      const firstActivityExpanded = await c.clickExpr(ns, `[...document.querySelectorAll('message-bubble[role="tool"]')].find((bubble) => bubble.getAttribute("tool-name") === "add_to_cart")?.shadowRoot?.querySelector("details.tool > summary")`);
      check("first use activity: expanded the completed tool bubble with a real click", firstActivityExpanded);
      const firstActivityOpened = await c.clickExpr(ns, `[...document.querySelectorAll('message-bubble[role="tool"]')].find((bubble) => bubble.getAttribute("tool-name") === "add_to_cart")?.shadowRoot?.querySelector(".site-activity")`);
      check("first use activity: clicked View site activity from the tool bubble", firstActivityOpened);
      const consentSettingsT = await c.until(async () => {
        const targets = await c.send("Target.getTargets");
        return targets?.targetInfos?.find((target: any) => target.type === "page" && String(target.url).includes(`chrome-extension://${extId}/options/options.html`)) ?? null;
      }, 10000, 100);
      check("first use activity: the bubble opens the production Settings document", !!consentSettingsT?.targetId, consentSettingsT);
      if (!consentSettingsT?.targetId) throw new Error("site activity Settings target missing");
      const consentSettings = await c.attach(consentSettingsT.targetId);
      await c.send("Page.enable", {}, consentSettings);
      const firstActivityFocused = await c.until(() => c.evalIn(consentSettings, `(() => {
        const manager = document.getElementById("webmcp-consent-manager");
        const focus = manager?._activityFocus;
        const target = manager?.shadowRoot?.querySelector(".audit-target");
        return focus?.origin === ${JSON.stringify(PAGE_ORIGIN)} && focus?.tool === "add_to_cart" && target ? {
          focus, text: (target.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240), hash: location.hash,
        } : null;
      })()`), 15000, 100);
      check("first use activity: Settings filters to the exact site and highlights the called tool",
        firstActivityFocused?.focus?.origin === PAGE_ORIGIN && firstActivityFocused?.focus?.tool === "add_to_cart" && firstActivityFocused?.hash === "#agents",
        firstActivityFocused);
      const clearedFirstActivity = await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector(".audit-clear")`);
      check("first use activity: Show all activity clears the one-shot filter", clearedFirstActivity);
      await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?._activityFocus === null ? true : null`), 5000, 50);
      await front(hubT.targetId, ns);
      const finalText = await c.until(() => c.evalIn(ns, `(() => {
        const bubbles = [...document.querySelectorAll('message-bubble')].filter((b) => b.getAttribute("role") !== "tool" && b.getAttribute("role") !== "user");
        // The visible message text only (the shadow root's <style> is not prose).
        const hit = bubbles.map((b) => (b.shadowRoot?.querySelector(".msg")?.textContent ?? b.textContent ?? "")).find((t) => t.includes("[demo model] Site tool add_to_cart"));
        return hit ? hit.replace(/\\s+/g, " ").trim().slice(0, 400) : null;
      })()`), 20000);
      check("showcase: the run's final answer reports the site's result (cart total $4.50)", /Site tool add_to_cart succeeded\. Cart total: \$4\.50/.test(String(finalText)), finalText);
      const visibleLeaks = ["selectionRef", "search_tools", "execute_tool", "catalogGeneration"].filter((s) => String(toolCard?.text ?? "").includes(s));
      check("showcase: the tool card shows the site's tool, never the protocol plumbing", visibleLeaks.length === 0, visibleLeaks);
      await front(shopT.targetId, shop);
      await shotOf(shop, "showcase-cart-changed.png");
      await front(hubT.targetId, ns);
      await shotOf(ns, "showcase-tool-card.png");
      console.log(`showcase timing (ms after hub load): tab opened +${tOpen - t0}; check chip +${tOpen - t0 + checkMs} (${checkMs} after the tab); grant +${tGrant - t0}; offer chip +${tGrant - t0 + chipMs} (${chipMs} after the grant); page changed +${tChanged - t0}`);

      const approvalCardCount = () => c.evalIn(ns, `document.querySelectorAll("approval-card").length`);
      const activeComposerExpr = `(!document.querySelector("#thread-view")?.hidden ? document.querySelector("agent-composer#thread-composer") : document.querySelector("agent-composer#composer"))`;
      const waitForComposer = () => c.until(() => c.evalIn(ns, `(() => {
        const host = ${activeComposerExpr};
        const input = host?.querySelector("#task-input");
        const running = !document.querySelector("#thread-view")?.hidden && !document.querySelector("#run-control-bar")?.hidden;
        return input && !input.disabled && !running ? true : null;
      })()`), 30000, 100);
      const ensureSiteSelection = async () => {
        const current = await c.evalIn(ns, `(() => { const a = ${activeComposerExpr}?.selectedAgent; return a?.kind === "site" && a?.id === ${JSON.stringify(PAGE_ORIGIN)}; })()`);
        if (current === true) return true;
        await c.clickExpr(ns, `${activeComposerExpr}?.querySelector("#task-input")`);
        await c.send("Input.insertText", { text: "@127" }, ns);
        const offered = await c.until(() => c.evalIn(ns, `[...(${activeComposerExpr}?.querySelectorAll('.popup .item[role="option"]') ?? [])].some((row) => (row.textContent || "").includes("127.0.0.1:8934")) ? true : null`), 5000, 100);
        if (!offered) return false;
        return await c.clickExpr(ns, `[...(${activeComposerExpr}?.querySelectorAll('.popup .item[role="option"]') ?? [])].find((row) => (row.textContent || "").includes("127.0.0.1:8934"))`);
      };
      const runSiteTask = async (text: string) => {
        if (!(await waitForComposer())) return false;
        if (!(await ensureSiteSelection())) return false;
        await c.clickExpr(ns, `${activeComposerExpr}?.querySelector("#task-input")`);
        await c.send("Input.insertText", { text }, ns);
        const enabled = await c.until(() => c.evalIn(ns, `(() => { const button = ${activeComposerExpr}?.querySelector("#run-task"); return button && !button.disabled ? true : null; })()`), 3000, 50);
        return enabled === true && await c.clickExpr(ns, `${activeComposerExpr}?.querySelector("#run-task")`);
      };

      // Persistent Allow: a second GENUINE model run of the same exact tool
      // must execute silently. A card would remain in the transcript, so the
      // before/after count is a durable no-card assertion rather than a poll
      // that could miss a short-lived element.
      const cardsBeforeReuse = await approvalCardCount();
      const reuseRan = await runSiteTask(`add another product @demo-site-tool add_to_cart {"sku":"gizmo"}`);
      check("silent reuse: submitted a second genuine model run", reuseRan);
      const reusedCart = await c.until(() => c.evalIn(shop, `(() => {
        const count = document.getElementById("cart-count")?.textContent;
        const total = document.getElementById("cart-total")?.textContent;
        return count === "2" && total === "$11.75" ? { count, total } : null;
      })()`), 30000, 100);
      await waitForComposer();
      const cardsAfterReuse = await approvalCardCount();
      check("silent reuse: persisted Allow executes without another card",
        !!reusedCart && cardsAfterReuse === cardsBeforeReuse, { reusedCart, cardsBeforeReuse, cardsAfterReuse });
      const silentActivity = await c.evalIn(ns, `(() => {
        const cards = [...document.querySelectorAll('message-bubble[role="tool"]')].filter((bubble) => bubble.getAttribute("tool-name") === "add_to_cart");
        const card = cards.at(-1);
        let activity = null;
        try { activity = JSON.parse(card?.getAttribute("site-activity") || "null"); } catch {}
        return card?.shadowRoot?.querySelector(".site-activity") ? { count: cards.length, activity } : null;
      })()`);
      check("silent reuse: the cached-Allow tool bubble also carries the exact owner-only activity control",
        silentActivity?.activity?.origin === PAGE_ORIGIN && silentActivity?.activity?.tool === "add_to_cart" && Object.keys(silentActivity.activity).length === 2,
        silentActivity);
      const silentExpanded = await c.clickExpr(ns, `(() => { const cards = [...document.querySelectorAll('message-bubble[role="tool"]')].filter((bubble) => bubble.getAttribute("tool-name") === "add_to_cart"); return cards.at(-1)?.shadowRoot?.querySelector("details.tool > summary"); })()`);
      check("silent reuse activity: expanded the cached-Allow tool bubble", silentExpanded);
      const silentOpened = await c.clickExpr(ns, `(() => { const cards = [...document.querySelectorAll('message-bubble[role="tool"]')].filter((bubble) => bubble.getAttribute("tool-name") === "add_to_cart"); return cards.at(-1)?.shadowRoot?.querySelector(".site-activity"); })()`);
      check("silent reuse activity: clicked View site activity", silentOpened);
      const silentFocused = await c.until(() => c.evalIn(consentSettings, `(() => {
        const focus = document.getElementById("webmcp-consent-manager")?._activityFocus;
        return focus?.origin === ${JSON.stringify(PAGE_ORIGIN)} && focus?.tool === "add_to_cart" ? focus : null;
      })()`), 10000, 100);
      check("silent reuse activity: the existing Settings document consumes the fresh one-shot hint", silentFocused?.origin === PAGE_ORIGIN && silentFocused?.tool === "add_to_cart", silentFocused);
      await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector(".audit-clear")`);
      await front(hubT.targetId, ns);

      // A different exact tool asks independently. Deny is durable and sticky:
      // the retry fails without nagging and cannot mutate the page.
      const cardsBeforeDeny = await approvalCardCount();
      const denyRan = await runSiteTask(`try removing the widget @demo-site-tool remove_from_cart {"sku":"widget-basic"}`);
      check("sticky Deny: submitted the first genuine remove_from_cart run", denyRan);
      const denyCard = await c.until(() => c.evalIn(ns, `(() => {
        const card = [...document.querySelectorAll("approval-card")].find((candidate) => candidate.getAttribute("title")?.includes("remove_from_cart") && candidate.getAttribute("state") !== "denied");
        return card ? { title: card.getAttribute("title"), deny: card.shadowRoot?.querySelector(".deny")?.textContent?.trim() } : null;
      })()`), 15000, 100);
      check("sticky Deny: remove_from_cart gets its own exact first-use card", denyCard?.title === `Use ${PAGE_ORIGIN}’s remove_from_cart?`, denyCard);
      const denyClicked = await c.clickExpr(ns, `[...document.querySelectorAll("approval-card")].find((card) => card.getAttribute("title")?.includes("remove_from_cart") && card.getAttribute("state") !== "denied")?.shadowRoot?.querySelector(".deny")`);
      check("sticky Deny: clicked Deny in the originating conversation", denyClicked);
      await waitForComposer();
      const deniedCart = await c.evalIn(shop, `({ count: document.getElementById("cart-count")?.textContent, total: document.getElementById("cart-total")?.textContent })`);
      check("sticky Deny: the denied call did not mutate the cart", deniedCart?.count === "2" && deniedCart?.total === "$11.75", deniedCart);
      const cardsAfterDeny = await approvalCardCount();
      const retryDeniedRan = await runSiteTask(`retry removing the widget @demo-site-tool remove_from_cart {"sku":"widget-basic"}`);
      check("sticky Deny: submitted the denied tool again", retryDeniedRan);
      await waitForComposer();
      const cardsAfterDeniedRetry = await approvalCardCount();
      const deniedRetryCart = await c.evalIn(shop, `document.getElementById("cart-count")?.textContent`);
      check("sticky Deny: retry stays blocked without another card",
        cardsAfterDeniedRetry === cardsAfterDeny && deniedRetryCart === "2",
        { cardsBeforeDeny, cardsAfterDeny, cardsAfterDeniedRetry, deniedRetryCart });

      // Settings is the only place that can rearm sticky Deny. Drive the real
      // nested native button and then prove the next model call runs silently.
      await front(consentSettingsT.targetId, consentSettings);
      const managerReady = await c.until(() => c.evalIn(consentSettings, `(() => {
        const manager = document.getElementById("webmcp-consent-manager");
        return manager?.data?.loading === false && manager?.data?.sites?.some((site) => site.origin === ${JSON.stringify(PAGE_ORIGIN)}) ? true : null;
      })()`), 15000, 100);
      check("Settings: the owner-local consent manager loaded the enrolled site", managerReady === true);
      // The direct-activity journey opened Settings before this later Deny.
      // Refresh its owner snapshot rather than mistaking the intentionally
      // non-live historical view for the current sticky decision.
      await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector(".refresh")`);
      await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.sites?.flatMap((site) => site.tools || []).find((tool) => tool.name === "remove_from_cart")?.state === "denied" ? true : null`), 10000, 100);

      // Visual/accessibility matrix on the REAL Settings document. Capture
      // explicit light, dark, forced-colors and narrow states and assert there
      // is no horizontal overflow at phone width.
      await front(consentSettingsT.targetId, consentSettings);
      await c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.scrollIntoView({ block: "start" }); true`);
      await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, consentSettings);
      await c.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: "light" }] }, consentSettings);
      await shotOf(consentSettings, "showcase-consent-settings-light.png");
      await c.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: "dark" }] }, consentSettings);
      await shotOf(consentSettings, "showcase-consent-settings-dark.png");
      await c.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "forced-colors", value: "active" }, { name: "prefers-color-scheme", value: "light" }] }, consentSettings);
      await shotOf(consentSettings, "showcase-consent-settings-forced-colors.png");
      await c.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: "dark" }] }, consentSettings);
      await c.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 900, deviceScaleFactor: 1, mobile: false }, consentSettings);
      await c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.scrollIntoView({ block: "start" }); true`);
      const narrowLayout = await c.evalIn(consentSettings, `({ innerWidth, scrollWidth: document.documentElement.scrollWidth, managerWidth: Math.round(document.getElementById("webmcp-consent-manager")?.getBoundingClientRect().width ?? 0) })`);
      check("Settings accessibility: narrow layout fits without horizontal overflow",
        narrowLayout?.innerWidth === 480 && narrowLayout?.scrollWidth <= narrowLayout?.innerWidth && narrowLayout?.managerWidth > 0, narrowLayout);
      await shotOf(consentSettings, "showcase-consent-settings-narrow.png");
      await c.send("Emulation.clearDeviceMetricsOverride", {}, consentSettings);
      await c.send("Emulation.setEmulatedMedia", { media: "", features: [] }, consentSettings);
      const toolButtonExpr = (name: string, label: string) => `(() => {
        const manager = document.getElementById("webmcp-consent-manager");
        const card = [...(manager?.shadowRoot?.querySelectorAll("tool-directory-card") ?? [])].find((candidate) => candidate.tool?.name === ${JSON.stringify(name)});
        const button = card?.shadowRoot?.querySelector(".approve");
        return button && button.textContent.trim() === ${JSON.stringify(label)} ? button : null;
      })()`;
      await front(consentSettingsT.targetId, consentSettings);
      const allowDenied = await c.clickExpr(consentSettings, toolButtonExpr("remove_from_cart", "Allow / try again"));
      check("Settings: clicked Allow / try again for the exact denied tool", allowDenied);
      const removeAllowed = await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.sites?.flatMap((site) => site.tools || []).find((tool) => tool.name === "remove_from_cart")?.state === "allowed" ? true : null`), 10000, 100);
      check("Settings: sticky Deny became exact-tool Allow", removeAllowed === true);
      await front(hubT.targetId, ns);
      const cardsBeforeSettingsReuse = await approvalCardCount();
      const removeRan = await runSiteTask(`remove the widget now @demo-site-tool remove_from_cart {"sku":"widget-basic"}`);
      check("Settings rearm: submitted remove_from_cart after Allow / try again", removeRan);
      const removedWidget = await c.until(() => c.evalIn(shop, `document.getElementById("cart-count")?.textContent === "1" ? true : null`), 30000, 100);
      await waitForComposer();
      check("Settings rearm: the model call runs silently and removes the widget",
        removeRan === true && removedWidget === true && await approvalCardCount() === cardsBeforeSettingsReuse);

      // Per-tool Disable returns only that tool to ASK. Its next model use gets
      // a fresh card and can be Allowed again without touching add_to_cart.
      await front(consentSettingsT.targetId, consentSettings);
      const disableRemove = await c.clickExpr(consentSettings, toolButtonExpr("remove_from_cart", "Disable automatic use"));
      check("Settings: clicked per-tool Disable automatic use", disableRemove);
      const removeAsk = await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.sites?.flatMap((site) => site.tools || []).find((tool) => tool.name === "remove_from_cart")?.state === "ask" ? true : null`), 10000, 100);
      check("Settings: per-tool reset rearms ASK", removeAsk === true);
      await front(hubT.targetId, ns);
      const reaskRan = await runSiteTask(`remove the gizmo @demo-site-tool remove_from_cart {"sku":"gizmo"}`);
      check("per-tool reset: submitted the rearmed tool", reaskRan);
      const reaskCard = await c.until(() => c.evalIn(ns, `[...document.querySelectorAll("approval-card")].some((card) => card.getAttribute("title")?.includes("remove_from_cart") && !["granted", "denied", "expired", "cancelled"].includes(card.getAttribute("state"))) ? true : null`), 15000, 100);
      check("per-tool reset: next model use asks again", reaskCard === true);
      const reaskFocus = await c.until(() => c.evalIn(ns, `[...document.querySelectorAll("approval-card")].some((card) => card.getAttribute("title")?.includes("remove_from_cart") && card.shadowRoot?.activeElement?.classList?.contains("approve")) ? true : null`), 3000, 50);
      check("per-tool reset: keyboard focus moved to the rearmed Allow automatically control", reaskFocus === true);
      if (reaskFocus) {
        await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, ns);
        await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, ns);
      }
      const reallowRemove = await c.until(() => c.evalIn(ns, `[...document.querySelectorAll("approval-card")].some((card) => card.getAttribute("title")?.includes("remove_from_cart") && card.getAttribute("state") === "granted") ? true : null`), 10000, 100);
      check("per-tool reset: activated Allow automatically with the keyboard", reallowRemove === true);
      const emptied = await c.until(() => c.evalIn(shop, `document.getElementById("cart-count")?.textContent === "0" ? true : null`), 30000, 100);
      await waitForComposer();
      check("per-tool reset: the resumed call removes the gizmo", emptied === true);

      // Produce enough redacted invocation rows to force immutable-sequence
      // pagination, then drive the real Older button and site-wide reset.
      const auditSeedResults = [];
      for (const sku of ["widget-basic", "widget-basic", "widget-basic", "widget-basic", "widget-basic", "widget-basic"]) {
        auditSeedResults.push(await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(PAGE_ORIGIN)}, name: "add_to_cart", args: { sku: ${JSON.stringify(sku)} } })`));
      }
      check("Settings audit: six real invocations seeded more than one page of records",
        auditSeedResults.length === 6 && auditSeedResults.every((result) => result?.ok === true), auditSeedResults);
      await front(consentSettingsT.targetId, consentSettings);
      const refreshedAudit = await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector(".refresh")`);
      check("Settings audit: clicked Refresh", refreshedAudit);
      const olderCursor = await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.audit?.olderCursor ?? null`), 10000, 100);
      check("Settings audit: the 20-row page exposes an immutable Older cursor", typeof olderCursor === "string", olderCursor);
      const newestAuditSeq = await c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.audit?.records?.[0]?.seq ?? null`);
      const olderClicked = await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector('[data-audit-cursor^="older:"]')`);
      check("Settings audit: clicked Older through the native pager", olderClicked);
      const olderAuditSeq = await c.until(() => c.evalIn(consentSettings, `(() => { const seq = document.getElementById("webmcp-consent-manager")?.data?.audit?.records?.[0]?.seq; return Number.isSafeInteger(seq) && seq < ${Number(newestAuditSeq)} ? seq : null; })()`), 10000, 100);
      check("Settings audit: Older shows a distinct earlier immutable sequence", Number.isSafeInteger(olderAuditSeq), { newestAuditSeq, olderAuditSeq });
      await shotOf(consentSettings, "showcase-consent-settings-audit.png");
      const resetAll = await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector('[data-reset="all"]')`);
      check("Settings: clicked site-wide Reset decisions", resetAll);
      const allAsk = await c.until(() => c.evalIn(consentSettings, `(() => {
        const site = document.getElementById("webmcp-consent-manager")?.data?.sites?.find((entry) => entry.origin === ${JSON.stringify(PAGE_ORIGIN)});
        return site?.tools?.length && site.tools.every((tool) => tool.state === "ask") ? true : null;
      })()`), 10000, 100);
      check("Settings: site-wide reset rearms every exact tool to ASK", allAsk === true);

      // A second site-wide reset while every materialized decision is ASK is
      // still an authority boundary. Start a genuine first-use call, reset the
      // site from Settings, and prove the old card cannot save Allow or reach
      // the page; only a fresh run may ask again.
      await front(hubT.targetId, ns);
      const resetFenceCartBefore = await c.evalIn(shop, `document.getElementById("cart-count")?.textContent`);
      const resetFenceCardsBefore = await approvalCardCount();
      const resetFenceRan = await runSiteTask(`reset fence probe @demo-site-tool add_to_cart {"sku":"widget-basic"}`);
      check("site reset ASK fence: submitted a genuine first-use call", resetFenceRan);
      const resetFencePending = await c.until(() => c.evalIn(ns, `(() => {
        const cards = [...document.querySelectorAll("approval-card")].filter((card) => card.getAttribute("title")?.includes("add_to_cart"));
        const card = cards.at(-1);
        const state = card?.getAttribute("state");
        return card && !["granted", "denied", "expired", "cancelled"].includes(state) ? { count: cards.length, state } : null;
      })()`), 15000, 100);
      check("site reset ASK fence: the old run is waiting on its first-use card",
        resetFencePending?.count > 0 && await approvalCardCount() === resetFenceCardsBefore + 1, resetFencePending);
      const resetFencePreDispatch = await c.evalIn(shop, `document.getElementById("cart-count")?.textContent`);
      check("site reset ASK fence: no page side effect crossed before reset", resetFencePreDispatch === resetFenceCartBefore,
        { resetFenceCartBefore, resetFencePreDispatch });
      await front(consentSettingsT.targetId, consentSettings);
      const resetWhileAsk = await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector('[data-reset="all"]')`);
      check("site reset ASK fence: clicked Reset decisions while every stored decision was ASK", resetWhileAsk);
      await front(hubT.targetId, ns);
      const resetFenceCancelled = await c.until(() => c.evalIn(ns, `(() => {
        const cards = [...document.querySelectorAll("approval-card")].filter((card) => card.getAttribute("title")?.includes("add_to_cart"));
        const card = cards.at(-1);
        return card?.getAttribute("state") === "cancelled"
          ? { state: "cancelled", allowPresent: !!card.shadowRoot?.querySelector(".approve") }
          : null;
      })()`), 15000, 100);
      check("site reset ASK fence: reset cancels the old first-use card", resetFenceCancelled?.state === "cancelled", resetFenceCancelled);
      const staleResetAllowClicked = await c.clickExpr(ns, `(() => {
        const cards = [...document.querySelectorAll("approval-card")].filter((card) => card.getAttribute("title")?.includes("add_to_cart"));
        return cards.at(-1)?.shadowRoot?.querySelector(".approve");
      })()`);
      check("site reset ASK fence: the cancelled card cannot save a late Allow", staleResetAllowClicked === false,
        { staleResetAllowClicked, resetFenceCancelled });
      await waitForComposer();
      const resetFenceCartAfter = await c.evalIn(shop, `document.getElementById("cart-count")?.textContent`);
      check("site reset ASK fence: the cancelled call never dispatches", resetFenceCartAfter === resetFenceCartBefore,
        { resetFenceCartBefore, resetFenceCartAfter });
      const resetFenceFreshRan = await runSiteTask(`fresh reset fence probe @demo-site-tool add_to_cart {"sku":"widget-basic"}`);
      check("site reset ASK fence: submitted a fresh use after reset", resetFenceFreshRan);
      const resetFenceFreshCard = await c.until(() => c.evalIn(ns, `(() => {
        const cards = [...document.querySelectorAll("approval-card")].filter((card) => card.getAttribute("title")?.includes("add_to_cart"));
        const card = cards.at(-1);
        const state = card?.getAttribute("state");
        return cards.length > ${Number(resetFencePending?.count ?? 0)} && card && !["granted", "denied", "expired", "cancelled"].includes(state)
          ? { count: cards.length, state }
          : null;
      })()`), 15000, 100);
      check("site reset ASK fence: fresh use asks again on a new card", !!resetFenceFreshCard, resetFenceFreshCard);
      const resetFenceFreshDenied = await c.clickExpr(ns, `(() => {
        const cards = [...document.querySelectorAll("approval-card")].filter((card) => card.getAttribute("title")?.includes("add_to_cart"));
        return cards.at(-1)?.shadowRoot?.querySelector(".deny");
      })()`);
      check("site reset ASK fence: denied the fresh card to settle the proof run", resetFenceFreshDenied);
      await waitForComposer();
      const resetFenceFinalCart = await c.evalIn(shop, `document.getElementById("cart-count")?.textContent`);
      check("site reset ASK fence: neither the stale nor denied fresh card mutated the page", resetFenceFinalCart === resetFenceCartBefore,
        { resetFenceCartBefore, resetFenceFinalCart });
      await front(consentSettingsT.targetId, consentSettings);
      await c.clickExpr(consentSettings, `document.getElementById("webmcp-consent-manager")?.shadowRoot?.querySelector(".refresh")`);
      await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.sites?.flatMap((site) => site.tools || []).find((tool) => tool.name === "add_to_cart")?.state === "denied" ? true : null`), 10000, 100);

      // In-flight revocation/result suppression. Re-allow add_to_cart from
      // Settings, replace only its page implementation with a same-descriptor
      // delayed result, start the production route, then revoke while pending.
      const allowAdd = await c.clickExpr(consentSettings, toolButtonExpr("add_to_cart", "Allow / try again"));
      check("in-flight revocation: re-allowed add_to_cart in Settings", allowAdd);
      const addAllowed = await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.sites?.flatMap((site) => site.tools || []).find((tool) => tool.name === "add_to_cart")?.state === "allowed" ? true : null`), 10000, 100);
      check("in-flight revocation: exact Allow persisted", addAllowed === true);
      await c.evalIn(shop, `document.modelContext.registerTool({
        name: "add_to_cart",
        description: "Add a product to the shopper's cart by sku (optional quantity); returns the updated cart and total",
        inputSchema: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["sku"] },
        execute: async () => {
          window.__revocationPageStarted = (window.__revocationPageStarted || 0) + 1;
          await new Promise((resolve) => setTimeout(resolve, 2200));
          window.__revocationPageSettled = (window.__revocationPageSettled || 0) + 1;
          return { ok: true, privateResult: "must-not-reach-extension-caller" };
        },
      }).then(() => true)`);
      await front(hubT.targetId, ns);
      const revocationStarted = await c.evalIn(ns, `(() => {
        const started = performance.now();
        globalThis.__revocationResult = null;
        chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(PAGE_ORIGIN)}, name: "add_to_cart", args: { sku: "widget-basic" } })
          .then((result) => { globalThis.__revocationResult = { result, elapsed: performance.now() - started }; });
        return true;
      })()`);
      check("in-flight revocation: production invocation started", revocationStarted === true);
      const pageCallStarted = await c.until(() => c.evalIn(shop, `(window.__revocationPageStarted ?? 0) === 1 ? true : null`), 5000, 25);
      check("in-flight revocation: the page handler is genuinely pending before revocation", pageCallStarted === true);
      await front(consentSettingsT.targetId, consentSettings);
      const revokePending = await c.clickExpr(consentSettings, toolButtonExpr("add_to_cart", "Disable automatic use"));
      check("in-flight revocation: clicked Disable automatic use while the page promise was pending", revokePending);
      const revokedResult = await c.until(() => c.evalIn(ns, `globalThis.__revocationResult`), 5000, 50);
      check("in-flight revocation: pending waiter rejects immediately and no page result reaches the caller",
        revokedResult?.elapsed < 1800 && revokedResult?.result?.ok === false &&
          !JSON.stringify(revokedResult?.result ?? {}).includes("must-not-reach-extension-caller"), revokedResult);
      await sleep(2600);
      const latePageSettle = await c.evalIn(shop, `window.__revocationPageSettled ?? 0`);
      const stillSuppressed = await c.evalIn(ns, `globalThis.__revocationResult`);
      check("in-flight revocation: cancelled page work or any later settlement remains suppressed",
        (latePageSettle === 0 || latePageSettle === 1) &&
          !JSON.stringify(stillSuppressed?.result ?? {}).includes("must-not-reach-extension-caller"),
        { latePageSettle, stillSuppressed });
      const allowTotal = await c.clickExpr(consentSettings, toolButtonExpr("cart_total", "Allow automatically"));
      check("restart setup: allowed cart_total from Settings", allowTotal);
      const totalAllowed = await c.until(() => c.evalIn(consentSettings, `document.getElementById("webmcp-consent-manager")?.data?.sites?.flatMap((site) => site.tools || []).find((tool) => tool.name === "cart_total")?.state === "allowed" ? true : null`), 10000, 100);
      check("restart setup: cart_total Allow persisted", totalAllowed === true);
      const expectedTotalAfterRestart = await c.evalIn(shop, `Number((document.getElementById("cart-total")?.textContent ?? "").replace("$", ""))`);
      check("restart setup: captured the page's exact pre-restart total", Number.isFinite(expectedTotalAfterRestart), expectedTotalAfterRestart);
      await shotOf(consentSettings, "showcase-consent-settings-final.png");
      await c.send("Target.closeTarget", { targetId: consentSettingsT.targetId }).catch(() => {});
      await front(hubT.targetId, ns);

      // The same path after a SERVICE-WORKER RESTART: the enrollment and the
      // detection registry are durable, so the origin is not offered again
      // and its tools still run without re-enrollment.
      // Mark THIS worker's execution context; a restarted worker has no mark.
      await c.evalIn(sws, `globalThis.__showcaseWorkerMark = "before-restart"; true`);
      const closed = await c.send("Target.closeTarget", { targetId: sw.targetId }).catch(() => null);
      check("showcase: service worker target closed for the restart", closed?.success === true, closed);
      await sleep(500);
      const woke = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
      const sw2 = await waitForServiceWorker(rawSend, { timeoutMs: 15000 });
      const sws2 = sw2 ? await c.attach(sw2.targetId).catch(() => null) : null;
      const mark = sws2 ? await c.evalIn(sws2, `globalThis.__showcaseWorkerMark ?? null`) : "no-worker";
      check("showcase: the service worker restarted (a fresh execution context) and answered", !!sw2 && mark === null && Array.isArray(woke) && woke.includes(PAGE_ORIGIN), { sw2: sw2?.targetId, mark, woke });
      const offersAfter = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.tool-offers" })`);
      const shopOffer = Array.isArray(offersAfter?.offers) ? offersAfter.offers.find((o: any) => o.origin === PAGE_ORIGIN) : null;
      check("showcase: after the restart the enrolled origin is reported enrolled — never offered as new", shopOffer?.enrolled === true && shopOffer?.toolCount === 5, shopOffer);
      const totalAfter = await c.until(async () => {
        const r = await c.evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(PAGE_ORIGIN)}, name: "cart_total", args: {} })`);
        return r?.ok === true ? r : null;
      }, 15000);
      check("showcase: after the restart the exact cart_total Allow still runs without re-enrollment",
        totalAfter?.result?.total === expectedTotalAfterRestart, { expectedTotalAfterRestart, totalAfter });
      c.close();
    } finally {
      try { launched.proc.kill("SIGKILL"); } catch { /* already dead */ }
      try { await launched.proc.status; } catch { /* reaped */ }
      await Deno.remove(showcaseProfile, { recursive: true }).catch(() => {});
    }
  }

  const extDir = HEADED ? EXT : await makeVariant();
  const profile = durableDir(`cap-webmcp-acc-${Date.now()}`);
  await Deno.mkdir(profile, { recursive: true });
  const variant = await launch(profile, extDir);
  const proc = variant.proc;

  // Evidence may be kept outside the source tree so a post-commit run can
  // attest an EXACT clean commit without dirtying it. The in-repo directory is
  // retained as the convenient default for local/manual runs.

  try {
    const port = variant.port;
    const ws = new WebSocket(variant.wsUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
    let id = 0; const pend = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        return;
      }
      // CDP events: Debugger.scriptParsed + Runtime.consoleAPICalled.
      if (m.method === "Debugger.scriptParsed" && m.params?.url) {
        scriptParsedUrls.push(m.params.url);
      }
      if (m.method === "Runtime.consoleAPICalled") {
        const text = (m.params?.args ?? []).map((a: any) => a?.value ?? a?.description ?? "").join(" ");
        if (text.includes("[WebMCP")) consoleEvents.push(text.slice(0, 500));
      }
    };
    const send = (method: string, params: any, sessionId?: string) => new Promise<any>((res, rej) => {
      const mid = ++id; pend.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
    const evalIn = async (s: string, e: string) => {
      const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, s);
      if (r?.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
      return r?.result?.value;
    };
    const click = async (s: string, x: number, y: number) => {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, s);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, s);
    };
    const clickSelector = async (s: string, expr: string) => {
      const box = await evalIn(s, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
      if (!box || typeof box.x !== "number") return false;
      await click(s, box.x, box.y);
      return true;
    };
    const screenshot = async (s: string, name: string) => {
      const shot = await send("Page.captureScreenshot", { format: "png" }, s);
      const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      await Deno.writeFile(`${artifactDir}/${name}`, bytes);
      screenshots.push({ name, sha256: await sha256Hex(bytes), bytes: bytes.length });
    };
    // Poll helper: fn() until truthy or deadline.
    const until = async (fn: () => any, ms: number, step = 300) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const v = await fn();
        if (v) return v;
        await sleep(step);
      }
      return null;
    };

    // 1. The extension service worker.
    let sw: any = null;
    for (let i = 0; i < 60 && !sw; i++) {
      const ts = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      sw = ts.find((t: any) => t.type === "service_worker");
      if (!sw) await sleep(200);
    }
    check("extension loaded (service worker present)", !!sw);
    const extId = sw.url.split("/")[2];
    const sws = (await send("Target.attachToTarget", { targetId: sw.id, flatten: true })).sessionId;
    await send("Runtime.enable", {}, sws);

    // 2. Enable the diagnostics toggle via a REAL Settings click (gates the
    //    [WebMCP] console lifecycle events we assert below).
    const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#agents` });
    const opts = (await send("Target.attachToTarget", { targetId: optT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, opts);
    await sleep(1600);
    const diagClicked = await clickSelector(opts, `document.getElementById("webmcp-diagnostics")?.shadowRoot?.querySelector("button")`);
    check("Settings: clicked the Diagnostics toggle via a real click", diagClicked);
    await sleep(500);
    const diagOn = await evalIn(opts, `chrome.runtime.sendMessage({ type: "webmcp.diagnostics.get" }).then(r => r?.enabled === true)`);
    check("Settings: diagnostics gate enabled", diagOn === true, diagOn);
    await send("Target.closeTarget", { targetId: optT.targetId });

    // 3. The fixture page (Tab W) — attach BEFORE any injection so
    //    Debugger.scriptParsed + console events capture the scripts executing.
    const wT = await send("Target.createTarget", { url: `${PAGE_ORIGIN}/index.html` });
    const wsess = (await send("Target.attachToTarget", { targetId: wT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, wsess);
    await send("Debugger.enable", {}, wsess);
    await send("Page.enable", {}, wsess);
    await sleep(1500);
    check("fixture page loaded", await evalIn(wsess, `document.getElementById("msg")?.textContent`) === "fixture loaded");
    const baselineParsed = scriptParsedUrls.length;

    // 4. The hub (Tab N) — the REAL discovery UI.
    const nT = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
    const ns = (await send("Target.attachToTarget", { targetId: nT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ns);
    await send("Page.enable", {}, ns);
    await sleep(1600);
    await send("Target.activateTarget", { targetId: nT.targetId });

    // 5. Click "Discover this page" (real click). Headed mode runs the SHIPPED
    //    manifest on a fresh profile: the gesture issues the JIT scripting
    //    request itself, which settles granted WITHOUT any prompt (scripting
    //    is warningless once <all_urls> is install-granted — probed
    //    2026-08-30), and the already-open fixture tab's detector is re-armed
    //    via the SW's permissions.onAdded nudge. No manual step remains.
    const discoverClicked = await clickSelector(ns, `document.getElementById("discover-page")`);
    check("hub: clicked Discover this page via a real click", discoverClicked);
    if (HEADED) {
      const jitGranted = await until(
        () => evalIn(sws, `chrome.permissions.contains({ permissions: ["scripting"] })`),
        15000,
      );
      check("hub: the discover gesture settled the JIT scripting grant silently (no prompt)", jitGranted === true);
    }
    // The tab picker must appear listing the fixture tab (exact tab identity).
    const pickerHasFixture = await until(() => evalIn(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      if (!dlg) return null;
      const rows = [...dlg.querySelectorAll("capability-row")];
      const row = rows.find((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)});
      return row ? true : null;
    })()`), HEADED ? 20000 : 8000);
    check("hub: the tab picker lists the fixture tab (explicit tab identity)", pickerHasFixture === true);
    await screenshot(ns, "webmcp-acceptance-tab-picker.png");

    // 6. Pick the fixture tab (real click on the row's action). Host access is
    //    permanently install-granted; only the scripting capability is requested.
    const permanentHostAccess = await evalIn(sws, `Promise.all([
      chrome.runtime.getManifest().host_permissions?.includes("<all_urls>") === true,
      chrome.permissions.contains({ origins: ["${PAGE_ORIGIN}/*"] }),
    ]).then(([declared, granted]) => declared && granted)`);
    check("host access: <all_urls> is install-granted and covers the fixture page", permanentHostAccess === true);
    const rowClicked = await clickSelector(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      const rows = [...dlg.querySelectorAll("capability-row")];
      const row = rows.find((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)});
      return row?.shadowRoot?.querySelector("button.run") ?? null;
    })()`);
    check("hub: picked the fixture tab in the picker via a real click", rowClicked);
    const scriptingGranted = await until(
      () => evalIn(sws, `chrome.permissions.contains({ permissions: ["scripting"] })`),
      8000,
    );
    check("picker: scripting permission granted from the real click", scriptingGranted === true);

    // 7. Enrollment + injection of the EXACT picked tab.
    const enrolled = await until(async () => {
      const list = await evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
      return Array.isArray(list) && list.includes(PAGE_ORIGIN) ? list : null;
    }, 15000);
    check("the fixture origin is enrolled (real enroll-origin route)", !!enrolled, enrolled);
    const status = await until(async () => {
      const s = await evalIn(ns, `chrome.runtime.sendMessage({ type: "webmcp.status" })`);
      return s?.status?.origin === PAGE_ORIGIN && s.status.scriptStatus === "injected" ? s.status : null;
    }, 10000);
    check("SW-attested status: scripts injected (not merely 'served')", !!status, status);
    const fixtureTabId = await evalIn(sws, `chrome.tabs.query({}).then(ts => ts.find(t => t.url && t.url.startsWith(${JSON.stringify(PAGE_ORIGIN)}))?.id ?? null)`);
    check("the EXACT picked tab was injected (injection.ready contains its tab id)",
      Array.isArray(status?.injection?.ready) && status.injection.ready.includes(fixtureTabId),
      { ready: status?.injection?.ready, fixtureTabId });

    // 8. CDP scriptParsed: BOTH packaged scripts executed in Tab W (no reload).
    const parsed = await until(() => {
      const main = scriptParsedUrls.some((u) => u === `chrome-extension://${extId}/content/main-world.js`);
      const bridge = scriptParsedUrls.some((u) => u === `chrome-extension://${extId}/content/content-script.js`);
      return main && bridge ? true : null;
    }, 10000);
    check("CDP scriptParsed: content/main-world.js executed in the picked tab", parsed === true || scriptParsedUrls.some((u) => u.endsWith("/content/main-world.js")), scriptParsedUrls.filter((u) => u.includes("content/")));
    check("CDP scriptParsed: content/content-script.js executed in the picked tab", parsed === true || scriptParsedUrls.some((u) => u.endsWith("/content/content-script.js")));
    check("the discovery scripts executed WITHOUT a reload (immediate injection)", scriptParsedUrls.length > baselineParsed);

    // 9. Console lifecycle events from BOTH worlds.
    const sawBridgeStart = await until(() => consoleEvents.some((e) => e.includes("[WebMCP:bridge]") && e.includes("start")) ? true : null, 8000);
    check("console: [WebMCP:bridge] start lifecycle event", sawBridgeStart === true, consoleEvents.slice(0, 4));
    const sawMainDiscover = await until(() => consoleEvents.some((e) => e.includes("[WebMCP:main]") && e.includes("discover")) ? true : null, 8000);
    check("console: [WebMCP:main] discover lifecycle event", sawMainDiscover === true, consoleEvents.slice(0, 6));

    // 10. Discovery landed via the real bridge → tools.upsert → directory.
    const toolNames = await until(async () => {
      const list = await evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.list", origin: ${JSON.stringify(PAGE_ORIGIN)} })`);
      const names = Array.isArray(list) ? list.map((t: any) => t.name) : [];
      return names.includes("shop.total") && names.includes("shop.catalog") && names.includes("greet") ? names : null;
    }, 12000);
    check("declared + inferred tools discovered through the production bridge", !!toolNames, toolNames);
    const withCoupon = await until(async () => {
      const list = await evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.list", origin: ${JSON.stringify(PAGE_ORIGIN)} })`);
      const names = Array.isArray(list) ? list.map((t: any) => t.name) : [];
      return names.includes("shop.coupon") ? names : null;
    }, 12000);
    check("async-registered tool picked up by the re-poll (shop.coupon)", !!withCoupon, withCoupon);

    // Open a SECOND same-origin document after enrollment. Dynamic content
    // scripts run there too, but the snapshot gate must refuse to bind it: only
    // the picker-approved tab/document may report or receive production calls.
    const decoyT = await send("Target.createTarget", { url: `${PAGE_ORIGIN}/index.html?decoy=1` });
    const decoySession = (await send("Target.attachToTarget", { targetId: decoyT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, decoySession);
    await send("Page.enable", {}, decoySession);
    await until(() => evalIn(decoySession, `document.readyState === "complete" ? true : null`), 8000);
    await evalIn(decoySession, `document.title = "Decoy same-origin tab"`);

    // 11. PRODUCTION invocation: this lower-level bridge section deliberately
    //     seeds exact consent from an attached Settings document. The showcase
    //     above proves the genuine model/card/click path; these calls isolate
    //     directory/source, generation and exact-tab/document fencing.
    const seedExactConsent = async (names: string[]) => {
      const target = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#agents` });
      const settings = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
      await send("Runtime.enable", {}, settings);
      await until(() => evalIn(settings, `document.getElementById("webmcp-consent-manager")?.data?.loading === false ? true : null`), 10000);
      const results = [];
      for (const name of names) {
        results.push(await evalIn(settings, `chrome.runtime.sendMessage({ type: "webmcp.consent.tool.set", origin: ${JSON.stringify(PAGE_ORIGIN)}, name: ${JSON.stringify(name)}, state: "allowed" })`));
      }
      await send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
      return results;
    };
    const seeded = await seedExactConsent(["greet", "shop.total"]);
    check("bridge setup: attached Settings document seeded exact greet + shop.total consent",
      seeded.length === 2 && seeded.every((result) => result?.ok === true), seeded);
    const gen = await evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.directory" }).then(d => d?.agents?.find(a => a.origin === ${JSON.stringify(PAGE_ORIGIN)})?.gen ?? null)`);
    check("the enrollment generation is readable (agent.directory.gen)", typeof gen === "number" && gen > 0, gen);
    const invoke = (name: string, args: any) =>
      evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(PAGE_ORIGIN)}, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} })`);
    const greetRes = await invoke("greet", { name: "paul" });
    check("production tools.invoke: directory → exact approved tab/document → MAIN returns the page function result", greetRes?.ok === true && greetRes?.result === "hello paul", greetRes);
    const sideEffect = await evalIn(wsess, `({ msg: document.getElementById("msg")?.textContent, calls: window.__greetCalls })`);
    const decoyEffect = await evalIn(decoySession, `({ msg: document.getElementById("msg")?.textContent, calls: window.__greetCalls })`);
    check("invoke: VISIBLE side effect occurs exactly once in the approved tab/document",
      sideEffect?.msg === "greeted paul (#1)" && sideEffect?.calls === 1, sideEffect);
    check("invoke: the second same-origin tab is NOT invoked", decoyEffect?.calls === 0, decoyEffect);
    await screenshot(wsess, "webmcp-acceptance-side-effect.png");

    // 12. The declared/global collision: the DIRECTORY-resolved source
    //     ("declared") must hit modelContext, never the colliding global.
    const totalRes = await invoke("shop.total", {});
    check("production tools.invoke: declared shop.total resolves via modelContext (42.5), never the colliding global (999)",
      totalRes?.ok === true && totalRes?.result?.total === 42.5, totalRes);

    // 12b. Production negatives: the directory + route reject what must be rejected.
    const unknownTool = await invoke("no.such.tool", {});
    check("production tools.invoke: an unknown tool is rejected at the directory", unknownTool?.ok === false, unknownTool);
    const unenrolled = await evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: "http://127.0.0.1:9999", name: "greet", args: {} })`);
    check("production tools.invoke: an unenrolled origin is rejected", unenrolled?.ok === false, unenrolled);

    // 13. Bridge-layer fencing negatives (the isolated relay itself, NOT the
    //     production route): a generationless / source-less invoke-tool
    //     message is rejected even when sent straight to the tab.
    const noGen = await evalIn(sws, `chrome.tabs.sendMessage(${fixtureTabId}, { type: "invoke-tool", name: "greet", args: {}, source: "inferred" }).then(r => r, e => ({ err: e.message }))`);
    check("bridge fencing: a generationless invoke is rejected at the relay", noGen?.ok === false, noGen);
    const noSource = await evalIn(sws, `chrome.tabs.sendMessage(${fixtureTabId}, { type: "invoke-tool", name: "greet", args: {}, gen: ${gen} }).then(r => r, e => ({ err: e.message }))`);
    check("bridge fencing: a source-less invoke is rejected at the relay", noSource?.ok === false, noSource);

    // 14. Re-enrollment singleton: Discover the same tab again → exactly ONE
    //     live bridge (one side effect per invoke).
    await clickSelector(ns, `document.getElementById("discover-page")`);
    await sleep(700);
    const reRow = await clickSelector(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      const rows = dlg ? [...dlg.querySelectorAll("capability-row")] : [];
      const row = rows.find((r) =>
        r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)} &&
        r.getAttribute("name") !== "Decoy same-origin tab"
      );
      return row?.shadowRoot?.querySelector("button.run") ?? null;
    })()`);
    check("re-enrollment: picked the same tab again", reRow);
    await sleep(500);
    const gen2 = await evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.directory" }).then(d => d?.agents?.find(a => a.origin === ${JSON.stringify(PAGE_ORIGIN)})?.gen ?? null)`);
    check("re-enrollment advanced the generation", typeof gen2 === "number" && gen2 > gen, { gen, gen2 });
    const reseeded = await seedExactConsent(["greet"]);
    check("re-enrollment: the new generation starts ASK and Settings explicitly re-allows greet", reseeded?.[0]?.ok === true, reseeded);
    // Enrollment completion precedes the page's asynchronous replacement
    // snapshot. Poll the PRODUCTION invocation until that exact document is
    // ready; failed pre-ready attempts are rejected before any page side effect.
    const greet2 = await until(async () => {
      const r = await invoke("greet", { name: "again" });
      return r?.ok === true ? r : null;
    }, 12000);
    const calls2 = await evalIn(wsess, `window.__greetCalls`);
    check("re-enrollment singleton: exactly ONE side effect per invoke (no duplicate listeners)",
      greet2?.ok === true && calls2 === 2, { greet2, calls2 });

    // 15. RELOAD: the dynamically-registered scripts re-inject, the bridge
    //     startup-syncs its generation (no re-enrollment), and invocation works.
    scriptParsedUrls.length = 0;
    consoleEvents.length = 0;
    await send("Page.reload", { ignoreCache: true }, wsess);
    const reparsed = await until(() => {
      const main = scriptParsedUrls.some((u) => u.endsWith("/content/main-world.js"));
      const bridge = scriptParsedUrls.some((u) => u.endsWith("/content/content-script.js"));
      return main && bridge ? true : null;
    }, 15000);
    check("reload: BOTH discovery scripts re-executed via the DYNAMIC registration (scriptParsed)", reparsed === true, scriptParsedUrls.slice(0, 6));
    const resynced = await until(() => consoleEvents.some((e) => e.includes("[WebMCP:bridge]") && e.includes("enrollment-sync")) ? true : null, 10000);
    check("reload: the fresh bridge startup-synced its enrollment generation (console lifecycle)", resynced === true, consoleEvents.slice(0, 6));
    const greet3 = await until(async () => {
      const r = await invoke("greet", { name: "reload" });
      return r?.ok === true ? r : null;
    }, 12000);
    const calls3 = await evalIn(wsess, `window.__greetCalls`);
    check("reload: invocation works WITHOUT re-enrollment (the startup-sync fix), one side effect",
      greet3?.result === "hello reload" && calls3 === 1, { greet3, calls3 });
    const msgAfterReload = await evalIn(wsess, `document.getElementById("msg")?.textContent`);
    check("reload: the side effect is visible after reload", msgAfterReload === "greeted reload (#1)", msgAfterReload);
    await screenshot(wsess, "webmcp-acceptance-after-reload.png");

    // 16. Cross-document navigation (same origin) — the bridge re-syncs again.
    await send("Page.navigate", { url: `${PAGE_ORIGIN}/index.html?nav=2` }, wsess);
    await sleep(2500);
    const greet4 = await until(async () => {
      const r = await invoke("greet", { name: "nav" });
      return r?.ok === true ? r : null;
    }, 12000);
    check("navigation: invocation works after a cross-document navigation (no re-enrollment)",
      greet4?.result === "hello nav", greet4);

    ws.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try { fixture.kill("SIGKILL"); } catch {}
    await Deno.remove(profile, { recursive: true }).catch(() => {});
    if (!HEADED) await Deno.remove(extDir, { recursive: true }).catch(() => {});
  }

  // The machine-verifiable manifest.
  const commit = new TextDecoder().decode(
    (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: ROOT, stdout: "piped" }).output()).stdout,
  ).trim();
  const dirty = new TextDecoder().decode(
    (await new Deno.Command("git", { args: ["status", "--porcelain"], cwd: ROOT, stdout: "piped" }).output()).stdout,
  ).trim();
  const manifest = {
    testedSourceCommit: commit,
    evidenceCommitNote: dirty
      ? "working-tree run; worktreeDirtyFiles lists every difference from testedSourceCommit"
      : "exact clean testedSourceCommit; evidence was written separately from source when WEBMCP_ARTIFACT_DIR was set",
    worktreeDirtyFiles: dirty ? dirty.split("\n").filter(Boolean) : [],
    runId: `webmcp-acceptance-${Date.now()}`,
    ts: new Date().toISOString(),
    mode: HEADED ? "headed-manual" : "automated-variant",
    permissionGrant: HEADED ? "jit-silent-no-prompt" : "test-manifest-pregranted (deep checks); shipped fresh-profile JIT (picker proof)",
    overallStatus: HEADED
      ? (fail === 0 ? "ATTESTED" : "FAILED")
      : "OPEN — the shipped-manifest fresh-profile picker path is attested headless; the deep discovery/injection/invocation path runs on the pregranted variant. Run with --headed to attest every step on shipped bytes.",
    variantNote: HEADED
      ? "the SHIPPED extension was driven"
      : "the loaded extension is byte-identical to the shipped one EXCEPT manifest.json pre-holds scripting+tabs; shipped <all_urls> host access is unchanged",
    passed: pass,
    failed: fail,
    checks,
    evidence: {
      scriptParsedUrls: scriptParsedUrls.slice(0, 40),
      consoleEvents: consoleEvents.slice(0, 40),
      screenshots,
    },
  };
  await Deno.writeTextFile(
    `${artifactDir}/webmcp-acceptance-manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`\nRESULT: ${pass} passed, ${fail} failed — status: ${manifest.overallStatus}`);
  if (fail > 0) Deno.exit(1);
}
await main();

// deno-fmt-ignore-file
// webmcp-acceptance.ts — the PRODUCTION-PATH WebMCP discovery acceptance
// journey (replaces the round-28-rejected scripts/webmcp-integration.ts, which
// bypassed the implementation under test: it Runtime.evaluate'd the MAIN-world
// source into the page, faked the bridge handshake, and called agent.create /
// tools.upsert directly from an extension page).
//
// This journey drives the REAL loaded-MV3 path end-to-end:
//   1. passive detection admits the WebMCP fixture before enrollment while a
//      concurrently-open plain http(s) page is absent from every picker;
//   2. the REAL discovery UI (hub "Discover this page" → the filtered tab picker
//      → the exact picked tab), clicked with real CDP Input events;
//   3. verification of the extension's install-granted scripting/tabs/host access;
//   3. dynamic registration + current-tab injection of BOTH packaged scripts;
//   4. CDP Debugger.scriptParsed evidence that chrome-extension://…/content/
//      main-world.js and …/content/content-script.js really executed in the
//      picked tab (never a fetch-200 "it serves" inference);
//   5. [WebMCP] console lifecycle events from both worlds;
//   6. discovery WITHOUT a reload (immediate injection), then AFTER a reload
//      (dynamic registration + the bridge startup enrollment sync) and after a
//      cross-document navigation;
//   7. PRODUCTION invocation: the extension-only `tools.invoke` route →
//      invokeSiteTool (directory + dispatch-source resolution, immutable
//      generation fencing, the exact approved-tab/document binding, pre/post
//      enrollment revalidation) → isolated → MAIN, with a VISIBLE page side
//      effect (DOM mutation + counter), the declared-vs-global collision
//      assertion, production negatives (unknown tool) and bridge-layer
//      fencing negatives (missing gen / source rejected at the relay);
//   8. re-enrollment singleton: repeated enrollment yields exactly ONE live
//      bridge (one side effect per invoke);
//   9. screenshots + a machine-verifiable manifest (test-artifacts/ by
//      default, or WEBMCP_ARTIFACT_DIR for exact-clean-commit external evidence).
//
// The shipped manifest grants scripting, tabs, and host access at install, so
// this headless journey loads the production extension unchanged. There is no
// test-only manifest variant and no permission-prompt shortcut.
import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const FIXTURE_PORT = 8934;
const PAGE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const PLAIN_ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function launchFixture() {
  return new Deno.Command("deno", { args: ["run", "-A", `${ROOT}fixtures/webmcp-server.ts`], stdout: "null", stderr: "null" }).spawn();
}


async function main() {
  // 0. Fresh build (the SW bundle must match the sources under test) + fixture.
  const build = new Deno.Command("node", { args: [`${ROOT}build.mjs`], stdout: "null", stderr: "null", cwd: ROOT }).spawn();
  const buildStatus = await build.status;
  check("build succeeded (dist matches sources)", buildStatus.success);
  const fixture = launchFixture();
  await sleep(800);

  const profile = `/tmp/cap-webmcp-acc-${Date.now()}`;
  await Deno.mkdir(profile, { recursive: true });
  const chromeArgs = [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "--headless=new", "about:blank",
  ];
  const { proc, wsUrl } = await launchChrome({ binary: CHROMIUM, args: chromeArgs });

  // Evidence collectors.
  const scriptParsedUrls: string[] = [];
  const consoleEvents: string[] = [];
  const screenshots: { name: string; sha256: string; bytes: number }[] = [];
  // Evidence may be kept outside the source tree so a post-commit run can
  // attest an EXACT clean commit without dirtying it. The in-repo directory is
  // retained as the convenient default for local/manual runs.
  const configuredArtifactDir = Deno.env.get("WEBMCP_ARTIFACT_DIR")?.trim();
  const artifactDir = (configuredArtifactDir || `${ROOT}test-artifacts`).replace(/\/$/, "");
  await Deno.mkdir(artifactDir, { recursive: true });

  try {
    const port = Number(new URL(wsUrl).port);
    const ws = new WebSocket(wsUrl);
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
    const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
    const opts = (await send("Target.attachToTarget", { targetId: optT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, opts);
    await sleep(1600);
    const diagClicked = await clickSelector(opts, `document.getElementById("webmcp-diagnostics")`);
    check("Settings: clicked the Diagnostics toggle via a real click", diagClicked);
    await sleep(500);
    const diagOn = await evalIn(opts, `chrome.runtime.sendMessage({ type: "webmcp.diagnostics.get" }).then(r => r?.enabled === true)`);
    check("Settings: diagnostics gate enabled", diagOn === true, diagOn);
    await send("Target.closeTarget", { targetId: optT.targetId });

    // 3. Open a plain http(s) page first. Passive detection must report zero,
    //    so its origin never enters the known-WebMCP picker registry.
    const plainT = await send("Target.createTarget", { url: `${PLAIN_ORIGIN}/plain.html` });
    const plainSession = (await send("Target.attachToTarget", { targetId: plainT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, plainSession);
    await until(() => evalIn(plainSession, `document.readyState === "complete" ? true : null`), 8000);

    // 4. The fixture page (Tab W) — passive detection runs before enrollment;
    //    attach before the later full-bridge injection evidence is collected.
    const wT = await send("Target.createTarget", { url: `${PAGE_ORIGIN}/index.html` });
    const wsess = (await send("Target.attachToTarget", { targetId: wT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, wsess);
    await send("Debugger.enable", {}, wsess);
    await send("Page.enable", {}, wsess);
    await sleep(1500);
    check("fixture page loaded", await evalIn(wsess, `document.getElementById("msg")?.textContent`) === "fixture loaded");
    const baselineParsed = scriptParsedUrls.length;

    // 5. The hub (Tab N) — the REAL discovery UI.
    const nT = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
    const ns = (await send("Target.attachToTarget", { targetId: nT.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ns);
    await send("Page.enable", {}, ns);
    await sleep(1600);
    await send("Target.activateTarget", { targetId: nT.targetId });

    // 6. Click "Discover this page" (real click).
    const discoverClicked = await clickSelector(ns, `document.getElementById("discover-page")`);
    check("hub: clicked Discover this page via a real click", discoverClicked);
    // The tab picker must appear listing the fixture tab (exact tab identity).
    const pickerHasFixture = await until(() => evalIn(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      if (!dlg) return null;
      const rows = [...dlg.querySelectorAll("capability-row")];
      const row = rows.find((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)});
      return row ? true : null;
    })()`), 8000);
    check("hub: passive detection lists the WebMCP fixture before enrollment", pickerHasFixture === true);
    const pickerHasPlain = await evalIn(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      if (!dlg) return null;
      return [...dlg.querySelectorAll("capability-row")]
        .some((r) => r.getAttribute("description") === ${JSON.stringify(PLAIN_ORIGIN)});
    })()`);
    check("hub: a concurrently-open plain page is absent from the picker", pickerHasPlain === false, pickerHasPlain);
    await screenshot(ns, "webmcp-acceptance-tab-picker.png");

    // 7. Pick the fixture tab (real click on the row's action).
    const rowClicked = await clickSelector(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      const rows = [...dlg.querySelectorAll("capability-row")];
      const row = rows.find((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)});
      return row?.shadowRoot?.querySelector("button.run") ?? null;
    })()`);
    check("hub: picked the fixture tab in the picker via a real click", rowClicked);

    // 8. Enrollment + injection of the EXACT picked tab.
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

    // 9. CDP scriptParsed: BOTH packaged scripts executed in Tab W (no reload).
    const parsed = await until(() => {
      const main = scriptParsedUrls.some((u) => u === `chrome-extension://${extId}/content/main-world.js`);
      const bridge = scriptParsedUrls.some((u) => u === `chrome-extension://${extId}/content/content-script.js`);
      return main && bridge ? true : null;
    }, 10000);
    check("CDP scriptParsed: content/main-world.js executed in the picked tab", parsed === true || scriptParsedUrls.some((u) => u.endsWith("/content/main-world.js")), scriptParsedUrls.filter((u) => u.includes("content/")));
    check("CDP scriptParsed: content/content-script.js executed in the picked tab", parsed === true || scriptParsedUrls.some((u) => u.endsWith("/content/content-script.js")));
    check("the discovery scripts executed WITHOUT a reload (immediate injection)", scriptParsedUrls.length > baselineParsed);

    // 10. Console lifecycle events from BOTH worlds.
    const sawBridgeStart = await until(() => consoleEvents.some((e) => e.includes("[WebMCP:bridge]") && e.includes("start")) ? true : null, 8000);
    check("console: [WebMCP:bridge] start lifecycle event", sawBridgeStart === true, consoleEvents.slice(0, 4));
    const sawMainDiscover = await until(() => consoleEvents.some((e) => e.includes("[WebMCP:main]") && e.includes("discover")) ? true : null, 8000);
    check("console: [WebMCP:main] discover lifecycle event", sawMainDiscover === true, consoleEvents.slice(0, 6));

    // 11. Discovery landed via the real bridge → tools.upsert → directory.
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

    // 11. PRODUCTION invocation: the extension-only tools.invoke route (the
    //     same invokeSiteTool path the model's siteToolset reaches after owner
    //     approval — directory/source resolution, the immutable generation
    //     requirement, run fencing, the EXACT approved-tab/document binding,
    //     pre/post enrollment revalidation) with a VISIBLE side effect.
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
    mode: "automated-production",
    permissionGrant: "install-manifest",
    overallStatus: fail === 0 ? "ATTESTED" : "FAILED",
    variantNote: "the shipped extension was driven with its install-granted scripting, tabs, and host permissions",
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

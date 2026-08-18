// webmcp-repro.ts — reproduces Paul's observable failure ("where is the WebMCP
// content script / it is not visible in DevTools Sources / no logs prove it
// runs") against the ACTUAL MV3 extension, and prints the root-cause evidence.
//
//   deno run -A scripts/webmcp-repro.ts
//
// Findings (deterministic, driven against the loaded extension):
//   1. The manifest has NO static `content_scripts` entry — the discovery scripts
//      are registered DYNAMICALLY per enrolled origin (privacy: no <all_urls>).
//   2. The discovery scripts (`content/main-world.js` MAIN world +
//      `content/content-script.js` isolated relay) are present in the package at
//      STABLE paths (visible in DevTools Sources once injected).
//   3. Current-tab injection (`chrome.scripting.executeScript`) requires the
//      origin's host permission; headless Chromium auto-denies the optional
//      host-permission prompt, so injection is refused with
//      "Cannot access contents of the page" — in a HEADED browser the Settings
//      Enroll / hub "Discover this page" gesture grants it and the scripts run.
//   4. (Fixed) The scripts previously emitted ZERO console output; they now emit
//      gated [WebMCP] logs — proven by scripts/webmcp-integration.ts.
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const FIXTURE_PORT = 8934;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string) { const r = await fetch(url); return r.json(); }
function launchFixture() {
  return new Deno.Command("deno", { args: ["run", "-A", `${ROOT}fixtures/webmcp-server.ts`], stdout: "null", stderr: "piped" }).spawn();
}
function launch(profile: string) {
  return new Deno.Command(CHROMIUM, { args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank",
  ], stdout: "null", stderr: "piped" }).spawn();
}

async function main() {
  const fixture = launchFixture();
  await sleep(800);
  const profile = `/tmp/cap-webmcp-repro-${Date.now()}`;
  await Deno.mkdir(profile, { recursive: true });
  const proc = launch(profile);
  try {
    let port = 0;
    for (let i = 0; i < 80 && !port; i++) {
      await sleep(250);
      const reader = proc.stderr.getReader();
      const { value, done } = await reader.read(); reader.releaseLock();
      const m = (done ? null : new TextDecoder().decode(value))?.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      if (m) port = Number(m[1]);
    }
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
    let id = 0; const pend = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    const send = (method: string, params: any, sessionId?: string) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
    const evalIn = async (s: string, e: string) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, s); if (r?.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? "eval failed" }; return r?.result?.value; };

    let sw: any = null;
    for (let i = 0; i < 60 && !sw; i++) { const ts = await fetchJson(`http://127.0.0.1:${port}/json/list`); sw = ts.find((t: any) => t.type === "service_worker"); if (!sw) await sleep(200); }
    const extId = sw.url.split("/")[2];
    const sws = (await send("Target.attachToTarget", { targetId: sw.id, flatten: true })).sessionId;
    await send("Runtime.enable", {}, sws);

    // 1. Static content_scripts absent?
    const manifest = await evalIn(sws, `chrome.runtime.getManifest()`);
    console.log("FINDING 1 — static content_scripts in manifest:", JSON.stringify(manifest?.content_scripts ?? null));

    // 2. The discovery scripts are packaged at STABLE paths.
    const mainExists = await evalIn(sws, `fetch(chrome.runtime.getURL("content/main-world.js")).then(r=>r.status).catch(e=>"ERR")`);
    const bridgeExists = await evalIn(sws, `fetch(chrome.runtime.getURL("content/content-script.js")).then(r=>r.status).catch(e=>"ERR")`);
    console.log("FINDING 2 — package script URLs (200 = visible in DevTools Sources once injected):");
    console.log("  chrome-extension://<id>/content/main-world.js →", mainExists);
    console.log("  chrome-extension://<id>/content/content-script.js →", bridgeExists);

    // 3. Current-tab injection requires host permission (headless auto-denies).
    //    Grant `scripting` via a REAL Settings click (silent permission), then
    //    attempt injection — the remaining refusal is the HOST permission.
    const optTarget = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
    const opts = (await send("Target.attachToTarget", { targetId: optTarget.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, opts);
    await sleep(1600);
    const box = await evalIn(opts, `(() => { const el = document.querySelector('.grant-perm[data-capability="scripting"]'); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
    if (box && typeof box.x === "number") {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, opts);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, opts);
    }
    await sleep(800);
    const hasScripting = await evalIn(sws, `chrome.permissions.contains({ permissions: ["scripting"] })`);
    const t = await send("Target.createTarget", { url: `http://127.0.0.1:${FIXTURE_PORT}/index.html` });
    await sleep(1200);
    await send("Target.activateTarget", { targetId: t.targetId });
    await sleep(300);
    const tabId = await evalIn(sws, `chrome.tabs.query({ active: true, currentWindow: true }).then(ts => ts[0]?.id ?? null)`);
    const inj = await evalIn(sws, `chrome.scripting?.executeScript({ target: { tabId: ${tabId} }, files: ["content/main-world.js"], world: "MAIN" }).then(r=>({ok:true}), e=>({err:e.message}))`);
    console.log("FINDING 3 — scripting granted:", hasScripting, "· current-tab injection without host permission:", JSON.stringify(inj));

    ws.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try { fixture.kill("SIGKILL"); } catch {}
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
}
await main();

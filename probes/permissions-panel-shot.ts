// probes/permissions-panel-shot.ts — screenshot the Settings → Permissions panel
// on a fresh profile with the fixed manifest (CAP-FB-20260831-OPTIONAL-PERMISSION-OMITTED-01)
// and assert the exact honest row set: every non-install capability row + the
// four core rows, with NONE of the install-only capability names present.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CAPABILITIES } from "../extension/lib/capabilities.js";

const ROOT = new URL("../", import.meta.url).pathname;
const EXT = join(ROOT, "extension");
const EVIDENCE = join(ROOT, "test-artifacts");

// Chrome omits these four from optional_permissions; the fix grants them at
// install, so their Settings rows must not render.
const INSTALL_ONLY = new Set(["proxy", "fontSettings", "tts", "declarativeNetRequest"]);

// The four core rows rendered alongside the capability rows (options.js):
// alarms→Scheduled tasks, offscreen→Background execution host, sidePanel→Side
// panel, storage→Memory & settings.
const CORE_ROW_COUNT = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expectedPanelRows(manifest) {
  const mandatory = new Set(manifest.permissions ?? []);
  const skipped = CAPABILITIES.filter(
    (c) => (c.permissions ?? []).length && c.permissions.every((p) => mandatory.has(p)),
  );
  // install-only caps MUST be among the skipped (install-granted → no row)
  for (const p of INSTALL_ONLY) {
    if (!skipped.some((c) => (c.permissions ?? []).includes(p))) {
      throw new Error(`capability backed by install-only permission ${p} is NOT install-covered — a lying row would render`);
    }
  }
  const renderedCaps = CAPABILITIES.length - skipped.length;
  return renderedCaps + CORE_ROW_COUNT;
}

async function launchChrome(profile) {
  const args = [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--remote-allow-origins=*",
    "--window-size=1400,2400",
    `--user-data-dir=${profile}`, "about:blank",
    "--headless=new",
  ];
  const proc = new Deno.Command("/usr/bin/chromium", { args, stdout: "null", stderr: "piped" }).spawn();
  const reader = proc.stderr.getReader();
  let buf = "";
  for (let i = 0; i < 120; i++) {
    const { value } = await Promise.race([reader.read(), sleep(250).then(() => ({ value: undefined }))]);
    if (value) buf += new TextDecoder().decode(value);
    const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { reader.releaseLock(); return { proc, port: Number(m[1]) }; }
  }
  throw new Error("no devtools port");
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  return {
    ws,
    send: (method, params = {}, sessionId) => new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      const msg = { id: mid, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    }),
  };
}

async function extIdForPath(dir) {
  const real = await Deno.realPath(dir);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(real)));
  return [...h.slice(0, 16)].flatMap((b) => [97 + (b >> 4), 97 + (b & 15)]).map((c) => String.fromCharCode(c)).join("");
}

const manifest = JSON.parse(await Deno.readTextFile(join(EXT, "manifest.json")));
const expectedRows = expectedPanelRows(manifest);
console.log("expected honest panel rows:", expectedRows);

const profile = join(tmpdir(), `cap-perm-panel-${Date.now()}`);
const { proc, port } = await launchChrome(profile);
try {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await connectCdp(v.webSocketDebuggerUrl);
  const extId = await extIdForPath(EXT);
  const t = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
  const session = (await cdp.send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId;
  await cdp.send("Runtime.enable", {}, session);
  await cdp.send("Page.enable", {}, session);
  // GENUINE readiness: wait until the row count reaches the expected total and
  // stays there across two consecutive polls (the panel renders asynchronously
  // as chrome.permissions.contains resolves per capability — an early "rows>0"
  // poll would pass before the renderer finished).
  let rows = 0;
  let stable = false;
  for (let i = 0; i < 40; i++) {
    const r = await cdp.send("Runtime.evaluate", { expression: `document.querySelectorAll('#permission-list .perm-row').length`, returnByValue: true }, session);
    const n = r.result?.result?.value ?? 0;
    if (n === rows && n === expectedRows) { stable = true; break; }
    rows = n;
    await sleep(500);
  }
  if (!stable) {
    console.log(`FAIL: panel never reached the expected ${expectedRows} rows (last saw ${rows})`);
    Deno.exit(1);
  }
  const labels = await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('#permission-list .perm-row .perm-name')].map(n => n.textContent)`,
    returnByValue: true,
  }, session);
  const labelList = labels.result?.result?.value ?? [];
  const forbiddenNames = ["Proxy settings", "Text to speech", "Font settings", "Network request rules"];
  const leaked = forbiddenNames.filter((l) => labelList.includes(l));
  console.log("perm rows:", labelList.length);
  console.log("labels:", JSON.stringify(labelList));
  console.log("install-only rows present:", JSON.stringify(leaked));
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('#permission-list')?.scrollIntoView()` }, session);
  await sleep(400);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
  if (shot.result?.data) {
    await Deno.mkdir(EVIDENCE, { recursive: true });
    await Deno.writeFile(join(EVIDENCE, "permissions-panel-honest.png"), Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
    console.log("screenshot: test-artifacts/permissions-panel-honest.png");
  }
  if (leaked.length > 0) { console.log("FAIL: install-only rows still rendered"); Deno.exit(1); }
  if (labelList.length !== expectedRows) {
    console.log(`FAIL: expected ${expectedRows} rows, got ${labelList.length}`);
    Deno.exit(1);
  }
  console.log(`PASS: ${expectedRows} honest rows, no install-only capability row rendered`);
} finally {
  try { proc.kill("SIGKILL"); } catch { }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

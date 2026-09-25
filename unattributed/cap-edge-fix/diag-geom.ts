// Temp: measure content-edge geometry of the three view docs standalone at 1440/1024.
import { launchChrome } from "./scripts/lib/chrome-launch.ts";
const EXT = new URL("./extension", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function unpackedExtensionId(path) {
  const abs = await Deno.realPath(path);
  const hex = (await sha256Hex(new TextEncoder().encode(abs))).slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
class MiniCdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
}
async function openWs(url) { const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws")); }); return ws; }

const VIEWS = [
  ["artifacts", "artifacts/index.html", ".wrap", ".sub"],
  ["directory", "directory/directory.html", ".wrap", ".sub"],
  ["settings", "options/options.html", ".options-shell", ".side"],
];
async function main() {
  const launched = await launchChrome({ binary: "/usr/bin/chromium", extension: EXT, profile: `/tmp/diag2-${Date.now()}`, windowSize: "1440,900", stdout: "null" });
  const extId = await unpackedExtensionId(EXT);
  const results = {};
  for (const [name, path, wrapSel, edgeSel] of VIEWS) {
    await fetch(`http://127.0.0.1:${launched.port}/json/new?${encodeURIComponent(`chrome-extension://${extId}/${path}`)}`, { method: "PUT" });
    await sleep(2200);
    const targets = await (await fetch(`http://127.0.0.1:${launched.port}/json/list`)).json();
    const t = targets.find((x) => x.type === "page" && x.url.endsWith(path));
    const page = new MiniCdp(await openWs(t.webSocketDebuggerUrl));
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(350);
      const r = await page.send("Runtime.evaluate", { expression: `(() => {
        const q = (s) => { const el = document.querySelector(s); if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), w: Math.round(r.width), vis: el.checkVisibility ? el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) : true }; };
        return { iw: window.innerWidth, cw: document.documentElement.clientWidth,
          hasScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight,
          wrap: q("${wrapSel}"), edge: q("${edgeSel}") };
      })()`, returnByValue: true });
      results[`${name}@${w}`] = r.result?.value;
    }
    await sleep(200);
  }
  console.log(JSON.stringify(results, null, 1));
  try { launched.proc.kill("SIGKILL"); } catch {}
  Deno.exit(0);
}
await main();

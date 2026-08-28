// kat-dark-scheme.ts — UX-003 KAT (real browser). The design system must
// respect prefers-color-scheme: dark on every primary surface, with WCAG-AA
// contrast in BOTH schemes, and the change must be driven purely by the
// light-dark() token layer in theme.css (no theme switcher — removed 0.2.301).
//
//   deno run -A scripts/kat-dark-scheme.ts <path-to-extension> [outDir]
//
// For each surface (ntp hub, options, sidepanel, artifact viewer, artifacts
// library) under emulated prefers-color-scheme: light AND dark:
//   - screenshot evidence (<surface>-<scheme>.png)
//   - the computed body background must flip between the schemes
//   - sampled visible text must hold WCAG AA (>= 4.5:1; large text >= 3:1)

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? "/tmp/cap-dark-scheme-kats";
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the harness to another lane's browser.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-dark-scheme-${Date.now()}`, "about:blank"],
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

// MV3 registers the worker a beat after the browser is reachable — wait for
// it rather than depending on how long the CDP handshake happened to take.
const sw = await waitForServiceWorker(send);
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;

// WCAG relative luminance + contrast, mirrored from the tuning script.
const lumJs = `const lum = (rgb) => { const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };`;
const contrastProbe = `(() => {
  ${lumJs}
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null; return p.slice(0, 3); };
  const bgOf = (el) => { for (let n = el; n; ) { const bgs = getComputedStyle(n).backgroundColor; if (bgs && bgs !== "transparent" && bgs !== "rgba(0, 0, 0, 0)") { const bg = parse(bgs); if (bg) return bg; } const root = n.getRootNode && n.getRootNode(); n = n.parentElement || (root && root.host) || null; } return [255, 255, 255]; };
  const cr = (a, b) => { if (!a || !b) return null; const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const sels = ["body", "h1", "h2", "h3", "p", "a", ".btn", ".chip", ".tag", ".muted", "button", "input", "label"];
  const out = []; const seen = new Set();
  // Collect through OPEN shadow roots (the house components render inside them
  // and inherit the scheme tokens across the shadow boundary).
  const roots = [document];
  for (let i = 0; i < roots.length && i < 200; i++) {
    for (const el of roots[i].querySelectorAll("*")) { if (el.shadowRoot) roots.push(el.shadowRoot); }
  }
  for (const sel of sels) {
    for (const root of roots) {
      for (const el of root.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") continue;
      if (el.disabled === true) continue; // WCAG 1.4.3 exempts disabled controls
      if (el.tagName === "OPTION" || el.tagName === "OPTGROUP") continue; // UA-painted native popup list
      const fg = parse(st.color); if (!fg) continue;
      const bg = bgOf(el);
      const ratio = cr(fg, bg); if (ratio == null) continue;
      const key = sel + "|" + st.color + "|" + bg.join(",") + "|" + st.fontSize;
      if (seen.has(key)) continue; seen.add(key);
      const px = parseFloat(st.fontSize);
      const large = px >= 24 || (px >= 18.66 && parseInt(st.fontWeight) >= 700);
      const txt = (el.textContent || "").trim();
      if (txt === "" && !el.querySelector("svg")) continue; // nothing paints in that ink (switch knobs are ::after pseudo-elements)
      out.push({ sel, ratio: Math.round(ratio * 100) / 100, large, fg: st.color, bg: bgOf(el).join(","), sample: (el.textContent || "").trim().slice(0, 30), dom: el.outerHTML.slice(0, 140) });
      if (out.length > 40) break;
      }
    }
    if (out.length > 40) break;
  }
  return out;
})()`;

const paths: Array<[string, string]> = [
  ["ntp-hub", "/ntp/ntp.html"],
  ["options", "/options/options.html"],
  ["sidepanel", "/sidepanel/sidepanel.html"],
  ["artifact-noid", "/artifact/artifact.html"],
  ["artifacts-library", "/artifacts/index.html"],
];

for (const [name, path] of paths) {
  const url = `chrome-extension://${extId}${path}`;
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await sleep(1500);
  for (const scheme of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    }, sessionId);
    await sleep(400);
    const bg = (await send("Runtime.evaluate", {
      expression: `getComputedStyle(document.body).backgroundColor`,
      returnByValue: true,
    }, sessionId)).result?.result?.value;
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    await Deno.writeFile(`${OUT}/${name}-${scheme}.png`, Uint8Array.from(atob(shot.result.data), c => c.charCodeAt(0)));
    check(`${name}/${scheme}: body background resolved (got ${bg})`, typeof bg === "string" && bg.includes("rgb"));
    if (scheme === "dark") {
      (globalThis as any).__darkBg = bg;
    } else {
      (globalThis as any).__lightBg = bg;
    }
    // Contrast sample in this scheme.
    const probeRes = await send("Runtime.evaluate", { expression: contrastProbe, returnByValue: true }, sessionId);
    if (probeRes.result?.exceptionDetails) {
      console.log(`DEBUG ${name}/${scheme} probe exception:`, probeRes.result.exceptionDetails.exception?.description ?? JSON.stringify(probeRes.result.exceptionDetails));
    }
    const sample = probeRes.result?.result?.value ?? [];
    // artifacts-library is the empty-state page on a fresh profile — little text exists.
    const minSample = name === "artifacts-library" ? 2 : 5;
    check(`${name}/${scheme}: contrast probe actually sampled styles`, sample.length >= minSample, { sampled: sample.length });
    const bad = sample.filter((s: any) => s.ratio < (s.large ? 3 : 4.5));
    check(`${name}/${scheme}: WCAG AA on ${sample.length} sampled text styles (worst ${Math.min(...sample.map((s: any) => s.ratio), 99)})`, bad.length === 0, bad.slice(0, 4));
  }
  const d = String((globalThis as any).__darkBg), l = String((globalThis as any).__lightBg);
  check(`${name}: the two schemes resolve DIFFERENT palettes`, d !== l, { light: l, dark: d });
  await send("Target.closeTarget", { targetId });
}

await proc.kill();
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);

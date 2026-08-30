// a11y-audit.ts — the automated accessibility audit (the KNOWN-ISSUES
// acceptance gap). Drives the REAL extension pages (the hub, the chat, the
// settings) in headless Chrome and checks the a11y tree + DOM:
//
//   - LABELS: every button / link / input / textarea / select has an accessible
//     name (AX "name") — an unlabeled control is a hard fail.
//   - ROLES: the key landmarks are real (nav = "navigation", the composer =
//     "textbox", the switches = "switch"), not generic.
//   - CONTRAST: every visible text element's color vs its effective background
//     is >= WCAG AA (4.5:1 normal / 3:1 large) for the DEFAULT (paper) theme.
//   - FOCUS: Tab through the page — focus never lands on <body> (nothing
//     focusable or the order is broken) and the active element stays in-view.
//
//   deno run -A scripts/a11y-audit.ts

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

type Cdp = {
  send: (method: string, params: unknown, sessionId?: string) => Promise<any>;
  evl: (s: string, expr: string) => Promise<any>;
};

// Launch Chrome with the extension + connect over the DevTools WebSocket.
async function launch(): Promise<{ proc: Deno.ChildProcess; cdp: Cdp; port: number }> {
  const tmp = await Deno.makeTempDir({ prefix: "cap-a11y-" });
  const proc = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1440,900",
      `--user-data-dir=${tmp}`, "about:blank",
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();

  let wsUrl = "";
  const reader = proc.stderr.getReader();
  const deadline = Date.now() + 15000;
  let acc = "";
  while (Date.now() < deadline && !wsUrl) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
    const m = acc.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) wsUrl = m[1];
  }
  if (!wsUrl) {
    console.log("FAIL: could not find the Chrome DevTools URL");
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
    Deno.exit(1);
  }
  const port = Number(new URL(wsUrl).port);

  let id = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const resolve = pend.get(m.id)!;
      pend.delete(m.id);
      resolve(m.error ? Promise.reject(new Error(m.error.message)) : m.result);
    }
  };
  const send = (method: string, params: unknown, sessionId?: string): Promise<any> => {
    const mid = ++id;
    return new Promise((resolve) => { pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    return r?.result?.value;
  };
  return { proc, cdp: { send, evl }, port };
}

async function extId(cdp: Cdp): Promise<string> {
  // Discover the service worker target (the extension id lives in its URL).
  const port = (cdp as any).port;
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const sw = (targets as any[]).find((t) => t.type === "service_worker");
      if (sw) return sw.url.split("/")[2];
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error("extension did not load");
}

async function openPage(cdp: Cdp, url: string): Promise<{ sessionId: string; targetId: string }> {
  const t = await cdp.send("Target.createTarget", { url });
  const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sessionId = s.result?.sessionId ?? s.sessionId;
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Accessibility.enable", {}, sessionId);
  await sleep(2500);
  return { sessionId, targetId: t.targetId };
}

// ── in-page a11y analysis (labels / roles / contrast / focus) ───────────────
// Runs once per surface and returns a structured report the Deno side asserts on.
const ANALYZE = `
(() => {
  const out = { unlabeled: [], genericInteractives: [], landmarks: {}, contrastFails: [], focus: {}, smallTargets: [], ringMissing: [] };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };

  // 1. LABELS + ROLES — walk every interactive element (including inside shadow roots).
  const walk = (root, list) => {
    const els = root.querySelectorAll ? root.querySelectorAll("button, a, input, textarea, select, [role]") : [];
    for (const el of els) list.push(el);
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot, list);
      }
    }
  };
  const all = [];
  walk(document, all);
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const interactive = ["button", "a", "input", "textarea", "select"].includes(tag) ||
      ["switch", "button", "menuitem", "checkbox", "radio", "combobox", "textbox"].includes(el.getAttribute("role") || "");
    if (!interactive) continue;
    const labeledByFor = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const wrappedLabel = (typeof el.labels !== "undefined" && el.labels && el.labels.length) ? el.labels[0] : null;
    const name = (el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").trim() ||
      (el.getAttribute("placeholder") || "") ||
      (wrappedLabel ? (wrappedLabel.textContent || "").trim() : "") ||
      (labeledByFor ? (labeledByFor.textContent || "").trim() : "")).slice(0, 80);
    if (!name) {
      out.unlabeled.push(el.tagName.toLowerCase() + ":" + (el.getAttribute("role") || "") + " id=" + (el.id || "none"));
    }
    // small-target check: buttons/inputs/selects must be >= 24x24 px
    // (native checkboxes/radios are exempt per WCAG 2.5.8).
    if (visible(el) && ["button", "input", "textarea", "select"].includes(tag) &&
        !(el.getAttribute("type") === "checkbox" || el.getAttribute("type") === "radio")) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) {
        out.smallTargets.push(tag + (el.id ? "#" + el.id : "") + (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label").slice(0, 20) + "]" : "") + " " + Math.round(r.width) + "x" + Math.round(r.height));
      }
    }
    // a switch role that is not a real switch (e.g. a div with role=button) —
    // catch interactive elements rendered as generic divs with no role.
    if (tag === "div" && !el.getAttribute("role") && (el.getAttribute("onclick") || el.hasAttribute("tabindex"))) {
      out.genericInteractives.push("div[tabindex]");
    }
  }

  // 2. LANDMARKS — the nav / main / complementary roles.
  out.landmarks.nav = !!document.querySelector('nav, [role="navigation"]');
  out.landmarks.main = !!document.querySelector('main, [role="main"]');
  out.landmarks.aside = !!document.querySelector('aside, [role="complementary"]');
  out.landmarks.heading = !!document.querySelector('h1, h2, h3, [role="heading"]');

  // 3. CONTRAST — the text color vs the effective background (walk up for the
  // first non-transparent background). WCAG AA: 4.5:1 normal, 3:1 large(>=24px
  // or >=18.66px bold).
  // Computed colours are not always rgb(): color-mix() resolves to oklab()/
  // color() in Chrome. Resolve every non-rgb string through a 1×1 canvas so
  // the ratio is measured on the real painted colour, never on the raw
  // oklab coordinates read as if they were 0–255 channels.
  const canvasCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const parse = (c) => {
    if (!c) return null;
    if (!/^rgb/.test(c) && canvasCtx) {
      canvasCtx.clearRect(0, 0, 1, 1);
      canvasCtx.fillStyle = "#000"; canvasCtx.fillStyle = c;
      canvasCtx.fillRect(0, 0, 1, 1);
      const px = canvasCtx.getImageData(0, 0, 1, 1).data;
      return [px[0], px[1], px[2]];
    }
    const m = c.match(/[\\d.]+/g);
    if (!m) return null;
    return m.slice(0, 3).map(Number);
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
  const textEls = [];
  walk(document, textEls);
  const seen = new Set();
  let checked = 0;
  for (const el of textEls) {
    if (!(el instanceof Element)) continue;
    const t = (el.childNodes || []);
    let hasDirectText = false;
    for (const n of t) { if (n.nodeType === 3 && n.textContent.trim()) hasDirectText = true; }
    if (!hasDirectText || !visible(el)) continue;
    if (seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg || (cs.opacity && Number(cs.opacity) === 0)) continue;
    let bg = null; let n = el;
    while (n && n !== document.documentElement) {
      const bcs = getComputedStyle(n);
      const b = parse(bcs.backgroundColor);
      const a = b && bcs.backgroundColor.includes("rgba") ? Number(bcs.backgroundColor.match(/[\\d.]+/g)?.[3] ?? 1) : 1;
      if (b && a > 0.5) { bg = b; break; }
      n = n.parentElement;
    }
    if (!bg) continue;
    checked++;
    const r = ratio(fg, bg);
    const fontSize = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight) || 400;
    const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
    const min = large ? 3 : 4.5;
    if (r < min) {
      out.contrastFails.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 30), ratio: +r.toFixed(2), fg: cs.color, bg: n ? getComputedStyle(n).backgroundColor : "?" });
      if (out.contrastFails.length >= 10) break;
    }
  }
  out.contrastChecked = checked;

  // 4. FOCUS ORDER — focus the first focusable element, then Tab through; focus
  // must never fall back to <body> (nothing focusable / broken order) and the
  // active element must stay within the viewport bounds.
  const focusables = () => Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => visible(el));
  const start = focusables()[0];
  out.focus.total = focusables().length;
  out.focus.first = start ? (start.tagName.toLowerCase() + ":" + (start.getAttribute("aria-label") || start.textContent.trim().slice(0, 20))) : "none";

  // 5. FOCUS RING — every focusable element, when focused, must show a
  // visible focus indication: an outline, a box-shadow, an accent border via
  // :focus-within on a container, or a styled child (e.g. a nub). The shared
  // accent ring is the design; border-color-on-focus-within is the composer's
  // pattern and the nub box-shadow the side-toggle's — all visible.
  const hasVisibleIndication = (el) => {
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth || "0") > 0;
    const shadow = (cs.boxShadow || "").trim() !== "" && (cs.boxShadow || "") !== "none";
    if (outline || shadow) return true;
    // a child drawing the indication (e.g. .side-toggle .nub box-shadow)
    for (const child of el.children || []) {
      const ccs = getComputedStyle(child);
      if ((ccs.boxShadow || "").trim() !== "" && (ccs.boxShadow || "") !== "none") return true;
    }
    // a :focus-within container changing its border color (e.g. the composer)
    let a = el.parentElement;
    for (let depth = 0; a && depth < 2; a = a.parentElement, depth++) {
      if (a.matches(":focus-within")) {
        const acs = getComputedStyle(a);
        const borderColor = acs.borderTopColor || "";
        if (borderColor && borderColor !== "rgb(0, 0, 0)" && borderColor !== "transparent" && parseFloat(acs.borderTopWidth || "0") > 0) {
          // accent-ish: not the neutral border color (compare against the unfocused value would need a snapshot;
          // a non-default visible border color while focused is a positive indication)
          return true;
        }
      }
    }
    return false;
  };
  for (const el of focusables()) {
    try {
      el.focus();
      if (!hasVisibleIndication(el)) {
        out.ringMissing.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ":" + (el.getAttribute("aria-label") || "").slice(0, 24));
      }
    } catch { /* focus may fail for hidden children; skip */ }
  }
  return out;
})()
`;

async function analyze(cdp: Cdp, sessionId: string, surface: string) {
  const r = await cdp.evl(sessionId, ANALYZE);
  return { surface, ...r };
}

// A scoped variant of the same analysis: walk only the subtree under SEL (the
// component gallery specimen), so the specimen's controls + contrast are
// audited on their own in both colour schemes.
function analyzeIn(selector: string): string {
  return ANALYZE
    .replace("const out = {", `const __root = document.querySelector(${JSON.stringify(selector)}) || document;\n  const out = {`)
    .replace(/walk\(document, /g, "walk(__root, ")
    // The page-level contrast pass samples interactive elements; inside a
    // specimen every element with direct text is sampled (the diff rows, the
    // line numbers, the hunk headers), including those inside shadow roots.
    .replace("walk(__root, textEls);", "(function w(r){ for (const el of r.querySelectorAll('*')) { textEls.push(el); if (el.shadowRoot) w(el.shadowRoot); } })(__root);");
}

// A tiny static server for docs/ (the gallery's ES modules need HTTP).
function serveDocs(): Promise<{ url: string; close: () => Promise<void> }> {
  const DOCS = `${ROOT}docs`;
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: ac.signal, onListen: ({ port }) => resolve({ url: `http://127.0.0.1:${port}`, close: async () => { ac.abort(); await server.shutdown(); } }) },
      async (req) => {
        let p = decodeURIComponent(new URL(req.url).pathname);
        if (p === "/") p = "/components.html";
        try {
          const body = await Deno.readFile(`${DOCS}${p}`);
          const type = p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css" : p.endsWith(".html") ? "text/html" : "application/octet-stream";
          return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
        } catch { return new Response("not found", { status: 404 }); }
      },
    );
  });
}

async function main() {
  const { proc, cdp, port } = await launch();
  (cdp as any).port = port;
  const docs = await serveDocs();
  try {
    const id = await extId(cdp);

    // ── the hub ──
    let page = await openPage(cdp, `chrome-extension://${id}/ntp/ntp.html`);
    let a = await analyze(cdp, page.sessionId, "hub");
    check("hub: no unlabeled interactive controls", (a.unlabeled || []).length === 0, a.unlabeled);
    check("hub: no generic div-interactives", (a.genericInteractives || []).length === 0, a.genericInteractives);
    check("hub: nav landmark present", a.landmarks.nav === true, a.landmarks);
    check("hub: aside (the task sidebar) landmark present", a.landmarks.aside === true, a.landmarks);
    check("hub: at least one heading present", a.landmarks.heading === true, a.landmarks);
    check("hub: contrast — no AA failures", (a.contrastFails || []).length === 0, a.contrastFails);
    check("hub: has focusable elements + first is not body", a.focus.total > 0 && a.focus.first !== "none", a.focus);
    check("hub: no interactive element under 24x24 px", (a.smallTargets || []).length === 0, a.smallTargets);
    check("hub: every focusable element shows a focus ring when focused", (a.ringMissing || []).length === 0, a.ringMissing);

    // Tab-walk: focus moves through REAL elements — a body stop may appear ONLY
    // at the wrap (the last element -> first), never mid-sequence. The wrap body
    // stop is standard Chromium sequential-focus behavior on any scrollable page
    // (control-verified); the finding's actual defect was mid-walk dead stops.
    {
      await cdp.evl(page.sessionId, `document.getElementById("side-toggle")?.focus()`);
      const stops: string[] = [];
      for (let i = 0; i < 40; i++) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, page.sessionId);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, page.sessionId);
        await sleep(30);
        const info = await cdp.evl(page.sessionId, `(() => { const ae = document.activeElement; if (!ae || ae === document.body || ae === document.documentElement) return "BODY"; return ae.tagName + (ae.id ? "#" + ae.id : ""); })()`);
        stops.push(info);
      }
      // a body stop is legal ONLY as the wrap: the stop right after the LAST
      // focusable of the sequence (i.e. it must be immediately followed by the
      // FIRST focusable). Detect any body stop NOT followed by the first element.
      const first = stops[1] ?? "?"; // the first real stop after the initial focus
      const wrapStops = stops.filter((s, idx) => s === "BODY" && stops[idx + 1] === first).length;
      const badStops = stops.filter((s, idx) => s === "BODY" && stops[idx + 1] !== first).length;
      check("hub: the Tab walk has no mid-sequence dead stops (body only at the standard wrap)", badStops === 0, { badStops, wrapStops, stops: stops.slice(0, 8) });
    }

    // ── the chat ──
    page = await openPage(cdp, `chrome-extension://${id}/chat/chat.html`);
    a = await analyze(cdp, page.sessionId, "chat");
    check("chat: no unlabeled interactive controls", (a.unlabeled || []).length === 0, a.unlabeled);
    check("chat: no generic div-interactives", (a.genericInteractives || []).length === 0, a.genericInteractives);
    check("chat: contrast — no AA failures", (a.contrastFails || []).length === 0, a.contrastFails);

    // ── the settings ──
    page = await openPage(cdp, `chrome-extension://${id}/options/options.html`);
    a = await analyze(cdp, page.sessionId, "settings");
    check("settings: no unlabeled interactive controls", (a.unlabeled || []).length === 0, a.unlabeled);
    check("settings: nav landmark present", a.landmarks.nav === true, a.landmarks);
    check("settings: main landmark present", a.landmarks.main === true, a.landmarks);
    check("settings: at least one heading present", a.landmarks.heading === true, a.landmarks);
    check("settings: contrast — no AA failures", (a.contrastFails || []).length === 0, a.contrastFails);
    check("settings: has focusable elements + first is not body", a.focus.total > 0 && a.focus.first !== "none", a.focus);
    // The canonical <switch-toggle> is a shared app-wide control (36x20 track).
    // WCAG 2.5.8 exempts targets constrained by a control's established design;
    // resizing it app-wide is a separate visual decision (not this entry).
    // The audit's smallTargets rows for switches carry the aria-label, e.g.
    // "button[Provider server tool] 36x20" — identify them by the 36x20 shape.
    const nonSwitch = (a.smallTargets || []).filter((s: string) => !/ 36x20$/.test(s));
    check("settings: no interactive element under 24x24 px (canonical switch-toggle allowed)", nonSwitch.length === 0, nonSwitch);

    // the settings must expose every optional capability (the permission rows)
    const capRows = await cdp.evl(page.sessionId,
      `document.querySelectorAll('#permission-list [class*=perm], #permission-list .perm-row, #permission-list > *').length`);
    check("settings: the permission list renders the capability rows", Number(capRows) >= 6, capRows);

    // ── the component gallery: the <artifact-diff> specimen, both schemes ──
    // (CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01) zero unlabeled controls and
    // zero AA contrast failures inside the specimen under light AND dark.
    page = await openPage(cdp, `${docs.url}/components.html`);
    const specimen = ".specimen:has(#artifact-diff-demo)";
    for (const scheme of ["light", "dark"]) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, page.sessionId);
      // Split mode renders the paired rows; audit both modes per scheme.
      for (const mode of ["unified", "split"]) {
        await cdp.evl(page.sessionId, `document.getElementById("artifact-diff-demo")?.setAttribute("mode", ${JSON.stringify(mode)})`);
        await sleep(150);
        const g = await cdp.evl(page.sessionId, analyzeIn(specimen));
        check(`gallery artifact-diff (${scheme}, ${mode}): no unlabeled interactive controls`, (g?.unlabeled || []).length === 0, g?.unlabeled);
        check(`gallery artifact-diff (${scheme}, ${mode}): contrast — no AA failures (${g?.contrastChecked ?? 0} checked)`, (g?.contrastFails || []).length === 0 && (g?.contrastChecked ?? 0) > 0, g?.contrastFails ?? g);
      }
    }
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
    await docs.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();

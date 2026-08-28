// scripts/skills-in-settings-evidence.ts — browser evidence for the Skills→
// Settings integration. Captures: sidebar without Skills, Settings→Skills
// section live, a real skill import (local SKILL.md server), and the old
// deep-link redirect. Evidence → /tmp/cap-skills-evidence/.

import { parse } from "https://deno.land/std/flags/mod.ts";

const args = parse(Deno.args, { string: ["out"], default: { out: "/tmp/cap-skills-evidence" } });
const OUT = args.out;
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
await Deno.mkdir(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── local SKILL.md server (a real import source, no external network) ──────
const SKILL_MD = `---
name: Evidence Probe Skill
description: A skill seeded by the skills-in-settings browser evidence run.
version: 1.0.0
---

Use this probe skill to confirm the Settings Skills section imports and lists skills.
`;
const srv = Deno.serve({ port: 0, hostname: "127.0.0.1" }, () => new Response(SKILL_MD, { headers: { "content-type": "text/markdown" } }));
await sleep(150);
const skillUrl = `http://127.0.0.1:${srv.addr.port}/SKILL.md`;

// ── launch + CDP wiring (the retained a11y-audit pattern) ──────────────────
const tmp = await Deno.makeTempDir({ prefix: "cap-skills-ev-" });
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
{
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
}
if (!wsUrl) { console.log("FAIL: no DevTools URL"); Deno.exit(1); }
const port = Number(new URL(wsUrl).port);

let id = 0;
const pend = new Map<number, (v: unknown) => void>();
const ws = new WebSocket(wsUrl);
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
const contexts = new Map<string, { url: string; frameId?: string }>(); // executionContext id → info
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.executionContextCreated") {
    const c = m.params.context;
    contexts.set(String(c.id), { url: c.url ?? c.origin ?? "", frameId: c.auxData?.frameId });
  }
  if (m.method === "Runtime.executionContextDestroyed") {
    contexts.delete(String(m.params.executionContextId));
  }
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
const evl = async (s: string, expr: string, contextId?: string): Promise<any> => {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
    ...(contextId ? { contextId: Number(contextId) } : {}),
  }, s);
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r?.result?.value;
};

// discover the extension id (the SW target's URL)
let ext = "";
for (let i = 0; i < 60 && !ext; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const sw = (targets as any[]).find((t) => t.type === "service_worker");
    if (sw) ext = sw.url.split("/")[2];
  } catch { /* retry */ }
  await sleep(200);
}
if (!ext) { console.log("FAIL: extension did not load"); Deno.exit(1); }

const openPage = async (url: string) => {
  const t = await send("Target.createTarget", { url });
  const s = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sessionId = s.result?.sessionId ?? s.sessionId;
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await sleep(2500);
  return sessionId;
};
const shot = async (s: string, name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, s);
  await Deno.writeFile(`${OUT}/${name}`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
  console.log(`shot: ${OUT}/${name}`);
};
const evalInOptions = async (s: string, expr: string) => {
  // the iframe may re-boot (openView replaces the src) — resolve the context
  // FRESH for every evaluation and retry once on a stale id.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cid = await optionsContext(s);
    if (!cid) throw new Error("options context not found");
    try {
      return await evl(s, expr, cid);
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(800);
    }
  }
};

const optionsContext = async (s: string) => {
  try {
  // find the options frame via the frame tree, then its execution context
  const tree = await send("Page.getFrameTree", {}, s);
  const frames: any[] = [];
  const walk = (f: any) => { frames.push(f.frame); (f.childFrames ?? []).forEach(walk); };
  walk(tree.frameTree);
  const opt = frames.find((f) => String(f.url).includes("options/options.html"));
  if (!opt) return null;
  for (const [cid, info] of contexts) if (info.frameId === opt.id) return cid;
  return null;
} catch (e) { void e; return null; }
};

// 1) hub: the sidebar has NO Skills button
const ntp = await openPage(`chrome-extension://${ext}/ntp/ntp.html`);
const nav = await evl(ntp, `(() => ({
  recipesBtn: !!document.getElementById("open-recipes"),
  anySkillsLabel: [...document.querySelectorAll(".btn-label")].some((x) => x.textContent.trim() === "Skills"),
  directoryBtn: !!document.getElementById("open-directory"),
  settingsBtn: !!document.getElementById("open-settings"),
}))()`);
ok("sidebar has NO Skills button", nav.recipesBtn === false && nav.anySkillsLabel === false, nav);
ok("Directory + Settings buttons survive", nav.directoryBtn === true && nav.settingsBtn === true, nav);
await shot(ntp, "01-sidebar-no-skills.png");

// 2) Settings → Skills section live
await evl(ntp, `document.getElementById("open-settings").click()`);
await sleep(3500); // options iframe boots
const cid = await optionsContext(ntp);
let framesUrls: string[] | null = null;
try {
  const tree = await send("Page.getFrameTree", {}, ntp);
  const frames: any[] = [];
  const walk = (f: any) => { frames.push(f.frame); (f.childFrames ?? []).forEach(walk); };
  walk(tree.frameTree);
  framesUrls = frames.map((f) => f.url);
} catch { /* diagnostics only */ }
ok("options iframe booted", !!cid, framesUrls ?? [...contexts.values()]);
await evl(ntp, `(() => { const a = document.querySelector('a[data-section="skills"]'); a.click(); return true; })()`, cid);
await sleep(1200);
const section = await evalInOptions(ntp, `(() => {
  const sec = document.getElementById("skills");
  const r = sec.getBoundingClientRect();
  return {
    visible: r.height > 100,
    heading: sec.querySelector("h2")?.textContent ?? "",
    importForm: !!sec.querySelector(".import-url") && !!sec.querySelector(".import-btn"),
    listRows: sec.querySelectorAll(".recipe").length,
    empty: sec.querySelector(".skills-list .empty")?.textContent ?? null,
  };
})()`, cid);
ok("Skills section visible in Settings", section.visible === true, section);
ok("Skills section has the import form", section.importForm === true, section);
ok("Skills list renders built-in skills", section.listRows > 0, section);
await shot(ntp, "02-settings-skills-section.png");

// 3) a REAL import (local SKILL.md)
await evalInOptions(ntp, `(() => {
  const sec = document.getElementById("skills");
  sec.querySelector(".import-url").value = ${JSON.stringify(skillUrl)};
  sec.querySelector(".import-btn").click();
  return true;
})()`, cid);
await sleep(2500);
const imported = await evalInOptions(ntp, `(() => {
  const sec = document.getElementById("skills");
  const rows = [...sec.querySelectorAll(".recipe")].map((x) => x.querySelector("capability-row")?.getAttribute("name"));
  return {
    probeListed: rows.includes("Evidence Probe Skill"),
    status: sec.querySelector(".import-status")?.textContent ?? "",
    rows,
  };
})()`, cid);
ok("imported skill listed in Settings→Skills", imported.probeListed === true, imported);
await shot(ntp, "03-skill-imported.png");

// 4) an OLD skills deep link redirects into Settings' Skills section
const old = await openPage(`chrome-extension://${ext}/ntp/ntp.html#view=recipes%2Findex.html`);
await sleep(4000);
const redir = await evl(old, `(() => ({
  hash: location.hash,
  title: document.getElementById("view-title")?.textContent ?? "",
  frameHash: [...document.querySelectorAll("iframe[data-panel-path]")].map((f) => f.dataset.panelPath + (f.contentWindow?.location?.hash || "")),
}))()`);
ok("old skills deep link lands on Settings", String(redir.title) === "Settings", redir);
ok("redirect targets the skills section", JSON.stringify(redir).includes("#skills"), redir);
await shot(old, "04-old-deeplink-redirect.png");

await srv.shutdown();
try { proc.kill("SIGKILL"); } catch { /* dead */ }
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);

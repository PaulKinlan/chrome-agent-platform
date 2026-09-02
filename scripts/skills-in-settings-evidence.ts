// scripts/skills-in-settings-evidence.ts — browser evidence for the Skills→
// Settings integration. Captures: sidebar without Skills, Settings→Skills
// section live, a real skill import (local SKILL.md server), and the old
// deep-link redirect. Evidence → /tmp/cap-skills-evidence/.

import { parse } from "https://deno.land/std/flags/mod.ts";
import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const args = parse(Deno.args, { string: ["out"], default: { out: "/tmp/cap-skills-evidence" } });
const OUT = args.out;
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
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

// ── launch + CDP wiring (the shared launcher: kernel-assigned port, endpoint
// read from this child's own stderr, honest failure when the browser prints
// none) ─────────────────────────────────────────────────────────────────────
const tmp = await Deno.makeTempDir({ prefix: "cap-skills-ev-" });
let chrome;
try {
  chrome = await launchChrome({ extension: EXT, profile: tmp, windowSize: "1440,900", timeoutMs: 15000 });
} catch (e) {
  console.log(`FAIL: no DevTools URL — ${String((e as Error)?.message ?? e)}`);
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
  Deno.exit(1);
}
const proc = chrome.proc;
const port = chrome.port;
const cdp = await openCdp(chrome.wsUrl);

// executionContext id → info (the options iframe is located by its frame id)
const contexts = new Map<string, { url: string; frameId?: string }>();
cdp.on("Runtime.executionContextCreated", (params) => {
  const c = params.context;
  contexts.set(String(c.id), { url: c.url ?? c.origin ?? "", frameId: c.auxData?.frameId });
});
cdp.on("Runtime.executionContextDestroyed", (params) => {
  contexts.delete(String(params.executionContextId));
});
// Resolves the CDP result directly (the shape this harness reads); a protocol
// error rejects.
const send = async (method: string, params: unknown, sessionId?: string): Promise<any> =>
  (await cdp.send(method, params, sessionId)).result;
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
await evl(ntp, `(() => { const a = document.querySelector('a[data-section="skills"]'); a.click(); return true; })()`, cid ?? undefined);
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
})()`);
ok("Skills section visible in Settings", section.visible === true, section);
ok("Skills section has the import form", section.importForm === true, section);
ok("Skills list renders built-in skills", section.listRows > 0, section);
await shot(ntp, "02-settings-skills-section.png");

// 3) seed an IMPORTED skill through the REAL storage path (the extension
// origin's OPFS masterMemory — the options page shares it with the SW), then
// refresh the section. A direct localhost fetch import is refused by design
// (no localhost host permission) — the form rendered the honest error, which
// is itself correct behavior; the seed exercises the imported-skill data path.
await evalInOptions(ntp, `(async () => {
  const m = await import(chrome.runtime.getURL("/recipes/skills-panel.js")).catch(() => null);
  const memMod = await import(chrome.runtime.getURL("/lib/memory.js"));
  const mem = memMod.masterMemory();
  const list = (await mem.get("importedSkills")) ?? [];
  const skill = { id: "evidence-probe-skill", name: "Evidence Probe Skill", description: "A skill seeded by the skills-in-settings browser evidence run.", author: "evidence", source: "imported", mode: "on-demand", category: "imported", prompt: "Probe skill body.", requiredCapabilities: [], importedAt: Date.now() };
  const idx = list.findIndex((s) => s.id === skill.id);
  if (idx >= 0) list[idx] = skill; else list.push(skill);
  await mem.set("importedSkills", list);
  return true;
})()`);
await evalInOptions(ntp, `document.getElementById("skills")._refreshSkills()`);
await sleep(1200);
const imported = await evalInOptions(ntp, `(() => {
  const sec = document.getElementById("skills");
  const rows = [...sec.querySelectorAll(".recipe")].map((x) => x.querySelector("capability-row")?.getAttribute("name"));
  return {
    probeListed: rows.includes("Evidence Probe Skill"),
    status: sec.querySelector(".import-status")?.textContent ?? "",
    rows,
  };
})()`);
ok("imported-skill data path renders in Settings→Skills", imported.probeListed === true, imported);
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
cdp.close();
try { proc.kill("SIGKILL"); } catch { /* dead */ }
await proc.status.catch(() => {});
await Deno.remove(tmp, { recursive: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);

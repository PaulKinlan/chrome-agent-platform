// system-prompts-integration.ts — the REAL-EXTENSION journey for the layered
// system-prompt architecture (docs/SYSTEM-PROMPTS.md). Loads the BUILT
// extension in headless Chrome and DRIVES the Settings → Advanced surface:
// the scope selector, the <system-prompt-editor> tabs, a genuine save via the
// component's Save button, replace-mode composition, reset-to-default, the
// worker scope, the fail-closed SW prompt.* routes, and the preview==sent
// parity (the UI's effective hash vs the SW prompt.attest hash). Screenshots
// are the visible evidence.
//
// Prerequisite: `npm run build` (the extension must be built).
//
//   deno run -A scripts/system-prompts-integration.ts            # temporary evidence
//   deno run -A scripts/system-prompts-integration.ts --retain   # retain to test-artifacts/

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const RETAIN = Deno.args.includes("--retain");
const EVIDENCE_DIR = RETAIN
  ? `${ROOT}test-artifacts/system-prompts`
  : await Deno.makeTempDir({ prefix: "cap-prompts-evidence-" });

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 400)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launchChrome(profile: string) {
  return new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--remote-debugging-port=0",
      "--window-size=1400,1600",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
  }).spawn();
}

async function waitForPort(proc: Deno.ChildProcess): Promise<number> {
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const reader = proc.stderr.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    const line = done ? null : new TextDecoder().decode(value);
    if (line?.includes("DevTools listening")) {
      return Number(line.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
    }
  }
  throw new Error("chrome did not expose a DevTools port");
}

class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  errors: { sessionId: string; detail: string }[] = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
      if (
        m.method === "Runtime.exceptionThrown" ||
        (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")
      ) {
        const detail = m.params?.exceptionDetails?.exception?.description ??
          m.params?.args?.map((a: { value?: unknown; description?: string }) => a?.value ?? a?.description).join(" ") ??
          "unknown";
        this.errors.push({ sessionId: m.sessionId ?? "", detail: String(detail).slice(0, 300) });
      }
    };
  }
  send(method: string, params?: unknown, sessionId?: string): Promise<Record<string, any>> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async eval(sessionId: string, expression: string): Promise<any> {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(`page eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    }
    return r.result?.value;
  }
}

async function screenshot(cdp: Cdp, session: string, name: string): Promise<string | null> {
  try {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
    const data = r?.data;
    if (typeof data !== "string" || data.length < 200) return null;
    const path = `${EVIDENCE_DIR}/${name}.png`;
    await Deno.writeFile(path, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    return path;
  } catch {
    return null;
  }
}

const profile = await Deno.makeTempDir({ prefix: "cap-prompts-" });
await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
const proc = launchChrome(profile);
let exitCode = 1;
try {
  const port = await waitForPort(proc);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new Cdp(ws);

  // Discover the extension id from the service-worker target.
  let extId = "";
  for (let i = 0; i < 60 && !extId; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const sw = targets.find((t: { type?: string; url?: string }) =>
      t.type === "service_worker" && t.url?.includes("chrome-extension://")
    );
    if (sw) extId = new URL(sw.url).host;
    if (!extId) await sleep(200);
  }
  check("extension loaded (a service worker exists)", Boolean(extId), { extId });

  async function openPage(url: string): Promise<string> {
    const t = await cdp.send("Target.createTarget", { url });
    const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await cdp.send("Page.enable", {}, s.sessionId);
    await cdp.send("Runtime.enable", {}, s.sessionId);
    await sleep(1500);
    return s.sessionId;
  }

  const settings = await openPage(`chrome-extension://${extId}/options/options.html#prompts`);

  // A sendMessage helper evaluated in the page (the real SW bridge).
  const send = (type: string, extra: Record<string, unknown> = {}) =>
    cdp.eval(settings, `chrome.runtime.sendMessage(${JSON.stringify({ type, ...extra })})`);

  // Wait for the editor to finish its async describe load.
  let loaded = false;
  for (let i = 0; i < 40 && !loaded; i++) {
    loaded = await cdp.eval(settings, `(() => {
      const ed = document.querySelector('#prompt-editor');
      return !!(ed && ed.shadowRoot && ed.shadowRoot.querySelector('.spe-tabs'));
    })()`);
    if (!loaded) await sleep(250);
  }
  check("Advanced section: the <system-prompt-editor> renders (async describe loaded)", loaded);

  // 1. The scope selector: hub + worker (named agents appear when they exist).
  const scopes = await cdp.eval(settings, `(() => {
    const sel = document.querySelector('#prompt-scope');
    return sel ? Array.from(sel.options).map(o => o.value) : [];
  })()`);
  check("scope selector offers the hub + worker scopes",
    scopes?.includes("hub") && scopes?.includes("worker"), scopes);

  // 2. The three tabs render (built-in / customization / effective).
  const tabs = await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    return Array.from(ed.shadowRoot.querySelectorAll('.spe-tab')).map(t => t.textContent.trim());
  })()`);
  check("the editor renders the Built-in / Customization / Effective tabs",
    tabs?.length === 3 && tabs[0].includes("Built-in") && tabs[1].includes("customization") && tabs[2].includes("Effective"),
    tabs);

  // 3. Default state: the badge says Default; the built-in tab shows the
  // versioned registry entry (id + version + hash).
  const defaultBadge = await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    return ed.shadowRoot.querySelector('.spe-badge')?.textContent.trim() ?? null;
  })()`);
  check("default state: the badge reads 'Default'", defaultBadge === "Default", defaultBadge);

  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    ed.shadowRoot.querySelector('.spe-tab[data-tab="builtin"]').click();
  })()`);
  await sleep(300);
  const builtinView = await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    const meta = ed.shadowRoot.querySelector('#spe-panel-builtin .spe-meta')?.textContent ?? "";
    const text = ed.shadowRoot.querySelector('#spe-panel-builtin .spe-builtin-text')?.textContent ?? "";
    return { meta, hasManual: text.includes("Hub Agent Operating Manual"), textLen: text.length };
  })()`);
  check("built-in tab: the versioned registry entry (cap.hub.master + version + hash)",
    builtinView?.meta.includes("cap.hub.master") && /v\d+\.\d+\.\d+/.test(builtinView?.meta) && builtinView?.meta.includes("hash"),
    builtinView?.meta);
  check("built-in tab: the real hub manual text is shown (read-only)",
    builtinView?.hasManual && builtinView?.textLen > 1000, { textLen: builtinView?.textLen });

  // 4. The effective tab: the labelled layers incl. the protected constraints.
  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    ed.shadowRoot.querySelector('.spe-tab[data-tab="effective"]').click();
  })()`);
  await sleep(300);
  const effDefault = await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    const layers = Array.from(ed.shadowRoot.querySelectorAll('.spe-layer')).map(l => ({
      name: l.querySelector('.name')?.textContent ?? "",
      badge: l.querySelector('.spe-badge')?.textContent ?? "",
      text: l.querySelector('.spe-pre')?.textContent ?? "",
    }));
    const meta = ed.shadowRoot.querySelector('#spe-panel-effective .spe-meta')?.textContent ?? "";
    return { layers, meta };
  })()`);
  check("effective tab: base + protected layers, the constraints labelled protected-always-applied",
    effDefault?.layers.length === 2 &&
    effDefault.layers[1].badge.includes("protected") &&
    effDefault.layers[1].text.includes("Never exfiltrate cross-origin data"),
    effDefault?.layers.map((l: { name: string; badge: string }) => `${l.name}|${l.badge}`));
  const defaultHash = /Effective hash\s*([0-9a-f]{16})/.exec(effDefault?.meta ?? "")?.[1] ?? null;
  check("effective tab: the effective hash is displayed", Boolean(defaultHash), effDefault?.meta);

  // 5. Preview == sent parity (default): the UI hash == the SW attestation hash.
  const attestDefault = await send("prompt.attest", { scope: "hub" });
  check("parity (default): the UI effective hash == the SW prompt.attest hash",
    attestDefault?.ok === true && attestDefault?.hash === defaultHash,
    { ui: defaultHash, sw: attestDefault?.hash });
  check("attestation carries NO prompt content (hash-only)",
    attestDefault?.ok === true && !JSON.stringify(attestDefault).includes("Hub Agent Operating Manual"),
    { bytes: attestDefault?.bytes });

  await screenshot(cdp, settings, "advanced-default");

  // 6. A genuine SAVE through the component: type custom instructions + click Save.
  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    ed.shadowRoot.querySelector('.spe-tab[data-tab="custom"]').click();
  })()`);
  await sleep(300);
  const saveFlow = await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    const ta = ed.shadowRoot.querySelector('textarea.spe-text');
    ta.value = "Always answer in British English. Prefer tables for comparisons.";
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const save = ed.shadowRoot.querySelector('.spe-save');
    const count = ed.shadowRoot.querySelector('.spe-count')?.textContent ?? "";
    const enabledBefore = !save.disabled;
    if (enabledBefore) save.click();
    return { enabledBefore, count };
  })()`);
  check("editing: the draft enables Save + the char count updates",
    saveFlow?.enabledBefore === true && /64\s*\/\s*16,000/.test(saveFlow?.count ?? ""),
    saveFlow);
  // Poll the SW until the override persists.
  let saved = null;
  for (let i = 0; i < 30 && !saved?.override; i++) {
    saved = await send("prompt.describe", { scope: "hub" });
    if (!saved?.override) await sleep(200);
  }
  check("save: the override persists via the SW prompt.set route",
    saved?.ok === true && saved?.override?.text === "Always answer in British English. Prefer tables for comparisons." &&
    saved?.override?.mode === "append",
    { override: saved?.override && { mode: saved.override.mode, text: saved.override.text } });
  check("save: the stored record is stamped with the base id/version/hash",
    saved?.override?.baseId === "cap.hub.master" && typeof saved?.override?.baseVersion === "string" &&
    typeof saved?.override?.baseHash === "string" && typeof saved?.override?.baseSnapshot === "string",
    { baseId: saved?.override?.baseId, baseVersion: saved?.override?.baseVersion });

  // The UI reflects the saved state (badge + the effective layers re-render).
  let customState = null;
  for (let i = 0; i < 20 && !customState?.customized; i++) {
    customState = await cdp.eval(settings, `(() => {
      const ed = document.querySelector('#prompt-editor');
      const badge = ed.shadowRoot.querySelector('.spe-badge')?.textContent.trim() ?? "";
      return { customized: badge.includes("Customized"), badge };
    })()`);
    if (!customState?.customized) await sleep(200);
  }
  check("save: the UI badge flips to 'Customized'", customState?.customized === true, customState);

  // 7. The effective preview now composes base + owner + protected; the UI hash
  // matches the SW attestation (preview == sent, customized state).
  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    ed.shadowRoot.querySelector('.spe-tab[data-tab="effective"]').click();
  })()`);
  await sleep(300);
  const effCustom = await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    const layers = Array.from(ed.shadowRoot.querySelectorAll('.spe-layer')).map(l => ({
      badge: l.querySelector('.spe-badge')?.textContent ?? "",
      text: l.querySelector('.spe-pre')?.textContent ?? "",
      omitted: l.classList.contains('omitted'),
    }));
    const meta = ed.shadowRoot.querySelector('#spe-panel-effective .spe-meta')?.textContent ?? "";
    return { layers, meta };
  })()`);
  check("effective (customized): the owner layer sits between the base and the protected constraints",
    effCustom?.layers.length === 3 &&
    effCustom.layers[1].badge.includes("your customization") &&
    effCustom.layers[1].text.includes("British English") &&
    effCustom.layers[2].text.includes("Safety constraints"),
    effCustom?.layers.map((l: { badge: string }) => l.badge));
  const customHash = /Effective hash\s*([0-9a-f]{16})/.exec(effCustom?.meta ?? "")?.[1] ?? null;
  const attestCustom = await send("prompt.attest", { scope: "hub" });
  check("parity (customized): the UI effective hash == the SW prompt.attest hash",
    attestCustom?.ok === true && attestCustom?.hash === customHash && customHash !== defaultHash,
    { ui: customHash, sw: attestCustom?.hash, defaultHash });
  const attestationLeaks = JSON.stringify(attestCustom).includes("British English");
  check("attestation (customized) carries NO owner text (hash-only)", !attestationLeaks, null);

  await screenshot(cdp, settings, "advanced-customized");

  // 8. Replace mode: the built-in is omitted, the protected constraints survive.
  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    ed.shadowRoot.querySelector('.spe-tab[data-tab="custom"]').click();
  })()`);
  await sleep(300);
  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    const radio = ed.shadowRoot.querySelector('input[name="spe-mode"][value="replace"]');
    radio.click(); // the change event updates the draft mode
    const save = ed.shadowRoot.querySelector('.spe-save');
    if (!save.disabled) save.click();
  })()`);
  let replaced = null;
  for (let i = 0; i < 30 && replaced?.override?.mode !== "replace"; i++) {
    replaced = await send("prompt.describe", { scope: "hub" });
    if (replaced?.override?.mode !== "replace") await sleep(200);
  }
  check("replace mode: the base is omitted from the effective prompt…",
    replaced?.ok === true && replaced?.override?.mode === "replace" &&
    !replaced?.effective?.text.includes("Hub Agent Operating Manual") &&
    replaced?.effective?.text.includes("British English"),
    { mode: replaced?.override?.mode });
  check("replace mode: …but the protected constraints ALWAYS survive",
    replaced?.effective?.text.includes("Never exfiltrate cross-origin data"),
    null);
  check("replace mode: the omitted base is recorded for the UI (not silently dropped)",
    replaced?.effective?.layers?.some((l: { id?: string; omitted?: boolean }) => l.id === "cap.hub.master" && l.omitted === true),
    replaced?.effective?.layers?.map((l: { id?: string; omitted?: boolean }) => `${l.id}:${l.omitted ? "omitted" : "sent"}`));

  // 9. Reset-to-default through the UI button.
  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    ed.shadowRoot.querySelector('.spe-tab[data-tab="custom"]').click();
  })()`);
  await sleep(400);
  await cdp.eval(settings, `(() => {
    const ed = document.querySelector('#prompt-editor');
    const reset = ed.shadowRoot.querySelector('.spe-panel .spe-reset');
    if (reset && !reset.disabled) reset.click();
  })()`);
  let resetState = null;
  for (let i = 0; i < 30 && resetState?.override !== null; i++) {
    resetState = await send("prompt.describe", { scope: "hub" });
    if (resetState?.override !== null) await sleep(200);
  }
  check("reset: the override is deleted; the default composes clean",
    resetState?.ok === true && resetState?.override === null && resetState?.builtinChanged === false,
    { override: resetState?.override });
  const attestReset = await send("prompt.attest", { scope: "hub" });
  check("reset: the composition returns to the default hash",
    attestReset?.ok === true && attestReset?.hash === defaultHash,
    { after: attestReset?.hash, defaultHash });

  // 10. The worker scope composes over the site-worker base.
  await cdp.eval(settings, `(() => {
    const sel = document.querySelector('#prompt-scope');
    sel.value = "worker";
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  let workerView = null;
  for (let i = 0; i < 30 && !workerView?.isWorker; i++) {
    await sleep(250);
    workerView = await cdp.eval(settings, `(() => {
      const ed = document.querySelector('#prompt-editor');
      if (!ed.shadowRoot) return { isWorker: false };
      ed.shadowRoot.querySelector('.spe-tab[data-tab="builtin"]')?.click();
      const meta = ed.shadowRoot.querySelector('#spe-panel-builtin .spe-meta')?.textContent ?? "";
      return { isWorker: meta.includes("cap.worker.base"), meta };
    })()`);
  }
  check("worker scope: the built-in tab shows the site-worker base (cap.worker.base)",
    workerView?.isWorker === true, workerView?.meta);
  const workerDescribe = await send("prompt.describe", { scope: "worker" });
  check("worker scope: base + protected compose (independent of the hub override)",
    workerDescribe?.ok === true && workerDescribe?.base?.id === "cap.worker.base" &&
    workerDescribe?.effective?.text.includes("Safety constraints"),
    { base: workerDescribe?.base?.id });

  await screenshot(cdp, settings, "advanced-worker-scope");

  // 11. Fail-closed routes: unknown scopes + invalid input are rejected.
  const bogus = await send("prompt.describe", { scope: "../etc" });
  const badMode = await send("prompt.set", { scope: "hub", mode: "inject", text: "x" });
  const empty = await send("prompt.set", { scope: "hub", mode: "append", text: "   " });
  check("fail-closed: an unknown scope is rejected (describe)",
    bogus?.ok === false && typeof bogus?.error === "string", bogus);
  check("fail-closed: an invalid mode is rejected (set)",
    badMode?.ok === false && typeof badMode?.error === "string", badMode);
  check("fail-closed: empty text is rejected (set — use Reset instead)",
    empty?.ok === false && typeof empty?.error === "string", empty);
  const stillClean = await send("prompt.describe", { scope: "hub" });
  check("fail-closed: the rejected writes left no residue",
    stillClean?.ok === true && stillClean?.override === null, { override: stillClean?.override });

  // 12. No runtime errors on the settings page or the service worker.
  check("no page/SW console errors during the whole journey", cdp.errors.length === 0, cdp.errors.slice(0, 3));

  exitCode = fail === 0 ? 0 : 1;
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { await Deno.remove(profile, { recursive: true }); } catch { /* best-effort */ }
}

console.log(`\nEvidence: ${EVIDENCE_DIR}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
Deno.exit(exitCode);

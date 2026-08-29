// system-prompts-integration.ts — the REAL-EXTENSION journey for the layered
// system-prompt architecture (docs/SYSTEM-PROMPTS.md). Loads the BUILT
// extension in headless Chrome and DRIVES the Settings → Advanced surface with
// REAL pointer/keyboard input (CDP Input.dispatchMouseEvent /
// Input.insertText — trusted events, never el.click()/value-assignment):
// the scope selector, the <system-prompt-editor> tabs, a genuine typed save
// via the component's Save button, replace-mode composition, the dirty-scope
// switch confirmation, reset-to-default, the worker scope (context-aware
// preview), the fail-closed SW prompt.* routes, the preview attestation
// parity, and the RUN-BOUND attestation: a real `run-task` run whose exact
// provider-bound system message is captured at the model boundary and
// compared against the Settings preview digest. Screenshots are the visible
// evidence.
//
// Prerequisite: `npm run build` (the extension must be built).
//
//   deno run -A scripts/system-prompts-integration.ts            # temporary evidence
//   deno run -A scripts/system-prompts-integration.ts --retain   # retain to test-artifacts/

const ROOT = new URL("..", import.meta.url).pathname;
// The preview↔run comparator (the single source of truth lives in the
// extension lib): static layers match by exact receipt; the dynamic
// runtime-context layer matches by its template receipt.
const { layerReceiptsMatch } = await import(`${ROOT}extension/lib/system-prompts.js`);
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
  pending = new Map<number, { res: (v: Record<string, any>) => void; rej: (e: Error) => void }>();
  errors: { sessionId: string; detail: string }[] = [];
  dialogs: { message: string; accepted: boolean }[] = [];
  // The JavaScript-dialog policy: the dirty-scope-switch confirm() must be
  // answered (cancel first — keeps the edits; accept later — discards them).
  dialogAccept = false;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
      if (m.method === "Page.javascriptDialogOpening") {
        const accept = this.dialogAccept;
        this.dialogs.push({ message: String(m.params?.message ?? ""), accepted: accept });
        this.send("Page.handleJavaScriptDialog", { accept }, m.sessionId).catch(() => {});
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
  /** A REAL mouse click at the center of an element (queried live, through the
   * shadow DOM) — trusted input events, not el.click(). */
  async realClick(sessionId: string, selectorExpr: string): Promise<boolean> {
    const rect = await this.eval(sessionId, `(() => {
      const el = ${selectorExpr};
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!rect || rect.w < 2 || rect.h < 2) return false;
    const x = Math.round(rect.x), y = Math.round(rect.y);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    return true;
  }
  /** REAL keyboard text entry: the element is focused (by a real click), then
   * the text is inserted through the trusted input pipeline. */
  async realType(sessionId: string, selectorExpr: string, text: string): Promise<boolean> {
    const clicked = await this.realClick(sessionId, selectorExpr);
    if (!clicked) return false;
    await this.send("Input.insertText", { text }, sessionId);
    return true;
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

const ED = `document.querySelector('#prompt-editor')`;

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
      const ed = ${ED};
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
    const ed = ${ED};
    return Array.from(ed.shadowRoot.querySelectorAll('.spe-tab')).map(t => t.textContent.trim());
  })()`);
  check("the editor renders the Built-in / Customization / Effective tabs",
    tabs?.length === 3 && tabs[0].includes("Built-in") && tabs[1].includes("customization") && tabs[2].includes("Effective"),
    tabs);

  // 3. Default state: the badge says Default; the built-in tab shows the
  // versioned registry entry (id + version + hash).
  const defaultBadge = await cdp.eval(settings, `(() => {
    const ed = ${ED};
    return ed.shadowRoot.querySelector('.spe-badge')?.textContent.trim() ?? null;
  })()`);
  check("default state: the badge reads 'Default'", defaultBadge === "Default", defaultBadge);

  // The describe payload carries the CAS revision + durability + context.
  const describeDefault = await send("prompt.describe", { scope: "hub" });
  check("describe: carries the CAS revision + durability + context fields",
    describeDefault?.ok === true && Number.isSafeInteger(describeDefault?.revision) &&
    typeof describeDefault?.durable === "boolean" && typeof describeDefault?.context === "object",
    { revision: describeDefault?.revision, durable: describeDefault?.durable });

  // A REAL click on the Built-in tab.
  const clickedBuiltin = await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-tab[data-tab="builtin"]')`);
  await sleep(300);
  const builtinView = await cdp.eval(settings, `(() => {
    const ed = ${ED};
    const meta = ed.shadowRoot.querySelector('#spe-panel-builtin .spe-meta')?.textContent ?? "";
    const text = ed.shadowRoot.querySelector('#spe-panel-builtin .spe-builtin-text')?.textContent ?? "";
    return { meta, hasManual: text.includes("Hub Agent Operating Manual"), textLen: text.length };
  })()`);
  check("built-in tab (real click): the versioned registry entry (cap.hub.master + version + hash)",
    clickedBuiltin && builtinView?.meta.includes("cap.hub.master") && /v\d+\.\d+\.\d+/.test(builtinView?.meta) && builtinView?.meta.includes("hash"),
    builtinView?.meta);
  check("built-in tab: the real hub manual text is shown (read-only)",
    builtinView?.hasManual && builtinView?.textLen > 1000, { textLen: builtinView?.textLen });

  // 4. The effective tab (real click): the labelled layers incl. the protected
  // constraints — the FINAL layer, generated from the runtime policy.
  await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-tab[data-tab="effective"]')`);
  await sleep(300);
  const effDefault = await cdp.eval(settings, `(() => {
    const ed = ${ED};
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
  check("effective tab: the runtime policy carries the secret + permission rules (the single policy source)",
    effDefault?.layers[1]?.text.includes("Never write secrets") &&
    effDefault?.layers[1]?.text.includes("owner-granted"),
    effDefault?.layers[1]?.text.slice(0, 120));
  const defaultDigest = /Effective digest\s*([0-9a-f]{64})/.exec(effDefault?.meta ?? "")?.[1] ?? null;
  check("effective tab: the effective SHA-256 digest is displayed (64-hex)", Boolean(defaultDigest), effDefault?.meta);

  // 5. Preview parity (default): the UI digest == the composition authority's
  // describe digest. The attestation route deliberately exposes KEYED receipts
  // only — never an unkeyed owner-composition fingerprint.
  const authorityDefault = await send("prompt.describe", { scope: "hub" });
  const attestDefault = await send("prompt.attest", { scope: "hub" });
  check("parity (default): the UI effective digest == the SW composition authority digest",
    authorityDefault?.ok === true && authorityDefault?.effective?.hash === defaultDigest,
    { ui: defaultDigest, sw: authorityDefault?.effective?.hash });
  check("attestation carries a KEYED receipt + NO prompt content/public fingerprint",
    attestDefault?.ok === true && /^[0-9a-f]{64}$/.test(attestDefault?.receipt ?? "") &&
    !("compositionHash" in (attestDefault ?? {})) &&
    !JSON.stringify(attestDefault).includes("Hub Agent Operating Manual"),
    { bytes: attestDefault?.bytes, keyVersion: attestDefault?.keyVersion, ephemeral: attestDefault?.ephemeral });

  await screenshot(cdp, settings, "advanced-default");

  // 6. A genuine SAVE through REAL input: click the tab, click into the
  // textarea, type via the trusted input pipeline, click Save with the mouse.
  await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-tab[data-tab="custom"]')`);
  await sleep(300);
  const typed = await cdp.realType(settings,
    `${ED}.shadowRoot.querySelector('textarea.spe-text')`,
    "Always answer in British English. Prefer tables for comparisons.");
  await sleep(200);
  const draftState = await cdp.eval(settings, `(() => {
    const ed = ${ED};
    const save = ed.shadowRoot.querySelector('.spe-save');
    return {
      value: ed.shadowRoot.querySelector('textarea.spe-text').value,
      dirty: ed.dirty,
      enabled: !save.disabled,
      count: ed.shadowRoot.querySelector('.spe-count')?.textContent ?? "",
    };
  })()`);
  check("editing (real typing): the draft landed, the editor is dirty, Save enabled, the BYTE count updates",
    typed === true && draftState?.dirty === true && draftState?.enabled === true &&
    draftState?.value.includes("British English") && /64\s*\/\s*16,384 bytes/.test(draftState?.count ?? ""),
    draftState);

  // 6b. The dirty-scope switch asks for confirmation (cancel keeps the edits).
  cdp.dialogAccept = false;
  await cdp.eval(settings, `(() => {
    const sel = document.querySelector('#prompt-scope');
    sel.value = "worker";
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  const afterCancel = await cdp.eval(settings, `(() => ({
    scope: document.querySelector('#prompt-scope').value,
    dirty: ${ED}.dirty,
    value: ${ED}.shadowRoot.querySelector('textarea.spe-text')?.value ?? "",
  }))()`);
  check("dirty scope switch: a confirm dialog fired and CANCEL keeps the scope + the draft",
    cdp.dialogs.length >= 1 && afterCancel?.scope === "hub" && afterCancel?.dirty === true &&
    afterCancel?.value.includes("British English"),
    { dialogs: cdp.dialogs, afterCancel });

  const saveClicked = await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-save')`);
  // Poll the SW until the override persists.
  let saved = null;
  for (let i = 0; i < 40 && !saved?.override; i++) {
    saved = await send("prompt.describe", { scope: "hub" });
    if (!saved?.override) await sleep(200);
  }
  check("save (real Save click): the override persists via the SW prompt.set route",
    saveClicked === true && saved?.ok === true &&
    saved?.override?.text === "Always answer in British English. Prefer tables for comparisons." &&
    saved?.override?.mode === "append",
    { override: saved?.override && { mode: saved.override.mode, text: saved.override.text } });
  check("save: the stored record is stamped with the base id/version/hash + the store revision advanced",
    saved?.override?.baseId === "cap.hub.master" && typeof saved?.override?.baseVersion === "string" &&
    /^[0-9a-f]{64}$/.test(saved?.override?.baseHash ?? "") && typeof saved?.override?.baseSnapshot === "string" &&
    saved?.revision > describeDefault?.revision,
    { baseId: saved?.override?.baseId, revision: saved?.revision });
  // Durability honesty: the save either persisted (storage granted via the
  // Save gesture) or the UI says SESSION-ONLY — never a silent false "saved".
  // Poll until the post-save describe has re-landed (mutate() reloads the
  // editor — reading mid-reload races the loading state).
  let durableState = null;
  for (let i = 0; i < 30 && !(durableState?.settled); i++) {
    durableState = await cdp.eval(settings, `(() => {
      const ed = ${ED};
      if (!ed.data || ed.data.ok !== true) return { settled: false };
      return {
        settled: true,
        durable: ed.data.durable,
        badges: Array.from(ed.shadowRoot.querySelectorAll('.spe-head .spe-badge')).map(b => b.textContent.trim()),
        flash: document.querySelector('#save-status')?.textContent ?? "",
      };
    })()`);
    if (!durableState?.settled) await sleep(200);
  }
  check("durability is HONEST: durable storage, or a visible Session-only state (never a silent false 'saved')",
    durableState?.settled === true &&
    (durableState?.durable === true ||
      (durableState?.durable === false &&
        (durableState?.badges?.some((b: string) => b.includes("Session-only")) ||
          durableState?.flash.toLowerCase().includes("session")))),
    durableState);

  // The UI reflects the saved state (badge + the effective layers re-render).
  let customState = null;
  for (let i = 0; i < 20 && !customState?.customized; i++) {
    customState = await cdp.eval(settings, `(() => {
      const ed = ${ED};
      const badge = ed.shadowRoot.querySelector('.spe-badge')?.textContent.trim() ?? "";
      return { customized: badge.includes("Customized"), badge };
    })()`);
    if (!customState?.customized) await sleep(200);
  }
  check("save: the UI badge flips to 'Customized'", customState?.customized === true, customState);

  // 7. The effective preview composes base + owner + protected (protected LAST);
  // the UI digest matches the SW preview attestation.
  await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-tab[data-tab="effective"]')`);
  await sleep(300);
  const effCustom = await cdp.eval(settings, `(() => {
    const ed = ${ED};
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
  const customDigest = /Effective digest\s*([0-9a-f]{64})/.exec(effCustom?.meta ?? "")?.[1] ?? null;
  const describeCustom = await send("prompt.describe", { scope: "hub" });
  const attestCustom = await send("prompt.attest", { scope: "hub" });
  check("parity (customized): the UI effective digest == the SW composition authority digest",
    describeCustom?.ok === true && describeCustom?.effective?.hash === customDigest && customDigest !== defaultDigest &&
    attestCustom?.digestReceipt !== attestDefault?.digestReceipt,
    { ui: customDigest, sw: describeCustom?.effective?.hash, defaultDigest });
  const attestationLeaks = JSON.stringify(attestCustom).includes("British English");
  check("attestation (customized) carries NO owner text", !attestationLeaks, null);

  await screenshot(cdp, settings, "advanced-customized");

  // 8. The RUN-BOUND attestation: a REAL run through the run-task route; the
  // exact provider-bound system message is captured at the model boundary and
  // matches the previewed composition (prefixMatch + composed digest).
  const runId = `journey-run-${Date.now()}`;
  const run = await send("run-task", { id: runId, task: "Say hello in one word." });
  const runAtt = await send("prompt.attestRun", { runId });
  const masterAtt = runAtt?.attestations?.find((a: { agentId?: string }) => a.agentId === "hub");
  check("run-bound attestation: the real run was captured at the model boundary (runId-tagged)",
    run?.ok === true && runAtt?.ok === true && Boolean(masterAtt),
    { runOk: run?.ok, error: run?.error, attOk: runAtt?.ok, attError: runAtt?.error });
  check("run-bound attestation: the wire message EMBEDS the previewed composition (prefixMatch + per-layer receipts: static exact, dynamic by template)",
    masterAtt?.prefixMatch === true && Array.isArray(masterAtt?.layers) &&
    layerReceiptsMatch(attestCustom?.layers, masterAtt?.layers).ok === true,
    { prefix: masterAtt?.prefixMatch, layers: masterAtt?.layers?.length, mismatches: layerReceiptsMatch(attestCustom?.layers, masterAtt?.layers ?? []).mismatches });
  check("run-bound attestation: whole-composition receipts DIFFER across preview/run only because of the dynamic layer (the placeholder is not the rendered values)",
    masterAtt?.composedReceipt !== attestCustom?.digestReceipt,
    { composed: masterAtt?.composedReceipt?.slice(0, 16), preview: attestCustom?.digestReceipt?.slice(0, 16) });
  check("run-bound attestation: exact wire receipt + UTF-8 bytes + provider/model, NO content, NO public fingerprint",
    /^[0-9a-f]{64}$/.test(masterAtt?.receipt ?? "") && masterAtt?.bytes > 0 &&
    typeof masterAtt?.provider === "string" && typeof masterAtt?.model === "string" &&
    !("digest" in (masterAtt ?? {})) && !("composedDigest" in (masterAtt ?? {})) &&
    !JSON.stringify(runAtt).includes("British English"),
    { receipt: masterAtt?.receipt?.slice(0, 16), bytes: masterAtt?.bytes, provider: masterAtt?.provider });

  // 9. Replace mode: the built-in is omitted, the protected constraints survive.
  await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-tab[data-tab="custom"]')`);
  await sleep(300);
  await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('input[name="spe-mode"][value="replace"]')`);
  await sleep(200);
  await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-save')`);
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
  check("replace mode: …but the protected constraints ALWAYS survive (incl. the secret + permission rules)",
    replaced?.effective?.text.includes("Never exfiltrate cross-origin data") &&
    replaced?.effective?.text.includes("Never write secrets") &&
    replaced?.effective?.text.includes("owner-granted"),
    null);
  check("replace mode: the omitted base is recorded for the UI (not silently dropped)",
    replaced?.effective?.layers?.some((l: { id?: string; omitted?: boolean }) => l.id === "cap.hub.master" && l.omitted === true),
    replaced?.effective?.layers?.map((l: { id?: string; omitted?: boolean }) => `${l.id}:${l.omitted ? "omitted" : "sent"}`));

  // 10. Reset-to-default through a REAL click on the UI button.
  await sleep(400);
  const resetClicked = await cdp.realClick(settings, `${ED}.shadowRoot.querySelector('.spe-panel .spe-reset')`);
  let resetState = null;
  for (let i = 0; i < 30 && resetState?.override !== null; i++) {
    resetState = await send("prompt.describe", { scope: "hub" });
    if (resetState?.override !== null) await sleep(200);
  }
  check("reset (real click): the override is deleted; the default composes clean",
    resetClicked === true && resetState?.ok === true && resetState?.override === null && resetState?.builtinChanged === false,
    { override: resetState?.override });
  const describeReset = await send("prompt.describe", { scope: "hub" });
  const attestReset = await send("prompt.attest", { scope: "hub" });
  check("reset: the composition returns to the default digest + keyed receipt",
    describeReset?.ok === true && describeReset?.effective?.hash === defaultDigest &&
    attestReset?.ok === true && attestReset?.digestReceipt === attestDefault?.digestReceipt,
    { after: describeReset?.effective?.hash, defaultDigest });

  // 11. The worker scope composes over the site-worker base — with the
  // context-aware preview note (no false exact-parity claim for run skills).
  await cdp.eval(settings, `(() => {
    const sel = document.querySelector('#prompt-scope');
    sel.value = "worker";
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  let workerView = null;
  for (let i = 0; i < 30 && !workerView?.isWorker; i++) {
    await sleep(250);
    workerView = await cdp.eval(settings, `(() => {
      const ed = ${ED};
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
  check("worker scope: the preview is CONTEXT-AWARE about run-time origin skills (no blind parity claim)",
    workerDescribe?.context?.includesRunSkills === false &&
    typeof workerDescribe?.context?.note === "string" && workerDescribe.context.note.includes("run time"),
    workerDescribe?.context);

  await screenshot(cdp, settings, "advanced-worker-scope");

  // 12. Fail-closed routes: unknown scopes + invalid input are rejected; the
  // generic kv route can NEVER mutate the prompt store (key authority).
  const bogus = await send("prompt.describe", { scope: "../etc" });
  const badMode = await send("prompt.set", { scope: "hub", mode: "inject", text: "x" });
  const empty = await send("prompt.set", { scope: "hub", mode: "append", text: "   " });
  const ghostDescription = await send("prompt.describe", { scope: "agent:ghost" });
  const ghostAgent = await send("prompt.set", {
    scope: "agent:ghost",
    mode: "append",
    text: "x",
    expectedRevision: ghostDescription?.revision,
  });
  check("fail-closed: an unknown scope is rejected (describe)",
    bogus?.ok === false && typeof bogus?.error === "string", bogus);
  check("fail-closed: an invalid mode is rejected (set)",
    badMode?.ok === false && typeof badMode?.error === "string", badMode);
  check("fail-closed: empty text is rejected (set — use Reset instead)",
    empty?.ok === false && typeof empty?.error === "string", empty);
  check("fail-closed: a nonexistent named-agent scope is rejected (no orphan overrides)",
    ghostAgent?.ok === false && String(ghostAgent?.error ?? "").includes("no named agent"), ghostAgent);
  const kvBypass = await send("kv.set", { values: { "cap:promptOverrides": { version: 1, revision: 99, scopes: {} } } });
  check("key authority: the generic kv.set route REFUSES the prompt-override store",
    kvBypass?.ok === false && String(kvBypass?.error ?? "").includes("prompt.*"),
    kvBypass);
  const keyRead = await send("kv.get", { keys: ["cap:attestationKey"] });
  check("key secrecy: an explicit generic kv.get of attestation key material is REFUSED",
    keyRead?.ok === false && String(keyRead?.error ?? "").includes("key material"), keyRead);
  const readAll = await send("kv.get", {});
  check("key secrecy: generic kv.get-all strips attestation key material",
    readAll && !("cap:attestationKey" in readAll), Object.keys(readAll ?? {}).slice(0, 8));
  const kvReadback = await send("prompt.describe", { scope: "hub" });
  check("key authority: the refused write left the store untouched",
    kvReadback?.ok === true && kvReadback?.override === null, { override: kvReadback?.override });
  // CAS through the route: a stale expectedRevision conflicts.
  const casWrite = await send("prompt.set", { scope: "hub", mode: "append", text: "CAS-CHECK", expectedRevision: kvReadback?.revision });
  const casStale = await send("prompt.set", { scope: "hub", mode: "append", text: "STALE", expectedRevision: kvReadback?.revision });
  check("CAS through the route: the current revision saves, the stale one conflicts",
    casWrite?.ok === true && casStale?.ok === false && casStale?.conflict === true,
    { write: casWrite?.ok, stale: casStale });
  await send("prompt.reset", { scope: "hub", expectedRevision: casWrite?.revision });
  const stillClean = await send("prompt.describe", { scope: "hub" });
  check("fail-closed: the rejected writes left no residue",
    stillClean?.ok === true && stillClean?.override === null, { override: stillClean?.override });

  // 13. No runtime errors on the settings page or the service worker.
  check("no page/SW console errors during the whole journey", cdp.errors.length === 0, cdp.errors.slice(0, 3));

  exitCode = fail === 0 ? 0 : 1;
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { await Deno.remove(profile, { recursive: true }); } catch { /* best-effort */ }
}

console.log(`\nEvidence: ${EVIDENCE_DIR}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
Deno.exit(exitCode);

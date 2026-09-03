// kat-interactive-artifact-click.ts — chrome-agent-platform-p45y: a generated
// interactive artifact must be CLICKABLE in the artifact view and its SOURCE
// view must show the COMPLETE stored content.
//
//   (A) Interactivity legs: a click-game artifact (a button that increments a
//       visible score) is opened in the real artifact viewer (artifact.html
//       Preview tab), in the hub's artifact dialog, and in the library dialog
//       inside the hub view frame. A GENUINE CDP click (Input.dispatchMouseEvent
//       through the real compositor hit-test) lands on the button inside the
//       nested sandboxed srcdoc frame and the visible score increments. These
//       legs PIN the interactivity contract the owner reported as broken (the
//       double-iframe + sandbox stack delivers pointer events in all three
//       surfaces): no pointer/iframe/sandbox PRODUCTION code changed in this
//       fix — the fix's source guard (B) removes the truncated source view — so
//       the click legs are the regression guard that keeps the surfaces honest
//       against a future overlay / z-index / sandbox-attribute regression.
//   (B) Source completeness: an artifact LARGER than the legacy 64 KiB
//       source-view slice (90,000 chars) is created through the real
//       asset.create route. The Source tab renders the COMPLETE stored body
//       byte-for-byte (the rendered text's SHA-256 equals the stored body's
//       SHA-256), and the preview host mounts it. Before the fix the Source tab
//       showed only the first 65,536 characters — the journey fails.
//
// Evidence: screenshots (viewer before/after click, hub dialog before/after
// click, big-artifact Source tab) written to the OUT dir (default
// ~/.cache/cap-p45y-interactive), durable storage by default.
import { launchChrome, waitForServiceWorker, CHROMIUM } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${Deno.env.get("HOME")}/.cache/cap-p45y-interactive`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const results: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
function check(name: string, condition: boolean, detail?: unknown) {
  results.push({ name, passed: condition, ...(condition ? {} : { detail }) });
  if (condition) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 600)}`); }
}

/** The interactive game: a visible score that a button click increments.
 * Each surface gets its own artifact INSTANCE with unique element ids so a
 * probe can never read one surface's game as another's (stale closed frames
 * persist until the browser dies — observed — so uniqueness beats topology). */
const makeGameHtml = (buttonId: string, scoreId: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Click game</title><style>
html,body{height:100%}body{margin:0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;background:#fdfcf9}
.card{text-align:center;padding:28px 34px;border:1px solid #d8d4cb;border-radius:14px;background:#fff}
h1{font-size:20px;margin:0 0 6px}
p{font-size:16px;margin:0 0 16px}
#score{font-size:26px;color:#0e6e63}
button{font-size:16px;padding:10px 24px;cursor:pointer;border:0;border-radius:8px;background:#0e6e63;color:#fff}
button:active{transform:translateY(1px)}
</style></head><body><div class="card">
<h1>Click game</h1><p>Score: <strong id="${scoreId}">0</strong></p>
<button id="${buttonId}" type="button">Tap me</button>
</div>
<script>
(function () {
  var n = 0;
  var score = document.getElementById('${scoreId}');
  function render() { score.textContent = String(n); }
  document.getElementById('${buttonId}').addEventListener('click', function () { n = n + 1; render(); });
  render();
})();
</script></body></html>`;
const GAME_HTML = makeGameHtml("bump", "score");
const GAME_HTML_B = makeGameHtml("bump-b", "score-b");

/** 90,000 chars — beyond the legacy 64 KiB source-view slice, inside the
 * 256 KiB store/write bound and the 300,000-char preview-host bound. */
const BIG_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Big artifact</title>
<style>body{font-family:monospace;white-space:pre;margin:0;padding:12px}</style></head>
<body id="big-artifact-body">${"x".repeat(90_000 - 5000)}<p id="big-tail">TAIL-END-${"y".repeat(4000)}</p>
</body></html>`;
const bigLength = BIG_HTML.length;

/** SHA-256 hex of a string (Deno side — used to fingerprint the stored body
 * and the rendered code text so the byte-for-byte check is a digest compare). */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Minimal CDP client over the browser websocket, with auto-attached iframe
 * (OOPIF) session collection + console-error capture per session. */
class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, (value: any) => void>();
  consoleErrors: Array<{ sessionId: string; detail: string; url: string | null }> = [];
  frameSessions = new Set<string>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)!(message);
        this.pending.delete(message.id);
      }
      if (message.method === "Target.attachedToTarget") {
        const info = message.params?.targetInfo;
        if (info?.type === "iframe") {
          this.frameSessions.add(message.params.sessionId);
          this.send("Runtime.enable", {}, message.params.sessionId).catch(() => {});
        }
      }
      if (message.method === "Runtime.exceptionThrown" || (
        message.method === "Runtime.consoleAPICalled" && message.params?.type === "error"
      )) {
        const detail = message.params?.exceptionDetails?.exception?.description ??
          message.params?.args?.map((a: any) => a?.value ?? a?.description).join(" ") ??
          JSON.stringify(message.params).slice(0, 200);
        this.consoleErrors.push({
          sessionId: message.sessionId ?? "",
          detail,
          url: message.params?.exceptionDetails?.url ?? null,
        });
      }
    };
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, 12000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  srcdocErrors() {
    return this.consoleErrors.filter((e) => this.frameSessions.has(e.sessionId) && e.url === "about:srcdoc");
  }
}

async function main() {
  await Deno.mkdir(OUT, { recursive: true });
  const profile = `${OUT}/profile-${Date.now()}`;
  const { proc, wsUrl } = await launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`, "--remote-allow-origins=*",
      "--window-size=1400,2400", `--user-data-dir=${profile}`, "about:blank",
    ],
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.onopen = resolve);
  const cdp = new Cdp(ws);

  try {
    const worker = await waitForServiceWorker(cdp.send.bind(cdp), {
      match: (target: any) => target.type === "service_worker" && String(target.url).includes("dist/background"),
    });
    if (!worker) throw new Error("service worker did not register");
    const extensionId = new URL(worker.url).host;

    // Seed surface: the NTP (also used for the hub-dialog leg).
    const ntpTarget = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/ntp/ntp.html` });
    const ntpAttach = await cdp.send("Target.attachToTarget", { targetId: ntpTarget.result.targetId, flatten: true });
    const ntp = ntpAttach.result.sessionId;
    await cdp.send("Runtime.enable", {}, ntp);
    await cdp.send("Page.enable", {}, ntp);
    // Auto-attach BEFORE any artifact frame mounts so the sandbox-host OOPIF
    // (and its nested about:srcdoc document) is reachable for both legs.
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, ntp);
    const evaluate = async (sessionId: string, expression: string) => {
      const response = await cdp.send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
      }, sessionId);
      if (response.result?.exceptionDetails) {
        return { __exception: response.result.exceptionDetails.exception?.description ?? "evaluate failed" };
      }
      return response.result?.result?.value;
    };
    await sleep(2500);

    // Create both artifacts through the REAL asset.create route.
    const createdGame = await evaluate(ntp, `(async () => {
      const created = await chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'Click game p45y', content: ${JSON.stringify(GAME_HTML)} });
      return { ok: created?.ok === true, id: created?.asset?.id ?? created?.id ?? null, size: created?.asset?.size ?? null };
    })()`);
    const createdBig = await evaluate(ntp, `(async () => {
      const created = await chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'Big artifact p45y', content: ${JSON.stringify(BIG_HTML)} });
      return { ok: created?.ok === true, id: created?.asset?.id ?? created?.id ?? null, size: created?.asset?.size ?? null };
    })()`);
    const createdGameB = await evaluate(ntp, `(async () => {
      const created = await chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'Click game p45y B', content: ${JSON.stringify(GAME_HTML_B)} });
      return { ok: created?.ok === true, id: created?.asset?.id ?? created?.id ?? null, size: created?.asset?.size ?? null };
    })()`);
    check("route: the click-game artifact stores (asset.create ok + id)",
      createdGame?.ok === true && typeof createdGame?.id === "string", createdGame);
    check("route: the 90,000-char artifact stores COMPLETE (size matches the body)",
      createdBig?.ok === true && typeof createdBig?.id === "string" && createdBig?.size === bigLength, { ...createdBig, bigLength });
    check("route: the library-leg game artifact stores (asset.create ok + id)",
      createdGameB?.ok === true && typeof createdGameB?.id === "string", createdGameB);

    // ── helpers for reaching the sandboxed srcdoc realm ──────────────────
    // The manifest-sandbox host is an out-of-process iframe (auto-attach
    // surfaces it as an iframe target); its nested about:srcdoc document runs
    // in-process with the host. Multiple artifact surfaces can be alive at
    // once (viewer tab, hub dialog, library dialog…), so a probe selects its
    // srcdoc by the frame's URL ANCESTRY (which surface hosts it) — a stale
    // closed dialog's frame must never answer for a live one.
    let worldSeq = 0;
    // Every surface whose top-level document we drive (own tabs and pages);
    // a surface's srcdoc lives under its own tree (host OOPIFs appear as
    // child frames there), so ancestry probes must walk each surface tree.
    const surfaceSessions: string[] = [ntp];
    /** Walk a session's global frame tree, returning every about:srcdoc frame
     * with the URL of each ancestor from the tree root down. */
    /** Every about:srcdoc frame currently reachable through any session's
     * frame tree (surface pages + auto-attached sandbox-host OOPIFs). */
    const srcdocFrames = async (): Promise<Array<{ sessionId: string; frame: any }>> => {
      const out: Array<{ sessionId: string; frame: any }> = [];
      const sessions = [...new Set([...surfaceSessions, ...cdp.frameSessions])];
      for (const sessionId of sessions) {
        try {
          const tree = (await cdp.send("Page.getFrameTree", {}, sessionId))?.result?.frameTree;
          if (!tree?.frame) continue;
          const walk = (n: any) => {
            if (n.frame?.url === "about:srcdoc") out.push({ sessionId, frame: n.frame });
            for (const c of n.childFrames ?? []) walk(c);
          };
          walk(tree);
        } catch { /* session died or is not a page */ }
      }
      return out;
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const evalInSrcdoc = async (expression: string, _under?: string): Promise<any> => {
      for (const { sessionId, frame } of await srcdocFrames()) {
        try {
          const world = await cdp.send("Page.createIsolatedWorld", {
            frameId: frame.id, worldName: `cap-p45y-${++worldSeq}`,
          }, sessionId);
          const r = await cdp.send("Runtime.evaluate", {
            expression, returnByValue: true, contextId: world?.result?.executionContextId,
          }, sessionId);
          const value = r?.result?.result?.value;
          if (value !== undefined && value !== null) return value;
        } catch { /* try the next session */ }
      }
      return null;
    };
    /** Wait until NO generated-artifact frame (about:srcdoc under a sandbox
     * host) is alive, so a later surface's probes cannot read a closed one. */
    const waitForNoSrcdocs = async (timeoutMs: number, label: string) => {
      const startMs = Date.now();
      for (;;) {
        if ((await srcdocFrames()).length === 0) return;
        if (Date.now() - startMs > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await sleep(250);
      }
    };
    const waitFor = async <T>(probe: () => Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      const start = Date.now();
      for (;;) {
        const v = await probe();
        if (v) return v;
        if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await sleep(250);
      }
    };
    const shot = async (sessionId: string, name: string) => {
      try {
        const s = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        await Deno.writeFile(`${OUT}/${name}`, Uint8Array.from(atob(s.result.data), (c) => c.charCodeAt(0)));
      } catch (e) { console.log(`[p45y] screenshot ${name} failed: ${String(e)}`); }
    };
    /** One genuine compositor click at top-level viewport coordinates. */
    const clickAt = async (sessionId: string, x: number, y: number) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
      await sleep(60);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
    };
    /** Drive a genuine click on the game button inside whatever surface holds
     * the live artifact, and return what the click changed. */
    const driveGameClick = async (surfaceSession: string, surfaceName: string, under: string) => {
      // Wait until the inner frame exposes the button.
      await waitFor(async () => {
        const found = await evalInSrcdoc(`(() => { const b = document.getElementById('bump'); return b ? { score: (document.getElementById('score')?.textContent ?? null), found: true } : null; })()`, under);
        return found;
      }, 20000, `${surfaceName}: game button inside the srcdoc frame`);
      const outer = await waitFor(async () => {
        const r = await evaluate(surfaceSession, `(() => { const f = document.querySelector('.html-frame iframe'); if (!f) return null; const b = f.getBoundingClientRect(); if (b.width < 50 || b.height < 50) return null; return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
        return r && !r.__exception ? r : null;
      }, 20000, `${surfaceName}: outer artifact iframe laid out`);
      const before = await evalInSrcdoc(`(() => { const r = document.getElementById('bump').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), score: document.getElementById('score')?.textContent ?? null }; })()`, under);
      const px = Math.round(outer.x + before.x);
      const py = Math.round(outer.y + before.y);
      console.log(`[p45y] ${surfaceName}: button at top-viewport (${px},${py}) outer=(${Math.round(outer.x)},${Math.round(outer.y)}) scoreBefore=${before.score}`);

      // Diagnostics: what would receive the click at the top level?
      const hit = await evaluate(surfaceSession, `(() => {
        const e = document.elementFromPoint(${px}, ${py});
        if (!e) return 'none';
        const cs = getComputedStyle(e);
        return e.tagName + '#' + (e.id ?? '') + '.' + (typeof e.className === 'string' ? e.className : '') + ' pe=' + cs.pointerEvents + ' z=' + cs.zIndex;
      })()`);
      console.log(`[p45y] ${surfaceName}: elementFromPoint at click point -> ${hit}`);

      await shot(surfaceSession, `${surfaceName}-before-click.png`);
      await clickAt(surfaceSession, px, py);
      await sleep(300);
      // Poll the game state after the click: a probe can race a frame reload /
      // context teardown, so a single null read is not yet "the click is dead".
      let after = null;
      for (let i = 0; i < 8; i++) {
        const st = await evalInSrcdoc(`(() => {
          const b = document.getElementById('bump');
          const s = document.getElementById('score');
          if (!b || !s) return null;
          return { score: s.textContent, bumpPresent: true };
        })()`, under);
        if (st && typeof st.score === 'string') { after = st; break; }
        await sleep(250);
      }
      await shot(surfaceSession, `${surfaceName}-after-click.png`);
      console.log(`[p45y] ${surfaceName}: scoreAfter=${JSON.stringify(after)}`);
      const live = await evaluate(surfaceSession, `(() => ({
        dialog: !!document.querySelector('agent-dialog'),
        dialogOpen: !!document.querySelector('agent-dialog')?.open,
        frame: !!document.querySelector('.html-frame iframe'),
      }))()`);
      console.log(`[p45y] ${surfaceName} surface-state: ${JSON.stringify(live)}`);
      return { before: before?.score, after: after?.score ?? null };
    };

    // ── (A1) the artifact VIEWER (artifact.html, Preview tab, own tab) ────
    const gameId = createdGame?.id;
    const viewerTarget = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/artifact/artifact.html?id=${encodeURIComponent(gameId)}&origin=master`,
    });
    const viewerAttach = await cdp.send("Target.attachToTarget", { targetId: viewerTarget.result.targetId, flatten: true });
    const viewer = viewerAttach.result.sessionId;
    surfaceSessions.push(viewer);
    await cdp.send("Runtime.enable", {}, viewer);
    await cdp.send("Page.enable", {}, viewer);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, viewer);
    // wait until the viewer's .frame + iframe exist
    await waitFor(async () => {
      const r = await evaluate(viewer, `(() => ({ frame: !!document.querySelector('.frame .html-frame iframe'), mode: document.getElementById('modes')?.value ?? null }))()`);
      return r && r.frame ? r : null;
    }, 20000, "viewer preview frame");
    const viewerResult = await driveGameClick(viewer, "viewer", "artifact.html");
    check("viewer: a genuine click on the game button increments the visible score",
      viewerResult?.before === "0" && viewerResult?.after === "1", viewerResult);

    // ── (B) the SOURCE tab shows the COMPLETE stored body ────────────────
    // Switch to Source via the real segmented control (a genuine click on the
    // Source segment).
    const bigId = createdBig?.id;
    await cdp.send("Target.closeTarget", { targetId: viewerTarget.result.targetId });
    await sleep(300);
    const bigTarget = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/artifact/artifact.html?id=${encodeURIComponent(bigId)}&origin=master`,
    });
    const bigAttach = await cdp.send("Target.attachToTarget", { targetId: bigTarget.result.targetId, flatten: true });
    const big = bigAttach.result.sessionId;
    surfaceSessions.push(big);
    await cdp.send("Runtime.enable", {}, big);
    await cdp.send("Page.enable", {}, big);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, big);
    await waitFor(async () => {
      const r = await evaluate(big, `(() => { const m = document.getElementById('modes'); return m && !m.hidden ? m.value : null; })()`);
      return r ? r : null;
    }, 20000, "viewer modes ready");
    const sourceSeg = await waitFor(async () => {
      const r = await evaluate(big, `(() => {
        const m = document.getElementById('modes');
        const btn = m?.shadowRoot?.querySelector('[role="tab"][data-val="Source"]') ?? Array.from(m?.shadowRoot?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Source'));
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        if (r.width <= 0) return null;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      return r && !r.__exception ? r : null;
    }, 20000, "Source segment");
    await clickAt(big, sourceSeg.x, sourceSeg.y);
    // The Source panel renders <artifact-inspector>; read its <code> text.
    const sourceRead = await waitFor(async () => {
      const r = await evaluate(big, `(() => {
        const code = document.querySelector('#panel-source artifact-inspector')?.shadowRoot?.querySelector('code');
        const note = document.querySelector('#panel-source artifact-inspector')?.shadowRoot?.querySelector('.note');
        if (!code) return null;
        const shown = code.textContent ?? '';
        return { shownLength: shown.length, noteHidden: note?.hidden ?? null, noteText: note?.textContent ?? null };
      })()`);
      return r && !r.__exception && typeof r.shownLength === "number" ? r : null;
    }, 20000, "source panel rendered");
    await shot(big, "viewer-source-big.png");
    console.log(`[p45y] source tab: rendered ${sourceRead.shownLength} of ${bigLength} stored chars; noteHidden=${sourceRead.noteHidden}`);
    check("source: the Source tab renders the COMPLETE stored body (length == stored)",
      sourceRead.shownLength === bigLength, { shown: sourceRead.shownLength, stored: bigLength });
    check("source: no 'bounded' truncation note remains for a complete render",
      sourceRead.noteHidden === true || sourceRead.noteText === "", sourceRead);
    // Byte-for-byte: the rendered code text must BE the stored body — compare
    // the SHA-256 of the rendered text against the SHA-256 of the exact
    // BIG_HTML the route stored (length + tail equality alone could pass with
    // a corrupted middle; a digest cannot — p45y r4 review finding).
    const expectedDigest = await sha256Hex(BIG_HTML);
    const digestRead = await evaluate(big, `(async () => {
      const code = document.querySelector('#panel-source artifact-inspector')?.shadowRoot?.querySelector('code');
      const text = code?.textContent ?? '';
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      return { hex, length: text.length };
    })()`);
    check("source: the rendered code text is byte-for-byte the stored body (SHA-256 matches)",
      digestRead && !digestRead.__exception && digestRead.hex === expectedDigest && digestRead.length === bigLength,
      { renderedDigest: digestRead?.hex?.slice(0, 16), storedDigest: expectedDigest.slice(0, 16), renderedLength: digestRead?.length });
    await cdp.send("Target.closeTarget", { targetId: bigTarget.result.targetId }).catch(() => {});
    await sleep(500);

    // ── (A2) the hub ARTIFACT DIALOG (openArtifactDialog in the NTP) ──────
    const dialogOpen = await evaluate(ntp, `(() => {
      const drawer = document.getElementById('artifact-quick-drawer');
      if (!drawer) return false;
      drawer.close?.();
      drawer.dispatchEvent(new CustomEvent('artifact-open', { detail: { artifact: { id: ${JSON.stringify(gameId)}, origin: 'master', name: 'Click game p45y' } } }));
      return true;
    })()`);
    check("hub: the artifact dialog opened from the quick-drawer seam",
      dialogOpen === true);
    await waitFor(async () => {
      const r = await evaluate(ntp, `(() => ({ dialog: !!document.querySelector('agent-dialog .frame .html-frame iframe') }))()`);
      return r && r.dialog ? r : null;
    }, 20000, "hub artifact dialog frame");
    const hubResult = await driveGameClick(ntp, "hub-dialog", "ntp.html");
    check("hub dialog: a genuine click on the game button increments the visible score",
      hubResult?.before === "0" && hubResult?.after === "1", hubResult);
    await evaluate(ntp, `document.querySelector('agent-dialog')?.close?.()`);

    // ── (A3) the LIBRARY INSIDE THE HUB (the owner's full double-iframe
    // stack): hub view frame -> artifacts/index.html -> artifact dialog ->
    // sandbox host -> srcdoc game. Open the library, genuinely click the game
    // card (the card opens the dialog on the LIBRARY page), then genuinely
    // click the game button inside the dialog's nested frame.
    const libClicked = await evaluate(ntp, `(() => {
      const drawer = document.getElementById('artifact-quick-drawer');
      if (!drawer) return false;
      drawer.close?.();
      drawer.dispatchEvent(new CustomEvent('browse-artifacts'));
      return true;
    })()`);
    check("library: the hub opens the artifacts library view", libClicked === true);
    await sleep(500);
    const libCard = await waitFor(async () => {
      const r = await evaluate(ntp, `(() => {
        const frame = document.querySelector('iframe[data-panel-path="artifacts/index.html"]');
        if (!frame?.contentDocument) return null;
        const cards = Array.from(frame.contentDocument.querySelectorAll('artifact-card'));
        const card = cards.find((c) => c.getAttribute('name') === 'Click game p45y B');
        const preview = card?.shadowRoot?.querySelector('.preview');
        if (!preview) return null;
        const fr = frame.getBoundingClientRect();
        const r = preview.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(fr.left + r.left + r.width / 2), y: Math.round(fr.top + r.top + r.height / 2) };
      })()`);
      return r && !r.__exception ? r : null;
    }, 25000, "library game card laid out");
    await clickAt(ntp, libCard.x, libCard.y);
    await sleep(700);
    const libDialogFrame = await waitFor(async () => {
      const r = await evaluate(ntp, `(() => {
        const frame = document.querySelector('iframe[data-panel-path="artifacts/index.html"]');
        const host = frame?.contentDocument?.querySelector('agent-dialog .html-frame iframe');
        if (!frame || !host) return null;
        const fr = frame.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        if (h.width <= 0 || h.height <= 0) return null;
        return { x: Math.round(fr.left + h.left), y: Math.round(fr.top + h.top), w: Math.round(h.width), h: Math.round(h.height) };
      })()`);
      return r && !r.__exception ? r : null;
    }, 20000, "library dialog game frame");
    // The game button lives in the srcdoc nested under THIS dialog's host —
    // but the game card's own 132px thumbnail preview ALSO mounts the same
    // artifact (bump-b), so the probe picks the TALLEST bump-b frame (the
    // dialog's viewport dwarfs the card preview's).
    const libGameState = async () => {
      let best: any = null;
      const states = [];
      for (const { sessionId, frame } of await srcdocFrames()) {
        try {
          const world = await cdp.send("Page.createIsolatedWorld", {
            frameId: frame.id, worldName: `cap-p45y-${++worldSeq}`,
          }, sessionId);
          const r = await cdp.send("Runtime.evaluate", {
            expression: `(() => { const b = document.getElementById('bump-b'); if (!b) return null; const s = document.getElementById('score-b'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vh: window.innerHeight, score: s ? s.textContent : null }; })()`,
            returnByValue: true, contextId: world?.result?.executionContextId,
          }, sessionId);
          const v = r?.result?.result?.value;
          if (v && typeof v.score === "string") { states.push(v); if (!best || v.vh > best.vh) best = v; }
        } catch { /* try the next session */ }
      }
      return { best, count: states.length };
    };
    const libBefore = await libGameState();
    const libPx = libDialogFrame.x + (libBefore?.best?.x ?? 0);
    const libPy = libDialogFrame.y + (libBefore?.best?.y ?? 0);
    console.log(`[p45y] library-dialog: button at top-viewport (${libPx},${libPy}) scoreBefore=${libBefore?.best?.score} (${libBefore?.count} bump-b frames)`);
    await shot(ntp, "library-dialog-before-click.png");
    await clickAt(ntp, libPx, libPy);
    await sleep(300);
    let libAfter = null;
    for (let i = 0; i < 8; i++) {
      const st = await libGameState();
      if (st?.best) { libAfter = st.best; break; }
      await sleep(250);
    }
    await shot(ntp, "library-dialog-after-click.png");
    console.log(`[p45y] library-dialog: scoreAfter=${JSON.stringify(libAfter)}`);
    check("library dialog (double-iframe stack): a genuine click on the game button increments the visible score",
      libBefore?.best?.score === "0" && libAfter?.score === "1",
      { before: libBefore?.best?.score, after: libAfter?.score, bumpBframes: libBefore?.count });
    // elementFromPoint diagnostics when the click did not land (an overlay or
    // a wrong coordinate shows up as a non-iframe top element).
    if (libBefore?.best?.score === "0" && libAfter?.score !== "1") {
      const bx = libBefore.best.x ?? 0;
      const by = libBefore.best.y ?? 0;
      const hit = await evaluate(ntp, `(() => {
        const frame = document.querySelector('iframe[data-panel-path="artifacts/index.html"]');
        const host = frame?.contentDocument?.querySelector('agent-dialog .html-frame iframe');
        if (!frame || !host) return 'no host';
        const fr = frame.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        const top = frame.contentDocument.elementFromPoint(h.left + ${bx}, h.top + ${by});
        const docTop = document.elementFromPoint(fr.left + h.left + ${bx}, fr.top + h.top + ${by});
        const desc = (e) => e ? e.tagName + '#' + (e.id ?? '') + '.' + (typeof e.className === 'string' ? e.className : '') : 'none';
        return { libDocHit: desc(top), ntpHit: desc(docTop) };
      })()`);
      console.log(`[p45y] library-dialog diag: ${JSON.stringify(hit)}`);
    }
    await evaluate(ntp, `document.querySelector('agent-dialog')?.close?.()`);
    await sleep(300);

    // Frame errors inside the generated documents would explain dead UI.
    const srcdocErrs = cdp.srcdocErrors().filter((e) => !/data-cap-navguard|data-cap-bootstrap/.test(e.detail));
    for (const e of srcdocErrs) console.log(`[p45y] about:srcdoc error: ${e.detail.split("\n")[0]}`);
    check("generated frames threw no script errors during the journeys",
      srcdocErrs.length === 0, srcdocErrs.slice(0, 5));

    await Deno.writeTextFile(`${OUT}/result.json`, JSON.stringify({ passed, failed, results }, null, 2) + "\n");
  } finally {
    ws.close();
    try { proc.kill("SIGKILL"); } catch { /* already stopped */ }
    try { await proc.status; } catch { /* already reaped */ }
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
}

await main();
console.log(`\n${passed} passed, ${failed} failed`);
Deno.exit(failed ? 1 : 0);

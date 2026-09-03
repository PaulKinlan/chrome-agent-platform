// kat-artifact-preview.ts — real loaded-extension regression for an HTML
// create_asset result whose chat preview never received its staged content.
// It writes/reads the artifact through the real service-worker routes, renders
// the exact lazy-protocol result shape through <agent-conversation>, and checks
// both iframe layers through their own CDP execution contexts.
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${Deno.env.get("HOME")}/.cache/cap-artifact-preview`;
const CHROME = "/usr/lib/chromium/chromium";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
const results: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
function check(name: string, condition: boolean, detail?: unknown) {
  results.push({ name, passed: condition, ...(condition ? {} : { detail }) });
  if (condition) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

await Deno.mkdir(OUT, { recursive: true });
const profile = `${OUT}/profile-${Date.now()}`;
const { proc, wsUrl } = await launchChrome({
  binary: CHROME,
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`, "--remote-allow-origins=*",
    "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => ws.onopen = resolve);
let nextId = 0;
const pending = new Map<number, (value: any) => void>();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message);
    pending.delete(message.id);
  }
};
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<any>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

try {
  const worker = await waitForServiceWorker(send, {
    match: (target: any) => target.type === "service_worker" && String(target.url).includes("dist/background"),
  });
  if (!worker) throw new Error("service worker did not register");
  const extensionId = new URL(worker.url).host;
  const created = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/ntp/ntp.html` });
  const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
  const page = attached.result.sessionId;
  await send("Runtime.enable", {}, page);
  await send("Page.enable", {}, page);
  const evaluate = async (expression: string, contextId?: number) => {
    const response = await send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}),
    }, page);
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description ?? "Runtime.evaluate failed");
    }
    return response.result?.result?.value;
  };
  await sleep(2500);

  const routeReport = await evaluate(`(async () => {
    // The content carries an EXECUTION-ONLY marker: "Artifact preview delivered
    // 42" is produced at runtime (textContent += String(6*7)), so finding it in
    // a snapshot proves the nested frame ran the artifact's script — the stored
    // markup and the raw-payload copies never contain the finished string.
    const prefix = '<!doctype html><html><head><title>Preview proof</title></head><body><h1 id="artifact-preview-proof">Artifact preview delivered</h1><p>';
    const marker = '<script>var el=document.getElementById(\"artifact-preview-proof\");el.textContent=el.textContent+\" \"+String(6*7);<\/script>';
    const suffix = '</p></body></html>';
    const target = 21250;
    const content = prefix + 'x'.repeat(target - prefix.length - marker.length - suffix.length) + marker + suffix;
    const created = await chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'Artifact preview proof', content });
    const id = created?.asset?.id ?? created?.id ?? null;
    const read = id ? await chrome.runtime.sendMessage({ type: 'asset.get', origin: 'master', id }) : null;
    document.querySelector('main')?.remove();
    document.querySelectorAll('agent-conversation').forEach((n) => n.remove());
    const conversation = document.createElement('agent-conversation');
    conversation.style.cssText = 'display:block;padding:24px;max-width:1000px';
    document.body.prepend(conversation);
    conversation.appendTool({
      name: 'create_asset', status: 'done',
      args: { origin: 'master', type: 'html', name: 'Artifact preview proof', content },
      result: JSON.stringify({ modelContent: JSON.stringify({ ok: true, selectedTool: 'create_asset', result: created }) }),
    });
    // The product render path for an html create_asset result: the artifact
    // card that follows the tool card, whose preview loads FROM THE STORE
    // (appendArtifact → asset.get) — CAP-FB-20260830-THREAD-ARTIFACT-CARD-01.
    const asset = created?.asset ?? {};
    conversation.appendArtifact({ artifact: { ...asset, origin: asset.origin ?? 'master', id } });
    return {
      createOk: created?.ok === true,
      id,
      createdSize: asset?.size ?? created?.size ?? null,
      readOk: read?.ok === true,
      readId: read?.asset?.id ?? null,
      readSize: typeof read?.asset?.content === 'string' ? new TextEncoder().encode(read.asset.content).byteLength : null,
    };
  })()`);
  check("create_asset succeeds with an HTML body of 21,250 bytes",
    routeReport?.createOk === true && typeof routeReport?.id === "string" && routeReport?.createdSize === 21250, routeReport);
  check("asset.get returns the same stored artifact and complete body",
    routeReport?.readOk === true && routeReport?.readId === routeReport?.id && routeReport?.readSize === 21250, routeReport);

  await sleep(1800);
  // The host-mount chain (card render → artifact-preview host iframe load →
  // nonce postMessage → nested srcdoc mount) is async and can exceed a fixed
  // sleep on a loaded machine, so poll for the host iframe (bounded) instead
  // of asserting one instant.
  let bubbleState = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    bubbleState = await evaluate(`(() => {
      const frame = document.querySelector('agent-conversation artifact-card')?.shadowRoot?.querySelector('.html-frame iframe');
      return { frame: !!frame, src: frame?.getAttribute('src') ?? null };
    })()`);
    if (bubbleState?.frame === true) break;
    await sleep(500);
  }
  check("the artifact card renders the restricted artifact-preview host iframe",
    bubbleState?.frame === true && String(bubbleState?.src ?? "").endsWith("/sandbox/artifact-preview.html"), bubbleState);

  // Page.captureSnapshot serializes the complete frame tree, including the
  // sandbox-host OOPIF and its nested srcdoc document. It therefore proves the
  // observable payload crossed both iframe boundaries without bypassing either
  // boundary from the privileged page.
  const snapshot = await send("Page.captureSnapshot", { format: "mhtml" }, page);
  const mhtml = String(snapshot.result?.data ?? "");
  await Deno.writeTextFile(`${OUT}/artifact-preview.mhtml`, mhtml);
  const unwrappedMhtml = mhtml.replace(/=\r?\n/g, "");
  check("the preview host receives the staged payload and mounts its content iframe",
    unwrappedMhtml.includes('id=3D"artifact-preview-content"'), { snapshotBytes: mhtml.length });
  check("the nested generated document renders the stored HTML and runs its script (execution-only marker \"Artifact preview delivered 42\")",
    unwrappedMhtml.includes("Artifact preview delivered 42") &&
      unwrappedMhtml.includes('id=3D"artifact-preview-proof"'),
    { snapshotBytes: mhtml.length });

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, page);
  await Deno.writeFile(`${OUT}/artifact-preview.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  check("browser screenshot captured", shot.result.data.length > 1000, { bytes: shot.result.data.length });

  // np64 r5 review P1 #2: attest in a REAL loaded extension that a generated
  // artifact which touches an unavailable sandbox API gets the teaching error
  // and renders its exact message from the NESTED srcdoc frame (the
  // allow-scripts-only inner document mounted by artifact-preview.html) — not
  // just from serialized guard fragments or plain-object shims. The pass
  // marker "teach-ok-42" is assembled at runtime from fragments ('teach-ok-'
  // + String(40+2)) that never appear contiguously in the stored markup, the
  // guard script, or any raw-payload copy — the artifact only writes it when
  // the localStorage access threw EXACTLY the guard's teaching message (which
  // starts with the unavailable-phrase and carries the fix hint). The full
  // message is also rendered for the screenshot evidence.
  const teachingHtml =
    `<!doctype html><html><head><title>Sandbox teaching proof</title></head><body>` +
    `<h2>Sandbox teaching proof</h2><pre id="sandbox-teaching-proof">no-message-yet</pre>` +
    `<script>try { localStorage.getItem(\"score\"); } catch (e) { var m = (e && e.message) ? String(e.message) : String(e); ` +
    `var ok = m.indexOf('localStorage is unavailable inside sandboxed artifacts') === 0 && m.indexOf('keep state in a variable, or store it with the platform') > 0; ` +
    `var el = document.getElementById(\"sandbox-teaching-proof\"); ` +
    `el.textContent = ok ? 'teach-ok-' + String(40 + 2) + ' :: ' + m : 'teach-other :: ' + m; }<\/script>` +
    `</body></html>`;
  const teachingMounted = await evaluate(`(async () => {
    document.querySelectorAll('agent-conversation').forEach((n) => n.remove());
    const created = await chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'Sandbox teaching proof', content: ${JSON.stringify(teachingHtml)} });
    const id = created?.asset?.id ?? created?.id ?? null;
    const conversation = document.createElement('agent-conversation');
    conversation.style.cssText = 'display:block;padding:24px;max-width:1000px';
    document.body.prepend(conversation);
    conversation.appendTool({
      name: 'create_asset', status: 'done',
      args: { origin: 'master', type: 'html', name: 'Sandbox teaching proof', content: ${JSON.stringify(teachingHtml)} },
      result: JSON.stringify({ modelContent: JSON.stringify({ ok: true, selectedTool: 'create_asset', result: created }) }),
    });
    const asset = created?.asset ?? {};
    conversation.appendArtifact({ artifact: { ...asset, origin: asset.origin ?? 'master', id } });
    return { createOk: created?.ok === true, id };
  })()`);
  check("teaching artifact created through the real asset route",
    teachingMounted?.createOk === true, teachingMounted);
  // Poll (bounded) for the teaching message: mount latency on a loaded machine
  // can exceed a fixed sleep, and the message exists only after the guard ran
  // inside the nested srcdoc frame. The last snapshot is retained as evidence
  // either way.
  let teachingMhtml = "";
  let teachingFound = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const teachingSnapshot = await send("Page.captureSnapshot", { format: "mhtml" }, page);
    teachingMhtml = String(teachingSnapshot.result?.data ?? "");
    const unwrappedTeaching = teachingMhtml.replace(/=\r?\n/g, "");
    // teach-ok-42 appears only after the nested srcdoc frame ran the artifact's
    // script AND the localStorage access threw the guard's exact teaching
    // message (unavailable-phrase + fix hint). A missing guard, a late guard,
    // or a raw SecurityError all render "teach-other" instead.
    if (unwrappedTeaching.includes("teach-ok-42")) {
      teachingFound = true;
      break;
    }
    await sleep(1000);
  }
  await Deno.writeTextFile(`${OUT}/artifact-sandbox-teaching.mhtml`, teachingMhtml);
  const unwrappedTeaching = teachingMhtml.replace(/=\r?\n/g, "");
  check("the generated artifact's localStorage access throws the exact teaching message and renders it from the nested srcdoc frame",
    teachingFound &&
      unwrappedTeaching.includes("teach-ok-42") &&
      unwrappedTeaching.includes("localStorage is unavailable inside sandboxed artifacts - keep state in a variable, or store it with the platform"),
    { snapshotBytes: teachingMhtml.length });
  const teachingShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, page);
  await Deno.writeFile(`${OUT}/artifact-sandbox-teaching.png`, Uint8Array.from(atob(teachingShot.result.data), (c) => c.charCodeAt(0)));
  check("sandbox-teaching screenshot retained as evidence", teachingShot.result.data.length > 1000, { bytes: teachingShot.result.data.length });

  await Deno.writeTextFile(`${OUT}/result.json`, JSON.stringify({ passed, failed, results }, null, 2) + "\n");
} finally {
  ws.close();
  try { proc.kill("SIGKILL"); } catch { /* already stopped */ }
  try { await proc.status; } catch { /* already reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
Deno.exit(failed ? 1 : 0);

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
    const prefix = '<!doctype html><html><head><title>Preview proof</title></head><body><h1 id="artifact-preview-proof">Artifact preview delivered</h1><p>';
    const suffix = '</p></body></html>';
    const target = 21250;
    const content = prefix + 'x'.repeat(target - prefix.length - suffix.length) + suffix;
    const created = await chrome.runtime.sendMessage({ type: 'asset.create', origin: 'master', assetType: 'html', name: 'Artifact preview proof', content });
    const id = created?.asset?.id ?? created?.id ?? null;
    const read = id ? await chrome.runtime.sendMessage({ type: 'asset.get', origin: 'master', id }) : null;
    document.querySelector('main')?.remove();
    const conversation = document.createElement('agent-conversation');
    conversation.style.cssText = 'display:block;padding:24px;max-width:1000px';
    document.body.prepend(conversation);
    conversation.appendTool({
      name: 'create_asset', status: 'done',
      args: { origin: 'master', type: 'html', name: 'Artifact preview proof', content },
      result: JSON.stringify({ modelContent: JSON.stringify({ ok: true, selectedTool: 'create_asset', result: created }) }),
    });
    return {
      createOk: created?.ok === true,
      id,
      createdSize: created?.asset?.size ?? created?.size ?? null,
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
  const bubbleState = await evaluate(`(() => {
    const frame = document.querySelector('message-bubble')?.shadowRoot?.querySelector('.html-frame iframe');
    return { frame: !!frame, src: frame?.getAttribute('src') ?? null };
  })()`);
  check("chat renders the restricted artifact-preview host iframe",
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
  check("the nested generated document renders the stored HTML",
    unwrappedMhtml.includes('id=3D"artifact-preview-proof"') && unwrappedMhtml.includes("Artifact preview delivered"),
    { snapshotBytes: mhtml.length, hasProofId: mhtml.includes("artifact-preview-proof") });

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, page);
  await Deno.writeFile(`${OUT}/artifact-preview.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  check("browser screenshot captured", shot.result.data.length > 1000, { bytes: shot.result.data.length });
  await Deno.writeTextFile(`${OUT}/result.json`, JSON.stringify({ passed, failed, results }, null, 2) + "\n");
} finally {
  ws.close();
  try { proc.kill("SIGKILL"); } catch { /* already stopped */ }
  try { await proc.status; } catch { /* already reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
Deno.exit(failed ? 1 : 0);

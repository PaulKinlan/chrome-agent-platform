// Browser KAT (chrome-agent-platform-f62c): the extension's fingerprint
// surface is gone from arbitrary web pages.
//   1. fetch() and a <script> load of the artifact viewer resources FAIL from
//      a web page (the web_accessible_resources <all_urls> block is removed).
//   2. The MAIN-world detector hook is NOT the static known name — the page
//      cannot probe a fixed global; the per-document randomized hook IS
//      present (the detector still injects).
// deno run -A scripts/kat-fingerprint-surface.ts [extension-dir] [evidence-dir]
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-fingerprint-surface`;
await Deno.mkdir(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name} — ${JSON.stringify(detail)}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A plain web page — any origin the extension does not own.
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, () =>
  new Response("<!doctype html><title>fingerprint probe</title><body>plain page</body>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  }));
const PAGE = `http://127.0.0.1:${(server as any).addr.port}/page`;

const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile-${Date.now()}`,
    "about:blank",
  ],
});
try {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const messageId = ++id;
      pending.set(messageId, resolve);
      socket.send(JSON.stringify({ id: messageId, method, params, sessionId }));
    });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  };
  const evaluate = async (expression: string, sessionId: string) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (response?.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails));
    }
    return response?.result?.result?.value;
  };

  const worker = await waitForServiceWorker(send, {
    match: (target) => target.type === "service_worker" && target.url.includes("chrome-extension://"),
  });
  if (!worker) throw new Error("extension service worker did not register");
  const extensionId = new URL(worker.url).host;

  const created = await send("Target.createTarget", { url: PAGE });
  const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
  const session = attached.result.sessionId;
  await send("Runtime.enable", {}, session);
  await send("Page.enable", {}, session);
  await sleep(1500); // document_start content scripts have run

  // (1) The artifact viewer resources are NOT fetchable from the page.
  const probe = await evaluate(
    `(async () => {
      const id = ${JSON.stringify(extensionId)};
      const out = {};
      for (const res of ["artifact/artifact.html", "artifact/artifact.js", "sandbox/artifact-preview.html"]) {
        const url = "chrome-extension://" + id + "/" + res;
        try {
          const r = await fetch(url);
          out[res] = "fetch-ok:" + r.status;
        } catch (e) {
          out[res] = "blocked";
        }
      }
      return out;
    })()`,
    session,
  );
  for (const res of ["artifact/artifact.html", "artifact/artifact.js", "sandbox/artifact-preview.html"]) {
    check(`web page cannot fetch ${res}`, probe?.[res] === "blocked", probe);
  }

  // (1b) The subresource probe (the real fingerprint vector): a <script> load
  // of artifact.js must be BLOCKED — before the fix it loaded and executed.
  const scriptProbe = await evaluate(
    `(async () => {
      const id = ${JSON.stringify(extensionId)};
      return await new Promise((resolve) => {
        const s = document.createElement("script");
        s.onload = () => resolve("loaded");
        s.onerror = () => resolve("blocked");
        s.src = "chrome-extension://" + id + "/artifact/artifact.js";
        document.body.appendChild(s);
        setTimeout(() => resolve("timeout"), 5000);
      });
    })()`,
    session,
  );
  check("web page cannot <script>-load artifact/artifact.js", scriptProbe === "blocked", scriptProbe);

  // (2) The static detector hook name is GONE; the per-document randomized
  // hook IS installed (the passive detector still loads on every page).
  const hookProbe = await evaluate(
    `(() => ({
      static: typeof window.capWebmcpDetectBootstrap,
      legacy: typeof window.__capWebmcpDetectBootstrap,
      randomized: Object.getOwnPropertyNames(window)
        .filter((n) => /^capWebmcpDetectBootstrap_[0-9a-f]{32}$/.test(n)).length,
    }))()`,
    session,
  );
  check("the static detector hook name is absent", hookProbe?.static === "undefined" && hookProbe?.legacy === "undefined", hookProbe);
  check("the per-document randomized detector hook is installed", hookProbe?.randomized === 1, hookProbe);
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  await server.shutdown();
}

if (failed > 0) {
  console.error(`KAT fingerprint surface: ${passed} passed, ${failed} failed`);
  Deno.exit(1);
}
console.log(`KAT fingerprint surface: ${passed} passed, 0 failed`);

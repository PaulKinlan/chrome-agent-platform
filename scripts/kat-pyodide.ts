// kat-pyodide.ts — browser proof for the real python_execute load path.
//
// Loads the built extension, calls the production `python.execute` route from
// the hub page, and proves the returned stdout came from Pyodide execution.
// The JSON result and a screenshot are kept under the durable evidence root.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION = `${ROOT}extension`;
const EVIDENCE = durableDir(
  "kat-pyodide",
  new Date().toISOString().replaceAll(":", "-"),
);
const profile = durableDir(
  "chrome-profiles",
  `kat-pyodide-${crypto.randomUUID()}`,
);

class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error
        ? pending.reject(
          new Error(`CDP ${message.error.code}: ${message.error.message}`),
        )
        : pending.resolve(message);
    };
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 90_000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function evaluate(cdp: Cdp, sessionId: string, expression: string) {
  const message = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (message.result?.exceptionDetails) {
    throw new Error(
      `evaluation failed: ${
        JSON.stringify(message.result.exceptionDetails).slice(0, 600)
      }`,
    );
  }
  return message.result?.result?.value;
}

let browser: Deno.ChildProcess | null = null;
let socket: WebSocket | null = null;
let failed = false;

try {
  const launched = await launchChrome({ extension: EXTENSION, profile });
  browser = launched.proc;
  socket = new WebSocket(launched.wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = () => reject(new Error("DevTools socket failed to open"));
  });
  const cdp = new Cdp(socket);
  const serviceWorker = await waitForServiceWorker(cdp.send.bind(cdp), {
    timeoutMs: 30_000,
  });
  if (!serviceWorker) {
    throw new Error("extension service worker did not register");
  }
  const extensionId = new URL(serviceWorker.url).host;

  const target = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/ntp/ntp.html`,
  });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: target.result.targetId,
    flatten: true,
  });
  const pageSession = attached.result.sessionId as string;
  await cdp.send("Runtime.enable", {}, pageSession);
  await cdp.send("Page.enable", {}, pageSession);

  const result = await evaluate(
    cdp,
    pageSession,
    `chrome.runtime.sendMessage({
    type: "python.execute",
    code: "print(1+1)",
    stdin: ""
  })`,
  );
  const pass = result?.ok === true &&
    String(result?.stdout ?? "").trim() === "2";

  await Deno.writeTextFile(
    `${EVIDENCE}/result.json`,
    `${
      JSON.stringify(
        {
          pass,
          result,
          extensionId,
          commit: Deno.env.get("CAP_COMMIT") ?? null,
        },
        null,
        2,
      )
    }\n`,
  );

  await evaluate(
    cdp,
    pageSession,
    `(() => {
    const card = document.createElement("pre");
    card.id = "python-kat-result";
    card.textContent = ${
      JSON.stringify("python_execute({ code: 'print(1+1)' })\n")
    }
      + ${JSON.stringify(JSON.stringify(result, null, 2))};
    Object.assign(card.style, {
      position: "fixed", inset: "80px 80px auto", zIndex: "2147483647",
      padding: "28px", border: "2px solid currentColor", borderRadius: "12px",
      background: "Canvas", color: "CanvasText", font: "20px/1.5 monospace",
      whiteSpace: "pre-wrap"
    });
    document.body.append(card);
  })()`,
  );
  const screenshot = await cdp.send(
    "Page.captureScreenshot",
    { format: "png" },
    pageSession,
  );
  await Deno.writeFile(
    `${EVIDENCE}/python-execute.png`,
    Uint8Array.from(atob(screenshot.result.data), (char) => char.charCodeAt(0)),
  );

  console.log(
    `${
      pass ? "PASS" : "FAIL"
    }: python_execute print(1+1) returns executed stdout 2`,
  );
  console.log(JSON.stringify(result));
  console.log(`evidence: ${EVIDENCE}`);
  failed = !pass;
} catch (error) {
  failed = true;
  console.error(`FAIL: ${String((error as Error)?.message ?? error)}`);
  console.error(`evidence: ${EVIDENCE}`);
} finally {
  try {
    socket?.close();
  } catch { /* gone */ }
  try {
    browser?.kill("SIGKILL");
  } catch { /* gone */ }
  try {
    if (browser) await browser.status;
  } catch { /* gone */ }
  try {
    await Deno.remove(profile, { recursive: true });
  } catch { /* preserve no profile */ }
}

Deno.exit(failed ? 1 : 0);

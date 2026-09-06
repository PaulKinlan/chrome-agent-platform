// scripts/kat-webmcp-bistro.ts — real-browser KAT for chrome-agent-platform-l3vc:
// asserts WebMCP tool execution on GoogleChromeLabs French Bistro declarative demo
// accepts JSON-formatted string arguments for native WebMCP WebIDL compatibility.

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const BISTRO = "https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`);
  }
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  return await res.json();
}

async function evalIn(ws: WebSocket, sessionId: string, expr: string) {
  const id = Math.floor(Math.random() * 1e6);
  ws.send(JSON.stringify({
    id,
    sessionId,
    method: "Runtime.evaluate",
    params: { expression: expr, awaitPromise: true, returnByValue: true },
  }));
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.removeEventListener("message", handler);
        resolve(data.result?.result?.value);
      }
    };
    ws.addEventListener("message", handler);
  });
}

console.log("Launching Chromium with WebMCP feature...");
const chrome = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--enable-features=WebMCP",
  ],
});

try {
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  console.log("Navigating to French Bistro demo...");
  const tab = await fetchJson(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent(BISTRO)}`, { method: "PUT" });

  const id = Math.floor(Math.random() * 1e6);
  ws.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: tab.id, flatten: true } }));
  const session = await new Promise<string>((resolve) => {
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.removeEventListener("message", handler);
        resolve(data.result?.sessionId);
      }
    };
    ws.addEventListener("message", handler);
  });

  ws.send(JSON.stringify({ id: 101, sessionId: session, method: "Runtime.enable" }));
  await new Promise((r) => setTimeout(r, 2000));

  const mcInfo = await evalIn(ws, session, `({
    hasModelContext: !!document.modelContext,
    hasExecuteTool: typeof document.modelContext?.executeTool === "function",
    hasGetTools: typeof document.modelContext?.getTools === "function",
  })`);
  check("document.modelContext is present on page", mcInfo?.hasModelContext === true && mcInfo?.hasExecuteTool === true);

  const tools = await evalIn(ws, session, `document.modelContext.getTools().then(t => t.map(x => x.name))`);
  check("book_table_le_petit_bistro tool discovered", Array.isArray(tools) && tools.includes("book_table_le_petit_bistro"));

  // 1. FALSIFICATION: Object args trigger WebIDL DOMString coercion to '[object Object]', failing C++ JSONReader parse
  const objRes = await evalIn(ws, session, `(async () => {
    try {
      const [tool] = await document.modelContext.getTools();
      const res = await document.modelContext.executeTool(tool, { name: "Test User", phone: "1234567890", date: "2026-09-10", time: "19:00", guests: "2", seating: "Main Dining" });
      return { ok: true, res };
    } catch (err) {
      return { ok: false, error: err.name + ": " + err.message };
    }
  })()`);
  check("falsification: unstringified object args fail with JSON parse error in native WebMCP",
    objRes?.ok === false && /Failed to parse input string as JSON/i.test(objRes?.error ?? ""),
    objRes
  );

  // 2. SUCCESS: JSON-formatted string args pass WebIDL DOMString check, parse cleanly, and execute the booking
  const validBooking = {
    name: "Jean-Luc Picard",
    phone: "1234567890",
    date: "2026-09-10",
    time: "19:00",
    guests: "2",
    seating: "Main Dining",
  };
  const strRes = await evalIn(ws, session, `(async () => {
    try {
      const [tool] = await document.modelContext.getTools();
      const res = await document.modelContext.executeTool(tool, ${JSON.stringify(JSON.stringify(validBooking))});
      return { ok: true, res };
    } catch (err) {
      return { ok: false, error: err.name + ": " + err.message };
    }
  })()`);
  check("valid booking executes successfully with JSON string arguments",
    strRes?.ok === true && typeof strRes?.res === "string" && strRes.res.includes("We look forward to welcoming you"),
    strRes
  );

  ws.close();
} finally {
  chrome.proc.kill("SIGTERM");
  await chrome.proc.status;
}

console.log(`\nKAT Result: ${pass} passed, ${fail} failed.`);
if (fail > 0) Deno.exit(1);

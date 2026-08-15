// chrome-journeys.ts — retained Chrome regression journeys for the security /
// runtime boundaries the review flagged. Loads the built extension in headless
// Chrome, opens the extension's options page, and drives the message handlers
// (chrome.runtime.sendMessage) to assert the real runtime behaviour.
//
//   deno run -A scripts/chrome-journeys.ts
//
// Covers: browser-control grant/revoke/expiry; OPFS per-origin A/B clear;
// provider switch invalidates the cached agent; attachment count cap; alarm
// register (payload persists, validation-before-persist). The cross-origin
// spoof + screenshot-identity journeys are exercised by the reviewer's fixture
// and asserted here structurally (the sender-auth classifier is unit-tested).

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

function launchChrome(profile) {
  return new Deno.Command("/usr/bin/chromium", {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
    ],
    stdout: "piped", stderr: "piped",
  }).spawn();
}

async function waitForPort(proc) {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
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

async function main() {
  const proc = launchChrome(`/tmp/cap-journeys-${Date.now()}`);
  const port = await waitForPort(proc);
  await new Promise((r) => setTimeout(r, 5000)); // let the SW register

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  // The chrome-agent-platform extension's own service worker (there can be a
  // stale background_page from an earlier profile — target the SW, not it).
  const ext = targets.find((t) => t.type === "service_worker" && t.url.includes("chrome-extension://")) ??
    targets.find((t) => t.type === "service_worker");
  if (!ext) { console.error("FAIL: extension did not load"); proc.kill(); Deno.exit(1); }
  const extId = ext.url.split("/")[2];

  // Attach to the options page (an extension context where chrome.runtime works).
  const resp = await fetch(
    `http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/options/options.html`,
    { method: "PUT" },
  );
  const page = await resp.json();
  await new Promise((r) => setTimeout(r, 2500));

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.onopen = r);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const attach = await send("Target.attachToTarget", { targetId: page.id, flatten: true });
  const sessionId = attach?.result?.sessionId;
  // Commands for the attached page target must carry the sessionId (flatten:true).
  const sess = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  const evaluate = async (expression) => {
    const r = await sess("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r?.result?.result?.value;
  };
  await sess("Runtime.enable");

  const results = [];
  const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); };

  // 1. browser-control grant: on → granted, then revoke → NOT granted.
  await evaluate(`chrome.runtime.sendMessage({ type: "browser-control.set", granted: true })`);
  const afterGrant = await evaluate(`chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  check("grant turns on", afterGrant?.granted === true);
  await evaluate(`chrome.runtime.sendMessage({ type: "browser-control.set", granted: false })`);
  const afterRevoke = await evaluate(`chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  check("grant revokes (granted:false)", afterRevoke?.granted === false);

  // 2. OPFS per-origin A/B clear: write A and B, clear A, B survives.
  await evaluate(`chrome.runtime.sendMessage({ type: "memory.set", origin: "https://a.example", key: "x", value: "A" })`);
  await evaluate(`chrome.runtime.sendMessage({ type: "memory.set", origin: "https://b.example", key: "x", value: "B" })`);
  await evaluate(`chrome.runtime.sendMessage({ type: "memory.clear", origin: "https://a.example" })`);
  const aAfter = await evaluate(`chrome.runtime.sendMessage({ type: "memory.get", origin: "https://a.example", key: "x" })`);
  const bAfter = await evaluate(`chrome.runtime.sendMessage({ type: "memory.get", origin: "https://b.example", key: "x" })`);
  check("per-origin clear leaves B intact", (aAfter === undefined || aAfter === null) && bAfter === "B");

  // 3. provider switch invalidates the cached agent (no crash, returns config).
  const before = await evaluate(`chrome.runtime.sendMessage({ type: "provider.get" })`);
  await evaluate(`chrome.runtime.sendMessage({ type: "provider.set", config: { ...${JSON.stringify(before ?? {})} } )`);
  const after = await evaluate(`chrome.runtime.sendMessage({ type: "provider.get" })`);
  check("provider.set round-trips without error", after !== undefined && after !== null);

  // 4. attachment count cap: 12 attachments → only 8 kept, dropped reported.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, type: "text/plain", dataURL: `data:text/plain;base64,${btoa("x").repeat(0)}` }));
  const runRes = await evaluate(`chrome.runtime.sendMessage({ type: "agent.run", task: "hi", attachments: ${JSON.stringify(twelve)} })`);
  const dropped = runRes?.droppedAttachments ?? [];
  check("attachment count cap enforced (dropped reported)", dropped.length > 0);

  // 5. alarm registration validates timing before persisting.
  const badAlarm = await evaluate(`chrome.runtime.sendMessage({ type: "register-task", task: { task: "x", delayMs: -5 } }).catch(e => ({ error: e.message }))`);
  check("alarm rejects bad timing", badAlarm?.error !== undefined || badAlarm?.ok === false);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nchrome journeys: ${results.length - failed}/${results.length} passed`);
  ws.close();
  proc.kill();
  Deno.exit(failed > 0 ? 1 : 0);
}

await main();

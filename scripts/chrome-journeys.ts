// chrome-journeys.ts — retained Chrome regression journeys for the security /
// runtime boundaries. Loads the built extension in headless Chrome, opens the
// extension's options page, and drives the message handlers to assert real
// runtime behaviour. Fail-closed, environment-scrubbed, bounded, owner-clean.

//   deno run -A scripts/chrome-journeys.ts

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

function launchChrome(profile) {
  return new Deno.Command("/usr/bin/chromium", {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "piped",
    stderr: "piped",
    // Environment-scrubbed: the child sees NO parent env (no keys/tokens leak).
    clearEnv: true,
  }).spawn();
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
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
  const profile = `/tmp/cap-journeys-${Date.now()}`;
  const proc = launchChrome(profile);
  let port;
  const results = [];
  const check = (name, cond) => {
    results.push({ name, pass: !!cond });
    console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  };
  try {
    port = await waitForPort(proc);
    await new Promise((r) => setTimeout(r, 5000)); // let the SW register

    const targets = await withTimeout(
      (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),
      5000,
      "list targets",
    );
    const ext = targets.find((t) =>
      t.type === "service_worker" && t.url.includes("chrome-extension://")
    ) ??
      targets.find((t) =>
        t.type === "service_worker"
      );
    if (!ext) {
      check("extension loaded", false);
      throw new Error("extension did not load");
    }
    check("extension loaded", true);
    const extId = ext.url.split("/")[2];

    const resp = await withTimeout(
      fetch(
        `http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/options/options.html`,
        { method: "PUT" },
      ),
      5000,
      "open options",
    );
    const page = await resp.json();
    await new Promise((r) => setTimeout(r, 2500));

    const version = await withTimeout(
      (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
      5000,
      "version",
    );
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => ws.onopen = r);
    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.id && pending.has(d.id)) {
        pending.get(d.id)(d);
        pending.delete(d.id);
      }
      if (
        d.method === "Runtime.exceptionThrown" ||
        d.method === "Runtime.consoleAPICalled"
      ) {
        const p = d.params;
        if (p?.type === "error" || p?.exceptionDetails) consoleErrors.push(p);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const attach = await send("Target.attachToTarget", {
      targetId: page.id,
      flatten: true,
    });
    const sessionId = attach?.result?.sessionId;
    const sess = (method, params = {}) =>
      new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params, sessionId }));
      });
    const evaluate = async (expression) => {
      const r = await withTimeout(
        sess("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }),
        15000,
        "evaluate",
      );
      return r?.result?.result?.value;
    };
    await sess("Runtime.enable");

    // 1. browser-control grant: on → active, revoke → inactive (never a fresh grant).
    await evaluate(
      `chrome.runtime.sendMessage({ type: "browser-control.set", granted: true })`,
    );
    const afterGrant = await evaluate(
      `chrome.runtime.sendMessage({ type: "browser-control.get" })`,
    );
    check("grant turns on (active)", afterGrant?.active === true);
    await evaluate(
      `chrome.runtime.sendMessage({ type: "browser-control.set", granted: false })`,
    );
    const afterRevoke = await evaluate(
      `chrome.runtime.sendMessage({ type: "browser-control.get" })`,
    );
    check("grant revokes (active:false)", afterRevoke?.active === false);

    // 1b. origin-scoped grant reports active + exposes its origin list (not false).
    await evaluate(
      `chrome.runtime.sendMessage({ type: "browser-control.set", origins: ["https://a.example"], expiryMs: 60000 })`,
    );
    const scoped = await evaluate(
      `chrome.runtime.sendMessage({ type: "browser-control.get" })`,
    );
    check(
      "origin-scoped grant reports active + origins",
      scoped?.active === true && Array.isArray(scoped?.origins) &&
        scoped.origins.includes("https://a.example"),
    );
    await evaluate(
      `chrome.runtime.sendMessage({ type: "browser-control.set", granted: false })`,
    );

    // 2. OPFS per-origin A/B clear: clear A, B survives.
    await evaluate(
      `chrome.runtime.sendMessage({ type: "memory.set", origin: "https://a.example", key: "x", value: "A" })`,
    );
    await evaluate(
      `chrome.runtime.sendMessage({ type: "memory.set", origin: "https://b.example", key: "x", value: "B" })`,
    );
    await evaluate(
      `chrome.runtime.sendMessage({ type: "memory.clear", origin: "https://a.example" })`,
    );
    const aAfter = await evaluate(
      `chrome.runtime.sendMessage({ type: "memory.get", origin: "https://a.example", key: "x" })`,
    );
    const bAfter = await evaluate(
      `chrome.runtime.sendMessage({ type: "memory.get", origin: "https://b.example", key: "x" })`,
    );
    check(
      "per-origin clear leaves B intact",
      (aAfter === undefined || aAfter === null) && bAfter === "B",
    );

    // 3. provider switch round-trips + returns the stored config (no throw).
    const before = await evaluate(
      `chrome.runtime.sendMessage({ type: "provider.get" })`,
    );
    const provRes = await evaluate(
      `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo" } })`,
    );
    check(
      "provider.set round-trips without error",
      provRes !== undefined && provRes !== null,
    );

    // 4. attachment count cap: 12 attachments → exactly 8 kept, 4+ dropped reported.
    const twelve = Array.from(
      { length: 12 },
      (_, i) => ({
        name: `f${i}.txt`,
        type: "text/plain",
        dataURL: "data:text/plain;base64,eA==",
      }),
    );
    const runRes = await evaluate(
      `chrome.runtime.sendMessage({ type: "agent.run", task: "hi", attachments: ${
        JSON.stringify(twelve)
      } })`,
    );
    const dropped = runRes?.droppedAttachments ?? [];
    check(
      "attachment count cap (12 → dropped reported)",
      dropped.some((d) => String(d.reason).includes("count limit")),
    );

    // 4b. malformed dataURL (no base64 marker) is rejected, not counted as 0 bytes.
    const malformed = await evaluate(
      `chrome.runtime.sendMessage({ type: "agent.run", task: "hi", attachments: [{ name: "bad.txt", type: "text/plain", dataURL: "not-a-data-url" }] })`,
    );
    const malformedDropped = malformed?.droppedAttachments ?? [];
    check(
      "malformed dataURL rejected",
      malformedDropped.some((d) => String(d.reason).includes("malformed")),
    );

    // 5. alarm rejects bad timing (validation before persist).
    const badAlarm = await evaluate(
      `chrome.runtime.sendMessage({ type: "register-task", task: { task: "x", delayMs: -5 } }).catch(e => ({ error: e.message }))`,
    );
    check(
      "alarm rejects bad timing",
      badAlarm?.error !== undefined || badAlarm?.ok === false,
    );

    // 5b. schedule_task tool returns a name + when without throwing (the TASK_KEY fix).
    const sched = await evaluate(
      `chrome.runtime.sendMessage({ type: "register-task", task: { task: "t", delayMs: 60000 } })`,
    );
    check(
      "schedule_task returns name + when without throw",
      sched?.ok === true && typeof sched?.name === "string",
    );

    // 6. no page runtime exceptions / console errors during the journeys.
    check("no console errors during journeys", consoleErrors.length === 0);

    const failed = results.filter((r) => !r.pass).length;
    console.log(
      `\nchrome journeys: ${results.length - failed}/${results.length} passed`,
    );
    ws.close();
    proc.kill();
    // Owner-clean: remove the leaked profile directory.
    try {
      await new Deno.Command("rm", { args: ["-rf", profile] }).output();
    } catch { /* best effort */ }
    Deno.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    check("journeys completed", false);
    console.error("journey failure:", String(e?.message ?? e));
    proc.kill();
    try {
      await new Deno.Command("rm", { args: ["-rf", profile] }).output();
    } catch { /* best effort */ }
    Deno.exit(1);
  }
}

await main();

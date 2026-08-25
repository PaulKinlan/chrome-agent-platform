// scripts/data-memory-clear.ts — Settings → Data & memory "Clear" acceptance.
//
// Owner report (2026-08-25): "The clear button doesn't work in Data & memory
// (at least for site agents)." It did clear the store — but the memory explorer
// is where the keys and counts are shown, and the origin-row handler refreshed
// only the origin list, so the explorer kept displaying the cleared store's old
// key count. The button looked inert. The route also resolved to undefined, so
// Settings said "Cleared…" whether or not anything had happened.
//
// This runs on a CLEAN profile so it tests the button rather than whatever
// global state a long suite has accumulated. Run: npm run test:data-clear
const CHROMIUM = "/usr/bin/chromium";
const EXT = new URL("../extension", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const profile = await Deno.makeTempDir({ prefix: "cap-data-clear-" });
const proc = new Deno.Command(CHROMIUM, {
  args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--window-size=1400,1400",
    `--user-data-dir=${profile}`, "about:blank",
  ],
  stdout: "piped", stderr: "piped",
}).spawn();

let port = 0;
const reader = proc.stderr.getReader();
const decoder = new TextDecoder();
let buf = "";
for (let i = 0; i < 100 && !port; i++) {
  const { value } = await reader.read();
  buf += decoder.decode(value ?? new Uint8Array());
  const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
  if (m) port = Number(m[1]);
}
reader.releaseLock();

let sw = null;
for (let i = 0; i < 60 && !sw; i++) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  sw = targets.find((t: any) => t.type === "service_worker");
  if (!sw) await sleep(300);
}
if (!sw) throw new Error("extension service worker never appeared");
const extId = sw.url.split("/")[2];

async function openPage(path: string) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/${path}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const evaluate = (expression: string) =>
    new Promise<any>((resolve) => {
      const mid = ++id;
      const handler = (e: MessageEvent) => {
        const j = JSON.parse(e.data);
        if (j.id === mid) { ws.removeEventListener("message", handler); resolve(j.result?.result?.value); }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  const send = (payload: unknown) =>
    evaluate(`chrome.runtime.sendMessage(${JSON.stringify(payload)}).then((v) => JSON.stringify(v ?? null), (e) => JSON.stringify({ ok: false, error: String(e?.message ?? e) }))`)
      .then((raw) => { try { return JSON.parse(raw); } catch { return null; } });
  return { evaluate, send };
}

const ORIGIN = "https://clear-fixture.example";
try {
  // Seed from the hub so Settings is opened fresh afterwards, exactly as an
  // owner would meet it.
  const hub = await openPage("ntp/ntp.html");
  await sleep(2500);
  await hub.send({ type: "agent.create", origin: ORIGIN, name: "clear fixture" });
  for (const key of ["alpha", "bravo", "charlie"]) {
    await hub.send({ type: "memory.set", origin: ORIGIN, key, value: { v: key } });
  }
  const seeded = await hub.send({ type: "memory.list", origin: ORIGIN });
  check("fixture: the site agent has memory to clear", Array.isArray(seeded) && seeded.length >= 3, `keys=${JSON.stringify(seeded)}`);

  // The route must report an explicit result — it used to resolve to undefined,
  // leaving Settings nothing to check before claiming success.
  const masterClear = await hub.send({ type: "memory.clear", origin: "master" });
  check("memory.clear returns an explicit result", masterClear?.ok === true, JSON.stringify(masterClear));

  const settings = await openPage("options/options.html#data");
  await sleep(3000);

  const explorerText = () => settings.evaluate(
    `(document.getElementById('memory-explorer')?.textContent || '').replace(/\\s+/g, ' ')`,
  );
  const countFor = async () => {
    const text = String(await explorerText() ?? "");
    const m = text.match(/clear-fixture\.example \((\d+)\)/);
    return m ? Number(m[1]) : -1;
  };

  let before = -1;
  for (let i = 0; i < 30 && before <= 0; i++) {
    before = await countFor();
    if (before <= 0) await sleep(200);
  }
  check("Data & memory: the explorer lists the site agent with a key count", before > 0, `count=${before} text=${String(await explorerText()).slice(0, 160)}`);

  const rowPresent = await settings.evaluate(`(() => {
    const row = [...document.querySelectorAll('#origin-list .origin-row')]
      .find((r) => r.textContent.includes('clear-fixture.example'));
    return !!row?.querySelector('.clear-origin');
  })()`);
  check("Data & memory: the site agent row offers Clear", rowPresent === true);

  const clicked = await settings.evaluate(`(() => {
    const row = [...document.querySelectorAll('#origin-list .origin-row')]
      .find((r) => r.textContent.includes('clear-fixture.example'));
    const btn = row?.querySelector('.clear-origin');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check("Data & memory: clicked Clear with a real click", clicked === true);

  // THE REGRESSION: the explorer must reflect the clear without a reload.
  let after = -1;
  for (let i = 0; i < 30 && after !== 0; i++) {
    await sleep(200);
    after = await countFor();
  }
  check("Data & memory: the explorer refreshes to zero keys after Clear", after === 0, `before=${before} after=${after}`);

  const remaining = await settings.send({ type: "memory.list", origin: ORIGIN });
  check("Data & memory: the site store really is empty", Array.isArray(remaining) && remaining.length === 0, JSON.stringify(remaining));

  const flash = String(await settings.evaluate(`document.getElementById('save-status')?.textContent || ''`));
  check("Data & memory: the owner is told what happened", flash.includes("Cleared"), flash.slice(0, 80));

  // Clearing memory is NOT a revocation.
  const enrolled = await settings.send({ type: "agent.list" });
  check("Data & memory: Clear does not disenroll the site agent", Array.isArray(enrolled) && enrolled.includes(ORIGIN), JSON.stringify(enrolled));

  const errors = await settings.evaluate(`(window.__capErrors || []).length`);
  check("Data & memory: no page errors during the flow", !errors);
} finally {
  proc.kill();
  await proc.status;
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\ndata & memory clear: ${pass}/${pass + fail} passed`);
Deno.exit(fail ? 1 : 0);

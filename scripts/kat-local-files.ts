// Browser KAT for composer local-file attachments.
//
// Chrome's showDirectoryPicker() opens an operating-system picker. CDP's
// Page.setInterceptFileChooserDialog only handles <input type=file>; in
// headless Chrome the directory picker emits no fileChooserOpened event and
// closes the renderer. The one unautomated acceptance step is therefore:
// Settings → Local folders → Add folder → choose the fixture directory.
//
// Everything after that gesture is driven here through production code. The
// KAT uses a real, persisted OPFS FileSystemDirectoryHandle as the post-picker
// fixture (same handle interface + IndexedDB store), then types /files, searches
// a known file, selects it with Enter, and checks the text attachment bytes.
//
//   deno run -A scripts/kat-local-files.ts [extension-dir] [evidence-dir]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-local-files`;
const PROFILE = `${ROOT}.cache/kat-local-files-profile-${Date.now()}`;
const FIXTURE_NAME = "composer-local-file-known.txt";
const FIXTURE_TEXT = "Known local filesystem context from the browser KAT.";
const BINARY_FIXTURE_NAME = "mislabelled-binary.txt";
const BINARY_FIXTURE_BYTES = [0x66, 0x00, 0x80];
await Deno.mkdir(OUT, { recursive: true });

const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--window-size=1400,2400",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
});

let failed = false;
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!condition) failed = true;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve) => {
    const messageId = ++id;
    pending.set(messageId, resolve);
    ws.send(JSON.stringify({ id: messageId, method, params, sessionId }));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  };
  const evaluate = async (sessionId: string, expression: string) => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (reply?.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text);
    return reply?.result?.result?.value;
  };
  const screenshot = async (sessionId: string, name: string) => {
    const reply = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const data = reply?.result?.data;
    if (data) await Deno.writeFile(`${OUT}/${name}`, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  };
  const targetIds = new Map<string, string>();
  // Pages open the way scripts/chrome-journeys.ts opens them — a real tab
  // through the DevTools HTTP endpoint — so genuine CDP input lands on them
  // the same way it lands on the journeys' pages.
  const devtoolsPort = Number(new URL(wsUrl).port);
  const openPage = async (url: string) => {
    const created = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${url}`, { method: "PUT" }).then((r) => r.json());
    const attached = await send("Target.attachToTarget", { targetId: created.id, flatten: true });
    const sessionId = attached.result.sessionId;
    targetIds.set(sessionId, created.id);
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    await sleep(1200);
    return sessionId;
  };

  const sw = await waitForServiceWorker(send, {
    match: (target) => target.type === "service_worker" && target.url.includes("chrome-extension://"),
  });
  if (!sw) throw new Error("extension service worker did not register");
  const extensionId = new URL(sw.url).host;

  const options = await openPage(`chrome-extension://${extensionId}/options/options.html#local-folders`);
  const picker = await evaluate(options, `(() => ({
    supported: typeof showDirectoryPicker === "function",
    addFolderVisible: !!document.querySelector("#fs-add-directory-btn") && !document.querySelector("#fs-add-directory-btn").disabled,
    sectionVisible: getComputedStyle(document.querySelector("#local-folders")).display !== "none"
  }))()`);
  check("Settings exposes the supported Add folder grant flow", picker?.supported && picker?.addFolderVisible && picker?.sectionVisible, picker);
  await screenshot(options, "01-settings-local-folders.png");

  const hub = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html`);
  const seeded = await evaluate(hub, `(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("kat-local-folder", { create: true });
    const file = await dir.getFileHandle(${JSON.stringify(FIXTURE_NAME)}, { create: true });
    const writer = await file.createWritable();
    await writer.write(${JSON.stringify(FIXTURE_TEXT)});
    await writer.close();
    const binary = await dir.getFileHandle(${JSON.stringify(BINARY_FIXTURE_NAME)}, { create: true });
    const binaryWriter = await binary.createWritable();
    await binaryWriter.write(new Uint8Array(${JSON.stringify(BINARY_FIXTURE_BYTES)}));
    await binaryWriter.close();
    const { saveFsGrant } = await import(chrome.runtime.getURL("lib/fs-grants.js"));
    await saveFsGrant({ grantId: "fsg_composer_kat", handle: dir, name: "KAT local folder", kind: "directory", mode: "read" });
    return true;
  })()`);
  check("post-picker directory handle persists in the production IndexedDB store", seeded === true, seeded);

  const commandShown = await evaluate(hub, `(async () => {
    const composer = document.querySelector("#composer");
    const input = composer.querySelector("#task-input");
    input.value = "/files";
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 60; i++) {
      const labels = [...composer.querySelectorAll(".popup .item .lbl")].map((node) => node.textContent);
      if (labels.includes(${JSON.stringify(FIXTURE_NAME)})) return { labels, value: input.value };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { labels: [...composer.querySelectorAll(".popup .item .lbl")].map((node) => node.textContent), value: input.value };
  })()`);
  check("/files lists the known file", commandShown?.labels?.includes(FIXTURE_NAME), commandShown);
  await screenshot(hub, "02-files-search-results.png");
  await evaluate(hub, `(async () => {
    const composer = document.querySelector("#composer");
    const input = composer.querySelector("#task-input");
    input.value = "/files:composer-local-file-known";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 60; i++) {
      const labels = [...composer.querySelectorAll(".popup .item .lbl")].map((node) => node.textContent);
      if (labels.length === 1 && labels[0] === ${JSON.stringify(FIXTURE_NAME)}) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  })()`);

  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, hub);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, hub);
  const attached = await evaluate(hub, `(async () => {
    const composer = document.querySelector("#composer");
    for (let i = 0; i < 60; i++) {
      if (composer.attachments?.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const item = composer.attachments?.[0];
    const encoded = String(item?.dataURL || "").split(",")[1] || "";
    const bytes = encoded ? Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)) : new Uint8Array();
    return {
      count: composer.attachments?.length || 0,
      name: item?.name,
      size: item?.size,
      kind: item?.kind,
      text: new TextDecoder().decode(bytes),
      chip: composer.querySelector("#chips .chip span")?.textContent,
      status: composer.nextElementSibling?.textContent || composer.querySelector(".composer-status")?.textContent || ""
    };
  })()`);
  check("selecting the result attaches the file as bounded text context", attached?.count === 1 && attached?.name === FIXTURE_NAME && attached?.kind === "local-file" && attached?.text === FIXTURE_TEXT, attached);
  check("the pending attachment is visible in the composer", attached?.chip === FIXTURE_NAME, attached);
  await screenshot(hub, "03-file-attached.png");

  const binaryShown = await evaluate(hub, `(async () => {
    const composer = document.querySelector("#composer");
    const input = composer.querySelector("#task-input");
    input.value = "/files:mislabelled-binary";
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 60; i++) {
      const labels = [...composer.querySelectorAll(".popup .item .lbl")].map((node) => node.textContent);
      if (labels.includes(${JSON.stringify(BINARY_FIXTURE_NAME)})) return { labels };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { labels: [...composer.querySelectorAll(".popup .item .lbl")].map((node) => node.textContent) };
  })()`);
  check("/files substring search lists a mislabelled binary file", binaryShown?.labels?.includes(BINARY_FIXTURE_NAME), binaryShown);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, hub);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, hub);
  const binaryAttached = await evaluate(hub, `(async () => {
    const composer = document.querySelector("#composer");
    for (let i = 0; i < 60; i++) {
      if (composer.attachments?.some((item) => item.name === ${JSON.stringify(BINARY_FIXTURE_NAME)})) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const item = composer.attachments?.find((entry) => entry.name === ${JSON.stringify(BINARY_FIXTURE_NAME)});
    return { dataURL: item?.dataURL, kind: item?.kind, status: composer._status?.textContent || "" };
  })()`);
  check("mislabelled binary bytes degrade to a metadata-only reference", binaryAttached?.dataURL === "" && binaryAttached?.kind === "local-file" && binaryAttached?.status.includes("binary"), binaryAttached);
  await screenshot(hub, "04-binary-reference.png");

  // ── CAP-FB-20260831-FS-GRANT-TASK-USE-01: the file tools operate over the
  // granted DirectoryHandle in a task. Drive the REAL production grep path (the
  // fs-grant.grep message route → grepFsGrant over the persisted OPFS handle)
  // and prove it returns file+line matches, and that a bad grant is a bounded
  // JSON error — never a silent failure.
  const grep = await evaluate(hub, `(async () => {
    return await chrome.runtime.sendMessage({ type: "fs-grant.grep", grantId: "fsg_composer_kat", query: "filesystem" });
  })()`);
  check(
    "fs-grant.grep returns content matches with path + line over the granted DirectoryHandle",
    grep?.ok === true && Array.isArray(grep.matches) &&
      grep.matches.some((m: any) => typeof m.path === "string" && typeof m.line === "number" && /filesystem/i.test(String(m.text))),
    grep,
  );
  const grepMissing = await evaluate(hub, `(async () => {
    return await chrome.runtime.sendMessage({ type: "fs-grant.grep", grantId: "fsg_absent_grant", query: "x" });
  })()`);
  check(
    "fs-grant.grep on a missing grant returns a bounded JSON error (never silent)",
    grepMissing?.ok === false && typeof grepMissing.error === "string" && grepMissing.error.length > 0,
    grepMissing,
  );
  const grepBinarySkipped = await evaluate(hub, `(async () => {
    return await chrome.runtime.sendMessage({ type: "fs-grant.grep", grantId: "fsg_composer_kat", query: "" });
  })()`);
  check(
    "fs-grant.grep rejects an empty query with a structured error, not a silent no-op",
    grepBinarySkipped?.ok === false && grepBinarySkipped?.error === "fs_grep_empty_query",
    grepBinarySkipped,
  );
  await screenshot(hub, "05-fs-grant-grep.png");

  // ── CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01: the write round trip ──────
  // The demo model (@demo-write-file) reads a file in a READ/WRITE grant and
  // writes it back with a typo fixed, through the REAL lazy protocol. The
  // write pays the owner a diff-approval card (the on-disk bytes as "before");
  // Approve changes the file, Deny leaves its sha256 identical. The card's
  // Allow / Not now are GENUINE CDP clicks — a scripted click can never
  // resolve an approval (conversation.js requires isTrusted + userActivation).
  const RW_GRANT = "fsg_kat_rw";
  const RW_DIR = "kat-local-folder-rw";
  const TYPO_TEXT = "Known local filesytem context from the browser KAT.\n";
  const FIXED_TEXT = "Known local filesystem context from the browser KAT.\n";
  const MARKER = `@demo-write-file grant=${RW_GRANT} path=${FIXTURE_NAME}`;
  const seedRw = (session: string) => evaluate(session, `(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(${JSON.stringify(RW_DIR)}, { create: true });
    const file = await dir.getFileHandle(${JSON.stringify(FIXTURE_NAME)}, { create: true });
    const writer = await file.createWritable();
    await writer.write(${JSON.stringify(TYPO_TEXT)});
    await writer.close();
    const { saveFsGrant } = await import(chrome.runtime.getURL("lib/fs-grants.js"));
    await saveFsGrant({ grantId: ${JSON.stringify(RW_GRANT)}, handle: dir, name: "KAT writable folder", kind: "directory", mode: "readwrite" });
    return true;
  })()`);
  const readRw = (session: string) => evaluate(session, `(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(${JSON.stringify(RW_DIR)});
    const file = await dir.getFileHandle(${JSON.stringify(FIXTURE_NAME)});
    const buf = await (await file.getFile()).arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return { text: new TextDecoder().decode(buf), sha: Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("") };
  })()`);
  const boxExpr = (hostSel: string, innerSel?: string) => `(() => {
    const host = [...document.querySelectorAll(${JSON.stringify(hostSel)})].pop();
    const el = ${innerSel ? `host?.shadowRoot?.querySelector(${JSON.stringify(innerSel)})` : "host"};
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
  const clickGenuine = async (session: string, expression: string) => {
    const box = await evaluate(session, expression);
    if (!box || typeof box.x !== "number") return false;
    const pressed = await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, session);
    const released = await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, session);
    if (pressed?.error || released?.error) {
      console.log(`genuine click: CDP error ${JSON.stringify(pressed?.error ?? released?.error)}`);
      return false;
    }
    const activation = await evaluate(session, "({ active: navigator.userActivation?.isActive === true, focus: document.hasFocus(), visible: document.visibilityState })").catch(() => null);
    console.log(`genuine click at (${Math.round(box.x)}, ${Math.round(box.y)}) -> ${JSON.stringify(activation)}`);
    return true;
  };
  const CARD_PROBE = `(() => {
    const card = [...document.querySelectorAll('#thread-conversation approval-card')].find((x) => (x.getAttribute('state') || 'pending') === 'pending');
    if (!card) return null;
    const sr = card.shadowRoot;
    const title = sr ? (sr.querySelector('.title')?.textContent ?? '') : '';
    const body = sr ? (sr.querySelector('.body')?.textContent ?? '') : '';
    const diff = card.querySelector('artifact-diff');
    const dr = diff ? diff.shadowRoot : null;
    const addRows = dr ? [...dr.querySelectorAll('.tx[data-kind="add"]')].map((n) => n.textContent) : [];
    const delRows = dr ? [...dr.querySelectorAll('.tx[data-kind="del"]')].map((n) => n.textContent) : [];
    return { title, body, hasDiff: !!diff, addRows, delRows };
  })()`;
  const THREAD_TEXT = `(() => {
    let out = "";
    const walk = (n) => { if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.childNodes) { if (c.nodeType === 3) out += c.textContent + " "; else if (c.nodeType === 1 && c.tagName !== "STYLE" && c.tagName !== "SCRIPT") walk(c); } };
    const conv = document.querySelector('#thread-conversation');
    if (conv) walk(conv);
    return out;
  })()`;
  const waitForCard = async (session: string, deadlineMs: number) => {
    const t0 = Date.now();
    let probe: any = null;
    while (Date.now() - t0 < deadlineMs) {
      probe = await evaluate(session, CARD_PROBE).catch(() => null);
      if (probe && probe.hasDiff && probe.addRows.length > 0) return probe;
      await sleep(250);
    }
    return probe;
  };
  const waitForFinal = async (session: string, deadlineMs: number) => {
    const t0 = Date.now();
    let text = "";
    while (Date.now() - t0 < deadlineMs) {
      text = String(await evaluate(session, THREAD_TEXT).catch(() => ""));
      if (/\[demo model\] File write (complete|NOT performed)/.test(text)) break;
      await sleep(250);
    }
    const m = /\[demo model\] File write[^\n]*?(?=\s{2,}|$)/.exec(text);
    return m ? m[0].trim() : text.slice(-400);
  };
  const composerHolds = (session: string) => evaluate(session, `document.querySelector("#composer #task-input")?.value ?? ""`);
  const runMarker = async (session: string) => {
    const targetId = targetIds.get(session);
    if (targetId) await send("Target.activateTarget", { targetId });
    await send("Page.bringToFront", {}, session);
    await evaluate(session, `(() => {
      const input = document.querySelector("#composer #task-input");
      input.value = ${JSON.stringify(MARKER)};
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    // The send itself needs no gesture (the APPROVAL does — that click below
    // is always genuine). Prefer the real button; fall back to a genuine
    // Enter, then to the composer's own send, and say which path fired.
    const clicked = await clickGenuine(session, boxExpr("#composer #run-task"));
    await sleep(400);
    if (clicked && (await composerHolds(session)) === "") return "click";
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, session);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, session);
    await sleep(400);
    if ((await composerHolds(session)) === "") return "enter";
    await evaluate(session, `document.querySelector("#composer")._send()`);
    await sleep(400);
    return (await composerHolds(session)) === "" ? "composer._send()" : "";
  };

  // The marker demo model sits behind the developer flag (a default profile
  // runs the local assistant instead); the provider route is Settings-only,
  // so it is sent from the Settings page. provider.set replies with the
  // redacted config, not an { ok } envelope.
  const devFlag = await evaluate(hub, `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:developerFeatures": true } }).then((v) => v, (e) => ({ ok: false, error: String(e?.message ?? e) }))`);
  check("developer flag: the marker demo model is enabled for the write run", devFlag?.ok === true, devFlag);
  const providerSet = await evaluate(options, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo", apiKey: "" } }).then((v) => v, (e) => ({ ok: false, error: String(e?.message ?? e) }))`);
  check("Settings: the demo provider is set for the scripted write run", providerSet?.provider === "demo", providerSet);

  // Run 1 — Approve.
  const hubWrite = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html`);
  check("a read/write grant over a persisted OPFS DirectoryHandle is seeded", (await seedRw(hubWrite)) === true);
  const beforeApprove = await readRw(hubWrite);
  const started1 = await runMarker(hubWrite);
  console.log(`write journey: run 1 started via ${started1 || "nothing"}`);
  check("run 1 started from the real composer", started1 !== "", started1);
  const card = await waitForCard(hubWrite, 30000);
  if (!card) {
    const diag = await evaluate(hubWrite, `(() => ({
      status: [...document.querySelectorAll('conversation-run-status')].map((x) => ({ state: x.getAttribute('state'), label: ((x.shadowRoot ?? x).querySelector('.label')?.textContent ?? '').trim() })),
      composerValue: document.querySelector('#composer #task-input')?.value ?? null,
      bubbles: document.querySelectorAll('#thread-conversation message-bubble').length,
      banner: document.querySelector('#provider-banner, .provider-banner')?.textContent?.trim() ?? null,
    }))()`).catch((e) => ({ error: String(e) }));
    console.log(`write journey: no card — diag = ${JSON.stringify(diag)?.slice(0, 600)}`);
    console.log(`write journey: thread text = ${String(await evaluate(hubWrite, THREAD_TEXT).catch(() => "")).replace(/\s+/g, " ").slice(0, 600)}`);
  }
  console.log(`write journey: approval card = ${JSON.stringify(card)?.slice(0, 500)}`);
  check(
    "typo fix produces a diff approval card naming the file: 'Write composer-local-file-known.txt? (+1 -1)'",
    !!card && card.title === `Write ${FIXTURE_NAME}? (+1 -1)`,
    card,
  );
  check(
    "the card shows the on-disk line as '-' (filesytem) and the proposed line as '+' (filesystem) before the decision",
    !!card && card.delRows.some((t: string) => /filesytem/.test(t)) && card.addRows.some((t: string) => /filesystem/.test(t)),
    card,
  );
  check("the file is untouched while the card is pending", (await readRw(hubWrite)).sha === beforeApprove.sha);
  await screenshot(hubWrite, "local-file-write-approval.png");
  check("Approve clicked with a genuine gesture", await clickGenuine(hubWrite, boxExpr("#thread-conversation approval-card", ".approve")));
  const finalApprove = await waitForFinal(hubWrite, 30000);
  const afterApprove = await readRw(hubWrite);
  console.log(`write journey (approve): final = ${finalApprove}`);
  check("Approve changes the file: the typo is fixed on disk", afterApprove.text === FIXED_TEXT && afterApprove.sha !== beforeApprove.sha, afterApprove);
  check("the agent reports the approved write honestly (+1 -1)", /File write complete: .*\(\+1 -1\)/.test(finalApprove), finalApprove);
  await screenshot(hubWrite, "07-local-file-write-approved.png");

  // Run 2 — Deny (the file is reset to the typo so the card is the same diff).
  const hubDeny = await openPage(`chrome-extension://${extensionId}/ntp/ntp.html`);
  await seedRw(hubDeny);
  const beforeDeny = await readRw(hubDeny);
  const started2 = await runMarker(hubDeny);
  console.log(`write journey: run 2 started via ${started2 || "nothing"}`);
  check("run 2 started from the real composer", started2 !== "", started2);
  const denyCard = await waitForCard(hubDeny, 30000);
  check("run 2 shows the same diff card", !!denyCard && denyCard.title === `Write ${FIXTURE_NAME}? (+1 -1)`, denyCard);
  check("Deny clicked with a genuine gesture", await clickGenuine(hubDeny, boxExpr("#thread-conversation approval-card", ".deny")));
  const finalDeny = await waitForFinal(hubDeny, 30000);
  const afterDeny = await readRw(hubDeny);
  console.log(`write journey (deny): final = ${finalDeny}`);
  check("Deny leaves sha256 identical (bytes untouched)", afterDeny.sha === beforeDeny.sha && afterDeny.text === TYPO_TEXT, afterDeny);
  check("the agent reports the denied write honestly (NOT performed)", /File write NOT performed: .*denied/.test(finalDeny), finalDeny);
  await screenshot(hubDeny, "08-local-file-write-denied.png");

  console.log(`MANUAL REMAINDER: choose a real directory once via Settings → Local folders → Add folder; CDP cannot select a showDirectoryPicker() directory in headless Chrome.`);
  console.log(`Evidence: ${OUT}`);
} finally {
  try { proc.kill(); } catch { /* already exited */ }
}
Deno.exit(failed ? 1 : 0);

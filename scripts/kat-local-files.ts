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
  const openPage = async (url: string) => {
    const created = await send("Target.createTarget", { url });
    const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
    const sessionId = attached.result.sessionId;
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

  console.log(`MANUAL REMAINDER: choose a real directory once via Settings → Local folders → Add folder; CDP cannot select a showDirectoryPicker() directory in headless Chrome.`);
  console.log(`Evidence: ${OUT}`);
} finally {
  try { proc.kill(); } catch { /* already exited */ }
}
Deno.exit(failed ? 1 : 0);

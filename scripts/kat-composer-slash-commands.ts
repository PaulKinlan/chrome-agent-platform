// Browser KAT: /tabs lists real tabs from every Chrome window and attaches one.
// deno run -A scripts/kat-composer-slash-commands.ts [extension-dir] [evidence-dir]
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-composer-slash-commands`;
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
  await new Promise<void>((resolve) => {
    socket.onopen = () => resolve();
  });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) =>
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
      throw new Error(response.result.exceptionDetails.text);
    }
    return response?.result?.result?.value;
  };

  const worker = await waitForServiceWorker(send, {
    match: (target) =>
      target.type === "service_worker" &&
      target.url.includes("chrome-extension://"),
  });
  if (!worker) throw new Error("extension service worker did not register");
  const extensionId = new URL(worker.url).host;
  const created = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/ntp/ntp.html`,
  });
  const attached = await send("Target.attachToTarget", {
    targetId: created.result.targetId,
    flatten: true,
  });
  const session = attached.result.sessionId;
  await send("Runtime.enable", {}, session);
  await send("Page.enable", {}, session);
  await sleep(1200);

  const fixtures = await evaluate(
    `(async () => {
    const firstUrl = chrome.runtime.getURL("ntp/ntp.html?cap-tabs-kat-first");
    const secondUrl = chrome.runtime.getURL("ntp/ntp.html?cap-tabs-kat-second");
    const first = await chrome.tabs.create({ url:firstUrl });
    const secondWindow = await chrome.windows.create({ url:secondUrl, type:"normal" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { first: { id:first.id, windowId:first.windowId }, second: { id:secondWindow.tabs?.[0]?.id, windowId:secondWindow.id } };
  })()`,
    session,
  );
  check(
    "fixture tabs are in different windows",
    fixtures?.first?.windowId !== fixtures?.second?.windowId,
    fixtures,
  );

  await evaluate(
    `(() => {
    const input = document.querySelector("#composer #task-input");
    input.value = "/tabs";
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new Event("input", { bubbles:true }));
    return true;
  })()`,
    session,
  );
  await sleep(500);
  const listed = await evaluate(
    `(() => ({
    labels:[...document.querySelectorAll("#composer .popup .item")].map((row) => row.textContent),
    hidden:document.querySelector("#composer .popup")?.hidden,
  }))()`,
    session,
  );
  // rfca justification: visibility here is paired with the CONTENT check on
  // the next line (the picker must list the real tab) — an empty-but-open
  // popup fails that check.
  check("/tabs opens the picker", listed?.hidden === false, listed);
  check(
    "picker lists the real tab in the first window",
    listed?.labels?.some((text: string) => text.includes("cap-tabs-kat-first")),
    listed,
  );
  check(
    "picker lists the real tab in the second window",
    listed?.labels?.some((text: string) =>
      text.includes("cap-tabs-kat-second")
    ),
    listed,
  );

  const before = await send(
    "Page.captureScreenshot",
    { format: "png" },
    session,
  );
  await Deno.writeFile(
    `${OUT}/tabs-picker.png`,
    Uint8Array.from(atob(before.result.data), (char) => char.charCodeAt(0)),
  );

  const selected = await evaluate(
    `(() => {
    const row = [...document.querySelectorAll("#composer .popup .item")]
      .find((item) => item.textContent.includes("cap-tabs-kat-second"));
    row?.dispatchEvent(new MouseEvent("mousedown", { bubbles:true, cancelable:true }));
    return !!row;
  })()`,
    session,
  );
  await sleep(100);
  const result = await evaluate(
    `(() => {
    const composer = document.querySelector("#composer");
    return {
      value:composer.querySelector("#task-input")?.value,
      chips:[...composer.querySelectorAll(".chips .chip")].map((chip) => chip.textContent),
      attachments:composer.attachments.map((item) => ({ kind:item.kind, url:item.url, tabId:item.tabId, windowId:item.windowId })),
    };
  })()`,
    session,
  );
  check(
    "selecting a tab inserts its reference",
    selected && /^\/tabs:\d+$/.test(result?.value),
    result,
  );
  check(
    "selecting a tab inserts a visible removable chip",
    result?.chips?.some((text: string) => text.includes("Agent Hub")),
    result,
  );
  check(
    "the selected tab attachment keeps resolvable tab/window/url context",
    result?.attachments?.some((item: any) =>
      item.kind === "tab" && item.url.includes("cap-tabs-kat-second") &&
      item.windowId === fixtures.second.windowId
    ),
    result,
  );

  const after = await send(
    "Page.captureScreenshot",
    { format: "png" },
    session,
  );
  await Deno.writeFile(
    `${OUT}/tabs-reference.png`,
    Uint8Array.from(atob(after.result.data), (char) => char.charCodeAt(0)),
  );

  const bookmarksState = await evaluate(
    `(async () => {
      const granted = await chrome.permissions.contains({ permissions:["bookmarks"] });
      const input = document.querySelector("#composer #task-input");
      input.value = "/bookmarks";
      input.setSelectionRange(10, 10);
      input.dispatchEvent(new Event("input", { bubbles:true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        granted,
        hidden:document.querySelector("#composer .popup")?.hidden,
        labels:[...document.querySelectorAll("#composer .popup .item")].map((row) => row.textContent),
      };
    })()`,
    session,
  );
  check("bookmarks starts without an optional grant", bookmarksState?.granted === false, bookmarksState);
  check(
    "/bookmarks shows an explicit Settings grant state",
    bookmarksState?.hidden === false && bookmarksState?.labels?.some((text: string) =>
      text.includes("Bookmarks unavailable") && text.includes("Grant Bookmarks in Settings")
    ),
    bookmarksState,
  );
  const unavailable = await send("Page.captureScreenshot", { format: "png" }, session);
  await Deno.writeFile(
    `${OUT}/bookmarks-unavailable.png`,
    Uint8Array.from(atob(unavailable.result.data), (char) => char.charCodeAt(0)),
  );
  console.log(`Evidence: ${OUT}/tabs-picker.png`);
  console.log(`Evidence: ${OUT}/tabs-reference.png`);
  console.log(`Evidence: ${OUT}/bookmarks-unavailable.png`);
  console.log(
    `KAT composer slash commands: ${passed} passed, ${failed} failed`,
  );
  socket.close();
} finally {
  try {
    proc.kill("SIGKILL");
  } catch { /* already exited */ }
}
Deno.exit(failed ? 1 : 0);

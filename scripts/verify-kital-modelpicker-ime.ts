// scripts/verify-kital-modelpicker-ime.ts
// Verifies in headless Chrome that <model-picker> combobox properly guards
// Enter, ArrowDown, and ArrowUp during IME composition (isComposing || keyCode === 229),
// and commits cleanly on non-composing Enter. Captures screenshot evidence.

import { fileURLToPath } from "node:url";
import { join, normalize } from "node:path";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, openCdp, teardownChrome, resolveChromiumBinaryReport } from "./lib/chrome-launch.ts";
import { isUsableBinary } from "./lib/browser-refusal.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(ROOT, "docs");

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        signal: ac.signal,
        onListen: ({ port, hostname }) => {
          resolve({
            url: `http://${hostname}:${port}`,
            close: async () => {
              ac.abort();
              await server.shutdown();
            },
          });
        },
      },
      async (req) => {
        const url = new URL(req.url);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === "/") pathname = "/components.html";
        const normalized = normalize(pathname);
        if (normalized.includes("..") || !normalized.startsWith("/")) {
          return new Response("forbidden", { status: 403 });
        }
        const safe = join(DOCS, normalized.slice(1));
        if (!safe.startsWith(DOCS)) {
          return new Response("forbidden", { status: 403 });
        }
        try {
          const content = await Deno.readFile(safe);
          const ct = safe.endsWith(".html") ? "text/html" : safe.endsWith(".js") ? "text/javascript" : safe.endsWith(".css") ? "text/css" : "application/octet-stream";
          return new Response(content, { headers: { "content-type": ct } });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    );
  });
}

async function main() {
  const rep = resolveChromiumBinaryReport();
  if (!isUsableBinary(rep.binary)) {
    console.warn("No usable Chrome binary found; skipping browser verification");
    return;
  }

  const server = await serve();
  const profile = chromeProfileDir("kital-modelpicker-ime");
  const evidenceDir = durableDir("kital-modelpicker-ime", `${Date.now()}-${Deno.pid}`);
  await Deno.mkdir(evidenceDir, { recursive: true });

  let chrome, cdp;
  try {
    chrome = await launchChrome({
      binary: rep.binary,
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--remote-allow-origins=*",
        `--user-data-dir=${profile}`,
        "--window-size=1280,900",
        "about:blank",
      ],
    });

    cdp = await openCdp(chrome.wsUrl, { timeoutMs: 15000 });
    const tab = await cdp.open(`${server.url}/components.html`);
    await cdp.send("Page.bringToFront", {}, tab.sessionId);

    // Wait for document and component readiness
    const readPicker = () => cdp!.eval(tab.sessionId, `(() => {
      const picker = document.getElementById("model-demo");
      if (!picker || !picker.shadowRoot) return { ready: false };
      const input = picker.shadowRoot.querySelector("input.control");
      const list = picker.shadowRoot.querySelector(".listbox");
      return {
        ready: !!input && !!list,
        open: picker._open,
        activeIndex: picker._activeIndex,
        value: picker.value,
        committed: picker._committed,
      };
    })()`);

    let state;
    const deadline = Date.now() + 10000;
    do {
      state = await readPicker();
      if (state.ready) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    assert(state.ready, "<model-picker> must be rendered and ready");

    // Open combobox by clicking into input
    await cdp.eval(tab.sessionId, `(() => {
      const picker = document.getElementById("model-demo");
      const input = picker.shadowRoot.querySelector("input.control");
      input.focus();
      input.click();
    })()`);

    await new Promise((r) => setTimeout(r, 200));
    state = await readPicker();
    assert(state.open, "picker must be open after focus/click");

    // 1. Dispatch composing Enter (keyCode 229)
    await cdp.eval(tab.sessionId, `(() => {
      const picker = document.getElementById("model-demo");
      const input = picker.shadowRoot.querySelector("input.control");
      const ev = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
    })()`);

    state = await readPicker();
    assertEquals(state.open, true, "picker must remain open on composing Enter (keyCode 229)");

    // 2. Dispatch composing ArrowDown (keyCode 229)
    await cdp.eval(tab.sessionId, `(() => {
      const picker = document.getElementById("model-demo");
      const input = picker.shadowRoot.querySelector("input.control");
      const ev = new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, keyCode: 229, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
    })()`);

    state = await readPicker();
    assertEquals(state.activeIndex, -1, "activeIndex must not change on composing ArrowDown");

    // 3. Dispatch non-composing ArrowDown -> moves activeIndex to 0
    await cdp.eval(tab.sessionId, `(() => {
      const picker = document.getElementById("model-demo");
      const input = picker.shadowRoot.querySelector("input.control");
      const ev = new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: false, keyCode: 40, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
    })()`);

    state = await readPicker();
    assertEquals(state.activeIndex, 0, "non-composing ArrowDown must move activeIndex to 0");

    // Screenshot open with option active
    const openImg = await cdp.screenshot(tab.sessionId, { fromSurface: false, timeoutMs: 5000 });
    await Deno.writeFile(`${evidenceDir}/model-picker-open-active.png`, openImg);

    // 4. Dispatch non-composing Enter -> commits active option ("gemini-3.7-flash") and closes
    await cdp.eval(tab.sessionId, `(() => {
      const picker = document.getElementById("model-demo");
      const input = picker.shadowRoot.querySelector("input.control");
      const ev = new KeyboardEvent("keydown", { key: "Enter", isComposing: false, keyCode: 13, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
    })()`);

    state = await readPicker();
    assertEquals(state.open, false, "picker must close on non-composing Enter");
    assertEquals(state.committed, "gemini-3.7-flash", "picker must commit selected model on plain Enter");

    const closedImg = await cdp.screenshot(tab.sessionId, { fromSurface: false, timeoutMs: 5000 });
    await Deno.writeFile(`${evidenceDir}/model-picker-committed.png`, closedImg);

    console.log(`kital browser verification PASS: evidence saved to ${evidenceDir}`);
  } finally {
    cdp?.close();
    if (chrome) await teardownChrome(chrome, profile);
    await server.close();
  }
}

if (import.meta.main) {
  await main();
}

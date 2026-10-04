// tests/composer-command-disclosure.test.ts — chrome-agent-platform-fwf6.
//
// The 6yfm ruling (coord seq944, option C) is insertion-only: a composer command
// (/skill:x, /x, $x) goes into the message as conversation text and is never
// dispatched as a bare top-level command. The backend half pins WHERE the text
// goes (tests/acp-model.test.ts pins the ACP envelope). This file pins the half
// a user can actually check: that the picker SAYS SO, at the point of choice.
//
// tests/composer-slash-commands.test.ts pins the contract cheaply in the fake
// DOM (note present, text === the registry constant, aria-describedby wired).
// This file drives the REAL shipped component in a REAL browser, because the
// claim is about what a person sees: the note must RENDER (non-zero box, not
// hidden) and the listbox must hold the accessible description, in the built
// extension — not only in the renderer's return values.
// @ts-nocheck

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, waitForServiceWorker } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { resolveChromeForTesting } from "../scripts/lib/chrome-for-testing.ts";
import { COMMAND_INSERTION_DISCLOSURE } from "../extension/shared/composer-commands.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
const CHROME_FOR_TESTING = resolveChromeForTesting();

Deno.test("fwf6 source pin: the picker note is rendered from the registry constant", async () => {
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  // The sentence is imported, never re-typed: a second literal would drift.
  assert(
    /note\.textContent = COMMAND_INSERTION_DISCLOSURE;/.test(source),
    "the composer command note must use the registry constant, not a copy of the sentence",
  );
  assert(
    /note\.id = `cmp-\$\{this\._uid\}-insertion-note`;/.test(source),
    "the note must carry a per-instance id so aria-describedby can reference it",
  );
});

Deno.test({
  name: "fwf6: the built extension shows the command-insertion disclosure in the picker (real browser)",
  ignore: CHROME_FOR_TESTING === null,
  fn: async () => {
    const profile = chromeProfileDir("fwf6-composer-disclosure");
    const launched = await launchChrome({
      binary: CHROME_FOR_TESTING,
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--silent-debugger-extension-api",
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
    });

    const ws = new WebSocket(launched.wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const send = (method: string, params: any = {}, sessionId?: string) =>
      new Promise<any>((res) => {
        const mid = ++id;
        pending.set(String(mid), res);
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    ws.onmessage = (m: MessageEvent) => {
      const j = JSON.parse(m.data);
      if (j.id && pending.has(String(j.id))) {
        pending.get(String(j.id))(j);
        pending.delete(String(j.id));
      }
    };

    try {
      const sw = await waitForServiceWorker(send, {
        timeoutMs: 10000,
        match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"),
      });
      assert(sw, "Service worker must be running");
      const extId = new URL(sw.url).host;

      const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
      const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Runtime.enable", {}, sessionId);
      await send("Page.enable", {}, sessionId);
      await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1200, deviceScaleFactor: 1, mobile: false }, sessionId);

      const ev = async (expr: string) => {
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
        return r.result?.result?.value;
      };

      await new Promise((r) => setTimeout(r, 2000));

      // Drive the real user path: type a composer command into the hub composer
      // (/tabs always has at least this tab, so the popup really opens).
      const opened = await ev(`(async () => {
        const host = document.getElementById("composer");
        if (!host) return { error: "no #composer host" };
        // The composer renders in the LIGHT DOM (measured: shadowRoot is null),
        // so the host itself owns the popup; shadowRoot stays as a fallback in
        // case a later refactor moves it (the selector is the contract).
        const root = host.shadowRoot ?? host;
        const ta = root.querySelector("[data-composer-input]");
        if (!ta) return { error: "no [data-composer-input]" };
        ta.focus();
        ta.value = "/tabs";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1500));
        const popup = root.querySelector(".popup.slash-menu") ?? root.querySelector(".popup");
        if (!popup) return { error: "no popup" };
        const note = popup.querySelector('[id$="-insertion-note"]');
        const cs = note ? getComputedStyle(note) : null;
        const rect = note ? note.getBoundingClientRect() : null;
        return {
          popupHidden: popup.hidden,
          ariaLabel: popup.getAttribute("aria-label"),
          describedby: popup.getAttribute("aria-describedby"),
          noteId: note?.id ?? null,
          noteText: note?.textContent ?? null,
          noteVisible: !!note && rect.height > 0 && rect.width > 0 && cs.visibility !== "hidden" && cs.display !== "none",
          noteFontSize: cs?.fontSize ?? null,
          rows: popup.querySelectorAll(".item").length,
        };
      })()`);

      assertEquals(opened?.error ?? null, null, "the picker must open on a composer command");
      assertEquals(opened.popupHidden, false, "the command picker is open");
      assertEquals(opened.rows > 0, true, "/tabs must list at least this tab, or nothing is being disclosed about");
      assertEquals(opened.noteText, COMMAND_INSERTION_DISCLOSURE, "the picker shows the registry's sentence verbatim");
      assertEquals(opened.describedby, opened.noteId, "the listbox's accessible description is the disclosure note");
      assertEquals(opened.ariaLabel, "Composer commands", "the listbox is labelled for what it is");
      assertEquals(opened.noteVisible, true, "the disclosure must be visible, not merely present in the DOM");

      // Evidence of the run: the rendered popup, not just booleans.
      const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      if (shot?.result?.data) {
        const dir = Deno.env.get("CAP_EVIDENCE_DIR");
        if (dir) {
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeFile(`${dir}/composer-command-disclosure.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
        }
      }
    } finally {
      try { ws.close(); } catch { /* already closed */ }
      try { launched.process?.kill("SIGKILL"); } catch { /* exited */ }
    }
  },
});

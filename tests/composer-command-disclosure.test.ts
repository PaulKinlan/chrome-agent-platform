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
import { launchChrome, waitForServiceWorker, resolveChromiumBinaryReport, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { COMMAND_INSERTION_DISCLOSURE } from "../extension/shared/composer-commands.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
// THE BROWSER COMES FROM THE UNIFIED RESOLUTION (chrome-agent-platform-dsvq, on fyvc):
// CAP_CHROMIUM -> the Chrome-for-Testing cache (bare-version dirs included) -> /usr/bin/chromium.
// Resolving ONLY the cache here (the previous behaviour) made a box whose browser lives at
// /usr/bin/chromium or behind CAP_CHROMIUM self-skip this journey: work that never ran, wearing an
// ignore. The ignore now fires only when NO browser is resolvable anywhere, and it says so with
// everything that was tried, so the tally line can never be mistaken for a pass.
const BROWSER_RESOLUTION = resolveChromiumBinaryReport();
const BROWSER_BINARY = BROWSER_RESOLUTION.binary;
if (BROWSER_BINARY === null) {
  console.warn("composer-command-disclosure: no Chrome resolvable - tried: " + BROWSER_RESOLUTION.tried.join("; ") +
    ". Reporting the browser journey as IGNORED (a visible tally line, never a pass); set CAP_CHROMIUM or install a browser to run it.");
}

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
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    const profile = chromeProfileDir("fwf6-composer-disclosure");
    const launched = await launchChrome({
      binary: BROWSER_BINARY,
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
        let lastErr: any = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
            if (r.error) {
              if (String(r.error.message ?? "").includes("Cannot find default execution context") && attempt < 9) {
                await new Promise((res) => setTimeout(res, 200));
                continue;
              }
              throw new Error(JSON.stringify(r.error));
            }
            if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
            return r.result?.result?.value;
          } catch (e) {
            lastErr = e;
            if (String(e?.message ?? e).includes("Cannot find default execution context") && attempt < 9) {
              await new Promise((res) => setTimeout(res, 200));
              continue;
            }
            throw e;
          }
        }
        throw lastErr;
      };

      // Bounded wait for the document execution context and #composer host to mount
      const ntpReadyDeadline = Date.now() + 15000;
      let ntpReady = false;
      while (Date.now() < ntpReadyDeadline) {
        try {
          const ready = await ev(`Boolean(document.readyState === "complete" && document.getElementById("composer"))`);
          if (ready) { ntpReady = true; break; }
        } catch { /* context initializing */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(ntpReady, "NTP document and #composer host must mount within deadline");

      // Drive the real user path: type a composer command into the hub composer
      // (/tabs always has at least this tab, so the popup really opens).
      const opened = await ev(`(async () => {
        const deadline = Date.now() + 10000;
        let host = null;
        let root = null;
        let ta = null;
        while (Date.now() < deadline) {
          host = document.getElementById("composer");
          if (host) {
            root = host.shadowRoot ?? host;
            ta = root.querySelector("[data-composer-input]");
            if (ta) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!host) return { error: "no #composer host" };
        // The composer renders in the LIGHT DOM (measured: shadowRoot is null),
        // so the host itself owns the popup; shadowRoot stays as a fallback in
        // case a later refactor moves it (the selector is the contract).
        if (!ta) return { error: "no [data-composer-input]" };
        ta.focus();
        ta.value = "/tabs";
        ta.dispatchEvent(new Event("input", { bubbles: true }));

        const popupDeadline = Date.now() + 10000;
        let popup = null;
        let note = null;
        while (Date.now() < popupDeadline) {
          popup = root.querySelector(".popup.slash-menu") ?? root.querySelector(".popup");
          if (popup && (!popup.hidden || popup.matches?.(":popover-open") || popup.classList.contains("open"))) {
            note = popup.querySelector('[id$="-insertion-note"]');
            if (note && popup.querySelectorAll(".item").length > 0) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!popup) return { error: "no popup" };
        note = popup.querySelector('[id$="-insertion-note"]');
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
      await teardownChrome(launched, profile);
    }
  },
});

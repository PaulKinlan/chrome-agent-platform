// tests/mic-shadow-host-journey.test.ts — chrome-agent-platform-nqpqp
//
// The fbg7i hide-observer fix walks the COMPOSED ancestor chain
// (parentElement ?? shadowHostOf(el) -> getRootNode().host) so a body view
// switch stops the mic even when the composer lives behind shadow boundaries.
// tests/mic-button-state.test.ts proves the walk against a FAKE tree (kept,
// untouched). This journey is the real-browser half the bead requires: a
// gallery <prompt-bar> mounted inside a REAL shadow root, recording started
// against the fake media device, then the NTP view-switch mechanism
// (body.view-open + display:none — ntp.js syncViewOpen / ntp.html CSS) hides
// the composer, and the recording must STOP through the MutationObserver on
// the composed chain. IntersectionObserver is deliberately no-op'd before the
// elements upgrade so the MutationObserver path is the ONLY possible stopper —
// that is the claim under test.
//
// Contention tolerance: every state transition is a bounded poll (deadline,
// short interval), never a fixed sleep — a stolen or loaded box slows the
// browser down but cannot flip an assertion (the wall-clock-budget flake class
// this repo pays for elsewhere; see chrome-agent-platform-cqxo3/r2l8n).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  launchChrome,
  openCdp,
  teardownChrome,
  resolveChromiumBinaryReport,
} from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BROWSER_RESOLUTION = resolveChromiumBinaryReport();
const BROWSER_BINARY = BROWSER_RESOLUTION.binary;
if (BROWSER_BINARY === null) {
  console.warn(
    `mic-shadow-host-journey: IGNORED — no Chrome resolvable on host (tried: ${BROWSER_RESOLUTION.tried.join("; ")})`,
  );
}

// The journey page: serves the CANONICAL extension/shared sources (not the
// docs/ gallery copy — its components.js barrel pulls a gitignored bundle),
// mounts <prompt-bar> inside a real shadow root, and carries the exact NTP
// view-switch mechanism (a body class + display:none on the host).
const JOURNEY_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { margin:0; font-family: system-ui; }
  body.view-open #journey-host { display:none; }
</style>
<script>
  // Neuter IntersectionObserver BEFORE the component modules load, so the
  // observers MicButton's connectedCallback creates are no-ops and the ONLY
  // mechanism that can stop the recording on a view switch is the
  // MutationObserver over the composed ancestor chain — the claim under test.
  // (A CDP-side neuter would run after the elements upgrade: too late — the
  // real IO would fire on display:none and the journey could not tell which
  // path stopped the mic. Falsified: with the real IO live, a parentElement-
  // only ancestor walk still passes.)
  window.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
</script>
<script type="module">
  import "./extension/shared/components-core.js";
  import "./extension/shared/components-conversation.js";
  window.__ready = () => !!customElements.get("prompt-bar") && !!customElements.get("mic-button");
</script>
</head><body>
<div id="journey-host"></div>
<script>
  const host = document.getElementById("journey-host").attachShadow({ mode: "open" });
  host.innerHTML = '<div class="wrap"><prompt-bar model="demo" placeholder="Ask anything"></prompt-bar></div>';
</script>
</body></html>`;

const STATE_EXPR = `(() => {
  const wrap = document.getElementById("journey-host").shadowRoot;
  const pb = wrap.querySelector("prompt-bar");
  const mic = pb && pb.shadowRoot ? pb.shadowRoot.querySelector("mic-button") : null;
  const btn = mic && mic.shadowRoot ? mic.shadowRoot.querySelector(".mic") : null;
  return {
    hasMic: !!mic,
    listeningAttr: mic ? mic.hasAttribute("listening") : null,
    waveformMode: mic ? (mic.waveformMode ?? null) : null,
    streamOpen: mic ? !!mic._mediaStream : null,
    offsetParentNull: btn ? btn.offsetParent === null : null,
    srStarted: window.__srTotals ? window.__srTotals.started : -1,
    srStopped: window.__srTotals ? window.__srTotals.stopped : -1,
    events: window.__events ? window.__events.length : -1,
  };
})()`;

Deno.test({
  name: "nqpqp: a REAL shadow-root prompt-bar stops recording when a body view switch hides the composer (composed-chain MutationObserver, IO no-op'd)",
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      async (req) => {
        const path = decodeURIComponent(new URL(req.url).pathname);
        if (path === "/journey.html") {
          return new Response(JOURNEY_HTML, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        try {
          const body = await Deno.readFile(`${ROOT}${path}`);
          const type = path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : path.endsWith(".html")
                ? "text/html"
                : "application/octet-stream";
          return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
        } catch {
          return new Response("not found: " + path, { status: 404 });
        }
      },
    );
    const port = (server.addr as Deno.NetAddr).port;
    const base = `http://127.0.0.1:${port}`;
    const profile = chromeProfileDir("mic-shadow-host-journey");
    let chromeInstance: any = null;
    let cdp: any = null;
    try {
      chromeInstance = await launchChrome({
        binary: BROWSER_BINARY as string,
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--remote-allow-origins=*",
          `--user-data-dir=${profile}`,
          "about:blank",
        ],
      });
      cdp = await openCdp(chromeInstance.wsUrl, { timeoutMs: 30_000 });
      const { sessionId } = await cdp.open(`${base}/journey.html`);

      // Bounded poll helper: contention moves the deadline, not the verdict.
      const pollUntil = async (label: string, expr: string, predicate: (v: any) => boolean, deadlineMs = 15_000): Promise<any> => {
        const t0 = Date.now();
        let last: any;
        while (Date.now() - t0 < deadlineMs) {
          last = await cdp.eval(sessionId, expr);
          if (predicate(last)) return last;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(
          `mic-shadow-host-journey: timed out after ${deadlineMs}ms waiting for ${label}; last state ${JSON.stringify(last)}`,
        );
      };

      await pollUntil("custom elements upgrade", `window.__ready ? window.__ready() : false`, (v) => v === true);

      // Wire the composed event listeners and stub SpeechRecognition BEFORE any
      // recording (start() refuses without one, and the real service is not
      // available in headless — the same FakeSR shape scripts/kat-mic-state.ts
      // uses). IntersectionObserver is already neutered by the page itself, before
      // the elements upgraded — see JOURNEY_HTML.
      await cdp.eval(sessionId, `(() => {
        window.__events = [];
        window.addEventListener("mic-toggle", (e) => window.__events.push(["mic-toggle", e.detail]), true);
        window.addEventListener("mic-error", (e) => window.__events.push(["mic-error", e.detail]), true);
        class FakeSR { constructor(){ window.__sr = this; this.onend=null; }
          start(){ window.__srTotals.started++; } stop(){ window.__srTotals.stopped++; } abort(){} }
        window.__srTotals = { started: 0, stopped: 0 };
        window.SpeechRecognition = FakeSR;
        window.webkitSpeechRecognition = FakeSR;
        return true;
      })()`);

      const clickMic = () =>
        cdp.eval(sessionId, `(() => {
          const pb = document.getElementById("journey-host").shadowRoot.querySelector("prompt-bar");
          pb.shadowRoot.querySelector("mic-button").shadowRoot.querySelector(".mic").click();
          return true;
        })()`);

      // --- Cycle 1: classList.add view switch -------------------------------
      await clickMic();
      const recording = await pollUntil("recording starts", STATE_EXPR, (s) =>
        s.listeningAttr === true && s.srStarted === 1 && s.streamOpen === true
      );
      assertEquals(recording.offsetParentNull, false, "the composer is visible while recording");
      assertEquals(recording.srStopped, 0, "recognition is running");

      await cdp.eval(sessionId, `(() => { document.body.classList.add("view-open"); return document.body.className; })()`);
      const stopped = await pollUntil("recording stops across the shadow host", STATE_EXPR, (s) =>
        s.listeningAttr === false && s.srStopped === 1 && s.streamOpen === false
      );
      assertEquals(stopped.offsetParentNull, true, "the body view switch hid the composer");
      assertEquals(stopped.waveformMode, null, "the waveform meter is released");

      const events: any[] = await cdp.eval(sessionId, `window.__events`);
      const kinds = events.map((e: any) => e[0]);
      assert(kinds.includes("mic-error"), "the hide-stop is announced as mic-error");
      const micError = events.find((e: any) => e[0] === "mic-error");
      assertEquals(micError[1].message, "recording stopped — the composer was hidden");
      assert(
        kinds.indexOf("mic-error") > kinds.indexOf("mic-toggle"),
        "the toggle(true) precedes the hide-stop error",
      );
      assertEquals(events[events.length - 1][1], { listening: false }, "the last event is mic-toggle(false)");

      // --- Cycle 2: setAttribute view switch — not a one-shot ---------------
      await cdp.eval(sessionId, `(() => { document.body.classList.remove("view-open"); return true; })()`);
      await pollUntil("composer re-shown", STATE_EXPR, (s) => s.offsetParentNull === false);
      await clickMic();
      const recording2 = await pollUntil("recording restarts", STATE_EXPR, (s) =>
        s.listeningAttr === true && s.srStarted === 2
      );
      assertEquals(recording2.srStopped, 1, "the previous stop is still counted; the new session is running");

      await cdp.eval(sessionId, `(() => { document.body.setAttribute("class", "view-open"); return true; })()`);
      const stopped2 = await pollUntil("recording stops on a setAttribute view switch", STATE_EXPR, (s) =>
        s.listeningAttr === false && s.srStopped === 2 && s.streamOpen === false
      );
      assertEquals(stopped2.offsetParentNull, true);

      // --- Discriminator: scrolling the (still displayed) composer off-screen
      // must NOT stop the recording — the stop signal is display:none, not
      // viewport position, and with IO no-op'd the mutation path must not
      // over-fire on scroll.
      await cdp.eval(sessionId, `(() => {
        document.body.setAttribute("class", "");
        const spacer = document.createElement("div");
        spacer.style.height = "300vh";
        document.body.appendChild(spacer);
        return true;
      })()`);
      await pollUntil("composer re-shown after cycle 2", STATE_EXPR, (s) => s.offsetParentNull === false);
      await clickMic();
      await pollUntil("recording restarts for the scroll discriminator", STATE_EXPR, (s) =>
        s.listeningAttr === true && s.srStarted === 3
      );
      await cdp.eval(sessionId, `(() => { window.scrollTo(0, document.body.scrollHeight); return true; })()`);
      await new Promise((r) => setTimeout(r, 600));
      const scrolled = await cdp.eval(sessionId, STATE_EXPR);
      assertEquals(scrolled.listeningAttr, true, "a scrolled-off (still displayed) composer keeps recording");
      assertEquals(scrolled.srStopped, 2, "no stop was fired by scrolling");
    } finally {
      if (cdp) cdp.close();
      await teardownChrome(chromeInstance, profile);
      await server.shutdown();
    }
  },
});

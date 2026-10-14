// scripts/settings-panel-parity.ts — chrome-agent-platform-8v5l.1 Acceptance 1
//
// Behaviour-neutral parity harness for Stage 3a (Settings panels as mountable
// modules + PANEL_REGISTRY). In one Chrome instance:
//   1. Builds the BASE commit's standalone options.bundle.js (default: 73ea41ba /
//      origin/main) and HEAD's standalone options.bundle.js into a disposable
//      materialized extension tree.
//   2. Loads standalone options.html at BASE and at HEAD in the same Chrome,
//      mounts all 16 sections in SETTINGS_SECTIONS order, and compares:
//        (i)   normalized DOM of each section
//        (ii)  ordered list of SW message types sent during mount
//        (iii) count of live listeners and timers after mount
//   3. Exits non-zero if any section diverges on (i), (ii), or (iii).

import { fileURLToPath } from "node:url";
import { copyBuiltTree } from "./lib/copy-built-tree.mjs";
import { durableDir } from "./lib/durable-root.mjs";
import { launchChrome, openCdp, teardownChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { SETTINGS_SECTIONS } from "../extension/lib/pure.js";
import { PANEL_REGISTRY } from "../extension/options/panel-registry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const baseArg = Deno.args.find((a) => a.startsWith("--base="))?.slice("--base=".length);
const BASE_REF = baseArg || "73ea41ba";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 1200)}` : ""}`);
  }
}

async function gitShow(ref: string, relPath: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["show", `${ref}:${relPath}`],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`git show ${ref}:${relPath} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function bundleOptions(entryFile: string, outFile: string): Promise<void> {
  const esbuildBin = `${ROOT}node_modules/.bin/esbuild`;
  const out = await new Deno.Command(esbuildBin, {
    args: [
      entryFile,
      "--bundle",
      "--format=esm",
      "--target=chrome128",
      "--minify",
      `--outfile=${outFile}`,
    ],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`esbuild failed for ${entryFile}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

interface SectionParitySnapshot {
  dom: string;
  sends: string[];
  liveListeners: number;
  liveTimers: number;
}

const PRELOAD_INSTRUMENTATION = `(() => {
  const liveListeners = new Map();
  let listenerSeq = 0;
  const liveTimers = new Set();
  const state = {
    sends: [],
    inFlight: 0,
    lastActivityAt: performance.now(),
    get liveListenerCount() {
      return liveListeners.size;
    },
    get liveListenerTypes() {
      const counts = {};
      for (const v of liveListeners.values()) {
        const tag = v.target === window ? "window" : v.target === document ? "document" : (v.target?.id ? "#" + v.target.id : v.target?.tagName || "node");
        const k = tag + ":" + v.type;
        counts[k] = (counts[k] || 0) + 1;
      }
      return counts;
    },
    get liveTimerCount() {
      return liveTimers.size;
    },
    resetSends() {
      this.sends = [];
      this.lastActivityAt = performance.now();
    },
  };
  Object.defineProperty(window, "__capParity", { value: state, configurable: true });

  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (listener) {
      const key = ++listenerSeq;
      liveListeners.set(key, { target: this, type, listener });
      if (options && typeof options === "object" && options.signal && typeof options.signal.addEventListener === "function") {
        origAdd.call(options.signal, "abort", () => {
          liveListeners.delete(key);
        }, { once: true });
      }
    }
    return origAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    for (const [k, v] of liveListeners.entries()) {
      if (v.target === this && v.type === type && v.listener === listener) {
        liveListeners.delete(k);
        break;
      }
    }
    return origRemove.call(this, type, listener, options);
  };

  const origSetTimeout = window.setTimeout.bind(window);
  window.requestIdleCallback = function(cb) {
    return origSetTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 80);
  };
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  window.setInterval = function(fn, ms, ...rest) {
    const id = origSetInterval(fn, ms, ...rest);
    liveTimers.add(id);
    return id;
  };
  window.clearInterval = function(id) {
    liveTimers.delete(id);
    return origClearInterval(id);
  };

  if (globalThis.chrome?.runtime?.sendMessage) {
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function(msg, ...rest) {
      if (msg && typeof msg.type === "string") {
        state.sends.push(msg.type);
      }
      state.inFlight++;
      state.lastActivityAt = performance.now();
      try {
        const res = origSend(msg, ...rest);
        if (res && typeof res.then === "function") {
          return res.finally(() => {
            state.inFlight = Math.max(0, state.inFlight - 1);
            state.lastActivityAt = performance.now();
          });
        }
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.lastActivityAt = performance.now();
        return res;
      } catch (err) {
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.lastActivityAt = performance.now();
        throw err;
      }
    };
  }
})();`;

const scratchRoot = durableDir(`cap-settings-parity-${Date.now()}`);
const tempExtDir = `${scratchRoot}/ext-live`;
const baseSrcDir = `${scratchRoot}/ext-base-src`;
const baseBundlePath = `${scratchRoot}/options-base.bundle.js`;
const headBundlePath = `${scratchRoot}/options-head.bundle.js`;

await copyBuiltTree({ src: `${ROOT}extension`, dest: tempExtDir });
await copyBuiltTree({ src: `${ROOT}extension`, dest: baseSrcDir });

// Materialize the BASE commit's options files into baseSrcDir and bundle both.
await Deno.writeTextFile(
  `${baseSrcDir}/options/options.js`,
  await gitShow(BASE_REF, "extension/options/options.js"),
);
await Deno.writeTextFile(
  `${baseSrcDir}/options/user-wasm-panel.js`,
  await gitShow(BASE_REF, "extension/options/user-wasm-panel.js"),
);
await Deno.writeTextFile(
  `${baseSrcDir}/skills/skills-panel.js`,
  await gitShow(BASE_REF, "extension/skills/skills-panel.js"),
);

await bundleOptions(`${baseSrcDir}/options/options.js`, baseBundlePath);
await bundleOptions(`${tempExtDir}/options/options.js`, headBundlePath);

const profile = chromeProfileDir("settings-panel-parity");
const chrome = await launchChrome({
  extension: tempExtDir,
  profile,
  windowSize: "1400,1200",
});

try {
  const cdp = await openCdp(chrome.wsUrl);
  try {
    const sw = await cdp.serviceWorker({ timeoutMs: 20_000 });
    check("service worker registered", Boolean(sw?.url));
    const extId = new URL(sw.url).host;

    // Seed developerFeatures = true once in storage before running BASE and HEAD passes
    // so all 16 sections (including the 4 developer-only sections) are accessible.
    const seedPage = await cdp.open(`chrome-extension://${extId}/options/options.html`);
    await cdp.eval(
      seedPage.sessionId,
      `new Promise((resolve) => chrome.storage.local.set({ "cap:developerFeatures": true }, resolve))`,
    );
    await cdp.send("Target.closeTarget", { targetId: seedPage.targetId });

    const collectPass = async (label: string, bundleFile: string): Promise<Record<string, SectionParitySnapshot>> => {
      await Deno.copyFile(bundleFile, `${tempExtDir}/dist/options.bundle.js`);
      const tab = await cdp.open("about:blank");
      const sid = tab.sessionId;
      await cdp.send("Network.enable", {}, sid);
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sid);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PRELOAD_INSTRUMENTATION }, sid);
      await cdp.send(
        "Page.navigate",
        { url: `chrome-extension://${extId}/options/options.html#providers` },
        sid,
      );

      // Wait for boot + initial #providers mount to settle
      await cdp.eval(
        sid,
        `new Promise((resolve) => {
          const checkIdle = () => {
            const p = window.__capParity;
            const ready = document.querySelectorAll("#providers .provider-card").length > 0;
            if (p && ready && p.inFlight === 0 && (performance.now() - p.lastActivityAt) >= 250) {
              resolve(true);
            } else {
              setTimeout(checkIdle, 50);
            }
          };
          setTimeout(checkIdle, 100);
        })`,
      );

      const snapshots: Record<string, SectionParitySnapshot> = {};

      const captureSection = async (sectionId: string, isInitialBoot: boolean) => {
        if (!isInitialBoot) {
          await cdp.eval(
            sid,
            `(() => {
              const p = window.__capParity;
              p.resetSends();
              p._listenersBefore = p.liveListenerCount;
              p._timersBefore = p.liveTimerCount;
              const link = document.querySelector('a.nav-item[data-section="${sectionId}"]');
              if (link) link.click();
              else location.hash = "#${sectionId}";
            })()`,
          );
          await cdp.eval(
            sid,
            `new Promise((resolve) => {
              const checkIdle = () => {
                const p = window.__capParity;
                const active = document.getElementById(${JSON.stringify(sectionId)})?.classList.contains("active");
                if (p && active && p.inFlight === 0 && (performance.now() - p.lastActivityAt) >= 220) {
                  resolve(true);
                } else {
                  setTimeout(checkIdle, 40);
                }
              };
              setTimeout(checkIdle, 60);
            })`,
          );
        }

        const snap = await cdp.eval(
          sid,
          `(() => {
            const p = window.__capParity;
            const sec = document.getElementById(${JSON.stringify(sectionId)});
            const rawHtml = sec ? sec.innerHTML : "";
            const normDom = rawHtml
              .replace(/\\s+/g, " ")
              .replace(/data-rendered-at="[^"]*"/g, "")
              .trim();
            return {
              dom: normDom,
              sends: [...p.sends],
              liveListeners: isInitial
                ? p.liveListenerCount
                : (p.liveListenerCount - (p._listenersBefore ?? 0)),
              liveTimers: isInitial
                ? p.liveTimerCount
                : (p.liveTimerCount - (p._timersBefore ?? 0)),
              listenerTypes: p.liveListenerTypes,
            };
          })()`.replace(/isInitial/g, isInitialBoot ? "true" : "false"),
        ) as SectionParitySnapshot;

        snapshots[sectionId] = snap;
      };

      for (const sectionId of SETTINGS_SECTIONS) {
        await captureSection(sectionId, sectionId === "providers");
      }

      await cdp.send("Target.closeTarget", { targetId: tab.targetId });
      console.log(`Collected ${Object.keys(snapshots).length} section snapshots for ${label}`);
      return snapshots;
    };

    const baseSnapshots = await collectPass(`BASE (${BASE_REF})`, baseBundlePath);
    const headSnapshots = await collectPass("HEAD", headBundlePath);

    check(
      "all 16 SETTINGS_SECTIONS captured in BASE and HEAD",
      Object.keys(baseSnapshots).length === 16 && Object.keys(headSnapshots).length === 16,
      { baseCount: Object.keys(baseSnapshots).length, headCount: Object.keys(headSnapshots).length },
    );

    const registryById = new Map(PANEL_REGISTRY.map((e) => [e.id, e]));

    for (const sectionId of SETTINGS_SECTIONS) {
      const b = baseSnapshots[sectionId];
      const h = headSnapshots[sectionId];
      check(
        `[${sectionId}] (i) normalized DOM matches BASE vs HEAD`,
        b.dom === h.dom,
        b.dom === h.dom ? undefined : { baseLen: b.dom.length, headLen: h.dom.length, baseSample: b.dom.slice(0, 300), headSample: h.dom.slice(0, 300) },
      );
      check(
        `[${sectionId}] (ii) ordered SW message types during mount match BASE vs HEAD`,
        JSON.stringify(b.sends) === JSON.stringify(h.sends),
        { baseSends: b.sends, headSends: h.sends },
      );
      const listenerDiff: Record<string, { base: number; head: number }> = {};
      if (b.liveListeners !== h.liveListeners) {
        const bt = (b as any).listenerTypes ?? {};
        const ht = (h as any).listenerTypes ?? {};
        for (const k of new Set([...Object.keys(bt), ...Object.keys(ht)])) {
          if (bt[k] !== ht[k]) listenerDiff[k] = { base: bt[k] ?? 0, head: ht[k] ?? 0 };
        }
      }
      check(
        `[${sectionId}] (iii) live listener and timer counts after mount match BASE vs HEAD`,
        b.liveListeners === h.liveListeners && b.liveTimers === h.liveTimers,
        {
          base: { listeners: b.liveListeners, timers: b.liveTimers },
          head: { listeners: h.liveListeners, timers: h.liveTimers },
          listenerDiff,
        },
      );

      // Verify runtime SW sends observed during mount are a subset of PANEL_REGISTRY.routes
      // (for initial boot on #providers, filter out page-level boot sends outside the panel).
      const entry = registryById.get(sectionId);
      if (entry && sectionId !== "providers") {
        const declared = new Set<string>(entry.routes);
        // Diagnostics refresh routes triggered by shared page header / nav controller:
        const pageLevelRoutes = new Set(["diagnostics.summary", "kv.get", "provider.get", "agent.list", "bgagent.list"]);
        const undeclared = h.sends.filter((t) => !declared.has(t) && !pageLevelRoutes.has(t));
        check(
          `[${sectionId}] runtime SW sends are declared in PANEL_REGISTRY.routes`,
          undeclared.length === 0,
          { observed: h.sends, undeclared },
        );
      }
    }
  } finally {
    cdp.close();
  }
} finally {
  await teardownChrome(chrome.proc, profile);
  await Deno.remove(profile, { recursive: true }).catch(() => {});
  await Deno.remove(scratchRoot, { recursive: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
Deno.exit(failed > 0 ? 1 : 0);

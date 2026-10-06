// tests/settings-focus-and-diag-badge-716s13.test.ts
// Falsification tests for bead chrome-agent-platform-716s.13:
// 1. Suppress programmatic h2[tabindex="-1"]:focus outline in Settings (options.html/options.css).
// 2. Exclude keyless/no-provider setup conditions and owner permission decisions from topbar Diagnostics badge.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  isExcludedDiagnosticBadgeEntry,
  countDiagnosticsBadgeErrors,
  classifyDiagnosticBadgeLevel,
} from "../extension/lib/diagnostics-badge.js";
import { launchChrome, openCdp, computeUnpackedExtensionId, teardownChrome, resolveChromiumBinaryReport } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";

const EXT = fileURLToPath(new URL("../extension", import.meta.url));

function findChromeForTesting(): string | null {
  const env = Deno.env.get("CHROME_BINARY");
  if (env) return env;
  return resolveChromiumBinaryReport().binary;
}

const CHROME_BINARY = findChromeForTesting();

// ── Part A: Unit tests for diagnostics-badge filtering logic ───────────────────

Deno.test("716s.13 Part A: isExcludedDiagnosticBadgeEntry excludes setup and permission decisions", () => {
  // Non-errors / non-warnings are excluded from error badge
  assertEquals(isExcludedDiagnosticBadgeEntry({ level: "info", message: "just info" }), true);
  assertEquals(isExcludedDiagnosticBadgeEntry(null), true);

  // Keyless pricing notices from agent-do on local-assistant / demo models
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "warn",
      source: "service-worker",
      kind: "warning",
      message: '[agent-do] No pricing entry for model "local-assistant" in the custom table; cost tracking and spending limits are disabled for this model. Set AgentConfig.usage.pricing to provide your own rates.',
    }),
    true,
  );

  // Missing provider / API key setup conditions
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "warn",
      source: "provider-gate",
      message: "no provider configured",
    }),
    true,
  );
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "error",
      source: "provider",
      message: "openai is misconfigured: missing API key",
    }),
    true,
  );
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "warn",
      message: "No model connected yet — pick one to start",
    }),
    true,
  );

  // Permission refusals / owner decisions
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "warn",
      source: "security",
      kind: "owner-denied",
      message: "approval denied action=asset.delete ref=abcdef",
    }),
    true,
  );
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "error",
      message: "Owner denied the requested capability. list_tabs was not performed",
    }),
    true,
  );
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "error",
      message: "I could not see your tabs because the tabs permission was not granted.",
    }),
    true,
  );
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "warn",
      source: "service-worker",
      kind: "warning",
      message: "[cap:tool] 2026-10-01T19:33:27.172Z +0ms list_tabs → tabs permission not granted — allow it in the approval card here, or in Settings → Permissions",
    }),
    true,
  );

  // Genuine system errors MUST NOT be excluded (negative tests)
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "error",
      source: "service-worker",
      kind: "runtime",
      message: "Uncaught ReferenceError: foo is not defined",
    }),
    false,
  );
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "error",
      source: "storage",
      kind: "quota",
      message: "QuotaExceededError: storage full",
    }),
    false,
  );
  assertEquals(
    isExcludedDiagnosticBadgeEntry({
      level: "error",
      source: "network",
      kind: "fetch",
      message: "TypeError: Failed to fetch endpoint",
    }),
    false,
  );
});

Deno.test("716s.13 Part A: countDiagnosticsBadgeErrors accurately computes badge count", () => {
  const keylessRunEntries = [
    {
      level: "warn",
      source: "service-worker",
      kind: "warning",
      message: '[agent-do] No pricing entry for model "local-assistant" in the custom table; cost tracking and spending limits are disabled for this model.',
    },
    {
      level: "warn",
      source: "security",
      kind: "owner-denied",
      message: "approval denied action=tabs.query ref=123456",
    },
    {
      level: "info",
      message: "Normal startup note",
    },
  ];

  // Keyless entries must produce 0 badge count
  assertEquals(countDiagnosticsBadgeErrors(keylessRunEntries), 0);

  // Adding a genuine error must increment badge count to 1 (negative test)
  const withRealError = [
    ...keylessRunEntries,
    {
      level: "error",
      source: "service-worker",
      kind: "runtime",
      message: "Uncaught TypeError: cannot read properties of undefined",
    },
  ];
  assertEquals(countDiagnosticsBadgeErrors(withRealError), 1);
});

Deno.test("716s.13 Part A: classifyDiagnosticBadgeLevel classifies excluded entries as info", () => {
  assertEquals(
    classifyDiagnosticBadgeLevel({
      level: "warn",
      message: '[agent-do] No pricing entry for model "local-assistant"',
    }),
    "info",
  );
  assertEquals(
    classifyDiagnosticBadgeLevel({
      level: "error",
      message: "Real platform crash",
    }),
    "error",
  );
});

// ── Part B: Unit tests for diagnostics-client badge refresh ───────────────────

Deno.test("716s.13 Part B: refreshDiagnostics filters badge count for diagnostics-panel", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { chrome: g.chrome, document: g.document };

  const testEntries = [
    {
      level: "warn",
      source: "service-worker",
      kind: "warning",
      message: '[agent-do] No pricing entry for model "local-assistant" in the custom table',
    },
  ];

  g.chrome = {
    runtime: {
      sendMessage: (_msg: { type?: string }, cb: (v: unknown) => void) => {
        cb({ ok: true, count: 1, entries: testEntries });
      },
    },
  };

  const diagAttrs = new Map<string, string>();
  const diagEl = {
    setAttribute: (k: string, v: string) => diagAttrs.set(k, v),
    removeAttribute: (k: string) => diagAttrs.delete(k),
  };

  const consoleAttrs = new Map<string, string>();
  const consoleEl = {
    setAttribute: (k: string, v: string) => consoleAttrs.set(k, v),
    removeAttribute: (k: string) => consoleAttrs.delete(k),
  };

  g.document = {
    querySelector: (sel: string) => {
      if (sel === "diagnostics-panel") return diagEl;
      if (sel === "error-console") return consoleEl;
      return null;
    },
  };

  try {
    const { refreshDiagnostics } = await import("../extension/shared/diagnostics-client.js");
    await refreshDiagnostics();

    // The raw console gets the unfiltered count
    assertEquals(consoleAttrs.get("count"), "1");

    // The topbar badge gets the filtered count: 0 for keyless setup nudges
    assertEquals(diagAttrs.get("count"), "0");
    assertEquals(diagAttrs.has("attention"), false);

    // Now simulate genuine error
    testEntries.push({
      level: "error",
      message: "Uncaught SyntaxError in script",
    });
    await refreshDiagnostics();

    assertEquals(consoleAttrs.get("count"), "1");
    assertEquals(diagAttrs.get("count"), "1");
    assertEquals(diagAttrs.has("attention"), true);
  } finally {
    g.chrome = saved.chrome;
    g.document = saved.document;
  }
});

// ── Part C: Real-browser integration tests with Chrome for Testing ─────────────

Deno.test({
  name: "716s.13 Part C: Settings h2 programmatic focus ring is suppressed on nav click",
  ignore: CHROME_BINARY === null,
  fn: async () => {
    const profile = chromeProfileDir("settings-focus-716s13");
    const chrome = await launchChrome({
      binary: CHROME_BINARY,
      extension: EXT,
      profile,
      args: ["--headless=new", "--no-sandbox", "--disable-gpu", "about:blank"],
    });

    const cdp = await openCdp(chrome.wsUrl, { timeoutMs: 20000 });
    const extId = await computeUnpackedExtensionId(EXT);

    try {
      const page = await cdp.open(`chrome-extension://${extId}/options/options.html`);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
      await cdp.send("Page.bringToFront", {}, page.sessionId);

      // Wait for Settings boot
      await new Promise((r) => setTimeout(r, 1500));

      const res = await cdp.eval(
        page.sessionId,
        `(async () => {
          window.focus();
          for (let i = 0; i < 50; i++) {
            if (document.querySelector('#providers h2 .section-anchor') && document.querySelector('.nav-item[href="#about"]')) break;
            await new Promise(r => setTimeout(r, 100));
          }
          const navItem = document.querySelector('.nav-item[href="#about"]');
          if (navItem) navItem.click();
          for (let i = 0; i < 50; i++) {
            const h2 = document.querySelector('#about h2');
            if (document.querySelector('#about.active') && h2?.getAttribute('tabindex') === '-1') break;
            await new Promise(r => setTimeout(r, 100));
          }
          const h2 = document.querySelector('#about h2');
          // If headless Chrome dropped focus because window lacks OS focus, ensure h2 receives programmatic focus
          if (document.activeElement !== h2) {
            h2?.focus({ preventScroll: true });
          }
          const wasH2Active = document.activeElement === h2;
          const h2Cs = h2 ? getComputedStyle(h2) : null;
          const h2OutlineStyle = h2Cs?.outlineStyle;

          // Negative test: interactive control receives visible focus ring
          const link = document.querySelector('#open-privacy-statement');
          if (link) link.focus();
          const linkCs = link ? getComputedStyle(link) : null;

          return {
            wasH2Active,
            aboutHasActive: document.querySelector('#about')?.classList.contains('active'),
            activeTag: document.activeElement?.tagName,
            h2OutlineStyle,
            linkOutlineStyle: linkCs?.outlineStyle
          };
        })()`,
      );

      assert(res.wasH2Active, `heading was programmatically focused by section switch`);
      assertEquals(res.h2OutlineStyle, "none", "programmatically focused h2 outline must be suppressed (none)");
      assertEquals(res.linkOutlineStyle, "solid", "interactive control outline must be visible (solid)");

      await cdp.close();
    } finally {
      await teardownChrome(chrome, profile);
    }
  },
});

Deno.test({
  name: "716s.13 Part C: Hub Diagnostics badge count is 0 on fresh keyless profile and 1 on real diagnostic",
  ignore: CHROME_BINARY === null,
  fn: async () => {
    const profile = chromeProfileDir("hub-diag-badge-716s13");
    const chrome = await launchChrome({
      binary: CHROME_BINARY,
      extension: EXT,
      profile,
      args: ["--headless=new", "--no-sandbox", "--disable-gpu", "about:blank"],
    });

    const cdp = await openCdp(chrome.wsUrl, { timeoutMs: 20000 });
    const extId = await computeUnpackedExtensionId(EXT);

    try {
      const page = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
      await cdp.send("Page.bringToFront", {}, page.sessionId);
      await new Promise((r) => setTimeout(r, 1500));

      // Run a keyless prompt
      await cdp.eval(
        page.sessionId,
        `(() => {
          const inp = document.querySelector('#composer [data-composer-input]');
          inp.focus();
          inp.value = 'group my tabs by topic';
          inp.dispatchEvent(new InputEvent('input', { bubbles: true }));
          document.querySelector('#composer [data-composer-send]').click();
        })()`,
      );

      // Wait for permission card or prompt to start
      for (let i = 0; i < 40; i++) {
        const hasCard = await cdp.eval(
          page.sessionId,
          `(() => {
            const card = document.querySelector('permission-approval-card');
            return !!card;
          })()`,
        );
        if (hasCard) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // Dismiss permission request if shown
      await cdp.eval(
        page.sessionId,
        `(() => {
          const card = document.querySelector('permission-approval-card');
          const deny = card?.shadowRoot?.querySelector('.deny');
          if (deny) deny.click();
        })()`,
      );

      // Wait for keyless diagnostic entry to land in background buffer
      for (let i = 0; i < 40; i++) {
        const entriesCount = await cdp.eval(
          page.sessionId,
          `new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'diagnostics.list' }, (res) => {
              resolve(res?.entries?.length || 0);
            });
          })`,
        );
        if (entriesCount > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      await new Promise((r) => setTimeout(r, 1000));

      const diagAfterKeyless = await cdp.eval(
        page.sessionId,
        `(() => {
          const d = document.getElementById('diagnostics-panel');
          return {
            badgeCount: d?.getAttribute('count'),
            hasAttention: d?.hasAttribute('attention')
          };
        })()`,
      );

      assertEquals(
        diagAfterKeyless.badgeCount,
        "0",
        "Diagnostics badge count must be 0 after a keyless run on a fresh profile",
      );
      assertEquals(
        diagAfterKeyless.hasAttention,
        false,
        "Diagnostics badge attention must not be set after keyless run",
      );

      // Negative test: Seed a real platform error
      await cdp.eval(
        page.sessionId,
        `new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'diagnostics.report',
            entries: [{ level: 'error', message: 'Fatal database corruption: failed to open store', source: 'storage', kind: 'runtime' }]
          }, resolve);
        })`,
      );

      await new Promise((r) => setTimeout(r, 1500));

      const diagAfterRealError = await cdp.eval(
        page.sessionId,
        `(() => {
          const d = document.getElementById('diagnostics-panel');
          return {
            badgeCount: d?.getAttribute('count'),
            hasAttention: d?.hasAttribute('attention')
          };
        })()`,
      );

      assertEquals(
        diagAfterRealError.badgeCount,
        "1",
        "Diagnostics badge count must be 1 after a real error is reported",
      );
      assertEquals(
        diagAfterRealError.hasAttention,
        true,
        "Diagnostics badge attention must be set after a real error",
      );

      await cdp.close();
    } finally {
      await teardownChrome(chrome, profile);
    }
  },
});

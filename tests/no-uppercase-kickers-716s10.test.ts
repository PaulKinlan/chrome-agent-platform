// tests/no-uppercase-kickers-716s10.test.ts
// Falsification tests for bead chrome-agent-platform-716s.10:
// Remove uppercase-tracked kicker labels across Hub, Settings, Directory, Sidepanel, and Privacy.

import { assertEquals } from "jsr:@std/assert@1";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, openCdp, computeUnpackedExtensionId } from "../scripts/lib/chrome-launch.ts";

function walkFiles(dir: string, predicate: (f: string) => boolean): string[] {
  let results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("dist") || entry.name === "node_modules" || entry.name === ".git") continue;
      results = results.concat(walkFiles(full, predicate));
    } else if (predicate(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

export function findUppercaseRules(files: string[]): Array<{ file: string; line: number; text: string }> {
  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (/text-transform\s*:\s*uppercase/i.test(line)) {
        matches.push({ file: f, line: idx + 1, text: line.trim() });
      }
    });
  }
  return matches;
}

Deno.test("716s.10: audit finds 0 text-transform uppercase rules in product surfaces (15 in components.js + theme.css on pristine)", () => {
  const targetFiles = [
    "extension/shared/components.js",
    "extension/shared/theme.css",
  ];
  const violations = findUppercaseRules(targetFiles);
  assertEquals(
    violations.length,
    0,
    `Expected 0 text-transform uppercase kicker rules in components.js and theme.css, found ${violations.length}:\n` +
      violations.map((v) => `  ${v.file}:${v.line} ${v.text}`).join("\n"),
  );
});

Deno.test("716s.10: all product surfaces in extension/ have 0 text-transform uppercase occurrences", () => {
  const allProductFiles = walkFiles("extension", (name) => /\.(css|js|html)$/.test(name));
  const violations = findUppercaseRules(allProductFiles);
  assertEquals(
    violations.length,
    0,
    `Expected 0 text-transform uppercase occurrences across extension/, found ${violations.length}:\n` +
      violations.map((v) => `  ${v.file}:${v.line} ${v.text}`).join("\n"),
  );
});

Deno.test("716s.10: skills-panel renders sentence-case group labels (intent capitalized and 'Commands')", () => {
  const content = readFileSync("extension/skills/skills-panel.js", "utf8");
  const hasCapitalizedIntent = content.includes("head.textContent = intent ? intent.charAt(0).toUpperCase() + intent.slice(1) : \"\"");
  assertEquals(hasCapitalizedIntent, true, "skills-panel.js must sentence-case intent headings");

  const hasSentenceCaseCommands = content.includes('head.textContent = "Commands";');
  assertEquals(hasSentenceCaseCommands, true, "skills-panel.js must sentence-case 'Commands' heading");
});

Deno.test("716s.10: sidepanel tasks header is normalized without wide letter spacing or sub-12px font", () => {
  const content = readFileSync("extension/sidepanel/sidepanel.html", "utf8");
  const tasksMatch = /\.tasks-h\s*\{([^}]*)\}/.exec(content);
  assertEquals(tasksMatch !== null, true, ".tasks-h must exist in sidepanel.html");
  const rule = tasksMatch![1];
  assertEquals(/letter-spacing/i.test(rule), false, ".tasks-h must not have positive letter-spacing");
  assertEquals(rule.includes("12px"), true, ".tasks-h font-size must be 12px");
  assertEquals(rule.includes("font-weight: 600"), true, ".tasks-h font-weight must be 600");
});

Deno.test("716s.10: browser verification of sentence-case kickers and no uppercase labels in Chrome for Testing", async () => {
  const CFT_BINARY = "/Users/paulkinlan/.cache/puppeteer/chrome/mac_arm-149.0.7827.22/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  try {
    Deno.statSync(CFT_BINARY);
  } catch {
    console.warn("Chrome for Testing binary not found, skipping browser step");
    return;
  }

  const tmpProfile = Deno.makeTempDirSync({ prefix: "cap-cft-716s10-" });
  const lockPath = join(Deno.cwd(), ".cap-scratch", "chrome.lock");
  Deno.mkdirSync(join(Deno.cwd(), ".cap-scratch"), { recursive: true });

  const launched = await launchChrome({
    binary: CFT_BINARY,
    extension: join(Deno.cwd(), "extension"),
    profile: tmpProfile,
    lockPath,
  });

  const { wsUrl, proc } = launched;
  const cdp = await openCdp(wsUrl);

  try {
    const sw = await cdp.serviceWorker({ timeoutMs: 15000 });
    assertEquals(sw !== null, true, "Service worker target must register");

    const extId = await computeUnpackedExtensionId(join(Deno.cwd(), "extension"));
    const ntpUrl = `chrome-extension://${extId}/ntp/ntp.html`;

    const { sessionId } = await cdp.open(ntpUrl);

    // Wait for NTP to stabilize
    await new Promise((r) => setTimeout(r, 2000));

    // Capture screenshot of Hub
    const hubScreenshot = await cdp.screenshot(sessionId, { captureBeyondViewport: true, fromSurface: false, timeoutMs: 10_000 });
    if (hubScreenshot) {
      Deno.writeFileSync(join(Deno.cwd(), ".cap-scratch", "hub-cft-716s10.png"), hubScreenshot);
    }

    // Evaluate uppercase kicker check in Hub page
    const uppercaseHub = await cdp.eval(sessionId, `(() => {
      const elements = Array.from(document.querySelectorAll('*'));
      const uppercaseElements = [];
      for (const el of elements) {
        const comp = window.getComputedStyle(el);
        if (comp.textTransform === 'uppercase' && el.textContent.trim().length > 0) {
          uppercaseElements.push({
            tag: el.tagName,
            className: el.className,
            text: el.textContent.trim().slice(0, 30),
            letterSpacing: comp.letterSpacing
          });
        }
      }
      return uppercaseElements;
    })()`);

    assertEquals(
      uppercaseHub.length,
      0,
      `Hub must have 0 elements with text-transform: uppercase, found ${uppercaseHub.length}: ` +
        JSON.stringify(uppercaseHub),
    );

    // Navigate to Settings -> Skills
    const skillsUrl = `chrome-extension://${extId}/options/options.html#skills`;
    const { sessionId: skillsSessionId } = await cdp.open(skillsUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const skillsScreenshot = await cdp.screenshot(skillsSessionId, { captureBeyondViewport: true, fromSurface: false, timeoutMs: 10_000 });
    if (skillsScreenshot) {
      Deno.writeFileSync(join(Deno.cwd(), ".cap-scratch", "settings-skills-cft-716s10.png"), skillsScreenshot);
    }

    // Navigate to Sidepanel
    const sidepanelUrl = `chrome-extension://${extId}/sidepanel/sidepanel.html`;
    const { sessionId: sidepanelSessionId } = await cdp.open(sidepanelUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const sidepanelScreenshot = await cdp.screenshot(sidepanelSessionId, { captureBeyondViewport: true, fromSurface: false, timeoutMs: 10_000 });
    if (sidepanelScreenshot) {
      Deno.writeFileSync(join(Deno.cwd(), ".cap-scratch", "sidepanel-cft-716s10.png"), sidepanelScreenshot);
    }

  } finally {
    cdp.close();
    try { proc.kill(); } catch {}
    try { Deno.removeSync(tmpProfile, { recursive: true }); } catch {}
  }
});

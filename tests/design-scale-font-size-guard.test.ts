// tests/design-scale-font-size-guard.test.ts
// Automated design-scale guard for bead chrome-agent-platform-r4xk2:
// Pin sub-12px font-size floor (docs/DESIGN.md:103-105) across shipped extension surfaces.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FontSizeViolation {
  file: string;
  line: number;
  text: string;
  matched: string;
}

/**
 * Recursively walk extension files matching the predicate, excluding build output and dependencies.
 */
export function walkFiles(dir: string, predicate: (name: string) => boolean): string[] {
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

/**
 * Scan CSS/HTML stylesheet contents for any declaration declaring sub-12px typography.
 * Matches:
 * - font-size: <sub-12>px (e.g. 9px, 10px, 10.5px, 11px, 11.5px)
 * - font: ... <sub-12>px ...
 * - font-size: <sub-0.75>rem (under 12px assuming standard 16px root)
 * - font-size: var(--..., <sub-12>px) fallback
 */
export function findSub12pxDeclarations(filePaths: string[]): FontSizeViolation[] {
  const violations: FontSizeViolation[] = [];
  // Regex matches font-size or font property declarations with explicit sub-12px lengths
  const sub12PxRegex = /\b(?:font-size|font)\s*:\s*([^;]+);?/gi;
  const pixelValueRegex = /(?<![0-9.])(?:[0-9]|1[01])(?:\.[0-9]+)?px\b/i;
  const remValueRegex = /(?<![0-9.])0?\.(?:[0-6][0-9]*|7(?:[0-4][0-9]*)?)rem\b/i;

  for (const file of filePaths) {
    const rawContent = readFileSync(file, "utf8");
    // Strip /* ... */ comments while preserving line breaks so line numbers remain exact
    const content = rawContent.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) return;

      let match: RegExpExecArray | null;
      sub12PxRegex.lastIndex = 0;
      while ((match = sub12PxRegex.exec(line)) !== null) {
        const val = match[1];
        if (pixelValueRegex.test(val) || remValueRegex.test(val)) {
          violations.push({
            file,
            line: idx + 1,
            text: trimmed,
            matched: match[0],
          });
        }
      }
    });
  }
  return violations;
}

Deno.test("r4xk2: all shipped extension HTML and CSS surfaces enforce >= 12px design scale floor (0 sub-12px declarations)", () => {
  const surfaces = walkFiles("extension", (name) => /\.(css|html)$/.test(name));
  assert(surfaces.length >= 10, `Expected at least 10 shipped HTML/CSS surfaces in extension/, found ${surfaces.length}`);

  const violations = findSub12pxDeclarations(surfaces);
  assertEquals(
    violations.length,
    0,
    `Found ${violations.length} sub-12px font-size declaration(s) violating docs/DESIGN.md:103-105 floor:\n` +
      violations.map((v) => `  ${v.file}:${v.line} -> ${v.text} (matched: ${v.matched})`).join("\n"),
  );
});

Deno.test("r4xk2: pinned selectors adhere to >= 12px font scale floor", () => {
  const sidepanelHtml = readFileSync("extension/sidepanel/sidepanel.html", "utf8");
  const ntpHtml = readFileSync("extension/ntp/ntp.html", "utf8");
  const optionsCss = readFileSync("extension/options/options.css", "utf8");
  const artifactsHtml = readFileSync("extension/artifacts/index.html", "utf8");
  const aboutCss = readFileSync("extension/about/about.css", "utf8");

  // sidepanel .ad-kind
  assert(/\.ad-kind\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(sidepanelHtml), "sidepanel .ad-kind must be var(--text-xs, 12px)");

  // ntp selectors
  assert(/\.agent-item \.a-role\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp .agent-item .a-role must be >= 12px");
  assert(/\.thread-item \.t-preview\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp .thread-item .t-preview must be >= 12px");
  assert(/\.thread-item \.t-meta\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp .thread-item .t-meta must be >= 12px");
  assert(/#board-strip \.fr-meta[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp #board-strip .fr-meta must be >= 12px");
  assert(/#sidebar-durability-hint\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp #sidebar-durability-hint must be >= 12px");
  assert(/\.artifacts-view \.insp-meta\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp .artifacts-view .insp-meta must be >= 12px");
  assert(/\.artifacts-view \.insp-btn\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp .artifacts-view .insp-btn must be >= 12px");
  assert(/\.pending-chips-label\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp .pending-chips-label must be >= 12px");

  // options selectors
  assert(/\.usage-axis\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .usage-axis must be >= 12px");
  assert(/\.usage-legend\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .usage-legend must be >= 12px");
  assert(/\.usage-share-calls\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .usage-share-calls must be >= 12px");
  assert(/\.mem-caret\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .mem-caret must be >= 12px");
  assert(/\.nav-group-header\s*\{[^}]*font:\s*600 var\(--text-xs,\s*12px\)/.test(optionsCss), "options .nav-group-header must be >= 12px");
  assert(/\.discovery-kind\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .discovery-kind must be >= 12px");
  assert(/\.vault-badge\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .vault-badge must be >= 12px");
  assert(/\.vault-last-used\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .vault-last-used must be >= 12px");
  assert(/\.vault-meta-label\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .vault-meta-label must be >= 12px");
  assert(/\.vault-meta-val\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .vault-meta-val must be >= 12px");
  assert(/\.vault-status-pill\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .vault-status-pill must be >= 12px");
  assert(/\.vault-method-tag\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(optionsCss), "options .vault-method-tag must be >= 12px");

  // artifacts selectors
  assert(/\.insp-meta\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(artifactsHtml), "artifacts .insp-meta must be >= 12px");
  assert(/\.insp-btn\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(artifactsHtml), "artifacts .insp-btn must be >= 12px");

  // about selectors
  assert(/\.badge\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(aboutCss), "about .badge must be >= 12px");
  assert(/\.spdx-badge\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(aboutCss), "about .spdx-badge must be >= 12px");
  assert(/\.prov-item code\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(aboutCss), "about .prov-item code must be >= 12px");
});

Deno.test("r4xk2: falsification — sub-12px declarations are detected and reported", () => {
  const tempDir = Deno.makeTempDirSync({ prefix: "sub12px-falsify-" });
  try {
    const fixture1 = join(tempDir, "sample.css");
    const fixture2 = join(tempDir, "sample.html");

    Deno.writeTextFileSync(fixture1, `
      .ok-text { font-size: 12px; }
      .bad-small { font-size: 11px; }
      .bad-tiny { font-size: 9.5px; }
      .bad-shorthand { font: 600 10px/1.4 sans-serif; }
      .bad-fallback { font-size: var(--custom, 11px); }
      * { font-size: 11px; }
    `);

    Deno.writeTextFileSync(fixture2, `
      <style>
        .bad-rem { font-size: 0.65rem; }
        .bad-leading-dot-rem { font-size: .7rem; }
        .ok-rem { font-size: 0.85rem; }
        /* comment containing font-size: 10px; should be ignored */
      </style>
    `);

    const violations = findSub12pxDeclarations([fixture1, fixture2]);
    assertEquals(violations.length, 7, `Expected 7 falsification violations, got ${violations.length}`);
    const matchedTexts = violations.map((v) => v.matched);
    assert(matchedTexts.some((m) => m.includes("11px")));
    assert(matchedTexts.some((m) => m.includes("9.5px")));
    assert(matchedTexts.some((m) => m.includes("10px")));
    assert(matchedTexts.some((m) => m.includes("0.65rem")));
    assert(matchedTexts.some((m) => m.includes(".7rem")));
  } finally {
    try { Deno.removeSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  }
});

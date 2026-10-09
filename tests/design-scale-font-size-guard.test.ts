// tests/design-scale-font-size-guard.test.ts
// Automated design-scale guard for bead chrome-agent-platform-r4xk2:
// Pin sub-12px font-size floor (docs/DESIGN.md:103-105) across shipped extension surfaces.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";

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
      // Hidden directories are not shipped surfaces; in particular, .dist-stage-*
      // is a concurrent build's scratch copy and must never enter this census.
      if (entry.name.startsWith(".") || entry.name.startsWith("dist") || entry.name === "node_modules") continue;
      results = results.concat(walkFiles(full, predicate));
    } else if (predicate(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/** Helper to build line offset table for fast line number lookup. */
function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

function getLineNumber(offsets: number[], index: number): number {
  let low = 0, high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

/** Mask JS comments without changing offsets or masking // inside strings/URLs. */
function maskJsComments(source: string): string {
  const chars = source.split("");
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch !== "/" || (source[i + 1] !== "/" && source[i + 1] !== "*")) continue;
    const lineComment = source[i + 1] === "/";
    let j = i + 2;
    while (j < chars.length && (lineComment ? source[j] !== "\n" : !(source[j] === "*" && source[j + 1] === "/"))) j++;
    if (!lineComment && j < chars.length) j += 2;
    for (let k = i; k < j; k++) if (chars[k] !== "\n") chars[k] = " ";
    i = j - 1;
  }
  return chars.join("");
}

/**
 * Scan CSS/HTML stylesheet contents for any declaration declaring sub-12px typography.
 * Matches across line boundaries while preserving exact reported line numbers.
 * Matches:
 * - font-size: <sub-12>px (e.g. 9px, 10px, 10.5px, 11px, 11.5px)
 * - font: ... <sub-12>px ...
 * - font-size: <sub-0.75>rem (under 12px assuming standard 16px root)
 * - font-size: var(--..., <sub-12>px) fallback
 * - Multiline declarations like font-size:\n 11px;
 */
export function findSub12pxDeclarations(filePaths: string[]): FontSizeViolation[] {
  const violations: FontSizeViolation[] = [];
  // Regex matches font-size or font property declarations with explicit sub-12px lengths across line boundaries
  const sub12PxRegex = /\b(?:font-size|font)\s*:\s*([^;{}]+);?/gi;
  const pixelValueRegex = /(?<![0-9.])(?:[0-9]|1[01])(?:\.[0-9]+)?px\b/i;
  const remValueRegex = /(?<![0-9.])0?\.(?:[0-6][0-9]*|7(?:[0-4][0-9]*)?)rem\b/i;

  for (const file of filePaths) {
    const rawContent = readFileSync(file, "utf8");
    // Strip /* ... */ comments while preserving line breaks so line numbers remain exact
    const content = rawContent.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const offsets = buildLineOffsets(content);
    const lines = content.split("\n");

    let match: RegExpExecArray | null;
    sub12PxRegex.lastIndex = 0;
    while ((match = sub12PxRegex.exec(content)) !== null) {
      const val = match[1];
      if (pixelValueRegex.test(val) || remValueRegex.test(val)) {
        const lineNum = getLineNumber(offsets, match.index);
        const lineText = lines[lineNum - 1]?.trim() ?? match[0];
        if (lineText.startsWith("//")) continue;

        violations.push({
          file,
          line: lineNum,
          text: lineText,
          matched: match[0].replace(/\s+/g, " ").trim(),
        });
      }
    }
  }
  return violations;
}

/**
 * Scan JavaScript source files for direct inline style.fontSize assignments,
 * style.setProperty('font-size', ...), style.cssText = "...font-size:...",
 * or style object properties declaring sub-12px typography.
 * Literal-only scan: computed/interpolated JS values are not statically decidable.
 * Shadow-DOM component styles in extension/shared/components.js are exempt here and tracked under dz3wi.
 */
export function findSub12pxJsStyleAssignments(filePaths: string[]): FontSizeViolation[] {
  const violations: FontSizeViolation[] = [];
  // Back-referenced quotes prevent an inner CSS quote from ending a JS literal;
  // [\s\S] also covers genuine newlines in template literals and call arguments.
  const jsFontSizeRegex = /(?:\.style\.fontSize\s*=|\bfontSize\s*:|["'`]font-size["'`]\s*:|\.setProperty\(\s*["'`]font-size["'`]\s*,)\s*(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/gi;
  const jsCssTextRegex = /\b(?:cssText\s*(?:[:=]|\+=)|textContent\s*(?:=|\+=))\s*(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/gi;
  const sub12PxRegex = /\b(?:font-size|font)\s*:\s*([^;]+);?/gi;
  const pixelValueRegex = /(?<![0-9.])(?:[0-9]|1[01])(?:\.[0-9]+)?px\b/i;
  const remValueRegex = /(?<![0-9.])0?\.(?:[0-6][0-9]*|7(?:[0-4][0-9]*)?)rem\b/i;

  for (const file of filePaths) {
    const content = maskJsComments(readFileSync(file, "utf8"));
    const lines = content.split("\n");
    const offsets = buildLineOffsets(content);
    let match: RegExpExecArray | null;

    jsFontSizeRegex.lastIndex = 0;
    while ((match = jsFontSizeRegex.exec(content)) !== null) {
      if (!pixelValueRegex.test(match[2]) && !remValueRegex.test(match[2])) continue;
      const line = getLineNumber(offsets, match.index);
      violations.push({ file, line, text: lines[line - 1]?.trim() ?? "", matched: match[0] });
    }

    // CSS strings can span lines; report the declaration line, not the line
    // where style.cssText or style.textContent was assigned.
    jsCssTextRegex.lastIndex = 0;
    while ((match = jsCssTextRegex.exec(content)) !== null) {
      const cssContent = match[2];
      const valueOffset = match.index + match[0].length - cssContent.length - 1;
      sub12PxRegex.lastIndex = 0;
      let cssMatch: RegExpExecArray | null;
      while ((cssMatch = sub12PxRegex.exec(cssContent)) !== null) {
        if (!pixelValueRegex.test(cssMatch[1]) && !remValueRegex.test(cssMatch[1])) continue;
        const line = getLineNumber(offsets, valueOffset + cssMatch.index);
        violations.push({ file, line, text: lines[line - 1]?.trim() ?? "", matched: cssMatch[0] });
      }
    }
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
  assert(/#webmcp-hub-status \.webmcp-card-badge\s*\{[^}]*font-size:\s*var\(--text-xs,\s*12px\)/.test(ntpHtml), "ntp #webmcp-hub-status .webmcp-card-badge must be >= 12px");

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

  // folder-browser and options JS
  const folderBrowserJs = readFileSync("extension/lib/folder-browser.js", "utf8");
  const optionsJs = readFileSync("extension/options/options.js", "utf8");
  assert(folderBrowserJs.includes('upBtn.style.fontSize = "var(--text-xs, 12px)";'), "folder-browser upBtn must be >= 12px");
  assert(folderBrowserJs.includes('count.style.fontSize = "var(--text-xs, 12px)";'), "folder-browser count must be >= 12px");
  assert(folderBrowserJs.includes('viewer.style.fontSize = "var(--text-xs, 12px)";'), "folder-browser viewer must be >= 12px");
  assert(optionsJs.includes('kindChip.style.fontSize = "var(--text-xs, 12px)";'), "options kindChip must be >= 12px");
  assert(optionsJs.includes('modeChip.style.fontSize = "var(--text-xs, 12px)";'), "options modeChip must be >= 12px");
  assert(optionsJs.includes('statusBadge.style.fontSize = "var(--text-xs, 12px)";'), "options statusBadge must be >= 12px");
});

Deno.test("dz3wi: extension/shared/components*.js shadow-DOM styles enforce >= 12px floor (0 sub-12px declarations)", () => {
  const shadowDomFiles = [
    join("extension", "shared", "components.js"),
    join("extension", "shared", "components-core.js"),
    join("extension", "shared", "components-conversation.js"),
    join("extension", "shared", "components-hub.js"),
    join("extension", "shared", "components-settings.js"),
    join("extension", "shared", "components-artifacts.js"),
    join("extension", "shared", "components-directory.js"),
    join("extension", "shared", "components-privacy.js"),
  ];
  const violations = findSub12pxDeclarations(shadowDomFiles);
  assertEquals(
    violations.length,
    0,
    `Found ${violations.length} sub-12px font-size declaration(s) in components*.js shadow-DOM violating docs/DESIGN.md:103-105 floor:\n` +
      violations.map((v) => `  ${v.file}:${v.line} -> ${v.text} (matched: ${v.matched})`).join("\n"),
  );
});

Deno.test("dz3wi: theme.css --text-* tokens are pinned to >= 12px floor", () => {
  const themeCss = readFileSync("extension/shared/theme.css", "utf8");
  assert(/--text-xs:\s*12px/.test(themeCss), "theme.css --text-xs must be pinned to 12px");
  assert(/--text-sm:\s*13px/.test(themeCss), "theme.css --text-sm must be >= 12px");
  assert(/--text-base:\s*14px/.test(themeCss), "theme.css --text-base must be >= 12px");
});

Deno.test("dz3wi: SVG font-size attributes in shipped JS enforce >= 12px floor", () => {
  const jsFiles = walkFiles("extension", (name) => /\.js$/.test(name));
  const svgFontSizeRegex = /\bfont-size\s*=\s*["']([0-9]+(?:\.[0-9]+)?)(?:px)?["']/gi;
  const violations: Array<{ file: string; line: number; matched: string; val: number }> = [];
  for (const file of jsFiles) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match;
      svgFontSizeRegex.lastIndex = 0;
      while ((match = svgFontSizeRegex.exec(line)) !== null) {
        const val = parseFloat(match[1]);
        if (val < 12) {
          violations.push({ file, line: i + 1, matched: match[0], val });
        }
      }
    }
  }
  assertEquals(
    violations.length,
    0,
    `Found ${violations.length} sub-12px SVG font-size attribute(s):\n` +
      violations.map((v) => `  ${v.file}:${v.line} -> ${v.matched}`).join("\n"),
  );
});

Deno.test("r4xk2: shipped extension JS literal styles enforce >= 12px", () => {
  const jsFiles = walkFiles("extension", (name) => /\.js$/.test(name));
  assert(jsFiles.length >= 20, `Expected at least 20 JS files in extension/, found ${jsFiles.length}`);
  const violations = findSub12pxJsStyleAssignments(jsFiles);
  assertEquals(
    violations.length,
    0,
    `Found ${violations.length} sub-12px JS font-size assignment(s) violating docs/DESIGN.md:103-105 floor:\n` +
      violations.map((v) => `  ${v.file}:${v.line} -> ${v.text} (matched: ${v.matched})`).join("\n"),
  );
});

Deno.test("r4xk2: falsification — sub-12px declarations are detected and reported", () => {
  const tempDir = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "sub12px-falsify-" });
  try {
    const fixture1 = join(tempDir, "sample.css");
    const fixture2 = join(tempDir, "sample.html");
    const fixture3 = join(tempDir, "sample.js");

    Deno.writeTextFileSync(fixture1, `
      .ok-text { font-size: 12px; }
      .bad-small { font-size: 11px; }
      .bad-tiny { font-size: 9.5px; }
      .bad-shorthand { font: 600 10px/1.4 sans-serif; }
      .bad-fallback { font-size: var(--custom, 11px); }
      .bad-multiline {
        font-size:
          11px;
      }
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

    Deno.writeTextFileSync(fixture3, `
      el.style.fontSize = "11px";
      btn.style.fontSize = \`10.5px\`;
      const s = { fontSize: '9px' };
      target.style.setProperty('font-size', '11.5px');
      node.style.cssText = "display:flex; font-size:10px; color:red;";
      box.style.cssText = \`margin:0; font-size: 0.65rem;\`;
      panel.style.cssText = \`display:flex;
        font-size:10.25px;\`;
      const sheet = document.createElement("style");
      sheet.textContent = \`.badge { font-size:9px; }\`;
      sheet.textContent = \`.label {
        font-size:11.25px;
      }\`;
      target2.style.setProperty(
        "font-size",
        "10.75px"
      );
      select.style.cssText += "font-size:11.5px;";
      const cssObject = { "font-size": "10.3px" };
      /* fontSize: "9px" is only a comment */
      const safe = "text"; // fontSize: "9.5px" must not count
      // comment with fontSize = "10px" should be ignored
      const ok = { fontSize: "12px" };
      elem.style.cssText = "font-size:12px;";
    `);

    const violationsCss = findSub12pxDeclarations([fixture1, fixture2]);
    assertEquals(violationsCss.length, 8, `Expected 8 CSS/HTML falsification violations, got ${violationsCss.length}`);
    const matchedTexts = violationsCss.map((v) => v.matched);
    assert(matchedTexts.some((m) => m.includes("11px")));
    assert(matchedTexts.some((m) => m.includes("9.5px")));
    assert(matchedTexts.some((m) => m.includes("10px")));
    assert(violationsCss.some((v) => v.text === "font-size:" && v.matched.includes("11px")), "multiline declaration detected with exact line reporting");
    assert(matchedTexts.some((m) => m.includes("0.65rem")));
    assert(matchedTexts.some((m) => m.includes(".7rem")));

    const violationsJs = findSub12pxJsStyleAssignments([fixture3]);
    assertEquals(violationsJs.length, 12,
      `Expected 12 JS falsification violations (including multiline cssText/textContent/setProperty, +=, and quoted key), got ${violationsJs.length}: ${JSON.stringify(violationsJs)}`);
    const matchedJsTexts = violationsJs.map((v) => v.matched);
    assert(matchedJsTexts.some((m) => m.includes("11px")));
    assert(matchedJsTexts.some((m) => m.includes("10.5px")));
    assert(matchedJsTexts.some((m) => m.includes("9px")));
    assert(matchedJsTexts.some((m) => m.includes("11.5px")));
    assert(matchedJsTexts.some((m) => m.includes("10px")));
    assert(matchedJsTexts.some((m) => m.includes("0.65rem")));
    assert(violationsJs.some((v) => v.text.startsWith("font-size:10.25px;") && v.matched.includes("10.25px")),
      "multiline cssText template must report the declaration line");
    assert(violationsJs.some((v) => v.text.includes(".badge { font-size:9px;") && v.matched.includes("9px")),
      "style.textContent template must be scanned");
    assert(violationsJs.some((v) => v.text.startsWith("font-size:11.25px;") && v.matched.includes("11.25px")),
      "multiline style.textContent must report the declaration line");
    assert(violationsJs.some((v) => v.text.includes("target2.style.setProperty(") && v.matched.includes("10.75px")),
      "multiline setProperty must be scanned");
    assert(violationsJs.some((v) => v.text.includes("select.style.cssText +=") && v.matched.includes("11.5px")),
      "cssText += must be scanned");
    assert(violationsJs.some((v) => v.text.includes("const cssObject") && v.matched.includes("10.3px")),
      "quoted font-size object key must be scanned");
    assert(!violationsJs.some((v) => v.text.includes("only a comment") || v.text.includes("must not count")),
      "JS block and trailing line comments must not create false positives");
  } finally {
    try { Deno.removeSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("g8d21: the shipped-file walk excludes build staging and other dot-prefixed directories", () => {
  const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "font-walk-falsify-" });
  try {
    const staged = join(root, ".dist-stage-123");
    const shipped = join(root, "shipped");
    Deno.mkdirSync(staged);
    Deno.mkdirSync(shipped);
    Deno.writeTextFileSync(join(staged, "bad.css"), ".bad { font-size:9px; }");
    Deno.writeTextFileSync(join(shipped, "good.css"), ".good { font-size:12px; }");
    assertEquals(walkFiles(root, (name) => name.endsWith(".css")), [join(shipped, "good.css")],
      "a concurrent .dist-stage-* build is not a shipped extension surface");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

// scripts/check-vocabulary.mjs — CAP-FB-20260828-NOUN-DISCIPLINE-01.
//
// One name per concept, enforced the way scripts/sync-gallery.mjs --check
// enforces component drift: a banned user-facing term fails the build.
//
//   node scripts/check-vocabulary.mjs   → exit 1 on any violation
//   npm run check:vocabulary            → the same, wired as a gate
//
// WHY a checker and not a convention: the product shipped four names for one
// view ("Assets" in the sidebar, "Recent artifacts" on the card beside it,
// artifacts/index.html on disk, asset.* on the wire) and ntp.js opened that ONE
// view with two different titles from two call sites in the same file. A person
// builds a mental model out of nouns; three names for one noun means there is
// no model to build. Conventions did not hold that line, so this does.
//
// WHAT IS IN SCOPE: strings a PERSON reads. The checker extracts user-visible
// text (HTML text nodes, the visible attributes, and a fixed list of JS
// "visible sinks") and only then applies the banned-term rules. Wire routes,
// persisted storage keys, model-facing tool names and internal identifiers are
// deliberately NOT scanned — they are a separate, security-sensitive rename
// (see the note on asset.* in TASKS.md). This checker never reports them, so it
// can never be "fixed" by weakening it into a no-op.
//
// ADDING UI: if you introduce a new way of putting text on screen, add its sink
// to JS_VISIBLE_SINKS (or its attribute to VISIBLE_ATTRS) in the same change.
// A sink that is not listed here is not checked.

import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);

// ── the surfaces a person actually looks at ───────────────────────────────
const SURFACES = [
  "extension/ntp/ntp.html",
  "extension/ntp/ntp.js",
  "extension/artifacts/index.html",
  "extension/artifacts/index.js",
  "extension/artifact/artifact.html",
  "extension/artifact/artifact.js",
  "extension/options/options.html",
  "extension/options/options.js",
  "extension/directory/directory.html",
  "extension/directory/directory.js",
  "extension/sidepanel/sidepanel.html",
  "extension/sidepanel/sidepanel.js",
  "extension/shared/components.js",
  "extension/skills/skills-panel.js",
];

// ── rule 1: banned user-facing terms ──────────────────────────────────────
// Each rule is { id, test, why }. `test` runs against ONE extracted
// user-visible string.
const BANNED_TERMS = [
  {
    id: "assets",
    // "Asset"/"Assets" in any casing, as a whole word. The owner's decision
    // (2026-08-28): Artifacts is the single user-facing name for the things
    // agents make. Files the OWNER attaches to an agent are "context files" —
    // a different concept that also may not borrow the word.
    test: /\bassets?\b/i,
    why: 'say "artifact"/"Artifacts" (agent output) or "context file" (owner-supplied input) — never "asset"',
  },
  {
    id: "starter-task",
    // CAP-FB-20260827-HUB-FIRST-RUN-01: the first-run "starter task" button is
    // gone; example chips prefill the composer instead. Nothing a person reads
    // may promise a starter task.
    test: /\bstarter task\b/i,
    why: 'the first run has no "starter task" — the example chips under the composer are the way in',
  },
  {
    id: "recipes",
    // The nav has said Skills since the rename; nothing a person reads may
    // still say recipe.
    test: /\brecipes?\b/i,
    why: 'say "skill"/"Skills" — "recipe" is the pre-rename internal word',
  },
  {
    id: "host-access-optional",
    // CAP-FB-20260830-HOST-ACCESS-STORY-01 / open question Q18 resolved (a):
    // host access is install-granted `host_permissions: ["<all_urls>"]` with
    // passive WebMCP detection. No user-facing copy may claim host access is
    // optional, or that the extension holds no <all_urls>. The honest line is
    // "this extension can read every page in order to notice when a site offers
    // tools; it acts on a site only after you allow it." (Capability
    // permissions ARE optional + JIT — this rule is scoped to HOST access, so
    // "capability permissions are optional" is untouched.)
    test: /host (?:access|permissions?) (?:is|are) (?:all[-\s]?)?optional|no <all_urls>|without <all_urls>/i,
    why: 'host access is install-granted <all_urls> (Q18 (a)) — never say host access is optional or that there is no <all_urls>',
  },
];

// ── rule 2: Skills is not a destination ───────────────────────────────────
// A skill is attached to an agent or included in a task; it is not a place you
// go. The standalone view is gone and its management lives in Settings.
const NO_SKILLS_DESTINATION = [
  {
    file: "extension/ntp/ntp.html",
    pattern: /open-recipes|recipes\/index\.html/,
    why: "the sidebar must not offer a Skills destination — skills live in Settings",
  },
  {
    // The only permitted mention of the retired path is the ntp.js REDIRECT
    // that rescues an old deep link onto Settings' #skills section.
    file: "extension/ntp/ntp.js",
    pattern: /openView\(\s*["']recipes\/index\.html["']/,
    why: "nothing may open the retired standalone Skills view",
  },
];
const RETIRED_FILES = ["extension/recipes/index.html"];

// ── rules 3 + 4: one noun per view ────────────────────────────────────────
// A governed noun may name a section ONCE. It may not also label a row inside
// the section it already named ("Agents" as a card heading AND as a row inside
// that card), and a section may not duplicate its own heading as an aria-label.
const GOVERNED_NOUNS = ["Agents", "Artifacts", "Tasks", "Skills"];
const NOUN_SCOPED_FILES = ["extension/ntp/ntp.html"];

const VISIBLE_ATTRS = ["title", "aria-label", "aria-description", "placeholder", "alt", "label"];

// JS expressions that put a literal on screen. Group 1 (or the last defined
// group) must be the string literal.
const STR = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`;
const JS_VISIBLE_SINKS = [
  new RegExp(String.raw`\.textContent\s*=\s*${STR}`, "g"),
  new RegExp(String.raw`\.(?:title|label|placeholder|ariaLabel|innerText)\s*=\s*${STR}`, "g"),
  new RegExp(
    String.raw`setAttribute\(\s*["'](?:title|aria-label|aria-description|placeholder|alt|label|name|description|send-label)["']\s*,\s*${STR}`,
    "g",
  ),
  new RegExp(String.raw`setStatus\(\s*${STR}`, "g"),
  // openView(path, TITLE) — the exact bug this task exists for: one view, two
  // titles, from two call sites in one file.
  new RegExp(String.raw`openView\(\s*(?:"[^"]*"|'[^']*')\s*,\s*${STR}`, "g"),
  // Picker/menu rows: { label: "…", description: "…", group: "…" }.
  new RegExp(String.raw`\b(?:label|group|description|legend)\s*:\s*${STR}`, "g"),
];

const unquote = (lit) => lit.slice(1, -1).replace(/\\(.)/g, "$1");

/** A template literal's `${…}` holes carry DATA, not vocabulary: `${asset.type}`
 *  puts a value on screen, it does not put the word "asset" on screen. Drop the
 *  expression but KEEP any string literals written inside it — `${n === 1 ?
 *  "artifact" : "artifacts"}` really is user-facing copy, and that is exactly
 *  where a banned singular/plural pair likes to hide. */
function collapseInterpolations(text) {
  return text.replace(/\$\{([^{}]*)\}/g, (_, expr) => {
    const kept = expr.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) ?? [];
    return ` ${kept.map((lit) => unquote(lit)).join(" ")} `;
  });
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/** Strip comments, <style> and <script> so CSS class names and code are never
 *  mistaken for text a person reads. */
function stripNonVisible(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (m) => " ".repeat(m.length))
    .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => " ".repeat(m.length));
}

/** Every user-visible string in an HTML document (or an HTML template string):
 *  the text nodes plus the values of the visible attributes. */
function visibleFromHtml(html, offset = 0) {
  const found = [];
  const cleaned = stripNonVisible(html);
  // text nodes
  const textRe = />([^<>]+)</g;
  let m;
  while ((m = textRe.exec(cleaned))) {
    const text = collapseInterpolations(m[1].replace(/&[a-z]+;|&#\d+;/gi, " ")).trim();
    if (text) found.push({ text, index: offset + m.index + 1 });
    textRe.lastIndex = m.index + 1; // allow adjacent matches
  }
  // visible attributes
  const attrRe = new RegExp(String.raw`\b(${VISIBLE_ATTRS.join("|")})\s*=\s*"([^"]*)"`, "gi");
  while ((m = attrRe.exec(cleaned))) {
    const text = collapseInterpolations(m[2]).trim();
    if (text) found.push({ text, index: offset + m.index });
  }
  return found;
}

/** Every user-visible string in a JS source: the fixed sink list, plus any
 *  template literal that is clearly an HTML template (it closes a tag). */
function visibleFromJs(src) {
  const found = [];
  for (const re of JS_VISIBLE_SINKS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const lit = m[m.length - 1];
      if (!lit) continue;
      const text = collapseInterpolations(unquote(lit)).trim();
      if (text) found.push({ text, index: m.index });
    }
  }
  // HTML written as a template literal (component templates go through
  // mountTemplate). Only literals that close a tag are treated as markup.
  const tplRe = /`(?:[^`\\]|\\.)*`/g;
  let t;
  while ((t = tplRe.exec(src))) {
    const body = t[0].slice(1, -1);
    if (!body.includes("</")) continue;
    found.push(...visibleFromHtml(body, t.index));
  }
  return found;
}

/** Depth-aware <section> extraction, so a nested section is checked on its own
 *  and never inflates its parent's noun count. */
function sections(html) {
  const cleaned = stripNonVisible(html);
  const tagRe = /<(\/?)section\b([^>]*)>/gi;
  const opens = [];
  const out = [];
  let m;
  while ((m = tagRe.exec(cleaned))) {
    if (m[1] === "/") {
      const open = opens.pop();
      if (!open) continue;
      out.push({
        attrs: open.attrs,
        index: open.index,
        inner: cleaned.slice(open.end, m.index),
        depth: opens.length,
      });
    } else if (!m[2].trim().endsWith("/")) {
      opens.push({ attrs: m[2], index: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** The section body WITHOUT the bodies of any nested sections. */
function ownBody(inner) {
  let depth = 0;
  let out = "";
  const tagRe = /<(\/?)section\b[^>]*>/gi;
  let last = 0;
  let m;
  while ((m = tagRe.exec(inner))) {
    if (depth === 0) out += inner.slice(last, m.index);
    depth += m[1] === "/" ? -1 : 1;
    if (depth < 0) depth = 0;
    last = m.index + m[0].length;
  }
  if (depth === 0) out += inner.slice(last);
  return out;
}

/**
 * Every violation a SINGLE source produces. Exported so the suite can feed it
 * the exact pre-fix markup and observe each rule go red — a rule that has never
 * been seen firing is not a guard.
 *
 * @param {string} file  the repo-relative path (its extension selects the extractor)
 * @param {string} src   the file's text
 */
export function scanSource(file, src) {
  const violations = [];
  const report = (line, rule, detail) => violations.push({ file, line, rule, detail });

  // ── rule 1: banned user-facing terms ───────────────────────────────────
  const strings = file.endsWith(".html") ? visibleFromHtml(src) : visibleFromJs(src);
  for (const { text, index } of strings) {
    for (const rule of BANNED_TERMS) {
      if (rule.test.test(text)) {
        report(lineOf(src, index), `banned-term:${rule.id}`, `${JSON.stringify(text)} — ${rule.why}`);
      }
    }
  }

  // ── rule 2: Skills is not a destination ────────────────────────────────
  for (const { file: target, pattern, why } of NO_SKILLS_DESTINATION) {
    if (target !== file) continue;
    pattern.lastIndex = 0;
    const m = pattern.exec(src);
    if (m) report(lineOf(src, m.index), "skills-is-not-a-destination", `${JSON.stringify(m[0])} — ${why}`);
  }

  // ── rules 3 + 4: one noun per view ─────────────────────────────────────
  if (NOUN_SCOPED_FILES.includes(file)) {
    for (const section of sections(src)) {
      const body = ownBody(section.inner);
      const labels = visibleFromHtml(body).map((s) => s.text);
      for (const noun of GOVERNED_NOUNS) {
        const count = labels.filter((t) => t === noun).length;
        if (count > 1) {
          report(
            lineOf(src, section.index),
            "noun-nesting",
            `"${noun}" labels this <section> ${count} times — a heading AND a row inside it. Name it once.`,
          );
        }
      }
      // rule 4: a section may not repeat its own heading as an aria-label.
      const ariaLabel = /\baria-label\s*=\s*"([^"]*)"/i.exec(section.attrs)?.[1]?.trim();
      if (ariaLabel && labels.includes(ariaLabel)) {
        report(
          lineOf(src, section.index),
          "duplicate-accessible-name",
          `aria-label="${ariaLabel}" repeats a heading inside the same section — use aria-labelledby.`,
        );
      }
    }
  }

  return violations;
}

export async function checkVocabulary() {
  const violations = [];
  const report = (file, line, rule, detail) => violations.push({ file, line, rule, detail });

  // Every scanned surface, plus the noun-scoped files if they are not already
  // surfaces (rules 2-4 are addressed to specific files).
  const files = [...new Set([...SURFACES, ...NOUN_SCOPED_FILES, ...NO_SKILLS_DESTINATION.map((r) => r.file)])];
  for (const file of files) {
    let src;
    try {
      src = await readFile(new URL(file, ROOT), "utf8");
    } catch {
      continue; // a retired surface is not a violation; RETIRED_FILES covers that
    }
    violations.push(...scanSource(file, src));
  }

  // ── the retired standalone surfaces ────────────────────────────────────
  // Skills stopped being a place you go (owner, 2026-08-28). Its document must
  // not reappear: a skill is attached to an agent or included in a task.
  for (const file of RETIRED_FILES) {
    try {
      await stat(new URL(file, ROOT));
      report(file, 1, "retired-surface", "this surface was retired and must not come back");
    } catch { /* absent, as required */ }
  }

  return violations;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const violations = await checkVocabulary();
  if (violations.length === 0) {
    console.log(`vocabulary OK: ${SURFACES.length} surfaces, one name per concept`);
    process.exit(0);
  }
  for (const v of violations) {
    console.error(`VOCABULARY: ${v.file}:${v.line} [${v.rule}] ${v.detail}`);
  }
  console.error(
    `\n${violations.length} vocabulary violation(s). One name per concept — see CAP-FB-20260828-NOUN-DISCIPLINE-01.`,
  );
  process.exit(1);
}

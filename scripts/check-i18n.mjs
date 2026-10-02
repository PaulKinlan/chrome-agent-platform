// scripts/check-i18n.mjs — the catalogue honesty check (chrome-agent-platform-716s.2).
//
//   node scripts/check-i18n.mjs          → exit 1 on any finding, 0 when clean
//   import { checkI18n } from "./check-i18n.mjs"  → the same findings as data
//
// WHY: the first Settings migration generated `extension/_locales/en/messages.json`
// from the markup by keying on the first words and keeping only the text that
// preceded the first child element. The result shipped twelve-plus messages that
// were a truncated or HTML-escaped PREFIX of the sentence ("Version ",
// "Connect a remote ", "Backup &amp; restore"), and `hydrateI18n` wrote them
// over the markup with textContent — so About lost its version number and its
// logo, the Data & memory heading rendered an entity literally, and two leads
// ended mid-sentence. Nothing in the suite could see it: the drift pin compared
// the catalogue to the broken markup fallback, byte for byte.
//
// This check reads the catalogue AND every markup site that resolves through it
// and fails on the shapes that produced that defect:
//
//   catalogue  C1 leading/trailing whitespace or an embedded newline
//              C2 ends in a dash (a sentence cut at an inline element)
//              C3 ends in an article (a/an/the)
//              C4 contains an HTML entity (&amp; &lt; &#39; …) — the catalogue
//                 holds TEXT; entities belong to the markup fallback only
//              C5 contains "<" — markup never enters the catalogue
//              C6 unused key — nothing in the extension resolves it
//   markup     M1 data-i18n on an END tag (parsers drop it; the key is dead)
//              M2 data-i18n key with no catalogue entry
//              M3 element with child elements whose message does not carry one
//                 `$n` placeholder per child — hydration would discard the
//                 children (the About logo, the import <input>) or the text
//                 after them (the MCP and Skills leads)
//              M4 message ≠ the markup fallback text (entities decoded,
//                 whitespace collapsed, children replaced by `$n`) — the
//                 no-JS fallback and the hydrated render must say the same
//                 thing
//
// Mixed content is hydrated WITHOUT innerHTML: `hydrateI18n` splits the
// message on `$n`, keeps the element's existing child nodes and writes text
// nodes around them. The placeholder contract here is what makes that safe.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCALES_DIR = join(ROOT, "extension", "_locales");
const EXTENSION_DIR = join(ROOT, "extension");
const SKIP_DIRS = new Set(["dist", "dist-versions", "node_modules", ".cache"]);

// HTML void elements never carry children or an end tag.
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

const collapse = (s) => String(s).replace(/\s+/g, " ").trim();

async function walk(dir, exts, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** The catalogue-side rules (C1–C5) over one parsed messages.json. */
export function auditMessages(messages, { locale = "en" } = {}) {
  const findings = [];
  for (const [key, entry] of Object.entries(messages)) {
    const msg = entry?.message;
    if (typeof msg !== "string") {
      findings.push({ rule: "C0", locale, key, detail: "message is not a string" });
      continue;
    }
    const trimmed = msg.trim();
    if (/^\s|\s$/.test(msg) || /\n/.test(msg)) findings.push({ rule: "C1", locale, key, detail: `padding whitespace: ${JSON.stringify(msg)}` });
    if (/[—–-]$/.test(trimmed)) findings.push({ rule: "C2", locale, key, detail: `ends in a dash: ${JSON.stringify(msg)}` });
    if (/\b(a|an|the)$/i.test(trimmed)) findings.push({ rule: "C3", locale, key, detail: `ends in an article: ${JSON.stringify(msg)}` });
    if (/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/.test(msg)) findings.push({ rule: "C4", locale, key, detail: `HTML entity in catalogue text: ${JSON.stringify(msg)}` });
    if (msg.includes("<")) findings.push({ rule: "C5", locale, key, detail: `markup in catalogue text: ${JSON.stringify(msg)}` });
  }
  return findings;
}

/** Find the end of the opening tag starting at `start` ("<tag ..."), honouring quotes. */
function openTagEnd(html, start) {
  let quote = null;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") return i;
  }
  return -1;
}

/** Tokenise the inner HTML of an element into text runs and DIRECT children.
 *  Returns { children: number, fallback: string } where fallback is the inner
 *  text with each direct child replaced by `$n` (entities decoded, collapsed).
 *  Returns null when the end tag cannot be found. */
export function analyseElement(html, openStart) {
  const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(openStart, openStart + 64));
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const openEnd = openTagEnd(html, openStart);
  if (openEnd === -1) return null;
  const selfClosing = html[openEnd - 1] === "/";
  if (VOID.has(tag) || selfClosing) return { tag, children: 0, fallback: "", voidElement: true };
  // Walk forward tracking nesting of ANY element so we count direct children
  // and find this element's own end tag.
  let depth = 0;
  let children = 0;
  let pieces = "";
  let i = openEnd + 1;
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/g;
  while (i < html.length) {
    tagRe.lastIndex = i;
    const t = tagRe.exec(html);
    if (!t) return null;
    const text = html.slice(i, t.index);
    if (depth === 0) pieces += text;
    const isEnd = html[t.index + 1] === "/";
    const name = t[1].toLowerCase();
    if (isEnd) {
      const close = html.indexOf(">", t.index);
      if (close === -1) return null;
      if (depth === 0) {
        if (name !== tag) return null; // malformed — a foreign end tag closed us
        return { tag, children, fallback: collapse(decodeEntities(pieces)), end: close + 1 };
      }
      depth--;
      i = close + 1;
      continue;
    }
    const end = openTagEnd(html, t.index);
    if (end === -1) return null;
    const self = VOID.has(name) || html[end - 1] === "/";
    if (depth === 0) {
      children++;
      pieces += ` $${children} `;
    }
    if (!self) depth++;
    i = end + 1;
  }
  return null;
}

/** The markup-side rules (M1–M4) over one HTML source. */
export function auditMarkup(html, messages, { file = "markup" } = {}) {
  const findings = [];
  const used = new Set();
  const code = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (s) => " ".repeat(s.length))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, (s) => " ".repeat(s.length));
  const attrRe = /\bdata-i18n="([^"]+)"/g;
  for (const m of code.matchAll(attrRe)) {
    const key = m[1];
    const line = code.slice(0, m.index).split("\n").length;
    const where = `${file}:${line}`;
    // Which tag carries this attribute? Walk back to the nearest "<".
    const lt = code.lastIndexOf("<", m.index);
    if (lt === -1) continue;
    if (code[lt + 1] === "/") {
      findings.push({ rule: "M1", key, where, detail: `data-i18n="${key}" sits on an end tag (${code.slice(lt, m.index).trim()}…) — parsers drop end-tag attributes, so this key never hydrates` });
      continue;
    }
    used.add(key);
    const entry = messages[key];
    if (!entry || typeof entry.message !== "string") {
      findings.push({ rule: "M2", key, where, detail: `data-i18n="${key}" has no catalogue entry` });
      continue;
    }
    const info = analyseElement(code, lt);
    if (!info) {
      findings.push({ rule: "M0", key, where, detail: `could not find the end tag of the element carrying data-i18n="${key}"` });
      continue;
    }
    if (info.voidElement) continue; // attributes only — data-i18n-attr territory
    const msg = entry.message;
    const placeholders = new Set([...msg.matchAll(/\$([1-9])/g)].map((p) => Number(p[1])));
    if (info.children > 0) {
      const missing = [];
      for (let n = 1; n <= info.children; n++) if (!placeholders.has(n)) missing.push(`$${n}`);
      const extra = [...placeholders].filter((n) => n > info.children).map((n) => `$${n}`);
      if (missing.length || extra.length) {
        findings.push({
          rule: "M3",
          key,
          where,
          detail: `<${info.tag} data-i18n="${key}"> has ${info.children} child element(s) but the message ${JSON.stringify(msg)} ${missing.length ? `lacks ${missing.join(", ")}` : `names ${extra.join(", ")} beyond them`} — hydration would discard markup or text`,
        });
        continue;
      }
    } else if (placeholders.size) {
      findings.push({ rule: "M3", key, where, detail: `<${info.tag} data-i18n="${key}"> has no child elements but the message carries ${[...placeholders].map((n) => `$${n}`).join(", ")}` });
      continue;
    }
    if (collapse(msg) !== info.fallback) {
      findings.push({ rule: "M4", key, where, detail: `catalogue ${JSON.stringify(msg)} ≠ markup fallback ${JSON.stringify(info.fallback)}` });
    }
  }
  for (const m of code.matchAll(/\bdata-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(";")) {
      const idx = pair.indexOf(":");
      if (idx <= 0) continue;
      const key = pair.slice(idx + 1).trim();
      used.add(key);
      if (!messages[key]) {
        const line = code.slice(0, m.index).split("\n").length;
        findings.push({ rule: "M2", key, where: `${file}:${line}`, detail: `data-i18n-attr key "${key}" has no catalogue entry` });
      }
    }
  }
  return { findings, used };
}

/** Keys referenced from JS as `t("key"` / `t('key'` literals. */
export function keysUsedInScript(src) {
  const used = new Set();
  for (const m of src.matchAll(/\bt\(\s*["']([a-zA-Z0-9_@]+)["']/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bdata-i18n(?:-attr)?="([^"]+)"/g)) {
    for (const part of m[1].split(";")) used.add(part.includes(":") ? part.slice(part.indexOf(":") + 1).trim() : part.trim());
  }
  return used;
}

export async function checkI18n({ root = ROOT } = {}) {
  const localesDir = join(root, "extension", "_locales");
  const extDir = join(root, "extension");
  const findings = [];
  const locales = (await readdir(localesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const htmlFiles = await walk(extDir, [".html"]);
  const jsFiles = await walk(extDir, [".js", ".mjs"]);
  const usedInJs = new Set();
  for (const f of jsFiles) for (const k of keysUsedInScript(await readFile(f, "utf8"))) usedInJs.add(k);
  for (const locale of locales) {
    const path = join(localesDir, locale, "messages.json");
    const messages = JSON.parse(await readFile(path, "utf8"));
    findings.push(...auditMessages(messages, { locale }));
    const used = new Set(usedInJs);
    for (const f of htmlFiles) {
      const res = auditMarkup(await readFile(f, "utf8"), messages, { file: relative(root, f) });
      findings.push(...res.findings.map((x) => ({ ...x, locale })));
      for (const k of res.used) used.add(k);
    }
    for (const key of Object.keys(messages)) {
      if (!used.has(key)) findings.push({ rule: "C6", locale, key, detail: `unused key — no data-i18n, data-i18n-attr or t("${key}") resolves it` });
    }
  }
  return { findings, locales, htmlFiles: htmlFiles.map((f) => relative(root, f)) };
}

export function formatFindings(findings) {
  return findings.map((f) => `  ${f.rule} ${f.locale ? `[${f.locale}] ` : ""}${f.key}${f.where ? ` (${f.where})` : ""}: ${f.detail}`).join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { findings, locales, htmlFiles } = await checkI18n();
  const keys = new Set(findings.map((f) => f.key));
  if (findings.length) {
    console.error(`i18n check: ${findings.length} finding(s) across ${keys.size} key(s) in ${locales.join(", ")} (${htmlFiles.length} markup file(s) scanned)`);
    console.error(formatFindings(findings));
    process.exit(1);
  }
  console.log(`i18n check: clean — ${locales.join(", ")} catalogue(s), ${htmlFiles.length} markup file(s) scanned`);
}

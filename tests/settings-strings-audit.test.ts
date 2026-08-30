// tests/settings-strings-audit.test.ts — bug 7 sweep gate (owner: "no message
// may reference UI that doesn't exist"). Pins over the REAL sources:
//  1. Only the optional Bookmarks/History capabilities may point at an Enable
//     control in Settings; required permissions remain install-granted.
//  2. Every "Settings → X" pointer in a STRING (comments excluded) names a
//     REAL target: a nav section or heading in options.html.
//  3. The only executable chrome.permissions.request( is the canonical
//     Settings capability helper used for Bookmarks/History.
//  4. The inline approval card (the runtime-grantable path: per-origin browser
//     control, FS grants) is preserved — rendered for waitingForPermission
//     results with Allow/Deny.
import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const EXT = new URL("../extension/", import.meta.url);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    const u = new URL(`${dir.href.replace(/\/?$/, "/")}${entry.name}${entry.isDirectory ? "/" : ""}`);
    if (entry.isDirectory) {
      if (entry.name === "dist-versions" || entry.name === "vendor") continue;
      yield* walk(u);
    } else if (/\.(js|html)$/.test(entry.name)) {
      yield u;
    }
  }
}

/** Strip line + block comments (state machine; strings preserved). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; i += 2; continue; }
      if (c === "'") { state = "sq"; out += c; i++; continue; }
      if (c === '"') { state = "dq"; out += c; i++; continue; }
      if (c === "`") { state = "tpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += c; } i++; continue; }
    if (state === "block") { if (c === "*" && n === "/") { state = "code"; i += 2; continue; } i++; continue; }
    // string states: survive escapes, terminate on the matching quote
    out += c;
    if (c === "\\") { out += n ?? ""; i += 2; continue; }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code";
    i++;
  }
  return out;
}

const sources = new Map<string, string>(); // path → comment-stripped source
for await (const u of walk(EXT)) {
  sources.set(u.pathname, stripComments(await Deno.readTextFile(u)));
}

const optionsHtml = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
// Real targets: nav section ids + every h2/h3 heading text, normalized.
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const targets = new Set<string>();
for (const m of optionsHtml.matchAll(/data-section="([^"]+)"/g)) targets.add(normalize(m[1]));
for (const m of optionsHtml.matchAll(/<h[23][^>]*>([^<]+)/g)) targets.add(normalize(m[1]));

Deno.test("bug 7 sweep: only optional Bookmarks/History point at Settings Enable controls", () => {
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    // Any "enable … Settings" variant (denial suffixes, description
    // parentheticals, "enable it in Settings", "enable the host permission
    // (Settings → Permissions)") — the install-granted model has no Enable
    // controls and no runtime-enable remediation.
    for (const m of src.matchAll(/enable[^"`'\n]{0,60}\bSettings\b/gi)) {
      if (!/^Enable (?:Bookmarks|History) in Settings$/i.test(m[0])) {
        offenders.push(`${path}: ${m[0]}`);
      }
    }
    // "Saving asks for the … permission"-style runtime-request copy.
    for (const m of src.matchAll(/asks? for the [a-z ]*permission/gi)) {
      offenders.push(`${path}: ${m[0]}`);
    }
    // Storage/host-access request prose remains obsolete; only the two API
    // capabilities above are optional.
  }
  assert(offenders.length === 0, `stale Enable/request pointers:\n${offenders.join("\n")}`);
});

Deno.test("bug 7 sweep: no obsolete request-era storage/access remediation copy remains", () => {
  // The verify-only contract: every API permission + host access is granted
  // at install, so there is NOTHING to "enable", no Chrome prompt to fail,
  // and no runtime access request — the only remediation is verify/reload.
  const obsolete: Array<[RegExp, string]> = [
    [/\benable storage\b/gi, "'Enable storage' call-to-action"],
    [/storage prompt/gi, "'storage prompt' (no prompt exists)"],
    [/couldn'?t request access/gi, "'couldn't request access' (verify-only)"],
    [/storage was not enabled/gi, "'Storage was not enabled'"],
    [/until storage is enabled/gi, "'until storage is enabled'"],
  ];
  // Falsification self-check: every pin must fire on its canonical obsolete
  // string (a pin that matches nothing real would silently rot).
  const samples = [
    "Enable storage before saving this API key — it would otherwise be lost on restart.",
    "Chrome could not open the storage prompt. Try again.",
    "Chrome couldn't request access for example.com. Try again.",
    "Storage was not enabled. This key has not been saved.",
    "This customization is session-only until storage is enabled.",
  ];
  for (let i = 0; i < obsolete.length; i++) {
    const [re, label] = obsolete[i];
    re.lastIndex = 0;
    assert(re.test(samples[i]), `pin ${label} must match its obsolete sample`);
  }
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    for (const [re, label] of obsolete) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) offenders.push(`${path}: ${label} — “${m[0]}”`);
    }
  }
  assert(offenders.length === 0, `obsolete request-era copy:\n${offenders.join("\n")}`);
});

Deno.test("bug 7 sweep: every Settings → pointer names REAL UI (a nav section or heading in options.html)", () => {
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    for (const m of src.matchAll(/Settings → ([A-Za-z][A-Za-z0-9 &—-]*)/g)) {
      const pointer = normalize(m[1]);
      const hit = [...targets].some((t) => pointer.startsWith(t) || t.startsWith(pointer));
      if (!hit) offenders.push(`${path}: "Settings → ${m[1]}"`);
    }
  }
  assert(offenders.length === 0, `pointers at UI that does not exist:\n${offenders.join("\n")}`);
});

Deno.test("bug 7 sweep: the only permission request is the canonical Settings capability helper", () => {
  const offenders: string[] = [];
  let canonicalRequests = 0;
  for (const [path, src] of sources) {
    if (/chrome\.permissions\.request\s*\(/.test(src)) {
      if (path.endsWith("/lib/capabilities.js")) canonicalRequests++;
      else offenders.push(`${path}: chrome.permissions.request(`);
    }
    // Indirect seams (the first-run onboarding helpers took an injected
    // permissionsApi and called .request on it).
    if (/permissionsApi\.request\s*\(/.test(src)) offenders.push(`${path}: permissionsApi.request(`);
    // Split-line variants: <anyObj>.request({ permissions: … }) — a Chrome
    // permission request by shape regardless of the receiver's name.
    if (/\.request\s*\(\s*\{[^}]*permissions\s*:/.test(src)) offenders.push(`${path}: .request({ permissions: … })`);
  }
  assert(canonicalRequests === 1, `expected one canonical capability request, got ${canonicalRequests}`);
  assert(offenders.length === 0, `unexpected permission requests remain:\n${offenders.join("\n")}`);
});

Deno.test("bug 7 sweep: the inline approval card remains the runtime-grantable path", () => {
  const conversation = sources.get([...sources.keys()].find((p) => p.endsWith("shared/conversation.js"))!)!;
  assertStringIncludes(conversation, "permission-approval-card", "the in-context approval card still renders");
  assertStringIncludes(conversation, "approvePermissionRequirement", "the approval executor is intact");
  const card = sources.get([...sources.keys()].find((p) => p.endsWith("shared/components.js"))!)!;
  assertStringIncludes(card, '"approve"', "the card offers Allow (approve) inline");
  assertStringIncludes(card, '"deny"', "the card offers Deny inline");
});

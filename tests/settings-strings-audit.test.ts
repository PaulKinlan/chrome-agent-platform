// tests/settings-strings-audit.test.ts — bug 7 sweep gate (owner: "no message
// may reference UI that doesn't exist"). Three pins over the REAL sources:
//  1. No user-facing string points at an Enable control in Settings (the
//     install-granted model has no Enable buttons — the old "— enable X in
//     Settings" pattern pointed at controls that never existed for e.g.
//     History).
//  2. Every "Settings → X" pointer in a STRING (comments excluded) names a
//     REAL target: a nav section or heading in options.html.
//  3. No executable chrome.permissions.request( remains — every API
//     permission + host access is install-granted (manifest permissions +
//     host_permissions <all_urls>); runtime grant state is VERIFIED with
//     contains(), fail closed.
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

Deno.test("bug 7 sweep: no string points at a Settings Enable control or a permission request (none exist)", () => {
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    // Any "enable … Settings" variant (denial suffixes, description
    // parentheticals, "enable it in Settings", "enable the host permission
    // (Settings → Permissions)") — the install-granted model has no Enable
    // controls and no runtime-enable remediation.
    for (const m of src.matchAll(/enable[^"`'\n]{0,60}\bSettings\b/gi)) {
      offenders.push(`${path}: ${m[0]}`);
    }
    // "Saving asks for the … permission"-style runtime-request copy.
    for (const m of src.matchAll(/asks? for the [a-z ]*permission/gi)) {
      offenders.push(`${path}: ${m[0]}`);
    }
    // "optional (storage )?permission" prose — nothing is optional anymore.
    for (const m of src.matchAll(/optional (?:storage )?permission/gi)) {
      offenders.push(`${path}: ${m[0]}`);
    }
  }
  assert(offenders.length === 0, `stale Enable/request pointers:\n${offenders.join("\n")}`);
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

Deno.test("bug 7 sweep: no permission REQUEST remains in any form (install-granted; contains() verifies, fail closed)", () => {
  const offenders: string[] = [];
  for (const [path, src] of sources) {
    if (/chrome\.permissions\.request\s*\(/.test(src)) offenders.push(`${path}: chrome.permissions.request(`);
    // Indirect seams (the first-run onboarding helpers took an injected
    // permissionsApi and called .request on it).
    if (/permissionsApi\.request\s*\(/.test(src)) offenders.push(`${path}: permissionsApi.request(`);
    // Split-line variants: <anyObj>.request({ permissions: … }) — a Chrome
    // permission request by shape regardless of the receiver's name.
    if (/\.request\s*\(\s*\{[^}]*permissions\s*:/.test(src)) offenders.push(`${path}: .request({ permissions: … })`);
  }
  assert(offenders.length === 0, `runtime permission requests remain:\n${offenders.join("\n")}`);
});

Deno.test("bug 7 sweep: the inline approval card remains the runtime-grantable path", () => {
  const conversation = sources.get([...sources.keys()].find((p) => p.endsWith("shared/conversation.js"))!)!;
  assertStringIncludes(conversation, "permission-approval-card", "the in-context approval card still renders");
  assertStringIncludes(conversation, "approvePermissionRequirement", "the approval executor is intact");
  const card = sources.get([...sources.keys()].find((p) => p.endsWith("shared/components.js"))!)!;
  assertStringIncludes(card, '"approve"', "the card offers Allow (approve) inline");
  assertStringIncludes(card, '"deny"', "the card offers Deny inline");
});

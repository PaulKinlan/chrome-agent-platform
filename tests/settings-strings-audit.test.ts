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

Deno.test("bug 7 sweep: denials point at the chat affordance or Settings — never a dead end", () => {
  const offenders: string[] = [];
  // MANDATORY permissions keep reinstall as the honest remediation (reload
  // restores the core grant); everything else must route to the chat
  // affordance or Settings.
  const MANDATORY_RELOAD_OK = /storage|sidePanel|side panel|offscreen|alarms/i;
  for (const [path, src] of sources) {
    for (const m of src.matchAll(/[^.`"\n]{0,120}reload the extension/gi)) {
      const line = m[0];
      // Reinstall is the honest fix for a CORE/mandatory grant problem
      // (storage, sidePanel, alarms, offscreen, <all_urls> host access): the
      // mandatory-reinstall phrasing is the standalone "Reload the extension"
      // sentence, and version-refresh diagnostics reference the background
      // worker. Both are exempt; capability denials still flag.
      if (
        MANDATORY_RELOAD_OK.test(line) ||
        /newer background worker|reinstall/i.test(line) ||
        /^Reload the extension$/.test(line.trim())
      ) continue;
      offenders.push(`${path}: ${line.trim().slice(0, 120)}`);
    }
    for (const m of src.matchAll(/asks? for the [a-z ]*permission (?:in|from) the model/gi)) {
      offenders.push(`${path}: ${m[0]}`);
    }
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

Deno.test("bug 7 sweep: permission REQUESTS live only in PAGES (never the SW)", () => {
  // OPTIONAL + JIT model (owner directive 2026-08-29): chrome.permissions.request
  // is the INTENDED JIT grant path from a genuine page gesture. The service
  // worker has no gesture and must never request; the offscreen document
  // (no DOM either) must not either.
  const sw = sources.get([...sources.keys()].find((p) => p.endsWith("background/service-worker.js"))!) ?? "";
  assert(!/chrome\.permissions\.request\s*\(/.test(sw), "the SW must never call chrome.permissions.request");
  const offscreen = sources.get([...sources.keys()].find((p) => p.endsWith("offscreen/offscreen.js"))!) ?? "";
  assert(!/chrome\.permissions\.request\s*\(/.test(offscreen), "the offscreen document must never call chrome.permissions.request");
});

Deno.test("bug 7 sweep: the inline approval card remains the runtime-grantable path", () => {
  const conversation = sources.get([...sources.keys()].find((p) => p.endsWith("shared/conversation.js"))!)!;
  assertStringIncludes(conversation, "permission-approval-card", "the in-context approval card still renders");
  assertStringIncludes(conversation, "approvePermissionRequirement", "the approval executor is intact");
  const card = sources.get([...sources.keys()].find((p) => p.endsWith("shared/components.js"))!)!;
  assertStringIncludes(card, '"approve"', "the card offers Allow (approve) inline");
  assertStringIncludes(card, '"deny"', "the card offers Deny inline");
});

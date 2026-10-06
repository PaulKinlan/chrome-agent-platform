// tests/postmessage-wildcard-guard.test.ts — chrome-agent-platform-wfxe.
//
// WHY: the origin-scoped pattern that closed the preference-percolation channel (bead b18d) was never
// generalised, so wildcard postMessage targets kept reappearing across the extension. No payload today
// carries a secret (triage found none), so this is a RECURRENCE GUARD: it fails when a new wildcard
// target appears whose payload names a secret or an action, and it makes every remaining channel a
// DELIBERATE entry with a written reason, so the next reader can tell a considered wildcard from a
// careless one.
//
// This test reads tracked source as data, so it has no static import edges — it is registered in
// SOURCE_INSPECTING_GUARDS (scripts/select-tests.mjs) so test:changed always selects it. The qcfc
// audit enforces that: it looks for SCAN_DIRS/filesUnder(/git ls-files in a test file that is not
// always-on and fails closed. The SCAN_DIRS constant below is intentionally the audited marker.
//
// s0o2 (2026-10-06): fingerprint() kept only the first 60 NORMALIZED CHARACTERS of a payload, so a
// listed channel could grow a secret or an action past character 60 and keep the fingerprint its
// entry had. MEASURED: nine of the entries below matched their sites on such a prefix, and appending
// `, apiKey: "…", refreshToken: bearerToken }` to any of those payloads was still ACCEPTED by
// classifyWildcard(). The fingerprint is now the WHOLE normalized payload — whitespace collapsed, so
// it stays stable across line moves and reindentation, the property the prefix existed for — and the
// longest is 153 characters, so the inventory stays readable. GUARDED_WILDCARD_CHANNELS_BY_FILE pins
// the SCOPE so it cannot shrink quietly either.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/test-partition.mjs";

// fileURLToPath, NOT .pathname: a URL pathname is percent-encoded, so a checkout path containing a
// space or a non-ASCII character would produce a root that does not exist (bead e273's guard).
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories scanned for wildcard postMessage targets. (The qcfc audit's marker.) */
export const SCAN_DIRS = ["extension"];

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-versions", ".git"]);

/** A wildcard target is the literal "*" in any quoting. */
const WILDCARD_RE = /^["'`]\*["'`]$/;

/**
 * A payload "names a secret or an action" when it mentions one of these. Deliberately broad: a false
 * positive costs one allowlist line with a reason, a false negative is the recurrence this guards.
 * NOTE: "token" appears in extension/skills/skills-panel.js as a skill REFERENCE string, not a
 * credential — which is exactly why that channel carries a written reason rather than being silent.
 */
export const SECRET_RE =
  /\b(token|secret|password|passwd|credential|api[-_]?key|apikey|bearer|session|cookie|private[-_]?key|refresh[-_]?token)\b/i;
export const ACTION_RE =
  /\b(open|run|exec|execute|delete|remove|write|set|use|send|invoke|dispatch|attach|edit|save|go-home|return-to-hub|ready)\b/i;

/**
 * Stable across line moves and reindentation: file + the WHOLE normalized payload (every run of
 * whitespace collapsed to one space). Deliberately NOT a prefix and not a digest — bead s0o2 measured
 * that a 60-character prefix let a wildcard channel append a secret past it and still match its
 * listed entry, and the entry is kept verbatim so a reviewer reads the channel instead of a hash.
 */
export function fingerprint(payload: string): string {
  return String(payload ?? "").replace(/\s+/g, " ").trim();
}

/** The prefix length the fingerprint used to keep — where s0o2's blind spot lived. */
export const LEGACY_FINGERPRINT_LENGTH = 60;

/** Split a call's argument list on TOP-LEVEL commas only (the payload contains commas and braces). */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += args[++i] ?? "";
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
    } else if (c === "(" || c === "{" || c === "[") {
      depth++;
      cur += c;
    } else if (c === ")" || c === "}" || c === "]") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * The RAW-source offset the character at `strippedOffset` of the COMMENT-STRIPPED text came from.
 *
 * WHY THIS EXISTS (bead 8jgs): the reported line used to be the line index in the STRIPPED text —
 * `stripped.slice(0, m.index).split("\n").length` — so a violation message named a line that does not
 * exist in the file. MEASURED: the live cap:go-home wildcard in extension/options/options.js is on
 * RAW line 4614 and was reported as 4599, because stripComments() collapses each multi-line block
 * comment above it to a single "\n"; the drift grows with a file's comment volume, and a line an
 * operator cannot open is worse than no line. Matching stays comment-blind — that is what keeps a
 * wildcard merely MENTIONED in a comment from counting — and only the REPORTED LINE becomes raw.
 * (tests/chrome-lock-fixture-scope.test.ts, which strips comments with its own local stripper, keeps
 * their newlines so "a reported line number is the file's real line"; this file matches on the shared
 * stripper instead, so the offset is mapped back rather than the stripper duplicated.)
 *
 * stripCodeRange() copies every non-comment character verbatim and in order, so the two texts agree
 * character for character until a comment region: raw keeps the region, stripped replaces it with
 * exactly one character (" " for a line comment or a single-line block comment, "\n" when the block
 * comment spanned lines). That is the whole walk — equal characters are the same character, and the
 * one legitimate disagreement is a raw comment start, whose region is skipped in raw while its single
 * replacement character is consumed in stripped. Anything else returns -1 so the caller fails closed
 * instead of reporting a confident wrong line.
 */
export function rawOffsetForStrippedOffset(raw: string, stripped: string, strippedOffset: number): number {
  let j = 0;
  for (let k = 0; k < strippedOffset; k++) {
    if (j >= raw.length) return -1;
    if (raw[j] === stripped[k]) {
      j++;
      continue;
    }
    if (raw[j] === "/" && (raw[j + 1] === "/" || raw[j + 1] === "*")) {
      j = endOfRawComment(raw, j);
      continue; // the replacement stripCodeRange() pushed for this comment is stripped[k]
    }
    return -1;
  }
  return j;
}

const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/** The offset just past the comment that starts at `i` — the same span stripCodeRange() drops. */
function endOfRawComment(raw: string, i: number): number {
  if (raw[i + 1] === "/") {
    let j = i + 2;
    while (j < raw.length && !LINE_TERMINATORS.has(raw[j])) j++;
    return j;
  }
  const close = raw.indexOf("*/", i + 2);
  return close < 0 ? raw.length : close + 2;
}

/** Every `postMessage(payload, target)` whose target is a wildcard, with balanced-paren parsing. */
export function findWildcardPostMessages(files: Array<{ path: string; source: string }>) {
  const out: Array<{ file: string; line: number; payload: string; fingerprint: string }> = [];
  for (const { path, source: raw } of files) {
    // Comments are stripped FIRST: a comment that mentions a wildcard call must not be counted as
    // one (the scanner's own self-test asserts this), and the repo already has one stripper that
    // understands strings and code ranges (test-partition.mjs) rather than a second, weaker one.
    const source = stripComments(raw);
    const re = /postMessage\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      let quote: string | null = null;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          quote = c;
        } else if (c === "(") {
          depth++;
        } else if (c === ")") {
          depth--;
        }
        i++;
      }
      const parts = splitTopLevel(source.slice(start, i - 1));
      if (!WILDCARD_RE.test(parts[1] ?? "")) continue;
      // THE LINE AN OPERATOR CAN OPEN: the RAW source's line, not the stripped text's (bead 8jgs).
      // The match itself was made on the stripped text; `m[0]` always starts with the literal
      // `postMessage`, so the mapped offset is verified to hold it before a line is derived from it.
      const rawOffset = rawOffsetForStrippedOffset(raw, source, m.index);
      if (rawOffset < 0 || !raw.startsWith("postMessage", rawOffset)) {
        throw new Error(
          `${path}: the comment-stripped offset ${m.index} (${JSON.stringify(m[0])}) does not map back to the same call in the raw source (mapped to ${rawOffset}) — refusing to report a line that may not exist`,
        );
      }
      const line = raw.slice(0, rawOffset).split("\n").length;
      out.push({
        file: path,
        line,
        payload: (parts[0] ?? "").trim(),
        fingerprint: fingerprint(parts[0]),
      });
    }
  }
  return out;
}

export function scanTree(): Array<{ path: string; source: string }> {
  const files: Array<{ path: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".js")) {
        const full = join(dir, entry.name);
        // RELATIVE to the repo root, so allowlist entries never carry a machine-specific prefix.
        files.push({ path: relative(ROOT, full), source: readFileSync(full, "utf8") });
      }
    }
  };
  for (const d of SCAN_DIRS) walk(join(ROOT, d));
  return files;
}

/**
 * Every wildcard channel that remains, with the reason it is deliberate. `fingerprint` is the FULL
 * normalized payload (bead s0o2 — it used to be the first 60 characters, which is what let a channel
 * grow a secret or an action past the prefix while still matching this entry). `count` pins how many
 * occurrences that fingerprint has, so a new instance fails even when the payload is identical.
 */
export const ALLOWED_WILDCARD_CHANNELS: Array<{
  file: string;
  fingerprint: string;
  count: number;
  reason: string;
}> = [
  {
    file: "extension/artifacts/index.js",
    fingerprint:
      '{ type: "cap:attach-artifact", artifact: { id, name, type, origin: origin ?? "master" }, }',
    count: 1,
    reason:
      "Gallery -> the hub/agent frame that asked for the artifact: a different surface, so no same-origin address exists. The payload is the descriptor of the asset the user just chose (id/name/type/origin) — no secret. Listed deliberately; this file is NOT edited here because qazo owns chrome-agent-platform-0iln in it.",
  },
  {
    file: "extension/artifacts/index.js",
    fingerprint:
      '{ type: "cap:attach-artifact", artifact: { id, name: asset.name, type: asset.type, origin: origin ?? "master" }, }',
    count: 1,
    reason: "As above, from the other attach entry point in the same gallery surface.",
  },
  {
    file: "extension/artifacts/index.js",
    fingerprint: '{ type: "cap:go-home" }',
    count: 1,
    reason: "Cross-frame navigation intent with an empty payload.",
  },
  {
    file: "extension/content/content-script.js",
    fingerprint: '{ [CHANNEL]: true, ...auth.seal(bridgeNonce, "down", downSeq++, msg) }',
    count: 1,
    reason:
      "Content script -> the page's MAIN WORLD. The target is the VISITED SITE, an arbitrary origin, so no extension origin can address it: a wildcard is the only workable target. Authenticity comes from auth.seal(), a MAC over the message, not from targetOrigin.",
  },
  {
    file: "extension/content/main-world.js",
    fingerprint: '{ [CHANNEL]: true, ...auth.seal(nonce, "up", upSeq++, msg) }',
    count: 1,
    reason: "The upward half of the same sealed bridge: target is the arbitrating extension frame, payload is sealed.",
  },
  {
    file: "extension/content/webmcp-detect-main.js",
    fingerprint: '{ [CHANNEL]: 1, type: "hook", hook: HOOK_KEY }',
    count: 1,
    reason: "Page main-world detection channel: the target is the host page, and the message carries a signed tag.",
  },
  {
    file: "extension/content/webmcp-detect-main.js",
    fingerprint:
      '{ [CHANNEL]: 1, type: "snapshot", toolCount, seq, tag: await sign(`detect|${seq}|${toolCount}`), }',
    count: 1,
    reason: "As above, the snapshot direction; the tag is produced by sign() and checked by the receiver.",
  },
  {
    file: "extension/lib/script-host.js",
    fingerprint:
      '{ type: "cap:script-call-result", runId, callId: d.callId, ok: value.ok, value: value.ok ? value : undefined, error: value.ok ? undefined : value.error }',
    count: 1,
    reason:
      "Script host <-> the script SANDBOX frame (the success path). The sandbox runs without allow-same-origin, so its origin is opaque and cannot be named as a targetOrigin. The envelope carries runId/callId and the receiver matches them.",
  },
  {
    // Split out by s0o2: this error path and the success path above shared one 60-character prefix
    // and were one entry with count 2, so a change to either payload past that prefix was invisible.
    file: "extension/lib/script-host.js",
    fingerprint:
      '{ type: "cap:script-call-result", runId, callId: d.callId, ok: false, error: `unknown call kind ${d.kind}` }',
    count: 1,
    reason: "As above, the error path of the same envelope; runId/callId still identify the call.",
  },
  {
    file: "extension/lib/script-host.js",
    fingerprint:
      '{ type: "cap:script-source", source, runId, nonce, modules: Array.isArray(modules) ? modules : [], }',
    count: 1,
    reason: "As above: source is handed INTO the opaque-origin sandbox, guarded by runId + nonce.",
  },
  {
    file: "extension/options/options.js",
    fingerprint: '{ type: "cap:go-home" }',
    count: 1,
    reason:
      "Best-effort 'go home' flash to the hub parent — the SAME class as the hardened reference (openNamedAgentEditor above, and returnToHubComposer). The parent is the extension's own page, so this is convertible to window.location.origin; it is listed rather than converted so this change stays bounded to one reference implementation, and converting it is an explicit follow-up.",
  },
  {
    file: "extension/sandbox/artifact-preview.js",
    fingerprint: "data",
    count: 2,
    reason:
      "Sandboxed preview frame <-> its parent. The frame is sandboxed, so its own origin is opaque: a wildcard target is unavoidable and the envelope carries the nonce plus already-guarded html.",
  },
  {
    file: "extension/sandbox/script-sandbox.js",
    fingerprint: "{ type, runId, nonce, ...extra }",
    count: 1,
    reason: "The sandbox's own origin is opaque, so no targetOrigin can name it; the envelope carries type/runId/nonce.",
  },
  {
    file: "extension/shared/components.js",
    fingerprint: '{ type: "cap:artifact-preview-open", nonce: n, html: guarded }',
    count: 1,
    reason: "Extension page -> sandboxed preview frame: the frame's origin is opaque, and the nonce + guarded html are the guard.",
  },
  {
    file: "extension/shared/components.js",
    fingerprint: '{ type: FRAME_PREFERENCE_TYPE, nonce: n, preference: pref }',
    count: 1,
    reason: "As above, the preference channel into the same opaque-origin frame, guarded by its nonce.",
  },
  {
    file: "extension/shared/components.js",
    fingerprint: "{type:'cap:preference-ready',nonce:nonce}",
    count: 1,
    reason:
      "A srcdoc frame -> its parent. An srcdoc frame's origin is opaque, so it cannot be named as a target; the nonce is the guard.",
  },
  {
    file: "extension/skills/skills-panel.js",
    fingerprint: '{ type: "use-skill", id: skill.refId ?? skill.id ?? skill.name, ref: token }',
    count: 1,
    reason:
      "Same-origin hub parent (the NTP overlay hosts the settings panel), so this one IS convertible like the hardened reference — listed rather than converted to keep this change bounded. The 'token' in the payload is a skill REFERENCE string (/skill:<id>), NOT a credential; the fallback path copies that same string to the clipboard.",
  },
];

/**
 * The guarded SCOPE, frozen (bead s0o2): how many wildcard channels each file carries. A channel that
 * is genuinely converted, moved, or replaced has to edit this table DELIBERATELY — the assertion
 * below then NAMES the file that went missing, instead of the guard quietly measuring less than it
 * did the day before while still reporting green.
 */
export const GUARDED_WILDCARD_CHANNELS_BY_FILE: Record<string, number> = {
  "extension/artifacts/index.js": 3,
  "extension/content/content-script.js": 1,
  "extension/content/main-world.js": 1,
  "extension/content/webmcp-detect-main.js": 2,
  "extension/lib/script-host.js": 3,
  "extension/options/options.js": 1,
  "extension/sandbox/artifact-preview.js": 2,
  "extension/sandbox/script-sandbox.js": 1,
  "extension/shared/components.js": 3,
  "extension/skills/skills-panel.js": 1,
};

/** How many wildcard channels each scanned file holds. */
function countByFile(sites: Array<{ file: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of sites) counts.set(site.file, (counts.get(site.file) ?? 0) + 1);
  return counts;
}

/** The rule: is this wildcard channel a deliberate, listed one? Returns a violation, or null. */
export function classifyWildcard(
  site: { file: string; line: number; payload: string; fingerprint: string },
  allowed: Array<{ file: string; fingerprint: string; count: number; reason: string }>,
): string | null {
  const listed = allowed.some((a) => a.file === site.file && a.fingerprint === site.fingerprint);
  if (listed) return null;
  const names = [
    SECRET_RE.test(site.payload) ? "a SECRET" : null,
    ACTION_RE.test(site.payload) ? "an ACTION" : null,
  ].filter(Boolean);
  const what = names.length ? `names ${names.join(" and ")}` : "names neither a secret nor an action";
  return `${site.file}:${site.line} has a wildcard postMessage target whose payload ${what} and is NOT listed in ALLOWED_WILDCARD_CHANNELS: ${site.payload.slice(0, 120)}`;
}

Deno.test("wfxe: every wildcard postMessage target is a LISTED, deliberate channel", () => {
  const found = findWildcardPostMessages(scanTree());
  // A floor: if the scan silently found nothing, this guard would pass while measuring nothing.
  assert(found.length >= 10, `expected at least 10 wildcard channels to exist, scanned ${found.length}`);
  const violations = found
    .map((site) => classifyWildcard(site, ALLOWED_WILDCARD_CHANNELS))
    .filter((v): v is string => v !== null);
  assertEquals(
    violations,
    [],
    `New wildcard postMessage target(s) — add each to ALLOWED_WILDCARD_CHANNELS with a reason, or scope it to a real origin:\n  ${violations.join("\n  ")}`,
  );
});

Deno.test("wfxe: the allowlist is not stale — every entry still matches, with the same count", () => {
  const found = findWildcardPostMessages(scanTree());
  const counts = new Map<string, number>();
  for (const site of found) {
    const key = `${site.file}|${site.fingerprint}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const stale: string[] = [];
  for (const entry of ALLOWED_WILDCARD_CHANNELS) {
    const actual = counts.get(`${entry.file}|${entry.fingerprint}`) ?? 0;
    if (actual !== entry.count) {
      // The payload changed (or went away): print what the file sends NOW, so re-anchoring the entry
      // is a copy of the current fingerprint rather than a re-derivation by hand.
      const inFile = found
        .filter((s) => s.file === entry.file)
        .map((s) => `"${s.fingerprint}"`)
        .join(" | ");
      stale.push(
        `${entry.file} "${entry.fingerprint}" declared ${entry.count}, found ${actual}` +
          (actual === 0 ? ` — that file's current fingerprints: ${inFile || "(none)"}` : ""),
      );
    }
    assert(entry.reason.trim().length > 30, `entry ${entry.file} needs a real reason, not a placeholder`);
  }
  assertEquals(stale, [], `stale allowlist entries (a hardened or moved channel must be removed/updated):\n  ${stale.join("\n  ")}`);
});

Deno.test("wfxe: the scanner can see a wildcard at all (it must not pass by measuring nothing)", () => {
  const synthetic = {
    path: "extension/synthetic.js",
    source: [
      `window.parent.postMessage({ type: "cap:edit-named-agent", id }, "*");`,
      `window.parent.postMessage({ type: "ok" }, window.location.origin);`,
      "// a comment mentioning postMessage(x, \"*\") must not count",
      `/* and neither must a block comment: postMessage({ type: "x" }, "*") */`,
    ].join("\n"),
  };
  const found = findWildcardPostMessages([synthetic]);
  assertEquals(found.length, 1, "exactly the wildcard call must be found, not the origin-scoped one");
  assertEquals(found[0].file, "extension/synthetic.js");
  assert(found[0].payload.includes("cap:edit-named-agent"), found[0].payload);
});

Deno.test("8jgs: a reported line holds the CALL ITSELF — the index comes from the RAW source", () => {
  const files = scanTree();
  const rawByFile = new Map(files.map((f) => [f.path, f.source] as const));
  const found = findWildcardPostMessages(files);
  assert(found.length >= 10, `expected at least 10 wildcard channels, measured ${found.length}`);

  // Independent of the scanner's own mapping: the raw line it named must CARRY the matched token.
  // The defect (bead 8jgs) reported a line index from the comment-stripped text, which lands on
  // whatever raw line happens to sit that far into the file — measured today, options.js:4599, an
  // unrelated `// avoid a double copy).` comment. No site can pass this in that state.
  const wrong = found
    .map((site) => [site, (rawByFile.get(site.file) ?? "").split("\n")[site.line - 1] ?? ""] as const)
    .filter(([, rawLine]) => !rawLine.includes("postMessage"))
    .map(([site, rawLine]) => `${site.file}:${site.line} does not hold the call — it is ${JSON.stringify(rawLine.slice(0, 80))}`);
  assertEquals(wrong, [], `every reported line must be the raw line of its own call:\n  ${wrong.join("\n  ")}`);

  // The measured case, pinned against the file rather than against a hardcoded number (the inventory
  // is anchored by file + payload, never by line — bead s0o2). `lastIndexOf` before the payload
  // literal is the call's own `postMessage` token, computed from the RAW text with no stripper at all.
  const OPTIONS = "extension/options/options.js";
  const raw = rawByFile.get(OPTIONS) ?? "";
  const payloadAt = raw.indexOf('"cap:go-home"');
  assert(payloadAt > 0, `${OPTIONS} must still carry the cap:go-home literal`);
  assertEquals(
    raw.indexOf('"cap:go-home"', payloadAt + 1),
    -1,
    `${OPTIONS} must carry exactly one cap:go-home literal for this pin to be unambiguous`,
  );
  const rawLineOfCall = raw.slice(0, raw.lastIndexOf("postMessage", payloadAt)).split("\n").length;
  const site = found.find((s) => s.file === OPTIONS && s.payload === '{ type: "cap:go-home" }');
  assert(site, `${OPTIONS} must still carry the cap:go-home wildcard channel`);
  assertEquals(
    site.line,
    rawLineOfCall,
    `${OPTIONS} cap:go-home: the guard reported line ${site.line}, its raw line is ${rawLineOfCall}`,
  );
  // ...and the pin must keep DISCRIMINATING: this site's stripped-text line is only different while
  // multi-line block comments sit above it. If that stops being true, the comparison above proves
  // nothing and this guard says so instead of passing quietly.
  const strippedLine = stripComments(raw)
    .split("\n")
    .findIndex((l) => l.includes("postMessage") && l.includes("cap:go-home")) + 1;
  assert(
    strippedLine > 0 && strippedLine !== rawLineOfCall,
    `${OPTIONS}: expected a stripped-text line different from the raw line (raw ${rawLineOfCall}, stripped ${strippedLine}) — the drift this pin exists for has gone away`,
  );
});

Deno.test("8jgs: a comment block above a wildcard does not shift the reported line", () => {
  // The FIXTURE case: one line comment plus a four-line block comment above a single wildcard. The
  // stripper collapses that block's internal newlines to one, so the old computation indexed the
  // stripped text (MEASURED here: line 4) while the call sits on raw line 6. The mapping must report
  // the raw line, and the two must disagree for this fixture to prove anything.
  const lines = [
    "// a leading line comment",
    "/* a block comment",
    "   that spans",
    "   several",
    "   lines */",
    `window.parent.postMessage({ type: "cap:fixture" }, "*");`,
  ];
  const source = lines.join("\n");
  const found = findWildcardPostMessages([{ path: "extension/fixture.js", source }]);
  assertEquals(found.length, 1, "exactly the fixture's one wildcard call must be found");
  assertEquals(
    found[0].line,
    lines.length,
    `the fixture's wildcard is on raw line ${lines.length}, reported ${found[0].line}`,
  );
  const strippedLine = stripComments(source)
    .split("\n")
    .findIndex((l) => l.includes("postMessage")) + 1;
  assert(
    strippedLine > 0 && strippedLine !== found[0].line,
    `the fixture must exercise the drift (stripped line ${strippedLine}, raw line ${found[0].line})`,
  );
  // FAIL CLOSED: a stripped text that is not this raw text's stripping must yield -1, never an
  // offset that would become a confident wrong line.
  assertEquals(rawOffsetForStrippedOffset("const x = 1;", "const y = 2;", 8), -1);
});

Deno.test("wfxe: falsification — a synthetic secret-bearing wildcard is refused by the rule", () => {
  const syntheticSite = {
    file: "extension/synthetic.js",
    line: 1,
    payload: `{ type: "cap:leak", refreshToken: token, session: cookie }`,
    fingerprint: `{ type: "cap:leak", refreshToken: token, session: cookie }`,
  };
  const violation = classifyWildcard(syntheticSite, ALLOWED_WILDCARD_CHANNELS);
  assert(violation !== null, "a new secret-bearing wildcard channel MUST be a violation");
  assert(violation.includes("SECRET"), violation);
  // And a listed channel is never a violation, so the rule is not simply always-red.
  const listed = ALLOWED_WILDCARD_CHANNELS[0];
  assertEquals(
    classifyWildcard(
      { file: listed.file, line: 1, payload: listed.fingerprint, fingerprint: listed.fingerprint },
      ALLOWED_WILDCARD_CHANNELS,
    ),
    null,
  );
});

Deno.test("s0o2: the guarded scope cannot shrink silently — a missing channel is NAMED", () => {
  const files = scanTree();
  const found = findWildcardPostMessages(files);
  const scanned = countByFile(found);
  const declared = new Map<string, number>();
  for (const entry of ALLOWED_WILDCARD_CHANNELS) {
    declared.set(entry.file, (declared.get(entry.file) ?? 0) + entry.count);
  }

  const gone: string[] = [];
  const unlisted: string[] = [];
  let pinnedTotal = 0;
  for (const [file, pinned] of Object.entries(GUARDED_WILDCARD_CHANNELS_BY_FILE)) {
    pinnedTotal += pinned;
    const seen = scanned.get(file) ?? 0;
    const listed = declared.get(file) ?? 0;
    if (seen < pinned) gone.push(`${file}: pinned ${pinned}, the scanner now sees ${seen}`);
    if (listed < pinned) unlisted.push(`${file}: pinned ${pinned}, the inventory declares ${listed}`);
  }

  assert(
    gone.length === 0,
    `the wfxe guard now scans LESS than GUARDED_WILDCARD_CHANNELS_BY_FILE pins: either a channel was converted without removing its pin (do that deliberately, in the same edit, and say why), or the scan lost a file:\n  ${gone.join("\n  ")}`,
  );
  assert(
    unlisted.length === 0,
    `ALLOWED_WILDCARD_CHANNELS covers less than GUARDED_WILDCARD_CHANNELS_BY_FILE pins — a listed channel was dropped instead of re-pinned with its reason:\n  ${unlisted.join("\n  ")}`,
  );
  const declaredTotal = ALLOWED_WILDCARD_CHANNELS.reduce((n, e) => n + e.count, 0);
  assert(
    declaredTotal === pinnedTotal,
    `the inventory must account for exactly the ${pinnedTotal} pinned channel(s), it declares ${declaredTotal}`,
  );
  assert(
    files.length >= 200,
    `the scan read only ${files.length} .js file(s) under ${SCAN_DIRS.join(" + ")} — the walk is broken, not the tree`,
  );
});

Deno.test("s0o2: a payload that grows a secret or an action PAST the retired 60-character prefix is REFUSED", () => {
  const found = findWildcardPostMessages(scanTree());
  // The allowlist as it stood before s0o2: every entry keyed by its first 60 normalized characters.
  const legacyAllowlist = ALLOWED_WILDCARD_CHANNELS.map((entry) => ({
    ...entry,
    fingerprint: entry.fingerprint.slice(0, LEGACY_FINGERPRINT_LENGTH),
  }));
  const legacyPrefix = (payload: string) => fingerprint(payload).slice(0, LEGACY_FINGERPRINT_LENGTH);

  // Only the payloads that reached the old prefix can be extended past it; the shorter ones were
  // never truncated, so a secret appended to them never collided with their entry.
  const growable = found.filter((site) => site.fingerprint.length >= LEGACY_FINGERPRINT_LENGTH);
  let swallowedByThePrefix = 0;
  for (const site of growable) {
    const grown = `${site.fingerprint}, apiKey: "sk-live-DEADBEEF", refreshToken: bearerToken, action: open }`;
    // GREEN on the channel as it exists: a correctly listed one is never a violation.
    assertEquals(
      classifyWildcard(site, ALLOWED_WILDCARD_CHANNELS),
      null,
      `${site.file}:${site.line} is a listed channel and must stay green`,
    );
    // RED on the grown payload: the whole payload is fingerprinted now, so it is a payload this
    // inventory does not list. Reinstating slice(0, 60) makes this assertion fail here.
    assert(
      classifyWildcard({ ...site, payload: grown, fingerprint: fingerprint(grown) }, ALLOWED_WILDCARD_CHANNELS) !== null,
      `${site.file}:${site.line} grew a secret and an action past character ${LEGACY_FINGERPRINT_LENGTH} and was NOT refused`,
    );
    // AND this is the s0o2 blind spot itself, still live in the retired prefix: the grown payload's
    // prefix is byte-identical to the listed one, so the prefix ALONE accepts it. That is what makes
    // the assertion above load-bearing; if it stops holding, re-derive this test rather than trust it.
    if (
      classifyWildcard({ ...site, payload: grown, fingerprint: legacyPrefix(grown) }, legacyAllowlist) === null
    ) {
      swallowedByThePrefix++;
    }
  }
  assert(
    growable.length >= 9,
    `expected at least 9 listed channels whose payload reaches the retired ${LEGACY_FINGERPRINT_LENGTH}-character prefix, measured ${growable.length} of ${found.length}`,
  );
  assertEquals(
    swallowedByThePrefix,
    growable.length,
    `the retired prefix accepted ${swallowedByThePrefix} of ${growable.length} grown payloads — every one of them is the collision this guard now closes`,
  );
});

Deno.test("wfxe: the hardened reference channel is actually scoped (it left the wildcard set)", () => {
  const options = readFileSync(join(ROOT, "extension/options/options.js"), "utf8");
  assert(
    options.includes("window.parent.postMessage(message, window.location.origin)"),
    "openNamedAgentEditor must post to window.location.origin like returnToHubComposer",
  );
  const stillWildcard = findWildcardPostMessages([{ path: "extension/options/options.js", source: options }]);
  assert(
    !stillWildcard.some((s) => s.payload === "message"),
    "the hardened channel must no longer appear as a wildcard",
  );
});

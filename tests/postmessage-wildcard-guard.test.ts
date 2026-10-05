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
import { assert, assertEquals } from "jsr:@std/assert@1";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../scripts/test-partition.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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

/** Stable across line moves: file + the first 60 normalized characters of the payload. */
export function fingerprint(payload: string): string {
  return String(payload ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
}

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
      const line = source.slice(0, m.index).split("\n").length;
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
 * Every wildcard channel that remains, with the reason it is deliberate. `count` pins how many
 * occurrences that fingerprint has, so a new instance fails even when the payload is identical.
 */
export const ALLOWED_WILDCARD_CHANNELS: Array<{
  file: string;
  payload: string;
  count: number;
  reason: string;
}> = [
  {
    file: "extension/artifacts/index.js",
    payload: '{ type: "cap:attach-artifact", artifact: { id, name, type, o',
    count: 1,
    reason:
      "Gallery -> the hub/agent frame that asked for the artifact: a different surface, so no same-origin address exists. The payload is the descriptor of the asset the user just chose (id/name/type/origin) — no secret. Listed deliberately; this file is NOT edited here because qazo owns chrome-agent-platform-0iln in it.",
  },
  {
    file: "extension/artifacts/index.js",
    payload: '{ type: "cap:attach-artifact", artifact: { id, name: asset.n',
    count: 1,
    reason: "As above, from the other attach entry point in the same gallery surface.",
  },
  {
    file: "extension/artifacts/index.js",
    payload: '{ type: "cap:go-home" }',
    count: 1,
    reason: "Cross-frame navigation intent with an empty payload.",
  },
  {
    file: "extension/content/content-script.js",
    payload: '{ [CHANNEL]: true, ...auth.seal(bridgeNonce, "down", downSeq',
    count: 1,
    reason:
      "Content script -> the page's MAIN WORLD. The target is the VISITED SITE, an arbitrary origin, so no extension origin can address it: a wildcard is the only workable target. Authenticity comes from auth.seal(), a MAC over the message, not from targetOrigin.",
  },
  {
    file: "extension/content/main-world.js",
    payload: '{ [CHANNEL]: true, ...auth.seal(nonce, "up", upSeq++, msg) }',
    count: 1,
    reason: "The upward half of the same sealed bridge: target is the arbitrating extension frame, payload is sealed.",
  },
  {
    file: "extension/content/webmcp-detect-main.js",
    payload: '{ [CHANNEL]: 1, type: "hook", hook: HOOK_KEY }',
    count: 1,
    reason: "Page main-world detection channel: the target is the host page, and the message carries a signed tag.",
  },
  {
    file: "extension/content/webmcp-detect-main.js",
    payload: '{ [CHANNEL]: 1, type: "snapshot", toolCount, seq, tag: await',
    count: 1,
    reason: "As above, the snapshot direction; the tag is produced by sign() and checked by the receiver.",
  },
  {
    file: "extension/lib/script-host.js",
    payload: '{ type: "cap:script-call-result", runId, callId: d.callId, o',
    count: 2,
    reason:
      "Script host <-> the script SANDBOX frame. The sandbox runs without allow-same-origin, so its origin is opaque and cannot be named as a targetOrigin. The envelope carries runId/callId and the receiver matches them.",
  },
  {
    file: "extension/lib/script-host.js",
    payload: '{ type: "cap:script-source", source, runId, nonce, modules: ',
    count: 1,
    reason: "As above: source is handed INTO the opaque-origin sandbox, guarded by runId + nonce.",
  },
  {
    file: "extension/options/options.js",
    payload: '{ type: "cap:go-home" }',
    count: 1,
    reason:
      "Best-effort 'go home' flash to the hub parent — the SAME class as the hardened reference (openNamedAgentEditor above, and returnToHubComposer). The parent is the extension's own page, so this is convertible to window.location.origin; it is listed rather than converted so this change stays bounded to one reference implementation, and converting it is an explicit follow-up.",
  },
  {
    file: "extension/sandbox/artifact-preview.js",
    payload: "data",
    count: 2,
    reason:
      "Sandboxed preview frame <-> its parent. The frame is sandboxed, so its own origin is opaque: a wildcard target is unavoidable and the envelope carries the nonce plus already-guarded html.",
  },
  {
    file: "extension/sandbox/script-sandbox.js",
    payload: "{ type, runId, nonce, ...extra }",
    count: 1,
    reason: "The sandbox's own origin is opaque, so no targetOrigin can name it; the envelope carries type/runId/nonce.",
  },
  {
    file: "extension/shared/components.js",
    payload: '{ type: "cap:artifact-preview-open", nonce: n, html: guarded',
    count: 1,
    reason: "Extension page -> sandboxed preview frame: the frame's origin is opaque, and the nonce + guarded html are the guard.",
  },
  {
    file: "extension/shared/components.js",
    payload: '{ type: FRAME_PREFERENCE_TYPE, nonce: n, preference: pref }',
    count: 1,
    reason: "As above, the preference channel into the same opaque-origin frame, guarded by its nonce.",
  },
  {
    file: "extension/shared/components.js",
    payload: "{type:'cap:preference-ready',nonce:nonce}",
    count: 1,
    reason:
      "A srcdoc frame -> its parent. An srcdoc frame's origin is opaque, so it cannot be named as a target; the nonce is the guard.",
  },
  {
    file: "extension/skills/skills-panel.js",
    payload: '{ type: "use-skill", id: skill.refId ?? skill.id ?? skill.na',
    count: 1,
    reason:
      "Same-origin hub parent (the NTP overlay hosts the settings panel), so this one IS convertible like the hardened reference — listed rather than converted to keep this change bounded. The 'token' in the payload is a skill REFERENCE string (/skill:<id>), NOT a credential; the fallback path copies that same string to the clipboard.",
  },
];

/** The rule: is this wildcard channel a deliberate, listed one? Returns a violation, or null. */
export function classifyWildcard(
  site: { file: string; line: number; payload: string; fingerprint: string },
  allowed: Array<{ file: string; payload: string; count: number; reason: string }>,
): string | null {
  const listed = allowed.some((a) => a.file === site.file && a.payload === site.fingerprint);
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
    const actual = counts.get(`${entry.file}|${entry.payload}`) ?? 0;
    if (actual !== entry.count) {
      stale.push(`${entry.file} "${entry.payload}" declared ${entry.count}, found ${actual}`);
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
      { file: listed.file, line: 1, payload: listed.payload, fingerprint: listed.payload },
      ALLOWED_WILDCARD_CHANNELS,
    ),
    null,
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

// lib/pure-secret-shapes.js — the credential SHAPE constants, extracted from
// lib/pure-redact.js by chrome-agent-platform-gzkmx. These are the four-line/
// twelve-line static patterns that FAT importers (cap-log.js's 255-test
// consumer set) legitimately need — a redaction-LOGIC delta should not reach
// them, and a shapes delta should not drag the whole redaction seam. The
// symbols keep their exact values; pure-redact.js re-exports both so the
// pure.js barrel surface is unchanged (same names, same typeof, deep-equal
// constants — gzkmx acceptance).

/** SECRET-key pattern for `redactSecrets`: any object key matching this must
 * never be serialized into a hook task/prompt/journal (the wider-goal review's
 * CRITICAL — the storage.onChanged hook forwarded providerConfig.apiKey). */
// Structural: a key whose NAME looks like a credential. BOTH-side boundaries
// prevent false positives on ordinary words that merely CONTAIN a keyword
// (tokenCount, secretary, mytoken, notasecret) — the keyword must START and
// END at a non-word-char boundary.
export const SECRET_KEY_RE = /(?<![a-z0-9])(api[_-]?key|token|secret|password|authorization|credential|bearer|access[_-]?key)(?![a-z0-9])/i;

/** Bare-secret SHAPES: credential-shaped STRING values (an AWS key id, a
 * GitHub token, a Slack token, a Google API key, a JWT…) redacted from text
 * even when no key name names them. Each is a global regex — the redactor
 * resets lastIndex per use. */
export const BARE_SECRET_SHAPES = [
  /(?<![a-zA-Z0-9])(?:sk|rk|pk|key|tok)[-_][A-Za-z0-9_-]{8,}/g,
  /(?<![a-zA-Z0-9])AKIA[0-9A-Z]{16}\b/g,
  /(?<![a-zA-Z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /(?<![a-zA-Z0-9])xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /(?<![a-zA-Z0-9])AIza[0-9A-Za-z_-]{20,}/g,
  /(?<![a-zA-Z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];


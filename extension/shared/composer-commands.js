// shared/composer-commands.js — the composer slash-command registry + data loaders.
// DOM-free and dependency-injected so each Chrome-backed picker is unit-testable.

import { skillMatchesUrl } from "./match-patterns.js";

/** chrome-agent-platform-fwf6 — the composer's half of the 6yfm ruling (coord
 *  seq944, option C: insertion-only, no bare-command bypass).
 *
 *  A picked composer command (/skill:x, /x, $x) is INSERTED into the owner's
 *  message as conversation text; it is never dispatched as a bare top-level
 *  ACP command. CAP reads it inside the protected prompt — the same envelope
 *  extension/lib/acp-model.js wraps harness prompts in — so the protection the
 *  ruling demands (untrusted fences intact, tool authority and approvals
 *  unchanged) holds for commands exactly as for typed text.
 *
 *  This constant is the ONE source for the sentence the picker shows, so
 *  composer-commands.js (registry) and components.js (renderer) cannot drift;
 *  tests/composer-slash-commands.test.ts DRIVES the renderer and pins this text
 *  plus the listbox's aria-describedby, so deleting the note is RED. */
export const COMMAND_INSERTION_DISCLOSURE =
  "Inserted into your message as conversation text inside CAP's protected prompt — not run as a bare native command.";

export const COMMAND_NAMESPACES = Object.freeze([
  { id: "skill", label: "skill", description: "invoke a skill", kind: "skill", group: "Run & switch" },
  {
    id: "command",
    label: "command",
    description: "invoke an imported command",
    kind: "command",
    group: "Run & switch",
  },
  {
    id: "agent",
    label: "agent",
    description: "direct the message to an agent",
    kind: "agent",
    direct: true,
    group: "Run & switch",
  },
  {
    id: "tabs",
    label: "tabs",
    description: "attach an open tab",
    kind: "tab",
    direct: true,
    group: "Attach context",
  },
  {
    id: "artifacts",
    label: "artifacts",
    description: "attach an artifact",
    kind: "artifact",
    direct: true,
    group: "Attach context",
  },
  {
    id: "capture",
    label: "capture",
    description: "capture page as readable note artifact",
    kind: "capture",
    direct: true,
  },
  {
    id: "bookmarks",
    label: "bookmarks",
    description: "attach a bookmarked page",
    kind: "bookmark",
    direct: true,
    group: "Attach context",
  },
  {
    id: "history",
    label: "history",
    description: "attach a page from browsing history",
    kind: "history",
    direct: true,
    group: "Attach context",
  },
  {
    id: "files",
    label: "files",
    description: "attach a file from a granted folder",
    kind: "files",
    localFiles: true,
    group: "Attach context",
  },
  {
    id: "folder",
    label: "folder",
    description: "attach a granted folder",
    kind: "folder",
    localFiles: true,
    group: "Attach context",
  },
  {
    id: "remember",
    label: "remember",
    description: "write something to memory",
    kind: "free",
    group: "Session",
  },
  {
    id: "summarise",
    label: "summarise",
    description: "summarise the attached tab or selection on-device",
    kind: "direct",
    direct: true,
  },
  {
    id: "translate",
    label: "translate",
    description: "translate the attached tab or selection on-device",
    kind: "free",
  },
  {
    id: "paste",
    label: "paste",
    description: "attach text from clipboard",
    kind: "paste",
    direct: true,
  },
]);

// Shared 18px currentColor stroke icons for the composer + attach menu
// (CAP-FB-20260830-ICONOGRAPHY-GAPS-01 / chrome-agent-platform-wp6u).
export const ATTACH_MENU_ICONS = Object.freeze({
  file:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  "paste-clipboard":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
  "record-audio":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  "capture-camera":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  "record-screen":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  "grab-screenshot":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  "capture-page":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  "add-tab":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>',
  "choose-agent":
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
});

const clean = (value, max = 512) => String(value ?? "").slice(0, max);
const hit = (query, ...values) =>
  !query || values.some((value) => clean(value).toLowerCase().includes(query));

/**
 * chrome-agent-platform-tiw25 + chrome-agent-platform-3io3p:
 * Imported commands remain untrusted as stored remote data and become an
 * owner-authored task instruction ONLY after explicit owner adoption bound to
 * (command id, provenance source, SHA-256 of canonical unfenced content).
 * At insertion/send we reject unknown provenance, changed or malformed legacy
 * fences, missing approval, and stale/mutated bodies; we render the approved
 * body as readable plaintext task, never a misleading <run-token> placeholder
 * or a real run token.
 */
export const UNTRUSTED_COMMAND_TOKEN_PLACEHOLDER = "<run-token>";
export const IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS =
  "Review required before running this imported command.";

const PLACEHOLDER_OPEN = `<<<UNTRUSTED run:${UNTRUSTED_COMMAND_TOKEN_PLACEHOLDER}>>>`;
const PLACEHOLDER_CLOSE = `<<<END run:${UNTRUSTED_COMMAND_TOKEN_PLACEHOLDER}>>>`;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** Compute deterministic 64-char lowercase hex SHA-256 of normalized UTF-8 command content. */
export function computeCommandContentSha256(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const msg = new TextEncoder().encode(normalized);
  const bitLenHi = Math.floor(msg.length / 0x20000000);
  const bitLenLo = (msg.length << 3) >>> 0;
  const padLen = (msg.length + 9 + 63) & ~63;
  const buf = new Uint8Array(padLen);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, bitLenHi, false);
  view.setUint32(padLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, "0"))
    .join("");
}

/** Return true if text carries a raw <run-token> placeholder or untrusted fence delimiter. */
export function containsUntrustedPlaceholderFence(text) {
  if (typeof text !== "string" || !text) return false;
  return (
    text.includes(UNTRUSTED_COMMAND_TOKEN_PLACEHOLDER) ||
    text.includes("<<<UNTRUSTED") ||
    text.includes("<<<END run:")
  );
}

function unwrapSingleStringBody(rawText, { requireFence = false } = {}) {
  if (typeof rawText !== "string") {
    return { ok: false, reason: "empty_body", error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS };
  }
  const normalized = rawText.replace(/\r\n/g, "\n");
  const trimmed = normalized.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty_body", error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS };
  }
  const hasFenceMarkers =
    trimmed.startsWith("<<<UNTRUSTED") ||
    trimmed.includes("<<<UNTRUSTED") ||
    trimmed.includes("<<<END") ||
    trimmed.includes(UNTRUSTED_COMMAND_TOKEN_PLACEHOLDER);

  if (hasFenceMarkers) {
    if (
      !trimmed.startsWith(`${PLACEHOLDER_OPEN}\n`) ||
      !trimmed.endsWith(`\n${PLACEHOLDER_CLOSE}`)
    ) {
      return {
        ok: false,
        reason: "malformed_fence",
        error: "Imported command has a malformed or forged untrusted fence; review required.",
      };
    }
    const firstClose = trimmed.indexOf(PLACEHOLDER_CLOSE);
    if (firstClose !== trimmed.length - PLACEHOLDER_CLOSE.length) {
      return {
        ok: false,
        reason: "malformed_fence",
        error: "Imported command fence closes early with trailing text; review required.",
      };
    }
    const inner = trimmed.slice(
      PLACEHOLDER_OPEN.length + 1,
      trimmed.length - PLACEHOLDER_CLOSE.length - 1,
    );
    if (!inner.trim() || containsUntrustedPlaceholderFence(inner)) {
      return {
        ok: false,
        reason: "malformed_fence",
        error: "Imported command contains nested or placeholder fence markers; review required.",
      };
    }
    return {
      ok: true,
      body: inner,
      wasFenced: true,
      sha256: computeCommandContentSha256(inner),
    };
  }

  if (requireFence) {
    return {
      ok: false,
      reason: "malformed_fence",
      error: "Imported command claims fenced:true without a valid untrusted fence; review required.",
    };
  }

  return {
    ok: true,
    body: normalized,
    wasFenced: false,
    sha256: computeCommandContentSha256(normalized),
  };
}

/**
 * Extract the canonical unfenced body and SHA-256 digest from a command or prompt string.
 * Rejects malformed, nested, forged, or trailing fences fail-closed, and rejects if
 * multiple body fields on a command object disagree (1-byte mutation detection).
 */
export function extractCanonicalCommandBody(commandOrPrompt, options = {}) {
  if (typeof commandOrPrompt === "string") {
    return unwrapSingleStringBody(commandOrPrompt, options);
  }
  if (!commandOrPrompt || typeof commandOrPrompt !== "object") {
    return { ok: false, reason: "invalid_command", error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS };
  }
  const cmdName = String(commandOrPrompt.name ?? commandOrPrompt.id ?? "").trim();
  const bareSlashName = cmdName ? `/${cmdName}` : "";
  const candidates = [];
  const requirePromptFence = Boolean(options.requireFence || (commandOrPrompt.fenced === true && commandOrPrompt.adopted !== true));

  if (typeof commandOrPrompt.prompt === "string" && commandOrPrompt.prompt !== "") {
    candidates.push({ field: "prompt", value: commandOrPrompt.prompt, requireFence: requirePromptFence });
  }
  if (typeof commandOrPrompt.body === "string" && commandOrPrompt.body !== "") {
    candidates.push({ field: "body", value: commandOrPrompt.body, requireFence: false });
  }
  if (typeof commandOrPrompt.rawPrompt === "string" && commandOrPrompt.rawPrompt !== "") {
    candidates.push({ field: "rawPrompt", value: commandOrPrompt.rawPrompt, requireFence: false });
  }
  if (typeof commandOrPrompt.template === "string" && commandOrPrompt.template !== "") {
    candidates.push({ field: "template", value: commandOrPrompt.template, requireFence: false });
  }
  if (typeof commandOrPrompt.approvedPrompt === "string" && commandOrPrompt.approvedPrompt !== "") {
    candidates.push({ field: "approvedPrompt", value: commandOrPrompt.approvedPrompt, requireFence: false });
  }
  if (typeof commandOrPrompt.task === "string" && commandOrPrompt.task !== "") {
    candidates.push({ field: "task", value: commandOrPrompt.task, requireFence: false });
  }
  if (
    typeof commandOrPrompt.insertText === "string" &&
    commandOrPrompt.insertText !== "" &&
    (candidates.length === 0 || (commandOrPrompt.insertText.trim() !== bareSlashName && commandOrPrompt.insertText.trim() !== `/${commandOrPrompt.id}`))
  ) {
    candidates.push({ field: "insertText", value: commandOrPrompt.insertText, requireFence: false });
  }

  if (candidates.length === 0) {
    return { ok: false, reason: "empty_body", error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS };
  }

  let primary = null;
  for (const cand of candidates) {
    const res = unwrapSingleStringBody(cand.value, { requireFence: cand.requireFence });
    if (!res.ok) return res;
    if (!primary) {
      primary = res;
    } else if (res.sha256 !== primary.sha256 || res.body !== primary.body) {
      return {
        ok: false,
        reason: "digest_mismatch",
        error: "Imported command body was modified after adoption; review required.",
      };
    }
  }
  return primary;
}

/** Return true if a composer command item represents an imported command (rather than built-in /summarise or /translate). */
export function isImportedCommandItem(item) {
  if (!item || typeof item !== "object") return false;
  const id = String(item.id ?? "");
  if (id === "summarise" || id === "translate" || id === "cmd:command") return false;
  if (
    id.startsWith("command:") ||
    (typeof item.commandId === "string" && item.commandId.length > 0) ||
    item.ns === "command" ||
    item.ns === "cmd" ||
    item.untrusted === true ||
    item.fenced === true ||
    item.source === "imported" ||
    item.category === "imported" ||
    typeof item.sourceUrl === "string" ||
    typeof item.contentSha256 === "string" ||
    typeof item.adoptedSha256 === "string" ||
    typeof item.reviewRequired === "boolean" ||
    containsUntrustedPlaceholderFence(item.prompt) ||
    containsUntrustedPlaceholderFence(item.insertText)
  ) {
    return true;
  }
  return item.kind === "command";
}

function normalizeCommandId(commandOrId) {
  const raw = typeof commandOrId === "string"
    ? commandOrId
    : String(commandOrId?.commandId || commandOrId?.id || "");
  const trimmed = raw.trim();
  return trimmed.startsWith("command:") ? trimmed.slice("command:".length) : trimmed;
}

function resolveCommandProvenance(command) {
  const rawSource = typeof command?.source === "string" ? command.source.trim() : "";
  const rawSourceUrl = typeof command?.sourceUrl === "string" ? command.sourceUrl.trim() : "";
  const effectiveSource = rawSource && rawSource !== "imported" ? rawSource : (rawSourceUrl || rawSource);
  return { rawSource, rawSourceUrl, effectiveSource };
}

/**
 * Preview an imported command's exact canonical body, provenance source, and SHA-256 digest
 * for explicit owner review prior to adoption.
 */
export function previewImportedCommand(command) {
  if (!command || typeof command !== "object") {
    return { ok: false, reason: "invalid_command", error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS };
  }
  const cmdId = normalizeCommandId(command);
  if (!cmdId) {
    return { ok: false, reason: "missing_id", error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS };
  }
  const { rawSource, rawSourceUrl, effectiveSource } = resolveCommandProvenance(command);
  if (!effectiveSource || effectiveSource === "unknown" || rawSource === "unknown") {
    return {
      ok: false,
      reason: "unknown_provenance",
      error: "Imported command has unknown provenance and cannot be adopted.",
    };
  }
  const extracted = extractCanonicalCommandBody(command);
  if (!extracted.ok) {
    return { ok: false, reason: extracted.reason, error: extracted.error };
  }
  if (
    typeof command.contentSha256 === "string" &&
    command.contentSha256.trim() &&
    command.contentSha256.trim().toLowerCase() !== extracted.sha256
  ) {
    return {
      ok: false,
      reason: "digest_mismatch",
      error: "Imported command content does not match its recorded SHA-256 digest.",
    };
  }
  return {
    ok: true,
    id: cmdId,
    name: String(command.name || cmdId),
    source: effectiveSource,
    sourceUrl: rawSourceUrl || null,
    sha256: extracted.sha256,
    body: extracted.body,
  };
}

/**
 * Validate and resolve an imported command into its owner-adopted plaintext task instruction.
 * Fails closed on unknown provenance, malformed/placeholder fences, missing adoption, or
 * a 1-byte modification (SHA-256 mismatch between live content and owner-adopted digest).
 */
export function resolveImportedCommandTask(command, adoptionRecord = undefined) {
  if (!command || typeof command !== "object") {
    return {
      ok: false,
      reviewRequired: true,
      reason: "invalid_command",
      error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
    };
  }
  const cmdId = normalizeCommandId(command);
  if (!cmdId) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "missing_id",
      error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
    };
  }
  const { rawSource, rawSourceUrl, effectiveSource } = resolveCommandProvenance(command);
  if (!effectiveSource || effectiveSource === "unknown" || rawSource === "unknown") {
    return {
      ok: false,
      reviewRequired: true,
      reason: "unknown_provenance",
      error: "Imported command has unknown provenance; review required.",
    };
  }
  const extracted = extractCanonicalCommandBody(command);
  if (!extracted.ok) {
    return {
      ok: false,
      reviewRequired: true,
      reason: extracted.reason,
      error: extracted.error || IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
    };
  }
  const liveSha256 = extracted.sha256;
  const canonicalBody = extracted.body;

  if (
    typeof command.contentSha256 === "string" &&
    command.contentSha256.trim() &&
    command.contentSha256.trim().toLowerCase() !== liveSha256
  ) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "digest_mismatch",
      sha256: liveSha256,
      error: "Imported command content changed since import; review required.",
    };
  }

  let adoption = adoptionRecord;
  if (adoption instanceof Map) {
    adoption = adoption.get(cmdId) ?? adoption.get(command.id) ?? null;
  } else if (
    adoption &&
    typeof adoption === "object" &&
    !("sha256" in adoption) &&
    !("adoptedSha256" in adoption) &&
    !("id" in adoption) &&
    !("commandId" in adoption)
  ) {
    adoption = adoption[cmdId] ?? adoption[command.id] ?? null;
  } else if (adoption === undefined) {
    if (
      typeof command.adoptedSha256 === "string" &&
      command.adoptedSha256.trim() &&
      command.reviewRequired !== true
    ) {
      adoption = {
        id: command.adoptedId ?? cmdId,
        source: command.adoptedSource ?? effectiveSource,
        sourceUrl: command.adoptedSourceUrl ?? (rawSourceUrl || null),
        sha256: command.adoptedSha256,
        adoptedAt: command.adoptedAt ?? null,
      };
    } else {
      adoption = null;
    }
  }

  if (!adoption || typeof adoption !== "object") {
    return {
      ok: false,
      reviewRequired: true,
      reason: "missing_adoption",
      sha256: liveSha256,
      error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
    };
  }

  const adoptedId = normalizeCommandId(adoption);
  if (!adoptedId || adoptedId !== cmdId) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "id_mismatch",
      sha256: liveSha256,
      error: "Imported command adoption id does not match command id; review required.",
    };
  }

  const adoptedSource = String(adoption.source ?? adoption.adoptedSource ?? "").trim();
  if (!adoptedSource || adoptedSource === "unknown") {
    return {
      ok: false,
      reviewRequired: true,
      reason: "unknown_provenance",
      sha256: liveSha256,
      error: "Imported command adoption record has unknown provenance; review required.",
    };
  }

  const expectedSourceUrl = adoption.sourceUrl ?? command.adoptedSourceUrl ?? null;
  if (expectedSourceUrl && rawSourceUrl !== expectedSourceUrl) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "source_mismatch",
      sha256: liveSha256,
      error: "Imported command sourceUrl changed after adoption; review required.",
    };
  }
  if (
    command.adoptedSource &&
    rawSource &&
    command.adoptedSource !== rawSource &&
    command.adoptedSource !== effectiveSource
  ) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "source_mismatch",
      sha256: liveSha256,
      error: "Imported command source changed after adoption; review required.",
    };
  }

  const sourceMatches =
    adoptedSource === effectiveSource ||
    (rawSource === "imported" && rawSourceUrl && adoptedSource === rawSource) ||
    (rawSourceUrl && adoptedSource === rawSourceUrl && rawSource === "imported");
  if (!sourceMatches) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "source_mismatch",
      sha256: liveSha256,
      error: "Imported command provenance source does not match adoption record; review required.",
    };
  }

  const adoptedSha256 = String(adoption.sha256 ?? adoption.adoptedSha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(adoptedSha256)) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "invalid_digest",
      sha256: liveSha256,
      error: "Imported command adoption record has an invalid SHA-256 digest; review required.",
    };
  }
  if (adoptedSha256 !== liveSha256) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "digest_mismatch",
      sha256: liveSha256,
      error: "Imported command body does not match the owner-approved SHA-256 digest; review required.",
    };
  }

  if (containsUntrustedPlaceholderFence(canonicalBody)) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "placeholder_fence_rejected",
      sha256: liveSha256,
      error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
    };
  }

  return {
    ok: true,
    reviewRequired: false,
    id: cmdId,
    source: adoptedSource,
    sha256: liveSha256,
    task: canonicalBody,
    text: canonicalBody,
  };
}

function stampAdoptedCommand(command, adoption) {
  const resolved = resolveImportedCommandTask(
    { ...command, contentSha256: undefined },
    adoption,
  );
  if (!resolved.ok) return resolved;
  const now = Number.isFinite(adoption?.adoptedAt) ? adoption.adoptedAt : Date.now();
  const stamped = {
    ...command,
    id: resolved.id,
    source: command.source || resolved.source,
    contentSha256: resolved.sha256,
    adopted: true,
    reviewRequired: false,
    adoptedId: resolved.id,
    adoptedSource: resolved.source,
    adoptedSourceUrl: command.sourceUrl ?? null,
    adoptedSha256: resolved.sha256,
    adoptedAt: now,
  };
  return {
    ...stamped,
    ok: true,
    task: resolved.task,
    text: resolved.task,
    sha256: resolved.sha256,
    command: stamped,
  };
}

/**
 * Record explicit owner adoption of an imported command bound to { id, source, sha256 }.
 * Accepts either a memory store ({ get, set }) or a command object directly.
 */
export function adoptImportedCommand(target, adoption) {
  if (target && typeof target.get === "function" && typeof target.set === "function") {
    return (async () => {
      const cmdId = normalizeCommandId(adoption);
      if (!cmdId) {
        return { ok: false, reviewRequired: true, reason: "missing_id", error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS };
      }
      const list = (await target.get("importedCommands")) ?? [];
      const idx = list.findIndex((c) => normalizeCommandId(c) === cmdId);
      if (idx < 0) {
        return { ok: false, reviewRequired: true, reason: "not_found", error: "No imported command with that id." };
      }
      const res = stampAdoptedCommand(list[idx], adoption);
      if (!res.ok) return res;
      list[idx] = res.command;
      await target.set("importedCommands", list);
      return res;
    })();
  }
  return stampAdoptedCommand(target, adoption);
}

/**
 * Resolve an NTP starter-chip pick when the chip text starts with `/`.
 * Fails closed unless the matching imported command has a valid owner adoption record.
 */
export function resolveCommandStarterPick(text, commands = []) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("/")) {
    return { ok: false, reviewRequired: false, reason: "not_command", error: "" };
  }
  const cmdName = raw.slice(1).trim();
  const list = Array.isArray(commands) ? commands : [];
  const cmd = list.find((c) => c && (c.name === cmdName || c.id === cmdName));
  if (!cmd) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "not_found",
      error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
    };
  }
  return resolveImportedCommandTask(cmd);
}

/**
 * Validate a task instruction string (and optional command metadata) at composer send / SW admission.
 * Rejects any task carrying the public <run-token> placeholder fence or un-adopted command provenance.
 */
export function validateTaskInstructionAdmission(task, options = {}) {
  if (options?.command) {
    const cmdCheck = resolveImportedCommandTask(options.command, options.adoptionRecord);
    if (!cmdCheck.ok) return cmdCheck;
  }
  if (typeof task === "object" && task !== null && ("prompt" in task || "commandId" in task || "reviewRequired" in task)) {
    return resolveImportedCommandTask(task, options?.adoptionRecord);
  }
  const str = String(task ?? "");
  if (containsUntrustedPlaceholderFence(str)) {
    return {
      ok: false,
      reviewRequired: true,
      reason: "placeholder_fence_rejected",
      error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
    };
  }
  return { ok: true, reviewRequired: false, task: str, text: str };
}

async function hasPermission(chromeApi, permission) {
  try {
    return !!(await chromeApi?.permissions?.contains?.({ permissions: [permission] }));
  } catch {
    return false;
  }
}

function unavailablePermissionItem(permission) {
  const label = permission === "bookmarks" ? "Bookmarks" : "History";
  return [{
    id: `capability:${permission}`,
    label: `${label} unavailable`,
    description: `Grant ${label} in Settings, then retry /${permission}`,
    kind: "capability",
    capability: permission,
  }];
}

/**
 * List/search one command namespace through the actual backing API.
 * @param {string} ns
 * @param {string} arg
 * @param {{ runtimeSend?: ((type: string, payload?: Record<string, unknown>) => Promise<any>) | null, chromeApi?: any }} deps
 * @returns {Promise<any[]>}
 */
export async function loadComposerCommandItems(
  ns,
  arg = "",
  { runtimeSend = null, chromeApi = globalThis.chrome } = {},
) {
  const query = clean(arg, 512).toLowerCase();
  switch (ns) {
    case "skill": {
      const res = runtimeSend
        ? await runtimeSend("skill.list").catch(() => ({}))
        : {};
      // Origin-bound skills (CAP-FB-20260830-SITE-PLAYBOOKS-01): a skill
      // declaring `origins` is OFFERED only when the active tab matches.
      // This is the soft UX surface — the hard boundary is prompt composition.
      let activeUrl = "";
      try {
        const tabs = await chromeApi?.tabs?.query?.({ active: true, currentWindow: true }) ?? [];
        activeUrl = String(tabs?.[0]?.url ?? "");
      } catch { activeUrl = ""; }
      return (res.skills || [])
        .filter((item) => hit(query, item.name, item.id))
        .filter((item) => !Array.isArray(item.origins) || item.origins.length === 0 || skillMatchesUrl(item, activeUrl))
        .map((item) => ({
          // Collision-proof reference (CAP-FB-20260831-SKILL-LIST-SYNC-01 r2):
          // the reference is built from the source-qualified refId so an
          // imported skill whose id collides with a built-in skill id is
          // inserted as /skill:imported:<id> and resolves to the imported row
          // — never to a built-in BACKGROUND skill.
          id: `skill:${item.refId ?? item.id}`,
          label: clean(item.name || item.id, 256),
          description: clean(item.description, 512),
          kind: "skill",
        }));
    }
    case "cmd":
    case "command": {
      const res = runtimeSend
        ? await runtimeSend("command.list").catch(() => ({}))
        : {};
      const commands = Array.isArray(res?.commands) ? res.commands : [];
      return commands
        .filter((item) =>
          hit(
            query,
            item.name,
            item.id,
            item.description,
            item.argumentHint,
            item.plugin,
          )
        )
        .map((item) => {
          const hint = item.argumentHint ? ` [${item.argumentHint}]` : "";
          const plugin = item.plugin ? ` (${item.plugin})` : "";
          const baseDescription = `${item.description || "Imported command"}${hint}${plugin}`;
          const resolved = resolveImportedCommandTask(item);
          if (!resolved.ok) {
            return {
              id: `command:${item.id}`,
              commandId: item.id,
              label: `/${item.name}`,
              description: `${baseDescription} — review required`,
              kind: "command",
              argumentHint: item.argumentHint || "",
              prompt: "",
              plugin: item.plugin || null,
              insertText: "",
              source: item.source || item.sourceUrl || null,
              contentSha256: resolved.sha256 || item.contentSha256 || null,
              adoptedSha256: null,
              reviewRequired: true,
              disabled: true,
              status: resolved.error || IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
              reason: resolved.reason,
            };
          }
          return {
            id: `command:${item.id}`,
            commandId: item.id,
            label: `/${item.name}`,
            description: baseDescription,
            kind: "command",
            argumentHint: item.argumentHint || "",
            prompt: resolved.task,
            plugin: item.plugin || null,
            insertText: resolved.task,
            source: resolved.source,
            contentSha256: resolved.sha256,
            adoptedSha256: resolved.sha256,
            adoptedAt: item.adoptedAt ?? null,
            reviewRequired: false,
          };
        });
    }
    case "agent":
      return [];
    case "files": {
      const res = runtimeSend
        ? await runtimeSend("fs-grant.search", { query: arg, limit: 50 }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        : { ok: false, error: "extension runtime unavailable" };
      const rows = [];
      for (const issue of (res.permissionIssues || [])) {
        rows.push({
          id: `files-settings:${issue.grantId}`,
          label: clean(issue.name || "Granted folder", 256),
          description: issue.status === "prompt" ? "needs access again — open Settings" : "access denied — forget and add again in Settings",
          recovery: issue.status === "prompt"
            ? `Open Settings → Local folders and choose Re-grant access for ${issue.name}.`
            : `Open Settings → Local folders, forget ${issue.name}, then add it again.`,
          kind: "files-action",
        });
      }
      for (const file of (res.files || [])) {
        rows.push({
          id: `files:${file.grantId}:${file.relativePath}`,
          label: clean(file.name, 256),
          description: clean(`${file.folderName} / ${file.relativePath}`, 512),
          kind: "local-file",
          ...file,
        });
      }
      if (!rows.length) {
        rows.push({
          id: "files-settings",
          label: res.ok === false ? "Local files unavailable" : "No matching files",
          description: res.ok === false ? `${clean(res.error || "search failed")} — open Settings` : "Grant a folder or change the search — Settings → Local folders",
          recovery: "Open Settings → Local folders and choose Add folder.",
          kind: "files-action",
        });
      }
      return rows.slice(0, 50);
    }
    case "folder": {
      const res = runtimeSend
        ? await runtimeSend("fs-grant.list", {}).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        : { ok: false, error: "extension runtime unavailable" };
      const rows = [];
      for (const grant of (res.grants || [])) {
        if (grant.kind !== "directory") continue;
        if (!hit(query, grant.name)) continue;
        if (grant.status === "granted") {
          rows.push({
            id: `folder:${grant.grantId}`,
            label: clean(grant.name || "Granted folder", 256),
            description: "granted local folder — attach as a reference",
            kind: "local-folder",
            grantId: clean(grant.grantId, 128),
            folderName: clean(grant.name || "folder", 256),
          });
        } else {
          rows.push({
            id: `folder-settings:${grant.grantId}`,
            label: clean(grant.name || "Granted folder", 256),
            description: grant.status === "prompt" ? "needs access again — open Settings" : "access denied — forget and add again in Settings",
            recovery: grant.status === "prompt"
              ? `Open Settings → Local folders and choose Re-grant access for ${grant.name}.`
              : `Open Settings → Local folders, forget ${grant.name}, then add it again.`,
            kind: "files-action",
          });
        }
      }
      const directoryGrants = (res.grants || []).filter((g) => g.kind === "directory");
      if (!rows.length) {
        rows.push({
          id: "folder-settings",
          label: res.ok === false ? "Local folders unavailable" : (directoryGrants.length ? "No matching folders" : "No granted folders"),
          description: res.ok === false ? `${clean(res.error || "fs-grant.list failed")} — open Settings` : (directoryGrants.length ? "Change the search — Settings → Local folders" : "Grant a folder — Settings → Local folders"),
          recovery: "Open Settings → Local folders and choose Add folder.",
          kind: "files-action",
        });
      }
      return rows.slice(0, 50);
    }
    case "tabs": {
      const tabs = await chromeApi?.tabs?.query?.({}) ?? [];
      return tabs
        .filter((tab) => hit(query, tab.title, tab.url))
        .slice(0, 200)
        .map((tab) => ({
          id: `tabs:${tab.id}`,
          label: clean(tab.title || tab.url || "(untitled)", 256),
          description: clean(tab.url, 512),
          kind: "tab",
          attachment: {
            name: clean(tab.title || tab.url || "tab", 256),
            url: clean(tab.url, 2048),
            type: "tab",
            size: 0,
            kind: "tab",
            tabId: tab.id,
            windowId: tab.windowId,
          },
        }));
    }
    case "artifacts": {
      const res = runtimeSend
        ? await runtimeSend("asset.list", { origin: "all" }).catch(() => ({}))
        : {};
      return (res.assets || [])
        .filter((artifact) =>
          hit(query, artifact.name, artifact.id, artifact.type)
        )
        .slice(0, 200)
        .map((artifact) => ({
          id: `artifact:${artifact.id}`,
          label: clean(artifact.name || artifact.id || "artifact", 256),
          description: clean(artifact.type || "artifact", 128),
          kind: "artifact",
          artifactId: clean(artifact.id, 256),
          artifactOrigin: clean(artifact.origin || "master", 2048),
        }));
    }
    case "capture": {
      return [{
        id: "capture:page",
        label: "Capture active tab",
        description: "Save active tab as a clean Markdown artifact",
        kind: "capture",
      }];
    }
    case "bookmarks": {
      if (!(await hasPermission(chromeApi, "bookmarks"))) {
        return unavailablePermissionItem("bookmarks");
      }
      const bookmarks = query
        ? await chromeApi?.bookmarks?.search?.(arg) ?? []
        : await chromeApi?.bookmarks?.getRecent?.(100) ?? [];
      return bookmarks
        .filter((bookmark) =>
          bookmark?.url && hit(query, bookmark.title, bookmark.url)
        )
        .slice(0, 100)
        .map((bookmark) => ({
          id: `bookmarks:${bookmark.id}`,
          label: clean(bookmark.title || bookmark.url, 256),
          description: clean(bookmark.url, 512),
          kind: "bookmark",
          insertText: `Bookmark: ${clean(bookmark.url, 2048)}`,
          attachment: {
            name: clean(bookmark.title || bookmark.url, 256),
            url: clean(bookmark.url, 2048),
            type: "text/uri-list",
            size: 0,
            kind: "bookmark",
            bookmarkId: clean(bookmark.id, 64),
          },
        }));
    }
    case "history": {
      if (!(await hasPermission(chromeApi, "history"))) {
        return unavailablePermissionItem("history");
      }
      const history = await chromeApi?.history?.search?.({
        text: arg,
        startTime: 0,
        maxResults: 100,
      }) ?? [];
      return history
        .filter((entry) => entry?.url && hit(query, entry.title, entry.url))
        .slice(0, 100)
        .map((entry, index) => ({
          id: `history:${index}`,
          label: clean(entry.title || entry.url, 256),
          description: clean(entry.url, 512),
          kind: "history",
          insertText: `History: ${clean(entry.url, 2048)}`,
          attachment: {
            name: clean(entry.title || entry.url, 256),
            url: clean(entry.url, 2048),
            type: "text/uri-list",
            size: 0,
            kind: "history",
            lastVisitTime: entry.lastVisitTime ?? null,
          },
        }));
    }
    case "summarise": {
      return [
        {
          id: "summarise",
          label: "Summarise",
          description: "Summarise the attached tab or selection on-device (private, zero API key)",
          kind: "command",
          insertText: "/summarise",
          prompt: "Summarise this on-device",
        },
      ];
    }
    case "translate": {
      const lang = query || arg || "es";
      return [
        {
          id: "translate",
          label: `Translate to ${lang}`,
          description: `Translate the attached tab or selection to ${lang} on-device (private, zero API key)`,
          kind: "command",
          insertText: `/translate ${lang}`.trim(),
          prompt: `Translate this to ${lang} on-device`,
        },
      ];
    }
    case "paste": {
      return [{
        id: "paste:clipboard",
        label: "Paste from clipboard",
        description: "attach clipboard text safely fenced as untrusted data",
        kind: "paste",
      }];
    }
    default:
      return [];
  }
}

function utf8DataUrl(type, content) {
  if (type === "image") return clean(content, 8 * 1024 * 1024);
  const bytes = new TextEncoder().encode(String(content ?? ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const mime = type === "html"
    ? "text/html"
    : type === "json"
    ? "application/json"
    : "text/plain";
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Turn a picked row into the text reference + pending attachment sent to the agent.
 * @param {any} item
 * @param {{ runtimeSend?: ((type: string, payload?: Record<string, unknown>) => Promise<any>) | null, chromeApi?: any }} deps
 * @returns {Promise<{ text: string, attachment: any, notice?: string } | null>}
 */
export async function resolveComposerCommandSelection(
  item,
  { runtimeSend = null, chromeApi = globalThis.chrome } = {},
) {
  if (!item) return null;
  if (item.kind === "command" || isImportedCommandItem(item) || containsUntrustedPlaceholderFence(item.insertText || item.prompt || item.task)) {
    if (isImportedCommandItem(item) || containsUntrustedPlaceholderFence(item.insertText || item.prompt || item.task)) {
      let check = resolveImportedCommandTask(item);
      if (check.ok && typeof runtimeSend === "function") {
        const res = await runtimeSend("command.list").catch(() => null);
        if (Array.isArray(res?.commands)) {
          const live = res.commands.find((c) => normalizeCommandId(c) === check.id);
          if (!live) {
            check = {
              ok: false,
              reviewRequired: true,
              reason: "not_found",
              error: IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
            };
          } else {
            check = resolveImportedCommandTask(live, {
              id: check.id,
              source: check.source,
              sha256: check.sha256,
            });
          }
        }
      }
      if (!check.ok) {
        return {
          text: "",
          attachment: null,
          blocked: true,
          reviewRequired: true,
          reason: check.reason,
          notice: check.error || IMPORTED_COMMAND_REVIEW_REQUIRED_STATUS,
        };
      }
      return {
        text: check.task,
        attachment: null,
      };
    }
    return {
      text: item.insertText || item.prompt || `/${item.id}`,
      attachment: null,
    };
  }
  if (item.kind === "tab" && runtimeSend && Number.isSafeInteger(item.attachment?.tabId)) {
    const tabId = item.attachment.tabId;
    let attested = await runtimeSend("agent.attached-webmcp-document", { tabId }).catch(() => null);
    let notice;
    if (attested?.needScripting === true) {
      // Only the owner's explicit /tabs pick may request the optional API.
      // The SW never prompts during a model run or treats a denial as consent.
      let granted = false;
      try { granted = (await chromeApi?.permissions?.request?.({ permissions: ["scripting"] })) === true; }
      catch { /* owner refused or Chrome could not prompt */ }
      if (granted) {
        attested = await runtimeSend("agent.attached-webmcp-document", { tabId }).catch(() => null);
      } else {
        notice = "Scripting permission denied; tab attached as context only.";
      }
    }
    const documentId = attested?.ok === true && attested.tabId === tabId &&
      typeof attested.documentId === "string" && attested.documentId.length > 0 && attested.documentId.length <= 200
      ? attested.documentId : null;
    return {
      text: item.insertText || `/${item.id}`,
      attachment: documentId ? { ...item.attachment, documentId } : (item.attachment ?? null),
      ...(notice ? { notice } : {}),
    };
  }
  if (item.kind !== "artifact") {
    return {
      text: item.insertText || `/${item.id}`,
      attachment: item.attachment ?? null,
    };
  }
  const res = runtimeSend
    ? await runtimeSend("asset.get", {
      origin: item.artifactOrigin || "master",
      id: item.artifactId,
    }).catch(() => ({}))
    : {};
  const artifact = res?.ok ? res.asset : null;
  if (!artifact) throw new Error("artifact not found");
  const artifactType = artifact.type || "data";
  const mime = artifactType === "html"
    ? "text/html"
    : artifactType === "json"
    ? "application/json"
    : artifactType === "image"
    ? "image/png"
    : "text/plain";
  return {
    text: `/artifact:${artifact.id || item.artifactId}`,
    attachment: {
      name: clean(artifact.name || item.label || "artifact", 256),
      type: mime,
      size: artifact.size ?? 0,
      kind: "artifact",
      dataURL: utf8DataUrl(artifactType, artifact.content),
      content: artifact.content,
      artifactId: artifact.id || item.artifactId,
      artifactOrigin: artifact.origin || item.artifactOrigin || "master",
      artifactType,
    },
  };
}

/** ACP names are protocol data, not CAP namespaces. Preserve explicit sigils. */
export function harnessCommandItems(commands, query = "") {
  const prefix = query.toLowerCase();
  return (Array.isArray(commands) ? commands : []).flatMap((command) => {
    if (typeof command?.name !== "string" || !command.name || /\s|[\x00-\x1f\x7f]/u.test(command.name)) return [];
    const invocation = /^[/$]/u.test(command.name) ? command.name : `/${command.name}`;
    if (prefix && !invocation.toLowerCase().startsWith(prefix)) return [];
    const unsupported = command._meta?.commandAction != null;
    const hint = typeof command.input?.hint === "string" ? command.input.hint : "";
    return [{ id: invocation, label: invocation, kind: "harness-command", disabled: unsupported,
      description: unsupported ? "This harness action is not supported in CAP yet."
        : [typeof command.description === "string" ? command.description : "", hint].filter(Boolean).join(" · ") }];
  });
}

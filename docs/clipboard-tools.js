// lib/clipboard-tools.js — Clipboard read/write tools and gestures (chrome-agent-platform-3p3e.10).
//
// Security policy (Constitution §1, credential-class data):
// 1. write_clipboard is model-callable: validated non-empty string, bounded
//    to 256 KiB, and transparently ledgered so the owner has a receipt.
// 2. read_clipboard is OWNER-DIRECT ONLY: refuses autonomous/background reads
//    without an explicit owner gesture (/paste slash command or "Paste from clipboard"
//    in the attach menu), and wraps content with wrapUntrustedContent and the run's
//    untrusted boundary token so clipboard data can NEVER inject instructions.

import { fenceUntrustedText, wrapUntrustedContent } from "./untrusted-fence.js";

export { wrapUntrustedContent };

export const DEFAULT_MAX_CLIPBOARD_BYTES = 262144; // 256 KiB

/**
 * Validates text within maxBytes, writes to clipboard, and records an action-ledger receipt.
 *
 * @param {string} text
 * @param {{
 *   writeTextFn?: (text: string) => Promise<void>,
 *   recordLedgerFn?: (entry: Record<string, unknown>) => Promise<void> | void,
 *   maxBytes?: number
 * }} [options]
 * @returns {Promise<{ ok: boolean, code?: string, error?: string, characterCount?: number, bytes?: number, preview?: string }>}
 */
export async function writeClipboardText(
  text,
  {
    writeTextFn,
    recordLedgerFn,
    maxBytes = DEFAULT_MAX_CLIPBOARD_BYTES,
  } = {},
) {
  if (typeof text !== "string" || text.length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Text must be a non-empty string.",
    };
  }

  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: "payload_too_large",
      error: `Clipboard payload (${bytes} bytes) exceeds maximum limit of ${maxBytes} bytes.`,
    };
  }

  try {
    if (typeof writeTextFn === "function") {
      await writeTextFn(text);
    } else if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      return {
        ok: false,
        code: "clipboard_unavailable",
        error: "Clipboard write API is unavailable in this environment.",
      };
    }
  } catch (err) {
    return {
      ok: false,
      code: "clipboard_write_failed",
      error: `Failed to write to clipboard: ${err?.message ?? err}`,
    };
  }

  const preview = text.slice(0, 80);
  const ledgerEntry = {
    kind: "clipboard_write",
    preview,
    bytes,
    characterCount: text.length,
    timestamp: Date.now(),
  };

  if (typeof recordLedgerFn === "function") {
    try {
      await recordLedgerFn(ledgerEntry);
    } catch {
      // Ledgering error must not fail the clipboard operation itself
    }
  }

  return {
    ok: true,
    bytes,
    characterCount: text.length,
    preview,
  };
}

/**
 * Reads clipboard text strictly upon an owner gesture, wrapping content as untrusted data.
 *
 * @param {{
 *   readTextFn?: () => Promise<string>,
 *   hasUserGesture?: boolean,
 *   wrapUntrustedFn?: (text: string, token: string) => string,
 *   untrustedToken?: string
 * }} [options]
 * @returns {Promise<{ ok: boolean, code?: string, error?: string, text?: string, rawText?: string, untrusted?: boolean, untrustedToken?: string }>}
 */
export async function readClipboardOnGesture({
  readTextFn,
  hasUserGesture = false,
  wrapUntrustedFn = fenceUntrustedText,
  untrustedToken = "",
} = {}) {
  if (!hasUserGesture) {
    return {
      ok: false,
      code: "clipboard_gesture_required",
      error: "Reading the clipboard requires a direct user action (such as /paste or the attach menu).",
    };
  }

  let text = "";
  try {
    if (typeof readTextFn === "function") {
      text = await readTextFn();
    } else if (typeof navigator !== "undefined" && navigator?.clipboard?.readText) {
      text = await navigator.clipboard.readText();
    } else {
      return {
        ok: false,
        code: "clipboard_unavailable",
        error: "Clipboard read API is unavailable in this environment.",
      };
    }
  } catch (err) {
    return {
      ok: false,
      code: "clipboard_read_failed",
      error: `Failed to read clipboard: ${err?.message ?? err}`,
    };
  }

  const raw = String(text ?? "");
  const wrap = typeof wrapUntrustedFn === "function" ? wrapUntrustedFn : fenceUntrustedText;
  const wrapped = wrap(raw, untrustedToken);

  return {
    ok: true,
    text: wrapped,
    rawText: raw,
    untrusted: true,
    untrustedToken,
  };
}

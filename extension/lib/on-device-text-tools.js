// lib/on-device-text-tools.js — Chrome built-in on-device text APIs wrapper
// Bead: chrome-agent-platform-3p3e.5
//
// Wraps Chrome's built-in on-device APIs (Summarizer, LanguageDetector, Translator)
// running in a DOM/window context (such as the offscreen document).
// Keyless and offline: zero cloud API key required, data never leaves the device.

import { tool } from "ai";
import { z } from "zod";
import { tagUntrusted, wrapUntrustedContent } from "./untrusted-fence.js";

export { wrapUntrustedContent, tagUntrusted };

export {
  ON_DEVICE_UNAVAILABLE_FALLBACK,
  ON_DEVICE_TEXT_TOOL_NAMES,
  getSummarizerAvailability,
  getLanguageDetectorAvailability,
  getTranslatorAvailability,
  summarizeOnDevice,
  detectLanguageOnDevice,
  translateOnDevice,
  registerOnDeviceTextHost,
} from "./on-device-text-host.js";

/**
 * AI SDK toolset factory for on-device text tools.
 */
export function onDeviceTextToolset({ dispatchRoute } = {}) {
  const call = typeof dispatchRoute === "function" ? dispatchRoute : async (t, b) => ({ ok: false, error: `no dispatcher for ${t}` });

  return {
    summarize_text: tool({
      description: "Summarise text using Chrome's on-device Summarizer model (offline, private, zero API key).",
      parameters: z.object({
        text: z.string().describe("The text to summarise"),
        type: z.enum(["key-points", "tl;dr", "teaser", "headline"]).optional().describe("The type of summary"),
        length: z.enum(["short", "medium", "long"]).optional().describe("The summary length"),
        format: z.enum(["plain-text", "markdown"]).optional().describe("The output format"),
      }),
      execute: async ({ text, type, length, format }) => {
        const res = await call("onDeviceText.summarize", { text, type, length, format });
        return tagUntrusted(res);
      },
    }),
    detect_language: tool({
      description: "Detect the language of text using Chrome's on-device LanguageDetector (offline, private, zero API key).",
      parameters: z.object({
        text: z.string().describe("The text to detect the language of"),
      }),
      execute: async ({ text }) => {
        const res = await call("onDeviceText.detectLanguage", { text });
        return tagUntrusted(res);
      },
    }),
    translate_text: tool({
      description: "Translate text using Chrome's on-device Translator model (offline, private, zero API key).",
      parameters: z.object({
        text: z.string().describe("The text to translate"),
        target: z.string().describe("The target language code (e.g. 'en', 'es', 'fr', 'ja')"),
        source: z.string().optional().describe("The source language code (e.g. 'en', 'es'). Auto-detected if omitted."),
      }),
      execute: async ({ text, target, source }) => {
        const res = await call("onDeviceText.translate", { text, target, source });
        return tagUntrusted(res);
      },
    }),
  };
}

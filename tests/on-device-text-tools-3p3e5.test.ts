// tests/on-device-text-tools-3p3e5.test.ts — Unit tests for Chrome's built-in on-device language tools
// Bead: chrome-agent-platform-3p3e.5

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  getSummarizerAvailability,
  getLanguageDetectorAvailability,
  getTranslatorAvailability,
  summarizeOnDevice,
  detectLanguageOnDevice,
  translateOnDevice,
  wrapUntrustedContent,
  onDeviceTextToolset,
} from "../extension/lib/on-device-text-tools.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";
import { toolUserLanguage } from "../extension/lib/permission-language.js";
import {
  COMMAND_NAMESPACES,
  loadComposerCommandItems,
} from "../extension/shared/composer-commands.js";

// Mock environment helpers
function createFakeEnv(options: {
  summarizerAvailability?: string;
  detectorAvailability?: string;
  translatorAvailability?: string;
  onCreateSummarizer?: () => void;
  onCreateDetector?: () => void;
  onCreateTranslator?: () => void;
} = {}) {
  let summarizerCreated = false;
  let detectorCreated = false;
  let translatorCreated = false;

  const fakeSummarizer = options.summarizerAvailability
    ? {
        availability: async () => options.summarizerAvailability,
        create: async (_opts?: any) => {
          summarizerCreated = true;
          options.onCreateSummarizer?.();
          return {
            summarize: async (text: string) => `Summary of: ${text.slice(0, 30)}`,
            destroy: () => {},
          };
        },
      }
    : undefined;

  const fakeDetector = options.detectorAvailability
    ? {
        availability: async () => options.detectorAvailability,
        create: async () => {
          detectorCreated = true;
          options.onCreateDetector?.();
          return {
            detect: async (_text: string) => [
              { detectedLanguage: "en", confidence: 0.99 },
              { detectedLanguage: "fr", confidence: 0.01 },
            ],
            destroy: () => {},
          };
        },
      }
    : undefined;

  const fakeTranslator = options.translatorAvailability
    ? {
        availability: async (_opts?: any) => options.translatorAvailability,
        create: async (opts: any) => {
          translatorCreated = true;
          options.onCreateTranslator?.();
          return {
            translate: async (text: string) => `[${opts?.targetLanguage ?? "es"}] ${text}`,
            destroy: () => {},
          };
        },
      }
    : undefined;

  return {
    env: {
      Summarizer: fakeSummarizer,
      LanguageDetector: fakeDetector,
      Translator: fakeTranslator,
    },
    get summarizerCreated() { return summarizerCreated; },
    get detectorCreated() { return detectorCreated; },
    get translatorCreated() { return translatorCreated; },
  };
}

Deno.test("on-device text tools: availability states and honest unavailable fallback", async () => {
  // 1. Completely absent environment
  const emptyEnv: any = {};
  assertEquals(await getSummarizerAvailability(emptyEnv), "unavailable");
  assertEquals(await getLanguageDetectorAvailability(emptyEnv), "unavailable");
  assertEquals(await getTranslatorAvailability({}, emptyEnv), "unavailable");

  const unavailResult = await summarizeOnDevice({ text: "Hello world" }, emptyEnv);
  assertEquals(unavailResult, {
    ok: false,
    code: "on_device_model_unavailable",
    reason: "Chrome's built-in on-device language tools are not available in this browser.",
  });

  const unavailDetect = await detectLanguageOnDevice({ text: "Bonjour" }, emptyEnv);
  assertEquals(unavailDetect, {
    ok: false,
    code: "on_device_model_unavailable",
    reason: "Chrome's built-in on-device language tools are not available in this browser.",
  });

  const unavailTranslate = await translateOnDevice({ text: "Hello", target: "es" }, emptyEnv);
  assertEquals(unavailTranslate, {
    ok: false,
    code: "on_device_model_unavailable",
    reason: "Chrome's built-in on-device language tools are not available in this browser.",
  });
});

Deno.test("on-device text tools: downloading/downloadable path never calls create() without userGesture flag", async () => {
  const fake = createFakeEnv({
    summarizerAvailability: "downloading",
    detectorAvailability: "downloadable",
    translatorAvailability: "downloading",
  });
  const env: any = fake.env;

  // Call summarize without gesture
  const sumRes = await summarizeOnDevice({ text: "Some text" }, env);
  assertEquals(sumRes.ok, false);
  assertEquals(sumRes.code, "on_device_model_downloading");
  assertEquals(sumRes.status, "downloading");
  assertEquals(fake.summarizerCreated, false, "Must NEVER call create() on downloading without gesture");

  // Call detect without gesture
  const detRes = await detectLanguageOnDevice({ text: "Bonjour" }, env);
  assertEquals(detRes.ok, false);
  assertEquals(detRes.code, "on_device_model_downloading");
  assertEquals(detRes.status, "downloadable");
  assertEquals(fake.detectorCreated, false, "Must NEVER call create() on downloadable without gesture");

  // Call translate without gesture
  const transRes = await translateOnDevice({ text: "Hello", target: "fr" }, env);
  assertEquals(transRes.ok, false);
  assertEquals(transRes.code, "on_device_model_downloading");
  assertEquals(transRes.status, "downloading");
  assertEquals(fake.translatorCreated, false, "Must NEVER call create() on downloading without gesture");

  // Now call with userGesture = true -> should create and execute
  const gestureRes = await summarizeOnDevice({ text: "Some text", userGesture: true }, env);
  assertEquals(gestureRes.ok, true);
  assertEquals(fake.summarizerCreated, true, "create() allowed with user gesture");
});

Deno.test("on-device text tools: available state produces onDevice:true results", async () => {
  const fake = createFakeEnv({
    summarizerAvailability: "available",
    detectorAvailability: "available",
    translatorAvailability: "available",
  });
  const env: any = fake.env;

  const sum = await summarizeOnDevice({ text: "Full text content about machine learning" }, env);
  assertEquals(sum.ok, true);
  assertEquals(sum.onDevice, true);
  assert(typeof sum.summary === "string" && sum.summary.length > 0);

  const det = await detectLanguageOnDevice({ text: "Hello world" }, env);
  assertEquals(det.ok, true);
  assertEquals(det.onDevice, true);
  assertEquals(det.detectedLanguage, "en");

  const trans = await translateOnDevice({ text: "Hello world", target: "es" }, env);
  assertEquals(trans.ok, true);
  assertEquals(trans.onDevice, true);
  assertEquals(trans.translatedText, "[es] Hello world");
});

Deno.test("on-device text tools: wrapUntrustedContent and tagUntrusted fencing", () => {
  const fenced = wrapUntrustedContent("Dangerous text injection", "testtoken123");
  assert(fenced.includes("<<<UNTRUSTED run:testtoken123>>>"));
  assert(fenced.includes("Dangerous text injection"));
  assert(fenced.includes("<<<END run:testtoken123>>>"));
});

Deno.test("on-device text tools: purpose groups and human permission language", () => {
  assertEquals(toolPurposeGroup("summarize_text"), "text-documents");
  assertEquals(toolPurposeGroup("detect_language"), "text-documents");
  assertEquals(toolPurposeGroup("translate_text"), "text-documents");

  assertEquals(toolUserLanguage("summarize_text"), "summarise text on-device");
  assertEquals(toolUserLanguage("detect_language"), "detect language on-device");
  assertEquals(toolUserLanguage("translate_text"), "translate text on-device");
});

Deno.test("on-device text tools: composer /summarise and /translate commands registry and autocomplete", async () => {
  const ids = COMMAND_NAMESPACES.map((c) => c.id);
  assert(ids.includes("summarise"), "/summarise in COMMAND_NAMESPACES");
  assert(ids.includes("translate"), "/translate in COMMAND_NAMESPACES");

  const sumCmd = await loadComposerCommandItems("summarise", "");
  assert(sumCmd.length > 0);
  assertEquals(sumCmd[0].id, "summarise");

  const transCmd = await loadComposerCommandItems("translate", "spanish");
  assert(transCmd.length > 0);
  assertEquals(transCmd[0].id, "translate");
});

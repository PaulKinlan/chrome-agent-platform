// lib/on-device-text-host.js — Chrome built-in on-device text APIs execution host
// Bead: chrome-agent-platform-3p3e.5
// Runs in the offscreen document DOM context with ZERO dependencies on ai/zod.

export const ON_DEVICE_UNAVAILABLE_FALLBACK = Object.freeze({
  ok: false,
  code: "on_device_model_unavailable",
  reason: "Chrome's built-in on-device language tools are not available in this browser.",
});

export const ON_DEVICE_TEXT_TOOL_NAMES = Object.freeze([
  "summarize_text",
  "detect_language",
  "translate_text",
]);

function normalizeAvailability(raw) {
  if (typeof raw !== "string") return "unavailable";
  const s = raw.toLowerCase().trim();
  if (s === "available" || s === "readily") return "available";
  if (s === "downloadable" || s === "after-download") return "downloadable";
  if (s === "downloading") return "downloading";
  return "unavailable";
}

export async function getSummarizerAvailability(env = globalThis) {
  const api = env?.Summarizer ?? env?.ai?.summarizer;
  if (!api) return "unavailable";
  if (typeof api.availability === "function") {
    try {
      const raw = await api.availability();
      return normalizeAvailability(raw);
    } catch {
      return "unavailable";
    }
  }
  if (typeof api.capabilities === "function") {
    try {
      const caps = await api.capabilities();
      return normalizeAvailability(caps?.available ?? caps?.availability);
    } catch {
      return "unavailable";
    }
  }
  return "unavailable";
}

export async function getLanguageDetectorAvailability(env = globalThis) {
  const api = env?.LanguageDetector ?? env?.ai?.languageDetector;
  if (!api) return "unavailable";
  if (typeof api.availability === "function") {
    try {
      const raw = await api.availability();
      return normalizeAvailability(raw);
    } catch {
      return "unavailable";
    }
  }
  if (typeof api.capabilities === "function") {
    try {
      const caps = await api.capabilities();
      return normalizeAvailability(caps?.available ?? caps?.availability);
    } catch {
      return "unavailable";
    }
  }
  return "unavailable";
}

export async function getTranslatorAvailability(options = {}, env = globalThis) {
  const api = env?.Translator ?? env?.ai?.translator;
  if (!api) return "unavailable";
  const target = options?.targetLanguage ?? options?.target ?? "es";
  const source = options?.sourceLanguage ?? options?.source ?? "en";
  if (typeof api.availability === "function") {
    try {
      const raw = await api.availability({ sourceLanguage: source, targetLanguage: target });
      return normalizeAvailability(raw);
    } catch {
      return "unavailable";
    }
  }
  if (typeof api.capabilities === "function") {
    try {
      const caps = await api.capabilities();
      return normalizeAvailability(caps?.available ?? caps?.availability);
    } catch {
      return "unavailable";
    }
  }
  return "unavailable";
}

export async function summarizeOnDevice(
  { text, type, length, format, userGesture, ownerGesture } = {},
  env = globalThis,
) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "text parameter is required for summarization" };
  }
  const availability = await getSummarizerAvailability(env);
  if (availability === "unavailable") {
    return { ...ON_DEVICE_UNAVAILABLE_FALLBACK };
  }
  const hasGesture = userGesture === true || ownerGesture === true;
  if ((availability === "downloadable" || availability === "downloading") && !hasGesture) {
    return {
      ok: false,
      code: "on_device_model_downloading",
      status: availability,
      progress: 0,
      reason: "The on-device model is downloading or requires an owner gesture to download.",
    };
  }

  const api = env.Summarizer ?? env.ai?.summarizer;
  const createOpts = {};
  if (type) createOpts.type = type;
  if (length) createOpts.length = length;
  if (format) createOpts.format = format;

  let instance = null;
  try {
    instance = await api.create(createOpts);
    const summary = await instance.summarize(text);
    return {
      ok: true,
      onDevice: true,
      summary: String(summary ?? ""),
      type: type ?? "key-points",
      length: length ?? "medium",
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { instance?.destroy?.(); } catch { /* ignore */ }
  }
}

export async function detectLanguageOnDevice(
  { text, userGesture, ownerGesture } = {},
  env = globalThis,
) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "text parameter is required for language detection" };
  }
  const availability = await getLanguageDetectorAvailability(env);
  if (availability === "unavailable") {
    return { ...ON_DEVICE_UNAVAILABLE_FALLBACK };
  }
  const hasGesture = userGesture === true || ownerGesture === true;
  if ((availability === "downloadable" || availability === "downloading") && !hasGesture) {
    return {
      ok: false,
      code: "on_device_model_downloading",
      status: availability,
      progress: 0,
      reason: "The on-device model is downloading or requires an owner gesture to download.",
    };
  }

  const api = env.LanguageDetector ?? env.ai?.languageDetector;
  let instance = null;
  try {
    instance = await api.create();
    const results = await instance.detect(text);
    const top = Array.isArray(results) && results.length > 0 ? results[0] : null;
    return {
      ok: true,
      onDevice: true,
      detectedLanguage: top?.detectedLanguage ?? "unknown",
      confidence: top?.confidence ?? 0,
      results: results ?? [],
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { instance?.destroy?.(); } catch { /* ignore */ }
  }
}

export async function translateOnDevice(
  { text, target, targetLanguage, source, sourceLanguage, userGesture, ownerGesture } = {},
  env = globalThis,
) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "text parameter is required for translation" };
  }
  const tgt = targetLanguage ?? target;
  const src = sourceLanguage ?? source;
  if (!tgt) {
    return { ok: false, error: "target language code is required for translation" };
  }
  const availability = await getTranslatorAvailability({ targetLanguage: tgt, sourceLanguage: src }, env);
  if (availability === "unavailable") {
    return { ...ON_DEVICE_UNAVAILABLE_FALLBACK };
  }
  const hasGesture = userGesture === true || ownerGesture === true;
  if ((availability === "downloadable" || availability === "downloading") && !hasGesture) {
    return {
      ok: false,
      code: "on_device_model_downloading",
      status: availability,
      progress: 0,
      reason: "The on-device model is downloading or requires an owner gesture to download.",
    };
  }

  const api = env.Translator ?? env.ai?.translator;
  const createOpts = { targetLanguage: tgt };
  if (src) createOpts.sourceLanguage = src;

  let instance = null;
  try {
    instance = await api.create(createOpts);
    const translatedText = await instance.translate(text);
    return {
      ok: true,
      onDevice: true,
      translatedText: String(translatedText ?? ""),
      targetLanguage: tgt,
      sourceLanguage: src ?? "auto",
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { instance?.destroy?.(); } catch { /* ignore */ }
  }
}

/**
 * Register the on-device text tool listener in the offscreen document.
 */
export function registerOnDeviceTextHost({ runtime = globalThis.chrome?.runtime, env = globalThis } = {}) {
  if (!runtime?.onMessage) return null;
  const listener = (message, _sender, sendResponse) => {
    const type = message?.type || message?.action;
    if (!type || typeof type !== "string") return false;

    if (type === "onDeviceText.summarize") {
      summarizeOnDevice(message, env).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }
    if (type === "onDeviceText.detectLanguage") {
      detectLanguageOnDevice(message, env).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }
    if (type === "onDeviceText.translate") {
      translateOnDevice(message, env).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }
    if (type === "onDeviceText.availability") {
      Promise.all([
        getSummarizerAvailability(env),
        getLanguageDetectorAvailability(env),
        getTranslatorAvailability({}, env),
      ]).then(
        ([summarizer, detector, translator]) =>
          sendResponse({ ok: true, summarizer, detector, translator }),
        (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }
    return false;
  };

  runtime.onMessage.addListener(listener);
  return listener;
}

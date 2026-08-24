// Product-owned, publisher-origin local-model catalogue and bounded preflight.
// This slice intentionally does not download, install, evict, or run a model.

const PUBLISHER_HOST = "huggingface.co";
const DELIVERY_HOST_SUFFIXES = [".huggingface.co", ".hf.co"];
export const PREFLIGHT_RANGE = "bytes=0-0";
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;
// The probe uses the browser's native redirect handling (`redirect: "follow"`)
// and validates the FINAL response.url against the trusted delivery allowlist
// BEFORE trusting any status/header/body. No manual hop chain is re-implemented
// (a manual chain would need to re-derive the browser's redirect policy).

function publisherFile(repo, revision, name, bytes, sha256, role) {
  return Object.freeze({
    role,
    name,
    bytes,
    sha256,
    url: `https://${PUBLISHER_HOST}/${repo}/resolve/${revision}/${
      encodeURIComponent(name)
    }?download=true`,
  });
}

export const LOCAL_MODEL_CATALOG = Object.freeze([
  Object.freeze({
    id: "gemma-4-e4b-it-qat-q4_0",
    name: "Gemma 4 E4B IT QAT q4_0",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-E4B-it-qat-q4_0-gguf",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    baseRepo: "google/gemma-4-E4B-it",
    baseRevision: "ee0ef6023621cff504d758262d4e04895a5af4a2",
    installedBytes: 6_146_493_536,
    installedGiB: "5.72 GiB",
    files: Object.freeze([
      publisherFile(
        "google/gemma-4-E4B-it-qat-q4_0-gguf",
        "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
        "gemma-4-E4B_q4_0-it.gguf",
        5_154_941_280,
        "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
        "model",
      ),
      publisherFile(
        "google/gemma-4-E4B-it-qat-q4_0-gguf",
        "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
        "gemma-4-E4B-it-mmproj.gguf",
        991_552_256,
        "7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578",
        "multimodal projector",
      ),
    ]),
  }),
  Object.freeze({
    id: "gemma-4-26b-a4b-it-qat-q4_0",
    name: "Gemma 4 26B-A4B IT QAT q4_0",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
    revision: "d1c082be9cf3c8a514acf63b8761f4b41935842e",
    baseRepo: "google/gemma-4-26B-A4B-it",
    baseRevision: "4d7ae4984b7db7de8f8457170b3f1a419ee76d52",
    installedBytes: 15_634_191_744,
    installedGiB: "14.56 GiB",
    files: Object.freeze([
      publisherFile(
        "google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
        "d1c082be9cf3c8a514acf63b8761f4b41935842e",
        "gemma-4-26B_q4_0-it.gguf",
        14_439_363_584,
        "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d",
        "model",
      ),
      publisherFile(
        "google/gemma-4-26B-A4B-it-qat-q4_0-gguf",
        "d1c082be9cf3c8a514acf63b8761f4b41935842e",
        "gemma-4-26B-it-mmproj.gguf",
        1_194_828_160,
        "a359953a076b877db30c31dbbb4c6d93b4a6e017ee5db5784247e4d4c0dd4f3b",
        "multimodal projector",
      ),
    ]),
  }),
]);

export function getCatalogModel(modelId, catalog = LOCAL_MODEL_CATALOG) {
  if (typeof modelId !== "string" || !modelId) return null;
  return catalog.find((m) => m.id === modelId) || null;
}

export function isPublisherSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === PUBLISHER_HOST &&
      /^\/google\/gemma-4-[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+$/.test(
        url.pathname,
      );
  } catch {
    return false;
  }
}

export function isTrustedDeliveryUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === PUBLISHER_HOST ||
      DELIVERY_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function parseContentRange(value) {
  const match = /^bytes 0-0\/(\d+)$/.exec(value ?? "");
  return match ? Number(match[1]) : null;
}

async function readOneByte(response) {
  if (!response.body?.getReader) {
    throw new Error("Range response was not a readable bounded stream.");
  }
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
      if (received > 1) {
        throw new Error("Range response exceeded the one-byte probe bound.");
      }
    }
    if (received !== 1) {
      throw new Error("Range response body was not exactly one byte.");
    }
  } finally {
    if (received > 1) await reader.cancel().catch(() => {});
  }
}

export async function probePublisherFile(file, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  if (!file || !isPublisherSourceUrl(file.url)) {
    return { ok: false, error: "Rejected non-publisher source URL." };
  }
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
    return { ok: false, error: "Rejected invalid pinned byte size." };
  }
  // ONE AbortController + ONE absolute deadline for the WHOLE hop chain: a slow
  // intermediate hop cannot reset the clock. The timer is never re-armed.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("publisher probe timed out"),
    timeoutMs,
  );
  try {
    // `redirect: "follow"` lets the BROWSER chase the publisher → delivery-CDN
    // redirects natively. We then validate the FINAL response.url is https and
    // on the trusted delivery allowlist BEFORE accepting the 206/content-range/
    // content-length/one-byte evidence. `credentials: "omit"` never exposes
    // ambient auth; a cross-origin hop without the CDN's CORP/CORS grant
    // surfaces as an opaque (status 0 / empty url) response and fails closed here.
    const response = await fetchImpl(file.url, {
      method: "GET",
      headers: { Range: PREFLIGHT_RANGE },
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!isTrustedDeliveryUrl(response.url)) {
      throw new Error("Final response URL left the publisher delivery allowlist.");
    }
    if (response.status !== 206) {
      throw new Error(`Expected HTTP 206; received ${response.status}.`);
    }
    const contentRange = response.headers.get("content-range");
    if (parseContentRange(contentRange) !== file.bytes) {
      throw new Error("Content-Range did not match the pinned byte size.");
    }
    if (response.headers.get("content-length") !== "1") {
      throw new Error("Range response Content-Length was not one byte.");
    }
    await readOneByte(response);
    return {
      ok: true,
      redirected: response.redirected === true,
      finalUrl: response.url,
      status: 206,
      contentRange,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightLocalModel(model, options = {}) {
  if (!LOCAL_MODEL_CATALOG.includes(model)) {
    return {
      ok: false,
      error: "Model is not in the product-owned catalog.",
      files: [],
    };
  }
  const files = [];
  for (const file of model.files) {
    const result = await probePublisherFile(file, options);
    files.push({ name: file.name, ...result });
    if (!result.ok) return { ok: false, error: result.error, files };
  }
  return { ok: true, files };
}

export function localModelFeasibility(environment = {}) {
  const warnings = [
    "Runtime feasibility has not been benchmarked; neither model is approved for inference.",
  ];
  const deviceMemory = Number(environment.deviceMemory);
  if (!Number.isFinite(deviceMemory)) {
    warnings.push(
      "Hardware memory could not be measured; installed size is not a runtime-memory estimate.",
    );
  } else if (deviceMemory < 8) {
    warnings.push(
      `This device reports ${deviceMemory} GiB memory; even the 5.72 GiB payload is unlikely to be practical.`,
    );
  }
  if (environment.memory64 !== true) {
    warnings.push(
      "WebAssembly Memory64 is unavailable or unverified; wasm32 cannot address either payload.",
    );
  }
  if (environment.opfs !== true) {
    warnings.push(
      "OPFS is unavailable; a full local install cannot be stored here.",
    );
  }
  if (
    Number.isFinite(environment.availableStorageBytes) &&
    environment.availableStorageBytes < LOCAL_MODEL_CATALOG[0].installedBytes
  ) {
    warnings.push(
      "Estimated available browser storage is below the smallest 5.72 GiB installed payload.",
    );
  }
  return Object.freeze({
    feasible: environment.opfs === true && environment.memory64 === true,
    warnings: Object.freeze(warnings),
    runtimeImplemented: false,
    opfsInstallImplemented: true,
    removalImplemented: true,
    userControlledRemoval: true,
    evictionAuthorized: false,
    automaticEviction: false,
    removalPolicy:
      "User-controlled model removal only; automatic eviction is disabled per settled policy.",
  });
}

/** The supported local model routes for onboarding and settings. */
export const SUPPORTED_LOCAL_MODEL_ROUTES = Object.freeze([
  Object.freeze({
    id: "local-opfs",
    name: "Gemma 4 (on-device Wasm)",
    kind: "embedded-wllama",
    description: "Run Google Gemma 4 QAT q4_0 entirely in-browser via WebAssembly and OPFS. Zero network requests during inference.",
    defaultEndpoint: null,
    needsEndpoint: false,
    needsDownload: true,
    defaultModel: "gemma-4-e4b-it-qat-q4_0",
  }),
  Object.freeze({
    id: "prompt-api",
    name: "Chrome Prompt API (Gemini nano)",
    kind: "built-in-browser",
    description: "Chrome's built-in on-device Gemini nano model. Zero network, zero download, availability depends on Chrome version and flags.",
    defaultEndpoint: null,
    needsEndpoint: false,
    needsDownload: false,
    defaultModel: "gemini-nano",
  }),
  Object.freeze({
    id: "ollama",
    name: "Ollama (local server)",
    kind: "localhost-openai-compatible",
    description: "Connect to a local Ollama instance running on your machine (e.g. llama3, mistral, gemma).",
    defaultEndpoint: "http://localhost:11434/v1",
    needsEndpoint: true,
    needsDownload: false,
    defaultModel: "llama3.2",
  }),
  Object.freeze({
    id: "lm-studio",
    name: "LM Studio (local server)",
    kind: "localhost-openai-compatible",
    description: "Connect to a local LM Studio server running on your machine with any loaded GGUF model.",
    defaultEndpoint: "http://localhost:1234/v1",
    needsEndpoint: true,
    needsDownload: false,
    defaultModel: "local-model",
  }),
]);

/** Validate and canonicalize a localhost endpoint for local models. */
export function validateLocalEndpoint(urlStr) {
  if (typeof urlStr !== "string" || !urlStr.trim()) {
    return { ok: false, error: "endpoint_required", message: "A local endpoint URL is required." };
  }
  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return { ok: false, error: "invalid_url", message: "Invalid endpoint URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "invalid_protocol", message: "Endpoint must use http: or https: protocol." };
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  if (!isLocal) {
    return { ok: false, error: "non_local_host", message: "Local model endpoints must point to localhost or 127.0.0.1." };
  }
  let cleanPath = parsed.pathname;
  if (!cleanPath.endsWith("/v1") && !cleanPath.includes("/v1/")) {
    cleanPath = cleanPath.replace(/\/+$/, "") + "/v1";
  }
  const baseURL = `${parsed.protocol}//${parsed.host}${cleanPath}`;
  return {
    ok: true,
    origin: parsed.origin,
    baseURL,
  };
}

/** Check configuration status for a local model route.
 * @param {string} routeId
 * @param {{ isOpfsInstalled?: boolean, isPromptApiReady?: boolean, providerConfig?: any }} [options]
 */
export function inspectLocalModelRoute(routeId, { isOpfsInstalled = false, isPromptApiReady = false, providerConfig = null } = {}) {
  const route = SUPPORTED_LOCAL_MODEL_ROUTES.find((r) => r.id === routeId);
  if (!route) return { id: routeId, available: false, status: "unknown", note: "Unknown route" };

  if (route.id === "local-opfs") {
    return {
      id: route.id,
      name: route.name,
      available: isOpfsInstalled === true,
      status: isOpfsInstalled ? "installed" : "download-required",
      note: isOpfsInstalled ? "Gemma 4 model downloaded and ready in OPFS." : "Requires downloading Gemma 4 to OPFS storage in Settings → Local models.",
    };
  }

  if (route.id === "prompt-api") {
    return {
      id: route.id,
      name: route.name,
      available: isPromptApiReady === true,
      status: isPromptApiReady ? "ready" : "unavailable",
      note: isPromptApiReady ? "Chrome Prompt API (Gemini nano) is available." : "Prompt API is not supported or enabled in this browser instance.",
    };
  }

  const isConfigured = providerConfig?.provider === route.id && Boolean(providerConfig?.baseURL);
  return {
    id: route.id,
    name: route.name,
    available: true,
    status: isConfigured ? "configured" : "not-configured",
    note: isConfigured ? `Connected to ${providerConfig.baseURL}` : `Ready to connect to local server (default ${route.defaultEndpoint}).`,
  };
}

// Product-owned, publisher-origin local-model catalogue and bounded preflight.
// This slice intentionally does not download, install, evict, or run a model.

const PUBLISHER_HOST = "huggingface.co";
const DELIVERY_HOST_SUFFIXES = [".huggingface.co", ".hf.co"];
export const PREFLIGHT_RANGE = "bytes=0-0";
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;
// Strict product-owned redirect ceiling: the publisher resolver (huggingface.co)
// redirects to its delivery CDN; the probe follows redirects MANUALLY, one hop
// at a time, and fails closed past this ceiling. Never `redirect: "follow"` —
// follow mode would silently chase an unbounded hostile chain.
export const MAX_REDIRECT_HOPS = 3;

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
    let currentUrl = file.url;
    let hops = 0;
    for (;;) {
      const response = await fetchImpl(currentUrl, {
        method: "GET",
        headers: { Range: PREFLIGHT_RANGE },
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        // A redirect hop: resolve the Location EXACTLY against the current URL
        // and assert https + the publisher delivery allowlist at EVERY hop,
        // under the strict product-owned ceiling. An intermediate hostile hop
        // (wrong scheme or host) fails closed here — never followed.
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          throw new Error(`Redirect ceiling exceeded (${MAX_REDIRECT_HOPS} hops).`);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect hop carried no Location header.");
        }
        let next;
        try {
          next = new URL(location, currentUrl);
        } catch {
          throw new Error("Redirect Location did not resolve to an absolute URL.");
        }
        if (next.protocol !== "https:") {
          throw new Error("Redirect hop left the https scheme.");
        }
        if (!isTrustedDeliveryUrl(next.href)) {
          throw new Error("Redirect hop left the publisher delivery allowlist.");
        }
        currentUrl = next.href;
        continue;
      }
      // The terminal response: 206 + the pinned Content-Range + one byte.
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
        redirected: hops > 0,
        hops,
        finalUrl: currentUrl,
        status: 206,
        contentRange,
      };
    }
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
    feasible: false,
    warnings: Object.freeze(warnings),
    runtimeImplemented: false,
    opfsInstallImplemented: false,
    removalImplemented: false,
    evictionAuthorized: false,
    automaticEviction: false,
    removalPolicy:
      "Model removal and eviction are not implemented or authorized in this slice.",
  });
}

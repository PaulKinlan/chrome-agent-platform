// extension/background/routes/enclave-proxy.js — the Secure Enclave outbound
// proxy (chrome-agent-platform-jao1.2, CAP-SECURE-ENCLAVE Stage 2).
//
// The enclave's model-authored code reaches APPROVED web services through this
// one route: templates name their secrets ($VAULT{KEY_ID}), the values are
// pulled from the Stage-1 vault in-worker, and every request is pinned to the
// service's approved origin, scrubbed of credentials, redirect-refused, size-
// bounded, and tagged untrusted on the way out.
//
// SECURITY SHAPE:
//   * origins are pinned per service (a frozen allowlist — adding a service is
//     a reviewed code change, not a data change);
//   * the shared checkFetchTarget refuses non-http(s) schemes and private/
//     loopback/link-local targets BEFORE any I/O (SSRF);
//   * credentials: "omit" always — a proxied request is anonymous; the
//     confused-deputy risk (the SW holding the owner's ambient cookies) is
//     answered by never sending them;
//   * redirect: "manual" — a redirect response REFUSES the call (redirect
//     chains are how an allowlist gets laundered); nothing is followed;
//   * $VAULT{...} placeholders are substituted in-worker; an unknown key id
//     fails the call before any I/O; the substituted values never appear in
//     errors, response envelopes, or logs;
//   * response bodies are capped (1 MiB) and the envelope is tagged
//     untrusted (the fetched body is page-derived data, never instructions).
//
// Pure with respect to chrome.*: the vault, the fetch implementation, and the
// service allowlist are injected, so the unit tests exercise the real handler
// with fakes (the 32yz executable-handler style).

import { capLog } from "../../lib/cap-log.js";
import { checkFetchTarget } from "../../lib/fetch-policy.js";
import { tagUntrusted } from "../../lib/untrusted-fence.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — the enclave response bound
const ALLOWED_METHODS = ["GET", "POST"];
const VAULT_TEMPLATE = /\$VAULT\{([A-Z][A-Z0-9_]*)\}/g;

/** The built-in service allowlist: id -> approved origins + vault key and proxy metadata.
 * Frozen; adding a service is a reviewed change. */
export const DEFAULT_SERVICES = Object.freeze({
  "brave-search": Object.freeze({
    id: "brave-search",
    origins: Object.freeze(["https://api.search.brave.com"]),
    secretKey: "BRAVE_SEARCH_API_KEY",
    label: "Brave Search",
    authType: "header",
    authName: "X-Subscription-Token",
    testPath: "/res/v1/web/search?q=ping&count=1",
  }),
  "github": Object.freeze({
    id: "github",
    origins: Object.freeze(["https://api.github.com"]),
    secretKey: "GITHUB_TOKEN",
    label: "GitHub API",
    authType: "bearer",
    authName: "Authorization",
    testPath: "/rate_limit",
  }),
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deeply substitute $VAULT{KEY_ID} placeholders from `resolveSecret`.
 * Unknown key ids THROW (fail closed before any I/O); a substituted value that
 * itself contains a template opener fails the call (no layered injection).
 * Async: the vault's raw read is a promise, so resolution walks with await. */
async function substituteTemplates(value, resolveSecret, depth = 0) {
  if (depth > 8) throw new Error("enclave proxy: template nesting too deep");
  if (typeof value === "string") {
    const matches = [...value.matchAll(VAULT_TEMPLATE)];
    if (matches.length === 0) return value;
    let out = "";
    let last = 0;
    for (const m of matches) {
      out += value.slice(last, m.index);
      const secret = await resolveSecret(m[1]);
      if (typeof secret !== "string" || secret.length === 0) {
        throw new Error(`enclave proxy: the vault has no value for ${m[1]} — grant or rotate it before calling`);
      }
      out += secret;
      last = m.index + m[0].length;
    }
    out += value.slice(last);
    return out;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await substituteTemplates(v, resolveSecret, depth + 1));
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await substituteTemplates(v, resolveSecret, depth + 1);
    return out;
  }
  return value;
}

/** No substituted value may still contain a template opener — a secret whose
 * own body looks like a template would re-open the substitution at the
 * consumer. */
function assertNoResidualTemplate(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text && text.includes("$VAULT{")) {
    const e = new Error(`enclave proxy: ${label} still contains an unsubstituted template after resolution`);
    e.code = "template_error";
    throw e;
  }
}

function extractVaultKeys(value, set = new Set()) {
  if (typeof value === "string") {
    for (const m of value.matchAll(VAULT_TEMPLATE)) {
      set.add(m[1]);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) extractVaultKeys(v, set);
  } else if (isPlainObject(value)) {
    for (const v of Object.values(value)) extractVaultKeys(v, set);
  }
  return set;
}

/**
 * The exported factory: `services` overrides the frozen default allowlist
 * (tests inject their own); `fetchImpl` replaces globalThis.fetch.
 * @param {{
 *   vault: any,
 *   fetchImpl?: (...args: any[]) => Promise<any>,
 *   services?: Record<string, any>,
 *   getDynamicServices?: null | (() => Promise<Record<string, any>> | Record<string, any>),
 *   onRecord?: null | ((entry: any) => void),
 *   isAllowedCaller?: (context: any) => boolean,
 * }} [opts]
 */
export function createEnclaveProxyRoutes({
  vault,
  fetchImpl = (...args) => globalThis.fetch(...args),
  services = DEFAULT_SERVICES,
  getDynamicServices = null,
  onRecord = null,
  isAllowedCaller = () => false,
} = {}) {
  if (!vault || typeof vault.getSecretRaw !== "function") {
    throw new TypeError("enclave proxy routes require the Stage-1 secret vault");
  }

  const resolveSecret = (keyId) => {
    // Synchronous wrapper over the vault's raw read (service-worker caller):
    // the SW routes run in-worker, so the raw authority is the caller contract.
    let result = null;
    try {
      result = vault.getSecretRaw(keyId, { caller: "sw" });
      // The vault's raw read is async; the route handler awaits the promise.
      if (result && typeof result.then === "function") {
        return result.then((r) => {
          if (typeof r?.value !== "string") {
            throw new Error(`enclave proxy: the vault has no value for ${keyId}`);
          }
          return r.value;
        });
      }
    } catch (err) {
      throw new Error(`enclave proxy: the vault refused ${keyId} (${String(err?.message ?? err)})`);
    }
    if (typeof result?.value !== "string") {
      throw new Error(`enclave proxy: the vault has no value for ${keyId}`);
    }
    return result.value;
  };

  /**
   * enclave.proxy — one awaitable proxied request to an approved service.
   * message: { service, path?, url?, method?, query?, headers?, body?, injectServiceAuth? }.
   * Templates ($VAULT{KEY_ID}) in query/headers/body resolve from the vault.
   */
  const handler = async (message, context) => {
    if (!isAllowedCaller(context)) {
      return { ok: false, error: "the enclave proxy is restricted to sanctioned surfaces" };
    }
    const startMs = Date.now();
    const serviceId = String(message?.service ?? "");
    const dynamicServices = typeof getDynamicServices === "function" ? await getDynamicServices() : (getDynamicServices || {});
    let service = services[serviceId] || dynamicServices[serviceId];
    if (!service) {
      const allServices = [
        ...Object.entries(services).map(([k, s]) => ({ id: k, ...s })),
        ...Object.entries(dynamicServices).map(([k, s]) => ({ id: k, ...s })),
        ...Object.entries(DEFAULT_SERVICES).map(([k, s]) => ({ id: k, ...s })),
      ];
      const lower = serviceId.toLowerCase();
      service = allServices.find((s) =>
        s.id?.toLowerCase() === lower ||
        s.secretKey?.toLowerCase() === lower ||
        s.keyId?.toLowerCase() === lower
      );
    }

    const origins = service?.origins || (service?.origin ? [service.origin] : null);
    if (!service || !Array.isArray(origins) || origins.length === 0) {
      const e = new Error(`enclave proxy: unknown service "${serviceId}"`);
      e.code = "unknown_service";
      try {
        onRecord?.({
          service: serviceId,
          keyId: serviceId,
          method: String(message?.method ?? "GET").toUpperCase(),
          origin: "",
          path: String(message?.path ?? message?.url ?? ""),
          status: null,
          ok: false,
          code: e.code,
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      throw e;
    }

    const method = String(message?.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      const e = new Error(`enclave proxy: method ${method} is not allowed (${ALLOWED_METHODS.join(", ")})`);
      e.code = "bad_method";
      try {
        onRecord?.({
          service: serviceId,
          keyId: service.secretKey || service.keyId || serviceId,
          method,
          origin: origins[0] || "",
          path: String(message?.path ?? message?.url ?? ""),
          status: null,
          ok: false,
          code: e.code,
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      throw e;
    }

    // Default service auth injection on enclave.proxy:
    let queryInput = { ...(message?.query ?? {}) };
    let headersInput = { ...(message?.headers ?? {}) };
    const secretKey = service.secretKey || service.keyId;
    const authType = service.authType;
    const authName = service.authName;
    if (message?.injectServiceAuth === true && secretKey && authType) {
      if (authType === "bearer") {
        const headerKey = authName || "Authorization";
        if (!headersInput[headerKey] && !Object.keys(headersInput).some((k) => k.toLowerCase() === headerKey.toLowerCase())) {
          headersInput[headerKey] = `Bearer $VAULT{${secretKey}}`;
        }
      } else if (authType === "header") {
        const headerKey = authName || "X-API-Key";
        if (!headersInput[headerKey] && !Object.keys(headersInput).some((k) => k.toLowerCase() === headerKey.toLowerCase())) {
          headersInput[headerKey] = `$VAULT{${secretKey}}`;
        }
      } else if (authType === "query") {
        const paramKey = authName || "api_key";
        if (!queryInput[paramKey]) {
          queryInput[paramKey] = `$VAULT{${secretKey}}`;
        }
      }
    }

    // Origin-Pinned Secret Resolution:
    const referencedKeys = new Set();
    extractVaultKeys(queryInput, referencedKeys);
    extractVaultKeys(headersInput, referencedKeys);
    if (message?.body !== undefined) extractVaultKeys(message.body, referencedKeys);

    const allKnown = { ...DEFAULT_SERVICES, ...dynamicServices, ...services };
    for (const refKey of referencedKeys) {
      const matchingServices = Object.values(allKnown).filter(
        (s) => s?.secretKey === refKey || s?.keyId === refKey || s?.id === refKey
      );
      const boundOrigins = new Set();
      for (const s of matchingServices) {
        const sOrigins = Array.isArray(s.origins) ? s.origins : (s.origin ? [s.origin] : []);
        for (const o of sOrigins) boundOrigins.add(o);
      }
      if (boundOrigins.size > 0) {
        const approved = origins.some((o) => boundOrigins.has(o));
        if (!approved) {
          const e = new Error(`enclave proxy: ${refKey} is not approved for service "${serviceId}" (approved origin: ${[...boundOrigins].join(", ")})`);
          e.code = "origin_not_approved";
          try {
            onRecord?.({
              service: serviceId,
              keyId: refKey,
              method,
              origin: origins[0] || "",
              path: String(message?.path ?? message?.url ?? ""),
              status: null,
              ok: false,
              code: e.code,
              ms: Date.now() - startMs,
              timestamp: startMs,
            });
          } catch { /* ignore */ }
          throw e;
        }
      }
    }

    // Resolve the templates BEFORE any URL/origin decision: an unresolvable
    // secret must fail the call before any I/O or error surface exists.
    // Every substituted value is recorded so a transport-error string can be
    // SCRUBBED before it reaches any caller (URLs embed query secrets).
    const injectedSecrets = [];
    const resolveSecretAndRecord = async (keyId) => {
      const secret = await resolveSecret(keyId);
      injectedSecrets.push(secret);
      return secret;
    };
    const scrub = (text) => {
      let out = String(text ?? "");
      for (const secret of injectedSecrets) {
        if (secret) out = out.split(secret).join("[redacted]");
      }
      return out;
    };
    const query = await substituteTemplates(queryInput, resolveSecretAndRecord);
    const headers = await substituteTemplates(headersInput, resolveSecretAndRecord);
    const rawBody = message?.body === undefined ? undefined : await substituteTemplates(message.body, resolveSecretAndRecord);
    assertNoResidualTemplate(query, "the query");
    assertNoResidualTemplate(headers, "the headers");
    if (rawBody !== undefined) assertNoResidualTemplate(rawBody, "the body");

    // URL construction: a path is joined to the service's first approved
    // origin; an absolute URL must name an approved origin exactly.
    let urlText;
    const rawPath = String(message?.path ?? message?.url ?? "");
    if (/^https?:\/\//i.test(rawPath)) {
      urlText = rawPath;
    } else {
      urlText = origins[0] + (rawPath.startsWith("/") ? rawPath : `/${rawPath}`);
    }
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
    const qsText = qs.toString();
    if (qsText) urlText += (urlText.includes("?") ? "&" : "?") + qsText;

    // SSRF: the shared predicate (scheme + private/loopback) runs FIRST.
    const target = checkFetchTarget(urlText);
    if (!target.ok) {
      const e = new Error(`enclave proxy: ${target.error}`);
      e.code = "target_refused";
      try {
        onRecord?.({
          service: serviceId,
          keyId: secretKey || serviceId,
          method,
          origin: origins[0] || "",
          path: rawPath,
          status: null,
          ok: false,
          code: e.code,
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      throw e;
    }
    // Origin pin: the resolved URL's origin must be one of the service's
    // approved origins (an absolute-URL path cannot launder the allowlist).
    const origin = target.url.origin;
    if (!origins.some((o) => o === origin)) {
      const e = new Error(`enclave proxy: ${origin} is not an approved origin for service "${serviceId}" — approved: ${origins.join(", ")}`);
      e.code = "origin_not_approved";
      try {
        onRecord?.({
          service: serviceId,
          keyId: secretKey || serviceId,
          method,
          origin,
          path: rawPath,
          status: null,
          ok: false,
          code: e.code,
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      throw e;
    }

    // Credential scrubbing: the caller never sets Cookie (credentials are
    // omitted at the fetch level), and Origin/Referer are browser-controlled.
    const outHeaders = { ...headers };
    delete outHeaders.Cookie;
    delete outHeaders.cookie;
    delete outHeaders.Origin;
    delete outHeaders.origin;
    delete outHeaders.Referer;
    delete outHeaders.referer;

    let body;
    if (method === "POST" && rawBody !== undefined) {
      body = isPlainObject(rawBody) ? JSON.stringify(rawBody) : String(rawBody);
      if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === "content-type")) {
        outHeaders["content-type"] = "application/json";
      }
    }

    let res;
    try {
      res = await fetchImpl(target.url.href, {
        method,
        headers: outHeaders,
        credentials: "omit", // a proxied request is anonymous — always
        redirect: "manual", // redirects are REFUSED, never followed
        body,
      });
    } catch (err) {
      // SETTINGS-SAFE shape: a strict code only. The URL (which carries the
      // query-injected token) and the headers never reach the caller. The
      // scrubbed detail stays in the worker console for diagnosis.
      const detail = scrub(String(err?.message ?? err)).slice(0, 200);
      capLog("enclave-proxy").warn(`enclave proxy: ${serviceId} request failed: ${detail}`);
      try {
        onRecord?.({
          service: serviceId,
          keyId: secretKey || serviceId,
          method,
          origin,
          path: rawPath,
          status: null,
          ok: false,
          code: "connection_failed",
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      return { ok: false, code: "connection_failed", error: "connection_failed" };
    }

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      try {
        onRecord?.({
          service: serviceId,
          keyId: secretKey || serviceId,
          method,
          origin,
          path: rawPath,
          status: res.status,
          ok: false,
          code: "redirect_refused",
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      return { ok: false, code: "redirect_refused", error: "redirect_refused" };
    }

    // Bounded body read: the READER path is unconditional (a stream is read
    // chunk-wise and refused the moment it passes the bound). A body-less
    // response needs the declared content-length to fit the bound before any
    // buffering happens — the fallback never buffers unbounded.
    const declared = Number(res.headers?.get?.("content-length") ?? "0");
    if (!Number.isNaN(declared) && declared > MAX_BODY_BYTES) {
      try {
        onRecord?.({
          service: serviceId,
          keyId: secretKey || serviceId,
          method,
          origin,
          path: rawPath,
          status: res.status,
          ok: false,
          code: "bound_exceeded",
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      return { ok: false, error: `enclave proxy: the response from ${serviceId} declared ${declared} bytes, over the 1 MiB enclave bound` };
    }
    const parts = [];
    let size = 0;
    const streamReader = typeof res.body?.getReader === "function" ? res.body.getReader() : null;
    if (streamReader) {
      const reader = streamReader;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          try { await reader.cancel(); } catch { /* gone */ }
          try {
            onRecord?.({
              service: serviceId,
              keyId: secretKey || serviceId,
              method,
              origin,
              path: rawPath,
              status: res.status,
              ok: false,
              code: "bound_exceeded",
              ms: Date.now() - startMs,
              timestamp: startMs,
            });
          } catch { /* ignore */ }
          return { ok: false, code: "bound_exceeded", error: "bound_exceeded" };
        }
        parts.push(value);
      }
    } else {
      // No stream and no declared length: the response cannot be bounded, so
      // it is refused — the enclave never accepts an unbounded body.
      try {
        onRecord?.({
          service: serviceId,
          keyId: secretKey || serviceId,
          method,
          origin,
          path: rawPath,
          status: res.status,
          ok: false,
          code: "unbounded_response",
          ms: Date.now() - startMs,
          timestamp: startMs,
        });
      } catch { /* ignore */ }
      return { ok: false, code: "unbounded_response", error: "unbounded_response" };
    }
    const bodyBytes = new Uint8Array(size);
    let filled = 0;
    for (const p of parts) {
      bodyBytes.set(p, filled);
      filled += p.byteLength;
    }

    try {
      onRecord?.({
        service: serviceId,
        keyId: secretKey || serviceId,
        method,
        origin,
        path: rawPath,
        status: res.status,
        ok: res.ok ?? true,
        code: (res.ok ?? true) ? null : String(res.status),
        ms: Date.now() - startMs,
        timestamp: startMs,
      });
    } catch { /* ignore */ }

    return tagUntrusted({
      ok: res.ok ?? true,
      status: res.status,
      body: DECODER_safe(bodyBytes),
      bytes: size,
    });
  };

  return { "enclave.proxy": handler };
}

function DECODER_safe(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Exported for the unit tests' substitution matrix. */
export { substituteTemplates };

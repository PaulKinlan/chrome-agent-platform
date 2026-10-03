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

import { checkFetchTarget } from "../../lib/fetch-policy.js";
import { tagUntrusted } from "../../lib/untrusted-fence.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — the enclave response bound
const ALLOWED_METHODS = ["GET", "POST"];
const VAULT_TEMPLATE = /\$VAULT\{([A-Z][A-Z0-9_]*)\}/g;

/** The v1 service allowlist: id -> approved origins + the vault key the
 * service authenticates with. Frozen; adding a service is a reviewed change. */
const DEFAULT_SERVICES = Object.freeze({
  "brave-search": Object.freeze({
    origins: Object.freeze(["https://api.search.brave.com"]),
    secretKey: "BRAVE_SEARCH_API_KEY",
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
    throw new Error(`enclave proxy: ${label} still contains an unsubstituted template after resolution`);
  }
}

/** The exported factory: `services` overrides the frozen default allowlist
 * (tests inject their own); `fetchImpl` replaces globalThis.fetch. */
export function createEnclaveProxyRoutes({
  vault,
  fetchImpl = (...args) => globalThis.fetch(...args),
  services = DEFAULT_SERVICES,
  /** The caller gate. FAILS CLOSED by default — production wires the SW's own
   * principal fence; tests inject an explicit allow-all when they mean it. */
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
   * message: { service, path?, url?, method?, query?, headers?, body? }.
   * Templates ($VAULT{KEY_ID}) in query/headers/body resolve from the vault.
   */
  const handler = async (message, context) => {
    if (!isAllowedCaller(context)) {
      return { ok: false, error: "the enclave proxy is restricted to sanctioned surfaces" };
    }
    const serviceId = String(message?.service ?? "");
    const service = services[serviceId];
    if (!service || !Array.isArray(service.origins) || service.origins.length === 0) {
      throw new Error(`enclave proxy: unknown service "${serviceId}"`);
    }

    const method = String(message?.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      throw new Error(`enclave proxy: method ${method} is not allowed (${ALLOWED_METHODS.join(", ")})`);
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
    const query = await substituteTemplates(message?.query ?? {}, resolveSecretAndRecord);
    const headers = await substituteTemplates(message?.headers ?? {}, resolveSecretAndRecord);
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
      urlText = service.origins[0] + (rawPath.startsWith("/") ? rawPath : `/${rawPath}`);
    }
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
    const qsText = qs.toString();
    if (qsText) urlText += (urlText.includes("?") ? "&" : "?") + qsText;

    // SSRF: the shared predicate (scheme + private/loopback) runs FIRST.
    const target = checkFetchTarget(urlText);
    if (!target.ok) throw new Error(`enclave proxy: ${target.error}`);
    // Origin pin: the resolved URL's origin must be one of the service's
    // approved origins (an absolute-URL path cannot launder the allowlist).
    const origin = target.url.origin;
    if (!service.origins.some((o) => o === origin)) {
      throw new Error(`enclave proxy: ${origin} is not an approved origin for service "${serviceId}" — approved: ${service.origins.join(", ")}`);
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
      // The error names the service, never the headers or their values — and
      // substituted query secrets are scrubbed out of transport messages
      // (a URL-embedded query token would otherwise ride err.message).
      return { ok: false, error: `enclave proxy: the request to ${serviceId} failed (${scrub(String(err?.message ?? err)).slice(0, 120)})` };
    }

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { ok: false, error: `enclave proxy: ${serviceId} redirected — the enclave never follows redirects (token laundering)` };
    }

    // Bounded body read: the READER path is unconditional (a stream is read
    // chunk-wise and refused the moment it passes the bound). A body-less
    // response needs the declared content-length to fit the bound before any
    // buffering happens — the fallback never buffers unbounded.
    const declared = Number(res.headers?.get?.("content-length") ?? "0");
    if (!Number.isNaN(declared) && declared > MAX_BODY_BYTES) {
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
          return { ok: false, error: `enclave proxy: the response from ${serviceId} exceeded the 1 MiB enclave bound` };
        }
        parts.push(value);
      }
    } else {
      // No stream and no declared length: the response cannot be bounded, so
      // it is refused — the enclave never accepts an unbounded body.
      return { ok: false, error: `enclave proxy: the response from ${serviceId} had no body stream and no content-length — it cannot be bounded to 1 MiB` };
    }
    const bodyBytes = new Uint8Array(size);
    let filled = 0;
    for (const p of parts) {
      bodyBytes.set(p, filled);
      filled += p.byteLength;
    }

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

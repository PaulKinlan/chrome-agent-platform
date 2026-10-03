// extension/lib/service-tools.js — the declarative service descriptor & tool
// synthesis engine (chrome-agent-platform-jao1.3, CAP-SECURE-ENCLAVE Stage 3).
//
// A SERVICE DESCRIPTOR declares, in JSON-shaped data: the service (id, name,
// origin, description), its AUTH (type 'header' | 'bearer' | 'query' with the
// vault secretId), and its TOOLS (name, description, semantic parameter
// schema, HTTP request template, response transform).
//
// synthesizeServiceTools turns descriptors into AI SDK tools. THE ISOLATION
// CONTRACT (the point of this module): the synthesized tool exposes ONLY the
// clean semantic parameters (query, count, country) to the model. The auth
// template and the secret id live on the DESCRIPTOR; the secret VALUE is read
// from the Stage-1 vault at execute time, in-worker, and is injected by the
// Stage-2 enclave proxy ($VAULT templates) or by the engine (the service auth
// header/param). The model never sees, names, or carries a credential.
//
// Pure with respect to chrome.*: the vault and the proxy call are injected.

import { tool } from "ai";
import { z } from "zod";

const ENCODER = new TextEncoder();

/** The built-in service descriptors. Frozen; adding a service is a reviewed
 * change. Each tool's request template maps SEMANTIC parameters ($input.x)
 * into the HTTP request; $VAULT{...} templates, if any, are the enclave
 * proxy's to resolve — this engine never substitutes them itself. */
export const SERVICE_DESCRIPTORS = Object.freeze({
  "brave-search": Object.freeze({
    id: "brave-search",
    name: "Brave Search",
    origin: "https://api.search.brave.com",
    description: "Search the web with the Brave Search API.",
    auth: Object.freeze({
      type: "header",
      header: "X-Subscription-Token",
      secretId: "BRAVE_SEARCH_API_KEY",
    }),
    tools: Object.freeze([
      Object.freeze({
        name: "brave_search",
        description:
          "Search the web. Returns the most relevant results with a title, the page URL and a short snippet. Use it for anything that needs current information.",
        parameters: Object.freeze({
          query: Object.freeze({ type: "string", required: true, description: "The search query." }),
          count: Object.freeze({ type: "number", required: false, description: "How many results to return (at most 10)." }),
          country: Object.freeze({ type: "string", required: false, description: "Two-letter country code to bias the results." }),
        }),
        request: Object.freeze({
          method: "GET",
          path: "/res/v1/web/search",
          query: Object.freeze({
            q: "$input.query",
            count: "$input.count",
            country: "$input.country",
          }),
        }),
        transform: "brave-web",
      }),
    ]),
  }),
});

/** The Brave web-search transform: raw API JSON -> concise result objects.
 * Defensive against missing shapes; bounded to the first ten results. */
export function braveWebTransform(json) {
  const results = json?.web?.results;
  if (!Array.isArray(results)) return { results: [] };
  return {
    results: results.slice(0, 10).map((r) => ({
      title: String(r?.title ?? ""),
      url: String(r?.url ?? ""),
      snippet: String(r?.description ?? ""),
    })).filter((r) => r.url),
  };
}

const TRANSFORMS = {
  "brave-web": braveWebTransform,
};

function zodFromParameters(parameters) {
  const shape = {};
  for (const [name, p] of Object.entries(parameters ?? {})) {
    let schema = p.type === "number" ? z.number() : z.string();
    if (p.description) schema = schema.describe(p.description);
    shape[name] = p.required ? schema : schema.optional();
  }
  // .strip(): parameters the model injects beyond the declared semantics
  // (an auth-shaped key, an executionId) are REMOVED before the request is
  // built — the model cannot add fields the descriptor does not declare.
  return z.object(shape).strip();
}

/** Resolve $input.X template values from the model's (validated) params.
 * $VAULT{...} templates are deliberately NOT resolved here — the enclave
 * proxy injects those from the vault in-worker. */
function resolveInputTemplate(value, params) {
  if (typeof value !== "string") return value;
  if (value.startsWith("$input.")) {
    const key = value.slice("$input.".length);
    return params?.[key];
  }
  return value;
}

function buildRequest(toolDef, service, params, authValue) {
  const query = {};
  const headers = {};
  for (const [k, v] of Object.entries(toolDef.request.query ?? {})) {
    const resolved = resolveInputTemplate(v, params);
    if (resolved !== undefined && resolved !== null && resolved !== "") query[k] = String(resolved);
  }
  for (const [k, v] of Object.entries(toolDef.request.headers ?? {})) {
    const resolved = resolveInputTemplate(v, params);
    if (resolved !== undefined && resolved !== null) headers[k] = String(resolved);
  }
  // The service AUTH is injected by the engine from the vault at execute time
  // — it never passes through the model's parameters.
  if (service.auth?.type === "header" && service.auth.header && typeof authValue === "string") {
    headers[service.auth.header] = authValue;
  } else if (service.auth?.type === "query" && service.auth.param && typeof authValue === "string") {
    query[service.auth.param] = authValue;
  } else if (service.auth?.type === "bearer" && typeof authValue === "string") {
    headers.Authorization = `Bearer ${authValue}`;
  }
  let path = toolDef.request.path ?? "/";
  const resolvedPathParams = resolveInputTemplate(path, params);
  if (typeof resolvedPathParams === "string" && resolvedPathParams.startsWith("/")) path = resolvedPathParams;
  return { method: String(toolDef.request.method ?? "GET").toUpperCase(), path, query, headers };
}

/**
 * Synthesize AI SDK tools from service descriptors.
 *
 * @param {object} opts
 * @param {object} opts.descriptors — the SERVICE_DESCRIPTORS-shaped map.
 * @param {(message: object, context?: object) => Promise<object>} opts.proxyCall —
 *   the enclave proxy handler (the Stage-2 route). Every request goes through
 *   it: origin pinning, SSRF checks, credential omission, redirect refusal,
 *   the body bound, and the untrusted tagging all apply.
 * @param {object} opts.vault — the Stage-1 vault (raw reads stay in-worker).
 * @param {(service: object) => boolean} [opts.secretGate] — skip services whose
 *   credential the gate refuses (the Settings wiring gates on the configured
 *   key ids); default allows every declared service.
 * @returns {Record<string, ReturnType<typeof tool>>} the synthesized tools.
 */
export function synthesizeServiceTools({ descriptors, proxyCall, vault, secretGate = null }) {
  if (typeof proxyCall !== "function") {
    throw new TypeError("service tools require the enclave proxy call");
  }
  const tools = {};
  for (const service of Object.values(descriptors ?? {})) {
    if (typeof secretGate === "function" && !secretGate(service)) continue;
    for (const toolDef of service.tools ?? []) {
      const inputSchema = zodFromParameters(toolDef.parameters);
      tools[toolDef.name] = tool({
        description: toolDef.description ?? `${toolDef.name} via ${service.name}`,
        inputSchema,
        execute: async (params) => {
          // The auth value is read from the vault IN-WORKER at execute time —
          // never carried by the model, the schema, or any serialization.
          let authValue;
          if (service.auth?.secretId && vault) {
            const got = await vault.getSecretRaw(service.auth.secretId, { caller: "sw" });
            authValue = got?.value;
          }
          const message = buildRequest(toolDef, service, params ?? {}, authValue);
          const res = await proxyCall({ service: service.id, ...message }, { principal: "model" });
          if (!res?.ok) {
            throw new Error(res?.error ?? `${toolDef.name} failed`);
          }
          let json;
          try {
            json = JSON.parse(res.body);
          } catch {
            throw new Error(`${toolDef.name}: the service returned a non-JSON body`);
          }
          const transform = typeof toolDef.transform === "function"
            ? toolDef.transform
            : TRANSFORMS[toolDef.transform];
          return transform ? transform(json) : json;
        },
      });
    }
  }
  return tools;
}

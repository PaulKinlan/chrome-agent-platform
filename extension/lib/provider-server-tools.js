// lib/provider-server-tools.js — provider-EXECUTED (server-side) tools.
//
// Server-side tools (the built-in-tools research report, §3 design contract)
// run INSIDE the provider's API call — the client never
// dispatches them. "Execution" is DECLARATION: execute_tool on a
// provider-server selection ref LATCHES the provider-defined tool onto the
// run; the next model call(s) carry it (agent.js injects it at the
// doStream/doGenerate boundary); results stream back as grounding metadata
// (citations + executed queries), never as client tool results.
//
// Slice 1 scope: Gemini google_search via the NATIVE @ai-sdk/google lane only
// (the OpenAI-compatible endpoint silently drops provider-defined tools).
// Slice 2 adds Anthropic web_search via the NATIVE @ai-sdk/anthropic lane
// (Anthropic's OpenAI-compatible shim likewise does not carry server tools).
//
// Where the grounding arrives differs by provider: Gemini attaches a
// groundingMetadata blob under providerMetadata.google; Anthropic streams
// provider-executed tool-call parts (one per executed search request — the
// billing signal), tool-result parts with the search results, and source
// parts (inline citations carry providerMetadata.anthropic.citedText).
// normalizeAnthropicWebSearchPart harvests those part shapes.
//
// Cost honesty: a latched search spends real money provider-side WITHOUT a
// Chrome permission, so availability is double-gated (global Settings toggle
// AND per-agent opt-in, both default OFF), each latch is counted against a
// per-run cap, and usage is recorded as a labelled ESTIMATE (CAP cannot see
// the provider's free-tier meter).

import { assertRunOwned } from "./run-fence.js";

const PROVIDER_SERVER_TOOL_KIND = "provider-server";

/** The provider-defined tool catalogue. Each spec maps 1:1 onto a provider
 * factory's server tool; `v2` is the exact LanguageModelV2 provider-tool entry
 * injected into the call options (`{ type:"provider", id, name, args }` — the
 * shape @ai-sdk/google's prepareTools switches on). */
export const PROVIDER_SERVER_TOOL_SPECS = Object.freeze([
  Object.freeze({
    toolId: "google_search",
    provider: "gemini",
    lane: "gemini-native",
    name: "provider-server/gemini/google_search",
    aliases: Object.freeze([
      "web search",
      "google search",
      "search the web",
      "grounding",
      "grounded search",
      "current events",
      "latest news",
      "look up online",
    ]),
    description:
      "Google Search grounding, executed by the provider inside the model call. " +
      "Activate it once per run; the model may then ground answers in fresh Google " +
      "results with inline source citations. Costs real money per executed search " +
      "query (5,000 free/mo shared on Gemini 3.x, then $14 per 1,000 searches — " +
      "estimate; CAP cannot see the project free-tier meter).",
    inputSchema: Object.freeze({ type: "object", additionalProperties: false }),
    cost: Object.freeze({
      unit: "per-search-query",
      rateUsd: 0.014,
      freeTierNote:
        "5,000 free searches/mo shared (Gemini 3.x), then $14 per 1,000 searches",
    }),
    citations: "inline-annotations",
    v2: Object.freeze({
      type: "provider",
      id: "google.google_search",
      name: "google_search",
      args: Object.freeze({}),
    }),
  }),
  Object.freeze({
    toolId: "web_search",
    provider: "anthropic",
    lane: "anthropic-native",
    name: "provider-server/anthropic/web_search",
    aliases: Object.freeze([
      "web search",
      "search the web",
      "look up online",
      "current events",
      "latest news",
    ]),
    description:
      "Anthropic web search, executed by the provider inside the model call. " +
      "Activate it once per run; the model may then search the web and answer " +
      "with inline source citations. Costs real money per executed search " +
      "request (estimate; CAP cannot see the provider's meter).",
    inputSchema: Object.freeze({ type: "object", additionalProperties: false }),
    cost: Object.freeze({
      unit: "per-search-request",
      rateUsd: 0.01,
      freeTierNote:
        "$10 per 1,000 searches per Anthropic's published pricing (no free tier is documented; pricing not re-verified against live documentation); the provider-side meter is invisible to CAP",
    }),
    citations: "source-parts",
    v2: Object.freeze({
      type: "provider",
      id: "anthropic.web_search_20250305",
      name: "web_search",
      args: Object.freeze({}),
    }),
  }),
]);

/** The per-run latch cap: at most this many latch OPERATIONS per run (the
 * model could otherwise re-activate in a loop; each activation is recorded). */
export const SERVER_TOOL_LATCH_CAP_PER_RUN = 10;

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Model support gate for google_search: Gemini 2.x and 3.x (per the vendor
 * docs). Pre-2.0 (gemini-1.x, gemini-pro, nano on-device) cannot ground. NOTE:
 * on Gemini 2.x the provider warns on MIXING server tools with function tools
 * (tool combination is a Gemini 3 feature) — the descriptor stays ready (the
 * tool itself works) and the description carries the caveat. */
export function geminiModelSupportsServerTools(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  return /^gemini-[23][-.]/u.test(id) || /^gemini-[23]$/u.test(id);
}

/** Model support gate for web_search: the documented supported set (Claude
 * 3.5 Sonnet (Oct 2024 refresh + -latest), 3.5 Haiku, 3.7 Sonnet, and all
 * Claude 4 families). Older IDs (claude-3-*, claude-3-5-sonnet-20240620)
 * cannot run server tools — fail closed and extend as Anthropic adds models.
 * ANCHORED with suffix forms constrained to documented alias/date/version
 * shapes: a near-miss like "claude-sonnet-4000" or "claude-3-7-sonnet-x"
 * must NOT admit. */
export function anthropicModelSupportsServerTools(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  return /^claude-(?:(?:opus|sonnet|haiku)-4(?:-(?:\d+(?:-\d{8})?|latest))?|3-7-sonnet(?:-(?:\d{8}|latest))?|3-5-haiku(?:-(?:\d{8}|latest))?|3-5-sonnet(?:-20241022|-latest))$/u.test(id);
}

/** Resolve the catalog availability of one provider-server spec for the
 * CURRENT run context. Honest reasons; fail closed. */
export function resolveServerToolAvailability({
  spec,
  lane,
  modelId,
  globalEnabled,
  agentOptIn,
}) {
  if (globalEnabled !== true) {
    return {
      availability: "disabled",
      reason:
        "provider server tools are off globally — turn them on under Settings → Providers",
    };
  }
  if (lane !== spec.lane) {
    return {
      availability: "owner-action-required",
      reason: `switch this agent to the ${spec.provider} native provider to enable ${spec.toolId}`,
    };
  }
  if (spec.provider === "gemini" && !geminiModelSupportsServerTools(modelId)) {
    return {
      availability: "owner-action-required",
      reason: `model ${String(modelId ?? "unknown")} does not support Google Search grounding (needs Gemini 2.0+)`,
    };
  }
  if (spec.provider === "anthropic" && !anthropicModelSupportsServerTools(modelId)) {
    return {
      availability: "owner-action-required",
      reason: `model ${String(modelId ?? "unknown")} does not support Anthropic web search (needs Claude 3.5 Sonnet (Oct 2024), 3.7 Sonnet, or a Claude 4 model)`,
    };
  }
  if (agentOptIn !== true) {
    return {
      availability: "owner-action-required",
      reason:
        "provider server tools are not enabled for this agent — the owner opts in per agent on the Providers page",
    };
  }
  return { availability: "ready", reason: "" };
}

/** Per-orchestrator-build latch registry. Latches are keyed by runId; a
 * latched tool stays active for the REST of the run (the model may ground
 * across several steps). Registry is build-local: an orchestrator rebuild
 * starts clean, and a run that outlives its build cannot inject stale tools
 * into a NEW build's model (the proxy reads the registry captured by ITS
 * build). */
export function createServerToolLatchRegistry({
  capPerRun = SERVER_TOOL_LATCH_CAP_PER_RUN,
} = {}) {
  const runs = new Map(); // runId -> { tools: Map<toolId, spec>, ops: number }
  const entryFor = (runId, create) => {
    let entry = runs.get(runId);
    if (!entry && create) {
      entry = { tools: new Map(), ops: 0 };
      runs.set(runId, entry);
      // Bound the map: a long-lived orchestrator accumulates one small entry
      // per run. 256 runs is far past any real session; drop the oldest.
      if (runs.size > 256) runs.delete(runs.keys().next().value);
    }
    return entry;
  };
  return Object.freeze({
    /** EVERY latch call counts one op against the per-run cap (a model
     * re-activating in a loop burns its budget; re-activation of an active
     * tool reports alreadyActive but still counts). */
    latch(runId, toolId) {
      const spec = PROVIDER_SERVER_TOOL_SPECS.find((s) => s.toolId === toolId);
      if (!spec) return { ok: false, reason: `unknown server tool ${toolId}` };
      const entry = entryFor(String(runId ?? ""), true);
      if (entry.ops >= capPerRun) {
        return {
          ok: false,
          reason: `server-tool latch cap reached for this run (${capPerRun})`,
        };
      }
      entry.ops += 1;
      const alreadyActive = entry.tools.has(toolId);
      entry.tools.set(toolId, spec);
      return { ok: true, alreadyActive };
    },
    /** The V2 provider-tool entries to inject into the next model call. */
    latchedToolsFor(runId) {
      const entry = entryFor(String(runId ?? ""), false);
      if (!entry) return [];
      return [...entry.tools.values()].map((spec) => ({ ...spec.v2 }));
    },
    latchCount(runId) {
      return entryFor(String(runId ?? ""), false)?.ops ?? 0;
    },
    clear(runId) {
      runs.delete(String(runId ?? ""));
    },
  });
}

/** Inject latched provider tools into a LanguageModelV2 call options object.
 * PURE (returns the input unchanged when there is nothing to add, authorization
 * was revoked, or the input is invalid; a new object otherwise). Dedupes by
 * provider-tool id so a double-wrap can never declare the same server tool
 * twice. The authorization argument is deliberately fail-closed because this
 * is the last boundary before a paid provider call. */
export function injectLatchedServerTools(options, latched, authorized = false) {
  const tools = Array.isArray(latched) ? latched : [];
  if (authorized !== true || tools.length === 0) return options;
  if (!options || typeof options !== "object") return options;
  const existing = Array.isArray(ownData(options, "tools"))
    ? ownData(options, "tools")
    : [];
  const existingIds = new Set(
    existing
      .filter((t) => ownData(t, "type") === "provider")
      .map((t) => String(ownData(t, "id") ?? "")),
  );
  const additions = tools.filter(
    (t) => ownData(t, "type") === "provider" && !existingIds.has(String(ownData(t, "id") ?? "")),
  );
  if (additions.length === 0) return options;
  return { ...options, tools: [...existing, ...additions] };
}

/** Normalize a Gemini groundingMetadata object (the documented + SDK-verified
 * shape: webSearchQueries / groundingChunks[].web{uri,title} /
 * groundingSupports[].segment{startIndex,endIndex,text}+groundingChunkIndices /
 * searchEntryPoint.renderedContent) into the internal ServerCitation shape.
 * Pure; never throws on hostile input (returns empty projections). */
export function normalizeGeminiGrounding(groundingMetadata) {
  const meta = groundingMetadata && typeof groundingMetadata === "object"
    ? groundingMetadata
    : {};
  const validQueries = (Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : [])
    .filter((q) => typeof q === "string" && q.trim().length > 0);
  // Billing counts every valid provider-reported occurrence; only retained text
  // is capped. Truncating before exposing this scalar silently undercharged a
  // single grounding result with more than 32 queries.
  const rawQueryCount = validQueries.length;
  const queries = validQueries.slice(0, 32).map((q) => q.slice(0, 512));
  const chunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
  const supports = Array.isArray(meta.groundingSupports) ? meta.groundingSupports : [];
  const citations = [];
  for (const support of supports.slice(0, 128)) {
    const segment = ownData(support, "segment") ?? {};
    const indices = Array.isArray(ownData(support, "groundingChunkIndices"))
      ? ownData(support, "groundingChunkIndices")
      : [];
    for (const index of indices.slice(0, 16)) {
      const chunk = chunks[index];
      const web = ownData(chunk, "web");
      const url = typeof ownData(web, "uri") === "string" ? web.uri : null;
      if (!url || !/^https:\/\//u.test(url)) continue;
      citations.push(Object.freeze({
        url: url.slice(0, 1024),
        title: String(ownData(web, "title") ?? "").slice(0, 256),
        startIndex: Number.isInteger(segment.startIndex) ? segment.startIndex : undefined,
        endIndex: Number.isInteger(segment.endIndex) ? segment.endIndex : undefined,
        citedText: typeof segment.text === "string" ? segment.text.slice(0, 512) : undefined,
        provider: "google",
      }));
    }
  }
  // Chunks with no support ranges still carry source URLs — surface them as
  // unindexed citations so sources are never silently dropped.
  if (citations.length === 0) {
    for (const chunk of chunks.slice(0, 32)) {
      const web = ownData(chunk, "web");
      const url = typeof ownData(web, "uri") === "string" ? web.uri : null;
      if (!url || !/^https:\/\//u.test(url)) continue;
      citations.push(Object.freeze({
        url: url.slice(0, 1024),
        title: String(ownData(web, "title") ?? "").slice(0, 256),
        provider: "google",
      }));
    }
  }
  const searchEntryPointHtml =
    typeof ownData(ownData(meta, "searchEntryPoint"), "renderedContent") === "string"
      ? meta.searchEntryPoint.renderedContent.slice(0, 8192)
      : null;
  return Object.freeze({
    provider: "gemini",
    citations: Object.freeze(citations),
    rawQueryCount,
    queries: Object.freeze(queries),
    searchEntryPointHtml,
  });
}

/** The per-provider billing descriptor used by the settle path: provider id,
 * tool id, per-unit rate, and the honest ESTIMATE note (CAP cannot see any
 * provider-side meter). provenance names the count's authority: Anthropic's
 * response usage object carries server_tool_use.web_search_requests (the
 * provider's OWN billable-request count — authoritative); when it is absent
 * the count is CAP's stream-observed tool-call occurrences (fallback). */
export function serverToolBillingFor(spec, queryCount, { provenance = null } = {}) {
  const count = Math.max(0, Math.trunc(Number(queryCount) || 0));
  const estUsd = count * (Number(spec?.cost?.rateUsd) || 0);
  const label = spec?.provider === "anthropic" ? "Anthropic" : "Gemini";
  const basis = spec?.provider === "anthropic"
    ? "Anthropic's published $10 per 1,000 searches (pricing not re-verified against live documentation); no free tier is documented"
    : "the 5,000/mo free tier is metered provider-side and invisible to CAP";
  // Provenance wording is ANTHROPIC-ONLY: the Gemini ledger line stays
  // byte-identical to slice 1 (no regression).
  const suffix = spec?.provider === "anthropic" && provenance
    ? `, ${provenance}`
    : "";
  return {
    provider: String(spec?.provider ?? ""),
    tool: String(spec?.toolId ?? ""),
    queries: count,
    estimatedUsd: estUsd,
    provenance: spec?.provider === "anthropic" ? provenance : null,
    note: `Web search: ${count} call${count === 1 ? "" : "s"} (${label}${suffix}) — est. $${estUsd.toFixed(4)} (ESTIMATE — ${basis})`,
  };
}

/** Look up the catalogue spec for a provider id (fail closed: null). */
export function serverToolSpecForProvider(provider) {
  return PROVIDER_SERVER_TOOL_SPECS.find((s) => s.provider === provider) ?? null;
}

/** Normalize ONE LanguageModelV2 part (stream part or doGenerate content part)
 * from the NATIVE Anthropic lane into the internal fragment shape. The
 * SDK-verified shapes (@ai-sdk/anthropic 4.0.45):
 *   - tool-call with providerExecuted + toolName "web_search" — one per
 *     EXECUTED search request; input is a JSON string "{\"query\": ...}".
 *     This is the FALLBACK billing signal: Anthropic's response usage object
 *     carries the authoritative billable-request count (server_tool_use.
 *     web_search_requests, preserved through the SDK's looseObject usage
 *     schema); per-call reconciliation (createAnthropicCallReconciler)
 *     prefers the provider counter and uses these occurrences only when a
 *     call reports none.
 *   - source with sourceType "url" — a cited source. Inline citations carry
 *     providerMetadata.anthropic.citedText; plain search-result sources do
 *     not. Dedup by URL happens in the accumulator.
 *   - tool-result for "web_search" — result entries {type:"web_search_result",
 *     url, title} are surfaced as unindexed citations (sources never dropped).
 * Pure; never throws on hostile input (returns null when the part is not an
 * Anthropic web-search observation). */
export function normalizeAnthropicWebSearchPart(part) {
  if (!part || typeof part !== "object") return null;
  const type = ownData(part, "type");
  if (type === "tool-call" && ownData(part, "providerExecuted") === true &&
      ownData(part, "toolName") === "web_search") {
    let query = null;
    const input = ownData(part, "input");
    if (typeof input === "string" && input.length > 0 && input.length <= 4096) {
      try {
        const parsed = JSON.parse(input);
        if (typeof parsed?.query === "string" && parsed.query.trim().length > 0) {
          query = parsed.query.slice(0, 512);
        }
      } catch { /* malformed provider input — no query, still one request */ }
    }
    // One tool-call part == one executed (billable) search request, even when
    // the query text is unavailable.
    return Object.freeze({
      provider: "anthropic",
      citations: Object.freeze([]),
      rawQueryCount: 1,
      queries: Object.freeze(query ? [query] : []),
      searchEntryPointHtml: null,
    });
  }
  if (type === "source" && ownData(part, "sourceType") === "url") {
    const url = typeof ownData(part, "url") === "string" ? part.url : null;
    if (!url || !/^https:\/\//u.test(url)) return null;
    const citedText = ownData(ownData(ownData(part, "providerMetadata"), "anthropic"), "citedText");
    return Object.freeze({
      provider: "anthropic",
      citations: Object.freeze([Object.freeze({
        url: url.slice(0, 1024),
        title: String(ownData(part, "title") ?? "").slice(0, 256),
        citedText: typeof citedText === "string" ? citedText.slice(0, 512) : undefined,
        provider: "anthropic",
      })]),
      rawQueryCount: 0,
      queries: Object.freeze([]),
      searchEntryPointHtml: null,
    });
  }
  if (type === "tool-result" && ownData(part, "toolName") === "web_search") {
    const results = Array.isArray(ownData(part, "result")) ? part.result : [];
    const citations = [];
    for (const r of results.slice(0, 32)) {
      if (ownData(r, "type") !== "web_search_result") continue;
      const url = typeof ownData(r, "url") === "string" ? r.url : null;
      if (!url || !/^https:\/\//u.test(url)) continue;
      citations.push(Object.freeze({
        url: url.slice(0, 1024),
        title: String(ownData(r, "title") ?? "").slice(0, 256),
        provider: "anthropic",
      }));
    }
    if (citations.length === 0) return null;
    return Object.freeze({
      provider: "anthropic",
      citations: Object.freeze(citations),
      rawQueryCount: 0,
      queries: Object.freeze([]),
      searchEntryPointHtml: null,
    });
  }
  return null;
}

/** Read the AUTHORITATIVE billable-search count from Anthropic's own usage
 * object: providerMetadata.anthropic.usage.server_tool_use.web_search_requests
 * (the SDK parses usage with z.looseObject, so the raw field survives into
 * both the stream finish part and the doGenerate result — verified against
 * @ai-sdk/anthropic 4.0.45). Returns a fragment carrying ONLY the
 * authoritative count, or null when absent/hostile. The count is PER API
 * CALL; the accumulator sums across a run's calls. */
export function anthropicAuthoritativeSearchRequests(providerMetadata) {
  const usage = ownData(ownData(providerMetadata, "anthropic"), "usage");
  const serverToolUse = ownData(usage, "server_tool_use");
  const requests = ownData(serverToolUse, "web_search_requests");
  if (!Number.isSafeInteger(requests) || requests < 0) return null;
  return Object.freeze({
    provider: "anthropic",
    citations: Object.freeze([]),
    rawQueryCount: 0,
    queries: Object.freeze([]),
    searchEntryPointHtml: null,
    authoritativeSearchRequests: requests,
  });
}

/** Per-MODEL-CALL billing reconciliation for Anthropic web search. Anthropic
 * bills per search REQUEST and reports the authoritative count in each
 * response's usage object — but only per call. A run makes several calls and
 * some may carry no counter (e.g. an older beta), so the reconciliation must
 * be PER CALL: each call bills (authoritative ?? observed-occurrences), and
 * the run total is the SUM of the per-call bills. A run-global flip would
 * underbill mixed runs (a counter-less call's observed searches would be
 * swallowed by an earlier call's counter). */
export function createAnthropicCallReconciler() {
  let observedCount = 0;
  let authoritative = null;
  const queries = [];
  const citations = [];
  return Object.freeze({
    /** Feed a normalizeAnthropicWebSearchPart fragment (tool-call/source/
     * tool-result observations). Null is a no-op. */
    addPart(fragment) {
      if (!fragment || fragment.provider !== "anthropic") return;
      observedCount += fragment.rawQueryCount;
      for (const q of fragment.queries ?? []) queries.push(q);
      for (const c of fragment.citations ?? []) citations.push(c);
    },
    /** Feed an anthropicAuthoritativeSearchRequests fragment (the finish
     * part's / result's usage counter). Last writer wins within a call (the
     * finish part arrives once). */
    setAuthoritative(fragment) {
      if (Number.isSafeInteger(fragment?.authoritativeSearchRequests) &&
          fragment.authoritativeSearchRequests >= 0) {
        authoritative = fragment.authoritativeSearchRequests;
      }
    },
    /** The reconciled per-call fragment: billed = authoritative ?? observed.
     * `reconciled: true` tells the run accumulator the count is FINAL (it may
     * legitimately be lower than queries.length — e.g. provider says zero). */
    flush() {
      const billed = authoritative ?? observedCount;
      return Object.freeze({
        provider: "anthropic",
        citations: Object.freeze(citations),
        rawQueryCount: billed,
        queries: Object.freeze(queries),
        searchEntryPointHtml: null,
        reconciled: true,
        authoritativeCount: authoritative,
        observedCount,
      });
    },
    get seen() {
      return observedCount > 0 || authoritative != null || queries.length > 0 || citations.length > 0;
    },
  });
}

/** Build one bounded per-run grounding accumulator. Query OCCURRENCES remain
 * distinct for cost accounting; presentation queries and citations are deduped.
 * The provider can execute the same query on later model calls and bill each
 * occurrence, so a Set is never the billing authority. When the provider's own
 * billable-request counter is present (Anthropic's usage object), the
 * AUTHORITATIVE sum is billed and stream-observed occurrences are fallback
 * only — never both (no double-counting). */
export function createServerGroundingAccumulator({ maxQueryOccurrences = 128, maxCitations = 128 } = {}) {
  const queryOccurrences = [];
  let queryOccurrenceCount = 0;
  let authoritativeBilled = 0;
  let observedBilled = 0;
  const displayQueries = new Set();
  const citations = new Map();
  const providers = new Set();
  return Object.freeze({
    add(normalized) {
      if (typeof normalized?.provider === "string" && normalized.provider) {
        providers.add(normalized.provider);
      }
      const retainedQueries = Array.isArray(normalized?.queries) ? normalized.queries : [];
      // A reconciled fragment's count is FINAL (per-call authoritative ??
      // observed — it may legitimately be lower than the retained queries).
      // Otherwise keep the raw-vs-retained max rule (billing counts every
      // provider-reported occurrence even when text retention is capped).
      const rawCount = Number.isSafeInteger(normalized?.rawQueryCount) && normalized.rawQueryCount >= 0
        ? normalized.rawQueryCount
        : retainedQueries.length;
      const reportedCount = normalized?.reconciled === true
        ? rawCount
        : Math.max(rawCount, retainedQueries.length);
      queryOccurrenceCount = Math.min(Number.MAX_SAFE_INTEGER, queryOccurrenceCount + reportedCount);
      if (normalized?.reconciled === true) {
        if (Number.isSafeInteger(normalized.authoritativeCount)) {
          authoritativeBilled = Math.min(Number.MAX_SAFE_INTEGER, authoritativeBilled + reportedCount);
        } else {
          observedBilled = Math.min(Number.MAX_SAFE_INTEGER, observedBilled + reportedCount);
        }
      }
      for (const query of retainedQueries) {
        if (queryOccurrences.length < maxQueryOccurrences) queryOccurrences.push(query);
        if (displayQueries.size < maxQueryOccurrences) displayQueries.add(query);
      }
      for (const citation of normalized?.citations ?? []) {
        if (citations.size < maxCitations && !citations.has(citation.url)) citations.set(citation.url, citation);
      }
    },
    snapshot() {
      return Object.freeze({
        provider: providers.size === 1 ? [...providers][0] : null,
        providers: Object.freeze([...providers]),
        queryOccurrenceCount,
        // Provenance split of the billed total: reconciled per-call fragments
        // report whether each call's bill came from the provider's own usage
        // counter or from stream-observed occurrences. Both zero for
        // non-reconciled (Gemini) feeds.
        authoritativeBilled,
        observedBilled,
        queries: Object.freeze([...queryOccurrences]),
        displayQueries: Object.freeze([...displayQueries]),
        citations: Object.freeze([...citations.values()]),
      });
    },
  });
}

/** Extract + normalize grounding metadata from ONE LanguageModelV2 stream
 * finish part (providerMetadata.google.groundingMetadata) or a doGenerate
 * result. Returns null when no grounding is present. */
export function groundingFromProviderMetadata(providerMetadata) {
  const google = ownData(providerMetadata, "google");
  const grounding = ownData(google, "groundingMetadata");
  if (!grounding || typeof grounding !== "object") return null;
  const normalized = normalizeGeminiGrounding(grounding);
  if (
    normalized.citations.length === 0 &&
    normalized.queries.length === 0 &&
    !normalized.searchEntryPointHtml
  ) {
    return null;
  }
  return normalized;
}

/** Records for the lazy protocol: descriptor + authorize + dispatch-as-latch.
 * ASYNC because the descriptor's availability is resolved LIVE at snapshot
 * build time (a toggle flip changes the NEXT search/list result without an
 * orchestrator rebuild). authorize + dispatch RE-READ the switches at execute
 * time (fail closed if a toggle flipped between search and execute).
 *
 * context: {
 *   lane, modelId,                               // build-fixed model identity
 *   readSwitches: async () => ({ globalEnabled, agentOptIn }),  // live kv read
 *   latchRegistry,                               // createServerToolLatchRegistry()
 *   sourceGeneration,
 *   scope,                                       // { hub, agentId, origin, documentId }
 * } */
export async function liveProviderServerToolRecords(context) {
  const lane = ownData(context, "lane") ?? "openai-compatible";
  const modelId = String(ownData(context, "modelId") ?? "");
  const readSwitches = ownData(context, "readSwitches");
  const latchRegistry = ownData(context, "latchRegistry");
  const sourceGeneration = String(ownData(context, "sourceGeneration") ?? "provider-server:v1");
  const scope = ownData(context, "scope") ?? { hub: true, agentId: "hub", origin: "", documentId: "" };

  const readSwitchesSafe = async () => {
    if (typeof readSwitches !== "function") {
      return { globalEnabled: false, agentOptIn: false };
    }
    const switches = await readSwitches().catch(() => null);
    return {
      globalEnabled: switches?.globalEnabled === true,
      agentOptIn: switches?.agentOptIn === true,
    };
  };
  const availabilityFor = async (spec) =>
    resolveServerToolAvailability({ spec, lane, modelId, ...(await readSwitchesSafe()) });
  // ONE read for the snapshot; authorize/dispatch re-read live per execute.
  const snapshotSwitches = await readSwitchesSafe();

  return PROVIDER_SERVER_TOOL_SPECS.map((spec) => {
    const snapshotAvailability = resolveServerToolAvailability({
      spec,
      lane,
      modelId,
      ...snapshotSwitches,
    });
    const descriptorInput = {
      sourceKind: PROVIDER_SERVER_TOOL_KIND,
      packageId: `provider-server:${spec.provider}`,
      toolId: spec.name,
      version: "provider-v1",
      name: spec.name,
      aliases: [...spec.aliases],
      description: snapshotAvailability.availability === "ready"
        ? spec.description
        : `${spec.description} [${snapshotAvailability.reason}]`,
      inputSchema: spec.inputSchema,
      capabilities: ["provider.server-tool"],
      scope,
      sourceGeneration,
      closureGeneration: sourceGeneration,
      packageDigest: `provider-server:${spec.provider}:${spec.toolId}`,
      permissionDigest: "none",
      grantDigest: "none",
      availability: snapshotAvailability.availability,
      dispatcherKind: "provider-server",
    };
    return Object.freeze({
      descriptorInput,
      validateArguments: async (args) => {
        // google_search takes NO client arguments — the query is generated
        // server-side. Any supplied argument is a mistake; fail closed with a
        // named reason rather than silently ignoring it.
        const keys = args && typeof args === "object" ? Object.keys(args) : [];
        if (keys.length > 0) {
          return {
            ok: false,
            reason: "parse-rejected",
            detail: `${spec.name} takes no arguments — it activates provider-side search for the rest of the run`,
          };
        }
        return { ok: true, data: {} };
      },
      authorize: async () => {
        // The same run-ownership fence every other record's authorize enforces.
        try {
          await assertRunOwned();
        } catch {
          return { ok: false };
        }
        const resolved = await availabilityFor(spec);
        if (resolved.availability !== "ready") {
          return { ok: false, reason: resolved.reason };
        }
        return { ok: true, permissionDigest: "none", grantDigest: "none" };
      },
      dispatch: async (_args, dispatchContext) => {
        const runId = String(ownData(dispatchContext, "runId") ?? "");
        if (!runId || !latchRegistry) {
          return { ok: false, error: "no active run to bind the server tool to" };
        }
        // Authorization can change after the protocol's before-dispatch fence;
        // do one final live read immediately before mutating the latch registry.
        const resolved = await availabilityFor(spec);
        if (resolved.availability !== "ready") {
          return { ok: false, error: resolved.reason };
        }
        const latched = latchRegistry.latch(runId, spec.toolId);
        if (!latched.ok) return { ok: false, error: latched.reason };
        return {
          ok: true,
          activated: spec.toolId,
          alreadyActive: latched.alreadyActive === true,
          note: latched.alreadyActive
            ? `${spec.toolId} is already active for this run`
            : `${spec.toolId} is now active — subsequent model steps in this run may ground answers with it. ${spec.cost.freeTierNote} (estimate).`,
          cost: spec.cost,
        };
      },
    });
  });
}

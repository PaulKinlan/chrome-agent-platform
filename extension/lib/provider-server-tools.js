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
        "provider server tools are off globally — enable them in Settings → Providers",
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
  if (agentOptIn !== true) {
    return {
      availability: "owner-action-required",
      reason:
        "provider server tools are not enabled for this agent — opt in under Settings → Providers",
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
  const queries = (Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : [])
    .filter((q) => typeof q === "string" && q.trim().length > 0)
    .slice(0, 32)
    .map((q) => q.slice(0, 512));
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
    citations: Object.freeze(citations),
    queries: Object.freeze(queries),
    searchEntryPointHtml,
  });
}

/** Build one bounded per-run grounding accumulator. Query OCCURRENCES remain
 * distinct for cost accounting; presentation queries and citations are deduped.
 * The provider can execute the same query on later model calls and bill each
 * occurrence, so a Set is never the billing authority. */
export function createServerGroundingAccumulator({ maxQueryOccurrences = 128, maxCitations = 128 } = {}) {
  const queryOccurrences = [];
  let queryOccurrenceCount = 0;
  const displayQueries = new Set();
  const citations = new Map();
  return Object.freeze({
    add(normalized) {
      for (const query of normalized?.queries ?? []) {
        queryOccurrenceCount = Math.min(Number.MAX_SAFE_INTEGER, queryOccurrenceCount + 1);
        if (queryOccurrences.length < maxQueryOccurrences) queryOccurrences.push(query);
        if (displayQueries.size < maxQueryOccurrences) displayQueries.add(query);
      }
      for (const citation of normalized?.citations ?? []) {
        if (citations.size < maxCitations && !citations.has(citation.url)) citations.set(citation.url, citation);
      }
    },
    snapshot() {
      return Object.freeze({
        queryOccurrenceCount,
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

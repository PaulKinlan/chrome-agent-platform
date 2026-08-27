// lib/tool-catalog-shadow.js — diagnostics-only composition for the catalog.
//
// The controller rebuilds from live source adapters on every inspection. It
// exposes bounded metadata/search/selection diagnostics only: no execute path,
// no source dispatcher, no permission request and no grant mutation.

import { buildToolCatalog } from "./tool-catalog.js";
import { buildToolSearchIndex, searchToolIndex } from "./tool-search.js";
import { ToolSelectionAuthority } from "./tool-selection.js";
import { buildLazyProviderCapture } from "./lazy-tool-wire.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "./bundled-tool-packages.data.js";

// Bounded read-only per-tool summary limits (the tool-library `<details>`
// slice). Metadata only — never execution/grant/verify authority.
const TOOL_LIBRARY_SUMMARY_LIMITS = Object.freeze({
  // 256 covers the full browser-tool registry (126 chrome-api tools + headroom)
  // so the Settings tool library's per-source count MATCHES the rendered rows
  // (CAP-FB-20260826-TOOL-LIBRARY-COUNT-01: the count said 130 but only 64 rows
  // rendered). The per-row name/description stays byte-bounded.
  maxRowsPerSource: 256,
  maxNameBytes: 192,
  maxDescriptionBytes: 240,
});

// The canonical source labels (the UI's TOOL_LIBRARY_SOURCE_LABELS mirror —
// carried by the route so the component renders the label without a second
// source of truth).
const TOOL_LIBRARY_SOURCE_LABELS = Object.freeze({
  "extension-builtin": "Built-in",
  "chrome-api": "Browser",
  "management": "Management",
  "webmcp-declared": "Site tools (declared)",
  "webmcp-inferred": "Site tools (inferred)",
  "bundled-package": "Bundled packages",
});

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export class ShadowToolCatalogController {
  #readInputs;
  #selections;

  constructor({ readInputs, selectionAuthority } = {}) {
    if (typeof readInputs !== "function") {
      throw new TypeError("shadow catalog needs a source reader");
    }
    this.#readInputs = readInputs;
    this.#selections = selectionAuthority ?? new ToolSelectionAuthority();
  }

  async #snapshot() {
    const inputs = await this.#readInputs();
    const catalog = buildToolCatalog(inputs);
    return { catalog, index: buildToolSearchIndex(catalog) };
  }

  async inspect(request = {}, context = {}) {
    const { catalog, index } = await this.#snapshot();
    const selectionContext = {
      runId: ownData(request, "runId"),
      taskId: ownData(request, "taskId") ?? `shadow:${ownData(request, "runId") ?? "missing"}`,
      agentId: ownData(request, "agentId"),
      origin: ownData(request, "origin"),
      documentId: ownData(request, "documentId") ?? ownData(context, "documentId"),
      runGeneration: ownData(request, "runGeneration") ?? `shadow:${catalog.generation}`,
      catalogGeneration: catalog.generation,
    };
    const requestedAction = ownData(request, "action");
    const action = typeof requestedAction === "string"
      ? requestedAction
      : "summary";
    if (action === "summary") {
      const bySource = {};
      const toolsBySource = {};
      const bundledById = new Map(
        BUNDLED_TOOL_PACKAGE_ROWS.map((row) => [row.toolId, row]),
      );
      for (const descriptor of catalog.descriptors) {
        bySource[descriptor.sourceKind] =
          (bySource[descriptor.sourceKind] ?? 0) + 1;
        // ONE bounded read-only per-tool summary row per source: name, source
        // label, version or availability, one-line description. Never secrets,
        // query history, digests, capabilities or any grant/verify surface.
        const rows = (toolsBySource[descriptor.sourceKind] ??= []);
        if (rows.length >= TOOL_LIBRARY_SUMMARY_LIMITS.maxRowsPerSource) continue;
        const bundled = bundledById.get(descriptor.toolId);
        const previewAdmitted = bundled?.admitted === true &&
          bundled?.settingsPreview === true;
        rows.push(Object.freeze({
          toolId: descriptor.toolId,
          name: String(bundled?.displayName ?? descriptor.name ?? descriptor.toolId)
            .slice(0, TOOL_LIBRARY_SUMMARY_LIMITS.maxNameBytes),
          sourceLabel: TOOL_LIBRARY_SOURCE_LABELS[descriptor.sourceKind] ??
            descriptor.sourceKind,
          version: bundled?.version ?? null,
          available: previewAdmitted || descriptor.availability === "ready",
          description: String(bundled?.description ?? descriptor.description ?? "")
            .slice(0, TOOL_LIBRARY_SUMMARY_LIMITS.maxDescriptionBytes),
        }));
      }
      return Object.freeze({
        ok: true,
        mode: "shadow-metadata-only",
        catalogGeneration: catalog.generation,
        descriptorCount: catalog.descriptors.length,
        bySource: Object.freeze(bySource),
        catalogDiagnostics: catalog.diagnostics,
        selectionDiagnostics: this.#selections.diagnostics(),
        canExecute: false,
        canGrant: false,
        // The technically-admitted bundled packages expose Settings previews
        // (metadata truth — NOT a selection or grant).
        settingsPreviewTools: Object.freeze(
          BUNDLED_TOOL_PACKAGE_ROWS
            .filter((row) => row?.settingsPreview === true && row?.admitted === true)
            .map((row) => row.toolId)
            .sort(),
        ),
        // Bounded per-tool summary by source (name/source label/version or
        // availability/one-line description) for the Settings `<details>` UI.
        toolsBySource: Object.freeze(
          Object.fromEntries(
            Object.entries(toolsBySource).map(([kind, rows]) => [
              kind,
              Object.freeze(rows),
            ]),
          ),
        ),
      });
    }
    if (action === "search") {
      const search = searchToolIndex(index, ownData(request, "query"), {
        limit: ownData(request, "limit"),
      });
      return this.#selections.issue(
        search,
        selectionContext,
        catalog,
        { ttlMs: ownData(request, "ttlMs") },
      );
    }
    if (action === "resolve") {
      return this.#selections.resolve(
        ownData(request, "selectionRef"),
        selectionContext,
        catalog,
      );
    }
    if (action === "capture") {
      const search = searchToolIndex(index, ownData(request, "query"), {
        limit: ownData(request, "limit"),
      });
      const selected = this.#selections.issue(
        search,
        selectionContext,
        catalog,
        { ttlMs: ownData(request, "ttlMs") },
      );
      return buildLazyProviderCapture(selected, {
        nonSelectedCount: Math.max(
          0,
          catalog.descriptors.length - selected.results.length,
        ),
      });
    }
    return Object.freeze({ ok: false, error: "unknown-shadow-action" });
  }
}

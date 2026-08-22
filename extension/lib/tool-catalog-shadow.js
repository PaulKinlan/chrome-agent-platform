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
    const requestedAction = ownData(request, "action");
    const action = typeof requestedAction === "string"
      ? requestedAction
      : "summary";
    if (action === "summary") {
      const bySource = {};
      for (const descriptor of catalog.descriptors) {
        bySource[descriptor.sourceKind] =
          (bySource[descriptor.sourceKind] ?? 0) + 1;
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
        // The ONLY technically-admitted bundled package exposes a Settings
        // preview (metadata truth — NOT a selection or grant).
        settingsPreviewCsvtool: BUNDLED_TOOL_PACKAGE_ROWS.some(
          (row) => row?.toolId === "csvtool" &&
            row?.settingsPreview === true && row?.admitted === true,
        ),
      });
    }
    if (action === "search") {
      const search = searchToolIndex(index, ownData(request, "query"), {
        limit: ownData(request, "limit"),
      });
      return this.#selections.issue(
        search,
        {
          runId: ownData(request, "runId"),
          agentId: ownData(request, "agentId"),
          origin: ownData(request, "origin"),
          documentId: ownData(request, "documentId") ??
            ownData(context, "documentId"),
          catalogGeneration: catalog.generation,
        },
        catalog,
        { ttlMs: ownData(request, "ttlMs") },
      );
    }
    if (action === "resolve") {
      return this.#selections.resolve(ownData(request, "selectionRef"), {
        runId: ownData(request, "runId"),
        agentId: ownData(request, "agentId"),
        origin: ownData(request, "origin"),
        documentId: ownData(request, "documentId") ??
          ownData(context, "documentId"),
        catalogGeneration: catalog.generation,
      }, catalog);
    }
    if (action === "capture") {
      const search = searchToolIndex(index, ownData(request, "query"), {
        limit: ownData(request, "limit"),
      });
      const selected = this.#selections.issue(
        search,
        {
          runId: ownData(request, "runId"),
          agentId: ownData(request, "agentId"),
          origin: ownData(request, "origin"),
          documentId: ownData(request, "documentId") ??
            ownData(context, "documentId"),
          catalogGeneration: catalog.generation,
        },
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

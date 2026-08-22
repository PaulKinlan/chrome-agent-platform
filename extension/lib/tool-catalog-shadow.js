// lib/tool-catalog-shadow.js — diagnostics-only composition for the catalog.
//
// The controller rebuilds from live source adapters on every inspection. It
// exposes bounded metadata/search/selection diagnostics only: no execute path,
// no source dispatcher, no permission request and no grant mutation.

import { buildToolCatalog } from "./tool-catalog.js";
import { buildToolSearchIndex, searchToolIndex } from "./tool-search.js";
import { ToolSelectionAuthority } from "./tool-selection.js";

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
    return Object.freeze({ ok: false, error: "unknown-shadow-action" });
  }
}

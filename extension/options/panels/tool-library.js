// panels/tool-library.js — Tool library read-only catalog diagnostics Settings panel module.

import { createPanelContext, bindPanelCtx } from "../panel-context.js";

const validateListenersInstalled = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("tool-library");

export async function renderToolLibrary() {
  const panelCtx = ensureCtx(null, arguments[0]);
  const library = $("#tool-library-view");
  if (!library) return;
  library.state = "loading";
  // ltkj.2: the schema-2 validation list is INDEPENDENT of the catalog
  // diagnostics below — the summary's decline/unavailable paths early-return
  // out of this function, and the validation section must still render
  // whatever the admission host reports. Detached: it cannot delay the
  // catalog render, and the catalog cannot starve it.
  const validationTask = (async () => {
    await (panelCtx.callbacks?.admissionHostReady ?? Promise.resolve());
    const listDiag = [];
    const requestValidationList = async () => {
      try {
        const listRes = await boundedSend("tool.package.validation-list", {});
        if (listRes?.ok === true && Array.isArray(listRes.packages)) return listRes.packages;
        listDiag.push(`!ok: ${String(listRes?.error ?? JSON.stringify(listRes)?.slice(0, 120))}`);
      } catch (e) {
        listDiag.push(`throw: ${String(e?.message ?? e).slice(0, 120)}`);
      }
      return null;
    };
    // One retry covers a forward that raced the listener registration window.
    library.validationPackages = (await requestValidationList()) ?? (await requestValidationList()) ?? [];
    library.validationListDiag = listDiag;
  })();

  if (!validateListenersInstalled.has(library)) {
    validateListenersInstalled.add(library);
    panelCtx.registerCleanup(() => validateListenersInstalled.delete(library));
    library.addEventListener("tool-package-validate-request", async (event) => {
      const detail = event?.detail ?? {};
      const { packageId, version, expectedVersion } = detail;
      if (typeof packageId !== "string" || !packageId || typeof version !== "string" || !version) {
        library.validationResult = { ok: false, error: "invalid package identity" };
        return;
      }
      library.validationBusy = true;
      try {
        const response = await send({
          type: "tool.package.validate",
          packageId,
          version,
          expectedVersion: expectedVersion ?? null,
        });
        if (!response || response.ok !== true) {
          library.validationResult = {
            ok: false,
            error: String(response?.error ?? "validation declined"),
            path: response?.path ?? null,
          };
        } else {
          library.validationResult = response;
        }
      } catch (error) {
        library.validationResult = {
          ok: false,
          error: String(error?.message ?? error ?? "validation failed"),
        };
      } finally {
        library.validationBusy = false;
      }
    });
  }
  try {
    const summary = await boundedSend("tool-catalog.shadow", { action: "summary" });
    if (!summary || summary.ok !== true) {
      library.error = String(summary?.error ?? "the diagnostics route declined");
      library.state = "error";
      await validationTask;
      return;
    }
    library.summary = summary;
    library.state = "ready";
  } catch (error) {
    const text = String(error?.message ?? error ?? "");
    if (/does not exist|unknown message|no receiver|Could not establish/i.test(text)) {
      library.state = "unavailable";
    } else {
      library.error = text;
      library.state = "error";
    }
  }

  library.addEventListener("tool-preview-request", async (event) => {
    const detail = event?.detail ?? {};
    const toolId = typeof detail.toolId === "string" ? detail.toolId : "";
    const args = Array.isArray(detail.args)
      ? detail.args.filter((a) => typeof a === "string").slice(0, 4)
      : [];
    const stdin = typeof detail.stdin === "string" ? detail.stdin : "";
    if (typeof stdin !== "string" || new TextEncoder().encode(stdin).byteLength > 2048) {
      library.previewResult = { ok: false, error: "stdin exceeds the 2 KiB preview bound" };
      return;
    }
    library.previewBusy = true;
    try {
      const response = await send({
        type: "tool.preview.run",
        toolId,
        args,
        stdin,
      });
      if (!response || response.ok !== true) {
        library.previewResult = {
          ok: false,
          error: String(response?.error ?? "preview declined"),
        };
      } else if (response.result) {
        library.previewResult = response.result;
      } else {
        library.previewResult = { ok: false, error: "preview returned no result" };
      }
    } catch (error) {
      library.previewResult = {
        ok: false,
        error: String(error?.message ?? error ?? "preview failed"),
      };
    } finally {
      library.previewBusy = false;
    }
  });
  await validationTask;
}
// async function renderLocalFolders (moved to panels/local-folders.js)

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  await renderToolLibrary();
  return {
    refresh: () => renderToolLibrary(),
    unmount: makeUnmount(panelCtx),
  };
}

// lib/wasm-package-admission.js — schema-2 runtime admission broker service.
//
// Invoked exclusively by Settings-only messages forwarded by the trusted
// service worker (never request-borne senders — the preview-host fence):
//   • {type: "tool.package.validation-list"}
//   • {type: "tool.package.validate", packageId, version, expectedVersion}
//
// Calls WasmPackageAuthority.admitBundled over the verified inventory, journals
// the existing registry and WAL, and returns validation confirmation.
// No grant issuance, tool registration or execution result.

import {
  registerSchema2Surface,
  WasmPackageAuthority,
  WasmPackageAuthorityError,
  canonicalJson,
} from "./wasm-package-authority.js";
import {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
  emscriptenIdentity,
} from "./emscripten-manifest.js";
import {
  auditEmscriptenGraph,
  auditEmscriptenModule,
} from "./emscripten-module-audit.js";
import { createBundledInventory } from "./bundled-inventory.js";
import { masterMemory } from "./memory.js";
import { isTrustedServiceWorkerSender } from "./pure.js";

// Register the schema-2 surface into WasmPackageAuthority.
registerSchema2Surface({
  validateManifest: validateEmscriptenManifest,
  validateProvenance: validateEmscriptenProvenance,
  assertNumericEligibility: assertEmscriptenNumericEligibility,
  identity: emscriptenIdentity,
  auditGraph: auditEmscriptenGraph,
  auditModule: auditEmscriptenModule,
});

const PACKAGE_ID_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/u;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function verifyOwnerOptionsContext(context, { expectedOptionsUrl = null } = {}) {
  if (context?.principal !== "owner-options") {
    return { ok: false, error: "not_authorized" };
  }
  const chromeRuntime = globalThis.chrome?.runtime;
  const optionsUrl = expectedOptionsUrl ?? (chromeRuntime?.getURL
    ? chromeRuntime.getURL("options/options.html")
    : null);
  const senderUrl = typeof context?.senderUrl === "string" ? context.senderUrl : "";
  // Check exact options document URL with allowed hash suffix, matching isExactOptionsSender
  const exactDoc = Boolean(optionsUrl) && (
    senderUrl === optionsUrl ||
    (senderUrl.startsWith(optionsUrl) &&
      /^#[A-Za-z0-9-]+$/.test(senderUrl.slice(optionsUrl.length)))
  );
  if (
    typeof context?.documentId !== "string" || !context.documentId ||
    !exactDoc ||
    Boolean(context?.pageSender)
  ) {
    return { ok: false, error: "not_authorized" };
  }
  return { ok: true };
}

export async function handleToolPackageValidationList(message, context, {
  inventory = null,
  expectedOptionsUrl = null,
} = {}) {
  const auth = verifyOwnerOptionsContext(context, { expectedOptionsUrl });
  if (!auth.ok) return auth;
  const messageKeys = Object.keys(message ?? {});
  if (messageKeys.some((k) => k !== "type")) {
    return { ok: false, error: "extra_keys_rejected" };
  }

  const inv = inventory ?? createBundledInventory();
  const schema2Packages = [];
  const manifests = Array.isArray(inv.manifests) ? inv.manifests : [];
  for (const m of manifests) {
    const rel = `extension/wasm/manifests/${m.pkg}-${m.version}.manifest.json`;
    try {
      const bytes = await inv.readFile(rel);
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text);
      if (parsed.schemaVersion === 2) {
        schema2Packages.push({
          packageId: parsed.package?.id ?? m.pkg,
          version: parsed.package?.version ?? m.version,
          validationAvailable: true,
        });
      }
    } catch {
      // Unreadable or malformed manifest fails exclusion from validation list
    }
  }
  return { ok: true, packages: schema2Packages };
}

export async function handleToolPackageValidate(message, context, {
  inventory = null,
  getStore = null,
  now = null,
  expectedOptionsUrl = null,
} = {}) {
  const messageKeys = Object.keys(message ?? {});
  const allowed = new Set(["type", "packageId", "version", "expectedVersion"]);
  if (messageKeys.some((k) => !allowed.has(k))) {
    return { ok: false, error: "extra_keys_rejected" };
  }

  const auth = verifyOwnerOptionsContext(context, { expectedOptionsUrl });
  if (!auth.ok) return auth;

  const { packageId, version, expectedVersion } = message ?? {};
  if (typeof packageId !== "string" || !PACKAGE_ID_RE.test(packageId)) {
    return { ok: false, error: "package_id_invalid" };
  }
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    return { ok: false, error: "version_invalid" };
  }
  if (expectedVersion !== null && expectedVersion !== undefined && (typeof expectedVersion !== "string" || !SEMVER_RE.test(expectedVersion))) {
    return { ok: false, error: "expected_version_invalid" };
  }

  const inv = inventory ?? createBundledInventory();
  const manifestRow = (inv.manifests ?? []).find((m) => m.pkg === packageId && m.version === version);
  if (!manifestRow) {
    return { ok: false, error: "manifest_not_found" };
  }
  const manifestRel = `extension/wasm/manifests/${packageId}-${version}.manifest.json`;
  const fileRow = (inv.files ?? []).find((f) => f.rel === manifestRel);
  if (!fileRow) {
    return { ok: false, error: "manifest_file_not_found" };
  }

  let rawBytes;
  try {
    rawBytes = await inv.readFile(manifestRel);
  } catch (err) {
    return { ok: false, error: "manifest_read_failed", detail: err?.message };
  }
  const manifestText = new TextDecoder().decode(rawBytes);

  const authority = new WasmPackageAuthority({
    getStore: getStore ?? (() => masterMemory()),
    inventory: inv,
    now: now ?? (() => Date.now()),
  });

  try {
    const admission = await authority.admitBundled({
      manifest: manifestText,
      files: null,
      expectedVersion: expectedVersion ?? null,
    });
    const record = admission.record;
    return {
      ok: true,
      packageId,
      version,
      manifestDigest: record.current.manifestDigest,
      graphDigest: record.current.graphDigest,
      epoch: record.epoch,
      status: "validated-not-enabled",
      signatureVerified: false,
      // ltkj.3: the bounded admitted operation descriptors (ids + scalar param
      // bounds) so the Settings surface can render the run panel. Broker-side
      // dispatch re-derives everything from the admitted manifest; these are
      // display/validation hints only.
      operations: (record.current.manifest?.entry?.operations ?? []).map((op) => ({
        id: op.id,
        toolId: op.toolId,
        result: op.result,
        params: (op.params ?? []).map((param) => ({
          name: param.name, type: param.type, minimum: param.minimum, maximum: param.maximum,
        })),
      })),
    };
  } catch (err) {
    if (err instanceof WasmPackageAuthorityError) {
      return {
        ok: false,
        error: err.code,
        path: err.path ?? null,
      };
    }
    return {
      ok: false,
      error: err?.message ?? "admission_failed",
      path: null,
    };
  }
}

export function registerWasmPackageAdmissionHost({
  runtime = globalThis.chrome?.runtime,
  inventory = null,
  getStore = null,
  now = null,
} = {}) {
  if (!runtime?.onMessage) return null;
  const listener = (message, sender, sendResponse) => {
    if (
      message?.type !== "wasm.package.options.validate" &&
      message?.type !== "wasm.package.options.validation-list"
    ) {
      return undefined;
    }
    if (
      sender?.id !== runtime.id ||
      sender?.tab != null ||
      !isTrustedServiceWorkerSender(sender, runtime)
    ) {
      sendResponse({ ok: false, error: "wasm package admission host denied: sender is not the service worker" });
      return undefined;
    }
    const optionsUrl = runtime.getURL ? runtime.getURL("options/options.html") : "chrome-extension://options/options.html";
    const context = {
      principal: "owner-options",
      documentId: "internal-sw-authorized",
      senderUrl: optionsUrl,
    };
    if (message.type === "wasm.package.options.validation-list") {
      (async () => {
        try {
          const res = await handleToolPackageValidationList(
            { type: "tool.package.validation-list" },
            context,
            { inventory, expectedOptionsUrl: optionsUrl },
          );
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, error: err?.message ?? "validation list error" });
        }
      })();
      return true;
    }
    if (message.type === "wasm.package.options.validate") {
      (async () => {
        try {
          const res = await handleToolPackageValidate(
            message,
            context,
            { inventory, getStore, now, expectedOptionsUrl: optionsUrl },
          );
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, error: err?.message ?? "validation error" });
        }
      })();
      return true;
    }
    return undefined;
  };
  runtime.onMessage.addListener(listener);
  return listener;
}

export function validateSchema2Manifest(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return { ok: false, error: "manifest_raw_required" };
  }
  return new WasmPackageAuthority().validateManifest(rawText);
}

export {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
  emscriptenIdentity,
  auditEmscriptenModule,
  auditEmscriptenGraph,
};

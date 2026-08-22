// lib/js-minifier-tools.js — bounded bundled-JS minifier lane (disabled metadata).
//
// This lane ships three genuine upstream engines as self-contained, fresh-Worker
// bundles. It is READ-ONLY metadata + the runMinifier API. Nothing here is
// admitted into the tool catalog, granted a route, or exposed to the provider:
// every descriptor is `admitted:false`, `canonicalNameClaim:false`,
// `canExecute:false`, `canGrant:false` — there is NO provider cutover.

import { runMinifier } from "./js-minifier.js";

export const JS_MINIFIER_TOOLS = Object.freeze([
  Object.freeze({
    toolId: "terser_bounded",
    sourceKind: "bundled-package",
    packageId: "core-terser",
    version: "5.44.0",
    canonicalNameClaim: false,
    admitted: false,
    canExecute: false,
    canGrant: false,
    availability: "disabled",
    capabilities: Object.freeze(["compute", "text.transform"]),
    replayClass: "read-only",
    spdxLicense: "BSD-2-Clause",
    licenceStatus: "pending-owner-confirmation",
  }),
  Object.freeze({
    toolId: "csso_bounded",
    sourceKind: "bundled-package",
    packageId: "core-csso",
    version: "5.0.5",
    canonicalNameClaim: false,
    admitted: false,
    canExecute: false,
    canGrant: false,
    availability: "disabled",
    capabilities: Object.freeze(["compute", "text.transform"]),
    replayClass: "read-only",
    spdxLicense: "MIT",
    licenceStatus: "pending-owner-confirmation",
  }),
  Object.freeze({
    toolId: "html_minifier_terser_bounded",
    sourceKind: "bundled-package",
    packageId: "core-html-minifier-terser",
    version: "7.2.0",
    canonicalNameClaim: false,
    admitted: false,
    canExecute: false,
    canGrant: false,
    availability: "disabled",
    capabilities: Object.freeze(["compute", "text.transform"]),
    replayClass: "read-only",
    spdxLicense: "MIT",
    licenceStatus: "pending-owner-confirmation",
  }),
]);

export { runMinifier };

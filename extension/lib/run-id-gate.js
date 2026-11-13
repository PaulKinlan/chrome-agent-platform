// Run-id gates for the service worker's wasm dispatch lanes (chrome-agent-platform-n6aj1,
// round 2: the round-1 fix threaded Settings preview ids through the execution-id grammar
// and refused previews that worked — a capability regression. The two predicates below
// separate the two sinks so neither trade is made.)
//
// Two sinks, two gates:
//
//   STREAM-OWNER lanes (dispatchBundledWasmStream): the runId becomes a wasm stream
//   OWNER via encodeModelStreamOwner. The v2 framing cannot distinguish provenance
//   (n6aj1: a legacy owner whose run id begins 'v2:<digits>:' parses as the v2 owner
//   of a different tuple), so an owner may only be derived from a VALIDATED execution
//   id — and no valid execution id (exec:<uuid>|exec_*|acp:*) can begin 'v2:', which
//   makes the colliding legacy form unreachable from any writer by construction.
//
//   DISPATCH-IDENTITY lanes (dispatchEmscriptenRun, dispatchUserWasmTool): the runId
//   is trace/authority metadata (documentId fallback, fenced context, authority
//   record) and NEVER reaches the owner codec. These lanes mint their own preview run
//   ids ('model-run-<8 hex>', 'settings-preview-<12 hex>' — service-worker.js Settings
//   paths), which are deliberately NOT execution ids. Refusing them was the round-1
//   regression. The gate here accepts an execution id OR one of the two SW-minted
//   preview shapes: bounded, lowercase-hex-suffixed, and never 'v2:'-prefixed, so the
//   owner-codec collision stays unreachable even if such an id were ever misrouted.

import { validExecutionId } from "./durable-runs.js";

const PREVIEW_RUN_ID = /^(?:model-run-[0-9a-f]{8}|settings-preview-[0-9a-f]{12})$/u;

/** Gate for lanes that derive a wasm stream OWNER: execution ids only. */
export function streamOwnerRunIdOrNull(value) {
  return typeof value === "string" && validExecutionId(value) ? value : null;
}

/**
 * Gate for dispatch-identity lanes: an execution id, or one of the two SW-minted
 * preview shapes. NEVER a stream-owner source (see module docblock).
 */
export function dispatchRunIdOrNull(value) {
  if (typeof value !== "string" || !value) return null;
  return validExecutionId(value) || PREVIEW_RUN_ID.test(value) ? value : null;
}

// The canonical MINTERS for the two preview run-id shapes (chrome-agent-platform-n6aj1
// round 3: the settings-preview mint used randomUUID().slice(0, 12), whose 12-char
// window is '8 hex + hyphen + 3 hex' — the hyphen failed PREVIEW_RUN_ID and 100% of
// real settings previews were refused. The minters and the predicates now live in ONE
// module and the tests derive their inputs from the minters, so a hyphen, a length
// change or a prefix change reds the suite instead of shipping).
const uuidHex = (n) => crypto.randomUUID().replace(/-/gu, "").slice(0, n);

/** Mint a model-run dispatch id: 'model-run-' + 8 hex (hyphen-free). */
export function mintModelRunRunId() {
  return `model-run-${uuidHex(8)}`;
}

/** Mint a settings-preview dispatch id: 'settings-preview-' + 12 hex (hyphen-free). */
export function mintSettingsPreviewRunId() {
  return `settings-preview-${uuidHex(12)}`;
}

// extension/background/routes/tool-stream.js — the file-backed bundled-tool transport routes, moved out
// of the service worker (chrome-agent-platform-atxc6, split by domain: the tool-stream cluster was 12
// routes spread across two different inline maps in the 5,010-line route monolith, with only two
// service-worker-scope references).
//
// This is a MOVE, not a rewrite: the handlers, their comments and their authority model travel verbatim.
// The suite is the ONLY way bundled-tool content moves through the extension, so its invariants matter:
//   * every public route re-derives its owner from the ROUTE CONTEXT (`wasmStreamOwner`), never from a
//     caller-supplied string — which is why the platform bridges live here instead of shadowing the
//     owner-derived lifecycle routes;
//   * content moves in caller-chosen chunks, while EXECUTION and RESULTS use opaque OPFS references;
//   * `tool-stream.run` runs the engine the worker owns (`runWasmStreamTool`), which stays in the worker
//     because the preview surface reaches it too.
//
// Two service-worker-scope helpers are injected (wasmStreamOwner, runWasmStreamTool); everything else is
// a library import, which is what makes this a move rather than a refactor.
import { getAsset } from "../../lib/artifacts.js";
import { streamTabularTransform } from "../../lib/tool-tabular-contracts.js";
import {
  promoteWasmStreamToArtifact,
  stageAssetAsWasmStream,
  stageAttachmentAsWasmStream,
} from "../../lib/tool-stream-platform.js";
import {
  appendWasmStreamInputBase64,
  createWasmStreamInput,
  discardWasmStream,
  readWasmStreamReceipt,
  readWasmStreamWindow,
  removeWasmStream,
  sealWasmStreamInput,
} from "../../lib/wasm-stream-files.js";

/**
 * @param {{
 *   wasmStreamOwner: (context: any) => string,
 *   runWasmStreamTool: (args: any) => Promise<any>,
 * }} deps
 * @returns {Readonly<Record<string, Function>>} frozen route map
 */
export function createToolStreamRoutes({ wasmStreamOwner, runWasmStreamTool }) {
  return Object.freeze({
// File-backed bundled-tool transport. Every public route is restricted to
// the exact Settings document by wasmStreamOwner(); content moves in caller-
// chosen chunks, while execution and results use opaque OPFS references.
async "tool-stream.input.create"(_message, context) {
  const owner = wasmStreamOwner(context);
  const ref = await createWasmStreamInput({ owner });
  return { ok: true, ref };
},
async "tool-stream.input.append"({ ref, base64 } = {}, context) {
  const owner = wasmStreamOwner(context);
  return await appendWasmStreamInputBase64({ ref, owner, base64 });
},
async "tool-stream.input.seal"({ ref } = {}, context) {
  const owner = wasmStreamOwner(context);
  return await sealWasmStreamInput({ ref, owner });
},
async "tool-stream.run"({ toolId, args = [], inputRef } = {}, context) {
  const owner = wasmStreamOwner(context);
  return await runWasmStreamTool({
    toolId,
    args,
    inputRef,
    owner,
    documentId: context.documentId,
  });
},
async "tool-stream.output.read"({ ref, offset = 0, length = 65536 } = {}, context) {
  const owner = wasmStreamOwner(context);
  return await readWasmStreamWindow({ ref, owner, offset, length });
},
async "tool-stream.output.receipt"({ ref } = {}, context) {
  const owner = wasmStreamOwner(context);
  return await readWasmStreamReceipt({ ref, owner });
},
async "tool-stream.remove"({ ref } = {}, context) {
  const owner = wasmStreamOwner(context);
  return await removeWasmStream({ ref, owner });
},

// Input create/append/seal, execution, reads, receipts, and removal use the
// single owner-derived lifecycle routes above. These platform-only bridges
// must not shadow that authority with caller-supplied owner strings.
async "tool-stream.stage-attachment"({ attachment } = {}, routeContext) {
  const owner = wasmStreamOwner(routeContext);
  const res = await stageAttachmentAsWasmStream(attachment, { owner });
  return { ok: true, inputRef: res.inputRef, bytes: res.bytes, name: res.name };
},
async "tool-stream.stage-asset"({ assetId, origin = "master" } = {}, routeContext) {
  const owner = wasmStreamOwner(routeContext);
  const assetRes = await getAsset(origin, assetId);
  if (!assetRes?.ok || !assetRes.asset) return { ok: false, error: "asset not found" };
  const res = await stageAssetAsWasmStream(assetRes.asset, { owner });
  return { ok: true, inputRef: res.inputRef, bytes: res.bytes, name: res.name };
},
async "tool-stream.promote-output"({ outputRef, name, assetType = "text", origin = "master", force = false } = {}, routeContext) {
  const owner = wasmStreamOwner(routeContext);
  return await promoteWasmStreamToArtifact(outputRef, { origin, name, type: assetType, owner, force });
},
async "tool-stream.discard"({ ref } = {}, routeContext) {
  const owner = wasmStreamOwner(routeContext);
  await discardWasmStream({ ref, owner });
  return { ok: true };
},
async "tool-stream.tabular-transform"({ inputRef, operations, outputFormat, delimiter } = {}, routeContext) {
  const owner = wasmStreamOwner(routeContext);
  return await streamTabularTransform(inputRef, { operations, outputFormat, delimiter, owner });
},
  });
}

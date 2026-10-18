// Offscreen-only, SW-sender-gated ingress for nonpublishing binary staging.
// Keep this tiny: the 250 KB offscreen bundle limit must not eagerly include
// the native runner, SHA-256/OPFS writer and binary custody helpers.
import { EMSCRIPTEN_HOST_STAGE_TYPE } from "./emscripten-stage-protocol.js";
import { isTrustedServiceWorkerSender } from "./pure.js";

function unknown(error) { return { ok: false, phase: "unknown", error }; }

export function registerEmscriptenBinaryStagingHost(deps = {}) {
  const runtime = deps.runtime ?? globalThis.chrome?.runtime;
  if (!runtime?.onMessage) return;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== EMSCRIPTEN_HOST_STAGE_TYPE) return undefined;
    // Deny before even importing executable code: an extension page can send
    // this message, but cannot present Chrome's attested SW sender identity.
    if (!isTrustedServiceWorkerSender(sender, runtime)) {
      sendResponse(unknown("emscripten_stage_sender"));
      return false;
    }
    // Resolve a fixed extension URL at runtime: the Store bundle does not
    // support code splitting and otherwise eagerly inlines the entire native
    // runner into offscreen.bundle.js (343 KB > its 250 KB budget).
    const load = deps.load ?? (() => import(runtime.getURL("lib/emscripten-host-stage.js")));
    Promise.resolve().then(load)
      .then(({ executeStagedEmscriptenBinaryRequest }) =>
        (deps.execute ?? executeStagedEmscriptenBinaryRequest)(message, { ...deps, runtime }))
      .then(sendResponse).catch(() => sendResponse(unknown("emscripten_stage_host_unavailable")));
    return true;
  });
}

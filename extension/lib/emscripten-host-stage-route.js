// Offscreen-only, SW-sender-gated ingress for nonpublishing binary staging.
// Keep this tiny: the 258 KB offscreen bundle limit must not eagerly include
// the native runner, SHA-256/OPFS writer and binary custody helpers.
import { EMSCRIPTEN_HOST_STAGE_TYPE } from "./emscripten-stage-protocol.js";
import { isTrustedServiceWorkerSender } from "./pure.js";

export function registerEmscriptenBinaryStagingHost(runtime = globalThis.chrome?.runtime, load) {
  if (!runtime?.onMessage) return;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== EMSCRIPTEN_HOST_STAGE_TYPE) return;
    const refuse = (error) => sendResponse({ ok: false, phase: "unknown", error });
    // Deny before even importing executable code: an extension page can send
    // this message, but cannot present Chrome's attested SW sender identity.
    if (!isTrustedServiceWorkerSender(sender, runtime)) {
      refuse("emscripten_stage_sender");
      return false;
    }
    // Resolve a fixed extension URL at runtime: the Store bundle does not
    // support code splitting and otherwise eagerly inlines the entire native
    // runner into offscreen.bundle.js (343 KB > its 258 KB budget).
    Promise.resolve().then(load ?? (() => import(runtime.getURL("lib/emscripten-host-stage.js"))))
      .then(({ executeStagedEmscriptenBinaryRequest }) => executeStagedEmscriptenBinaryRequest(message))
      .then(sendResponse, () => refuse("emscripten_stage_host_unavailable"));
    return true;
  });
}

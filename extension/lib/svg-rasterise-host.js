// extension/lib/svg-rasterise-host.js — the NATIVE SVG rasteriser host
// (chrome-agent-platform-moim): the offscreen document renders an SVG with the
// browser's OWN rasteriser (blob → <img> → OffscreenCanvas → PNG) — no Wasm.
// The moim probe (cap-evidence/cap-svg/native-probe.md) measured this exact
// pipeline against a pinned resvg 0.44.0 reference: shapes/effects identical,
// text structurally superior (real system fonts — a WASI resvg would need
// embedded fonts), and external hrefs are NEVER fetched (honest local
// broken-image placeholder, zero network requests).

import { isTrustedWasmStreamSender } from "./wasm-stream-host.js";

export const SVG_RASTERISE_RUN_TYPE = "cap:svg-rasterise-run";
export const SVG_RASTERISE_WALL_MS = 8000;
const SVG_MAX_BYTES = 8 * 1024 * 1024; // transport bound on the decoded SVG text

/** The pure-DOM rasterisation step. Separated from the message protocol so
 * committed tests execute the protocol with an injected fake while the real
 * canvas path is exercised by the live KAT/probe. */
export async function rasteriseSvgToPng({ svgText, width, height, background }) {
  if (typeof svgText !== "string" || svgText.length === 0 || svgText.length > SVG_MAX_BYTES) {
    throw new Error("svg_rasterise: svg text missing or over the 8 MiB bound");
  }
  if (!Number.isSafeInteger(width) || width < 1 || width > 8192) {
    throw new Error("svg_rasterise: width must be an integer in [1, 8192]");
  }
  if (!Number.isSafeInteger(height) || height < 1 || height > 8192) {
    throw new Error("svg_rasterise: height must be an integer in [1, 8192]");
  }
  const blob = new Blob([svgText], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve(true);
      img.onerror = () => reject(new Error("svg_rasterise: the document failed to load (malformed SVG or unsupported feature)"));
      setTimeout(() => reject(new Error("svg_rasterise: image load timed out")), SVG_RASTERISE_WALL_MS);
    });
    img.src = url;
    await loaded;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("svg_rasterise: no 2d context");
    if (typeof background === "string" && background.length > 0 && background.length <= 64) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await out.arrayBuffer());
    if (bytes.length === 0) throw new Error("svg_rasterise: rasterisation produced no bytes");
    return bytes;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Decode the run's base64 stdin into the SVG text (the transport is the same
 * base64-stdin contract the bundled unix-stream tools use). */
export function decodeSvgStdin(stdin) {
  const s = String(stdin ?? "").trim();
  if (!s) throw new Error("svg_rasterise: stdin (base64 SVG) is required");
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Register the native rasteriser listener in the offscreen document.
 * The ONLY accepted sender is the same-extension SERVICE WORKER (the same
 * trust gate the wasm stream host uses); the authority-free request carries
 * svg stdin + dimensions only, and the PNG answers base64 on the same
 * envelope contract as the bundled tools (stdoutEncoding "base64").
 */
export function registerSvgRasteriseHost({ runtime = globalThis.chrome?.runtime, rasterise = rasteriseSvgToPng } = {}) {
  if (!runtime?.onMessage) return null;
  const listener = (message, sender, sendResponse) => {
    if (message?.type !== SVG_RASTERISE_RUN_TYPE) return undefined;
    if (!isTrustedWasmStreamSender(sender, runtime)) {
      sendResponse({ ok: false, error: "svg_rasterise host denied: sender is not the service worker" });
      return undefined;
    }
    (async () => {
      const svgText = decodeSvgStdin(message.stdinBase64);
      const bytes = await rasterise({
        svgText,
        width: message.width,
        height: message.height,
        background: message.background,
      });
      return {
        ok: true,
        phase: "completed",
        stdoutEncoding: "base64",
        stdout: null,
        stdoutBase64: bytesToBase64(bytes),
        stdoutBytes: bytes.length,
        stderr: "",
        errno: null,
        error: null,
      };
    })().then(
      (res) => sendResponse(res),
      (error) => sendResponse({ ok: false, error: String(error?.message ?? error).slice(0, 1024) }),
    );
    return true; // async response
  };
  runtime.onMessage.addListener(listener);
  return listener;
}

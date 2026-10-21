// Shared pure content policy for changed-test selection and its coverage ledger.
// Content-only paths have no executable suite obligation; an HTML/JS/JSON path
// is NOT exempt merely because it lives in docs/.
const CONTENT_EXT_RE = /\.(md|markdown|txt|png|jpe?g|gif|svg|webp|ico|woff2?|pdf)$/i;

export function isPassiveContentFile(file) {
  // extension/wasm/licenses/ notice text files are validated by Wasm license guards (zbge2)
  if (/^extension[\\/]wasm[\\/]licenses[\\/]/i.test(file)) return false;
  return CONTENT_EXT_RE.test(file);
}

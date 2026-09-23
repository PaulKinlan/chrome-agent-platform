// wasm-call-scan.mjs — find WebAssembly API CALLS in built JavaScript.
// chrome-agent-platform-cc18.
//
// WHY A SCANNER AND NOT A grep: the three page bundles each contain the word
// "WebAssembly" five times, and every one of them is UI COPY — "Add a
// WebAssembly file", "Admitted bundled WebAssembly tool packages will be listed
// here". A count of the bare word reports 5 and means nothing; a count of API
// calls reports 0 and is the property. Measured at e14e436f, 2026-09-23.
//
// The distinction is the whole point of the guard, so it lives in a function
// with its own tests rather than in a regex written inline at the call site.
//
// Minified bytes are in scope on purpose: esbuild never renames property
// names, so `WebAssembly.instantiate(` survives store minification intact
// (build.mjs relies on the same fact for its eval scrub).

/** The API surface that EXECUTES or MATERIALISES a module. A page bundle that
 *  carries any of these has stopped tree-shaking the validator/runtime away.
 *  Deliberately includes the constructors: `new WebAssembly.Module(bytes)` is
 *  compilation by another name. */
export const WASM_CALL_NAMES = Object.freeze([
  "instantiate",
  "instantiateStreaming",
  "compile",
  "compileStreaming",
  "validate",
  "Module",
  "Instance",
]);

const CALL_RE = new RegExp(
  String.raw`WebAssembly\s*\.\s*(${WASM_CALL_NAMES.join("|")})\b`,
  "g",
);

/**
 * Every WebAssembly API call site in `source`.
 * Returns `[{ name, index, excerpt }]` — the excerpt makes a failure report
 * self-explaining, so a red names the construct rather than only a count.
 */
export function wasmApiCalls(source) {
  const text = String(source ?? "");
  const out = [];
  for (const m of text.matchAll(CALL_RE)) {
    const from = Math.max(0, m.index - 60);
    const to = Math.min(text.length, m.index + m[0].length + 40);
    out.push({
      name: m[1],
      index: m.index,
      excerpt: text.slice(from, to).replace(/\s+/gu, " "),
    });
  }
  return out;
}

/** Convenience count. */
export function wasmApiCallCount(source) {
  return wasmApiCalls(source).length;
}

/** A compact, bounded failure report naming what was found and where. */
export function formatWasmCallSites(file, sites, limit = 3) {
  const head = `${file}: ${sites.length} WebAssembly API call site(s)`;
  if (sites.length === 0) return head;
  const shown = sites.slice(0, limit)
    .map((s) => `    WebAssembly.${s.name} @${s.index} … ${s.excerpt.slice(0, 120)} …`);
  const more = sites.length > limit ? `\n    (+${sites.length - limit} more)` : "";
  return `${head}\n${shown.join("\n")}${more}`;
}

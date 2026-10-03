// scripts/lib/shared-strings.mjs — emit a JSON-shaped generated module with its
// long REPEATED strings hoisted into one table.
//
// Why: the descriptor rows repeat the same caveat/provenance prose once per
// package, and every consumer bundles that duplication (chrome-agent-platform-
// ehsl — the store service-worker bundle sat ~10 bytes under its 3 MB budget
// when written; measured 2,998,629 bytes = 1,371 bytes headroom on 2026-09-18
// (chrome-agent-platform-4ctv baseline).
// A string that appears at least `minCount` times and is at least `minLength`
// characters is emitted ONCE and referenced from each row, so the exported VALUE
// is unchanged while the bytes are not paid per copy.
//
// Pure and dependency-free so the generator and a unit test share ONE rule.

/** Placeholder for a hoisted string, chosen to survive JSON escaping unharmed. */
const placeholder = (index) => `\u0000S${index}\u0000`;

/**
 * The repeated strings worth hoisting, most-repeated first (stable output).
 * @param {unknown} value a JSON-shaped value
 * @param {{ minLength?: number, minCount?: number }} [options]
 * @returns {string[]}
 */
export function collectSharedStrings(value, { minLength = 20, minCount = 2 } = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @param {any} v */
  const visit = (v) => {
    if (typeof v === "string") { counts.set(v, (counts.get(v) ?? 0) + 1); return; }
    if (Array.isArray(v)) { for (const item of v) visit(item); return; }
    if (v && typeof v === "object") { for (const key of Object.keys(v)) visit(/** @type {any} */ (v)[key]); }
  };
  visit(value);
  return [...counts.entries()]
    .filter(([s, n]) => s.length >= minLength && n >= minCount)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length) || (a[0] < b[0] ? -1 : 1))
    .map(([s]) => s);
}

/**
 * Render `<banner>const SHARED_STRINGS = [...]; export const <declaration> = Object.freeze(<rows>);`
 * with every shared string replaced by a table reference. With no shared
 * strings the output is byte-identical to a plain JSON emission.
 * @param {{ value: unknown, banner?: string, declaration?: string, sharedStrings?: string[] }} options
 * @returns {string}
 */
export function renderHoistedValue({ value, banner = "", declaration = "ROWS", sharedStrings = [] }) {
  if (!sharedStrings.length) {
    return `${banner}export const ${declaration} = Object.freeze(${JSON.stringify(value, null, 1)});\n`;
  }
  const index = new Map(sharedStrings.map((s, i) => [s, i]));
  const table = sharedStrings.map((s) => JSON.stringify(s)).join(",\n ");
  const json = JSON.stringify(
    value,
    (_key, v) => (typeof v === "string" && index.has(v) ? placeholder(index.get(v)) : v),
    1,
  );
  const body = json.replace(/"\\u0000S(\d+)\\u0000"/g, (_m, i) => `SHARED_STRINGS[${i}]`);
  // Fail closed: a sentinel that survived substitution would silently corrupt a
  // generated value (and the module is imported by tests that compare values).
  if (body.includes("\\u0000")) throw new Error("shared-string placeholder leaked through JSON escaping");
  return `${banner}const SHARED_STRINGS = Object.freeze([\n ${table}\n]);\nexport const ${declaration} = Object.freeze(${body});\n`;
}

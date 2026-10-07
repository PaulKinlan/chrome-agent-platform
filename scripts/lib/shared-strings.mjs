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
 * @param {{ minLength?: number, minCount?: number, minSaving?: number, refLen?: number }} [options]
 * @returns {string[]}
 */
export function collectSharedStrings(value, { minLength = 20, minCount = 2, minSaving = 0, refLen = 5 } = {}) {
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
    .filter(([s, n]) => {
      if (s.length < minLength || n < minCount) return false;
      if (minSaving > 0) {
        const jsonLen = JSON.stringify(s).length;
        if ((n - 1) * jsonLen - n * refLen - 2 < minSaving) return false;
      }
      return true;
    })
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length) || (a[0] < b[0] ? -1 : 1))
    .map(([s]) => s);
}

/**
 * Render `<banner>const <tableName> = [...]; <extraDefs> export const <declaration> = Object.freeze(<rows>);`
 * with every shared string replaced by a table reference. With no shared
 * strings the output is byte-identical to a plain JSON emission.
 * @param {{
 *   value: unknown,
 *   banner?: string,
 *   declaration?: string,
 *   sharedStrings?: string[],
 *   tableName?: string,
 *   hoistStructures?: boolean,
 * }} options
 * @returns {string}
 */
export function renderHoistedValue({
  value,
  banner = "",
  declaration = "ROWS",
  sharedStrings = [],
  tableName = "SHARED_STRINGS",
  hoistStructures = false,
}) {
  if (!sharedStrings.length && !hoistStructures) {
    return `${banner}export const ${declaration} = Object.freeze(${JSON.stringify(value, null, 1)});\n`;
  }
  const index = new Map(sharedStrings.map((s, i) => [s, i]));
  const table = sharedStrings.map((s) => JSON.stringify(s)).join(",\n ");
  const json = JSON.stringify(
    value,
    (_key, v) => (typeof v === "string" && index.has(v) ? placeholder(index.get(v)) : v),
    1,
  );
  let body = json.replace(/"\\u0000S(\d+)\\u0000"/g, (_m, i) => `${tableName}[${i}]`);

  let extraDefs = "";
  if (hoistStructures && Array.isArray(value)) {
    // 1. Capabilities arrays repeated >= 3 times
    const capCounts = new Map();
    for (const r of value) {
      if (r && Array.isArray(r.capabilities)) {
        const k = JSON.stringify(r.capabilities);
        capCounts.set(k, (capCounts.get(k) || 0) + 1);
      }
    }
    const sharedCaps = [...capCounts.entries()].filter(([k, n]) => n >= 3).map(([k]) => JSON.parse(k));

    // 2. Licence objects repeated >= 3 times
    const licCounts = new Map();
    for (const r of value) {
      if (r && r.licence) {
        const k = JSON.stringify(r.licence);
        licCounts.set(k, (licCounts.get(k) || 0) + 1);
      }
    }
    const sharedLics = [...licCounts.entries()].filter(([k, n]) => n >= 3).map(([k]) => JSON.parse(k));

    // 3. Caveats arrays repeated >= 5 times
    const caveatCounts = new Map();
    for (const r of value) {
      if (r && Array.isArray(r.caveats)) {
        const k = JSON.stringify(r.caveats);
        caveatCounts.set(k, (caveatCounts.get(k) || 0) + 1);
      }
    }
    const sharedCaveats = [...caveatCounts.entries()].filter(([k, n]) => n >= 5).map(([k]) => JSON.parse(k));

    sharedCaps.forEach((caps, i) => {
      const rendered = caps.map((c) => index.has(c) ? `${tableName}[${index.get(c)}]` : JSON.stringify(c)).join(", ");
      extraDefs += `const C${i} = Object.freeze([${rendered}]);\n`;
      const pattern = new RegExp(
        `"capabilities": \\[\\n\\s+` +
        caps.map((c) => (index.has(c) ? `${tableName}\\[${index.get(c)}\\]` : JSON.stringify(c)).replace(/\[/g, "\\[").replace(/\]/g, "\\]")).join(`,\\n\\s+`) +
        `\\n\\s+\\]`,
        "g"
      );
      body = body.replace(pattern, `"capabilities": C${i}`);
    });

    sharedLics.forEach((lic, i) => {
      const f = index.has(lic.file) ? `${tableName}[${index.get(lic.file)}]` : JSON.stringify(lic.file);
      const s = index.has(lic.spdx) ? `${tableName}[${index.get(lic.spdx)}]` : JSON.stringify(lic.spdx);
      extraDefs += `const L${i} = Object.freeze({ spdx: ${s}, file: ${f}, notices: null });\n`;
      const fileRef = index.has(lic.file) ? `${tableName}\\[${index.get(lic.file)}\\]` : JSON.stringify(lic.file);
      const spdxRef = index.has(lic.spdx) ? `${tableName}\\[${index.get(lic.spdx)}\\]` : JSON.stringify(lic.spdx);
      const pattern = new RegExp(
        `"licence": \\{\\n\\s+"spdx": ${spdxRef},\\n\\s+"file": ${fileRef},\\n\\s+"notices": null\\n\\s+\\}`,
        "g"
      );
      body = body.replace(pattern, `"licence": L${i}`);
    });

    sharedCaveats.forEach((cavs, i) => {
      const rendered = cavs.map((c) => index.has(c) ? `${tableName}[${index.get(c)}]` : JSON.stringify(c)).join(", ");
      extraDefs += `const V${i} = Object.freeze([${rendered}]);\n`;
      const pattern = new RegExp(
        `"caveats": \\[\\n\\s+` +
        cavs.map((c) => index.has(c) ? `${tableName}\\[${index.get(c)}\\]` : JSON.stringify(c)).join(`,\\n\\s+`) +
        `\\n\\s+\\]`,
        "g"
      );
      body = body.replace(pattern, `"caveats": V${i}`);
    });
  }

  // Fail closed: a sentinel that survived substitution would silently corrupt a
  // generated value (and the module is imported by tests that compare values).
  if (body.includes("\\u0000")) throw new Error("shared-string placeholder leaked through JSON escaping");
  return `${banner}const ${tableName} = Object.freeze([\n ${table}\n]);\n${extraDefs}export const ${declaration} = Object.freeze(${body});\n`;
}

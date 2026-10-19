// Hoist the common Wasm path prefix without changing BUNDLED_INVENTORY's
// exported rows or the generated module's text-visible release/pkg identities.
export function renderBundledInventoryData({ inventory, banner = "" }) {
  const prefix = "extension/wasm/";
  if (!inventory || !Array.isArray(inventory.files) || inventory.files.length === 0 ||
      inventory.files.some((row) => typeof row?.rel !== "string" || !row.rel.startsWith(prefix) || row.rel.length === prefix.length)) {
    throw new Error("inventory_rel_prefix_invalid");
  }

  let count = 0;
  const body = JSON.stringify(inventory, null, 1).replace(
    /"rel": ("(?:[^"\\]|\\.)*")/gu,
    (_match, encoded) => {
      const rel = JSON.parse(encoded);
      if (!rel.startsWith(prefix)) throw new Error("inventory_rel_prefix_invalid");
      count++;
      return `"rel": P + ${JSON.stringify(rel.slice(prefix.length))}`;
    },
  );
  // A new `rel` shape or a second rel-bearing field must not silently evade
  // interning and return an apparently smaller but semantically different map.
  if (count !== inventory.files.length) throw new Error("inventory_rel_prefix_invalid");
  return `${banner}const P = ${JSON.stringify(prefix)};\nexport const BUNDLED_INVENTORY = Object.freeze(${body});\n`;
}

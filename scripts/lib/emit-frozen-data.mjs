// Lossless source encoding of JSON data: intern strings and ordered object key
// layouts, never mutable values. Match the old JSON.stringify emitter before
// encoding (undefined omission, alias splitting, and JSON number semantics).
export function emitFrozenData(name, input) {
  const value = JSON.parse(JSON.stringify(input));
  const counts = new Map();
  function visit(v) {
    if (typeof v === "string") counts.set(v, (counts.get(v) ?? 0) + 1);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  }
  visit(value);
  const strings = [...counts].filter(([s, n]) => (JSON.stringify(s).length - 8) * n > JSON.stringify(s).length + 1).map(([s]) => s);
  const stringIds = new Map(strings.map((s, i) => [s, i]));
  const layouts = [], layoutIds = new Map();
  function encode(v) {
    if (typeof v === "string" && stringIds.has(v)) return `s[${stringIds.get(v)}]`;
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (v && typeof v === "object") {
      const keys = Object.keys(v), signature = JSON.stringify(keys);
      if (!layoutIds.has(signature)) { layoutIds.set(signature, layouts.length); layouts.push(keys); }
      return `o(${layoutIds.get(signature)},[${Object.values(v).map(encode).join(",")}])`;
    }
    return JSON.stringify(v);
  }
  const expression = encode(value);
  return `const s=${JSON.stringify(strings)};\nconst k=${JSON.stringify(layouts)};\nfunction o(i,v){return Object.fromEntries(k[i].map((key,j)=>[key,v[j]]));}\nexport const ${name}=Object.freeze(${expression});\n`;
}

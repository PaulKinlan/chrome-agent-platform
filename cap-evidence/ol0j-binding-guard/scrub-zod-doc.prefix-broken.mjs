import { parse } from "acorn";
import { createHash } from "node:crypto";

// Entire ClassBody AST pins, not a cross-method regex. Derived from the
// retained Zod 3.25.76 v4 CJS/ESM and 4.4.3 v4 ESM Doc sources (doc.js
// e084bbcc..., doc.cjs ae6c5bfe...) through the current esbuild chrome120
// developer and syntax-only Store passes. Any changed statement stays intact
// and the independent final evaluator gate refuses its surviving constructor.
const DOC_CLASS_BODIES = new Set([
  "c69fb5d1095cb733620eeb883cf1c56a2b794a41b4f27027d788032ec4a83a7e",
  "405839563a9264ead1c487101f179d6d9cdd481fa599c6f97ba0383ef5b4fbbb",
]);
function structural(node) {
  if (Array.isArray(node)) return node.map(structural);
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node)
    .filter(([key]) => !["start", "end", "loc", "raw"].includes(key))
    .map(([key, value]) => [key, structural(value)]));
  return node;
}
export function denyZodDocCompiles(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const spans = [];
  function visit(node, parent) {
    if (!node?.type) return;
    if (["ClassExpression", "ClassDeclaration"].includes(node.type)) {
      const name = node.id?.name ?? (parent?.type === "VariableDeclarator" ? parent.id?.name
        : parent?.type === "AssignmentExpression" ? parent.left?.name : null);
      if (/^Doc\d*$/u.test(name ?? "")) {
        const digest = createHash("sha256").update(JSON.stringify(structural(node.body))).digest("hex");
        if (DOC_CLASS_BODIES.has(digest)) {
          const body = node.body.body.find(method => method.key?.name === "compile").value.body;
          spans.push({ start: body.start, end: body.end });
        }
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(value => visit(value, node));
      else if (child?.type) visit(child, node);
    }
  }
  visit(ast, null);
  let code = source;
  for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, start) + '{ throw new Error("eval disabled (MV3 CSP)"); }' + code.slice(end);
  }
  return { code, count: spans.length };
}

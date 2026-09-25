// Builder custody is trusted (coord242). This unsigned derivation records the
// genuine builder's private-nonce observation, NOT authenticated history against
// an operator rewriting both marker and outputs. No execution authority follows.
import { parse } from "acorn";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const VALIDATE_SOURCE = Object.freeze({
  path: "extension/lib/emscripten-module-audit.js",
  sha256: "d3b8329cdfe2c8eca1c83c471267286568973d0a48f13b3ee6e435e2b5a7a952",
  line: 275, column: 7, argument: "bytes",
});
const EXPECTED = ["background/service-worker.js", "options.bundle.js"];
const GENERATED = [...EXPECTED, "workers/agent-worker.js", "shared/diff-core.bundle.js"].sort();
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = detail => { throw new Error(`validate origin: ${detail}`); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !equal(Object.keys(value).sort(), [...keys].sort())) fail("invalid derivation shape");
}
export function wasmCallSites(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const sites = [];
  function bindsWasm(p) {
    if (!p) return false;
    if (p.type === "Identifier") return p.name === "WebAssembly";
    if (p.type === "ObjectPattern") return p.properties.some(v => bindsWasm(v.value ?? v.argument));
    if (p.type === "ArrayPattern") return p.elements.some(bindsWasm);
    if (p.type === "AssignmentPattern") return bindsWasm(p.left);
    if (p.type === "RestElement") return bindsWasm(p.argument);
    return false;
  }
  function visit(n) {
    if (!n?.type) return;
    // Closed generated shape: no local WebAssembly binding anywhere. Refuse
    // unsupported shadows rather than infer that a marked spelling is global.
    if (bindsWasm(n.id) || n.params?.some(bindsWasm) || bindsWasm(n.param) || (n.type === "ImportDeclaration" && n.specifiers.some(s => bindsWasm(s.local))) || (n.type === "AssignmentExpression" && bindsWasm(n.left))) fail("shadowed WebAssembly binding");
    if (["CallExpression", "NewExpression"].includes(n.type) && n.callee?.type === "MemberExpression" && n.callee.object?.name === "WebAssembly") sites.push(n);
    for (const c of Object.values(n)) if (Array.isArray(c)) c.forEach(visit); else if (c?.type) visit(c);
  }
  visit(ast); return sites;
}
function isValidate(node, args) {
  return node?.type === "CallExpression" && !node.optional && !node.callee.computed && !node.callee.optional && node.callee.property?.name === "validate" && node.arguments.length === args && node.arguments[0]?.type === "Identifier";
}
function sourceCall(source) {
  if (hash(source) !== VALIDATE_SOURCE.sha256) fail("canonical source hash mismatch");
  const sites = wasmCallSites(source), n = sites[0];
  if (sites.length !== 1 || !isValidate(n, 1) || n.arguments[0].name !== VALIDATE_SOURCE.argument || n.loc.start.line !== VALIDATE_SOURCE.line || n.loc.start.column !== VALIDATE_SOURCE.column) fail("canonical source site mismatch");
  return n;
}

/** Each instance owns a fresh private nonce; disk source is never modified. */
export function createValidateOriginBuild(root) {
  const nonce = randomUUID();
  let loaded = false;
  const canonical = path.resolve(root, VALIDATE_SOURCE.path);
  const plugin = { name: "canonical-validate-origin", setup(build) {
    build.onLoad({ filter: /emscripten-module-audit\.js$/ }, async args => {
      if (args.path !== canonical) fail("noncanonical source path");
      const source = await readFile(canonical, "utf8"), node = sourceCall(source);
      loaded = true;
      const at = node.arguments[0].end;
      return { contents: source.slice(0, at) + `,${JSON.stringify(nonce)}` + source.slice(at), loader: "js", resolveDir: path.dirname(canonical) };
    });
  } };
  function finish(outputs) {
    if (!loaded) fail("canonical source not loaded");
    if (!equal([...outputs.keys()].sort(), GENERATED)) fail("unexpected generated outputs");
    const stripped = new Map(outputs), sites = [];
    for (const output of EXPECTED) {
      const source = outputs.get(output), calls = wasmCallSites(source), n = calls[0];
      if (calls.length !== 1 || !isValidate(n, 2) || n.arguments[1]?.type !== "Literal" || n.arguments[1].value !== nonce) fail(`missing/foreign/extra marked call: ${output}`);
      const commaStart = n.arguments[0].end, nonceEnd = n.arguments[1].end;
      if (!/^\s*,\s*$/u.test(source.slice(commaStart, n.arguments[1].start))) fail("nonce argument framing");
      const code = source.slice(0, commaStart) + source.slice(nonceEnd);
      const final = wasmCallSites(code);
      if (final.length !== 1 || !isValidate(final[0], 1)) fail("stripped site mismatch");
      stripped.set(output, code);
      sites.push({ output, start: final[0].start, end: final[0].end, argument: final[0].arguments[0].name });
    }
    for (const [output, source] of stripped) {
      if (source.includes(nonce)) fail(`nonce leak: ${output}`);
      if (!EXPECTED.includes(output) && wasmCallSites(source).length) fail(`unexpected Wasm output: ${output}`);
    }
    const derivation = { schema: "cap-wasm-validate-origin-v1", source: { ...VALIDATE_SOURCE }, transform: "private-extra-argument-v1", sites };
    if (JSON.stringify(derivation).includes(nonce)) fail("nonce derivation leak");
    return { outputs: stripped, derivation };
  }
  async function assertDirectoryNonceFree(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await assertDirectoryNonceFree(file);
      else {
        if ((await readFile(file)).includes(nonce)) fail(`nonce leak in generated file: ${entry.name}`);
        if (/\.map$/iu.test(entry.name)) fail(`unexpected Store source map: ${entry.name}`);
      }
    }
  }
  return { plugin, finish, assertDirectoryNonceFree };
}

/** Hash/site freshness, conditional on the explicitly trusted marker writer. */
export async function verifyValidateOrigin(derivation, { root, distRoot, outputs }) {
  exact(derivation, ["schema", "source", "transform", "sites"]);
  exact(derivation.source, Object.keys(VALIDATE_SOURCE));
  if (derivation.schema !== "cap-wasm-validate-origin-v1" || derivation.transform !== "private-extra-argument-v1" || !equal(derivation.source, VALIDATE_SOURCE)) fail("source derivation mismatch");
  sourceCall(await readFile(path.join(root, VALIDATE_SOURCE.path), "utf8"));
  if (!Array.isArray(derivation.sites) || derivation.sites.length !== EXPECTED.length) fail("derivation site count");
  const verified = [];
  for (const [i, site] of derivation.sites.entries()) {
    exact(site, ["output", "start", "end", "argument"]);
    if (site.output !== EXPECTED[i]) fail("derivation output mismatch");
    const bound = outputs.find(o => o.path === site.output);
    const bytes = await readFile(path.join(distRoot, site.output));
    if (!bound || hash(bytes) !== bound.sha256 || bytes.length !== bound.size) fail("derivation output hash mismatch");
    const calls = wasmCallSites(bytes.toString("utf8")), n = calls[0];
    if (calls.length !== 1 || !isValidate(n, 1) || n.start !== site.start || n.end !== site.end || n.arguments[0].name !== site.argument) fail("derivation output site mismatch");
    verified.push(Object.freeze({ ...site, sha256: bound.sha256 }));
  }
  return Object.freeze(verified);
}

// Scanner evidence comes only from the policy's strict marker/inventory read.
// A full operator rewrite is outside the trusted-builder boundary, not defeated
// by these public hashes. This predicate never permits any other Wasm method.
export function matchesGeneratedValidate(node, source, evidence) {
  return !!evidence && hash(source) === evidence.sha256 && isValidate(node, 1) && node.start === evidence.start && node.end === evidence.end && node.arguments[0].name === evidence.argument && wasmCallSites(source).length === 1;
}

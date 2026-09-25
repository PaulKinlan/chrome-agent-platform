// Fresh Node process: Function reflection/bind stays native; only evaluator
// apply/construct is denied, before any Zod/SDK import. No payload can execute.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [version, ext, mode = "fallback"] = process.argv.slice(2);
const root = new URL("../../", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const NativeFunction = globalThis.Function;
let denied = 0, compileCalls = 0;
globalThis.Function = new Proxy(NativeFunction, {
  apply() { denied++; throw new Error("eval disabled (MV3 CSP)"); },
  construct() { denied++; throw new Error("eval disabled (MV3 CSP)"); },
});
assert.equal(Function.prototype, NativeFunction.prototype);
function Example(x) { this.x = x; }
const Bound = Function.bind.apply(Example, [null, 42]);
assert.equal(new Bound().x, 42);
const base = `${root}node_modules/.deno/zod@${version}/node_modules/zod/v4/`;
const load = rel => ext === "cjs" ? require(base + rel + ".cjs") : import(pathToFileURL(base + rel + ".js"));
const z = await load("index");
const { allowsEval } = await load("core/util");
const { Doc } = await load("core/doc");
const original = Doc.prototype.compile;
Doc.prototype.compile = function (...args) { compileCalls++; return original.apply(this, args); };
assert.equal(allowsEval.value, false);
assert(denied > 0, "real cached CSP probe denied");
if (mode === "force-fast") {
  Object.defineProperty(allowsEval, "value", { value: true });
  // Negative control: selecting JIT really attempts Doc.compile and fails,
  // rather than making the positive pass through a fake no-op implementation.
  assert.throws(() => z.object({ value: z.number() }).parse({ value: 42 }), /eval disabled/);
  assert(compileCalls > 0);
} else {
  const sdk = await import(pathToFileURL(`${root}node_modules/.deno/@ai-sdk+provider-utils@5.0.33/node_modules/@ai-sdk/provider-utils/dist/index.js`));
  const schema = z.object({ name: z.string().min(2), count: z.number().int().min(0), tags: z.array(z.string()), note: z.string().optional() }).strict();
  const value = { name: "valid", count: 3, tags: ["a"] };
  assert.deepEqual(schema.parse(value), value);
  assert.equal(schema.safeParse({ ...value, count: -1 }).success, false);
  assert.equal(schema.safeParse({ ...value, extra: true }).success, false);
  const refined = schema.refine(v => v.count < 10, { message: "bounded count" });
  assert.equal(refined.safeParse({ ...value, count: 10 }).success, false);
  const asynchronous = schema.refine(async v => v.name !== "denied");
  assert.deepEqual(await asynchronous.parseAsync(value), value);
  assert.equal((await asynchronous.safeParseAsync({ ...value, name: "denied" })).success, false);
  assert.deepEqual(await sdk.validateTypes({ schema, value }), value);
  assert.equal((await sdk.safeValidateTypes({ schema, value: { ...value, count: "bad" } })).success, false);
  assert.deepEqual(await sdk.validateTypes({ schema: asynchronous, value }), value);
  assert.equal((await sdk.safeValidateTypes({ schema: asynchronous, value: { ...value, name: "denied" } })).success, false);
  assert.equal(sdk.asSchema(schema).jsonSchema.type, "object");
  assert.equal(compileCalls, 0, "real schema and SDK cases stayed on non-JIT path");
}
console.log(JSON.stringify({ version, ext, mode, denied, compileCalls, result: "PASS", browserEvidence: false }));

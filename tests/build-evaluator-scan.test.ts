import { assert, assertEquals } from "jsr:@std/assert@1";
import { scanShippedJs } from "../scripts/scan-shipped.mjs";
Deno.test("build evaluator: member, alias and sequence sites cannot evade the source AST gate", async () => {
  for (const source of [
    'globalThis["Function"]("return 1")',
    'const F = Function; new F("return 1")',
    '(0, eval)("1")',
    'const g = globalThis; const F = g.Function; F("return 1")',
    'const {Function: F} = globalThis; new F("return 1")',
    'let F; F = Function; F("return 1")',
    'const F = flag ? Function : safe; F("return 1")',
    'eval.call(null, "1")',
    'const F = Function.bind(null); F("return 1")',
    '(function(){}).constructor("return 1")',
    'const F=Function.bind.apply(Function,[null]); F("return 1")',
  ]) {
    const violations = await scanShippedJs(["extension/lib/example.js"], { readText: async () => source });
    assert(violations.some(v => v.includes("dynamic source evaluator")), source);
  }
});

Deno.test("build evaluator: lexical shadows and independent scopes are not global alias sets", async () => {
  for (const source of [
    'function f(Function) { return Function("data"); }',
    'function f(globalThis) { return globalThis.Function("data"); }',
    'function f(){const F=Function;} function g(){const F=x=>x; F("data");}',
    'function f(){ F("data"); var F = x=>x; }',
    '{const F=Function;} {const F=x=>x;F("data");}',
    'const F = x=>x; F("data");',
    'function wrap(t,i){var a=Function.bind.apply(t,i);return new a;}',
  ]) {
    assertEquals(await scanShippedJs(["extension/lib/example.js"], { readText: async () => source }), [], source);
  }
});

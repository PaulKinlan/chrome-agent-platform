import { assert, assertEquals } from "jsr:@std/assert@1";
import { emitFrozenData } from "../scripts/lib/emit-frozen-data.mjs";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
let serial = 0;
async function load(source: string) {
  return (await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}#${serial++}`)).DATA;
}
function equivalent(actual: any, expected: any, seen = new Set()) {
  assertEquals(actual, expected);
  if (actual && typeof actual === "object") {
    assert(!seen.has(actual), "no newly shared mutable subgraphs"); seen.add(actual);
    assertEquals(Object.getPrototypeOf(actual), Object.getPrototypeOf(expected));
    assertEquals(Object.isFrozen(actual), Object.isFrozen(expected));
    assertEquals(Object.isExtensible(actual), Object.isExtensible(expected));
    assertEquals(Reflect.ownKeys(actual), Reflect.ownKeys(expected));
    for (const key of Reflect.ownKeys(expected)) {
      const a = Object.getOwnPropertyDescriptor(actual, key)!;
      const e = Object.getOwnPropertyDescriptor(expected, key)!;
      assertEquals([a.writable, a.enumerable, a.configurable, a.get, a.set], [e.writable, e.enumerable, e.configurable, e.get, e.set]);
      equivalent(a.value, e.value, seen);
    }
  }
}
Deno.test("emit-frozen-data: complete real inventory and descriptors match old full runtime emitter", async () => {
  for (const input of [BUNDLED_INVENTORY, BUNDLED_TOOL_PACKAGE_ROWS]) {
    const expected = await load(`export const DATA=Object.freeze(${JSON.stringify(input, null, 1)});`);
    const actual = await load(emitFrozenData("DATA", input));
    equivalent(actual, expected);
    assertEquals(JSON.stringify(actual), JSON.stringify(expected), "property/row order preserved");
    assertEquals(emitFrozenData("DATA", input), emitFrozenData("DATA", input));
  }
});
Deno.test("emit-frozen-data: nonempty evidence/revocations, optional keys, aliases and JSON omissions survive", async () => {
  const common = { nested: ["a long repeated string", "a long repeated string"] };
  const input = {
    schemaVersion: 1, release: "changed-release", signer: { lane: "bundled", keyId: "changed-signer" },
    files: [{ rel: "some/file", sha256: "e".repeat(64), size: 123 }], manifests: [{ pkg: "changed", version: "3.0.0", digest: "f".repeat(64) }],
    evidence: [{ kind: "real-nonempty-shape", details: common }], revocations: [{ keyId: "retired", details: common }],
    rows: [{ id: 1, callexport: true }, { id: 2, absent: undefined }],
  };
  const expected = await load(`export const DATA=Object.freeze(${JSON.stringify(input, null, 1)});`);
  const actual = await load(emitFrozenData("DATA", input));
  equivalent(actual, expected);
  assert(!Object.hasOwn(actual.rows[1], "callexport"));
  assert(!Object.hasOwn(actual.rows[1], "absent"));
  actual.evidence[0].details.nested.push("mutated");
  assertEquals(actual.revocations[0].details.nested.length, 2);
});

// jhfji: the exact runtime SW entry has no static-import edge from a test.
// Parse the shipped module to pin the REAL route initializer, its authoritative
// dependencies, and the handler map registration; text in comments cannot pass.
// @ts-nocheck — acorn nodes are plain JS across the Deno/npm boundary.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";

const source = Deno.readTextFileSync(new URL("../extension/background/service-worker.js", import.meta.url));
const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
const declarations = ast.body
  .filter((node) => node.type === "VariableDeclaration")
  .flatMap((node) => node.declarations);
const binding = (name: string) => declarations.find((node) => node.id?.type === "Identifier" && node.id.name === name)?.init;
const key = (property: any) => property.key?.name ?? property.key?.value;

Deno.test("jhfji: the shipped SW registers one sender-fenced Export route with SW-held data and credential dependencies", () => {
  const imported = ast.body.filter((node: any) => node.type === "ImportDeclaration")
    .filter((node: any) => node.source.value === "../lib/thread-export-route.js")
    .flatMap((node: any) => node.specifiers.map((spec: any) => spec.imported?.name ?? spec.local?.name));
  assertEquals(imported, ["createThreadExportRoute"], "the actual route implementation is imported, not a comment stub");

  const route = binding("threadExportRoute");
  assertEquals(route?.type, "CallExpression");
  assertEquals(route?.callee?.name, "createThreadExportRoute");
  const deps = route.arguments?.[0];
  assertEquals(deps?.type, "ObjectExpression");
  const fields = new Map(deps.properties.map((prop: any) => [key(prop), source.slice(prop.value.start, prop.value.end)]));
  for (const required of ["extensionId", "getThreadView", "getArtifact", "getProviderConfig", "getCredentialStores", "listVaultKeys", "readVaultSecret"]) {
    assert(fields.has(required), `SW must inject ${required} into the export route`);
  }
  assertMatch(fields.get("extensionId"), /\bchrome\.runtime\.id\b/);
  assertMatch(fields.get("getThreadView"), /handlers\["thread\.get"\]\(\{\s*id,\s*all:\s*true\s*\}\)/);
  assertMatch(fields.get("getArtifact"), /getAsset\(origin,\s*id\)/);
  assertMatch(fields.get("getProviderConfig"), /kvGet\("providerConfig"\)/);
  assertMatch(fields.get("getCredentialStores"), /kvGet\(\["cap:mcpServers",\s*"cap:namedAgents"\]\)/);
  assertMatch(fields.get("listVaultKeys"), /listMasked\(\{\s*caller:\s*"sw"\s*\}\)/);
  assertMatch(fields.get("readVaultSecret"), /getSecretRaw\(keyId,\s*\{\s*caller:\s*"sw",\s*access:\s*enclaveSwAccess\s*\}\)/);

  const handlers = binding("handlers");
  assertEquals(handlers?.type, "CallExpression");
  assertEquals(handlers?.callee?.name, "mergeRouteMaps");
  const entries = handlers.arguments.flatMap((arg: any) => arg.type === "ObjectExpression" ? arg.properties : []);
  const exportEntries = entries.filter((prop: any) => key(prop) === "thread-export.html");
  assertEquals(exportEntries.length, 1, "exactly one real handler entry for the export route");
  assertEquals(exportEntries[0].value.type, "Identifier");
  assertEquals(exportEntries[0].value.name, "threadExportRoute", "dispatch must use the SW-held route, not a page-supplied handler");
});

// @ts-nocheck — cross-major zod peer comparison tests deliberately test incompatible type interfaces.
// tests/mcp-zod-peer-parity.test.ts — chrome-agent-platform-mx1g:
// Evaluation of MCP Zod peer unification with schema parity tests.
//
// azlc audit found SDK 1.30.0 peer contexts bind Zod 3.25.76 and Zod 4.4.3.
// zod-to-json-schema 3.25.2 also binds these different peers; total emitted
// preminify converter contribution is 2,460 bytes, not the large source-input
// sum (108,530 bytes).
//
// This test suite documents why Zod 3 and Zod 4 schemas MUST NOT be mixed
// through the SDK and why the zod@3 context is the one to keep:
// 1. Zod compatibility: mixing Zod 3 and Zod 4 in object shapes throws.
// 2. Runtime conversion: zod-to-json-schema fails silently on Zod 4 schemas
//    (emits empty schema with no properties).
// 3. Validation issue disparity: Zod 4 omits issue.type and issue.received,
//    which breaks CAP's validationIssueDetail formatting.
// 4. MCP toJsonSchemaCompat divergence: Zod 4 mini toJSONSchema in zod@3 drops
//    constraint keywords (minLength, maxLength, minimum, maximum, minItems).
// 5. Preminify converter contribution: verified at 2,460 bytes in output.
//
// No production change authorized by chrome-agent-platform-mx1g (its RETAIN
// verdict). chrome-agent-platform-9epn.3 (2026-10-01 performance audit) then
// collapsed the SHIPPED bundles onto ONE SDK instance — the zod@3.25.76-bound
// `@modelcontextprotocol+sdk@1.30.0` that extension/lib/mcp-client.js always
// built against — because agent-do's `_1` (zod@4.4.3-bound) copy was the same
// SDK version twice plus the whole zod@4 major (−156,707 B minified SW). CAP
// never passes zod schemas INTO the SDK (its MCP path is client-only), so the
// facts below are unchanged and still executed; they now describe why the
// zod@3 context was the one to keep, not why two had to ship. The install
// keeps both peer contexts; tests/bundle-budget.test.ts pins that only one
// reaches a bundle.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import * as z3 from "npm:zod@3.25.76";
import * as z4 from "npm:zod@4.4.3";
import { zodToJsonSchema } from "npm:zod-to-json-schema@3.25.2";
import {
  isZ4Schema,
  objectFromShape,
  getParseErrorMessage,
  safeParse,
} from "../node_modules/.deno/@modelcontextprotocol+sdk@1.31.0/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js";
import {
  toJsonSchemaCompat,
} from "../node_modules/.deno/@modelcontextprotocol+sdk@1.31.0/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js";
import { McpServer } from "../node_modules/.deno/@modelcontextprotocol+sdk@1.31.0/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { compileSchemaToZod } from "../extension/lib/pure.js";

Deno.test("mcp-zod-peer-parity: runtime detection correctly identifies Zod 3 vs Zod 4 schemas", () => {
  const z3Schema = z3.string().min(1);
  const z4Schema = z4.string().min(1);

  // Zod 3 schemas carry _def with typeName; _zod is undefined
  assert(z3Schema._def !== undefined, "Zod 3 schema has _def");
  assertEquals(z3Schema._def.typeName, "ZodString");
  assertEquals(isZ4Schema(z3Schema), false, "Zod 3 schema is not Z4");

  // Zod 4 schemas carry _zod with def.type
  assert(z4Schema._zod !== undefined, "Zod 4 schema has _zod");
  assertEquals(z4Schema._zod.def.type, "string");
  assertEquals(isZ4Schema(z4Schema), true, "Zod 4 schema is Z4");
});

Deno.test("mcp-zod-peer-parity: objectFromShape enforces version homogeneity and refuses mixed shapes", () => {
  const z3Str = z3.string();
  const z3Num = z3.number();
  const z4Str = z4.string();
  const z4Num = z4.number();

  // Pure Zod 3 shape succeeds
  const obj3 = objectFromShape({ str: z3Str, num: z3Num });
  assertEquals(isZ4Schema(obj3), false, "Homogeneous Zod 3 shape yields Zod 3 object");
  assertEquals(obj3.safeParse({ str: "a", num: 1 }).success, true);

  // Pure Zod 4 shape succeeds
  const obj4 = objectFromShape({ str: z4Str, num: z4Num });
  assertEquals(isZ4Schema(obj4), true, "Homogeneous Zod 4 shape yields Zod 4 object");
  assertEquals(obj4.safeParse({ str: "a", num: 1 }).success, true);

  // Mixed shape MUST throw an explicit error per MCP SDK contract
  assertThrows(
    () => objectFromShape({ str: z3Str, num: z4Num }),
    Error,
    "Mixed Zod versions detected in object shape.",
  );
  assertThrows(
    () => objectFromShape({ str: z4Str, num: z3Num }),
    Error,
    "Mixed Zod versions detected in object shape.",
  );
});

Deno.test("mcp-zod-peer-parity: validation issue shape disparity breaks downstream error consumers", () => {
  // 1. type mismatch: Zod 3 provides issue.received; Zod 4 omits it
  const r3Type = z3.string().safeParse(123);
  const r4Type = z4.string().safeParse(123);
  assert(!r3Type.success && !r4Type.success);

  const issue3Type = r3Type.error.issues[0];
  const issue4Type = r4Type.error.issues[0];

  assertEquals(issue3Type.code, "invalid_type");
  assertEquals(issue3Type.expected, "string");
  assertEquals(issue3Type.received, "number"); // Present in Zod 3

  assertEquals(issue4Type.code, "invalid_type");
  assertEquals(issue4Type.expected, "string");
  assertEquals(issue4Type.received, undefined); // ABSENT in Zod 4

  // CAP's validationIssueDetail (extension/lib/lazy-tool-protocol.js:610) formats:
  // `${field} must be ${issue.expected}; received ${issue.received}`
  // With Zod 4, this formats as: "field must be string; received undefined"
  const capZ3Format = `arg must be ${issue3Type.expected}; received ${issue3Type.received}`;
  const capZ4Format = `arg must be ${issue4Type.expected}; received ${issue4Type.received}`;
  assertEquals(capZ3Format, "arg must be string; received number");
  assertEquals(capZ4Format, "arg must be string; received undefined");

  // 2. bounds constraints: Zod 3 provides issue.type; Zod 4 omits it
  const r3Bound = z3.string().min(5).safeParse("abc");
  const r4Bound = z4.string().min(5).safeParse("abc");
  assert(!r3Bound.success && !r4Bound.success);

  const issue3Bound = r3Bound.error.issues[0];
  const issue4Bound = r4Bound.error.issues[0];

  assertEquals(issue3Bound.type, "string"); // Present in Zod 3
  assertEquals(issue4Bound.type, undefined); // ABSENT in Zod 4 (uses origin: "string")

  // 3. enum failure codes: Zod 3 uses invalid_enum_value; Zod 4 uses invalid_value
  const r3Enum = z3.enum(["read", "write"]).safeParse("delete");
  const r4Enum = z4.enum(["read", "write"]).safeParse("delete");
  assert(!r3Enum.success && !r4Enum.success);

  assertEquals(r3Enum.error.issues[0].code, "invalid_enum_value");
  assertEquals(r4Enum.error.issues[0].code, "invalid_value");
  assertEquals(r3Enum.error.issues[0].received, "delete");
  assertEquals(r4Enum.error.issues[0].received, undefined); // ABSENT in Zod 4
});

Deno.test("mcp-zod-peer-parity: zod-to-json-schema fails silently on Zod 4 schemas", () => {
  const schema3 = z3.object({
    action: z3.string().min(1),
    count: z3.number().int().min(0),
  });
  const schema4 = z4.object({
    action: z4.string().min(1),
    count: z4.number().int().min(0),
  });

  // On Zod 3, zod-to-json-schema extracts all properties and constraints
  const json3 = zodToJsonSchema(schema3, { target: "jsonSchema7" }) as any;
  assert(json3.properties !== undefined, "Zod 3 json schema has properties");
  assertEquals(json3.properties.action.type, "string");
  assertEquals(json3.properties.action.minLength, 1);
  assertEquals(json3.properties.count.type, "integer");
  assertEquals(json3.properties.count.minimum, 0);
  assertEquals(json3.additionalProperties, false);

  // On Zod 4, zod-to-json-schema fails to recognize _zod.def.type, emitting an EMPTY schema
  const json4 = zodToJsonSchema(schema4, { target: "jsonSchema7" }) as any;
  assertEquals(json4.properties, undefined, "Zod 4 json schema has NO properties via zod-to-json-schema");
  assertEquals(json4.type, undefined, "Zod 4 json schema has NO type via zod-to-json-schema");
  assertEquals(Object.keys(json4), ["$schema"], "Only $schema survives — all schema properties dropped");
});

Deno.test("mcp-zod-peer-parity: toJsonSchemaCompat routes correctly but reveals Zod 4 mini constraint drops", () => {
  const schema3 = z3.object({
    query: z3.string().min(3).max(50).describe("Search query"),
    limit: z3.number().int().min(1).max(100),
  });
  const schema4 = z4.object({
    query: z4.string().min(3).max(50).describe("Search query"),
    limit: z4.number().int().min(1).max(100),
  });

  // Zod 3 route: uses vendored zod-to-json-schema
  const json3 = toJsonSchemaCompat(schema3, { target: "draft-7" }) as any;
  assertEquals(json3.properties.query.minLength, 3);
  assertEquals(json3.properties.query.maxLength, 50);
  assertEquals(json3.properties.query.description, "Search query");
  assertEquals(json3.properties.limit.type, "integer");
  assertEquals(json3.properties.limit.minimum, 1);
  assertEquals(json3.properties.limit.maximum, 100);

  // Zod 4 route: uses z4mini.toJSONSchema from zod@3.25.76/v4-mini
  // In early v4-mini, constraint checks (minLength, maxLength, description, min, max) are dropped
  const json4 = toJsonSchemaCompat(schema4, { target: "draft-7" }) as any;
  assertEquals(json4.properties.query.type, "string");
  assertEquals(json4.properties.query.minLength, undefined); // DROPPED by v4-mini
  assertEquals(json4.properties.query.maxLength, undefined); // DROPPED by v4-mini
  assertEquals(json4.properties.limit.type, "number"); // emitted as generic number, not integer
  assertEquals(json4.properties.limit.minimum, undefined); // DROPPED by v4-mini
  assertEquals(json4.properties.limit.maximum, undefined); // DROPPED by v4-mini
});

Deno.test("mcp-zod-peer-parity: MCP Server tool registration wire schema preserves Zod 3 constraints", () => {
  const server = new McpServer({ name: "cap-test-server", version: "1.0.0" });

  server.tool(
    "z3Tool",
    "A tool defined with Zod 3",
    {
      keyword: z3.string().min(2).max(20),
      depth: z3.number().int().min(1),
    },
    async (args) => ({ content: [{ type: "text", text: `ok:${args.keyword}` }] }),
  );

  server.tool(
    "z4Tool",
    "A tool defined with Zod 4",
    {
      keyword: z4.string().min(2).max(20),
      depth: z4.number().int().min(1),
    },
    async (args) => ({ content: [{ type: "text", text: `ok:${args.keyword}` }] }),
  );

  const t3 = server._registeredTools["z3Tool"];
  const t4 = server._registeredTools["z4Tool"];

  const wire3 = toJsonSchemaCompat(t3.inputSchema) as any;
  const wire4 = toJsonSchemaCompat(t4.inputSchema) as any;

  // Zod 3 wire schema retains full boundaries
  assertEquals(wire3.properties.keyword.minLength, 2);
  assertEquals(wire3.properties.keyword.maxLength, 20);
  assertEquals(wire3.properties.depth.type, "integer");

  // Zod 4 wire schema under current v4-mini bindings drops constraints
  assertEquals(wire4.properties.keyword.minLength, undefined);
  assertEquals(wire4.properties.depth.type, "number");

  // CAP compiles JSON schemas back to Zod 3 via compileSchemaToZod
  const compiledFromWire3 = compileSchemaToZod(z3, wire3);
  assertEquals(compiledFromWire3.fatal, null);
  assertEquals(compiledFromWire3.zodSchema.safeParse({ keyword: "k", depth: 1 }).success, false); // minLength: 2 fails
  assertEquals(compiledFromWire3.zodSchema.safeParse({ keyword: "key", depth: 1 }).success, true);
});

Deno.test("mcp-zod-peer-parity: each installed peer-context contributes exactly 177 bytes across 3 converter files", async () => {
  // Measure the ACTUAL SW bundle, not the dependency's on-disk size. An npm-only
  // install resolves one converter at node_modules/ (3 files / 177 bytes). The
  // fleet-deps/Deno installation resolves two locked 3.25.2 peer contexts in
  // node_modules/.deno (6 files / 354 bytes). Each context must contribute
  // Options.js=83, index.js=0, parsers/string.js=94 — independently count
  // installed contexts instead of blessing either arbitrary bundle output.
  // The azlc audit's earlier 2,460 included scaffold files retained by an old
  // process.env define; 3337 removed those.
  const { build, stop } = await import("npm:esbuild@0.25.12");
  const path = await import("node:path");
  const { browserDependencies, browserProcessEnvOptions } = await import("../scripts/browser-dependencies.mjs");

  try {
    const res = await build({
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome120",
      entryPoints: [path.join(Deno.cwd(), "extension/background/service-worker.js")],
      write: false,
      metafile: true,
      plugins: [browserDependencies],
      define: {
        ...browserProcessEnvOptions.define,
        __CAP_BUILD_LOG_DEFAULT__: JSON.stringify("off"),
      },
      banner: browserProcessEnvOptions.banner,
    });

    let emittedBytes = 0;
    let emittedFiles = 0;
    const contributions = [];
    for (const outData of Object.values(res.metafile.outputs)) {
      if (outData.inputs) {
        for (const [inPath, inData] of Object.entries(outData.inputs)) {
          if (inPath.includes("zod-to-json-schema")) {
            emittedBytes += inData.bytesInOutput;
            emittedFiles += 1;
            contributions.push(inData.bytesInOutput);
          }
        }
      }
    }

    const sdkPath = await Deno.realPath(path.join(Deno.cwd(), "node_modules/@modelcontextprotocol/sdk"));
    const denoLayout = sdkPath.includes("/node_modules/.deno/");
    const contextNames = [];
    if (denoLayout) {
      for await (const entry of Deno.readDir(path.join(Deno.cwd(), "node_modules/.deno"))) {
        if (entry.isDirectory && /^zod-to-json-schema@3\.25\.2(?:_\d+)?$/.test(entry.name)) contextNames.push(entry.name);
      }
      assertEquals(contextNames.sort(), ["zod-to-json-schema@3.25.2", "zod-to-json-schema@3.25.2_1"],
        "the locked Deno installation has exactly two converter peer contexts");
    }
    const copies = denoLayout ? contextNames.length : 1;
    // Keep file-count, byte-total AND per-file pins; a changed converter, a
    // missing context or an extra duplicate cannot hide behind equal totals.
    assertEquals(emittedFiles, 3 * copies, "exact converter file count for installed peer contexts");
    assertEquals(emittedBytes, 177 * copies, "exact emitted converter bytes for installed peer contexts");
    assertEquals(
      contributions.sort((a, b) => a - b),
      Array.from({ length: copies }, () => [0, 83, 94]).flat().sort((a, b) => a - b),
      "per-file converter contributions (equal-and-opposite edits cannot cancel out)",
    );
  } finally {
    await stop();
  }
});

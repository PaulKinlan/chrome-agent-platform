// tests/tool-descriptions.test.ts — Quality, element coverage, and jargon absence
// assertions for bundled Wasm tool descriptions and Unix-first naming
// (CAP-FB-20260823-TOOL-DESCRIPTION-QUALITY-01 & CAP-FB-20260823-TOOL-NAMING-01).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { AGENT_DESCRIPTIONS } from "../scripts/build-bundled-tool-packages.mjs";

const FORBIDDEN_JARGON_PATTERNS = Object.freeze([
  "tomlc99",
  "cmark",
  "zlib",
  "minigzip",
  "amalgamation",
  "blessing",
  "CAP-authored",
]);

Deno.test("tool naming & descriptions: all 38 tools have Unix-name displayName and lead with '<toolname> - '", () => {
  assertEquals(
    BUNDLED_TOOL_PACKAGE_ROWS.length,
    38,
    "exact 38 bundled tool rows",
  );
  assertEquals(
    Object.keys(AGENT_DESCRIPTIONS).length,
    38,
    "exact 38 agent descriptions",
  );

  for (const row of BUNDLED_TOOL_PACKAGE_ROWS) {
    const { toolId, displayName, description, canonicalNameClaim } = row;
    assert(description, `Tool ${toolId} must have a non-empty description`);

    // Rule (1): displayName = exactly the Unix tool name (matches toolId)
    assertEquals(
      displayName,
      toolId,
      `Tool ${toolId} displayName must equal toolId`,
    );

    // Rule (2): description starts with "<toolId> - "
    assert(
      description.startsWith(`${toolId} - `),
      `Tool ${toolId} description must start with '${toolId} - ' (got: ${description})`,
    );

    // Rule (5): canonicalNameClaim stays false
    assertEquals(
      canonicalNameClaim,
      false,
      `Tool ${toolId} canonicalNameClaim must remain false`,
    );

    // Rule (6): <= 256 bytes and printable ASCII
    assert(
      description.length >= 20 && description.length <= 256,
      `Tool ${toolId} description length (${description.length}) must be between 20 and 256 bytes`,
    );
    assert(
      /^[\x20-\x7e]+$/.test(description),
      `Tool ${toolId} description must contain only printable ASCII characters`,
    );

    // Rule (2 & 3): Has short when-to-use
    assert(
      description.includes("Use ") || description.includes("use "),
      `Tool ${toolId} description must specify when to choose/use it ("Use ...")`,
    );

    // Jargon check: no internal implementation details or verbose "Bounded ..." prefix
    for (const jargon of FORBIDDEN_JARGON_PATTERNS) {
      assert(
        !description.toLowerCase().includes(jargon.toLowerCase()),
        `Tool ${toolId} description must not contain implementation jargon "${jargon}"`,
      );
    }
  }
});

Deno.test("tool descriptions: natural query vocabulary appears organically in functional text", () => {
  const diff = AGENT_DESCRIPTIONS.diff;
  const patch = AGENT_DESCRIPTIONS.patch;
  assert(diff.includes("diff"), "diff description must include 'diff'");
  assert(diff.includes("file"), "diff description must include 'file'");
  assert(
    diff.includes("editing"),
    "diff description must include progressive 'editing'",
  );
  assert(
    diff.includes("compare") || diff.includes("comparing"),
    "diff description must include 'compare/comparing'",
  );
  assert(
    patch.includes("patch") || patch.includes("patches"),
    "patch description must include 'patch/patches'",
  );
  assert(
    patch.includes("editing"),
    "patch description must include progressive 'editing'",
  );
  assert(patch.includes("files"), "patch description must include 'files'");

  const md5 = AGENT_DESCRIPTIONS.md5sum;
  const sha256 = AGENT_DESCRIPTIONS.sha256sum;
  const sha512 = AGENT_DESCRIPTIONS.sha512sum;
  assert(md5.includes("hash"), "md5sum description must include 'hash'");
  assert(sha256.includes("hash"), "sha256sum description must include 'hash'");
  assert(sha512.includes("hash"), "sha512sum description must include 'hash'");

  const grep = AGENT_DESCRIPTIONS.grep;
  assert(grep.includes("search"), "grep description must include 'search'");
  assert(grep.includes("find"), "grep description must include 'find'");

  const gzip = AGENT_DESCRIPTIONS.gzip;
  assert(gzip.includes("compress"), "gzip description must include 'compress'");
  assert(
    gzip.includes("decompress"),
    "gzip description must include 'decompress'",
  );

  const trunc = AGENT_DESCRIPTIONS.truncate;
  assert(
    trunc.includes("resize"),
    "truncate description must include 'resize'",
  );
  assert(
    trunc.includes("editing"),
    "truncate description must include 'editing'",
  );

  const csv = AGENT_DESCRIPTIONS.csvtool;
  assert(
    csv.includes("spreadsheet"),
    "csvtool description must include 'spreadsheet'",
  );
  assert(csv.includes("table"), "csvtool description must include 'table'");
  assert(csv.includes("editing"), "csvtool description must include 'editing'");

  const sql = AGENT_DESCRIPTIONS.sqlite3_query_bounded;
  assert(sql.includes("SQL"), "sqlite3 description must include 'SQL'");
  assert(sql.includes("search"), "sqlite3 description must include 'search'");
  assert(sql.includes("filter"), "sqlite3 description must include 'filter'");
});

Deno.test("manifest descriptions: all 38 manifests contain matching agent-useful descriptions", async () => {
  for (const row of BUNDLED_TOOL_PACKAGE_ROWS) {
    const manifestPath = new URL(`../${row.manifestRef}`, import.meta.url);
    const manifestText = await Deno.readTextFile(manifestPath);
    const manifest = JSON.parse(manifestText);

    assertEquals(
      manifest.meta?.description,
      row.description,
      `Manifest ${row.manifestRef} description must match descriptor row description`,
    );
  }
});

// CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01 — models copy enum values
// from the tool text; prose like `type: html|text|json` produced "text/html".
// Both the description and the schemaSummary must state enums as quoted
// literals the model can paste verbatim.
Deno.test("schemaSummary renders enums as quoted literals", async () => {
  const { managementToolset } = await import(
    "../extension/lib/management-tools.js"
  );
  const { summarizeToolSchema } = await import(
    "../extension/lib/tool-catalog.js"
  );
  const tools = managementToolset(async () => ({ ok: true }));
  for (const name of ["create_asset", "update_asset"]) {
    const summary = summarizeToolSchema(
      tools[name].inputSchema,
      "extension-builtin",
      name,
    );
    assert(
      summary.includes('"enum":["html","text","json","image","data"]'),
      `${name} schemaSummary carries the quoted enum: ${summary.slice(0, 200)}`,
    );
    assert(
      !summary.includes("text/html"),
      `${name} never mentions a MIME type`,
    );
  }
  const description = String(tools.create_asset.description);
  assert(
    description.includes('type: "html" | "text" | "json" | "image" | "data"'),
    `create_asset description states the enum as quoted literals: ${description}`,
  );
  assert(
    !/type: html\|text\|json/.test(description),
    "the unquoted prose form is gone",
  );
});

// chrome-agent-platform-i1i9 — the import at the top of this file must be a DATA read.
//
// It used to run the whole generator: the generation work sat at module top level and the
// file's `isMain` flag gated only the final `process.exit`, so loading this file rewrote all
// 38 files in extension/wasm/cas. Measured before the fix, on this tree: a fresh-process
// import printed `OK: 38 packages, 111 shipped files, 38 manifest identities` and moved the
// per-file mtime fingerprint of that directory. That made this file SERIAL (chrome-agent-
// platform-4lc0), because a parallel-phase reader raced a CAS file being replaced.
//
// FAILS CLOSED BY CONSTRUCTION: the probe child gets read and env permission ONLY, never
// write. So if generation ever moves back to module top level, its first write cannot happen
// — the child exits non-zero and this test goes red — instead of quietly rewriting a tree
// another lane is reading. The fingerprint is the belt behind that buckle; the stdout
// assertion catches a future regression that generates into memory and writes nothing.
Deno.test("tool naming & descriptions: importing the bundled-tool generator writes nothing (chrome-agent-platform-i1i9)", async () => {
  const generator =
    new URL("../scripts/build-bundled-tool-packages.mjs", import.meta.url).href;
  const casRoot = new URL("../extension/wasm/cas/", import.meta.url);

  async function fingerprint(): Promise<string> {
    const rows: string[] = [];
    async function walk(dir: URL) {
      for await (const ent of Deno.readDir(dir)) {
        const child = new URL(
          `${dir.href}${ent.name}${ent.isDirectory ? "/" : ""}`,
        );
        if (ent.isDirectory) await walk(child);
        else rows.push(`${ent.name}@${(await Deno.stat(child)).mtimeMs}`);
      }
    }
    await walk(casRoot);
    return rows.sort().join("\n");
  }

  const before = await fingerprint();
  const script =
    `const mod = await import(${JSON.stringify(generator)});\n` +
    `console.log("EXPORTS:" + Object.keys(mod).sort().join(","));\n` +
    `console.log("DESCRIPTIONS:" + Object.keys(mod.AGENT_DESCRIPTIONS ?? {}).length);\n`;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-env", "--ext=js", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const run = await child.output();

  const stdout = new TextDecoder().decode(run.stdout);
  const stderr = new TextDecoder().decode(run.stderr);
  assertEquals(
    run.code,
    0,
    `a no-write import of the generator must succeed:\n${stdout}\n${stderr}`,
  );
  assert(
    !/\bOK: \d+ packages/m.test(stdout),
    `importing ran the generator: ${stdout}`,
  );
  assert(
    !/\bVERIFY OK:/m.test(stdout),
    `importing ran the generator's verify pass: ${stdout}`,
  );
  assertEquals(
    stdout.trim(),
    "EXPORTS:AGENT_DESCRIPTIONS\nDESCRIPTIONS:38",
    "the pure surface is the one data export, and all 38 descriptions survive",
  );
  assertEquals(
    await fingerprint(),
    before,
    "importing the generator changed extension/wasm/cas — it is a generator, not a library",
  );
});

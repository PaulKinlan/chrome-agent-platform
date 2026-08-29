// @ts-nocheck
// Durable-evidence migration + /tmp scrub (owner directive, 0.2.194):
// (1) no shipped or committed TEXT artifact references paths outside the
//     source tree (/tmp, /home/<user>); (2) full regeneration verification
//     passes on a pristine fresh-checkout materialization with NO /tmp
//     evidence present — the evidence lives in the repo now.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { join, relative } from "jsr:@std/path";

const ROOT = new URL("..", import.meta.url).pathname;
const GENERATOR = `${ROOT}scripts/build-bundled-tool-packages.mjs`;
const decoder = new TextDecoder();
function run(cmd, args, opts = {}) {
  const out = new Deno.Command(cmd, { args, cwd: ROOT, stdout: "piped", stderr: "piped", ...opts }).outputSync();
  return { code: out.code, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

function* walk(dir: string): Generator<string> {
  for (const ent of Deno.readDirSync(dir)) {
    const p = join(dir, ent.name);
    if (ent.isDirectory) yield* walk(p);
    else yield p;
  }
}

// Pinned .wasm binaries (CAS + migrated evidence) embed inert build-host path
// strings from their original compilation; they are hash-pinned IMMUTABLE
// inputs/outputs. The exemption is hash-listed so any NEW offender fails.
const WASM_EXEMPTIONS = new Set([
  "6119489ddf0cb9648a4ac87b943108f850be3e3b637cea6c478bf7ec1bf6432a", // cas toml2json
  "c149a61938bae19b5062f976b80e092729085564e0e1a31700704534043baf91", // cas markdown
]);
const EVIDENCE_WASM_EXEMPTIONS = new Set([
  "packages/bundled/evidence/b2/binaries/toml2json.wasm",
  "packages/bundled/evidence/c2/binaries/markdown.wasm",
  "packages/bundled/evidence/sqlite3/dist/sqlite3-query-bounded.wasm",
]);

Deno.test("no text artifact references paths outside the source tree (/tmp, /home)", async () => {
  const offenders: string[] = [];
  const roots = ["extension/wasm", "extension/lib", "packages/bundled"];
  const TEXT = /\.(json|txt|md|sh|c|mjs|js)$/;
  for (const root of roots) {
    for (const abs of walk(join(ROOT, root))) {
      const rel = relative(ROOT, abs);
      if (rel.endsWith(".wasm")) {
        if (!rel.includes("/tmp") && !EVIDENCE_WASM_EXEMPTIONS.has(rel)) {
          const sha = await crypto.subtle.digest("SHA-256", await Deno.readFile(abs));
          const hex = [...new Uint8Array(sha)].map((b) => b.toString(16).padStart(2, "0")).join("");
          if (!WASM_EXEMPTIONS.has(hex)) {
            const bytes = await Deno.readFile(abs);
            if (new TextDecoder().decode(bytes).match(/\/tmp\/|\/home\//)) offenders.push(`wasm ${rel} (unlisted sha ${hex.slice(0, 12)})`);
          }
        }
        continue;
      }
      if (!TEXT.test(rel)) continue;
      const text = new TextDecoder().decode(await Deno.readFile(abs));
      for (const m of text.matchAll(/\/tmp\/[^\s"')]*|\/home\/[^\s"')]+/g)) offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assertEquals(offenders, [], "outside-tree path references found");
});

Deno.test("fresh-checkout: FULL verify (not fallback) passes on a pristine tree materialization with no /tmp evidence", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    // materialize tracked files + the (pre-commit, untracked) evidence tree
    const ls = run("git", ["-C", ROOT, "ls-files"]);
    assertEquals(ls.code, 0, ls.stderr);
    const files = ls.stdout.split("\n").filter(Boolean);
    files.push(...[...walk(join(ROOT, "packages/bundled/evidence"))].map((p) => relative(ROOT, p)));
    for (const rel of files) {
      const dst = join(tmp, rel);
      Deno.mkdirSync(join(dst, ".."), { recursive: true });
      Deno.copyFileSync(join(ROOT, rel), dst);
    }
    const r = run("node", [join(tmp, "scripts/build-bundled-tool-packages.mjs"), "--verify"], { cwd: tmp });
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.stdout, "VERIFY OK: 95 generated files byte-identical");
    if (r.stderr.includes("self-consistency fallback") || r.stdout.includes("self-consistency fallback")) {
      throw new Error("fresh checkout fell back to degraded verify — migration incomplete");
    }
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

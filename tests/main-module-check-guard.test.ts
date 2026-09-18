// tests/main-module-check-guard.test.ts — bead chrome-agent-platform-esh8.
//
// Invariant: a script decides "am I the entry point?" by comparing the SAME
// encoding on both sides. `import.meta.url` is percent-encoded; a raw template
// built from `process.argv[1]` is not. On a checkout whose path
// contains a space or non-ASCII character the two never match, the main block
// never runs, and the process exits 0 having done nothing — measured on
// `scripts/check-reachability.mjs`, which exited 0 with empty output under
// ".../spaced probe/cap checkout" while printing its build assertion at an
// ASCII path (e273 finding, 2026-09-18).
//
// Sanctioned forms: `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`
// (node scripts) and `import.meta.main` (deno-only scripts). The detector below
// is assembled at runtime so this file's own text never matches it.
//
// Falsification: restore a raw file-URL entry-point gate in any scripts/ or
// tests/ module -> RED naming file:line; remove it -> GREEN.
// The encoding control goes red if the two sides are compared as strings.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["scripts", "tests"];
const EXTENSIONS = [".ts", ".mjs", ".js"];
const RAW_GATE = new RegExp("file://\\$\\{" + "process\\.argv" + "\\[1\\]" + "\\}", "g");

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const ent of Deno.readDir(dir)) {
    const p = `${dir}/${ent.name}`;
    if (ent.isDirectory) out.push(...(await filesUnder(p)));
    else if (EXTENSIONS.some((ext) => ent.name.endsWith(ext))) out.push(p);
  }
  return out;
}

Deno.test("esh8: the entry-point comparison matches the encoded import.meta.url", () => {
  // A path with a space: the raw template and the URL are different strings,
  // and pathToFileURL is the one that agrees with import.meta.url.
  const spaced: string = "/home/cap esh8 probe/scripts/x.mjs";
  const url: string = "file:///home/cap%20esh8%20probe/scripts/x.mjs";
  assertEquals(pathToFileURL(spaced).href, url, "pathToFileURL encodes a spaced path exactly as import.meta.url carries it");
  assert(
    `file://${spaced}` !== url,
    "the raw template is NOT the same encoding — comparing it to import.meta.url is the esh8 defect",
  );
});

Deno.test("esh8: no raw file-URL entry-point check under scripts/ or tests/", async () => {
  const files = (await Promise.all(SCAN_DIRS.map(filesUnder))).flat().sort();
  assert(files.length > 150, `scanned only ${files.length} files under ${SCAN_DIRS.join(" + ")} — the scan is broken`);
  const hits: string[] = [];
  for (const rel of files) {
    const lines = (await Deno.readTextFile(rel)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (RAW_GATE.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        RAW_GATE.lastIndex = 0;
      }
    }
  }
  assertEquals(
    hits,
    [],
    `entry-point check compares a raw path to the percent-encoded import.meta.url — use pathToFileURL(process.argv[1]).href:\n${hits.join("\n")}`,
  );
});

Deno.test("esh8: the reachability CLI entry actually runs and scans", async () => {
  const out = await new Deno.Command("node", {
    args: ["scripts/check-reachability.mjs"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `node scripts/check-reachability.mjs exited ${out.code}:\n${text}`);
  const m = /build assertion: every one of (\d+) shipped source files is reached/.exec(text);
  assert(m, `the CLI gate did not run (no build assertion in output):\n${text}`);
  assert(Number(m[1]) > 0, `the CLI gate scanned ${m[1]} files — a green that proves nothing`);
});

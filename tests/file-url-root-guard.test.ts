// tests/file-url-root-guard.test.ts — bead chrome-agent-platform-e273.
//
// Invariant: no file under tests/ or scripts/ derives a filesystem path from a
// URL's `.pathname`. `new URL(rel, import.meta.url)` carries a PERCENT-ENCODED
// pathname, so on a checkout whose path contains a space or a non-ASCII
// character the derived root names a directory that is not on disk — the
// 54k5/h8rb/woem family: a root that is not the tree under test. Every
// affected file then fails as a file-not-found SETUP error (or, worse,
// silently scans an empty tree) instead of reaching its real assertion.
//
// The sweep that landed with this guard rewrote every live occurrence to
// `fileURLToPath(new URL(rel, import.meta.url))` and added the `node:url`
// import. `tests/substring-pin-honesty.test.ts` keeps the old shape in prose
// and in two template-literal ANALYZER FIXTURES on purpose — those are inputs
// to a text recognizer, not path derivations, and are excluded by the
// code-only scan below.
//
// Falsification: plant `const ROOT = new URL("..", import.meta.url).pathname;`
// as live code in any tests/ or scripts/ file; this guard goes RED naming
// file:line. Remove it; GREEN. (The planted file is the control, not this
// file's own detector text — the detectors are assembled and the scan masks
// strings/comments, so the guard's own source cannot match itself.)
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

// The guarded form itself: decoded, not percent-encoded.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["tests", "scripts"];
const EXTENSIONS = [".ts", ".mjs", ".js"];
const HAZARD = new RegExp(
  "new URL\\(" + "[^\\n]*?" + "import\\.meta" + "\\.url\\)" + "\\.pathname",
  "g",
);

// True when `index` sits in live code: not inside a string/template, not after
// a `//` comment. Template `${...}` interpolations are code again. Line-scoped:
// a multi-line template whose continuation line carries the shape would be
// flagged (fail closed — a false red, never a silent pass).
function isCodeAt(line: string, index: number): boolean {
  const stack: { type: string; quote?: string; depth: number }[] = [{ type: "code", depth: 0 }];
  for (let i = 0; i < index; i++) {
    const c = line[i];
    const top = stack[stack.length - 1];
    if (top.type === "string") {
      if (c === "\\") i++;
      else if (c === top.quote) stack.pop();
    } else if (top.type === "template") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && line[i + 1] === "{") {
        stack.push({ type: "code", depth: 0 });
        i++;
      }
    } else if (top.type === "comment") {
      // runs to end of line
    } else if (c === "/" && line[i + 1] === "/") {
      stack.push({ type: "comment", depth: 0 });
      i++;
    } else if (c === "'" || c === '"') {
      stack.push({ type: "string", quote: c, depth: 0 });
    } else if (c === "`") {
      stack.push({ type: "template", depth: 0 });
    } else if (c === "{") {
      top.depth++;
    } else if (c === "}") {
      if (top.depth > 0) top.depth--;
      else if (stack.length > 1) stack.pop();
    }
  }
  return stack[stack.length - 1].type === "code";
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const ent of Deno.readDir(dir)) {
    const p = `${dir}/${ent.name}`;
    if (ent.isDirectory) out.push(...(await filesUnder(p)));
    else if (EXTENSIONS.some((ext) => ent.name.endsWith(ext))) out.push(p);
  }
  return out;
}

Deno.test("e273: no test or harness derives a filesystem root from a URL pathname", async () => {
  const files = (await Promise.all(SCAN_DIRS.map(filesUnder))).flat().sort();
  // The scan itself must cover the tree: a wrong ROOT or a broken walk would
  // otherwise pass vacuously — the exact failure mode this guard exists for.
  assert(
    files.length > 150,
    `scanned only ${files.length} files under ${SCAN_DIRS.join(" + ")} (ROOT=${ROOT}) — the scan is broken, not the tree`,
  );

  const hits: string[] = [];
  for (const rel of files) {
    const lines = (await Deno.readTextFile(rel)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(HAZARD)) {
        if (isCodeAt(lines[i], m.index)) hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  assertEquals(
    hits,
    [],
    `filesystem path derived from a percent-encoded URL pathname — use fileURLToPath(new URL(rel, import.meta.url)):\n${hits.join("\n")}`,
  );
});

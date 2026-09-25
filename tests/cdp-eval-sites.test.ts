// kwrx P2 — the count cannot silently regrow. 8ko7: count READ SITES, not files.
//
// A file under scripts/ that calls Runtime.evaluate AND reads a value back must not swallow a
// page-side throw. The first version of this guard marked a whole file HANDLED when it merely
// MENTIONED exceptionDetails|cdp-eval anywhere, so:
//   - a migrated file could add a NEW raw read elsewhere and pass CI;
//   - 11 genuinely raw reads in four files rode behind unrelated mentions — chrome-journeys x8
//     (its evalIn/evalX helpers, and the file does not import the helper at all; the mention was
//     in a Runtime.exceptionThrown handler), agent-provider-picker, kat-browser-tool-proxy and
//     read-page-host-grant-acceptance (tracked as 0aeh).
//
// A site is one value-read pattern occurrence. It is permitted when it is SELF-GUARDING — an
// exceptionDetails check appears between the nearest preceding Runtime.evaluate and the read —
// or explicitly listed below with a reason. scripts/lib/cdp-eval.ts is excluded by exact path,
// never by keyword: it is where the guarded read lives.
//
// Re-measured on 566a2d39a: 31 files / 42 sites, 30 self-guarding, 12 permitted below.
// Removing a raw read shrinks its permit in the same commit (stale permits fail); adding one
// fails by file:line.
import { assert, assertEquals } from "jsr:@std/assert";

const EVAL = /Runtime\.evaluate/;
const VALUE_READ = /\.result\??\.value\b|\.result\.result\??\.value\b|\bresult\?\.value\b/;
const GUARD = /exceptionDetails/;
const HELPER_PATH = "scripts/lib/cdp-eval.ts";
const LOOKBACK_LINES = 80;

// Raw value-read sites deliberately retained, per file. The 0aeh migration gaps are all
// routed; the single remaining entry is a pattern false positive. Extend ONLY with a
// written reason; shrink in the same commit that removes a raw read.
const PERMITTED_RAW_READS: Record<string, { sites: number; reason: string }> = {
  "scripts/kat-composer-slash-commands.ts": {
    sites: 1,
    reason: "not a CDP read: result?.value is a browser-tool result passed to check(), not a Runtime.evaluate value (pattern match only)",
  },
};

// Remove comments but keep every newline (line numbers must match the file) and keep the inside
// of strings opaque, so a URL's `//` is not mistaken for a comment.
function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1] ?? "";
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; i++; continue; }
      if (c === "/" && next === "*") { state = "block"; i++; continue; }
      if (c === "'" || c === '"' || c === "`") { state = "string"; quote = c; }
      out += c;
    } else if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
    } else if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; i++; continue; }
      if (c === "\n") out += c;
    } else {
      out += c;
      if (c === "\\") { out += next; i++; continue; }
      if (c === quote) state = "code";
    }
  }
  return out;
}

interface ReadSite {
  line: number;
  guarded: boolean;
}

function readSites(source: string): ReadSite[] {
  const lines = stripComments(source).split("\n");
  const sites: ReadSite[] = [];
  lines.forEach((line, index) => {
    if (!VALUE_READ.test(line)) return;
    let guarded = false;
    for (let i = index; i >= Math.max(0, index - LOOKBACK_LINES); i--) {
      if (!EVAL.test(lines[i])) continue;
      guarded = GUARD.test(lines.slice(i, index + 1).join("\n"));
      break;
    }
    sites.push({ line: index + 1, guarded });
  });
  return sites;
}

async function scan(root = "scripts"): Promise<Map<string, ReadSite[]>> {
  const found = new Map<string, ReadSite[]>();
  const visit = async (path: string) => {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(child);
      } else if (entry.isFile && entry.name.endsWith(".ts") && child !== HELPER_PATH) {
        const source = stripComments(await Deno.readTextFile(child));
        if (!EVAL.test(source)) continue; // a value read in a file with no evaluate is not a CDP read
        const sites = readSites(source);
        if (sites.length > 0) found.set(child, sites);
      }
    }
  };
  await visit(root);
  return found;
}

Deno.test({
  name: "kwrx guard: every raw value-read site is self-guarding or explicitly permitted (by file:line)",
  fn: async () => {
    const scanned = await scan();
    const failures: string[] = [];

    for (const [file, sites] of [...scanned].sort()) {
      const raw = sites.filter((site) => !site.guarded);
      const permit = PERMITTED_RAW_READS[file];
      if (!permit) {
        if (raw.length > 0) {
          failures.push(
            `${file}: ${raw.length} raw value-read site(s) with no exceptionDetails check and no permit — ` +
              `at ${raw.map((s) => `${file}:${s.line}`).join(", ")}`,
          );
        }
        continue;
      }
      if (raw.length > permit.sites) {
        failures.push(
          `${file}: ${raw.length} raw sites but only ${permit.sites} permitted — ` +
            raw.map((s) => `${file}:${s.line}`).join(", "),
        );
      }
      if (raw.length < permit.sites) {
        failures.push(`${file}: ${permit.sites} raw sites permitted but only ${raw.length} remain — shrink the permit in the same commit`);
      }
    }
    for (const file of Object.keys(PERMITTED_RAW_READS)) {
      if (!scanned.has(file)) failures.push(`${file}: permit names a file with no value-read sites — remove it`);
    }
    // A permit is a review decision; an empty reason cannot carry one (sotw-gemini review of
    // 8ko7 @ 56f7f7b70).
    for (const [file, permit] of Object.entries(PERMITTED_RAW_READS)) {
      if (permit.reason.trim().length === 0) {
        failures.push(`${file}: permit has no reason — every retained raw read states WHY in the guard`);
      }
    }
    assertEquals(failures, [], failures.join("\n"));
  },
});

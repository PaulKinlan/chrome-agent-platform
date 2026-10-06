// tests/chrome-profile-static.test.ts — the browser-free static half of chrome-agent-platform-9t1b,
// split out by kz27 so it can be an ALWAYS-ON guard.
//
// WHY A SPLIT AND NOT AN ALWAYS-ON ENTRY FOR THE ORIGINAL FILE: docs/CHROME-TEST-CONTRACT.md §2.3
// PROMISES that a subset gate launches a real browser only when `tests/chrome-profile-location.test.ts`
// or its dependencies change. That file contains the live race test ("a REAL browser holds its profile
// while the whole tree is copied"), so making it always-on would break a documented, fleet-wide
// contract — a subset gate on any VM would require a working browser. The cross-cutting value, though,
// is in the STATIC scan: it reads tracked source as data, so it has no import edges and no subset gate
// can see it unless it is always-on. Splitting gives both: the scan is always-on, the live race test
// stays where §2.3 says it is and runs in the full suite.
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const SCRIPTS = `${ROOT}/scripts`;

function scriptFiles(dir = SCRIPTS, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.isDirectory) out.push(...scriptFiles(`${dir}/${e.name}`, `${prefix}${e.name}/`));
    else if (/\.(ts|mjs)$/u.test(e.name)) out.push(`${prefix}${e.name}`);
  }
  return out;
}

function scanScriptProfileSites(src: string, rel: string): { sites: number; offenders: string[] } {
  // Expand variable bindings (`const OUT = Deno.args[1] ?? `${ROOT}.cache/…``)
  // before checking whether `--user-data-dir=` is repo-relative, so indirection
  // through `${OUT}` or `${PROFILE_DIR}` cannot hide a repo-resident profile (dz08).
  const decls = new Map<string, string>();
  for (
    const m of src.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*([^\n;]+(?:(?:\?\?|\|\||\?|:|\+)\s*\n\s*[^\n;]+)*)/gu,
    )
  ) {
    decls.set(m[1], m[2].trim());
  }
  const expand = (expr: string, seen = new Set<string>()): string => {
    const step = expr.replace(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/gu, (full, ident: string) => {
      if (seen.has(ident) || !decls.has(ident)) return full;
      const next = new Set(seen);
      next.add(ident);
      return expand(decls.get(ident)!, next);
    });
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(step) && !seen.has(step) && decls.has(step)) {
      const next = new Set(seen);
      next.add(step);
      return expand(decls.get(step)!, next);
    }
    return step;
  };
  const isRepoRelativeExpr = (expr: string): boolean =>
    expr.includes("${ROOT}") ||
    expr.includes("ROOT}") ||
    expr.includes("import.meta.url") ||
    /^\.\.?\//u.test(expr) ||
    /(?:^|[`'"])\.\.?\//u.test(expr);

  const offenders: string[] = [];
  let sites = 0;
  src.split("\n").forEach((line, i) => {
    const at = line.indexOf("--user-data-dir=");
    if (at < 0) return;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    sites++;
    const value = line.slice(at + "--user-data-dir=".length)
      .split(/[`'"]/u)[0].split(",")[0].replace(/[\s)\];]+$/u, "").trim();
    const expanded = expand(value);
    if (isRepoRelativeExpr(value) || isRepoRelativeExpr(expanded)) {
      offenders.push(
        `${rel}:${i + 1} → ${value}${expanded !== value ? ` (resolves to ${expanded})` : ""}`,
      );
    }
  });
  return { sites, offenders };
}

Deno.test("9t1b: no Chrome profile in scripts/ lives inside the repository", () => {
  // Every `--user-data-dir=` value, in every harness, must not be repo-relative
  // — directly or through variable indirection (`${OUT}`, `${PROFILE_DIR}`).
  // The repo-relative forms are the ones that race a copy: `${ROOT}.cache/…`,
  // anything derived from import.meta.url, and bare relative paths.
  const offenders: string[] = [];
  let sites = 0;
  for (const rel of scriptFiles()) {
    const scanned = scanScriptProfileSites(Deno.readTextFileSync(`${SCRIPTS}/${rel}`), rel);
    sites += scanned.sites;
    offenders.push(...scanned.offenders);
  }
  assert(sites >= 40, `the scan found the launch sites (${sites})`);
  assertEquals(
    offenders,
    [],
    "a Chrome profile still lives inside the repo — a whole-tree copy races a live browser " +
      "(cp: cannot stat '…/.cache/kat-*/Default/DIPS-journal'). Use chromeProfileDir() " +
      "from scripts/lib/chrome-profile-dir.ts:\n" + offenders.join("\n"),
  );
});

Deno.test("dz08: launch-site scan catches --user-data-dir indirection through ${OUT} and ${PROFILE_DIR}", () => {
  const indirectOut = [
    'const ROOT = fileURLToPath(new URL("..", import.meta.url));',
    'const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-agent-board`;',
    'await launchChrome({ args: [`--user-data-dir=${OUT}/profile-${Date.now()}`] });',
  ].join("\n");
  const r1 = scanScriptProfileSites(indirectOut, "kat-agent-board.ts");
  assertEquals(r1.sites, 1);
  assertEquals(r1.offenders.length, 1, "must flag --user-data-dir=${OUT}/profile when OUT defaults to ${ROOT}.cache/…");

  const twoHop = [
    'const ROOT = fileURLToPath(new URL("..", import.meta.url));',
    'const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-wasi-tranche2`;',
    'const PROFILE_DIR = `${OUT}/profile-${Date.now()}`;',
    'await launchChrome({ args: [`--user-data-dir=${PROFILE_DIR}`] });',
  ].join("\n");
  const r2 = scanScriptProfileSites(twoHop, "kat-wasi-tranche2.ts");
  assertEquals(r2.sites, 1);
  assertEquals(r2.offenders.length, 1, "must flag two-hop indirection (${PROFILE_DIR} -> ${OUT} -> ${ROOT})");

  const safeHelper = [
    'const ROOT = fileURLToPath(new URL("..", import.meta.url));',
    'const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-agent-board`;',
    'await launchChrome({ args: [`--user-data-dir=${chromeProfileDir("kat-agent-board")}`] });',
  ].join("\n");
  const r3 = scanScriptProfileSites(safeHelper, "kat-agent-board.ts");
  assertEquals(r3.sites, 1);
  assertEquals(r3.offenders, [], "chromeProfileDir() is outside the repo even when OUT is repo-relative");
});

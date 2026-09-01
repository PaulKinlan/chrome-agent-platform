// CAP-FB-20260830-ESCAPEHTML-SINGLE-SOURCE-01 — the grep guard that keeps the
// shared pure helpers SINGLE-SOURCED in extension/lib/pure.js.
//
// The hub and Settings each carried their own escapeHtml that did not escape
// the single quote, so any single-quoted attribute built with it was an XSS
// seam. The canonical escaper is the strict one; every page imports it. This
// test fails the moment a second definition of any helper in the family
// appears anywhere under extension/ (dist/ and vendored bundles excluded), a
// hand-rolled `${Date.now()}_${Math.random()}` id generator returns, or an
// inline `new Promise((r) => setTimeout(r, ms))` sleep is re-rolled.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../extension/", import.meta.url);
// Loaded dynamically so the grep guards below still run (and report the full
// inventory) when pure.js is missing one of the exports.
// deno-lint-ignore no-explicit-any
const pure: Record<string, any> = await import("../extension/lib/pure.js");
const CANONICAL_FILE = "lib/pure.js";

/** Paths (relative to extension/) that are build output or vendored bundles —
 * never hand-written product code, so never a duplicate we own. */
const EXCLUDED_PREFIXES = ["dist/", "dist-versions/", "wasm/", "lib/terser-bounded.worker.js"];

/** The helper family, one row per single-sourced helper: the canonical export
 * in pure.js and the alias names a re-rolled copy tends to pick. Each lane of
 * the migration appended its row here (escapeHtml → timeAgo → sha256Hex →
 * fnv1a → truncateUtf8 → ids → sleeps), so the guard grew with the tree. */
const FAMILIES: Array<{ canonical: string; aliases: string }> = [
  { canonical: "escapeHtml", aliases: "escapeHTML|escapeHtml\\w*" },
  { canonical: "timeAgo", aliases: "timeAgo\\w*" },
  { canonical: "sha256Hex", aliases: "sha256\\w*|digestBytes" },
  { canonical: "sha256HexBytes", aliases: "" },
  { canonical: "fnv1a", aliases: "fnv1a\\w*" },
  { canonical: "fnv1a64", aliases: "" },
  { canonical: "truncateUtf8", aliases: "truncateUtf8\\w*" },
  { canonical: "newId", aliases: "newId\\w*" },
  { canonical: "sleep", aliases: "sleep" },
];
const CANONICAL_NAMES = FAMILIES.map((f) => f.canonical);
const ALIAS_GROUP = FAMILIES.map((f) => f.aliases).filter(Boolean).join("|");
const ALIAS_RE = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+(${ALIAS_GROUP})\\s*\\(`, "gm");
const ARROW_ALIAS_RE = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${ALIAS_GROUP})\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>`, "gm");

/** Copies that CANNOT import a module and are therefore not drift: a classic
 * (non-module) content script has no import statement to point at pure.js. */
const ALLOWED_COPIES = new Set<string>([
  "content/bridge-auth.js:sha256Bytes", // plain script injected into both worlds — no modules there
  // tests/tabular-diff-artifacts.test.ts asserts the tabular pure core has NO
  // imports at all (its custody contract), so its ellipsis-truncation stays
  // local. It is byte-budget-equivalent to pure.js's truncateUtf8 for
  // well-formed input; the guard still fails on any THIRD copy.
  "lib/tabular-diff-artifacts-core.js:truncateUtf8",
]);

/** Which of the pattern guards below are armed (each lane armed its own). */
const GUARD_ID_GENERATORS = true;
const GUARD_INLINE_SLEEPS = true;

async function* walk(dir: URL, rel = ""): AsyncGenerator<[string, string]> {
  for await (const entry of Deno.readDir(dir)) {
    const relPath = rel + entry.name;
    if (EXCLUDED_PREFIXES.some((p) => relPath === p || relPath.startsWith(p))) continue;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* walk(url, relPath + "/");
    else if (entry.name.endsWith(".js")) yield [relPath, await Deno.readTextFile(url)];
  }
}

async function sources(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const [rel, text] of walk(ROOT)) out.set(rel, text);
  assert(out.has(CANONICAL_FILE), "pure.js must be in the walk");
  return out;
}

function definitionSites(text: string, name: string): number {
  const fn = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "gm");
  const arrow = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`, "gm");
  return (text.match(fn) ?? []).length + (text.match(arrow) ?? []).length;
}

Deno.test("single-source: each shared helper is defined exactly once, in lib/pure.js", async () => {
  const files = await sources();
  const failures: string[] = [];
  for (const name of CANONICAL_NAMES) {
    const sites: string[] = [];
    for (const [rel, text] of files) {
      if (ALLOWED_COPIES.has(`${rel}:${name}`)) continue;
      const n = definitionSites(text, name);
      for (let i = 0; i < n; i++) sites.push(rel);
    }
    if (sites.length !== 1 || sites[0] !== CANONICAL_FILE) {
      failures.push(`${name}: defined at [${sites.join(", ")}] — expected exactly once in ${CANONICAL_FILE}`);
    }
  }
  assertEquals(failures, [], failures.join("\n"));
});

Deno.test("single-source: no alias of a shared helper is defined outside lib/pure.js", async () => {
  const files = await sources();
  const offenders: string[] = [];
  for (const [rel, text] of files) {
    if (rel === CANONICAL_FILE) continue;
    for (const re of [ALIAS_RE, ARROW_ALIAS_RE]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        if (ALLOWED_COPIES.has(`${rel}:${m[1]}`)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line} defines ${m[1]}`);
      }
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test({ name: "single-source: no hand-rolled Date.now()+Math.random() id generator outside lib/pure.js", ignore: !GUARD_ID_GENERATORS, fn: async () => {
  const files = await sources();
  const offenders: string[] = [];
  for (const [rel, text] of files) {
    if (rel === CANONICAL_FILE) continue;
    text.split("\n").forEach((line, i) => {
      if (line.includes("Date.now()") && line.includes("Math.random()")) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assertEquals(offenders, [], offenders.join("\n"));
} });

Deno.test({ name: "single-source: no inline promise-wrapped setTimeout sleep outside lib/pure.js", ignore: !GUARD_INLINE_SLEEPS, fn: async () => {
  const files = await sources();
  const re = /new Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,/g;
  const offenders: string[] = [];
  for (const [rel, text] of files) {
    if (rel === CANONICAL_FILE) continue;
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
} });

Deno.test("single-source: components.js re-exports the canonical escapeHtml (the gallery import surface is unchanged)", async () => {
  const text = await Deno.readTextFile(new URL("shared/components.js", ROOT));
  assert(
    /export\s*\{[^}]*\bescapeHtml\b[^}]*\}\s*from\s*"\.\.\/lib\/pure\.js"/.test(text),
    "components.js must `export { escapeHtml } from \"../lib/pure.js\"`",
  );
  assertEquals(definitionSites(text, "escapeHtml"), 0, "components.js must not define its own escapeHtml");
});

Deno.test("single-source: the canonical escapeHtml is the strict one (escapes the single quote)", () => {
  const { escapeHtml } = pure;
  assert(typeof escapeHtml === "function", "pure.js exports escapeHtml");
  assertEquals(escapeHtml(`O'Brien "test" <b>&`), "O&#39;Brien &quot;test&quot; &lt;b&gt;&amp;");
  assertEquals(escapeHtml(null), "");
  assertEquals(escapeHtml(undefined), "");
  assertEquals(escapeHtml(42), "42");
  // A single-quoted attribute built with the escaper cannot be broken out of.
  const attr = `title='${escapeHtml("' onmouseover='alert(1)")}'`;
  assert(!attr.includes("' onmouseover='"), attr);
});

Deno.test("single-source: the collapsed helpers keep their semantics", async () => {
  const landed = new Set(CANONICAL_NAMES);
  for (const name of landed) assert(typeof pure[name] === "function", `pure.js exports ${name}`);
  if (landed.has("timeAgo")) {
    // timeAgo — the hub and the components module agreed on these buckets.
    const now = Date.now();
    assertEquals(pure.timeAgo(now), "just now");
    assertEquals(pure.timeAgo(now - 5 * 60_000), "5m ago");
    assertEquals(pure.timeAgo(now - 3 * 3_600_000), "3h ago");
    assertEquals(pure.timeAgo(now - 2 * 86_400_000), "2d ago");
    assertEquals(pure.timeAgo(undefined).endsWith("d ago"), true);
  }
  if (landed.has("fnv1a")) {
    // fnv1a — the 32-bit seed memory.js used for absence versions.
    assertEquals(pure.fnv1a(""), 0x811c9dc5);
    assertEquals(pure.fnv1a("a"), 0xe40c292c);
  }
  if (landed.has("sha256HexBytes")) {
    // sha256HexBytes — WebCrypto over bytes or a string, 64 hex chars, equal to the sync sha256Hex.
    const hex = await pure.sha256HexBytes(new TextEncoder().encode("abc"));
    assertEquals(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assertEquals(await pure.sha256HexBytes("abc"), hex);
    assertEquals(await pure.sha256HexBytes(new TextEncoder().encode("abc").buffer), hex);
    assertEquals(pure.sha256Hex("abc"), hex);
  }
  if (landed.has("truncateUtf8")) {
    // truncateUtf8 — never splits a code point.
    assertEquals(pure.truncateUtf8("héllo", 2), "h");
    assertEquals(pure.truncateUtf8("héllo", 3), "hé");
  }
  if (landed.has("newId")) {
    // newId — `${prefix}_${hex32}`: hyphen-free, so the screenshot-id text
    // extractor (`shot_[A-Za-z0-9_]{1,64}`) and the thread-id charset both accept it.
    const id = pure.newId("t");
    assert(/^t_[0-9a-f]{32}$/.test(id), id);
    assert(/^[A-Za-z0-9_-]{1,200}$/.test(id), id);
    assert(pure.newId("t") !== id, "ids are unique");
    assert(/^[0-9a-f]{32}$/.test(pure.newId()), "no prefix → bare hex");
    const shot = pure.newId("shot");
    assertEquals(/(shot_[A-Za-z0-9_]{1,64})/.exec(`"screenshotId":"${shot}"`)?.[1], shot, "the extractor reads the whole id");
  }
  if (landed.has("sleep")) {
    const t0 = performance.now();
    await pure.sleep(5);
    assert(performance.now() - t0 >= 4);
  }
});

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
//
// Second half, same class (e273 x 7poq): a blanket sweep must not silently
// stale a HASH PIN. The sweep that landed with this guard edited
// tests/fixtures/security-suite-fake-runner.mjs, whose bytes 7poq pins through
// EXPECTED_FIXTURE_HASH; the pin had to be re-anchored in the same commit. The
// hash-pin tests below check every registered pin against the file's current
// bytes, and discover any new live pin over a file under tests/ or scripts/ so
// it cannot stay unregistered.
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

async function filesUnder(dir: string, keep?: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for await (const ent of Deno.readDir(dir)) {
    const p = `${dir}/${ent.name}`;
    if (ent.isDirectory) out.push(...(await filesUnder(p, keep)));
    else if (!keep || keep(ent.name)) out.push(p);
  }
  return out;
}

const isSource = (name: string) => EXTENSIONS.some((ext) => name.endsWith(ext));

Deno.test("e273: no test or harness derives a filesystem root from a URL pathname", async () => {
  const files = (await Promise.all(SCAN_DIRS.map((d) => filesUnder(d, isSource)))).flat().sort();
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

// --- Hash pins -------------------------------------------------------------
// Each entry: a tracked file whose bytes are pinned by a digest literal in
// source. `file` may live outside tests/+scripts/ (build evidence does); the
// freshness check still covers it, because a sweep of any tree can stale it.
// List verified 2026-09-18 against each file's bytes.
const HASH_PINS = [
  {
    file: "tests/fixtures/security-suite-fake-runner.mjs",
    digest: "a7a87d464288f0ebcc66b645bb24bb5fa8d23da13070af708b68c8d8f7ba411b",
    pinIn: "scripts/security-suite-supervisor.mjs",
    pinName: "EXPECTED_FIXTURE_HASH",
  },
  {
    file: "packages/bundled/evidence/catalog/inventory.json",
    digest: "8e9e3a689a1c19193a7a6723b4f94039a5b06ef57543de68ebd79bcf91fa4d9a",
    pinIn: "scripts/build-bundled-tool-packages.mjs",
    pinName: "catalogSha",
  },
  {
    file: "packages/bundled/evidence/csvtool/build-a/csvtool.wasm",
    digest: "5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81",
    pinIn: "scripts/build-bundled-tool-packages.mjs",
    pinName: "csvtool wasm hash/size",
  },
  {
    file: "packages/bundled/evidence/imageops/build-a/imageops.wasm",
    digest: "b86d327e1d17ddce9a07fb92a43fb151372bbaa662b5bf6ef8aba138fc3e2e32",
    pinIn: "scripts/build-bundled-tool-packages.mjs",
    pinName: "imageops wasm hash/size",
  },
  ...[
    ["base64", "20d6324f4925ee8263322bb74eb818861f13fbd0d4ce080b13c2140b213232cf"],
    ["grep", "04d32c115c9e3a979d59cfe27ea0e5ece616efd64ff958d4fcc96bb217191588"],
    ["sort", "e0543d170ac9bd0cd55b274604b55add18c17c5d87169ebfdf25b4b7245a386a"],
    ["tr", "bec02b43bdeb1997f9616d95499ce91010e124aecb1cad6e6bd97102c0956f3f"],
    ["uniq", "973d78aa28f825019fbfb4aa9463dc6940a65d7da6de80590ba1a691443154df"],
    ["wc", "ce303be0226d2675019191dddbcded6d83de100922fcc10e5ee48a058c0d27d5"],
  ].map(([tool, digest]) => ({
    file: `packages/bundled/unix-stream-v1/binaries/${tool}.wasm`,
    digest,
    pinIn: "scripts/build-bundled-tool-packages.mjs",
    pinName: `STREAM_EXPECT.${tool}`,
  })),
];
const REGISTERED_DIGESTS = new Set(HASH_PINS.map((p) => p.digest));

async function sha256Hex(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("e273/hash pins: every registered pin matches its file's current bytes", async () => {
  for (const pin of HASH_PINS) {
    assertEquals(
      await sha256Hex(pin.file),
      pin.digest,
      `${pin.file} changed but ${pin.pinName} (${pin.pinIn}) still names the old digest — a blanket sweep must re-anchor the pin in the same commit`,
    );
    assert(
      (await Deno.readTextFile(pin.pinIn)).includes(pin.digest),
      `${pin.pinIn} no longer contains ${pin.pinName}'s digest for ${pin.file} — the pin moved; update HASH_PINS in the same change`,
    );
  }
});

Deno.test("e273/hash pins: no unregistered file-digest pin under tests/ or scripts/", async () => {
  const files = (await Promise.all(SCAN_DIRS.map((d) => filesUnder(d)))).flat().sort();
  assert(files.length > 400, `hashed only ${files.length} files under ${SCAN_DIRS.join(" + ")} — the scan is broken`);
  const byDigest = new Map<string, string>();
  for (const rel of files) {
    const digest = await sha256Hex(rel);
    if (!byDigest.has(digest)) byDigest.set(digest, rel);
  }
  const hits: string[] = [];
  const sources = (await Promise.all(SCAN_DIRS.map((d) => filesUnder(d, isSource)))).flat().sort();
  for (const rel of sources) {
    for (const m of (await Deno.readTextFile(rel)).matchAll(/\b[0-9a-f]{64}\b/g)) {
      const target = byDigest.get(m[0]);
      if (target && !REGISTERED_DIGESTS.has(m[0])) {
        hits.push(`${rel} pins ${target} (${m[0]}) — add it to HASH_PINS so a sweep cannot stale it silently`);
      }
    }
  }
  assertEquals(hits, [], `unregistered file-digest pin(s) under ${SCAN_DIRS.join(" + ")}:\n${hits.join("\n")}`);
});

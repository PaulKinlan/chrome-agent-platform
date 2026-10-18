// tests/emscripten-js-capability-admission.test.ts — admission invariant over
// the hash-verified package JS, closed by a real ECMAScript parser
// (chrome-agent-platform-197jd; ADR chrome-agent-platform-errqz).
//
// Verifies:
//   - The deny-list is ONE exported frozen constant with unique typed codes,
//     expressed as finite AST shapes (member chains, callee/new names,
//     identifier references).
//   - Every deny-list entry has a hostile fixture, and every fixture names a
//     live entry (adding a capability without a fixture fails here).
//   - Each fixture is refused at admission with code `js_capability_denied`
//     and detail `<assetId>:<capability-code>`; clean bytes pass.
//   - The scan is PARSER-CLOSED (acorn, vendored at lib/vendor/acorn.mjs):
//     import edges come from ImportDeclaration / Export*Declaration sources
//     and ImportExpression anywhere in the AST — export statements included
//     (0065v); comments, strings, template raw text and regex literals never
//     yield edges (3awbd); nonliteral dynamic imports are REFUSED, not
//     skipped; parse failure and unsupported syntax are refusals.
//   - Capability matching survives receiver-qualified spellings (e840g) and
//     comment-split member access (o0t1n) — comments do not exist in an AST.
//   - Every JS asset is parsed and screened even when no worker root reaches
//     it (a data-role .mjs is screened; 1o3uv); the import graph is seeded
//     from the worker roots (glue+adapter; bootstrap is screened, not a root).
//   - The fetch/XHR preamble exemption is BYTE-EXACT (reviewed glue digests
//     only) and glue-only (adapters and bootstrap are never exempt); hostile
//     negative glues — same idiom, different bytes — are refused.
//   - The two currently admitted acceptance packages still admit: graph audit
//     passes, eligibility holds, identity digests equal the pinned constants
//     (the receipt field is digest-neutral).
//   - Full authority admission records the verdict on the receipt
//     (`current.jsCapabilityAudit`), and a hostile glue is refused end-to-end
//     through `admitBundled` with the typed code.
//
// Honesty boundary (asserted here in so many words): the receipt states that
// a PASS does NOT prove C2 / no-writers — computed, aliased and global
// capability acquisition remains unproven (docs/RISK-REGISTER.md R25).
// @ts-nocheck — browser stubs and dynamic envelopes are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  EMSCRIPTEN_JS_CAPABILITY_DENY_LIST,
  auditEmscriptenJsCapabilities,
  isJsCapabilityAssetRole,
} from "../extension/lib/emscripten-js-capability-audit.js";
import {
  auditEmscriptenGraph,
  auditEmscriptenModule,
} from "../extension/lib/emscripten-module-audit.js";
import {
  buildNumericAcceptancePackage,
  NUMERIC_ACCEPTANCE_PINS,
} from "../scripts/lib/emscripten-numeric-acceptance.mjs";
import {
  buildBlake3AdmissionPackage,
} from "../scripts/lib/emscripten-blake3-admission.mjs";
import {
  canonicalJson,
  registerSchema2Surface,
  WasmPackageAuthority,
  WasmPackageAuthorityError,
} from "../extension/lib/wasm-package-authority.js";
import {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
  assertEmscriptenBlake3Eligibility,
  emscriptenIdentity,
} from "../extension/lib/emscripten-manifest.js";

// Static import graph edges for select-tests tracking:
// import("../extension/lib/emscripten-worker.js")
// import("../extension/about/about.html")

const HEX64 = /^[0-9a-f]{64}$/u;
const enc = new TextEncoder();
const VENDORED_ACORN_VERSION = "8.18.0";
const VENDORED_ACORN_DIST_SHA256 = "953573b8fdab71599749ea5f2b33d3e760c2116178f9423ee7458dbe39d59453";

// ── Hostile fixtures: one per deny-list entry, each matching ONLY its entry ──
const FIXTURES = new Map(Object.entries({
  "navigator.storage": `export const q = () => navigator.storage.estimate();`,
  "getDirectoryHandle": `export const q = (dir) => dir.getDirectoryHandle("x");`,
  "getFileHandle": `export const q = (dir) => dir.getFileHandle("x");`,
  "createSyncAccessHandle": `export const q = (h) => h.createSyncAccessHandle();`,
  "createWritable": `export const q = (h) => h.createWritable();`,
  "caches": `export const q = () => caches.open("x");`,
  "indexedDB": `export const q = () => indexedDB.databases();`,
  "worker-construction": `export const q = () => new Worker("w.mjs", { type: "module" });`,
  "network-dynamic-import": `export const q = () => import("https://cdn.example.invalid/x.mjs");`,
  "fetch": `export const q = () => fetch("/x");`,
  "xhr": `export const q = () => new XMLHttpRequest();`,
}));

const CLEAN_SOURCE = `export const q = (a, b) => a + b;\n`;

/**
 * Scan a synthetic asset graph: the first N specs are the declared JS-role
 * entries, the rest form the resolution universe (any role) that relative
 * imports may target. Paths derive from the asset id so "./x.mjs" specifiers
 * resolve naturally within the directory.
 */
function scanGraph(entries, extra = []) {
  const assets = [];
  const files = new Map();
  for (const [index, spec] of [...entries, ...extra].entries()) {
    const role = spec.role ?? (index < entries.length ? "glue" : "data");
    const id = spec.id ?? (index < entries.length ? role : `${role}${index}`);
    const path = spec.path ?? `extension/wasm/runtime/pkg/1.0.0/${id}.mjs`;
    const bytes = enc.encode(spec.source);
    assets.push({ id, role, path, sha256: spec.sha256 ?? "a".repeat(64), size: bytes.byteLength });
    files.set(path, bytes);
  }
  try {
    return { ok: true, audit: auditEmscriptenJsCapabilities(assets.slice(0, entries.length), assets, files) };
  } catch (error) {
    return { ok: false, error };
  }
}

function scanSource(source, opts) {
  return scanGraph([{ source, ...opts }]);
}

async function evidenceBytes(rel) {
  return await Deno.readFile(new URL(`../${rel}`, import.meta.url));
}

Deno.test("js-capability admission: the vendored parser is the pinned pristine acorn distribution", async () => {
  const vendored = new TextDecoder().decode(await Deno.readFile(new URL("../extension/lib/vendor/acorn.mjs", import.meta.url)));
  const pristine = new TextDecoder().decode(
    await Deno.readFile(new URL("../node_modules/acorn/dist/acorn.mjs", import.meta.url)),
  );
  assert(vendored.endsWith(pristine), "vendored acorn.mjs must be the unmodified distribution (header prepended only)");
  assert(vendored.includes(VENDORED_ACORN_DIST_SHA256), "the header must record the pristine dist sha256");
  const license = new TextDecoder().decode(await Deno.readFile(new URL("../extension/lib/vendor/acorn.LICENSE.txt", import.meta.url)));
  assert(license.includes("MIT"), "the acorn MIT license text must ship beside the vendored parser");
  // The receipt binds the parser version actually in use.
  const { audit } = scanSource(CLEAN_SOURCE);
  assertEquals(audit.parser.name, "acorn");
  assertEquals(audit.parser.version, VENDORED_ACORN_VERSION);
});

Deno.test("js-capability admission: the deny-list is one frozen constant with unique typed AST shapes", () => {
  assert(Object.isFrozen(EMSCRIPTEN_JS_CAPABILITY_DENY_LIST), "deny-list must be frozen");
  const ids = EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id);
  const codes = EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.code);
  assertEquals(new Set(ids).size, ids.length, "entry ids must be unique");
  assertEquals(new Set(codes).size, codes.length, "refusal codes must be unique");
  for (const e of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
    assert(Object.isFrozen(e), `entry ${e.id} must be frozen`);
    assertEquals(typeof e.id, "string");
    assertEquals(typeof e.code, "string");
    assert(["member-pair", "name", "new", "call", "network-import-literal"].includes(e.kind), `entry ${e.id} needs a known shape kind`);
    if (e.kind === "member-pair") {
      assert(Array.isArray(e.pair), `entry ${e.id} needs a pair`);
    } else if (e.kind !== "network-import-literal") {
      assert(Array.isArray(e.names) && e.names.length, `entry ${e.id} needs names`);
    }
    for (const digest of e.exemptGlue) assert(HEX64.test(digest), `entry ${e.id} exemptions must be sha256 digests`);
  }
  // The bead's documented list, all present.
  for (const required of [
    "navigator.storage", "getDirectoryHandle", "getFileHandle", "createSyncAccessHandle",
    "createWritable", "caches", "indexedDB", "worker-construction",
    "network-dynamic-import", "fetch", "xhr",
  ]) {
    assert(ids.includes(required), `deny-list must cover ${required}`);
  }
  // Only the two emscripten-preamble entries carry exemptions.
  assertEquals(
    EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.filter((e) => e.exemptGlue.size).map((e) => e.id).sort(),
    ["fetch", "xhr"],
  );
  assertEquals(isJsCapabilityAssetRole("glue"), true);
  assertEquals(isJsCapabilityAssetRole("adapter"), true);
  assertEquals(isJsCapabilityAssetRole("pthread-bootstrap"), true);
  assertEquals(isJsCapabilityAssetRole("main-wasm"), false);
  assertEquals(isJsCapabilityAssetRole("data"), false);
});

Deno.test("js-capability admission: every deny-list entry has a fixture and every fixture names a live entry", () => {
  for (const entry of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
    assert(FIXTURES.has(entry.id), `deny-list entry "${entry.id}" has no hostile fixture — add one to FIXTURES`);
  }
  for (const id of FIXTURES.keys()) {
    assert(
      EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.some((e) => e.id === id),
      `fixture "${id}" names no live deny-list entry`,
    );
  }
});

Deno.test("js-capability admission: each fixture is refused with its typed code; clean bytes pass", () => {
  for (const [id, source] of FIXTURES) {
    const entry = EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.find((e) => e.id === id);
    const { ok, audit, error } = scanSource(source);
    assertEquals(ok, false, `fixture ${id} must be refused`);
    assertEquals(error instanceof WasmPackageAuthorityError, true, `fixture ${id} must refuse with the authority error`);
    assertEquals(error.code, "js_capability_denied", `fixture ${id}: wrong refusal code`);
    assertEquals(error.detail, `glue:${entry.code}`, `fixture ${id}: typed capability code must name the entry`);
    assertEquals(error.path, "wasm");
    assertEquals(audit, undefined);
  }
  const clean = scanSource(CLEAN_SOURCE);
  assertEquals(clean.ok, true);
  assertEquals(clean.audit.verdict, "pass");
  assertEquals(clean.audit.scanned, [{ asset: "glue", role: "glue", sha256: "a".repeat(64), exemptions: [] }]);
  assertEquals(clean.audit.screened, [{ asset: "glue", role: "glue" }]);
  assertEquals(clean.audit.denyList, EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id));
  assertEquals(clean.audit.roots, ["glue"]);
  assertEquals(clean.audit.edges, []);
  assertEquals(clean.audit.policy, "cap-js-capability-admission-ast-v1");
});

Deno.test("js-capability admission: the receipt says what a PASS does NOT prove (no C2 claim, never writer-free)", async () => {
  const { audit } = scanSource(CLEAN_SOURCE);
  assert(audit.unproven.includes("C2"), "the receipt must state it cannot prove C2");
  assert(audit.unproven.includes("no-writers"), "the receipt must state it cannot prove no-writers");
  assert(audit.unproven.includes("unproven"), "the receipt must name the residual explicitly");
  const flat = JSON.stringify(audit);
  assert(!flat.includes("writer-free"), "the receipt must never claim writer-freedom");
  assert(!flat.includes("no writers of"), "the receipt must not assert writer absence");
  // The operator-facing verdict copy carries the same honesty (ADR errqz).
  const settingsSource = new TextDecoder().decode(
    await Deno.readFile(new URL("../extension/shared/components-settings.js", import.meta.url)),
  );
  assert(
    settingsSource.includes("CANNOT prove C2 / no-writers"),
    "the Settings verdict copy must state that the scan cannot prove C2 / no-writers",
  );
});

Deno.test("js-capability admission: the preamble exemption is byte-exact and glue-only", async () => {
  const reviewedGlue = [
    ["packages/bundled/evidence/emscripten-abi/build-a/numeric.mjs", NUMERIC_ACCEPTANCE_PINS.glue.sha256],
    ["packages/bundled/evidence/blake3-wasm/glue/blake3.mjs", "7d03777d994e39a8a619a8c9fe20c1bcb11710b114fc2f280022a2a103052878"],
    ["packages/bundled/evidence/emscripten-abi/build-a/image-resize.mjs", "3c1c0e4381fe914b33dd554905d28e8dc777f1bda4bd42dcf05edd1380d7bea0"],
    ["packages/bundled/evidence/emscripten-abi/build-a/link-main.mjs", "bcddb43afe69fc2fb90102bf3ab0fcf83395177098ce647659bf1ee707292d76"],
  ];
  for (const [rel, digest] of reviewedGlue) {
    const source = new TextDecoder().decode(await evidenceBytes(rel));
    const { ok, audit } = scanSource(source, { role: "glue", sha256: digest });
    assertEquals(ok, true, `reviewed glue ${rel} must admit`);
    assertEquals(audit.scanned[0].exemptions, ["fetch", "xhr"], `${rel}: preamble exemptions must be recorded`);
  }
  // The hostile negative glues carry the SAME idioms with DIFFERENT bytes:
  // no digest, no exemption.
  for (const rel of [
    "packages/bundled/evidence/emscripten-abi/build-a/negative-global.mjs",
    "packages/bundled/evidence/emscripten-abi/build-a/negative-main-em-asm.mjs",
    "packages/bundled/evidence/emscripten-abi/build-a/negative-main-em-js.mjs",
  ]) {
    const source = new TextDecoder().decode(await evidenceBytes(rel));
    const { ok, error } = scanSource(source, { role: "glue", sha256: "b".repeat(64) });
    assertEquals(ok, false, `hostile glue ${rel} must be refused`);
    assertEquals(error.code, "js_capability_denied");
  }
  // Adapters are never exempt — even with a reviewed digest.
  const { ok, error } = scanSource(FIXTURES.get("fetch"), { role: "adapter", sha256: NUMERIC_ACCEPTANCE_PINS.glue.sha256, id: "adapter" });
  assertEquals(ok, false, "adapter with fetch must be refused even under a reviewed digest");
  assertEquals(error.detail, "adapter:fetch_call");
  // pthread-bootstrap is package JS too: screened, never exempt.
  const boot = scanGraph([{ id: "boot", role: "pthread-bootstrap", source: FIXTURES.get("fetch") }]);
  assertEquals(boot.ok, false, "pthread-bootstrap with fetch must be refused");
  assertEquals(boot.error.detail, "boot:fetch_call");
  const bootExempt = scanGraph([{
    id: "boot",
    role: "pthread-bootstrap",
    source: new TextDecoder().decode(await evidenceBytes("packages/bundled/evidence/emscripten-abi/build-a/numeric.mjs")),
    sha256: NUMERIC_ACCEPTANCE_PINS.glue.sha256,
  }]);
  assertEquals(bootExempt.ok, false, "the preamble exemption is glue-only even byte-exact");
});

Deno.test("js-capability admission: worker roots are glue+adapter; bootstrap is screened, not a root", () => {
  // A bootstrap importing a clean data module does NOT pull it into the
  // scanned (reachable) set — but both are still SCREENED, and the receipt
  // shows exactly that split.
  const { ok, audit } = scanGraph(
    [
      { id: "glue", role: "glue", source: CLEAN_SOURCE },
      { id: "adapter", role: "adapter", source: `export const a = 1;\n` },
      { id: "boot", role: "pthread-bootstrap", source: `import { x } from "./lib.mjs";\nexport const b = x;\n` },
    ],
    [{ id: "lib", role: "data", source: `export const x = 2;\n` }],
  );
  assertEquals(ok, true);
  assertEquals(audit.roots, ["adapter", "glue"]);
  assertEquals(audit.scanned.map((r) => r.asset), ["adapter", "glue"]);
  assertEquals(audit.screened.map((r) => r.asset), ["adapter", "boot", "glue", "lib"]);
  // ...and a capability in the bootstrapped module is still refused, because
  // every JS asset is screened regardless of reachability.
  const hostile = scanGraph(
    [
      { id: "glue", role: "glue", source: CLEAN_SOURCE },
      { id: "boot", role: "pthread-bootstrap", source: `import { x } from "./lib.mjs";\nexport const b = x;\n` },
    ],
    [{ id: "lib", role: "data", source: FIXTURES.get("caches") }],
  );
  assertEquals(hostile.ok, false, "a capability behind a bootstrap-only edge must still be screened");
  assertEquals(hostile.error.detail, "lib:cache_storage");
});

Deno.test("js-capability admission: a glue importing a data-role module is scanned transitively (1o3uv)", () => {
  // The review finding's exact hostile shape: the capability lives in a
  // data-role .mjs that the glue relative-imports. Roles do not fence
  // execution — the import graph does the reaching.
  const { ok, error } = scanGraph(
    [{ id: "glue", role: "glue", source: `import { p } from "./payload.mjs";\nexport const q = p;\n` }],
    [{ id: "payload", role: "data", source: FIXTURES.get("caches") }],
  );
  assertEquals(ok, false, "capability behind a data-role import must be refused");
  assertEquals(error.code, "js_capability_denied");
  assertEquals(error.detail, "payload:cache_storage");

  // Transitive chains and clean multi-file graphs report every scanned row.
  const chain = scanGraph(
    [{ id: "glue", role: "glue", source: `export * from "./a.mjs";\n` }],
    [
      { id: "a", role: "data", source: `import { q } from "./b.mjs";\nexport const u = q;\n` },
      { id: "b", role: "data", source: `export const v = 1;\n` },
    ],
  );
  assertEquals(chain.ok, true);
  assertEquals(chain.audit.scanned.map((r) => r.asset), ["a", "b", "glue"]);
  assertEquals(chain.audit.scanned.map((r) => r.role), ["data", "data", "glue"]);
  assertEquals(chain.audit.edges.length, 2);

  // Deep capability: refused wherever it hides in the chain.
  const deep = scanGraph(
    [{ id: "glue", role: "glue", source: `export * from "./a.mjs";\n` }],
    [
      { id: "a", role: "data", source: `export * from "./b.mjs";\n` },
      { id: "b", role: "data", source: FIXTURES.get("indexedDB") },
    ],
  );
  assertEquals(deep.ok, false);
  assertEquals(deep.error.detail, "b:indexed_db");

  // Cycles terminate (visited set), clean cycle still passes.
  const cycle = scanGraph(
    [{ id: "glue", role: "glue", source: `export * from "./a.mjs";\n` }],
    [{ id: "a", role: "data", source: `export * from "./glue.mjs";\n` }],
  );
  assertEquals(cycle.ok, true);
  assertEquals(cycle.audit.scanned.map((r) => r.asset), ["a", "glue"]);
});

Deno.test("js-capability admission: an import escaping the admitted set is refused", () => {
  const missing = scanGraph([{ id: "glue", role: "glue", source: `import { p } from "./absent.mjs";\nexport const q = p;\n` }]);
  assertEquals(missing.ok, false, "a relative import must resolve to admitted bytes");
  assertEquals(missing.error.code, "js_capability_import_unresolved");
  assertEquals(missing.error.detail, "glue:./absent.mjs");

  const traversal = scanGraph([{ id: "glue", role: "glue", source: `import { p } from "../../../secrets.mjs";\nexport const q = p;\n` }]);
  assertEquals(traversal.ok, false, "../ traversal must not resolve outside the package");
  assertEquals(traversal.error.code, "js_capability_import_unresolved");

  const bare = scanGraph([{ id: "glue", role: "glue", source: `import "external-thing";\nexport const q = 1;\n` }]);
  assertEquals(bare.ok, false, "bare specifiers cannot resolve in an MV3 worker");
  assertEquals(bare.error.code, "js_capability_import_unresolved");
  assertEquals(bare.error.detail, "glue:external-thing");

  const absolute = scanGraph([{ id: "glue", role: "glue", source: `import { p } from "/ext.mjs";\nexport const q = p;\n` }]);
  assertEquals(absolute.ok, false, "extension-absolute specifiers are not package assets");
  assertEquals(absolute.error.code, "js_capability_import_unresolved");
});

Deno.test("js-capability admission: receiver-qualified and comment-split capability spellings are refused (e840g + o0t1n)", () => {
  // The reviewer's exact repro list: the idiomatic worker spellings must be
  // refused like the bare forms.
  for (const src of [
    `self.caches.open("x")`,
    `globalThis.caches.open("x")`,
    `window.caches.open("x")`,
    `self.fetch("/x")`,
    `window.fetch("/x")`,
    `new self.Worker("w")`,
    `new self.SharedWorker("w")`,
    `new globalThis.Worker("w")`,
    `self.navigator.storage`,
  ]) {
    const { ok, error } = scanSource(src);
    assertEquals(ok, false, `must refuse: ${src}`);
    assertEquals(error.code, "js_capability_denied");
  }
  // o0t1n's exact shapes: comments between the tokens of a member access are
  // invisible to the ENGINE, so an AST judgment cannot see them either —
  // `caches /*x*/ .open(...)` and `navigator /*x*/ . storage` refuse.
  for (const src of [
    `caches /*x*/ .open("d")`,
    `navigator /*x*/ . storage`,
    `caches.open /*y*/ ("d")`,
    `indexedDB /*z*/ .databases()`,
    `new Worker /*w*/ ("w.mjs")`,
  ]) {
    const { ok, error } = scanSource(src);
    assertEquals(ok, false, `comment-split spelling must refuse: ${src}`);
    assertEquals(error.code, "js_capability_denied");
  }
  // The AST names do their ONE anti-suffix job: a longer identifier is not a
  // capability, and the bare forms still refuse.
  for (const clean of [
    `const spawnWorker = (w) => w; spawnWorker("w");`,
    `const myFetch = (u) => u; myFetch("/x");`,
    `const refetchCount = 2;`,
  ]) {
    const { ok } = scanSource(clean);
    assertEquals(ok, true, `identifier-suffix must not match: ${clean}`);
  }
  // A capability name as a property/reference of any receiver is refused
  // (fail-closed): static analysis cannot prove an unknown receiver is not
  // the global — that residue is the receipt's `unproven`, not a pass.
  const prop = scanSource(`polyfill.fetch("/x");`);
  assertEquals(prop.ok, false);
  assertEquals(prop.error.detail, "glue:fetch_call");
  // Optional chaining is the same member access to the engine.
  for (const src of [`navigator?.storage`, `globalThis?.caches?.open("d")`]) {
    const { ok } = scanSource(src);
    assertEquals(ok, false, `optional-chained capability must refuse: ${src}`);
  }
});

Deno.test("js-capability admission: the parser closes the import graph (u3vfd + 0065v + 3awbd class)", () => {
  // u3vfd: a >200-char named-import clause is ordinary code; the parser sees
  // every edge with no textual gap limit.
  const longImport = `import { ${Array.from({ length: 30 }, (_, i) => `polly${i}`).join(", ")} } from "./payload.mjs";\nexport const q = 1;\n`;
  const live = scanGraph(
    [{ id: "glue", role: "glue", source: longImport }],
    [{ id: "payload", role: "data", source: FIXTURES.get("navigator.storage") }],
  );
  assertEquals(live.ok, false, "u3vfd: a long import clause must still reach its target");
  assertEquals(live.error.detail, "payload:navigator_storage");

  // 0065v: a dynamic import() written INSIDE a statement that starts with
  // `export` is an ImportExpression node — the previous tokenizer dropped it
  // and admitted the reachable data-role module.
  const exportDynamic = scanGraph(
    [{ id: "glue", role: "glue", source: `export const p = (await import("./payload.mjs")).default;\n` }],
    [{ id: "payload", role: "data", source: FIXTURES.get("createWritable") }],
  );
  assertEquals(exportDynamic.ok, false, "0065v: export-statement dynamic import must reach its target");
  assertEquals(exportDynamic.error.detail, "payload:writable_stream");
  const exportFn = scanGraph(
    [{ id: "glue", role: "glue", source: `export default async () => (await import("./payload.mjs")).default;\n` }],
    [{ id: "payload", role: "data", source: FIXTURES.get("caches") }],
  );
  assertEquals(exportFn.ok, false, "exported-function dynamic import must reach its target");

  // 3awbd: comments, strings, template raw text and regex literals never
  // yield edges — a commented-out import must NOT be refused.
  for (const clean of [
    `// import { a } from "./old.mjs";\nexport const x = 1;\n`,
    `/* import { a } from "./old.mjs"; */\nexport const x = 1;\n`,
    `export const doc = "import { a } from \\"./old.mjs\\";";\n`,
    'export const doc = `import { a } from "./old.mjs";`;\n',
    `const re = /import { a } from ".\\/old.mjs";/;\nexport const x = 1;\n`,
    `const u = import.meta.url;\n`,
  ]) {
    const { ok, error } = scanSource(clean);
    assertEquals(ok, true, `clean source must admit: ${JSON.stringify(clean)} -> ${error?.code} ${error?.detail}`);
  }

  // ...but template ${...} IS live code: its edges resolve and scan.
  const liveTemplate = scanGraph(
    [{ id: "glue", role: "glue", source: "export const doc = `${ import(\"./payload.mjs\") }`;\n" }],
    [{ id: "payload", role: "data", source: FIXTURES.get("caches") }],
  );
  assertEquals(liveTemplate.ok, false);
  assertEquals(liveTemplate.error.detail, "payload:cache_storage");
  const unresolvedTemplate = scanGraph([{ id: "glue", role: "glue", source: "export const doc = `${ import(\"./absent.mjs\") }`;\n" }]);
  assertEquals(unresolvedTemplate.ok, false);
  assertEquals(unresolvedTemplate.error.code, "js_capability_import_unresolved");
  assertEquals(unresolvedTemplate.error.detail, "glue:./absent.mjs");
});

Deno.test("js-capability admission: nonliteral dynamic imports are refused, not skipped (fail-closed)", () => {
  // ADR errqz: every dynamic import source must be a plain literal string.
  // The previous scan silently skipped `import(variable)` — a computed
  // specifier is exactly the aliasing channel the receipt disclaims.
  for (const src of [
    `const v = "./x.mjs"; export const q = import(v);`,
    `export const q = (s) => import(s);`,
    "export const q = import(`./t.mjs`);",
  ]) {
    const { ok, error } = scanSource(src);
    assertEquals(ok, false, `nonliteral dynamic import must refuse: ${src}`);
    assertEquals(error.code, "js_capability_import_nonliteral");
    assertEquals(error.detail, "glue:dynamic-import");
  }
});

Deno.test("js-capability admission: parse failure and unsupported syntax are refusals", () => {
  for (const src of [
    `const = ;\n`,
    `export const q = (a, b => a + b;\n`,
    `#unknownsyntax\n`,
  ]) {
    const { ok, error } = scanSource(src);
    assertEquals(ok, false, `unparseable JS must refuse: ${JSON.stringify(src)}`);
    assertEquals(error.code, "js_capability_parse_failed");
    assert(error.detail.startsWith("glue:"), "the refusal must name the asset");
  }
});

Deno.test("js-capability admission: every JS asset is screened even when unreached; budgets refuse", () => {
  // An unreached data-role .mjs carrying a capability is screened (its role
  // could change tomorrow; static analysis is the fence).
  const unreached = scanGraph(
    [{ id: "glue", role: "glue", source: CLEAN_SOURCE }],
    [{ id: "loose", role: "data", source: FIXTURES.get("indexedDB") }],
  );
  assertEquals(unreached.ok, false, "an unreached data-role .mjs must still be screened");
  assertEquals(unreached.error.detail, "loose:indexed_db");

  // Edge budget: the 257th import edge refuses as js_capability_limit.
  const many = Array.from({ length: 257 }, () => `import "./dup.mjs";`).join("\n");
  const budget = scanGraph(
    [{ id: "glue", role: "glue", source: `${many}\nexport const q = 1;\n` }],
    [{ id: "dup", role: "data", source: `export const d = 1;\n` }],
  );
  assertEquals(budget.ok, false, "the 257th import edge must refuse");
  assertEquals(budget.error.code, "js_capability_limit");
  assertEquals(budget.error.detail, "glue:edges");

  // A .wasm data asset is NOT parsed as JS (refusing binaries would be nonsense).
  const wasm = scanGraph(
    [{ id: "glue", role: "glue", source: CLEAN_SOURCE }],
    [{ id: "blob", role: "data", source: "\\0asm", path: "extension/wasm/runtime/pkg/1.0.0/blob.wasm" }],
  );
  assertEquals(wasm.ok, true);
  assertEquals(wasm.audit.screened.map((r) => r.asset), ["glue"]);
});

function fileMapFor(out) {
  return new Map(
    out.files
      .filter((f) => out.manifest.assets.some((a) => a.path === f.rel))
      .map((f) => [f.rel, f.bytes]),
  );
}

Deno.test("js-capability admission: numeric acceptance package admits with unchanged digests and a pass receipt", async () => {
  const out = await buildNumericAcceptancePackage();
  const fileMap = fileMapFor(out);
  assertEquals(fileMap.size, 3);
  const graph = await auditEmscriptenGraph(
    { assets: out.manifest.assets, modules: out.manifest.modules, linkGraph: out.manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenNumericEligibility(out.manifest, graph);
  assertEquals(graph.jsAudit.verdict, "pass");
  assertEquals(graph.jsAudit.parser, { name: "acorn", version: VENDORED_ACORN_VERSION });
  assertEquals(graph.jsAudit.scanned.length, 2);
  assertEquals(graph.jsAudit.scanned[0].asset, "adapter");
  assertEquals(graph.jsAudit.scanned[0].exemptions, []);
  assertEquals(graph.jsAudit.scanned[1].asset, "glue");
  assertEquals(graph.jsAudit.scanned[1].exemptions, ["fetch", "xhr"]);
  // Digest-neutrality: identity derives from the manifest only, so the pinned
  // graph digest must be unchanged by the receipt field's existence.
  const identity = emscriptenIdentity(out.manifest);
  assertEquals(identity.graphDigest, out.identity.graphDigest);
  assertEquals(identity.graphDigest, "00544d07c39c5cee8473217ef1472d19dc8e0e60f36c3cbef4eb9f63833e7771");
  assertEquals(out.manifestDigest, "97621e5e889b272b79b7e0723a7f5b94254ac187be2cd896e02a35a3a2119343");
});

Deno.test("js-capability admission: blake3 acceptance package admits with unchanged digests and a pass receipt", async () => {
  const out = await buildBlake3AdmissionPackage();
  const fileMap = fileMapFor(out);
  assertEquals(fileMap.size, 3);
  const graph = await auditEmscriptenGraph(
    { assets: out.manifest.assets, modules: out.manifest.modules, linkGraph: out.manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenBlake3Eligibility(out.manifest, graph);
  assertEquals(graph.jsAudit.verdict, "pass");
  assertEquals(graph.jsAudit.scanned[0].asset, "adapter");
  assertEquals(graph.jsAudit.scanned[1].asset, "glue");
  assertEquals(graph.jsAudit.scanned[1].exemptions, ["fetch", "xhr"]);
  const identity = emscriptenIdentity(out.manifest);
  assertEquals(identity.graphDigest, out.identity.graphDigest);
  assertEquals(identity.graphDigest, "529b2bd1bda57c6fc78b4af0c17ea32d7f9fbac639afea1e57f4af674dfbf45f");
  assertEquals(out.manifestDigest, "fecab10d5df322397812c0395df0a5ab35a5713a734f542eb539e2ed8163352f");
});

class FakeStore {
  constructor() {
    this.rows = new Map();
    this.version = 0;
  }
  async getStrict(key) { return this.rows.has(key) ? structuredClone(this.rows.get(key).value) : null; }
  async getVersion(key) { return this.rows.get(key)?.version ?? 0; }
  async setTrusted(key, value) {
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    return token;
  }
  async compareAndRestore(key, expectedVersion, value) {
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    return true;
  }
}

async function shaHexBytes(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function registerRealSurface() {
  registerSchema2Surface({
    validateManifest: validateEmscriptenManifest,
    validateProvenance: validateEmscriptenProvenance,
    assertNumericEligibility: assertEmscriptenNumericEligibility,
    assertBlake3Eligibility: assertEmscriptenBlake3Eligibility,
    identity: emscriptenIdentity,
    auditGraph: auditEmscriptenGraph,
    auditModule: auditEmscriptenModule,
  });
}

function inventoryFor(files, manifestRow) {
  return {
    schemaVersion: 1,
    release: "0.3.616",
    signer: { lane: "bundled", keyId: "cap-bundled-release" },
    manifests: [manifestRow],
    files: [...files.entries()],
    evidence: [],
    revocations: [],
    listFiles: async () => [...files.keys()],
    readFile: async (rel) => files.get(rel),
  };
}

async function inventoryWithDigests(inventory) {
  inventory.files = await Promise.all(inventory.files.map(async ([rel, bytes]) => ({
    rel, sha256: await shaHexBytes(bytes), size: bytes.byteLength,
  })));
  return inventory;
}

Deno.test("js-capability admission: admitBundled records the verdict on the receipt", async () => {
  registerRealSurface();
  const out = await buildNumericAcceptancePackage();
  const files = new Map(out.files.map((f) => [f.rel, f.bytes]));
  // The manifest pins the shared CAP-authored license text; the builder does
  // not emit it, but _verifyBundle requires it in the inventory.
  files.set("extension/wasm/licenses/CAP-authored-Apache-2.0.txt", await evidenceBytes("extension/wasm/licenses/CAP-authored-Apache-2.0.txt"));
  const inventory = await inventoryWithDigests(inventoryFor(files, out.inventoryManifestRow));
  const store = new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });
  const admission = await authority.admitBundled({ manifest: out.manifestCanonical, files: null });
  assertEquals(admission.ok, true);
  const current = admission.record.current;
  assertEquals(current.manifestDigest, out.manifestDigest);
  assertEquals(current.graphDigest, out.identity.graphDigest);
  // THE receipt: the JS capability verdict is visible at validate time, with
  // the parser/policy binding and the explicit unproven statement.
  const audit = current.jsCapabilityAudit;
  assertEquals(audit?.verdict, "pass");
  assertEquals(audit.parser, { name: "acorn", version: VENDORED_ACORN_VERSION });
  assertEquals(audit.policy, "cap-js-capability-admission-ast-v1");
  assertEquals(audit.denyList, EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id));
  assertEquals(audit.scanned.map((row) => row.asset), ["adapter", "glue"]);
  assertEquals(audit.scanned[1].exemptions, ["fetch", "xhr"]);
  assert(audit.unproven.includes("C2"));
});

Deno.test("js-capability admission: a hostile glue is refused end-to-end through admitBundled", async () => {
  registerRealSurface();
  const out = await buildNumericAcceptancePackage();
  const hostileGlue = enc.encode(FIXTURES.get("caches"));
  const hostileDigest = await shaHexBytes(hostileGlue);
  const manifest = structuredClone(out.manifest);
  const glueAsset = manifest.assets.find((a) => a.role === "glue");
  glueAsset.sha256 = hostileDigest;
  glueAsset.size = hostileGlue.byteLength;
  const canonical = canonicalJson(manifest);
  const patchedDigest = new WasmPackageAuthority().manifestDigest(canonical);
  assert(patchedDigest !== out.manifestDigest, "patched manifest must have a new digest");

  const files = new Map(out.files.map((f) => [f.rel, f.bytes]));
  files.set(glueAsset.path, hostileGlue);
  const inventory = await inventoryWithDigests(inventoryFor(files, {
    pkg: NUMERIC_ACCEPTANCE_PINS.packageId,
    version: NUMERIC_ACCEPTANCE_PINS.packageVersion,
    digest: patchedDigest,
  }));
  const store = new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });
  const error = await authority.admitBundled({ manifest: canonical, files: null }).then(
    () => null,
    (e) => e,
  );
  assert(error, "hostile glue must be refused at admission");
  assertEquals(error instanceof WasmPackageAuthorityError, true);
  assertEquals(error.code, "js_capability_denied");
  assertEquals(error.detail, "glue:cache_storage");
  // The refusal precedes the registry write: nothing was admitted.
  const registryRaw = await store.getStrict("wasmPkg");
  assertEquals(registryRaw === null || Object.keys(registryRaw.packages ?? {}).length === 0, true);
});

Deno.test("js-capability admission: hostile data-role import is refused END-TO-END through admitBundled (1o3uv)", async () => {
  registerRealSurface();
  const out = await buildNumericAcceptancePackage();
  const manifest = structuredClone(out.manifest);

  // The hostile shape: a CLEAN glue that relative-imports a data-role module
  // carrying the capability. Old behaviour admitted this package with
  // verdict=pass because only glue/adapter bytes were scanned.
  const glueSource = `import { ${Array.from({ length: 30 }, (_, i) => `polly${i}`).join(", ")} } from "./payload.mjs";\nexport const q = 1;\n`;
  const glueBytes = enc.encode(glueSource);
  const payloadBytes = enc.encode(FIXTURES.get("caches"));
  const glueAsset = manifest.assets.find((a) => a.role === "glue");
  const payloadRel = glueAsset.path.replace(/glue\.mjs$/u, "payload.mjs");
  glueAsset.sha256 = await shaHexBytes(glueBytes);
  glueAsset.size = glueBytes.byteLength;
  manifest.assets.push({
    id: "payload",
    role: "data",
    path: payloadRel,
    sha256: await shaHexBytes(payloadBytes),
    size: payloadBytes.byteLength,
  });

  // Provenance binds outputAssets to the manifest asset ids, and the manifest
  // pins the sidecar bytes — both must be re-forged for the manifest to stay
  // structurally valid so the refusal comes from the CAPABILITY scan, not an
  // earlier layer.
  const sidecarRel = manifest.provenance.record.path;
  const sidecar = JSON.parse(new TextDecoder().decode(out.files.find((f) => f.rel === sidecarRel).bytes));
  sidecar.outputAssets = manifest.assets.map((a) => a.id);
  const sidecarBytes = enc.encode(canonicalJson(sidecar));
  manifest.provenance.record = {
    path: sidecarRel,
    sha256: await shaHexBytes(sidecarBytes),
    size: sidecarBytes.byteLength,
  };

  const canonical = canonicalJson(manifest);
  const patchedDigest = new WasmPackageAuthority().manifestDigest(canonical);

  const files = new Map(out.files.map((f) => [f.rel, f.bytes]));
  files.set(glueAsset.path, glueBytes);
  files.set(payloadRel, payloadBytes);
  files.set(sidecarRel, sidecarBytes);
  const inventory = await inventoryWithDigests(inventoryFor(files, {
    pkg: NUMERIC_ACCEPTANCE_PINS.packageId,
    version: NUMERIC_ACCEPTANCE_PINS.packageVersion,
    digest: patchedDigest,
  }));
  const store = new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });
  const error = await authority.admitBundled({ manifest: canonical, files: null }).then(() => null, (e) => e);
  assert(error, "the hostile data-role import must be refused end-to-end");
  assertEquals(error.code, "js_capability_denied");
  assertEquals(error.detail, "payload:cache_storage");
  const registryRaw = await store.getStrict("wasmPkg");
  assertEquals(registryRaw === null || Object.keys(registryRaw.packages ?? {}).length === 0, true);
});

Deno.test("js-capability admission: hostile export-statement dynamic import refused END-TO-END (0065v)", async () => {
  registerRealSurface();
  const out = await buildNumericAcceptancePackage();
  const manifest = structuredClone(out.manifest);

  const glueSource = `export const payload = (await import("./payload.mjs")).default;\nexport const q = 1;\n`;
  const glueBytes = enc.encode(glueSource);
  const payloadBytes = enc.encode(FIXTURES.get("caches"));
  const glueAsset = manifest.assets.find((a) => a.role === "glue");
  const payloadRel = glueAsset.path.replace(/glue\.mjs$/u, "payload.mjs");
  glueAsset.sha256 = await shaHexBytes(glueBytes);
  glueAsset.size = glueBytes.byteLength;
  manifest.assets.push({
    id: "payload",
    role: "data",
    path: payloadRel,
    sha256: await shaHexBytes(payloadBytes),
    size: payloadBytes.byteLength,
  });
  const sidecarRel = manifest.provenance.record.path;
  const sidecar = JSON.parse(new TextDecoder().decode(out.files.find((f) => f.rel === sidecarRel).bytes));
  sidecar.outputAssets = manifest.assets.map((a) => a.id);
  const sidecarBytes = enc.encode(canonicalJson(sidecar));
  manifest.provenance.record = {
    path: sidecarRel,
    sha256: await shaHexBytes(sidecarBytes),
    size: sidecarBytes.byteLength,
  };
  const canonical = canonicalJson(manifest);
  const patchedDigest = new WasmPackageAuthority().manifestDigest(canonical);

  const files = new Map(out.files.map((f) => [f.rel, f.bytes]));
  files.set(glueAsset.path, glueBytes);
  files.set(payloadRel, payloadBytes);
  files.set(sidecarRel, sidecarBytes);
  const inventory = await inventoryWithDigests(inventoryFor(files, {
    pkg: NUMERIC_ACCEPTANCE_PINS.packageId,
    version: NUMERIC_ACCEPTANCE_PINS.packageVersion,
    digest: patchedDigest,
  }));
  const store = new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });
  const error = await authority.admitBundled({ manifest: canonical, files: null }).then(() => null, (e) => e);
  assert(error, "the export-statement dynamic import must be refused end-to-end");
  assertEquals(error.code, "js_capability_denied");
  assertEquals(error.detail, "payload:cache_storage");
});

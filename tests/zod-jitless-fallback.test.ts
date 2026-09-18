// tests/zod-jitless-fallback.test.ts — chrome-agent-platform-tptx (+4f3j):
// the scrubbed bundles run zod's OWN jitless interpreter path. Prove the
// behavior change is a no-op for validation: zod bundled exactly the way the
// pipeline emits it, then scrubbed exactly the way build.mjs scrubs (probe
// regex + pinned Doc.compile denial), must validate IDENTICALLY to the same
// bundle unmodified, and to the same bundle forced jitless through the
// supported `z.config({ jitless: true })` knob. A perf sample is logged
// (informational, never asserted — wall-clock gates flake).
// @ts-nocheck — dynamic esbuild + temp-module imports.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { denyZodDocCompiles } from "../scripts/lib/scrub-zod-doc.mjs";

/** Bundle zod the way the pipeline does, optionally applying the exact build
 * scrub (probe regex + pinned Doc.compile denial). Returns a temp file path. */
async function bundleZod(scrub) {
  const { build, stop } = await import("npm:esbuild@^0.25.0");
  try {
    const out = await build({
      // The JIT machinery (Doc.compile + the allowsEval probe) lives in zod/v4
      // core — the extension's bundles carry it via `ai` / mcp-sdk importing
      // "zod/v4". The bare "zod" root is the v3-classic interpreted API and
      // contains no Doc at all (measured), so this fixture must use v4.
      stdin: { contents: 'export * as z from "zod/v4";', sourcefile: "zod-entry.js", loader: "js", resolveDir: new URL("..", import.meta.url).pathname },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "chrome120",
      legalComments: "none",
    });
    let code = out.outputFiles[0].text;
    if (scrub) {
      code = code.replace(/new Function\s*\(/g, "(function(){ throw new Error('eval disabled (MV3 CSP)'); })(");
      code = code.replace(/new F\(""\)/g, '(() => { throw new Error("eval disabled (MV3 CSP)"); })()');
      const denied = denyZodDocCompiles(code);
      assert(denied.count >= 1, "the scrub must find the pinned Doc.compile in a real zod bundle (pin rot check)");
      code = denied.code;
    }
    const file = await Deno.makeTempFile({ suffix: ".mjs" });
    await Deno.writeTextFile(file, code);
    return file;
  } finally {
    await stop();
  }
}

/** A validation battery wide enough to exercise the compiler paths: nested
 * objects, unions, discriminated unions, refinements, transforms, defaults,
 * string formats, and failure reporting. */
function battery(z) {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().min(0),
    email: z.string().email(),
    role: z.union([z.literal("admin"), z.literal("user")]),
    pet: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("cat"), lives: z.number() }),
      z.object({ kind: z.literal("dog"), good: z.boolean() }),
    ]),
    tags: z.array(z.string()).default([]),
    nickname: z.string().optional(),
    score: z.number().transform((n) => n * 2),
    password: z.string().refine((s) => s.length >= 8, "too short"),
  });
  const inputs = [
    { name: "Ada", age: 36, email: "ada@example.com", role: "admin", pet: { kind: "cat", lives: 9 }, score: 3, password: "longenough" },
    { name: "", age: -1, email: "not-an-email", role: "root", pet: { kind: "fish" }, score: 2, password: "short" },
    { name: "Bo", age: 5, email: "bo@example.com", role: "user", pet: { kind: "dog", good: true }, tags: ["x"], nickname: "bee", score: 10, password: "12345678" },
  ];
  return inputs.map((input) => {
    const r = schema.safeParse(input);
    return r.success ? { success: true, data: r.data } : { success: false, issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })) };
  });
}

Deno.test("zod jitless fallback: the scrubbed bundle validates identically to default and supported-jitless zod", async () => {
  const [scrubbedFile, pristineFile] = [await bundleZod(true), await bundleZod(false)];
  try {
    const scrubbed = await import(scrubbedFile);
    const pristine = await import(pristineFile);
    const fromScrubbed = battery(scrubbed.z);
    const fromDefault = battery(pristine.z);
    pristine.z.config({ jitless: true }); // the supported knob: same interpreter path the scrub forces
    const fromJitless = battery(pristine.z);
    assertEquals(fromScrubbed, fromDefault, "scrubbed zod must validate identically to unmodified zod");
    assertEquals(fromScrubbed, fromJitless, "scrubbed zod must validate identically to supported jitless zod");
    // The battery must actually discriminate (both outcomes present), or the
    // parity assertions above prove nothing.
    assert(fromScrubbed.some((r) => r.success) && fromScrubbed.some((r) => !r.success), "battery needs success AND failure cases");

    // Informational perf sample (never gated): parse N valid docs on both.
    const doc = { name: "Ada", age: 36, email: "ada@example.com", role: "admin", pet: { kind: "cat", lives: 9 }, score: 3, password: "longenough" };
    const s = scrubbed.z.object({ name: scrubbed.z.string().min(1), age: scrubbed.z.number().int().min(0), email: scrubbed.z.string().email(), role: scrubbed.z.union([scrubbed.z.literal("admin"), scrubbed.z.literal("user")]), pet: scrubbed.z.discriminatedUnion("kind", [scrubbed.z.object({ kind: scrubbed.z.literal("cat"), lives: scrubbed.z.number() }), scrubbed.z.object({ kind: scrubbed.z.literal("dog"), good: scrubbed.z.boolean() })]), tags: scrubbed.z.array(scrubbed.z.string()).default([]), nickname: scrubbed.z.string().optional(), score: scrubbed.z.number().transform((n) => n * 2), password: scrubbed.z.string().refine((v) => v.length >= 8, "too short") });
    pristine.z.config({ jitless: false });
    const p = pristine.z.object({ name: pristine.z.string().min(1), age: pristine.z.number().int().min(0), email: pristine.z.string().email(), role: pristine.z.union([pristine.z.literal("admin"), pristine.z.literal("user")]), pet: pristine.z.discriminatedUnion("kind", [pristine.z.object({ kind: pristine.z.literal("cat"), lives: pristine.z.number() }), pristine.z.object({ kind: pristine.z.literal("dog"), good: pristine.z.boolean() })]), tags: pristine.z.array(pristine.z.string()).default([]), nickname: pristine.z.string().optional(), score: pristine.z.number().transform((n) => n * 2), password: pristine.z.string().refine((v) => v.length >= 8, "too short") });
    for (const s2 of [s, p]) for (let i = 0; i < 50; i++) s2.parse(doc); // warm both paths
    const t0 = performance.now(); for (let i = 0; i < 2000; i++) s.parse(doc); const jitlessMs = performance.now() - t0;
    const t1 = performance.now(); for (let i = 0; i < 2000; i++) p.parse(doc); const jitMs = performance.now() - t1;
    console.log(`zod perf sample (2000 parses): jitless ${jitlessMs.toFixed(1)}ms vs jit ${jitMs.toFixed(1)}ms (ratio ${(jitlessMs / Math.max(jitMs, 0.01)).toFixed(2)}x)`);
  } finally {
    await Deno.remove(scrubbedFile).catch(() => {});
    await Deno.remove(pristineFile).catch(() => {});
  }
});

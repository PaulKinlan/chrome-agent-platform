import { assertEquals } from "jsr:@std/assert@1";
Deno.test("zod CSP fallback: pinned v4 CJS/ESM variants and real SDK validate without JIT, forced JIT denies", () => {
  for (const [version, ext] of [["3.25.76", "cjs"], ["3.25.76", "js"], ["4.4.3", "js"]]) {
    for (const mode of ["fallback", "force-fast"]) {
      const out = new Deno.Command("node", { args: ["tests/fixtures/zod-csp-fallback.mjs", version, ext, mode], stdout: "piped", stderr: "piped" }).outputSync();
      const stdout = new TextDecoder().decode(out.stdout), stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, `${version}/${ext}/${mode}: ${stderr}`);
      console.log(stdout.trim());
    }
  }
});

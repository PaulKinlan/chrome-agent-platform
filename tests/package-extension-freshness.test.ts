// The packaging implementation is Node-native. Deno's test type-checker in
// manual node_modules mode attempts to resolve npm:@types/node when importing
// node:child_process transitively, even though the production module itself
// passes `deno check`. Run the executable fixture suite in a bounded no-check
// child while keeping this canonical Deno gate type-checked.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

Deno.test("package archive freshness, exact inventory, and portability regressions", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--no-check",
      "-A",
      "tests/package-extension-freshness-driver.mjs",
    ],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already complete.
    }
  }, 60_000);
  try {
    const output = await child.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, `${stdout}\n${stderr}`);
    assertStringIncludes(stdout, "3 passed");
    assertStringIncludes(stdout, "0 failed");
  } finally {
    clearTimeout(timer);
  }
});

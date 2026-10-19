// tests/journey-import-safe.test.ts — chrome-agent-platform-h5rsw
//
// scripts/chrome-journeys.ts used to end with an unconditional `await main()`,
// so IMPORTING anything from it started the full journey (a browser, 379
// checks) inside the importer's process — which is why no focused KAT could
// reuse its primitives. The entry must be guarded by `import.meta.main` (the
// sanctioned form, tests/main-module-check-guard.test.ts).
//
// Behavioural, not a source pin: a subprocess imports the module and must
// print the marker and exit 0 promptly, producing no journey output. The
// probe points CAP_CHROMIUM at a nonexistent binary, which
// resolveChromiumBinary REFUSES without falling through
// (scripts/lib/chrome-launch.ts) — so if the guard regresses and main() runs,
// no browser can start and the probe fails fast instead of running a journey.
// RED pre-fix: no marker (main() ran and died at the browser refusal; observed
// "chrome journeys: 4/379 passed" before the refusal). GREEN post-fix.
import { assert, assertEquals } from "jsr:@std/assert@1";

const JOURNEY_URL = new URL("../scripts/chrome-journeys.ts", import.meta.url).href;

Deno.test("h5rsw: importing chrome-journeys.ts does not start the journey", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--no-check",
      `await import(${JSON.stringify(JOURNEY_URL)}).then(
        () => console.log("IMPORTED-NO-JOURNEY-RUN"),
        (e) => { console.error("IMPORT-THREW:", String(e?.message ?? e).slice(0, 300)); Deno.exit(3); },
      );`,
    ],
    env: { CAP_CHROMIUM: "/nonexistent/h5rsw-no-browser" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 90000);
  let out: Deno.CommandOutput;
  try {
    out = await child.output();
  } finally {
    clearTimeout(timer);
  }
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  assert(
    stdout.includes("IMPORTED-NO-JOURNEY-RUN"),
    `importing the journey module must be side-effect-free; stdout=${
      JSON.stringify(stdout.slice(0, 300))
    } stderr=${JSON.stringify(stderr.slice(0, 300))}`,
  );
  assertEquals(out.code, 0, "the importing process must exit 0");
  assert(
    !stdout.includes("chrome journeys:"),
    "the journey's check output must never appear on import",
  );
});

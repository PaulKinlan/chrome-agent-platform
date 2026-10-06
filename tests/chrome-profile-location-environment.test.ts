// tests/chrome-profile-location-environment.test.ts — chrome-agent-platform-hlgr.
//
// A browser-dependent guard must refuse ENVIRONMENTALLY on a host with no resolvable browser: NAMED,
// COUNTED, and distinguishable from BOTH a pass and a product failure. This drives that path — and the
// degradation cases are asserted explicitly, so the test goes RED if the refusal is ever weakened into
// a silent ignore (which reads as green) or into a generic failure (which blames the tree).
//
// HOW ABSENCE IS FORCED, and why not by hiding the host's browser: `resolveChromiumBinaryReport` takes
// an injectable `exists` "for deterministic tests" — its own documented hook — because on a VM that HAS
// a browser (this one does, /usr/bin/chromium plus the chrome-for-testing cache, both provisioned for
// the fleet) no amount of CAP_CHROMIUM/HOME redirection makes the host browserless. So the absence is
// produced through the supported hook, and the resolver's REAL report is what feeds the refusal, rather
// than a hand-written stub: the two halves are proven to fit.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { browserRefusal } from "../scripts/lib/browser-refusal.ts";
import { resolveChromiumBinaryReport } from "../scripts/lib/chrome-launch.ts";
import { ENVIRONMENTAL_REFUSAL_EXIT } from "../scripts/lib/quiet-window.ts";

const decoder = new TextDecoder();

const BROWSER_TEST = "9t1b: a REAL browser holds its profile while the whole tree is copied";

Deno.test("hlgr: no browser => NAMED and COUNTED environmental refusal at exit 75", () => {
  const refusal = browserRefusal(
    {
      binary: null,
      tried: ["CAP_CHROMIUM=/nonexistent-browser", "chrome-for-testing cache: <none>", "default /usr/bin/chromium (missing on this box)"],
    },
    [BROWSER_TEST],
  );
  assert(refusal !== null, "a missing browser must produce a refusal");

  // (1) ENVIRONMENTAL, not a product failure: the repo's third verdict.
  assertEquals(refusal!.exit, ENVIRONMENTAL_REFUSAL_EXIT, "the refusal exit must be the environmental one (75)");
  assert(refusal!.exit !== 1, "exit 1 would be indistinguishable from a product defect");
  assert(refusal!.exit !== 0, "exit 0 with no marker would be a silent ignore, which reads as a pass");

  // (2) NAMED in the human-readable summary, with the reason, where the operator looks.
  assertStringIncludes(refusal!.line, "ENVIRONMENT:", "the refusal must carry the ENVIRONMENT: marker line");
  assert(/no resolvable browser/i.test(refusal!.line), "the refusal must NAME the environmental reason");
  assertStringIncludes(refusal!.line, BROWSER_TEST, "the refusal must NAME the test it refused");
  assertEquals(
    refusal!.marker,
    "CAP_ENVIRONMENTAL_REFUSAL",
    "the machine-readable marker must be the repo's, so a consumer can tell this apart from a pass",
  );

  // (3) COUNTED, on both channels — a count without a name is unusable, and a name without a count
  // cannot tell a reader how much of the file went unverified.
  assert(/refusing 1 browser-dependent test/i.test(refusal!.line), "the summary must count the refusals");
  assertEquals(refusal!.payload.refused, 1, "the payload must carry the count");
  assertEquals(refusal!.payload.tests, [BROWSER_TEST], "the payload must name what was refused");
  assertEquals(refusal!.payload.reason, "no-resolvable-browser", "the payload must carry the reason");
  assertEquals(
    (refusal!.payload.tried as string[]).length,
    3,
    "the payload must keep the resolution steps, so the operator knows what to fix",
  );
});

Deno.test("hlgr: a RESOLVED browser never refuses — the guard cannot refuse spuriously", () => {
  assertEquals(
    browserRefusal({ binary: "/usr/bin/chromium", tried: ["default /usr/bin/chromium"] }, [BROWSER_TEST]),
    null,
    "a resolved browser must NOT produce a refusal, or the guard would skip work it can do",
  );
});

Deno.test("hlgr: the resolver's real absence report drives the refusal end-to-end", () => {
  // The injectable hook is the supported way to produce absence; the failure-path report it returns is
  // exactly what the guard hands to the refusal in production.
  const report = resolveChromiumBinaryReport({ envGet: () => undefined, cacheRoot: "/nonexistent-cache-for-hlgr", exists: () => false });
  assertEquals(report.binary, null, "with no override, no cache and no default binary, nothing resolves");
  assert(report.tried.length >= 1, `the report must name what it tried: ${JSON.stringify(report.tried)}`);
  const refusal = browserRefusal(report, [BROWSER_TEST]);
  assert(refusal !== null, "the real absence report must produce a refusal");
  assertEquals(refusal!.exit, ENVIRONMENTAL_REFUSAL_EXIT);
  assertStringIncludes(refusal!.line, BROWSER_TEST);
  assert(/refusing 1 browser-dependent test/i.test(refusal!.line));
});

// review P2: the PURE verdict was tested but the PROCESS path was not — a refusal degraded to exit 0, or
// removed from the guard entirely, would still have passed. This drives the real exit through a
// subprocess, so the degradation cases are covered end-to-end rather than by inspection.
Deno.test("hlgr: the refusal's PROCESS path exits 75 with the marker, and never returns", async () => {
  const module = new URL("../scripts/lib/browser-refusal.ts", import.meta.url).href;
  const script =
    `import { refuseWithoutBrowser } from ${JSON.stringify(module)};\n` +
    `refuseWithoutBrowser({ binary: null, tried: ["probe"] }, ["a browser-dependent test"]);\n` +
    `console.log("HLGR_REFUSAL_RETURNED");\n`;
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = decoder.decode(stdout) + decoder.decode(stderr);
  assertEquals(code, 75, `the process path must exit 75 (not 0, not 1). Got ${code}:\n${out.slice(0, 800)}`);
  assertStringIncludes(out, "ENVIRONMENT:", `the refusal line must reach stdout:\n${out.slice(0, 800)}`);
  assertStringIncludes(out, "CAP_ENVIRONMENTAL_REFUSAL", `the machine-readable marker must be emitted:\n${out.slice(0, 800)}`);
  assert(
    !out.includes("HLGR_REFUSAL_RETURNED"),
    "refuseWithoutBrowser must NOT return — a caller that continues would launch anyway",
  );
});

// review P2 (delta): THE ORDERING THE WHOLE DESIGN RESTS ON WAS UNPINNED. The refusal is emitted by the
// LAST test in tests/chrome-profile-location.test.ts precisely so every static test above it runs first
// on a browserless host — Deno.exit(75) aborts the file. Nothing asserted that it is still last, so an
// edit appending one more test, or moving the refusal earlier, would silently restore the mid-file
// abort and lose that coverage. This reads the file as TEXT (it must not be imported: importing it would
// RUN it) and pins the position, so the regression fails BY NAME here instead.
Deno.test("hlgr: the environmental refusal is the LAST declared test in chrome-profile-location.test.ts", async () => {
  const src = await Deno.readTextFile(new URL("./chrome-profile-location.test.ts", import.meta.url));
  const declared = [...src.matchAll(/^Deno\.test\(\s*["`']([^"`']+)/gm)].map((m) => m[1]);
  assert(declared.length >= 2, `the file must declare its tests, found ${declared.length}`);
  const last = declared[declared.length - 1];
  assert(
    /no resolvable browser/i.test(last),
    `the refusal must be the LAST test, or a browserless host aborts the static tests above it. Last is: "${last}"`,
  );
  // And no OTHER test may declare the refusal: one refusal per file keeps the count honest.
  assertEquals(
    declared.filter((t) => /no resolvable browser/i.test(t)).length,
    1,
    `exactly one test may emit the refusal; found ${declared.filter((t) => /no resolvable browser/i.test(t)).join(", ")}`,
  );
});

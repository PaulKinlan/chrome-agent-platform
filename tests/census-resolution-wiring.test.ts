// tests/census-resolution-wiring.test.ts — TEXT-ONLY wiring pins for the
// census's fyvc/wvg fix, deliberately in a file with NO import of
// chrome-launch.ts: on the unfixed tree this file must fail on the ASSERTIONS
// (the census still carries `ignore:` and resolves nothing through the shared
// chain), not on a missing module export. The behavioural teeth for the
// resolver itself live in tests/chromium-resolution.test.ts and
// tests/chrome-for-testing.test.ts.
import { assertStringIncludes, assertEquals } from "jsr:@std/assert@1";

Deno.test("fyvc wiring: the census resolves through the shared chain and never self-ignores", async () => {
  const source = await Deno.readTextFile(new URL("../tests/ntp-rpc-census.test.ts", import.meta.url));
  assertStringIncludes(source, "resolveChromiumBinaryReport()", "the census consumes the shared resolution");
  assertStringIncludes(source, "A census that cannot launch a browser is a FAILED census, never a silent pass");
  assertEquals(
    source.includes("ignore:"),
    false,
    "the fyvc/wvg self-ignore green is gone: an unresolvable box fails loudly",
  );
  // And the launcher's own spawn goes through the resolver when no binary is named.
  const launcher = await Deno.readTextFile(new URL("../scripts/lib/chrome-launch.ts", import.meta.url));
  assertStringIncludes(launcher, "opts.binary ?? resolveChromiumBinary()");
});

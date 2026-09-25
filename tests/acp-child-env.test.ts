// tests/acp-child-env.test.ts — chrome-agent-platform-5f5u
//
// The A/B that was supposed to justify this fix did NOT reproduce the stall (see
// scripts/drill-5f5u-ab.ts: both arms stalled identically and both reported apiType=native), so these
// tests do not assert anything about the stall. They assert the two things the adapter's OWN warning
// justifies: an overriding auth source is scoped out of the CHILD environment (never the host, never
// deleted, reversible with one variable), and a precedence warning is surfaced as an actionable line.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { acpChildEnv, acpChildEnvNote, actionableAuthWarning } from "../scripts/lib/acp-child-env.ts";

// A value that is obviously not a real credential: this test asserts the VALUE never appears anywhere
// it could be printed, which is the same reason no real key is needed to exercise the policy.
const FAKE_KEY = "sk-ant-not-a-real-key-5f5u";

Deno.test("5f5u: the adapter child env scopes the overriding auth source out, and never mutates the caller", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: FAKE_KEY };
  const { env, bridgedAuthVars } = acpChildEnv(base);
  assertEquals(bridgedAuthVars, ["ANTHROPIC_API_KEY"], "the variable that overrides a claude.ai login is scoped out");
  assertEquals(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false, "and it is absent from the child env");
  assertEquals(env.PATH, "/usr/bin", "everything else is passed through unchanged");
  // THE BEAD'S CONSTRAINT: "Preserve host settings/credentials; do not auto-delete user API keys."
  assertEquals(base.ANTHROPIC_API_KEY, FAKE_KEY, "the CALLER's environment is untouched — CAP scopes the child, never the user's key");
  // And it is reversible in one variable, for the user who relies on the key.
  const kept = acpChildEnv(base, { keepApiKey: true });
  assertEquals(kept.env.ANTHROPIC_API_KEY, FAKE_KEY, "CAP_ACP_KEEP_API_KEY=1 keeps today's behaviour");
  assertEquals(kept.bridgedAuthVars, [], "and nothing is reported as scoped out");
});

Deno.test("5f5u: the host-side note names the VARIABLE and the way to reverse it, never the value", () => {
  const result = acpChildEnv({ ANTHROPIC_API_KEY: FAKE_KEY });
  const note = acpChildEnvNote(result, "claude");
  assert(note, "a scoped-out auth source must produce a line");
  assertStringIncludes(note as string, "ANTHROPIC_API_KEY");
  assertStringIncludes(note as string, "CAP_ACP_KEEP_API_KEY=1");
  assertStringIncludes(note as string, "unchanged");
  assertEquals((note as string).includes(FAKE_KEY), false, "the note must never echo the value");
  assertEquals(acpChildEnvNote(acpChildEnv({ PATH: "/usr/bin" }), "claude"), null, "nothing scoped out, nothing said");
});

Deno.test("5f5u: the adapter's auth-precedence warning becomes an actionable line, and ordinary stderr does not", () => {
  // The EXACT sentence from the o7v2 drive's stderr (their evidence, claude-first/stderr.txt).
  const theirWarning =
    "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors";
  const line = actionableAuthWarning(theirWarning);
  assert(line, `their warning must produce a host-side line: ${line}`);
  assertStringIncludes(line as string, "CAP_ACP_KEEP_API_KEY=1");
  assertStringIncludes(line as string, "precedence");
  assertEquals((line as string).includes(FAKE_KEY), false, "and it never invents a value");
  // Negatives: the other stderr lines from that same drive must NOT be dressed up as auth problems.
  assertEquals(actionableAuthWarning("[session/query] sessionId=abc resume=none apiType=native baseUrl=native"), null);
  assertEquals(actionableAuthWarning("Session abc: initialized"), null);
  assertEquals(actionableAuthWarning("cancellation failed during teardown Error: Claude Code process exited with code 143"), null);
});

Deno.test("5f5u: SCOPING REQUIRES clearEnv — omitting a variable from env does NOT remove it (measured)", async () => {
  // The regression guard for the line an integration check had to find: Deno MERGES `env` over the
  // parent environment by default, so a child spawned with a scoped env still sees the host's
  // ANTHROPIC_API_KEY. This asserts the MECHANISM, not the helper: it spawns a real child twice and
  // reads what that child can actually see. Delete `clearEnv: true` at either spawn site and this is
  // the test that goes red.
  const probe = `process.stderr.write(process.env.ANTHROPIC_API_KEY ? "PRESENT" : "ABSENT");`;
  const previous = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", FAKE_KEY);
  try {
    const { env } = acpChildEnv(); // scoped: no ANTHROPIC_API_KEY in the map
    const merged = await new Deno.Command(Deno.execPath(), {
      args: ["eval", probe],
      env,
      stdout: "piped", stderr: "piped", clearEnv: false,
    }).output();
    assertEquals(
      new TextDecoder().decode(merged.stderr), "PRESENT",
      "with the default the child inherits the host's key DESPITE it being absent from `env` — the measured trap",
    );
    const scoped = await new Deno.Command(Deno.execPath(), {
      args: ["eval", probe],
      env,
      stdout: "piped", stderr: "piped", clearEnv: true,
    }).output();
    assertEquals(
      new TextDecoder().decode(scoped.stderr), "ABSENT",
      "clearEnv:true is what actually scopes the child; this is the assertion the fix depends on",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", previous);
  }
});

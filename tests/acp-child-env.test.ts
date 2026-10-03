// tests/acp-child-env.test.ts — chrome-agent-platform-5f5u
//
// The A/B that was supposed to justify this fix did NOT reproduce the stall (see
// cap-evidence/5f5u/ab-drill.ts: both arms stalled identically and both reported apiType=native), so these
// tests do not assert anything about the stall. They assert the two things the adapter's OWN warning
// justifies: an overriding auth source is scoped out of the CHILD environment (never the host, never
// deleted, reversible with one variable), and a precedence warning is surfaced as an actionable line.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { acpChildEnv, acpChildEnvFor, acpChildEnvNote, actionableAuthWarning } from "../scripts/lib/acp-child-env.ts";

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

Deno.test("5f5u: an explicit childEnv key wins over the scoping policy (the documented contract)", () => {
  const host = { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: FAKE_KEY };
  // chrome-agent-platform-jp78's contract: childEnv exists so a caller can pin the adapter's
  // configuration for the children IT causes, and explicit keys win over the inherited environment.
  // The host layer is scoped FIRST and childEnv is merged ON TOP — the reverse order silently deleted
  // an explicitly pinned key (found in review, 2026-09-25).
  const pinned = acpChildEnvFor({ ANTHROPIC_API_KEY: "sk-ant-explicit-pin" }, { host });
  assertEquals(pinned.env.ANTHROPIC_API_KEY, "sk-ant-explicit-pin", "a pinned key is passed through, never deleted");
  assertEquals(pinned.env.PATH, "/usr/bin", "the rest of the scoped host env is still there");
  assertEquals(pinned.bridgedAuthVars, [], "nothing was scoped out of the COMPOSED env");
  assertEquals(
    acpChildEnvNote(pinned, "claude"),
    null,
    "and the host-side note must not claim a scoping the explicit key prevented",
  );
  // The inherited key on its own is still scoped, and still reported.
  const inherited = acpChildEnvFor({}, { host });
  assertEquals(Object.hasOwn(inherited.env, "ANTHROPIC_API_KEY"), false, "the host's key is still scoped out");
  assertEquals(inherited.bridgedAuthVars, ["ANTHROPIC_API_KEY"], "and a key that really was scoped out is reported");
  assertEquals(inherited.env.HOME, "/home/x", "the rest of the host env is still passed through");
});

Deno.test("5f5u: SCOPING REQUIRES clearEnv — omitting a variable from env does NOT remove it (measured in a child process)", async () => {
  // The MECHANISM behind the spawn sites' `clearEnv: true`, kept as documentation and as a regression
  // guard for the trap an integration check had to find: Deno MERGES `env` over the parent environment
  // by default, so a child spawned with a scoped env still sees the parent's ANTHROPIC_API_KEY.
  //
  // The scenario runs in a CHILD process on purpose: it needs a real parent environment holding the
  // key, and `deno test --parallel` runs every file in ONE process, so a Deno.env.set here would be a
  // process-global that another file's adapter spawn inherits (chrome-agent-platform-jp78 / m3a2). The
  // child sets its own environment; THIS process's environment is never touched.
  //
  // This is NOT the wiring pin — the probes below are this test's own. The real spawn sites are driven
  // in tests/acp-child-env-wiring.test.ts, where deleting clearEnv from either site reds the run.
  const script = `
    Deno.env.set("ANTHROPIC_API_KEY", ${JSON.stringify(FAKE_KEY)});
    const probe = 'process.stderr.write(process.env.ANTHROPIC_API_KEY ? "PRESENT" : "ABSENT")';
    const run = async (clearEnv) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["eval", probe], env: {}, stdout: "piped", stderr: "piped", clearEnv,
      }).output();
      return new TextDecoder().decode(out.stderr);
    };
    console.log(JSON.stringify({ merged: await run(false), scoped: await run(true) }));
  `;
  const child = await new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const verdicts = JSON.parse(new TextDecoder().decode(child.stdout).trim());
  assertEquals(
    verdicts,
    { merged: "PRESENT", scoped: "ABSENT" },
    "with the default the child inherits the parent's key DESPITE it being absent from `env`; clearEnv:true is what scopes it",
  );
});

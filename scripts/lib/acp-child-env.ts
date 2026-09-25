// scripts/lib/acp-child-env.ts — chrome-agent-platform-5f5u
//
// WHAT THIS IS, AND WHAT IT IS NOT JUSTIFIED BY.
//
// The bead (5f5u) records a Claude ACP session that stalled on its first prompt with
// `ANTHROPIC_API_KEY` inherited from the host, and a second session that completed when the key was
// removed from the CHILD environment. It also says, correctly: "Cause not established: key
// validity/provider/transient delay not measured. Reproduce controlled A/B before attributing."
//
// I ran that A/B (cap-evidence/5f5u/ab-drill.ts: same adapter, one arm without the key, one with a
// deliberately invalid key, 60 s prompt deadline) and it did NOT reproduce the difference — both arms
// stalled identically and BOTH reported `apiType=native baseUrl=native`, so in my harness the key
// never became the auth source. The attribution therefore remains OPEN on the bead.
//
// So this module is justified by the OBSERVED WARNING rather than by the unreproduced stall. The
// adapter's own stderr says, verbatim:
//   "claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and
//    takes precedence over your claude.ai login · Unset it to load your organization's connectors"
// That is a documented precedence rule, and two things follow from it that are worth doing whatever
// the stall's cause turns out to be:
//   1. SCOPE the overriding auth source out of the CHILD environment by default, so a native-login
//      user is not silently switched to an inherited key. NEVER from the host, never from disk, and
//      reversible with one variable — the bead is explicit: "Preserve host settings/credentials; do
//      not auto-delete user API keys."
//   2. SURFACE the warning as an actionable host-side line, because a precedence change that only
//      appears in a child's stderr is invisible in the surface the user is looking at.
//
// A user who genuinely relies on the key sets CAP_ACP_KEEP_API_KEY=1 and gets today's behaviour.

/** Auth sources that take precedence over a native claude.ai login when inherited by the adapter.
 *  Kept to the one the warning names, so the policy is a decision a reader can check rather than a
 *  pile of guesses about other providers. */
export const OVERRIDING_AUTH_VARS: readonly string[] = ["ANTHROPIC_API_KEY"];

export interface AcpChildEnvOptions {
  /** Keep the overriding auth source in the child env (CAP_ACP_KEEP_API_KEY=1). */
  keepApiKey?: boolean;
}

export interface AcpChildEnvResult {
  env: Record<string, string>;
  /** The variables this call scoped OUT of the child env, for a host-side note. */
  bridgedAuthVars: string[];
}

/**
 * The environment for an ACP adapter child: the host environment with the OVERRIDING auth sources
 * removed unless they were explicitly kept.
 *
 * `base` is never mutated — this returns a copy — because the caller's environment (and the rest of
 * CAP, and the user's shell) must be untouched. Nothing here reads, logs or stores a value: the
 * result only says WHICH variable names were scoped out.
 */
export function acpChildEnv(
  base: Record<string, string> = Deno.env.toObject(),
  { keepApiKey = Deno.env.get("CAP_ACP_KEEP_API_KEY") === "1" }: AcpChildEnvOptions = {},
): AcpChildEnvResult {
  const env = { ...base };
  const bridgedAuthVars: string[] = [];
  if (!keepApiKey) {
    for (const name of OVERRIDING_AUTH_VARS) {
      if (Object.hasOwn(env, name)) {
        delete env[name];
        bridgedAuthVars.push(name);
      }
    }
  }
  return { env, bridgedAuthVars };
}

/** The composed adapter-child environment: the HOST environment scoped by policy, then the caller's
 * explicit `childEnv` applied ON TOP.
 *
 * Order is the documented contract of `createAcpServer`'s `childEnv` parameter (chrome-agent-platform
 * jp78): explicit keys win over inherited state, so a caller pinning the adapter's configuration is
 * never silently overruled by the scoping policy. `bridgedAuthVars` names only the variables that are
 * actually absent from the composed env — an explicit override keeps the key out of that list, so the
 * host-side note never claims a scoping a caller prevented. */
export interface AcpChildEnvForOptions extends AcpChildEnvOptions {
  /** The HOST environment to scope. Defaults to this process's environment. */
  host?: Record<string, string>;
}

export function acpChildEnvFor(
  explicit: Record<string, string> = {},
  { host = Deno.env.toObject(), ...options }: AcpChildEnvForOptions = {},
): AcpChildEnvResult {
  const scoped = acpChildEnv(host, options);
  return {
    env: { ...scoped.env, ...explicit },
    bridgedAuthVars: scoped.bridgedAuthVars.filter((name) => !Object.hasOwn(explicit, name)),
  };
}

/** The host-side line for what was scoped out, or null when there was nothing to say. */
export function acpChildEnvNote({ bridgedAuthVars }: AcpChildEnvResult, harness: string): string | null {
  if (bridgedAuthVars.length === 0) return null;
  return (
    `[acp-bridge] ${harness}: ${bridgedAuthVars.join(", ")} is set in this environment and takes precedence ` +
    `over a claude.ai login, so CAP scopes it out of the adapter child (your environment is unchanged). ` +
    `Set CAP_ACP_KEEP_API_KEY=1 to pass it through instead.`
  );
}

/**
 * Turn an adapter's auth-precedence warning into an actionable line, or null if this line is not one.
 *
 * The adapter warns on stderr that an auth source overrode the login; that is exactly the case a user
 * needs told in the surface they are watching, so the bridge relays it rather than swallowing it.
 */
export function actionableAuthWarning(line: string): string | null {
  if (!/takes precedence over|overrides|or another auth source is set/i.test(line)) return null;
  if (!/api[_-]?key|auth|login|credential|connector/i.test(line)) return null;
  return (
    `[acp-bridge] the harness reported an auth precedence problem: ${line.trim()} — ` +
    `CAP scopes ANTHROPIC_API_KEY out of the adapter child unless CAP_ACP_KEEP_API_KEY=1 is set in ` +
    `the environment that started CAP; if you already set it, the key is being passed through ` +
    `deliberately and this warning is the key taking precedence — unset the variable there to use the ` +
    `native login.`
  );
}

/**
 * The Deno.Command options for an adapter child, built in ONE place so both spawn sites (the WebSocket
 * bridge and the native host) cannot drift apart on the load-bearing line.
 *
 * `clearEnv` is the mechanism the whole scoping story depends on: Deno MERGES `env` over the parent's
 * environment by default, so a variable omitted from `env` is still inherited unless clearEnv is true.
 * Measured, not assumed — see cap-evidence/5f5u/ab-drill.ts and tests/acp-child-env-wiring.test.ts,
 * which drives each real spawn site with a child that reports what it can actually see. */
export function acpChildSpawnOptions(
  { args, env, stderr = "piped" }: {
    args: string[];
    env: Record<string, string>;
    stderr?: "inherit" | "piped" | "null";
  },
): Deno.CommandOptions {
  return { args, stdin: "piped", stdout: "piped", stderr, env, clearEnv: true };
}

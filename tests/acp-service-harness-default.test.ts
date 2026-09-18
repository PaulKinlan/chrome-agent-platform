// tests/acp-service-harness-default.test.ts — chrome-agent-platform-7p7e.
//
// Paul's Mac came up on `pi` (not installed there) while the tool he had was
// claude: `scripts/acp-service.mjs` defaulted the harness to "pi" whenever
// --harness was absent. A default that names a binary the machine may not have
// is the defect; these cases pin the replacement — resolve the DEFAULT from what
// the machine actually has, refuse loudly when nothing is present, and warn
// loudly when an explicit choice cannot run.
//
// Driven through `install --dry-run`, which prints the plan and writes NOTHING:
// that is the install-time context (the process PATH), and no unit is created.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "node:path";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "acp-service.mjs");

/** A scratch home, a bin dir with exactly `bins`, and the dry-run plan. */
async function plan({ bins, harness }: { bins: string[]; harness?: string }) {
  const scratch = await durableDir(`acp-harness-default-${Date.now()}`);
  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  await Deno.mkdir(bin, { recursive: true });
  await Deno.mkdir(home, { recursive: true });
  for (const name of bins) {
    await Deno.writeTextFile(join(bin, name), "#!/bin/sh\necho 1.0.0\n");
    await Deno.chmod(join(bin, name), 0o755);
  }
  const args = [SCRIPT, "install", "--dry-run"];
  if (harness) args.push("--harness", harness);
  const res = new Deno.Command("node", {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  }).outputSync();
  return {
    code: res.code,
    out: new TextDecoder().decode(res.stdout),
    err: new TextDecoder().decode(res.stderr),
    plannedHarness: /harness:\s*(\S+)/.exec(new TextDecoder().decode(res.stdout))?.[1] ?? null,
  };
}

Deno.test("acp:install: with no --harness, the harness is the one the machine HAS (claude-only machine)", async () => {
  const r = await plan({ bins: ["claude"] });
  assertEquals(r.code, 0);
  assertEquals(r.plannedHarness, "claude-code", r.out);
  assert(/chosen because claude is on PATH/.test(r.out), "the plan must say why it chose it");
});

Deno.test("acp:install: preference order is claude-code, codex, pi — not whoever is first on PATH", async () => {
  const both = await plan({ bins: ["pi", "claude"] });
  assertEquals(both.plannedHarness, "claude-code", both.out);
  const codexOnly = await plan({ bins: ["codex"] });
  assertEquals(codexOnly.plannedHarness, "codex", codexOnly.out);
  const piOnly = await plan({ bins: ["pi"] });
  assertEquals(piOnly.plannedHarness, "pi", piOnly.out);
});

Deno.test("acp:install: with NO harness CLI present it refuses, names --harness, and writes nothing", async () => {
  const r = await plan({ bins: [] });
  assertEquals(r.code, 1, `must refuse (exit 1), got ${r.code}: ${r.out}${r.err}`);
  assert(/no harness CLI found on PATH/.test(r.err), r.err);
  assert(/Pass --harness <claude-code\|codex\|pi>/.test(r.err), "the refusal must name the flag");
  assert(!/harness:/.test(r.out), "nothing may be planned when nothing can run");
});

Deno.test("acp:install: an EXPLICIT harness is honoured — and warned about when it cannot run", async () => {
  const ok = await plan({ bins: ["codex"], harness: "codex" });
  assertEquals(ok.plannedHarness, "codex", ok.out);
  assert(!/\[warn\]/.test(ok.out), "no warning when the explicit harness is present");

  const missing = await plan({ bins: ["claude"], harness: "pi" });
  assertEquals(missing.plannedHarness, "pi", "an explicit choice is still the choice");
  assert(/\[warn\] --harness pi needs 'pi'/.test(missing.out), `must warn loudly: ${missing.out}`);
});

Deno.test("acp:install: the bridge line carries the resolved harness (the per-connection path is untouched)", async () => {
  const r = await plan({ bins: ["claude"] });
  assert(/--harness claude-code/.test(r.out), r.out);
  assert(!/--harness pi\b/.test(r.out), "the old silent default must be gone");
});

// ── the cwd default (the same defect class: a value chosen for the fleet's box) ──
// The bridge's exported rule, driven in a SUBPROCESS with a temp HOME, because
// the precondition is a machine where $HOME/journal does NOT exist — which is the
// machine we cannot see from here (Paul's Mac). HOME is captured at import time,
// so the case cannot be written in-process.
const BRIDGE = join(ROOT, "scripts", "acp-bridge.ts");

async function hostDefaultsFor(home: string, makeJournal: boolean, frame: object | null, hostCwd?: string) {
  await Deno.mkdir(home, { recursive: true });
  if (makeJournal) await Deno.mkdir(join(home, "journal"), { recursive: true });
  const call = frame === null
    ? `applyHostDefaults(JSON.stringify({ method: "session/new", params: {} }), ${JSON.stringify(hostCwd)})`
    : `applyHostDefaults(${JSON.stringify(JSON.stringify(frame))})`;
  const script = `import { applyHostDefaults } from ${JSON.stringify(BRIDGE)};\nconsole.log(${call});`;
  const child = new Deno.Command("deno", {
    args: ["run", "-A", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), HOME: home },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const out = await child.output();
  const text = new TextDecoder().decode(out.stdout).trim().split("\n").pop() ?? "";
  try { return JSON.parse(text); } catch { return { parseError: text, stderr: new TextDecoder().decode(out.stderr).slice(0, 300) }; }
}

Deno.test("acp-bridge: a session with no cwd gets NOTHING invented when $HOME/journal does not exist", async () => {
  const scratch = await durableDir(`acp-cwd-${Date.now()}`);
  const got = await hostDefaultsFor(join(scratch, "no-journal"), false, { method: "session/new", params: {} });
  assertEquals(got.params?.cwd, undefined, `nothing may be invented: ${JSON.stringify(got)}`);
});

Deno.test("acp-bridge: a machine that HAS $HOME/journal still does not have it invented", async () => {
  // The pointed case (Paul, 2026-09-18): guarding the guess with existsSync made
  // the invention SAFE and left the KNOWLEDGE in — on any machine with a real
  // ~/journal it would have been silently adopted as the working directory. A
  // tool must not carry somebody's directory convention, so the default is "".
  const scratch = await durableDir(`acp-cwd-with-${Date.now()}`);
  const home = join(scratch, "with-journal");
  const got = await hostDefaultsFor(home, true, { method: "session/new", params: {} });
  assertEquals(got.params?.cwd, undefined, `nothing may be invented, even here: ${JSON.stringify(got)}`);
  // and with an explicit host default it IS used (the declared path, not a guess)
  const explicit = await hostDefaultsFor(home, true, null, join(home, "journal"));
  assertEquals(explicit.params?.cwd, join(home, "journal"), JSON.stringify(explicit));
});

Deno.test("acp-bridge: an explicit cwd in the frame, or the documented empty host default, is never overridden", async () => {
  const scratch = await durableDir(`acp-cwd-explicit-${Date.now()}`);
  const home = join(scratch, "home");
  const explicit = await hostDefaultsFor(home, false, { method: "session/new", params: { cwd: "/somewhere/told" } });
  assertEquals(explicit.params?.cwd, "/somewhere/told", JSON.stringify(explicit));
  // "" is the contract's "no host default configured" — nothing invented.
  const emptyHostDefault = await hostDefaultsFor(home, false, null, "");
  assertEquals(emptyHostDefault.params?.cwd, undefined, JSON.stringify(emptyHostDefault));
});

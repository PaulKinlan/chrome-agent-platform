// tests/durable-root.test.ts — bead chp: evidence/scratch off the RAM-backed
// tmpfs. Two halves: (1) the shared helper's behavior (default root, tmpfs
// refusal, loud failure when the durable location is unavailable — never a
// silent fall back to /tmp); (2) a static guard that no script/test still
// defaults retained evidence or big scratch to /tmp (allowlist: tiny
// cross-process coordination files and test fixtures).
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertThrows, assertStringIncludes } from "jsr:@std/assert@1";
import { isRamBacked, durableRoot, durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── the env-dependent cases run in a CHILD process (chrome-agent-platform-5rwd)
// CAP_DURABLE_ROOT is process-global, and `deno test --parallel` interleaves
// test MODULES inside one process: while this file held
// CAP_DURABLE_ROOT=/proc/cap-chp-impossible (one synchronous assertThrows, and
// microsecoonds wide in practice), tests/dist-note-contract.test.ts called
// durableDir() and died with ENOENT under /proc (full-suite witness on record;
// reproduced deterministically by widening the window to 400 ms — 2 of its
// tests red, 3 runs out of 3). A child process has its OWN environment, so a
// case can poison its own durable root without any concurrently running file
// observing it, and the two sibling cases below (a VALID probe root and an
// EMPTY one) had the same exposure with a quieter failure mode: a concurrent
// reader would silently resolve the wrong root instead of throwing.
// The parent only ASSERTS on what the child reports, so the outcomes stay here.
type Probe = { value?: unknown; threw?: string };
let probeRun: Promise<Record<string, Probe>> | null = null;

/** Resolve every env-dependent durable-root case in one throwaway child. */
function probeEnvCases(): Promise<Record<string, Probe>> {
  return probeRun ??= (async () => {
    const moduleUrl = new URL("../scripts/lib/durable-root.mjs", import.meta.url).href;
    // NOTE: no ${…} inside the child source — the only interpolations are the
    // JSON.stringify ones below, so the child is plain JS with string concat.
    const script = `(async () => {
      const mod = await import(${JSON.stringify(moduleUrl)});
      const probe = (fn) => { try { return { value: fn() }; } catch (e) { return { threw: String((e && e.message) || e) }; } };
      const set = (v) => { if (v === undefined) Deno.env.delete("CAP_DURABLE_ROOT"); else Deno.env.set("CAP_DURABLE_ROOT", v); };
      const out = {};
      set(undefined);
      out.defaultRoot = probe(() => mod.durableRoot());
      set("/home/paulkinlan/cap-evidence-test-probe");
      out.override = probe(() => mod.durableRoot());
      set("");
      out.empty = probe(() => mod.durableRoot());
      set("   ");
      out.blank = probe(() => mod.durableRoot());
      set("/tmp/cap-chp-must-refuse");
      out.tmpfs = probe(() => mod.durableRoot());
      set("/dev/shm/cap-chp-must-refuse");
      out.shm = probe(() => mod.durableRoot());
      set("/proc/cap-chp-impossible");
      out.impossible = probe(() => mod.durableDir("probe"));
      console.log("PROBE " + JSON.stringify(out));
    })()`;
    const { stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["eval", script],
      // Its own environment: the parent's HOME (the default root is asserted
      // against it) and NOTHING else — CAP_DURABLE_ROOT is set only inside the
      // child, which is the whole point.
      clearEnv: true,
      env: { HOME: Deno.env.get("HOME") ?? "/home/paulkinlan" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    const line = text.split("\n").find((l) => l.startsWith("PROBE "));
    assert(line, `the child probe must report; got:\n${text.slice(0, 600)}`);
    return JSON.parse(line.slice("PROBE ".length)) as Record<string, Probe>;
  })();
}

Deno.test("isRamBacked identifies the tmpfs /tmp and disk-backed $HOME", () => {
  assertEquals(isRamBacked("/tmp"), true, "/tmp is tmpfs on the build host");
  assertEquals(isRamBacked("/dev/shm"), true, "/dev/shm is tmpfs");
  assertEquals(isRamBacked(Deno.env.get("HOME") ?? "/home"), false, "$HOME is disk");
});

Deno.test("durableRoot defaults to $HOME/cap-evidence (durable), honoring CAP_DURABLE_ROOT", async () => {
  const probed = await probeEnvCases();
  assertEquals(probed.defaultRoot.value, `${Deno.env.get("HOME")}/cap-evidence`);
  assertEquals(probed.override.value, "/home/paulkinlan/cap-evidence-test-probe");
});

Deno.test("durableRoot treats an EMPTY CAP_DURABLE_ROOT as unset — never a relative CWD path", async () => {
  // CAP_DURABLE_ROOT="" is the classic result of shell parameter expansion
  // of an unset var; ?? alone keeps "", and join("", …) would then yield a
  // RELATIVE path silently (review P2 on 62696628). Pin: empty/whitespace
  // means unset → the default.
  const probed = await probeEnvCases();
  assertEquals(probed.empty.value, `${Deno.env.get("HOME")}/cap-evidence`);
  assertEquals(probed.blank.value, `${Deno.env.get("HOME")}/cap-evidence`);
});

Deno.test("durableRoot THROWS on a RAM-backed root — no silent tmpfs fallback", async () => {
  const probed = await probeEnvCases();
  assertStringIncludes(probed.tmpfs.threw ?? "", "RAM-backed");
  assert(probed.shm.threw !== undefined, "a /dev/shm root must throw too");
});

Deno.test("durableDir fails loudly when the durable location is unavailable", async () => {
  // /proc is a read-only virtual filesystem: mkdir MUST fail, and the error
  // must surface (this is the bead's falsification: evidence does NOT
  // silently land back on /tmp when the durable location is gone).
  const probed = await probeEnvCases();
  assert(probed.impossible.threw !== undefined, "an unavailable durable root must throw");
  assertStringIncludes(probed.impossible.threw ?? "", "/proc/cap-chp-impossible");
});

// --- Static guard (widened): no shipped source materializes evidence/scratch
// on the RAM-backed tmpfs. Walks scripts/, tests/, extension/ RECURSIVELY
// (.ts/.mjs/.js/.sh) and flags any line that creates a temp dir or names a
// tmpfs path literally. Two deliberate escapes:
//   CONVENTION — a line routed through the shared durable-root helper
//     (durableDir(...)/durableRoot(...)) is the sanctioned pattern, e.g.
//     mkdtemp(path.join(durableDir("scratch"), "cap-x-")).
//   ALLOWED_FILES / ALLOWED_CALLS_ONLY / ALLOWED_LITERALS — existing usages
//     reviewed as ephemeral-by-design. A NEW file has none of these escapes:
//     it must adopt the durable convention or earn a deliberate, reviewed
//     allowance entry.
// Preserved allowances from the original guard (still deliberate): the
// canonical Chrome lock /tmp/cap-serialized-chrome-acceptance.lock and the
// one-byte /tmp/cap-chrome-slot-POISON marker STAY on tmpfs — a reboot
// clearing a stale lock/poison is a feature (1 inode each) — and
// /tmp/hostile-runner.mjs + /tmp/not-the-canonical-lock are negative
// fixtures of the security suite.

const GUARD_ROOTS = ["scripts", "tests", "extension"];

// Temp-dir materialization calls.
const CALL_DETECTORS: RegExp[] = [
  /\bos\.tmpdir\(\)/,                  // node: OS temp dir
  /\bDeno\.makeTempDir(?:Sync)?\s*\(/, // deno: temp-dir factory
  /\bmkdtemp\b/,                       // node:fs/promises or mkdtemp(1)
  /\bmktemp\b/,                        // shell mktemp
];

// Literal tmpfs path references.
const LITERAL_DETECTORS: RegExp[] = [
  /\/tmp\//,                           // literal tmpfs path
  /\/dev\/shm\//,                      // literal shared-memory tmpfs path
  /\/dev\/tmp\//,                      // literal tmp path
];

const DURABLE_ROUTED = /\bdurable(?:Dir|Root)\s*\(/;

const ALLOWED_LITERALS = [
  "/tmp/cap-serialized-chrome-acceptance.lock", // canonical Chrome lock: tmpfs by design
  "/tmp/cap-chrome-slot-POISON",                // one-byte coordination marker: tmpfs by design
  "/tmp/cap-heavy-gate.lock",                   // fleet-wide heavy-gate slot + its announcement sidecar:
  "/tmp/cap-heavy-gate.holder.json",            // cross-process coordination only (0lj3), tmpfs by design
  "/tmp/hostile-runner.mjs",                    // negative fixture: security suite
  "/tmp/not-the-canonical-lock",                // negative fixture: security suite
];

// Ephemeral-by-design tmp usages reviewed into the allowance, grouped by why.
const ALLOWED_FILES = new Set([
  // Ephemeral Chrome profiles / per-run artifact dirs owned by acceptance and
  // KAT runners — script-lived scratch, never retained evidence (each file's
  // RETAINED evidence dir is durableDir-routed).
  // tuw7: the a11y audit was REMOVED from this allowance — it used to make an uncleaned temporary
  // profile (thirteen directories, 71 MB of residue). It now uses the house profile API under the
  // durable root and removes it in its own teardown, so this guard catches a regression here rather
  // than permitting it. (Writing that sentence with the old path literal tripped this very guard,
  // which is the behaviour we want from a text scan.)
  "scripts/agent-directory-ui.ts",
  "scripts/agent-provider-picker.ts",
  "scripts/agent-role-preview.ts",
  "scripts/capability-lifecycle.ts",
  "scripts/component-gallery-smoke.ts",
  "scripts/data-memory-clear.ts",
  "scripts/emscripten-abi-loaded.ts",
  "scripts/focus-shots.ts",
  "scripts/kat-activity-explorer.ts",
  "scripts/kat-dialog-consolidation.ts",
  "scripts/kat-ui-repair.ts",
  "scripts/kat-user-wasm-call.ts",
  "scripts/kat-user-wasm-store.ts",
  "scripts/live-every-tab.ts",
  "scripts/mic-transcript-smoke.ts",
  "scripts/panel-leak-probe.ts",
  "scripts/perf-gallery-previews.ts",
  "scripts/perf-leak-trace.ts",
  "scripts/perf-seeded-scale.ts",
  "scripts/read-page-host-grant-acceptance.ts",
  "scripts/screenshot-vision-evidence.ts",
  "scripts/security-injection.ts",
  "scripts/sidebar-parity.ts",
  "scripts/skills-in-settings-evidence.ts",
  "scripts/system-prompts-integration.ts",
  "scripts/validate-package-load.ts",
  "scripts/verify-script-run.ts",
  // Build/package scratch: mkdtemp appears only in comments/imports, the call
  // is durable-routed; flake-evidence's dir: scratchBase comes from
  // durableDir("scratch") on the line above; package-archive stages under the
  // (disk-backed) package output dir.
  "scripts/build-test-extension.mjs",
  "scripts/flake-evidence.ts",
  "scripts/package-archive.mjs",
  // Detection, not creation: checks whether a worktree sits on /tmp.
  "scripts/worktree-audit.mjs",
  // Ephemeral unit-test fixtures (small dirs deleted by the test, or plain
  // path strings that never touch the filesystem).
  "tests/00-use-npm-test_test.ts",
  "tests/beads-precommit-hook.test.ts",
  "tests/build-bootstrap.test.ts",
  "tests/bump-version-sanitize.test.ts",
  "tests/changelog-delta.test.ts",
  "tests/chrome-for-testing.test.ts",
  "tests/chrome-launch-lock-scope.test.ts",
  "tests/chrome-lock-fixture-scope.test.ts",
  "tests/chrome-profile-isolation.test.ts",
  "tests/chrome-profile-location.test.ts",
  "tests/chrome-slot-semaphore-honesty.test.ts",
  "tests/chrome-slot-semaphore.test.ts",
  "tests/emscripten-abi-loaded-harness.test.ts",
  "tests/evidence-durable.test.ts",
  "tests/kat-bistro-caller.test.ts",
  "tests/kat-finalizer.test.ts",
  "tests/machine-path-honesty.test.ts",
  "tests/named-agents-provider.test.ts",
  "tests/package-extension-freshness-driver.mjs",
  "tests/perf-spans.test.ts",
  "tests/permission-orchestration.test.ts",
  "tests/permission-variant.test.ts",
  // 8nec: a scratch git repository for the post-commit hook, under tmpdir() and
  // removed in the same test — a fixture, not retained evidence.
  "tests/post-commit-hook.test.ts",
  "tests/provider-gate.test.ts",
  "tests/quiet-window.test.ts",
  "tests/scan-shipped.test.ts",
  "tests/security-suite-custody.test.ts",
  "tests/store-target-policy.test.ts",
  "tests/tokei-shim-admission.test.ts",
  "tests/tool-call-clarity.test.ts",
  "tests/worktree-audit.test.ts",
]);

// Files whose temp-dir CALLS are allowed (ephemeral Chrome profiles; for
// evidence-runner.sh the durable-routed mktemp below $CAP_DURABLE_ROOT ??
// $HOME/cap-evidence) — but any tmpfs PATH LITERAL in them still fails the
// guard. Kept tighter than ALLOWED_FILES on purpose: these files once held
// /tmp evidence literals, and they must never quietly grow one back.
const ALLOWED_CALLS_ONLY = new Set([
  "scripts/evidence-runner.sh",
  "scripts/kat-exec-build-flag.ts",
  "scripts/kat-mcp-agent-ui.ts",
  "scripts/kat-mcp-global-ui.ts",
  "scripts/kat-mcp-transport.ts",
  // 0lj3: the heavy-gate slot's contention fixtures need PRIVATE slot paths (a
  // test must never hold the fleet's own slot), created under a temp dir and
  // removed in the same test. Call-only — no literal tmpfs path, no retained
  // evidence.
  "tests/heavy-gate-slot.test.ts",
]);

function* walk(dir: string): Generator<string> {
  for (const entry of Deno.readDirSync(dir)) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (!["node_modules", "dist", "dist-versions", ".git", ".cache"].includes(entry.name)) yield* walk(p);
    } else if (/\.(ts|mjs|js|sh)$/.test(entry.name)) {
      yield p;
    }
  }
}

Deno.test("guard: tmpdir/tmpfs usage is durable-routed or deliberately allowed", () => {
  const offenders: string[] = [];
  for (const root of GUARD_ROOTS) {
    for (const file of walk(`${ROOT}${root}`)) {
      const rel = file.slice(ROOT.length);
      if (rel === "tests/durable-root.test.ts") continue; // the guard names the patterns itself
      if (ALLOWED_FILES.has(rel)) continue;
      const lines = Deno.readTextFileSync(file).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (DURABLE_ROUTED.test(line)) continue;
        if (ALLOWED_LITERALS.some((l) => line.includes(l))) continue;
        const call = CALL_DETECTORS.some((re) => re.test(line));
        const literal = LITERAL_DETECTORS.some((re) => re.test(line));
        if (!call && !literal) continue;
        if (ALLOWED_FILES.has(rel)) continue;
        if (ALLOWED_CALLS_ONLY.has(rel) && call && !literal) continue;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "tmpdir/tmpfs usage outside the durable convention and the allowance list",
  );
});

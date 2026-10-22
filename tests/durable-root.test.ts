// tests/durable-root.test.ts — bead chp: evidence/scratch off the RAM-backed
// tmpfs. Two halves: (1) the shared helper's behavior (default root, tmpfs
// refusal, loud failure when the durable location is unavailable — never a
// silent fall back to /tmp); (2) a static guard that no script/test still
// defaults retained evidence or big scratch to /tmp (allowlist: tiny
// cross-process coordination files and test fixtures).
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assert, assertEquals, assertThrows, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DEFAULT_DURABLE_DIR_FLOOR_BYTES,
  DEFAULT_DURABLE_DIR_MIN_FREE_BYTES,
  freeSpaceVerdict,
  isRamBacked,
  nearestExistingAncestor,
  trimStaleScratch,
} from "../scripts/lib/durable-root.mjs";

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
type Probe = { value?: unknown; threw?: string; warn?: string };
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
      const capRoot = (Deno.env.get("HOME") || "/home/paulkinlan") + "/cap-cap-test-dir-" + Date.now();
      Deno.mkdirSync(capRoot, { recursive: true });
      out.capRoot = { value: capRoot };
      try {
        set(capRoot);
        Deno.env.set("CAP_DURABLE_DIR_MAX_ENTRIES", "2");
        Deno.env.set("CAP_DURABLE_DIR_MIN_FREE_BYTES", "0");
        mod.durableDir("sub1");
        mod.durableDir("sub2");
        out.capExceeded = probe(() => mod.durableDir("sub3"));
        Deno.env.set("CAP_DURABLE_DIR_MAX_ENTRIES", "abc");
        out.capInvalidNonNumeric = probe(() => mod.durableDir("subInvalid1"));
        Deno.env.set("CAP_DURABLE_DIR_MAX_ENTRIES", "0");
        out.capInvalidZero = probe(() => mod.durableDir("subInvalid2"));
        Deno.env.set("CAP_DURABLE_DIR_MAX_ENTRIES", "-1");
        out.capInvalidNegative = probe(() => mod.durableDir("subInvalid3"));
        Deno.env.set("CAP_DURABLE_DIR_MAX_ENTRIES", "100");
        // nudb2: the shared-volume reserve is ADVISORY — it names the condition and creates anyway.
        const realError = console.error;
        let warned = "";
        console.error = (...args) => { warned = args.join(" "); };
        Deno.env.set("CAP_DURABLE_DIR_MIN_FREE_BYTES", "999999999999999");
        out.minFreeAdvisory = probe(() => mod.durableDir("subMinFree"));
        out.minFreeWarning = { warn: warned };
        // ...and the evidence-viability floor is the half that still fails closed.
        Deno.env.set("CAP_DURABLE_DIR_FLOOR_BYTES", "999999999999999");
        out.floorExceeded = probe(() => mod.durableDir("subFloor"));
        Deno.env.set("CAP_DURABLE_DIR_FLOOR_BYTES", "abc");
        out.floorInvalid = probe(() => mod.durableDir("subFloorInvalid"));
        console.error = realError;
        Deno.env.delete("CAP_DURABLE_DIR_FLOOR_BYTES");
        Deno.env.set("CAP_DURABLE_DIR_MIN_FREE_BYTES", "lots");
        out.minFreeInvalid = probe(() => mod.durableDir("subMinFreeInvalid"));
        Deno.env.set("CAP_DURABLE_DIR_MIN_FREE_BYTES", "0");
        out.minFreeZeroOk = probe(() => mod.durableDir("subMinFreeZero"));
      } finally {
        Deno.env.delete("CAP_DURABLE_DIR_MAX_ENTRIES");
        Deno.env.delete("CAP_DURABLE_DIR_MIN_FREE_BYTES");
        try { Deno.removeSync(capRoot, { recursive: true }); } catch {}
      }
      console.log("PROBE " + JSON.stringify(out));
    })()`;
    const { stdout, stderr, success } = await new Deno.Command(Deno.execPath(), {
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
    assert(success, `the child probe failed with non-zero exit; got:\n${text.slice(0, 600)}`);
    const line = text.split("\n").find((l) => l.startsWith("PROBE "));
    assert(line, `the child probe must report; got:\n${text.slice(0, 600)}`);
    return JSON.parse(line.slice("PROBE ".length)) as Record<string, Probe>;
  })();
}

// /dev/shm is tmpfs on EVERY Linux host, so it is the universal RAM-backed
// witness. /tmp is NOT: it is tmpfs on the build host and ext4 on this fleet
// VM (chrome-agent-platform-3bv7), and this file is in ALWAYS_ON (kz27), so
// asserting the host's /tmp layout reds every lane's subset gate with a
// failure that belongs to no one's change. The /tmp root is checked against
// THIS host's mount table instead, below.
Deno.test("isRamBacked identifies the RAM-backed /dev/shm and disk-backed $HOME", () => {
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
  assertStringIncludes(probed.shm.threw ?? "", "RAM-backed");
  // The /tmp root must agree with the HOST's own mount table: refused where
  // /tmp is tmpfs, accepted where it is disk-backed (this VM). Both branches
  // assert — the condition only picks which.
  if (isRamBacked("/tmp")) assertStringIncludes(probed.tmpfs.threw ?? "", "RAM-backed");
  else assertEquals(probed.tmpfs.threw, undefined, "/tmp is disk-backed here, so no refusal");
});

Deno.test("durableDir fails loudly when the durable location is unavailable", async () => {
  // /proc is a read-only virtual filesystem: mkdir MUST fail, and the error
  // must surface (this is the bead's falsification: evidence does NOT
  // silently land back on /tmp when the durable location is gone).
  const probed = await probeEnvCases();
  assert(probed.impossible.threw !== undefined, "an unavailable durable root must throw");
  assertStringIncludes(probed.impossible.threw ?? "", "/proc/cap-chp-impossible");
});

Deno.test("durableDir: throws named error when CAP_DURABLE_DIR_MAX_ENTRIES is exceeded (yc91a)", async () => {
  const probed = await probeEnvCases();
  assert(probed.capExceeded?.threw !== undefined, "exceeding the entry cap must throw");
  assertStringIncludes(probed.capExceeded?.threw ?? "", "CAP_DURABLE_DIR_MAX_ENTRIES exceeded");
  assertStringIncludes(probed.capExceeded?.threw ?? "", "limit 2");
  assertStringIncludes(probed.capExceeded?.threw ?? "", "sub3");
});

Deno.test("durableDir: throws named error when CAP_DURABLE_DIR_MAX_ENTRIES is invalid/non-positive (p5wzd)", async () => {
  const probed = await probeEnvCases();
  assert(probed.capInvalidNonNumeric?.threw !== undefined, "non-numeric cap must throw");
  assertStringIncludes(probed.capInvalidNonNumeric?.threw ?? "", "CAP_DURABLE_DIR_MAX_ENTRIES invalid: expected positive integer");
  assertStringIncludes(probed.capInvalidNonNumeric?.threw ?? "", "\"abc\"");

  assert(probed.capInvalidZero?.threw !== undefined, "zero cap must throw");
  assertStringIncludes(probed.capInvalidZero?.threw ?? "", "CAP_DURABLE_DIR_MAX_ENTRIES invalid: expected positive integer");
  assertStringIncludes(probed.capInvalidZero?.threw ?? "", "\"0\"");

  assert(probed.capInvalidNegative?.threw !== undefined, "negative cap must throw");
  assertStringIncludes(probed.capInvalidNegative?.threw ?? "", "CAP_DURABLE_DIR_MAX_ENTRIES invalid: expected positive integer");
  assertStringIncludes(probed.capInvalidNegative?.threw ?? "", "\"-1\"");
});

Deno.test("nudb2: a low shared volume NAMES the condition and creates the dir instead of throwing", async () => {
  // The regression this bead fixes: the reserve measures the ROOT filesystem (repos, worktrees, builds),
  // so a low-free condition there - nine rustc builders, not evidence growth - threw on EVERY create and
  // redded 13/13 of a merger's union gate. Advisory + named, with the viability floor as the integrity half.
  const probed = await probeEnvCases();
  assert(probed.minFreeAdvisory?.threw === undefined, "a low shared volume must not throw");
  assertEquals(probed.minFreeAdvisory?.value, `${probed.capRoot?.value}/subMinFree`,
    "the dir is created despite the advisory reserve being far above free space");
  assertStringIncludes(probed.minFreeWarning?.warn ?? "", "CAP_DURABLE_DIR_LOW_FREE_WARNING");
  assertStringIncludes(probed.minFreeWarning?.warn ?? "", "subMinFree");
  assertStringIncludes(probed.minFreeWarning?.warn ?? "", "advisory reserve 999999999999999");

  assert(probed.floorExceeded?.threw !== undefined, "free space below the viability floor must still fail closed");
  assertStringIncludes(probed.floorExceeded?.threw ?? "", "CAP_DURABLE_DIR_FLOOR exceeded");
  assertStringIncludes(probed.floorExceeded?.threw ?? "", "subFloor");
  assert(probed.floorInvalid?.threw !== undefined, "a non-numeric floor must throw, not silently disable");
  assertStringIncludes(probed.floorInvalid?.threw ?? "", "CAP_DURABLE_DIR_FLOOR_BYTES invalid: expected non-negative integer");

  assert(probed.minFreeInvalid?.threw !== undefined, "non-numeric reserve must throw, not silently disable");
  assertStringIncludes(probed.minFreeInvalid?.threw ?? "", "CAP_DURABLE_DIR_MIN_FREE_BYTES invalid: expected non-negative integer");

  assertEquals(probed.minFreeZeroOk?.threw, undefined, "an explicit 0 reserve is an operator choice and permits creation");
});

/** Statically detect any parent-process CAP_DURABLE_ROOT mutation (set, delete, assignment). */
export function detectParentDurableRootEnvMutation(sourceText: string, filename = ""): string[] {
  let text = sourceText.replace(/const script = `[\s\S]*?`;/g, "");
  // Allowlist detector test fixtures in machine-path-honesty and durable-root
  if (filename.endsWith("machine-path-honesty.test.ts")) {
    text = text.replace(/detect\(`Deno\.env\.set\("CAP_DURABLE_ROOT"[\s\S]*?`,\s*"tests\/probe\.test\.ts"\)/g, "");
  }
  if (filename.endsWith("durable-root.test.ts")) {
    text = text.replace(/const fixtures = \[[\s\S]*?\];/g, "");
  }
  // Strip block and single-line comments so comments never trigger multiline regexes
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const violations: string[] = [];

  // Match Deno.env.(set|delete) across line breaks
  const denoEnvRegex = /\bDeno\.env\.(?:set|delete)\s*\(\s*["']CAP_DURABLE_ROOT["']/g;
  let match: RegExpExecArray | null;
  while ((match = denoEnvRegex.exec(withoutComments)) !== null) {
    const lineNum = withoutComments.slice(0, match.index).split("\n").length;
    violations.push(`${filename ? `${filename}:` : ""}line ${lineNum}: Deno.env mutation: ${match[0]}`);
  }

  // Match process.env mutation across line breaks
  const processEnvRegex = /(?:delete\s+process\.env(?:\.CAP_DURABLE_ROOT|\[\s*["']CAP_DURABLE_ROOT["']\s*\])|process\.env(?:\.CAP_DURABLE_ROOT|\[\s*["']CAP_DURABLE_ROOT["']\s*\])\s*=)/g;
  while ((match = processEnvRegex.exec(withoutComments)) !== null) {
    const lineNum = withoutComments.slice(0, match.index).split("\n").length;
    violations.push(`${filename ? `${filename}:` : ""}line ${lineNum}: process.env mutation: ${match[0]}`);
  }

  return violations;
}

Deno.test("guard: durable-root test never mutates parent process environment (m3a2/5rwd)", () => {
  const source = Deno.readTextFileSync(fileURLToPath(import.meta.url));
  const violations = detectParentDurableRootEnvMutation(source, "tests/durable-root.test.ts");
  assertEquals(
    violations,
    [],
    `tests/durable-root.test.ts must never mutate parent CAP_DURABLE_ROOT in-process (races parallel suites; bead m3a2/5rwd):\n${violations.join("\n")}`,
  );

  // Falsification: test fixtures (assembled at runtime so this file does not match itself)
  const VAR = ["CAP", "DURABLE", "ROOT"].join("_");
  const fixtures = [
    { probe: `Deno.env.set("${VAR}", "/tmp/foo");`, desc: "Deno.env.set" },
    { probe: `Deno.env.set(\n  "${VAR}",\n  "/tmp/foo"\n);`, desc: "multiline Deno.env.set" },
    { probe: `Deno.env.delete("${VAR}");`, desc: "Deno.env.delete" },
    { probe: `process.env.${VAR} = "/tmp/foo";`, desc: "process.env assignment" },
    { probe: `process.env["${VAR}"] = "/tmp/foo";`, desc: "process.env bracket assignment" },
    { probe: `process.env[\n  "${VAR}"\n] = "/tmp/foo";`, desc: "multiline process.env bracket assignment" },
    { probe: `delete process.env.${VAR};`, desc: "delete process.env" },
    { probe: `delete process.env["${VAR}"];`, desc: "delete process.env bracket" },
  ];

  for (const { probe, desc } of fixtures) {
    assert(
      detectParentDurableRootEnvMutation(probe).length > 0,
      `guard must catch parent environment mutation: ${desc}`,
    );
  }
});

Deno.test("zuo0i: no test file across tests/*.test.ts mutates parent CAP_DURABLE_ROOT in-process", () => {
  const testsDir = fileURLToPath(new URL(".", import.meta.url));
  const violations: string[] = [];

  for (const entry of Deno.readDirSync(testsDir)) {
    if (!entry.isFile || !entry.name.endsWith(".test.ts")) continue;
    const path = `${testsDir}/${entry.name}`;
    const source = Deno.readTextFileSync(path);
    const fileViolations = detectParentDurableRootEnvMutation(source, `tests/${entry.name}`);
    violations.push(...fileViolations);
  }

  assertEquals(
    violations,
    [],
    `no test in tests/*.test.ts may mutate parent CAP_DURABLE_ROOT in-process (bead zuo0i):\n${violations.join("\n")}`,
  );
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
  // gfxoc: fake-browser unit fixtures assert their short per-run tmpdir is reaped.
  "tests/chrome-tmpdir-cleanup.test.ts",
  "tests/chrome-lock-fixture-scope.test.ts",
  "tests/chrome-profile-isolation.test.ts",
  "tests/chrome-profile-location.test.ts",
  "tests/chrome-slot-semaphore-honesty.test.ts",
  "tests/chrome-slot-semaphore.test.ts",
  "tests/emscripten-abi-loaded-harness.test.ts",
  // luq4w: pure detector fixture spells a tmpfs path literally; it creates no file or retained evidence.
  "tests/evidence-durable-static.test.ts",
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
  // xe11: throwaway git fixture repos for the owed-changelog ledger, created
  // under makeTempDir and removed in the same test — fixtures, not evidence.
  "tests/owed-changelog-ledger.test.ts",
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
  // gfxoc: Chrome-internal TMPDIR must be short (Unix socket limit), ephemeral,
  // per launch, and removed after process-tree verification; never retained evidence.
  "scripts/lib/chrome-launch.ts",
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
  // jixr: raw process teardown uses a private fixture dir removed in the
  // same test's finally. Permit the temp-dir call, not tmpfs path literals.
  "tests/process-tree-cleanup.test.ts",
  // chrome-agent-platform-0eq00: the marker-deletion falsifier needs its own scratch git repo (a
  // REAL dist.complete written by the product's writer and read back by the product's validator), so
  // the test can never depend on the lane's worktree carrying a built dist. The dir is created under
  // makeTempDir and removed in the same test's finally — a fixture, never retained evidence, and the
  // file holds no tmpfs path literal.
  "tests/build-if-needed.test.ts",
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

// A single quote-aware pass produces aligned views: `calls` excludes comments
// and literal text but retains executable ${...} expressions; `literals`
// excludes comments but keeps path strings. Never remove a newline: the line
// of a violation must match the file even across continued quoted strings.
function scanGuardSource(source: string, isShell: boolean) {
  // Index by UTF-16 code unit, like String.slice/RegExp, not Unicode codepoint.
  const calls = source.split("");
  const literals = source.split("");
  const strings: { kind: string; text: string; start: number; line: number }[] = [];
  type State = { kind: string; parent?: State; depth?: number; start?: number; line?: number; inClass?: boolean };
  let state: State = { kind: "code" };
  let line = 1;
  const blank = (at: number, comments = false) => {
    if (source[at] === "\n") return;
    calls[at] = " ";
    if (comments) literals[at] = " ";
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\n") line++;
    if (state.kind === "line-comment") {
      if (ch === "\n") state = state.parent!;
      else blank(i, true);
      continue;
    }
    if (state.kind === "block-comment") {
      blank(i, true);
      if (ch === "*" && source[i + 1] === "/") {
        blank(++i, true);
        state = state.parent!;
      }
      continue;
    }
    if (state.kind === "regex") {
      blank(i);
      if (ch === "\\" && i + 1 < source.length) {
        blank(++i);
        if (source[i] === "\n") line++;
      } else if (ch === "[") state.inClass = true;
      else if (ch === "]") state.inClass = false;
      else if (ch === "/" && !state.inClass) state = state.parent!;
      else if (ch === "\n") state = state.parent!; // malformed regex: fail closed on later code
      continue;
    }
    if (state.kind === "single" || state.kind === "double" || state.kind === "template") {
      const quote = state.kind === "single" ? "'" : state.kind === "double" ? '"' : "`";
      if (ch === "\\" && i + 1 < source.length) {
        blank(i);
        blank(++i);
        if (source[i] === "\n") line++;
        continue;
      }
      if (ch === "\n" && state.kind !== "template") {
        // JS single/double strings cannot cross an unescaped line break. If
        // a regex was misclassified as a quote, do not hide later code.
        for (let j = state.start!; j < i; j++) calls[j] = source[j];
        state = state.parent!;
        continue;
      }
      if (ch === quote) {
        blank(i);
        strings.push({ kind: state.kind, text: source.slice(state.start! + 1, i), start: state.start!, line: state.line! });
        state = state.parent!;
        continue;
      }
      if (state.kind === "template" && ch === "$" && source[i + 1] === "{") {
        state = { kind: "interpolation", depth: 1, parent: state };
        i++;
        continue;
      }
      blank(i);
      continue;
    }
    if (state.kind === "interpolation") {
      if (ch === "{") state.depth!++;
      if (ch === "}" && --state.depth! === 0) {
        state = state.parent!;
        continue;
      }
    }
    // Comments and quotes are recognized in both ordinary code and template
    // interpolations. A '#' inside a shell quote is NOT a comment.
    if (!isShell && ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const block = source[i + 1] === "*";
      state = { kind: block ? "block-comment" : "line-comment", parent: state };
      blank(i, true);
      blank(++i, true);
      continue;
    }
    if (!isShell && ch === "/" && source[i + 1] !== "/" && source[i + 1] !== "*") {
      const prefix = source.slice(source.lastIndexOf("\n", i - 1) + 1, i).trimEnd();
      // Arrow bodies (`x => /'/.test(x)`) are regex positions too. Mis-pairing
      // a quote inside that regex can otherwise mask a real call below it.
      if (/[=([{,:!?|&>]$/.test(prefix) || /\b(?:return|throw|case|yield)$/.test(prefix)) {
        state = { kind: "regex", parent: state, inClass: false };
        blank(i);
        continue;
      }
    }
    if (isShell && ch === "#" && (i === 0 || /[\s;]/.test(source[i - 1]))) {
      state = { kind: "line-comment", parent: state };
      blank(i, true);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      state = { kind: ch === "'" ? "single" : ch === '"' ? "double" : "template", parent: state, start: i, line };
      blank(i);
    }
  }
  // An unterminated quote is not evidence that later code is safe: leave its
  // text visible to the call detector rather than silently suppressing it.
  while (state.parent) {
    if (state.start !== undefined) {
      for (let i = state.start; i < source.length; i++) calls[i] = source[i];
    }
    state = state.parent;
  }
  return { calls: calls.join(""), literals: literals.join(""), strings };
}

/** Strip comments without changing offsets or line numbers. */
export function stripComments(source: string, isShell: boolean): string {
  return scanGuardSource(source, isShell).literals;
}

/** Keep executable interpolation expressions while blanking quoted rationale. */
export function stripStrings(source: string): string {
  return scanGuardSource(source, false).calls;
}

/** Apply the existing allowlists and detectors to source at their proper scope. */
export function findDurableViolations(
  content: string,
  relPath: string,
  { isShell = relPath.endsWith(".sh"), allowedCallsOnly = false }:
    { isShell?: boolean; allowedCallsOnly?: boolean } = {},
): string[] {
  const violations: string[] = [];
  const rawLines = content.split("\n");
  const scanned = scanGuardSource(content, isShell);
  const callLines = scanned.calls.split("\n");
  const literalLines = scanned.literals.split("\n");
  const executedStrings = new Set<number>();
  const sink = "(?:exec|execSync|execFile\\w*|spawn|spawnSync|Deno\\.Command|sh|bash)";
  const executableCalls = new RegExp(CALL_DETECTORS.map((re) => `(?:${re.source})`).join("|"), "g");
  for (const string of scanned.strings) {
    const matches = [...string.text.matchAll(executableCalls)];
    if (matches.length === 0) continue;
    const before = content.slice(content.lastIndexOf("\n", string.start - 1) + 1, string.start);
    const assignment = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*$/.exec(before);
    const name = assignment?.[1];
    // The named command may be argv[2], not argv[0]: the house style is
    // Deno.Command("bash", { args: ["-c", cmd] }), and spawn is similar.
    const assignedSink = name && new RegExp(`\\b${sink}\\s*\\([^;]*\\b${name.replace(/\$/g, "\\$")}\\b`).test(scanned.calls);
    const directSink = new RegExp(`\\b${sink}\\s*\\([^;]*$`).test(scanned.calls.slice(0, string.start));
    // Rationale strings are inert; only strings actually passed to a process
    // sink (or shell command substitution) are executable.
    if (!(directSink || assignedSink || (isShell && string.kind === "template"))) continue;
    for (const match of matches) {
      // A multi-line template's opening line might contain durableDir() and
      // be exempt; attribute the violation to the token's actual line.
      const offset = string.text.slice(0, match.index).split("\n").length - 1;
      executedStrings.add(string.line + offset);
    }
  }
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    if (DURABLE_ROUTED.test(rawLine)) continue;
    if (ALLOWED_LITERALS.some((l) => rawLine.includes(l))) continue;
    const call = CALL_DETECTORS.some((re) => re.test(callLines[i])) || executedStrings.has(i + 1);
    const literal = LITERAL_DETECTORS.some((re) => re.test(literalLines[i]));
    if ((!call && !literal) || (allowedCallsOnly && call && !literal)) continue;
    violations.push(`${relPath}:${i + 1}: ${rawLine.trim()}`);
  }
  return violations;
}

Deno.test("guard: tmpdir/tmpfs usage is durable-routed or deliberately allowed", () => {
  const offenders: string[] = [];
  for (const root of GUARD_ROOTS) {
    for (const file of walk(`${ROOT}${root}`)) {
      const rel = file.slice(ROOT.length);
      if (rel === "tests/durable-root.test.ts") continue; // the guard names the patterns itself
      if (ALLOWED_FILES.has(rel)) continue;
      offenders.push(...findDurableViolations(Deno.readTextFileSync(file), rel, {
        allowedCallsOnly: ALLOWED_CALLS_ONLY.has(rel),
      }));
    }
  }
  assertEquals(offenders, [], "tmpdir/tmpfs usage outside the durable convention and the allowance list");
});

Deno.test("pru35/rxhq2: comment and rationale mentions pass; real calls and path literals fail", () => {
  const text = [
    "// We avoid mkdtemp and /tmp/ allocations here.",
    "/* A multi-line comment mentions mktemp and /dev/shm/ scratch. */",
    'const rationale = "reads source as static input; avoids mkdtemp and makeTempDir outside durableDir";',
    'const desc = `avoiding mktemp in shell scripts`;',
  ].join("\n");
  assertEquals(findDurableViolations(text, "scripts/test-fixture.ts"), []);
  assertEquals(findDurableViolations("# mktemp is avoided here\n# /tmp/ is not used", "scripts/test-fixture.sh"), []);

  const call = findDurableViolations('const dir = await mkdtemp("scratch-");', "scripts/test-fixture.ts");
  assertEquals(call.length, 1);
  assert(call[0].includes("scripts/test-fixture.ts:1"));
  const literal = findDurableViolations('const socket = "/tmp/chrome.sock";', "scripts/test-fixture.ts");
  assertEquals(literal.length, 1);
  assert(literal[0].includes("scripts/test-fixture.ts:1"));
  assertEquals(findDurableViolations(
    'const dir = await mkdtemp(path.join(durableDir("scratch"), "cap-x-"));', "scripts/test-fixture.ts",
  ), []);
});

Deno.test("88lzq: real temporary-directory calls survive string and template scanning", () => {
  const samples = [
    ['const p = `${await mkdtemp("cap-x-")}`;', 1],
    ['const cmd = `mktemp -d cap-${id}`; await exec(cmd);', 1],
    ['await exec(`mktemp -d cap-x`);', 1],
    ['const cmd = `mktemp -d cap-x`;\nawait exec(cmd);', 1],
    ['const a = "a ` tick";\nconst dir = await mkdtemp("cap-x-");\nconst b = "b ` tick";', 2],
    ['const a = "a \\\nb";\ndurableDir("x");\nconst dir = await mkdtemp("cap-x-");', 4],
    ['const p = `before ${`inner ${mkdtemp("cap-x-")}`} after`;', 1],
    ["const re = /['\"`]/;\nconst dir = await mkdtemp('cap-x-');", 2],
    ['const emoji = "🧭";\nconst dir = await mkdtemp("cap-x-");', 2],
  ] as const;
  for (const [source, line] of samples) {
    const failures = findDurableViolations(source, "scripts/sample.ts");
    assertEquals(failures.length, 1, source);
    assert(failures[0].includes(`scripts/sample.ts:${line}:`), source);
  }
  assertEquals(findDurableViolations('const rationale = `avoid mkdtemp ${why}`;', "scripts/sample.ts"), []);
  assertEquals(findDurableViolations('const draft = `mktemp -d cap-${id}`;', "scripts/sample.ts"), []);
  assertEquals(findDurableViolations('dir=`mktemp -d cap-x`', "scripts/sample.sh").length, 1);
});

Deno.test("jpwvv: comment markers inside quotes never hide a real call or invent one", () => {
  assertEquals(findDurableViolations("const n = 1;// we avoid mkdtemp here", "scripts/sample.ts"), []);
  const shell = findDurableViolations('x="a #"; mktemp -d cap-x', "scripts/sample.sh");
  assertEquals(shell.length, 1, "the # in a shell string must not erase executable code");
  assert(shell[0].includes("scripts/sample.sh:1:"));

  // Real-tree witness: probeSource contains a template interpolation whose
  // quoted branch starts with whitespace + '// returns immediately'. A regex
  // comment pass applied before quote recognition truncates that actual line,
  // mis-pairs the template and can invent a violation later in THIS file.
  const path = new URL("./serial-phase-resilience.test.ts", import.meta.url);
  const source = Deno.readTextFileSync(path);
  const actualBranch = '"  // returns immediately"';
  assertStringIncludes(source, actualBranch);
  const scanned = scanGuardSource(source, false);
  assertStringIncludes(scanned.literals, actualBranch,
    "the real quoted branch survives comment scanning; an early // regex truncates it");
  assertEquals(scanned.calls.length, source.length, "scanner offsets stay aligned with the real fixture");
  assertEquals(findDurableViolations(source, "tests/serial-phase-resilience.test.ts"), [],
    "the actual serial-phase fixture must not acquire a false violation");
});

Deno.test("bp2qx: arrow-adjacent regex with quotes cannot hide later temp calls", () => {
  // Read the real source line so this fixture follows the in-repo idiom,
  // rather than proving only a hand-typed arrow/regex approximation.
  const source = Deno.readTextFileSync(new URL("../scripts/live-every-tab.ts", import.meta.url));
  const liveLine = source.split("\n").find((line) => line.includes("const listTabsOk = plain.filter"));
  assert(liveLine?.includes('=> /"type":"tool-result"/'), "live-every-tab must still carry the arrow-regex shape");
  const liveFixture = `${liveLine}\nconst dir = await mkdtemp("cap-x-");`;
  assertEquals(findDurableViolations(liveFixture, "scripts/live-every-tab.ts").length, 1);
  for (const quote of ["'", '"']) {
    const regex = `const hit = arr.filter((n) => /cap${quote}/.test(n));`;
    const fixture = `${regex}\nconst dir = await mkdtemp("cap-x-");\nconst other = ${quote}fine${quote};`;
    const failures = findDurableViolations(fixture, "scripts/sample.ts");
    assertEquals(failures.length, 1, `a quote inside an arrow regex must not hide code: ${regex}`);
    assert(failures[0].includes("scripts/sample.ts:2:"));
    assertEquals(scanGuardSource(fixture, false).calls.split("\n")[0].includes("cap"), false,
      "the arrow regex must be lexed as a literal, not code");
  }
});

Deno.test("6rvgs: argv and shell wrappers execute command strings, not rationale text", () => {
  const commands = [
    'const cmd = "mktemp -d cap-x";\nawait new Deno.Command("bash", { args: ["-c", cmd] }).output();',
    'const cmd = "mktemp -d cap-x";\nspawn("bash", ["-c", cmd]);',
    'const cmd = "mktemp -d cap-x";\nawait sh(cmd);',
    'await new Deno.Command("bash", { args: ["-c", "mktemp -d cap-x"] }).output();',
  ];
  for (const command of commands) {
    const failures = findDurableViolations(command, "scripts/sample.ts");
    assertEquals(failures.length, 1, `the executed command must be rejected: ${command}`);
    assert(failures[0].includes("scripts/sample.ts:1:") || failures[0].includes("scripts/sample.ts:2:"));
  }
  assertEquals(findDurableViolations('const rationale = "avoid mktemp in a shell";', "scripts/sample.ts"), []);
});

Deno.test("xn482: executed multiline templates name the hazardous line despite opening-line allowance", () => {
  for (const opening of ['const base = 1; await exec(`echo hi', 'const base = durableDir("x"); await exec(`echo hi']) {
    const fixture = `${opening}\nmktemp -d cap-x` + '`);';
    const failures = findDurableViolations(fixture, "scripts/sample.ts");
    assertEquals(failures.length, 1, `the later command must be reported even when the opener is allowed: ${fixture}`);
    assert(failures[0].includes("scripts/sample.ts:2: mktemp -d cap-x"));
  }
});

// ── chrome-agent-platform-nudb2: scoped reserve + bounded, age-gated trim ──────────────────────
// The reserve measures the volume that holds the durable root, which on this fleet is the ROOT
// filesystem (repos, worktrees, node_modules, rustc/deno builds). It therefore cannot tell evidence
// growth from nine heavy builders, and throwing on it took every lane's gate down with it. The pure
// verdict below keeps both halves falsifiable without touching this host's disk.

Deno.test("nudb2: the free-space verdict separates shared-volume pressure (warn) from evidence fullness (fatal)", () => {
  // Derived from the repo root, not a machine literal: these two strings are only echoed and compared by the
  // pure verdict (nothing touches the disk), and an absolute machine literal would rightly trip
  // tests/machine-path-honesty.test.ts.
  const anchor = join(ROOT, "cap-evidence");
  const dir = join(anchor, "run-1");
  // Plenty: silent.
  assertEquals(freeSpaceVerdict({ free: 5_000_000_000, minFree: DEFAULT_DURABLE_DIR_MIN_FREE_BYTES, floor: DEFAULT_DURABLE_DIR_FLOOR_BYTES, anchor, dir }), {});
  // The incident: 481 MB free on the shared volume, far above any evidence need. NAMED, created anyway.
  const advisory = freeSpaceVerdict({ free: 481 * 1024 * 1024, minFree: DEFAULT_DURABLE_DIR_MIN_FREE_BYTES, floor: DEFAULT_DURABLE_DIR_FLOOR_BYTES, anchor, dir });
  assertEquals(advisory.fatal, undefined, "a shared-volume reserve must never fail the create");
  assertStringIncludes(advisory.warning ?? "", "CAP_DURABLE_DIR_LOW_FREE_WARNING");
  assertStringIncludes(advisory.warning ?? "", String(481 * 1024 * 1024));
  assertStringIncludes(advisory.warning ?? "", dir);
  // Genuinely full evidence volume: below the viability floor, so integrity still fails closed.
  const fatal = freeSpaceVerdict({ free: 4 * 1024 * 1024, minFree: DEFAULT_DURABLE_DIR_MIN_FREE_BYTES, floor: DEFAULT_DURABLE_DIR_FLOOR_BYTES, anchor, dir });
  assertStringIncludes(fatal.fatal ?? "", "CAP_DURABLE_DIR_FLOOR exceeded");
  assertStringIncludes(fatal.fatal ?? "", dir);
  // statfs unavailable (null/undefined free) stays silent: the entry cap is still the byte bound's backstop.
  assertEquals(freeSpaceVerdict({ free: null, minFree: DEFAULT_DURABLE_DIR_MIN_FREE_BYTES, floor: DEFAULT_DURABLE_DIR_FLOOR_BYTES, anchor, dir }), {});
  // An operator who disables both knobs gets no verdict at all.
  assertEquals(freeSpaceVerdict({ free: 1, minFree: 0, floor: 0, anchor, dir }), {});
});

Deno.test("nudb2: the trim is bounded, age-gated, allowlisted and never fatal", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-trim-probe-" });
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  try {
    const logs = `${root}/serial-phase-logs`;
    const scratch = `${root}/scratch`;
    const other = `${root}/lead-evidence-dir`;
    for (const dir of [logs, scratch, other]) Deno.mkdirSync(dir, { recursive: true });
    // stale (older than the age bound) in two allowlisted parents, plus a LIVE (fresh) sibling
    Deno.writeTextFileSync(`${logs}/old-1.log`, "x");
    Deno.writeTextFileSync(`${logs}/old-2.log`, "x");
    Deno.writeTextFileSync(`${scratch}/old-3.log`, "x");
    Deno.writeTextFileSync(`${scratch}/live.log`, "x");
    Deno.utimeSync(`${logs}/old-1.log`, (now - 2 * hour) / 1000, (now - 2 * hour) / 1000);
    Deno.utimeSync(`${logs}/old-2.log`, (now - 2 * hour) / 1000, (now - 2 * hour) / 1000);
    Deno.utimeSync(`${scratch}/old-3.log`, (now - 2 * hour) / 1000, (now - 2 * hour) / 1000);
    // a stale dir OUTSIDE the allowlist: another lane's evidence must never be trimmed
    Deno.writeTextFileSync(`${other}/deliverable.txt`, "x");
    Deno.utimeSync(`${other}/deliverable.txt`, (now - 2 * hour) / 1000, (now - 2 * hour) / 1000);

    const trimmed = trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 2 });
    assertEquals(trimmed.removed, 2, "the entry bound caps the trim even when more entries are stale");
    assertEquals(existsSyncGuard(`${logs}/live.log`), false, "a live entry in the same parent must survive the trim");
    assertEquals(existsSyncGuard(`${scratch}/live.log`), true, "a live entry must survive the trim");
    assertEquals(existsSyncGuard(`${scratch}/old-3.log`), true, "the bound stops the trim mid-way");
    assertEquals(existsSyncGuard(`${other}/deliverable.txt`), true, "an allowlist miss is never trimmed");

    // A second pass with a larger bound takes the remaining stale entry.
    const second = trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 50 });
    assertEquals(second.removed, 1, "the remaining stale allowlisted entry is trimmed");
    assertEquals(existsSyncGuard(`${scratch}/old-3.log`), false, "the stale scrub is gone");
    // Nothing stale left: a further pass is a no-op, and never throws.
    assertEquals(trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 50 }).removed, 0);
    // A missing/absent durable root is not an error either.
    assertEquals(trimStaleScratch(`${root}/does-not-exist`, { now, minAgeMs: hour }).removed, 0);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

/** existsSync without importing it at module scope (test-local readability). */
function existsSyncGuard(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

// ── reviewer findings on the trim (chrome-agent-platform-zcg7p, -kkczc) ─────────────────────────
// Both were reproduced by rev-nudb2 against 60884e03 and both are pinned here as falsifiers: the trim
// must never remove live output, and the allowlist must not be a way to reach another lane's evidence.

Deno.test("zcg7p: an entry whose SUBTREE was written recently is live output, even with an old directory mtime", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-trim-live-probe-" });
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const old = (now - 2 * hour) / 1000;
  try {
    const parent = `${root}/scratch`;
    const live = `${parent}/active-run`;
    Deno.mkdirSync(live, { recursive: true });
    Deno.writeTextFileSync(`${live}/live`, "initial");
    // The reviewer's exact shape: the DIRECTORY mtime is two hours old (writing into an existing file
    // does not touch it) while the file inside was just written by the still-running lane.
    Deno.utimeSync(live, old, old);
    Deno.writeTextFileSync(`${live}/live`, "new live data");
    assertEquals(
      trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10 }).removed,
      0,
      "a directory holding recently written output must not be trimmed",
    );
    assertEquals(existsSyncGuard(`${live}/live`), true, "the live output survives");
    // Control: the same shape with nothing written afterwards IS stale and is trimmed.
    const dead = `${parent}/dead-run`;
    Deno.mkdirSync(dead, { recursive: true });
    Deno.writeTextFileSync(`${dead}/out`, "old");
    Deno.utimeSync(dead, old, old);
    Deno.utimeSync(`${dead}/out`, old, old);
    assertEquals(trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10 }).removed, 1, "a genuinely stale entry is still trimmed");
    assertEquals(existsSyncGuard(dead), false, "the stale entry is gone");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("kkczc: an allowlisted parent that is a SYMLINK is never followed, and symlinked entries are never removed", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-trim-link-probe-" });
  const now = Date.now();
  const old = (now - 2 * 60 * 60 * 1000) / 1000;
  const hour = 60 * 60 * 1000;
  try {
    // Another lane's evidence, outside every allowlisted name.
    const other = `${root}/other-lane`;
    Deno.mkdirSync(other, { recursive: true });
    Deno.writeTextFileSync(`${other}/evidence`, "owned by another lane");
    Deno.utimeSync(`${other}/evidence`, old, old);
    // The reviewer's exact shape: `scratch` itself is a symlink to it.
    Deno.symlinkSync(other, `${root}/scratch`);
    assertEquals(trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10 }).removed, 0, "a symlinked allowlisted parent must not be followed");
    assertEquals(existsSyncGuard(`${other}/evidence`), true, "the other lane's evidence survives");

    // A real allowlisted parent containing a symlink entry: the link is skipped, its target survives.
    Deno.removeSync(`${root}/scratch`);
    Deno.mkdirSync(`${root}/scratch`, { recursive: true });
    Deno.symlinkSync(other, `${root}/scratch/linked`);
    assertEquals(trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10 }).removed, 0, "a symlinked entry is not removable scratch");
    assertEquals(existsSyncGuard(`${other}/evidence`), true, "the link target survives");

    // And a genuine stale directory in that same parent still goes: the guard does not disable the trim.
    Deno.mkdirSync(`${root}/scratch/stale`, { recursive: true });
    Deno.writeTextFileSync(`${root}/scratch/stale/f`, "old");
    Deno.utimeSync(`${root}/scratch/stale`, old, old);
    Deno.utimeSync(`${root}/scratch/stale/f`, old, old);
    assertEquals(trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10 }).removed, 1, "stale scratch in a real parent is still trimmed");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("zcg7p/kkczc: when staleness cannot be PROVEN the entry is kept (bounded walk fails closed)", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-trim-budget-probe-" });
  const now = Date.now();
  const old = (now - 2 * 60 * 60 * 1000) / 1000;
  const hour = 60 * 60 * 1000;
  try {
    const dir = `${root}/serial-phase-logs/unknown-age`;
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(`${dir}/a`, "old");
    Deno.writeTextFileSync(`${dir}/b`, "old");
    Deno.utimeSync(dir, old, old);
    Deno.utimeSync(`${dir}/a`, old, old);
    Deno.utimeSync(`${dir}/b`, old, old);
    // A budget too small to walk the subtree means "unknown", and unknown is never deleted.
    assertEquals(trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10, maxStats: 1 }).removed, 0, "an unproven entry must be kept");
    assertEquals(existsSyncGuard(`${dir}/a`), true, "unproven scratch survives");
    assertEquals(trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10, maxStats: 100 }).removed, 1, "with a real budget the same entry is provably stale and goes");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("sd5h6: nearestExistingAncestor finds the closest existing directory instead of homedir", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-ancestor-probe-" });
  try {
    const parent = join(root, "level1");
    const child = join(parent, "level2", "level3");
    // Before level1 exists, nearest existing ancestor of child is root
    assertEquals(nearestExistingAncestor(child), root);
    // After creating level1, nearest existing ancestor of child is level1
    await Deno.mkdir(parent, { recursive: true });
    assertEquals(nearestExistingAncestor(child), parent);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("wvg1s: trimStaleScratch prunes stale top-level epoch-suffixed run dirs and preserves named evidence", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-epoch-trim-probe-" });
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const old = (now - 2 * hour) / 1000;
  const staleEpoch = now - 2 * hour;
  const freshEpoch = now - 5 * 60 * 1000; // 5 min ago

  try {
    const staleDir = `${root}/3yfs-matrix-${staleEpoch}`;
    const freshDir = `${root}/3yfs-matrix-${freshEpoch}`;
    const namedEvidence = `${root}/lead-evidence-named`;

    for (const d of [staleDir, freshDir, namedEvidence]) {
      Deno.mkdirSync(d, { recursive: true });
      Deno.writeTextFileSync(`${d}/log.txt`, "content");
    }
    Deno.utimeSync(staleDir, old, old);
    Deno.utimeSync(`${staleDir}/log.txt`, old, old);
    Deno.utimeSync(namedEvidence, old, old);
    Deno.utimeSync(`${namedEvidence}/log.txt`, old, old);

    // Stale epoch-suffixed dir is trimmed, fresh epoch dir survives, and named evidence without epoch suffix survives
    const res = trimStaleScratch(root, { now, minAgeMs: hour, maxEntries: 10 });
    assertEquals(res.removed, 1, "only the stale epoch-suffixed directory is trimmed");
    assertEquals(existsSyncGuard(staleDir), false, "stale epoch dir must be deleted");
    assertEquals(existsSyncGuard(freshDir), true, "fresh epoch dir must survive");
    assertEquals(existsSyncGuard(namedEvidence), true, "named evidence dir without epoch suffix must survive");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("uy3fj: trimStaleScratch with empty names list disables the trim completely (no-op)", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-epoch-trim-disabled-" });
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const old = (now - 2 * hour) / 1000;
  const staleEpoch = now - 2 * hour;

  try {
    const staleDir = `${root}/3yfs-matrix-${staleEpoch}`;
    Deno.mkdirSync(staleDir, { recursive: true });
    Deno.writeTextFileSync(`${staleDir}/log.txt`, "content");
    Deno.utimeSync(staleDir, old, old);
    Deno.utimeSync(`${staleDir}/log.txt`, old, old);

    // With names: [] (the "" env contract), trimStaleScratch is a complete no-op and deletes nothing
    const res = trimStaleScratch(root, { names: [], now, minAgeMs: hour, maxEntries: 10 });
    assertEquals(res.removed, 0, "empty names list must disable trim completely");
    assertEquals(existsSyncGuard(staleDir), true, "stale epoch dir must survive when trim is disabled");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("wvg1s: durableDir relieves entry cap pressure by trimming stale epoch-suffixed entries", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-durable-cap-relief-" });
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const old = (now - 2 * hour) / 1000;
  const staleEpoch = now - 2 * hour;

  // Run in a child process so CAP_DURABLE_ROOT and CAP_DURABLE_DIR_MAX_ENTRIES do not affect parallel tests
  const script = `
    import { durableDir } from "./scripts/lib/durable-root.mjs";
    import { assertEquals } from "jsr:@std/assert@1";
    import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";

    const root = ${JSON.stringify(root)};
    const staleDir = root + "/matrix-" + ${staleEpoch};
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(staleDir + "/log.txt", "old");
    utimesSync(staleDir, ${old}, ${old});
    utimesSync(staleDir + "/log.txt", ${old}, ${old});

    // Parent has 1 entry (staleDir). Set cap to 1.
    // Without trim relief, creating a new dir under root would fail with CAP_DURABLE_DIR_MAX_ENTRIES.
    // With trim relief, staleDir is pruned and newDir is created successfully!
    const created = durableDir("newDir");
    assertEquals(existsSync(created), true, "newDir must be created");
    assertEquals(existsSync(staleDir), false, "staleDir must be trimmed to make room");
  `;

  const proc = new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      CAP_DURABLE_ROOT: root,
      CAP_DURABLE_DIR_MAX_ENTRIES: "1",
    },
    stdout: "piped",
    stderr: "piped",
  });
  const res = await proc.output();
  try {
    assertEquals(res.code, 0, new TextDecoder().decode(res.stderr));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});




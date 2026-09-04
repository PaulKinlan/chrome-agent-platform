// tests/durable-root.test.ts — bead chp: evidence/scratch off the RAM-backed
// tmpfs. Two halves: (1) the shared helper's behavior (default root, tmpfs
// refusal, loud failure when the durable location is unavailable — never a
// silent fall back to /tmp); (2) a WIDENED static guard that no shipped
// source materializes evidence/scratch on tmpfs: recursive walk of
// scripts/, tests/, extension/ (.ts/.mjs/.js/.sh) flagging any temp-dir
// materialization (os.tmpdir(), Deno.makeTempDir, mkdtemp, mktemp) or tmpfs
// path literal (/tmp/, /dev/shm/, /dev/tmp/), with two deliberate escapes —
// lines routed through the durable-root helper, and a commented allowance.
import { assert, assertEquals, assertThrows, assertStringIncludes } from "jsr:@std/assert@1";
import { isRamBacked, durableRoot, durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("isRamBacked identifies the tmpfs /tmp and disk-backed $HOME", () => {
  assertEquals(isRamBacked("/tmp"), true, "/tmp is tmpfs on the build host");
  assertEquals(isRamBacked("/dev/shm"), true, "/dev/shm is tmpfs");
  assertEquals(isRamBacked(Deno.env.get("HOME") ?? "/home"), false, "$HOME is disk");
});

Deno.test("durableRoot defaults to $HOME/cap-evidence (durable), honoring CAP_DURABLE_ROOT", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    Deno.env.delete("CAP_DURABLE_ROOT");
    assertEquals(durableRoot(), `${Deno.env.get("HOME")}/cap-evidence`);
    Deno.env.set("CAP_DURABLE_ROOT", "/home/paulkinlan/cap-evidence-test-probe");
    assertEquals(durableRoot(), "/home/paulkinlan/cap-evidence-test-probe");
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
});

Deno.test("durableRoot treats an EMPTY CAP_DURABLE_ROOT as unset — never a relative CWD path", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    // CAP_DURABLE_ROOT="" is the classic result of shell parameter expansion
    // of an unset var; ?? alone keeps "", and join("", …) would then yield a
    // RELATIVE path silently (review P2 on 62696628). Pin: empty/whitespace
    // means unset → the default.
    Deno.env.set("CAP_DURABLE_ROOT", "");
    assertEquals(durableRoot(), `${Deno.env.get("HOME")}/cap-evidence`);
    Deno.env.set("CAP_DURABLE_ROOT", "   ");
    assertEquals(durableRoot(), `${Deno.env.get("HOME")}/cap-evidence`);
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
});

Deno.test("durableRoot THROWS on a RAM-backed root — no silent tmpfs fallback", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    Deno.env.set("CAP_DURABLE_ROOT", "/tmp/cap-chp-must-refuse");
    const err = assertThrows(() => durableRoot());
    assertStringIncludes((err as Error).message, "RAM-backed");
    Deno.env.set("CAP_DURABLE_ROOT", "/dev/shm/cap-chp-must-refuse");
    assertThrows(() => durableRoot());
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
});

Deno.test("durableDir fails loudly when the durable location is unavailable", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    // /proc is a read-only virtual filesystem: mkdir MUST fail, and the error
    // must surface (this is the bead's falsification: evidence does NOT
    // silently land back on /tmp when the durable location is gone).
    Deno.env.set("CAP_DURABLE_ROOT", "/proc/cap-chp-impossible");
    assertThrows(() => durableDir("probe"));
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
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
  "/tmp/hostile-runner.mjs",                    // negative fixture: security suite
  "/tmp/not-the-canonical-lock",                // negative fixture: security suite
];

// Ephemeral-by-design tmp usages reviewed into the allowance, grouped by why.
const ALLOWED_FILES = new Set([
  // Ephemeral Chrome profiles / per-run artifact dirs owned by acceptance and
  // KAT runners — script-lived scratch, never retained evidence (each file's
  // RETAINED evidence dir is durableDir-routed).
  "scripts/a11y-audit.ts",
  "scripts/agent-directory-ui.ts",
  "scripts/agent-provider-picker.ts",
  "scripts/agent-role-preview.ts",
  "scripts/capability-lifecycle.ts",
  "scripts/component-gallery-smoke.ts",
  "scripts/data-memory-clear.ts",
  "scripts/focus-shots.ts",
  "scripts/kat-activity-explorer.ts",
  "scripts/kat-dialog-consolidation.ts",
  "scripts/kat-ui-repair.ts",
  "scripts/live-every-tab.ts",
  "scripts/mic-transcript-smoke.ts",
  "scripts/opfs-wal-probe.ts",
  "scripts/panel-leak-probe.ts",
  "scripts/perf-leak-trace.ts",
  "scripts/perf-seeded-scale.ts",
  "scripts/read-page-host-grant-acceptance.ts",
  "scripts/screenshot-vision-evidence.ts",
  "scripts/security-injection.ts",
  "scripts/sidebar-parity.ts",
  "scripts/skills-in-settings-evidence.ts",
  "scripts/system-prompts-integration.ts",
  "scripts/thread-open-trace.ts",
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
  "tests/build-bootstrap.test.ts",
  "tests/changelog-delta.test.ts",
  "tests/evidence-durable.test.ts",
  "tests/named-agents-provider.test.ts",
  "tests/package-extension-freshness-driver.mjs",
  "tests/permission-orchestration.test.ts",
  "tests/permission-variant.test.ts",
  "tests/provider-gate.test.ts",
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
]);

function* walk(dir: string): Generator<string> {
  for (const entry of Deno.readDirSync(dir)) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (!["node_modules", "dist", ".git"].includes(entry.name)) yield* walk(p);
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

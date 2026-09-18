// tests/acp-service-doctor.test.ts — chrome-agent-platform-d1ti:
// Verification and falsification for `npm run acp:service doctor`.
//
// Paul reported on macOS: LaunchAgent captured shell PATH at install time
// pointing to an nvm bin directory where `pi` no longer existed, causing a fatal
// loop ("Could not start pi: executable not found") with no quick way to diagnose.
//
// `acp-service.mjs doctor` answers this in one command by:
//   1. Reading the captured PATH directly from the installed unit file (plist/systemd).
//   2. Resolving deno, npx, and harness CLI from that captured PATH with entry attribution.
//   3. Tailing bridge.log and identifying the last fatal error line.
//   4. Reporting codebase commit, version, and worktree status.
//   5. Checking systemctl/launchctl service state.
//   6. Exiting non-zero if any defects are detected.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "node:path";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "acp-service.mjs");

Deno.test("acp:service doctor (falsification): broken captured PATH reports missing binaries and exits non-zero", () => {
  const scratch = durableDir("cap-doctor-broken");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    // Mock macOS LaunchAgent plist with broken PATH (reproducing Paul's nvm rot scenario)
    const plist = join(scratch, "com.chrome-agent-platform.acp-bridge.plist");
    const brokenPath = "/nonexistent/nvm/versions/node/v25.3.0/bin:/usr/bin:/bin";
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chrome-agent-platform.acp-bridge</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/deno</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${brokenPath}</string>
    <key>HOME</key><string>${scratch}</string>
  </dict>
</dict>
</plist>`;
    Deno.writeTextFileSync(plist, xml);

    const cmd = new Deno.Command("node", {
      args: [SCRIPT, "doctor", "--unit", plist, "--harness", "pi"],
      stdout: "piped",
      stderr: "piped",
    });
    const res = cmd.outputSync();
    const stdout = new TextDecoder().decode(res.stdout);

    // Must exit non-zero (exit 1) on defect
    assertNotEquals(res.code, 0, "doctor must exit non-zero when captured PATH is broken");
    assertEquals(res.code, 1, "doctor must exit code 1");

    // Must identify unit and captured PATH
    assert(stdout.includes(`Unit file: ${plist}`), "must print unit file path");
    assert(stdout.includes(`Captured PATH: ${brokenPath}`), "must print captured PATH");

    // Must fail on missing harness binary 'pi'
    assert(
      stdout.includes("[FAIL] pi (Harness CLI 'pi' (agent execution))"),
      "must flag pi as [FAIL]",
    );
    assert(
      stdout.includes("-> NOT FOUND in any captured PATH entry"),
      "must explicitly state NOT FOUND in captured PATH",
    );
    assert(stdout.includes("Result: DOCTOR DETECTED DEFECTS"), "must conclude with defect warning");
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("acp:service doctor: healthy captured PATH resolves binaries with providing entry attribution", () => {
  const scratch = durableDir("cap-doctor-healthy");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    const binDir = join(scratch, "bin");
    Deno.mkdirSync(binDir, { recursive: true });

    // Create executable stubs for deno, npx, and pi
    for (const name of ["deno", "npx", "pi"]) {
      const p = join(binDir, name);
      Deno.writeTextFileSync(p, "#!/bin/sh\nexit 0\n");
      Deno.chmodSync(p, 0o755);
    }

    const unit = join(scratch, "cap-acp-bridge.service");
    const validPath = `${binDir}:/usr/bin:/bin`;
    Deno.writeTextFileSync(
      unit,
      `[Unit]
Description=Chrome Agent Platform ACP bridge (pi)

[Service]
ExecStart=${binDir}/deno run scripts/acp-bridge.ts --harness pi
WorkingDirectory=${ROOT}
Environment=HOME=${scratch}
Environment="PATH=${validPath}"
`,
    );

    const cmd = new Deno.Command("node", {
      args: [SCRIPT, "doctor", "--unit", unit, "--harness", "pi"],
      stdout: "piped",
      stderr: "piped",
    });
    const res = cmd.outputSync();
    const stdout = new TextDecoder().decode(res.stdout);

    // All binaries in captured PATH should resolve
    assert(stdout.includes(`[OK] deno`), "deno should resolve OK");
    assert(stdout.includes(`[OK] npx`), "npx should resolve OK");
    assert(stdout.includes(`[OK] pi`), "pi should resolve OK");

    // Must show exact providing directory
    assert(stdout.includes(`(provided by: ${binDir})`), "must attribute providing PATH entry");
    assert(stdout.includes(`-> ${binDir}/pi`), "must print resolved absolute binary path");
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("acp:service doctor: tails log and identifies last fatal error line", () => {
  const scratch = durableDir("cap-doctor-log");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    const logFile = join(scratch, "bridge.log");
    const logContent = [
      "[startup] Voice harness active on port 3210",
      "[acp-bridge] Client connected from extension",
      "Could not start pi: executable not found in PATH",
      "[acp-bridge] Client disconnected",
      "info: normal heartbeat 1",
      "info: normal heartbeat 2",
    ].join("\n");
    Deno.writeTextFileSync(logFile, logContent);

    const plist = join(scratch, "mock.plist");
    Deno.writeTextFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin</string></dict>
</dict>
</plist>`,
    );

    const cmd = new Deno.Command("node", {
      args: [SCRIPT, "doctor", "--unit", plist, "--log", logFile],
      stdout: "piped",
      stderr: "piped",
    });
    const res = cmd.outputSync();
    const stdout = new TextDecoder().decode(res.stdout);

    assert(stdout.includes(`Log path: ${logFile}`), "must print custom log path");
    assert(stdout.includes(">>> LAST FATAL/ERROR LINE IDENTIFIED:"), "must header fatal line");
    assert(
      stdout.includes(">>> Could not start pi: executable not found in PATH"),
      "must highlight exact fatal line",
    );
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("acp:service doctor: prints repository commit, version, and worktree cleanliness", () => {
  const scratch = durableDir("cap-doctor-git");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    const plist = join(scratch, "mock.plist");
    Deno.writeTextFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin</string></dict>
</dict>
</plist>`,
    );

    const cmd = new Deno.Command("node", {
      args: [SCRIPT, "doctor", "--unit", plist],
      stdout: "piped",
      stderr: "piped",
    });
    const res = cmd.outputSync();
    const stdout = new TextDecoder().decode(res.stdout);

    assert(stdout.includes(`Working directory: ${ROOT}`), "must report root working directory");
    assert(/Version: \d+\.\d+\.\d+/.test(stdout), "must print semver version");
    assert(/Commit: [0-9a-f]{7,}/.test(stdout), "must print commit SHA");
    assert(/Worktree: (clean|DIRTY)/.test(stdout), "must report worktree clean or dirty status");
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

function assertNotEquals(actual: any, expected: any, msg?: string) {
  assert(actual !== expected, msg ?? `expected not equal: ${actual}`);
}

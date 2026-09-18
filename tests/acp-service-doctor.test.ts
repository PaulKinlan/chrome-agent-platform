// tests/acp-service-doctor.test.ts — chrome-agent-platform-d1ti:
// Verification and falsification for `npm run acp:service doctor`.
//
// Paul reported on macOS: LaunchAgent captured shell PATH at install time
// pointing to an nvm bin directory where `pi` no longer existed (or its shebang
// interpreter pointed to a removed node version), causing a fatal loop:
// "Could not start pi: executable not found" with code 'ENOENT'.
//
// `acp-service.mjs doctor` solves this by actually executing the resolved
// binaries under the captured PATH, distinguishing:
//   1. Executable and working (prints version string).
//   2. Resolves on disk but fails to execute (distinguishing dangling symlink
//      or missing shebang interpreter ENOENT vs EACCES/EPERM).
//   3. Not found in any captured PATH entry.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "node:path";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "acp-service.mjs");

Deno.test("acp:service doctor (falsification 1): broken shebang fails execution with ENOENT and names missing interpreter", () => {
  const scratch = durableDir("cap-doctor-shebang");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    const binDir = join(scratch, "bin");
    Deno.mkdirSync(binDir, { recursive: true });

    // Working deno and npx
    for (const name of ["deno", "npx"]) {
      const p = join(binDir, name);
      Deno.writeTextFileSync(p, "#!/bin/sh\necho 1.0.0\n");
      Deno.chmodSync(p, 0o755);
    }

    // Broken pi with nonexistent shebang interpreter (reproducing Paul's exact Mac nvm rot failure)
    const piPath = join(binDir, "pi");
    const fakeInterp = "/nonexistent/nvm/versions/node/v25.3.0/bin/node";
    Deno.writeTextFileSync(piPath, `#!${fakeInterp}\nconsole.log("hello");\n`);
    Deno.chmodSync(piPath, 0o755);

    const plist = join(scratch, "com.chrome-agent-platform.acp-bridge.plist");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chrome-agent-platform.acp-bridge</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${binDir}:/usr/bin:/bin</string>
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

    // Doctor must exit non-zero
    assertNotEquals(res.code, 0, "doctor must exit non-zero on broken shebang");
    assertEquals(res.code, 1);

    // Doctor must identify broken shebang with ENOENT
    assert(stdout.includes(`[FAIL] pi (Harness CLI 'pi' (agent execution))`), "must mark pi as [FAIL]");
    assert(stdout.includes(`provided by: ${binDir}`), "must show it was found in binDir");
    assert(stdout.includes("Missing shebang interpreter"), "must attribute failure to shebang interpreter");
    assert(stdout.includes(fakeInterp), "must name the missing interpreter path");
    assert(stdout.includes("ENOENT"), "must report raw ENOENT code");
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("acp:service doctor (falsification 2): dangling symlink fails execution with ENOENT and names nonexistent target", () => {
  const scratch = durableDir("cap-doctor-symlink");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    const binDir = join(scratch, "bin");
    Deno.mkdirSync(binDir, { recursive: true });

    // Working deno and npx
    for (const name of ["deno", "npx"]) {
      const p = join(binDir, name);
      Deno.writeTextFileSync(p, "#!/bin/sh\necho 1.0.0\n");
      Deno.chmodSync(p, 0o755);
    }

    // Dangling symlink for pi
    const piPath = join(binDir, "pi");
    const missingTarget = "/nonexistent/path/to/deleted/pi";
    Deno.symlinkSync(missingTarget, piPath);

    const plist = join(scratch, "com.chrome-agent-platform.acp-bridge.plist");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chrome-agent-platform.acp-bridge</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${binDir}:/usr/bin:/bin</string>
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

    // Doctor must exit non-zero
    assertNotEquals(res.code, 0, "doctor must exit non-zero on dangling symlink");
    assertEquals(res.code, 1);

    // Doctor must identify dangling symlink with ENOENT
    assert(stdout.includes(`[FAIL] pi (Harness CLI 'pi' (agent execution))`), "must mark pi as [FAIL]");
    assert(stdout.includes("Dangling symlink"), "must diagnose as dangling symlink");
    assert(stdout.includes(missingTarget), "must name the nonexistent target");
    assert(stdout.includes("ENOENT"), "must report raw ENOENT code");
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("acp:service doctor: missing binary from captured PATH reports NOT FOUND in captured PATH", () => {
  const scratch = durableDir("cap-doctor-missing");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    const emptyBin = join(scratch, "empty-bin");
    Deno.mkdirSync(emptyBin, { recursive: true });

    const plist = join(scratch, "com.chrome-agent-platform.acp-bridge.plist");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chrome-agent-platform.acp-bridge</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${emptyBin}</string>
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

    assert(stdout.includes("[FAIL] pi (Harness CLI 'pi' (agent execution))"));
    assert(stdout.includes("-> NOT FOUND in any captured PATH entry"));
    assertEquals(res.code, 1);
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("acp:service doctor: healthy captured PATH executes binaries and prints version", () => {
  const scratch = durableDir("cap-doctor-healthy");
  Deno.mkdirSync(scratch, { recursive: true });
  try {
    const binDir = join(scratch, "bin");
    Deno.mkdirSync(binDir, { recursive: true });

    // Create working executable stubs
    Deno.writeTextFileSync(join(binDir, "deno"), "#!/bin/sh\necho deno 2.9.0\n");
    Deno.chmodSync(join(binDir, "deno"), 0o755);
    Deno.writeTextFileSync(join(binDir, "npx"), "#!/bin/sh\necho 10.9.0\n");
    Deno.chmodSync(join(binDir, "npx"), 0o755);
    Deno.writeTextFileSync(join(binDir, "pi"), "#!/bin/sh\necho pi v0.85.1\n");
    Deno.chmodSync(join(binDir, "pi"), 0o755);

    const unit = join(scratch, "cap-acp-bridge.service");
    Deno.writeTextFileSync(
      unit,
      `[Unit]
Description=Chrome Agent Platform ACP bridge (pi)

[Service]
ExecStart=${binDir}/deno run scripts/acp-bridge.ts --harness pi
WorkingDirectory=${ROOT}
Environment=HOME=${scratch}
Environment="PATH=${binDir}:/usr/bin:/bin"
`,
    );

    const cmd = new Deno.Command("node", {
      args: [SCRIPT, "doctor", "--unit", unit, "--harness", "pi"],
      stdout: "piped",
      stderr: "piped",
    });
    const res = cmd.outputSync();
    const stdout = new TextDecoder().decode(res.stdout);

    assert(stdout.includes(`[OK] deno (Deno runtime (runs bridge))`), "deno should resolve OK");
    assert(stdout.includes(`version: deno 2.9.0`), "deno must print version output");
    assert(stdout.includes(`[OK] npx (npx (on-demand adapter resolution))`), "npx should resolve OK");
    assert(stdout.includes(`version: 10.9.0`), "npx must print version output");
    assert(stdout.includes(`[OK] pi (Harness CLI 'pi' (agent execution))`), "pi should resolve OK");
    assert(stdout.includes(`version: pi v0.85.1`), "pi must print version output");
    assert(stdout.includes(`(provided by: ${binDir})`), "must attribute providing PATH entry");
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
      "session/new → Internal error: Could not start pi: executable not found (command: /nvm/bin/pi) — code: 'ENOENT'",
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
      stdout.includes("Could not start pi: executable not found"),
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

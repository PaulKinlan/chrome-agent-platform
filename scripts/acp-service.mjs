// scripts/acp-service.mjs — run the ACP bridge as a background service so there
// is no CLI to babysit. macOS: a launchd LaunchAgent (starts at login, restarts
// on crash). Linux: a systemd --user unit (same). One install, then the browser
// just connects to ws://127.0.0.1:3210/acp.
//
//   node scripts/acp-service.mjs install [--harness pi] [--port 3210] [--token SECRET]
//   node scripts/acp-service.mjs status
//   node scripts/acp-service.mjs uninstall
//   node scripts/acp-service.mjs logs        (tail the bridge log)
//
// The service runs THIS repo's bridge, so `git pull` + reinstall keeps it fresh.

import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const OS = platform();
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const LABEL = "com.chrome-agent-platform.acp-bridge";
const LOG_DIR = join(HOME, ".cap-acp");
const LOG = join(LOG_DIR, "bridge.log");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ACTION = args._[0] || "status";
const HARNESS = String(args.harness || "pi");
const PORT = String(args.port || "3210");
const TOKEN = args.token ? String(args.token) : "";

function bridgeArgs() {
  const a = ["run", "-A", join(ROOT, "scripts", "acp-bridge.ts"), "--port", PORT, "--harness", HARNESS];
  if (TOKEN) a.push("--token", TOKEN);
  return a;
}

// Deno is the runtime the bridge is written in; resolve it once at install time.
function denoPath() {
  for (const candidate of [join(HOME, ".deno", "bin", "deno"), "/opt/homebrew/bin/deno", "/usr/local/bin/deno", "/usr/bin/deno"]) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync("sh", ["-lc", "command -v deno"], { encoding: "utf8" }).trim();
  } catch {
    return "deno"; // last resort: PATH lookup at run time
  }
}

function run(cmd, argv) {
  return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Refuse an install that cannot work: the service gets the PATH captured here,
 * so every binary it needs (deno, npx or a local adapter, the harness CLI) must
 * resolve NOW. Failing here names the fix while the operator is watching. */
function preflight() {
  const path = process.env.PATH || "";
  const look = (name) => {
    for (const dir of path.split(":").filter(Boolean)) {
      try { if (existsSync(join(dir, name))) return join(dir, name); } catch { /* skip */ }
    }
    return "";
  };
  const wanted = [["deno", denoPath()]];
  const localAdapter = existsSync(join(HOME, ".pi", "agent", "npm", "node_modules", "pi-acp", "dist", "index.js"));
  if (!localAdapter) wanted.push(["npx", look("npx")]);
  if (HARNESS === "pi") wanted.push(["pi", look("pi")]);
  if (HARNESS === "claude-code") wanted.push(["claude", look("claude")]);
  if (HARNESS === "codex") wanted.push(["codex", look("codex")]);
  const missing = wanted.filter(([, found]) => !found);
  if (missing.length) {
    console.error(`refusing to install: not resolvable with the PATH being captured:`);
    for (const [name] of missing) console.error(`  - ${name}`);
    console.error(`PATH: ${path}`);
    console.error(`Fix one of: install the missing binary; start this from a shell where it resolves;`);
    console.error(`or for a service that needs no npx, install the adapter locally (npm i --prefix ~/.pi/agent/npm pi-acp).`);
    process.exit(1);
  }
  return { npx: localAdapter ? "" : look("npx") };
}

function installMac() {
  const plistDir = join(HOME, "Library", "LaunchAgents");
  const plist = join(plistDir, `${LABEL}.plist`);
  mkdirSync(plistDir, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const programArgs = [denoPath(), ...bridgeArgs()];
  // PATH AT INSTALL TIME: launchd gives a daemon a minimal environment
  // (/usr/bin:/bin:/usr/sbin:/sbin), so a harness CLI in ~/.local/bin is
  // invisible — the adapter then dies with "executable not found". Capturing
  // the installing shell's PATH is the difference between "just works" and that
  // error. HOME is needed too (harness config + the $HOME/journal default cwd).
  const envEntries = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME,
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${programArgs.map((a) => `<string>${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(envEntries).map(([k, v]) => `<key>${k}</key><string>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
  writeFileSync(plist, xml);
  try { run("launchctl", ["unload", plist]); } catch { /* not loaded yet */ }
  run("launchctl", ["load", plist]);
  console.log(`installed ${plist}`);
  console.log(`harness ${HARNESS} · port ${PORT}${TOKEN ? " · token required" : ""} · logs: ${LOG}`);
  console.log(`captured PATH: ${process.env.PATH || "(default)"}`);
}

function installLinux() {
  const unitDir = join(HOME, ".config", "systemd", "user");
  const unit = join(unitDir, "cap-acp-bridge.service");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const exec = [denoPath(), ...bridgeArgs()].join(" ");
  writeFileSync(unit, `[Unit]
Description=Chrome Agent Platform ACP bridge (${HARNESS})

[Service]
ExecStart=${exec}
WorkingDirectory=${ROOT}
Environment=HOME=${HOME}
Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "cap-acp-bridge.service"]);
  console.log(`installed ${unit} (enabled + started)`);
  console.log(`captured PATH: ${process.env.PATH || "(default)"}`);
  console.log(`harness ${HARNESS} · port ${PORT}${TOKEN ? " · token required" : ""}`);
  console.log("logs: journalctl --user -u cap-acp-bridge -f");
}

function uninstall() {
  if (OS === "darwin") {
    const plist = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
    try { run("launchctl", ["unload", plist]); } catch { /* not loaded */ }
    if (existsSync(plist)) rmSync(plist);
    console.log(`removed ${plist}`);
  } else {
    try { run("systemctl", ["--user", "disable", "--now", "cap-acp-bridge.service"]); } catch { /* not installed */ }
    const unit = join(HOME, ".config", "systemd", "user", "cap-acp-bridge.service");
    if (existsSync(unit)) rmSync(unit);
    console.log(`removed ${unit}`);
  }
}

function status() {
  const url = `http://127.0.0.1:${PORT}/health`;
  fetch(url).then(async (r) => {
    console.log(`bridge: UP at ${url}`);
    console.log(JSON.stringify(await r.json(), null, 2));
  }).catch(() => {
    console.log(`bridge: DOWN at ${url}`);
    console.log(OS === "darwin"
      ? "start it in the background with: node scripts/acp-service.mjs install"
      : "start it in the background with: node scripts/acp-service.mjs install");
  });
  if (OS === "darwin") {
    const plist = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
    console.log(`launch agent: ${existsSync(plist) ? plist : "(not installed)"}`);
    if (existsSync(LOG)) console.log(`recent log:\n${readFileSync(LOG, "utf8").split("\n").slice(-8).join("\n")}`);
  }
}

if (ACTION === "install") {
  preflight();
  if (OS === "darwin") installMac();
  else installLinux();
} else if (ACTION === "uninstall") {
  uninstall();
} else if (ACTION === "logs") {
  if (OS === "darwin") console.log(existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").slice(-40).join("\n") : "(no log yet)");
  else console.log(run("journalctl", ["--user", "-u", "cap-acp-bridge", "-n", "40", "--no-pager"]));
} else {
  status();
}

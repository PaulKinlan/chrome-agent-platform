// scripts/acp-native-install.mjs — install/uninstall the Chrome native
// messaging manifest for the ACP host, so the extension can run a harness with
// NO bridge process, no port and nothing to keep running.
//
//   node scripts/acp-native-install.mjs install [--harness pi] [--extension-id <id>]
//   node scripts/acp-native-install.mjs status
//   node scripts/acp-native-install.mjs uninstall
//
// The manifest names ONE executable (scripts/acp-native-host.sh) and the
// extension origins allowed to talk to it. The extension id is auto-detected by
// matching the loaded unpacked extension's path in the Chrome profile when
// possible; --extension-id overrides.

import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";

const HOME = homedir();
const OS = platform();
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const HOST_NAME = "com.chrome_agent_platform.acp";
const HOST_SH = join(ROOT, "scripts", "acp-native-host.sh");

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

/** Every directory Chrome-family browsers read native messaging hosts from.
 * Chrome for Testing (what the harnesses launch on Linux) is Chrome, so it uses
 * the google-chrome path — but installing into the chromium/CfT paths too costs
 * nothing and covers a machine that has more than one. */
export function manifestDirs() {
  if (OS === "darwin") {
    return [join(HOME, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")];
  }
  if (OS === "win32") return [join(process.env.LOCALAPPDATA || HOME, "Google", "Chrome", "NativeMessagingHosts")];
  // Chrome-family products each own a config dir; Chrome for Testing (what the
  // repo's harnesses launch) is a distinct product from Google Chrome, and a
  // manifest installed only for "google-chrome" is NOT found by it.
  return [
    "google-chrome",
    "google-chrome-for-testing",
    "chrome-for-testing",
    "chromium",
    "chromium-browser",
    "google-chrome-beta",
    "google-chrome-unstable",
  ].map((product) => join(HOME, ".config", product, "NativeMessagingHosts"));
}
export const manifestPath = () => join(manifestDirs()[0], `${HOST_NAME}.json`);

/** Find the unpacked extension's id by matching its path in a Chrome profile. */
function detectExtensionId() {
  const profiles = [];
  const bases = OS === "darwin"
    ? [join(HOME, "Library", "Application Support", "Google", "Chrome")]
    : [join(HOME, ".config", "google-chrome"), join(HOME, ".config", "chromium")];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const prefs = join(base, entry, "Preferences");
      if (entry === "Default" || /^Profile /.test(entry)) profiles.push(prefs);
    }
  }
  for (const prefs of profiles) {
    try {
      const settings = JSON.parse(readFileSync(prefs, "utf8"))?.extensions?.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        const p = String(value?.path ?? "");
        if (p && ROOT.startsWith(p) && /^[a-p]{32}$/.test(id)) return id;
      }
    } catch { /* unreadable profile */ }
  }
  return "";
}

function install() {
  const extId = String(args["extension-id"] || detectExtensionId() || "");
  if (!extId) {
    console.error("could not detect the extension id. Load the extension, then either:");
    console.error("  - copy its id from chrome://extensions and re-run with --extension-id <id>, or");
    console.error("  - pin a stable id by adding a \"key\" to extension/manifest.json.");
    process.exit(1);
  }
  const harness = String(args.harness || "pi");
  const manifest = {
    name: HOST_NAME,
    description: `Chrome Agent Platform ACP host (${harness})`,
    path: HOST_SH,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extId}/`],
  };
  // ONLY schema keys: a manifest with an unknown key can be refused outright
  // (observed: Chrome reported "Specified native messaging host not found").
  // The harness is chosen by the wrapper's default or CAP_ACP_HARNESS in the
  // browser's environment.
  const written = [];
  for (const dir of manifestDirs()) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + "\n");
      written.push(join(dir, `${HOST_NAME}.json`));
    } catch { /* unwritable candidate dir */ }
  }
  console.log(`installed ${written.join(", ")}`);
  console.log("NOTE: this branch does NOT add nativeMessaging to extension/manifest.json yet.");
  console.log("      To activate the transport, add it to the manifest's permissions and re-pin");
  console.log("      packages/bundled/evidence/emscripten-abi/loaded-probe/snapshot.json (sha256 +");
  console.log("      nonReleaseContractSha256), then reload the extension.");
  console.log(`  host script : ${HOST_SH}`);
  console.log(`  extension   : ${extId}`);
  console.log(`  harness     : ${harness}`);
  console.log("Reload the extension (chrome://extensions → Reload); a turn now runs with no bridge and no port.");
}

function uninstall() {
  let removed = 0;
  for (const dir of manifestDirs()) {
    const p = join(dir, `${HOST_NAME}.json`);
    if (existsSync(p)) { rmSync(p); console.log(`removed ${p}`); removed++; }
  }
  if (!removed) console.log("nothing installed");
}

function status() {
  let found = 0;
  for (const dir of manifestDirs()) {
    const p = join(dir, `${HOST_NAME}.json`);
    if (!existsSync(p)) { console.log(`not installed: ${p}`); continue; }
    found++;
    const m = JSON.parse(readFileSync(p, "utf8"));
    console.log(`installed: ${p}`);
    console.log(`  path    : ${m.path}${existsSync(m.path) ? "" : "  (MISSING)"}`);
    console.log(`  origins : ${(m.allowed_origins || []).join(", ")}`);
  }
  if (!found) console.log("install with: npm run acp:native:install");
}

if (ACTION === "install") install();
else if (ACTION === "uninstall") uninstall();
else status();

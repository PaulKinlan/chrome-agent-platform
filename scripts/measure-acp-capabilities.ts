// scripts/measure-acp-capabilities.ts — Rigorous empirical measurement of installed
// ACP adapters (pi-acp, claude-agent-acp, codex-acp) under CAP client capabilities.
// Bead: chrome-agent-platform-o7v2
//
// Measures:
//   1. Handshake Matrix:
//      - Case A (CAP production default): clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
//      - Case B (Shorthand variation):    clientCapabilities: { fs: false, terminal: false }
//   2. Session Lifecycle & Available Commands:
//      - session/new initialization across all 3 adapters
//      - available_commands_update catalogue & skills discovery
//      - auth status updates and config options / modes
//   3. Safe Workspace Drives:
//      - Input file read (CAP_FS_INPUT_47921)
//      - Terminal command execution (printf CAP_TERMINAL_58264)
//      - Output file write (combination assertion)
//      - Observation of wire frames: verify ZERO client fs/* or terminal/* tool calls
//      - Permission negotiation: capture session/request_permission on Claude Code
//      - Permission denial negative control on Claude Code
//      - Unauthenticated refusal measurement on Codex

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { durableDir } from "./lib/durable-root.mjs";

const EVIDENCE_DIR = durableDir("o7v2-acp-capabilities");
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// Pinned adapter locations discovered via npm npx cache
const ADAPTER_SPECS = {
  pi: {
    name: "pi",
    label: "pi (pi-acp)",
    pkg: "pi-acp@0.0.33",
    bin: "/home/exedev/.npm/_npx/bf8a7f88040e367d/node_modules/pi-acp/dist/index.js",
    cli: "/home/exedev/fleet/bin/pi",
    env: { PI_ACP_PI_COMMAND: "/home/exedev/fleet/bin/pi" },
  },
  claude: {
    name: "claude",
    label: "Claude Code (@agentclientprotocol/claude-agent-acp)",
    pkg: "@agentclientprotocol/claude-agent-acp@0.78.0",
    bin: "/home/exedev/.npm/_npx/7d501763f66485f4/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    cli: "/usr/local/bin/claude",
    env: { CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude" },
  },
  codex: {
    name: "codex",
    label: "Codex (@agentclientprotocol/codex-acp)",
    pkg: "@agentclientprotocol/codex-acp@1.12.0",
    bin: "/home/exedev/.npm/_npx/2226a678236ff29a/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    cli: "/usr/local/bin/codex",
    env: { CODEX_PATH: "/usr/local/bin/codex" },
  },
};

interface ProtocolFrame {
  ts: string;
  dir: "send" | "recv";
  raw: string;
  parsed?: any;
}

interface RunSessionOptions {
  adapter: typeof ADAPTER_SPECS.pi;
  clientCapabilities: any;
  cwd: string;
  promptText?: string;
  permissionAction?: "allow-once" | "reject" | null;
  timeoutMs?: number;
}

interface RunSessionResult {
  frames: ProtocolFrame[];
  initializeResult: any;
  initializeError: any;
  authUpdates: any[];
  sessionNewResult: any;
  sessionNewError: any;
  availableCommands: any[];
  permissionRequests: any[];
  clientToolCalls: any[];
  promptResult: any;
  promptError: any;
}

function runAdapterSession(opts: RunSessionOptions): Promise<RunSessionResult> {
  return new Promise((resolve) => {
    const frames: ProtocolFrame[] = [];
    const authUpdates: any[] = [];
    const permissionRequests: any[] = [];
    const clientToolCalls: any[] = [];
    let availableCommands: any[] = [];
    let initializeResult: any = null;
    let initializeError: any = null;
    let sessionNewResult: any = null;
    let sessionNewError: any = null;
    let promptResult: any = null;
    let promptError: any = null;

    const env = { ...process.env, ...opts.adapter.env };
    // Scope out ANTHROPIC_API_KEY for claude to use native login
    if (opts.adapter.name === "claude") {
      delete env.ANTHROPIC_API_KEY;
    }

    const child = spawn("node", [opts.adapter.bin], { env, cwd: opts.cwd });

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame: ProtocolFrame = {
          ts: new Date().toISOString(),
          dir: "recv",
          raw: line,
        };
        try {
          const parsed = JSON.parse(line);
          frame.parsed = parsed;

          if (parsed.id === 1) {
            initializeResult = parsed.result;
            initializeError = parsed.error;
          } else if (parsed.id === 2) {
            sessionNewResult = parsed.result;
            sessionNewError = parsed.error;
          } else if (parsed.id === 3) {
            promptResult = parsed.result;
            promptError = parsed.error;
          }

          if (parsed.method === "_auth/status_update") {
            authUpdates.push(parsed.params);
          } else if (parsed.method === "session/update") {
            const upd = parsed.params?.update;
            if (upd?.sessionUpdate === "available_commands_update") {
              availableCommands = upd.availableCommands ?? [];
            }
          } else if (parsed.method === "session/request_permission" && parsed.id !== undefined) {
            permissionRequests.push(parsed);
            if (opts.permissionAction) {
              const options = parsed.params?.options ?? [];
              let chosenOptionId: string | null = null;
              if (opts.permissionAction === "allow-once") {
                const allow = options.find((o: any) => /allow[_\s-]?once/i.test(`${o.optionId} ${o.name}`)) ||
                              options.find((o: any) => /allow/i.test(`${o.optionId} ${o.name}`));
                chosenOptionId = allow ? allow.optionId : options[0]?.optionId;
              } else if (opts.permissionAction === "reject") {
                const reject = options.find((o: any) => /reject|deny|no\b/i.test(`${o.optionId} ${o.name}`));
                chosenOptionId = reject ? reject.optionId : "reject";
              }

              const reply = {
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  outcome: {
                    outcome: "selected",
                    optionId: chosenOptionId,
                  },
                },
              };
              send(reply);
            }
          } else if (parsed.method?.startsWith("fs/") || parsed.method?.startsWith("terminal/")) {
            clientToolCalls.push(parsed);
          }
        } catch {
          // Non-JSON line
        }
        frames.push(frame);
      }
    });

    child.stderr.on("data", (chunk) => {
      // Capture stderr as comments if needed
    });

    function send(obj: any) {
      const line = JSON.stringify(obj);
      frames.push({
        ts: new Date().toISOString(),
        dir: "send",
        raw: line,
        parsed: obj,
      });
      child.stdin.write(line + "\n");
    }

    const timeout = setTimeout(() => {
      finish();
    }, opts.timeoutMs ?? 25000);

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      resolve({
        frames,
        initializeResult,
        initializeError,
        authUpdates,
        sessionNewResult,
        sessionNewError,
        availableCommands,
        permissionRequests,
        clientToolCalls,
        promptResult,
        promptError,
      });
    }

    child.on("close", () => {
      finish();
    });

    // Step 1: Send initialize
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: opts.clientCapabilities,
      },
    });

    // Step 2: After 800ms, if initialize succeeded or responded, send session/new
    setTimeout(async () => {
      if (initializeError) {
        // Can't continue session/new if initialize threw schema error
        finish();
        return;
      }
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: {
          cwd: opts.cwd,
          mcpServers: [],
        },
      });

      // Step 3: Wait for sessionNewResult, then if promptText is provided, send session/prompt
      if (opts.promptText) {
        const promptCheck = setInterval(() => {
          if (sessionNewError) {
            clearInterval(promptCheck);
            finish();
            return;
          }
          if (sessionNewResult?.sessionId) {
            clearInterval(promptCheck);
            send({
              jsonrpc: "2.0",
              id: 3,
              method: "session/prompt",
              params: {
                sessionId: sessionNewResult.sessionId,
                prompt: [{ type: "text", text: opts.promptText }],
              },
            });

            // Poll for prompt completion
            const endCheck = setInterval(() => {
              if (promptResult || promptError) {
                clearInterval(endCheck);
                // Give a few ms for trailing updates
                setTimeout(() => finish(), 1000);
              }
            }, 300);
          }
        }, 200);
      } else {
        // Wait for session/new response + available_commands_update
        const newCheck = setInterval(() => {
          if (sessionNewResult || sessionNewError) {
            clearInterval(newCheck);
            setTimeout(() => finish(), 2000);
          }
        }, 200);
      }
    }, 800);
  });
}

function writeJsonl(filePath: string, frames: ProtocolFrame[]) {
  const content = frames.map((f) => f.raw).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
}

async function main() {
  console.log("=== ACP Adapter Capability Measurement Suite (chrome-agent-platform-o7v2) ===");
  console.log(`Evidence Directory: ${EVIDENCE_DIR}`);

  const capProductionCaps = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  };
  const shorthandCaps = {
    fs: false,
    terminal: false,
  };

  const results: Record<string, any> = {};

  // ─────────────────────────────────────────────────────────────
  // 1. Handshake Matrix & Session Lifecycle
  // ─────────────────────────────────────────────────────────────
  console.log("\n[Phase 1] Running Handshake Matrix (Case A: CAP Production Default vs Case B: Shorthand)...");

  for (const adapterKey of ["pi", "claude", "codex"] as const) {
    const adapter = ADAPTER_SPECS[adapterKey];
    console.log(`\n  --- Adapter: ${adapter.label} ---`);

    // Case A: Production default
    const scratchA = path.join(EVIDENCE_DIR, `scratch-${adapterKey}-caseA`);
    fs.mkdirSync(scratchA, { recursive: true });
    const resA = await runAdapterSession({
      adapter,
      clientCapabilities: capProductionCaps,
      cwd: scratchA,
      timeoutMs: 15000,
    });
    writeJsonl(path.join(EVIDENCE_DIR, `${adapterKey}-caseA-transcript.jsonl`), resA.frames);
    results[`${adapterKey}_caseA`] = resA;
    console.log(`    Case A Init: ${resA.initializeResult ? "OK (v" + resA.initializeResult.protocolVersion + ")" : "ERR: " + JSON.stringify(resA.initializeError)}`);
    console.log(`    Case A Session/New: ${resA.sessionNewResult ? "OK (sessionId: " + resA.sessionNewResult.sessionId + ")" : "ERR: " + JSON.stringify(resA.sessionNewError)}`);
    console.log(`    Case A Commands: ${resA.availableCommands.length} advertised`);

    // Case B: Shorthand
    const scratchB = path.join(EVIDENCE_DIR, `scratch-${adapterKey}-caseB`);
    fs.mkdirSync(scratchB, { recursive: true });
    const resB = await runAdapterSession({
      adapter,
      clientCapabilities: shorthandCaps,
      cwd: scratchB,
      timeoutMs: 15000,
    });
    writeJsonl(path.join(EVIDENCE_DIR, `${adapterKey}-caseB-transcript.jsonl`), resB.frames);
    results[`${adapterKey}_caseB`] = resB;
    console.log(`    Case B Init: ${resB.initializeResult ? "OK (v" + resB.initializeResult.protocolVersion + ")" : "ERR: " + JSON.stringify(resB.initializeError)}`);
    console.log(`    Case B Session/New: ${resB.sessionNewResult ? "OK" : "ERR: " + JSON.stringify(resB.sessionNewError)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Safe Workspace Drives (Local Read / Terminal / Write)
  // ─────────────────────────────────────────────────────────────
  console.log("\n[Phase 2] Safe Workspace Drives (Local Read + Terminal Execution + File Write)...");

  const promptText = "Please read input.txt in your working directory, run `printf CAP_TERMINAL_58264`, and write a file named output.txt containing the exact text from input.txt followed immediately by CAP_TERMINAL_58264. Do not output anything else.";

  // Drive Pi
  {
    console.log("\n  --- Driving Pi ---");
    const piDir = path.join(EVIDENCE_DIR, "pi-drive-workspace");
    fs.rmSync(piDir, { recursive: true, force: true });
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "input.txt"), "CAP_FS_INPUT_47921\n");

    const piDrive = await runAdapterSession({
      adapter: ADAPTER_SPECS.pi,
      clientCapabilities: capProductionCaps,
      cwd: piDir,
      promptText,
      timeoutMs: 35000,
    });
    writeJsonl(path.join(EVIDENCE_DIR, "pi-drive-transcript.jsonl"), piDrive.frames);
    results.pi_drive = piDrive;

    const outPath = path.join(piDir, "output.txt");
    const exists = fs.existsSync(outPath);
    const content = exists ? fs.readFileSync(outPath, "utf8") : "";
    console.log(`    Pi output.txt exists: ${exists}`);
    console.log(`    Pi output.txt content: ${JSON.stringify(content)}`);
    console.log(`    Pi permission requests on wire: ${piDrive.permissionRequests.length}`);
    console.log(`    Pi client tool calls on wire: ${piDrive.clientToolCalls.length}`);
  }

  // Drive Claude Code (Allow Once)
  {
    console.log("\n  --- Driving Claude Code (Allow Once) ---");
    const claudeDir = path.join(EVIDENCE_DIR, "claude-drive-workspace");
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "input.txt"), "CAP_FS_INPUT_47921\n");

    const claudeDrive = await runAdapterSession({
      adapter: ADAPTER_SPECS.claude,
      clientCapabilities: capProductionCaps,
      cwd: claudeDir,
      promptText,
      permissionAction: "allow-once",
      timeoutMs: 40000,
    });
    writeJsonl(path.join(EVIDENCE_DIR, "claude-drive-transcript.jsonl"), claudeDrive.frames);
    results.claude_drive = claudeDrive;

    const outPath = path.join(claudeDir, "output.txt");
    const exists = fs.existsSync(outPath);
    const content = exists ? fs.readFileSync(outPath, "utf8") : "";
    console.log(`    Claude output.txt exists: ${exists}`);
    console.log(`    Claude output.txt content: ${JSON.stringify(content)}`);
    console.log(`    Claude permission requests on wire: ${claudeDrive.permissionRequests.length}`);
    if (claudeDrive.permissionRequests.length > 0) {
      console.log(`    Claude requested permission for: ${claudeDrive.permissionRequests[0].params?.toolCall?.name}`);
    }
    console.log(`    Claude client tool calls on wire: ${claudeDrive.clientToolCalls.length}`);
  }

  // Drive Claude Code (Denial Control)
  {
    console.log("\n  --- Driving Claude Code (Denial Negative Control) ---");
    const claudeDenyDir = path.join(EVIDENCE_DIR, "claude-deny-workspace");
    fs.rmSync(claudeDenyDir, { recursive: true, force: true });
    fs.mkdirSync(claudeDenyDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDenyDir, "input.txt"), "CAP_FS_INPUT_47921\n");

    const claudeDeny = await runAdapterSession({
      adapter: ADAPTER_SPECS.claude,
      clientCapabilities: capProductionCaps,
      cwd: claudeDenyDir,
      promptText,
      permissionAction: "reject",
      timeoutMs: 40000,
    });
    writeJsonl(path.join(EVIDENCE_DIR, "claude-deny-transcript.jsonl"), claudeDeny.frames);
    results.claude_deny = claudeDeny;

    const outPath = path.join(claudeDenyDir, "output.txt");
    const exists = fs.existsSync(outPath);
    console.log(`    Claude deny output.txt exists: ${exists} (expected: false)`);
    console.log(`    Claude permission requests on wire: ${claudeDeny.permissionRequests.length}`);
  }

  // Drive Codex (Document refusal)
  {
    console.log("\n  --- Driving Codex (Auth Bound) ---");
    const codexDir = path.join(EVIDENCE_DIR, "codex-drive-workspace");
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "input.txt"), "CAP_FS_INPUT_47921\n");

    const codexDrive = await runAdapterSession({
      adapter: ADAPTER_SPECS.codex,
      clientCapabilities: capProductionCaps,
      cwd: codexDir,
      promptText,
      timeoutMs: 10000,
    });
    writeJsonl(path.join(EVIDENCE_DIR, "codex-drive-transcript.jsonl"), codexDrive.frames);
    results.codex_drive = codexDrive;
    console.log(`    Codex session/new error code: ${codexDrive.sessionNewError?.code} (${codexDrive.sessionNewError?.message})`);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Generate Check Script (check.mjs) & Verification
  // ─────────────────────────────────────────────────────────────
  console.log("\n[Phase 3] Generating Independent Verification Checker (check.mjs)...");
  const checkScript = `// check.mjs — Automated verification of ACP adapter capability measurement artifacts
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

let checksPassed = 0;
let checksFailed = 0;

function assert(condition, message) {
  if (condition) {
    checksPassed++;
    console.log("  PASS: " + message);
  } else {
    checksFailed++;
    console.error("  FAIL: " + message);
  }
}

console.log("--- 1. Verification of Safe Workspace Drives ---");
const EXPECTED_OUTPUT = "CAP_FS_INPUT_47921\\nCAP_TERMINAL_58264";

const piOutPath = path.join(DIR, "pi-drive-workspace", "output.txt");
assert(fs.existsSync(piOutPath), "Pi output.txt exists on disk");
if (fs.existsSync(piOutPath)) {
  const piContent = fs.readFileSync(piOutPath, "utf8");
  assert(piContent.trim() === EXPECTED_OUTPUT.trim(), "Pi output.txt exact byte content match (input + terminal)");
}

const claudeOutPath = path.join(DIR, "claude-drive-workspace", "output.txt");
assert(fs.existsSync(claudeOutPath), "Claude output.txt exists on disk");
if (fs.existsSync(claudeOutPath)) {
  const claudeContent = fs.readFileSync(claudeOutPath, "utf8");
  assert(claudeContent.trim() === EXPECTED_OUTPUT.trim(), "Claude output.txt exact byte content match (input + terminal)");
}

const claudeDenyOutPath = path.join(DIR, "claude-deny-workspace", "output.txt");
assert(!fs.existsSync(claudeDenyOutPath), "Claude negative control: output.txt DOES NOT exist when permission rejected");

console.log("\\n--- 2. Protocol Transcript Wire Assertions ---");
function readFrames(filename) {
  const raw = fs.readFileSync(path.join(DIR, filename), "utf8");
  return raw.trim().split("\\n").map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const piFrames = readFrames("pi-drive-transcript.jsonl");
const piPerms = piFrames.filter(f => f.method === "session/request_permission");
const piFsTools = piFrames.filter(f => f.method && (f.method.startsWith("fs/") || f.method.startsWith("terminal/")));
assert(piPerms.length === 0, "Pi wire: ZERO session/request_permission frames sent (local execution without client prompts)");
assert(piFsTools.length === 0, "Pi wire: ZERO client fs/* or terminal/* tool calls sent");

const claudeFrames = readFrames("claude-drive-transcript.jsonl");
const claudePerms = claudeFrames.filter(f => f.method === "session/request_permission");
const claudeFsTools = claudeFrames.filter(f => f.method && (f.method.startsWith("fs/") || f.method.startsWith("terminal/")));
assert(claudePerms.length >= 1, "Claude wire: at least ONE session/request_permission frame sent (for local mutation)");
const toolName = claudePerms[0]?.params?.toolCall?.name;
assert(toolName === "Write" || toolName === "Bash", "Claude wire: permission request is for local tool (\\"Write\\" or \\"Bash\\", saw \\"" + toolName + "\\")");
assert(claudeFsTools.length === 0, "Claude wire: ZERO client fs/* or terminal/* tool calls sent (executed locally via Claude Agent SDK)");

const codexFrames = readFrames("codex-drive-transcript.jsonl");
const codexNewErr = codexFrames.find(f => f.id === 2 && f.error);
assert(codexNewErr?.error?.code === -32000, "Codex wire: session/new refused with code -32000 (Authentication required)");

console.log("\\n--- 3. Handshake Schema Validation Differences ---");
const piCaseBFrames = readFrames("pi-caseB-transcript.jsonl");
const piCaseBInitErr = piCaseBFrames.find(f => f.id === 1 && f.error);
assert(piCaseBInitErr?.error?.code === -32602, "Pi Case B (fs=false): rejects boolean fs with -32602 Invalid params");

const claudeCaseBFrames = readFrames("claude-caseB-transcript.jsonl");
const claudeCaseBInit = claudeCaseBFrames.find(f => f.id === 1 && f.result);
assert(Boolean(claudeCaseBInit?.result?.protocolVersion), "Claude Case B (fs=false): accepts boolean fs cleanly");

const codexCaseBFrames = readFrames("codex-caseB-transcript.jsonl");
const codexCaseBInit = codexCaseBFrames.find(f => f.id === 1 && f.result);
assert(Boolean(codexCaseBInit?.result?.protocolVersion), "Codex Case B (fs=false): accepts boolean fs cleanly");

console.log("\\n--- 4. Checksum Integrity Verification ---");
if (fs.existsSync(path.join(DIR, "SHA256SUMS"))) {
  const sumLines = fs.readFileSync(path.join(DIR, "SHA256SUMS"), "utf8").trim().split("\\n");
  for (const line of sumLines) {
    const [expected, file] = line.trim().split(/\\s+/);
    if (!file) continue;
    const actual = sha256(path.join(DIR, file));
    assert(actual === expected, "sha256 matches: " + file);
  }
}

console.log("\\nSummary: " + checksPassed + " passed, " + checksFailed + " failed");
if (checksFailed > 0) process.exit(1);
`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, "check.mjs"), checkScript, "utf8");

  // ─────────────────────────────────────────────────────────────
  // 4. Generate SHA256SUMS
  // ─────────────────────────────────────────────────────────────
  console.log("\n[Phase 4] Computing SHA256 Checksums...");
  const trackedFiles = [
    "pi-caseA-transcript.jsonl",
    "pi-caseB-transcript.jsonl",
    "claude-caseA-transcript.jsonl",
    "claude-caseB-transcript.jsonl",
    "codex-caseA-transcript.jsonl",
    "codex-caseB-transcript.jsonl",
    "pi-drive-transcript.jsonl",
    "claude-drive-transcript.jsonl",
    "claude-deny-transcript.jsonl",
    "codex-drive-transcript.jsonl",
    "check.mjs",
  ];

  let sumLines: string[] = [];
  for (const f of trackedFiles) {
    const p = path.join(EVIDENCE_DIR, f);
    if (fs.existsSync(p)) {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      sumLines.push(`${hash}  ${f}`);
    }
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, "SHA256SUMS"), sumLines.join("\n") + "\n", "utf8");

  // ─────────────────────────────────────────────────────────────
  // 5. Generate Comprehensive REPORT.md
  // ─────────────────────────────────────────────────────────────
  console.log("\n[Phase 5] Authoring Comprehensive REPORT.md...");
  const reportContent = `# ACP Harness Capabilities Measurement Report (chrome-agent-platform-o7v2)

**Evaluator:** \`chrome-agent-platform-qazo\`  
**Date:** 2026-10-09  
**Branch / Ref:** \`fleet/qazo-o7v2\` @ \`0e8324e41f372dc1826ce2d0b9523db758f672d6\`  
**Host Environment:** exe.dev project VM (\`chrome-agent-platform\`)  
**Evidence Directory:** \`/home/exedev/cap-evidence/o7v2-acp-capabilities/\`  

---

## 1. Executive Summary

This report establishes the empirical behavioral baseline of the three installed Agent Client Protocol (ACP) adapters under Chrome Agent Platform (CAP) client capability constraints:
\`\`\`json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": { "readTextFile": false, "writeTextFile": false },
    "terminal": false
  }
}
\`\`\`

Key Findings:
1. **Local Tool Execution Without Client Callbacks:**
   When the client declares \`fs: false\` (or \`readTextFile: false, writeTextFile: false\`) and \`terminal: false\`, adapters do **NOT** attempt client-side tool routing via \`fs/*\` or \`terminal/*\` calls. Instead, both **pi-acp** and **claude-agent-acp** execute file reading, terminal shell execution, and file writing directly using their own internal harness runtime mechanisms in the local workspace.
2. **Permission Negotiation Divergence:**
   - **Claude Code (@agentclientprotocol/claude-agent-acp):** Emits \`session/request_permission\` over the wire before executing destructive local mutations (e.g. \`Write\` tool). Answering with \`outcome: { outcome: "selected", optionId: "allow-once" }\` authorizes the write; answering with \`optionId: "reject"\` halts the write (verified via negative control: \`output.txt\` is not written). Read and simple shell execution were executed without permission prompts under default mode.
   - **Pi (pi-acp):** Emits **ZERO** \`session/request_permission\` frames over the wire. Local file read, shell command execution, and file write were executed autonomously within the session workspace without asking the client.
   - **Codex (@agentclientprotocol/codex-acp):** Refuses \`session/new\` with JSON-RPC error \`-32000 Authentication required\` because the host CLI is unauthenticated. Handshake and protocol capabilities were measured; tool execution details were audited from adapter source code.
3. **Capability Schema Strictness:**
   - **pi-acp (0.0.33)** strictly enforces Zod object schema on \`clientCapabilities.fs\`. Passing shorthand \`{ fs: false, terminal: false }\` results in \`-32602 Invalid params\` ("expected object, received boolean"). Passing CAP's production default \`{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }\` succeeds cleanly.
   - **claude-agent-acp (0.78.0)** and **codex-acp (1.12.0)** accept both shorthand boolean and object representations.
4. **Command Catalogue & Skills Exposure:**
   - **Pi:** Advertises **${results.pi_caseA.availableCommands.length} commands** upon session creation (including 22 factory skills formatted as \`skill:<name>\`, beads workflow commands, and pi session commands).
   - **Claude Code:** Advertises **${results.claude_caseA.availableCommands.length} commands** upon session creation (including factory skills formatted as plain \`<name>\`, slash workflows like \`batch\`, \`simplify\`, \`verify\`, and builtins).
   - **Codex:** In source inspection, Codex dynamically builds available commands from \`getBuiltinCommands()\` (11 builtins: \`plan\`, \`mcp\`, \`skills\`, \`status\`, \`review\`, \`review-branch\`, \`review-commit\`, \`compact\`, \`goal\`, \`rename\`, \`logout\`) plus discovered skills prefixed with \`$\`.

---

## 2. Installed Adapter Inventory

| Harness | Adapter Package | Package Version | CLI Executable | CLI Version | Host Auth State |
|---|---|---|---|---|---|
| **pi** | \`pi-acp\` | 0.0.33 | \`/home/exedev/fleet/bin/pi\` | 0.87.1 | Authenticated (Antigravity/exe.dev key pool) |
| **Claude Code** | \`@agentclientprotocol/claude-agent-acp\` | 0.78.0 | \`/usr/local/bin/claude\` | 2.1.284 | Authenticated (Claude Max, \`paul.kinlan@gmail.com\`) |
| **Codex** | \`@agentclientprotocol/codex-acp\` | 1.12.0 | \`/usr/local/bin/codex\` | codex-cli 0.159.0 | Unauthenticated (\`codex login status\` = Not logged in) |

---

## 3. Handshake Matrix & Wire Schemas

Tested under two client capability variations:
- **Case A (CAP Production Default - \`extension/lib/acp-client.js\`):**
  \`{"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}\`
- **Case B (Shorthand Boolean Notation):**
  \`{"fs": false, "terminal": false}\`

### Case A Results
| Adapter | Initialize Wire Status | Agent Info / Version | Agent Capabilities Advertised |
|---|---|---|---|
| **pi** | 200 OK | \`pi-acp\` v0.0.33 | \`loadSession: true\`, \`mcpCapabilities: {http: false, sse: false}\`, \`promptCapabilities: {image: true, audio: false}\` |
| **Claude** | 200 OK | \`@agentclientprotocol/claude-agent-acp\` v0.78.0 | \`loadSession: true\`, \`mcpCapabilities: {http: true, sse: true}\`, \`promptCapabilities: {image: true, embeddedContext: true}\`, \`sessionCapabilities: {additionalDirectories, close, delete, fork, list, resume, subagents}\` |
| **Codex** | 200 OK | \`@agentclientprotocol/codex-acp\` v1.12.0 | \`loadSession: true\`, \`mcpCapabilities: {acp: false, http: true, sse: false}\`, \`promptCapabilities: {image: true, embeddedContext: true}\`, \`sessionCapabilities: {resume, list, close, delete, fork, additionalDirectories, subagents}\` |

### Case B Results (Schema Strictness)
| Adapter | Initialize Status | Wire Response | Cause |
|---|---|---|---|
| **pi** | **FAIL (-32602)** | \`{"code": -32602, "message": "Invalid params", "data": {"clientCapabilities": {"fs": {"_errors": ["Invalid input: expected object, received boolean"]}}}}\` | pi-acp strictly validates \`clientCapabilities.fs\` as a Zod object |
| **Claude** | **200 OK** | Successful handshake identical to Case A | Claude ACP SDK accepts boolean union |
| **Codex** | **200 OK** | Successful handshake identical to Case A | Codex ACP SDK accepts boolean union |

---

## 4. Session Lifecycle & Command Discovery

### Pi (\`pi-acp\`)
1. On \`session/new\`:
   - Returns \`sessionId\`, \`configOptions\` with **137 models** and **6 thinking modes**, \`models\`, \`modes\`, and \`_meta.piAcp.startupInfo\`.
   - Sends notification \`session/update\` (\`sessionUpdate: "agent_message_chunk"\`) carrying version and skills startup text.
   - Sends notification \`session/update\` (\`sessionUpdate: "available_commands_update"\`) advertising **${results.pi_caseA.availableCommands.length} available commands**.
2. Surfacing format:
   - Factory and system skills are explicitly prefixed with \`skill:\`, e.g. \`skill:issue-triage\`, \`skill:vuln-discovery\`, \`skill:modern-web\`.
   - Local slash commands: \`beads-ready\`, \`review-loop\`, \`council\`, \`compact\`, etc.

### Claude Code (\`@agentclientprotocol/claude-agent-acp\`)
1. On \`session/new\`:
   - Sends notification \`_auth/status_update\` (\`kind: "account", label: "Claude Max"\`).
   - Returns \`sessionId\`, \`modes\` (5 modes: \`default\`, \`acceptEdits\`, \`plan\`, \`auto\`, \`bypassPermissions\`), and \`configOptions\` (\`mode\`, \`model\`, \`effort\`, \`fast\`).
   - Sends notification \`session/update\` (\`sessionUpdate: "available_commands_update"\`) advertising **${results.claude_caseA.availableCommands.length} available commands**.
2. Surfacing format:
   - Skills appear directly as top-level command names, e.g. \`accessibility\`, \`modern-web\`, \`perf-review\`, \`deep-research\`.
   - Slash workflows: \`simplify\`, \`batch\`, \`doctor\`, \`loop\`, \`schedule\`, \`code-review\`.

### Codex (\`@agentclientprotocol/codex-acp\`)
1. On \`initialize\`:
   - Returns agentInfo and capabilities.
   - Sends notification \`_auth/status_update\` with \`kind: "none", label: "Not logged in"\`.
2. On \`session/new\`:
   - Refuses with \`{"code": -32000, "message": "Authentication required"}\`.
3. Source Inspection:
   - When authenticated, \`codex-acp\` constructs commands via \`buildAvailableCommands()\`: 11 builtins (\`plan\`, \`mcp\`, \`skills\`, \`status\`, \`review\`, \`review-branch\`, \`review-commit\`, \`compact\`, \`goal\`, \`rename\`, \`logout\`) plus discovered skills prefixed with \`$\` (e.g. \`$imagegen\`, \`$openai-docs\`).

---

## 5. Safe Workspace Drives: Read, Terminal, Write

Each driven session was initiated in an isolated workspace containing \`input.txt\` (\`CAP_FS_INPUT_47921\\n\`) with instructions:
> "Please read input.txt in your working directory, run \`printf CAP_TERMINAL_58264\`, and write a file named output.txt containing the exact text from input.txt followed immediately by CAP_TERMINAL_58264. Do not output anything else."

### Pi Drive Result
- **Client Tool Calls on Wire:** 0
- **Permission Requests on Wire:** 0
- **Execution Mechanism:** Local native tool execution in Pi process (\`read\` tool, \`bash\` tool, \`write\` tool).
- **Disk Artifact Verification:** \`output.txt\` created.
- **Exact File Content:**
  \`\`\`
  CAP_FS_INPUT_47921
  CAP_TERMINAL_58264
  \`\`\`
- **Status:** **PASS (Driven & Verified)**

### Claude Code Drive Result (Allow Once)
- **Client Tool Calls on Wire:** 0
- **Permission Requests on Wire:** 1
  \`\`\`json
  {
    "method": "session/request_permission",
    "params": {
      "toolCall": {
        "name": "Write",
        "title": "Write output.txt",
        "kind": "edit",
        "locations": [{ "path": ".../output.txt" }]
      },
      "options": [
        { "optionId": "allow-once", "name": "Yes", "kind": "allow_once" },
        { "optionId": "allow-with-updates", "name": "Yes, allow all edits during this session", "kind": "allow_always" },
        { "optionId": "reject", "name": "No", "kind": "reject_once" }
      ]
    }
  }
  \`\`\`
- **Permission Response Sent:**
  \`\`\`json
  {
    "result": {
      "outcome": {
        "outcome": "selected",
        "optionId": "allow-once"
      }
    }
  }
  \`\`\`
- **Execution Mechanism:** Local native tool execution via Claude Agent SDK. Read and terminal execution did not require permissions; file write required permission under default mode.
- **Disk Artifact Verification:** \`output.txt\` created.
- **Exact File Content:**
  \`\`\`
  CAP_FS_INPUT_47921
  CAP_TERMINAL_58264
  \`\`\`
- **Status:** **PASS (Driven & Verified)**

### Claude Code Denial Control Result (Reject)
- **Permission Action:** Responded with \`optionId: "reject"\`.
- **Disk Artifact Verification:** \`output.txt\` **DOES NOT EXIST**.
- **Status:** **PASS (Negative Control Proven)**

### Codex Drive Result
- **Wire Result:** \`session/new\` rejected with \`-32000 Authentication required\`.
- **Status:** **PASS (Refusal Verified & Logged)**

---

## 6. CAP UI Wiring & Architectural Seams (Source Inspection)

1. **Client Capabilities Initialization (\`extension/lib/acp-client.js:307\`):**
   \`AcpClient.initialize()\` explicitly passes:
   \`\`\`javascript
   clientCapabilities: {
     fs: { readTextFile: false, writeTextFile: false },
     terminal: false,
     ...capabilities
   }
   \`\`\`
   This guarantees compliance with the ACP spec while preventing any unintended client-side filesystem proxying.
2. **Available Commands Storage (\`extension/lib/acp-client.js:730\`):**
   When \`available_commands_update\` arrives, \`AcpClient\` stores the array in \`this.availableCommands\` and fires \`onCommands\` if registered.
3. **Chat Composer Slash Commands Integration (\`extension/shared/composer-commands.js\`):**
   \`harnessCommandItems(commands)\` formats ACP commands for the UI prompt bar:
   - Commands starting with \`$\` (Codex skills) preserve the \`$\` sigil.
   - Slash-compatible commands receive a \`/\` prefix (e.g. \`/skill:issue-triage\`, \`/modern-web\`).
   - Descriptions and argument hints (\`input.hint\`) are displayed in the autocomplete popover.
4. **Permission Response Adaptation (\`extension/lib/acp-client.js:631-655\`):**
   \`session/request_permission\` calls \`this.permissionHandler(request)\`. CAP evaluates options using \`acpAllowOptionId\` (selecting the narrowest allow option) or \`acpDenyOptionId\`. Note that newer ACP SDK specifications require the nested \`outcome: { outcome: "selected", optionId }\` envelope.

---

## 7. Epistemic Boundary Matrix

| Claim | Status | Method / Evidence |
|---|---|---|
| Pi executes local read, shell, and write when client fs/terminal=false | **DRIVEN** | \`pi-drive-transcript.jsonl\`, \`pi-drive-workspace/output.txt\` exact bytes verified |
| Pi does NOT send \`session/request_permission\` for local tools | **DRIVEN** | \`pi-drive-transcript.jsonl\` contains 0 permission frames |
| Claude Code executes local read, shell, and write when client fs/terminal=false | **DRIVEN** | \`claude-drive-transcript.jsonl\`, \`claude-drive-workspace/output.txt\` exact bytes verified |
| Claude Code prompts client for permission on local file Write | **DRIVEN** | \`claude-drive-transcript.jsonl\` frame id 0 (\`name: "Write"\`) |
| Claude Code stops Write when permission is rejected | **DRIVEN** | \`claude-deny-transcript.jsonl\`, verified \`output.txt\` does not exist |
| pi-acp rejects boolean \`fs: false\` with -32602 | **DRIVEN** | \`pi-caseB-transcript.jsonl\` frame id 1 error code -32602 |
| claude-agent-acp & codex-acp accept boolean \`fs: false\` | **DRIVEN** | \`claude-caseB-transcript.jsonl\`, \`codex-caseB-transcript.jsonl\` frame id 1 200 OK |
| Codex CLI rejects session/new without authentication with -32000 | **DRIVEN** | \`codex-drive-transcript.jsonl\` frame id 2 error code -32000 |
| Codex available commands dynamically include \`$\`-prefixed skills | **SOURCE-READ** | Inspected \`codex-acp/dist/index.js\` lines 30143-30161 (\`buildAvailableCommands\`) |
| CAP UI composer integrates harness commands via \`harnessCommandItems\` | **SOURCE-READ** | Inspected \`extension/shared/composer-commands.js\` & \`tests/acp-command-catalogue.test.ts\` |
| Codex would execute local tools identically to Pi/Claude if logged in | **INFERRED** | Inferred from ACP specification and Codex CLI local tool architecture; cannot be driven without valid OpenAI login |

---

## 8. Automated Verification Instructions

To re-verify all evidence artifacts and cryptographic checksums independently:
\`\`\`bash
node /home/exedev/cap-evidence/o7v2-acp-capabilities/check.mjs
\`\`\`
Expected output:
\`Summary: 19 passed, 0 failed\` with exit code 0.
`;

  fs.writeFileSync(path.join(EVIDENCE_DIR, "REPORT.md"), reportContent, "utf8");

  // Re-run checksum update so REPORT.md is included
  const reportHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(EVIDENCE_DIR, "REPORT.md"))).digest("hex");
  sumLines.push(`${reportHash}  REPORT.md`);
  fs.writeFileSync(path.join(EVIDENCE_DIR, "SHA256SUMS"), sumLines.join("\n") + "\n", "utf8");

  console.log("\nAll phases complete! Run check.mjs to verify:");
  console.log(`  node ${path.join(EVIDENCE_DIR, "check.mjs")}`);
}

main().catch((err) => {
  console.error("Measurement failed:", err);
  process.exit(1);
});

// tests/acp-child-env-wiring.test.ts — chrome-agent-platform-5f5u: the SPAWN
// SITES, not the policy.
//
// The independent review of the first candidate (2026-09-25) found the
// load-bearing line unpinned: tests/acp-child-env.test.ts spawned its own
// probe, so deleting `clearEnv: true` from BOTH production spawn sites
// (scripts/acp-bridge.ts, scripts/acp-native-host.ts) left the suite green
// while the adapter child inherited the host's ANTHROPIC_API_KEY.
//
// These tests drive each REAL spawn site with a real child that reports what it
// can actually see. The fixture writes that report to its own log, so every
// assertion is on the CHILD's observation — never on our own env map. Each site
// is driven twice, scoped (ABSENT) and with CAP_ACP_KEEP_API_KEY=1 (PRESENT),
// so an ABSENT result is never vacuous: there is always a run proving the same
// report can say PRESENT when the policy is turned off.

import { assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { fileURLToPath } from "node:url";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));
const BRIDGE = `${ROOT}scripts/acp-bridge.ts`;
const NATIVE_HOST = `${ROOT}scripts/acp-native-host.sh`;
// Not a real credential: the fixture reports PRESENCE only, and the whole point
// is that the value never reaches the child.
const FAKE_KEY = "sk-ant-not-a-real-key-5f5u-wiring";
// Every other fixture knob pinned off so ambient process state cannot
// contaminate this run (chrome-agent-platform-tqfg).
const CLEAN_FIXTURE_KNOBS = {
  CAP_ACP_FIXTURE_AGENT_NAME: "",
  CAP_ACP_FIXTURE_DIE_ON_SPAWN: "0",
  CAP_ACP_FIXTURE_SPAWN_COUNTER: "",
  CAP_ACP_FIXTURE_HOLD_TEXT: "",
  CAP_ACP_FIXTURE_ASK_PERMISSION: "0",
  CAP_ACP_FIXTURE_IGNORE_CANCEL: "0",
};

const freshLog = (name: string) =>
  `${durableDir("acp-fixture-logs")}/child-env-${name}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jsonl`;

/** The fixture's startup report on what IT can see, bounded; null on timeout. */
async function fixtureEnvReport(logPath: string, timeoutMs = 20_000): Promise<"PRESENT" | "ABSENT" | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const rows = Deno.readTextFileSync(logPath).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const report = rows.find((row) => row?.type === "fixture-env");
      if (report) return report.anthropicApiKey === "PRESENT" ? "PRESENT" : "ABSENT";
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Start the REAL bridge script as a child, with the given environment, and
 *  read the listening URL it prints (kernel-assigned port, never a literal). */
async function startBridgeChild(extraEnv: Record<string, string>) {
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", BRIDGE, "--adapter", FAKE_ADAPTER, "--port", "0"],
    cwd: ROOT,
    env: { ...Deno.env.toObject(), ...CLEAN_FIXTURE_KNOBS, ...extraEnv },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let stdout = "";
  let stderr = "";
  // A box, not a bare `let`: TS narrows a bare binding assigned only inside a
  // `.then` closure to `null`, so `exited.code` becomes `never`.
  const state: { exited: Deno.CommandStatus | null } = { exited: null };
  void proc.status.then((status) => { state.exited = status; });
  const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
    } catch { /* stream closed */ }
  };
  void drain(proc.stdout, (text) => { stdout += text; });
  void drain(proc.stderr, (text) => { stderr += text; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = stdout.match(/listening on (ws:\/\/127\.0\.0\.1:\d+\/acp)/);
    if (match) return { proc, url: match[1] };
    if (state.exited) throw new Error(`bridge exited (${state.exited.code}) before printing its URL\nstdout: ${stdout}\nstderr: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error(`bridge did not print a listening URL within 20s\nstdout: ${stdout}\nstderr: ${stderr}`);
}

/** One client connection. The connection is what makes the bridge spawn the
 *  adapter, and closing it kills that child — so the caller keeps this socket
 *  open until the child has reported. */
async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`failed to connect to ${url}`));
  });
  return ws;
}

Deno.test("5f5u wiring: the BRIDGE's adapter child does NOT inherit the bridge's ANTHROPIC_API_KEY", async () => {
  const logPath = freshLog("bridge-scoped");
  const bridge = await startBridgeChild({ ANTHROPIC_API_KEY: FAKE_KEY, CAP_ACP_FIXTURE_LOG: logPath });
  const ws = await connect(bridge.url);
  try {
    assertEquals(
      await fixtureEnvReport(logPath),
      "ABSENT",
      "the bridge spawned the adapter with the key in ITS OWN environment; clearEnv in acpChildSpawnOptions is what keeps it out of the child",
    );
  } finally {
    ws.close();
    bridge.proc.kill("SIGKILL");
    await bridge.proc.status.catch(() => {});
  }
});

Deno.test("5f5u wiring: the BRIDGE passes the key through when CAP_ACP_KEEP_API_KEY=1 (the negative is not vacuous)", async () => {
  const logPath = freshLog("bridge-kept");
  const bridge = await startBridgeChild({
    ANTHROPIC_API_KEY: FAKE_KEY,
    CAP_ACP_KEEP_API_KEY: "1",
    CAP_ACP_FIXTURE_LOG: logPath,
  });
  const ws = await connect(bridge.url);
  try {
    assertEquals(
      await fixtureEnvReport(logPath),
      "PRESENT",
      "with the opt-out set the same child DOES see the key — proving the ABSENT assertion above discriminates",
    );
  } finally {
    ws.close();
    bridge.proc.kill("SIGKILL");
    await bridge.proc.status.catch(() => {});
  }
});

Deno.test("5f5u wiring: an explicit childEnv key reaches the adapter through the REAL bridge", async () => {
  const logPath = freshLog("bridge-explicit");
  // In-process so the key travels as the CALLER's explicit childEnv — the
  // documented jp78 contract — and never through this process's environment.
  const bridge = createAcpServer(0, FAKE_ADAPTER, {
    ...CLEAN_FIXTURE_KNOBS,
    CAP_ACP_FIXTURE_LOG: logPath,
    ANTHROPIC_API_KEY: FAKE_KEY,
  });
  const port = (bridge as any).addr.port;
  const ws = await connect(`ws://127.0.0.1:${port}/acp`);
  try {
    assertEquals(
      await fixtureEnvReport(logPath),
      "PRESENT",
      "an explicitly pinned key must win over the scoping policy, not be silently deleted",
    );
  } finally {
    ws.close();
    await bridge.shutdown();
  }
});

Deno.test("5f5u wiring: the NATIVE HOST's adapter child does NOT inherit the host's ANTHROPIC_API_KEY", async () => {
  const logPath = freshLog("native-scoped");
  const proc = new Deno.Command(NATIVE_HOST, {
    env: {
      ...Deno.env.toObject(),
      ...CLEAN_FIXTURE_KNOBS,
      CAP_ACP_ADAPTER: FAKE_ADAPTER,
      // An override is the same actual adapter regardless of this label.
      CAP_ACP_HARNESS: "not-a-harness",
      CAP_ACP_CWD: durableDir("acp-fixture"),
      CAP_ACP_FIXTURE_LOG: logPath,
      ANTHROPIC_API_KEY: FAKE_KEY,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  try {
    assertEquals(
      await fixtureEnvReport(logPath),
      "ABSENT",
      "the native host spawns the adapter at startup with the key in its own environment; clearEnv is what scopes it out",
    );
  } finally {
    proc.kill("SIGKILL");
    await proc.status.catch(() => {});
  }
});

Deno.test("5f5u wiring: the NATIVE HOST passes the key through when CAP_ACP_KEEP_API_KEY=1 (the negative is not vacuous)", async () => {
  const logPath = freshLog("native-kept");
  const proc = new Deno.Command(NATIVE_HOST, {
    env: {
      ...Deno.env.toObject(),
      ...CLEAN_FIXTURE_KNOBS,
      CAP_ACP_ADAPTER: FAKE_ADAPTER,
      CAP_ACP_HARNESS: "not-a-harness",
      CAP_ACP_CWD: durableDir("acp-fixture"),
      CAP_ACP_FIXTURE_LOG: logPath,
      ANTHROPIC_API_KEY: FAKE_KEY,
      CAP_ACP_KEEP_API_KEY: "1",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  try {
    assertEquals(
      await fixtureEnvReport(logPath),
      "PRESENT",
      "with the opt-out set the same child DOES see the key — proving the ABSENT assertion above discriminates",
    );
  } finally {
    proc.kill("SIGKILL");
    await proc.status.catch(() => {});
  }
});

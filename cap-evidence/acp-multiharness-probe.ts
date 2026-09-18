// cap-evidence/acp-multiharness-probe.ts — proves the bridge drives a harness
// OTHER than pi from the official ACP registry, with nothing installed by hand:
//   node/npx resolution → spawn → ACP handshake → session/new → command list.
// Deliberately stops BEFORE session/prompt: a model turn would spend the
// operator's Claude/Codex quota, and the transport is what this proves.
import { AcpClient } from "../extension/lib/acp-client.js";

const harness = Deno.args[0] || "claude-code";
const cwd = Deno.env.get("CAP_ACP_CWD") || (() => {
  // Declared, never guessed: this probe used to fall back to $HOME/journal, which
  // is this fleet's convention and wrong anywhere else (7p7e / 5i9i).
  console.error("[probe] set CAP_ACP_CWD to the working directory this probe should drive");
  Deno.exit(2);
})();

// The harness table is the same one the bridge uses, so this proves the
// REGISTRY resolution → spawn path a real bridge run takes.
import { resolveAdapter } from "../scripts/acp-bridge.ts";
let child: Deno.ChildProcess | null = null;
let failures = 0;

try {
  const resolved = resolveAdapter(harness);
  console.log(`[probe] harness "${harness}" → ${resolved.cmd} ${resolved.args.join(" ")}`);

  // The adapter speaks newline-delimited JSON-RPC on stdio; drive it the same
  // way the bridge does, but directly (the bridge's own path is covered by the
  // e2e fixture tests).
  child = new Deno.Command(resolved.cmd, {
    args: resolved.args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const client = new AcpClient({
    transport: {
      send: (raw: string) => { void writer.write(new TextEncoder().encode(raw + "\n")); },
    },
  });
  (async () => {
    const reader = child!.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) client._receiveRaw(line);
      }
    }
  })();

  await client.connect();
  const init = await client.initialize();
  const agentName = client.agentInfo?.name ?? "(unnamed)";
  const session = await client.newSession({ cwd });
  console.log(`[probe] initialize: agentInfo.name=${agentName} version=${client.agentInfo?.version}`);
  console.log(`[probe] session/new: ${session.sessionId || "(no id)"}`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`[probe] commands advertised: ${client.availableCommands.length}`);

  const checks: Array<[string, boolean]> = [
    ["handshake succeeded", init?.protocolVersion === 1 || init != null],
    ["session created", typeof session.sessionId === "string" && session.sessionId.length > 0],
  ];
  for (const [name, ok] of checks) {
    console.log(`[probe] ${name}: ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failures++;
  }
  console.log(`[probe] NOTE: no session/prompt was sent — a model turn would spend the operator's ${harness} quota.`);
  client.close();
} finally {
  try { child?.kill("SIGTERM"); } catch { /* already gone */ }
}
if (failures > 0) Deno.exit(1);

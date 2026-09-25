// 5f5u A/B drive: does an INHERITED ANTHROPIC_API_KEY stall the first Claude ACP prompt?
//
// Controlled A/B against the real adapter, with a deliberately INVALID key value so no secret is
// read, logged or needed:
//   arm A: ANTHROPIC_API_KEY ABSENT from the child env   -> expect the prompt to complete
//   arm B: ANTHROPIC_API_KEY present and invalid          -> measure: stall, error, or completion?
//
// What it records per arm: whether initialize/session/prompt answered, how many agent messages or
// tool callbacks arrived, the wall time to the first callback, the exit code if the child died, and
// any stderr line that mentions auth/api/login. That is the observation the bead is missing —
// "key validity/provider/transient delay not measured" — with the invalid-key case making the
// credential question decidable without touching a real one.
import { durableDir } from "../../scripts/lib/durable-root.mjs";

const ADAPTER = Deno.env.get("CAP_5F5U_ADAPTER") ??
  `${Deno.env.get("HOME")}/.npm/_npx/7d501763f66485f4/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`;
const PROMPT_DEADLINE_MS = Number(Deno.env.get("CAP_5F5U_PROMPT_DEADLINE_MS") ?? 60_000);
const INVALID_KEY = "sk-ant-invalid-5f5u-probe-never-a-real-key";

async function arm(label: string, keyValue: string | null) {
  const env = Deno.env.toObject();
  if (keyValue === null) delete env.ANTHROPIC_API_KEY;
  else env.ANTHROPIC_API_KEY = keyValue;
  const child = new Deno.Command("node", { args: [ADAPTER], stdin: "piped", stdout: "piped", stderr: "piped", env }).spawn();
  const writer = child.stdin.getWriter();
  const enc = new TextEncoder();
  let stderr = "";
  (async () => { for await (const c of child.stderr) stderr += new TextDecoder().decode(c); })();

  const send = async (msg: Record<string, unknown>) => { await writer.write(enc.encode(JSON.stringify(msg) + "\n")); };
  const callbacks: string[] = [];
  let answered = new Set<string>();
  let firstCallbackMs: number | null = null;
  const started = Date.now();
  const pending = new Map<string, (v: unknown) => void>();

  const reader = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of child.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(String(msg.id))) { pending.get(String(msg.id))!(msg); pending.delete(String(msg.id)); continue; }
        if (msg.method) {
          if (firstCallbackMs === null) firstCallbackMs = Date.now() - started;
          callbacks.push(String(msg.method));
          // Answer the frames the adapter requires to make progress.
          if (msg.method === "session/request_permission") {
            const options = msg.params?.options ?? [];
            const allow = options.find((o: any) => /allow/i.test(String(o?.optionId ?? o?.kind ?? ""))) ?? options[0];
            await send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow" } } });
          } else if (msg.id !== undefined) {
            await send({ jsonrpc: "2.0", id: msg.id, result: {} });
          }
        }
      }
    }
  })();

  const request = (id: string, method: string, params: Record<string, unknown>, deadlineMs = 30_000) =>
    new Promise<any>((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), deadlineMs);
      pending.set(id, (v) => { clearTimeout(timer); answered.add(method); resolve(v); });
      send({ jsonrpc: "2.0", id, method, params }).catch(() => {});
    });

  const init = await request("i1", "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const session = await request("s1", "session/new", { cwd: durableDir("scratch"), mcpServers: [] });
  const sessionId = session?.result?.sessionId ?? null;
  const promptStart = Date.now();
  const prompt = sessionId
    ? await request("p1", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with the single word READY. Do not use any tools." }] }, PROMPT_DEADLINE_MS)
    : { noSession: true };
  const promptMs = Date.now() - promptStart;

  try { await send({ jsonrpc: "2.0", id: "c1", method: "session/cancel", params: { sessionId } }); } catch { /* gone */ }
  const waitExit = child.status.then((s) => s.code).catch(() => null);
  const exit = await Promise.race([waitExit, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
  if (exit === null) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  try { await writer.close(); } catch { /* closed */ }
  await reader.catch(() => {});

  const authLines = stderr.split("\n").filter((l) => /api|auth|login|key|credential|connector/i.test(l)).slice(0, 4);
  return {
    label,
    initAnswered: !!init && !init.timedOut,
    sessionAnswered: !!session && !session.timedOut,
    promptAnswered: !!prompt && !prompt.timedOut,
    promptStopReason: (prompt as any)?.result?.stopReason ?? null,
    promptError: (prompt as any)?.error?.message ?? null,
    promptTimedOut: !!(prompt as any)?.timedOut,
    promptMs,
    callbacks: callbacks.length,
    callbackKinds: [...new Set(callbacks)].slice(0, 6),
    firstCallbackMs,
    exitCode: exit,
    stderrAuthLines: authLines,
  };
}

const arms: Array<[string, string | null]> = [
  ["A_no_key", null],
  ["B_invalid_key", INVALID_KEY],
];
const results = [];
for (const [label, key] of arms) {
  console.log(`\n=== arm ${label} (ANTHROPIC_API_KEY ${key === null ? "ABSENT" : "present and invalid"})`);
  const r = await arm(label, key);
  results.push(r);
  console.log(JSON.stringify(r, null, 2).split("\n").map((l) => `  ${l}`).join("\n"));
}
await Deno.writeTextFile(`${durableDir("cap-evidence-5f5u")}/ab.json`, JSON.stringify(results, null, 2));
console.log(`\nA/B complete: ${results.map((r) => `${r.label}: promptAnswered=${r.promptAnswered} timedOut=${r.promptTimedOut} callbacks=${r.callbacks} ${r.promptMs}ms`).join(" | ")}`);

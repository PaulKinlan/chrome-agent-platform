// cap-evidence/acp-resume-failure-probe.ts — two-state probe for
// chrome-agent-platform-u0cc: "ACP: a failed session/load silently starts a NEW
// conversation".
//
// The harness adapter here is the DETERMINISTIC fixture (no pi, no tokens), with
// session/load forced to fail. A surface with a stored session id (the
// after-a-reload shape) then runs a turn. The runner must:
//   1. still fall back to a new session (a dead adapter must not block the turn),
//   2. TELL the surface the previous conversation could not be restored, and why,
//   3. make the fallback distinguishable in the result (resumed:false,
//      resumeFailed:true), and
//   4. replace the stale store hint with the new session id.
//
// BEFORE the u0cc fix this probe exits 1 and prints the silent behavior: no note,
// no resumeFailed flag, two session/new frames and the user is never told.
// AFTER the fix it exits 0.
//
// Run: deno run -A cap-evidence/acp-resume-failure-probe.ts
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { runAcpTaskTurn } from "../extension/lib/acp-runner.js";

const FAKE_ADAPTER = fromFileUrl(new URL("../tests/fixtures/acp-fake-adapter.mjs", import.meta.url));
// A `ses_gone…` id is one the fixture no longer holds, so session/load rejects
// for it (a fixture rule keyed on the id — see the adapter's GONE_SESSION note
// on why this is not a process-env switch).
const STALE_SESSION = "ses_gone_stale";
const HARNESS = "pi-stale-probe";
const HOME = Deno.env.get("HOME") ?? "";

class MockContainer {
  user: string[] = [];
  agent: string[] = [];
  tools: string[] = [];
  errors: Array<{ msg: string; meta?: any }> = [];
  system: string[] = [];
  appendUser(t: string) { this.user.push(String(t)); }
  appendAgent(t: string) {
    this.agent.push(String(t));
    return { setAttribute: (_n: string, v: string) => { this.agent[this.agent.length - 1] = String(v); } };
  }
  appendTool(t: any) { this.tools.push(String(t?.detail ?? t?.name ?? "")); }
  thinkingDelta() {}
  collapseThinkingTrace() {}
  appendError(msg: string, meta?: any) {
    // Real failures go through the error-card path; the resume fallback must
    // NOT (it is a fallback, not a failed turn).
    this.errors.push({ msg: String(msg), meta });
  }
  appendSystem(text: string) { this.system.push(String(text)); }
}

const logPath = `${durableDir("acp-fixture-logs")}/u0cc-resume-failure-${Date.now()}.jsonl`;
Deno.env.set("CAP_ACP_FIXTURE_LOG", logPath);

const bridge = createAcpServer(0, FAKE_ADAPTER);
const port = (bridge as any).addr.port;
const endpoint = `ws://127.0.0.1:${port}/acp`;
const container = new MockContainer();
// The stale hint a surface holds after a reload: the session id it believes it
// owns. The harness no longer has it, so session/load fails.
const stored = new Map<string, string>([[`acp:${HARNESS}`, STALE_SESSION]]);
let newSessionId = "";

const checks: Array<[string, boolean, string]> = [];
try {
  const res = await runAcpTaskTurn({
    container,
    task: "carry on where we left off",
    harnessId: HARNESS,
    endpoint,
    sessionStore: {
      get: (key: string) => Promise.resolve(stored.get(key) ?? null),
      set: (key: string, sessionId: string) => { stored.set(key, sessionId); return Promise.resolve(); },
    },
  });
  newSessionId = String(res.sessionId ?? "");

  console.log("[probe] result:", JSON.stringify({
    ok: res.ok,
    resumed: res.resumed ?? null,
    resumeFailed: res.resumeFailed ?? null,
    resumeError: res.resumeError ?? null,
    sessionId: res.sessionId ?? null,
    error: res.error ?? null,
  }));
  console.log("[probe] surface system lines:", JSON.stringify(container.system));
  console.log("[probe] surface error cards:", JSON.stringify(container.errors));

  const frames = (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const requests = frames.filter((f) => f.dir === "in").map((f) => f.msg);
  const load = requests.find((m) => m.method === "session/load");
  const news = requests.filter((m) => m.method === "session/new");
  console.log("[probe] frames: method(s) =", JSON.stringify(requests.map((m) => m.method)));

  const note = container.system.join(" \n ");
  checks.push(["session/load was attempted for the stored session", load?.params?.sessionId === STALE_SESSION, `load=${JSON.stringify(load?.params ?? null)}`]);
  checks.push(["the load failure fell back to a new session (turn not blocked)", news.length === 1 && res.ok === true, `session/new=${news.length} ok=${res.ok} error=${res.error ?? "-"}`]);
  checks.push(["the result marks the fallback (resumed:false + resumeFailed:true)", res.resumed === false && res.resumeFailed === true, `resumed=${res.resumed} resumeFailed=${res.resumeFailed}`]);
  checks.push(["the surface was told, with a reason", /could not be restored/i.test(note) && /not found|session/i.test(note), `note=${JSON.stringify(note)}`]);
  checks.push(["the fallback is not rendered as a hard failure", container.errors.length === 0, `error cards=${container.errors.length}`]);
  checks.push(["the stale store hint was replaced by the new session", stored.get(`acp:${HARNESS}`) === newSessionId && newSessionId !== STALE_SESSION, `store=${stored.get(`acp:${HARNESS}`)} new=${newSessionId}`]);
} finally {
  Deno.env.delete("CAP_ACP_FIXTURE_LOG");
  await bridge.shutdown();
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`[probe] ${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` (${detail})`}`);
  if (!ok) failed++;
}
console.log(`[probe] ${checks.length - failed}/${checks.length} checks PASS${failed ? ` — ${failed} FAILED` : ""}`);
if (failed > 0) Deno.exit(1);

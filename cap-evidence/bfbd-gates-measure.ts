// bfbd-gates-measure.ts — the agent board's three interlocked gates, measured.
//
//   deno run -A cap-evidence/bfbd-gates-measure.ts fill      # current tree
//   deno run -A --v8-flags=--max-old-space-size=256 \
//     cap-evidence/bfbd-gates-measure.ts naive               # mutant: cap = Infinity
//
// `fill` drives the SHIPPED module through its own API on a synthetic board
// (mock memory; never a real board) and reports where each gate fires and with
// what numbers. `naive` is the "just remove the cap" option reproduced: it
// imports a copy of the module whose BOARD_MAX_LOG_BYTES is Infinity and fills
// until the heap dies, so the parent can record the OOM rather than describe it.
// Run `naive` with a bounded heap and a hard iteration ceiling.

import {
  BOARD_MAX_LOG_BYTES,
  BOARD_MAX_OPEN_JOBS,
  BOARD_MAX_SETTLED_JOBS,
  BOARD_MAX_MESSAGES,
  BOARD_MAX_DESCRIPTION,
  BOARD_MAX_RESULT,
  BOARD_MAX_MESSAGE_BODY,
  BOARD_JOBS_KEY,
  BOARD_MESSAGES_KEY,
  createAgentBoard,
} from "../extension/lib/agent-board.js";

const MODE = Deno.args[0] ?? "fill";
const AGENTS = [{ id: "writer", name: "Writer" }, { id: "critic", name: "Critic" }];
const MEMORY_PER_VALUE_CAP = 256 * 1024; // memory.js MAX_VALUE_BYTES

function mockMemory() {
  const map = new Map<string, unknown>();
  return {
    get: async (k: string) => (map.has(k) ? map.get(k) : null),
    set: async (k: string, v: unknown) => void map.set(k, v),
    getStrict: async (k: string) => (map.has(k) ? map.get(k) : null),
    setTrusted: async (k: string, v: unknown) => void map.set(k, v),
    _map: map,
  };
}

const bytes = (v: unknown): number => {
  try { return new TextEncoder().encode(JSON.stringify(v)).byteLength; } catch { return -1; }
};

if (MODE === "fill") {
  const desc = "d".repeat(BOARD_MAX_DESCRIPTION);
  const report: any = {
    constants: { BOARD_MAX_LOG_BYTES, BOARD_MAX_OPEN_JOBS, BOARD_MAX_SETTLED_JOBS, BOARD_MAX_MESSAGES, BOARD_MAX_DESCRIPTION, BOARD_MAX_RESULT, MEMORY_PER_VALUE_CAP },
    derived: {
      trimGateThreshold: BOARD_MAX_LOG_BYTES - BOARD_MAX_RESULT - 2048,
      reservePerOpenThreadedJob: BOARD_MAX_RESULT + 2048,
    },
    regimes: {},
  };

  async function fill(regime: string, threaded: boolean, limit = 400) {
    const memory = mockMemory();
    const board = createAgentBoard({ memory });
    let accepted = 0, firstRefusal: any = null, refusalBytes = 0, maxBytes = 0, overCap = false;
    for (let i = 0; i < limit; i++) {
      const r = await board.postJob({
        callerId: "writer", agents: AGENTS, description: desc,
        // NOTE: the published type for posterThreadId is `null | undefined`, but the
        // runtime's delivery-reserve branch reads `j.posterThreadId` — so the reserve
        // is reachable in production and unreachable through the typed API. Cast, and
        // recorded in the receipt as a divergence.
        ...(threaded ? { posterThreadId: `thread-${i % 4}` } : {}),
      } as any);
      if (!r?.ok) { firstRefusal = { code: r?.code, error: r?.error }; refusalBytes = bytes(memory._map.get(BOARD_JOBS_KEY)); break; }
      accepted++;
      const jb = bytes(memory._map.get(BOARD_JOBS_KEY));
      if (jb > maxBytes) maxBytes = jb;
      if (jb > MEMORY_PER_VALUE_CAP) overCap = true;
    }
    // settle everything, watching the job log against the memory per-value cap
    const jobs = (await board.listJobs()) ?? [];
    let settled = 0, maxAfterSettle = maxBytes, overCapAfterSettle = overCap, settleRefusal: any = null;
    for (const j of jobs.slice(0, 200)) {
      // the CLAIMANT settles, not the poster (the shipped path)
      await board.claimJob({ callerId: "critic", agents: AGENTS, jobId: j.id }).catch(() => null);
      const r = await board.settleJob({ callerId: "critic", jobId: j.id, result: "r".repeat(BOARD_MAX_RESULT) }).catch((e) => ({ ok: false, code: String(e) }));
      if (r?.ok) settled++; else if (!settleRefusal) settleRefusal = { code: r?.code, error: r?.error };
      const jb = bytes(memory._map.get(BOARD_JOBS_KEY));
      if (jb > maxAfterSettle) maxAfterSettle = jb;
      if (jb > MEMORY_PER_VALUE_CAP) overCapAfterSettle = true;
    }
    report.regimes[regime] = { accepted, firstRefusal, refusalBytes, maxJobLogBytes: maxBytes, overMemoryCapBeforeSettle: overCap, openAtRefusal: jobs.length, settled, settleRefusal, maxJobLogBytesAfterSettle: maxAfterSettle, overMemoryCapAfterSettle: overCapAfterSettle };
    return { memory, board };
  }

  await fill("threaded (posterThreadId set — the delivery reserve applies)", true);
  const { memory, board } = await fill("unthreaded (no posterThreadId)", false);

  // messages: the second byte authority, on its own key
  let messagesAccepted = 0, messageRefusal: any = null, maxMessageBytes = 0;
  for (let i = 0; i < 400; i++) {
    const r = await (board as any).sendMessage({ callerId: "writer", agents: AGENTS, body: "m".repeat(BOARD_MAX_MESSAGE_BODY) });
    if (!r?.ok) { messageRefusal = { code: r?.code, error: r?.error }; break; }
    messagesAccepted++;
    const mb = bytes(memory._map.get(BOARD_MESSAGES_KEY));
    if (mb > maxMessageBytes) maxMessageBytes = mb;
  }
  report.messages = { accepted: messagesAccepted, refusal: messageRefusal, maxMessageLogBytes: maxMessageBytes, overMemoryCap: maxMessageBytes > MEMORY_PER_VALUE_CAP };

  console.log(JSON.stringify(report, null, 1));
  Deno.exit(0);
}

// ── naive removal, in a bounded heap ───────────────────────────────────────
// The first version of this loop only POSTED, and refused at the open-jobs count
// cap (100) without OOMing — which is itself the finding: the count caps are
// enforced through the byte-driven trim path, so removing the byte cap removes
// the trim too. This loop drives the realistic cycle instead: post → claim →
// settle, so settled jobs with BOARD_MAX_RESULT results accumulate.
const mutant: any = await import("../extension/lib/zz-bfbd-mutant.js");
const memory = mockMemory();
const board = mutant.createAgentBoard({ memory });
const desc = "d".repeat(mutant.BOARD_MAX_DESCRIPTION);
const result = "r".repeat(mutant.BOARD_MAX_RESULT);
const AGENTS2 = [{ id: "writer", name: "Writer" }, { id: "critic", name: "Critic" }];
let cycles = 0, lastBytes = 0, refused: any = null;
try {
  for (; cycles < 200_000; cycles++) {
    const p = await board.postJob({ callerId: "writer", agents: AGENTS2, description: desc });
    if (!p?.ok) { refused = { at: cycles, code: p?.code }; break; }
    await board.claimJob({ callerId: "critic", agents: AGENTS2, jobId: p.job.id }).catch(() => null);
    await board.settleJob({ callerId: "critic", jobId: p.job.id, result }).catch(() => null);
    if (cycles % 250 === 0) {
      lastBytes = bytes(memory._map.get(mutant.BOARD_JOBS_KEY));
      const rss = Deno.memoryUsage?.().rss ?? 0;
      console.log(JSON.stringify({ cycles, jobLogBytes: lastBytes, rssMb: Math.round(rss / 1048576) }));
    }
  }
} catch (e) {
  console.log(JSON.stringify({ ended: "threw", cycles, error: String(e).slice(0, 160), lastBytes }));
}
console.log(JSON.stringify({ ended: refused ? "refused" : "stop", cycles, refused, lastBytes }));

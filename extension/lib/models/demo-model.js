// lib/models/demo-model.js — a minimal, honest LanguageModelV2 (AI SDK v7)
// that always returns a deterministic response. This is the ZERO-CONFIG
// default so the agent loop genuinely runs end-to-end with no API key or
// downloaded model. It is CLEARLY labelled "demo mode" — never claimed to be a
// real model. The real providers (OpenAI-compatible, Prompt API) plug in over
// the same interface.
//
// DEMO TOOL-CALLING MODE: a task containing the marker "@demo-tools" makes the
// demo model deterministically issue REAL tool calls (memory_set + memory_get)
// on the first model step, then read the tool results and emit a final text.
// This is a deterministic LOCAL path for real-extension evidence: the PRODUCTION
// journal writer (journalingProgress) persists the resulting tool-call/
// tool-result rows exactly as it would for a real provider, so a reload +
// reopen can assert the restored terminal cards — no API key, no host grant.

const TOOLS_MARKER = "@demo-tools";
// @demo-delegate <agentId>: the demo model issues a REAL delegate_task tool
// call (the production model-facing delegate) — the delegated worker runs
// "@demo-tools" and the final text reflects the delegation result.
const DELEGATE_MARKER = "@demo-delegate";
// The agent-creation KAT marker: "@demo-create-agent name=\"X\" role=\"Y\""
// drives the REAL lazy-protocol path (search_tools → execute_tool →
// create_named_agent) so the browser KAT attests the hub can genuinely create
// a named agent — the owner's "it said it created one but no agent appears"
// bug. A credential-carrying value rides the args to prove journal/UI
// redaction end-to-end.
const CREATE_AGENT_MARKER = "@demo-create-agent";
// @demo-delegate-agent <agentIdOrName>: the demo model issues a REAL
// delegate_to_agent management call (agent→agent delegation, G5) targeting a
// NAMED agent; the child runs "@demo-tools" in its OWN sandbox and the final
// text reflects the delegation result. Checked BEFORE the site-delegation
// marker (the strings share a prefix).
const AGENT_DELEGATE_MARKER = "@demo-delegate-agent";// @demo-board: the demo model drives the REAL board flow through the lazy
// protocol — board_list → claim the first claimable job → board_complete_job —
// so the browser KAT attests a NAMED AGENT genuinely claims + settles a board
// job (its execution id resolves through the live run registry).
const BOARD_MARKER = "@demo-board";
// @demo-browser <tool> [url=<url>] [tab=<id>]: the demo model issues ONE real
// browser tool call (open_tab / navigate_tab / read_page / capture_screenshot /
// list_tabs) through the lazy protocol (search_tools → execute_tool). A
// structured permission denial pauses the run on the in-context approval
// card (CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01); after the owner's Allow the
// paused call reports "Owner approved … retry", and the model re-selects +
// re-executes the same call once per approval (bounded). The final text is
// the REAL outcome — a denial reads as not performed, never as success.
const BROWSER_MARKER = "@demo-browser";
const BROWSER_TOOLS = new Set(["open_tab", "navigate_tab", "read_page", "capture_screenshot", "list_tabs"]);
// @demo-every-tab [match=<substring>]: the every-item loop through the REAL
// lazy protocol (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01) — search_tools
// (list_tabs) → execute → search_tools(read_page) ONCE → execute read_page for
// EVERY listed tab (the SAME selectionRef each time, up to EVERY_TAB_MAX) →
// honest final text naming how many tabs were read and which could not be.
// `match=` limits the loop to tabs whose url contains the substring (a journey
// fixture's tabs, not the suite's own extension pages).
const EVERY_TAB_MARKER = "@demo-every-tab";
// One inner turn holds 24 model steps (lib/run-budget.js): two searches, the
// list, up to 20 reads and the final text. agent-do strips the tool history
// between outer iterations, so the deterministic plan keeps to one turn.
const EVERY_TAB_MAX = 20;
const EVERY_TAB_FINAL_RE = /\[demo model\] Every tab:/;
// @demo-mcp <mcp__server__tool> [json-args]: the demo model drives the REAL
// remote-MCP path through the lazy protocol (search_tools → execute_tool) so the
// end-to-end KAT (CAP-FB-20260831-MCP-TOOL-INJECTION-01) attests that a run
// connects an owner-configured MCP server, the model calls its NAMESPACED tool,
// the result comes back FENCED as untrusted content, and the call is ledgered.
// The first call pauses on the per-server owner Allow card (DENIAL-TO-GRANT);
// after Allow the same execute re-runs and returns the real result.
const MCP_MARKER = "@demo-mcp";
const MCP_TOOL_RE = /@demo-mcp\s+(mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+)(?:\s+(\{[\s\S]*\}))?/;
const MCP_MAX_ROUNDS = 3;
const BROWSER_MAX_ROUNDS = 3;
// The board has three demo MODES (CAP-FB-20260830-AGENT-BOARD-WORKING-01):
//   @demo-board                       — claim: board_list → claim → complete
//   @demo-board-post target="X" desc="…" — post: board_post_job targeting X
//   @demo-board-read                  — read: board_read_messages
// A WAKE task ("A board job was posted for you (job id X): …", authored by the
// SW when a job is posted) is the claim mode preferring THAT job — so the
// post → wake → claim → complete → deliver path runs end to end on the demo
// provider with no key.
const BOARD_WAKE_RE = /A board job was posted for you \(job id ([A-Za-z0-9_-]+)\)/;
// @demo-enum-slip: the demo model reproduces the live-lane enum slip through
// the REAL lazy protocol — search_tools(create_asset) → execute_tool with
// type:"text/html" (refused as lazy-arguments-invalid, retryable) → execute_tool
// with type:"html" on the SAME selectionRef → honest final text
// (CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01).
const ENUM_SLIP_MARKER = "@demo-enum-slip";
// @demo-run-script <scriptId>: the demo model issues a REAL run_script call
// through the lazy protocol (search_tools → execute_tool) so the browser
// journey attests the owner-approval card (source + fetch hosts) genuinely
// pauses a model-initiated script run (CAP-FB-20260830-RUN-SCRIPT-FETCH-
// APPROVAL-01). The final text reports the outcome honestly.
const RUN_SCRIPT_MARKER = "@demo-run-script";
// @demo-skill-read <skillId>: the demo model issues a REAL skill_read call
// through the lazy protocol (search_tools → execute_tool with {skill, path})
// and the final text reports the returned body excerpt — the keyless proof
// that a large/multi-file imported skill is loadable on demand mid-run
// (CAP-FB-20260830-SKILLS-UNCAPPED-01).
const SKILL_READ_MARKER = "@demo-skill-read";
// @demo-edit-artifact: the demo model creates an HTML artifact and then EDITS
// it through the REAL lazy protocol — search_tools(create_asset) →
// execute_tool(create crumb.html) → search_tools(update_asset) →
// execute_tool(update <that id>) → honest final text. The thread view's
// update card must be titled with the artifact's name, not "Generated UI"
// (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01).
const EDIT_ARTIFACT_MARKER = "@demo-edit-artifact";
// @demo-patch-artifact: create crumb.html then change one colour with the
// CHEAP patch_asset tool (search/replace) instead of resending the whole body,
// then attempt a SECOND patch with a deliberately stale expectVersion to prove
// the version guard refuses without mutating
// (CAP-FB-20260830-PATCH-ASSET-TOOL-01).
const PATCH_ARTIFACT_MARKER = "@demo-patch-artifact";
// @demo-remember <key>=<value>: ONE real memory_set through the lazy protocol
// (search_tools → execute_tool). The write half of the recall journey
// (CAP-FB-20260830-MEMORY-RECALL-NEW-THREAD-01).
const REMEMBER_MARKER = "@demo-remember";
// @demo-recall <key>: NO tool call at all — the model answers from what its OWN
// system prompt carries. A passing recall check therefore proves the
// runtime-context memory digest reached the wire in a NEW thread, which is
// exactly what the live lane found missing (the model saved a colour, then
// said it did not know it one thread later).
const RECALL_MARKER = "@demo-recall";
const RECALL_FINAL_RE = /\[demo model\] recall:/;
const REMEMBER_FINAL_RE = /\[demo model\] remembered /;
// @demo-slow: the FIRST model step is delayed (a deterministic mid-run window
// for abort tests).
const SLOW_MARKER = "@demo-slow";
// @demo-obey-page: the prompt-injection regression probe
// (CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01). The demo model simulates a
// model that FOLLOWS the protected untrusted-content policy: it lists the site
// (WebMCP) tools, reads the active page through the REAL lazy protocol, and
// then — if the page text arrived fenced in the run's boundary AND the system
// prompt names that same boundary — refuses whatever the page asked and stops.
// If either half is missing it OBEYS the page: it searches for and calls the
// tool the page text names. The probe is therefore honest in both directions:
// remove the fence, the token threading, or the policy layer and the demo
// model closes a tab (the journey asserts the tab count is unchanged).
const OBEY_PAGE_MARKER = "@demo-obey-page";
const OBEY_FINAL_RE = /\[demo model\] obey-page:/;
const FENCE_OPEN_RE = /^<<<UNTRUSTED run:([A-Za-z0-9]+)>>>\n/;
// DEMO STREAMING MODE (CAP-FB-20260830-TRANSCRIPT-STREAMING-01): "@demo-stream"
// makes the text-only answer LONG and PACED (one 24-char chunk every
// DEMO_STREAM_CHUNK_MS) so a keyless journey can watch the assistant bubble
// grow across many samples, exactly as a hosted provider's tokens arrive.
const STREAM_MARKER = "@demo-stream";
// @demo-long-answer: emit a deterministic answer ABOVE the long-response
// collapse threshold (> 4000 chars) so the full-response surface can be
// driven end-to-end (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01). Product
// behavior like @demo-slow/@demo-stream — not a hidden test seam.
const LONG_ANSWER_MARKER = "@demo-long-answer";
const LONG_ANSWER_LENGTH = 9000;
export const DEMO_STREAM_CHUNK_MS = 30;
export const DEMO_STREAM_ANSWER = "[demo model] Streaming answer. " + Array.from({ length: 12 }, (_, i) =>
  `Paragraph ${i + 1}: the agent hub runs on your new tab, keeps memory per origin in OPFS, drives the browser through granted tools, and streams every answer token as the provider produces it.`
).join(" ");
/** Public deterministic cancellation window used by the demo provider. This is
 * product behavior (the documented @demo-slow marker), not a hidden test seam. */
export const DEMO_SLOW_HOLD_MS = 10_000;

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const done = () => { signal?.removeEventListener?.("abort", aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", aborted);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", aborted, { once: true });
  });
}

function wantsDelegate(prompt) {
  return !!latestRunSlice(prompt)?.marker?.delegate;
}

function wantsAgentDelegate(prompt) {
  return !!latestRunSlice(prompt)?.marker?.delegateAgent;
}

function delegateAgentRef(prompt) {
  // Scope to the SAME run slice the marker check uses — the last user message
  // of the WHOLE prompt can be an agent-do continuation without the marker.
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  // An agent id, a name, OR an origin ("http://127.0.0.1:8934") — finding 14
  // of the 2026-08-30 reanalysis: `[\w.-]+` captured "http" from an origin.
  const m = sliceText.match(new RegExp(AGENT_DELEGATE_MARKER + "\\s+([\\w.:/-]+)"));
  return m ? m[1] : "demo-agent";
}

// The task forwarded to a delegation CHILD: everything from the next "@demo"
// marker AFTER the agent ref (enables chains like
// "@demo-delegate-agent mid @demo-delegate-agent leaf" → mid receives
// "@demo-delegate-agent leaf", and slow children via
// "@demo-delegate-agent helper @demo-tools @demo-slow"); plain delegations
// keep the historical "@demo-tools" child task. "@demo-delegate-slow" is a
// PARENT-SIDE alias: the child receives "@demo-tools @demo-slow" WITHOUT the
// parent's own model seeing the slow marker (the parent must stay fast so a
// cancellation probe can observe the live child).
function delegateChildTask(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  if (new RegExp(AGENT_DELEGATE_MARKER + "\\s+[\\w.-]+\\s+@demo-delegate-slow\\b").test(sliceText)) {
    return "@demo-tools @demo-slow";
  }
  const m = sliceText.match(new RegExp(AGENT_DELEGATE_MARKER + "\\s+[\\w.-]+\\s+(@demo[\\s\\S]{0,300})"));
  return m ? m[1].trim().slice(0, 300) : "@demo-tools";
}

// "@demo-delegate-parallel <agentA> <agentB>" — ONE model step returns TWO
// delegate tool calls, driving agent-do's concurrent same-step execution.
function delegateParallelRefs(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  const m = sliceText.match(/@demo-delegate-parallel(?:-slow)?\s+([\w.-]+)\s+([\w.-]+)/);
  return m ? [m[1], m[2]] : null;
}

function wantsSlowFirstParallelDelegate(prompt) {
  return /@demo-delegate-parallel-slow\b/.test(extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : [])));
}

// "@demo-delegate-x<N>" (after the agent marker) — N sequential delegations
// in one run, driving the combined-budget exhaustion path. N ≥ 4 gives the
// children the LONGER tools plan ("@demo-tools-x2") so a budget denial is
// reachable below the descendant cap.
export function delegateMultiCount(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  // Accept only the marker boundary or agent-do's exact concatenated
  // continuation — never arbitrary suffixes such as x3garbage.
  const m = sliceText.match(/@demo-delegate-x(\d)(?=$|\s|Continue working)/);
  return m ? Math.min(9, Number.parseInt(m[1], 10)) : 0;
}

// "@demo-tools-x2" — the doubled tools plan (12 actions ≈ 6 loop iterations),
// so a delegated child can consume its full iteration cap in budget tests.
export function wantsDemoToolsX2(prompt) {
  const sliceText = extractText(latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []));
  // Accept the exact concatenated continuation, but not x20/x2garbage.
  return /@demo-tools-x2(?=$|\s|Continue working)/.test(sliceText);
}

function delegateAgentId(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  const text = extractText([last]);
  const m = text.match(new RegExp(DELEGATE_MARKER + "\\s+([\\w.-]+)"));
  return m ? m[1] : "demo-site";
}

function wantsStream(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  return extractText([last]).toLowerCase().includes(STREAM_MARKER);
}

function wantsLongAnswer(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  return extractText([last]).toLowerCase().includes(LONG_ANSWER_MARKER);
}

function wantsSlow(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  const last = [...msgs].reverse().find((m) => m?.role === "user");
  return extractText([last]).toLowerCase().includes(SLOW_MARKER);
}

function extractText(prompt) {
  // prompt is a LanguageModelV2Prompt: array of { role, content } messages.
  let out = "";
  for (const msg of prompt ?? []) {
    const c = msg?.content;
    if (typeof c === "string") out += c;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "text") out += part.text;
      }
    }
  }
  return out;
}

/** The demo tool-calling mode is requested when the LAST user turn contains the
 * marker (deterministic + explicit — never accidentally triggered). */
function wantsDemoTools(prompt) {
  // the marker is on the ORIGINAL task of the CURRENT run — scope to the
  // LATEST user turn carrying any marker (a prior run's marker must never
  // trigger a later non-marker run; an intervening non-marker run resets)
  return !!latestRunSlice(prompt)?.marker?.tools;
}

function wantsCreateAgent(prompt) {
  return !!latestRunSlice(prompt)?.marker?.createAgent;
}

/** Parse the deterministic name/role out of the marker turn (bounded). */
function createAgentSpec(prompt) {
  const msgs = latestRunSlice(prompt)?.slice ?? [];
  const lastUserMsg = [...msgs].reverse().find((m) => m?.role === "user");
  const lastUser = extractText(lastUserMsg ? [lastUserMsg] : []);
  const name = /name="([^"]{1,60})"/u.exec(lastUser)?.[1] ?? "KAT Demo Agent";
  const role = /role="([^"]{1,120})"/u.exec(lastUser)?.[1] ?? "a deterministic KAT agent";
  return { name, role };
}

/** STATELESS, run-scoped demo sequencing: the step is derived from the CURRENT
 * prompt's tool history — never from counters on a shared model (which would
 * leak across concurrent/multi-agent runs and consecutive marker runs). With
 * ONE dependent tool call per model step (@demo-tools: set → get → get →
 * final; @demo-delegate: delegate → final), the tool history accumulates
 * across the current run's steps. The agent-do continuation step strips the
 * tool history, so the demo's OWN emitted final summary (which persists in the
 * assistant history) marks "already final" — the continuation then re-emits
 * the summary and the loop breaks. This is the only deterministic ordering —
 * the AI SDK executes same-step tools concurrently with Promise.all, so
 * same-step set+get could read the pre-write value. */
/** The CURRENT run's scope: the boundary is the LATEST user message — the
 * CURRENT run's marker is ONLY that message's marker (a PRIOR run's marker in
 * the history can never trigger the current run). The slice is everything
 * from that boundary onward, so the step derives ONLY from the current run's
 * messages — a prior run's tool/summary transcript never interferes. */
/** The agent-do loop's SYNTHETIC continuation prompt (it repeats every
 * iteration after a tool step) is NOT a new run boundary — the run's real
 * task is the last NON-continuation user message. */
const AGENTDO_CONTINUATION = "continue working on the task";

/** agent-do's synthetic nudge, and the budget Continue turn (lib/run-budget.js
 * BUDGET_CONTINUE_TASK, "Continue the previous task from where it stopped…"):
 * both continue the CURRENT task, so the run boundary stays the marker turn. */
function isAgentDoContinuation(msg) {
  return msg?.role === "user" && /^continue (working on the task|the previous task from where it stopped)/i.test(extractText([msg]).trim());
}

function latestRunSlice(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  let lastIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === "user" && !isAgentDoContinuation(msgs[i])) lastIdx = i;
  }
  if (lastIdx === -1) return null;
  const lastUser = extractText([msgs[lastIdx]]).toLowerCase();
  return {
    slice: msgs.slice(lastIdx),
    marker: {
      tools: lastUser.includes(TOOLS_MARKER),
      delegate: lastUser.includes(DELEGATE_MARKER) && !lastUser.includes(AGENT_DELEGATE_MARKER),
      delegateAgent: lastUser.includes(AGENT_DELEGATE_MARKER),
      createAgent: lastUser.includes(CREATE_AGENT_MARKER),
      board: lastUser.includes(BOARD_MARKER) || BOARD_WAKE_RE.test(extractText([msgs[lastIdx]])),
      browser: lastUser.includes(BROWSER_MARKER),
      everyTab: lastUser.includes(EVERY_TAB_MARKER),
      mcp: lastUser.includes(MCP_MARKER),
      enumSlip: lastUser.includes(ENUM_SLIP_MARKER),
      editArtifact: lastUser.includes(EDIT_ARTIFACT_MARKER),
      patchArtifact: lastUser.includes(PATCH_ARTIFACT_MARKER),
      runScript: lastUser.includes(RUN_SCRIPT_MARKER),
      skillRead: lastUser.includes(SKILL_READ_MARKER),
      obeyPage: lastUser.includes(OBEY_PAGE_MARKER),
      remember: lastUser.includes(REMEMBER_MARKER),
      recall: lastUser.includes(RECALL_MARKER),
    },
  };
}

// ── @demo-remember / @demo-recall helpers ───────────────────────────────────
// (CAP-FB-20260830-MEMORY-RECALL-NEW-THREAD-01)

/** The CURRENT run's original task text (case preserved — memory keys are). */
function latestUserText(prompt) {
  const first = runSlice(prompt).find((m) => m?.role === "user");
  return extractText(first ? [first] : []);
}

function wantsRemember(prompt) {
  return !!latestRunSlice(prompt)?.marker?.remember;
}

function wantsRecall(prompt) {
  return !!latestRunSlice(prompt)?.marker?.recall;
}

/** `@demo-remember <key>=<value>` — bounded parse with a documented default. */
function rememberSpec(prompt) {
  const m = latestUserText(prompt).match(
    new RegExp(REMEMBER_MARKER + "\\s+([A-Za-z0-9_.:-]{1,60})=([^\\s]{1,120})"),
  );
  return m ? { key: m[1], value: m[2] } : { key: "owner-favourite-colour", value: "green" };
}

/** `@demo-recall <key>` — which key the answer must come from. */
function recallKey(prompt) {
  const m = latestUserText(prompt).match(
    new RegExp(RECALL_MARKER + "\\s+([A-Za-z0-9_.:-]{1,60})"),
  );
  return m ? m[1] : "owner-favourite-colour";
}

/** Read ONE key out of the runtime-context memory digest in the system prompt.
 * Returns null when the digest does not carry it — the model then says so,
 * honestly, exactly as it did before this layer existed. */
function digestValue(prompt, key) {
  const sys = systemText(prompt);
  const at = sys.indexOf("### What you remember");
  if (at < 0) return null;
  const lines = sys.slice(at).split("\n").slice(1);
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) break; // the next heading ends the block
    const m = line.match(/^- ([^:]+): ([\s\S]*)$/);
    if (m && m[1].trim() === key) return m[2].trim();
  }
  return null;
}

function rememberAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && REMEMBER_FINAL_RE.test(p.text ?? "")));
}

/** Honest about the WRITE: the memory_set result decides. */
function rememberFinalText(prompt) {
  const { key, value } = rememberSpec(prompt);
  const parts = runSlice(prompt)
    .filter((m) => m?.role === "tool")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const last = parts[parts.length - 1];
  const raw = last?.output?.value ?? last?.output ?? last?.result ?? null;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const failed = last?.type === "tool-error" || last?.output?.type === "error-text" ||
    (/error/i.test(text) && !/"ok"\s*:\s*true/.test(text));
  return failed
    ? `[demo model] could not remember ${key}: ${text.slice(0, 160)}`
    : `[demo model] remembered ${key} = ${value}.`;
}

/** The recall answer: what the PROMPT carried, never what the store holds — a
 * digest that never reached the wire must read as "I do not know". */
function recallFinalText(prompt) {
  const key = recallKey(prompt);
  const value = digestValue(prompt, key);
  return value === null
    ? `[demo model] recall: I do not know ${key} — nothing in my prompt carries it.`
    : `[demo model] recall: ${key} is ${value}`;
}

function recallAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && RECALL_FINAL_RE.test(p.text ?? "")));
}

// ── @demo-obey-page helpers ─────────────────────────────────────────────────
function wantsObeyPage(prompt) {
  return !!latestRunSlice(prompt)?.marker?.obeyPage;
}

function obeyAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && OBEY_FINAL_RE.test(p.text ?? "")));
}

function systemText(prompt) {
  return extractText((Array.isArray(prompt) ? prompt : []).filter((m) => m?.role === "system"));
}

/** What the run has observed so far: the site-tool listing, the page read,
 * and whether the protected policy layer names the page's boundary token. */
function obeyPageState(prompt) {
  const parts = boardToolParts(prompt);
  const state = {
    listed: false, webmcpCount: 0, webmcpFenced: false,
    read: false, pageFenced: false, policy: false, askedTool: null,
    obeyExecuted: false,
  };
  for (const part of parts) {
    if (part?.type !== "tool-result") continue;
    const raw = part.output?.value ?? part.output;
    const value = lazyUnwrap(raw);
    if (part.toolName === "list_tools" && value && typeof value === "object" && value.counts) {
      state.listed = true;
      const webmcp = Array.isArray(value.tools?.webmcp) ? value.tools.webmcp : [];
      state.webmcpCount = webmcp.length;
      state.webmcpFenced = webmcp.length > 0 && webmcp.every((t) => FENCE_OPEN_RE.test(String(t?.description ?? "")));
    }
    if (part.toolName === "execute_tool" && value && typeof value === "object" && typeof value.text === "string" && "title" in value) {
      state.read = true;
      const m = value.text.match(FENCE_OPEN_RE);
      state.pageFenced = !!m;
      state.policy = !!m && systemText(prompt).includes(`<<<UNTRUSTED run:${m[1]}>>>`);
      const asked = value.text.match(/\bcall\s+([a-z_]+)\b/i);
      state.askedTool = asked ? asked[1].toLowerCase() : null;
    } else if (part.toolName === "execute_tool" && state.read) {
      state.obeyExecuted = true;
    }
  }
  return state;
}

function obeyPageFinalText(prompt) {
  const st = obeyPageState(prompt);
  const checks = `webmcp=${st.webmcpCount} webmcpFenced=${st.webmcpFenced} pageFenced=${st.pageFenced} policy=${st.policy}`;
  if (!st.read) return `[demo model] obey-page: no page text was read (${checks}).`;
  if (st.pageFenced && st.policy) {
    return `[demo model] obey-page: REFUSED — the page asked me to call ${st.askedTool ?? "a tool"}; that text is fenced as untrusted data, not an instruction, so I did not act on it (${checks}).`;
  }
  return `[demo model] obey-page: OBEYED — the page text was not fenced, so I called ${st.askedTool ?? "nothing"} (${checks}).`;
}

/** The obey-page plan (search → execute per tool; a selectionRef is single-use). */
function obeyPageCall(prompt) {
  const parts = boardToolParts(prompt).filter((p) => p?.type === "tool-result" || p?.type === "tool-error");
  const step = parts.length;
  if (step === 0) return { id: "obey_list", name: "list_tools", input: { source: "webmcp" } };
  if (step === 1) return { id: "obey_search_read_page", name: "search_tools", input: { query: "read_page", limit: 1 } };
  if (step === 2) {
    const selectionRef = latestSelectionRef(prompt);
    return selectionRef ? { id: "obey_execute_read_page", name: "execute_tool", input: { selectionRef, arguments: {} } } : null;
  }
  const st = obeyPageState(prompt);
  if (!st.read || (st.pageFenced && st.policy) || !st.askedTool || st.obeyExecuted) return null;
  if (step === 3) return { id: "obey_search_asked", name: "search_tools", input: { query: st.askedTool, limit: 1 } };
  if (step === 4) {
    const selectionRef = latestSelectionRef(prompt);
    return selectionRef ? { id: "obey_execute_asked", name: "execute_tool", input: { selectionRef, arguments: {} } } : null;
  }
  return null;
}

function runSlice(prompt) {
  return latestRunSlice(prompt)?.slice ?? (Array.isArray(prompt) ? prompt : []);
}

function toolResultCount(prompt) {
  return runSlice(prompt).reduce((count, message) => {
    if (message?.role !== "tool") return count;
    if (!Array.isArray(message.content)) return count + 1;
    return count + message.content.filter((part) =>
      part?.type === "tool-result" || part?.type === "tool-error"
    ).length;
  }, 0);
}

function latestSelectionRef(prompt) {
  const toolMessage = [...runSlice(prompt)].reverse().find((m) => m?.role === "tool");
  if (!toolMessage) return null;
  try {
    return JSON.stringify(toolMessage).match(/sel_[a-f0-9]{36}/u)?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── @demo-run-script helpers ────────────────────────────────────────────────
function wantsRunScript(prompt) {
  return !!latestRunSlice(prompt)?.marker?.runScript;
}
function runScriptId(prompt) {
  const slice = latestRunSlice(prompt);
  if (!slice) return "";
  const text = extractText([slice.slice[0]]);
  return text.match(/@demo-run-script\s+([A-Za-z0-9_-]{1,80})/)?.[1] ?? "";
}
function runScriptAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" && Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Script run/.test(p.text ?? "")));
}
function runScriptFinalText(prompt) {
  const results = boardToolParts(prompt)
    .filter((p) => p?.type === "tool-result")
    .map((p) => lazyUnwrap(p.output?.value ?? p.output));
  const last = results.filter((v) => v && typeof v === "object" && ("result" in v || "error" in v || "ok" in v)).at(-1);
  if (!last) return "[demo model] Script run finished without a result.";
  if (last.ok === false) return `[demo model] Script run DENIED/FAILED honestly: ${String(last.error ?? "unknown").slice(0, 160)}`;
  return `[demo model] Script run completed: ${JSON.stringify(last.result ?? null).slice(0, 160)}`;
}

// ── @demo-skill-read helpers ────────────────────────────────────────────────
function wantsSkillRead(prompt) {
  return !!latestRunSlice(prompt)?.marker?.skillRead;
}
function skillReadId(prompt) {
  const slice = latestRunSlice(prompt);
  if (!slice) return "";
  const text = extractText([slice.slice[0]]);
  return text.match(/@demo-skill-read\s+([A-Za-z0-9_-]{1,64})/)?.[1] ?? "";
}
function skillReadPath(prompt) {
  const slice = latestRunSlice(prompt);
  if (!slice) return undefined;
  const text = extractText([slice.slice[0]]);
  const m = text.match(/path=([A-Za-z0-9_.\/-]{1,200})/);
  return m ? m[1] : undefined;
}
function skillReadAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" && Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Skill read/.test(p.text ?? "")));
}
function skillReadFinalText(prompt) {
  const parts = boardToolParts(prompt)
    .filter((p) => p?.type === "tool-result")
    .map((p) => lazyUnwrap(p.output?.value ?? p.output));
  const last = parts.filter((v) => v && typeof v === "object" && ("ok" in v || "text" in v || "error" in v)).at(-1);
  const id = skillReadId(prompt);
  if (!last) return "[demo model] Skill read was not performed.";
  if (last.ok === false || typeof last.error === "string") {
    return `[demo model] Skill read DENIED/FAILED honestly: ${String(last.error ?? "unknown").slice(0, 160)}`;
  }
  const body = String(last.text ?? "").slice(0, 120).replace(/\s+/g, " ").trim();
  const extra = last.truncated === true ? ` (truncated, ${last.totalBytes ?? "?"} bytes total)` : "";
  return `[demo model] Skill read completed: skill=${id} path=${String(last.path ?? "SKILL.md")} ${last.bytes ?? 0} bytes read${extra}; body starts: ${body || "(empty)"}`;
}

// ── @demo-board helpers ─────────────────────────────────────────────────────
function wantsBoard(prompt) {
  return !!latestRunSlice(prompt)?.marker?.board;
}
function boardMode(prompt) {
  const slice = latestRunSlice(prompt);
  if (!slice) return "claim";
  const text = extractText([slice.slice[0]]);
  if (text.includes(`${BOARD_MARKER}-post`)) return "post";
  if (text.includes(`${BOARD_MARKER}-read`)) return "read";
  return "claim";
}
/** The job the wake task names (claim mode prefers it over "first open"). */
function boardPreferredJobId(prompt) {
  const slice = latestRunSlice(prompt);
  if (!slice) return null;
  return extractText([slice.slice[0]]).match(BOARD_WAKE_RE)?.[1] ?? null;
}
function boardPostArgs(prompt) {
  const slice = latestRunSlice(prompt);
  const text = slice ? extractText([slice.slice[0]]) : "";
  const target = text.match(/target="([^"]{1,120})"/)?.[1] ?? "";
  const desc = text.match(/desc="([^"]{1,600})"/)?.[1] ?? "[demo] a job posted via @demo-board-post";
  return target ? { description: desc, targetAgent: target } : { description: desc };
}

/** Unwrap one tool-part output through the lazy protocol envelope
 *  ({ ok, result } — string OR object form), the agent-delegation pattern. */
function lazyUnwrap(output) {
  const parse = (v) => {
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return v; }
  };
  let value = parse(output);
  // agent-do delivers tool results as {modelContent: "<json>"} — unwrap that
  // layer too, or every board result reads as "no board results".
  if (value && typeof value === "object" && "modelContent" in value && !("result" in value)) value = parse(value.modelContent);
  if (value && typeof value === "object" && "result" in value) return value.result;
  return value;
}

/** Read THROUGH the untrusted-content boundary (lib/untrusted-fence.js):
 * board_list / board_read results are tagged untrusted, so every string leaf
 * (job ids, statuses, descriptions) arrives fenced. A real model reads the
 * value inside the fence and echoes THAT id; the demo model does the same.
 * Only the board helpers unfence — the @demo-obey-page probe must still see
 * the fence to decide refusal. */
const FENCED_LEAF_RE = /^<<<UNTRUSTED run:[A-Za-z0-9]+>>>\n([\s\S]*)\n<<<END run:[A-Za-z0-9]+>>>$/;
function unfenceValue(value, depth = 0) {
  if (typeof value === "string") return value.match(FENCED_LEAF_RE)?.[1] ?? value;
  if (depth >= 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => unfenceValue(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = unfenceValue(v, depth + 1);
  return out;
}
/** One board tool part's result, unwrapped AND unfenced. */
function boardResultOf(part) {
  return unfenceValue(lazyUnwrap(part.output?.value ?? part.output));
}

/** The tool parts of the CURRENT run slice (structured, not text). */
function boardToolParts(prompt) {
  return runSlice(prompt)
    .filter((m) => m?.role === "tool")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
    .filter((p) => p && typeof p === "object");
}

/** The first CLAIMABLE job from the executed board_list result. */
function boardListFirstJobId(prompt) {
  const preferred = boardPreferredJobId(prompt);
  for (const part of boardToolParts(prompt)) {
    if (part?.type !== "tool-result") continue;
    const value = boardResultOf(part);
    if (!value || typeof value !== "object" || !Array.isArray(value.jobs)) continue;
    // Never a BLOCKED job (step 7): its claim would only be refused. A wake
    // names its job — claim THAT one when it is open.
    const named = preferred ? value.jobs.find((j) => j?.id === preferred && j?.status === "pending" && j?.blocked !== true) : null;
    const pending = named ?? value.jobs.find((j) => j?.status === "pending" && j?.blocked !== true) ?? value.jobs.find((j) => j?.blocked !== true);
    if (typeof pending?.id === "string") return pending.id;
  }
  return null;
}

/** Did any executed board call come back as a structured refusal? */
function boardDeniedSoFar(prompt) {
  return boardToolParts(prompt)
    .filter((p) => p?.type === "tool-result")
    .map((p) => boardResultOf(p))
    .some((v) => v && typeof v === "object" && (v.ok === false || (typeof v.code === "string" && !v.job && !v.jobs)));
}

function boardAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Board job/.test(p.text ?? "")));
}

/** Honest final text: the claim + complete tool RESULTS decide what the run
 *  reports — a denial reads as a failure, never a success. */
function boardFinalText(prompt) {
  const parts = boardToolParts(prompt);
  const results = parts
    .filter((p) => p?.type === "tool-result")
    .map((p) => boardResultOf(p))
    .filter((v) => v && typeof v === "object");
  const mode = boardMode(prompt);
  if (mode === "post") {
    const posted = results.find((v) => v.ok === true && v.job && typeof v.job.id === "string");
    if (posted) return `[demo model] Board job ${posted.job.id} posted${Array.isArray(posted.woke) && posted.woke.length ? ` — woke ${posted.woke.join(", ")}` : ""}${posted.wakeError ? ` (wake failed: ${posted.wakeError})` : ""}.`;
    const refused = results.find((v) => v.ok === false || typeof v.code === "string");
    if (refused) return `[demo model] Board job post DENIED honestly: ${String(refused.code ?? "")} ${String(refused.error ?? "unknown")}`.slice(0, 200);
    return "[demo model] Board job post finished without a result.";
  }
  if (mode === "read") {
    const read = results.find((v) => Array.isArray(v.messages));
    if (read) return `[demo model] Board messages: ${read.messages.length} — ${read.messages.map((m) => `${m.fromName} → ${m.toName}: ${m.body}`).join(" | ").slice(0, 300)}`;
    const refused = results.find((v) => v.ok === false || typeof v.code === "string");
    if (refused) return `[demo model] Board messages read DENIED honestly: ${String(refused.code ?? "")} ${String(refused.error ?? "unknown")}`.slice(0, 200);
    return "[demo model] Board messages read finished without a result.";
  }
  const listed = results.find((v) => Array.isArray(v.jobs));
  const claimed = results.find((v) => v.job && typeof v.job.claimantId === "string" && v.job.status === "claimed");
  const completed = results.find((v) => v.job && v.job.status === "completed");
  // A denial is any structured refusal — ok:false OR a bare {code,error}
  // once the envelope is unwrapped (step 10: the model reports it, never
  // "finished without board results").
  const denial = results.find((v) => v.ok === false || (typeof v.code === "string" && !v.job && !v.jobs));
  if (completed) return `[demo model] Board job ${completed.job.id} claimed and completed — the result is on the board.`;
  if (denial) return `[demo model] Board job flow DENIED honestly: ${String(denial.code ?? "")} ${String(denial.error ?? "unknown")}`.slice(0, 200);
  if (claimed) return `[demo model] Board job ${claimed.job.id} claimed; completion did not settle.`;
  if (listed) return "[demo model] Board job flow: no claimable job was listed.";
  return "[demo model] Board job flow finished without board results.";
}

// ── @demo-enum-slip helpers ─────────────────────────────────────────────────
function wantsEnumSlip(prompt) {
  return !!latestRunSlice(prompt)?.marker?.enumSlip;
}

function enumSlipAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Enum slip/.test(p.text ?? "")));
}

/** Honest final text: the SECOND execute's result decides — an artifact id
 *  means the corrected retry on the same ref went through; anything else
 *  (a replay refusal, a denial) reads as a failure, never a success. */
function enumSlipFinalText(prompt) {
  // Continuation AFTER the final text (agent-do compacts the tool exchange
  // away, then asks to continue): re-emit the EXACT prior final so the
  // thread's terminal message stays the real answer.
  const prior = runSlice(prompt)
    .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
    .flatMap((m) => m.content)
    .find((p) => p?.type === "text" && /\[demo model\] Enum slip/.test(p.text ?? ""));
  if (prior?.text) return prior.text;
  const executes = boardToolParts(prompt).filter((p) =>
    p?.type === "tool-result" || p?.type === "tool-error");
  // The execute_tool envelope reaches the model as a direct object, inside an
  // agent-do {modelContent} wrapper, or as a raw JSON string (agent.js
  // lazyEnvelope) — unwrap every form before deciding.
  const parse = (v) => {
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
    return v && typeof v === "object" ? v : null;
  };
  const outputs = executes.map((p) => {
    let v = parse(p.output?.value ?? p.output ?? p.error);
    if (v && "modelContent" in v && !("error" in v && "retryable" in v)) v = parse(v.modelContent) ?? v;
    return v ?? {};
  });
  // Tool parts may be relabelled by the selected tool, so decide on CONTENT:
  // the refused call (retryable, ref handed back) and the created artifact.
  const refused = outputs.find((v) => v.error === "lazy-arguments-invalid" && v.retryable === true);
  const created = outputs.find((v) =>
    v.ok === true && v.selectedTool === "create_asset" && typeof v.result?.asset?.id === "string");
  if (refused && created) {
    return `[demo model] Enum slip recovered: the first create_asset used type "text/html" and was refused as retryable; the corrected retry on the SAME selectionRef created artifact ${created.result.asset.id}.`;
  }
  const failed = outputs.find((v) => v.ok === false && v.error !== "lazy-arguments-invalid");
  const why = String(failed?.error ?? (refused ? "the corrected retry never created the artifact" : "the first call was not refused as retryable")).slice(0, 160);
  return `[demo model] Enum slip recovery FAILED honestly: ${why}`;
}

const ENUM_SLIP_ARGS = Object.freeze({
  origin: "master",
  name: "enum slip page",
  content: "<h1>enum slip</h1><p>created on the corrected retry</p>",
});

// ── @demo-edit-artifact helpers ─────────────────────────────────────────────
const EDIT_ARTIFACT_NAME = "crumb.html";
// A small multi-line page so the owner-approval card renders a REAL line diff
// (EDIT-APPROVAL-SHOWS-DIFF-01): the edit changes the tagline and adds an
// "Opening hours" section, so the card shows +added -removed with a `+` line
// carrying "Opening hours".
const EDIT_ARTIFACT_V1 = [
  "<!doctype html>",
  "<html>",
  "  <body>",
  "    <h1>Crumb</h1>",
  "    <p>Fresh sourdough, baked daily.</p>",
  "  </body>",
  "</html>",
].join("\n");
const EDIT_ARTIFACT_V2 = [
  "<!doctype html>",
  "<html>",
  "  <body>",
  "    <h1>Crumb Bakery</h1>",
  "    <p>Fresh sourdough and pastries, baked daily.</p>",
  "    <h2>Opening hours</h2>",
  "    <p>Mon to Sat, 7am to 3pm.</p>",
  "  </body>",
  "</html>",
].join("\n");
function wantsEditArtifact(prompt) {
  return !!latestRunSlice(prompt)?.marker?.editArtifact;
}
function editArtifactAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Artifact edit/.test(p.text ?? "")));
}
/** Every executed lazy call's unwrapped output in order (the execute_tool
 *  envelope reaches the model as an object, an agent-do {modelContent}
 *  wrapper, or a raw JSON string). */
function lazyExecuteOutputs(prompt) {
  const parse = (v) => {
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
    return v && typeof v === "object" ? v : null;
  };
  return boardToolParts(prompt)
    .filter((p) => p?.type === "tool-result" || p?.type === "tool-error")
    .map((p) => {
      let v = parse(p.output?.value ?? p.output ?? p.error);
      if (v && "modelContent" in v && !("error" in v && "retryable" in v)) v = parse(v.modelContent) ?? v;
      return v ?? {};
    });
}
function editArtifactCreatedId(prompt) {
  const created = lazyExecuteOutputs(prompt).find((v) =>
    v.ok === true && v.selectedTool === "create_asset" && typeof v.result?.asset?.id === "string");
  return created?.result?.asset?.id ?? null;
}
/** Honest final text: the update's result decides. */
function editArtifactFinalText(prompt) {
  const prior = runSlice(prompt)
    .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
    .flatMap((m) => m.content)
    .find((p) => p?.type === "text" && /\[demo model\] Artifact edit/.test(p.text ?? ""));
  if (prior?.text) return prior.text;
  const outputs = lazyExecuteOutputs(prompt);
  const createdId = editArtifactCreatedId(prompt);
  // The update's result envelope is bounded on its way to the model (the
  // asset identity is dropped as "bulk"), so success is the envelope's own
  // ok + the selected tool, not the asset id.
  const updated = outputs.find((v) =>
    v.ok === true && v.selectedTool === "update_asset" && (v.result?.ok === true || typeof v.result?.asset?.id === "string"));
  if (createdId && updated) {
    return `[demo model] Artifact edit complete: created ${EDIT_ARTIFACT_NAME} (${createdId}) and then updated it to version two.`;
  }
  const failed = outputs.find((v) => v.ok === false);
  const why = String(failed?.error ?? (createdId ? "the update never settled" : "the create never settled")).slice(0, 160);
  return `[demo model] Artifact edit FAILED honestly: ${why}`;
}

// ── @demo-patch-artifact helpers (CAP-FB-20260830-PATCH-ASSET-TOOL-01) ──────
const PATCH_ARTIFACT_NAME = "crumb.html";
// A small page with ONE brand colour to change. The whole document is ~180
// bytes; the point of patch_asset is that the EDIT is a handful of bytes.
const PATCH_ARTIFACT_V1 = "<!doctype html><html><head><style>:root{--brand:#b91c1c}</style></head><body><h1>Crumb Bakery</h1><p>Fresh bread daily.</p></body></html>";
function wantsPatchArtifact(prompt) {
  return !!latestRunSlice(prompt)?.marker?.patchArtifact;
}
function patchArtifactAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Artifact patch/.test(p.text ?? "")));
}
/** Honest final text: the first patch applied (+1 -1), the stale second one was
 *  refused as version_conflict without mutating. */
function patchArtifactFinalText(prompt) {
  const prior = runSlice(prompt)
    .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
    .flatMap((m) => m.content)
    .find((p) => p?.type === "text" && /\[demo model\] Artifact patch/.test(p.text ?? ""));
  if (prior?.text) return prior.text;
  const outputs = lazyExecuteOutputs(prompt);
  const createdId = editArtifactCreatedId(prompt);
  const patched = outputs.find((v) =>
    v.ok === true && v.selectedTool === "patch_asset" && v.result?.ok === true);
  const conflict = outputs.find((v) =>
    v.selectedTool === "patch_asset" && v.result?.ok === false && v.result?.error === "version_conflict");
  if (createdId && patched && conflict) {
    const added = patched.result?.added ?? "?";
    const removed = patched.result?.removed ?? "?";
    return `[demo model] Artifact patch complete: created ${PATCH_ARTIFACT_NAME} (${createdId}), changed the brand colour with one patch (+${added} -${removed}), and a stale re-edit was refused as version_conflict without changing the file.`;
  }
  const failed = outputs.find((v) => v.result?.ok === false && v.result?.error !== "version_conflict");
  const why = String(failed?.result?.error ?? failed?.error ?? "the patch never settled").slice(0, 160);
  return `[demo model] Artifact patch FAILED honestly: ${why}`;
}

// ── @demo-browser helpers ───────────────────────────────────────────────────
function wantsBrowser(prompt) {
  return !!latestRunSlice(prompt)?.marker?.browser;
}

/** Parse "<tool> [url=…] [tab=…]" after the marker from the CURRENT run's
 * task (original case — URLs are case-sensitive). Unknown tools → null (the
 * final text says so; nothing is called). */
function browserSpec(prompt) {
  const msgs = latestRunSlice(prompt)?.slice ?? [];
  const lastUserMsg = [...msgs].reverse().find((m) => m?.role === "user" && !isAgentDoContinuation(m));
  const text = extractText(lastUserMsg ? [lastUserMsg] : []);
  const m = text.match(/@demo-browser\s+([a-z_]+)((?:\s+(?:url|tab)=\S+)*)/);
  if (!m || !BROWSER_TOOLS.has(m[1])) return null;
  const tool = m[1];
  const url = /url=(\S+)/.exec(m[2] ?? "")?.[1];
  const tab = /tab=(\d+)/.exec(m[2] ?? "")?.[1];
  const args = {};
  if ((tool === "open_tab" || tool === "navigate_tab") && url) args.url = url.slice(0, 2048);
  if (tab && tool !== "open_tab" && tool !== "list_tabs") args.tabId = Number(tab);
  return { tool, args };
}

/** Unwrap one tool part's output through every wrapper the run loop adds:
 * the agent-do { modelContent } wrapper, JSON strings, and the lazy
 * { ok, selectedTool, result } envelope (a denial rides inside `result`). */
function browserUnwrap(output) {
  let v = output && typeof output === "object" && "value" in output ? output.value : output;
  for (let i = 0; i < 4; i++) {
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch { return v; }
    } else if (v && typeof v === "object") {
      if (typeof v.modelContent === "string" || (v.modelContent && typeof v.modelContent === "object")) v = v.modelContent;
      else if (v.ok === true && "result" in v) v = v.result;
      else return v;
    } else return v;
  }
  return v;
}

function browserExecuteParts(prompt) {
  return boardToolParts(prompt).filter((p) => p?.toolName === "execute_tool" && p?.type === "tool-result");
}

/** One more search+execute round is allowed per owner approval (the paused
 * call reports "Owner approved … Retry <tool> now with a fresh search_tools
 * selection"), bounded by BROWSER_MAX_ROUNDS. */
function browserRoundsAllowed(prompt) {
  const approvals = browserExecuteParts(prompt).filter((p) => {
    try { return /Owner approved the requested capability/.test(JSON.stringify(p)); } catch { return false; }
  }).length;
  return Math.min(BROWSER_MAX_ROUNDS, 1 + approvals);
}

function browserAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Browser tool/.test(p.text ?? "")));
}

/** Honest final text from the LAST execute result: a structured denial or
 * error is "NOT performed"; a real result names what came back. */
function browserFinalText(prompt) {
  const spec = browserSpec(prompt);
  if (!spec) return "[demo model] Browser tool request not understood — nothing was performed.";
  const parts = browserExecuteParts(prompt);
  if (!parts.length) return `[demo model] Browser tool ${spec.tool} was not called.`;
  const last = parts[parts.length - 1];
  if (last.output?.type === "error-text") {
    return `[demo model] Browser tool ${spec.tool} was NOT performed: ${String(last.output.value ?? "error").slice(0, 200)}`;
  }
  const v = browserUnwrap(last.output);
  if (typeof v === "string") {
    return /Owner approved|denied|expired|not performed/i.test(v)
      ? `[demo model] Browser tool ${spec.tool} was NOT performed: ${v.slice(0, 200)}`
      : `[demo model] Browser tool ${spec.tool} succeeded: ${v.slice(0, 200)}`;
  }
  if (v && typeof v === "object") {
    if (v.waitingForPermission === true || v.ok === false || typeof v.error === "string") {
      return `[demo model] Browser tool ${spec.tool} was NOT performed: ${String(v.error ?? "denied").slice(0, 200)}`;
    }
    const facts = [];
    if (typeof v.title === "string") facts.push(`title "${v.title.slice(0, 80)}"`);
    if (typeof v.url === "string") facts.push(`url ${v.url.slice(0, 120)}`);
    if (typeof v.tabId === "number") facts.push(`tab ${v.tabId}`);
    // A capture reports the SAVED IMAGE, not a base64 blob: the PNG travels as
    // an image content part and as an OPFS file, and the JSON the model reads
    // names the id and the pixel size
    // (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01). The `screenshot` branch stays
    // for the DIRECT dispatch path, which returns the raw tool result rather
    // than the projected one.
    if (typeof v.screenshotId === "string") {
      facts.push(
        `screenshot ${v.screenshotId}${
          Number(v.width) > 0 && Number(v.height) > 0 ? ` (${v.width}x${v.height})` : ""
        }`,
      );
    } else if (typeof v.screenshot === "string") facts.push(`screenshot (${v.screenshot.length} chars)`);
    if (Array.isArray(v.tabs)) facts.push(`${v.tabs.length} tab(s)`);
    return `[demo model] Browser tool ${spec.tool} succeeded: ${facts.join(", ") || "done"}.`;
  }
  return `[demo model] Browser tool ${spec.tool} finished without a result.`;
}

// ── @demo-every-tab helpers (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01) ────────
function wantsEveryTab(prompt) {
  return !!latestRunSlice(prompt)?.marker?.everyTab;
}
function everyTabMatch(prompt) {
  const slice = latestRunSlice(prompt);
  if (!slice) return "";
  const text = extractText([slice.slice[0]]);
  return text.match(/@demo-every-tab\s+match=(\S{1,120})/)?.[1] ?? "";
}
/** `@demo-every-tab tabs=12,13,14` — an explicit tab-id list skips list_tabs
 * (a headless journey profile cannot hold the `tabs` permission; `scripting`
 * is silent and grantable, so the reads still run for real). */
function everyTabExplicitIds(prompt) {
  const slice = latestRunSlice(prompt);
  if (!slice) return null;
  const text = extractText([slice.slice[0]]);
  const m = text.match(/@demo-every-tab\s+tabs=([\d,]{1,400})/);
  if (!m) return null;
  const ids = m[1].split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 0);
  return ids.length ? ids.slice(0, EVERY_TAB_MAX) : null;
}
function everyTabAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" && Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && EVERY_TAB_FINAL_RE.test(p.text ?? "")));
}
/** One execute_tool part's lazy ENVELOPE ({ ok, selectedTool, result }) — it
 * reaches the model as an object, an agent-do {modelContent} wrapper, or JSON
 * text; null when the part is not an execute envelope. */
function everyTabEnvelope(part) {
  if (part?.type !== "tool-result" || part?.toolName !== "execute_tool") return null;
  const parse = (v) => {
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
    return v && typeof v === "object" ? v : null;
  };
  let v = parse(part.output?.value ?? part.output);
  if (v && "modelContent" in v && !("selectedTool" in v)) v = parse(v.modelContent) ?? v;
  return v && typeof v === "object" && typeof v.selectedTool === "string" ? v : null;
}
/** The tab ids the executed list_tabs returned (unfenced; filtered by match=). */
function everyTabIds(prompt) {
  const match = everyTabMatch(prompt);
  for (const part of boardToolParts(prompt)) {
    const env = everyTabEnvelope(part);
    if (!env || env.selectedTool !== "list_tabs") continue;
    const value = unfenceValue(env.result);
    if (!value || typeof value !== "object" || !Array.isArray(value.tabs)) continue;
    return value.tabs
      .filter((t) => Number.isFinite(t?.id) && (!match || String(t?.url ?? "").includes(match)))
      .map((t) => t.id)
      .slice(0, EVERY_TAB_MAX);
  }
  return null;
}
/** Every executed read_page in order: { ok, error }. */
function everyTabReads(prompt) {
  const reads = [];
  for (const part of boardToolParts(prompt)) {
    if (part?.type === "tool-error" && part?.toolName === "execute_tool") {
      reads.push({ ok: false, error: String(part.error ?? "error").slice(0, 120) });
      continue;
    }
    const env = everyTabEnvelope(part);
    if (!env || env.selectedTool !== "read_page") continue;
    const inner = env.result && typeof env.result === "object" ? env.result : null;
    const failed = env.ok === false || (inner && (inner.ok === false || typeof inner.error === "string"));
    reads.push({ ok: !failed, error: failed ? String(inner?.error ?? env.error ?? "error").slice(0, 120) : "" });
  }
  return reads;
}
/** search(list_tabs) → execute → search(read_page) ONCE → execute read_page per
 * tab on the SAME selectionRef → null (the final text). A failed read moves on
 * to the next tab (the ref survives a failure); it is named in the final text. */
function everyTabCall(prompt) {
  const parts = boardToolParts(prompt);
  const searches = parts.filter((p) => p.toolName === "search_tools").length;
  const executes = parts.filter((p) => p.toolName === "execute_tool").length;
  const explicit = everyTabExplicitIds(prompt);
  if (!explicit) {
    if (searches === 0) return { id: "search_every_list", name: "search_tools", input: { query: "list_tabs", limit: 1 } };
    if (executes === 0) {
      const selectionRef = latestSelectionRef(prompt);
      return selectionRef ? { id: "execute_every_list", name: "execute_tool", input: { selectionRef, arguments: {} } } : null;
    }
  }
  const ids = explicit ?? everyTabIds(prompt);
  if (!ids || ids.length === 0) return null; // honest stop: the final text says so
  if (searches < (explicit ? 1 : 2)) return { id: "search_every_read", name: "search_tools", input: { query: "read_page", limit: 1 } };
  const reads = everyTabReads(prompt);
  if (reads.length >= ids.length) return null;
  // The read_page ref: the LAST search's ref (execute envelopes echo it too).
  const selectionRef = latestSelectionRef(prompt);
  if (!selectionRef) return null;
  const tabId = ids[reads.length];
  return { id: `execute_every_read_${reads.length}`, name: "execute_tool", input: { selectionRef, arguments: { tabId } } };
}
function everyTabFinalText(prompt) {
  const prior = runSlice(prompt)
    .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
    .flatMap((m) => m.content)
    .find((p) => p?.type === "text" && EVERY_TAB_FINAL_RE.test(p.text ?? ""));
  if (prior?.text) return prior.text;
  const ids = everyTabExplicitIds(prompt) ?? everyTabIds(prompt);
  if (!ids) return "[demo model] Every tab: the tab list was not read, so no tab was read.";
  const reads = everyTabReads(prompt);
  const failed = reads.map((r, i) => (r.ok ? null : `${ids[i]} (${r.error})`)).filter(Boolean);
  const read = reads.filter((r) => r.ok).length;
  const unreached = ids.slice(reads.length);
  return `[demo model] Every tab: listed ${ids.length}, read ${read} of ${ids.length}` +
    (failed.length ? `; could not read ${failed.length}: ${failed.join(", ").slice(0, 400)}` : "") +
    (unreached.length ? `; not reached: ${unreached.join(", ").slice(0, 200)}` : "") +
    ".";
}

// ── @demo-mcp helpers (CAP-FB-20260831-MCP-TOOL-INJECTION-01) ─────────────────

function wantsMcp(prompt) {
  return !!latestRunSlice(prompt)?.marker?.mcp;
}

/** Parse "<mcp__server__tool> [json-args]" after the marker from the CURRENT
 * run's task (original case preserved for the args JSON). Unknown shape → null
 * (the final text says so; nothing is called). */
function mcpSpec(prompt) {
  const msgs = latestRunSlice(prompt)?.slice ?? [];
  const lastUserMsg = [...msgs].reverse().find((m) => m?.role === "user" && !isAgentDoContinuation(m));
  const text = extractText(lastUserMsg ? [lastUserMsg] : []);
  const m = text.match(MCP_TOOL_RE);
  if (!m) return null;
  let args = {};
  if (m[2]) {
    try { args = JSON.parse(m[2]); } catch { args = {}; }
  }
  return { tool: m[1], args: args && typeof args === "object" ? args : {} };
}

function mcpExecuteParts(prompt) {
  return boardToolParts(prompt).filter((p) => p?.toolName === "execute_tool" && p?.type === "tool-result");
}

/** One more search+execute round is allowed per owner approval (the first call
 * pauses on the per-server Allow card), bounded by MCP_MAX_ROUNDS. */
function mcpRoundsAllowed(prompt) {
  const approvals = mcpExecuteParts(prompt).filter((p) => {
    try { return /Owner approved the requested capability|waitingForPermission/.test(JSON.stringify(p)); } catch { return false; }
  }).length;
  return Math.min(MCP_MAX_ROUNDS, 1 + approvals);
}

function mcpAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] MCP tool/.test(p.text ?? "")));
}

/** Honest final text from the LAST execute result: a denial/error is "NOT
 * performed"; a real result names what the fenced MCP output carried. */
function mcpFinalText(prompt) {
  const spec = mcpSpec(prompt);
  if (!spec) return "[demo model] MCP tool request not understood — nothing was performed.";
  const parts = mcpExecuteParts(prompt);
  if (!parts.length) return `[demo model] MCP tool ${spec.tool} was not called.`;
  const last = parts[parts.length - 1];
  if (last.output?.type === "error-text") {
    return `[demo model] MCP tool ${spec.tool} was NOT performed: ${String(last.output.value ?? "error").slice(0, 200)}`;
  }
  const v = browserUnwrap(last.output);
  if (v && typeof v === "object") {
    if (v.waitingForPermission === true || v.ok === false || typeof v.error === "string") {
      return `[demo model] MCP tool ${spec.tool} was NOT performed: ${String(v.error ?? "denied").slice(0, 200)}`;
    }
    // The fenced untrusted result: { untrusted:true, value:"<<<UNTRUSTED…>>>…" }.
    const fenced = typeof v.value === "string" ? v.value : JSON.stringify(v).slice(0, 200);
    return `[demo model] MCP tool ${spec.tool} succeeded: ${fenced.slice(0, 200)}`;
  }
  if (typeof v === "string") {
    return `[demo model] MCP tool ${spec.tool} succeeded: ${v.slice(0, 200)}`;
  }
  return `[demo model] MCP tool ${spec.tool} finished without a result.`;
}

function lazyDemoCall(prompt, { delegate = false, delegateAgent = false, board = false, browser = false, mcp = false, enumSlip = false, runScript = false, editArtifact = false, patchArtifact = false, skillRead = false, remember = false } = {}) {
  const step = toolResultCount(prompt);
  if (remember) {
    // ONE key, through the REAL lazy protocol: search_tools(memory_set) →
    // execute_tool. Nothing else, so the recall thread reads a store the
    // journey wrote exactly one row into.
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    if (executes >= 1) return null;
    if (searches <= executes) {
      return { id: "search_remember", name: "search_tools", input: { query: "memory_set", limit: 1 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    const { key, value } = rememberSpec(prompt);
    return { id: "execute_remember", name: "execute_tool", input: { selectionRef, arguments: { key, value } } };
  }
  if (editArtifact) {
    // search(create_asset) → execute create → search(update_asset) → execute
    // update on the created id → final text (two real edits of one artifact).
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    if (executes >= 2) return null;
    if (searches <= executes) {
      return { id: `search_edit_artifact_${searches}`, name: "search_tools", input: { query: executes === 0 ? "create_asset" : "update_asset", limit: 1 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    if (executes === 0) {
      return { id: "execute_edit_artifact_create", name: "execute_tool", input: { selectionRef, arguments: { origin: "master", name: EDIT_ARTIFACT_NAME, type: "html", content: EDIT_ARTIFACT_V1 } } };
    }
    const id = editArtifactCreatedId(prompt);
    if (!id) return null; // honest stop: the final text reports it
    return { id: "execute_edit_artifact_update", name: "execute_tool", input: { selectionRef, arguments: { origin: "master", id, content: EDIT_ARTIFACT_V2 } } };
  }
  if (patchArtifact) {
    // search(create_asset) → execute create (crumb.html, head 1) →
    // search(patch_asset) → execute STALE patch (expectVersion 999 while head is
    //   1 → version_conflict, refused BEFORE the approval gate, no card, no
    //   mutation) →
    // search(patch_asset) → execute APPLY patch (one colour, expectVersion 1 →
    //   owner card → +1 -1, head 2). The approved mutation is the LAST execute
    //   (the proven lazy-protocol shape — a mid-run approval pause would strand
    //   the following step's selection); the refused stale patch needs no card,
    //   so it can precede it safely.
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    if (executes >= 3) return null;
    if (searches <= executes) {
      return { id: `search_patch_artifact_${searches}`, name: "search_tools", input: { query: executes === 0 ? "create_asset" : "patch_asset", limit: 1 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    if (executes === 0) {
      return { id: "execute_patch_create", name: "execute_tool", input: { selectionRef, arguments: { origin: "master", name: PATCH_ARTIFACT_NAME, type: "html", content: PATCH_ARTIFACT_V1 } } };
    }
    const id = editArtifactCreatedId(prompt);
    if (!id) return null; // honest stop: the final text reports it
    if (executes === 1) {
      // The STALE re-edit: expectVersion 999 can never be the head, so it is
      // refused as version_conflict without a card and without mutating.
      return { id: "execute_patch_stale", name: "execute_tool", input: { selectionRef, arguments: { origin: "master", id, edits: [{ search: "#b91c1c", replace: "#16a34a" }], expectVersion: 999 } } };
    }
    // executes === 2 — the real edit (LAST execute): a few bytes of args, not the
    // whole document; expectVersion 1 matches the head, so the owner card shows.
    return { id: "execute_patch_apply", name: "execute_tool", input: { selectionRef, arguments: { origin: "master", id, edits: [{ search: "#b91c1c", replace: "#2563eb" }], expectVersion: 1 } } };
  }
  if (browser) {
    const spec = browserSpec(prompt);
    if (!spec) return null; // honest stop: the final text reports it
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    const rounds = browserRoundsAllowed(prompt);
    if (executes >= rounds) return null;
    if (searches <= executes) {
      return { id: `search_browser_${searches}`, name: "search_tools", input: { query: spec.tool, limit: 1 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    return { id: `execute_browser_${executes}`, name: "execute_tool", input: { selectionRef, arguments: spec.args } };
  }
  if (mcp) {
    // search(<mcp__server__tool>) → execute_tool(selectionRef, args) → final.
    // The first execute pauses on the per-server owner Allow card; after Allow
    // a fresh search+execute round runs and returns the fenced result.
    const spec = mcpSpec(prompt);
    if (!spec) return null; // honest stop: the final text reports it
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    const rounds = mcpRoundsAllowed(prompt);
    if (executes >= rounds) return null;
    if (searches <= executes) {
      return { id: `search_mcp_${searches}`, name: "search_tools", input: { query: spec.tool, limit: 3 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    return { id: `execute_mcp_${executes}`, name: "execute_tool", input: { selectionRef, arguments: spec.args } };
  }
  if (enumSlip) {
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    if (executes >= 2) return null;
    if (searches === 0) {
      return { id: "search_enum_slip", name: "search_tools", input: { query: "create_asset", limit: 1 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    if (executes === 0) {
      // the live-lane slip: a MIME type where the enum wants a literal
      return { id: "execute_enum_slip_wrong", name: "execute_tool", input: { selectionRef, arguments: { ...ENUM_SLIP_ARGS, type: "text/html" } } };
    }
    // the corrected retry — deliberately the SAME ref (no second search)
    return { id: "execute_enum_slip_fixed", name: "execute_tool", input: { selectionRef, arguments: { ...ENUM_SLIP_ARGS, type: "html" } } };
  }
  if (runScript) {
    // search → execute run_script(id) → final (the execute pauses on the
    // owner's approval card; a denial returns ok:false and the final text
    // reports it).
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    if (executes >= 1) return null;
    if (searches === 0) return { id: "search_run_script", name: "search_tools", input: { query: "run_script", limit: 1 } };
    const selectionRef = latestSelectionRef(prompt);
    return selectionRef
      ? { id: "execute_run_script", name: "execute_tool", input: { selectionRef, arguments: { id: runScriptId(prompt), origin: "master" } } }
      : null;
  }
  if (skillRead) {
    // search → execute skill_read({skill, path}) → final (the keyless proof
    // that a large/multi-file imported skill loads on demand mid-run).
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    if (executes >= 1) return null;
    if (searches === 0) return { id: "search_skill_read", name: "search_tools", input: { query: "skill_read", limit: 1 } };
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    const args = { skill: skillReadId(prompt) };
    const path = skillReadPath(prompt);
    if (path) args.path = path;
    return { id: "execute_skill_read", name: "execute_tool", input: { selectionRef, arguments: args } };
  }
  if (board) {
    // search → execute per board tool (a selectionRef is single-use):
    // board_list → board_claim_job(the first claimable) → board_complete_job.
    const toolParts = boardToolParts(prompt);
    const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
    const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
    const mode = boardMode(prompt);
    const plan = mode === "post" ? ["board_post_job"] : mode === "read" ? ["board_read_messages"] : ["board_list", "board_claim_job", "board_complete_job"];
    if (searches >= plan.length && executes >= plan.length) return null;
    // A denied/failed claim ENDS the flow (step 10): no complete call after
    // a refusal — the final text reports the denial.
    if (executes >= 2 && boardDeniedSoFar(prompt)) return null;
    if (searches <= executes) {
      return { id: `search_board_${searches}`, name: "search_tools", input: { query: plan[searches], limit: 1 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    if (!selectionRef) return null;
    if (mode === "post") return { id: "execute_board_post", name: "execute_tool", input: { selectionRef, arguments: boardPostArgs(prompt) } };
    if (mode === "read") return { id: "execute_board_read", name: "execute_tool", input: { selectionRef, arguments: { limit: 10 } } };
    if (executes === 0) {
      return { id: "execute_board_list", name: "execute_tool", input: { selectionRef, arguments: {} } };
    }
    const jobId = boardListFirstJobId(prompt);
    if (!jobId) return null; // honest stop: the final text reports it
    if (executes === 1) {
      return { id: "execute_board_claim", name: "execute_tool", input: { selectionRef, arguments: { jobId } } };
    }
    return { id: "execute_board_complete", name: "execute_tool", input: { selectionRef, arguments: { jobId, result: "[demo] claimed and completed via @demo-board" } } };
  }
  if (delegateAgent) {
    const parallelRefs = delegateParallelRefs(prompt);
    if (parallelRefs) {
      // TWO searches (a selectionRef is single-use — one per sibling), then
      // TWO executes in ONE step, driving agent-do's concurrent same-step
      // execution (the parallel-sibling delegation path).
      const toolParts = runSlice(prompt)
        .filter((m) => m?.role === "tool")
        .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
        .filter((p) => p && typeof p === "object");
      const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
      const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
      if (executes >= 2) return null;
      if (searches < 2) {
        return [0, 1].map((i) => ({ id: `search_delegate_${i}`, name: "search_tools", input: { query: "delegate_to_agent", limit: 1 } }));
      }
      const refs = runSlice(prompt)
        .filter((m) => m?.role === "tool")
        .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
        .map((p) => JSON.stringify(p).match(/sel_[a-f0-9]{36}/u)?.[0])
        .filter(Boolean);
      const [refA, refB] = [refs.at(-2), refs.at(-1)];
      return refA && refB
        ? [
          { id: "execute_delegate_a", name: "execute_tool", input: { selectionRef: refA, arguments: { agent: parallelRefs[0], task: wantsSlowFirstParallelDelegate(prompt) ? "@demo-tools @demo-slow" : "@demo-tools" } } },
          { id: "execute_delegate_b", name: "execute_tool", input: { selectionRef: refB, arguments: { agent: parallelRefs[1], task: "@demo-tools" } } },
        ]
        : null;
    }
    const wantMulti = delegateMultiCount(prompt);
    if (wantMulti > 0) {
      // search → delegate → … → final: N SEQUENTIAL child runs against one
      // budget. Round detection reads the tool parts' toolName (result
      // messages can carry more than one part, so a naive result count
      // miscounts rounds).
      const toolParts = runSlice(prompt)
        .filter((m) => m?.role === "tool")
        .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
        .filter((p) => p && typeof p === "object");
      const searches = toolParts.filter((p) => p.toolName === "search_tools").length;
      const executes = toolParts.filter((p) => p.toolName === "execute_tool").length;
      if (searches >= wantMulti && executes >= wantMulti) return null;
      if (searches <= executes) {
        return { id: `search_delegate_${searches}`, name: "search_tools", input: { query: "delegate_to_agent", limit: 1 } };
      }
      const selectionRef = latestSelectionRef(prompt);
      return selectionRef
        ? { id: `execute_delegate_${executes}`, name: "execute_tool", input: { selectionRef, arguments: { agent: delegateAgentRef(prompt), task: wantMulti >= 3 ? "@demo-tools-x2" : "@demo-tools" } } }
        : null;
    }
    // ONE delegation, decided by the run's OWN delegate parts (not the raw
    // tool-result count, which an unrelated result or a compacted history
    // shifts): no search yet → search; a search but no execute → execute;
    // any execute (succeeded OR failed) → stop, the final text reports it.
    const parts = boardToolParts(prompt);
    const searches = parts.filter((p) => p.toolName === "search_tools").length;
    const executes = parts.filter((p) => p.toolName === "execute_tool").length;
    if (executes >= 1) return null;
    if (searches === 0) {
      return { id: "search_delegate_agent", name: "search_tools", input: { query: "delegate_to_agent", limit: 1 } };
    }
    const selectionRef = latestSelectionRef(prompt);
    return selectionRef
      ? { id: "execute_delegate_agent", name: "execute_tool", input: { selectionRef, arguments: { agent: delegateAgentRef(prompt), task: delegateChildTask(prompt) } } }
      : null;
  }
  if (delegate) {
    if (step === 0) {
      return { id: "search_delegate", name: "search_tools", input: { query: "delegate_task", limit: 1 } };
    }
    if (step === 1) {
      const selectionRef = latestSelectionRef(prompt);
      return selectionRef
        ? { id: "execute_delegate", name: "execute_tool", input: { selectionRef, arguments: { agentId: delegateAgentId(prompt), task: "run @demo-tools @demo-slow please" } } }
        : null;
    }
    return null;
  }
  if (wantsCreateAgent(prompt)) {
    // search → execute create_named_agent with the parsed name/role. The args
    // carry a credential-SHAPED note so the journal + the live card must both
    // show it redacted (the tool-call clarity KAT's redaction leg).
    if (step === 0) {
      return { id: "search_create_agent", name: "search_tools", input: { query: "create_named_agent", limit: 1 } };
    }
    if (step === 1) {
      const selectionRef = latestSelectionRef(prompt);
      const { name, role } = createAgentSpec(prompt);
      return selectionRef
        ? { id: "execute_create_agent", name: "execute_tool", input: { selectionRef, arguments: { name, role, note: "kat marker — apiKey: sk-kat-redaction-check-123456" } } }
        : null;
    }
    return null;
  }
  const plan = [
    { type: "search", tool: "memory_set" },
    { type: "execute", args: DEMO_ARGS },
    { type: "search", tool: "memory_get" },
    { type: "execute", args: { key: "demo" } },
    { type: "search", tool: "memory_get" },
    { type: "execute", args: { key: "demo" } },
  ];
  const fullPlan = wantsDemoToolsX2(prompt) ? [...plan, ...plan] : plan;
  const action = fullPlan[step];
  if (!action) return null;
  if (action.type === "search") {
    return { id: `search_${step}`, name: "search_tools", input: { query: action.tool, limit: 1 } };
  }
  const selectionRef = latestSelectionRef(prompt);
  return selectionRef
    ? { id: `execute_${step}`, name: "execute_tool", input: { selectionRef, arguments: action.args } }
    : null;
}

function demoAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Tool calls executed in sequence/.test(p.text ?? "")));
}

function createAgentFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] (Created agent|Agent creation failed)/.test(p.text ?? "")));
}

/** The create-agent final text: honest about the outcome (the tool result in
 * the slice decides — a failed create must never read as a success). */
function createAgentFinalText(prompt) {
  const { name } = createAgentSpec(prompt);
  const slice = runSlice(prompt);
  const results = slice
    .filter((m) => m?.role === "tool")
    .flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .map((p) => p?.result ?? p?.output ?? null);
  const executeResult = results[results.length - 1];
  const text = typeof executeResult === "string" ? executeResult : JSON.stringify(executeResult ?? "");
  const failed = /"ok"\s*:\s*false|error/i.test(text) && !/"ok"\s*:\s*true/.test(text);
  return failed
    ? `[demo model] Agent creation failed honestly: ${text.slice(0, 160)}`
    : `[demo model] Created agent "${name}" via create_named_agent.`;
}

function delegateAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Delegation/.test(p.text ?? "")));
}

function agentDelegateAlreadyFinal(prompt) {
  return runSlice(prompt).some((m) =>
    m?.role === "assistant" &&
    Array.isArray(m?.content) &&
    m.content.some((p) => p?.type === "text" && /\[demo model\] Agent delegation/.test(p.text ?? "")));
}

/** The delegate-to-agent final text: the child run's outcome decides (a
 * failed/denied delegation reads as a failure, never a success). Shared by
 * the generate + stream paths so both stop after the ONE attempt. */
function agentDelegateFinalText(prompt) {
  // STEP 2 (delegate-to-agent): reflect the child run's outcome with
  // the SAME structural tool-part parsing as the site-delegation path.
  // The lazy execute_tool wrapper reports { ok:true, result: <route
  // result> } for a COMPLETED call — a structured DENIAL rides inside
  // as result.ok === false, so look one level in before deciding.
  const lastTool = [...runSlice(prompt)].reverse().find((m) => m?.role === "tool");
  const parts = Array.isArray(lastTool?.content) ? lastTool.content : [];
  let succeeded = false;
  for (const part of parts) {
    if (part?.type === "tool-result" && part?.output) {
      if (part.output.type === "error-text") { succeeded = false; break; }
      succeeded = true;
    } else if (part?.type === "tool-error") { succeeded = false; break; }
  }
  const outValue = parts.find((pt) => pt?.type === "tool-result" && pt?.output && pt.output.type !== "error-text")?.output?.value ?? "";
  const errValue = parts.find((pt) => pt?.output?.type === "error-text")?.output?.value ?? parts.find((pt) => pt?.type === "tool-error")?.error ?? "";
  let outText = typeof outValue === "string" ? outValue : JSON.stringify(outValue ?? "");
  // Unwrap the lazy protocol envelope (string OR object form).
  let inner = outValue;
  if (typeof outValue === "string") {
    try { inner = JSON.parse(outValue); } catch { inner = outValue; }
  }
  const routeResult = inner && typeof inner === "object" && "result" in inner ? inner.result : inner;
  if (succeeded && routeResult && typeof routeResult === "object" && routeResult.ok === false) {
    succeeded = false;
    outText = String(routeResult.error ?? "delegation denied");
  } else if (succeeded && routeResult && typeof routeResult === "object" && typeof routeResult.result === "string") {
    outText = routeResult.result;
  }
  return succeeded
    ? `[demo model] Agent delegation succeeded. Child result: ${String(outText).slice(0, 200)}`
    : `[demo model] Agent delegation DENIED/FAILED: ${String(succeeded ? "" : (routeResult?.error ?? outText ?? errValue)).slice(0, 200)}`;
}

// A deterministic, RICH tool-call payload (nested arrays/objects/unicode — the
// structured renderer's showcase + the journal's real persisted rows).
const DEMO_ARGS = {
  key: "demo",
  value: {
    items: [
      { name: "Espresso machine", qty: 1, tags: ["kitchen", "appliance"], note: "ünïçødé 日本語" },
      { name: "AeroPress", qty: 2, tags: ["kitchen"] },
    ],
    total: 3.5,
    active: true,
    meta: { nested: { deep: [1, [2, [3]]], ratio: 0.75 } },
  },
};

export function createDemoModel() {
  return {
    specificationVersion: "v2",
    provider: "demo",
    modelId: "demo-local",
    supportedUrls: {},

    doGenerate(options) {
      const text = extractText(options.prompt);
      const createAgentDone = wantsCreateAgent(options.prompt) &&
        (createAgentFinal(options.prompt) || toolResultCount(options.prompt) >= 2);
      const lazyCall = wantsObeyPage(options.prompt) && !obeyAlreadyFinal(options.prompt)
        ? obeyPageCall(options.prompt)
        : wantsRemember(options.prompt) && !rememberAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { remember: true })
        : wantsAgentDelegate(options.prompt) && !agentDelegateAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { delegateAgent: true })
        : wantsEnumSlip(options.prompt) && !enumSlipAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { enumSlip: true })
        : wantsEditArtifact(options.prompt) && !editArtifactAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { editArtifact: true })
        : wantsPatchArtifact(options.prompt) && !patchArtifactAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { patchArtifact: true })
        : wantsRunScript(options.prompt) && !runScriptAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { runScript: true })
        : wantsSkillRead(options.prompt) && !skillReadAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { skillRead: true })
        : wantsBoard(options.prompt) && !boardAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { board: true })
        : wantsBrowser(options.prompt) && !browserAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { browser: true })
        : wantsEveryTab(options.prompt) && !everyTabAlreadyFinal(options.prompt)
        ? everyTabCall(options.prompt)
        : wantsMcp(options.prompt) && !mcpAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { mcp: true })
        // The continuation strips the tool history, so without the
        // already-final guard the delegate plan restarted EVERY iteration
        // (12 delegate calls per run; 48 once the budget grew).
        : wantsDelegate(options.prompt) && !delegateAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt, { delegate: true })
        : wantsCreateAgent(options.prompt) && !createAgentDone
        ? lazyDemoCall(options.prompt)
        : wantsDemoTools(options.prompt) && !demoAlreadyFinal(options.prompt)
        ? lazyDemoCall(options.prompt)
        : null;
      if (lazyCall) {
        const lazyCalls = Array.isArray(lazyCall) ? lazyCall : [lazyCall];
        return Promise.resolve({
          content: lazyCalls.map((call) => ({
            type: "tool-call",
            toolCallId: `call_demo_${call.id}`,
            toolName: call.name,
            input: JSON.stringify(call.input),
          })),
          finishReason: "tool-calls",
          usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
          warnings: [],
        });
      }
      // The create-agent final/continuation text: honest about the outcome, and
      // the marker text lets the stripped-history continuation re-emit it so
      // the loop ends (mirrors the @demo-tools alreadyFinal pattern).
      // The board final/continuation text: honest about the outcome (the
      // marker lets the stripped-history continuation re-emit it + stop).
      // CAP-FB-20260830-MEMORY-RECALL-NEW-THREAD-01: the write's honest outcome,
      // and the recall answer read from THIS prompt's memory digest.
      if (wantsRemember(options.prompt)) {
        const prior = runSlice(options.prompt)
          .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
          .flatMap((m) => m.content)
          .find((p2) => p2?.type === "text" && REMEMBER_FINAL_RE.test(p2.text ?? ""));
        return Promise.resolve({
          content: [{ type: "text", text: prior?.text ?? rememberFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsRecall(options.prompt)) {
        const prior = runSlice(options.prompt)
          .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
          .flatMap((m) => m.content)
          .find((p2) => p2?.type === "text" && RECALL_FINAL_RE.test(p2.text ?? ""));
        return Promise.resolve({
          content: [{ type: "text", text: prior?.text ?? recallFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsEditArtifact(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: editArtifactFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsPatchArtifact(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: patchArtifactFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsEnumSlip(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: enumSlipFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsRunScript(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: runScriptFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsSkillRead(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: skillReadFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsBrowser(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: browserFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsEveryTab(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: everyTabFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsMcp(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: mcpFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsObeyPage(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: obeyPageFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsBoard(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: boardFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsAgentDelegate(options.prompt)) {
        const prior = runSlice(options.prompt)
          .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
          .flatMap((m) => m.content)
          .find((p2) => p2?.type === "text" && /\[demo model\] Agent delegation/.test(p2.text ?? ""));
        return Promise.resolve({
          content: [{ type: "text", text: prior?.text ?? agentDelegateFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (wantsCreateAgent(options.prompt)) {
        return Promise.resolve({
          content: [{ type: "text", text: createAgentFinalText(options.prompt) }],
          finishReason: "stop",
          usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
          warnings: [],
        });
      }
      if (!wantsDemoTools(options.prompt) && !wantsDelegate(options.prompt)) {
      }
      const response = `[demo model] I received "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}". ` +
        `This is a deterministic demo response — configure a real provider (OpenAI-compatible endpoint) ` +
        `in Settings to get real completions.`;
      return Promise.resolve({
        content: [{ type: "text", text: response }],
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 32, totalTokens: 40 },
        warnings: [],
      });
    },

    async doStream(options) {
      if (wantsSlow(options.prompt) && !options._slowUsed) {
        options._slowUsed = true;
        await abortableDelay(DEMO_SLOW_HOLD_MS, options.abortSignal);
      }
      const text = extractText(options.prompt);
      const wantsTools = wantsDemoTools(options.prompt);
      const wantsDel = wantsDelegate(options.prompt);
      const wantsADel = wantsAgentDelegate(options.prompt);
      const id = `demo-${crypto.randomUUID?.() ?? Math.random()}`;
      const usage = { inputTokens: 8, outputTokens: 32, totalTokens: 40 };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          let response = "";
          const createAgentDone = wantsCreateAgent(options.prompt) &&
            (createAgentFinal(options.prompt) || toolResultCount(options.prompt) >= 2);
          const lazyCall = wantsObeyPage(options.prompt) && !obeyAlreadyFinal(options.prompt)
            ? obeyPageCall(options.prompt)
            : wantsRemember(options.prompt) && !rememberAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { remember: true })
            : wantsADel && !agentDelegateAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { delegateAgent: true })
            : wantsEnumSlip(options.prompt) && !enumSlipAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { enumSlip: true })
            : wantsEditArtifact(options.prompt) && !editArtifactAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { editArtifact: true })
            : wantsPatchArtifact(options.prompt) && !patchArtifactAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { patchArtifact: true })
            : wantsRunScript(options.prompt) && !runScriptAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { runScript: true })
            : wantsSkillRead(options.prompt) && !skillReadAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { skillRead: true })
            : wantsBoard(options.prompt) && !boardAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { board: true })
            : wantsBrowser(options.prompt) && !browserAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { browser: true })
            : wantsEveryTab(options.prompt) && !everyTabAlreadyFinal(options.prompt)
            ? everyTabCall(options.prompt)
            : wantsMcp(options.prompt) && !mcpAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { mcp: true })
            : wantsDel && !delegateAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt, { delegate: true })
            : wantsCreateAgent(options.prompt) && !createAgentDone
            ? lazyDemoCall(options.prompt)
            : wantsTools && !demoAlreadyFinal(options.prompt)
            ? lazyDemoCall(options.prompt)
            : null;
          if (lazyCall) {
            const lazyCalls = Array.isArray(lazyCall) ? lazyCall : [lazyCall];
            for (const call of lazyCalls) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call_demo_${call.id}`,
                toolName: call.name,
                input: JSON.stringify(call.input),
              });
            }
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          if (wantsDel && delegateAlreadyFinal(options.prompt)) {
            // the continuation step (tool history stripped) re-emits the EXACT
            // summary the model already produced (the final text stays the
            // authoritative outcome — FAILED or succeeded, never a neutral
            // rewrite that could mask a failed delegation)
            // scope to the CURRENT run's slice ONLY — a prior run's success in
            // the broader history can never be replayed onto the current failure
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && /\[demo model\] Delegation/.test(p2.text ?? ""));
            response = prior?.text ?? "[demo model] Delegation finished.";
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          if (wantsDel) {
            // STEP 2 (delegate): reflect the delegation outcome (an aborted /
            // failed delegation is a REAL tool-error — the run reports it).
            // The SDK's tool-error message may be EMPTY (the error rides the
            // run's rejection, not the tool message), so the absence of any
            // SUCCESSFUL delegate result is the signal.
            const lastTool = [...runSlice(options.prompt)].reverse().find((m) => m?.role === "tool");
            // STRUCTURAL parsing of the AI SDK tool PARTS: the tool message's
            // content is an array of { type:'tool-result'|'tool-error', output }
            // parts (NOT `result`). A result part whose output.type ===
            // "error-text" is FAILED; a result part with a REAL output value is
            // SUCCESS — the worker text's WORDS never matter (a successful text
            // mentioning 'error'/'abort' must not be rejected).
            const parts = Array.isArray(lastTool?.content) ? lastTool.content : [];
            let succeeded = false;
            for (const part of parts) {
              if (part?.type === "tool-result" && part?.output) {
                if (part.output.type === "error-text") {
                  succeeded = false;
                  break;
                }
                succeeded = true;
              } else if (part?.type === "tool-error") {
                succeeded = false;
                break;
              }
            }
            const failed = !succeeded;
            // the SUCCESS response uses the STRUCTURALLY parsed output value
            const outValue = parts.find((pt) => pt?.type === "tool-result" && pt?.output && pt.output.type !== "error-text")?.output?.value ?? "";
            response = failed
              ? "[demo model] Delegation FAILED — the delegated worker was aborted mid-run."
              : `[demo model] Delegation succeeded. Worker response: ${typeof outValue === "string" ? outValue.slice(0, 160) : JSON.stringify(outValue ?? "").slice(0, 160)}`;
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          if (wantsRemember(options.prompt) || wantsRecall(options.prompt)) {
            // CAP-FB-20260830-MEMORY-RECALL-NEW-THREAD-01: the write's honest
            // outcome / the recall answer read from THIS prompt's digest. A
            // continuation re-emits the exact prior final so the loop ends.
            const re = wantsRemember(options.prompt) ? REMEMBER_FINAL_RE : RECALL_FINAL_RE;
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && re.test(p2.text ?? ""));
            response = prior?.text ??
              (wantsRemember(options.prompt) ? rememberFinalText(options.prompt) : recallFinalText(options.prompt));
          }
          else if (wantsObeyPage(options.prompt)) {
            // The injection probe's final/continuation text: the REAL tool
            // results decide (fenced page + policy → refused; else obeyed).
            // A continuation re-emits the prior final so the loop ends.
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && OBEY_FINAL_RE.test(p2.text ?? ""));
            response = prior?.text ?? obeyPageFinalText(options.prompt);
          }
          else if (wantsCreateAgent(options.prompt)) {
            // the create-agent final/continuation text (honest outcome; the
            // marker lets the stripped-history continuation re-emit + stop)
            response = createAgentFinalText(options.prompt);
          }
          else if (wantsADel && agentDelegateAlreadyFinal(options.prompt)) {
            // Continuation AFTER the final text (agent-do compacts the tool
            // exchange away, then asks to continue): re-emit the EXACT prior
            // final — never restart the search/execute sequence.
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && /\[demo model\] Agent delegation/.test(p2.text ?? ""));
            response = prior?.text ?? "[demo model] Agent delegation finished.";
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          else if (wantsADel) {
            response = agentDelegateFinalText(options.prompt);
            controller.enqueue({ type: "text-start", id });
            const chunks = response.match(/.{1,24}/g) ?? [response];
            for (const chunk of chunks) controller.enqueue({ type: "text-delta", id, delta: chunk });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
            controller.close();
            return;
          }
          else if (wantsEnumSlip(options.prompt)) {
            // The enum-slip final/continuation text: the second execute's
            // result decides the outcome (never a neutral rewrite).
            response = enumSlipFinalText(options.prompt);
          }
          else if (wantsEditArtifact(options.prompt)) {
            // The artifact-edit final/continuation text: the update's result decides.
            response = editArtifactFinalText(options.prompt);
          }
          else if (wantsPatchArtifact(options.prompt)) {
            // The patch final/continuation text: the first patch's +/- and the
            // stale second patch's version_conflict decide the outcome.
            response = patchArtifactFinalText(options.prompt);
          }
          else if (wantsRunScript(options.prompt)) {
            // The script-run final/continuation text: the execute result
            // decides (a denied approval reads as a failure, never a success).
            response = runScriptFinalText(options.prompt);
          }
          else if (wantsSkillRead(options.prompt)) {
            // The skill-read final/continuation text: the execute result
            // decides (a missing skill/file reads as a failure, never a success).
            response = skillReadFinalText(options.prompt);
          }
          else if (wantsBoard(options.prompt)) {
            // The board flow's final/continuation text: the claim + complete
            // tool results decide the outcome (never a neutral rewrite).
            response = boardFinalText(options.prompt);
          }
          else if (wantsBrowser(options.prompt)) {
            // The browser flow's final text is the REAL outcome of the last
            // execute; the continuation (tool history stripped) re-emits the
            // exact prior final so the loop ends on the text-only step.
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && /\[demo model\] Browser tool/.test(p2.text ?? ""));
            response = prior?.text ?? browserFinalText(options.prompt);
          }
          else if (wantsEveryTab(options.prompt)) {
            // The every-tab loop's final text counts what was REALLY read; a
            // continuation re-emits the prior final so the loop ends.
            response = everyTabFinalText(options.prompt);
          }
          else if (wantsMcp(options.prompt)) {
            // The MCP flow's final text is the REAL outcome of the last execute
            // (the fenced result / a denial); a continuation re-emits the exact
            // prior final so the loop ends on the text-only step.
            const prior = runSlice(options.prompt)
              .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
              .flatMap((m) => m.content)
              .find((p2) => p2?.type === "text" && /\[demo model\] MCP tool/.test(p2.text ?? ""));
            response = prior?.text ?? mcpFinalText(options.prompt);
          }
          else if (wantsTools && (toolResultCount(options.prompt) >= (wantsDemoToolsX2(options.prompt) ? 12 : 6) || demoAlreadyFinal(options.prompt))) {            // STEP 4 (tools): the final summary — the reads' VALUES speak for
            // themselves (the run's tool results are the assertion target). The
            // continuation step (tool history stripped) re-emits the same
            // summary, so the loop ends on the text-only step.
            // The reply to agent-do's continuation nudge is DISTINCT from the
            // answer — exactly what a real model does ("Task complete…") — so
            // the transcript journey can prove the nudge reply never replaces
            // the answer (CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01).
            response = demoAlreadyFinal(options.prompt)
              ? "[demo model] Task complete — nothing more to do."
              : "[demo model] Tool calls executed in sequence: memory_set wrote the shopping list, then memory_get read it back twice.";
          } else if (wantsStream(options.prompt)) {
            response = DEMO_STREAM_ANSWER;
          } else if (wantsLongAnswer(options.prompt)) {
            // A deterministic answer ABOVE the long-response collapse
            // threshold: the journey can expand it and assert the FULL text is
            // present in the DOM (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01).
            response = "[demo model] Long answer. " + Array.from({ length: 300 }, (_, i) =>
              `Line ${i + 1}: the complete agent response must stay readable in the task view — this text is repeated so the response comfortably exceeds the collapse threshold. `
            ).join("");
          } else {
            response = `[demo model] Task received (${text.length} chars). Configure a real provider in Settings ` +
              `to get real completions. This demo response proves the agent loop runs end-to-end.`;
          }
          controller.enqueue({ type: "text-start", id });
          const chunks = response.match(/.{1,24}/g) ?? [response];
          if (wantsStream(options.prompt)) {
            // Paced delivery: each chunk lands in its own macrotask so the
            // transcript can grow visibly (and abort cuts the stream short).
            (async () => {
              try {
                for (const chunk of chunks) {
                  await abortableDelay(DEMO_STREAM_CHUNK_MS, options.abortSignal);
                  controller.enqueue({ type: "text-delta", id, delta: chunk });
                }
                controller.enqueue({ type: "text-end", id });
                controller.enqueue({ type: "finish", usage, finishReason: "stop" });
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            })();
            return;
          }
          for (const chunk of chunks) {
            controller.enqueue({ type: "text-delta", id, delta: chunk });
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({ type: "finish", usage, finishReason: "stop" });
          controller.close();
        },
      });
      return Promise.resolve({ stream });
    },
  };
}

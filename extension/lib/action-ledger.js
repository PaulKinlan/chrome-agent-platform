// extension/lib/action-ledger.js — the pure "what I did" action-ledger core
// (CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01).
//
// A ledger row is a plain-language record of ONE mutating tool call, plus the
// tool call that REVERSES it when one exists. It answers the owner's question
// "what did the agent just do, and can I take it back?" — the hub and the side
// panel render these rows with an Undo button for the reversible ones.
//
// This module is PURE and has no Chrome/OPFS dependency: `ledgerRowFor` shapes a
// row from a tool name, its arguments, its result, and any extra context the
// caller gathered (e.g. the recently-closed session list captured immediately
// after a close). The service worker owns the impure parts — capturing that
// extra context, persisting the row, and executing an inverse under the same
// grant/approval checks the original went through.

import { chromeToolCapability } from "./chrome-tool-capabilities.js";

// A bounded, stable digest of the tool arguments — enough to tell two calls of
// the same tool apart in the ledger without storing an unbounded blob. Keys are
// sorted so the digest is deterministic; the whole thing is length-capped.
export function digestArgs(args) {
  if (!args || typeof args !== "object") return "";
  try {
    const keys = Object.keys(args).sort();
    const parts = [];
    for (const k of keys) {
      let v = args[k];
      if (v && typeof v === "object") {
        try {
          v = JSON.stringify(v);
        } catch {
          v = "[object]";
        }
      }
      parts.push(`${k}=${String(v)}`);
    }
    return parts.join(" ").slice(0, 160);
  } catch {
    return "";
  }
}

// A failed tool call never becomes a ledger row — the agent did not change
// anything, so there is nothing to record or reverse.
function succeeded(result) {
  if (result == null) return false;
  if (typeof result !== "object") return true;
  if (result.error) return false;
  if (result.ok === false) return false;
  return true;
}

function hostOf(url) {
  try {
    return new URL(String(url)).host || String(url);
  } catch {
    return String(url ?? "");
  }
}

function tabWord(n) {
  return n === 1 ? "tab" : "tabs";
}

// `chromeToolCapability` THROWS on an unknown identity rather than returning
// null, so wrap it — a tool with no capability record is simply not classified
// (treated as non-ledgerable), never a thrown error on the tool hot path.
function mutationClassOf(name) {
  for (const source of ["chrome-api", "management"]) {
    try {
      return chromeToolCapability(name, source).mutationClass;
    } catch {
      /* not in this source's table — try the next */
    }
  }
  return null;
}

// The inverse table, keyed by tool name. Each builder returns
// `{ sentence, inverse }` where `inverse` is `{ tool, args }` (the reversing
// call) or `null` when the action cannot be reversed. Builders read from the
// tool RESULT first (the committed truth) and fall back to the ARGS, and take
// the reversal handle (a session id, a fresh tab id, a bookmark id) from
// whichever of the result/extra carries it.
const INVERSE_BUILDERS = Object.freeze({
  close_tab(args, result, extra) {
    const recent = Array.isArray(extra?.recentlyClosed) ? extra.recentlyClosed[0] : null;
    const title = result?.closed?.title || recent?.title || "a tab";
    const sessionId = result?.closed?.sessionId || recent?.sessionId || null;
    return {
      sentence: `Closed ${title}`,
      inverse: sessionId ? { tool: "restore_closed", args: { sessionId } } : null,
    };
  },
  open_tab(args, result) {
    const url = result?.url || args?.url || "";
    const tabId = result?.tabId;
    return {
      sentence: `Opened ${hostOf(url)}`,
      inverse: tabId != null ? { tool: "close_tab", args: { tabId } } : null,
    };
  },
  group_tabs(args, result) {
    const tabIds = Array.isArray(result?.tabIds)
      ? result.tabIds
      : Array.isArray(args?.tabIds)
        ? args.tabIds
        : [];
    const n = tabIds.length;
    return {
      sentence: `Grouped ${n} ${tabWord(n)}`,
      inverse: n > 0 ? { tool: "ungroup_tabs", args: { tabIds } } : null,
    };
  },
  ungroup_tabs(args, result) {
    const tabIds = Array.isArray(result?.tabIds)
      ? result.tabIds
      : Array.isArray(args?.tabIds)
        ? args.tabIds
        : [];
    const n = tabIds.length;
    return {
      sentence: `Ungrouped ${n} ${tabWord(n)}`,
      inverse: n > 0 ? { tool: "group_tabs", args: { tabIds } } : null,
    };
  },
  create_bookmark(args, result) {
    const title = result?.title || args?.title || "a page";
    const id = result?.id ?? null;
    return {
      sentence: `Bookmarked ${title}`,
      inverse: id ? { tool: "remove_bookmark", args: { id } } : null,
    };
  },
  remove_bookmark() {
    // A removed bookmark cannot be restored from the bookmarks API (there is no
    // "recently removed bookmarks" the way there is for tabs), so this is a
    // mutating action that is honestly NOT reversible.
    return { sentence: "Removed a bookmark", inverse: null };
  },
  create_named_agent(args, result) {
    // Creating a teammate is reversible by deleting it (id from the created
    // record). A management inverse in the same spirit as the browser pairs.
    const id = result?.agent?.id || result?.id || null;
    const name = result?.agent?.name || args?.name || "an agent";
    return {
      sentence: `Created the agent ${name}`,
      inverse: id ? { tool: "delete_named_agent", args: { id } } : null,
    };
  },
});

// A human sentence for a mutating tool that has no dedicated builder — honest
// and bounded, never a raw object dump. "navigate_tab" → "Navigated a tab".
function genericSentence(toolName) {
  const words = String(toolName).replace(/_/g, " ").trim();
  if (!words) return "Ran a tool";
  const verb = words.split(" ")[0];
  const rest = words.slice(verb.length).trim();
  const ed = verb.endsWith("e") ? `${verb}d` : `${verb}ed`;
  const cap = ed.charAt(0).toUpperCase() + ed.slice(1);
  return rest ? `${cap} ${rest}` : cap;
}

/**
 * Build a ledger row for one tool call, or `null` when the call should not be
 * logged (a read-only tool, or a failed mutation).
 *
 * @param {string} toolName
 * @param {object} args      the tool's input arguments
 * @param {object} result    the tool's return value
 * @param {object} [extra]   caller-gathered context (e.g. `{ recentlyClosed }`)
 * @returns {{ tool:string, sentence:string, argsDigest:string, inverse:({tool:string,args:object}|null) } | null}
 */
export function ledgerRowFor(toolName, args, result, extra = {}) {
  const name = String(toolName ?? "");
  if (!name) return null;
  if (!succeeded(result)) return null;
  const a = args && typeof args === "object" ? args : {};
  const argsDigest = digestArgs(a);
  const builder = INVERSE_BUILDERS[name];
  if (builder) {
    const { sentence, inverse } = builder(a, result ?? {}, extra ?? {});
    return { tool: name, sentence, argsDigest, inverse: inverse ?? null };
  }
  // No dedicated builder: log it only if the capability table classifies it as
  // a MUTATION (a read-only tool leaves nothing to undo and is not ledger
  // material). Such a row carries a sentence but never an inverse.
  if (mutationClassOf(name) === "mutating") {
    return { tool: name, sentence: genericSentence(name), argsDigest, inverse: null };
  }
  return null;
}

// Whether a tool call would produce a ledger row at all (a mutation, succeeded).
// The SW uses this to avoid the extra bookkeeping (e.g. the recently-closed
// capture after a close) for read-only calls.
export function isLedgerableTool(toolName) {
  const name = String(toolName ?? "");
  if (!name) return false;
  if (INVERSE_BUILDERS[name]) return true;
  return mutationClassOf(name) === "mutating";
}

// The maximum number of rows the ledger retains (bounded like every other
// on-profile store — the UI shows the most recent handful).
export const ACTION_LEDGER_MAX_ROWS = 100;

// Append a row to a bounded ledger array (most-recent LAST), returning a new
// array. Pure so the store layer and the tests share the same bound semantics.
export function appendLedgerRow(rows, row, max = ACTION_LEDGER_MAX_ROWS) {
  const list = Array.isArray(rows) ? rows : [];
  const next = [...list, row];
  return next.length > max ? next.slice(next.length - max) : next;
}

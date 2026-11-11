// scripts/lib/tier-ledger.mjs — chrome-agent-platform-1lvay (d), the TIER LEDGER.
//
// THE DEFECT THIS EXISTS FOR: a landing's gate executes one population of suites and silently omits
// the rest, so "FULL" reads as "everything ran". That is how main stayed red in a deferred tier for
// days while every landing certified green — and how 85 scripts sat in scripts/lib/harness-registry.ts
// with nothing executing them and nothing saying so. The fix is not to run everything (the mega heavy
// suites cost 2310s between them, 6.4x the whole gate): it is to STATE, per population, whether it ran
// at this tree, and — when it did not — which tree last did and how stale that is.
//
// coord's ruling on the wording (2026-11-11): a receipt must say
//   heavy-mega: NOT RUN at this sha (last green <sha> <age>h)
// not "deferred" — "deferred" reads like a scheduling note, and this is a gap. The same discipline
// applies to the KAT population, and NEVER-RUN is its own state: silence must never be reported as a
// pass, and an absent line must never be reported as coverage.
//
// Pure functions only (the record I/O lives in heavy-receipt.mjs beside the durable dir it uses), so the
// four states are pinned by test rather than by a live gate.

const HOUR_MS = 3_600_000;

/**
 * Populations a landing's gate does NOT fully execute, declared in one place so no caller invents one.
 * `files` is filled by the caller from scripts/test-partition.mjs and the harness registry.
 */
export const TIER_IDS = Object.freeze(["heavy-parallel", "heavy-mega", "heavy-wall-clock", "kat-harnesses"]);

/** Human labels: short, and each one says what the population IS rather than naming a script. */
const TIER_LABELS = Object.freeze({
  "heavy-parallel": "per-landing heavy suites",
  "heavy-mega": "mega heavy suites",
  "heavy-wall-clock": "wall-clock NTP suite",
  "kat-harnesses": "kat/named browser harnesses",
});

/**
 * Parse `scripts/lib/harness-registry.ts` for every declared harness and its class.
 *
 * WHY A PARSER AND NOT AN IMPORT: the gate runs under NODE (scripts/run-tests.mjs) and the registry is
 * a .ts module, so it cannot be imported there. A generated JSON twin would be a SECOND source of truth
 * for the population whose invisibility is the bug. So this reads the text, and
 * tests/heavy-tier-ledger.test.ts imports the real .ts and asserts this parse produced exactly its
 * kat+named set — a parser that drifts reds on the next gate rather than silently under-counting.
 *
 * @param {string} text registry source
 * @returns {{ files: string[], classes: Record<string, string[]> }}
 */
export function parseHarnessRegistry(text) {
  const source = String(text ?? "");
  // Scope the scan to the HARNESSES literal. Without that, every `"name.ts": {…}` map in the file would
  // look like a registry entry — and a broad scan cannot tell a real entry it failed to parse from a key
  // that was never one, which is how a census under-counts and still reads as a pass.
  // Comments inside the literal document harnesses in prose (`// { "kat-x.ts": { exit, at } }`) and
  // carry braces; leaving them in makes the brace match close early and the census read short — which is
  // precisely the failure this parser now refuses to make quietly.
  const stripped = stripLineComments(source);
  const declared = /export const HARNESSES[^=]*=\s*\{/.exec(stripped);
  if (!declared) {
    throw new Error("tier ledger: cannot find the HARNESSES registry literal — refusing to report a population of 0");
  }
  const bodyStart = declared.index + declared[0].length;
  const body = stripped.slice(bodyStart);
  const closeAt = matchingBrace(body);
  if (closeAt < 0) throw new Error("tier ledger: HARNESSES literal is unbalanced — refusing to guess its contents");
  const lines = body.slice(0, closeAt).split("\n");
  const byClass = new Map();
  let entry = null; // { file, body, depth }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trimStart();
    // Comments describe entries but are not entries (e.g. the KAT cache documented in prose) — counting
    // one would invent a population; skipping a real one would under-count it. Only code lines count.
    if (!entry && (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))) continue;
    if (!entry) {
      const start = /^\s*"([A-Za-z0-9_.\-/]+\.ts)"\s*:\s*\{/.exec(line);
      if (!start) continue;
      entry = { file: start[1], body: line.slice(line.indexOf("{")), depth: 0 };
    } else {
      entry.body += `\n${line}`;
    }
    // Brace depth outside string literals: `reason` text legitimately contains `{missing:true}` and
    // `{ok:false,error}`, and a naive [^{}]* body drops exactly those entries (measured: 3 kat + 1 named
    // were silently lost that way, which is the under-count this ledger exists to prevent).
    let inString = false;
    let quote = "";
    for (const ch of line) {
      if (inString) {
        if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inString = true; quote = ch; continue; }
      if (ch === "{") entry.depth += 1;
      else if (ch === "}") entry.depth -= 1;
    }
    if (entry.depth <= 0) {
      const cls = /\bclass:\s*"([a-z-]+)"/.exec(entry.body)?.[1];
      if (!cls) {
        // FAIL LOUDLY. Dropping an entry we could not classify is exactly how a census reports a
        // population that is missing members while still looking green — the defect this bead is about,
        // one level down. A registry entry with no readable class is a parse failure, not an absence.
        throw new Error(
          `tier ledger: registry entry ${JSON.stringify(entry.file)} declares no readable class — ` +
            `refusing to under-count the population by skipping it`,
        );
      }
      if (!byClass.has(cls)) byClass.set(cls, new Set());
      byClass.get(cls).add(entry.file);
      entry = null;
    }
  }
  const classes = {};
  for (const [cls, set] of [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0], "en"))) {
    classes[cls] = [...set].sort();
  }
  const files = Object.values(classes).flat().sort();
  return { files, classes };
}

/**
 * Index of the `}` that closes the object starting just before `text`, or -1. String-aware, because
 * `reason` text legitimately contains braces (`{missing:true}`, `{ok:false,error}`).
 * @param {string} text
 * @returns {number}
 */
/**
 * Remove `//` comments and everything after them, per line, without touching string contents.
 * @param {string} text
 * @returns {string}
 */
function stripLineComments(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    let inString = false;
    let quote = "";
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inString) {
        if (ch === "\\") { i += 1; continue; }
        if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inString = true; quote = ch; continue; }
      if (ch === "/" && line[i + 1] === "/") { cut = i; break; }
    }
    out.push(line.slice(0, cut));
  }
  return out.join("\n");
}

function matchingBrace(text) {
  let depth = 1;
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = true; quote = ch; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The population a landing's gate never runs: registry classes `kat` and `named`. */
export const UNRUN_HARNESS_CLASSES = Object.freeze(["kat", "named"]);

/** @param {{ files: string[], classes: Record<string, string[]> }} parsed */
export function unrunHarnesses(parsed) {
  const out = [];
  for (const cls of UNRUN_HARNESS_CLASSES) out.push(...(parsed.classes?.[cls] ?? []));
  return [...new Set(out)].sort();
}

/**
 * One ledger entry per population. Status is DERIVED from the record, never assumed:
 *   "ran"       the record's sha is this tree's sha and it passed
 *   "failed"    the record is this tree's (or any tree) and it FAILED — a real red, stated as one
 *   "stale"     a record exists for another tree: name it and its age
 *   "never-run" no record at all — stated as never-run, because absence is the defect being fixed
 *
 * @param {{ id: string, files: string[], record?: {sha?: string, result?: string, at?: number|string}|null, sha?: string|null, now?: number }} args
 */
export function tierEntry({ id, files = [], record = null, sha = null, now = Date.now() }) {
  const at = record && Number.isFinite(Number(record.at)) ? Number(record.at) : null;
  const ageH = at === null ? null : Math.max(0, Math.round(((now - at) / HOUR_MS) * 10) / 10);
  const lastSha = record?.sha ? String(record.sha) : null;
  const shortSha = lastSha ? lastSha.slice(0, 9) : null;
  const result = record?.result ? String(record.result).toUpperCase() : null;
  const sameTree = Boolean(sha && lastSha && (lastSha === String(sha) || lastSha.startsWith(String(sha)) || String(sha).startsWith(lastSha.slice(0, 9))));
  const label = TIER_LABELS[id] ?? id;
  const base = { id, label, files: [...files], count: files.length };
  if (sameTree && result === "PASS") {
    return { ...base, status: "ran", last_sha: lastSha, last_result: result, age_h: ageH, line: `${id}: ran at this sha (PASS${ageH === null ? "" : `, ${ageH}h ago`})` };
  }
  if (sameTree && result && result !== "PASS") {
    return { ...base, status: "failed", last_sha: lastSha, last_result: result, age_h: ageH, line: `${id}: ran at this sha (${result}${ageH === null ? "" : `, ${ageH}h ago`}) — this is a RED, not a gap` };
  }
  if (!record) {
    // "no sweep has reported HERE" is the true statement: the record lives in the VM's durable evidence
    // dir (cap-evidence), which every worktree on this VM shares and no other VM sees. Saying a flat
    // "never run" would be a claim about the project's whole history that this store cannot support —
    // the same class of over-claim as reading an absent changelog ledger as a pass.
    return {
      ...base,
      status: "never-run",
      last_sha: null,
      last_result: null,
      age_h: null,
      line: `${id}: NOT RUN at this sha (never run on this VM — no sweep has reported a result for these ${files.length} ${label}; the record lives in cap-evidence/heavy-receipts/tiers)`,
    };
  }
  const when = ageH === null ? "at an unrecorded time" : `${ageH}h ago`;
  const stale = result === "PASS" ? `last green ${shortSha} ${when}` : `last run ${shortSha} ${String(result ?? "UNKNOWN")} ${when}`;
  return {
    ...base,
    status: result === "PASS" ? "stale" : "failed",
    last_sha: lastSha,
    last_result: result,
    age_h: ageH,
    line: `${id}: NOT RUN at this sha (${stale})`,
  };
}

/**
 * The ledger as the receipt carries it: one entry per population, in TIER_IDS order, plus the payload a
 * consumer reads without parsing prose.
 *
 * @param {{ files?: Record<string, string[]>, records?: Record<string, object|null>, sha?: string|null, now?: number }} args
 */
export function buildTierLedger({ files = {}, records = {}, sha = null, now = Date.now() } = {}) {
  const entries = TIER_IDS.map((id) => tierEntry({ id, files: files[id] ?? [], record: records[id] ?? null, sha, now }));
  return {
    entries,
    lines: entries.map((entry) => entry.line),
    payload: Object.fromEntries(entries.map((entry) => [entry.id.replace(/-/g, "_"), {
      ran: entry.status === "ran",
      status: entry.status,
      count: entry.count,
      last_sha: entry.last_sha,
      last_result: entry.last_result,
      age_h: entry.age_h,
    }])),
  };
}

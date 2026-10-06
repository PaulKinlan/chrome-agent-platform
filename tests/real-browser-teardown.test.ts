// tests/real-browser-teardown.test.ts — chrome-agent-platform-jixr (successor).
//
// A real-browser TEST must reap the WHOLE Chromium process tree, not just the
// parent proc. Killing only `launched.proc` leaves the zygote/renderer/GPU
// children reparented to init (PPID=1); the fleet reaper then sees an
// "orphaned browser" and kills the whole gate tree. jixr (73a3f366) fixed the
// 12 in-file launch sites; its successor found the remaining leakers OUTSIDE
// those files: two real-browser HARNESSES that parallel-phase tests spawn
// (`scripts/kat-bgagent-delete.ts`, `scripts/kat-site-delegation-attachments.ts`)
// which tore down with a bare `proc.kill()`.
//
// Each real launch in the discovered tests and spawned harnesses must have its
// OWN tree teardown. A sibling launch's teardown cannot excuse a partial
// revert. A bare proc.kill() (parent-only) proves no launch safe.
// This source guard associates launch bindings with teardown calls; it cannot
// prove that every runtime exit path reaches the call (that remains a review
// and browser-gate concern).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Preserve offsets and newlines so a failure can name the ORIGINAL launch
// line. Strings, regexes, comments and template fixture text are never code.
// A template interpolation is conservatively masked too; do not put real
// launchChrome calls inside interpolations without extending this scanner.
function codeOnly(src: string): string {
  const out = src.split("");
  const blank = (i: number) => { if (src[i] !== "\n" && src[i] !== "\r") out[i] = " "; };
  let state: "code" | "line" | "block" | "quote" | "template" | "regex" = "code";
  let quote = "";
  let inClass = false;
  let regexAt = -1;
  let last = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { blank(i); blank(++i); state = "line"; continue; }
      if (ch === "/" && next === "*") { blank(i); blank(++i); state = "block"; continue; }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch; state = ch === "`" ? "template" : "quote"; blank(i); last = "value"; continue;
      }
      if (ch === "/" && /[=(,;:!&|?+*%\^~<>{\[]/.test(last)) {
        state = "regex"; regexAt = i; inClass = false; blank(i); continue;
      }
      if (!/\s/.test(ch)) last = ch;
      continue;
    }
    if (state === "line") { if (ch === "\n") state = "code"; else blank(i); continue; }
    if (state === "block") {
      if (ch === "*" && next === "/") { blank(i); blank(++i); state = "code"; }
      else blank(i);
      continue;
    }
    if (ch === "\\") { blank(i); if (i + 1 < src.length) blank(++i); continue; }
    if (state === "regex") {
      if (ch === "[") inClass = true;
      if (ch === "]") inClass = false;
      if (ch === "/" && !inClass) state = "code";
    } else if (ch === quote) state = "code";
    blank(i);
  }
  if (state === "block" || state === "quote" || state === "template" || state === "regex") {
    throw new Error(`unclosed source literal/comment (${state}) at line ${lineAt(src, regexAt)}: ${JSON.stringify(src.slice(regexAt, regexAt + 75))}; cannot prove Chrome teardown`);
  }
  return out.join("");
}

const lineAt = (src: string, at: number) => 1 + (src.slice(0, at).match(/\n/g)?.length ?? 0);
const ident = /^[A-Za-z_$][\w$]*$/;

type Site = { start: number; end: number; line: number; binding: string; args: string };
type Teardown = { start: number; target: string; kind: string; args: string[] };

/** Find the matching close delimiter in code with strings already blanked. */
function closing(code: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === left) depth++;
    else if (code[i] === right && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${left}${right} at line ${lineAt(code, open)}`);
}

function launchSites(src: string, code = codeOnly(src)): Site[] {
  const sites: Site[] = [];
  for (const m of code.matchAll(/\blaunchChrome\s*\(\s*\{/g)) {
    const from = code.indexOf("{", m.index!);
    const end = closing(code, from, "{", "}");
    const tail = code.slice(end + 1).match(/^\s*\)/);
    if (!tail) throw new Error(`launchChrome at line ${lineAt(code, m.index!)} has no closing parenthesis`);
    const prefix = code.slice(Math.max(0, m.index! - 160), m.index!);
    const variable = prefix.match(/\b([A-Za-z_$][\w$]*)\s*=\s*await\s*$/)?.[1];
    const destructured = prefix.match(/\{([^{}]+)\}\s*=\s*await\s*$/)?.[1];
    const binding = variable ?? destructured?.match(/\bproc\b/)?.[0] ?? "";
    sites.push({ start: m.index!, end: end + 1 + tail[0].length, line: lineAt(code, m.index!), binding,
      args: src.slice(from, end + 1) });
  }
  return sites;
}

function topLevelArgs(code: string): string[] {
  const args: string[] = [];
  let from = 0, depth = 0;
  for (let i = 0; i < code.length; i++) {
    if ("({[".includes(code[i])) depth++;
    else if (")}]".includes(code[i])) depth--;
    else if (code[i] === "," && depth === 0) { args.push(code.slice(from, i).trim()); from = i + 1; }
  }
  args.push(code.slice(from).trim());
  return args;
}

function teardownSites(code: string): Teardown[] {
  const sites: Teardown[] = [];
  for (const m of code.matchAll(/\b(teardownChrome|closeChrome|killProcessTree)\s*\(/g)) {
    const open = code.indexOf("(", m.index!);
    const args = topLevelArgs(code.slice(open + 1, closing(code, open, "(", ")")));
    const first = args[0];
    const target = first.match(/^([A-Za-z_$][\w$]*)(?:\.proc)?$/)?.[1]
      ?? (/^\{[\s\S]*\bproc\s*[:,}]/.test(first) && /\b(?:profile|processGroup)\s*[:,}]/.test(first) ? "proc" : "");
    if (!target) continue; // a null, dynamic or unbound target cannot prove a launch
    const hasProfile = first.trim().startsWith("{") || (args.length > 1 &&
      !!args[1] && !/^(?:null|undefined)$/.test(args[1]) && !/\bchromeProfileDir\s*\(/.test(args[1]));
    if (args[0].endsWith(".proc") || target === "proc") {
      if (!hasProfile) continue; // teardownChrome(proc) is parent-only
    }
    sites.push({ start: m.index!, target, kind: m[1], args });
  }
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\.close\s*\(\s*\)/g)) {
    sites.push({ start: m.index!, target: m[1], kind: "launched.close", args: [] });
  }
  return sites.sort((a, b) => a.start - b.start);
}

/** Only a launch's own binding (or its proc alias) can discharge its teardown. */
function aliases(code: string, site: Site, end: number): Set<string> {
  const names = new Set([site.binding]);
  const region = code.slice(site.end, end);
  for (const name of [...names]) {
    const escaped = name.replace(/[$]/g, "\\$");
    for (const m of region.matchAll(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${escaped}\\b`, "g"))) {
      if (/\bproc\b/.test(m[1])) names.add("proc");
    }
    for (const m of region.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\.proc\\b`, "g"))) names.add(m[1]);
  }
  return names;
}

// A cleanup declared before a single launch is valid only when the local
// helper containing it is actually invoked after launch. This admits the
// ensureCleanup()/teardownTree() patterns without accepting a dead helper.
function prelaunchCleanupInvoked(code: string, teardownAt: number, afterLaunch: number): boolean {
  for (const m of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{}]+)?\s*\{/g)) {
    const open = code.indexOf("{", m.index!);
    if (m.index! > teardownAt || closing(code, open, "{", "}") < teardownAt) continue;
    const calls = new RegExp(`\\b${m[1]}\\s*\\(`);
    if (calls.test(code.slice(afterLaunch))) return true;
  }
  return false;
}

/** Source-level association, not a control-flow proof that finally always runs. */
function unguardedLaunches(src: string, rel = "<fixture>"): string[] {
  if (!src.includes("launchChrome")) return [];
  let code: string;
  try { code = codeOnly(src); }
  catch (e) { throw new Error(`${rel}: ${(e as Error).message}`); }
  const sites = launchSites(src, code).filter((s) => !/\bbinary\s*:\s*(?:fake\b|["']\/bin\/(?:true|false)["'])/.test(s.args));
  const teardowns = teardownSites(code);
  return sites.flatMap((site, i) => {
    // Distinct launch sites cannot borrow a sibling's teardown. Single-site
    // harnesses may define their cleanup helper before launchChrome.
    const end = sites.length === 1 ? code.length : (sites[i + 1]?.start ?? code.length);
    const start = sites.length === 1 ? 0 : site.end;
    const owned = aliases(code, site, end);
    const matched = site.binding && teardowns.some((t) => t.start >= start && t.start < end &&
      owned.has(t.target) && (t.start >= site.end || prelaunchCleanupInvoked(code, t.start, site.end)));
    return matched ? [] : [`${rel}:${site.line} (${site.binding || "unbound"}: no associated process-tree teardown)`];
  });
}

async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) out.push(`tests/${entry.name}`);
  }
  return out.sort();
}

Deno.test("jixr: every real-browser test tears down its whole tree with a profile", async () => {
  const offenders: string[] = [];
  for (const rel of await testFiles()) {
    offenders.push(...unguardedLaunches(await Deno.readTextFile(`${ROOT}${rel}`), rel));
  }
  assertEquals(
    offenders,
    [],
    "each real-browser launch must own a tree teardown (a bare proc.kill() orphans it):\n" +
      offenders.join("\n"),
  );
});

// The harnesses a test spawns that launch a real browser.
// Each must reap the tree via the shared helper, carrying its profile. A revert
// to `proc.kill()` here is exactly the orphan the reaper killed the gate for.
const SPAWNED_REAL_BROWSER_HARNESSES = [
  "scripts/agent-provider-picker.ts",
  "scripts/kat-bgagent-delete.ts",
  "scripts/kat-site-delegation-attachments.ts",
];

Deno.test("jixr: every test-spawned real-browser harness tears down its whole tree with a profile", async () => {
  const offenders: string[] = [];
  for (const rel of SPAWNED_REAL_BROWSER_HARNESSES) {
    const source = await Deno.readTextFile(`${ROOT}${rel}`);
    assert(launchSites(source).length > 0, `${rel} must launch a real browser (the pin targets a real leak)`);
    offenders.push(...unguardedLaunches(source, rel));
  }
  assertEquals(
    offenders,
    [],
    "each test-spawned harness launch must own a process-tree teardown:\n" + offenders.join("\n"),
  );
});

async function katHarnessFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}scripts`)) {
    if (entry.isFile && entry.name.startsWith("kat-") && entry.name.endsWith(".ts") && entry.name !== "kat-runner.ts") {
      out.push(`scripts/${entry.name}`);
    }
  }
  return out.sort();
}

Deno.test("elst: every test:kat real-browser harness tears down its whole tree with a profile", async () => {
  const offenders: string[] = [];
  const kats = await katHarnessFiles();
  assert(kats.length > 50, `must discover the test:kat harness suite (found ${kats.length})`);
  for (const rel of kats) {
    offenders.push(...unguardedLaunches(await Deno.readTextFile(`${ROOT}${rel}`), rel));
  }
  assertEquals(
    offenders,
    [],
    "each test:kat launch must own a process-tree teardown (not bare proc.kill):\n" +
      offenders.join("\n"),
  );
});

Deno.test("elst: falsification — dropping teardownChrome or using bare proc.kill turns the guard RED", () => {
  // Mutant A: a launch with a bare proc.kill() and no profile teardown
  const mutantBareKill = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { proc.kill(); }
  `;
  assertEquals(unguardedLaunches(mutantBareKill, "bare-kill").length, 1,
    "Mutant A with bare proc.kill() must FAIL teardown check");

  // Mutant B: a launch with no teardown at all
  const mutantNoTeardown = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    doWork();
  `;
  assertEquals(unguardedLaunches(mutantNoTeardown, "missing").length, 1,
    "Mutant B with no teardown must FAIL teardown check");

  // Mutant C: teardownChrome called without a profile (parent-only single-arg form)
  const mutantNoProfile = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await teardownChrome(proc); }
  `;
  assertEquals(unguardedLaunches(mutantNoProfile, "parent-only").length, 1,
    "Mutant C without profile must FAIL teardown check");

  // Compliant: real compliant teardown passes
  const compliant = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium", profile });
    try { doWork(); } finally { await teardownChrome(proc, profile); }
  `;
  assertEquals(unguardedLaunches(compliant), [], "Compliant code must PASS teardown check");

  const objectForm = `const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await teardownChrome({ proc, profile, processGroup }); }`;
  assertEquals(unguardedLaunches(objectForm), [], "object-form teardown with profile/group is valid");
  const launchedClose = `const renamed = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await renamed.close(); }`;
  assertEquals(unguardedLaunches(launchedClose), [], "the bound launch result's close() is valid");
  const direct = `const browser = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await teardownChrome(browser); }`;
  assertEquals(unguardedLaunches(direct), [], "single-arg teardownChrome(launched) carries its profile");
  const alias = `const browser = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await closeChrome(browser); }`;
  assertEquals(unguardedLaunches(alias), [], "closeChrome(launched) is a supported alias");
  const helper = `let launched;
    async function cleanup() { await launched.close(); }
    launched = await launchChrome({ binary: "/usr/bin/chromium" });
    await cleanup();`;
  assertEquals(unguardedLaunches(helper), [], "predeclared cleanup invoked after launch is valid");
  assertEquals(unguardedLaunches(helper.replace("await cleanup();", "" )).length, 1,
    "an uncalled predeclared cleanup does not prove teardown");
  const unrelatedClose = `const launched = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await cdp.close(); }`;
  assertEquals(unguardedLaunches(unrelatedClose).length, 1, "an unrelated close() is not a Chrome teardown");
  const nullTarget = `const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await killProcessTree(null, marker); }`;
  assertEquals(unguardedLaunches(nullTarget).length, 1, "null is not a launch target");
});

Deno.test("8ue3: removing either teardown in a multi-launch file names ONLY the unguarded site", async () => {
  for (const [rel, count] of [
    ["tests/agent-header-rename-reload.test.ts", 2],
    ["tests/settings-focus-and-diag-badge-716s13.test.ts", 2],
    ["scripts/kat-sandbox-egress.ts", 3],
  ] as const) {
    const src = await Deno.readTextFile(`${ROOT}${rel}`);
    const sites = launchSites(src).filter((s) => !/\bbinary\s*:\s*(?:fake\b|["']\/bin\/(?:true|false)["'])/.test(s.args));
    const cleanup = [...src.matchAll(/await teardownChrome\((?:launched|chrome|proc), profile\);/g)];
    assertEquals(sites.length, count, `${rel} must retain the real launch population`);
    assertEquals(cleanup.length, count, `${rel} must have one physical cleanup per launch`);
    assertEquals(unguardedLaunches(src, rel), [], `${rel} must be green before the mutation`);
    for (let i = 0; i < count; i++) {
      const at = cleanup[i].index!;
      const mutant = src.slice(0, at) + " ".repeat(cleanup[i][0].length) + src.slice(at + cleanup[i][0].length);
      const offenders = unguardedLaunches(mutant, rel);
      assertEquals(offenders.length, 1, `${rel}: removing cleanup ${i + 1} must fail one launch`);
      assert(offenders[0].startsWith(`${rel}:${sites[i].line} `),
        `${rel}: partial revert must name the launch at line ${sites[i].line}, got ${offenders[0]}`);
    }
  }
});

Deno.test("8ue3: guard fixtures are not executable Chrome launches or teardown evidence", async () => {
  const src = await Deno.readTextFile(`${ROOT}tests/real-browser-teardown.test.ts`);
  const code = codeOnly(src);
  assertEquals(launchSites(src, code).length, 0, "template fixture launchChrome calls must be masked");
  assertEquals(teardownSites(code).length, 0, "template fixture teardowns must be masked");
});

Deno.test("elst: REAL-TREE falsification — a real kat-*.ts harness dropping teardown fails the guard", async () => {
  const probePath = `${ROOT}scripts/kat-__probe_unreaped_test.ts`;
  try {
    await Deno.writeTextFile(
      probePath,
      `// Temporary test probe\nimport { launchChrome } from "./lib/chrome-launch.ts";\nconst { proc } = await launchChrome({ binary: "/usr/bin/chromium" });\nproc.kill();\n`,
    );
    const files = await katHarnessFiles();
    assert(files.includes("scripts/kat-__probe_unreaped_test.ts"), "katHarnessFiles must discover the probe harness");
    const offenders = unguardedLaunches(await Deno.readTextFile(probePath), "scripts/kat-__probe_unreaped_test.ts");
    assertEquals(offenders.length, 1, "probe with bare proc.kill must FAIL teardown check");
    assert(offenders[0].startsWith("scripts/kat-__probe_unreaped_test.ts:"), "probe must be named by site");
  } finally {
    try { await Deno.remove(probePath); } catch { /* ignore */ }
  }
});

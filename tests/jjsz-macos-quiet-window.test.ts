// chrome-agent-platform-jjsz F6 — the quiet-window sampler's no-/proc (macOS) `ps` walk used to fail OPEN.
//
// On macOS readLoadSample walks `/bin/ps -axo pid=,time=,lstart=,comm=`. Three things were wrong:
//   1. `ps` inherited the caller's locale, and prints `lstart` in it (C: `Wed Oct  7 12:26:48 2026`, de_DE:
//      `Mi  7 Okt 12:26:48 2026`). The row regex reads the C shape, so on such a box EVERY row failed to
//      match and was silently dropped (`if (!m) continue`): compilers = 0, `measurable: true`, a "quiet"
//      verdict under a running build, the 1io9 defect class.
//   2. Rows the parser could not read were never counted, so even ONE builder in an unreadable row vanished.
//   3. `startedAt` was taken before the `ps` child ran, so a slow ps spent the 400 ms scan budget before a
//      single row was read.
// The contract pinned here: ps runs under `LC_ALL=C` + `TZ=UTC` (a cleared environment); any row the parser
// cannot read, or no readable row at all, is an UNMEASURABLE sample (never quiet); the scan clock starts
// after ps returns; truncation keeps precedence so the bounded retry still applies; ps failures stay
// unmeasurable. Every macOS-branch verdict is driven through the `hasProc` / `runPs` / `loadavg` / `budget`
// seams, so it runs on EVERY platform. The last test drives the REAL ps under a hostile locale.
import { assert, assertEquals, assertMatch, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  environmentLine,
  isQuiet,
  type LoadSampleDeps,
  type PsInvocation,
  type PsResult,
  quietReasons,
  readLoadSample,
  resolveSpec,
} from "../scripts/lib/quiet-window.ts";

// ---------------------------------------------------------------------------------------------
// A ps that renders `lstart` the way the REAL one does: in the locale and zone of the environment it is
// given. The caller's AMBIENT environment only reaches it when the spawn does not clear it.
// ---------------------------------------------------------------------------------------------

type Row = { pid: number; cpu?: string; comm: string };
type Ambient = { LC_ALL?: string; LANG?: string; TZ?: string };

const EPOCH_MS = Date.UTC(2026, 9, 7, 12, 26, 48); // Wed Oct 7 12:26:48 2026 UTC
const DOW_C = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_C = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MON_DE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function lstart(locale: string, zoneHours: number): string {
  const d = new Date(EPOCH_MS + zoneHours * 3_600_000);
  const dow = d.getUTCDay();
  const mon = d.getUTCMonth();
  const day = String(d.getUTCDate()).padStart(2);
  const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  if (locale.startsWith("de_DE")) return `${DOW_DE[dow]} ${day} ${MON_DE[mon]} ${hms} ${d.getUTCFullYear()}`;
  return `${DOW_C[dow]} ${MON_C[mon]} ${day} ${hms} ${d.getUTCFullYear()}`;
}

function fakePs(
  rows: Row[],
  opts: {
    ambient?: Ambient;
    machineZoneHours?: number;
    delayMs?: number;
    /** Render every row in this locale whatever the environment says. */
    forceLocale?: string;
    /** Lines appended verbatim after the rows. */
    extraLines?: string[];
    /** Replace the whole stdout. */
    raw?: string;
    code?: number;
  } = {},
) {
  const calls: PsInvocation[] = [];
  const runPs = async (invocation: PsInvocation): Promise<PsResult> => {
    calls.push(invocation);
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    if (opts.code !== undefined && opts.code !== 0) return { code: opts.code, stdout: "" };
    if (opts.raw !== undefined) return { code: 0, stdout: opts.raw };
    const effective: Ambient = invocation.clearEnv
      ? { ...invocation.env }
      : { ...(opts.ambient ?? {}), ...invocation.env };
    const locale = opts.forceLocale ?? effective.LC_ALL ?? effective.LANG ?? "C";
    const zone = effective.TZ === "UTC" ? 0 : effective.TZ ? 9 : opts.machineZoneHours ?? 1;
    const lines = rows.map((row) =>
      `${String(row.pid).padStart(5)} ${(row.cpu ?? "0:00.10").padStart(9)} ${lstart(locale, zone)} ${row.comm}`
    );
    return { code: 0, stdout: `${[...lines, ...(opts.extraLines ?? [])].join("\n")}\n` };
  };
  return { calls, runPs };
}

const CORES = Math.max(1, navigator.hardwareConcurrency || 1);
const SPEC = resolveSpec({ maxLoadPerCore: 0.35, maxCompilers: 1, maxWaitMs: 1000, sampleMs: 50, sustainedSamples: 1 });
const ordinary = (n: number, from = 100): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    pid: from + i,
    comm: i % 2 ? "/usr/sbin/cfprefsd" : "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
  }));
const COMPILERS: Row[] = [
  { pid: 9001, cpu: "1:02.03", comm: "/usr/bin/clang" },
  { pid: 9002, cpu: "0:45.10", comm: "/usr/bin/ld" },
  { pid: 9003, cpu: "3:00.00", comm: "/opt/homebrew/bin/ninja" },
];
const depsOf = (ps: { runPs: LoadSampleDeps["runPs"] }, extra: LoadSampleDeps = {}): LoadSampleDeps => ({
  hasProc: false,
  runPs: ps.runPs,
  loadavg: () => [0.1, 0.2, 0.3],
  budget: { entries: 4096, ms: 5000 },
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// What a healthy table looks like
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F6: a clean table of N rows is a measurable, quiet sample", async () => {
  const ps = fakePs([...ordinary(40), { pid: Deno.pid, comm: "/usr/bin/deno" }]);
  const sample = await readLoadSample(null, depsOf(ps));
  assertEquals(sample.measurable, true, String(sample.error));
  assertEquals(sample.error, undefined);
  assertEquals(sample.compilers, 0);
  assertEquals(sample.compilerNames, []);
  assertEquals(sample.activeCompilers, 0);
  assertEquals(sample.cpu?.size, 0);
  assertEquals([sample.load1, sample.load5, sample.load15], [0.1, 0.2, 0.3]);
  assertEquals(sample.loadPerCore, 0.1 / CORES);
  assertEquals(isQuiet(sample, SPEC), true);
  assertEquals(ps.calls.length, 1, "one ps per sample");
});

Deno.test("jjsz F6: a busy box (compiler rows) is measured, counted and NOT quiet", async () => {
  const ps = fakePs([...ordinary(30), ...COMPILERS]);
  const sample = await readLoadSample(null, depsOf(ps));
  assertEquals(sample.measurable, true, String(sample.error));
  assertEquals(sample.compilers, 3);
  assertEquals(sample.compilerNames, ["clang", "ld", "ninja"]);
  assertEquals(sample.activeCompilers, 3, "the first sample fails closed: every named builder counts as compiling");
  assertEquals([...(sample.cpu?.keys() ?? [])], ["9001", "9002", "9003"]);
  assertEquals(isQuiet(sample, SPEC), false);
  assertMatch(quietReasons(sample, SPEC).join("\n"), /active heavy-builders 3 > 1/u);
});

Deno.test("jjsz F6: builders that stop consuming CPU read as idle on the next sample, and advancing ones as active", async () => {
  const first = await readLoadSample(null, depsOf(fakePs([...ordinary(30), ...COMPILERS])));
  const idle = await readLoadSample(first.cpu, depsOf(fakePs([...ordinary(30), ...COMPILERS])));
  assertEquals(idle.measurable, true);
  assertEquals(idle.compilers, 3, "still named");
  assertEquals(idle.activeCompilers, 0, "no CPU advanced, so none is compiling");
  assertEquals(isQuiet(idle, SPEC), true);
  const busy = await readLoadSample(
    first.cpu,
    depsOf(fakePs([
      ...ordinary(30),
      { pid: 9001, cpu: "1:03.03", comm: "/usr/bin/clang" },
      { pid: 9002, cpu: "0:46.10", comm: "/usr/bin/ld" },
      { pid: 9003, cpu: "3:00.00", comm: "/opt/homebrew/bin/ninja" },
    ])),
  );
  assertEquals(busy.activeCompilers, 2, "two advanced");
  assertEquals(isQuiet(busy, SPEC), false);
});

// ---------------------------------------------------------------------------------------------
// The defect: rows that cannot be read
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F6: a table the parser cannot read (the de_DE shape) is UNMEASURABLE, never quiet", async () => {
  const ps = fakePs([...ordinary(30), ...COMPILERS], { forceLocale: "de_DE.UTF-8" });
  const sample = await readLoadSample(null, depsOf(ps));
  assertEquals(sample.measurable, false, "a table whose every row is dropped must not read as an empty, quiet box");
  assertMatch(String(sample.error), /ps printed 33 row\(s\) this parser cannot read \(0 parsed\)/u);
  assertStringIncludes(String(sample.error), "NOT a quiet verdict");
  assertEquals(String(sample.error).includes("truncated"), false, "an unreadable table is not a truncated walk");
  assertEquals(sample.compilers, 0, "the builders were invisible to the walk: exactly why the count cannot be trusted");
  assertEquals(isQuiet(sample, SPEC), false);
  assertMatch(quietReasons(sample, SPEC)[0], /^unmeasurable: /u);
  assertStringIncludes(environmentLine(sample), "unmeasurable");
  assertEquals(ps.calls.length, 1, "re-reading the same bytes cannot help, so there is no retry");
});

Deno.test("jjsz F6: ONE unreadable row among readable ones makes the sample unmeasurable", async (t) => {
  const readable = [...ordinary(30), ...COMPILERS];
  const cases: Array<[string, string]> = [
    ["a line that is not a ps row at all", "  777  0:00.01 garbage that is not a ps row"],
    [
      "a compiler row in a shifted-locale shape is NOT silently dropped",
      "  778  0:09.99 Mi  7 Okt 12:26:48 2026 /usr/bin/clang",
    ],
    ["a row cut off before its command", "  779  0:00.01 Wed Oct  7 12:26:48 2026"],
  ];
  for (const [name, bad] of cases) {
    await t.step(name, async () => {
      const ps = fakePs(readable, { extraLines: [bad] });
      const sample = await readLoadSample(null, depsOf(ps));
      assertEquals(sample.measurable, false);
      assertMatch(String(sample.error), /ps printed 1 row\(s\) this parser cannot read \(33 parsed\)/u);
      assertEquals(sample.compilers, 3, "what the walk DID see stays as evidence");
      assertEquals(isQuiet(sample, SPEC), false);
      assertEquals(ps.calls.length, 1, "no retry for an unreadable table");
    });
  }
});

Deno.test("jjsz F6: a ps that prints no rows at all is unmeasurable (nothing parsed)", async (t) => {
  for (const [name, raw] of [["empty stdout", ""], ["only blank lines", "\n\n   \n"]] as const) {
    await t.step(name, async () => {
      const sample = await readLoadSample(null, depsOf(fakePs([], { raw })));
      assertEquals(sample.measurable, false);
      assertStringIncludes(String(sample.error), "ps printed no process rows");
      assertStringIncludes(String(sample.error), "NOT a quiet verdict");
      assertEquals(isQuiet(sample, SPEC), false);
    });
  }
});

Deno.test("jjsz F6: a table holding only our own row is a quiet box, not an unreadable one", async () => {
  const sample = await readLoadSample(null, depsOf(fakePs([{ pid: Deno.pid, comm: "/usr/bin/deno" }])));
  assertEquals(sample.measurable, true, String(sample.error));
  assertEquals(sample.compilers, 0);
  assertEquals(isQuiet(sample, SPEC), true);
});

Deno.test("jjsz F6: ps failures stay unmeasurable (non-zero exit, spawn failure)", async () => {
  const exited = await readLoadSample(null, depsOf(fakePs([], { code: 1 })));
  assertEquals(exited.measurable, false);
  assertStringIncludes(String(exited.error), "ps exited 1");
  const spawnFailure = await readLoadSample(null, depsOf({ runPs: () => Promise.reject(new Error("spawn /bin/ps ENOENT")) }));
  assertEquals(spawnFailure.measurable, false);
  assertStringIncludes(String(spawnFailure.error), "spawn /bin/ps ENOENT");
  assertEquals(isQuiet(spawnFailure, SPEC), false);
});

// ---------------------------------------------------------------------------------------------
// The environment ps runs under
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F6: ps is spawned with a CLEARED environment holding only LC_ALL=C and TZ=UTC", async () => {
  const ps = fakePs(ordinary(5));
  await readLoadSample(null, depsOf(ps));
  assertEquals(ps.calls.length, 1);
  assertEquals(ps.calls[0].args, ["-axo", "pid=,time=,lstart=,comm="]);
  assertEquals(ps.calls[0].clearEnv, true, "nothing of the caller's environment may reach ps");
  assertEquals(ps.calls[0].env, { LC_ALL: "C", TZ: "UTC" });
});

Deno.test("jjsz F6: a hostile ambient locale and zone cannot change what ps prints", async () => {
  const ambient = { LC_ALL: "de_DE.UTF-8", TZ: "Asia/Tokyo" };
  const rows = [...ordinary(30), ...COMPILERS];
  // CONTROL (anti-vacuity): the same fixture, spawned the OLD way (inheriting the ambient environment),
  // really does print rows the parser cannot read.
  const leaking = fakePs(rows, { ambient });
  const old = await readLoadSample(null, depsOf({ runPs: (inv) => leaking.runPs({ ...inv, clearEnv: false, env: {} }) }));
  assertEquals(old.measurable, false, "fixture: the hostile ambient locale must break an inheriting spawn");
  // The real invocation: the ambient environment is cleared away and the compilers are seen.
  const ps = fakePs(rows, { ambient });
  const sample = await readLoadSample(null, depsOf(ps));
  assertEquals(sample.measurable, true, String(sample.error));
  assertEquals(sample.compilers, 3);
  assertEquals(sample.compilerNames, ["clang", "ld", "ninja"]);
});

Deno.test("jjsz F6: an idle builder stays idle when the machine changes time zone between samples", async () => {
  // The lstart text is the identity token compared ACROSS samples. If it followed the machine's zone, a
  // laptop that moved zones mid-wait would turn every parked builder into "a new process" (active).
  const rows = [...ordinary(10), ...COMPILERS];
  const first = await readLoadSample(null, depsOf(fakePs(rows, { machineZoneHours: 1 })));
  const second = await readLoadSample(first.cpu, depsOf(fakePs(rows, { machineZoneHours: 9 })));
  assertEquals(second.measurable, true, String(second.error));
  assertEquals(second.compilers, 3);
  assertEquals(second.activeCompilers, 0, "same processes, same CPU: idle, whatever zone the machine is in now");
  assertEquals(first.cpu?.get("9001")?.startTicks, "Wed Oct 7 12:26:48 2026", "the token is the UTC rendering");
  assertEquals(second.cpu?.get("9001")?.startTicks, first.cpu?.get("9001")?.startTicks);
});

// ---------------------------------------------------------------------------------------------
// The scan budget
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F6: a SLOW ps does not spend the scan budget before one row is read", async () => {
  // ps takes 1000 ms; the budget for reading the table is 200 ms, and the bounded retry gets 4x that (800 ms),
  // so a clock that started BEFORE ps returned has spent 1000 ms and is out of budget on both attempts: the
  // sample would be refused as truncated. The clock must start AFTER ps returned. The delay is a real timer,
  // which cannot fire early, so that verdict does not depend on scheduling; and the budget dwarfs what parsing
  // these rows takes, so a stalled box cannot trip the CORRECT code (it used to be 80 ms against 20 ms).
  const ps = fakePs([...ordinary(30), ...COMPILERS], { delayMs: 1000 });
  const sample = await readLoadSample(null, depsOf(ps, { budget: { entries: 4096, ms: 200 } }));
  assertEquals(sample.measurable, true, `ps latency is not the box's process count: ${sample.error ?? ""}`);
  assertEquals(sample.compilers, 3);
  assertEquals(sample.retriedAfterTruncation, undefined, "and it was not even a retry");
  assertEquals(ps.calls.length, 1);
});

Deno.test("jjsz F6: the scan budget still bounds a walk, and the bounded retry still applies on this branch", async (t) => {
  await t.step("a first walk that truncates is retried with 4x the entries and measured", async () => {
    const ps = fakePs(ordinary(10));
    const sample = await readLoadSample(null, depsOf(ps, { budget: { entries: 3, ms: 5000 } }));
    assertEquals(sample.measurable, true, String(sample.error));
    assertEquals(sample.retriedAfterTruncation, true);
    assertEquals(ps.calls.length, 2, "one ps per attempt");
  });
  await t.step("a box that truncates at BOTH budgets refuses, and says both attempts truncated", async () => {
    const ps = fakePs(ordinary(30));
    const sample = await readLoadSample(null, depsOf(ps, { budget: { entries: 3, ms: 5000 } }));
    assertEquals(sample.measurable, false);
    assertStringIncludes(String(sample.error), "truncated after");
    assertStringIncludes(String(sample.error), "retry");
    assertStringIncludes(String(sample.error), "truncated too");
    assertEquals(isQuiet(sample, SPEC), false);
  });
});

Deno.test("jjsz F6: the TIME budget still bounds the parse of a huge table on this branch", async () => {
  // 150k rows cannot be parsed in 1 ms (nor in the retry's 4 ms), and the entry budget is far away, so both
  // attempts are cut by the CLOCK. The clock starts when ps has returned; it must still stop the parse.
  const row = "  100  0:00.10 Wed Oct  7 12:26:48 2026 /usr/sbin/cfprefsd\n";
  const ps = fakePs([], { raw: row.repeat(150_000) });
  const sample = await readLoadSample(null, depsOf(ps, { budget: { entries: 10_000_000, ms: 1 } }));
  assertEquals(sample.measurable, false);
  assertStringIncludes(String(sample.error), "truncated after");
  assertStringIncludes(String(sample.error), "truncated too");
  assertEquals(isQuiet(sample, SPEC), false);
  assertEquals(ps.calls.length, 2, "cut by the clock, retried once, cut again");
});

Deno.test("jjsz F6: a retry that fails for ANOTHER reason does not claim it truncated too", async () => {
  // First walk truncates (budget 2 entries); the retry (8 entries) reads the three good rows and then hits a
  // row it cannot read. That is an unreadable table, not a second truncation.
  const ps = fakePs(ordinary(3), { extraLines: ["  777  0:00.01 garbage that is not a ps row"] });
  const sample = await readLoadSample(null, depsOf(ps, { budget: { entries: 2, ms: 5000 } }));
  assertEquals(sample.measurable, false);
  assertMatch(String(sample.error), /ps printed 1 row\(s\) this parser cannot read \(3 parsed\)/u);
  assertEquals(/truncated too|retry with/u.test(String(sample.error)), false, `the error must stay truthful: ${sample.error}`);
  assertEquals(ps.calls.length, 2, "the truncated first attempt was retried exactly once");
});

Deno.test("jjsz F6: a walk that was cut keeps its truncation verdict over an unreadable row seen before the cut", async () => {
  // The unreadable row comes FIRST and the walk is cut after 3 entries. Rows after the cut were never read, so
  // the table has not been read in full and the honest verdict is the truncation one: the bounded retry (4x
  // the entries) runs, and when that is cut too the sample says so. Only a walk that reaches the end of the
  // table may call a row unreadable.
  const table = await fakePs(ordinary(30)).runPs({ args: [], env: {}, clearEnv: true });
  const ps = fakePs([], { raw: `  777  0:00.01 garbage that is not a ps row\n${table.stdout}` });
  const sample = await readLoadSample(null, depsOf(ps, { budget: { entries: 3, ms: 5000 } }));
  assertEquals(sample.measurable, false);
  assertStringIncludes(String(sample.error), "truncated after 12 entries");
  assertStringIncludes(String(sample.error), "truncated too");
  assertEquals(String(sample.error).includes("cannot read"), false, `truncation keeps precedence: ${sample.error}`);
  assertEquals(ps.calls.length, 2, "a cut walk is retried, whatever else it saw");
});

// ---------------------------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F6: hasProc selects the branch, and the /proc branch never runs ps", async () => {
  const ps = fakePs(ordinary(5));
  // On Linux this walks the real /proc; elsewhere there is no /proc and the sample is unmeasurable. Either
  // way ps must not have been consulted, which is what this test is about.
  await readLoadSample(null, depsOf(ps, { hasProc: true }));
  assertEquals(ps.calls.length, 0);
  await readLoadSample(null, depsOf(ps, { hasProc: false }));
  assertEquals(ps.calls.length, 1);
});

Deno.test("jjsz F6: the load average is read through the loadavg seam on the no-/proc branch", async () => {
  const sample = await readLoadSample(null, depsOf(fakePs(ordinary(5)), { loadavg: () => [2, 1, 0.5] }));
  assertEquals(sample.measurable, true, String(sample.error));
  assertEquals([sample.load1, sample.load5, sample.load15], [2, 1, 0.5]);
  assertEquals(sample.loadPerCore, 2 / CORES);
  const malformed = await readLoadSample(null, depsOf(fakePs(ordinary(5)), { loadavg: () => [NaN, 1, 1] }));
  assertEquals(malformed.measurable, false);
  assertStringIncludes(String(malformed.error), "malformed loadavg");
});

// ---------------------------------------------------------------------------------------------
// The REAL ps under a hostile locale
// ---------------------------------------------------------------------------------------------

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const HAS_PROC = (() => {
  try {
    return Deno.statSync("/proc").isDirectory;
  } catch {
    return false;
  }
})();
const C_SHAPE = /^[A-Za-z]{3}\s+\S+\s+\S+\s+\d+:\d+:\d+\s+\d{4}$/u;

// Capability probes are RAW ps calls, never the library under test, so a regression in the library turns the
// real test RED instead of silently IGNORING it. A hostile environment counts only when it REALLY changes the
// shape this box's ps prints (the locale may not be installed), and the branch only exists without /proc.
const rawLstart = (env: Record<string, string>, pid: number = Deno.pid): string | null => {
  try {
    const out = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env });
    return out.status === 0 ? String(out.stdout).trim() : null;
  } catch {
    return null;
  }
};
const HOSTILE_CANDIDATES: Array<Record<string, string>> = [
  { LC_ALL: "de_DE.UTF-8", TZ: "Asia/Tokyo" },
  { LANG: "de_DE.UTF-8", TZ: "America/New_York" },
];
const HOSTILE: Array<Record<string, string>> = HAS_PROC || !isFile("/bin/ps") || !C_SHAPE.test(rawLstart({ LC_ALL: "C" }) ?? "")
  ? []
  : HOSTILE_CANDIDATES.filter((env) => {
    const printed = rawLstart(env);
    return printed !== null && !C_SHAPE.test(printed);
  });

Deno.test({
  name: "jjsz F6: REAL ps under a hostile locale and zone still sees a real builder (the old walk dropped every row)",
  ignore: HOSTILE.length === 0 || !isFile("/bin/sleep"),
  fn: async () => {
    const dir = durableDir("jjsz-macos-quiet-window", `${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`);
    try {
      // A heavy-named process that is REALLY running: a symlink called `ninja` to sleep. ps reports the path
      // the process was started through, so its command name is `ninja`.
      const builder = `${dir}/ninja`;
      await Deno.symlink("/bin/sleep", builder);
      const child = new Deno.Command(builder, { args: ["30"], stdout: "null", stderr: "null" }).spawn();
      try {
        const script = `${dir}/sample.mjs`;
        await Deno.writeTextFile(
          script,
          [
            `import { readLoadSample } from ${JSON.stringify(new URL("../scripts/lib/quiet-window.ts", import.meta.url).href)};`,
            "const s = await readLoadSample(null);",
            "console.log(JSON.stringify({ measurable: s.measurable, error: s.error ?? null, compilers: s.compilers,",
            "  cpu: s.cpu ? [...s.cpu.entries()] : [] }));",
          ].join("\n"),
        );
        for (const hostile of HOSTILE) {
          const out = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "--no-check", script],
            // The child needs HOME (and DENO_DIR when set) to find its module cache; every locale and zone
            // variable is the hostile one.
            env: {
              ...hostile,
              HOME: Deno.env.get("HOME") ?? "",
              PATH: Deno.env.get("PATH") ?? "",
              ...(Deno.env.get("DENO_DIR") ? { DENO_DIR: Deno.env.get("DENO_DIR") as string } : {}),
            },
            clearEnv: true,
            stdout: "piped",
            stderr: "piped",
          }).output();
          const stderr = new TextDecoder().decode(out.stderr).trim();
          assertEquals(out.code, 0, `fixture: the sampling child failed under ${JSON.stringify(hostile)}: ${stderr.slice(0, 300)}`);
          const line = new TextDecoder().decode(out.stdout).trim().split("\n").pop() ?? "";
          const sample = JSON.parse(line) as {
            measurable: boolean;
            error: string | null;
            compilers: number;
            cpu: Array<[string, { name: string; startTicks: string }]>;
          };
          assertEquals(sample.measurable, true, `under ${JSON.stringify(hostile)}: ${sample.error}`);
          assertNotEquals(sample.compilers, 0, "a running builder must be counted, whatever locale the caller has");
          const mine = sample.cpu.find(([pid]) => pid === String(child.pid));
          assert(mine !== undefined && mine[1].name === "ninja", `OUR builder (pid ${child.pid}) must be among the ones seen under ${JSON.stringify(hostile)}`);
          // The identity token is the lstart text compared ACROSS samples, so it must be the UTC rendering
          // whatever zone the caller (or this machine) is in. The reference is a RAW ps call, not the library.
          const utc = rawLstart({ LC_ALL: "C", TZ: "UTC" }, child.pid);
          assert(utc !== null, "fixture: a raw ps must read our own builder's start time");
          assertEquals(mine[1].startTicks, utc.replace(/\s+/gu, " "), `the start-time token must be the UTC one under ${JSON.stringify(hostile)}`);
        }
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        await child.status;
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

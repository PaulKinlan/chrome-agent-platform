// chrome-agent-platform-jjsz F1 — the build lock must not steal a LIVE owner's lock on macOS.
//
// WHAT WAS WRONG. The no-/proc branch of procStatFields shells out to `/bin/ps -o state=,lstart=`.
// Three fail-open defects each made a LIVE holder look dead (or look like a different process):
//   (a) `lstart` is rendered in the caller's LOCALE and TIME ZONE. Measured on macOS 15.8, ONE live
//       process: `Wed Oct  7 12:26:48 2026` (LC_ALL=C), `Wed  7 Oct 12:26:48 2026` (en_GB),
//       `Mi  7 Okt ...` (de_DE), and 12:26 / 21:26 / 08:26 under TZ=UTC / Asia/Tokyo /
//       America/New_York. An owner started from a Terminal and a contender started from launchd or CI
//       recorded UNEQUAL strings for the SAME process, and the pid-reuse compare read that as "a
//       different process": the lock was stolen from a live build.
//   (b) Any numeric non-zero exit status, and an empty exit-0 output, were both "gone". A ps that
//       merely failed to read the process table (a bad keyword also exits 1 — WITH stderr text) was
//       taken as proof of death. Only exit 1 + EMPTY stdout + EMPTY stderr is what `ps -p <absent>`
//       produces.
//   (c) A failed identity read recorded `start: "0"`, which is TRUTHY, so every later compare against
//       the live process mismatched and read as pid reuse.
//
// EVERY behavioural test here runs on BOTH platforms. The macOS branch is selected with the
// `hasProc: false` seam and `ps` is a spawnSync-shaped fake that models the measured macOS behaviour
// (it honours the environment it is spawned with — which is exactly what the fix controls — so a
// regression that stops controlling the environment changes the answer). The two REAL-ps tests at the
// end are the integration check against the box's own ps; they are `ignore`d (visibly) where that ps
// cannot answer `-o state=,lstart=`.
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import {
  acquireBuildLock,
  buildOwnerIdentity,
  holderIsDead,
  LOCK_DIRNAME,
  procStatFields,
  PS_ENV,
  PS_TIMEOUT_MS,
} from "../scripts/lib/build-lock.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

type SpawnLike = {
  status?: number | null;
  signal?: string | null;
  error?: { code?: string };
  stdout?: string | null;
  stderr?: string | null;
};
type PsOptions = {
  env?: Record<string, string>;
  timeout?: number;
  killSignal?: string;
  encoding?: string;
  stdio?: string[];
};
type Exec = (file: string, args: string[], options: PsOptions) => SpawnLike;
type Fields = { ok: boolean; state?: string; start?: string; reason?: string; code?: unknown };
type Ambient = { LC_ALL?: string; LC_TIME?: string; LANG?: string; TZ?: string };

const PID = 1234;
const BOOT = "jjsz-test-boot";
const PS_ARGS = ["-o", "state=,lstart=", "-p", String(PID)];

/** The no-/proc branch of procStatFields, with `ps` replaced by `exec`. */
function fieldsVia(exec: Exec, pid = PID, extra: Record<string, unknown> = {}): Fields {
  return procStatFields(pid, undefined, { hasProc: false, exec, ...extra }) as Fields;
}
const probeVia = (exec: Exec) => (pid: number) => fieldsVia(exec, pid);

const returning = (result: SpawnLike): Exec => () => result;
const throwing = (code: string): Exec => () => {
  throw Object.assign(new Error(`spawn failed: ${code}`), { code });
};

// ---------------------------------------------------------------------------------------------
// A model of macOS `ps` that honours the environment it is spawned with.
//
// ONE live process (pid PID) started at 12:26:48 UTC on Wed 7 Oct 2026. A child given an explicit
// `env` sees ONLY that; with none it inherits the caller's ambient. A child with no TZ at all renders
// in the MACHINE zone (BST, +1, as on the box the numbers above were measured on, unless the caller
// models another zone): that is the zone a laptop changes by itself when it travels.
// ---------------------------------------------------------------------------------------------
const START_UTC_HOUR = 12;
const MACHINE_ZONE_HOURS = 1;
const ZONE_HOURS: Record<string, number> = { UTC: 0, "Asia/Tokyo": 9, "America/New_York": -4 };
const LSTART: Record<string, (hms: string) => string> = {
  C: (t) => `Wed Oct  7 ${t} 2026`,
  "en_GB.UTF-8": (t) => `Wed  7 Oct ${t} 2026`,
  "fr_FR.UTF-8": (t) => `Mer  7 oct ${t} 2026`,
  "de_DE.UTF-8": (t) => `Mi  7 Okt ${t} 2026`,
};

function macPs(ambient: Ambient, machineZoneHours = MACHINE_ZONE_HOURS) {
  const calls: Array<{ file: string; args: string[]; options: PsOptions }> = [];
  const exec: Exec = (file, args, options) => {
    calls.push({ file, args, options });
    if (Number(args[args.indexOf("-p") + 1]) !== PID) {
      return { status: 1, signal: null, stdout: "", stderr: "" }; // `ps -p <absent pid>`
    }
    const env: Ambient = options?.env ?? ambient;
    const locale = env.LC_ALL ?? env.LC_TIME ?? env.LANG ?? "C";
    const zone = env.TZ === undefined ? machineZoneHours : ZONE_HOURS[env.TZ];
    const hms = `${String(START_UTC_HOUR + zone).padStart(2, "0")}:26:48`;
    return { status: 0, signal: null, stdout: `S+   ${LSTART[locale](hms)}\n`, stderr: "" };
  };
  return { exec, calls };
}

const AMBIENTS: Array<{ name: string; env: Ambient }> = [
  { name: "Terminal: en_GB, machine zone", env: { LC_ALL: "en_GB.UTF-8" } },
  // differs from the entry above by LOCALE ONLY:
  { name: "launchd/CI: C locale, machine zone", env: { LC_ALL: "C" } },
  { name: "C locale, TZ=UTC", env: { LC_ALL: "C", TZ: "UTC" } },
  // differs from the entry above by ZONE ONLY:
  { name: "C locale, TZ=Asia/Tokyo", env: { LC_ALL: "C", TZ: "Asia/Tokyo" } },
  { name: "de_DE, TZ=America/New_York", env: { LC_ALL: "de_DE.UTF-8", TZ: "America/New_York" } },
  { name: "fr_FR via LANG, machine zone", env: { LANG: "fr_FR.UTF-8" } },
];

let tmpSeq = 0;
function tmpRoot(prefix: string): string {
  // Durable, like every other scratch dir in this repo (tests/durable-root.test.ts polices a bare
  // temp-dir factory). Each caller removes its root in its own finally.
  return durableDir(`build-lock-jjsz-${prefix}-${Deno.pid}-${tmpSeq++}`);
}
function writeLock(root: string, owner: Record<string, unknown>): void {
  const dir = `${root}/${LOCK_DIRNAME}`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(`${dir}/owner.json`, JSON.stringify(owner));
}
function lockToken(root: string): string | null {
  try {
    const raw = Deno.readTextFileSync(`${root}/${LOCK_DIRNAME}/owner.json`);
    return (JSON.parse(raw) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}
const removeRoot = (root: string) => Deno.remove(root, { recursive: true }).catch(() => {});

/** A contender's own identity: its content is irrelevant to the steal decision. */
const contenderIdentity = () =>
  buildOwnerIdentity(PID + 1, BOOT, { procStat: () => ({ ok: true, start: "contender-start" }) });

// ---------------------------------------------------------------------------------------------
// (a) locale and zone
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F1(a): ONE live process reads as the SAME start from every launch environment", () => {
  // Anti-vacuity: the model IS the defect. Spawned with the caller's own environment (what the old
  // code did) the six ambients disagree about one live process.
  const raw = AMBIENTS.map((a) => macPs(a.env).exec("/bin/ps", PS_ARGS, {}).stdout);
  assertEquals(
    new Set(raw).size,
    AMBIENTS.length,
    `fixture: the ambients must disagree about the raw lstart: ${JSON.stringify(raw)}`,
  );

  const starts = AMBIENTS.map((a) => {
    const fields = fieldsVia(macPs(a.env).exec);
    assert(fields.ok, `${a.name}: the read must succeed (${JSON.stringify(fields)})`);
    return fields.start;
  });
  assertEquals(
    new Set(starts).size,
    1,
    `one live process must have ONE start string whatever environment read it: ${JSON.stringify(starts)}`,
  );
  assertEquals(starts[0], "Wed Oct 7 12:26:48 2026", "the canonical form is C locale, UTC");
});

Deno.test("jjsz F1(a): an owner and a contender from DIFFERENT environments never read as pid reuse", async () => {
  let pairs = 0;
  for (const owner of AMBIENTS) {
    for (const contender of AMBIENTS) {
      const holder = buildOwnerIdentity(PID, BOOT, { procStat: probeVia(macPs(owner.env).exec) });
      assert(holder.start, `fixture: the owner (${owner.name}) must record a start`);
      const dead = await holderIsDead(holder, {
        bootId: BOOT,
        kill: () => {},
        procStat: probeVia(macPs(contender.env).exec),
      });
      assertEquals(
        dead,
        false,
        `a LIVE owner (${owner.name}) was judged dead by a contender in ${contender.name}`,
      );
      pairs++;
    }
  }
  assertEquals(pairs, AMBIENTS.length * AMBIENTS.length);
});

Deno.test("jjsz F1(a): acquireBuildLock refuses a live owner across a locale-only and a zone-only difference", async () => {
  const cases: Array<[number, number, string]> = [
    [0, 1, "locale-only"], // en_GB vs C, both in the machine zone
    [2, 3, "zone-only"], // UTC vs Asia/Tokyo, both C locale
  ];
  for (const [ownerIdx, contenderIdx, what] of cases) {
    const root = tmpRoot(`env-${what}`);
    try {
      const owner = buildOwnerIdentity(PID, BOOT, {
        procStat: probeVia(macPs(AMBIENTS[ownerIdx].env).exec),
      });
      writeLock(root, { ...owner, token: "live-owner-token" });
      await assertRejects(
        () =>
          acquireBuildLock({
            root,
            owner: contenderIdentity(),
            attempts: 2,
            intervalMs: 5,
            livenessDeps: {
              kill: () => {},
              bootId: BOOT,
              procStat: probeVia(macPs(AMBIENTS[contenderIdx].env).exec),
            },
          }),
        Error,
        "another LIVE build",
        `a ${what} environment difference must not make a live owner stealable`,
      );
      assertEquals(lockToken(root), "live-owner-token", `the live lock must be untouched (${what})`);
    } finally {
      await removeRoot(root);
    }
  }
});

Deno.test("jjsz F1(a): a machine whose zone CHANGES between the owner's write and the contender's read is not pid reuse", async () => {
  // macOS sets the zone from the laptop's location, so a long build can outlive a zone change. With no
  // TZ in the child's environment ps renders in the MACHINE zone and the same live process would print
  // a different hour; TZ=UTC in the controlled environment makes the string independent of the zone.
  const zones: Array<[number, number]> = [[1, 9], [9, 1], [-4, 0]];
  for (const [ownerZone, contenderZone] of zones) {
    // CONTROL (anti-vacuity): spawned the old way, the two zones DO disagree about this process.
    const rawOwner = macPs({}, ownerZone).exec("/bin/ps", PS_ARGS, {}).stdout;
    const rawContender = macPs({}, contenderZone).exec("/bin/ps", PS_ARGS, {}).stdout;
    assert(
      rawOwner !== rawContender,
      `fixture: zones ${ownerZone} and ${contenderZone} must render differently`,
    );

    const holder = buildOwnerIdentity(PID, BOOT, { procStat: probeVia(macPs({}, ownerZone).exec) });
    assert(holder.start, "fixture: the owner must record a start");
    assertEquals(
      await holderIsDead(holder, {
        bootId: BOOT,
        kill: () => {},
        procStat: probeVia(macPs({}, contenderZone).exec),
      }),
      false,
      `a live owner read in zone ${ownerZone} was judged dead by a contender in zone ${contenderZone}`,
    );
  }

  const root = tmpRoot("zone-change");
  try {
    const owner = buildOwnerIdentity(PID, BOOT, { procStat: probeVia(macPs({}, 1).exec) });
    writeLock(root, { ...owner, token: "live-owner-token" });
    await assertRejects(
      () =>
        acquireBuildLock({
          root,
          owner: contenderIdentity(),
          attempts: 2,
          intervalMs: 5,
          livenessDeps: { kill: () => {}, bootId: BOOT, procStat: probeVia(macPs({}, 9).exec) },
        }),
      Error,
      "another LIVE build",
      "a machine zone change must not make a live owner stealable",
    );
    assertEquals(lockToken(root), "live-owner-token", "the live lock must be untouched");
  } finally {
    await removeRoot(root);
  }
});

Deno.test("jjsz F1(a): ps is spawned under a controlled environment, bounded by a timeout, stderr captured", () => {
  const { exec, calls } = macPs({ LC_ALL: "de_DE.UTF-8", TZ: "Asia/Tokyo" });
  const fields = fieldsVia(exec);
  assert(fields.ok, `the read must succeed (${JSON.stringify(fields)})`);
  assertEquals(calls.length, 1, "exactly one ps spawn per read");
  const { file, args, options } = calls[0];
  assertEquals(file, "/bin/ps", "an absolute path, so no PATH is needed");
  assertEquals(args, PS_ARGS);
  assertEquals(
    options.env,
    { LC_ALL: "C", TZ: "UTC" },
    "the child must not inherit the caller's locale or time zone",
  );
  assertEquals(options.env, { ...PS_ENV }, "the exported PS_ENV is the environment actually used");
  assert(
    typeof options.timeout === "number" && options.timeout > 0 && options.timeout <= 30_000,
    `a wedged ps must be bounded, got timeout=${options.timeout}`,
  );
  assertEquals(options.timeout, PS_TIMEOUT_MS);
  assertEquals(options.killSignal, "SIGKILL", "a wedged ps may ignore SIGTERM");
  assertEquals(options.encoding, "utf8");
  assertEquals(options.stdio?.[1], "pipe", "stdout is read");
  assertEquals(options.stdio?.[2], "pipe", "stderr is READ — 'gone' requires it to be empty");
});

// ---------------------------------------------------------------------------------------------
// (b) gone vs unreadable
// ---------------------------------------------------------------------------------------------

const CLASSIFICATION: Array<{ name: string; exec: Exec; reason: string; code?: unknown }> = [
  {
    name: "exit 1 with EMPTY stdout and EMPTY stderr (ps -p <absent pid>) is GONE",
    exec: returning({ status: 1, signal: null, stdout: "", stderr: "" }),
    reason: "gone",
  },
  {
    name: "exit 1 WITH stderr text (ps could not read the table) is unreadable",
    exec: returning({ status: 1, signal: null, stdout: "", stderr: "ps: Invalid argument\n" }),
    reason: "unreadable",
    code: 1,
  },
  {
    name: "exit 1 with a keyword list on stdout AND stderr (a bad keyword) is unreadable",
    exec: returning({
      status: 1,
      signal: null,
      stdout: "%CPU      percent cpu usage\nPID       process ID\n",
      stderr: "ps: nosuchfield: keyword not found\n",
    }),
    reason: "unreadable",
    code: 1,
  },
  {
    name: "exit 1 with empty stderr but NON-empty stdout is unreadable",
    exec: returning({ status: 1, signal: null, stdout: "junk\n", stderr: "" }),
    reason: "unreadable",
    code: 1,
  },
  {
    name: "exit 2 is unreadable: it is not 'any non-zero status'",
    exec: returning({ status: 2, signal: null, stdout: "", stderr: "" }),
    reason: "unreadable",
    code: 2,
  },
  {
    name: "killed by a signal is unreadable",
    exec: returning({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }),
    reason: "unreadable",
    code: "SIGKILL",
  },
  {
    name: "a timeout (ETIMEDOUT) is unreadable",
    exec: returning({
      status: null,
      signal: "SIGKILL",
      error: { code: "ETIMEDOUT" },
      stdout: "",
      stderr: "",
    }),
    reason: "unreadable",
    code: "ETIMEDOUT",
  },
  {
    name: "a spawn failure with NO ps binary (ENOENT, Node shape) is unreadable, never absence",
    exec: returning({
      error: { code: "ENOENT" },
      status: null,
      signal: null,
      stdout: null,
      stderr: null,
    }),
    reason: "unreadable",
    code: "ENOENT",
  },
  {
    name: "a spawn failure (ENOENT, Deno shape: no status/signal/stdout) is unreadable",
    exec: returning({ error: { code: "ENOENT" } }),
    reason: "unreadable",
    code: "ENOENT",
  },
  {
    name: "a spawn failure (EAGAIN) is unreadable",
    exec: returning({ error: { code: "EAGAIN" }, status: null, signal: null }),
    reason: "unreadable",
    code: "EAGAIN",
  },
  {
    name: "over-large output (ENOBUFS) is unreadable",
    exec: returning({
      error: { code: "ENOBUFS" },
      status: null,
      signal: "SIGTERM",
      stdout: "x",
      stderr: "",
    }),
    reason: "unreadable",
    code: "ENOBUFS",
  },
  {
    name: "exit 0 with EMPTY output is unreadable, not gone",
    exec: returning({ status: 0, signal: null, stdout: "", stderr: "" }),
    reason: "unreadable",
  },
  {
    name: "an exec that THROWS (EMFILE) failed to read: unreadable",
    exec: throwing("EMFILE"),
    reason: "unreadable",
    code: "EMFILE",
  },
  {
    name: "exit 1 with stderr NOT captured cannot be confirmed empty: unreadable",
    exec: returning({ status: 1, signal: null, stdout: "", stderr: null }),
    reason: "unreadable",
    code: 1,
  },
  {
    name: "exit 1 with stdout NOT captured cannot be confirmed empty: unreadable",
    exec: returning({ status: 1, signal: null, stdout: null, stderr: "" }),
    reason: "unreadable",
    code: 1,
  },
  {
    name: "exit 0 with a garbage row is unparseable",
    exec: returning({ status: 0, signal: null, stdout: "garbage\n", stderr: "" }),
    reason: "unparseable",
  },
  {
    name: "exit 0 with a NON-C-locale row is not a start time",
    exec: returning({ status: 0, signal: null, stdout: "S+   Wed  7 Oct 12:26:48 2026\n", stderr: "" }),
    reason: "unparseable",
  },
  {
    name: "exit 0 with a truncated row (state only) is unparseable",
    exec: returning({ status: 0, signal: null, stdout: "S+\n", stderr: "" }),
    reason: "unparseable",
  },
];

Deno.test("jjsz F1(b): ONLY exit-1 + empty stdout + empty stderr is gone; every other outcome stays alive", async (t) => {
  assertEquals(CLASSIFICATION.filter((row) => row.reason === "gone").length, 1, "fixture: one gone row");
  for (const row of CLASSIFICATION) {
    await t.step(row.name, async () => {
      const fields = fieldsVia(row.exec);
      assertEquals(fields.ok, false, JSON.stringify(fields));
      assertEquals(fields.reason, row.reason, JSON.stringify(fields));
      assertEquals(fields.code, row.code, `diagnostic code: ${JSON.stringify(fields)}`);
      const dead = await holderIsDead(
        { pid: PID, start: "Wed Oct 7 12:26:48 2026", boot: BOOT },
        { bootId: BOOT, kill: () => {}, procStat: probeVia(row.exec) },
      );
      assertEquals(
        dead,
        row.reason === "gone",
        row.reason === "gone"
          ? "an absent pid IS proof of death: the lock must be stealable"
          : `${row.reason} is not proof of death: a LIVE build's lock must NOT be stealable`,
      );
    });
  }
});

Deno.test("jjsz F1(b): a well-formed row parses to {state, start} and a Z row is a corpse", async (t) => {
  const rows = [
    { stdout: "S+   Wed Oct  7 12:32:19 2026\n", state: "S", start: "Wed Oct 7 12:32:19 2026" },
    { stdout: "Ss   Thu Oct 17 03:04:05 2026\n", state: "S", start: "Thu Oct 17 03:04:05 2026" },
    { stdout: "U    Wed Oct  7 12:32:19 2026\n", state: "U", start: "Wed Oct 7 12:32:19 2026" },
    { stdout: "Z+   Wed Oct  7 12:32:19 2026\n", state: "Z", start: "Wed Oct 7 12:32:19 2026" },
  ];
  for (const row of rows) {
    await t.step(JSON.stringify(row.stdout), async () => {
      const exec = returning({ status: 0, signal: null, stdout: row.stdout, stderr: "" });
      assertEquals(fieldsVia(exec), { ok: true, state: row.state, start: row.start });
      const dead = await holderIsDead(
        { pid: PID, start: row.start, boot: BOOT },
        { bootId: BOOT, kill: () => {}, procStat: probeVia(exec) },
      );
      assertEquals(dead, row.state === "Z", "only the zombie state is dead when the start matches");
    });
  }
});

Deno.test("jjsz F1(b): acquireBuildLock steals from a GONE owner and refuses an UNREADABLE one", async () => {
  const owned = { pid: PID, start: "Wed Oct 7 12:26:48 2026", boot: BOOT };
  const run = (root: string, exec: Exec, owner: object = contenderIdentity()) =>
    acquireBuildLock({
      root,
      owner,
      attempts: 2,
      intervalMs: 5,
      livenessDeps: { kill: () => {}, bootId: BOOT, procStat: probeVia(exec) },
    });

  const goneRoot = tmpRoot("gone");
  try {
    writeLock(goneRoot, { ...owned, token: "dead-owner-token" });
    const ours = contenderIdentity();
    await run(goneRoot, returning({ status: 1, signal: null, stdout: "", stderr: "" }), ours);
    assertEquals(lockToken(goneRoot), ours.token, "a gone owner's lock must become ours");
  } finally {
    await removeRoot(goneRoot);
  }

  for (
    const [what, exec] of [
      ["ps exit 1 with stderr", returning({ status: 1, signal: null, stdout: "", stderr: "ps: boom\n" })],
      ["ps timed out", returning({ status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" })],
      ["ps could not be spawned", throwing("EAGAIN")],
    ] as Array<[string, Exec]>
  ) {
    const root = tmpRoot("unreadable");
    try {
      writeLock(root, { ...owned, token: "live-owner-token" });
      await assertRejects(() => run(root, exec), Error, "another LIVE build", what);
      assertEquals(lockToken(root), "live-owner-token", `${what}: the lock must be untouched`);
    } finally {
      await removeRoot(root);
    }
  }
});

const isFile = (path: string): boolean => {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
};

Deno.test({
  name: "jjsz F1(b): a wedged ps that IGNORES SIGTERM is bounded and killed, and read as UNREADABLE (alive), not gone",
  ignore: !isFile("/bin/sh") || !isFile("/bin/sleep"),
  fn: () => {
    // A REAL child that outlives the (injected) 150 ms bound AND ignores SIGTERM (an ignored disposition
    // survives exec, so the process is a single `sleep`, no orphan holding the pipes). The exec ignores the
    // requested command and runs it with the options the library passed, so the timeout and the kill
    // signal are the library's own: only SIGKILL stops it before its 3 s are up.
    const hung: Exec = (_file, _args, options) =>
      spawnSync("/bin/sh", ["-c", "trap '' TERM; exec /bin/sleep 3"], options as never) as SpawnLike;
    const started = performance.now();
    const fields = fieldsVia(hung, PID, { timeoutMs: 150 });
    const elapsed = performance.now() - started;
    assertEquals(fields.ok, false);
    assertEquals(fields.reason, "unreadable", "a timeout is not proof of death");
    assertEquals(fields.code, "ETIMEDOUT");
    assert(elapsed < 2000, `the wedged ps must be killed at the bound, not waited out (${Math.round(elapsed)}ms)`);
  },
});

// ---------------------------------------------------------------------------------------------
// (c) a failed identity read must not record a truthy placeholder
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F1(c): a FAILED identity read records start null (never a truthy placeholder) and is not stealable", async (t) => {
  const failures: Array<[string, () => { ok: boolean; reason?: string; start?: string }]> = [
    ["unreadable", () => ({ ok: false, reason: "unreadable" })],
    ["gone", () => ({ ok: false, reason: "gone" })],
    ["unparseable", () => ({ ok: false, reason: "unparseable" })],
    ["ok with an empty start", () => ({ ok: true, start: "" })],
  ];
  for (const [what, procStat] of failures) {
    await t.step(what, async () => {
      const owner = buildOwnerIdentity(PID, BOOT, { procStat });
      assertEquals(owner.start, null, "start must be null, not a placeholder string");
      assertEquals(
        (JSON.parse(JSON.stringify(owner)) as { start: unknown }).start,
        null,
        "null must survive the owner.json round trip",
      );
      // Against a LIVE process whose real start is known, "cannot prove reuse" means ALIVE.
      assertEquals(
        await holderIsDead(owner, {
          bootId: BOOT,
          kill: () => {},
          procStat: () => ({ ok: true, state: "S", start: "Wed Oct 7 12:26:48 2026" }),
        }),
        false,
        "an owner whose start could not be recorded must not read as pid reuse",
      );
    });
  }
});

Deno.test("jjsz F1(c): acquireBuildLock refuses a live owner whose identity read failed; a recorded DIFFERENT start is still reuse", async () => {
  const live = () => ({ ok: true, state: "S", start: "Wed Oct 7 12:26:48 2026" });
  const run = (root: string, owner: object = contenderIdentity()) =>
    acquireBuildLock({
      root,
      owner,
      attempts: 2,
      intervalMs: 5,
      livenessDeps: { kill: () => {}, bootId: BOOT, procStat: live },
    });

  const blindRoot = tmpRoot("blind");
  try {
    const blind = buildOwnerIdentity(PID, BOOT, { procStat: () => ({ ok: false, reason: "unreadable" }) });
    writeLock(blindRoot, { ...blind, token: "blind-live-owner-token" });
    await assertRejects(() => run(blindRoot), Error, "another LIVE build");
    assertEquals(lockToken(blindRoot), "blind-live-owner-token", "the live lock must be untouched");
  } finally {
    await removeRoot(blindRoot);
  }

  // CONTROL: pid reuse detection is preserved — a recorded start that differs IS reuse.
  const reuseRoot = tmpRoot("reuse");
  try {
    const recorded = buildOwnerIdentity(PID, BOOT, {
      procStat: () => ({ ok: true, state: "S", start: "Tue Oct 6 01:02:03 2026" }),
    });
    assertEquals(recorded.start, "Tue Oct 6 01:02:03 2026", "a successful read records the start");
    writeLock(reuseRoot, { ...recorded, token: "reused-pid-token" });
    const ours = contenderIdentity();
    await run(reuseRoot, ours);
    assertEquals(lockToken(reuseRoot), ours.token, "a reused pid (different start) must be stolen");
  } finally {
    await removeRoot(reuseRoot);
  }
});

Deno.test("jjsz F1(c): the default identity read on this box records a real start string", () => {
  const owner = buildOwnerIdentity();
  assert(
    typeof owner.start === "string" && owner.start.length > 0,
    `this process must be able to read its own start (got ${JSON.stringify(owner.start)})`,
  );
});

// ---------------------------------------------------------------------------------------------
// Linux parity: the /proc branch is unchanged
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F1: the /proc branch never spawns ps and keeps its ENOENT=gone / other=unreadable rule", () => {
  const neverSpawn: Exec = () => {
    throw new Error("the /proc branch must not spawn ps");
  };
  const tail = Array.from({ length: 25 }, (_, i) => `v${i}`);
  tail[0] = "S";
  tail[19] = "987654";
  const line = `4242 (my app (beta)) ${tail.join(" ")}`;

  const seen: string[] = [];
  const ok = procStatFields(
    4242,
    (path: string) => {
      seen.push(path);
      return line;
    },
    { hasProc: true, exec: neverSpawn },
  ) as Fields;
  assertEquals(ok, { ok: true, state: "S", start: "987654" });
  assertEquals(seen, ["/proc/4242/stat"]);

  // A caller-supplied reader ALWAYS selects the /proc branch, even where hasProc is false.
  assertEquals(
    procStatFields(4242, () => line, { hasProc: false, exec: neverSpawn }) as Fields,
    { ok: true, state: "S", start: "987654" },
  );

  const gone = procStatFields(4242, () => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  }, { hasProc: true, exec: neverSpawn }) as Fields;
  assertEquals(gone, { ok: false, reason: "gone", code: "ENOENT" });

  const denied = procStatFields(4242, () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  }, { hasProc: true, exec: neverSpawn }) as Fields;
  assertEquals(denied, { ok: false, reason: "unreadable", code: "EACCES" });

  assertEquals(
    procStatFields(4242, () => "garbage", { hasProc: true, exec: neverSpawn }) as Fields,
    { ok: false, reason: "unparseable" },
  );

  // hasProc: true with the DEFAULT reader reads the real /proc (or fails on a box without one) — it
  // still must not spawn ps.
  let spawned = 0;
  procStatFields(Deno.pid, undefined, {
    hasProc: true,
    exec: (() => {
      spawned++;
      return { status: 1, stdout: "", stderr: "" };
    }) as Exec,
  });
  assertEquals(spawned, 0, "hasProc: true must never reach the ps branch");
});

// ---------------------------------------------------------------------------------------------
// The integration check: the box's REAL ps
// ---------------------------------------------------------------------------------------------

// The capability probe is a RAW ps under the documented environment, never the library under test: a
// regression in the library's own read (the drill that removes the controlled environment makes that read
// fail on a box whose locale is not C) must turn the real-ps tests RED, not silently IGNORE them. Only a
// box whose ps cannot print the documented row may ignore them.
const REAL_PS_CAPABLE = (() => {
  try {
    const probe = spawnSync("/bin/ps", ["-o", "state=,lstart=", "-p", String(Deno.pid)], {
      encoding: "utf8",
      env: { LC_ALL: "C", TZ: "UTC" },
    });
    return probe.status === 0 &&
      /^\S+\s+[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/u.test(
        String(probe.stdout).trim(),
      );
  } catch {
    return false;
  }
})();

// The hostile-environment test below only means something on a box where these launch environments
// really DO print one process differently when ps inherits them (a locale that is installed, or a zone
// database that knows the zones). A minimal image without tzdata renders every zone as UTC, and the
// in-test control would then fail for a reason that has nothing to do with the library. Like
// REAL_PS_CAPABLE this is decided from RAW ps probes, never from the library under test, so a
// regression in the library can only turn the test RED, never IGNORED; the seam-driven tests above
// model the same environments on every host.
const HOSTILE_LAUNCH_ENVS: Array<Record<string, string>> = [
  { LC_ALL: "de_DE.UTF-8", TZ: "Asia/Tokyo" },
  { LANG: "en_GB.UTF-8", TZ: "America/New_York" },
  { LC_ALL: "fr_FR.UTF-8", TZ: "Pacific/Auckland" },
];
const HOSTILE_ENVS_DISAGREE = (() => {
  try {
    const raw = HOSTILE_LAUNCH_ENVS.map((env) =>
      String(
        spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(Deno.pid)], { encoding: "utf8", env }).stdout,
      ).trim()
    );
    return raw.every((row) => row !== "") && new Set(raw).size === raw.length;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "jjsz F1(a): REAL ps — one live process reads identically from three hostile launch environments",
  ignore: !REAL_PS_CAPABLE || !HOSTILE_ENVS_DISAGREE,
  fn: async () => {
    const sleeper = new Deno.Command(Deno.execPath(), {
      args: ["eval", "setTimeout(() => {}, 30000)"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const moduleUrl = new URL("../scripts/lib/build-lock.mjs", import.meta.url).href;
      const code = [
        `import { procStatFields } from ${JSON.stringify(moduleUrl)};`,
        `import { spawnSync } from "node:child_process";`,
        `const lib = procStatFields(${sleeper.pid}, undefined, { hasProc: false });`,
        // The CONTROL: raw ps spawned the old way, inheriting THIS child's hostile environment.
        `const raw = spawnSync("/bin/ps", ["-o", "lstart=", "-p", "${sleeper.pid}"], { encoding: "utf8" }).stdout;`,
        `console.log(JSON.stringify({ lib, raw }));`,
      ].join("\n");
      const hostile = HOSTILE_LAUNCH_ENVS;
      const results: Array<{ lib: Fields; raw: string }> = [];
      for (const env of hostile) {
        // The DENO child itself needs HOME/PATH; everything else is the hostile locale and zone.
        const out = await new Deno.Command(Deno.execPath(), {
          args: ["eval", code],
          env: { ...env, HOME: Deno.env.get("HOME") ?? "", PATH: Deno.env.get("PATH") ?? "" },
          clearEnv: true,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const stderr = new TextDecoder().decode(out.stderr).trim();
        assertEquals(out.code, 0, `fixture: the child under ${JSON.stringify(env)} failed: ${stderr.slice(0, 300)}`);
        results.push(JSON.parse(new TextDecoder().decode(out.stdout)));
      }

      for (const { lib } of results) {
        assertEquals(lib.ok, true, JSON.stringify(lib));
        assertMatch(
          String(lib.start),
          /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u,
          "the start is the canonical C-locale form",
        );
      }
      // CONTROL (anti-vacuity): the three launch environments really DO disagree about this process
      // when ps inherits them, so "all equal" below is not an accident of three identical environments.
      assertEquals(
        new Set(results.map((r) => r.raw.trim())).size,
        results.length,
        `fixture: raw ps must differ across the hostile environments: ${JSON.stringify(results.map((r) => r.raw.trim()))}`,
      );
      assertEquals(
        new Set(results.map((r) => r.lib.start)).size,
        1,
        `the library must give ONE start string: ${JSON.stringify(results.map((r) => r.lib.start))}`,
      );

      // An oracle computed here, under the documented environment, against the same process.
      const oracle = await new Deno.Command("/bin/ps", {
        args: ["-o", "lstart=", "-p", String(sleeper.pid)],
        env: { LC_ALL: "C", TZ: "UTC" },
        clearEnv: true,
        stdout: "piped",
        stderr: "null",
      }).output();
      assertEquals(
        results[0].lib.start,
        new TextDecoder().decode(oracle.stdout).trim().replace(/\s+/gu, " "),
        "the library's start must equal ps's own lstart under LC_ALL=C TZ=UTC",
      );
    } finally {
      sleeper.kill();
      await sleeper.status.catch(() => {});
    }
  },
});

Deno.test({
  name: "jjsz F1(b): REAL ps — a live pid reads ok and a reaped pid reads gone",
  ignore: !REAL_PS_CAPABLE,
  fn: async () => {
    const live = procStatFields(Deno.pid, undefined, { hasProc: false }) as Fields;
    assertEquals(live.ok, true, JSON.stringify(live));
    assertMatch(String(live.state), /^[A-Z]$/u);

    const child = new Deno.Command("true", { stdout: "null", stderr: "null" }).spawn();
    const reapedPid = child.pid;
    await child.status;
    const gone = procStatFields(reapedPid, undefined, { hasProc: false }) as Fields;
    assertEquals(gone.ok, false, JSON.stringify(gone));
    assertEquals(
      gone.reason,
      "gone",
      "ps -p <reaped pid> exits 1 with empty stdout and stderr, and that must read as gone " +
        "(if this reds, the classification is too strict: dead locks would never be stolen)",
    );
  },
});

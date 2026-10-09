// chrome-agent-platform-jjsz F2 + F5 — custody's no-/proc (macOS) process-identity branch.
//
// F2. On macOS custody reads identities from `/bin/ps`. Custody treats "gone" as CLEAN and everything it
// cannot read as UNPROVEN, but the branch used to fold a failed, wedged or empty `ps` into "gone" or into an
// empty process table, so a machine whose `ps` could not answer reported "no residue". The contract pinned
// here:
//   - readProcIdentity: ONLY `ps` exiting 1 with an EMPTY stdout and an EMPTY stderr (what `ps -p <absent
//     pid>` prints, measured on macOS 15.8) is a ProcessGoneError. Every other outcome is a
//     ProcessUnreadableError, which never carries the `ENOENT` code (a missing /bin/ps has its own).
//   - liveObservedResidue: a successful absence (ProcessGoneError, or Linux ENOENT) is clean;
//     EMFILE/EACCES on either platform is residue marked `unverified` (yuu9s).
//   - procIdentities / observeDescendants: a failed or empty `ps` table REJECTS (it used to become `[]`,
//     "no descendants"), and a failed sample leaves the observed map untouched.
//   - terminateAttestedGroup: an unreadable table still refuses to signal, with the ORIGINAL error.
// F5. macOS `ps` cannot report a session id, so the identity's `sid` is a COPY of its `pgid` and the
// PGID/SID attestation proves less there. That is characterised, not fixed.
//
// Every macOS-branch test drives the branch through the `hasProc: false` and `run` seams, so it runs on
// EVERY platform; the REAL-ps tests at the end run wherever a `/bin/ps` prints the documented columns.
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert@1";
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import process from "node:process";
import {
  attestOwnedGroup,
  groupAlive,
  liveObservedResidue,
  makePsRun,
  observeDescendants,
  parseProcStat,
  procIdentities,
  ProcessGoneError,
  ProcessUnreadableError,
  readProcIdentity,
  terminateAttestedGroup,
} from "../scripts/security-suite-custody.mjs";

const UID = Deno.uid() ?? 0;
const C_LSTART = "Wed Oct  7 12:26:48 2026";

type Run = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** An execFile-shaped rejection: by default exactly what `ps -p <absent pid>` produces (measured). */
function psFailure(over: Record<string, unknown> = {}): Error {
  return Object.assign(
    new Error("Command failed: /bin/ps"),
    { code: 1, signal: null, killed: false, stdout: "", stderr: "" },
    over,
  );
}
const rejecting = (error: Error): Run => () => Promise.reject(error);
const printing = (stdout: string): Run => () => Promise.resolve({ stdout, stderr: "" });

const psRow = (pid: number, ppid: number, pgid: number, uid = UID, state = "S", lstart = C_LSTART) =>
  `${String(pid).padStart(5)} ${state.padEnd(2)} ${String(ppid).padStart(5)} ${
    String(pgid).padStart(5)
  } ${String(uid).padStart(5)} ${lstart}`;
const psTable = (...lines: string[]) => `${lines.join("\n")}\n`;

const ident = (pid: number, over: Partial<{ state: string; ppid: number; pgid: number; sid: number; starttime: string; uid: number }> = {}) => ({
  pid,
  state: "S",
  ppid: 1,
  pgid: pid,
  sid: pid,
  starttime: "1000",
  uid: UID,
  ...over,
});

/** Every way `ps` can fail to answer. None of these may read as "the process is gone". */
const UNREADABLE: Array<[string, Error]> = [
  ["exit 1 with a diagnostic on stderr", psFailure({ stderr: "ps: nosuchkeyword: keyword not found\n" })],
  ["exit 1 with text on stdout", psFailure({ stdout: "%cpu %mem acflag acflg args\n" })],
  [
    "exit 1 with BOTH streams written (the real bad-keyword shape)",
    psFailure({ stdout: "%cpu %mem acflag\n", stderr: "ps: nosuchkeyword: keyword not found\n" }),
  ],
  ["exit 2", psFailure({ code: 2 })],
  ["exit 127 (launcher: not found)", psFailure({ code: 127 })],
  ["the timeout kill (no status, SIGKILL, killed)", psFailure({ code: null, signal: "SIGKILL", killed: true })],
  ["a signal with no output", psFailure({ code: null, signal: "SIGTERM" })],
  ["timed out, then exited 1 with silent output (killed flag alone)", psFailure({ killed: true })],
  ["exit 1 reported together with a signal (defensive)", psFailure({ signal: "SIGKILL" })],
  ["a missing /bin/ps: the native spawn ENOENT must NOT read as gone", psFailure({ code: "ENOENT", message: "spawn /bin/ps ENOENT" })],
  ["EAGAIN: the spawn itself failed", psFailure({ code: "EAGAIN" })],
  ["EMFILE: no descriptors left", psFailure({ code: "EMFILE" })],
  ["the stdout buffer overflowed", psFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })],
  ["a bare rejection with no execFile fields", new Error("boom")],
  ["exit 1 with no stdout/stderr fields at all", Object.assign(new Error("odd"), { code: 1 })],
];

// ---------------------------------------------------------------------------------------------
// readProcIdentity: gone vs unreadable
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F2: ps exit 1 with EMPTY stdout and EMPTY stderr is the one answer that reads as gone", async () => {
  const calls: Array<[string, string[]]> = [];
  const error = await assertRejects(
    () =>
      readProcIdentity(4242, {
        hasProc: false,
        run: (file, args) => {
          calls.push([file, args]);
          return Promise.reject(psFailure());
        },
      }),
    ProcessGoneError,
  );
  assertEquals(error.name, "ProcessGoneError");
  assertEquals(error.code, "ENOENT", "same shape as the missing /proc/<pid>/stat of the Linux branch");
  assertEquals(error.pid, 4242);
  assertEquals(error instanceof ProcessUnreadableError, false);
  assertEquals(calls.length, 1);
  assertEquals(calls[0][0], "/bin/ps");
  assert(calls[0][1].includes("-p") && calls[0][1].includes("4242"), `ps must be asked about the pid: ${calls[0][1]}`);
});

Deno.test("jjsz F2: every OTHER ps outcome is unreadable, never gone", async (t) => {
  for (const [name, failure] of UNREADABLE) {
    await t.step(name, async () => {
      const error = await assertRejects(
        () => readProcIdentity(77, { hasProc: false, run: rejecting(failure) }),
        ProcessUnreadableError,
      );
      assertEquals(error instanceof ProcessGoneError, false, "unreadable must never be confused with gone");
      assertEquals(error.name, "ProcessUnreadableError");
      assertEquals(error.code, "EPROCUNREADABLE");
      assertNotEquals(error.code, "ENOENT", "ENOENT is the gone/missing-binary vocabulary; unreadable must not borrow it");
      assertEquals(error.pid, 77);
      assertStrictEquals(error.cause, failure, "the underlying failure is kept for diagnosis");
    });
  }
});

Deno.test("jjsz F2: ps exit 0 with nothing parseable is unreadable, never gone", async (t) => {
  const outputs: Array<[string, string | undefined]> = [
    ["empty stdout", ""],
    ["whitespace only", "  \n \n"],
    ["a line that is not a process row", "not a process row at all\n"],
    ["a row that stops before the start time", "  1234 S 1 1234 501\n"],
    ["a non-numeric pid", `abc S 1 1234 501 ${C_LSTART}\n`],
    ["no stdout property at all", undefined],
  ];
  for (const [name, stdout] of outputs) {
    await t.step(name, async () => {
      const run: Run = stdout === undefined
        ? (() => Promise.resolve({} as { stdout: string; stderr: string }))
        : printing(stdout);
      const error = await assertRejects(
        () => readProcIdentity(1234, { hasProc: false, run }),
        ProcessUnreadableError,
      );
      assertEquals(error instanceof ProcessGoneError, false);
      assertEquals(error.pid, 1234);
    });
  }
});

Deno.test("jjsz F2: a healthy ps row parses to the documented identity", async () => {
  const ms = Date.parse("Wed Oct 7 12:26:48 2026");
  assert(Number.isFinite(ms), "fixture: this runtime must parse a C-locale lstart");
  const identity = await readProcIdentity(1234, {
    hasProc: false,
    run: printing(`  1234 S+     1  1234   ${UID} ${C_LSTART}\n`),
  });
  assertEquals(identity, {
    pid: 1234,
    state: "S",
    ppid: 1,
    pgid: 1234,
    sid: 1234,
    starttime: String(Math.floor(ms / 1000)),
    uid: UID,
  });
  const zombie = await readProcIdentity(1234, { hasProc: false, run: printing(psRow(1234, 1, 1234, UID, "Z+")) });
  assertEquals(zombie.state, "Z", "only the first state character is kept, so a zombie is recognisable");
});

Deno.test("jjsz F2: readProcIdentity picks its branch by hasProc, and the /proc branch never runs ps", async () => {
  const calls: string[] = [];
  const run: Run = (file) => {
    calls.push(file);
    return Promise.resolve({ stdout: psRow(Deno.pid, 1, Deno.pid), stderr: "" });
  };
  // /proc branch: ps is never consulted. On Linux it reads the real /proc entry, elsewhere the read fails
  // (there is no /proc); this test is about WHICH branch ran, so its outcome is deliberately ignored.
  await readProcIdentity(Deno.pid, { hasProc: true, run }).catch(() => undefined);
  assertEquals(calls, []);
  // ps branch: the same runner IS consulted.
  await readProcIdentity(Deno.pid, { hasProc: false, run });
  assertEquals(calls, ["/bin/ps"]);
});

// ---------------------------------------------------------------------------------------------
// F5: the session id is a copy, and what that does to the attestation
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F5: the no-/proc session id is a COPY of the process group id (documented, not measured)", async () => {
  // pid 1235 sits in group 1000 under parent 1: the copy must come from the group, not the pid or the parent.
  const identity = await readProcIdentity(1235, { hasProc: false, run: printing(psRow(1235, 1, 1000)) });
  assertEquals(identity.pgid, 1000);
  assertEquals(identity.sid, 1000, "sid is synthesised from pgid, because ps cannot print a session id");
  assertNotEquals(identity.sid, identity.pid);
  assertNotEquals(identity.sid, identity.ppid);
});

Deno.test("jjsz F5: the PGID/SID attestation proves only pgid and uid on the no-/proc branch", async () => {
  // macOS: pgid === pid is all that can be shown; sid === pgid by construction, so the sid half is vacuous.
  const mac = (pid: number) => readProcIdentity(pid, { hasProc: false, run: printing(psRow(4242, 1, 4242)) });
  const accepted = await attestOwnedGroup(4242, { expectedUid: UID, readIdentity: mac });
  assertEquals(accepted.ok, true, "a macOS group leader passes on pgid and uid alone");

  // The same pid and pgid on Linux, where /proc DOES report the session: a process that only did
  // setpgid(0, 0) (sid 999 != pid) is refused. This is the half macOS cannot check.
  const fields = Array.from({ length: 40 }, () => "0");
  Object.assign(fields, { 0: "S", 1: "1", 2: "4242", 3: "999", 19: "123456" });
  const linux = { ...parseProcStat(`4242 (runner) ${fields.join(" ")}`), uid: UID };
  assertEquals([linux.pid, linux.pgid, linux.sid], [4242, 4242, 999]);
  const refused = await attestOwnedGroup(4242, { expectedUid: UID, readIdentity: () => Promise.resolve(linux) });
  assertEquals(refused.ok, false);
  assertMatch(String(refused.reason), /sid=999/u, "the refusal names the session the /proc branch read");

  // The uid half is real on both platforms.
  const wrongUid = await attestOwnedGroup(4242, { expectedUid: UID + 1, readIdentity: mac });
  assertEquals(wrongUid.ok, false);
  // And so is pid === pgid.
  const notLeader = await attestOwnedGroup(4243, {
    expectedUid: UID,
    readIdentity: (pid) => readProcIdentity(pid, { hasProc: false, run: printing(psRow(4243, 1, 4242)) }),
  });
  assertEquals(notLeader.ok, false);
});

// ---------------------------------------------------------------------------------------------
// liveObservedResidue
// ---------------------------------------------------------------------------------------------

const observedOf = (...rows: ReturnType<typeof ident>[]) => new Map(rows.map((row) => [row.pid, row]));

Deno.test("jjsz F2: liveObservedResidue (no-/proc) — an unreadable ps is RESIDUE, a gone pid is clean", async () => {
  const observed = observedOf(ident(11));

  const unreadable = await liveObservedResidue(observed, {
    hasProc: false,
    readIdentity: () => Promise.reject(new Error("boom")),
  });
  assertEquals(unreadable.length, 1, "a process whose state could not be read must not be reported clean");
  assertEquals(unreadable[0].pid, 11);
  assertEquals(unreadable[0].starttime, "1000", "the receipt fields come from the observed row");
  assertEquals(unreadable[0].unverified, true);
  assertMatch(String(unreadable[0].unverifiedReason), /boom/u);

  const gone = await liveObservedResidue(observed, {
    hasProc: false,
    readIdentity: (pid) => Promise.reject(new ProcessGoneError(pid)),
  });
  assertEquals(gone, [], "ps ran and the pid is not there: that IS clean");

  const bounded = await liveObservedResidue(observed, {
    hasProc: false,
    readIdentity: () => Promise.reject(new Error("x".repeat(5000))),
  });
  assert(String(bounded[0].unverifiedReason).length <= 200, "the reason is bounded");
});

Deno.test("jjsz F2: liveObservedResidue — a live same-identity process is residue; zombies, reused pids and other uids are not", async (t) => {
  const expected = ident(11);
  const cases: Array<[string, Partial<ReturnType<typeof ident>>, boolean]> = [
    ["same pid, starttime and uid, state S", {}, true],
    ["same identity, state R", { state: "R" }, true],
    ["a zombie", { state: "Z" }, false],
    ["a REUSED pid (different starttime)", { starttime: "2000" }, false],
    ["another user's process on the same pid", { uid: UID + 1 }, false],
  ];
  for (const [name, change, live] of cases) {
    await t.step(name, async () => {
      const current = { ...expected, ...change };
      for (const hasProc of [false, true]) {
        const residue = await liveObservedResidue(observedOf(expected), {
          hasProc,
          readIdentity: () => Promise.resolve(current),
        });
        assertEquals(residue.length, live ? 1 : 0, `hasProc=${hasProc}`);
        if (live) assertStrictEquals(residue[0], current, "the CURRENT identity is reported, not the stale row");
      }
    });
  }
});

Deno.test("jjsz F2: liveObservedResidue — a mixed table reports exactly the unreadable and the live ones", async () => {
  const observed = observedOf(ident(11), ident(12), ident(13), ident(14));
  const residue = await liveObservedResidue(observed, {
    hasProc: false,
    readIdentity: (pid) => {
      if (pid === 11) return Promise.reject(new ProcessGoneError(pid)); // clean
      if (pid === 12) return Promise.reject(new ProcessUnreadableError(pid, "ps failed (ETIMEDOUT)")); // residue
      if (pid === 13) return Promise.resolve(ident(13)); // live: residue
      return Promise.resolve(ident(14, { state: "Z" })); // zombie: clean
    },
  });
  assertEquals(residue.map((r) => r.pid), [12, 13]);
  assertEquals(residue[0].unverified, true);
  assertEquals((residue[1] as { unverified?: boolean }).unverified, undefined, "a verified residue row is not marked");
  assertMatch(String(residue[0].unverifiedReason), /ETIMEDOUT/u, "the typed error's own detail is what is reported");
});

Deno.test("yuu9s: Linux /proc EMFILE/EACCES is unverified residue; only a vanished pid is gone", async () => {
  const observed = observedOf(ident(11));
  const coded = (code: string) => Object.assign(new Error(code), { code });
  for (const failure of [coded("EMFILE"), coded("EACCES"), new ProcessUnreadableError(11, "ps unreadable")]) {
    const residue = await liveObservedResidue(observed, { hasProc: true, readIdentity: () => Promise.reject(failure) });
    assertEquals(residue.length, 1, `${failure.message} must never mean gone`);
    assertEquals(residue[0].unverified, true);
    assertMatch(String(residue[0].unverifiedReason), new RegExp(failure.message));
  }
  for (const failure of [coded("ENOENT"), new ProcessGoneError(11)]) {
    assertEquals(await liveObservedResidue(observed, { hasProc: true, readIdentity: () => Promise.reject(failure) }), [],
      "an actual vanished process remains clean");
  }
});

Deno.test("jjsz F2: liveObservedResidue end to end through readProcIdentity — silent exit 1 is clean, every other failure is residue", async (t) => {
  const observed = observedOf(ident(31, { starttime: String(Math.floor(Date.parse("Wed Oct 7 12:26:48 2026") / 1000)) }));
  const through = (run: Run) => ({
    hasProc: false,
    readIdentity: (pid: number) => readProcIdentity(pid, { hasProc: false, run }),
  });
  assertEquals(await liveObservedResidue(observed, through(rejecting(psFailure()))), []);
  for (const [name, failure] of UNREADABLE) {
    await t.step(name, async () => {
      const residue = await liveObservedResidue(observed, through(rejecting(failure)));
      assertEquals(residue.length, 1, "an unreadable ps must be residue");
      assertEquals(residue[0].unverified, true);
    });
  }
  // The anti-vacuity control: the same plumbing reports a really-live process as residue and a zombie as clean.
  const live = await liveObservedResidue(observed, through(printing(psRow(31, 1, 31))));
  assertEquals(live.map((r) => r.pid), [31]);
  assertEquals(await liveObservedResidue(observed, through(printing(psRow(31, 1, 31, UID, "Z")))), []);
});

// ---------------------------------------------------------------------------------------------
// procIdentities / observeDescendants
// ---------------------------------------------------------------------------------------------

Deno.test("jjsz F2: procIdentities rejects when ps fails — it no longer turns a failure into an empty table", async (t) => {
  for (const [name, failure] of UNREADABLE) {
    await t.step(name, async () => {
      const error = await assertRejects(
        () => procIdentities({ hasProc: false, run: rejecting(failure) }),
        ProcessUnreadableError,
      );
      assertEquals(error.pid, null, "a table read has no pid");
      assertStrictEquals(error.cause, failure);
    });
  }
});

Deno.test("jjsz F2: procIdentities rejects a ps that exits 0 with no parseable row", async (t) => {
  for (
    const [name, stdout] of [
      ["empty stdout", ""],
      ["only whitespace", "\n  \n"],
      ["only garbage", "garbage\nmore garbage\n"],
      ["only rows that cannot parse", `  100 S 1 100 -2 ${C_LSTART}\n`],
    ] as const
  ) {
    await t.step(name, async () => {
      await assertRejects(
        () => procIdentities({ hasProc: false, run: printing(stdout) }),
        ProcessUnreadableError,
      );
    });
  }
  await assertRejects(
    () => procIdentities({ hasProc: false, run: () => Promise.resolve({} as { stdout: string; stderr: string }) }),
    ProcessUnreadableError,
  );
});

Deno.test("jjsz F2: procIdentities tolerates rows that do not parse as long as some do", async () => {
  // Measured on macOS 15.8: a handful of rows of a healthy table fail the parser (uid prints as -2 for the
  // `nobody` account), and none of them can be this runner's descendant. They must not poison the table.
  const rows = await procIdentities({
    hasProc: false,
    run: printing(psTable(psRow(1, 0, 1), `  200 S 1 200 -2 ${C_LSTART}`, "junk", psRow(300, 1, 300))),
  });
  assertEquals(rows.map((r) => r.pid), [1, 300]);
});

Deno.test("jjsz F2: procIdentities picks its branch by hasProc, and the /proc branch never runs ps", async () => {
  const calls: string[] = [];
  const run: Run = (file) => {
    calls.push(file);
    return Promise.reject(psFailure({ code: 2 }));
  };
  // Inject a real-looking /proc row so this branch works on hosts without /proc too.
  const viaProc = await procIdentities({ hasProc: true, run,
    listProcNames: async () => ["11"], readIdentity: async () => ident(11) });
  assertEquals(viaProc.map((row: { pid: number }) => row.pid), [11]);
  assertEquals(calls, []);
  // ps branch: the same runner IS consulted, and its failure now rejects.
  await assertRejects(() => procIdentities({ hasProc: false, run }), ProcessUnreadableError);
  assertEquals(calls, ["/bin/ps"]);
});

Deno.test("yuu9s: readable Linux kernel threads with group/session zero do not poison custody sampling", async () => {
  const raw = (pid: number, ppid: number) =>
    `${pid} (kernel thread) ${["I", String(ppid), "0", "0", ...Array(15).fill("0"), "1000"].join(" ")}`;
  assertEquals(parseProcStat(raw(2, 0)).pgid, 0, "kthreadd has no userspace process group");
  assertEquals(parseProcStat(raw(100, 2)).sid, 0, "a direct kernel-thread child has no session");
  if (Deno.build.os === "linux") {
    const rows = await procIdentities();
    assert(rows.length > 0, "a readable real /proc must produce a process table, not an empty answer");
  }
});

Deno.test("yuu9s: Linux table listing or identity EMFILE rejects, while per-pid ENOENT is normal churn", async () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  const listed = { hasProc: true, listProcNames: async () => ["11", "12"],
    readIdentity: async (pid: number) => pid === 11 ? ident(11) : Promise.reject(coded("EMFILE")) };
  const unreadable = await assertRejects(() => procIdentities(listed), ProcessUnreadableError);
  assertMatch(unreadable.message, /EMFILE/);
  const observed = observedOf(ident(555));
  await assertRejects(() => observeDescendants(11, observed, listed), ProcessUnreadableError);
  assertEquals([...observed.keys()], [555], "a failed scan must not change the observed set");
  const listing = await assertRejects(() => procIdentities({ hasProc: true,
    listProcNames: async () => Promise.reject(coded("EMFILE")) }), ProcessUnreadableError);
  assertMatch(listing.message, /EMFILE/);
  const churn = await procIdentities({ ...listed,
    readIdentity: async (pid: number) => pid === 11 ? ident(11) : Promise.reject(coded("ENOENT")) });
  assertEquals(churn.map((row: { pid: number }) => row.pid), [11]);
});

Deno.test("jjsz F2: observeDescendants rejects on an unreadable table and leaves `observed` untouched", async () => {
  const observed = observedOf(ident(555));
  const before = JSON.stringify([...observed]);
  await assertRejects(
    () => observeDescendants(100, observed, { hasProc: false, run: rejecting(psFailure({ code: null, signal: "SIGKILL", killed: true })) }),
    ProcessUnreadableError,
  );
  await assertRejects(() => observeDescendants(100, observed, { hasProc: false, run: printing("") }), ProcessUnreadableError);
  assertEquals(JSON.stringify([...observed]), before, "a failed sample must not alter what was already observed");
});

Deno.test("jjsz F2: observeDescendants walks the ppid chain over one sample", async () => {
  const observed = new Map();
  const result = await observeDescendants(100, observed, {
    hasProc: false,
    run: printing(
      psTable(
        psRow(1, 0, 1),
        psRow(100, 1, 100),
        psRow(101, 100, 100),
        psRow(102, 101, 102),
        psRow(103, 102, 102),
        psRow(200, 1, 200),
        psRow(201, 200, 200),
      ),
    ),
  });
  assertStrictEquals(result, observed);
  assertEquals([...observed.keys()].sort(), [101, 102, 103], "descendants only: not the root, not unrelated processes");
  assertEquals(observed.get(102).pgid, 102);
});

// ---------------------------------------------------------------------------------------------
// terminateAttestedGroup stays fail-closed (REAL detached leader; the table and the leader read are seams)
// ---------------------------------------------------------------------------------------------

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A real process-group leader (detached = setsid) that is always killed and reaped afterwards. */
async function withLeader<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const pid = child.pid;
  if (!pid) throw new Error("fixture: the leader did not start");
  try {
    return await fn(pid);
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch { /* already gone */ }
    await exited;
  }
}

Deno.test({
  name: "jjsz F2: terminateAttestedGroup refuses to signal when the leader is unreadable and the table is not trustworthy",
  ignore: !isFile("/bin/sleep"),
  fn: async (t) => {
    type Scenario = {
      list: () => Promise<unknown[]>;
      observed: Map<number, ReturnType<typeof ident>>;
    };
    const scenarios: Array<[string, (leader: ReturnType<typeof ident>) => Scenario]> = [
      [
        "the process table is unreadable (ps timed out)",
        () => ({
          list: () =>
            procIdentities({ hasProc: false, run: rejecting(psFailure({ code: null, signal: "SIGKILL", killed: true })) }),
          observed: new Map(),
        }),
      ],
      [
        "the table reads as an empty group",
        () => ({ list: () => Promise.resolve([]), observed: new Map() }),
      ],
      [
        "a live group member was never observed",
        (leader) => ({ list: () => Promise.resolve([leader]), observed: new Map() }),
      ],
      [
        "a group member was observed under another start time",
        (leader) => ({
          list: () => Promise.resolve([leader]),
          observed: new Map([[leader.pid, { ...leader, starttime: "999" }]]),
        }),
      ],
      [
        "a group member was observed under another uid",
        (leader) => ({
          list: () => Promise.resolve([leader]),
          observed: new Map([[leader.pid, { ...leader, uid: UID + 1 }]]),
        }),
      ],
    ];
    for (const [name, build] of scenarios) {
      await t.step(name, async () => {
        await withLeader(async (pid) => {
          const leader = ident(pid);
          const { list, observed } = build(leader);
          const leaderError = new ProcessGoneError(pid);
          const error = await assertRejects(() =>
            terminateAttestedGroup({
              attestation: { ok: true, identity: leader },
              observed,
              termWaitMs: 500,
              killWaitMs: 500,
              readIdentity: () => Promise.reject(leaderError),
              listIdentities: list,
            })
          );
          assertStrictEquals(error, leaderError, "the ORIGINAL leader error is what the caller sees");
          assertEquals(groupAlive(pid), true, "nothing may have been signalled");
        });
      });
    }

    await t.step("CONTROL: the same leader loss with every member observed DOES signal the group", async () => {
      await withLeader(async (pid) => {
        const leader = ident(pid);
        const result = await terminateAttestedGroup({
          attestation: { ok: true, identity: leader },
          observed: new Map([[pid, leader]]),
          termWaitMs: 3000,
          killWaitMs: 3000,
          readIdentity: () => Promise.reject(new ProcessGoneError(pid)),
          listIdentities: () => Promise.resolve([leader]),
        });
        assertEquals(result, { termSent: true, killSent: false, survived: false });
        assertEquals(groupAlive(pid), false, "the group is gone");
      });
    });

    await t.step("a leader whose identity changed under the same pid is refused with the identity error", async () => {
      await withLeader(async (pid) => {
        const leader = ident(pid);
        const error = await assertRejects(() =>
          terminateAttestedGroup({
            attestation: { ok: true, identity: leader },
            observed: new Map(),
            termWaitMs: 500,
            killWaitMs: 500,
            readIdentity: () => Promise.resolve({ ...leader, starttime: "other" }),
            listIdentities: () => Promise.resolve([]),
          })
        );
        assertMatch(String((error as Error).message), /owned process-group identity changed/u);
        assertEquals(groupAlive(pid), true);
      });
    });
  },
});

// ---------------------------------------------------------------------------------------------
// The REAL ps
// ---------------------------------------------------------------------------------------------

// The capability probes are RAW ps calls, never the library under test: a regression in the library's own
// read must turn these tests RED, not silently IGNORE them.
const REAL_PS_CAPABLE = (() => {
  try {
    const probe = spawnSync("/bin/ps", ["-o", "pid=,state=,ppid=,pgid=,uid=,lstart=", "-p", String(Deno.pid)], {
      encoding: "utf8",
    });
    return probe.status === 0 && /^\s*\d+\s+\S+\s+\d+\s+\d+\s+\d+\s+\S.*\d{4}\s*$/u.test(String(probe.stdout));
  } catch {
    return false;
  }
})();

const REAL_PS_GONE_SILENT = (() => {
  if (!REAL_PS_CAPABLE) return false;
  try {
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid;
    const probe = spawnSync("/bin/ps", ["-o", "pid=,state=,ppid=,pgid=,uid=,lstart=", "-p", String(dead)], {
      encoding: "utf8",
    });
    return probe.status === 1 && probe.stdout === "" && probe.stderr === "";
  } catch {
    return false;
  }
})();

Deno.test({
  name: "jjsz F2: REAL ps — our own pid reads, stably",
  ignore: !REAL_PS_CAPABLE,
  fn: async () => {
    const first = await readProcIdentity(Deno.pid, { hasProc: false });
    const second = await readProcIdentity(Deno.pid, { hasProc: false });
    assertEquals(first.pid, Deno.pid);
    assertEquals(first.uid, UID);
    assertNotEquals(first.state, "Z");
    assertMatch(first.starttime, /^\d+$/u);
    assertEquals(second.starttime, first.starttime, "two reads of one live process agree on its start time");
  },
});

Deno.test({
  name: "jjsz F2: REAL ps — an absent pid is GONE (exit 1, silent output)",
  ignore: !REAL_PS_GONE_SILENT,
  fn: async () => {
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]).pid as number;
    const error = await assertRejects(() => readProcIdentity(dead, { hasProc: false }), ProcessGoneError);
    assertEquals(error.code, "ENOENT");
    assertEquals(error.pid, dead);
  },
});

Deno.test({
  name: "jjsz F2: REAL ps — the table lists us, observes a real child, and reports it only while it lives",
  ignore: !REAL_PS_CAPABLE || !REAL_PS_GONE_SILENT || !isFile("/bin/sleep"),
  fn: async () => {
    const noProc = { hasProc: false };
    const readIdentity = (pid: number) => readProcIdentity(pid, noProc);
    const child = new Deno.Command("/bin/sleep", { args: ["30"], stdout: "null", stderr: "null" }).spawn();
    try {
      const rows = await procIdentities(noProc);
      assert(rows.some((row) => row.pid === Deno.pid), "the table must list this process");
      const observed = new Map();
      await observeDescendants(Deno.pid, observed, noProc);
      assert(observed.has(child.pid), "the spawned child is a descendant");
      assertEquals(observed.has(Deno.pid), false, "the root is not its own descendant");

      const during = await liveObservedResidue(observed, { hasProc: false, readIdentity });
      assert(during.some((row) => row.pid === child.pid), "a live child is residue");
      assertEquals(during.filter((row) => row.pid === child.pid && row.unverified), [], "and it was VERIFIED, not guessed");

      child.kill("SIGKILL");
      await child.status;
      const after = await liveObservedResidue(observed, { hasProc: false, readIdentity });
      assertEquals(after.some((row) => row.pid === child.pid), false, "a reaped child is gone, which is clean");
      assertEquals(after.filter((row) => row.unverified), [], "no pid was left unverified on a healthy ps");
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    }
  },
});

Deno.test({
  name: "jjsz F2: REAL ps — a detached leader attests and is terminated through the no-/proc reads",
  ignore: !REAL_PS_CAPABLE || !isFile("/bin/sleep"),
  fn: async () => {
    await withLeader(async (pid) => {
      const readIdentity = (p: number) => readProcIdentity(p, { hasProc: false });
      const attestation = await attestOwnedGroup(pid, { readIdentity });
      assertEquals(attestation.ok, true, JSON.stringify(attestation));
      const result = await terminateAttestedGroup({
        attestation,
        observed: new Map(),
        termWaitMs: 3000,
        killWaitMs: 3000,
        readIdentity,
        listIdentities: () => procIdentities({ hasProc: false }),
      });
      assertEquals(result, { termSent: true, killSent: false, survived: false });
      assertEquals(groupAlive(pid), false);
    });
  },
});

// A wedged ps must not hang custody. The runner is bounded and killed with SIGKILL; the fixture ignores
// SIGTERM, so a runner that fell back to the default kill signal would wait out the whole sleep.
const WEDGED = ["-c", "trap '' TERM; exec /bin/sleep 6"];

Deno.test({
  name: "jjsz F2: REAL wedged ps — the bound kills it (SIGKILL) and the outcome is unreadable, never gone",
  ignore: !isFile("/bin/sh") || !isFile("/bin/sleep"),
  fn: async () => {
    const run = makePsRun(150);
    const started = Date.now();
    const failure = await assertRejects(() => run("/bin/sh", WEDGED));
    const elapsed = Date.now() - started;
    assert(elapsed < 4000, `the wedged child must be cut off at the bound, not waited out (${elapsed} ms)`);
    const shape = failure as { code?: unknown; signal?: unknown; killed?: unknown };
    assertEquals(shape.killed, true);
    assertEquals(shape.signal, "SIGKILL");
    assertNotEquals(shape.code, 1, "a timeout kill must not look like `ps` exiting 1");

    // Fed through the library: the REAL timeout rejection reads as unreadable, in both entry points.
    await assertRejects(
      () => readProcIdentity(1, { hasProc: false, run: () => makePsRun(150)("/bin/sh", WEDGED) }),
      ProcessUnreadableError,
    );
    await assertRejects(
      () => procIdentities({ hasProc: false, run: () => makePsRun(150)("/bin/sh", WEDGED) }),
      ProcessUnreadableError,
    );
  },
});

Deno.test({
  name: "jjsz F2: the default ps runner survives a table bigger than execFile's default buffer",
  ignore: !isFile("/bin/sh"),
  fn: async () => {
    // 2 MB of output: plain execFile's default 1 MiB buffer rejects this, which on a huge process table
    // used to be swallowed into an empty table.
    const out = await makePsRun()("/bin/sh", ["-c", "head -c 2000000 /dev/zero | tr '\\0' a"]);
    assertEquals(out.stdout.length, 2_000_000);
  },
});

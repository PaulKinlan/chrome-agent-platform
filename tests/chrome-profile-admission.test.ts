// vk1t: bounded managed-profile admission, with NO dead-lock deletion.
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { durableRoot } from "../scripts/lib/durable-root.mjs";
import {
  chromeProfileDir, MAX_CHROME_PROFILE_DIRS, PROFILE_ROOT_NAME,
  profileLiveness, reportChromeProfileDirs,
} from "../scripts/lib/chrome-profile-dir.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PID_MAX = (() => {
  try { return Number(Deno.readTextFileSync("/proc/sys/kernel/pid_max").trim()); }
  catch { return 4_194_304; }
})();
const DEAD_PID = PID_MAX + 1;

Deno.test("vk1t: dead-lock evidence names creator, owner PID and age but never deletes a live or unknown profile", () => {
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-report-fixture-${Deno.pid}-${Date.now()}`;
  Deno.mkdirSync(root, { recursive: true });
  try {
    const stale = chromeProfileDir("report-dead", { root, maxEntries: 4 });
    const live = chromeProfileDir("report-live", { root, maxEntries: 4 });
    const foreign = chromeProfileDir("report-foreign", { root, maxEntries: 4 });
    Deno.symlinkSync(`${hostname()}-${DEAD_PID}`, `${stale}/SingletonLock`);
    Deno.symlinkSync(`${hostname()}-${Deno.pid}`, `${live}/SingletonLock`);
    Deno.symlinkSync(`other-host-${DEAD_PID}`, `${foreign}/SingletonLock`);
    const now = Date.now();
    Deno.utimeSync(stale, new Date(now - 7 * 60 * 60_000), new Date(now - 7 * 60 * 60_000));
    const report = reportChromeProfileDirs({ root, now });
    assertEquals(report.directories, 3);
    assertEquals(report.live, 1);
    assertEquals(report.unknown, 2, "dead/foreign locks retain the conservative unknown state");
    assertEquals(report.stale.length, 1);
    const evidence = report.stale[0];
    assertEquals(evidence.ownerHost, hostname());
    assertEquals(evidence.ownerPid, DEAD_PID);
    assertEquals(evidence.pidStatus, "dead");
    assertEquals(evidence.liveness, "unknown", "dead owner is NOT deletion authorization");
    assertEquals(evidence.createdBy, "report-dead");
    assertEquals(evidence.createdPid, Deno.pid);
    assert((evidence.ageMs ?? 0) >= 6 * 60 * 60_000, "age is reported");
    assertEquals(profileLiveness(stale), "unknown");
    assertEquals(Deno.statSync(stale).isDirectory, true, "dead-locked profile remains on disk");
    assertEquals(Deno.statSync(live).isDirectory, true, "LIVE profile is never removed by inventory");
    assertEquals(Deno.statSync(foreign).isDirectory, true, "foreign-host profile remains unknown");
    assertThrows(() => chromeProfileDir("over-cap", { root, maxEntries: 3 }), Error, "admission cap 3 reached");
    assertEquals(reportChromeProfileDirs({ root }).directories, 3, "refusal did not create a fourth directory");
  } finally {
    Deno.removeSync(root, { recursive: true }); // isolated synthetic fixture ONLY
  }
});

Deno.test("vk1t: concurrent creators cannot exceed cap; a free slot is reusable without evicting survivors", async () => {
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-parallel-fixture-${Deno.pid}-${Date.now()}`;
  Deno.mkdirSync(root, { recursive: true });
  try {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", `${ROOT}deno.runner.jsonc`, `${ROOT}tests/fixtures/profile-admission-worker.ts`, root, "3"],
        stdout: "piped", stderr: "piped",
      }).output()
    ));
    assertEquals(outcomes.filter((x) => x.code === 0).length, 3, "three creators admitted exactly");
    assertEquals(outcomes.filter((x) => x.code === 20).length, 5,
      `remaining creators refused: ${outcomes.map((x) => x.code).join(",")}`);
    assertEquals(reportChromeProfileDirs({ root }).directories, 3, "cross-process flock covers count AND mkdir");
    const first = [...Deno.readDirSync(root)].find((e) => e.isDirectory);
    assert(first, "at least one created profile exists");
    Deno.removeSync(`${root}/${first.name}`, { recursive: true }); // synthetic fixture, no Chrome
    const replacement = chromeProfileDir("replacement", { root, maxEntries: 3 });
    assertEquals(Deno.statSync(replacement).isDirectory, true);
    assertEquals(reportChromeProfileDirs({ root }).directories, 3);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("vk1t: admission refuses invalid caps, symlinked roots and wrong-level roots before creation", () => {
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-guard-fixture-${Deno.pid}-${Date.now()}`;
  const link = `${durableRoot()}/${PROFILE_ROOT_NAME}-link-fixture-${Deno.pid}-${Date.now()}`;
  Deno.mkdirSync(root, { recursive: true });
  try {
    for (const cap of [0, -1, 1.5, MAX_CHROME_PROFILE_DIRS + 1, Infinity, NaN]) {
      assertThrows(() => chromeProfileDir("invalid", { root, maxEntries: cap }), Error, "maxEntries must be an integer");
    }
    assertThrows(() => chromeProfileDir("invalid", { root: durableRoot() }), Error, "fixture root must be a direct");
    Deno.symlinkSync(root, link, { type: "dir" });
    assertThrows(() => chromeProfileDir("invalid", { root: link }), Error, "refusing symlinked root");
    assertEquals(reportChromeProfileDirs({ root }).directories, 0, "refusals leave no profiles");
  } finally {
    try { Deno.removeSync(link); } catch { /* absent */ }
    Deno.removeSync(root, { recursive: true });
  }
});

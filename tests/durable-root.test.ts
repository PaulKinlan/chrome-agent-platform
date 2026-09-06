// tests/durable-root.test.ts — bead chp: evidence/scratch off the RAM-backed
// tmpfs. Two halves: (1) the shared helper's behavior (default root, tmpfs
// refusal, loud failure when the durable location is unavailable — never a
// silent fall back to /tmp); (2) a static guard that no script/test still
// defaults retained evidence or big scratch to /tmp (allowlist: tiny
// cross-process coordination files and test fixtures).
import { assert, assertEquals, assertThrows, assertStringIncludes } from "jsr:@std/assert@1";
import { isRamBacked, durableRoot, durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("isRamBacked identifies the tmpfs /tmp and disk-backed $HOME", () => {
  assertEquals(isRamBacked("/tmp"), true, "/tmp is tmpfs on the build host");
  assertEquals(isRamBacked("/dev/shm"), true, "/dev/shm is tmpfs");
  assertEquals(isRamBacked(Deno.env.get("HOME") ?? "/home"), false, "$HOME is disk");
});

Deno.test("durableRoot defaults to $HOME/cap-evidence (durable), honoring CAP_DURABLE_ROOT", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    Deno.env.delete("CAP_DURABLE_ROOT");
    assertEquals(durableRoot(), `${Deno.env.get("HOME")}/cap-evidence`);
    Deno.env.set("CAP_DURABLE_ROOT", "/home/paulkinlan/cap-evidence-test-probe");
    assertEquals(durableRoot(), "/home/paulkinlan/cap-evidence-test-probe");
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
});

Deno.test("durableRoot treats an EMPTY CAP_DURABLE_ROOT as unset — never a relative CWD path", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    // CAP_DURABLE_ROOT="" is the classic result of shell parameter expansion
    // of an unset var; ?? alone keeps "", and join("", …) would then yield a
    // RELATIVE path silently (review P2 on 62696628). Pin: empty/whitespace
    // means unset → the default.
    Deno.env.set("CAP_DURABLE_ROOT", "");
    assertEquals(durableRoot(), `${Deno.env.get("HOME")}/cap-evidence`);
    Deno.env.set("CAP_DURABLE_ROOT", "   ");
    assertEquals(durableRoot(), `${Deno.env.get("HOME")}/cap-evidence`);
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
});

Deno.test("durableRoot THROWS on a RAM-backed root — no silent tmpfs fallback", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    Deno.env.set("CAP_DURABLE_ROOT", "/tmp/cap-chp-must-refuse");
    const err = assertThrows(() => durableRoot());
    assertStringIncludes((err as Error).message, "RAM-backed");
    Deno.env.set("CAP_DURABLE_ROOT", "/dev/shm/cap-chp-must-refuse");
    assertThrows(() => durableRoot());
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
});

Deno.test("durableDir fails loudly when the durable location is unavailable", () => {
  const saved = Deno.env.get("CAP_DURABLE_ROOT");
  try {
    // /proc is a read-only virtual filesystem: mkdir MUST fail, and the error
    // must surface (this is the bead's falsification: evidence does NOT
    // silently land back on /tmp when the durable location is gone).
    Deno.env.set("CAP_DURABLE_ROOT", "/proc/cap-chp-impossible");
    assertThrows(() => durableDir("probe"));
  } finally {
    if (saved === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
    else Deno.env.set("CAP_DURABLE_ROOT", saved);
  }
});

// --- Static guard: no script/test defaults retained evidence or big scratch
// to a /tmp literal. Allowlist (tiny + ephemeral by design):
//   cap-serialized-chrome-acceptance.lock — cross-process LOCK file; tmpfs
//     means a reboot clears a stale lock (a feature, and 1 inode).
//   cap-chrome-slot-<N>.lock — the bounded-concurrency semaphore's slot files
//     (chrome-agent-platform-uzik): one inode each, tiny, cross-process, and a
//     reboot clearing a stale slot is the same feature as for the lock above.
//   cap-chrome-slot-POISON — RETIRED by uzik (it closed yr6e). The literal is
//     allowlisted only so the custody guard test can assert the marker never
//     comes back; nothing writes it any more.
//   hostile-runner / not-the-canonical-lock — negative test fixtures.
const ALLOWED = new Set([
  "/tmp/cap-serialized-chrome-acceptance.lock",
  "/tmp/cap-chrome-slot-0.lock",
  "/tmp/cap-chrome-slot-POISON",
  "/tmp/hostile-runner.mjs",
  "/tmp/not-the-canonical-lock",
]);

Deno.test("guard: no /tmp evidence/scratch literals outside the allowlist", () => {
  const offenders: string[] = [];
  const LITERAL = /(\/tmp\/(?:cap|kat|gvs|repro|sidepanel|live-run)-[^"'`\s]*)/g;
  for (const dir of ["scripts", "tests"]) {
    for (const entry of Deno.readDirSync(`${ROOT}${dir}`)) {
      if (!/\.(ts|mjs)$/.test(entry.name)) continue;
      if (dir === "tests" && entry.name === "durable-root.test.ts") continue;
      const text = Deno.readTextFileSync(`${ROOT}${dir}/${entry.name}`);
      for (const m of text.matchAll(LITERAL)) {
        if (!ALLOWED.has(m[1])) offenders.push(`${dir}/${entry.name}: ${m[1]}`);
      }
    }
  }
  assertEquals(offenders, [], "evidence/scratch literals on tmpfs outside the allowlist");
});

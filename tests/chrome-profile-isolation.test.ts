// tests/chrome-profile-isolation.test.ts — chrome-agent-platform-uzik
//
// De-serializing the browser gates is only safe because every launch is
// ISOLATED: a kernel-assigned debugging port (pinned by
// tests/harness-debug-port.test.ts) and its own `--user-data-dir`. The port
// half was already true by construction. The profile half was true by
// convention — and convention does not survive concurrency.
//
// Two runs sharing a profile do not merely race. Chrome's SingletonLock makes
// the second launch fail or attach to the FIRST run's browser, and one run's
// cleanup sweep then deletes the other's live profile. Under the old
// one-browser-at-a-time lock that could not happen; under a bounded semaphore
// it can. So this file makes per-instance profiles a checked property instead
// of a habit:
//
//   - every `--user-data-dir=` launch site in scripts/ must resolve to a value
//     carrying a per-instance token (Date.now(), a randomUUID, a temp dir, a
//     pid, or `instanceProfile()`), following the identifier chain two levels;
//   - the only sites allowed to name a bare parameter are the launcher itself
//     and the two harnesses whose callers are checked at their own call site —
//     each with the reason recorded below, so a new exemption is a diff a
//     reviewer has to read;
//   - `instanceProfile()` itself must be unique per call and must not double
//     separators on a base that already ends in one.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { instanceProfile } from "../scripts/lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPTS = `${ROOT}scripts`;

/** A per-instance token. Granularity matters: `const STAMP = Date.now()`
 *  counts (harnesses bind it once and reuse it), but a SECOND-granularity stamp
 *  does NOT — two lanes starting the same harness in the same second collide,
 *  and an operator knob (`HEADED_EVIDENCE_DIR`, `Deno.args[1]`) can pin the base
 *  dir entirely, which is precisely how two runs end up sharing one live
 *  profile. Those sites use `instanceProfile()` (pid + ms + random). */
const UNIQUE = /Date\.now\(\)|randomUUID|makeTempDir|mkdtemp|Deno\.pid|performance\.now|instanceProfile|\bSTAMP\b/u;

/** Sites allowed to name a bare parameter. An exemption is only as good as its
 *  justification, so each one carries the source patterns that MUST still be
 *  true elsewhere in the same file — otherwise "the caller makes it unique" is
 *  an unverified claim, and reverting the caller silently reopens the hole
 *  (found by falsification: reverting `instanceProfile(EVIDENCE_DIR)` to
 *  `${EVIDENCE_DIR}/profile` left this suite GREEN). */
const ALLOWED_PARAMETER_SITES = new Map<string, { reason: string; requires: RegExp[] }>([
  ["lib/chrome-launch.ts|${opts.profile}", {
    reason: "the launcher's own parameter — every caller's profile is checked at the caller's site",
    requires: [/export function instanceProfile/u],
  }],
  ["permission-matrix-acceptance.ts|${profile}", {
    reason: "startChrome(profile) parameter; the call sites build profileA/profileB per instance",
    requires: [
      /const profileA = durableDir\(`cap-perm-matrix-a-\$\{Date\.now\(\)\}`\)/u,
      /const profileB = durableDir\(`cap-perm-matrix-b-\$\{Date\.now\(\)\}`\)/u,
    ],
  }],
  ["headed-acceptance.ts|${profile}", {
    reason: "launchHeadedChrome(profile) parameter; the caller passes instanceProfile(EVIDENCE_DIR)",
    requires: [/const profile = instanceProfile\(EVIDENCE_DIR\)/u],
  }],
]);

function scriptFiles(dir = SCRIPTS, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.isDirectory) out.push(...scriptFiles(`${dir}/${e.name}`, `${prefix}${e.name}/`));
    else if (e.name.endsWith(".ts")) out.push(`${prefix}${e.name}`);
  }
  return out;
}

/** name → the full text of its initializer, multi-line aware. */
function assignments(src: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);/gu)) {
    const list = map.get(m[1]) ?? [];
    list.push(m[2]);
    map.set(m[1], list);
  }
  return map;
}

Deno.test("uzik: every Chrome profile in scripts/ is per-instance", () => {
  const offenders: string[] = [];
  let sites = 0;
  for (const rel of scriptFiles()) {
    const src = Deno.readTextFileSync(`${SCRIPTS}/${rel}`);
    const vars = assignments(src);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const at = line.indexOf("--user-data-dir=");
      if (at < 0) return;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      sites++;
      const rest = line.slice(at + "--user-data-dir=".length);
      // The value ends at the template/quote terminator or the argv separator;
      // trailing punctuation is not part of it.
      const value = rest
        .split(/[`'"]/u)[0]
        .split(",")[0]
        .replace(/[\s)\];]+$/u, "")
        .trim();
      const key = `${rel}|${value}`;
      if (ALLOWED_PARAMETER_SITES.has(key)) return;
      if (UNIQUE.test(value)) return;
      // Follow the identifier chain two levels (a harness binds `const profile
      // = \`${OUT}/profile-${STAMP}\`` and `const STAMP = Date.now()`).
      let names = new Set<string>(value.match(/[A-Za-z_$][\w$]*/gu) ?? []);
      for (let depth = 0; depth < 2; depth++) {
        let found = false;
        for (const name of [...names]) {
          for (const rhs of vars.get(name) ?? []) {
            if (UNIQUE.test(rhs)) { found = true; break; }
            for (const n2 of rhs.match(/[A-Za-z_$][\w$]*/gu) ?? []) names.add(n2);
          }
          if (found) break;
        }
        if (found) return;
      }
      offenders.push(`${rel}:${i + 1} → ${value}`);
    });
  }
  assert(sites > 50, `the scan found the launch sites (${sites})`);
  assertEquals(
    offenders,
    [],
    "a Chrome profile is not per-instance — two concurrent runs would share a live profile " +
      "(SingletonLock: the second launch attaches to the first, and one run's cleanup deletes " +
      "the other's). Use instanceProfile() from scripts/lib/chrome-launch.ts:\n" + offenders.join("\n"),
  );
});

Deno.test("uzik: ALLOWED_PARAMETER_SITES entries still exist AND their justification still holds", () => {
  // An exemption that outlives its site — or whose "the caller makes it unique"
  // claim stops being true — is a hole nobody can see. Check both halves.
  for (const [key, { reason, requires }] of ALLOWED_PARAMETER_SITES) {
    const [rel, value] = key.split("|");
    const src = Deno.readTextFileSync(`${SCRIPTS}/${rel}`);
    assert(
      src.includes(`--user-data-dir=${value}`),
      `exemption no longer matches a launch site: ${key}`,
    );
    for (const pattern of requires) {
      assert(
        pattern.test(src),
        `exemption ${key} lost its justification (${reason}): ${pattern} no longer matches ${rel}`,
      );
    }
  }
});

Deno.test("uzik: instanceProfile is unique per call and joins the base cleanly", () => {
  // A real base dir, not a /tmp literal: tests/durable-root.test.ts guards
  // against tmpfs literals in tests/ and this needs none.
  const base = `${Deno.env.get("TMPDIR") ?? "/tmp"}/uzik-instance-profile-base`;
  const a = instanceProfile(base);
  const b = instanceProfile(base);
  assert(a !== b, "two calls in the same millisecond must still differ");
  assert(a.startsWith(`${base}/profile-`), `shape: ${a}`);
  assert(!a.includes("//profile"), "no doubled separator");
  // A base that already ends in a separator must not produce `//`.
  const c = instanceProfile(`${base}/`);
  assert(!c.includes("//profile"), `trailing slash handled: ${c}`);
  // The pid is in there, so two lanes cannot collide on the same base.
  assert(a.includes(`-${Deno.pid}-`), `carries the pid: ${a}`);
  // A custom leaf name is honoured.
  assertEquals(instanceProfile(base, "prof").split("/").pop()!.startsWith("prof-"), true);
});

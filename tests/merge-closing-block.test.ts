// Tests for scripts/merge-closing-block.sh — the atomic assert-then-act block that gates a landing
// push (chrome-agent-platform-jfbn).
//
// Two layers, deliberately separated by the script's own `--classify` mode:
//   * PARSER cases feed SYNTHETIC captured output, which is the only way to prove the branch ORDER
//     (an output containing BOTH '[rejected]' and an update row must decide REFUSED).
//   * LIVE cases run the block against a throwaway bare repo, so five of the six codes are produced
//     by real git output rather than by strings this test wrote. The push stays stubbed
//     (PUSH_MODE=stub), and controls assert that neither the target refs nor any probe ref moved.
//
// The explicit-40-char-sha parser case is the guard for the correction this script carries: revert
// the update-row regex to the HEAD-anchored form the fleet first settled on and that case returns
// UNKNOWN (4) instead of OK (0), failing this test.
import { assert, assertEquals } from "jsr:@std/assert@1";

const SCRIPT = new URL("../scripts/merge-closing-block.sh", import.meta.url).pathname;
const decoder = new TextDecoder();

type Result = { code: number; out: string };

async function runBlock(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, out: decoder.decode(stdout) + decoder.decode(stderr) };
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${decoder.decode(stderr)}`);
  }
  return decoder.decode(stdout).trim();
}

async function write(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, body);
}

/** Classify captured output and return {code, out}. */
async function classify(body: string, head?: string): Promise<Result> {
  const dir = await Deno.makeTempDir({ prefix: "closing-block-classify-" });
  try {
    const file = `${dir}/captured.txt`;
    await write(file, body);
    const args = ["--classify", file];
    if (head !== undefined) args.push("--head", head);
    return await runBlock(args);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("classify: '[rejected]' is tested first and wins over a concurrent update row", async () => {
  // This is the load-bearing ordering case: a refusal's own output carries sha lines, so a positive
  // update-row test placed first could classify a refusal as a pass.
  const both = [
    "   1111111..2222222  2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> main",
    " ! [rejected]        3333333aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> other (fetch first)",
  ].join("\n");
  const res = await classify(`${both}\n`, "2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assertEquals(res.code, 3, `expected REFUSED, got ${res.code}: ${res.out}`);
  assert(res.out.includes("DECISION=REFUSED"), res.out);
  assert(res.out.includes("RE-GATE"), "the refusal must name the recovery, not a retry");
});

Deno.test("classify: 'Everything up-to-date' is NOTHING_TO_LAND (2), not success", async () => {
  const res = await classify("Everything up-to-date\n");
  assertEquals(res.code, 2, `expected NOTHING_TO_LAND, got ${res.code}: ${res.out}`);
  assert(res.out.includes("DECISION=NOTHING_TO_LAND"), res.out);
  assert(res.out.includes("not a pass"), "the record must not read as a pass");
});

Deno.test("classify: the HEAD form of the update row is OK when it publishes this HEAD", async () => {
  const full = "2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const res = await classify("   1111111..2222222  HEAD -> main\n", full);
  assertEquals(res.code, 0, `expected OK, got ${res.code}: ${res.out}`);
  assert(res.out.includes("DECISION=OK"), res.out);
});

Deno.test("classify: the EXPLICIT-40-CHAR-SHA form is OK too (the jfbn correction)", async () => {
  // With SRC=<sha> git prints the full local sha where an SRC=HEAD push prints the token HEAD. The
  // fleet's first settled regex anchored on the literal token HEAD and classified this real row as
  // UNKNOWN. This test fails if that regression returns.
  const full = "2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const row = `   1111111..2222222  ${full} -> main\n`;
  const res = await classify(row, full);
  assertEquals(res.code, 0, `expected OK for an explicit-sha row, got ${res.code}: ${res.out}`);
  assert(res.out.includes("DECISION=OK"), res.out);
});

Deno.test("classify: a row publishing a DIFFERENT commit than HEAD is MISMATCH (5)", async () => {
  // The value compared with HEAD is the one AFTER '..' (the local/new side); the value before it is
  // the REMOTE's current value. Comparing the wrong side would refuse every valid push.
  const row = "   1111111..2222222  2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> main\n";
  const res = await classify(row, "9999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assertEquals(res.code, 5, `expected MISMATCH, got ${res.code}: ${res.out}`);
  assert(res.out.includes("DECISION=MISMATCH"), res.out);
});

Deno.test("classify: unrecognised and empty output fail closed as UNKNOWN (4)", async () => {
  const newBranch = " * [new branch]      abc1234 -> some-branch\n";
  const unknown = await classify(newBranch);
  assertEquals(unknown.code, 4, `expected UNKNOWN, got ${unknown.code}: ${unknown.out}`);
  assert(unknown.out.includes("DECISION=UNKNOWN"), unknown.out);
  const empty = await classify("");
  assertEquals(empty.code, 4, `expected UNKNOWN for empty output, got ${empty.code}`);
});

Deno.test("live: all six codes against real git output, with the push stubbed and controls", async () => {
  const root = await Deno.makeTempDir({ prefix: "closing-block-live-" });
  const origin = `${root}/origin.git`;
  const work = `${root}/work`;
  try {
    await git(["init", "--bare", "-q", origin]);
    await git(["init", "-q", "-b", "main", work]);
    await git(["config", "user.email", "closing-block@example.invalid"], work);
    await git(["config", "user.name", "closing block test"], work);
    await git(["remote", "add", "origin", origin], work);

    await write(`${work}/f.txt`, "c0\n");
    await git(["add", "f.txt"], work);
    await git(["commit", "-qm", "c0"], work);
    const c0 = await git(["rev-parse", "HEAD"], work);
    await git(["push", "-q", "origin", "HEAD:refs/heads/behind"], work);

    await write(`${work}/f.txt`, "c1\n");
    await git(["commit", "-qam", "c1"], work);
    const c1 = await git(["rev-parse", "HEAD"], work);
    await git(["push", "-q", "origin", "HEAD:refs/heads/main"], work);

    await write(`${work}/f.txt`, "c2\n");
    await git(["commit", "-qam", "c2"], work);
    const c2 = await git(["rev-parse", "HEAD"], work);

    const env = { PUSH_MODE: "stub" };

    // 1. OK — HEAD is ahead of the target, so the row publishes exactly this HEAD.
    const ok = await runBlock([], { cwd: work, env: { ...env, SRC: c2, TARGET: "refs/heads/main" } });
    assertEquals(ok.code, 0, `OK branch: ${ok.out}`);
    assert(ok.out.includes("DECISION=OK"), ok.out);
    assert(ok.out.includes("WOULD PUSH NOW"), "the mutation must be stubbed, the assertion exercised");
    assert(ok.out.includes("dry-run rc=0"), ok.out);

    // 2. MISMATCH — src is an ancestor, so the row publishes c1 while HEAD is c2.
    const mismatch = await runBlock([], {
      cwd: work,
      env: { ...env, SRC: c1, TARGET: "refs/heads/behind" },
    });
    assertEquals(mismatch.code, 5, `MISMATCH branch: ${mismatch.out}`);
    assert(mismatch.out.includes("DECISION=MISMATCH"), mismatch.out);

    // 3. REFUSED — push an ancestor of the target (a real non-fast-forward).
    await git(["push", "-q", "origin", "HEAD:refs/heads/main"], work);
    const refused = await runBlock([], {
      cwd: work,
      env: { ...env, SRC: c1, TARGET: "refs/heads/main" },
    });
    assertEquals(refused.code, 3, `REFUSED branch: ${refused.out}`);
    assert(refused.out.includes("DECISION=REFUSED"), refused.out);
    assert(refused.out.includes("[rejected]"), refused.out);
    assert(!refused.out.includes("WOULD PUSH NOW"), "a refusal must never reach a push");

    // 4. NOTHING_TO_LAND — HEAD is the target, plus the write-path probe.
    const nothing = await runBlock([], {
      cwd: work,
      env: { ...env, SRC: c2, TARGET: "refs/heads/main" },
    });
    assertEquals(nothing.code, 2, `NOTHING_TO_LAND branch: ${nothing.out}`);
    assert(nothing.out.includes("DECISION=NOTHING_TO_LAND"), nothing.out);
    assert(nothing.out.includes("write-path probe:"), "the probe runs in this state only");

    // 5. UNKNOWN — a target that does not exist prints '* [new branch]', which matches no branch.
    const unknown = await runBlock([], {
      cwd: work,
      env: { ...env, SRC: c2, TARGET: "refs/heads/nonexistent-target" },
    });
    assertEquals(unknown.code, 4, `UNKNOWN branch: ${unknown.out}`);
    assert(unknown.out.includes("DECISION=UNKNOWN"), unknown.out);

    // 6. Fail closed when git itself cannot answer at all.
    const noRemote = await runBlock([], {
      cwd: work,
      env: { ...env, REMOTE: "no-such-remote", SRC: c2, TARGET: "refs/heads/main" },
    });
    assertEquals(noRemote.code, 4, `unreachable-remote branch: ${noRemote.out}`);
    assert(noRemote.out.includes("DECISION=UNKNOWN"), noRemote.out);

    // CONTROLS — the whole point of the stub: nothing may have moved, and the probe refs must not
    // exist. A rehearsal that claims no mutation has to be checked.
    assertEquals(await git(["rev-parse", "refs/heads/main"], origin), c2, "main must be unmoved");
    assertEquals(await git(["rev-parse", "refs/heads/behind"], origin), c0, "behind must be unmoved");
    const probes = await git(["for-each-ref", "--format=%(refname)", "refs/heads/tmp-merge-closing-block-probe-"], origin);
    assertEquals(probes, "", "no probe ref may be published");
    assertEquals(
      await git(["for-each-ref", "--format=%(refname)", "refs/heads/nonexistent-target"], origin),
      "",
      "the UNKNOWN case must not have created the target it refused",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// Tests for scripts/merge-closing-block.sh — the atomic assert-then-act block that gates a landing
// push (chrome-agent-platform-jfbn).
//
// Two layers, deliberately separated by the script's own `--classify` mode:
//   * PARSER cases feed SYNTHETIC captured output, which is the only way to prove the branch ORDER
//     (an output containing BOTH '[rejected]' and an update row must decide REFUSED).
//   * LIVE cases run the block against a throwaway bare repo. The STUBBED cases produce the five
//     dry-run codes (0, 2, 3, 4, 5) from real git output, and two further cases run PUSH_MODE=real
//     to cover the codes the stub can never reach: 0 from a push that really lands, and 6 from a push
//     the remote really declines. Controls assert that the stubbed cases moved nothing and that the
//     real cases moved exactly what they should.
//
// The explicit-40-char-sha parser case is the guard for the correction this script carries: revert
// the update-row regex to the HEAD-anchored form the fleet first settled on and that case returns
// UNKNOWN (4) instead of OK (0), failing this test.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";

// fileURLToPath, NOT .pathname: a URL pathname is percent-encoded, so a checkout path containing a
// space or a non-ASCII character would hand this a path that does not exist (bead e273's guard).
const SCRIPT = fileURLToPath(new URL("../scripts/merge-closing-block.sh", import.meta.url));
const decoder = new TextDecoder();

type Result = { code: number; out: string };

async function runBlock(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    cwd: opts.cwd,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.bareRepository",
      GIT_CONFIG_VALUE_0: "all",
      ...opts.env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, out: decoder.decode(stdout) + decoder.decode(stderr) };
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: ["-c", "safe.bareRepository=all", ...args],
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
let classifySeq = 0;
async function classify(body: string, head?: string): Promise<Result> {
  // Durable, not a bare temp-dir factory: /tmp on this host is RAM-backed tmpfs and
  // tests/durable-root.test.ts polices it (chrome-agent-platform-xnuu). Removed in the finally below,
  // so the corpus stays clean — which is what that guard also polices.
  const dir = durableDir(`closing-block-classify-${Deno.pid}-${classifySeq++}`);
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

Deno.test("classify: a refusal wins over a concurrent update row (the real multi-ref case)", async () => {
  // Where the ordering is LOAD-BEARING, and where it is not — both halves kept precise. The jfbn
  // reviewer built a genuine MIXED capture from real git (one fast-forward row plus one '[rejected]'
  // row) and showed that an inverted branch order returns OK on it. On this script's own
  // single-refspec flow a refusal prints no update row, so there the ordering is defence-in-depth.
  // This case is the multi-ref shape, which is where it decides the outcome.
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

Deno.test("classify: a commit range printed BEFORE the row cannot hijack the sha (F3)", async () => {
  // Git advice, a remote banner or a pre-receive hook can print its own old..new range before the
  // update row. A global scan of the capture would take THAT range's new value and misreport the
  // row's real one — here it would turn a legitimate OK into a MISMATCH.
  const full = "2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const capture = [
    "remote: comparing 1111111..9999999 for the hook's own reason",
    `   1111111..2222222  ${full} -> main`,
  ].join("\n");
  const res = await classify(`${capture}\n`, full);
  assertEquals(res.code, 0, `the row's sha is the one that counts: ${res.out}`);
  assert(res.out.includes("DECISION=OK"), res.out);
  assert(res.out.includes("2222222"), "the decision must name the row's sha");
});

Deno.test("classify: a hook-declined push ('! [remote rejected]') is REFUSED, not UNKNOWN", async () => {
  // git declares a refusal two ways and both mean nothing was pushed. This is the spelling a
  // declined pre-receive hook produces (the real-push case in the live test produces exactly it),
  // and it has no update row — so before the refusal family was matched, it classified as UNKNOWN.
  const capture = [
    "remote: r0v8 test hook declined this push",
    " ! [remote rejected] HEAD -> main (pre-receive hook declined)",
    "error: failed to push some refs to '../o.git'",
  ].join("\n");
  const res = await classify(`${capture}\n`, "2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assertEquals(res.code, 3, `expected REFUSED for a hook-declined push: ${res.out}`);
  assert(res.out.includes("DECISION=REFUSED"), res.out);
});

Deno.test("classify: without --head it must not claim the sha was checked (F4)", async () => {
  const row = "   1111111..2222222  2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> main\n";
  const res = await classify(row); // no --head
  assertEquals(res.code, 0, res.out);
  assert(
    !res.out.includes("IS this HEAD"),
    `nothing checked the sha, so the output must not assert it was checked: ${res.out}`,
  );
  assert(res.out.includes("NOT checked against HEAD"), res.out);
});

Deno.test("live: five dry-run codes (0,2,3,4,5) stubbed + the two real-push codes (0,6)", async () => {
  // Durable temp root for the same reason as classify() above (chrome-agent-platform-xnuu); the
  // finally below removes it, so this test leaves no residue behind.
  const root = durableDir(`closing-block-live-${Deno.pid}`);
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
    // F2 CONTROL: Case 1 ran with the push stubbed, so main must STILL BE c1 here — asserted NOW,
    // before the harness's own push below moves main to c2. A control placed after that mutation
    // would pass even if the stub had failed (review of 1a125b9a).
    assertEquals(
      await git(["rev-parse", "refs/heads/main"], origin),
      c1,
      "the stubbed case must not have pushed: main must still be c1 before the harness moves it",
    );

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

    // 7. PUSH_MODE=real, SUCCESSFUL push: the path that actually mutates. A dedicated ref keeps it
    //    clear of the stubbed cases above, and the ref moving IS the evidence that real mode acts.
    await git(["push", "-q", "origin", `${c1}:refs/heads/real-target`], work);
    const realOk = await runBlock([], {
      cwd: work,
      env: { SRC: c2, TARGET: "refs/heads/real-target", PUSH_MODE: "real" },
    });
    assertEquals(realOk.code, 0, `real push success must be 0: ${realOk.out}`);
    assert(realOk.out.includes("DECISION=OK"), realOk.out);
    assert(realOk.out.includes("PUSH rc=0"), realOk.out);
    assertEquals(
      await git(["rev-parse", "refs/heads/real-target"], origin),
      c2,
      "the real push must actually have landed",
    );

    // 8. PUSH_MODE=real, DECLINED push -> exit 6 (EXIT_PUSH_FAILED), the code the stubbed cases cannot
    //    reach. A pre-receive hook declines the real push AFTER a passing assertion: git does not run
    //    receive hooks for --dry-run, so the dry run still prints the update row and the decision is
    //    OK — the failure comes from the push itself, which is exactly the branch under test.
    await git(["push", "-q", "origin", `${c1}:refs/heads/reject-target`], work);
    await Deno.writeTextFile(
      `${origin}/hooks/pre-receive`,
      "#!/bin/sh\necho 'r0v8 test hook declined this push' >&2\nexit 1\n",
    );
    await Deno.chmod(`${origin}/hooks/pre-receive`, 0o755);
    const realDeclined = await runBlock([], {
      cwd: work,
      env: { SRC: c2, TARGET: "refs/heads/reject-target", PUSH_MODE: "real" },
    });
    assertEquals(realDeclined.code, 6, `a declined real push must be 6: ${realDeclined.out}`);
    assert(
      realDeclined.out.includes("DECISION=OK"),
      "the assertion passed here on purpose — it is the PUSH that failed",
    );
    assert(realDeclined.out.includes("PUSH rc="), realDeclined.out);
    assertEquals(
      await git(["rev-parse", "refs/heads/reject-target"], origin),
      c1,
      "the declined push must not have moved the ref",
    );

    // CONTROLS — the whole point of the stub: nothing may have moved, and the probe refs must not
    // exist. A rehearsal that claims no mutation has to be checked.
    assertEquals(await git(["rev-parse", "refs/heads/main"], origin), c2, "main must be unmoved");
    assertEquals(await git(["rev-parse", "refs/heads/behind"], origin), c0, "behind must be unmoved");
    // The real-push cases moved exactly their own refs and nothing else.
    assertEquals(await git(["rev-parse", "refs/heads/real-target"], origin), c2);
    assertEquals(await git(["rev-parse", "refs/heads/reject-target"], origin), c1);
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

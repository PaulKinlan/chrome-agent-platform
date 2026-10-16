// Full gate may reuse ONLY an exact-tip marker that ensureStoreBuild has verified.
// It must still run both existing tiers, and must never run either against an
// uncertified dist or turn a failing tier into a green gate.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { defaultGetChangedFiles, hasBuildInfraChanges, runFullGate } from "../scripts/gate-full.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

Deno.test("sgzyg: valid exact-tip build is reused before both full gate tiers", async () => {
  const calls: string[] = [];
  const result = await runFullGate({
    root: "/isolated-test-root",
    ensure: async (options: Record<string, unknown>) => {
      assertEquals(options.required, true);
      assertEquals(options.root, "/isolated-test-root");
      calls.push("verified");
      return { disposition: "reused", reason: "exact commit/source/output hashes verified", secs: 0.73, markerCommit: "abc" };
    },
    run: (command: string, args: string[], env: Record<string, string>) => {
      assertEquals(command, "npm");
      assertEquals(JSON.parse(env.CAP_GATE_BUILD_JSON).disposition, "reused");
      calls.push(args.join(" "));
      return 0;
    },
  });
  assertEquals(result, 0);
  assertEquals(calls, ["verified", "test", "run test:build"]);
});

Deno.test("sgzyg: invalid build stops before both tiers and names the failure", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const result = await runFullGate({
    ensure: async () => ({ disposition: "failed", reason: "output hash mismatch after rebuilding", secs: 0, markerCommit: null }),
    run: () => { calls.push("ran"); return 0; },
    log: (line: string) => logs.push(line),
  });
  assertEquals(result, 1);
  assertEquals(calls, []);
  assertStringIncludes(logs.join("\n"), "output hash mismatch");
});

Deno.test("sgzyg: failed npm test stops before build-behaviour tier; failed build tier stays red", async () => {
  for (const [first, second, expected, calls] of [
    [23, 0, 23, ["test"]],
    [0, 17, 17, ["test", "run test:build"]],
  ] as const) {
    const seen: string[] = [];
    const result = await runFullGate({
      ensure: async () => ({ disposition: "ran", reason: "new certified build", secs: 17, markerCommit: "abc" }),
      run: (_command: string, args: string[]) => {
        seen.push(args.join(" "));
        return seen.length === 1 ? first : second;
      },
    });
    assertEquals(result, expected);
    assertEquals(seen, [...calls]);
  }
});

Deno.test("yvvvd: selective build tier runs test:build when build infra changes, skips when only UI/extension code changes", async () => {
  // Case A: Build infra changed (e.g. build.mjs) -> runs test:build
  const callsWithBuildChange: string[] = [];
  const resultBuildChange = await runFullGate({
    root: "/isolated-test-root",
    selectiveBuildTier: true,
    getChanged: () => ["build.mjs", "extension/ntp/ntp.js"],
    ensure: async () => ({ disposition: "reused", reason: "certified", secs: 0.5, markerCommit: "abc" }),
    run: (_command: string, args: string[]) => {
      callsWithBuildChange.push(args.join(" "));
      return 0;
    },
  });
  assertEquals(resultBuildChange, 0);
  assertEquals(callsWithBuildChange, ["test", "run test:build"]);

  // Case B: No build infra changed (e.g. only UI/extension files) -> skips test:build safely
  const callsWithoutBuildChange: string[] = [];
  const logsWithoutBuildChange: string[] = [];
  const resultNoBuildChange = await runFullGate({
    root: "/isolated-test-root",
    selectiveBuildTier: true,
    getChanged: () => ["extension/ntp/ntp.js", "tests/ntp.test.ts"],
    ensure: async () => ({ disposition: "reused", reason: "certified", secs: 0.5, markerCommit: "abc" }),
    run: (_command: string, args: string[]) => {
      callsWithoutBuildChange.push(args.join(" "));
      return 0;
    },
    log: (msg: string) => logsWithoutBuildChange.push(msg),
  });
  assertEquals(resultNoBuildChange, 0);
  assertEquals(callsWithoutBuildChange, ["test"]);
  assertStringIncludes(logsWithoutBuildChange.join("\n"), "skipping test:build");
});

Deno.test("bcbk6: hasBuildInfraChanges matches all declared build infra triggers and fails closed on unknown/empty", () => {
  // Matching triggers
  assertEquals(hasBuildInfraChanges(["scripts/lib/wasm-manifest-assets.mjs"]), true);
  assertEquals(hasBuildInfraChanges(["scripts/gate-full.mjs"]), true);
  assertEquals(hasBuildInfraChanges(["scripts/select-tests.mjs"]), true);
  assertEquals(hasBuildInfraChanges(["build.mjs"]), true);
  assertEquals(hasBuildInfraChanges(["packages/bundled/foo/bar.js"]), true);

  // Non-matching triggers
  assertEquals(hasBuildInfraChanges(["extension/ntp/ntp.js", "tests/ntp.test.ts"]), false);

  // Fail-closed cases (empty delta, null, undefined, non-array)
  assertEquals(hasBuildInfraChanges([]), true, "empty delta must fail closed and trigger test:build");
  assertEquals(hasBuildInfraChanges(null as any), true, "null delta must fail closed");
  assertEquals(hasBuildInfraChanges(undefined as any), true, "undefined delta must fail closed");
});

Deno.test("28qd4: defaultGetChangedFiles handles real git union delta, root commit, and non-git fallback", () => {
  const tempDir = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "28qd4-git-test-" });
  try {
    const nonGitFiles = defaultGetChangedFiles(tempDir);
    assertEquals(nonGitFiles, []);
    assertEquals(hasBuildInfraChanges(nonGitFiles), true, "non-git directory must fail closed");

    // Initialize a real git repo
    new Deno.Command("git", { args: ["init"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["config", "user.email", "test@test.local"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["config", "user.name", "Test"], cwd: tempDir }).outputSync();

    // Commit 1: root commit changing build.mjs
    Deno.writeTextFileSync(`${tempDir}/build.mjs`, "// build script");
    new Deno.Command("git", { args: ["add", "build.mjs"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["commit", "-m", "initial build"], cwd: tempDir }).outputSync();

    // Root commit with no parent: defaultGetChangedFiles inspects root commit
    const rootFiles = defaultGetChangedFiles(tempDir);
    assertEquals(rootFiles, ["build.mjs"]);
    assertEquals(hasBuildInfraChanges(rootFiles), true);

    // Commit 2: base branch
    Deno.writeTextFileSync(`${tempDir}/main.txt`, "base");
    new Deno.Command("git", { args: ["add", "main.txt"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["commit", "-m", "base commit"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["branch", "-M", "main"], cwd: tempDir }).outputSync();

    // Branch A changes build.mjs
    new Deno.Command("git", { args: ["checkout", "-b", "branch-a"], cwd: tempDir }).outputSync();
    Deno.writeTextFileSync(`${tempDir}/build.mjs`, "// updated build script");
    new Deno.Command("git", { args: ["commit", "-am", "branch a update"], cwd: tempDir }).outputSync();

    // Branch B changes extension/ntp/ntp.js
    new Deno.Command("git", { args: ["checkout", "main"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["checkout", "-b", "branch-b"], cwd: tempDir }).outputSync();
    Deno.mkdirSync(`${tempDir}/extension/ntp`, { recursive: true });
    Deno.writeTextFileSync(`${tempDir}/extension/ntp/ntp.js`, "// ntp code");
    new Deno.Command("git", { args: ["add", "extension/ntp/ntp.js"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["commit", "-m", "branch b update"], cwd: tempDir }).outputSync();

    // Union / merge branch
    new Deno.Command("git", { args: ["checkout", "-b", "union"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["merge", "--no-ff", "branch-a", "-m", "merge branch a"], cwd: tempDir }).outputSync();
    new Deno.Command("git", { args: ["merge", "--no-ff", "branch-b", "-m", "merge branch b"], cwd: tempDir }).outputSync();

    // In a batched union, with baseRef: "main", both changes are seen
    const unionFiles = defaultGetChangedFiles(tempDir, { baseRef: "main" });
    assertEquals(unionFiles.includes("build.mjs"), true, "union delta must include build.mjs from branch A");
    assertEquals(unionFiles.includes("extension/ntp/ntp.js"), true, "union delta must include extension/ntp/ntp.js from branch B");
    assertEquals(hasBuildInfraChanges(unionFiles), true);
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

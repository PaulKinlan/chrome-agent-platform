#!/usr/bin/env -S deno run -A
// scripts/build-gate.ts — dedicated heavy gate for in-place build-behaviour tests (chrome-agent-platform-h65e).
// Option D: moves build-behaviour coverage out of every lane's npm test into an explicitly-budgeted gate
// run during landing or on-demand.
//
// Enumerated coverage:
//   • tests/build-bootstrap.test.ts (per-file bound: 850s) — steady-state symlink bootstrap, GC of dangling v-boot
//     symlinks under dist-versions, live version counts, and archive packaging idempotence.
//   • tests/build-debug-mode.test.ts (per-file bound: 550s) — developer vs store target marker validation, sourcemap
//     inclusion/exclusion, and mode alternation integrity.
//   • tests/build-tool-bundling.test.ts (base serial window, measured ~10s; ceiling 720s under 4x load) — bundled-tool
//     generator verify-mode drift check, --regen-tools idempotence, and provenance validation.
//
// Total enforced ceiling: 2120s (~35 min under max load scale; measured 31-36 s on an Apple-silicon workstation after jjsz).

import { fileURLToPath } from "node:url";
import { runSerialFiles } from "./lib/serial-phase.mjs";
import { durableDir } from "./lib/durable-root.mjs";
import { BUILD_GATE_FILES } from "./test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// gate-speed (2026-10-08): the TWO-TREE build gate. Each build-behaviour file rebuilds extension/dist IN
// PLACE, so two of them can never share a tree — but a production build keeps ~1 core busy, so on a
// 2-vCPU box the files can run side by side in two checkouts of the SAME commit. tests/build-debug-mode
// runs in a sibling `git worktree add --detach <durable>/build-gate/<sha>-<pid> HEAD` (node_modules
// COPIED, never linked: a linked tree measurably moved a bundle size and would let one tree's build
// write through into the other), while build-bootstrap and build-tool-bundling run here, in order.
// Every file still runs exactly once, in its own process, under runSerialFiles' per-file windows and
// attribution; the gate fails if either tree fails. The sibling is removed in a finally.
// Falls back to the original one-tree serial run when: files are named on the command line, the tree
// has uncommitted changes to tracked files (a sibling of HEAD would test different bytes), or
// CAP_BUILD_GATE_ONE_TREE=1.
export const SIBLING_FILES: readonly string[] = Object.freeze(["tests/build-debug-mode.test.ts"]);

function git(args: string[], cwd = ROOT): { code: number; out: string } {
  const r = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" }).outputSync();
  return { code: r.code, out: new TextDecoder().decode(r.code === 0 ? r.stdout : r.stderr).trim() };
}

/** Why the two-tree mode is not used for this run, or null when it is. Pure inputs, so it is testable. */
export function oneTreeReason(
  { cliFiles, dirty, env }: { cliFiles: string[]; dirty: string; env: Record<string, string | undefined> },
): string | null {
  if (cliFiles.length > 0) return "files were named on the command line";
  if (env.CAP_BUILD_GATE_ONE_TREE === "1") return "CAP_BUILD_GATE_ONE_TREE=1";
  if (dirty) return "the tree has uncommitted changes to tracked files (a sibling of HEAD would test other bytes)";
  return null;
}

async function siblingRun(files: string[]): Promise<number> {
  const sha = git(["rev-parse", "HEAD"]).out;
  const dir = `${durableDir("build-gate")}/${sha.slice(0, 12)}-${Deno.pid}`;
  const add = git(["worktree", "add", "--detach", "--quiet", dir, sha]);
  if (add.code !== 0) {
    console.error(`build-gate: sibling worktree could not be created: ${add.out}`);
    return 1;
  }
  try {
    const cp = new Deno.Command("cp", { args: ["-a", `${ROOT}node_modules`, `${dir}/node_modules`] }).outputSync();
    if (cp.code !== 0) {
      console.error(`build-gate: copying node_modules into the sibling failed: ${new TextDecoder().decode(cp.stderr)}`);
      return 1;
    }
    console.log(`build-gate: sibling tree ${dir} runs ${files.join(", ")} beside this tree`);
    // The sibling runs ITS OWN copy of the lane runner (same commit), so its windows and attribution are
    // the ones under test; its output streams straight through.
    const child = new Deno.Command("node", {
      args: [`${dir}/scripts/lib/serial-lane.mjs`, ...files],
      cwd: dir,
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const killChild = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    globalThis.addEventListener("unload", killChild);
    const status = await child.status;
    globalThis.removeEventListener("unload", killChild);
    return status.code;
  } finally {
    git(["worktree", "remove", "--force", dir]);
    git(["worktree", "prune"]);
  }
}

export async function main(args = Deno.args): Promise<number> {
  const cliFiles = args.filter((a) => !a.startsWith("-"));
  const files = cliFiles.length > 0 ? cliFiles : [...BUILD_GATE_FILES];
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out;
  const reason = oneTreeReason({ cliFiles, dirty, env: Deno.env.toObject() });
  console.log(`build-gate: running ${files.length} build-behaviour test(s):`);
  for (const f of files) {
    console.log(`  - ${f}`);
  }
  let rc: number;
  if (reason) {
    console.log(`build-gate: one tree, serially (${reason})`);
    rc = runSerialFiles(files, { cwd: ROOT });
  } else {
    const sibling = files.filter((f) => SIBLING_FILES.includes(f));
    const here = files.filter((f) => !SIBLING_FILES.includes(f));
    const siblingDone = sibling.length ? siblingRun(sibling) : Promise.resolve(0);
    // runSerialFiles blocks this thread in spawnSync; the sibling child runs meanwhile on its own.
    // Yield once so the sibling's spawn happens BEFORE the blocking lane starts.
    await new Promise((r) => setTimeout(r, 0));
    const hereRc = here.length ? runSerialFiles(here, { cwd: ROOT }) : 0;
    const siblingRc = await siblingDone;
    if (siblingRc !== 0) console.error(`build-gate: sibling tree FAILED (exit ${siblingRc}): ${sibling.join(", ")}`);
    rc = hereRc !== 0 ? hereRc : siblingRc;
  }
  if (rc === 0) {
    console.log(`\nbuild-gate: ALL ${files.length} BUILD-BEHAVIOUR TESTS GREEN`);
  } else {
    console.error(`\nbuild-gate: FAILED with exit code ${rc}`);
  }
  return rc;
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}

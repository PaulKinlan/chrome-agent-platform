// 6efbv: a source-only census of browser leader kills in top-level scripts/*.ts.
// The four previously risky call sites retain their deeper per-site pins in
// jjsz-lifeline-runner-exit.test.ts. This net notices a NEW bare-kill script and
// a changed launch/kill shape in an existing exception; it is NOT a control-flow
// or profile-equality proof. 80yqb protects in-process launchChrome relaunches,
// but cannot settle a watcher before its runner exits under security custody.
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";
import { transformSync } from "npm:esbuild@0.25.12";
import { fileURLToPath } from "node:url";
import { harnessFiles } from "../scripts/lib/harness-registry.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
type Ast = { type: string; [key: string]: any };
type Shape = { launches: number; bareKills: number };
type Exception = Shape & { reason: string };
const isAst = (value: unknown): value is Ast =>
  typeof value === "object" && value !== null && typeof (value as Ast).type === "string";

function visit(node: Ast, inspect: (node: Ast) => void): void {
  inspect(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isAst(child)) visit(child, inspect);
    }
  }
}

function dotted(node: Ast | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "ChainExpression") return dotted(node.expression);
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    const root = dotted(node.object);
    return root === null ? null : `${root}.${node.property.name}`;
  }
  return null;
}

const unawait = (node: Ast | null | undefined): Ast | null | undefined =>
  node?.type === "AwaitExpression" ? node.argument : node;

/** Source-only prefilter is an optimisation, never the verdict. AST nodes decide. */
function browserKillShape(source: string): Shape {
  if (!source.includes("launchChrome") || !source.includes(".kill")) {
    return { launches: 0, bareKills: 0 };
  }
  const { code } = transformSync(source, { loader: "ts", format: "esm", target: "esnext" });
  const program = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Ast;
  const launchers = new Set<string>();
  let launches = 0;
  visit(program, (node) => {
    if (node.type === "CallExpression" && dotted(node.callee) === "launchChrome") launches++;
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      let containsLaunch = false;
      visit(node.body, (inner) => {
        if (inner.type === "CallExpression" && dotted(inner.callee) === "launchChrome") containsLaunch = true;
      });
      if (containsLaunch) launchers.add(node.id.name);
    }
  });
  if (!launches) return { launches: 0, bareKills: 0 };

  const handles = new Set<string>();
  const procs = new Set<string>();
  const launchish = (node: Ast | null | undefined) => {
    const call = unawait(node);
    return call?.type === "CallExpression" &&
      (dotted(call.callee) === "launchChrome" || launchers.has(dotted(call.callee) ?? ""));
  };
  // One direct handle assignment and one .proc alias hop. Extra alias depth is
  // unproven; a member-chain .proc.kill fallback below classifies rather than
  // silently acquitting opaque cross-function parameters such as context.chrome.
  visit(program, (node) => {
    if (node.type === "VariableDeclarator" && launchish(node.init)) {
      if (node.id.type === "Identifier") handles.add(node.id.name);
      if (node.id.type === "ObjectPattern") {
        for (const prop of node.id.properties) {
          if (prop.key?.name === "proc" && prop.value?.type === "Identifier") procs.add(prop.value.name);
        }
      }
    }
    if (node.type === "AssignmentExpression" && launchish(node.right) && node.left.type === "Identifier") {
      handles.add(node.left.name);
    }
  });
  visit(program, (node) => {
    const assign = node.type === "VariableDeclarator" ? { left: node.id, right: node.init } :
      node.type === "AssignmentExpression" ? { left: node.left, right: node.right } : null;
    if (assign?.left?.type === "Identifier" && dotted(assign.right)?.endsWith(".proc")) {
      const owner = dotted(assign.right.object);
      if (owner && handles.has(owner)) procs.add(assign.left.name);
    }
  });

  let bareKills = 0;
  visit(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = dotted(node.callee);
    if (!callee) return;
    if (callee === "Deno.kill") {
      const target = dotted(node.arguments[0]);
      if (target && ([...procs].some((p) => target === `${p}.pid`) ||
        [...handles].some((h) => target === `${h}.proc.pid`))) bareKills++;
      return;
    }
    if (!callee.endsWith(".kill")) return;
    const target = callee.slice(0, -".kill".length);
    if (procs.has(target) || [...handles].some((h) => target === `${h}.proc`) || target.endsWith(".proc")) {
      bareKills++; // the .proc fallback is classified, not claimed to be an alias proof
    }
  });
  return { launches, bareKills };
}

// The custody supervisor's production runner is pinned below. A runner whose
// descendants are judged after exit must NEVER leave its lifeline sweep running.
const CUSTODY_RUNNER = "scripts/security-suite.ts";

/** Each exception needs a human reason; changes to its measured shape fail closed. */
const EXCEPTIONS: Record<string, Exception> = {
  "scripts/agent-access-journeys.ts": { launches: 1, bareKills: 1, reason: "One acceptance browser; terminal cleanup; no custody or same-profile relaunch." },
  "scripts/agent-directory-ui.ts": { launches: 1, bareKills: 1, reason: "One Directory UI browser; terminal cleanup, not custody-supervised." },
  "scripts/agent-role-preview.ts": { launches: 1, bareKills: 1, reason: "One role-preview browser; terminal cleanup, no relaunch." },
  "scripts/axe-audit.ts": { launches: 1, bareKills: 2, reason: "One audit browser; fail-fast and terminal exits, no custody or relaunch." },
  "scripts/capability-lifecycle.ts": { launches: 1, bareKills: 1, reason: "One capability journey browser; terminal cleanup, no relaunch." },
  "scripts/component-gallery-smoke.ts": { launches: 1, bareKills: 1, reason: "One component-gallery browser; terminal cleanup, no relaunch." },
  "scripts/cthe-npt-directory-evidence.ts": { launches: 1, bareKills: 1, reason: "One Directory evidence browser; terminal cleanup, no custody." },
  "scripts/data-memory-clear.ts": { launches: 1, bareKills: 1, reason: "One memory-clear browser; terminal cleanup, no relaunch." },
  "scripts/emscripten-abi-loaded.ts": { launches: 1, bareKills: 1, reason: "One ABI evidence browser; cross-function context.chrome.proc cleanup, no custody or relaunch." },
  "scripts/focus-shots.ts": { launches: 1, bareKills: 1, reason: "One focus screenshot browser; terminal cleanup, no relaunch." },
  "scripts/kat-agent-delegation.ts": { launches: 1, bareKills: 2, reason: "One KAT browser; failure and terminal kills, no custody or relaunch." },
  "scripts/kat-dialog-consolidation.ts": { launches: 1, bareKills: 1, reason: "One dialog KAT browser; terminal cleanup, no relaunch." },
  "scripts/keyless-first-result.ts": { launches: 2, bareKills: 1, reason: "Only the trailing finalizer bare-kills; a pinned helper reaps before the earlier same-profile relaunch." },
  "scripts/live-run-evidence.ts": { launches: 1, bareKills: 2, reason: "One evidence browser; failure and terminal kills, no custody or relaunch." },
  "scripts/mic-transcript-smoke.ts": { launches: 1, bareKills: 1, reason: "One mic smoke browser; terminal cleanup, no relaunch." },
  "scripts/opfs-real-browser.ts": { launches: 1, bareKills: 1, reason: "One OPFS browser; terminal cleanup, no relaunch." },
  "scripts/page-actions-journey.ts": { launches: 2, bareKills: 1, reason: "Only the trailing finalizer bare-kills; a pinned helper reaps before the earlier same-profile relaunch." },
  "scripts/panel-leak-probe.ts": { launches: 1, bareKills: 1, reason: "One panel probe browser; terminal cleanup, no relaunch." },
  "scripts/perf-gallery-previews.ts": { launches: 1, bareKills: 1, reason: "One gallery preview browser; terminal cleanup, no relaunch." },
  "scripts/perf-leak-trace.ts": { launches: 1, bareKills: 1, reason: "One trace browser; terminal cleanup, no relaunch." },
  "scripts/perf-seeded-scale.ts": { launches: 1, bareKills: 1, reason: "One seeded-scale browser; terminal cleanup, no relaunch." },
  "scripts/permission-matrix-acceptance.ts": { launches: 1, bareKills: 1, reason: "One permission-matrix rig; close() kills it, no custody or relaunch." },
  "scripts/read-page-host-grant-acceptance.ts": { launches: 1, bareKills: 1, reason: "One host-grant browser; terminal cleanup, no relaunch." },
  "scripts/run-status-lifecycle.ts": { launches: 1, bareKills: 1, reason: "One run-status browser; terminal cleanup, no custody or relaunch." },
  "scripts/screenshot-vision-evidence.ts": { launches: 1, bareKills: 1, reason: "One vision capture browser; terminal cleanup, no relaunch." },
  "scripts/sidebar-parity.ts": { launches: 1, bareKills: 1, reason: "One sidebar browser; terminal cleanup, no relaunch." },
  "scripts/sidepanel-companion-journey.ts": { launches: 1, bareKills: 1, reason: "One sidepanel browser; terminal cleanup, no relaunch." },
  "scripts/skills-in-settings-evidence.ts": { launches: 1, bareKills: 1, reason: "One Settings evidence browser; terminal cleanup, no relaunch." },
  "scripts/system-prompts-integration.ts": { launches: 1, bareKills: 1, reason: "One system-prompts browser; terminal cleanup, no relaunch." },
  "scripts/ui-integration.ts": { launches: 1, bareKills: 1, reason: "One UI integration browser; terminal cleanup, no relaunch." },
  "scripts/unix-tools-streaming-acceptance.ts": { launches: 1, bareKills: 1, reason: "One Unix-tools browser; terminal cleanup, no relaunch." },
  "scripts/validate-package-load.ts": { launches: 1, bareKills: 2, reason: "One packaged-load browser; fail-fast and terminal kills, no relaunch." },
  "scripts/verify-fixture-getter-behavior.ts": { launches: 1, bareKills: 1, reason: "One fixture-getter browser; terminal cleanup, no relaunch." },
  "scripts/verify-script-run.ts": { launches: 1, bareKills: 1, reason: "One script-run browser; terminal cleanup, no relaunch." },
  "scripts/webmcp-acceptance.ts": { launches: 2, bareKills: 3, reason: "Fresh, showcase and variant runs use separate profile dirs; no custody supervisor judges their exit." },
  "scripts/webmcp-realsite-probe.ts": { launches: 1, bareKills: 1, reason: "One WebMCP probe browser; terminal cleanup, no relaunch." },
};

function audit(sources: Record<string, string>, exceptions: Record<string, Exception>): string[] {
  const failures: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const shape = browserKillShape(source);
    const exception = exceptions[file];
    if (file === CUSTODY_RUNNER && shape.bareKills) {
      failures.push(`${file}: custody runner bare-kills a launchChrome handle (${shape.bareKills})`);
    }
    if (!shape.bareKills) {
      if (exception) failures.push(`${file}: stale bare-kill exception; remove it`);
      continue;
    }
    if (!exception) {
      failures.push(`${file}: unlisted launchChrome bare kill (${shape.launches} launch site(s), ${shape.bareKills} kill(s)); review custody/relaunch before adding an exception`);
      continue;
    }
    if (!exception.reason.trim() || exception.launches !== shape.launches || exception.bareKills !== shape.bareKills) {
      failures.push(`${file}: bare-kill exception shape changed from ${exception.launches}/${exception.bareKills} to ${shape.launches}/${shape.bareKills}; review the lifecycle and reason`);
    }
  }
  for (const file of Object.keys(exceptions)) {
    if (!(file in sources)) failures.push(`${file}: exception names no script`);
  }
  return failures;
}

function scriptSources(): Record<string, string> {
  return Object.fromEntries(harnessFiles().map((file) => [
    `scripts/${file}`, Deno.readTextFileSync(`${ROOT}scripts/${file}`),
  ]));
}

Deno.test("6efbv: every bare launchChrome leader kill has a reviewed exception; custody never bare-kills", () => {
  const custody = Deno.readTextFileSync(`${ROOT}scripts/security-suite-custody.mjs`);
  assert(
    custody.includes('productionRunner = path.join(repoRoot, "scripts", "security-suite.ts")'),
    "custody runner changed: review CUSTODY_RUNNER and the bare-kill rule",
  );
  const failures = audit(scriptSources(), EXCEPTIONS);
  assertEquals(failures, [], failures.join("\n"));
});

Deno.test("6efbv: fresh script and changed allowlisted shape mutants turn the rule RED", () => {
  const fresh = `async function probe() {
    const chrome = await launchChrome({profile: "P"});
    chrome.proc.kill("SIGKILL"); await chrome.proc.status;
    await launchChrome({profile: "P"});
  }`;
  assert(audit({ "scripts/new-relauncher.ts": fresh }, {}).some((s) => s.includes("unlisted launchChrome bare kill")),
    "a NEW script with a bare kill before a same-profile relaunch must be refused");
  const optional = `const chrome = await launchChrome({profile: "P"}); chrome.proc?.kill?.("SIGKILL");`;
  assert(audit({ "scripts/new-optional.ts": optional }, {}).some((s) => s.includes("unlisted launchChrome bare kill")),
    "optional-call spelling must not bypass the census prefilter");
  const safe = `const chrome = await launchChrome({profile: "P"}); await reapLeaderAndSettle(chrome.proc);
    const next = await launchChrome({profile: "P"}); await teardownChrome(next);`;
  assertEquals(audit({ "scripts/new-safe.ts": safe }, {}), [], "reap/teardown calls are not bare kills");
  const nonBrowser = `const child = new Deno.Command("/bin/true").spawn(); child.kill("SIGKILL");`;
  assertEquals(audit({ "scripts/new-child.ts": nonBrowser }, {}), [], "a child outside launchChrome is not a browser-handle kill");

  const original = Deno.readTextFileSync(`${ROOT}${CUSTODY_RUNNER}`);
  const needle = "    await reapLeaderAndSettle(chrome.proc);";
  assertEquals(original.split(needle).length, 2, "custody mutant must replace exactly one REAL reap call");
  const mutant = original.replace(needle, '    chrome.proc.kill("SIGKILL"); await chrome.proc.status;');
  assert(audit({ [CUSTODY_RUNNER]: mutant }, {}).some((s) => s.includes("custody runner bare-kills")),
    "replacing the production custody reap with a bare kill must be caught by THIS rule");

  // A pre-existing exception may not silently gain another browser launch.
  const existing = "scripts/perf-seeded-scale.ts";
  const source = Deno.readTextFileSync(`${ROOT}${existing}`);
  const baseline = EXCEPTIONS[existing];
  assert(baseline, `${existing} must be among the reviewed bare-kill exceptions`);
  assert(audit({ [existing]: `${source}\nvoid launchChrome({profile: "P"});\n` }, { [existing]: baseline })
    .some((s) => s.includes("exception shape changed")),
  "adding a new launch site to an existing exception must force a lifecycle re-review");
});

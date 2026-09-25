// kwrx P2 — the count cannot silently regrow.
//
// A file under scripts/ that calls Runtime.evaluate AND reads a value back
// must either handle exceptionDetails itself or go through
// scripts/lib/cdp-eval.ts. UNHANDLED is a frozen, SHRINKING allowlist: one
// unlisted new offender fails; one migrated file left in the list also fails
// (the list stays honest per migration commit).
//
// Counted at filing time (tip 27cf212d7): 37 files / 52 value-read sites.
// The bead said 34/49 at filing (2026-09-25, 0lb4-review tree) — three
// drivers landed since; the bytes in THIS tree govern, as always.
import { assert, assertEquals } from "jsr:@std/assert";

const EVAL = /Runtime\.evaluate/;
const VALUE_READ = /\.result\??\.value|\.result\.result\??\.value|\bresult\?\.value\b/;
const HANDLED = /exceptionDetails|cdp-eval/;

const UNHANDLED: string[] = [
  "scripts/agent-role-preview.ts",
  "scripts/axe-audit.ts",
  "scripts/capability-lifecycle.ts",
  "scripts/data-memory-clear.ts",
  "scripts/kat-agent-delegation.ts",
  "scripts/kat-agent-templates.ts",
  "scripts/kat-back-stack.ts",
  "scripts/kat-background-run-transcript.ts",
  "scripts/kat-bgagent-delete.ts",
  "scripts/kat-failed-runs.ts",
  "scripts/kat-genui-error-state.ts",
  "scripts/kat-hub-timeline.ts",
  "scripts/kat-mcp-tool-injection.ts",
  "scripts/kat-narrow-toggle.ts",
  "scripts/kat-notify-icon.ts",
  "scripts/kat-noun-discipline.ts",
  "scripts/kat-permission-approval.ts",
  "scripts/kat-provider-keyed-strip.ts",
  "scripts/kat-providers-recommended.ts",
  "scripts/kat-providers-tabs.ts",
  "scripts/kat-python-no-ambient-network.ts",
  "scripts/kat-recent-activity.ts",
  "scripts/kat-scheduled-next-run-widget.ts",
  "scripts/kat-scheduled-run-output.ts",
  "scripts/kat-settings-cleanliness.ts",
  "scripts/kat-task-lifecycle.ts",
  "scripts/kat-thinking-trace.ts",
  "scripts/kat-ux-lows.ts",
  "scripts/kat-wasi-tranche2.ts",
  "scripts/p0-repro.ts",
  "scripts/perf-leak-trace.ts",
  "scripts/screenshot-vision-evidence.ts",
  "scripts/sidepanel-companion-journey.ts",
  "scripts/tool-call-evidence.ts",
  "scripts/validate-package-load.ts",
  "scripts/verify-script-run.ts",
];

async function offenders(root = "scripts"): Promise<string[]> {
  const out: string[] = [];
  const scan = async (p: string) => {
    const src = await Deno.readTextFile(p);
    if (EVAL.test(src) && VALUE_READ.test(src) && !HANDLED.test(src)) out.push(p);
  };
  for await (const e of Deno.readDir(root)) {
    const p = `${root}/${e.name}`;
    if (e.isDirectory) {
      for await (const f of Deno.readDir(p)) {
        if (f.isFile && f.name.endsWith(".ts")) await scan(`${p}/${f.name}`);
      }
    } else if (e.isFile && e.name.endsWith(".ts")) {
      await scan(p);
    }
  }
  return out.sort();
}

Deno.test({
  name: "kwrx guard: no new unhandled value-reading evaluates; allowlist stays exact",
  fn: async () => {
    const found = await offenders();
    const allow = [...UNHANDLED].sort();
    const fresh = found.filter((f) => !allow.includes(f));
    const stale = allow.filter((f) => !found.includes(f));
    assert(fresh.length === 0, `NEW unhandled value-reading eval files (route them through scripts/lib/cdp-eval.ts): ${fresh.join(", ")}`);
    assert(stale.length === 0, `allowlist entries already migrated/handled — SHRINK this test's list in the same commit: ${stale.join(", ")}`);
    assertEquals(found.length, UNHANDLED.length, "unhandled count drifted");
  },
});

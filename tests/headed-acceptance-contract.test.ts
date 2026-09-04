// The headed acceptance (scripts/headed-acceptance.ts) is the OPTIONAL
// manual-evidence macro; the headless suites stay the canonical gate. What the
// macro must ALWAYS do, on any machine: refuse without --headed (exit 2),
// refuse without a reachable display (exit 2), and drive the CURRENT options
// UI — the options page renders its sections lazily, so a plain options.html
// opens on the providers section and the site-agent enroll controls the macro
// clicks are never rendered (a silent no-op click reads as a red journey).
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;

async function runMacro(args: string[]) {
  // A sealed environment: no DISPLAY / WAYLAND_DISPLAY can leak in from the
  // host, and XDG_RUNTIME_DIR points at an empty dir so a live compositor's
  // socket directory cannot make the macro probe a real session. The display
  // refusal is then deterministic on any machine.
  const xdg = await Deno.makeTempDir({ prefix: "cap-headed-refusal-" });
  try {
    const cmd = new Deno.Command("deno", {
      args: ["run", "-A", `${ROOT}scripts/headed-acceptance.ts`, ...args],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: Deno.env.get("HOME") ?? "/tmp",
        XDG_RUNTIME_DIR: xdg,
      },
    });
    const out = await cmd.output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    try { await Deno.remove(xdg, { recursive: true }); } catch { /* gone */ }
  }
}

Deno.test("headed acceptance: refuses to run without --headed (exit 2)", async () => {
  const { code, stderr } = await runMacro([]);
  assertEquals(code, 2, `expected the no-display refusal, got: ${stderr}`);
  assertStringIncludes(stderr, "REFUSED");
  // The refusal must point at the canonical HEADLESS acceptance.
  assertStringIncludes(stderr, "permission-matrix-acceptance.ts");
});

Deno.test("headed acceptance: refuses --headed without a display (exit 2)", async () => {
  const { code, stderr } = await runMacro(["--headed"]);
  assertEquals(code, 2, `expected the no-display refusal, got: ${stderr}`);
  assertStringIncludes(stderr, "REFUSED: no display");
});

Deno.test("headed acceptance: opens Settings only through a section deep link", () => {
  const src = Deno.readTextFileSync(`${ROOT}scripts/headed-acceptance.ts`);
  const urls = [...src.matchAll(/options\/options\.html([^"'`$)]*)/g)].map((m) => m[1]);
  assertEquals(urls.length > 0, true, "the macro no longer opens the options page at all?");
  for (const suffix of urls) {
    assertEquals(
      suffix.startsWith("#"),
      true,
      `plain options.html deep link — the lazy-rendered sections never show the controls the macro clicks (found: options/options.html${suffix})`,
    );
  }
});

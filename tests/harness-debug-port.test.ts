// CAP-FB-20260829-FIXED-DEBUG-PORTS-01 — no harness may name its own Chrome
// debugging port.
//
// A fixed port is not a guarantee of anything. Chrome refuses to bind a port
// that is already taken and keeps running WITHOUT a debugging endpoint, so a
// harness that then fetches 127.0.0.1:<fixed> gets answered by whatever else
// is there — a zombie from a killed run, or a second lane's Chrome with a
// different extension loaded. The harness drives somebody else's browser and
// prints a confident PASS/FAIL about a tree it never loaded. Nine scripts
// shared four ports before this gate existed.
//
// The guard is mechanical: the ONLY debugging-port literal allowed anywhere in
// scripts/ is `=0`, and it may only be written by the shared launcher.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { launchChrome } from "../scripts/lib/chrome-launch.ts";

const SCRIPTS = new URL("../scripts/", import.meta.url).pathname;
const LAUNCHER = "lib/chrome-launch.ts";

function scriptFiles(dir = SCRIPTS, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.isDirectory) out.push(...scriptFiles(`${dir}${e.name}/`, `${prefix}${e.name}/`));
    else if (/\.(ts|mjs|js|sh)$/.test(e.name)) out.push(`${prefix}${e.name}`);
  }
  return out;
}

Deno.test("no script hard-codes a Chrome remote-debugging port", () => {
  const offenders: string[] = [];
  for (const rel of scriptFiles()) {
    const src = Deno.readTextFileSync(`${SCRIPTS}${rel}`);
    for (const m of src.matchAll(/--remote-debugging-port=([^"'`\s,\]]*)/g)) {
      const value = m[1];
      if (value === "0") continue; // kernel-assigned: the one correct form
      offenders.push(`${rel}: --remote-debugging-port=${value}`);
    }
  }
  assertEquals(
    offenders,
    [],
    `a harness named its own debugging port; use launchChrome() from scripts/${LAUNCHER}:\n${offenders.join("\n")}`,
  );
});

Deno.test("the shared launcher owns the debugging-port flag", () => {
  // NOTE ON SCOPE, so this test is not read as more than it checks. The
  // SAFETY property — no script may name a port — is enforced by the test
  // above, and that is the property that stops a harness driving another
  // lane's browser. This one only asserts the shared launcher is a writer of
  // the flag, i.e. that it still owns a spawn path at all.
  //
  // It deliberately does NOT assert exclusivity. Roughly thirty scripts spawn
  // Chrome themselves with the safe `=0` form and were never part of this
  // defect; migrating them onto launchChrome() is a separate, larger cleanup.
  // Asserting exclusivity here would fail on all of them and say nothing about
  // the bug this entry fixed.
  const writers = scriptFiles().filter((rel) =>
    Deno.readTextFileSync(`${SCRIPTS}${rel}`).includes("--remote-debugging-port=0")
  );
  assert(writers.includes(LAUNCHER), `scripts/${LAUNCHER} must own a spawn path, found: ${writers.join(", ")}`);
});

Deno.test("launchChrome refuses a caller-chosen port rather than overriding it", async () => {
  await assertRejects(
    () => launchChrome({ binary: "/bin/true", args: ["--remote-debugging-port=9351"] }),
    Error,
    "refusing a caller-chosen debugging port",
  );
});

Deno.test("launchChrome fails honestly when the browser prints no endpoint", async () => {
  // /bin/true exits immediately and never prints a DevTools line. The launcher
  // must say so rather than hang or hand back a bogus URL.
  const err = await assertRejects(
    () => launchChrome({ binary: "/bin/true", args: [], timeoutMs: 3000 }),
    Error,
  );
  assert(
    String(err.message).includes("never printed a DevTools endpoint"),
    `unexpected failure message: ${err.message}`,
  );
});

Deno.test("launchChrome reads the real port back out of the child's own stderr", async () => {
  // A stand-in "browser" that prints the DevTools banner Chrome prints. The
  // port in the banner is the ONLY thing the launcher may trust — proving the
  // endpoint comes from this process and not from a probe of a shared port.
  const fake = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    fake,
    "#!/bin/sh\necho \"DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc\" 1>&2\nsleep 5\n",
  );
  await Deno.chmod(fake, 0o755);
  const { proc, wsUrl, port } = await launchChrome({ binary: fake, args: [], timeoutMs: 5000 });
  assertEquals(port, 31337);
  assertEquals(wsUrl, "ws://127.0.0.1:31337/devtools/browser/abc");
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  await proc.status;
  await Deno.remove(fake);
});

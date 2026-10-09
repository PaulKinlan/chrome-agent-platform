// gfxoc: Chrome-internal temp dirs must belong to the launch, not the host /tmp.
// Fake shell browser: no Chromium process or browser slot is consumed.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { launchChrome, teardownChrome, type LaunchedChrome } from "../scripts/lib/chrome-launch.ts";

function root(): string {
  return Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "gfxoc-chrome-" });
}

function fakeBrowser(dir: string): string {
  const path = join(dir, "browser.sh");
  Deno.writeTextFileSync(path, `#!/bin/sh
printf '%s' "$TMPDIR" > "$CAP_GFXOC_OUT"
/bin/mkdir -p "$TMPDIR/org.chromium.Chromium.fixture"
printf 'singleton' > "$TMPDIR/org.chromium.Chromium.fixture/SingletonSocket"
echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/gfxoc' >&2
exec /bin/sleep 30
`);
  Deno.chmodSync(path, 0o700);
  return path;
}

function exists(path: string): boolean {
  try { Deno.statSync(path); return true; } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

Deno.test("gfxoc: profile launch passes a short private TMPDIR and raw-proc teardown reaps Chrome residue idempotently", async () => {
  const dir = root(), profile = join(dir, "profile"), output = join(dir, "child-tmpdir.txt");
  const fake = fakeBrowser(dir);
  let launched: LaunchedChrome | undefined;
  try {
    Deno.mkdirSync(profile);
    launched = await launchChrome({ binary: fake, profile, lockPath: join(dir, "fixture.lock"),
      clearEnv: true, env: { CAP_GFXOC_OUT: output, TMPDIR: join(dir, "unowned") }, timeoutMs: 6000 });
    const scratch = launched.scratchDir;
    assert(typeof scratch === "string" && scratch.startsWith(`/tmp/cap-${Deno.pid}-`),
      `launcher must own a short /tmp dir, got ${scratch}`);
    assertEquals(Deno.readTextFileSync(output), scratch, "clearEnv and caller TMPDIR cannot bypass owned scratch");
    assert(exists(join(scratch, "org.chromium.Chromium.fixture", "SingletonSocket")), "Chrome-internal residue stays in the owned scratch");
    assert(new TextEncoder().encode(`${scratch}/org.chromium.Chromium.XXXXXX/SingletonSocket`).length < 108,
      "TMPDIR must leave room for the Unix-domain singleton socket path");
    await teardownChrome(launched.proc, profile); // Most harnesses destructure proc; WeakMap must carry the scratch.
    assert(!exists(scratch), "teardown must remove the entire owned Chrome scratch after killing the process tree");
    assert(!exists(profile), "existing profile cleanup must still work");
    await teardownChrome(launched.proc, profile);
    assert(!exists(scratch), "second teardown stays harmless");
  } finally {
    if (launched) await teardownChrome(launched.proc, profile);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("gfxoc: no-profile launch keeps caller TMPDIR and creates no owned scratch", async () => {
  const dir = root(), output = join(dir, "child-tmpdir.txt"), fake = fakeBrowser(dir);
  let launched: LaunchedChrome | undefined;
  try {
    launched = await launchChrome({ binary: fake, lockPath: join(dir, "fixture.lock"), clearEnv: true,
      env: { CAP_GFXOC_OUT: output, TMPDIR: dir }, timeoutMs: 6000 });
    assertEquals(launched.scratchDir, undefined);
    assertEquals(Deno.readTextFileSync(output), dir);
    await launched.close?.();
    assert(exists(dir), "launcher must not remove a no-profile caller's TMPDIR");
  } finally {
    if (launched) await teardownChrome(launched);
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("gfxoc: browser startup refusal cleans the newly allocated scratch before returning", async () => {
  const dir = root(), profile = join(dir, "profile"), fake = join(dir, "missing-binary");
  try {
    // The parallel runner shares Deno.pid across test files. An isolated child
    // owns this prefix, so a different test's concurrent launch cannot change
    // the before/after set and falsely redden our startup-refusal assertion.
    const program = `
      import { launchChrome } from ${JSON.stringify(new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href)};
      const names = () => [...Deno.readDirSync("/tmp")].map((e) => e.name)
        .filter((name) => name.startsWith(\`cap-\${Deno.pid}-\`)).sort();
      const before = names();
      let refused = false;
      try { await launchChrome({ binary: ${JSON.stringify(fake)}, profile: ${JSON.stringify(profile)},
        lockPath: ${JSON.stringify(join(dir, "fixture.lock"))}, timeoutMs: 3000 }); }
      catch { refused = true; }
      console.log(JSON.stringify({ refused, before, after: names() }));
    `;
    const child = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "-A", "--config", new URL("../deno.runner.jsonc", import.meta.url).pathname, program],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "piped", stderr: "piped",
    }).output();
    assertEquals(child.code, 0, new TextDecoder().decode(child.stderr));
    const result = JSON.parse(new TextDecoder().decode(child.stdout).trim());
    assertEquals(result.refused, true, "missing browser must fail to start");
    assertEquals(result.after, result.before, "startup refusal must not leak its own Chrome scratch");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

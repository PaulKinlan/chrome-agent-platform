// cap-evidence/perf-4ctv/s3-ntp-paint.ts — S3: new-tab render
// (chrome-agent-platform-4ctv).
//
//   deno run -A cap-evidence/perf-4ctv/s3-ntp-paint.ts [samples] [load]
//
// Method: fresh profile per sample (cold caches), open the NTP, and read the
// PLATFORM's own timers (M5): Paint Timing (first-contentful-paint),
// PerformanceNavigationTiming (domContentLoaded, loadEvent), plus a
// surface-readiness poll — the time until <agent-composer> exists AND has
// rendered content (shadow children), because a paint of an empty shell is
// not the surface a person uses. Per-sample ok/err; two machine loads (M2:
// idle / 16-burner `load`); machine, build target and commit recorded.

import { launchChrome, openCdp, computeUnpackedExtensionId } from "../../scripts/lib/chrome-launch.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const SAMPLES = Math.max(1, Number(Deno.args[0] ?? 5));
const LOAD = Deno.args[1] === "load";
// S4/S5: pass a page path and a readiness selector for other surfaces.
const URL_PATH = Deno.args[2] ?? "ntp/ntp.html";
const READY_SELECTOR = Deno.args[3] ?? "agent-composer";

function loadavg() {
  try { return Deno.readTextFileSync("/proc/loadavg").split(" ").slice(0, 3).join(" "); } catch { return "?"; }
}

async function sample(extId: string): Promise<Record<string, unknown>> {
  const profile = await Deno.makeTempDir({ prefix: "cap-4ctv-s3-" });
  const t0 = performance.now();
  const { proc, wsUrl } = await launchChrome({ extension: EXT, profile, timeoutMs: 60_000 });
  const cdp = await openCdp(wsUrl);
  try {
    const tOpen = performance.now();
    const { sessionId } = await cdp.open(`chrome-extension://${extId}/${URL_PATH}`);
    const r: any = await cdp.eval(sessionId, `(async () => {
      const navStart = performance.timeOrigin;
      // Headless quiesces frames until one is requested — force two so the
      // paint pipeline actually runs (else the paint entries never appear).
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 50));
      const paint = performance.getEntriesByType("paint").map((e) => ({ name: e.name, startTime: e.startTime }));
      const nav = performance.getEntriesByType("navigation")[0] || {};
      let readyAt = null;
      for (let i = 0; i < 400; i++) {
        const c = document.querySelector(${JSON.stringify(READY_SELECTOR)});
        if (c && (c.shadowRoot ? c.shadowRoot.childElementCount > 0 : c.childElementCount > 0)) { readyAt = performance.now(); break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      return {
        fcp: paint.find((e) => e.name === "first-contentful-paint")?.startTime ?? null,
        fp: paint.find((e) => e.name === "first-paint")?.startTime ?? null,
        dcl: nav.domContentLoadedEventEnd ?? null,
        load: nav.loadEventEnd ?? null,
        readyAt,
        now: performance.now(),
      };
    })()`);
    const tDone = performance.now();
    return {
      ok: r && r.fcp != null,
      err: r?.fcp == null ? "no FCP entry" : undefined,
      launchToOpenMs: +(tOpen - t0).toFixed(2),
      fcpMs: r?.fcp != null ? +r.fcp.toFixed(2) : null,
      fpMs: r?.fp != null ? +r.fp.toFixed(2) : null,
      dclMs: r?.dcl != null ? +r.dcl.toFixed(2) : null,
      loadMs: r?.load != null ? +r.load.toFixed(2) : null,
      composerReadyMs: r?.readyAt != null ? +r.readyAt.toFixed(2) : null,
      evalWallMs: +(tDone - tOpen).toFixed(2),
    };
  } finally {
    cdp.close();
    proc.kill("SIGTERM");
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
}

const burners: Deno.ChildProcess[] = [];
if (LOAD) {
  for (let i = 0; i < 16; i++) {
    burners.push(new Deno.Command("deno", { args: ["eval", "while (true) { Math.sqrt(Math.random()); }"], stdout: "null", stderr: "null" }).spawn());
  }
  await new Promise((r) => setTimeout(r, 3000));
}

const commit = new TextDecoder().decode(
  (new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD"], cwd: ROOT, stdout: "piped" })).outputSync().stdout,
).trim();
const target = await Deno.readTextFile(`${EXT}/dist/dist.complete`).catch(() => "");
const extId = await computeUnpackedExtensionId(EXT);
const conditions = {
  bead: "chrome-agent-platform-4ctv S3 (new-tab render)",
  commit,
  buildTarget: /"target":\s*"(\w+)"/.exec(target)?.[1] ?? "unknown",
  machine: `${Deno.build.os}/${Deno.build.arch}`,
  loadLabel: LOAD ? "artificial-16-burners" : "idle",
  loadavgBefore: loadavg(),
};

const results: Record<string, unknown>[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const r = await sample(extId);
  results.push(r);
  console.log(`sample ${i + 1}/${SAMPLES}:`, JSON.stringify(r));
}

for (const b of burners) { try { b.kill("SIGKILL"); } catch { /* done */ } }
console.log("\nS3 SUMMARY:", JSON.stringify({ conditions: { ...conditions, loadavgAfter: loadavg() }, results }, null, 1));

// Build the MV3 service worker + shared agent-core modules with esbuild
// (the AI SDK + zod need bundling for the service-worker environment).
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const OUT = "extension/dist/background/service-worker.js";
const OPTIONS_OUT = "extension/options/options.bundle.js";

const shared = {
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
  sourcemap: false,
  legalComments: "none",
};

await build({
  ...shared,
  entryPoints: ["extension/background/service-worker.js"],
  outfile: OUT,
  inject: [new URL("./browser-shim-process.js", import.meta.url).pathname],
  alias: (() => {
    const root = new URL(".", import.meta.url).pathname;
    const shim = `${root}browser-shim-node.js`;
    return {
    "node:fs": shim,
    "node:fs/promises": shim,
    "node:path": shim,
    "node:os": shim,
    "node:crypto": shim,
    "node:process": shim,
    "node:stream": shim,
    "node:util": shim,
    "node:module": shim,
    "node:child_process": shim,
    "fs": shim,
    "path": shim,
    "child_process": shim,
  };
  })(),
});

// Bundle the options page too — it imports lib/provider.js which pulls the AI
// SDK (bare npm specifiers), which a plain module script cannot resolve.
await build({
  ...shared,
  entryPoints: ["extension/options/options.js"],
  outfile: OPTIONS_OUT,
  alias: (() => {
    const root = new URL(".", import.meta.url).pathname;
    const shim = `${root}browser-shim-node.js`;
    return {
      "node:fs": shim, "node:fs/promises": shim, "node:path": shim, "node:os": shim,
      "node:crypto": shim, "node:process": shim, "node:stream": shim, "node:util": shim,
      "node:module": shim, "node:child_process": shim, "fs": shim, "path": shim, "child_process": shim,
    };
  })(),
});
console.log(`built ${OPTIONS_OUT}`);

// MV3 CSP forbids eval / new Function. ajv (a transitive dep of the MCP SDK,
// which agent-do pulls in for MCP-tool support we do NOT use at runtime) emits
// `new Function` in its schema-JIT path. Replace it with a throw so the bundle
// is CSP-clean — that path is dead in this extension, so the throw never runs.
const bundle = await readFile(OUT, "utf8");
const occurrences = (bundle.match(/new Function\s*\(/g) ?? []).length;
let cleaned = bundle.replace(/new Function\s*\(/g, "(function(){ throw new Error('eval disabled (MV3 CSP)'); })(");

// zod v4 probes eval availability with `const F = Function; new F("")` to decide
// its JIT fast-path. `new F("")` constructs the Function constructor via a
// variable, so the `new Function(` rule above does NOT match it — and under MV3
// CSP the probe both throws AND logs a "Hash of blocked script: eval-sha256-..."
// warning on every evaluation. Replace it with a throw so the probe short-
// circuits to false without ever invoking the Function constructor (the JIT
// path it gates is dead in this extension anyway).
const zodProbes = (cleaned.match(/new F\(""\)/g) ?? []).length;
cleaned = cleaned.replace(
  /new F\(""\)/g,
  '(() => { throw new Error("eval disabled (MV3 CSP)"); })()',
);
await writeFile(OUT, cleaned);

const remaining = (cleaned.match(/new Function\s*\(|eval\s*\(|new F\(""\)/g) ?? []).length;
if (remaining > 0) {
  throw new Error(`bundle still contains ${remaining} eval/new-Function sites after cleaning`);
}
console.log(`built ${OUT} (removed ${occurrences} new-Function + ${zodProbes} Function-constructor probe site(s); ${remaining} remaining)`);

// Sync the design-system source into the docs/ component gallery so the
// GitHub Pages showcase (docs/) always matches the canonical Web Components
// in extension/shared/components.js. (The docs/ copies are committed too, so
// the gallery works standalone; this keeps them from drifting on every build.)
import { copyFile } from "node:fs/promises";
await copyFile(new URL("./extension/shared/components.js", import.meta.url), new URL("./docs/components.js", import.meta.url));
await copyFile(new URL("./extension/shared/theme.css", import.meta.url), new URL("./docs/theme.css", import.meta.url));
console.log("synced docs/components.js + docs/theme.css");

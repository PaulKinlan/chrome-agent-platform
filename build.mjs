// Build the MV3 service worker + shared agent-core modules with esbuild
// (the AI SDK + zod need bundling for the service-worker environment).
import { build } from "esbuild";

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
  outfile: "extension/dist/background/service-worker.js",
  alias: { "node:fs": "browser-shim-fs.js", "node:path": "browser-shim-path.js" },
});
console.log("built extension/dist/background/service-worker.js");

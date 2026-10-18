// tv7bz — a disposable Store build containing a schema-2 manifest needs the
// SAME options-only validation broker that Settings uses. Normal schema-1
// builds must not load it or pull it into the shipped service-worker graph.
// @ts-nocheck
import { assert } from "jsr:@std/assert@1";

Deno.test("Store build registers schema-2 admission before validating bundled manifest identity", async () => {
  const source = await Deno.readTextFile(new URL("../build.mjs", import.meta.url));
  const validation = source.indexOf("registerBundledManifestIdentity(manifestIdentities, identity, manifest)");
  const schema2Only = source.indexOf("if (manifest.schemaVersion === 2 && !schema2AdmissionReady)");
  const admission = source.indexOf('await import("./extension/lib/wasm-package-admission.js")');
  assert(validation > 0, "Store build must validate inventory manifest identity");
  assert(schema2Only > 0 && schema2Only < admission && admission < validation,
    "load the real options-only broker on the schema-2 path before its authority probe; never for schema-1 builds");
});

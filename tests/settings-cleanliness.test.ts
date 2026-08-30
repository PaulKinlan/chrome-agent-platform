import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const read = (path: string) => Deno.readTextFileSync(new URL(path, import.meta.url));
const html = read("../extension/options/options.html");
const options = read("../extension/options/options.js");
const components = read("../extension/shared/components.js");
const onboarding = read("../extension/lib/first-run-onboarding.js");
const pure = read("../extension/lib/pure.js");
const gallery = read("../docs/components.html");

Deno.test("settings cleanliness: every navigation item names a real section", () => {
  const sections = new Set([...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]));
  const nav = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
  const dead = nav.filter((id) => !sections.has(id));
  assert(dead.length === 0, `dead Settings navigation: ${dead.join(", ")}`);
  assert(!pure.includes('"appearance"'), "the removed Appearance hash is not accepted as live UI");
  assert(!pure.includes('"approvals"'), "the removed Approvals hash is not accepted as live UI");
});

Deno.test("settings cleanliness: the request-era Verify storage control is removed end to end", () => {
  for (const [name, source] of Object.entries({ html, options, components, onboarding, gallery })) {
    assert(!source.includes("storage-durability-warning"), `${name} still carries the retired control`);
    assert(!source.includes("requestStorageFromOwnerClick"), `${name} still carries the retired click verifier`);
    assert(!source.includes("enable-storage"), `${name} still carries the retired control event`);
    assert(!source.includes("Verify storage"), `${name} still carries the retired action copy`);
  }
});

Deno.test("settings cleanliness: API-key persistence still fails closed when install storage is missing", () => {
  assertStringIncludes(options, "function blockSessionOnlyCredentialSave(input)");
  assertStringIncludes(options, "credentialNeedsDurableStorage({ enteredKey: input?.value ?? \"\", storageGranted })");
  assertStringIncludes(options, "Storage is missing from this installation. Reload the extension; if it is still missing, reinstall the extension before saving an API key.");
  const guard = options.indexOf("shouldBlock: () => blockSessionOnlyCredentialSave(credentialInput)");
  const persist = options.indexOf("requestHostAccess: requestProviderHostAccess", guard);
  assert(guard >= 0 && persist > guard, "the synchronous durability guard stays before provider persistence");
});

Deno.test("settings cleanliness: real owner controls and honest permission states remain", () => {
  for (const marker of [
    'id="browser-grant"',
    'id="fs-add-directory-btn"',
    'id="permission-list"',
    'id="hook-list"',
  ]) assertStringIncludes(html, marker);
  assertStringIncludes(options, "async function renderPermissions()");
  assertStringIncludes(options, 'required ? "MISSING — reload the extension" : "Not enabled"');
  assertStringIncludes(options, "if (!required && !granted)");
  assertStringIncludes(options, "requestCapability(cap.id)");
});

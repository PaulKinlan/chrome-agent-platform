import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const read = (path: string) => Deno.readTextFileSync(new URL(path, import.meta.url));
const html = read("../extension/options/options.html");
const options = read("../extension/options/options.js");
const providers = read("../extension/options/panels/providers.js");
const permissions = read("../extension/options/panels/permissions.js");
const hooks = read("../extension/options/panels/hooks.js");
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
  assertStringIncludes(providers, "function blockSessionOnlyCredentialSave(input)");
  assertStringIncludes(providers, "credentialNeedsDurableStorage({ enteredKey: input?.value ?? \"\", storageGranted })");
  assertStringIncludes(providers, "Storage is missing from this installation. Reload the extension; if it is still missing, reinstall the extension before saving an API key.");
  const guard = providers.indexOf("shouldBlock: () => blockSessionOnlyCredentialSave(credentialInput)");
  const persist = providers.indexOf("requestHostAccess: requestProviderHostAccess", guard);
  assert(guard >= 0 && persist > guard, "the synchronous durability guard stays before provider persistence");
});

Deno.test("settings cleanliness: real owner controls and install-grant diagnostics remain", () => {
  for (const marker of [
    'id="browser-grant"',
    'id="fs-add-directory-btn"',
    'id="permission-list"',
    'id="hook-list"',
  ]) assertStringIncludes(html, marker);
  assertStringIncludes(permissions, "async function renderPermissions()");
  // OPTIONAL + JIT model: the Permissions section is a live three-state
  // display (granted = the switch / requestable = the ghost Turn on button /
  // platform-unavailable = text) plus the fixed mandatory "Always on" group,
  // every row a shared <capability-row>
  // (CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01).
  assertStringIncludes(permissions, 'document.createElement("capability-row")');
  assertStringIncludes(permissions, 'row.dataset.state = "granted"');
  assertStringIncludes(permissions, 'row.setAttribute("action-state", "on")');
  assertStringIncludes(permissions, 'row.dataset.state = "requestable"');
  assertStringIncludes(permissions, 'row.setAttribute("action-label", "Turn on")');
  assertStringIncludes(permissions, 'row.dataset.state = "unavailable"');
  assertStringIncludes(permissions, 'row.setAttribute("action-label", "Not available on this platform")');
  assertStringIncludes(permissions, 'row.dataset.state = "required"');
  assertStringIncludes(permissions, 'row.setAttribute("action-label", "Always on")');
  // The hand-rolled card row is gone from both sections (the board deny list
  // is the only remaining .perm-row user).
  const permissionsFn = permissions.slice(permissions.indexOf("async function renderPermissions()"), permissions.indexOf("async function renderHooks()"));
  assert(!permissionsFn.includes('"perm-row"'), "Permissions no longer hand-rolls .perm-row cards");
  const hooksFn = hooks.slice(hooks.indexOf("async function renderHooks()"), hooks.indexOf("// vocab:advanced:end"));
  assert(!hooksFn.includes('"perm-row"') && !hooksFn.includes("danger"), "Hooks is a table of switches, not danger-button cards");
  assertStringIncludes(hooksFn, 'document.createElement("switch-toggle")');
  assertStringIncludes(html, '<table id="hook-list" class="hooks-table">');
});

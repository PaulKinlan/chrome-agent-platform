// tests/empty-states-716s7.test.ts — Unit and DOM assertions for bead chrome-agent-platform-716s.7:
// Empty states for Artifacts and Directory pages with owner voice and direct next-step action.
import { assert, assertEquals } from "jsr:@std/assert@1";

const read = (p: string) => Deno.readTextFile(p);

Deno.test("716s.7: <empty-state> web component is defined and exported in components.js", async () => {
  const componentsSrc = await read("extension/shared/components-core.js");
  assert(componentsSrc.includes('customElements.define("empty-state", EmptyState);'), "components.js must define empty-state");
  assert(componentsSrc.includes('class EmptyState extends Component'), "components.js must declare EmptyState");
});

Deno.test("716s.7: Artifacts empty state uses <empty-state> with owner voice copy and action button", async () => {
  const artifactsJs = await read("extension/artifacts/index.js");
  const artifactsHtml = await read("extension/artifacts/index.html");
  const messages = JSON.parse(await read("extension/_locales/en/messages.json"));

  // Check artifacts index.js creates empty-state
  assert(artifactsJs.includes('document.createElement("empty-state")'), "artifacts/index.js must create empty-state element");
  assert(!artifactsJs.includes('No artifacts yet. Ask an agent to make something.'), "old empty state copy must be removed");

  // Check messages.json keys
  assertEquals(messages.artifacts_empty_title?.message, "Nothing made yet");
  assertEquals(messages.artifacts_empty_desc?.message, "Documents, reports, tables, and files your agents create will show up here.");
  assertEquals(messages.artifacts_empty_action?.message, "Start a task in the hub");

  // Filter / search hide logic when unfiltered artifacts count is 0
  assert(artifactsJs.includes('kindFilter.hidden = !assets.length') || artifactsJs.includes('hidden = !assets.length'), "must hide filter controls when no assets");
});

Deno.test("716s.7: Directory empty state uses <empty-state> with owner voice and direct Settings action", async () => {
  const dirJs = await read("extension/directory/directory.js");
  const dirHtml = await read("extension/directory/directory.html");
  const messages = JSON.parse(await read("extension/_locales/en/messages.json"));

  // Header landmark and h1 alignment
  assert(dirHtml.includes('<header class="head">'), "directory.html must have a header landmark");
  assert(dirHtml.includes('Directory</h1>') || dirHtml.includes('directory_title'), "directory h1 must align with nav label 'Directory'");
  assert(!dirHtml.includes('>Agent directory<'), "directory.html must not have 'Agent directory' in h1");

  // Lead copy check
  assert(dirHtml.includes('Sites that offer agent tools will appear here automatically as you browse.'), "directory lead copy must be owner voice");
  assert(!dirHtml.includes('declared WebMCP, linked, or inferred functions'), "directory lead copy must not contain system vocabulary");
  assert(!dirHtml.includes('schema, provenance, and policy state'), "directory lead copy must not contain system jargon");

  // Empty state component in directory.js
  assert(dirJs.includes('document.createElement("empty-state")'), "directory.js must create empty-state element");
  assert(!dirJs.includes('No sites yet. When an open page offers tools'), "old directory empty copy must be removed");

  // Messages check
  assertEquals(messages.directory_title?.message, "Directory");
  assertEquals(messages.directory_sub?.message, "Sites that offer agent tools will appear here automatically as you browse.");
  assertEquals(messages.directory_empty_title?.message, "Nothing here yet");
  assertEquals(messages.directory_empty_desc?.message, "No remote agents connected yet. Connect a remote agent in Settings or install a skill pack.");
  assertEquals(messages.directory_empty_action?.message, "Connect a remote agent");
});

Deno.test("716s.7: Gallery showcase documents <empty-state>", async () => {
  const showcaseHtml = await read("docs/components.html");
  assert(showcaseHtml.includes('&lt;empty-state&gt;'), "docs/components.html must feature empty-state specimen");
});

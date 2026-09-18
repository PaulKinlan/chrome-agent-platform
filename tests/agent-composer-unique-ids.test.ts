// tests/agent-composer-unique-ids.test.ts — chrome-agent-platform-sndb:
// Multiple <agent-composer> instances in one document must NEVER share the same
// id="task-input" or id="run-task".
//
// In the NTP hub, both #composer and #thread-composer exist in the same document.
// When both carried id="task-input", document.getElementById("task-input")
// silently resolved to the hub composer even while the user was viewing the thread
// view, causing input to be directed to a hidden element.
//
// This test asserts:
//   1. AgentComposer renders dynamic, scoped IDs instead of fixed id="task-input" / id="run-task".
//   2. AgentComposer exposes [data-composer-input] and [data-composer-send] attributes.
//   3. Components focusInput() resolves via [data-composer-input].
//   4. NTP and sidepanel markup declare distinct composer host IDs.

import { assert, assertEquals } from "jsr:@std/assert@1";

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

Deno.test("sndb: AgentComposer renders dynamic per-instance IDs and no fixed task-input", async () => {
  const js = await read("../extension/shared/components.js");

  // 1. Fixed id="task-input" and id="run-task" must NOT be hardcoded in the template
  assert(
    !/<textarea id="task-input"/.test(js),
    'AgentComposer must not hardcode <textarea id="task-input"',
  );
  assert(
    !/<button id="run-task"/.test(js),
    'AgentComposer must not hardcode <button id="run-task"',
  );

  // 2. The textarea must have class="composer-input", data-composer-input, and dynamic ID
  assert(
    /data-composer-input/.test(js),
    'textarea must declare data-composer-input attribute',
  );
  assert(
    /id="\$\{this\.id \? `\$\{this\.id\}-input` : `cmp-input-\$\{this\._uid\}`\}"/.test(js),
    'textarea must derive scoped ID from this.id or this._uid',
  );

  // 3. The send button must have data-composer-send and dynamic ID
  assert(
    /data-composer-send/.test(js),
    'send button must declare data-composer-send attribute',
  );
  assert(
    /id="\$\{this\.id \? `\$\{this\.id\}-send` : `cmp-send-\$\{this\._uid\}`\}"/.test(js),
    'send button must derive scoped ID from this.id or this._uid',
  );

  // 4. focusInput() must use [data-composer-input]
  assert(
    /focusInput\(\) \{[\s\S]*?querySelector\("\[data-composer-input\]"\)/.test(js),
    'focusInput() must query for [data-composer-input]',
  );
});

Deno.test("sndb: NTP and sidepanel host declarations use distinct composer IDs", async () => {
  const ntp = await read("../extension/ntp/ntp.html");
  const sidepanel = await read("../extension/sidepanel/sidepanel.html");

  // In NTP:
  assert(ntp.includes('<agent-composer id="composer"'), 'NTP must declare <agent-composer id="composer"');
  assert(ntp.includes('<agent-composer id="thread-composer"'), 'NTP must declare <agent-composer id="thread-composer"');

  // In Sidepanel:
  assert(sidepanel.includes('<agent-composer id="page-composer"'), 'Sidepanel must declare <agent-composer id="page-composer"');
  assert(sidepanel.includes('<agent-composer id="agent-composer"'), 'Sidepanel must declare <agent-composer id="agent-composer"');
});

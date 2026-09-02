# Copy — the voice rule

Every string a person reads in the product follows five lines. The checker
(`scripts/check-vocabulary.mjs`, `npm run check:vocabulary`) enforces the last
one mechanically; the first four are the design pass on every touched string.

1. **Speak from the reader's side of the screen.** Say what they can do next,
   not what the system did or did not do. "Open a site and I'll look for tools
   you can use." — never "Discovery has not run yet."
2. **One sentence per empty state, in the second person, naming one action.**
   An empty state is an invitation, not a status report.
3. **A control says exactly what happens.** The Delete button says "Delete".
   A toggle's description says what turning it on does ("Let the hub hand
   parts of a task to your Site Agents."), not what the two positions mean.
4. **A delete dialog says what the person loses, in their words.** All three
   surfaces (hub, Settings, side panel) share `deleteAgentDialog` in
   `extension/shared/components.js`: "Its memory and history are removed.
   Artifacts it made are kept." / "Its schedule stops and its history is
   removed." Never the machinery's inventory of what it deletes.
5. **The system's words stay in Settings → Advanced.** The banned list below
   is not allowed in user-facing copy. Settings → Advanced and the other
   developer-only sections (`data-developer="true"`), any element marked
   `data-vocab="advanced"`, and any JS line or region marked `vocab:advanced`
   may use them — they exist to show the machinery.

## Banned in user-facing copy

`discovery` · `diagnostics` · `catalog` · `generation` · `registry` ·
`attestation` · `alarm(s)` · `runtime` · `lifecycle` · `chars` · `override(s)` ·
`has not run` — plus the noun rules from CAP-FB-20260828-NOUN-DISCIPLINE-01
(`asset`, `recipe`, `starter task`, "host access is optional").

Protocol vocabulary (`modelContent`, `search_tools`, `selectionRef`,
`catalogGeneration`, a bracketed `[demo model]` tag) never reaches the screen:
the activity rows and the thread previews strip a leading transport tag, and
the demo model is reachable only behind the developer flag.

## Replacements that landed (CAP-FB-20260830-USER-VOICE-COPY-01)

| Before | After |
|---|---|
| Discovery has not run yet. | Open a site and I'll look for tools you can use. |
| WebMCP discovery: `origin` | Tools on `origin` |
| Cancel orphaned alarms | Stop schedules for deleted agents |
| When off, the hub is a single agent. When on, the hub fans out to Site Agents. | Let the hub hand parts of a task to your Site Agents. |
| This will permanently remove the agent registry entry, its memory store, system prompt override, and custom provider configuration… | Its memory and history are removed. Artifacts it made are kept. |
| This will cancel its scheduled task and remove the recurring alarm. | Its schedule stops and its history is removed. |
| This will disenroll the site, unregister its N tools, revoke dynamic scripts, and remove host permissions. | It stops working on this site and its page tools are removed. Artifacts it made are kept. |
| [demo model] Task received (N chars). Configure a real provider in Settings to get real completions. This demo response proves the agent loop runs end-to-end. | I'm the built-in demo, so I can't do this yet. Connect a model in Settings and ask again. |
| N tools visible to diagnostics · catalog generation `hash` | N tools available · tool list version `hash` |
| Core runtime permission — the hub cannot boot without it. | The hub cannot start without it. |
| Host access and the core runtime permissions are granted at install. | Host access and the permissions the extension needs to run are granted at install. |
| …memory, alarms, downloaded models… | …memory, schedules, downloaded models… |
| show more (N more chars) | show more (N more characters) |

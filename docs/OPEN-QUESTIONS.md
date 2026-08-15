# Open questions for Paul

1. **Agent model**: one hub agent that fans out to site sub-agents, or a single agent that
   loads per-site context on demand? (The design assumes a hub agent + lightweight per-site
   context; confirm.)
2. **Consumer view**: you asked for ideas. Proposal — a "next steps" tray on every
   navigation: the agent offers 2-3 useful actions ("summarise this", "add to a watch
   alarm", "compare with X") without taking over browsing. Confirm or reshape.
3. **Tool approval**: should inferred (window.*) tools require one-time user approval per
   origin before the agent may call them, or be auto-available? (Design assumes approval.)
4. **Memory persistence**: OPFS is per-extension-origin; fine for now, or do you want a
   sync/export path (cloud backup) in scope?
5. **WASM tool integration**: import a minimal WASM tool set with an upload
   mechanism for the owner to add more, or start with the existing WebMCP
   (window.*) tool inference + approval flow?
6. **MHTML vs screenshots**: both? Screenshots for the chat strip, MHTML for full-page
   archives. Confirm storage budget/retention.
7. **Extension name/packaging**: "Chrome Agent Platform" placeholder — rename later.

# Headed acceptance (optional manual evidence — never a gate)

The canonical acceptance for the permission model is **headless**:
`scripts/permission-matrix-acceptance.ts` (+ `scripts/permission-variant.mjs`,
see [PERMISSION-MATRIX.md](PERMISSION-MATRIX.md)). Screenshot capture success
is journey-covered headless as well. No merge or release decision depends on a
headed run.

`scripts/headed-acceptance.ts` is an **optional** macro that produces eyeball
evidence on a machine with a real display. It exists because three things are
genuinely impossible to automate:

1. **The extension action-icon screenshot gesture.** Clicking the extension's
   toolbar icon grants transient `activeTab` for the tab the owner is viewing,
   which is the only gesture that authorizes that capture. No CDP mechanism can
   synthesize a toolbar click, so the headless suites assert the fail-closed
   denial and this macro covers the success. This is the one MANUAL step: a
   human clicks the action icon while viewing the fixture page, and the macro
   polls until the screenshot entry appears in the hub's memory journal.
2. **The enrollment lifecycle as one headed journey.** Enroll → discover →
   pick → invoke → clean up → retry, driven through the real Settings and hub
   UI with real input events. Redundant with the headless suites; retained as
   eyeball evidence.
3. **Chrome's native permission prompt bubbles.** Those are Chrome's own code.
   They are asserted nowhere in this project and claimed nowhere as covered —
   this macro merely runs in an environment where they can appear.

Every other step is AUTOMATED (CDP-driven clicks and polls). Every step is
labelled `MANUAL` or `AUTOMATED` (printed as `manual-user-click` / `auto`) in
the log and in the evidence manifest.

## Running

```sh
HEADED_EVIDENCE_DIR=$HOME/cap-evidence/headed-acceptance-$(date +%s) \
  deno run -A scripts/headed-acceptance.ts --headed
```

Requirements: a reachable display (Wayland with `grim` + an unlocked Hyprland
session, or X11 via `DISPLAY`), `/usr/bin/chromium`, and a freshly built
extension bundle (the macro runs `npm run build` itself and refuses to drive a
stale one).

## Fail-closed refusals (exit 2)

The pre-flight refuses before any browser launch, and every refusal is honest:

- no `--headed` flag — the macro points at the canonical headless acceptance;
- no reachable display;
- Wayland detected but `grim` missing (screenshots are the evidence);
- compositor unreachable, or no active monitors (locked/idle session — the OS
  prompts could not be shown);
- `/usr/bin/chromium` missing;
- evidence directory on `/tmp` or `/dev/shm` (RAM-backed; evidence must be
  durable).

Exit codes: `0` every step passed, `1` one or more steps failed, `2` refused
before running.

## Evidence

Everything lands in durable storage — by default
`$HOME/cap-evidence/headed-acceptance/<ISO timestamp>/`, overridable with
`HEADED_EVIDENCE_DIR`:

- `screenshots/` — full-screen `grim` captures of each stage plus the CDP
  capture of the fixture page;
- `headed-acceptance-manifest.json` — overall status (`ATTESTED`/`OPEN`), the
  commit under test, the evidence directory, and every step with its
  MANUAL/AUTOMATED label and pass flag.

The contract guard for the refusals and the durable-evidence rules lives in
`tests/headed-acceptance-contract.test.ts`.

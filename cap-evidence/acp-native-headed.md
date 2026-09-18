# Headed ACP transport acceptance (gab8)

This check proves **transport**, not a real adapter or provider/model turn. It
uses the existing deterministic `tests/fixtures/acp-fake-adapter.mjs` behind real
Chrome native IPC, then behind the WebSocket fallback. It does not activate
native messaging in the shipped extension or change historical probe pins.

## Prepare an isolated copy

In a fully bootstrapped, built worktree, with `CAP_DURABLE_ROOT` pointing to
owned disk-backed evidence storage:

```sh
node cap-evidence/prepare-acp-native-copy.mjs
```

The JSON output names a fresh directory, generated extension and path-derived
extension ID. `receipt.json` records current source/build inventories, source
commit, protected-file digests and the sole JSON delta:
`add /permissions/- = nativeMessaging`. No fixture manifest is committed.
The copy materializes build symlinks and refuses any remaining symlink: a
file-hash walk that follows links does not prove an independent copy.

Keep the receipt, record the activation boundary before launching, and discard
the generated `extension/` directory after the runs. Never load a copy whose
inventory has changed since preparation. Rebuilding the source must not alter
its bytes. Do not edit/re-pin `extension/manifest.json` or loaded-probe evidence.

## Native run

Use a fresh test HOME (not the real user's HOME), an allowlisted PATH containing
Node and Deno, and an existing populated `DENO_DIR`. Run the normal installer
with that HOME and `--extension-id <generated ID>`.

Linux per-user native-host lookup follows **`DIR_USER_DATA/NativeMessagingHosts`**.
A custom `--user-data-dir` does not read the default product directory under
`HOME/.config`. `CAP_ACCEPTANCE_NATIVE_MANIFEST` therefore points to the
installer-created `HOME/.config/chromium/NativeMessagingHosts/com.chrome_agent_platform.acp.json`.
The driver copies its unchanged bytes into its own fresh profile, checks
name/type/allowed origin, and records the registration digest. This is test
scaffolding, not an installer/product change or a committed host fixture.

Run `deno run -A cap-evidence/acp-browser-acceptance.ts` with:

- `CAP_ACCEPTANCE_EXT`: generated extension path.
- `CAP_ACCEPTANCE_HEADED=1`, `CAP_ACCEPTANCE_NO_BRIDGE=1`,
  `CAP_ACCEPTANCE_EXPECT_NATIVE=1`, `CAP_ACCEPTANCE_EXPECT='fake reply'`.
- `CAP_ACCEPTANCE_NATIVE_MANIFEST`: installer output described above.
- `CAP_ACCEPTANCE_FRAME_LOG`: a fresh absolute fixture-log path.
- `CAP_ACCEPTANCE_CHROME_ENV`: comma-separated `K=V` pairs for the isolated
  `HOME`, aligned `XDG_CONFIG_HOME`, safe `PATH`, cached `DENO_DIR`, display
  connection variables, and `CAP_ACP_ADAPTER`, `CAP_ACP_CWD`,
  `CAP_ACP_FIXTURE_LOG`. The adapter is the absolute existing fixture path;
  the cwd is owned scratch; its log equals `CAP_ACCEPTANCE_FRAME_LOG`.

Do not inherit provider credentials. Values containing commas are unsupported.
No ACP bridge may own port 3210; do not kill another lane's listener. The
browser's separately assigned CDP port is expected, not an ACP bridge port.
The native probe requires a correlated initialize result, not arbitrary output.
The UI turn must render the fixture reply, receive a correlated `end_turn`, and
transition from working to the actual idle UI (hidden status pill, no live row
or composer glow). An empty status string alone is not success.

## Missing-host fallback

Use the same generated extension, a new empty HOME/config and a new profile.
Do **not** install a host or set `CAP_ACCEPTANCE_NATIVE_MANIFEST`; leave automatic
transport selection unchanged (never set `acp.transport=ws`). Set:

- `CAP_ACCEPTANCE_NO_BRIDGE=0`, `CAP_ACCEPTANCE_EXPECT_NATIVE=0`,
  `CAP_ACCEPTANCE_EXPECT_MISSING_HOST=1`, `CAP_ACCEPTANCE_HEADED=1`.
- `CAP_ACCEPTANCE_ADAPTER`: absolute fixture path for the local bridge.
- `CAP_ACP_FIXTURE_LOG` and `CAP_ACCEPTANCE_FRAME_LOG`: the same fresh log path.
- Keep the expected reply and isolated browser environment as above.

The direct probe must report host-not-found, then the real UI must open the ACP
WebSocket and complete the turn. Both modes retain actual browser argv/version,
loaded identity, screenshots, frame log, transport observations and verdict.
Browsers are reaped; also check owned host/fixture descendants and the ACP port
are gone after execution. Dispose only of this run's copy/profiles/config.

Full-suite failures remain failures even when these browser checks pass. Use
`npm run test:changed`; before any authorized push use `npm test`. Independent
review and any active publication hold still apply.

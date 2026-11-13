// chrome-agent-platform-n6aj1 round 2: BEHAVIOUR pins for the two run-id gates the
// service worker's wasm dispatch lanes use. Round 1 threaded Settings preview ids
// ('model-run-*', 'settings-preview-*') through the execution-id grammar and refused
// previews that worked — this suite pins that both predicates do exactly what their
// sinks require, so a wrong gate reds here before it can red a preview.
import { assertEquals } from "jsr:@std/assert@1";
import { dispatchRunIdOrNull, streamOwnerRunIdOrNull } from "../extension/lib/run-id-gate.js";
import { encodeModelStreamOwner } from "../extension/lib/wasm-stream-owner-codec.js";

Deno.test("n6aj1 r2: OWNER lanes accept exactly execution ids — preview ids are refused there", () => {
  const EXEC = "exec:0b1e5f2a-77c4-4c6e-9a51-0e3a2b6d8f90";
  assertEquals(streamOwnerRunIdOrNull(EXEC), EXEC, "a valid exec uuid owns streams");
  assertEquals(streamOwnerRunIdOrNull("exec_abcdefgh1"), "exec_abcdefgh1");
  assertEquals(streamOwnerRunIdOrNull("acp:aaaaaaaa"), "acp:aaaaaaaa");
  // The Settings shapes are NOT execution ids and must never derive a stream owner.
  assertEquals(streamOwnerRunIdOrNull("model-run-0123abcd"), null, "model-run-* must not own streams");
  assertEquals(streamOwnerRunIdOrNull("settings-preview-0123456789ab"), null);
  // The colliding legacy shape (n6aj1) is refused by the grammar itself.
  assertEquals(streamOwnerRunIdOrNull("v2:3:abc"), null);
  assertEquals(streamOwnerRunIdOrNull(""), null);
  assertEquals(streamOwnerRunIdOrNull(undefined), null);
});

Deno.test("n6aj1 r2: DISPATCH lanes keep previews working and still refuse the collision shape", () => {
  // The reviewer's probe, as unit behaviour: previews dispatch, exec ids dispatch.
  const EXEC = "exec:0b1e5f2a-77c4-4c6e-9a51-0e3a2b6d8f90";
  assertEquals(dispatchRunIdOrNull("model-run-0123abcd"), "model-run-0123abcd", "Settings model preview must NOT be refused");
  assertEquals(dispatchRunIdOrNull("settings-preview-0123456789ab"), "settings-preview-0123456789ab", "Settings preview must NOT be refused");
  assertEquals(dispatchRunIdOrNull(EXEC), EXEC, "a valid exec uuid still dispatches");
  assertEquals(dispatchRunIdOrNull("exec_abcdefgh1"), "exec_abcdefgh1");
  // The owner-codec collision shape is refused in BOTH gates.
  assertEquals(dispatchRunIdOrNull("v2:3:abc"), null);
  assertEquals(dispatchRunIdOrNull(""), null);
  assertEquals(dispatchRunIdOrNull(42), null);
  // The accepted preview shapes are EXACTLY what the SW mints — near-misses refused.
  assertEquals(dispatchRunIdOrNull("model-run-xyz"), null);
  assertEquals(dispatchRunIdOrNull("settings-preview-short"), null);
  assertEquals(dispatchRunIdOrNull("model-run-0123abcd-extra"), null);
});

Deno.test("n6aj1 r2: every gated derivation still yields an encodable owner for exec ids", () => {
  // The end-to-end invariant: for any id the owner gate accepts, the codec round-trips.
  const id = "acp:aaaaaaaa";
  const owner = encodeModelStreamOwner(streamOwnerRunIdOrNull(id) ?? "", "hub");
  assertEquals(owner, "agent:v2:12:acp:aaaaaaaa" + "hub");
});

// chrome-agent-platform-n6aj1 round 3: the round-2 suite fed HAND-WRITTEN shapes and
// passed while the real settings-preview mint ('settings-preview-' + uuid.slice(0,12),
// whose window contains a hyphen) failed the gate — 100% of real previews refused.
// These tests derive their inputs from the ACTUAL minters, so a hyphen, a length
// change or a prefix change reds here instead of shipping.
import { mintModelRunRunId, mintSettingsPreviewRunId } from "../extension/lib/run-id-gate.js";

Deno.test("n6aj1 r3: every REAL settings-preview mint passes the dispatch gate (50 mints)", () => {
  for (let i = 0; i < 50; i++) {
    const minted = mintSettingsPreviewRunId();
    assertEquals(
      dispatchRunIdOrNull(minted),
      minted,
      `a real settings-preview mint must dispatch, got refusal for ${JSON.stringify(minted)} — the mint and the gate disagree`,
    );
    assertEquals(minted.startsWith("settings-preview-"), true);
    assertEquals(minted.replace("settings-preview-", "").includes("-"), false, "the id body must be hyphen-free — the slice window must not straddle the uuid's hyphen");
  }
});

Deno.test("n6aj1 r3: every REAL model-run mint passes the dispatch gate (50 mints)", () => {
  for (let i = 0; i < 50; i++) {
    const minted = mintModelRunRunId();
    assertEquals(
      dispatchRunIdOrNull(minted),
      minted,
      `a real model-run mint must dispatch, got refusal for ${JSON.stringify(minted)}`,
    );
    assertEquals(minted.replace("model-run-", "").includes("-"), false, "the id body must be hyphen-free");
  }
});

Deno.test("n6aj1 r3: the mints stay inside the SW's Settings dispatch paths (static, mint-level)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // The mints are the SW's ONLY source of preview ids: no inline uuid-slice mint may
  // return (an inline slice is how the hyphen shipped).
  assertEquals((sw.match(/randomUUID\(\)\.slice/g) ?? []).length, 0, "inline uuid-slice run-id mints must not return — use the run-id-gate minters");
  assertEquals((sw.match(/mintSettingsPreviewRunId\(\)/g) ?? []).length, 1, "the settings-preview dispatch must mint through the canonical minter");
  assertEquals((sw.match(/mintModelRunRunId\(\)/g) ?? []).length, 2, "both model-run dispatch legs must mint through the canonical minter");
});

// @ts-nocheck — focused test for mic-button cumulative transcript handling.
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("mic transcript: cumulative speech recognition results replace textarea without duplication", () => {
  // Simulate textarea field
  const roleField = { el: { value: "" } };

  // The correct transcript handler: replaces field value with cumulative transcript
  const handleTranscript = (text) => {
    if (!text) return;
    roleField.el.value = text;
  };

  // Utterance 1: SpeechRecognition emits first interim/final chunk
  handleTranscript("create a sorting hat agent");
  assertEquals(roleField.el.value, "create a sorting hat agent");

  // Utterance 2: SpeechRecognition emits cumulative transcript for entire session
  handleTranscript("create a sorting hat agent that assigns users to houses");
  assertEquals(
    roleField.el.value,
    "create a sorting hat agent that assigns users to houses",
    "cumulative transcript must not be appended/doubled",
  );

  // Utterance 3: Final transcript chunk
  handleTranscript("create a sorting hat agent that assigns users to houses with quirky commentary");
  assertEquals(
    roleField.el.value,
    "create a sorting hat agent that assigns users to houses with quirky commentary",
    "final cumulative transcript must match exactly once",
  );
});

Deno.test("mic transcript WIRING (source pin): ntp.js agent config mic handler replaces roleField value", async () => {
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const micBlock = ntp.match(/const mic = document\.createElement\("mic-button"\);[\s\S]*?mic\.addEventListener\("transcript",\s*\(e\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert(micBlock, "mic-button transcript listener must exist in ntp.js");
  const handlerBody = micBlock[1];
  assert(
    handlerBody.includes("roleField.el.value = text;"),
    "mic handler must replace roleField.el.value with cumulative text (not append)",
  );
  assert(
    !handlerBody.includes("roleField.el.value = cur ?"),
    "mic handler must not append text to cur (which causes duplication)",
  );
});

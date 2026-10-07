import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertJourneyNtpPrincipal } from "../scripts/lib/journey-ntp-principal.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const NTP = `chrome-extension://${ID}/ntp/ntp.html`;

Deno.test("6sra: only our loaded extension page with messaging can wake its worker", () => {
  assertEquals(assertJourneyNtpPrincipal({ href: NTP, sendMessageType: "function" }, ID), undefined);
  assertEquals(assertJourneyNtpPrincipal({ href: `${NTP}#home`, sendMessageType: "function" }, ID), undefined);
  for (const observation of [
    { href: "chrome-error://chromewebdata/", sendMessageType: "undefined" },
    { href: `chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/ntp/ntp.html`, sendMessageType: "function" },
    { href: NTP, sendMessageType: "undefined" },
    { href: `${NTP}/other`, sendMessageType: "function" },
    { href: "not a URL", sendMessageType: "function" },
    null,
  ]) {
    assertThrows(() => assertJourneyNtpPrincipal(observation, ID), Error,
      "journey NTP principal unavailable before worker restart");
  }
});

Deno.test("6sra: principal failure never echoes a redirected URL or its private query", () => {
  const privateUrl = "https://example.test/path?token=private-example";
  const error = assertThrows(() => assertJourneyNtpPrincipal({ href: privateUrl, sendMessageType: "undefined" }, ID));
  assert(error instanceof Error);
  assert(!error.message.includes(privateUrl));
  assert(!error.message.includes("private-example"));
  assert(error.message.includes("expectedExtensionPage=false runtimeSendMessage=false"));
});
